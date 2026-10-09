import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import type GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import { getTransformedRect } from './actors/geometry.js';
import { utilsLog } from './diagnostics/logging.js';
import { createTarget } from './rendering/stageCopy.js';
import { coglContext, paintStageToContent } from './shellVersion.js';

// How much better the other colour has to score before the decision flips.
// With a preferred colour set, flipping towards it is easy and away from it
// hard.
const SWITCH_ADVANTAGE = 1.2;
const SWITCH_ADVANTAGE_TOWARD_PREFERRED = 1.02;
const SWITCH_ADVANTAGE_AGAINST_PREFERRED = 1.6;
// Contrast ratios this close mean the background favours neither colour; a
// preferred colour then applies outright (see decideTextColor()).
const AMBIGUOUS_RATIO = 1.15;
// Measurements are ignored this long after a flip: the samples cover the text
// itself, and the colour tween (about 380ms) would be measured as a change.
const SWITCH_SETTLE_MS = 600;
const MIN_READABLE_CONTRAST = 4.5;
const BACKDROP_COVERS_GLASS_ALPHA = 190;
const READABILITY_FLIP_COOLDOWN = 3;
const BACKGROUND_REALLY_MOVED = 0.15;
const BACKDROP_SEARCH_DEPTH = 8;
// With preferredMinContrast set, the preferred colour comes back once it
// reads this many times better than that.
const PREFERRED_RETURN = 1.15;

export const AdaptiveContrastConfig = {
  enabled: true,
  // Sample each text actor separately instead of one merged rect (costlier).
  samplePerElement: false,
  sampleIntervalMs: 200,
  lightTextColor: '#f2f2f2',
  darkTextColor: '#1a1a1a',
  // 'light'/'dark' name the text colour to favour; 'auto' favours neither.
  preference: 'auto' as AdaptiveColorPreference,
  // When above 0, the preferred colour is kept while its contrast ratio is
  // at least this, not only when the background favours neither colour.
  preferredMinContrast: 0,
};

/** Which text colour the user wants the ambiguous cases resolved to. */
export type AdaptiveColorPreference = 'auto' | 'light' | 'dark';

// Anything unrecognised in the setting counts as 'auto'.
export function sanitizeColorPreference(value: string | null | undefined): AdaptiveColorPreference {
  return (value === 'light' || value === 'dark') ? value : 'auto';
}

function _clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function _srgbToLinear(c: number): number {
  const n = c / 255.0;
  if (n <= 0.04045)
    return n / 12.92;
  return Math.pow((n + 0.055) / 1.055, 2.4);
}

function _luminanceFromRgb(r: number, g: number, b: number): number {
  const rl = _srgbToLinear(r);
  const gl = _srgbToLinear(g);
  const bl = _srgbToLinear(b);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function _trimmedMean(values: number[], trimRatio: number = 0.1): number | null {
  if (values.length === 0)
    return null;

  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * trimRatio);
  const start = _clamp(trim, 0, sorted.length - 1);
  const end = _clamp(sorted.length - trim, start + 1, sorted.length);

  let sum = 0.0;
  for (let i = start; i < end; i++)
    sum += sorted[i];

  return sum / (end - start);
}

function _getActorRect(actor: Clutter.Actor): { x: number, y: number, width: number, height: number } | null {
  if (!actor)
    return null;

  if (!actor.mapped) return null;
  const [x, y, w, h] = getTransformedRect(actor);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  // Shell.Screenshot expects stage coordinates, including ancestor scale.
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(global.stage.width, Math.ceil(x + w));
  const bottom = Math.min(global.stage.height, Math.ceil(y + h));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function _mergeRects(rects: { x: number, y: number, width: number, height: number }[]): { x: number, y: number, width: number, height: number } | null {
  if (rects.length === 0)
    return null;

  let minX = rects[0].x;
  let minY = rects[0].y;
  let maxX = rects[0].x + rects[0].width;
  let maxY = rects[0].y + rects[0].height;

  for (let i = 1; i < rects.length; i++) {
    const r = rects[i];
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** One sampled image, in whatever layout the capture path produced. */
interface SampleImage {
  data: Uint8Array;
  width: number;
  height: number;
  stride: number;
  channels: number;
  /** Sample every step-th pixel; 1 for an already-downscaled buffer. */
  step: number;
}

// The samples are textures read through Shell.Screenshot.composite_to_stream(),
// whose result comes with the pixels. A direct GPU read-back
// (Stage.paint_to_buffer(), Cogl.Texture.get_data()) is not usable from GJS:
// their output buffers are annotated as input arrays, so GJS passes a
// temporary copy and the pixels never come back. Decoding a screenshot's PNG
// is avoided too: from GdkPixbuf 2.44 on, that starts a sandboxed loader.
let _capturePathLogged = false;

function _reportCapturePath(msg: string): void {
  if (_capturePathLogged) return;
  _capturePathLogged = true;
  utilsLog(`[Liquid Glass][contrast] ${msg}`);
}

// Pixels are sampled on a grid of about this many steps per edge.
const SAMPLE_MAX_EDGE = 48;

/**
 * Reads a texture into memory, only to measure the brightness behind the
 * text. Nothing is written to disk or kept after the measurement.
 */
function _readTexture(texture: Cogl.Texture, width: number, height: number): Promise<SampleImage | null> {
  return new Promise(resolve => {
    Shell.Screenshot.composite_to_stream(texture, 0, 0, width, height, 1, null, 0, 0, 1,
      Gio.MemoryOutputStream.new_resizable(), (_obj: any, res: any) => {
        // The finish call throws a GError on failure.
        try {
          resolve(_imageOf(Shell.Screenshot.composite_to_stream_finish(res)));
        } catch {
          resolve(null);
        }
      });
  });
}

/**
 * Draws the part [s0, t0]-[s1, t1] of `texture` into a new texture of
 * width x height and reads that. Drawing with `texture` also flushes what is
 * still queued for it, which GNOME 46 leaves queued after painting the stage
 * into one.
 */
function _drawAndRead(texture: Cogl.Texture, s0: number, t0: number, s1: number, t1: number,
  width: number, height: number): Promise<SampleImage | null> {
  const target = createTarget(width, height);
  if (!target) return Promise.resolve(null);

  const pipeline = Cogl.Pipeline.new(coglContext());
  pipeline.set_layer_texture(0, texture);
  pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
  const fb = target.framebuffer;
  fb.orthographic(0, 0, width, height, -1, 1);
  fb.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
  fb.draw_textured_rectangle(pipeline, 0, 0, width, height, s0, t0, s1, t1);
  // The read goes through a sub-texture, which does not flush the drawing
  // queued on this framebuffer.
  fb.flush();
  return _readTexture(target.texture, width, height);
}

/**
 * Paints the stage under `rect` into a texture of about SAMPLE_MAX_EDGE
 * pixels a side, as the screen shows it now, and reads that.
 */
function _captureViaStage(rect: SampleRect): Promise<SampleImage | null> {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const scale = Math.min(1, SAMPLE_MAX_EDGE / Math.max(width, height));
  let content: Clutter.Content;
  // Painting into an offscreen throws a GError when it cannot be allocated.
  try {
    content = paintStageToContent(new Mtk.Rectangle({ x, y, width, height }), scale);
  } catch {
    return Promise.resolve(null);
  }
  const texture = (content as Clutter.TextureContent | null)?.get_texture();
  if (!texture) return Promise.resolve(null);
  return _drawAndRead(texture, 0, 0, 1, 1, texture.get_width(), texture.get_height());
}

function _imageOf(pixbuf: GdkPixbuf.Pixbuf | null): SampleImage | null {
  if (!pixbuf) return null;
  const width = pixbuf.get_width();
  const height = pixbuf.get_height();
  return {
    data: pixbuf.get_pixels(),
    width,
    height,
    stride: pixbuf.get_rowstride(),
    channels: pixbuf.get_n_channels(),
    step: Math.max(1, Math.floor(Math.min(width, height) / SAMPLE_MAX_EDGE)),
  };
}

/** A glass whose backdrop can be read instead of the screen; see BackdropGlass. */
export interface BackdropSource {
  readonly mapped: boolean;
  readonly uniformValues: ReadonlyMap<string, number>;
  get_paint_opacity(): number;
  backdropCopy(): { texture: Cogl.Texture, rect: number[] } | null;
}

/**
 * What the glass does to the colour of its backdrop away from the edges
 * (applySCB(), the tint and the flat surface light in glass.frag), so that the
 * backdrop alone predicts what the text is drawn over.
 */
export interface GlassTone {
  brightness: number;
  contrast: number;
  saturation: number;
  tint: [number, number, number];
  tintStrength: number;
  light: number;
}

// The z of glass.frag's light direction, normalize(cos a, sin a, 0.38).
const LIGHT_FACING = 0.38 / Math.sqrt(1 + 0.38 * 0.38);

export function glassToneOf(values: ReadonlyMap<string, number>): GlassTone {
  const get = (name: string, fallback: number) => {
    const v = values.get(name);
    return v !== undefined && Number.isFinite(v) ? v : fallback;
  };
  const specular = Math.pow(LIGHT_FACING, Math.max(get('shininess', 42), 1)) * get('specular_intensity', 0) * 0.65;
  const sheen = Math.pow(LIGHT_FACING, 1.65) * get('sheen_intensity', 0);
  return {
    brightness: get('brightness', 1),
    contrast: get('contrast', 1),
    saturation: get('saturation', 1),
    tint: [get('tint_r', 1), get('tint_g', 1), get('tint_b', 1)],
    tintStrength: _clamp(get('tint_strength', 0), 0, 1),
    light: (specular + sheen) * get('surface_light_enabled', 1),
  };
}

export function tonedLuminance(r: number, g: number, b: number, tone: GlassTone): number {
  const scb = (c: number) => 0.5 + ((c / 255) * tone.brightness - 0.5) * tone.contrast;
  let cr = scb(r), cg = scb(g), cb = scb(b);
  const luma = 0.299 * cr + 0.587 * cg + 0.114 * cb;
  const t = tone.tintStrength;
  const finish = (c: number, tint: number) => {
    const tinted = Math.max(0, luma + (c - luma) * tone.saturation) * (1 - t) + tint * t;
    return tinted + tone.light - tinted * tone.light;
  };
  cr = finish(cr, tone.tint[0]);
  cg = finish(cg, tone.tint[1]);
  cb = finish(cb, tone.tint[2]);
  // The shader scales an overbright colour down by its largest channel.
  const peak = Math.max(1, cr, cg, cb);
  return _luminanceFromRgb(_clamp(cr / peak, 0, 1) * 255, _clamp(cg / peak, 0, 1) * 255, _clamp(cb / peak, 0, 1) * 255);
}

function _overlap(copyRect: number[], rect: SampleRect): SampleRect | null {
  const x = Math.max(rect.x, copyRect[0]);
  const y = Math.max(rect.y, copyRect[1]);
  const right = Math.min(rect.x + rect.width, copyRect[2]);
  const bottom = Math.min(rect.y + rect.height, copyRect[3]);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Reads the part of a glass's backdrop copy under `rect`. The copy is first
 * drawn into a texture of about SAMPLE_MAX_EDGE pixels a side, so only that
 * much is read back.
 */
function _captureViaBackdrop(copy: { texture: Cogl.Texture, rect: number[] },
  rect: SampleRect): Promise<SampleImage | null> {
  const area = _overlap(copy.rect, rect);
  if (!area) return Promise.resolve(null);
  const k = Math.min(1, SAMPLE_MAX_EDGE / Math.max(area.width, area.height));
  const [x0, y0, x1, y1] = copy.rect;
  return _drawAndRead(copy.texture,
    (area.x - x0) / (x1 - x0), (area.y - y0) / (y1 - y0),
    (area.x + area.width - x0) / (x1 - x0), (area.y + area.height - y0) / (y1 - y0),
    Math.max(1, Math.round(area.width * k)), Math.max(1, Math.round(area.height * k)));
}

export function backdropLuminance(actor: Clutter.Actor, root: Clutter.Actor | null = null): { luminance: number, alpha: number } | null {
  let node: any = actor;

  for (let depth = 0; node && depth < BACKDROP_SEARCH_DEPTH; depth++) {
    // Only St widgets have a theme node; plain Clutter actors are skipped.
    const color = node.get_theme_node?.().get_background_color();
    if (color && color.alpha >= BACKDROP_COVERS_GLASS_ALPHA) {
      return {
        luminance: _luminanceFromRgb(color.red, color.green, color.blue),
        alpha: color.alpha,
      };
    }

    if (root && node === root) break;
    node = node.get_parent();
  }

  return null;
}

type SampleRect = { x: number, y: number, width: number, height: number };

function _visibleTargets(actors: Clutter.Actor[]): { targets: Clutter.Actor[], rects: SampleRect[] } {
  const targets: Clutter.Actor[] = [];
  const rects: SampleRect[] = [];
  for (const actor of actors) {
    const rect = _getActorRect(actor);
    if (!rect) continue;
    targets.push(actor);
    rects.push(rect);
  }
  return { targets, rects };
}

function _rootOrMergedRect(root: Clutter.Actor | null, rects: SampleRect[]): SampleRect | null {
  const rootRect = root ? _getActorRect(root) : null;
  return rootRect ?? _mergeRects(rects);
}

function _readSignature(paintSignature?: () => number): number | null {
  if (!paintSignature) return null;
  const v = paintSignature();
  return Number.isFinite(v) ? v : null;
}

// The decision also depends on the configuration, not only on pixels.
function _skipKey(rects: SampleRect[], config: typeof AdaptiveContrastConfig): string {
  return rects
    .map(r => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`)
    .join(';') + `|${config.samplePerElement ? 'e' : 'm'}|${config.preference ?? 'auto'}|${config.preferredMinContrast}|${config.lightTextColor}|${config.darkTextColor}`;
}

type LuminanceShot = { data: ArrayLike<number>, width: number, height: number, stride: number, channels: number, step: number };

function _pixelLuminance(data: ArrayLike<number>, idx: number, channels: number, tone?: GlassTone): number | null {
  const measure = (r: number, g: number, b: number) => tone ? tonedLuminance(r, g, b, tone) : _luminanceFromRgb(r, g, b);
  if (channels <= 3) return measure(data[idx], data[idx + 1], data[idx + 2]);
  const a = data[idx + 3];
  if (a < 32) return null;
  if (a >= 255) return measure(data[idx], data[idx + 1], data[idx + 2]);
  // Un-premultiply semi-transparent pixels before measuring.
  const inv = 255.0 / a;
  const unpremultiply = (c: number) => _clamp(Math.round(c * inv), 0, 255);
  return measure(unpremultiply(data[idx]), unpremultiply(data[idx + 1]), unpremultiply(data[idx + 2]));
}

/** @param tone When given, each pixel is measured as the glass would show it. */
export function luminanceSamples(shot: LuminanceShot, tone?: GlassTone): number[] {
  const { data, width, height, stride, channels, step } = shot;
  const values: number[] = [];
  for (let y = 0; y < height; y += step) {
    const row = y * stride;
    for (let x = 0; x < width; x += step) {
      const luma = _pixelLuminance(data, row + x * channels, channels, tone);
      if (luma !== null) values.push(luma);
    }
  }
  return values;
}

export class StageContrastSampler {
  private _lastLuma: number | null = null;
  private _lastIsBright: boolean | null = null;
  // Monotonic time of the last flip; see SWITCH_SETTLE_MS.
  private _lastSwitchAt: number | null = null;
  // The configuration the hold started under; a change ends it.
  private _holdConfig: string = '';
  private _roundsSinceFlip: number = READABILITY_FLIP_COOLDOWN;
  private _lastRawLuma: number | null = null;
  private _lastRect: { x: number; y: number; width: number; height: number } | null = null;
  private _lastDecided: string | null = null;
  // The caller's paint counter after the last capture, and the rects and
  // configuration it measured; see chooseColorsForActors().
  private _unchangedSignature: number | null = null;
  private _unchangedKey: string = '';

  // The next call always samples.
  invalidate(): void {
    this._unchangedSignature = null;
    this._unchangedKey = '';
  }

  // Forgets the decisions so far, for a surface that is shown again and may be
  // over something else now: the next decision is not smoothed towards the
  // last one.
  reset(): void {
    this.invalidate();
    this._lastRect = null;
  }

  /**
   * Measures the screen under `rect`.
   * @param tone Set when no glass is drawn there yet: the screen then shows
   *   the bare backdrop, and the tone predicts the glass over it.
   */
  async sampleLuminance(rect: SampleRect, tone?: GlassTone): Promise<number | null> {
    if (!rect || rect.width <= 0 || rect.height <= 0)
      return null;

    const shot = await _captureViaStage(rect);
    if (!shot) {
      _reportCapturePath('screen capture failed; adaptive text colors will keep their current values');
      return null;
    }
    return this._meanOf(shot, tone);
  }

  /** Measures a glass's backdrop under `rect`, as the glass shows it. */
  async sampleBackdropLuminance(copy: { texture: Cogl.Texture, rect: number[] }, rect: SampleRect,
    tone: GlassTone): Promise<number | null> {
    const shot = await _captureViaBackdrop(copy, rect);
    if (!shot) {
      _reportCapturePath('backdrop read failed; adaptive text colors will keep their current values');
      return null;
    }
    return this._meanOf(shot, tone);
  }

  private _meanOf(shot: SampleImage, tone?: GlassTone): number | null {
    const values = luminanceSamples(shot, tone);
    if (values.length === 0) {
      _reportCapturePath('capture produced no usable pixels (everything below the alpha cutoff)');
      return null;
    }

    // A screenshot contains the text itself, whose colour is what is being
    // decided. Trimming 30% from each end (an interquartile mean) keeps the
    // glyphs from moving the result, so a flip cannot flip itself back.
    return _trimmedMean(values, 0.30);
  }

  /**
   * The glass's backdrop when one of `sources` is drawn over `rect` and has
   * copied it, so that the text, the highlights and the bars on the glass are
   * not measured; the screen otherwise.
   */
  private _measure(rect: SampleRect, sources: BackdropSource[]): Promise<number | null> {
    if (sources.length === 0) return this.sampleLuminance(rect);

    const drawn = sources.filter(source => source.mapped && source.get_paint_opacity() > 0);
    let best: { source: BackdropSource, copy: { texture: Cogl.Texture, rect: number[] } } | null = null;
    let bestArea = 0;
    for (const source of drawn) {
      const copy = source.backdropCopy();
      const area = copy ? _overlap(copy.rect, rect) : null;
      if (copy && area && area.width * area.height > bestArea) {
        best = { source, copy };
        bestArea = area.width * area.height;
      }
    }
    if (best) return this.sampleBackdropLuminance(best.copy, rect, glassToneOf(best.source.uniformValues));
    return this.sampleLuminance(rect, drawn.length === 0 ? glassToneOf(sources[0].uniformValues) : undefined);
  }

  decideTextColor(luminance: number, config: typeof AdaptiveContrastConfig = AdaptiveContrastConfig): string | null {
    if (luminance === null || luminance === undefined)
      return null;

    if (!Number.isFinite(luminance)) return null;
    luminance = _clamp(luminance, 0, 1);
    const colorLuma = (hex: string) => {
      const rgb = parseInt(hex.slice(1), 16);
      return _luminanceFromRgb((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    };
    const light = colorLuma(config.lightTextColor);
    const dark = colorLuma(config.darkTextColor);
    const contrast = (background: number, foreground: number) =>
      (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);

    const rawLight = contrast(luminance, light);
    const rawDark = contrast(luminance, dark);
    const preference = config.preference ?? 'auto';
    const hasPreference = preference !== 'auto';
    const preferDark = preference === 'dark';
    // From the raw contrasts, so it reflects what is on screen now.
    const ambiguous = Math.max(rawLight, rawDark) < Math.min(rawLight, rawDark) * AMBIGUOUS_RATIO;
    const floor = hasPreference ? config.preferredMinContrast : 0;
    // The contrast a colour needs to be called readable.
    const readableAt = (bright: boolean) => floor > 0 && bright === preferDark ? floor : MIN_READABLE_CONTRAST;
    // Per-element decisions keep no history, so the preference is the only
    // stabiliser.
    if (config.samplePerElement) {
      const preferredReads = floor > 0 && (preferDark ? rawDark : rawLight) >= floor;
      if ((ambiguous || preferredReads) && hasPreference) return preferDark ? config.darkTextColor : config.lightTextColor;
      return rawDark > rawLight ? config.darkTextColor : config.lightTextColor;
    }

    // Hold the decision for SWITCH_SETTLE_MS after a flip, unless the held
    // colour is unreadable and the other one is not. A configuration change
    // ends the hold: it should apply at once.
    const now = GLib.get_monotonic_time();
    const holdConfig = `${preference}|${floor}|${config.lightTextColor}|${config.darkTextColor}`;
    if (holdConfig !== this._holdConfig) {
      this._holdConfig = holdConfig;
      this._lastSwitchAt = null;
    }
    if (this._lastIsBright !== null && this._inSettleHold(now)) {
      const heldContrast = this._lastIsBright ? rawDark : rawLight;
      const otherContrast = this._lastIsBright ? rawLight : rawDark;
      const heldUnreadable = heldContrast < readableAt(this._lastIsBright) && otherContrast >= readableAt(!this._lastIsBright);
      if (!heldUnreadable)
        return this._lastIsBright ? config.darkTextColor : config.lightTextColor;
    }

    const smoothed = this._lastLuma === null
      ? luminance : this._lastLuma * 0.7 + luminance * 0.3;
    this._lastLuma = smoothed;
    const lightContrast = contrast(smoothed, light);
    const darkContrast = contrast(smoothed, dark);
    let isBright: boolean;
    if (floor > 0) {
      const preferred = preferDark ? darkContrast : lightContrast;
      const onPreferred = this._lastIsBright === null || this._lastIsBright === preferDark;
      isBright = preferred >= (onPreferred ? floor : floor * PREFERRED_RETURN) ? preferDark : !preferDark;
    } else if (ambiguous && hasPreference) {
      // Decided by the measurement alone, so it cannot oscillate.
      isBright = preferDark;
    } else if (this._lastIsBright === null) {
      // First decision for this surface.
      isBright = darkContrast > lightContrast;
    } else {
      isBright = this._lastIsBright;
      const current = isBright ? darkContrast : lightContrast;
      const alternative = isBright ? lightContrast : darkContrast;
      const towardPreferred = hasPreference && preferDark !== isBright;
      const advantage = !hasPreference ? SWITCH_ADVANTAGE
        : (towardPreferred ? SWITCH_ADVANTAGE_TOWARD_PREFERRED : SWITCH_ADVANTAGE_AGAINST_PREFERRED);
      if (alternative > current * advantage) isBright = !isBright;
    }

    // Readability wins over smoothing and over the preference: switch at once
    // when the current colour is unreadable and the other is not.
    const rawCurrent = isBright ? rawDark : rawLight;
    const rawAlternative = isBright ? rawLight : rawDark;
    const jumped = this._lastRawLuma === null ||
      Math.abs(luminance - this._lastRawLuma) > BACKGROUND_REALLY_MOVED;
    this._lastRawLuma = luminance;

    const wasBright = isBright;
    if (rawCurrent < readableAt(isBright) && rawAlternative >= readableAt(!isBright) &&
        (jumped || this._roundsSinceFlip >= READABILITY_FLIP_COOLDOWN))
      isBright = !isBright;

    this._roundsSinceFlip = isBright === wasBright ? this._roundsSinceFlip + 1 : 0;
    if (this._lastIsBright !== null && this._lastIsBright !== isBright)
      this._lastSwitchAt = now;
    this._lastIsBright = isBright;
    return isBright ? config.darkTextColor : config.lightTextColor;
  }

  private _inSettleHold(now: number = GLib.get_monotonic_time()): boolean {
    return this._lastSwitchAt !== null && now - this._lastSwitchAt < SWITCH_SETTLE_MS * 1000;
  }

  _backdropColorFor(actor: Clutter.Actor, config: typeof AdaptiveContrastConfig,
    root: Clutter.Actor | null): string | null {
    const backdrop = backdropLuminance(actor, root);
    if (backdrop === null) return null;

    return this.decideTextColor(backdrop.luminance, { ...config, samplePerElement: true });
  }

  /**
   * @param paintSignature Optional counter that advances whenever the glass
   *   under the text is painted. Anything that changes under the text
   *   repaints that glass, so while the counter stands still the capture is
   *   skipped and an empty map returned (the applied colours stay).
   * @param backdrops The glasses under the text, whose backdrops are measured
   *   in place of the screen; see _measure().
   */
  async chooseColorsForActors(actors: Clutter.Actor[], config: typeof AdaptiveContrastConfig = AdaptiveContrastConfig,
    root: Clutter.Actor | null = null, paintSignature?: () => number,
    backdrops?: () => BackdropSource[]): Promise<Map<Clutter.Actor, string>> {
    const { targets, rects } = _visibleTargets(actors);
    if (targets.length === 0)
      return new Map();

    const merged = config.samplePerElement ? null : _rootOrMergedRect(root, rects);
    const mergedRects = merged ? [merged] : [];
    const sampledRects = config.samplePerElement ? rects : mergedRects;
    const key = _skipKey(config.samplePerElement ? rects : [...sampledRects, ...rects], config);
    const before = _readSignature(paintSignature);
    if (before !== null && before === this._unchangedSignature && key === this._unchangedKey)
      return new Map();

    // Only a converged decision may be frozen: the merged path smooths over
    // samples and holds after a flip. The capture itself paints the region,
    // so it may advance the counter by one per screenshot; more means the
    // screen changed meanwhile.
    const settle = (stable: boolean) => {
      const after = _readSignature(paintSignature);
      if (stable && before !== null && after !== null && after - before <= sampledRects.length) {
        this._unchangedSignature = after;
        this._unchangedKey = key;
      } else {
        this.invalidate();
      }
    };

    const sources = backdrops?.() ?? [];
    if (config.samplePerElement)
      return this._choosePerElement(targets, rects, config, settle, sources);
    if (!merged)
      return new Map();
    // Text that is not laid out yet, as in a menu opening for the first time,
    // takes the same colour, so it does not show up in the old one.
    return this._chooseMerged(actors, merged, config, settle, sources);
  }

  private _resetIfRegionMoved(merged: SampleRect): void {
    const last = this._lastRect;
    const moved = !last || (['x', 'y', 'width', 'height'] as const).some(k => Math.abs(merged[k] - last[k]) > 2);
    if (moved) {
      this._lastLuma = null;
      this._lastIsBright = null;
      this._lastRawLuma = null;
      this._lastSwitchAt = null;
      this._roundsSinceFlip = READABILITY_FLIP_COOLDOWN;
    }
    this._lastRect = merged;
  }

  private async _chooseMerged(targets: Clutter.Actor[], merged: SampleRect, config: typeof AdaptiveContrastConfig,
    settle: (stable: boolean) => void, sources: BackdropSource[]): Promise<Map<Clutter.Actor, string>> {
    const result = new Map<Clutter.Actor, string>();
    this._resetIfRegionMoved(merged);
    const luma = await this._measure(merged, sources);
    if (luma === null) {
      this.invalidate();
      return result;
    }
    const inHold = this._lastIsBright !== null && this._inSettleHold();
    const color = this.decideTextColor(luma, config);
    const converged = this._lastLuma !== null && Math.abs(this._lastLuma - _clamp(luma, 0, 1)) < 0.01;
    settle(!inHold && color !== null && color === this._lastDecided && converged &&
      this._roundsSinceFlip >= READABILITY_FLIP_COOLDOWN);
    this._lastDecided = color;
    if (color)
      for (const actor of targets) result.set(actor, color);
    return result;
  }

  private async _choosePerElement(targets: Clutter.Actor[], rects: SampleRect[], config: typeof AdaptiveContrastConfig,
    settle: (stable: boolean) => void, sources: BackdropSource[]): Promise<Map<Clutter.Actor, string>> {
    const result = new Map<Clutter.Actor, string>();
    for (let i = 0; i < targets.length; i++) {
      const luma = await this._measure(rects[i], sources);
      if (luma === null) {
        this.invalidate();
        return result;
      }
      const color = this.decideTextColor(luma, config);
      if (color)
        result.set(targets[i], color);
    }
    // Per-element decisions are stateless.
    settle(true);
    return result;
  }
}
