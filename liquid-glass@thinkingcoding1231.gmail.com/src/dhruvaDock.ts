import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { BackdropGlass } from './rendering/backdropGlass.js';
import { SHADER_PADDING, attachDockGlass, createDockGlass, followDockMaterial } from './dockManager.js';
import { dockEdges, dockSide } from './actors/dockGeometry.js';
import { placeScreenGlass, GLASS_SHADOW_MAX_RADIUS } from './actors/glassBounds.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isActorValid } from './actors/lifecycle.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { startStageLoop, stopStageLoop } from './animation/frameLoops.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
import type { Logger } from './logger.js';

/**
 * The glass of a Dhruva dock (dhruva@narkagni). Dhruva draws the dock's
 * background as one widget, DhruvaBackground, and while the pointer magnifies
 * the icons it widens that widget with a scale and a translation rather than
 * a new size. The glass takes the widget's rect on screen every frame, and
 * the widget is left in place, transparent, as Dhruva's drop target.
 */
export class DhruvaDock {
  private _glass: BackdropGlass | null = null;
  private _background: Clutter.Actor | null = null;
  private _settingsIds: number[] = [];
  private _mapId = 0;
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _lastTickUs = 0;

  constructor(private _path: string, private _container: Clutter.Actor, private _settings: Gio.Settings,
    private _logger: Logger) {}

  setup(): void {
    this._settingsIds.push(this._settings.connect('changed::enable-dock-glass', () => {
      if (this._settings.get_boolean('enable-dock-glass')) this._apply();
      else this._remove();
    }));
    this._settingsIds.push(this._settings.connect('changed::dock-glass-expand', () => this._glass?.queue_redraw()));
    this._settingsIds.push(...followDockMaterial(this._settings, () => this._glass));
    if (this._settings.get_boolean('enable-dock-glass')) this._apply();
  }

  private _apply(): void {
    if (this._glass) return;
    this._background = this._container.get_children().find(child => child.get_name() === 'DhruvaBackground') ?? null;
    if (this._background) this._background.opacity = 0;

    const glass = createDockGlass(this._path, this._settings, this._logger, 'dock:dhruva');
    this._glass = glass;
    // Below the dock, so the glass reads the stage before the dock is drawn.
    const uiGroup = Main.layoutManager.uiGroup;
    if (this._container.get_parent() === uiGroup) uiGroup.insert_child_below(glass, this._container);
    else uiGroup.add_child(glass);
    glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
    // Dhruva's animations move the background between the frame tick and the paint.
    glass.setLiveGeometryHook(() => this._place(false));

    this._mapId = this._container.connect('notify::mapped', () => {
      if (this._container.mapped) {
        this._startFrameSync();
      } else {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._glass?.hide();
      }
    });
    if (this._container.mapped) this._startFrameSync();
    else glass.hide();
  }

  private _startFrameSync(): void {
    startStageLoop(this._frameSignalSlot, this._frameSlot, () => {
      const glass = this._glass;
      if (!glass || !this._container.mapped || isFrameSyncFrozen()) return;
      // Two stage views would step it twice in one frame.
      const nowUs = GLib.get_monotonic_time();
      if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
      this._lastTickUs = nowUs;
      try {
        ensureGlassAllocated(glass);
        this._place(true);
      } catch (e) {
        reportFrameLoopError('DhruvaDock', e);
      }
    });
  }

  // Puts the glass where the background is on screen. With `sync`, also
  // places the glass on its monitor and its sample area, which must happen
  // in the frame tick; the paint-time call only moves the glass rect.
  private _place(sync: boolean): void {
    const glass = this._glass;
    if (!glass) return;
    const box = (this._background ?? this._container).get_transformed_extents();
    const [x, y, w, h] = [box.get_x(), box.get_y(), box.get_width(), box.get_height()];
    if (![x, y].every(Number.isFinite) || !(w > 1) || !(h > 1)) {
      if (sync) glass.hide();
      return;
    }
    const monitor = Main.layoutManager.monitors[Main.layoutManager.findIndexForActor(this._container)]
      ?? Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const pad = SHADER_PADDING + this._settings.get_int('dock-glass-expand');
    const side = dockSide(dockEdges({ absX: x, absY: y, baseW: w, baseH: h }, monitor));
    const [rx, ry, rw, rh] = attachDockGlass(glass, this._settings,
      [x - pad - monitor.x, y - pad - monitor.y, w + pad * 2, h + pad * 2], side, monitor.width, monitor.height).rect;
    const rect = { x: rx, y: ry, w: rw, h: rh };
    if (sync) {
      glass.show();
      // Dhruva fades the whole dock in and out as it hides.
      glass.opacity = this._container.get_paint_opacity();
      placeScreenGlass(glass, monitor.x, monitor.y, monitor.width, monitor.height, rect);
      glass.setResolution(monitor.width, monitor.height);
    }
    glass.setGlassGeometry(rect.x, rect.y, rect.w, rect.h);
    // After the geometry setters, so the relays cover this frame's rect.
    if (sync) glass.syncSources();
  }

  private _remove(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    // Dhruva may have destroyed its dock already.
    if (this._mapId && isActorValid(this._container)) this._container.disconnect(this._mapId);
    this._mapId = 0;
    if (this._background && isActorValid(this._background)) this._background.opacity = 255;
    this._background = null;
    const glass = this._glass;
    this._glass = null;
    if (glass) {
      glass.cleanup();
      if (isActorValid(glass)) glass.destroy();
    }
  }

  cleanup(): void {
    this._remove();
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}
