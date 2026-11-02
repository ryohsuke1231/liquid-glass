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
// The growth's springs, [response (s), damping fraction], as SwiftUI gives them. Opening, the glass spreads along
// the bar under the button quickly and nearly without overshoot, while it flows down on a softer spring that swings
// some 8% past the menu and settles back, as liquid does. Closing, both run back without a swing.
const OPEN_SPREAD = [0.3, 0.78];
const OPEN_DROP = [0.46, 0.62];
const CLOSE = [0.26, 1];
// Frames to wait for a menu that is not laid out yet before it opens without the growth.
const WAIT_FRAMES = 30;
// The items come up through the glass between these points of its drop, and slide down this far (px) as they do,
// riding the drop's swing.
const CONTENT_FROM = 0.3;
const CONTENT_TO = 0.9;
const CONTENT_SLIDE = 14;
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
  // How fast the menu animates, 1 as designed (the menu's morph-speed).
  speed(): number;
}

/**
 * A menu that grows out of the top bar's glass instead of floating below it (top-bar-menus-grow). The bar draws
 * the menu's glass as part of its own; the menu manager's glass stays hidden meanwhile. Opening, the glass runs
 * down out of the bar below the button and widens into the menu, its items coming up through it; closing runs back.
 */
export class BarGrowth {
  private _bar: TopBarManager | null = null;
  // How far the glass has spread along the bar towards the menu's width, and dropped towards its bottom, 0 to 1.
  private _spread = new SwiftSpring(OPEN_SPREAD[0], OPEN_SPREAD[1]);
  private _drop = new SwiftSpring(OPEN_DROP[0], OPEN_DROP[1]);
  // The items' translation_y at rest, and the slide (stage px) added to it now.
  private _restY = 0;
  private _slide = 0;
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
    // A reversal midway keeps the springs' values and velocities, so the glass turns round smoothly.
    const [spread, drop] = open ? [OPEN_SPREAD, OPEN_DROP] : [CLOSE, CLOSE];
    this._spread.updateParams(spread[0], spread[1]);
    this._drop.updateParams(drop[0], drop[1]);
    this._spread.target = this._drop.target = open ? 1 : 0;
    this._waitFrames = 0;
    // The items keep their size; a scale the menu's own spring left behind would shrink them and the glass.
    const a = this._host.animActor;
    a.remove_all_transitions();
    a.set_scale(1, 1);
    if (!this._tickId) {
      this._restY = a.translation_y - this._slide;
      if (open) a.opacity = 0;
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
    this._spread.value = this._spread.target = this._drop.value = this._drop.target = 1;
    this._spread.velocity = this._drop.velocity = 0;
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
    for (const spring of [this._spread, this._drop]) {
      spring.value = spring.target = 0;
      spring.velocity = 0;
    }
    const a = this._host.animActor;
    if (!isActorValid(a)) return;
    if (this._slide) this._setSlide(0);
    a.remove_clip();
    a.opacity = 255;
  }

  // Moves the items `slide` stage px from where they rest.
  private _setSlide(slide: number): void {
    const a = this._host.animActor;
    const k = this._host.targetActor.get_scale()[1] || 1;
    this._slide = slide;
    a.translation_y = this._restY + slide / k;
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
    const elapsedMs = (this._lastUs ? (now - this._lastUs) / 1000 : 1000 / 60) * Math.max(host.speed(), 0.05);
    this._lastUs = now;
    // Both stepped every frame: && would skip the second once the first settles.
    const spreadSettled = this._spread.update(elapsedMs);
    const dropSettled = this._drop.update(elapsedMs);
    const spread = this._spread.value, drop = this._drop.value;
    const [bx, , bw] = this._button;
    const lerp = (from: number, to: number, p: number) => from + (to - from) * p;
    const left = lerp(bx, body[0], spread);
    const right = lerp(bx + bw, body[0] + body[2], spread);
    const reach = lerp(bar.glassBottom(), body[1] + body[3], drop);
    this._place([left, body[1], right - left, reach - body[1]], drop);
    const done = this._opening
      ? spreadSettled && dropSettled
      : Math.max(spread, drop) <= CLOSED_BELOW;
    if (!done) return true;

    this._tickId = 0;
    if (this._opening) {
      this._setSlide(0);
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
    const [x, slidY] = animActor.get_transformed_position();
    // Where the items rest, not where their slide has them now.
    const y = slidY - this._slide;
    const k = (targetActor.get_scale()[0] || 1) * (animActor.get_scale()[0] || 1);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 1) || !(h > 1)) return null;
    const e = this._host.expand();
    return [x - e, y - e, w * k + e * 2, h * k + e * 2];
  }

  // Hands the bar the glass down to `body`'s bottom, and shows the menu's items inside it, coming in with the
  // glass's drop `p`.
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
    const t = Math.min(Math.max((p - CONTENT_FROM) / (CONTENT_TO - CONTENT_FROM), 0), 1);
    a.opacity = Math.round(255 * t * t * (3 - 2 * t));
    // Above the rest at first, then down with the glass, past the rest on its swing and back. Only while it moves:
    // at rest the manager owns the items' translation.
    if (this._tickId) this._setSlide(-CONTENT_SLIDE * (1 - p));
    if (p >= 1 && Math.abs(this._slide) < 0.5) {
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
