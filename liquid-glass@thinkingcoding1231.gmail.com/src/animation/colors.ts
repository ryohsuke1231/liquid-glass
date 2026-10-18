import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { isActorValid } from '../actors/lifecycle.js';
// The adaptive text color flips between a light and a dark color.
// Interpolating those in RGB passes through mid-grey, which is unreadable on
// the very background that triggered the flip, so a real light/dark flip
// cross-dissolves instead: fade the old color out (easeIn), swap at the
// bottom of the dip, fade the new one in (easeOut). Alpha is scaled between
// the two endpoint alphas, so an actor that turns insensitive mid-flip still
// ends at its own alpha.
export interface RgbColor { r: number; g: number; b: number; }

// '#rrggbb' as normalized [r, g, b]; anything else gives white.
export function hexToColorArray(hex: string): [number, number, number] {
  if (!hex || !hex.startsWith('#') || hex.length !== 7)
    return [1.0, 1.0, 1.0];
  return [
    parseInt(hex.slice(1, 3), 16) / 255.0,
    parseInt(hex.slice(3, 5), 16) / 255.0,
    parseInt(hex.slice(5, 7), 16) / 255.0,
  ];
}

export function hexToRgb(hex: string): RgbColor {
  const value = parseInt(hex.replace('#', ''), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}

export function crossFadeColorAt(
  start: RgbColor, startAlpha: number,
  target: RgbColor, targetAlpha: number,
  progress: number
): { r: number; g: number; b: number; a: number } {
  const p = Math.max(0, Math.min(1, progress));
  if (p < 0.5) {
    const local = p / 0.5;
    const a = startAlpha * (1 - local * local);
    return { r: start.r, g: start.g, b: start.b, a };
  }
  const local = (p - 0.5) / 0.5;
  // easeOutQuad on the fade-in: mirrors the curve above.
  const e = 1 - (1 - local) * (1 - local);
  return { r: target.r, g: target.g, b: target.b, a: targetAlpha * e };
}

// A small change (off-white to white) has no grey to pass through, and a
// dissolve would only add a flicker. Rec. 709 luma difference, 0..1.
const CROSS_FADE_LUMA_DELTA = 0.4;

export function shouldCrossFadeColors(start: RgbColor, target: RgbColor): boolean {
  const luma = (c: RgbColor) =>
    (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return Math.abs(luma(target) - luma(start)) > CROSS_FADE_LUMA_DELTA;
}

// Plain per-channel interpolation (easeInOutQuad), used for small changes.
export function lerpColorAt(
  start: RgbColor, startAlpha: number,
  target: RgbColor, targetAlpha: number,
  progress: number
): { r: number; g: number; b: number; a: number } {
  const p = Math.max(0, Math.min(1, progress));
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  return {
    r: Math.round(start.r + (target.r - start.r) * e),
    g: Math.round(start.g + (target.g - start.g) * e),
    b: Math.round(start.b + (target.b - start.b) * e),
    a: startAlpha + (targetAlpha - startAlpha) * e,
  };
}

// 'rgb-lerp' interpolates every change, flips included, for comparison through
// global._lgGlass.textColorMode().
export type AdaptiveColorMode = 'cross-fade' | 'rgb-lerp';

let _adaptiveColorMode: AdaptiveColorMode = 'cross-fade';

export function setAdaptiveColorMode(mode: AdaptiveColorMode): void {
  _adaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
}

export function getAdaptiveColorMode(): AdaptiveColorMode {
  return _adaptiveColorMode;
}

// Whether this change should dissolve rather than interpolate.
export function resolveCrossFade(start: RgbColor, target: RgbColor): boolean {
  return _adaptiveColorMode === 'cross-fade' && shouldCrossFadeColors(start, target);
}

// One frame-driven clock for every adaptive-color tween. Per-actor GLib
// timers flipped a row of labels out of step and beat against the frame rate;
// stepping every actor from the same timestamp in one BEFORE_REDRAW pass keeps
// them together and smooth. Actors queued in the same turn share a start time
// (`batchStart`). The later chain only runs while something is animating.
interface ColorTweenEntry {
  startRgb: RgbColor;
  startAlpha: number;
  targetRgb: RgbColor;
  targetAlpha: number;
  crossFade: boolean;
  durationMs: number;
  startTime: number; // GLib monotonic microseconds
  // `progress` is for the OSD level bar, whose track color follows the same clock.
  apply: (r: number, g: number, b: number, a: number, progress: number) => void;
  // False when `apply` writes more than (r,g,b,a) describes (the level bar's
  // track), so a repeated tuple must still be applied. Defaults to true.
  coalesce?: boolean;
  last?: { r: number; g: number; b: number; a: number };
}

class AdaptiveColorTweener {
  private _entries: Map<any, ColorTweenEntry> = new Map();
  private _laterId: number = 0;

  /**
   * @param batchStart monotonic timestamp shared by every actor updated in the
   *   same turn. Callers pass one value for a whole color map so the actors
   *   move in lockstep; omitted, the actor starts from now.
   */
  add(actor: any, entry: Omit<ColorTweenEntry, 'startTime' | 'last'>, batchStart?: number): void {
    if (!actor) return;
    const prev = this._entries.get(actor);
    // Restarting mid-tween: start from what is on screen, not from the theme
    // node, which St may not have re-resolved yet.
    const startRgb = prev?.last
      ? { r: prev.last.r, g: prev.last.g, b: prev.last.b }
      : entry.startRgb;
    const startAlpha = prev?.last ? prev.last.a : entry.startAlpha;

    this._entries.set(actor, {
      ...entry,
      startRgb,
      startAlpha,
      crossFade: entry.crossFade && shouldCrossFadeColors(startRgb, entry.targetRgb),
      startTime: batchStart ?? GLib.get_monotonic_time(),
    });
    this._schedule();
  }

  cancel(actor: any): void {
    this._entries.delete(actor);
  }

  stopAll(): void {
    this._entries.clear();
    this._unschedule();
  }

  isAnimating(actor: any): boolean {
    return this._entries.has(actor);
  }

  private _schedule(): void {
    if (this._laterId !== 0) return;
    this._laterId = global.compositor.get_laters().add(
      Meta.LaterType.BEFORE_REDRAW,
      () => { this._tick(); return false; }
    );
  }

  private _unschedule(): void {
    if (this._laterId === 0) return;
    global.compositor.get_laters().remove(this._laterId);
    this._laterId = 0;
  }

  private _applyEntry(e: ColorTweenEntry, now: number): number {
    const elapsedMs = (now - e.startTime) / 1000;
    const progress = e.durationMs > 0 ? Math.min(elapsedMs / e.durationMs, 1) : 1;
    const c = e.crossFade
      ? crossFadeColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress)
      : lerpColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress);
    const a = Math.max(0, Math.min(1, c.a));

    // set_style() re-parses CSS and relayouts, so skip frames that would
    // write the same value (the flat ends of the curve).
    const same = e.coalesce !== false && e.last &&
      e.last.r === c.r && e.last.g === c.g && e.last.b === c.b &&
      Math.abs(e.last.a - a) < 0.002;
    if (!same) {
      e.last = { r: c.r, g: c.g, b: c.b, a };
      e.apply(c.r, c.g, c.b, a, progress);
    }
    return progress;
  }

  private _tick(): void {
    this._laterId = 0;
    const now = GLib.get_monotonic_time();

    for (const [actor, e] of this._entries) {
      if (!isActorValid(actor)) { this._entries.delete(actor); continue; }

      const progress = this._applyEntry(e, now);

      if (progress >= 1) this._entries.delete(actor);
    }

    if (this._entries.size > 0) this._schedule();
  }
}

export const adaptiveColorTweener = new AdaptiveColorTweener();
