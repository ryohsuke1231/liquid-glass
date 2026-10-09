import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
import { connectClicks, type DesktopItem, type ItemEnv, PREFERRED_MIN_CONTRAST } from './desktopItem.js';
import { FIELD_RANGE, type DigitsRequest } from './digits.js';
import { DigitsSource } from './digitsSource.js';
import { type TallStyle } from './glassText.js';
import { coglContext } from '../shellVersion.js';

// The drop shadow's reach (px), a little inside the distance field's.
const SHADOW_REACH = 40;
// Font changes are applied once the preferences stop changing them.
const FONT_DELAY_MS = 300;
// The date sits this far (px) above the glass digits' outline.
const DATE_GAP = 6;

const SIZE_KEYS = ['glass-clock-size', 'glass-clock-stretch', 'glass-clock-height'];

// The glass of the digits for one time.
interface Glass {
  texture: Cogl.Texture;
  band: number;
  width: number;
  height: number;
}

// The [min, max] the schema allows for a number key.
function keyRange(settings: Gio.Settings, key: string): [number, number] {
  const [, range] = settings.settings_schema.get_key(key).get_range().recursiveUnpack() as [string, [number, number]];
  return range;
}

function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A large clock whose digits are glass, like the clock on the iPhone's lock
 * screen, with the date above it.
 */
export class GlassClock implements DesktopItem {
  readonly id = 'clock';
  readonly actor: St.Widget;
  readonly shown = true;
  private _env: ItemEnv;
  private _glass: BackdropGlass;
  private _date: St.Label;
  private _source: DigitsSource;
  // The font, size and shape the digits are made in; null until there is one.
  private _font: Omit<DigitsRequest, 'text'> | null = null;
  // The digits for the time shown and for the next minute, made ahead so the
  // minute changes without the work.
  private _prepared = new Map<string, Promise<Glass>>();
  private _text = '';
  // The digits' height in the font as it is (px), once known.
  private _digitHeight = 0;
  private _fieldSize: [number, number] = [1, 1];
  private _size: [number, number] = [1, 1];
  private _bounds: [number, number, number, number] = [0, 0, 1, 1];
  private _sizeChanged = true;
  private _timerId = 0;
  private _fontTimerId = 0;
  private _settingsIds: number[] = [];
  private _interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
  private _interfaceIds: number[] = [];
  private _adaptive: AdaptiveTextColor;

  constructor(env: ItemEnv) {
    this._env = env;
    this.actor = new St.Widget({ name: 'liquid-glass-desktop-clock', reactive: true });
    this._glass = new BackdropGlass({
      extensionPath: env.path, settings: env.settings, logger: env.logger, owner: 'desktop-clock', shapeTexture: true,
    } as any);
    this._glass.setPadding(0);
    this._glass.setIsDock(false);
    this._glass.setShadowMaxRadius(SHADOW_REACH);
    this._source = new DigitsSource(env.path, env.logger);
    this._date = new St.Label({ style_class: 'liquid-glass-clock-date' });
    this.actor.add_child(this._glass);
    this.actor.add_child(this._date);
    connectClicks(this.actor, () => {}, (x, y) => env.menu(this, x, y));

    this._adaptive = new AdaptiveTextColor(() => [this._date], () => [this._glass], env.logger, 'clock');
    const watch = (key: string, fn: () => void) => this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
    for (const key of ['glass-clock-font', 'glass-clock-size', 'glass-clock-stretch', 'glass-clock-height', 'glass-clock-tall-style'])
      watch(key, () => this._queueFont());
    watch('glass-clock-format', () => this._tick());
    watch('glass-clock-show-date', () => this._tick());
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'brightness', 'contrast', 'saturation'])
      watch(`glass-clock-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`desktop-widget-${key}`, () => this._syncAdaptive());
    this._interfaceIds.push(this._interfaceSettings.connect('changed::clock-format', () => this._tick()));
    this._interfaceIds.push(this._interfaceSettings.connect('changed::font-name', () => this._queueFont()));

    this._applyMaterial();
    this._syncAdaptive();
    this._loadFont();
  }

  private _applyMaterial(): void {
    const s = this._env.settings;
    const g = this._glass;
    g.setTintColor(...hexToColorArray(s.get_string('glass-clock-tint-color')));
    g.setTintStrength(s.get_double('glass-clock-tint-strength'));
    g.setBlurRadius(s.get_int('glass-clock-blur-radius'));
    g.setBrightness(s.get_double('glass-clock-brightness'));
    g.setContrast(s.get_double('glass-clock-contrast'));
    g.setSaturation(s.get_double('glass-clock-saturation'));
  }

  private _syncAdaptive(): void {
    const s = this._env.settings;
    if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
      this._adaptive.clear();
      return;
    }
    this._adaptive.start(s.get_int('desktop-widget-sample-interval-ms'),
      sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
  }

  // The font the digits are cut from: the chosen one, or the interface font in bold.
  private _fontDescription(): string {
    const chosen = this._env.settings.get_string('glass-clock-font').trim();
    if (chosen) return chosen;
    const ui = Pango.FontDescription.from_string(this._interfaceSettings.get_string('font-name'));
    return `${ui.get_family() ?? 'Sans'} Bold`;
  }

  private _queueFont(): void {
    if (this._fontTimerId) GLib.Source.remove(this._fontTimerId);
    this._fontTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FONT_DELAY_MS, () => {
      this._fontTimerId = 0;
      this._loadFont();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _loadFont(): void {
    const s = this._env.settings;
    const font = this._fontDescription();
    const size = s.get_int('glass-clock-size');
    const stretch = s.get_double('glass-clock-stretch');
    const height = s.get_double('glass-clock-height');
    const style: TallStyle = s.get_string('glass-clock-tall-style') === 'upright' ? 'upright' : 'even';
    const next = { extensionPath: this._env.path, font, size, stretch, height, style };
    if (this._font && JSON.stringify(next) === JSON.stringify(this._font)) return;
    this._font = next;
    this._prepared.clear();
    this._date.set_style(`font-size: ${Math.max(11, Math.round(size * 0.13))}px;`);
    this._text = '';
    this._tick();
  }

  /** Whether the digits have a size or width other than the default. */
  get resized(): boolean {
    const s = this._env.settings;
    return SIZE_KEYS.some(key => !s.get_value(key).equal(s.get_default_value(key)!));
  }

  /**
   * Makes the clock `sx` times as wide and `sy` times as tall, as far as the
   * settings allow: taller alone makes the digits taller with their strokes
   * as thick (see restroke()), wider alone stretches them, and both
   * scale the font.
   */
  resizeBy(sx: number, sy: number): void {
    const s = this._env.settings;
    if (sx === 1 && this._digitHeight) {
      const added = (sy - 1) * this._bounds[3] / this._digitHeight;
      const height = clamp(s.get_double('glass-clock-height') + added, keyRange(s, 'glass-clock-height'));
      s.set_double('glass-clock-height', Math.round(height * 100) / 100);
      this._loadFont();
      return;
    }
    const size = s.get_int('glass-clock-size');
    const newSize = Math.round(clamp(size * sy, keyRange(s, 'glass-clock-size')));
    // The width follows the size too; the stretch makes up the rest.
    const stretch = clamp(s.get_double('glass-clock-stretch') * sx * size / newSize, keyRange(s, 'glass-clock-stretch'));
    s.set_int('glass-clock-size', newSize);
    s.set_double('glass-clock-stretch', Math.round(stretch * 100) / 100);
    this._loadFont();
  }

  resetSize(): void {
    for (const key of SIZE_KEYS) this._env.settings.reset(key);
    this._loadFont();
  }

  private _timeText(now: GLib.DateTime): string {
    const format = this._env.settings.get_string('glass-clock-format');
    const twelve = format === '12h' || (format !== '24h' && this._interfaceSettings.get_string('clock-format') === '12h');
    return now.format(twelve ? '%-I:%M' : '%H:%M') ?? '';
  }

  private _tick(): void {
    if (this._timerId) GLib.Source.remove(this._timerId);
    const now = GLib.DateTime.new_now_local();
    this._date.visible = this._env.settings.get_boolean('glass-clock-show-date');
    this._date.text = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    this._setText(this._timeText(now));
    this._sizeChanged = true;
    const wait = 60 - now.get_seconds() + 0.05;
    this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait * 1000), () => {
      this._timerId = 0;
      this._tick();
      return GLib.SOURCE_REMOVE;
    });
  }

  // The glass for `text` in the current font.
  private _glassFor(text: string): Promise<Glass> {
    let glass = this._prepared.get(text);
    if (!glass) {
      glass = this._source.make({ ...this._font!, text }).then(digits => {
        this._digitHeight = digits.digitHeight;
        const texture = Cogl.Texture2D.new_from_data(coglContext(), digits.width, digits.height * 2,
          Cogl.PixelFormat.RGBA_8888, digits.width * 4, digits.bytes);
        return { texture, band: digits.band, width: digits.width, height: digits.height };
      });
      glass.catch(() => this._prepared.delete(text));
      this._prepared.set(text, glass);
    }
    return glass;
  }

  private async _setText(text: string): Promise<void> {
    const font = this._font;
    if (text === this._text || !font) return;
    this._text = text;
    let glass;
    try {
      glass = await this._glassFor(text);
      if (font !== this._font || text !== this._text) return;
    } catch (e) {
      if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
        this._env.logger.error(`[Liquid Glass] Could not draw the clock's digits: ${e}`);
      // Tried again at the next minute.
      if (text === this._text) this._text = '';
      return;
    }
    const { texture, band, width, height } = glass;
    this._fieldSize = [width, height];
    this._glass.set_size(width, height);
    this._glass.setResolution(width, height);
    this._glass.setGlassGeometry(0, 0, width, height);
    this._glass.setShapeTexture(texture, FIELD_RANGE, band);
    this._sizeChanged = true;
    this._adaptive.invalidate();

    for (const key of [...this._prepared.keys()]) {
      if (key !== text) this._prepared.delete(key);
    }
    // A failure shows when that minute comes and the digits are made again.
    this._glassFor(this._timeText(GLib.DateTime.new_now_local().add_minutes(1)!)).catch(() => {});
  }

  // The date above the digits; the field's margin is mostly empty, so the
  // label goes into it.
  private _layout(): void {
    const [fw, fh] = this._fieldSize;
    const [, dateH] = this._date.visible ? this._date.get_preferred_height(-1) : [0, 0];
    const [, dateW] = this._date.visible ? this._date.get_preferred_width(-1) : [0, 0];
    const glassY = Math.max(dateH + DATE_GAP - FIELD_RANGE, 0);
    const width = Math.max(fw, dateW);
    const glassX = Math.round((width - fw) / 2);
    this._glass.set_position(glassX, glassY);
    const dateX = Math.round((width - dateW) / 2);
    const dateY = Math.max(glassY + FIELD_RANGE - DATE_GAP - dateH, 0);
    this._date.set_position(dateX, dateY);
    this._size = [Math.ceil(width), Math.ceil(glassY + fh)];
    this.actor.set_size(...this._size);

    const r = FIELD_RANGE;
    let [x0, y0, x1, y1] = [glassX + r, glassY + r, glassX + fw - r, glassY + fh - r];
    if (this._date.visible) {
      x0 = Math.min(x0, dateX);
      x1 = Math.max(x1, dateX + dateW);
      y0 = Math.min(y0, dateY);
    }
    this._bounds = [x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1)];
  }

  size(): [number, number] {
    return this._size;
  }

  bounds(): [number, number, number, number] {
    return this._bounds;
  }

  sync(): boolean {
    const changed = this._sizeChanged;
    if (changed) {
      this._sizeChanged = false;
      this._layout();
    }
    if (this.actor.mapped) {
      ensureGlassAllocated(this._glass);
      this._glass.syncSources();
    }
    return changed;
  }

  destroy(): void {
    if (this._timerId) GLib.Source.remove(this._timerId);
    if (this._fontTimerId) GLib.Source.remove(this._fontTimerId);
    this._timerId = this._fontTimerId = 0;
    for (const id of this._settingsIds) this._env.settings.disconnect(id);
    for (const id of this._interfaceIds) this._interfaceSettings.disconnect(id);
    this._settingsIds = [];
    this._interfaceIds = [];
    this._adaptive.clear();
    this._source.destroy();
    this._font = null;
    this._prepared.clear();
    this._glass.cleanup();
    if (isActorValid(this.actor)) this.actor.destroy();
  }
}
