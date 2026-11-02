import GLib from 'gi://GLib';
import type Clutter from 'gi://Clutter';
import type St from 'gi://St';

import { SwiftSpring, addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs } from './animation.js';
import { getAllocatedSize, isActorValid } from './actors.js';
import { growthBarFrom, type GrowthBar } from './growthBars.js';

// The BoxPointer's own open and close eases, which are held while the bar grows and shrinks.
const BOXPOINTER_EASED = ['opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y'];
const BOXPOINTER_HOLD_MS = 10000;
// How far the content's glass starts inside the bar's, so the two read as one body with no seam where they meet.
const OVERLAP = 4;
// The growth's springs, [response (s), damping fraction], as SwiftUI gives them. Opening, the glass spreads along
// the bar under the button quickly and nearly without overshoot, while it flows down on a softer spring that swings
// some 8% past the content and settles back, as liquid does. Closing, both run back without a swing.
const OPEN_SPREAD = [0.3, 0.78];
const OPEN_DROP = [0.46, 0.62];
const CLOSE = [0.26, 1];
// Frames to wait for content that is not laid out yet before it opens without the growth.
const WAIT_FRAMES = 30;
// The content comes up through the glass between these points of its drop, and slides down this far (px) as it
// does, riding the drop's swing.
const CONTENT_FROM = 0.3;
const CONTENT_TO = 0.9;
const CONTENT_SLIDE = 14;
// Closing ends here rather than waiting out the spring's tail, while the hidden content still takes the pointer.
const CLOSED_BELOW = 0.02;

/** What grows out of the bar (a menu, a notification banner), as its manager tells BarGrowth. */
export interface BarGrowthHost {
  // The setting that makes it grow out of the bar instead of floating.
  key: string;
  // The actor shown inside the glass, or null while there is none.
  content(): St.Widget | null;
  // Whether the content is on screen, and the scale its container puts on it.
  shown(): boolean;
  scale(): number;
  // The bar's button it grows out of, and that button's capsule, [x, y, w, h] on the stage, or null.
  source(): Clutter.Actor | null;
  button(): number[] | null;
  // How far its glass reaches past the content, px, and the radius of the glass's corners.
  expand(): number;
  radius(): number;
  // The manager's animation interval, ms, and how fast it animates (1 as designed).
  intervalMs(): number;
  speed(): number;
  // Each frame of the growth: holds the shell's own open (`opening`) or close animation of the content.
  hold(opening: boolean): void;
  // The content went back into the bar.
  closed(): void;
}

/** The host for a popup menu: its BoxPointer `targetActor` and its items' box `animActor`. */
export function menuGrowthHost(menu: any, targetActor: St.Widget, animActor: St.Widget,
  rest: Pick<BarGrowthHost, 'source' | 'button' | 'expand' | 'radius' | 'intervalMs' | 'speed'>): BarGrowthHost {
  return {
    ...rest,
    key: 'top-bar-menus-grow',
    content: () => animActor,
    shown: () => targetActor.mapped,
    scale: () => targetActor.get_scale()[1] || 1,
    // The menu stays where it opens and stays visible until the glass is back in the bar.
    hold: opening => {
      for (const name of BOXPOINTER_EASED) {
        const ease = targetActor.get_transition(name);
        if (!ease) continue;
        if (opening) ease.set_from(ease.get_interval().peek_final_value());
        else ease.set_to(ease.get_interval().peek_initial_value());
        if (!opening && name === 'opacity') ease.set_duration(BOXPOINTER_HOLD_MS);
      }
    },
    closed: () => {
      animActor.opacity = 0;
      if (!menu.isOpen) targetActor.hide();
    },
  };
}

/**
 * Content that grows out of the top bar's glass instead of floating below it. The bar draws the content's glass as
 * part of its own; the manager's glass stays hidden meanwhile. Opening, the glass spreads out of the bar under the
 * button and flows down into the content, which comes up through it; closing runs back.
 */
export class BarGrowth {
  private _bar: GrowthBar | null = null;
  // How far the glass has spread along the bar towards the content's width, and dropped towards its bottom, 0 to 1.
  private _spread = new SwiftSpring(OPEN_SPREAD[0], OPEN_SPREAD[1]);
  private _drop = new SwiftSpring(OPEN_DROP[0], OPEN_DROP[1]);
  // The content the growth moves, its translation_y at rest, and the slide (stage px) added to it now.
  private _content: St.Widget | null = null;
  private _restY = 0;
  private _slide = 0;
  private _opening = false;
  private _tickId = 0;
  private _lastUs = 0;
  private _waitFrames = 0;
  private _button: number[] | null = null;
  // The glass body last drawn, which a growth whose content went away runs back in from.
  private _lastBody: number[] | null = null;

  constructor(private _host: BarGrowthHost) {}

  /** Whether the bar draws the content now, as it grows or at rest. */
  get holding(): boolean {
    return this._bar !== null;
  }

  /** Whether it is opening or open, rather than closing. */
  get opening(): boolean {
    return this._opening;
  }

  /**
   * Starts the content growing out of the bar (`open`) or back into it. False when it does not grow out of a bar;
   * the manager then animates it as usual.
   */
  start(open: boolean): boolean {
    const bar = growthBarFrom(this._host.source(), this._host.key) ?? (open ? null : this._bar);
    const content = this._host.content();
    if (!bar || !content) {
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
    // The content keeps its size; a scale the manager's own spring left behind would shrink it and the glass.
    content.remove_all_transitions();
    content.set_scale(1, 1);
    // New content (a banner coming while the last one's glass runs back in) takes over the glass where it is.
    if (this._content !== content) {
      if (this._content) this._resetContent();
      this._content = content;
      this._slide = 0;
      this._restY = content.translation_y;
      if (open) content.opacity = 0;
    } else if (!this._tickId) {
      this._restY = content.translation_y - this._slide;
      if (open) content.opacity = 0;
    }
    if (!this._tickId) {
      this._lastUs = 0;
      this._tickId = addFrameTicker(() => this._step(), normalizeAnimationIntervalMs(this._host.intervalMs()));
    }
    return true;
  }

  /**
   * Keeps the bar drawing the content at rest, for a manager's per-frame sync. True while it does, and the
   * manager's own glass is to stay hidden.
   */
  holdAtRest(): boolean {
    if (this._tickId) return true;
    const content = this._host.content();
    const bar = content && this._host.shown() ? growthBarFrom(this._host.source(), this._host.key) : null;
    if (bar !== this._bar || content !== this._content) this.release();
    if (!bar || !content) return false;
    this._bar = bar;
    this._content = content;
    this._opening = true;
    this._spread.value = this._spread.target = this._drop.value = this._drop.target = 1;
    this._spread.velocity = this._drop.velocity = 0;
    const body = this._body();
    if (body) this._place(body, 1);
    return true;
  }

  /**
   * Runs the glass back into the bar from where it is, without the content, which went away (a banner the shell
   * removed at once). Nothing happens unless the bar holds it.
   */
  retract(): void {
    if (!this._bar || !this._lastBody) {
      this.release();
      return;
    }
    this._resetContent();
    this._opening = false;
    this._spread.updateParams(CLOSE[0], CLOSE[1]);
    this._drop.updateParams(CLOSE[0], CLOSE[1]);
    this._spread.target = this._drop.target = 0;
    if (!this._tickId) {
      this._lastUs = 0;
      this._tickId = addFrameTicker(() => this._step(), normalizeAnimationIntervalMs(this._host.intervalMs()));
    }
  }

  /** Takes the content's glass back into the bar at once and leaves the content as the manager expects it. */
  release(): void {
    if (this._tickId) {
      removeFrameTicker(this._tickId);
      this._tickId = 0;
    }
    if (!this._bar) return;
    this._bar.setMenuGrowth(this, null, 0);
    this._bar = null;
    this._lastBody = null;
    for (const spring of [this._spread, this._drop]) {
      spring.value = spring.target = 0;
      spring.velocity = 0;
    }
    this._resetContent();
  }

  private _resetContent(): void {
    const content = this._content;
    this._content = null;
    if (!content || !isActorValid(content)) {
      this._slide = 0;
      return;
    }
    if (this._slide) {
      content.translation_y = this._restY;
      this._slide = 0;
    }
    content.remove_clip();
    content.opacity = 255;
  }

  // Moves the content `slide` stage px from where it rests.
  private _setSlide(slide: number): void {
    this._slide = slide;
    this._content!.translation_y = this._restY + slide / this._host.scale();
  }

  private _step(): boolean {
    const host = this._host;
    const bar = this._bar;
    // Without its content only a retract goes on, from the glass's last shape.
    const content = this._content && isActorValid(this._content) ? this._content : null;
    if (!bar || (!content && this._opening)) {
      this._tickId = 0;
      this.release();
      return false;
    }
    if (content) host.hold(this._opening);

    this._button = host.button() ?? this._button;
    const body = content ? this._body() : this._lastBody;
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
    // Down out of a top bar to the content's bottom, or up out of a dock to its top.
    if (bar.growDirection > 0) {
      const reach = lerp(bar.glassEdge(), body[1] + body[3], drop);
      this._place([left, body[1], right - left, reach - body[1]], drop);
    } else {
      const reach = lerp(bar.glassEdge(), body[1], drop);
      this._place([left, reach, right - left, body[1] + body[3] - reach], drop);
    }
    const done = this._opening
      ? spreadSettled && dropSettled
      : Math.max(spread, drop) <= CLOSED_BELOW;
    if (!done) return true;

    this._tickId = 0;
    if (this._opening) {
      this._setSlide(0);
      content!.remove_clip();
      content!.opacity = 255;
    } else {
      this.release();
      if (content) host.closed();
    }
    return false;
  }

  // The content's glass body where it is, [x, y, w, h] on the stage, or null before it is laid out.
  private _body(): number[] | null {
    const content = this._content;
    if (!content || !this._host.shown()) return null;
    // The allocation: a restyle leaves a relayout pending, during which the size getters re-measure.
    const [w, h] = getAllocatedSize(content);
    const [x, slidY] = content.get_transformed_position();
    // Where the content rests, not where its slide has it now.
    const y = slidY - this._slide;
    const k = this._host.scale() * (content.get_scale()[0] || 1);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 1) || !(h > 1)) return null;
    const e = this._host.expand();
    return [x - e, y - e, w * k + e * 2, h * k + e * 2];
  }

  // Hands the bar the glass down to `body`'s bottom, and shows the content inside it, coming in with the glass's
  // drop `p`.
  private _place(body: number[], p: number): void {
    const bar = this._bar!;
    const content = this._content;
    if (content) this._lastBody = body;
    const dir = bar.growDirection;
    // From just inside the glass to the body's far end: its bottom growing down, its top growing up.
    const near = bar.glassEdge() - OVERLAP * dir;
    const [x, , w] = body;
    const top = dir > 0 ? near : body[1];
    const h = dir > 0 ? body[1] + body[3] - near : near - body[1];
    if (!(w >= 1) || !(h > OVERLAP)) {
      bar.setMenuGrowth(this, null, 0);
      if (content) content.opacity = 0;
      return;
    }
    bar.setMenuGrowth(this, [x, top, w, h], this._host.radius());
    if (!content) return;

    const t = Math.min(Math.max((p - CONTENT_FROM) / (CONTENT_TO - CONTENT_FROM), 0), 1);
    content.opacity = Math.round(255 * t * t * (3 - 2 * t));
    // On the glass's side of the rest at first, then out with the glass, past the rest on its swing and back. Only
    // while it moves: at rest the manager owns the content's translation.
    if (this._tickId) this._setSlide(-CONTENT_SLIDE * (1 - p) * dir);
    if (p >= 1 && Math.abs(this._slide) < 0.5) {
      content.remove_clip();
      return;
    }
    // Cut to the glass, so the content comes out of the bar with it.
    const [ax, ay] = content.get_transformed_position();
    const [aw] = content.get_transformed_size();
    const k = aw > 0 && content.width > 0 ? aw / content.width : 1;
    content.set_clip((x - ax) / k, (top - ay) / k, w / k, h / k);
  }
}
