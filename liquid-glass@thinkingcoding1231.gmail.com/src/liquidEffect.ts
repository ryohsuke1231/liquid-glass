import { MaterialSettings } from './rendering/material.js';
import { CropPass } from './rendering/crop.js';
import { BlurRenderer, type BlurMethod } from './rendering/blur.js';
import { ShaderPipelines, configureSamplerLayer } from './rendering/pipelines.js';
import { GlassGeometry } from './rendering/geometry.js';
import { UniformState } from './rendering/uniforms.js';
// Coordinates, deferred paint ordering and historical traps are documented in
// docs/rendering-notes.md. GPU work belongs in rendering/*; this class coordinates
// the Clutter effect lifecycle and preserves the managers’ public interface.

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { Logger } from './logger.js';
import { RenderPasses } from './rendering/passes.js';
import { computeCaptureLayout } from './actors/geometry.js';
import { registerGlassEffect, unregisterGlassEffect } from './diagnostics/glass.js';
import { frameSerial, ensureFrameSerialHook, frameSerialIsLive } from './rendering/frameClock.js';
export { noteStrandEntry, setGlassRingArmed, isGlassRingArmed, startGlassRingSampler, stopGlassRingSampler, flushGlassRing } from './diagnostics/glass.js';

interface LiquidEffectParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  logger?: Logger;
  /**
   * Which manager owns this effect ('dock', 'menu', 'notification', 'osd',
   * 'quick-settings', 'quick-settings-toggles', 'application'). Diagnostic
   * only. Without it every popup surface shows up in global._lgGlass.dump()
   * as the same actor name, "liquid-box", and telling the dock's instance
   * apart from a menu's needs cross-referencing creation timestamps in the
   * log — which is exactly the step that made the first round of paint-rate
   * analysis ambiguous.
   */
  owner?: string;
  [key: string]: any; // spread into super._init(params)
}

// ─── Main class ───────────────────────────────────────────────────────────────

export const LiquidEffect = GObject.registerClass({
  GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {

  // Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
  static MAX_GLASS_REGIONS = 16;

  static get USE_BLUR_RECT() { return GlassGeometry.USE_BLUR_RECT; }
  static set USE_BLUR_RECT(value) { GlassGeometry.USE_BLUR_RECT = value; }
  static get BLUR_RECT_MIN_MARGIN() { return GlassGeometry.BLUR_RECT_MIN_MARGIN; }
  static set BLUR_RECT_MIN_MARGIN(value) { GlassGeometry.BLUR_RECT_MIN_MARGIN = value; }
  static get BLUR_RECT_MIN_SAVING() { return GlassGeometry.BLUR_RECT_MIN_SAVING; }
  static set BLUR_RECT_MIN_SAVING(value) { GlassGeometry.BLUR_RECT_MIN_SAVING = value; }
  static get BLUR_RECT_QUANTUM() { return GlassGeometry.BLUR_RECT_QUANTUM; }
  static set BLUR_RECT_QUANTUM(value) { GlassGeometry.BLUR_RECT_QUANTUM = value; }
  static get CAPTURE_CLIP_EXTRA_MARGIN() { return GlassGeometry.CAPTURE_CLIP_EXTRA_MARGIN; }
  static set CAPTURE_CLIP_EXTRA_MARGIN(value) { GlassGeometry.CAPTURE_CLIP_EXTRA_MARGIN = value; }
  static get CAPTURE_CLIP_MIN_SAVING() { return GlassGeometry.CAPTURE_CLIP_MIN_SAVING; }
  static set CAPTURE_CLIP_MIN_SAVING(value) { GlassGeometry.CAPTURE_CLIP_MIN_SAVING = value; }
  static get USE_COMPOSITE_RECT() { return GlassGeometry.USE_COMPOSITE_RECT; }
  static set USE_COMPOSITE_RECT(value) { GlassGeometry.USE_COMPOSITE_RECT = value; }
  static get COMPOSITE_RECT_MIN_SAVING() { return GlassGeometry.COMPOSITE_RECT_MIN_SAVING; }
  static set COMPOSITE_RECT_MIN_SAVING(value) { GlassGeometry.COMPOSITE_RECT_MIN_SAVING = value; }

  // ─── Private fields ────────────────────────────────────────────────────────

  declare private _extensionPath: string | undefined;
  // Diagnostic label naming the owning manager; see LiquidEffectParams.owner.
  declare private _owner: string;
  // [anim-diag] Human-readable identity of what this glass belongs to (a
  // window title, usually), set by the owning manager. The dump had no way to
  // tell two glasses apart: five 'application' rows with only a size to go on
  // meant "is this the same instance resized, or a second one?" could not be
  // answered from a log, which is exactly the question the animation and
  // leftover-glass reports turn on.
  declare _diagOwnerLabel: string;
  declare private _logger: Logger | undefined;
  // Per-instance override of LiquidEffect.USE_CROP_PASS.
  declare private _cropPassEnabled: boolean;

  // [DIAG] Last frame's resolved pipeline state, dumped by global._lgGlass.
  declare private _diagLast: any;
  // The rect handed to the blur chain on the last paint, in that same
  // space, or null when the whole actor is blurred (the old behavior).
  declare private _blurRect: number[] | null;
  // The rect the blur result currently in _blurResultTex was actually
  // produced with, so a reuse can tell whether it still describes it.
  declare private _blurRectUsed: number[] | null;
  // The composite quad's sub-rect on the last paint, or null for the whole
  // actor. Diagnostics only; see _computeCompositeRect().
  declare private _compositeRect: number[] | null;
  declare private _shadersLoaded: boolean;

  // Unconditional counters distinguish a culled effect from a broken composite.
  declare private _diagPaintCount: number;
  declare private _diagCompositedPaintCount: number;
  declare private _diagLastPaintLogAt: number;
  declare private _diagFirstPaintLogged: boolean;

  // Keep expensive per-paint diagnostics separate from the output-logs switch.
  declare private _diagEnabled: boolean;

  // Wall-clock of the last _diagLast refresh, so global._lgGlass.dump() still
  // reports something useful (about a second stale) with diagnostics off.
  declare private _diagLastSnapshotAt: number;

  // Reuse is keyed on stage frame serial, never the paint framebuffer:
  // nested clone paints have different framebuffers but share the same source frame.
  declare private _blurFrameSerial: number;
  // Diagnostics: how many chains were skipped, and how many paints asked.
  declare private _blurRuns: number;
  declare private _blurSkips: number;

  // ApplicationManager uses this serial to repair outer captures after an inner
  // glass re-renders. Increment only when Clutter marks the capture ACTOR_DIRTY.
  declare private _recaptureSerial: number;

  declare private _material: MaterialSettings;

  declare private _crop: CropPass;

  declare private _geometry: GlassGeometry;

  declare private _uniforms: UniformState;

  declare private _blur: BlurRenderer;

  declare private _pipelines: ShaderPipelines;

  declare private _passes: RenderPasses;

  // ─── _init ──────────────────────────────────────────────────────────────────

  _init(params: LiquidEffectParams) {
    const extensionPath = params.extensionPath;
    const settings = params.settings;
    const logger = params.logger;
    const owner = params.owner;
    delete params.extensionPath;
    delete params.settings;
    delete params.logger;
    delete params.owner;

    super._init(params);

    this._owner = owner ?? '?';
    this._diagOwnerLabel = '';

    this._shadersLoaded = false;
    this._diagPaintCount = 0;
    this._diagLast = null;
    registerGlassEffect(this);
    this._diagCompositedPaintCount = 0;
    this._diagLastPaintLogAt = 0;
    this._diagEnabled = false;
    this._diagLastSnapshotAt = 0;
    this._blurFrameSerial = -1;
    this._cropPassEnabled = LiquidEffect.USE_CROP_PASS;
    this._blurRect = null;
    this._blurRectUsed = null;
    this._compositeRect = null;
    this._blurRuns = 0;
    this._blurSkips = 0;
    this._recaptureSerial = 0;
    ensureFrameSerialHook();
    this._diagFirstPaintLogged = false;

    this._extensionPath = extensionPath;
    this._logger = logger;
    this._passes = new RenderPasses(logger);
    this._pipelines = new ShaderPipelines(logger);
    this._crop = new CropPass(this._pipelines, this._passes, logger);
    this._blur = new BlurRenderer(this._pipelines, this._passes, () => this.queue_repaint(), logger);
    this._uniforms = new UniformState();
    this._geometry = new GlassGeometry(this._uniforms.values);
    this._material = new MaterialSettings(settings, this._uniforms, this._blur, enabled => { this._diagEnabled = enabled; });

    this._material.initialize();
    this._loadAllShadersAsync();
  }

  /**
  * Load all shader files asynchronously.
  */
  private async _loadAllShadersAsync(): Promise<void> {
    // [DIAG] Black-background investigation: each LiquidEffect instance loads
    // its own copy of the 3 shader files independently (no cross-instance
    // cache), so a brand-new window's glass literally cannot render until
    // this completes. Log start/duration to see how long this actually takes
    // relative to the window's own open animation, and to correlate with the
    // applicationManager diag logs (search for "[Liquid Glass][diag]").
    const diagStart = GLib.get_monotonic_time();
    this._logger?.log(`[Liquid Glass][diag] LiquidEffect: starting async shader load at t=${diagStart}us ` +
      `(extensionPath=${this._extensionPath})`);
    try {
      await this._pipelines.load(this._extensionPath);

      this._shadersLoaded = true;

      const elapsedMs = (GLib.get_monotonic_time() - diagStart) / 1000;
      this._logger?.log(`[Liquid Glass][diag] LiquidEffect: async shader load finished in ${elapsedMs.toFixed(1)}ms, ` +
        `calling queue_repaint() now. If the on-screen black-background bug is still visible ` +
        `after this point, the shader load itself is not the (sole) cause -- the issue is in ` +
        `getting this repaint request actually flushed to the display.`);

      // 読み込み完了後に再描画をリクエストし、パイプラインを初期化させる
      this.queue_repaint();
      const actor = this.get_actor();
      actor?.queue_redraw();
      actor?.get_parent()?.queue_redraw();
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to load shaders asynchronously: ${e}`);
    }
  }

  /**
   * Overrides Clutter.Effect's paint hook purely to observe the dirty flag.
   *
   * ACTOR_DIRTY is the only place the "the offscreen is about to be
   * re-rendered" fact is visible from JS: vfunc_paint_target() runs on every
   * paint, cached or not, so it cannot tell the two apart. Everything else is
   * left to the base class.
   */
  vfunc_paint(node: Clutter.PaintNode, paintContext: Clutter.PaintContext,
    flags: Clutter.EffectPaintFlags): void {
    if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY) this._recaptureSerial++;
    super.vfunc_paint(node, paintContext, flags);
  }

  /**
   * Overrides the Clutter.OffscreenEffect hook.
   *
   * Called after OffscreenEffect has rendered the actor's content into its
   * internal FBO, at the point where that FBO texture is normally composited
   * onto the screen.
   *
   * The default super.vfunc_paint_target() just draws the FBO straight to
   * the screen; here we instead run the blur pipeline followed by the glass
   * composite pass.
   *
   * @param _paintNode   Clutter's paint node (new signature since GNOME 45+)
   * @param paintContext Current paint context, holding a reference to the on-screen framebuffer
   */
  vfunc_paint_target(_paintNode: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
    // Count every invocation; resolve actor titles and log only when diagnostics are on.
    this._diagPaintCount++;
    if (this._diagEnabled) {
      const now = GLib.get_monotonic_time();
      const actorTitle = (() => {
        try {
          const a = this.get_actor() as any;
          return a?.get_meta_window?.()?.get_title?.() ?? a?.get_name?.() ?? '?';
        } catch (e) { return '?'; }
      })();
      if (!this._diagFirstPaintLogged) {
        this._diagFirstPaintLogged = true;
        this._diagLastPaintLogAt = now;
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: FIRST call for "${actorTitle}" ` +
          `(paintCount=${this._diagPaintCount}, shadersLoaded=${this._shadersLoaded})`);
      } else if (now - this._diagLastPaintLogAt > 2000 * 1000) {
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: heartbeat for "${actorTitle}", ` +
          `paintCount=${this._diagPaintCount}, compositedCount=${this._diagCompositedPaintCount}`);
        this._diagLastPaintLogAt = now;
      }
    }

    // ── Wait for async shaders ──────────────────────────────────────────────
    if (!this._shadersLoaded) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }
    // ── Deferred pipeline initialization ─────────────────────────────────────
    if (!this._pipelines.composite) {
      try {
        const ctx = this._getCoglContext();
        if (!ctx) throw new Error('Could not obtain a Cogl context');
        this._pipelines.initialize(ctx);
        this._uniforms.attach(this._pipelines.composite);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Pipeline initialization failed: ${e}`);
        // Fall back to OffscreenEffect's default drawing.
        super.vfunc_paint_target(_paintNode, paintContext);
        return;
      }
    }

    // ── Guard check ───────────────────────────────────────────────────────────
    // The Gaussian H/V pipelines don't exist until a radius has been set
    // (they're built dynamically), so they're intentionally excluded from
    // this required-pipeline check.
    if (!this._pipelines.composite || !this._pipelines.downsample || !this._pipelines.upsample) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    // ── Deferred compilation of the Gaussian shaders ─────────────────────────
    // Whenever setBlurRadius() changes the tap count, compile the new H/V
    // pipelines here, where a Cogl context is guaranteed to be available.
    // Old pipeline references are left for GJS's GC rather than disposed
    // manually.
    if (this._blur.needsCompile) {
      try {
        const ctx = this._getCoglContext();
        if (!ctx) throw new Error('Could not obtain a Cogl context');
        this._blur.compilePending(ctx);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to build Gaussian pipelines: ${e}`);
      }
    }

    // Repeat paints may reuse the first paint’s blur: source content is identical,
    // and deferred paint nodes execute in dependency order. Retry stage hookup if
    // the effect was created before global.stage became available.
    if (!frameSerialIsLive()) ensureFrameSerialHook();

    // Without a live counter every paint is treated as a first paint, which is
    // exactly the behavior from before this optimization existed. _blurFrame
    // Serial is deliberately left untouched in that case, so it cannot later
    // collide with a real serial once the hook does come up.
    const serialIsLive = frameSerialIsLive();
    const firstPaintThisFrame = !serialIsLive || this._blurFrameSerial !== frameSerial;
    if (serialIsLive) this._blurFrameSerial = frameSerial;

    // Grab the FBO texture OffscreenEffect captured from the actor.
    const srcTex = this.get_texture() as Cogl.Texture2D | null;
    if (!srcTex) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    const srcW = srcTex.get_width();
    const srcH = srcTex.get_height();

    // ── Trust the actor's logical size over get_texture()'s reported size ──
    // get_texture() can be a few pixels larger than the actor's logical size
    // due to internal FBO padding (see the crop-pass comment above), so
    // actor.get_size() is used as the source of truth from here on.
    const actor = this.get_actor();
    let allocW = srcW;
    let allocH = srcH;
    if (actor) {
      const [aw, ah] = actor.get_size();
      if (Number.isFinite(aw) && aw > 0) allocW = Math.round(aw);
      if (Number.isFinite(ah) && ah > 0) allocH = Math.round(ah);
    }

    // Offscreen textures include paint-box padding, not just allocation pixels.
    // computeCaptureLayout supplies the valid UV range and the matching draw rect.
    const effectiveW = allocW;
    const effectiveH = allocH;

    const layout = computeCaptureLayout(actor, srcW, srcH, effectiveW, effectiveH);
    const srcUV: number[] = layout.uv;

    // Publish the actor-local origin inside the padded capture. Nested background
    // blur resolves stage coordinates against this framebuffer, so the offset matters.
    try {
      (actor as any)._lgCaptureOffset = [layout.dest[0], layout.dest[1]];
    } catch (e) { /* diagnostic only */ }

    // ── [PERF] Blurred sub-rect ─────────────────────────────────────────────
    // See _computeBlurRect() and glass.frag's blur_rect_* uniforms. The rect
    // lives in the shader's coordinate space (resolution_x/y) while the
    // capture mapping below is in allocation space; they are the same space
    // for every current caller, but if they ever drift the rect is dropped
    // rather than trusted.
    const resW = this._uniforms.values.get('resolution_x') ?? 0;
    const resH = this._uniforms.values.get('resolution_y') ?? 0;
    const spacesAgree =
      Math.abs(resW - effectiveW) <= 1 && Math.abs(resH - effectiveH) <= 1;
    // With no blur running, layer 1 is the raw capture over the FULL actor,
    // so the shader must keep the identity mapping.
    const blurRect =
      (this._blur.passCount > 0 && spacesAgree) ? this._geometry.blurRect() : null;
    // NOTE: the blur_rect_* uniforms are NOT set here. They describe what
    // layer 1 actually holds, and layer 1 only holds the sub-rect if the blur
    // really ran — several paths below fall back to binding the raw capture.
    // They are set once that is known, just before _applyPendingUniforms().

    // The blur chain's own resolution, and the slice of the capture it reads.
    const blurW = blurRect ? blurRect[2] : effectiveW;
    const blurH = blurRect ? blurRect[3] : effectiveH;
    const blurSrcUV: number[] = blurRect
      ? [
        srcUV[0] + (blurRect[0] / effectiveW) * (srcUV[2] - srcUV[0]),
        srcUV[1] + (blurRect[1] / effectiveH) * (srcUV[3] - srcUV[1]),
        srcUV[0] + ((blurRect[0] + blurRect[2]) / effectiveW) * (srcUV[2] - srcUV[0]),
        srcUV[1] + ((blurRect[1] + blurRect[3]) / effectiveH) * (srcUV[3] - srcUV[1]),
      ]
      : srcUV;

    // [PERF] A repeat paint can reuse the blur only if the pool it was written
    // into is still the right one — a resize between paints destroys it.
    // The rect has to match too, not just the pool size: geometry can change
    // between two paints of the same frame, and the quantized size would
    // often survive a move that shifts the rect's ORIGIN. Reusing a blur
    // taken somewhere else would draw the wrong background.
    const a = this._blurRectUsed;
    const rectUnchanged = (a === null)
      ? (blurRect === null)
      : (blurRect !== null && a[0] === blurRect[0] && a[1] === blurRect[1] &&
        a[2] === blurRect[2] && a[3] === blurRect[3]);
    const reuseBlur = !firstPaintThisFrame &&
      this._blur.passCount > 0 &&
      this._blur.result !== null &&
      rectUnchanged &&
      this._blur.width === blurW &&
      this._blur.height === blurH;

    // [PERF] The crop runs only for a paint that is going to blur — the blur
    // is its only consumer now that both composite layers share one texture.
    // With a sub-rect in play it has nothing left to do: its whole job was to
    // hand the blur a padding-free 0..1 texture, and the blur is reading an
    // arbitrary sub-rect of the capture anyway. Cropping first would mean a
    // full-resolution copy of exactly the pixels we are trying not to touch.
    let effectiveTexOut: Cogl.Texture = srcTex;
    if (this._cropPassEnabled && !blurRect && !reuseBlur &&
      (srcW !== effectiveW || srcH !== effectiveH)) {
      try {
        const cropCtx = this._getCoglContext();
        if (cropCtx) {
          effectiveTexOut = this._crop.render(
            _paintNode, cropCtx, srcTex, srcW, srcH, effectiveW, effectiveH, layout.uv
          );
        }
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Crop pass node failed; continuing with the padded texture: ${e}`);
      }
    }

    // Both composite layers bind the same texture: glass.frag reads only sampler1.
    // One UV range is therefore correct for both; do not use the unsafe GI
    // add_multitexture_rectangle call to supply separate layer coordinates.
    const effectiveTex: Cogl.Texture = effectiveTexOut;
    // Whether the crop actually ran decides the range every later pass uses:
    // the cropped texture is padding-free (0..1), the raw capture is not.
    const inputUV: number[] = (effectiveTex === srcTex) ? srcUV : [0, 0, 1, 1];
    // What the blur's first pass reads. Identical to inputUV unless a
    // sub-rect is active, in which case the crop is off and this is the
    // rect's slice of the raw capture.
    const blurInputUV: number[] = blurRect ? blurSrcUV : inputUV;

    // ── Rebuild the texture pool when the resolution changes ────────────────
    // Based on the cropped ("true") resolution — using the padded size here
    // would cause rounding error from bit-shifting (w >> 1) an odd value to
    // accumulate across passes, misaligning the sharp and blurred layers.
    if (!reuseBlur && (blurW !== this._blur.width || blurH !== this._blur.height)) {
      try {
        const ctx = this._getCoglContext();
        if (!ctx) throw new Error('Could not obtain a Cogl context');
        this._crop.clear();
        this._blur.resize(ctx, blurW, blurH);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to rebuild the texture pool: ${e}`);
        super.vfunc_paint_target(_paintNode, paintContext);
        return;
      }
    }

    if (!this._blur.ready) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Blur pass: which blur method runs depends on _blurMethod
    //   0: Separable Gaussian blur
    //   1: Dual Kawase blur (original implementation)
    // Always takes the raw capture as input, sampled over srcUV.
    // ─────────────────────────────────────────────────────────────────────
    if (reuseBlur) {
      // _blurResultTex is left exactly as the frame's first paint set it.
      this._blurSkips++;
    } else {
      this._blurRectUsed = blurRect;
      if (this._blur.passCount > 0) this._blurRuns++;
      this._blur.render(_paintNode, effectiveTex, blurInputUV);
    }

    // The final quad is in capture-texel coordinates, not actor-local coordinates.
    // Use layout.dest so OffscreenEffect’s framebuffer offset is not applied twice.
    const compPipeline = this._pipelines.composite!;

    // With blur, both layers use the result and full UVs; without it they use the
    // capture and its valid sub-rectangle. Revisit this if glass.frag starts reading sampler0.
    const haveBlur = this._blur.passCount > 0 && this._blur.result !== null;

    // [PERF] Now that it is settled whether layer 1 is the blurred sub-rect
    // or the whole raw capture, tell the shader which it is. Zero means "the
    // whole actor", i.e. the identity mapping glass.frag used before the
    // sub-rect existed — so every fallback path above lands on the correct
    // sampling automatically.
    const activeRect = (haveBlur && blurRect) ? blurRect : null;
    this._blurRect = activeRect;
    this._uniforms.set('blur_rect_x', activeRect ? activeRect[0] : 0.0);
    this._uniforms.set('blur_rect_y', activeRect ? activeRect[1] : 0.0);
    this._uniforms.set('blur_rect_w', activeRect ? activeRect[2] : 0.0);
    this._uniforms.set('blur_rect_h', activeRect ? activeRect[3] : 0.0);
    // Layer 0 is never sampled by glass.frag, so it exists only to not
    // contradict layer 1's coordinate range. Bind whichever texture already
    // uses the range layer 1 needs.
    const layer0Tex = haveBlur ? this._blur.result! : effectiveTex;
    compPipeline.set_layer_texture(0, layer0Tex);
    configureSamplerLayer(compPipeline, 0);
    const layer0UV = haveBlur ? [0, 0, 1, 1] : inputUV;

    // Layer 1 is the one glass.frag actually samples: the blurred background,
    // or the raw capture when blur is disabled.
    // [FIX round 12] The finished blur no longer always lands in
    // _blurTextures[0]; whichever runner executed records its output here.
    compPipeline.set_layer_texture(1, layer0Tex);
    configureSamplerLayer(compPipeline, 1);

    // Manually sync pending uniforms into the composite pipeline.
    // Without this, values like dock_x would stay at 0 and the whole screen
    // would be misdetected as being inside the dock mask.
    this._uniforms.flush();

    // Use cascaded paint opacity and scale RGB as well as alpha. Scaling only alpha
    // breaks premultiplied blending and brightens glass during fade animations.
    const paintOpacity = actor ? actor.get_paint_opacity() : 255;
    const color = new Cogl.Color();
    const paintOpacity_f = paintOpacity / 255;
    color.init_from_4f(paintOpacity_f, paintOpacity_f, paintOpacity_f, paintOpacity_f);
    this._pipelines.composite!.set_color(color);

    // Nodes inherit the effect transform at execution time. Map the composite subrect
    // through layout.dest and UVs together; disable clipping if shader and allocation
    // coordinate spaces disagree, since even a subpixel mismatch visibly clips glass.
    const compRect = (resW === effectiveW && resH === effectiveH)
      ? this._geometry.compositeRect()
      : null;
    this._compositeRect = compRect;

    let drawRect = layout.dest;
    let drawUV = layer0UV;
    if (compRect) {
      const sx = (layout.dest[2] - layout.dest[0]) / effectiveW;
      const sy = (layout.dest[3] - layout.dest[1]) / effectiveH;
      drawRect = [
        layout.dest[0] + compRect[0] * sx,
        layout.dest[1] + compRect[1] * sy,
        layout.dest[0] + (compRect[0] + compRect[2]) * sx,
        layout.dest[1] + (compRect[1] + compRect[3]) * sy,
      ];
      const [u0, v0, u1, v1] = layer0UV;
      drawUV = [
        u0 + (compRect[0] / resW) * (u1 - u0),
        v0 + (compRect[1] / resH) * (v1 - v0),
        u0 + ((compRect[0] + compRect[2]) / resW) * (u1 - u0),
        v0 + ((compRect[1] + compRect[3]) / resH) * (v1 - v0),
      ];
    }

    this._passes.composite(_paintNode, this._pipelines.composite!, drawRect, drawUV, drawUV);

    this._diagCompositedPaintCount++;

    // A missing blur result means sampler1 falls back to the sharp capture.
    // Throttle snapshots to once a second unless full diagnostics are enabled.
    const diagNow = GLib.get_monotonic_time();
    if (this._diagEnabled || diagNow - this._diagLastSnapshotAt > 1000 * 1000) {
      this._diagLastSnapshotAt = diagNow;
      this._diagLast = {
        owner: this._owner,
        actor: (() => { try { return (this.get_actor() as any)?.get_name?.() ?? '?'; } catch (e) { return '?'; } })(),
        src: `${srcW}x${srcH}`,
        alloc: `${allocW}x${allocH}`,
        uv: layout.uv.map(v => +v.toFixed(5)),
        dest: layout.dest.map(v => +v.toFixed(2)),
        ...this._blur.describe(),
        paintOpacity,
        paints: this._diagPaintCount,
        // [PERF] How the paints split: blurRuns is the chains actually
        // executed, blurSkips the repeat paints that reused one. With nested
        // glass, blurSkips is where the saving is.
        cropRan: effectiveTex !== srcTex,
        blurRuns: this._blurRuns,
        blurSkips: this._blurSkips,
        // The uniforms that decide whether a drop shadow can appear at all.
        // Read straight out of the buffered state, which is by definition
        // what was last handed to the pipeline — so a value that looks wrong
        // here is a JS-side problem, and a value that looks right here with
        // no shadow on screen puts the fault in the shader or in what is
        // drawn over it.
        u: {
          shadowRadius: this._uniforms.values.get('shadow_radius'),
          shadowIntensity: this._uniforms.values.get('shadow_intensity'),
          shadowMaxRadius: this._uniforms.values.get('shadow_max_radius'),
          edgeSmoothing: this._uniforms.values.get('edge_smoothing'),
          cornerRadius: this._uniforms.values.get('corner_radius'),
          padding: this._uniforms.values.get('padding'),
          isDock: this._uniforms.values.get('isDock'),
          multiRegion: this._uniforms.values.get('multi_region_mode'),
          earlyExit: this._uniforms.values.get('early_exit_enabled'),
          dockRect: [
            this._uniforms.values.get('dock_x'),
            this._uniforms.values.get('dock_y'),
            this._uniforms.values.get('dock_w'),
            this._uniforms.values.get('dock_h'),
          ],
          blurRect: this._blurRect ? this._blurRect.slice() : null,
          captureClip: this._lgCaptureClip ? this._lgCaptureClip.slice() : null,
          compositeRect: this._compositeRect ? this._compositeRect.slice() : null,
          blurPool: [this._blur.width, this._blur.height, this._blur.downscale],
        },
      };
    }
  }

  /** Conservative capture extent, including refraction and blur reach. */
  getCaptureClipRect(): number[] | null {
    return this._geometry.captureClip(this._blur.radius);
  }

  /** Shader-space size of this glass, i.e. the resolution_x/y uniforms. */
  getResolution(): [number, number] {
    return [
      this._uniforms.values.get('resolution_x') ?? 0,
      this._uniforms.values.get('resolution_y') ?? 0,
    ];
  }

  // [DIAG] The capture clip rect syncGlassCaptureClip() applied last, purely
  // so global._lgGlass.dump() can show it. Written by capture/clip.ts.
  declare _lgCaptureClip: number[] | null;

  static USE_CROP_PASS = true;

  /**
   * [PERF] Requests a repaint only if something actually changed since the
   * last one. See _uniformsDirty for why this is safe.
   */
  private _queueRepaintIfDirty(): void {
    if (!this._uniforms.takeDirty()) return;
    this.queue_repaint();
  }

  // ─── Cogl context lookup ─────────────────────────────────────────────────────

  private _getCoglContext(): Cogl.Context | null {
    try {
      // Clutter.get_default_backend() is available from GJS.
      // On GNOME 50, get_cogl_context() returns a Cogl.Context.
      const backend = Clutter.get_default_backend();
      return backend.get_cogl_context() as Cogl.Context;
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to obtain the Cogl context: ${e}`);
      return null;
    }
  }

  // ─── Public API (compatible with the previous ShaderEffect-based interface) ──

  cleanup(): void {
    // The frame-serial hook is one signal shared by every instance; drop it
    // once nothing is left to use it, so disabling the extension leaves
    // nothing connected to the stage.
    unregisterGlassEffect(this);

    // Disconnect GSettings signal handlers.
    this._material.clear();

    this._blur.clear();
    this._crop.clear();
    this._passes.clear();
    this._pipelines.clear();
    this._uniforms.clear();
  }

  /**
   * [PERF/DEBUG] Turns glass.frag's two early exits on/off at runtime.
   *
   * They are meant to be exactly equivalent to the full per-pixel path, so
   * anything that looks different with them on is a bug in the thresholds.
   * Being able to flip this inside a running session — rather than
   * rebuilding and reproducing the state again — is what makes such a
   * report cheap to settle. Reachable as global._lgGlass.earlyExit(bool).
   */
  /**
   * [PERF/DEBUG] Turns the crop pass on/off at runtime; see USE_CROP_PASS.
   * Reachable as global._lgGlass.cropPass(bool).
   */
  setCropPassEnabled(enabled: boolean): void {
    this._cropPassEnabled = enabled;
    this.queue_repaint();
  }

  /**
   * [PERF/DEBUG] Turns the blurred sub-rect on/off at runtime; see
   * USE_BLUR_RECT. Off means the blur runs over the whole capture again,
   * which is what it did before that optimization existed.
   */
  setBlurRectEnabled(enabled: boolean): void {
    this._geometry.blurEnabled = enabled;
    // The pool is keyed on the blurred region's size, so it is stale now.
    this._blur.invalidate();
    this.queue_repaint();
  }

  /**
   * [PERF/DEBUG] Turns the composite sub-rect on/off at runtime; see
   * USE_COMPOSITE_RECT. Off means glass.frag runs over the whole capture
   * again, which is what it did before that optimization existed.
   */
  setCompositeRectEnabled(enabled: boolean): void {
    this._geometry.compositeEnabled = enabled;
    this.queue_repaint();
  }

  setEarlyExitEnabled(enabled: boolean): void {
    this._uniforms.set('early_exit_enabled', enabled ? 1.0 : 0.0);
    this._queueRepaintIfDirty();
  }

  /**
   * [DEBUG] Diagnostic visualisation mode; see glass.frag's debug_view.
   * 0 = normal, 1 = shadow/shape mask view. Reachable as
   * global._lgGlass.debugView(n).
   */
  setDebugView(mode: number): void {
    this._uniforms.set('debug_view', mode);
    this._queueRepaintIfDirty();
  }

  setIsDock(isDock: boolean): void {
    this._uniforms.set('isDock', isDock ? 1.0 : 0.0);
  }

  /**
   * Enables/disables the rim light + specular + sheen "glass surface
   * glint" terms as a group (see addedLight in glass.frag). The outer
   * drop shadow and inner AO edge-darkening are unaffected either way —
   * they're computed independently of this uniform. Used by
   * applicationManager.ts to give application windows a plainer
   * "shadow + AO only" edge instead of the dock/menu-style glass glint,
   * without touching the shared rim/specular/sheen settings that dock,
   * menu, notification, quick-settings and OSD still use.
   */
  setSurfaceLightEnabled(enabled: boolean): void {
    this._uniforms.set('surface_light_enabled', enabled ? 1.0 : 0.0);
    this._queueRepaintIfDirty();
  }

  setPadding(pad: number): void {
    this._uniforms.set('padding', pad);
  }

  /**
   * Tells the shader how much room (in px) the drop shadow actually
   * has to render outward, independent of the small optical `padding`
   * uniform. Should be kept in sync with dockManager's CLIP_PADDING (minus
   * a small safety margin) so shadow_radius can use its full prefs.js
   * range (0-100) without being invisibly clamped or hitting a hard edge
   * at the bgActor's own clip boundary.
   */
  setShadowMaxRadius(radius: number): void {
    this._uniforms.set('shadow_max_radius', radius);
  }

  /**
   * [DEBUG] Forces glass.frag (and the downsample/upsample shaders) to be
   * re-read from disk and recompiled into fresh Cogl.Pipelines on the next
   * paint.
   *
   * Why this exists: _initPipelines() only ever runs once per LiquidEffect
   * instance, guarded by `if (!this._pipelines.composite)` in
   * vfunc_paint_target(). The instance itself only gets recreated when
   * dockManager tears down and rebuilds the effect (extension disable/
   * re-enable, or the dock actor being destroyed). So editing glass.frag on
   * disk while the shell keeps running has NO effect on what's on screen
   * until one of those happens — the exact same (possibly still-buggy)
   * compiled shader keeps executing every frame regardless of what the
   * source file now says. This silently made prior shader fixes look like
   * they hadn't worked. Call this after saving shader edits to pick them up
   * immediately instead.
   */
  setBlurMethod(method: BlurMethod): void { this._blur.setBlurMethod(method); }
  setBlurRadius(radius: number): void { this._blur.setBlurRadius(radius); }

  reloadShaders(): void {
    this._pipelines.clear();
    this._uniforms.attach(null);
    this._blur.reload();
    this.queue_repaint();
  }

  setTintColor(r: number, g: number, b: number): void {
    this._uniforms.set('tint_r', r);
    this._uniforms.set('tint_g', g);
    this._uniforms.set('tint_b', b);
    this._queueRepaintIfDirty();
  }

  // Sets the flat fallback fill composited underneath the glass/shadow
  // result, for areas outside every glass region — see glass.frag's
  // panel_bg_* uniforms for the full rationale. Pass alpha = 0 (the
  // default) to disable it entirely.
  setPanelBackgroundColor(r: number, g: number, b: number, a: number): void {
    this._uniforms.set('panel_bg_r', r);
    this._uniforms.set('panel_bg_g', g);
    this._uniforms.set('panel_bg_b', b);
    this._uniforms.set('panel_bg_a', a);
    this._queueRepaintIfDirty();
  }

  // [FIX] The panel's REAL widget bounds (monitor-relative px, no
  // SHADER_PADDING/CLIP_PADDING/glassExpand) — masks
  // setPanelBackgroundColor()'s fallback fill to this rect in glass.frag so
  // it can't bleed into the sampling-headroom margin around bgActor. See
  // the panel_rect_* uniform comments in glass.frag for the full
  // rationale. Harmless to call regardless of panel_bg_a.
  setPanelRect(x: number, y: number, w: number, h: number): void {
    this._uniforms.set('panel_rect_x', x);
    this._uniforms.set('panel_rect_y', y);
    this._uniforms.set('panel_rect_w', w);
    this._uniforms.set('panel_rect_h', h);
    this._queueRepaintIfDirty();
  }

  setTintStrength(strength: number): void {
    this._uniforms.set('tint_strength', strength);
    this._queueRepaintIfDirty();
  }

  setCornerRadius(radius: number): void {
    this._uniforms.set('corner_radius', radius);
    this._queueRepaintIfDirty();
  }

  setAnimationScale(scale: number): void {
    if (this._material.setAnimationScale(scale)) this._queueRepaintIfDirty();
  }

  setPointerPosition(x: number, y: number, intensity: number): void {
    this._uniforms.set('pointer_x', x);
    this._uniforms.set('pointer_y', y);
    this._uniforms.set('intensity', intensity);
  }

  /**
   * Syncs the actor's logical size to the shader's resolution uniform.
   *
   * The texture pool itself is rebuilt automatically inside
   * vfunc_paint_target based on get_texture()'s size, so no extra work is
   * needed here.
   */
  setResolution(width: number, height: number): void {
    this._uniforms.set('resolution_x', width);
    this._uniforms.set('resolution_y', height);
    this._queueRepaintIfDirty();
  }

  /**
   * Full-screen FBO mode: passes the dock's monitor-relative geometry to the
   * shader (see the dock_x/y/w/h comments in glass.frag for details).
   */
  setGlassGeometry(x: number, y: number, w: number, h: number): void {
    this._uniforms.set('dock_x', x);
    this._uniforms.set('dock_y', y);
    this._uniforms.set('dock_w', w);
    this._uniforms.set('dock_h', h);
    // [PERF] Mirrored for _computeBlurRect(); reading it back out of
    // _pendingUniforms every paint would work too, but four Map lookups per
    // paint per surface is exactly the kind of cost that section removes.
    this._geometry.rect[0] = x;
    this._geometry.rect[1] = y;
    this._geometry.rect[2] = w;
    this._geometry.rect[3] = h;
    this._queueRepaintIfDirty();
  }

  /**
   * Enables/disables multi-region compositing mode (see glass.frag's
   * multi_region_mode uniform). When enabled, setGlassRegions() draws up to
   * MAX_GLASS_REGIONS independent small rounded-rect "windows" instead of
   * the single dock_x/y/w/h rect. Used by Quick Settings' "Toggles"
   * apply-to mode; every other consumer leaves this at its default (false)
   * and is completely unaffected.
   */
  setMultiRegionMode(enabled: boolean): void {
    this._uniforms.set('multi_region_mode', enabled ? 1.0 : 0.0);
    this._geometry.multiRegion = enabled;
    this._queueRepaintIfDirty();
  }

  // [PERF] "Window background rendering gets noticeably more expensive
  // (CLUTTER_SHOW_FPS: per-frame paint time roughly triples, ~1.8ms ->
  // ~5-6ms, though FPS itself stays near 60) the moment a window is open,
  // and moving it is the worst case." Single master switch for every
  // drag-time cost-reduction change below — false keeps current behavior
  // byte-for-byte; only flip to true to test the combined effect. Flip
  // this one line, nothing else, to compare.
  static DRAG_PERF_MODE_ENABLED = true;

  // Coalesce parameter changes within a manager’s frame update into one repaint.
  // Without batching, each setter can invalidate OffscreenEffect’s cached capture.
  private declare _batchDepth: number;
  private declare _batchDirty: boolean;

  beginBatch(): void {
    if (!LiquidEffect.DRAG_PERF_MODE_ENABLED) return;
    this._batchDepth = (this._batchDepth || 0) + 1;
  }

  endBatch(): void {
    if (!LiquidEffect.DRAG_PERF_MODE_ENABLED) return;
    if (!this._batchDepth) return; // beginBatch() was never called, or the flag flipped mid-batch
    this._batchDepth--;
    if (this._batchDepth === 0 && this._batchDirty) {
      this._batchDirty = false;
      // @ts-ignore — calling the inherited Clutter.Effect implementation
      // directly, bypassing our own override below.
      Clutter.Effect.prototype.queue_repaint.call(this);
    }
  }

  // Overrides (does not shadow via vfunc_, so this is a plain JS-level
  // method override — GJS resolves method lookups the normal JS-prototype
  // way, so every one of this file's existing `this.queue_repaint()` call
  // sites transparently goes through here without needing to change any
  // of them individually) the inherited Clutter.Effect.queue_repaint().
  queue_repaint(): void {
    if (LiquidEffect.DRAG_PERF_MODE_ENABLED && this._batchDepth) {
      this._batchDirty = true;
      return;
    }
    // @ts-ignore
    super.queue_repaint();
  }

  /**
   * Supplies the list of glass regions to draw when multi-region mode is
   * enabled. Each region is a small rounded rect (monitor-relative pixel
   * coordinates, same space as setGlassGeometry()/setResolution()) carrying
   * its own BASE color — the color the underlying element actually paints
   * itself — plus how strongly that base color should be applied. Silently
   * truncated to LiquidEffect.MAX_GLASS_REGIONS (must match glass.frag's
   * MAX_GLASS_REGIONS #define) if more are supplied.
   *
   * [FIX-8] `tintR/G/B` used to arrive pre-blended with the user's configured
   * tint color, leaving the shader's single `tint_strength` to scale the
   * element's own color and the user's tint together. They are separate
   * layers now: the base color/strength here, and setTintColor()/
   * setTintStrength() for the custom tint on top. `baseStrength` 0 means
   * "this region has no usable base color", which is how a region whose real
   * color could not be sampled opts out.
   */
  setGlassRegions(regions: {
    x: number; y: number; w: number; h: number;
    tintR: number; tintG: number; tintB: number;
    baseStrength?: number;
  }[]): void {
    const clamped = regions.slice(0, LiquidEffect.MAX_GLASS_REGIONS);

    const rx = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const ry = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const rw = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const rh = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const rTintR = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
    const rTintG = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
    const rTintB = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
    const rBaseStrength = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);

    clamped.forEach((region, i) => {
      rx[i] = region.x;
      ry[i] = region.y;
      rw[i] = region.w;
      rh[i] = region.h;
      rTintR[i] = region.tintR;
      rTintG[i] = region.tintG;
      rTintB[i] = region.tintB;
      rBaseStrength[i] = Math.max(0.0, Math.min(1.0, region.baseStrength ?? 0.0));
    });

    // [PERF] Mirrored for _computeBlurRect() — see setGlassGeometry().
    this._geometry.regions = clamped.map(r => [r.x, r.y, r.w, r.h]);

    this._uniforms.set('region_count', clamped.length);
    this._uniforms.setArray('region_x', rx);
    this._uniforms.setArray('region_y', ry);
    this._uniforms.setArray('region_w', rw);
    this._uniforms.setArray('region_h', rh);
    this._uniforms.setArray('region_tint_r', rTintR);
    this._uniforms.setArray('region_tint_g', rTintG);
    this._uniforms.setArray('region_tint_b', rTintB);
    this._uniforms.setArray('region_base_strength', rBaseStrength);
    this._queueRepaintIfDirty();
  }

  setBrightness(brightness: number): void {
    this._uniforms.set('brightness', brightness);
    this._queueRepaintIfDirty();
  }

  setContrast(contrast: number): void {
    this._uniforms.set('contrast', contrast);
    this._queueRepaintIfDirty();
  }

  setSaturation(saturation: number): void {
    this._uniforms.set('saturation', saturation);
    this._queueRepaintIfDirty();
  }
});

export type LiquidEffect = InstanceType<typeof LiquidEffect>;
