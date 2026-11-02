import GLib from 'gi://GLib';
import type Clutter from 'gi://Clutter';
import type St from 'gi://St';

import { SwiftSpring, addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs } from './animation.js';
import { getAllocatedSize, isActorValid } from './actors.js';
import { barGrowingMenuFrom, type TopBarManager } from './topBarManager.js';

// The BoxPointer's own open and close eases, which are held while the bar grows and shrinks.
const BOXPOINTER_EASED = ['opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y'];
const BOXPOINTER_HOLD_MS = 10000;
// How far the menu's glass starts inside the bar's, so the two read as one body with no seam where they meet.
const OVERLAP = 4;
// The growth's spring: a little quicker than the drop morph, and settling with a small swing past the menu.
const RESPONSE_S = 0.36;
const DAMPING_FRACTION = 0.8;
// Frames to wait for a menu that is not laid out yet before it opens without the growth.
const WAIT_FRAMES = 30;
// The items come up through the glass over the last part of the growth.
const CONTENT_FROM = 0.45;
// Closing ends here rather than waiting out the spring's tail, while the hidden menu still takes the pointer.
const CLOSED_BELOW = 0.02;

/** What a menu manager tells BarGrowth about its menu. */
export interface BarGrowthHost {
  menu: any;
  // The menu's BoxPointer and the box of its items.
  targetActor: St.Widget;
  animActor: St.Widget;
  // The button the menu opened from.
  source(): Clutter.Actor | null;
  // The button's capsule, [x, y, w, h] on the stage, or null when it is not on screen.
  button(): number[] | null;
  // How far the menu's glass reaches past its items, px.
  expand(): number;
  // The radius of the menu glass's corners.
  radius(): number;
  // The manager's animation interval, ms.
  intervalMs(): number;
}

/**
 * A menu that grows out of the top bar's glass instead of floating below it (top-bar-menus-grow). The bar draws
 * the menu's glass as part of its own; the menu manager's glass stays hidden meanwhile. Opening, the glass runs
 * down out of the bar below the button and widens into the menu, its items coming up through it; closing runs back.
 */
export class BarGrowth {
  private _bar: TopBarManager | null = null;
  private _progress = new SwiftSpring(RESPONSE_S, DAMPING_FRACTION);
  private _opening = false;
  private _tickId = 0;
  private _lastUs = 0;
  private _waitFrames = 0;
  private _button: number[] | null = null;

  constructor(private _host: BarGrowthHost) {}

  /** Whether the bar draws the menu now, as it grows or at rest. */
  get holding(): boolean {
    return this._bar !== null;
  }

  /**
   * Starts the menu growing out of the bar (`open`) or back into it. False when the menu does not grow out of a
   * bar; the manager then animates it as usual.
   */
  start(open: boolean): boolean {
    const bar = barGrowingMenuFrom(this._host.source()) ?? (open ? null : this._bar);
    if (!bar) {
      this.release();
      return false;
    }
    if (this._bar && this._bar !== bar) this._bar.setMenuGrowth(this, null, 0);
    this._bar = bar;
    this._opening = open;
    this._progress.target = open ? 1 : 0;
    this._waitFrames = 0;
    // The items keep their size; a scale the menu's own spring left behind would shrink them and the glass.
    const a = this._host.animActor;
    a.remove_all_transitions();
    a.set_scale(1, 1);
    if (open) a.opacity = 0;
    if (!this._tickId) {
      this._lastUs = 0;
      this._tickId = addFrameTicker(() => this._step(), normalizeAnimationIntervalMs(this._host.intervalMs()));
    }
    return true;
  }

  /**
   * Keeps the bar drawing the resting menu, for a manager's per-frame sync. True while it does, and the manager's
   * own glass is to stay hidden.
   */
  holdAtRest(): boolean {
    if (this._tickId) return true;
    const bar = this._host.targetActor.mapped ? barGrowingMenuFrom(this._host.source()) : null;
    if (bar !== this._bar) this.release();
    if (!bar) return false;
    this._bar = bar;
    this._progress.value = this._progress.target = 1;
    const body = this._body();
    if (body) this._place(body, 1);
    return true;
  }

  /** Takes the menu's glass back into the bar at once and leaves the menu's items as the manager expects them. */
  release(): void {
    if (this._tickId) {
      removeFrameTicker(this._tickId);
      this._tickId = 0;
    }
    if (!this._bar) return;
    this._bar.setMenuGrowth(this, null, 0);
    this._bar = null;
    this._progress.value = this._progress.target = 0;
    this._progress.velocity = 0;
    const a = this._host.animActor;
    if (!isActorValid(a)) return;
    a.remove_clip();
    a.opacity = 255;
  }

  private _step(): boolean {
    const host = this._host;
    const bar = this._bar;
    if (!bar) {
      this._tickId = 0;
      return false;
    }
    // The menu stays where it opens and stays visible until the glass is back in the bar.
    for (const name of BOXPOINTER_EASED) {
      const ease = host.targetActor.get_transition(name);
      if (!ease) continue;
      if (this._opening) ease.set_from(ease.get_interval().peek_final_value());
      else ease.set_to(ease.get_interval().peek_initial_value());
      if (!this._opening && name === 'opacity') ease.set_duration(BOXPOINTER_HOLD_MS);
    }

    this._button = host.button() ?? this._button;
    const body = this._body();
    if (!body || !this._button) {
      if (++this._waitFrames < WAIT_FRAMES) return true;
      this._tickId = 0;
      this.release();
      return false;
    }

    const now = GLib.get_monotonic_time();
    const settled = this._progress.update(this._lastUs ? (now - this._lastUs) / 1000 : 1000 / 60);
    this._lastUs = now;
    const p = this._progress.value;
    const [bx, , bw] = this._button;
    const lerp = (from: number, to: number) => from + (to - from) * p;
    const bottom = bar.glassBottom();
    const left = lerp(bx, body[0]);
    const right = lerp(bx + bw, body[0] + body[2]);
    const reach = lerp(bottom, body[1] + body[3]);
    this._place([left, body[1], right - left, reach - body[1]], p);
    if (!settled && (this._opening || p > CLOSED_BELOW)) return true;

    this._tickId = 0;
    if (this._opening) {
      host.animActor.remove_clip();
      host.animActor.opacity = 255;
    } else {
      this.release();
      host.animActor.opacity = 0;
      if (!host.menu.isOpen) host.targetActor.hide();
    }
    return false;
  }

  // The menu's glass body where its items are, [x, y, w, h] on the stage, or null before they are laid out.
  private _body(): number[] | null {
    const { targetActor, animActor } = this._host;
    if (!targetActor.mapped) return null;
    // The allocation: a restyle leaves a relayout pending, during which the size getters re-measure.
    const [w, h] = getAllocatedSize(animActor);
    const [x, y] = animActor.get_transformed_position();
    const k = (targetActor.get_scale()[0] || 1) * (animActor.get_scale()[0] || 1);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 1) || !(h > 1)) return null;
    const e = this._host.expand();
    return [x - e, y - e, w * k + e * 2, h * k + e * 2];
  }

  // Hands the bar the glass down to `body`'s bottom, and shows the menu's items inside it, fading in with `p`.
  private _place(body: number[], p: number): void {
    const bar = this._bar!;
    const top = bar.glassBottom() - OVERLAP;
    const [x, , w] = body;
    const bottom = body[1] + body[3];
    const h = bottom - top;
    if (!(w >= 1) || !(h > OVERLAP)) {
      bar.setMenuGrowth(this, null, 0);
      this._host.animActor.opacity = 0;
      return;
    }
    bar.setMenuGrowth(this, [x, top, w, h], this._host.radius());

    const a = this._host.animActor;
    a.opacity = Math.round(255 * Math.min(Math.max((p - CONTENT_FROM) / (1 - CONTENT_FROM), 0), 1));
    if (p >= 1) {
      a.remove_clip();
      return;
    }
    // Cut to the glass, so the items come out of the bar with it.
    const [ax, ay] = a.get_transformed_position();
    const [aw] = a.get_transformed_size();
    const k = aw > 0 && a.width > 0 ? aw / a.width : 1;
    a.set_clip((x - ax) / k, (top - ay) / k, w / k, h / k);
  }
}
