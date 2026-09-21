import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { isActorValid } from '../actors/lifecycle.js';
// ─── Adaptive text colour: polarity cross-fade ──────────────────────────────
//
// The adaptive text colour only ever flips between the configured light and
// dark colours (white <-> black by default). Interpolating those two in RGB
// walks the text straight through mid-grey, and mid-grey text is exactly what
// sits on top of a background whose luminance just crossed the threshold that
// triggered the flip — so the label vanishes for the middle third of the
// tween. That is why the polarity case used to be snapped instead of animated
// (`skipAnimations || changesPolarity`, commit 5df9084), which is the hard cut
// this replaces.
//
// A cross-dissolve avoids the grey entirely: fade the OLD colour out, swap the
// colour at the bottom of the dip where nothing is drawn anyway, fade the NEW
// colour in. easeIn on the way out and easeOut on the way in, so the two
// halves meet with matching slope and read as one motion.
//
// `progress` is 0..1. Alpha is scaled between the two endpoint alphas so an
// actor that also becomes insensitive mid-flip still lands on 0.5.
export interface RgbColor { r: number; g: number; b: number; }

export function crossFadeColorAt(
  start: RgbColor, startAlpha: number,
  target: RgbColor, targetAlpha: number,
  progress: number
): { r: number; g: number; b: number; a: number } {
  const p = Math.max(0, Math.min(1, progress));
  if (p < 0.5) {
    const local = p / 0.5;
    // easeInQuad on the fade-out: holds the readable colour a little longer.
    const a = startAlpha * (1 - local * local);
    return { r: start.r, g: start.g, b: start.b, a };
  }
  const local = (p - 0.5) / 0.5;
  // easeOutQuad on the fade-in: mirrors the curve above.
  const e = 1 - (1 - local) * (1 - local);
  return { r: target.r, g: target.g, b: target.b, a: targetAlpha * e };
}

// Only a real light<->dark flip earns the dissolve. A small nudge (the theme's
// own off-white to pure white, say) has no grey to walk through, and dipping
// the alpha for it would invent a flicker where a plain lerp is invisible.
// Rec. 709 luma, 0..1; the threshold is far below a white/black flip (1.0) and
// far above any within-palette adjustment.
const CROSS_FADE_LUMA_DELTA = 0.4;

export function shouldCrossFadeColors(start: RgbColor, target: RgbColor): boolean {
  const luma = (c: RgbColor) =>
    (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return Math.abs(luma(target) - luma(start)) > CROSS_FADE_LUMA_DELTA;
}

/**
 * The plain channel-by-channel interpolation, kept as the A/B alternative to
 * the dissolve. easeInOutQuad, exactly what every manager used to run inline.
 * It walks white->black through mid-grey, which is the legibility problem the
 * dissolve exists to avoid — that is the trade being switched between.
 */
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

// ─── Adaptive text colour: which interpolation runs ─────────────────────────
//
// 'cross-fade' (default) is the dissolve above. 'rgb-lerp' is the plain
// interpolation, i.e. the pre-5df9084 behaviour with the polarity snap taken
// out, so a white<->black flip really does walk through grey. Switchable so
// the two can be compared side by side on the same background:
// global._lgGlass.textColorMode('rgb-lerp') / ('cross-fade').
export type AdaptiveColorMode = 'cross-fade' | 'rgb-lerp';

let _adaptiveColorMode: AdaptiveColorMode = 'cross-fade';

export function setAdaptiveColorMode(mode: AdaptiveColorMode): void {
  _adaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
}

export function getAdaptiveColorMode(): AdaptiveColorMode {
  return _adaptiveColorMode;
}

/**
 * True when this particular change should dissolve rather than lerp: only in
 * 'cross-fade' mode, and only for a real light<->dark flip.
 */
export function resolveCrossFade(start: RgbColor, target: RgbColor): boolean {
  return _adaptiveColorMode === 'cross-fade' && shouldCrossFadeColors(start, target);
}

// ─── Adaptive text colour: the shared tween clock ───────────────────────────
//
// Every manager used to give each actor its own GLib.timeout_add(16). Two
// things went wrong with that, both of them visible:
//
//   * **Out of sync.** N actors meant N independent GLib sources. They are not
//     tied to the frame clock, so each actor's set_style() landed in whichever
//     frame its own source happened to fire in, and a row of labels flipped
//     raggedly instead of together.
//   * **Judder.** A 16ms source against a 16.67ms frame beats: most frames get
//     one update, every ~25th gets two (or none). The colour ramp therefore
//     advanced in uneven steps — the "カクカク" — even though the easing curve
//     itself is smooth.
//
// One driver fixes both. Every actor is stepped from the SAME timestamp, in
// the SAME pass, and the pass is a Meta.LaterType.BEFORE_REDRAW later, so it
// runs exactly once per frame, immediately before the frame that will show its
// result. Actors queued in one turn also share a start time (see `batchStart`)
// so a batch that flips together stays together for the whole tween.
//
// The chain only exists while something is animating: the tick re-arms itself
// only if entries remain, so this is not another always-on per-frame poll.
interface ColorTweenEntry {
  startRgb: RgbColor;
  startAlpha: number;
  targetRgb: RgbColor;
  targetAlpha: number;
  crossFade: boolean;
  durationMs: number;
  startTime: number;               // GLib monotonic microseconds
  // `progress` is handed through for the one caller that has a second colour
  // riding on the same clock (the OSD level bar's track).
  apply: (r: number, g: number, b: number, a: number, progress: number) => void;
  // False when `apply` writes something the (r,g,b,a) tuple does not fully
  // describe — the level bar's track colour has its own delta and can move in
  // a frame where the foreground rounds to the same byte. Such an entry must
  // not have its repeat writes coalesced away. Defaults to true.
  coalesce?: boolean;
  last?: { r: number; g: number; b: number; a: number };
}

class AdaptiveColorTweener {
  private _entries: Map<any, ColorTweenEntry> = new Map();
  private _laterId: number = 0;

  /**
   * @param batchStart monotonic timestamp shared by every actor updated in the
   *   same turn. Callers pass one value for a whole colour map so the actors
   *   move in lockstep; omitted, the actor starts from now.
   */
  add(actor: any, entry: Omit<ColorTweenEntry, 'startTime' | 'last'>, batchStart?: number): void {
    if (!actor) return;
    const prev = this._entries.get(actor);
    // Restarting mid-tween: begin from what is actually on screen, not from
    // the theme node — St has not necessarily re-resolved it yet this frame,
    // and starting from a stale colour is a visible jump.
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
    try {
      this._laterId = (global as any).compositor.get_laters().add(
        Meta.LaterType.BEFORE_REDRAW,
        () => { this._tick(); return false; }
      );
    } catch (_) {
      this._laterId = 0;
    }
  }

  private _unschedule(): void {
    if (this._laterId === 0) return;
    try { (global as any).compositor.get_laters().remove(this._laterId); } catch (_) { }
    this._laterId = 0;
  }

  private _tick(): void {
    this._laterId = 0;
    const now = GLib.get_monotonic_time();

    for (const [actor, e] of [...this._entries]) {
      if (!isActorValid(actor)) { this._entries.delete(actor); continue; }

      const elapsedMs = (now - e.startTime) / 1000;
      const progress = e.durationMs > 0 ? Math.min(elapsedMs / e.durationMs, 1) : 1;
      const c = e.crossFade
        ? crossFadeColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress)
        : lerpColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress);
      const a = Math.max(0, Math.min(1, c.a));

      // set_style() re-parses CSS and dirties the actor's layout, so it is by
      // far the expensive half of this. Skip it when the frame would write the
      // value that is already there (the flat ends of the easing curve).
      const same = e.coalesce !== false && e.last &&
        e.last.r === c.r && e.last.g === c.g && e.last.b === c.b &&
        Math.abs(e.last.a - a) < 0.002;
      if (!same) {
        e.last = { r: c.r, g: c.g, b: c.b, a };
        try { e.apply(c.r, c.g, c.b, a, progress); } catch (_) { }
      }

      if (progress >= 1) this._entries.delete(actor);
    }

    if (this._entries.size > 0) this._schedule();
  }
}

export const adaptiveColorTweener = new AdaptiveColorTweener();
