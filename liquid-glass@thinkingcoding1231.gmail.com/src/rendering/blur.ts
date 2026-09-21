import Cogl from 'gi://Cogl';
import type { Logger } from '../logger.js';
import { ShaderPipelines, configureSamplerLayer } from './pipelines.js';
import { RenderPasses, setPipelineFloat, setPipelineVec2 } from './passes.js';
import { computeGaussianKernel, buildGaussianSnippet, type GaussianKernel } from './shaderSource.js';

export type BlurMethod = 0 | 1;
type CoglFB = Cogl.Framebuffer;

/** Owns blur configuration, shader recompilation and the acyclic texture pool. */
export class BlurRenderer {
  constructor(
    private _pipelines: ShaderPipelines, private _passes: RenderPasses,
    private _repaint: () => void, private _logger?: Logger,
  ) {}

  get radius(): number { return this._targetRadius; }
  get downscale(): number { return this._blurDownscale; }
  get passCount(): number { return this.PASS_COUNT; }
  get result(): Cogl.Texture | null { return this._blurResultTex; }
  get width(): number { return this._poolWidth; }
  get height(): number { return this._poolHeight; }
  get ready(): boolean { return this.PASS_COUNT === 0 || this._blurFbos.length > 0; }
  get needsCompile(): boolean { return this._gaussianPipelineDirty && this._pendingGaussianKernel !== null; }

  invalidate(): void { this._destroyTexturePool(); }

  compilePending(ctx: Cogl.Context): void {
    if (!this.needsCompile) return;
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._compileGaussianPipelines(ctx, this._pendingGaussianKernel!);
  }

  render(parent: any, source: Cogl.Texture, uv: number[]): void {
    this._blurResultTex = null;
    if (this.PASS_COUNT <= 0) return;
    if (this._blurMethod === 0) {
      if (this._gaussianHPipeline && this._gaussianVPipeline) this._runGaussianBlur(parent, source, uv);
    } else this._runDualKawaseBlur(parent, source, uv);
  }

  setDownscale(factor: number): void {
    if (factor === this._blurDownscale) return;
    this._blurDownscale = factor;
    this._destroyTexturePool();
    this.setBlurRadius(this._targetRadius);
    this._repaint();
  }

  reload(): void {
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._gaussianKernel = null;
    this._gaussianFetchPairs = 0;
    this.setBlurRadius(this._targetRadius);
  }

  clear(): void {
    this._destroyTexturePool();
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._gaussianKernel = null;
    this._pendingGaussianKernel = null;
    this._gaussianPipelineDirty = false;
    this._gaussianBaseSigma = 0;
    this._gaussianScale = 1;
    this._gaussianFetchPairs = 0;
  }

  describe() {
    const result = this._blurResultTex;
    return {
      blurMethod: this._blurMethod, passCount: this.PASS_COUNT,
      pool: this._poolWidth + 'x' + this._poolHeight, poolLevels: this._blurFbos.length,
      blurResult: result ? result.get_width() + 'x' + result.get_height() : 'NULL (layer 1 falls back to the SHARP capture)',
      radiusDown: this._blurRadiusDown, radiusUp: this._blurRadiusUp, targetRadius: this._targetRadius,
      gaussianPipelines: !!(this._gaussianHPipeline && this._gaussianVPipeline),
    };
  }


  // ── Blur texture pool ──
  // Index 0 = w/2 × h/2 (first half-res level)
  // Index N = w/(2^(N+1)) × h/(2^(N+1))
  private _blurTextures: Cogl.Texture2D[] = [];

  private _blurFbos: Cogl.Offscreen[] = [];


  // ── Intermediate buffers for the Gaussian blur ──
  // Holds the output of the horizontal pass (same resolution as _blurTextures
  // at the corresponding index).
  private _gaussianTempTextures: Cogl.Texture2D[] = [];

  private _gaussianTempFbos: Cogl.Offscreen[] = [];


  // [FIX round 12] Dedicated output targets, one per pool level, so no pass
  // ever writes into a framebuffer that an earlier pass read from.
  //
  // Immediate-mode drawing let the passes ping-pong freely: each pass ran and
  // flushed on the spot, so reusing _blurFbos[i] as both a downsample target
  // and an upsample target was harmless. Deferred paint nodes make Cogl build
  // a real dependency graph between framebuffers, and that ping-pong is a
  // CYCLE in it (_blurFbos[0] reads the Gaussian temp buffer while the temp
  // buffer reads _blurFbos[0]; adjacent Kawase levels do the same). Cogl
  // detects the cycle, refuses the dependency
  // ("_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed")
  // and the passes lose their ordering, so the composite samples an
  // never-written blur texture — which is exactly the flat tint with no
  // background in it, while the rim lighting (which does not read the blur
  // layer) kept working.
  //
  // Writing upsample/vertical output into separate targets makes the pass
  // graph a strict DAG. Costs one extra half-resolution texture per level.
  private _upTextures: Cogl.Texture2D[] = [];

  private _upFbos: Cogl.Offscreen[] = [];


  // The texture holding the finished blur for this frame; set by whichever
  // blur runner executed, read by the composite.
  private _blurResultTex: Cogl.Texture | null = null;

  // Separable Gaussian
  private _gaussianHPipeline: Cogl.Pipeline | null = null;
 // horizontal pass
  private _gaussianVPipeline: Cogl.Pipeline | null = null;


  // ── Active blur method (0: Gaussian, 1: Dual Kawase) ──
  private _blurMethod: BlurMethod = 1;


  // ── State for dynamic Gaussian shader generation ──
  // The kernel currently compiled into the H/V pipelines (its tap count
  // determines the shader's structure).
  private _gaussianKernel: GaussianKernel | null = null;

  // A kernel waiting to be compiled; picked up safely inside vfunc_paint_target.
  private _pendingGaussianKernel: GaussianKernel | null = null;

  // While true, the Gaussian H/V pipelines will be recompiled on the next paint.
  private _gaussianPipelineDirty: boolean = false;

  // The sigma (in half-res texels) that the currently compiled kernel targets.
  // Small changes in radius that don't change the tap count are absorbed via
  // the kernel_scale ratio below instead of triggering a recompile.
  private _gaussianBaseSigma: number = 0;

  // kernel_scale uniform sent to the shader (= current sigma / _gaussianBaseSigma).
  private _gaussianScale: number = 1.0;

  // Number of fetch pairs in the currently compiled (or pending) kernel.
  private _gaussianFetchPairs: number = 0;


  private _poolWidth: number = 0;

  private _poolHeight: number = 0;

  // glass-blur-downscale: 2 = half resolution (default), 4 = quarter.
  private _blurDownscale: number = 2;


  // Number of blur passes. Each direction runs PASS_COUNT passes.
  // With 4: 1/2 → 1/4 → 1/8 → 1/16 → (turnaround) → 1/8 → 1/4 → 1/2
  private PASS_COUNT: number = 4;


  // Blur radius, forwarded to the down/upsample shaders' blur_radius uniform.
  // Any real number >= 0.5; larger values produce a stronger blur.
  // Default for downsample is 0.5 (the original Kawase value), default for
  // upsample is 1.0 (the original tent-filter value).
  private _blurRadiusDown: number = 0.5;

  private _blurRadiusUp: number = 1.0;


  // The last radius requested by the caller (before method-specific mapping).
  private _targetRadius: number = 15.0;


  /**
   * Compiles the H/V pipelines from a dynamically generated GaussianKernel.
   * The caller is responsible for having already dropped any previous
   * pipeline reference (we never call run_dispose(), see _destroyTexturePool).
   */
  private _compileGaussianPipelines(ctx: Cogl.Context, kernel: GaussianKernel): void {
    this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this._gaussianHPipeline, 0);
    const hSnippet = buildGaussianSnippet(kernel, 'h');
    const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, hSnippet.decl, null);
    hSnip.set_replace(hSnippet.body);
    this._gaussianHPipeline.add_snippet(hSnip);

    this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this._gaussianVPipeline, 0);
    const vSnippet = buildGaussianSnippet(kernel, 'v');
    const vSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, vSnippet.decl, null);
    vSnip.set_replace(vSnippet.body);
    this._gaussianVPipeline.add_snippet(vSnip);

    this._gaussianKernel = kernel;
    this._gaussianPipelineDirty = false;
    this._pendingGaussianKernel = null;
  }


  // ─── Texture pool management ─────────────────────────────────────────────────

  /**
   * Allocates the blur texture + FBO pairs for resolution (w, h).
   *
   * Index-to-resolution mapping (with glass-blur-downscale at its default 2):
   *   [0]: w>>1 × h>>1  (= w/2)
   *   [1]: w>>2 × h>>2  (= w/4)
   *   ...
   *   [PASS_COUNT-1]: w >> PASS_COUNT
   *
   * [PERF] glass-blur-downscale = 4 shifts the whole ladder down one more
   * step, so level 0 is w/4 × h/4 — a quarter of the fill and a quarter of
   * the texture memory of the default, at the cost of a visibly coarser
   * blur. See _setGaussianBlurRadius(), which converts the radius into the
   * matching texel space, and _runGaussianBlur()'s pre-pass, which switches
   * filter to keep a 4x downsample from aliasing.
   */
  resize(ctx: Cogl.Context, w: number, h: number): void {
    this._destroyTexturePool();

    const shift = this._blurDownscale >= 4 ? 2 : 1;
    let pw = Math.max(w >> shift, 1);
    let ph = Math.max(h >> shift, 1);

    for (let i = 0; i < this.PASS_COUNT; i++) {
      try {
        // Main buffer, shared by Dual Kawase and Gaussian.
        const tex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
        const fbo = Cogl.Offscreen.new_with_texture(tex);
        this._blurTextures.push(tex);
        this._blurFbos.push(fbo);

        // Intermediate buffer for the Gaussian horizontal pass (same resolution).
        const tmpTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
        const tmpFbo = Cogl.Offscreen.new_with_texture(tmpTex);
        this._gaussianTempTextures.push(tmpTex);
        this._gaussianTempFbos.push(tmpFbo);

        // [FIX round 12] Output target for this level (see _upTextures).
        const upTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
        const upFbo = Cogl.Offscreen.new_with_texture(upTex);
        this._upTextures.push(upTex);
        this._upFbos.push(upFbo);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to build texture pool at pass ${i} (${pw}x${ph}): ${e}`);
        this._destroyTexturePool();
        return;
      }

      pw = Math.max(pw >> 1, 1);
      ph = Math.max(ph >> 1, 1);
    }

    this._poolWidth = w;
    this._poolHeight = h;
  }


  /**
   * Runs the Dual Kawase blur.
   *
   *   Downsample phase: srcTex → [0] → [1] → ... → [PASS_COUNT-1]
   *   Upsample phase:   [PASS_COUNT-1] → ... → [0]
   *
   * The result ends up in _blurTextures[0].
   */
  private _runDualKawaseBlur(parentNode: any, srcTex: Cogl.Texture, srcUV: number[]): void {
    let currentSrc: Cogl.Texture = srcTex;

    // ── Downsample phase ────────────────────────────────────────────────────
    for (let i = 0; i < this.PASS_COUNT; i++) {
      const destFbo = this._blurFbos[i] as unknown as CoglFB;
      const destTex = this._blurTextures[i];
      const destW = destTex.get_width();
      const destH = destTex.get_height();

      const invW = 1.0 / currentSrc.get_width();
      const invH = 1.0 / currentSrc.get_height();

      // [FIX] Only the FIRST pass reads the raw capture, which may carry
      // padding; it samples just the valid sub-rect via srcUV. Every later
      // pass reads one of our own pool textures, which contain the
      // padding-free region already and so use the full 0..1 range.
      // inv_size stays 1/textureSize either way — it is a texel step in
      // texture space, unaffected by which sub-rect we sample.
      const uv = (i === 0) ? srcUV : [0, 0, 1, 1];

      // [PERF] glass-blur-downscale = 4 makes the FIRST pass a 4x reduction
      // rather than 2x, and Kawase's kernel is not a 4x minification filter —
      // at the smallest radius _blurRadiusDown is 0.0, which collapses all
      // five taps onto one texel. The box filter is used for that one pass
      // instead; the remaining passes still give the blur its character.
      const boxFirst = i === 0 && this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
      const pipeline = boxFirst
        ? this._passes.pipeline('kawase-down-0-box', this._pipelines.boxDown!)
        : this._passes.pipeline(`kawase-down-${i}`, this._pipelines.downsample!);
      pipeline.set_layer_texture(0, currentSrc);
      setPipelineVec2(pipeline, 'inv_size', invW, invH);
      if (!boxFirst)
        setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusDown);

      this._passes.add(parentNode, destFbo, pipeline, destW, destH, uv);

      currentSrc = destTex;
    }

    // ── Upsample phase ──────────────────────────────────────────────────────
    // [FIX round 12] Reads the downsample chain but writes into the separate
    // _up* targets, so no framebuffer is ever both an input to one pass and
    // the output of a later one. That mutual dependency is what Cogl's cycle
    // check rejected once the passes became deferred nodes.
    if (this.PASS_COUNT <= 1) {
      this._blurResultTex = this._blurTextures[0];
      return;
    }

    for (let i = this.PASS_COUNT - 1; i > 0; i--) {
      // First step reads the deepest downsample level; later steps read the
      // previous upsample output.
      const srcTexture = (i === this.PASS_COUNT - 1)
        ? this._blurTextures[i]
        : this._upTextures[i];
      const destFbo = this._upFbos[i - 1] as unknown as CoglFB;
      const destTex = this._upTextures[i - 1];
      const destW = destTex.get_width();
      const destH = destTex.get_height();

      const invW = 1.0 / srcTexture.get_width();
      const invH = 1.0 / srcTexture.get_height();

      const pipeline = this._passes.pipeline(`kawase-up-${i}`, this._pipelines.upsample!);
      pipeline.set_layer_texture(0, srcTexture);
      setPipelineVec2(pipeline, 'inv_size', invW, invH);
      setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusUp);

      this._passes.add(parentNode, destFbo, pipeline, destW, destH, [0, 0, 1, 1]);
    }

    this._blurResultTex = this._upTextures[0];
  }


  /**
   * Runs the separable Gaussian blur.
   *
   * PASS_COUNT is always fixed to 1 for this method, and the texture pool
   * only uses a single w/2 × h/2 level (no pool rebuild / pass-count change
   * happens when the radius changes).
   *
   *   srcTex → [gaussianTemp[0]] (horizontal pass) → [blurTextures[0]] (vertical pass)
   *
   * The H/V pipelines are the ones dynamically built from the kernel
   * computed in setBlurRadius() (fully unrolled). Result ends up in
   * _blurTextures[0].
   */
  private _runGaussianBlur(parentNode: any, srcTex: Cogl.Texture, srcUV: number[]): void {
    const tempFbo = this._gaussianTempFbos[0] as unknown as CoglFB;
    const tempTex = this._gaussianTempTextures[0];
    const destFbo = this._blurFbos[0] as unknown as CoglFB;
    const destTex = this._blurTextures[0];
    const destW = destTex.get_width();
    const destH = destTex.get_height();

    // ── 0. Pre-pass: srcTex (full res) → destTex (half res) ─────────────────
    // A plain bilinear downsample so the H/V passes can operate entirely in
    // half-resolution space.
    // [PERF] Uses the snippet-less passthrough pipeline rather than
    // downsample.frag with blur_radius = 0. Identical output (the collapsed
    // kernel averaged four fetches of the same texel), one fetch instead of
    // five. No inv_size / blur_radius to set — the pipeline has no uniforms.
    // [PERF] At the default downscale of 2 a single bilinear fetch already
    // averages the 2x2 source footprint exactly, so the passthrough is both
    // cheapest and correct. At 4 it would point-sample one texel in sixteen,
    // so the exact 4x4 box filter is used instead — see _boxDownPipeline.
    const wideDownsample = this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
    const prePipeline = wideDownsample
      ? this._passes.pipeline('gauss-pre-box', this._pipelines.boxDown!)
      : this._passes.pipeline('gauss-pre', this._pipelines.passthrough!);
    prePipeline.set_layer_texture(0, srcTex);
    if (wideDownsample) {
      // inv_size is a texel step in the SOURCE texture, so it uses the
      // capture's own size regardless of which sub-rect we sample.
      setPipelineVec2(prePipeline, 'inv_size',
        1.0 / srcTex.get_width(), 1.0 / srcTex.get_height());
    }

    // [FIX] Sample only the valid sub-rect of the raw capture (see the
    // matching comment in _runDualKawaseBlur). The H/V passes below read
    // our own pool textures and keep the full 0..1 range.
    this._passes.add(parentNode, destFbo, prePipeline, destW, destH, srcUV);

    // ── 1. Horizontal pass: destTex (half res) → tempTex (half res) ─────────
    // Input is already half-resolution, so inv_size uses destW/destH directly.
    const hPipeline = this._passes.pipeline('gauss-h', this._gaussianHPipeline!);
    hPipeline.set_layer_texture(0, destTex);
    setPipelineVec2(hPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
    setPipelineFloat(hPipeline, 'kernel_scale', this._gaussianScale);

    this._passes.add(parentNode, tempFbo, hPipeline, destW, destH, [0, 0, 1, 1]);

    // ── 2. Vertical pass: tempTex (half res) → destTex (half res) ───────────
    // [FIX round 12] Writes into the separate output target rather than back
    // into destFbo. Going back would make destFbo depend on tempFbo while
    // tempFbo already depends on destFbo (the horizontal pass read destTex) —
    // the exact cycle Cogl rejects now that these passes are deferred nodes.
    const vPipeline = this._passes.pipeline('gauss-v', this._gaussianVPipeline!);
    vPipeline.set_layer_texture(0, tempTex);
    setPipelineVec2(vPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
    setPipelineFloat(vPipeline, 'kernel_scale', this._gaussianScale);

    const outFbo = this._upFbos[0] as unknown as CoglFB;
    this._passes.add(parentNode, outFbo, vPipeline, destW, destH, [0, 0, 1, 1]);

    this._blurResultTex = this._upTextures[0];
  }


  /**
   * Drops the texture pool and resets the related fields.
   *
   * We never call run_dispose() on these GJS-managed Cogl objects: GJS's own
   * garbage collector would later try to unref them again, causing a double
   * free ("free(): invalid size" → SIGABRT). Simply clearing the references
   * lets the GC reclaim the VRAM safely.
   */
  private _destroyTexturePool(): void {
    this._blurFbos = [];
    this._blurTextures = [];
    this._gaussianTempFbos = [];
    this._gaussianTempTextures = [];
    this._upFbos = [];
    this._upTextures = [];
    this._blurResultTex = null;
    this._poolWidth = 0;
    this._poolHeight = 0;
  }


  /**
   * Dynamically switches the blur method.
   *
   * @param method 0: separable Gaussian blur, 1: Dual Kawase blur
   *
   * The Dual Kawase pipelines are already compiled in _initPipelines on the
   * first frame. The Gaussian pipelines are built dynamically: setBlurRadius()
   * computes the kernel for the current radius, and it's lazily compiled on
   * the next vfunc_paint_target only if needed.
   * The texture pool is shared between both methods (see _buildTexturePool),
   * so no manual rebuild is required when switching — queue_repaint() alone
   * is enough for the new method to take effect on the next frame.
   */
  setBlurMethod(method: BlurMethod): void {
    if (this._blurMethod === method) return;
    this._blurMethod = method;
    this.setBlurRadius(this._targetRadius);
    this._repaint();
  }


  /**
   * Dynamically sets the blur radius. The calculation branches depending on
   * the active method (Gaussian / Dual Kawase).
   */
  setBlurRadius(radius: number): void {
    this._targetRadius = radius;

    if (this._blurMethod === 0) {
      this._setGaussianBlurRadius(radius);
      return;
    }

    this._setDualKawaseBlurRadius(radius);
  }


  /**
   * Radius setter for the separable Gaussian blur (dynamic shader generation).
   *
   * Basic approach:
   *   - PASS_COUNT is always fixed to 1. The texture pool only uses a single
   *     w/2 × h/2 level, so changing the radius never triggers a pool
   *     rebuild (avoids visible stutter).
   *   - The number of fetch pairs (tap count) is derived from the radius
   *     (= sigma, in original-resolution pixels). As long as the fetch count
   *     doesn't change, the existing compiled shader is reused as-is and only
   *     the kernel_scale uniform is updated (skips an unnecessary recompile).
   *
   * Derivation:
   *   1. Compute the effective standard deviation sigma in half-resolution
   *      space: sigma = radius / RES_SCALE (RES_SCALE = 2.0; at half
   *      resolution, 1 texel = 2 original pixels).
   *   2. Clamp to a maximum radius of 30px (15 texels in half-res space).
   *   3. Determine how many one-sided taps are needed for the Gaussian
   *      weights to decay close enough to zero (the "3 sigma" rule), then
   *      convert that into a fetch-pair count (2 taps merged per fetch).
   *   4. If the fetch-pair count matches the previous one, skip regenerating
   *      the shader string and recompiling the pipeline — just update
   *      kernel_scale = sigma / base sigma.
   *      If it changed, stage a new kernel in _pendingGaussianKernel to be
   *      compiled safely on the next vfunc_paint_target.
   */
  private _setGaussianBlurRadius(radius: number): void {
    // [PERF] glass-blur-downscale: 2 (half res, 1 texel = 2 original px) or
    // 4 (quarter res, 1 texel = 4). The radius the user asks for is in
    // original pixels either way, so the conversion is the only thing that
    // changes — and because MAX_SIGMA_TEXEL is a texel cap, quarter
    // resolution also raises the largest reachable blur from 30px to 60px.
    const RES_SCALE = this._blurDownscale >= 4 ? 4.0 : 2.0;
    const MAX_SIGMA_TEXEL = 15.0; // texel cap: 30px at half res, 60px at quarter

    // ── Minimum sigma guarantee ────────────────────────────────────────────
    // Downsampling to half resolution (bilinear 2x) is effectively a 2px-wide
    // box filter, which aliases high-frequency content such as text. To
    // counteract that aliasing, the H/V kernel's effective width needs to
    // exceed 1.0 half-res texel (= 2 original pixels).
    // So sigma is floored at MIN_SIGMA_TEXEL = 1.0, guaranteeing at least a
    // minimal amount of smoothing even for a very small requested radius.
    // For small radii, kernel_scale ends up < 1.0, pulling the taps toward
    // the center — functioning simply as a "weaker blur" (the anti-aliasing
    // effect is preserved).
    const MIN_SIGMA_TEXEL = 1.0;

    if (radius <= 0) {
      if (this.PASS_COUNT !== 0) {
        this.PASS_COUNT = 0;
        this._destroyTexturePool();
      }
      this._gaussianScale = 0.0;
      this._repaint();
      return;
    }

    const sigmaTexel = Math.min(radius / RES_SCALE, MAX_SIGMA_TEXEL);

    // Use a sigma floored at MIN_SIGMA_TEXEL to decide the kernel shape
    // (fetch-pair count), so a wide-enough kernel gets compiled even for
    // small radii.
    const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);

    // Number of one-sided taps needed to satisfy the 4-sigma rule (changed from 3
    // to prevent abrupt truncation ringing/grid artifacts at integer multiples),
    // converted to fetch pairs (2 taps per fetch). At least 2 pairs (5-tap equivalent)
    // are guaranteed so bilinear-downsample aliasing is reliably absorbed.
    const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
    const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));

    const needsRecompile =
      this._gaussianFetchPairs !== fetchPairs ||
      (!this._gaussianKernel && !this._pendingGaussianKernel);

    if (needsRecompile) {
      const kernel = computeGaussianKernel(kernelSigma, fetchPairs);
      this._pendingGaussianKernel = kernel;
      this._gaussianPipelineDirty = true;
      this._gaussianFetchPairs = fetchPairs;
      this._gaussianBaseSigma = kernelSigma;
      // kernel_scale = actual sigma / sigma at compile time.
      // When sigmaTexel < kernelSigma, scale < 1.0, giving a weaker blur.
      this._gaussianScale = sigmaTexel / kernelSigma;
    } else {
      // Fetch count (shader structure) is unchanged — only update
      // kernel_scale and skip the recompile.
      this._gaussianScale = this._gaussianBaseSigma > 0
        ? sigmaTexel / this._gaussianBaseSigma
        : 1.0;
    }

    // Gaussian always uses a single level (w/2 × h/2).
    // A pool rebuild is only needed when PASS_COUNT transitions 0 → 1
    // (recovering from a disabled-blur state).
    if (this.PASS_COUNT !== 1) {
      this.PASS_COUNT = 1;
      // Only force a rebuild if the pool wasn't built yet, or previously had
      // a different number of levels (e.g. coming from Dual Kawase). The
      // actual rebuild happens next frame once vfunc_paint_target notices
      // the resolution mismatch.
      this._destroyTexturePool();
    }

    this._repaint();
  }


  /**
   * Radius setter for the Dual Kawase blur (original implementation, logic unchanged).
   */
  private _setDualKawaseBlurRadius(radius: number): void {
    // [PERF] Deliberately NOT compensated for glass-blur-downscale, unlike
    // _setGaussianBlurRadius()'s RES_SCALE. This mapping is empirical — the
    // prefs slider already warns that a Dual Kawase radius is not
    // pixel-accurate — and its pass count is what decides how deep the
    // pyramid goes, so scaling it here would trade one arbitrary mapping for
    // another while also changing the number of passes. At quarter
    // resolution the same slider position therefore reads as a wider blur,
    // which is consistent with what the setting says it does.
    let newPassCount = 0;
    let offsetDown = 0.0;
    let offsetUp = 0.0;

    if (radius > 0) {
      // 1. Derive the optimal integer pass count P from the physical radius R
      //    (empirical blur-falloff model).
      let p = Math.floor(Math.log2(radius + 1));

      // Clamp the pass count to the shader/FBO limit of [1, 4].
      newPassCount = Math.max(1, Math.min(4, p));

      // 2. Compute a linear normalized progress t within the pass interval.
      let baseR = (newPassCount === 1) ? 0 : Math.pow(2, newPassCount) - 1;
      let nextR = Math.pow(2, newPassCount + 1) - 1;

      let t = (radius - baseR) / (nextR - baseR);
      t = Math.max(0.0, Math.min(1.0, t));

      // 3. A piecewise cubic Hermite spline, chosen for C1 continuity.
      let s = 0.25 * Math.pow(t, 3) - 0.75 * Math.pow(t, 2) + 1.5 * t;

      // 4. Map to an offset range that guarantees anti-aliasing.
      let minOffset = (newPassCount === 1) ? 0.0 : 0.5;
      let maxOffset = 1.0;

      let r = minOffset + s * (maxOffset - minOffset);

      offsetDown = r;
      offsetUp = r * 1.5;
    }

    // Check whether anything actually changed.
    if (this.PASS_COUNT !== newPassCount ||
      this._blurRadiusDown !== offsetDown ||
      this._blurRadiusUp !== offsetUp) {

      const passCountChanged = this.PASS_COUNT !== newPassCount;

      this.PASS_COUNT = newPassCount;
      this._blurRadiusDown = offsetDown;
      this._blurRadiusUp = offsetUp;

      // A pass-count change requires rebuilding the FBO pool.
      if (passCountChanged) {
        this._destroyTexturePool();
      }

      this._repaint();
    }
  }
}
