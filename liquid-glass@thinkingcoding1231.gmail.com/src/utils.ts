// utils.ts
//
// Shared helpers for the Liquid Glass extension: actors that stay invisible
// to Looking Glass's picker, the UI-layer sampler that clones the desktop
// behind the glass, and the special-case handling needed to render a blurred
// panel (from the Blur My Shell extension) inside the glass without breaking
// the real panel's own blur.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Mtk from 'gi://Mtk';


/**
 * Reads an actor's *allocated* size, instead of Clutter.Actor.get_size().
 *
 * get_size() returns the actor's natural (preferred) size whenever
 * `needs_allocation` is set — i.e. whenever anything in its subtree has
 * queued a relayout that the stage has not processed yet. Every per-frame
 * clone sync in this extension runs from a Meta.LaterType.BEFORE_REDRAW
 * later, and those fire in the stage's "before update" phase — *before*
 * clutter_stage_maybe_relayout() — so we hit that window constantly.
 *
 * That is fatal for GNOME's overviewGroup. ControlsManagerLayout reports
 * [0, 0] as its preferred size on purpose ("the MonitorConstraint will
 * allocate us a fixed size anyway"), and both OverviewActor and
 * overviewGroup take their size from constraints, which feed the allocation
 * only — never the preferred size. So the instant anything inside the
 * overview queues a relayout (an app icon's label changing on hover, a
 * layout update), overviewGroup.get_size() answers [0, 0] for that frame,
 * syncProperties() culls the clone as zero-sized, and the wallpaper flashes
 * through the glass for exactly one frame.
 *
 * get_allocation_box() has no such fallback: it returns the last allocation
 * verbatim — which is precisely what was on screen last frame.
 */
export function getAllocatedSize(actor: Clutter.Actor): [number, number] {
  try {
    const box = actor.get_allocation_box();
    const w = box.get_width();
    const h = box.get_height();
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return [w, h];
    }
  } catch (_) { /* noop */ }

  // Never allocated yet (or the call failed): fall back to get_size(), whose
  // answer is at least as good as nothing.
  try {
    const [w, h] = actor.get_size();
    return [w, h];
  } catch (_) {
    return [0, 0];
  }
}


/**
 * [FIX round 13] Works out where the actor's own pixels live inside the
 * padded capture texture, and where the composite quad has to be drawn so
 * that it lands exactly back on the actor.
 *
 * Two things were wrong before, and both came from the same guess — that
 * the capture's padding is split evenly around the actor.
 *
 * 1. The padding is NOT centred. ClutterOffscreenEffect.pre_paint() sizes
 *    its FBO from _clutter_actor_box_enlarge_for_effects(), which does:
 *
 *        w  = nearbyint(raw.x2 - raw.x1)
 *        x2 = ceilf(raw.x2 + 0.75)
 *        x1 = x2 - w - 3
 *
 *    For an integer-sized actor at a whole-pixel origin that yields
 *    x1 = -2, x2 = w + 1 — i.e. 2px of padding on the left/top and 1px on
 *    the right/bottom, for the 3px total this extension has always
 *    measured (964x563 capture for a 961x560 actor). Sampling from
 *    padding/2 = 1.5px therefore read half a pixel too far left/up.
 *
 * 2. Far more visibly: vfunc_paint_target() does NOT run in the actor's
 *    own coordinate space. clutter_offscreen_effect_paint_texture() wraps
 *    the paint_target call in a ClutterTransformNode carrying
 *    translate(fbo_offset_x, fbo_offset_y) — the very offset above — and
 *    then Clutter's own default paint_target draws the FULL texture at
 *    (0, 0, texWidth, texHeight). So in this space one unit is one capture
 *    TEXEL and the origin is the texture's top-left corner, which sits at
 *    actor-local (-2, -2). Drawing the composite at (0, 0, w, h), as this
 *    did, therefore shifted the entire glass up and to the left by that
 *    offset — the reported "-3px, -3px offset" on the dock, menus,
 *    notifications, application windows and the OSD.
 *
 * Returns UVs into the capture plus the destination rect in that texel
 * space. Everything is derived from the actor's paint volume, exactly as
 * Clutter derives it; the result is sanity-checked against the texture's
 * real size and falls back to the old centred assumption if the
 * replication ever stops matching (a Clutter change, a rotated actor, a
 * paint volume we can't read).
 */
export function computeCaptureLayout(
  actor: Clutter.Actor | null, srcW: number, srcH: number,
  allocW: number, allocH: number
): { uv: number[]; dest: number[] } {
  const centredFallback = (): { uv: number[]; dest: number[] } => {
    const padW = srcW - allocW;
    const padH = srcH - allocH;
    if (padW === 0 && padH === 0) {
      return { uv: [0, 0, 1, 1], dest: [0, 0, allocW, allocH] };
    }
    const x0 = padW / 2, y0 = padH / 2;
    return {
      uv: [
        x0 / srcW, y0 / srcH,
        Math.min(1.0, (x0 + allocW) / srcW),
        Math.min(1.0, (y0 + allocH) / srcH),
      ],
      dest: [x0, y0, x0 + allocW, y0 + allocH],
    };
  };

  if (!actor) return centredFallback();

  // The paint volume is in the actor's own coordinate space and is what
  // pre_paint() feeds to _clutter_actor_box_enlarge_for_effects(). When it
  // can't be obtained, Clutter falls back to the allocation box, which for
  // our purposes is the same rectangle with its origin at (0, 0).
  let rawX1 = 0, rawY1 = 0, rawX2 = allocW, rawY2 = allocH;
  try {
    const pv = (actor as any).get_paint_volume?.();
    if (pv) {
      const origin = pv.get_origin();
      rawX1 = origin.x;
      rawY1 = origin.y;
      rawX2 = rawX1 + pv.get_width();
      rawY2 = rawY1 + pv.get_height();
    }
  } catch (e) {
    // Keep the allocation-derived box.
  }
  if (!Number.isFinite(rawX1) || !Number.isFinite(rawY1) ||
    !Number.isFinite(rawX2) || !Number.isFinite(rawY2)) {
    return centredFallback();
  }

  // CLUTTER_NEARBYINT: round half away from zero, truncated to an int.
  const nearbyint = (v: number) => Math.trunc(v < 0 ? v - 0.5 : v + 0.5);

  let x1 = rawX1, y1 = rawY1, x2 = rawX2, y2 = rawY2;
  // _clutter_actor_box_enlarge_for_effects leaves a zero-area box alone.
  if ((rawX2 - rawX1) * (rawY2 - rawY1) !== 0) {
    const w = nearbyint(rawX2 - rawX1);
    const h = nearbyint(rawY2 - rawY1);
    x2 = Math.ceil(rawX2 + 0.75);
    y2 = Math.ceil(rawY2 + 0.75);
    x1 = x2 - w - 3;
    y1 = y2 - h - 3;
  }

  const boxW = x2 - x1;
  const boxH = y2 - y1;
  if (!(boxW > 0) || !(boxH > 0)) return centredFallback();

  // priv->fbo_offset_{x,y} is the INTEGER truncation of the enlarged box's
  // origin, and the offscreen's modelview translates by its negation, so
  // capture texel = (actorLocal - fboOffset) * scale.
  const fboOffX = Math.trunc(x1);
  const fboOffY = Math.trunc(y1);

  // pre_paint scales the box by ceilf(resourceScale) and ceils the result
  // into the texture size, so the scale is recoverable from the texture
  // itself — no HiDPI-only API needed, and the check below rejects the
  // answer outright if the replication doesn't reproduce srcW/srcH.
  const scale = Math.max(1, Math.round(srcW / boxW));
  if (Math.ceil(boxW * scale) !== srcW || Math.ceil(boxH * scale) !== srcH) {
    return centredFallback();
  }

  const padLeft = -fboOffX * scale;
  const padTop = -fboOffY * scale;
  const contentW = allocW * scale;
  const contentH = allocH * scale;

  if (!(padLeft >= 0) || !(padTop >= 0) ||
    padLeft + contentW > srcW || padTop + contentH > srcH) {
    return centredFallback();
  }

  return {
    uv: [
      padLeft / srcW, padTop / srcH,
      (padLeft + contentW) / srcW, (padTop + contentH) / srcH,
    ],
    dest: [padLeft, padTop, padLeft + contentW, padTop + contentH],
  };
}

/**
 * Captures a small rectangle of the screen (the panel area) into a
 * `Clutter.Content`, for use as the "blurred panel" backdrop inside the
 * glass, while structurally guaranteeing the glass never captures itself.
 *
 * Background: Blur My Shell (BMS) blurs the real top panel using a native
 * (non-JS) Clutter effect. That effect has no public API to read its result,
 * and — critically — it assumes it is the *only* consumer of its target
 * actor's paint output. Cloning the BMS target directly (`Clutter.Clone`)
 * makes BMS think a second consumer has taken over, and the *real* panel
 * loses its blur. So we never clone or paint the BMS actor at all; instead
 * we take an independent snapshot of "what the screen looks like there".
 *
 * Why `paint_to_content()` specifically: it performs a one-off, synchronous
 * render of a stage rectangle into an offscreen buffer, completely separate
 * from the actual on-screen frame. That gives us two things a live
 * `Clutter.Clone` cannot:
 *   1. Self-exclusion: our own glass root (`bgActor`) sits directly above
 *      the panel in z-order and can visually overlap it (e.g. when a
 *      panel-anchored popup is open). If we captured "the whole composited
 *      screen" while our own glass was visible, we would capture our own
 *      glass along with the panel — and since we redraw using that captured
 *      image every frame, this becomes a runaway feedback loop: each new
 *      capture already contains yesterday's capture, nested one level
 *      deeper, forever. (Diagnostic tip that confirmed this: the nesting
 *      alternated right-side-up / upside-down with each additional level,
 *      matching a V-flip correction from an older capture method being
 *      compounded once per loop iteration.)
 *      We avoid this entirely by hiding our own root actor for the single
 *      synchronous `paint_to_content()` call, then restoring it immediately
 *      — so the glass structurally cannot appear in its own snapshot.
 *   2. No visible flicker: hide → capture → show all happens synchronously,
 *      before control returns to Clutter's normal repaint cycle, so the
 *      actual displayed frame is never affected.
 *
 * We also always pass `Clutter.PaintFlag.NO_CURSORS`. GNOME Shell's own
 * screenshot code (shell-screenshot.c) does the same for this exact API —
 * without it, the mouse pointer sprite gets composited into the snapshot,
 * which shows up as cursor smearing inside the glass.
 */
export class SelfExcludingSnapshotCapture {
  private _content: any = null;
  private _rectGetter: () => [number, number, number, number];

  private _hideActors: Set<Clutter.Actor> = new Set();
  private _stage: Clutter.Stage;
  private _refCount: number = 0;
  private _afterPaintId: number = 0;
  private _destroyed: boolean = false;

  // Re-capture on every 'after-paint' rather than a fixed timer: this way
  // updates only happen (and only cost anything) while the screen is
  // actually changing, and are as fresh as the display's own refresh rate.
  // Raise FRAME_SKIP if this ever proves too expensive on slower hardware
  // (2 = every other frame, etc.) — 1 keeps it perfectly in sync.
  private static readonly FRAME_SKIP = 1;
  private _frameCounter: number = 0;

  // [DIAG] Every failure path in _captureOnce() used to be swallowed by a
  // bare `catch (e) {}`, so a capture that never produced anything looked
  // from the outside exactly like a capture that worked — the glass simply
  // showed whatever was layered beneath it (the wallpaper/window clones)
  // with no hint as to why. These make the first failure of each kind, and
  // then every 300th, visible in the journal.
  private _label: string;
  private _failCount: number = 0;
  private _okCount: number = 0;

  // When set and it returns false, _captureOnce() is a no-op (and reports
  // nothing): the capture is dormant rather than failing. Without it, a
  // capture created for a popup keeps hiding its hide-actor and re-painting
  // the whole stage into an offscreen on every single frame for as long as it
  // lives, popup open or not.
  private _activeCheck: (() => boolean) | null;

  constructor(
    stage: Clutter.Stage, hideActor: Clutter.Actor,
    rectGetter: () => [number, number, number, number],
    label: string = 'snapshot',
    activeCheck: (() => boolean) | null = null
  ) {
    this._stage = stage;
    this._label = label;
    this._activeCheck = activeCheck;
    if (hideActor) this._hideActors.add(hideActor);
    this._rectGetter = rectGetter;
    this._captureOnce();
    try {
      this._afterPaintId = (this._stage as any).connect('after-paint', () => {
        if (this._destroyed) return;
        this._frameCounter++;
        if (this._frameCounter % SelfExcludingSnapshotCapture.FRAME_SKIP !== 0) return;
        this._captureOnce();
      });
    } catch (e) {
    }
  }

  retain(): void { this._refCount++; }
  release(): boolean {
    this._refCount--;
    if (this._refCount <= 0) { this.destroy(); return true; }
    return false;
  }

  /** Registers another Liquid Glass instance's root as needing to be hidden during capture. */
  addHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.add(actor);
  }

  /** Unregisters a previously-added hide actor (called when that instance releases the capture). */
  removeHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.delete(actor);
  }

  /** [DIAG] Throttled: reports the 1st, 2nd and then every 300th occurrence. */
  private _report(kind: string, detail: string): void {
    this._failCount++;
    if (this._failCount <= 2 || this._failCount % 300 === 0) {
      console.warn(
        `[Liquid Glass][snapshot:${this._label}] ${kind} (failures=${this._failCount}, ` +
        `successes=${this._okCount}): ${detail}`
      );
    }
  }

  private _captureOnce(): void {
    if (this._activeCheck) {
      try {
        if (!this._activeCheck()) return;
      } catch (e) {
        return;
      }
    }

    const [x, y, w, h] = this._rectGetter();
    if (w <= 0 || h <= 0) {
      this._report('empty capture rect', `x=${x} y=${y} w=${w} h=${h}`);
      return;
    }

    // Hide every registered instance's root, not just a single
    // one, so a shared capture never leaks any glass instance into itself.
    const hidden: Clutter.Actor[] = [];
    try {
      for (const actor of this._hideActors) {
        try {
          if (actor && actor.visible) {
            actor.hide();
            hidden.push(actor);
          }
        } catch (_) { /* actor may have been destroyed; skip it */ }
      }

      const rect = new Mtk.Rectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
      const scale = 1; // TODO: honor per-monitor resource scale if this is ever used on HiDPI setups.

      // Signature is (rect, scale, color_state, paint_flags); color_state
      // of null uses the default color space. NO_CURSORS excludes the
      // mouse pointer sprite from the snapshot (see class doc comment).
      // CLEAR matters: clutter_stage_paint_to_framebuffer() only clears the
      // offscreen when this flag is set, and the texture it allocates starts
      // out with undefined contents — anything the stage does not paint over
      // is garbage without it.
      const NO_CURSORS = (Clutter as any).PaintFlag?.NO_CURSORS ?? 0;
      const CLEAR = (Clutter as any).PaintFlag?.CLEAR ?? 0;
      const paintFlags = NO_CURSORS | CLEAR;
      const content = (this._stage as any).paint_to_content?.(rect, scale, null, paintFlags);
      if (content) {
        this._content = content;
        this._okCount++;
      } else {
        this._report('paint_to_content returned null',
          `rect=${rect.x},${rect.y} ${rect.width}x${rect.height}`);
      }
    } catch (e) {
      this._report('paint_to_content threw', `${e}`);
    } finally {
      for (const actor of hidden) {
        try { actor.show(); } catch (_) { /* actor may have been destroyed; skip it */ }
      }
    }
  }

  getContent(): any | null {
    return this._content;
  }

  destroy(): void {
    this._destroyed = true;
    if (this._afterPaintId) {
      try { (this._stage as any).disconnect(this._afterPaintId); } catch (_) { /* noop */ }
      this._afterPaintId = 0;
    }
  }
}

// Shared pool: multiple UILayerSampler instances (e.g. a permanent dock glass
// and a popup-menu glass) may want to capture the same BMS target. Keying by
// source actor lets them share a single capture instead of duplicating work.
const _selfExcludingSnapshotRegistry: Map<Clutter.Actor, SelfExcludingSnapshotCapture> = new Map();

function acquireSelfExcludingSnapshot(
  sourceActor: Clutter.Actor,
  stage: Clutter.Stage,
  hideActor: Clutter.Actor,
  rectGetter: () => [number, number, number, number],
  label: string = 'bms'
): SelfExcludingSnapshotCapture {
  let cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) {
    cap = new SelfExcludingSnapshotCapture(stage, hideActor, rectGetter, label);
    _selfExcludingSnapshotRegistry.set(sourceActor, cap);
  } else {
    cap.addHideActor(hideActor);
  }
  cap.retain();
  return cap;
}

function releaseSelfExcludingSnapshot(sourceActor: Clutter.Actor, hideActor?: Clutter.Actor): void {
  const cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) return;
  // Unregister our hide actor first so a capture that outlives us (still
  // retained by another instance) doesn't keep trying to hide an actor we
  // no longer care about.
  cap.removeHideActor(hideActor);
  if (cap.release()) {
    _selfExcludingSnapshotRegistry.delete(sourceActor);
  }
}

/**
 * A Clutter.Clone whose pick pass is a no-op, so Looking Glass's actor
 * picker sees through it to whatever is behind.
 */
export const UnpickableClone = GObject.registerClass(
  class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext: any): void {
      // No-op: never respond to picking.
    }
  }
);

/**
 * A plain container actor with the same "invisible to picking" behavior as
 * UnpickableClone. Uses Clutter.Actor rather than St.Widget to avoid St's
 * CSS/theming padding interfering with pixel-precise layout.
 */
export const UnpickableActor = GObject.registerClass(
  class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext: any): void {
      // No-op: never respond to picking.
    }
  }
);

/**
 * An St.Widget that never responds to picking, used purely to re-paint some
 * other widget's THEME BACKGROUND (background color / gradient / border-image
 * / border-radius) somewhere else.
 *
 * Copying the source widget's style class onto a bare widget makes St resolve
 * and paint exactly the same background material, without cloning — and
 * therefore without dragging the source's children (labels, icons, ...) along
 * with it, which is what a Clutter.Clone or a stage snapshot would do.
 *
 * Caveat: only selectors that match on the class itself apply; a rule written
 * as a descendant selector against the real widget's ancestry will not.
 */
export const UnpickableStyledWidget = GObject.registerClass(
  class UnpickableStyledWidget extends St.Widget {
    vfunc_pick(_pickContext: any): void {
      // No-op: never respond to picking.
    }
  }
);

/**
 * [FIX-5] "Quick Settings turns into a full-screen dark rectangle, Toggles
 * show nothing" the moment bgActor became a child of animActor (a real
 * St.BoxLayout, used for the actual quick-settings grid).
 *
 * Root cause: unlike a plain Clutter.Actor (which — absent an explicit
 * LayoutManager — does NOT roll its children's sizes into its own reported
 * preferred size; this is exactly why bgActor's own many manually-sized
 * descendants, or bgActor itself sitting under uiGroup, never caused any
 * such ballooning before), St.BoxLayout DOES actively query each direct
 * child's own get_preferred_width()/height() and stacks/sums them to
 * compute ITS OWN size. bgActor has an EXPLICIT fixed size set on it
 * directly (set_size(screenW, screenH) — see _syncToggleRegions()/
 * resolution-update code), and an actor's own explicitly-set size is
 * exactly what get_preferred_width()/height() reports back to a querying
 * parent, regardless of any layout manager. So animActor's BoxLayout was
 * faithfully doing its job: stacking a "child" that claims to want
 * 1920x1080, on top of the real ~1920x198 toggle content — hence the
 * ballooned (1958x1316) allocation and the screen-covering dark panel.
 *
 * Fix: LayoutOpaqueActor unconditionally reports (0,0) for both min and
 * natural size in both dimensions, no matter what its own children (e.g.
 * bgActor) request. A querying parent's LayoutManager takes exactly what
 * get_preferred_width()/height() returns as authoritative — it never looks
 * past that return value into the subtree — so this is a hard, guaranteed
 * "don't count anything below me towards your own size" boundary, usable
 * to wrap any actor (like bgActor) that must be dropped into a real
 * layout-managed container (like animActor) purely for z-order, with its
 * own geometry fully hand-managed instead of participating in that
 * container's size negotiation. Its own on-screen ORIGIN (x,y) still comes
 * from wherever the parent's layout manager decides to place a 0-sized
 * child — callers reposition it explicitly every frame regardless (see
 * quickSettingsManager.ts's animActor counter-transform), so that's fine.
 */
export const LayoutOpaqueActor = GObject.registerClass(
  class LayoutOpaqueActor extends UnpickableActor {
    vfunc_get_preferred_width(_forHeight: number): [number, number] {
      return [0, 0];
    }
    vfunc_get_preferred_height(_forWidth: number): [number, number] {
      return [0, 0];
    }
  }
);

/**
 * St.Widget variant of the same "invisible to picking" behavior, for cases
 * that need St's styling/layout features.
 */
export const UnpickableWidget = GObject.registerClass(
  class UnpickableWidget extends St.Widget {
    vfunc_pick(_pickContext: any): void {
      // No-op: never respond to picking.
    }
  }
);

/**
 * Paints a captured texture stretched to fill its own allocation, without
 * ever triggering the source actor's own paint. Used for the "read an
 * existing OffscreenEffect's texture" fallback path (see
 * UILayerSampler._createExistingEffectBlitActor): unlike Clutter.Clone,
 * this never re-evaluates the source's effect chain, so it can't cause the
 * "two consumers" ownership conflict described on SelfExcludingSnapshotCapture.
 */
export const TextureBlitActor = GObject.registerClass({
  GTypeName: 'LiquidGlassTextureBlitActor',
}, class TextureBlitActor extends Clutter.Actor {

  declare private _getTexture: (() => Cogl.Texture2D | null) | null;
  declare private _sourceActor: Clutter.Actor | null;
  declare private _pipeline: Cogl.Pipeline | null;

  _init(params: any = {}) {
    super._init(params);
    this._getTexture = null;
    this._sourceActor = null;
    this._pipeline = null;
  }

  vfunc_pick(_pickContext: any): void { }

  setTextureGetter(fn: () => Cogl.Texture2D | null): void {
    this._getTexture = fn;
  }

  setSourceActor(actor: Clutter.Actor): void {
    this._sourceActor = actor;
  }

  private _getCoglContext(): Cogl.Context | null {
    try {
      const backend = Clutter.get_default_backend();
      return backend.get_cogl_context() as Cogl.Context;
    } catch (e) {
      return null;
    }
  }

  vfunc_paint(paintContext: Clutter.PaintContext): void {
    if (!this._getTexture) return;
    const tex = this._getTexture();
    if (!tex) return;

    try {
      if (!this._pipeline) {
        const ctx = this._getCoglContext();
        if (!ctx) return;
        this._pipeline = Cogl.Pipeline.new(ctx);
        this._pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        this._pipeline.set_layer_filters(
          0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR
        );
      }

      const texW = tex.get_width();
      const texH = tex.get_height();

      // A ClutterOffscreenEffect's captured texture is a few pixels larger
      // than the actor's logical size, and — contrary to what this used to
      // assume — that padding is NOT centred: it is 2px on the left/top and
      // 1px on the right/bottom (see computeCaptureLayout()). Sample only
      // the sub-rectangle that actually holds the source's own pixels.
      let uMin = 0, vMin = 0, uMax = 1, vMax = 1;
      const src = this._sourceActor;
      if (src) {
        const [rawW, rawH] = getAllocatedSize(src);
        const allocW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : texW;
        const allocH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : texH;

        if ((allocW !== texW || allocH !== texH) && texW > 0 && texH > 0) {
          const uv = computeCaptureLayout(src, texW, texH, allocW, allocH).uv;
          uMin = uv[0]; vMin = uv[1]; uMax = uv[2]; vMax = uv[3];
        }
      }

      this._pipeline.set_layer_texture(0, tex);

      const [w, h] = this.get_size();
      if (!(w > 0) || !(h > 0)) return;

      const fb = paintContext.get_framebuffer() as unknown as Cogl.Framebuffer;
      fb.draw_textured_rectangle(this._pipeline, 0, 0, w, h, uMin, vMin, uMax, vMax);
    } catch (e) {
    }
  }
});
export type TextureBlitActor = InstanceType<typeof TextureBlitActor>;

/**
 * Clones every actor under `Main.layoutManager.uiGroup` into a private
 * container so the glass can render a distorted/blurred view of "everything
 * behind it" (panel, windows, other extensions' UI). One instance per glass
 * (permanent dock glass, popup-menu glass, etc).
 */
export class UILayerSampler {
  private readonly _selfActor: Clutter.Actor;
  private readonly _container: Clutter.Actor;
  private readonly _extraExclusions: Set<Clutter.Actor>;

  private _selfRoot: Clutter.Actor | null = null;
  private _clones: Map<Clutter.Actor, Clutter.Actor> = new Map();
  private _uiClonesContainer: Clutter.Actor | null = null;

  // Read-only cache: for each uiGroup child, either the (actor, effect) pair
  // of an existing Clutter.OffscreenEffect found in its subtree, or null if
  // none was found. Never written to by us (no actor tree mutation), so
  // sharing this cache across multiple UILayerSampler instances is safe.
  private _existingEffectCache: Map<Clutter.Actor, { actor: Clutter.Actor; effect: Clutter.OffscreenEffect } | null> = new Map();

  // While true, a uiGroup child containing the Blur My Shell target is
  // rendered via _createExistingEffectBlitActor() if a usable
  // Clutter.OffscreenEffect is found in its subtree. BMS's actual blur is a
  // native (non-JS) effect that never matches this, so BMS itself always
  // falls through — this toggle mainly matters for *other* extensions that
  // implement their effects as a JS Clutter.OffscreenEffect subclass.
  private _useCaptureFixForBms: boolean = true;

  // clone actor -> { source actor (BMS target's uiGroup child), hideActor (our own selfRoot) }
  // Both are needed on destroy to release exactly what we registered on the
  // (possibly shared) SelfExcludingSnapshotCapture.
  private _delayedCaptureOwners: Map<Clutter.Actor, { source: Clutter.Actor; hideActor: Clutter.Actor }> = new Map();

  constructor(
    selfActor: Clutter.Actor,
    container: Clutter.Actor,
    extraExclusions: Clutter.Actor[] = [],
    cloneContainer: Clutter.Actor | null = null
  ) {
    this._selfActor = selfActor;
    this._container = container;
    this._extraExclusions = new Set(extraExclusions);
    this._selfRoot = this._findUiGroupAncestor(selfActor);

    this._uiClonesContainer = new UnpickableActor();
    this._uiClonesContainer.set_name("ui-clones-container");

    // Connect to the destroy signal and assign null
    this._uiClonesContainer.connect('destroy', () => {
      this._uiClonesContainer = null;
    });

    if (cloneContainer) {
      cloneContainer.add_child(this._uiClonesContainer);
    } else {
      this._container.add_child(this._uiClonesContainer);
    }
  }

  private _findUiGroupAncestor(actor: Clutter.Actor): Clutter.Actor | null {
    const uiGroup = Main.layoutManager.uiGroup;
    let current: Clutter.Actor | null = actor;
    while (current) {
      if (current.get_parent() === uiGroup) return current;
      current = current.get_parent();
    }
    return null;
  }

  /** Adds an actor to the set of uiGroup children that should never be cloned. */
  addExclusion(actor: Clutter.Actor) {
    if (!actor) return;
    this._extraExclusions.add(actor);
  }

  /**
   * Resolves the Blur My Shell panel-blur target actor via
   * Main.extensionManager, if BMS is installed and enabled and its internal
   * structure matches what we expect. Everything here is best-effort and
   * guarded: if BMS is absent or has changed shape, this simply returns
   * null and callers fall back to normal cloning.
   */
  private _resolveBmsTargetActor(): Clutter.Actor | null {
    try {
      const ext = (Main as any).extensionManager?.lookup?.('blur-my-shell@aunetx');
      const actor = ext?.stateObj?._panel_blur?.actors_list?.[0]?.bg_manager?.backgroundActor;
      return (actor as Clutter.Actor) ?? null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Returns the BMS target actor if `child` (a direct uiGroup child) either
   * *is* the BMS target or contains it as a descendant — i.e. whether
   * cloning `child` would also clone BMS's blurred panel.
   */
  private _findBmsDescendant(child: Clutter.Actor): Clutter.Actor | null {
    const target = this._resolveBmsTargetActor();
    if (!target) return null;
    if (child === target) return target;
    try {
      if (typeof (child as any).contains === 'function' && (child as any).contains(target)) {
        return target;
      }
    } catch (_) { /* noop */ }
    return null;
  }

  /**
   * @deprecated no-op, kept only so older callers that still toggle these
   * debug switches don't break. The multi-paint diagnostic probe and the
   * "force-hide the BMS clone" A/B switch they used to control have both
   * been removed now that the real fix (SelfExcludingSnapshotCapture) is in
   * place.
   */
  setDebugDisableBmsClone(_disabled: boolean): void { /* no-op */ }
  /** @deprecated no-op, see setDebugDisableBmsClone. */
  setDebugBmsProbeEnabled(_enabled: boolean): void { /* no-op */ }

  /**
   * Primary path for rendering the BMS-blurred panel inside the glass. See
   * SelfExcludingSnapshotCapture for the full rationale. Returns null (and
   * lets the caller fall back) if this Clutter version lacks
   * `Stage.paint_to_content()`.
   */
  private _createSelfExcludingSnapshotActor(child: Clutter.Actor): Clutter.Actor | null {
    try {
      const stage = child.get_stage() as Clutter.Stage | null;
      if (!stage) return null;
      if (typeof (stage as any).paint_to_content !== 'function') return null;
      if (!this._selfRoot) return null;
      const selfRoot = this._selfRoot;

      const rectGetter = (): [number, number, number, number] => {
        const [x, y] = child.get_transformed_position();
        const [w, h] = getAllocatedSize(child);
        if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0) {
          return [0, 0, 0, 0];
        }
        return [x, y, w, h];
      };

      const capture = acquireSelfExcludingSnapshot(child, stage, selfRoot, rectGetter);

      const actor = new UnpickableActor();
      actor.set_name(`${child.name}-selfExcludingSnapshot`);

      // Push new content onto the actor whenever the capture updates,
      // rather than polling on a timer, so this stays in lockstep with
      // SelfExcludingSnapshotCapture's own 'after-paint'-driven refresh.
      const applyContent = () => {
        if ((actor as any)._isDisposed) return;
        const content = capture.getContent();
        if (content && actor.content !== content) {
          actor.content = content;
        }
      };
      let afterPaintId = 0;
      try {
        afterPaintId = (stage as any).connect('after-paint', applyContent);
      } catch (e) {
      }
      applyContent();

      this._delayedCaptureOwners.set(actor, { source: child, hideActor: selfRoot });
      actor.connect('destroy', () => {
        (actor as any)._isDisposed = true;
        if (afterPaintId) { try { (stage as any).disconnect(afterPaintId); } catch (_) { /* noop */ } }
        const owner = this._delayedCaptureOwners.get(actor);
        if (owner) {
          releaseSelfExcludingSnapshot(owner.source, owner.hideActor);
          this._delayedCaptureOwners.delete(actor);
        }
      });

      return actor;
    } catch (e) {
      return null;
    }
  }

  /** Toggle for the OffscreenEffect-reading fallback (see _useCaptureFixForBms). */
  setUseCaptureFixForBms(enabled: boolean): void {
    this._useCaptureFixForBms = enabled;
  }


  /**
   * Searches `root`'s subtree (read-only, no mutation) for an existing
   * Clutter.OffscreenEffect — e.g. a blur implemented as a JS effect by some
   * other extension. Our own debug effects (GTypeName starting with
   * "LiquidGlass") are skipped so we never pick up our own instrumentation.
   */
  private _findExistingOffscreenEffect(
    root: Clutter.Actor
  ): { actor: Clutter.Actor; effect: Clutter.OffscreenEffect } | null {
    const stack: Clutter.Actor[] = [root];
    const visited = new Set<Clutter.Actor>();

    while (stack.length > 0) {
      const actor = stack.pop()!;
      if (visited.has(actor)) continue;
      visited.add(actor);

      try {
        const effects: Clutter.Effect[] = (actor as any).get_effects?.() ?? [];
        for (const effect of effects) {
          if (!(effect instanceof Clutter.OffscreenEffect)) continue;
          const gtypeName = (effect.constructor as any)?.$gtype?.name ?? '';
          if (gtypeName.startsWith('LiquidGlass')) continue;
          return { actor, effect: effect as Clutter.OffscreenEffect };
        }

        const children: Clutter.Actor[] = (actor as any).get_children?.() ?? [];
        for (const c of children) stack.push(c);
      } catch (_) { /* noop */ }
    }
    return null;
  }

  /**
   * Fallback for BMS-target children when SelfExcludingSnapshotCapture is
   * unavailable: reads an existing OffscreenEffect's captured texture
   * directly, without adding anything to the actor tree. This never
   * matches BMS's own native blur effect (see class doc comment on
   * _useCaptureFixForBms) but can help other, JS-effect-based extensions.
   * Returns null if nothing suitable was found.
   */
  private _createExistingEffectBlitActor(child: Clutter.Actor): Clutter.Actor | null {
    let found = this._existingEffectCache.get(child);
    if (found === undefined) {
      found = this._findExistingOffscreenEffect(child);
      this._existingEffectCache.set(child, found);
    }
    if (!found) return null;

    const { actor: effectOwner, effect } = found;
    const blit = new TextureBlitActor();
    blit.setSourceActor(effectOwner);
    blit.setTextureGetter(() => effect.get_texture() as Cogl.Texture2D | null);
    return blit;
  }

  rebindSelf() {
    this._selfRoot = this._findUiGroupAncestor(this._selfActor);
  }

  /**
   * Returns true if `root`'s subtree contains the root actor of *another*
   * Liquid Glass instance (bgActor, named 'liquid-glass-bg-actor', or its
   * child liquidBox, named 'liquid-box'). Searched recursively with no
   * depth limit — a shallow, direct-child-only check is not enough: if a
   * glass instance's root ends up nested more than one level below a
   * uiGroup child (e.g. when multiple popups are open at once, or another
   * container wraps it), a shallow check silently misses it and that whole
   * instance — including whatever it has already rendered — gets cloned
   * into this glass, producing a visible "glass inside glass" nesting
   * artifact.
   */
  private _containsOtherLiquidGlassRoot(root: Clutter.Actor): boolean {
    const stack: Clutter.Actor[] = [root];
    const visited = new Set<Clutter.Actor>();
    while (stack.length > 0) {
      const actor = stack.pop()!;
      if (visited.has(actor)) continue;
      visited.add(actor);
      try {
        const name = (actor as any).name;
        if (name === 'liquid-glass-bg-actor' || name === 'liquid-box') return true;
        const children: Clutter.Actor[] = (actor as any).get_children?.() ?? [];
        for (const c of children) stack.push(c);
      } catch (_) { /* noop */ }
    }
    return false;
  }

  /**
   * Repositions a freshly-added clone within `_uiClonesContainer` to match
   * `child`'s real z-order among `uiGroup`'s children, rather than leaving
   * it wherever `add_child()` put it (always the front).
   *
   * Without this, any uiGroup child that appears *after* the glass was
   * already showing other clones — e.g. the full-screen blurred backdrop
   * GNOME's Activities/Overview creates — ends up rendered in front of
   * clones added earlier, regardless of its real stacking order on screen.
   * (The real screen is unaffected since this only concerns our own clone
   * container's internal ordering.)
   */
  private _insertCloneInZOrder(child: Clutter.Actor, clone: Clutter.Actor): void {
    if (!this._uiClonesContainer) return;
    try {
      const uiGroup = Main.layoutManager.uiGroup;
      const siblings = uiGroup.get_children();
      const idx = siblings.indexOf(child);
      if (idx < 0) return; // Not found: leave it at the front.

      let insertAboveClone: Clutter.Actor | null = null;
      for (let i = idx - 1; i >= 0; i--) {
        const prevClone = this._clones.get(siblings[i]);
        if (prevClone && !(prevClone as any)._isDisposed) {
          insertAboveClone = prevClone;
          break;
        }
      }
      if (insertAboveClone) {
        this._uiClonesContainer.set_child_above_sibling(clone, insertAboveClone);
      } else {
        // No cloned sibling sits below `child` in uiGroup's real order, so
        // this one is currently the backmost among cloned siblings.
        this._uiClonesContainer.set_child_below_sibling(clone, null);
      }
    } catch (e) {
    }
  }

  /**
   * Scans uiGroup's current children, creating/destroying clones as needed.
   * Call whenever the set of top-level UI actors may have changed (e.g. a
   * menu opening or closing).
   */
  refresh() {
    if (!this._selfRoot) this._selfRoot = this._findUiGroupAncestor(this._selfActor);

    const uiGroup = Main.layoutManager.uiGroup;
    const children = uiGroup.get_children();
    const seen = new Set<Clutter.Actor>();

    for (const child of children) {
      if ((child as any)._isDisposed) continue;
      if (child === this._selfActor || child === this._selfRoot) continue;
      if (child === Main.layoutManager._backgroundGroup) continue;
      if (this._extraExclusions.has(child)) continue;
      if (!child.visible || !child.mapped) continue;
      // if (this._containsOtherLiquidGlassRoot(child)) continue;
      // Deep scan for nested Liquid Glass roots only once per newly discovered actor.
      // Doing this every frame causes massive performance drops in the Overview.
      if (!this._clones.has(child) && this._containsOtherLiquidGlassRoot(child)) {
        this.addExclusion(child);
        continue;
      }
      seen.add(child);
      if (!this._clones.has(child)) {
        child.connect('destroy', () => {
          (child as any)._isDisposed = true;
          const clone = this._clones.get(child);
          if (clone) {
            this._clones.delete(child);
            try { clone.destroy(); } catch (_) { }
          }
        });

        const bmsTarget = this._findBmsDescendant(child);

        let sourceClone: Clutter.Actor | null = null;
        if (bmsTarget) {
          // 1st: the real fix — a snapshot that structurally cannot
          // include ourselves (see SelfExcludingSnapshotCapture).
          sourceClone = this._createSelfExcludingSnapshotActor(child);
          // 2nd: read an existing OffscreenEffect's texture (useful for
          // other extensions; BMS's native effect never matches this).
          if (!sourceClone && this._useCaptureFixForBms) {
            sourceClone = this._createExistingEffectBlitActor(child);
          }
        }
        // Fallback: an ordinary unpickable clone.
        if (!sourceClone) {
          sourceClone = new UnpickableClone({ source: child });
        }
        sourceClone.set_name(`${child.name}-sourceClone`);

        sourceClone.connect('destroy', () => {
          this._clones.delete(child);
        });

        this._uiClonesContainer?.add_child(sourceClone);
        this._clones.set(child, sourceClone);
        this._insertCloneInZOrder(child, sourceClone);
      }
    }

    for (const [actor, sourceClone] of this._clones) {
      if (!seen.has(actor)) {
        try { sourceClone.destroy(); } catch (_) { }
      }
    }
  }

  private static _stageToLocal(
    actor: Clutter.Actor,
    stageX: number,
    stageY: number
  ): [number, number] {
    try {
      const res = (actor as any).transform_stage_point(stageX, stageY);
      if (Array.isArray(res) && res[0] === true) {
        return [res[1] as number, res[2] as number];
      }
    } catch (_) { }

    try {
      const [cx, cy] = actor.get_transformed_position();
      return [
        stageX - (Number.isNaN(cx) ? 0 : cx),
        stageY - (Number.isNaN(cy) ? 0 : cy),
      ];
    } catch (_) {
      return [stageX, stageY];
    }
  }

  /**
   * Copies `source`'s current position/size/opacity/visibility onto its
   * clone, and culls the clone if it falls outside the given container
   * bounds.
   */
  syncProperties(
    source: Clutter.Actor,
    sourceClone: Clutter.Actor,
    containerW: number,
    containerH: number,
    cX: number,
    cY: number
  ) {
    if (!source || !sourceClone) return;
    try {
      const [absX, absY] = source.get_transformed_position();
      const [w, h] = getAllocatedSize(source);

      if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
        sourceClone.visible = false;
        return;
      }

      const scaleX = source.scale_x;
      const scaleY = source.scale_y;

      // get_transformed_position() already folds in source's own
      // scale/pivot (it maps the local origin through the full accumulated
      // transform). So we must NOT also apply scale/pivot again on the
      // clone — doing so double-counts the pivot offset
      // (pivot * size * (1 - scale)), which is invisible when scale is 1
      // and pivot is (0,0) but shows up as a few pixels of drift on
      // anything that scales on hover/press (e.g. the calendar's "today"
      // highlight, panel buttons). Instead, bake the visual scale directly
      // into the clone's size and leave its own scale at 1.
      const scaledW = w * scaleX;
      const scaledH = h * scaleY;

      sourceClone.set_position(absX, absY);
      sourceClone.translation_x = 0;
      sourceClone.translation_y = 0;

      sourceClone.set_size(scaledW, scaledH);
      sourceClone.set_scale(1.0, 1.0);
      sourceClone.set_pivot_point(0, 0);

      sourceClone.opacity = source.opacity;

      const localX = absX - cX;
      const localY = absY - cY;

      const isVisible = source.visible && source.mapped;

      if (isVisible && containerW > 0 && containerH > 0) {
        const isIntersecting =
          localX < containerW &&
          (localX + scaledW) > 0 &&
          localY < containerH &&
          (localY + scaledH) > 0;

        sourceClone.visible = isIntersecting;
      } else {
        sourceClone.visible = isVisible;
      }
    } catch (_) { }
  }

  // Repositions the UI-clone container and culls off-screen clones.
  //
  // In the full-screen-FBO architecture, callers pass
  //   sync(monitor.x, monitor.y, screenW, screenH)
  // rather than the dock's own local (bgX, bgY, bgW, bgH).
  //
  // Effect: _uiClonesContainer is placed at (-monitor.x, -monitor.y) so a
  // clone at absolute screen position (absX, absY) ends up at:
  //   monitor.x + (-monitor.x + absX) = absX  ✓
  // The wider container dimensions (screenW, screenH) relax the cull
  // frustum to the full monitor; actual rendering is still limited to the
  // dock area by the clip applied to liquidBox/blurBox elsewhere.
  sync(cX?: number, cY?: number, cW?: number, cH?: number) {
    let contW = cW ?? 0;
    let contH = cH ?? 0;
    let contAbsX = cX ?? 0;
    let contAbsY = cY ?? 0;

    if (cX === undefined || cY === undefined) {
      try {
        const [cw, ch] = this._container.get_size();
        if (!Number.isNaN(cw)) contW = cw;
        if (!Number.isNaN(ch)) contH = ch;

        const [tx, ty] = this._container.get_transformed_position();
        contAbsX = Number.isNaN(tx) ? 0 : tx;
        contAbsY = Number.isNaN(ty) ? 0 : ty;
      } catch (_) { }
    }
    // Always bring the UI clones container to the front, regardless of its parent.
    // This prevents WindowCloneManager's rebuilds from placing windows above the UI.
    const parent = this._uiClonesContainer?.get_parent();
    if (parent && this._uiClonesContainer) {
      const siblings = parent.get_children();
      if (siblings[siblings.length - 1] !== this._uiClonesContainer) {
        parent.set_child_above_sibling(this._uiClonesContainer, null);
      }
    }
    // Sign is flipped relative to WindowCloneManager.setOffset(x, y).
    this._uiClonesContainer?.set_position(-contAbsX, -contAbsY);

    for (const [actor, sourceClone] of this._clones) {
      this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
    }
  }

  destroy() {
    if (this._uiClonesContainer) {
      try { this._uiClonesContainer.destroy(); } catch (_) { }
    }
    this._clones.clear();
    this._selfRoot = null;
    this._existingEffectCache.clear();
  }
}


export class WindowCloneManager {
  private windowClonesContainer: Clutter.Actor | null = null;
  private _windowClones: Map<Clutter.Actor, Clutter.Clone>;
  private bgClone: Clutter.Clone | null = null;

  private container: Clutter.Actor | null = null;
  private cloneContainer: Clutter.Actor | null = null;

  constructor(container: Clutter.Actor, cloneContainer: Clutter.Actor | null = null) {
    this.container = container;
    this._windowClones = new Map();

    this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
    this.bgClone.connect('destroy', () => { this.bgClone = null; });

    this.windowClonesContainer = new UnpickableActor();
    this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });

    this.cloneContainer = cloneContainer;

    // windowClonesContainer can only have one parent, so it's added either
    // to cloneContainer or to container directly — never both. As long as
    // cloneContainer is added to container after bgClone, the intended
    // z-order (bgClone behind, window clones in front) holds regardless.
    if (this.cloneContainer) {
      this.cloneContainer.add_child(this.windowClonesContainer);
    } else {
      this.container.add_child(this.windowClonesContainer);
    }

    // bgClone (the wallpaper) always sits at the very back of container.
    this.container.insert_child_at_index(this.bgClone, 0);
  }

  rebuildClones() {
    if (!this.container) return;

    if (this.bgClone) { this.bgClone.destroy(); }
    if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); }

    this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
    this.bgClone.connect('destroy', () => { this.bgClone = null; });

    this.windowClonesContainer = new UnpickableActor();
    this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });

    if (this.cloneContainer) {
      this.cloneContainer.add_child(this.windowClonesContainer);
    } else {
      this.container.add_child(this.windowClonesContainer);
    }
    this.container.insert_child_at_index(this.bgClone, 0);

    this._windowClones.clear();
    this.sync();
  }

  // Shifts the entire clone subtree within the full-screen FBO.
  //
  // In the full-screen-FBO architecture, the caller (dockManager) passes
  // (-monitor.x, -monitor.y) rather than the dock's own (-bgX, -bgY).
  //
  // Rationale: clones sit at their absolute screen coordinates (w.x, w.y).
  // blurBox/liquidBox start at (0,0) inside bgActor, which itself sits at
  // (monitor.x, monitor.y). Offsetting this container by
  // (-monitor.x, -monitor.y) makes each clone's net screen position:
  //   monitor.x + 0 + (-monitor.x + w.x) = w.x  ✓
  setOffset(x: number, y: number) {
    this.windowClonesContainer?.set_position(x, y);
    this.bgClone?.set_position(x, y);
  }

  sync() {
    let windows = getWindowActors();
    let activeWindows = new Set();
    let zIndex = 0;

    for (let w of windows) {
      let metaWindow = w.get_meta_window();
      if (!metaWindow || metaWindow.minimized || !w.visible) continue;

      // Read position/size directly rather than via the more expensive
      // get_transformed_position(). Size comes from the allocation, not
      // w.width/w.height: those fall back to the preferred size while a
      // relayout is pending, and a bogus 0 here would `continue` past the
      // window and destroy its clone for a frame (see getAllocatedSize).
      let [width, height] = getAllocatedSize(w);

      if (width <= 0 || height <= 0) continue;

      activeWindows.add(w);

      let clone;
      if (!this._windowClones.has(w)) {
        clone = new UnpickableClone({ source: w });
        this.windowClonesContainer?.add_child(clone);
        this._windowClones.set(w, clone);
      } else {
        clone = this._windowClones.get(w);
      }

      clone.remove_transition('position');
      clone.remove_transition('size');
      clone.set_position(w.x, w.y);
      clone.set_size(width, height);

      clone.remove_transition('scale-x');
      clone.remove_transition('scale-y');
      clone.set_scale(w.scale_x, w.scale_y);

      // Copy translation directly too, so animation interpolation is
      // reflected immediately rather than lagging a frame behind.
      clone.translation_x = w.translation_x;
      clone.translation_y = w.translation_y;

      let pX = w.pivot_point ? w.pivot_point.x : 0;
      let pY = w.pivot_point ? w.pivot_point.y : 0;
      clone.set_pivot_point(pX, pY);

      this.windowClonesContainer?.set_child_at_index(clone, zIndex);
      zIndex++;
    }

    // Remove clones for windows that closed, or all of them when the
    // Overview starts.
    for (let [w, clone] of this._windowClones.entries()) {
      if (!activeWindows.has(w)) {
        clone.destroy();
        this._windowClones.delete(w);
      }
    }
  }

  destroy() {
    if (this.windowClonesContainer) {
      this.windowClonesContainer.destroy();
    }
    this._windowClones.clear();
    if (this.bgClone) {
      this.bgClone.destroy();
    }
    this.container = null;
  }
}

/**
 * A ShaderEffect that punches a rounded-rectangle hole out of whatever it's
 * attached to, leaving only the (inset) corner regions visible.
 *
 * Used by ApplicationManager: real application windows have square surfaces,
 * but the liquid-glass background behind them is rendered with rounded
 * corners (via LiquidEffect's corner_radius uniform). Without this effect the
 * window's own opaque content would square off the corners again, breaking
 * the illusion. Applied to a small overlay actor stacked above the window's
 * content and fed a clone of the true (unblurred) background, it reveals
 * exactly the true corner pixels while leaving the rest of the window alone.
 */
export const InverseCornerEffect = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassInverseCornerEffect',
  },
  class InverseCornerEffect extends Clutter.ShaderEffect {
    private _radius: number = 0;
    private _inset: number = 0;

    setRadius(radius: number) {
      this._radius = radius;
      this._updateShader();
    }

    setInset(inset: number) {
      this._inset = inset;
      this._updateShader();
    }

    _updateShader() {
      const shader = `
        uniform sampler2D cogl_sampler;
        uniform float radius;
        uniform float inset;
        uniform float width;
        uniform float height;

        float sdRoundRect(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b + vec2(r);
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
        }

        void main() {
          vec2 st = cogl_tex_coord_in[0].st;
          vec2 resolution = vec2(width, height);
          vec2 p = (st * resolution) - (resolution * 0.5);

          // [FIX] Box half-size at the window's TRUE edge, not shrunk by
          // "inset" on every side. This overlay's actor is padded by
          // SHADER_PADDING beyond the real window bounds on all sides, and
          // "inset" here is exactly that padding — so windowHalf lands
          // precisely on the real window edge.
          //
          // Previously this used (resolution - inset*2)*0.5 with
          // inset = SHADER_PADDING + CORNER_PADDING, which shrank the box by
          // the SAME amount on every side, not just near the corners. Per
          // sdRoundRect's construction, its straight-edge (non-corner)
          // zero-crossing sits exactly at the box half-size regardless of
          // "radius" — only points within "radius" of an actual corner get
          // pulled inward. So shrinking the box itself (rather than only
          // widening "radius") revealed a uniform band along the ENTIRE
          // perimeter — straight edges included — instead of just the 4
          // corners. That band unconditionally painted this overlay's raw,
          // unblurred/untinted/un-shadowed source at full alpha, erasing the
          // drop shadow right next to the window on every edge (reported as
          // an unnatural halo/"frame" around the window), and — since its
          // width is a fixed pixel count independent of actor scale — became
          // sharply more visible whenever GNOME Shell's open/close animation
          // scaled the window down (the same fixed-pixel band read as a much
          // larger fraction of the shrunk window).
          //
          // "radius" (cornerRadius + CORNER_PADDING, set by the caller) is
          // intentionally a couple pixels larger than the glass shape's own
          // corner_radius so the cut safely over-reveals past the glass's
          // own antialiased corner — but that over-cut should only pull the
          // 4 corners inward, not shift the straight edges too.
          vec2 windowHalf = max(resolution * 0.5 - vec2(inset), vec2(1.0));

          float d = sdRoundRect(p, windowHalf, radius);

          // Sharper transition for the corner cut to avoid dark fringes
          float alpha = smoothstep(-0.5, 0.5, d);

          // Fade out at the very edges of the overlay actor to ensure it blends seamlessly
          // with the background and hides any potential window shadow cutoff.
          vec2 edgeDist = min(st, 1.0 - st) * resolution;
          float edgeFade = smoothstep(0.0, 10.0, min(edgeDist.x, edgeDist.y));
          alpha *= edgeFade;

          cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
        }
      `;
      this.set_shader_source(shader);
      this._updateUniforms();
    }

    _setUniform(name: string, value: number) {
      let gval = new GObject.Value();
      gval.init(GObject.TYPE_FLOAT);
      gval.set_float(value);
      this.set_uniform_value(name, gval);
    }

    _updateUniforms() {
      let actor = (this as any).get_actor();
      if (!actor) return;

      let w = actor.width;
      let h = actor.height;

      if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) return;

      this._setUniform('radius', this._radius);
      this._setUniform('inset', this._inset);
      this._setUniform('width', w);
      this._setUniform('height', h);
    }

    vfunc_paint_target(node: any, paint_context: any): void {
      this._updateUniforms();
      super.vfunc_paint_target(node, paint_context);
    }
  }
);

/**
 * Safe helper to retrieve window actors, compatible with GNOME Shell
 * pre-48 (global.get_window_actors) and 48+/GNOME 50 (Mutter moved it to
 * global.compositor.get_window_actors). Every call site in this extension
 * that needs the current list of window actors should go through this
 * instead of calling either API directly.
 */
export function getWindowActors(): any[] {
  if (global.compositor && typeof (global.compositor as any).get_window_actors === 'function') {
    return (global.compositor as any).get_window_actors();
  }
  if (typeof (global as any).get_window_actors === 'function') {
    return (global as any).get_window_actors();
  }
  return [];
}

/**
 * Safe helper to check whether a Clutter actor (GObject) is still valid and
 * has not been disposed. Touching a property on a disposed GObject throws;
 * this is used to guard per-frame sync loops (e.g. ApplicationManager, which
 * juggles many short-lived per-window clones) against that.
 */
export function isActorValid(actor: any): boolean {
  if (!actor) return false;
  try {
    let _v = actor.visible;
    return true;
  } catch (e) {
    return false;
  }
}

export const InvertedPositionConstraint = GObject.registerClass({
  GTypeName: 'InvertedPositionConstraint',
  Properties: {
    'source': GObject.ParamSpec.object(
      'source', 'Source', 'Source Actor',
      GObject.ParamFlags.READWRITE,
      Clutter.Actor.$gtype
    ),
    'offset-x': GObject.ParamSpec.double(
      'offset-x', 'Offset X', 'X Offset',
      GObject.ParamFlags.READWRITE,
      Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0
    ),
    'offset-y': GObject.ParamSpec.double(
      'offset-y', 'Offset Y', 'Y Offset',
      GObject.ParamFlags.READWRITE,
      Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0
    ),
  },
}, class InvertedPositionConstraint extends Clutter.Constraint {
  declare source: Clutter.Actor | null;
  declare offset_x: number;
  declare offset_y: number;

  private _sourceXId: number = 0;
  private _sourceYId: number = 0;

  _init(props?: any) {
    super._init(props);

    // sourceプロパティ自体が変更されたときの監視
    this.connect('notify::source', this._onSourceChanged.bind(this));
    if (this.source) {
      this._onSourceChanged();
    }
  }

  private _onSourceChanged() {
    this._disconnectSignals();

    if (this.source) {
      const queueRelayout = () => {
        const actor = this.get_actor();
        if (actor) {
          actor.queue_relayout(); // 変更があったら再割り当てを要求
        }
      };

      // sourceが移動した時にレイアウト再計算を走らせる
      this._sourceXId = this.source.connect('notify::x', queueRelayout);
      this._sourceYId = this.source.connect('notify::y', queueRelayout);

      // 登録時にも1度レイアウトを要求
      queueRelayout();
    }
  }

  private _disconnectSignals() {
    if (!this.source) return;
    if (this._sourceXId) { this.source.disconnect(this._sourceXId); this._sourceXId = 0; }
    if (this._sourceYId) { this.source.disconnect(this._sourceYId); this._sourceYId = 0; }
  }

  vfunc_update_allocation(actor: Clutter.Actor, allocation: Clutter.ActorBox) {
    if (!this.source)
      return;

    // 1. 基準アクターの座標を取得
    const [x, y] = this.source.get_position();

    // 2. 追従アクターの現在の幅と高さを保持
    const width = allocation.get_width();
    const height = allocation.get_height();

    // 3. 反転座標にオフセットを加算
    const targetX = -x + (this.offset_x ?? 0.0);
    const targetY = -y + (this.offset_y ?? 0.0);

    // 4. allocation (Clutter.ActorBox) の領域を直接書き換える
    allocation.x1 = targetX;
    allocation.y1 = targetY;
    allocation.x2 = targetX + width;
    allocation.y2 = targetY + height;
  }
});
export type InvertedPositionConstraint = InstanceType<typeof InvertedPositionConstraint>;
