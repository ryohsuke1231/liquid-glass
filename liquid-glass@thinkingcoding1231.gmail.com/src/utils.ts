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
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Mtk from 'gi://Mtk';

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
  // [CHANGED] A single shared capture (keyed by BMS source actor, see
  // acquireSelfExcludingSnapshot) can be used by *multiple* Liquid Glass
  // instances at once (e.g. dock glass + menu glass both on). Every
  // instance's own root actor must be hidden during the snapshot, not just
  // whichever instance happened to create the capture first — otherwise
  // instances created later stay visible in the shared snapshot, get
  // captured into it, and since that snapshot is what they redraw with
  // every frame, each new capture already contains the previous one's
  // rendered glass, nested one level deeper: a runaway feedback loop that
  // washes the panel out to white ("複数個ある場合は自己参照して真っ白になる").
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

  constructor(stage: Clutter.Stage, hideActor: Clutter.Actor, rectGetter: () => [number, number, number, number]) {
    this._stage = stage;
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
      console.error(`[Liquid Glass] SelfExcludingSnapshotCapture: failed to connect to 'after-paint': ${e}`);
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

  private _captureOnce(): void {
    const [x, y, w, h] = this._rectGetter();
    if (w <= 0 || h <= 0) return;

    // [CHANGED] Hide every registered instance's root, not just a single
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
      const paintFlags = (Clutter as any).PaintFlag?.NO_CURSORS ?? 0;
      const content = (this._stage as any).paint_to_content?.(rect, scale, null, paintFlags);
      if (content) this._content = content;
    } catch (e) {
      console.error(`[Liquid Glass] SelfExcludingSnapshotCapture: paint_to_content failed: ${e}`);
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
  rectGetter: () => [number, number, number, number]
): SelfExcludingSnapshotCapture {
  let cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) {
    cap = new SelfExcludingSnapshotCapture(stage, hideActor, rectGetter);
    _selfExcludingSnapshotRegistry.set(sourceActor, cap);
  } else {
    // [CHANGED] The capture already exists (created by another Liquid Glass
    // instance, e.g. the dock glass while this is the menu glass, or vice
    // versa). We must still register *our* root as a hide target, or our
    // glass stays visible during every future capture and ends up
    // recursively baked into its own panel snapshot.
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
      console.error(`[Liquid Glass][TextureBlitActor] failed to get Cogl context: ${e}`);
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

      // Some OffscreenEffect implementations pad their captured texture a
      // few pixels beyond the actor's logical size (Cogl FBO alignment).
      // If so, sample only the centered sub-rectangle matching the source's
      // actual allocated size.
      let uMin = 0, vMin = 0, uMax = 1, vMax = 1;
      const src = this._sourceActor;
      if (src) {
        const [rawW, rawH] = src.get_size();
        const allocW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : texW;
        const allocH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : texH;

        if ((allocW !== texW || allocH !== texH) && texW > 0 && texH > 0) {
          const padW = texW - allocW;
          const padH = texH - allocH;
          uMin = (padW / 2) / texW;
          vMin = (padH / 2) / texH;
          uMax = Math.min(1.0, uMin + allocW / texW);
          vMax = Math.min(1.0, vMin + allocH / texH);
        }
      }

      this._pipeline.set_layer_texture(0, tex);

      const [w, h] = this.get_size();
      if (!(w > 0) || !(h > 0)) return;

      const fb = paintContext.get_framebuffer() as unknown as Cogl.Framebuffer;
      fb.draw_textured_rectangle(this._pipeline, 0, 0, w, h, uMin, vMin, uMax, vMax);
    } catch (e) {
      console.error(`[Liquid Glass][TextureBlitActor] paint failed: ${e}`);
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
  private _uiClonesContainer: Clutter.Actor;

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
        const [w, h] = child.get_size();
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
        console.error(`[Liquid Glass] SelfExcludingSnapshotActor: failed to connect to 'after-paint': ${e}`);
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
      console.error(`[Liquid Glass] Failed to create SelfExcludingSnapshotCapture actor: ${e}`);
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
      console.error(`[Liquid Glass] _insertCloneInZOrder failed: ${e}`);
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

        this._uiClonesContainer.add_child(sourceClone);
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
      const [w, h] = source.get_size();

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
    const parent = this._uiClonesContainer.get_parent();
    if (parent) {
      const siblings = parent.get_children();
      if (siblings[siblings.length - 1] !== this._uiClonesContainer) {
        parent.set_child_above_sibling(this._uiClonesContainer, null);
      }
    }
    // Sign is flipped relative to WindowCloneManager.setOffset(x, y).
    this._uiClonesContainer.set_position(-contAbsX, -contAbsY);

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
    this.windowClonesContainer = new UnpickableActor();
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

    if (this.bgClone) { this.bgClone.destroy(); this.bgClone = null; }
    if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); this.windowClonesContainer = null; }

    this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
    this.windowClonesContainer = new UnpickableActor();

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
    let windows = global.get_window_actors();
    let activeWindows = new Set();
    let zIndex = 0;

    for (let w of windows) {
      let metaWindow = w.get_meta_window();
      if (!metaWindow || metaWindow.minimized || !w.visible) continue;

      // Read position/size directly rather than via the more expensive
      // get_transformed_position().
      let width = w.width;
      let height = w.height;

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
      this.windowClonesContainer = null;
    }
    this._windowClones.clear();
    if (this.bgClone) {
      this.bgClone.destroy();
      this.bgClone = null;
    }
    this.container = null;
  }
}

// Pass-through shader effect: outputs its input texture unchanged. Useful
// as a minimal no-op effect when one is needed structurally.
export const PassThroughEffect = GObject.registerClass({
  GTypeName: 'LiquidGlassPassThroughEffect',
}, class PassThroughEffect extends Clutter.ShaderEffect {
  _init(params: any = {}) {
    super._init(params);
    this.set_shader_source(`
      uniform sampler2D tex;
      void main() {
        cogl_color_out = texture2D(tex, cogl_tex_coord_in[0].st);
      }
    `);
  }
});

export type PassThroughEffect = InstanceType<typeof PassThroughEffect>;
