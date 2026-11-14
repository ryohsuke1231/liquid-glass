import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type { Logger } from '../logger.js';
import { coglContext } from '../shellVersion.js';
import { WorkerProcess } from '../workers/workerProcess.js';
import { type DepthMap, type PictureStyle, decodeDepthMap, hasSubject } from './depthMap.js';
import { DEPTH_MODEL, SUBJECT_MODEL, depthCacheDir, hasModel, modelPath } from './depthModels.js';

// A new wallpaper is analysed once it has stayed this long, so one that is only passed through is not.
const SETTLE_MS = 3000;
// The shell fades to a new wallpaper for about this long; its map is shown after that.
const FADE_MS = 1000;
const STYLES: PictureStyle[] = ['zoom', 'scaled', 'stretched', 'centered', 'spanned'];

/** The depth map of the wallpaper shown on the primary monitor. */
export interface WallpaperMap {
  map: DepthMap;
  texture: Cogl.Texture;
  // Whether the map's subject plane holds a subject.
  subject: boolean;
  // The monitor the map covers, stage coordinates.
  monitor: { x: number, y: number, width: number, height: number };
}

interface Target {
  file: string;
  style: PictureStyle;
  width: number;
  height: number;
}

function isCancelled(e: unknown): boolean {
  return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Keeps the depth map of the current wallpaper: read from the cache when the
 * wallpaper was analysed before, made by a worker process (wallpaperWorker.js)
 * otherwise. `changed` is called whenever `current` is another map or none.
 */
export class WallpaperDepth {
  current: WallpaperMap | null = null;
  private _background = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
  private _interface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
  private _signals: { target: any, id: number }[] = [];
  private _cancellable = new Gio.Cancellable();
  private _settleId = 0;
  private _showId = 0;
  private _worker: WorkerProcess | null = null;
  // The wallpaper wanted now, and the one the worker is on.
  private _wanted = '';
  private _analysing = '';
  private _request: number;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger, private _changed: () => void) {
    const watch = (target: any, signal: string, fn: () => void) => this._signals.push({ target, id: target.connect(signal, fn) });
    for (const key of ['picture-uri', 'picture-uri-dark', 'picture-options'])
      watch(this._background, `changed::${key}`, () => this._update(false));
    watch(this._interface, 'changed::color-scheme', () => this._update(false));
    watch(Main.layoutManager, 'monitors-changed', () => this._update(false));
    watch(_settings, 'changed::glass-clock-depth-auto', () => this._update(false));
    this._request = _settings.get_int('glass-clock-depth-request');
    watch(_settings, 'changed::glass-clock-depth-request', () => {
      const request = _settings.get_int('glass-clock-depth-request');
      if (request === this._request) return;
      this._request = request;
      this._update(true);
    });
    this._update(false);
  }

  private _status(status: string): void {
    if (status !== 'analysing') this._settings.reset('glass-clock-depth-progress');
    if (this._settings.get_string('glass-clock-depth-status') !== status)
      this._settings.set_string('glass-clock-depth-status', status);
  }

  // The picture the primary monitor shows and how; null when it shows none the map can be made for.
  private _target(): Target | null {
    const monitor = Main.layoutManager.primaryMonitor;
    const style = this._background.get_string('picture-options') as PictureStyle;
    if (!monitor || !STYLES.includes(style)) return null;
    // A spanned picture runs over all the monitors; on one alone it fills it.
    if (style === 'spanned' && Main.layoutManager.monitors.length > 1) return null;
    const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
    const file = Gio.File.new_for_uri(this._background.get_string(dark ? 'picture-uri-dark' : 'picture-uri')).get_path();
    // A slideshow is a list of pictures, not one.
    if (!file || file.endsWith('.xml')) return null;
    return { file, style, width: monitor.width, height: monitor.height };
  }

  private _setCurrent(current: WallpaperMap | null): void {
    if (current === this.current) return;
    this.current = current;
    this._changed();
  }

  private _stopTimers(): void {
    if (this._settleId) GLib.Source.remove(this._settleId);
    if (this._showId) GLib.Source.remove(this._showId);
    this._settleId = this._showId = 0;
  }

  // `asked`: from the preferences, so the analysis starts now and also with glass-clock-depth-auto off.
  private async _update(asked: boolean): Promise<void> {
    this._stopTimers();
    this._cancellable.cancel();
    const cancellable = this._cancellable = new Gio.Cancellable();
    const target = this._target();
    if (!target) {
      this._wanted = '';
      this._setCurrent(null);
      this._status('unsupported');
      return;
    }
    let cache: string;
    try {
      const info = await new Promise<Gio.FileInfo>((resolve, reject) => {
        const file = Gio.File.new_for_path(target.file);
        file.query_info_async('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
          try {
            resolve(file.query_info_finish(res));
          } catch (e) {
            reject(e);
          }
        });
      });
      const key = [target.file, info.get_size(), info.get_attribute_uint64('time::modified'), target.style, target.width, target.height].join('|');
      cache = GLib.build_filenamev([depthCacheDir(), GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, key, -1)!]);
    } catch (e) {
      if (isCancelled(e)) return;
      this._wanted = '';
      this._setCurrent(null);
      this._status('unsupported');
      return;
    }
    const again = cache === this._wanted;
    this._wanted = cache;
    if (again && this.current) return;
    this._setCurrent(null);
    if (await this._load(cache, cancellable, again ? 0 : FADE_MS) || cancellable.is_cancelled()) return;
    if (!hasModel(DEPTH_MODEL)) {
      this._status('no-model');
      return;
    }
    if (!asked && !this._settings.get_boolean('glass-clock-depth-auto')) {
      this._status('waiting');
      return;
    }
    this._status('analysing');
    if (this._analysing) return;
    this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, asked ? 0 : SETTLE_MS, () => {
      this._settleId = 0;
      this._analyse(target, cache);
      return GLib.SOURCE_REMOVE;
    });
  }

  // Shows the map in `cache`, after `delay` ms. False when there is none.
  private async _load(cache: string, cancellable: Gio.Cancellable, delay: number): Promise<boolean> {
    let map: DepthMap | null;
    try {
      map = decodeDepthMap(await new Promise<Uint8Array>((resolve, reject) => {
        const file = Gio.File.new_for_path(cache);
        file.load_contents_async(cancellable, (_f, res) => {
          try {
            resolve(file.load_contents_finish(res)[1]);
          } catch (e) {
            reject(e);
          }
        });
      }));
    } catch {
      // Not analysed yet, or given up for a newer wallpaper.
      return false;
    }
    const monitor = Main.layoutManager.primaryMonitor;
    if (!map || !monitor) return false;
    const shown = map;
    const show = () => {
      const texture = Cogl.Texture2D.new_from_data(coglContext(), shown.width, shown.height, Cogl.PixelFormat.RGBA_8888,
        shown.width * 4, shown.pixels);
      const { x, y, width, height } = monitor;
      this._setCurrent({ map: shown, texture, subject: hasSubject(shown), monitor: { x, y, width, height } });
      this._status('ready');
    };
    if (delay === 0) {
      show();
      return true;
    }
    this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this._showId = 0;
      show();
      return GLib.SOURCE_REMOVE;
    });
    return true;
  }

  private async _analyse(target: Target, cache: string): Promise<void> {
    // The worker and its helpers are let go after each wallpaper, with all the memory they took.
    const worker = this._worker = new WorkerProcess(`${this._path}/dist/workers/wallpaperWorker.js`, 'wallpaper\'s worker', this._logger);
    this._analysing = cache;
    let failed = false;
    try {
      const answer = await worker.request({
        ...target, cache, depthModel: modelPath(DEPTH_MODEL), subjectModel: hasModel(SUBJECT_MODEL) ? modelPath(SUBJECT_MODEL) : '',
      }, fraction => this._settings.set_int('glass-clock-depth-progress', Math.round(fraction * 100)));
      this._logger.log(`[Liquid Glass] Analysed the wallpaper in ${answer.seconds.toFixed(1)} s`);
    } catch (e) {
      failed = true;
      this._logger.log(`[Liquid Glass] Could not analyse the wallpaper: ${e}`);
    }
    // Destroyed meanwhile.
    if (this._worker !== worker) return;
    worker.destroy();
    this._worker = null;
    this._analysing = '';
    if (this._wanted !== cache) {
      // Another wallpaper came while this one was worked on.
      this._update(false);
    } else if (failed || !await this._load(cache, this._cancellable, 0)) {
      this._status('failed');
    }
  }

  destroy(): void {
    this._stopTimers();
    for (const { target, id } of this._signals) target.disconnect(id);
    this._signals = [];
    this._cancellable.cancel();
    this._worker?.destroy();
    this._worker = null;
    this.current = null;
    this._status('off');
  }
}
