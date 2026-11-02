import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { isActorValid } from './actors.js';
import { reportFrameLoopError } from './logger.js';
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

    for (const [actor, e] of [...this._entries]) {
      if (!isActorValid(actor)) { this._entries.delete(actor); continue; }

      const progress = this._applyEntry(e, now);

      if (progress >= 1) this._entries.delete(actor);
    }

    if (this._entries.size > 0) this._schedule();
  }
}

export const adaptiveColorTweener = new AdaptiveColorTweener();

export const SAME_FRAME_WINDOW_US = 4000;

// Diagnostic switch (global._lgGlass.freezeSync): every per-frame sync tick
// keeps rescheduling but does no work, so the cost of the sync itself can be
// measured. The glass stops following anything that moves while it is on.
let _frameSyncFrozen = false;

export function setFrameSyncFrozen(frozen: boolean): void {
  _frameSyncFrozen = !!frozen;
}

export function isFrameSyncFrozen(): boolean {
  return _frameSyncFrozen;
}

export type IdSlot = { get(): number; set(id: number): void };

export function addBeforeRedraw(callback: GLib.SourceFunc): number {
  return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
}

export function removeBeforeRedraw(id: number): void {
  if (!id) return;
  global.compositor.get_laters().remove(id);
}

export type LaterLoop = {
  alive: () => boolean;
  step: () => void;
  errorTag: string;
  honourFreeze?: boolean;
};

// A self-rescheduling BEFORE_REDRAW chain. The next tick is scheduled before
// step() runs, so an exception in step() is reported (rate-limited) instead of
// silently ending the chain and freezing the glass.
export function startLaterLoop(slot: IdSlot, loop: LaterLoop): boolean {
  if (slot.get() !== 0) return false;
  const tick = (): boolean => {
    slot.set(0);
    if (!loop.alive()) return GLib.SOURCE_REMOVE;
    slot.set(addBeforeRedraw(tick));
    if (loop.honourFreeze && isFrameSyncFrozen()) return GLib.SOURCE_REMOVE;
    try {
      loop.step();
    } catch (e) {
      reportFrameLoopError(loop.errorTag, e);
    }
    return GLib.SOURCE_REMOVE;
  };
  slot.set(addBeforeRedraw(tick));
  return true;
}

export function stopLaterLoop(slot: IdSlot): void {
  const id = slot.get();
  slot.set(0);
  removeBeforeRedraw(id);
}

// Follows the stage's own frames instead of requesting them, so an idle
// desktop does not keep the frame clock running. `first` covers the frame in
// which the loop starts.
export function startStageLoop(signal: IdSlot, first: IdSlot, tick: () => void): boolean {
  if (signal.get() !== 0) return false;
  signal.set(global.stage.connect('before-update', tick));
  first.set(addBeforeRedraw(() => {
    first.set(0);
    tick();
    return GLib.SOURCE_REMOVE;
  }));
  return true;
}

export function stopStageLoop(signal: IdSlot, first: IdSlot): void {
  const signalId = signal.get();
  signal.set(0);
  if (signalId) global.stage.disconnect(signalId);
  stopLaterLoop(first);
}

/**
 * startStageLoop() for a manager's per-frame sync, taking the same loop as
 * startLaterLoop(). `step` runs at most once per frame (several stage views
 * update in the same one), and the loop stops itself once `alive()` is false.
 * Exceptions are reported rate-limited, and the loop keeps running.
 */
export function startSyncLoop(signal: IdSlot, first: IdSlot, loop: LaterLoop): boolean {
  let lastUs = 0;
  return startStageLoop(signal, first, () => {
    if (!loop.alive()) {
      stopStageLoop(signal, first);
      return;
    }
    if (loop.honourFreeze && isFrameSyncFrozen()) return;
    const nowUs = GLib.get_monotonic_time();
    if (nowUs - lastUs < SAME_FRAME_WINDOW_US) return;
    lastUs = nowUs;
    try {
      loop.step();
    } catch (e) {
      reportFrameLoopError(loop.errorTag, e);
    }
  });
}

const MAX_INTERVAL_MS = 50;

type Ticker = { laterId: number, cb: () => boolean, minUs: number, last: number };

let _nextId = 0;
const _tickers: Map<number, Ticker> = new Map();

// Steps an animation at most once per frame from a BEFORE_REDRAW later, which
// also keeps the frame clock running while the animation lives. A GLib timer
// would beat against the frame; smoothness comes from sub-stepping the physics
// (Spring.update()), not from writing the actors more often. `cb` returns true
// to keep going; the returned id stays valid across the reschedules.
export function addFrameTicker(cb: () => boolean, minIntervalMs: number = 0): number {
  const id = ++_nextId;
  const ticker: Ticker = { laterId: 0, cb, minUs: Math.max(0, minIntervalMs || 0) * 1000, last: 0 };
  _tickers.set(id, ticker);
  const schedule = () => {
    ticker.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      ticker.laterId = 0;
      if (_tickers.get(id) !== ticker) return GLib.SOURCE_REMOVE;
      let keep = true;
      const now = GLib.get_monotonic_time();
      // At most once per frame even when several stage views update in the
      // same one (SAME_FRAME_WINDOW_US), and a little slack so a 16ms minimum
      // does not drop a frame whose interval happened to measure 15.9ms.
      const due = ticker.last === 0 ||
        now - ticker.last >= Math.max(SAME_FRAME_WINDOW_US, ticker.minUs - SAME_FRAME_WINDOW_US);
      if (due) {
        ticker.last = now;
        try {
          keep = !!ticker.cb();
        } catch (e) {
          keep = false;
          reportFrameLoopError('frameTicker', e);
        }
      }
      if (_tickers.get(id) !== ticker) return GLib.SOURCE_REMOVE;
      if (keep) schedule();
      else _tickers.delete(id);
      return GLib.SOURCE_REMOVE;
    });
  };
  schedule();
  return id;
}

export function removeFrameTicker(id: number): void {
  const ticker = _tickers.get(id);
  if (!ticker) return;
  _tickers.delete(id);
  if (!ticker.laterId) return;
  global.compositor.get_laters().remove(ticker.laterId);
  ticker.laterId = 0;
}

/**
 * Maps animation-interval-ms onto what a frame-driven animation can do:
 * anything up to one 60Hz frame means every frame (0); larger values cap the
 * frame rate, bounded to what the preferences offer.
 */
export function normalizeAnimationIntervalMs(v: number): number {
  if (!Number.isFinite(v) || v <= 16) return 0;
  return Math.min(Math.round(v), MAX_INTERVAL_MS);
}

// The longest frame the physics follows in full. It covers the 20fps cap the
// preferences offer, so a capped animation keeps its speed; longer gaps (a
// stall) are clamped instead of jumped over.
export const MAX_STEP_S = 0.066;
const SUB_STEP_S = 0.002;

// Damped spring (Hooke's law), integrated with semi-implicit Euler.
export class Spring {
  private stiffness: number;
  private damping: number;
  private mass: number;
  public value: number;
  public velocity: number;
  public target: number;

  constructor(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;

    this.value = 0;
    this.velocity = 0;
    this.target = 0;
  }

  updateParams(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }

  update(elapsedMs: number) {
    let dt = elapsedMs / 1000;
    if (dt > MAX_STEP_S) dt = MAX_STEP_S;

    // Sub-stepped: with the stiffness the preferences allow, a whole frame is
    // not a stable step for an explicit integrator.
    const mass = this.mass > 1e-3 ? this.mass : 1e-3;
    let remaining = dt;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, SUB_STEP_S);
      const springForce = -this.stiffness * (this.value - this.target);
      const dampingForce = -this.damping * this.velocity;
      const acceleration = (springForce + dampingForce) / mass;

      this.velocity += acceleration * h;
      this.value += this.velocity * h;
      remaining -= h;
    }

    // Settled.
    return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
  }
}

// A spring described by response (period, seconds) and damping fraction, as
// SwiftUI does, solved analytically so it cannot diverge at any stiffness.
export class SwiftSpring {
  response = 0.4;
  dampingFraction = 0.7;
  mass = 1.0;

  value = 0;
  velocity = 0;
  target = 0;

  constructor(response: number, dampingFraction: number, mass: number = 1.0) {
    this.updateParams(response, dampingFraction, mass);
  }

  // Out-of-range values (including NaN) keep the previous parameter.
  updateParams(response: number, dampingFraction: number, mass: number = 1.0) {
    if (response > 0.01) this.response = response;
    if (dampingFraction >= 0) this.dampingFraction = dampingFraction;
    if (mass > 0.01) this.mass = mass;
  }

  update(elapsedMs: number): boolean {
    let dt = elapsedMs / 1000;

    if (!(dt > 0)) return false;
    if (dt > 0.1) dt = 0.1;

    if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    const x0 = this.value - this.target;
    const v0 = this.velocity;

    if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    const omega0 = (2 * Math.PI) / this.response;
    const zeta = this.dampingFraction;

    let x_t = 0;
    let v_t = 0;

    if (zeta < 0.999) {
      // Underdamped
      const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
      const alpha = zeta * omega0;
      const exp = Math.exp(-alpha * dt);
      const cos = Math.cos(omegaD * dt);
      const sin = Math.sin(omegaD * dt);

      x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
      v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
    } else if (zeta > 1.001) {
      // Overdamped
      const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
      const gamma1 = -zeta * omega0 + beta;
      const gamma2 = -zeta * omega0 - beta;
      const exp1 = Math.exp(gamma1 * dt);
      const exp2 = Math.exp(gamma2 * dt);

      const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
      const c2 = x0 - c1;

      x_t = c1 * exp1 + c2 * exp2;
      v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
    } else {
      // Critically damped
      const exp = Math.exp(-omega0 * dt);
      x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
      v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
    }

    this.value = x_t + this.target;
    this.velocity = v_t;

    if (!Number.isFinite(this.value)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    this.value = Math.max(-0.5, Math.min(2.5, this.value));

    if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    return false;
  }
}

/**
 * A rectangle carried to each new target by a spring, so it swings a little past it and settles, as liquid
 * does. `rect()` steps the spring to the time it is given.
 */
export class RectSpring {
  private _from: number[];
  private _to: number[];
  private _progress: SwiftSpring;
  private _lastUs = 0;

  constructor(rect: number[], response = 0.42, dampingFraction = 0.72) {
    this._from = [...rect];
    this._to = [...rect];
    this._progress = new SwiftSpring(response, dampingFraction);
    this._progress.value = 1;
    this._progress.target = 1;
  }

  setTarget(target: number[], nowUs: number): void {
    if (target.every((v, i) => Math.abs(v - this._to[i]) < 0.5)) return;
    this._from = this.rect(nowUs);
    this._to = [...target];
    this._progress.value = 0;
    this._progress.velocity = 0;
  }

  rect(nowUs: number): number[] {
    if (this._lastUs) this._progress.update((nowUs - this._lastUs) / 1000);
    this._lastUs = nowUs;
    const p = this._progress.value;
    return this._from.map((v, i) => v + (this._to[i] - v) * p);
  }

  settled(): boolean {
    return this._progress.value === this._progress.target && this._progress.velocity === 0;
  }
}

const CLOSE_SPEED = 15.0;
const CLOSED_BELOW = 0.005;
const OPEN_SNAP_DISTANCE = 0.002;
const OPEN_SNAP_VELOCITY = 0.03;

export interface MenuSpring {
  value: number;
  velocity: number;
  target: number;
  update(elapsedMs: number): boolean;
}

export interface MenuFrame {
  closing: boolean;
  stopped: boolean;
  scale: number;
  opacity: number;
}

function clampOpacity(v: number): number {
  return Math.min(255, Math.max(0, v));
}

// Closing uses exponential decay: faster than the spring and never bounces.
function stepClosing(scale: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const dt = Math.min(elapsedMs / 1000, MAX_STEP_S);
  const k = 1.0 - Math.exp(-CLOSE_SPEED * dt);
  scale.value += (0 - scale.value) * k;
  if (scale.value < CLOSED_BELOW) return { s: 0, stopped: true };
  return { s: scale.value, stopped: false };
}

// Opening uses the spring, which gives the bounce.
function stepOpening(scale: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const settled = scale.update(elapsedMs);
  const s = scale.value;
  // Snap to 1.0 once the bounce has almost settled, instead of micro-stepping forever.
  if (Math.abs(1.0 - s) < OPEN_SNAP_DISTANCE && Math.abs(scale.velocity) < OPEN_SNAP_VELOCITY)
    return { s: 1.0, stopped: true };
  return { s, stopped: settled };
}

export function stepMenuSpring(scale: MenuSpring, elapsedMs: number): MenuFrame {
  const closing = scale.target === 0;
  const { s, stopped } = closing ? stepClosing(scale, elapsedMs) : stepOpening(scale, elapsedMs);
  // Scale 0 crashes Cogl, hence the 0.001 floor. Opacity fades out between
  // scale 1.0 and 0.3, ahead of the shrink.
  if (closing)
    return { closing, stopped, scale: Math.max(0.001, s), opacity: clampOpacity((s - 0.3) / 0.7 * 255) };
  return { closing, stopped, scale: 0.2 + s * 0.8, opacity: clampOpacity((s / 0.3) * 255) };
}

export function applyMenuFrame(frame: MenuFrame, animActor: any, glass: any, menuActor: any, sync: () => void): void {
  animActor.set_scale(frame.scale, frame.scale);
  glass.opacity = frame.opacity;
  animActor.opacity = frame.opacity;
  sync();
  if (!frame.stopped) return;
  if (frame.closing) {
    if (!menuActor) return;
    menuActor.hide();
    glass.opacity = 0;
    animActor.opacity = 0;
    return;
  }
  animActor.set_scale(1.0, 1.0);
  animActor.opacity = 255;
  glass.opacity = 255;
  sync();
}

export function showMenuAtRest(glass: any, animActor: any): void {
  if (!glass) return;
  glass.remove_all_transitions();
  glass.opacity = 255;
  glass.set_scale(1.0, 1.0);
  if (!animActor) return;
  animActor.set_scale(1.0, 1.0);
  animActor.opacity = 255;
}

// A rectangle that eases to each new target in a fixed time, without the
// overshoot of a spring.

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export class RectTween {
  private _from: number[] = [0, 0, 1, 1];
  private _to: number[] = [0, 0, 1, 1];
  private _startUs = 0;

  constructor(private _durationMs: number) {}

  /** Puts it at `rect` [x, y, w, h] and eases from there to `target`. */
  start(rect: number[], target: number[], nowUs: number): void {
    this._from = [...rect];
    this._to = [...target];
    this._startUs = nowUs;
  }

  /** Eases from where it is now to `target`, unless it is already heading there. */
  setTarget(target: number[], nowUs: number): void {
    if (target.every((v, i) => Math.abs(v - this._to[i]) < 0.5)) return;
    this.start(this.rect(nowUs), target, nowUs);
  }

  /** Milliseconds until it lands, 0 once it has. */
  remaining(nowUs: number): number {
    return Math.max(this._durationMs - (nowUs - this._startUs) / 1000, 0);
  }

  rect(nowUs: number): number[] {
    const t = Math.min(Math.max((nowUs - this._startUs) / (this._durationMs * 1000), 0), 1);
    const k = easeOutCubic(t);
    return this._from.map((v, i) => v + (this._to[i] - v) * k);
  }
}

// How a menu's glass grows out of its panel button and goes back into it, as
// one body of glass all the way. Opening, the button's capsule draws itself
// into a round drop as it drops out of the button, and the drop is thrown out
// to where the menu will be and swells to the menu's size, rounding off less
// and less; each time it is also given a push of its own, somewhere
// downwards, so no two openings are quite the same. Closing, the menu shrinks
// back into a drop that rises into the button, stretching into its capsule on
// the way, and fades there. The springs follow liquid-dom (below) 's menu demo.
//
// Note: this implementation is inspired by and adapted from:
// https://github.com/AndrewPrifer/liquid-dom
// Big thanks to the original author (@AndrewPrifer) for the elegant solution.

// [x, y, w, h]
export type Rect = number[];

const STEP_S = 0.002;
const MAX_FRAME_S = 0.05;

class MorphSpring {
  velocity = 0;
  target: number;

  constructor(public value: number, private _stiffness: number, private _damping: number) {
    this.target = value;
  }

  step(dt: number): void {
    const acc = -this._stiffness * (this.value - this.target) - this._damping * this.velocity;
    this.velocity += acc * dt;
    this.value += this.velocity * dt;
  }

  settled(within: number): boolean {
    return Math.abs(this.value - this.target) < within && Math.abs(this.velocity) < within * 10;
  }
}

// [stiffness, damping], unit mass, as liquid-dom's demo has them.
const OPEN_MOVE = [144, 14];
const CLOSE_MOVE = [130, 18];
const CONTENT_FADE = [137, 20];
// The demo throws the menu out at 2400 px/s over about 150 px; here the
// throw is that many times the distance, per second.
const THROW = 16;
// The push each opening gets on top of the throw, px/s per px of the menu's
// shorter side, at its strongest: the menu swings aside or dips by up to
// about 15% of that side before it settles. Its strength is drawn from
// PUSH_MIN to 1 of that (about 10% at the weakest), its direction from
// anywhere in the lower half.
const PUSH = 3.65;
const PUSH_MIN = 0.67;
// The capsule draws into a drop this many times the button's height across,
// while the springs, started on a slow clock that comes up to full speed as
// the capsule ends, carry it a little way down. The clock runs at CLOCK_START
// at first, and the springs start with CAPSULE_PUSH times the way to the menu
// per second.
const DROP_SIZE = 1.15;
const CAPSULE_S = 0.14;
const CLOCK_START = 0.3;
const CLOCK_POWER = 8;
const CAPSULE_PUSH = 2.2;
// Opening from a capsule that a reversal left behind: it first rounds into the drop this long.
const ROUND_S = 0.1;
// Opening from a reversal, the glass opacity and the softening come back to
// their open values over this long.
const REVEAL_S = 0.12;
// The springs swing the drop past the menu; as it swells to the menu's size,
// all but this much of the swing is taken out, so the grown glass does not
// shoot back over the menu.
const SETTLED_SWING = 0.25;
const OPEN_SIZE_S = 0.3;
const CLOSE_SIZE_S = 0.25;
const CONTENT_SCALE_S = 0.3;
// The content starts twice its size.
const CONTENT_CLOSED_SCALE = 2;
// The content is seen through the glass as if it were deep inside it when
// the menu opens, and comes up to the surface over this long.
const LENS_S = 0.3;
// Closing: the drop starts to turn into the capsule once it is this many
// button heights from where the capsule rests, or this long after closing
// began whatever, and rises into place as it does over CLOSE_CAPSULE_S. It
// fades over FADE_S from FADE_DELAY_S after it starts to, so it stays a
// moment as the capsule, and then goes: on the button it only hides
// the clock, bent by the glass.
const ARRIVE_HEIGHTS = 2;
const ARRIVE_MAX_S = 0.6;
const CLOSE_CAPSULE_S = 0.16;
const FADE_DELAY_S = 0.24;
const FADE_S = 0.12;
// Over the button the bent, blurred clock looks muddy, so the refraction and
// the blur are taken down (MorphFrame.soften) as the drop comes back to the
// button, from this many button heights away, and are all the way down when
// it touches the button. Once on its way into the capsule, they are down
// SOFTEN_S after that at the latest.
const SOFTEN_HEIGHTS = 1.5;
const SOFTEN_S = 0.1;

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (t: number, a: number, b: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return x => {
    if (x <= 0 || x >= 1) return Math.min(Math.max(x, 0), 1);
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(Math.max(t - (at(t, x1, x2) - x) / d, 0), 1);
    }
    return at(t, y1, y2);
  };
}

// Slow out of the drop, then quick to the menu's size.
const openSize = cubicBezier(0.8, 0.3, 0.5, 0.8);
const easeOut = (t: number) => 1 - (1 - t) ** 2;
const easeInOut = (t: number) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// Closing, the items are as faded as the opening had them at this many times
// the time it took to reach the size, so they stay longer.
const CLOSE_FADE_HOLD = 1.0;

// How the items fade in as the glass opens, every FADE_STEP_S from its start.
const FADE_STEP_S = 0.002;
const OPEN_FADE = (() => {
  const fade = new MorphSpring(0, CONTENT_FADE[0], CONTENT_FADE[1]);
  fade.target = 1;
  const values: number[] = [];
  for (let t = 0; t < 1; t += FADE_STEP_S) {
    values.push(clamp01(fade.value));
    fade.step(FADE_STEP_S);
  }
  return values;
})();

function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface MorphFrame {
  // The glass and its corner radius.
  body: Rect;
  bodyRadius: number;
  // The menu's items: drawn around the body's center at this scale and opacity.
  contentScale: number;
  contentOpacity: number;
  // How deep in the glass the content looks, 0 (at the surface) to 1.
  lens: number;
  glassOpacity: number;
  // How far the refraction and the blur are taken down, 0 (as set) to 1.
  soften: number;
  // Opening: at rest on the menu. Closing: faded out on the button.
  done: boolean;
}

export class MenuMorphMotion {
  private _t = 0;
  private _x: MorphSpring;
  private _y: MorphSpring;
  private _opacity: MorphSpring;
  // Opening: how long the capsule takes to draw into a drop (0 when the
  // motion takes over from another). The rest of the motion starts after it.
  private _capsuleS: number;
  private _sizeFrom: number[];
  // Opening, how round the corners start, as a fraction of the roundest they
  // can be; closing, the radius they start from.
  private _radiusFrom: number;
  // Opening from a reversal: how long the capsule takes to round into a drop
  // before the glass grows. 0 when it is not a capsule.
  private _roundS = 0;
  // Opening from a reversal: the glass opacity and softening it had.
  private _glassFrom = 1;
  private _softenFrom = 0;
  private _contentFrom: number;
  private _lensFrom: number;
  // Closing: when the drop came near the button, and its size then.
  private _arrivedAt = -1;
  private _arrivedSize: number[] = [];
  // Closing: the furthest the body has been from the button, and how far the
  // refraction and blur are down; they never come back up.
  private _furthest = 0;
  private _soften = 0;
  private _frame: MorphFrame;

  private _pushVx = 0;
  private _pushVy = 0;

  /**
   * Starts towards the menu (`opening`) or back to the button, from `from`
   * (the frame a reversed motion had got to) or from where that motion rests.
   * `random` gives the opening its push.
   */
  constructor(readonly opening: boolean, private _buttonRect: Rect, private _menu: Rect,
    private _menuRadius: number, from: MorphFrame | null = null, velocities: number[] | null = null,
    random: () => number = Math.random) {
    const start: MorphFrame = from ?? (opening
      ? {
        body: [..._buttonRect], bodyRadius: _buttonRect[3] / 2, contentScale: CONTENT_CLOSED_SCALE,
        contentOpacity: 0, lens: 1, glassOpacity: 1, soften: 0, done: false
      }
      : {
        body: [..._menu], bodyRadius: _menuRadius, contentScale: 1, contentOpacity: 1, lens: 0, glassOpacity: 1,
        soften: 0, done: false
      });
    this._frame = start;
    this._capsuleS = opening && !from ? CAPSULE_S : 0;

    const [stiffness, damping] = opening ? OPEN_MOVE : CLOSE_MOVE;
    // The drop is thrown from where it fell to.
    const [cx, y] = center(start.body);
    this._x = new MorphSpring(cx, stiffness, damping);
    this._y = new MorphSpring(y, stiffness, damping);
    this._opacity = new MorphSpring(start.contentOpacity, CONTENT_FADE[0], CONTENT_FADE[1]);
    if (velocities) [this._x.velocity, this._y.velocity] = velocities;
    const drop = this._drop();
    this._sizeFrom = this._capsuleS ? [drop, drop] : [start.body[2], start.body[3]];
    this._radiusFrom = opening
      ? start.bodyRadius / Math.max(Math.min(start.body[2], start.body[3]) / 2, 1)
      : start.bodyRadius;
    if (opening && from) {
      const [fw, fh] = [start.body[2], start.body[3]];
      if (Math.min(fw, fh) <= drop * 1.01 && Math.max(fw, fh) > drop * 1.05) this._roundS = ROUND_S;
    }
    this._contentFrom = start.contentScale;
    this._lensFrom = start.lens;
    this._glassFrom = start.glassOpacity;
    this._softenFrom = start.soften;
    this._aim();
    if (opening && !velocities) {
      const launch = this._capsuleS ? CAPSULE_PUSH : THROW * 0.5;
      for (const s of [this._x, this._y]) s.velocity = (s.target - s.value) * launch;
      const angle = random() * Math.PI;
      const push = PUSH * Math.min(_menu[2], _menu[3]) * lerp(PUSH_MIN, 1, random());
      this._pushVx = Math.cos(angle) * push;
      this._pushVy = Math.sin(angle) * push;
    }
  }

  /** The body's velocity, for a motion that reverses this one. */
  get velocities(): number[] {
    return [this._x.velocity, this._y.velocity];
  }

  get frame(): MorphFrame {
    return this._frame;
  }

  /** Where the button and the menu are now; they may move while it runs. */
  retarget(button: Rect, menu: Rect | null, menuRadius: number): void {
    this._buttonRect = button;
    if (menu) this._menu = menu;
    this._menuRadius = menuRadius;
    this._aim();
  }

  // The round drop between the capsule and the menu, px across.
  private _drop(): number {
    const [, , w, h] = this._buttonRect;
    return Math.max(Math.min(h * DROP_SIZE, w), 1);
  }

  private _aim(): void {
    [this._x.target, this._y.target] = center(this.opening ? this._menu : this._buttonRect);
    this._opacity.target = this.opening ? 1 : 0;
  }

  /** Advances by `elapsed` seconds. */
  step(elapsed: number, speed: number): MorphFrame {
    let dt = Math.min(Math.max(elapsed, 0), MAX_FRAME_S);
    dt *= speed;
    this._t += dt;
    this._frame = this.opening ? this._open(dt) : this._close(dt);
    return this._frame;
  }

  private _stepSprings(dt: number, motionOnly = false): void {
    const springs = motionOnly ? [this._x, this._y] : [this._x, this._y, this._opacity];
    for (let t = 0; t < dt; t += STEP_S) {
      const h = Math.min(STEP_S, dt - t);
      for (const s of springs) s.step(h);
    }
  }

  private _open(dt: number): MorphFrame {
    if (this._capsuleS) {
      // The springs run on a clock that is at full speed, with no
      // acceleration of its own, where the capsule ends, so position,
      // velocity and acceleration carry over without a step.
      const before = this._t - dt;
      const span = Math.min(this._t, this._capsuleS) - Math.min(before, this._capsuleS);
      if (span > 0) {
        const u = (before + span / 2) / this._capsuleS;
        const ease = u * u * u * (u * (u * 6 - 15) + 10);
        this._stepSprings(span * lerp(CLOCK_START, 1, ease ** CLOCK_POWER), true);
      }
    }
    if (this._t < this._capsuleS) {
      const t = this._t / this._capsuleS;
      // It leaves the button as a capsule and rounds off on the way down.
      const k = easeInOut(clamp01((t - 0.3) / 0.7));
      const [, , bw, bh] = this._buttonRect;
      const drop = this._drop();
      const w = lerp(bw, drop, k), h = lerp(bh, drop, k);
      const x = this._x.value, y = this._y.value;

      this._radiusFrom = 1;

      return {
        body: [x - w / 2, y - h / 2, w, h], bodyRadius: Math.min(w, h) / 2,
        contentScale: CONTENT_CLOSED_SCALE, contentOpacity: 0, lens: 1, glassOpacity: 1, soften: 0, done: false
      };
    }
    const t = this._t - this._capsuleS;
    this._stepSprings(Math.min(dt, t));
    if (t > 0 && t < 0.2 && (this._pushVx !== 0 || this._pushVy !== 0)) {
      const forceFactor = Math.sin((t / 0.2) * Math.PI) * (dt / 0.2);
      this._x.velocity += this._pushVx * forceFactor;
      this._y.velocity += this._pushVy * forceFactor;
    }
    const g = t - this._roundS;
    let w: number, h: number, radius: number;
    if (g < 0) {
      // A capsule from a reversal goes through the round drop before it grows.
      const drop = this._drop();
      const c = easeInOut(clamp01(t / this._roundS));
      w = lerp(this._sizeFrom[0], drop, c);
      h = lerp(this._sizeFrom[1], drop, c);
      radius = Math.min(w, h) / 2;
    } else {
      const from = this._roundS ? [this._drop(), this._drop()] : this._sizeFrom;
      const k = openSize(clamp01(g / OPEN_SIZE_S));
      w = lerp(from[0], this._menu[2], k);
      h = lerp(from[1], this._menu[3], k);
      // The corners square off as the glass grows, and are the menu's once it has.
      const menuRound = this._menuRadius / Math.max(Math.min(this._menu[2], this._menu[3]) / 2, 1);
      const roundFrom = this._roundS ? 1 : this._radiusFrom;
      // Never a corner sharper than the menu's while the drop is still smaller than it.
      radius = Math.max(lerp(roundFrom, menuRound, k) * Math.min(w, h) / 2, Math.min(this._menuRadius, w / 2, h / 2));
    }
    const k = openSize(clamp01(Math.max(g, 0) / OPEN_SIZE_S));
    const reveal = clamp01(t / REVEAL_S);
    const moving = !this._x.settled(0.5) || !this._y.settled(0.5);
    // Cubed, so the swing starts being taken out with no step in velocity or acceleration.
    const swing = lerp(1, SETTLED_SWING, k ** 3);
    const x = this._x.target + (this._x.value - this._x.target) * swing;
    const y = this._y.target + (this._y.value - this._y.target) * swing;
    return {
      body: [x - w / 2, y - h / 2, w, h],
      bodyRadius: Math.min(radius, w / 2, h / 2),
      contentScale: lerp(this._contentFrom, 1, easeOut(clamp01(t / CONTENT_SCALE_S))),
      contentOpacity: clamp01(this._opacity.value),
      lens: this._lensFrom * (1 - clamp01(t / LENS_S) ** 2),
      glassOpacity: lerp(this._glassFrom, 1, reveal),
      soften: lerp(this._softenFrom, 0, reveal),
      done: !moving && g >= OPEN_SIZE_S,
    };
  }

  // The items fade as they did when the glass opened to this size.
  private _closeOpacity(w: number, h: number): number {
    const drop = this._drop();
    const grown = Math.min((w - drop) / Math.max(this._menu[2] - drop, 1), (h - drop) / Math.max(this._menu[3] - drop, 1));
    const k = clamp01(grown);
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (openSize(mid) < k) lo = mid;
      else hi = mid;
    }
    return OPEN_FADE[Math.min(Math.round(lo * OPEN_SIZE_S * CLOSE_FADE_HOLD / FADE_STEP_S), OPEN_FADE.length - 1)];
  }

  private _close(dt: number): MorphFrame {
    this._stepSprings(dt);
    const t = this._t;
    const drop = this._drop();
    const targetW = Math.min(this._sizeFrom[0], drop);
    const targetH = Math.min(this._sizeFrom[1], drop);
    const k = easeOut(clamp01(t / CLOSE_SIZE_S));
    const w = lerp(this._sizeFrom[0], targetW, k);
    const h = lerp(this._sizeFrom[1], targetH, k);
    // Rounding off into the drop as it shrinks, as the opening squares off as it grows.
    const radius = lerp(this._radiusFrom, Math.min(w, h) / 2, k);
    let body = [this._x.value - w / 2, this._y.value - h / 2, w, h];
    let bodyRadius = Math.min(radius, w / 2, h / 2);

    const [hx, hy] = center(this._buttonRect);
    const near = Math.hypot(this._x.value - hx, this._y.value - hy) <= this._buttonRect[3] * ARRIVE_HEIGHTS;
    if (this._arrivedAt < 0 && ((near && t >= CLOSE_SIZE_S) || t >= ARRIVE_MAX_S || this._sizeFrom[0] <= drop)) {
      this._arrivedAt = t;
      this._arrivedSize = [w, h];
    }
    let glassOpacity = 1;
    let since = -1;
    if (this._arrivedAt >= 0) {
      // Into the capsule as it rises, ending on the button wherever the springs are.
      since = t - this._arrivedAt;
      const c = easeInOut(clamp01(since / CLOSE_CAPSULE_S));
      const [aw, ah] = this._arrivedSize;
      const [, , bw, bh] = this._buttonRect;
      const cw = lerp(aw, bw, c), ch = lerp(ah, bh, c);
      const cx = lerp(this._x.value, hx, c), cy = lerp(this._y.value, hy, c);
      body = [cx - cw / 2, cy - ch / 2, cw, ch];
      bodyRadius = Math.min(cw, ch) / 2;
      glassOpacity = 1 - easeInOut(clamp01((since - FADE_DELAY_S) / FADE_S));
    }
    // Measured from the furthest it got, so a menu that opened right below
    // the button does not start out half way down.
    const gap = rectGap(body, this._buttonRect);
    this._furthest = Math.max(this._furthest, gap);
    const ramp = Math.min(this._buttonRect[3] * SOFTEN_HEIGHTS, this._furthest);
    const closeness = ramp > 0 ? 1 - gap / ramp : 1;
    this._soften = Math.max(this._soften, clamp01(closeness), since >= 0 ? clamp01(since / SOFTEN_S) : 0);
    const soften = this._soften;
    return {
      body,
      bodyRadius,
      contentScale: lerp(this._contentFrom, CONTENT_CLOSED_SCALE, easeOut(clamp01(t / CONTENT_SCALE_S))),
      contentOpacity: this._closeOpacity(w, h),
      lens: lerp(this._lensFrom, 1, easeOut(clamp01(t / LENS_S))),
      glassOpacity,
      soften,
      done: glassOpacity === 0,
    };
  }
}

// How far apart two rects are, 0 when they touch or overlap.
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(b[0] - (a[0] + a[2]), a[0] - (b[0] + b[2]), 0);
  const dy = Math.max(b[1] - (a[1] + a[3]), a[1] - (b[1] + b[3]), 0);
  return Math.hypot(dx, dy);
}

function center(r: Rect): number[] {
  return [r[0] + r[2] / 2, r[1] + r[3] / 2];
}

// Quick Settings' buttons coming out as the menu opens in toggle mode. They
// start smaller, gathered towards the middle of the area they end up in, and
// spring out to their places, those nearest the panel button fastest. Their
// glass shows from the start; their labels and icons fade in as they go.

// The size and spread the buttons start at, as a share of their own.
const START_SCALE = 0.7;
// A spring that swings once just past the end and settles without a second
// swing (about 6% over, then under 0.5%).
const RESPONSE_S = 0.27;
const DAMPING_FRACTION = 0.66;
// Its speed at the start, in the whole way per second. From rest it would hardly move in the first frames, which
// reads as a pause before the buttons grow.
const START_VELOCITY = 4;
// How fast the button furthest from the panel button springs out, as a share of the nearest's speed. Every button
// moves from the first frame, so none sits at its start size waiting for its turn.
const SLOWEST_SPEED = 0.65;
// The spring is within 0.2% of the end by then.
const SETTLE_S = Math.log(500) / (DAMPING_FRACTION * 2 * Math.PI / RESPONSE_S);
// The least gap (px) kept between two buttons' glass while they swing past their size.
export const MIN_GLASS_GAP = 3;
// How strongly the larger of two buttons that come too close is the one made smaller.
const YIELD_POWER = 8;

/** The spring's progress (0 to about 1.06, then 1) `t` seconds after it starts. */
export function introProgress(t: number): number {
  if (t <= 0) return 0;
  const omega0 = 2 * Math.PI / RESPONSE_S;
  const zeta = DAMPING_FRACTION;
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega0 * t);
  return 1 - decay * (Math.cos(omegaD * t) + (zeta * omega0 - START_VELOCITY) / omegaD * Math.sin(omegaD * t)); // 1 - decay * wave * start velocity -> t
}

export interface IntroFrame {
  // Each button's rect [x, y, w, h], in the coordinates of the rects given.
  rects: number[][];
  // Of each button's content, 0 to 1.
  opacity: number[];
  done: boolean;
}

/**
 * The buttons' rects over time, from their rects at rest `rects` [x, y, w, h],
 * the point they come from first `anchor` (the panel button) and how far
 * their glass reaches past them `expand`.
 */
export class ToggleIntro {
  private _center: [number, number];
  private _speeds: number[];
  // Pairs of buttons and the least gap kept between them.
  private _pairs: { i: number, j: number, gap: number }[] = [];

  constructor(private _rects: number[][], anchor: [number, number], expand: number) {
    const x0 = Math.min(..._rects.map(r => r[0]));
    const y0 = Math.min(..._rects.map(r => r[1]));
    const x1 = Math.max(..._rects.map(r => r[0] + r[2]));
    const y1 = Math.max(..._rects.map(r => r[1] + r[3]));
    this._center = [(x0 + x1) / 2, (y0 + y1) / 2];

    const distances = _rects.map(r => Math.hypot(r[0] + r[2] / 2 - anchor[0], r[1] + r[3] / 2 - anchor[1]));
    const near = Math.min(...distances);
    const span = Math.max(...distances) - near;
    this._speeds = distances.map(d => span > 0 ? 1 - (1 - SLOWEST_SPEED) * (d - near) / span : 1);

    for (let i = 0; i < _rects.length; i++) {
      for (let j = i + 1; j < _rects.length; j++) {
        const rest = distance(_rects[i], _rects[j]);
        // Buttons whose glass already touches at rest are left as they are.
        if (rest - 2 * expand < 0) continue;
        this._pairs.push({ i, j, gap: Math.min(rest, 2 * expand + MIN_GLASS_GAP) });
      }
    }
  }

  frame(t: number): IntroFrame {
    const [cx, cy] = this._center;
    const progress = this._speeds.map(speed => introProgress(t * speed));
    const rects = this._rects.map((r, i) => {
      const k = START_SCALE + (1 - START_SCALE) * progress[i];
      const mx = cx + (r[0] + r[2] / 2 - cx) * k;
      const my = cy + (r[1] + r[3] / 2 - cy) * k;
      return [mx - r[2] * k / 2, my - r[3] * k / 2, r[2] * k, r[3] * k];
    });
    this._keepApart(rects);
    return {
      rects,
      opacity: progress.map(p => Math.min(Math.max(p, 0), 1)),
      done: t >= SETTLE_S / SLOWEST_SPEED,
    };
  }

  // Buttons grow and swing at different speeds, so one can grow into its
  // neighbour; both are made smaller about their middles until their glass is
  // far enough apart, the larger (as a share of its size at rest) by most of
  // the shortfall. The shares are weighed rather than compared, so the sizes
  // change smoothly when one button overtakes the other.
  private _keepApart(rects: number[][]): void {
    for (let pass = 0; pass < 3; pass++) { // loop 3 times to settle
      for (const { i, j, gap } of this._pairs) {
        const short = gap - distance(rects[i], rects[j]); // calculate the gap between the buttons
        if (short <= 0) continue;
        const [gx, gy] = axisGaps(rects[i], rects[j]);
        const [wi, wj] = [i, j].map(n => (rects[n][2] / this._rects[n][2]) ** YIELD_POWER); // which to make smaller
        for (const [n, weight] of [[i, wi / (wi + wj)], [j, wj / (wi + wj)]]) {
          const r = rects[n];
          // Each side that faces the other moves in by this share of the shortfall.
          const shrink = (axis: number) => (r[axis + 2] - 2 * short * weight) / r[axis + 2];
          const k = Math.max(gx > 0 && gy > 0 ? Math.min(shrink(0), shrink(1)) : shrink(gx > gy ? 0 : 1), 0.5);
          const [mx, my] = [r[0] + r[2] / 2, r[1] + r[3] / 2];
          rects[n] = [mx - r[2] * k / 2, my - r[3] * k / 2, r[2] * k, r[3] * k];
        }
      }
    }
  }
}

// The gaps between two rects [x, y, w, h] across and down; negative where they overlap.
function axisGaps(a: number[], b: number[]): [number, number] {
  return [Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]), Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3])];
}

// How far apart two rects are: corner to corner when they are apart both ways.
function distance(a: number[], b: number[]): number {
  const [gx, gy] = axisGaps(a, b);
  return gx > 0 && gy > 0 ? Math.hypot(gx, gy) : Math.max(gx, gy);
}
