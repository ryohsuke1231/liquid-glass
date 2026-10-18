import Cogl from 'gi://Cogl';
import { configureSamplerLayer } from './pipelines.js';
import { setPipelineFloat, setPipelineVec2 } from './passes.js';
import { computeGaussianKernel, buildGaussianSnippet } from './shaderSource.js';
import { uniformDeclarations } from '../shellVersion.js';

export class BlurRenderer {
    _pipelines;
    _passes;
    _repaint;

    constructor(_pipelines, _passes, _repaint) {
        this._pipelines = _pipelines;
        this._passes = _passes;
        this._repaint = _repaint;
    }

    get radius() { return this._targetRadius; }

    get downscale() { return this._blurDownscale; }

    get passCount() { return this.PASS_COUNT; }

    get result() { return this._blurResultTex; }

    get width() { return this._poolWidth; }

    get height() { return this._poolHeight; }

    get ready() { return this.PASS_COUNT === 0 || this._blurFbos.length > 0; }

    get needsCompile() { return this._gaussianPipelineDirty && this._pendingGaussianKernel !== null; }

    invalidate() { this._destroyTexturePool(); }

    compilePending(ctx) {
        if (!this.needsCompile)
            return;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compileGaussianPipelines(ctx, this._pendingGaussianKernel);
    }

    render(parent, source, uv, inputKey) {
        this._blurResultTex = null;
        this._renderedKey = null;
        if (this.PASS_COUNT <= 0)
            return;
        if (this._blurMethod === 0) {
            if (this._gaussianHPipeline && this._gaussianVPipeline)
                this._runGaussianBlur(parent, source, uv);
        }
        else
            this._runDualKawaseBlur(parent, source, uv);
        // Only a chain that actually produced a result may be reused later, and
        // the key records the configuration it was produced with.
        if (inputKey && this._blurResultTex !== null)
            this._renderedKey = [...inputKey, ...this._configKey()];
    }

    canReuse(inputKey) {
        const stored = this._renderedKey;
        if (stored === null || this._blurResultTex === null || this.PASS_COUNT <= 0)
            return false;
        const config = this._configKey();
        if (stored.length !== inputKey.length + config.length)
            return false;
        for (let i = 0; i < inputKey.length; i++)
            if (stored[i] !== inputKey[i])
                return false;
        for (let i = 0; i < config.length; i++)
            if (stored[inputKey.length + i] !== config[i])
                return false;
        return true;
    }

    _renderedKey = null;

    _configKey() {
        const p = this._pipelines;
        return [this._blurFbos[0] ?? null, this._blurMethod, this.PASS_COUNT, this._blurDownscale,
            this._blurRadiusDown, this._blurRadiusUp, this._gaussianScale,
            this._gaussianHPipeline, this._gaussianVPipeline,
            p.downsample, p.upsample, p.passthrough, p.boxDown];
    }

    setDownscale(factor) {
        if (factor === this._blurDownscale)
            return;
        this._blurDownscale = factor;
        // Level 0 changes size; the next paint rebuilds the pool.
        this._destroyTexturePool();
        this.setBlurRadius(this._targetRadius);
        this._repaint();
    }

    reload() {
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._gaussianKernel = null;
        this._gaussianFetchPairs = 0;
        this.setBlurRadius(this._targetRadius);
    }

    clear() {
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
            blurResult: result ? result.get_width() + 'x' + result.get_height() : 'NULL (layer 1 falls back to the unblurred copy)',
            radiusDown: this._blurRadiusDown, radiusUp: this._blurRadiusUp, targetRadius: this._targetRadius,
            gaussianPipelines: !!(this._gaussianHPipeline && this._gaussianVPipeline),
        };
    }

    // The texture pool; see resize() for the sizes.
    _blurTextures = [];
    _blurFbos = [];
    // The Gaussian horizontal pass output, per level.
    _gaussianTempTextures = [];
    _gaussianTempFbos = [];
    // Separate output targets per level, so no pass writes a framebuffer that
    // an earlier pass read. Deferred paint nodes make Cogl track dependencies
    // between framebuffers, and ping-ponging is a cycle it rejects; the passes
    // then lose their order and the composite reads an unwritten blur.
    _upTextures = [];
    _upFbos = [];
    // This frame's finished blur, read by the composite.
    _blurResultTex = null;
    _gaussianHPipeline = null;
    _gaussianVPipeline = null;
    _blurMethod = 1;
    // The kernel compiled into the H/V pipelines, and one waiting to be
    // compiled on the next paint.
    _gaussianKernel = null;
    _pendingGaussianKernel = null;
    _gaussianPipelineDirty = false;
    // The sigma the compiled kernel was built for; radius changes that keep
    // the tap count only change kernel_scale = sigma / _gaussianBaseSigma.
    _gaussianBaseSigma = 0;
    _gaussianScale = 1.0;
    _gaussianFetchPairs = 0;
    _poolWidth = 0;
    _poolHeight = 0;
    // glass-blur-downscale: 2 = half resolution (default), 4 = quarter.
    _blurDownscale = 2;
    // Passes per direction. With 4: 1/2 → 1/4 → 1/8 → 1/16 → 1/8 → 1/4 → 1/2.
    PASS_COUNT = 4;
    // The Kawase shaders' blur_radius uniforms.
    _blurRadiusDown = 0.5;
    _blurRadiusUp = 1.0;
    // The requested radius, before the per-method mapping.
    _targetRadius = 15.0;

    // The caller drops the previous pipelines first.
    _compileGaussianPipelines(ctx, kernel) {
        this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this._gaussianHPipeline, 0);
        const hSnippet = buildGaussianSnippet(kernel, 'h');
        const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(hSnippet.decl), null);
        hSnip.set_replace(hSnippet.body);
        this._gaussianHPipeline.add_snippet(hSnip);
        this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this._gaussianVPipeline, 0);
        const vSnippet = buildGaussianSnippet(kernel, 'v');
        const vSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(vSnippet.decl), null);
        vSnip.set_replace(vSnippet.body);
        this._gaussianVPipeline.add_snippet(vSnip);
        this._gaussianKernel = kernel;
        this._gaussianPipelineDirty = false;
        this._pendingGaussianKernel = null;
    }

    /**
     * Allocates the pool for a (w, h) source. Level i is w >> (i + 1) wide
     * (level 0 at half resolution); glass-blur-downscale = 4 shifts every level
     * down one more step.
     */
    resize(ctx, w, h) {
        this._destroyTexturePool();
        const shift = this._blurDownscale >= 4 ? 2 : 1;
        let pw = Math.max(w >> shift, 1);
        let ph = Math.max(h >> shift, 1);
        for (let i = 0; i < this.PASS_COUNT; i++) {
            const tex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
            this._blurTextures.push(tex);
            this._blurFbos.push(Cogl.Offscreen.new_with_texture(tex));
            const tmpTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
            this._gaussianTempTextures.push(tmpTex);
            this._gaussianTempFbos.push(Cogl.Offscreen.new_with_texture(tmpTex));
            const upTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
            this._upTextures.push(upTex);
            this._upFbos.push(Cogl.Offscreen.new_with_texture(upTex));
            pw = Math.max(pw >> 1, 1);
            ph = Math.max(ph >> 1, 1);
        }
        this._poolWidth = w;
        this._poolHeight = h;
    }

    // Dual Kawase: downsample srcTex through every level, then upsample back
    // into the _up* targets.
    _runDualKawaseBlur(parentNode, srcTex, srcUV) {
        let currentSrc = srcTex;
        for (let i = 0; i < this.PASS_COUNT; i++) {
            const destFbo = this._blurFbos[i];
            const destTex = this._blurTextures[i];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / currentSrc.get_width();
            const invH = 1.0 / currentSrc.get_height();
            // Only the first pass reads the source, through srcUV.
            const uv = (i === 0) ? srcUV : [0, 0, 1, 1];
            // At downscale 4 the first pass is a 4x reduction, which Kawase's
            // kernel does not filter properly; the box filter does.
            const boxFirst = i === 0 && this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
            const pipeline = boxFirst
                ? this._passes.pipeline('kawase-down-0-box', this._pipelines.boxDown)
                : this._passes.pipeline(`kawase-down-${i}`, this._pipelines.downsample);
            pipeline.set_layer_texture(0, currentSrc);
            setPipelineVec2(pipeline, 'inv_size', invW, invH);
            if (!boxFirst)
                setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusDown);
            this._passes.add(parentNode, destFbo, pipeline, destW, destH, uv);
            currentSrc = destTex;
        }
        if (this.PASS_COUNT <= 1) {
            this._blurResultTex = this._blurTextures[0];
            return;
        }
        for (let i = this.PASS_COUNT - 1; i > 0; i--) {
            const srcTexture = (i === this.PASS_COUNT - 1)
                ? this._blurTextures[i]
                : this._upTextures[i];
            const destFbo = this._upFbos[i - 1];
            const destTex = this._upTextures[i - 1];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / srcTexture.get_width();
            const invH = 1.0 / srcTexture.get_height();
            const pipeline = this._passes.pipeline(`kawase-up-${i}`, this._pipelines.upsample);
            pipeline.set_layer_texture(0, srcTexture);
            setPipelineVec2(pipeline, 'inv_size', invW, invH);
            setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusUp);
            this._passes.add(parentNode, destFbo, pipeline, destW, destH, [0, 0, 1, 1]);
        }
        this._blurResultTex = this._upTextures[0];
    }

    // Separable Gaussian on pool level 0 only: a downsampling pre-pass into
    // _blurTextures[0], the horizontal pass into the temp texture, and the
    // vertical pass into _upTextures[0].
    _runGaussianBlur(parentNode, srcTex, srcUV) {
        const tempFbo = this._gaussianTempFbos[0];
        const tempTex = this._gaussianTempTextures[0];
        const destFbo = this._blurFbos[0];
        const destTex = this._blurTextures[0];
        const destW = destTex.get_width();
        const destH = destTex.get_height();
        // At downscale 2 one bilinear fetch averages the 2x2 footprint exactly;
        // at 4 the box filter is needed.
        const wideDownsample = this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
        const prePipeline = wideDownsample
            ? this._passes.pipeline('gauss-pre-box', this._pipelines.boxDown)
            : this._passes.pipeline('gauss-pre', this._pipelines.passthrough);
        prePipeline.set_layer_texture(0, srcTex);
        if (wideDownsample) {
            setPipelineVec2(prePipeline, 'inv_size', 1.0 / srcTex.get_width(), 1.0 / srcTex.get_height());
        }
        this._passes.add(parentNode, destFbo, prePipeline, destW, destH, srcUV);
        const hPipeline = this._passes.pipeline('gauss-h', this._gaussianHPipeline);
        hPipeline.set_layer_texture(0, destTex);
        setPipelineVec2(hPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        setPipelineFloat(hPipeline, 'kernel_scale', this._gaussianScale);
        this._passes.add(parentNode, tempFbo, hPipeline, destW, destH, [0, 0, 1, 1]);
        // Not back into destFbo, which the horizontal pass read (see _upTextures).
        const vPipeline = this._passes.pipeline('gauss-v', this._gaussianVPipeline);
        vPipeline.set_layer_texture(0, tempTex);
        setPipelineVec2(vPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        setPipelineFloat(vPipeline, 'kernel_scale', this._gaussianScale);
        const outFbo = this._upFbos[0];
        this._passes.add(parentNode, outFbo, vPipeline, destW, destH, [0, 0, 1, 1]);
        this._blurResultTex = this._upTextures[0];
    }

    // Dropping the references frees the textures; GJS owns them, so
    // run_dispose() would free them twice.
    _destroyTexturePool() {
        this._blurFbos = [];
        this._blurTextures = [];
        this._gaussianTempFbos = [];
        this._gaussianTempTextures = [];
        this._upFbos = [];
        this._upTextures = [];
        this._blurResultTex = null;
        // The reuse key holds the old source texture.
        this._renderedKey = null;
        this._poolWidth = 0;
        this._poolHeight = 0;
    }

    // Both methods share the pool, and the Gaussian kernel is compiled on the
    // next paint, so a repaint is all a switch needs.
    setBlurMethod(method) {
        if (this._blurMethod === method)
            return;
        this._blurMethod = method;
        this.setBlurRadius(this._targetRadius);
        this._repaint();
    }

    setBlurRadius(radius) {
        this._targetRadius = radius;
        if (this._blurMethod === 0) {
            this._setGaussianBlurRadius(radius);
            return;
        }
        this._setDualKawaseBlurRadius(radius);
    }

    /**
     * The Gaussian uses one pool level, so a radius change never rebuilds the
     * pool. The tap count follows a 4-sigma cutoff; while it stays the same,
     * only kernel_scale changes and nothing is recompiled.
     */
    _setGaussianBlurRadius(radius) {
        // The radius is in screen pixels; one texel is RES_SCALE of them. The
        // sigma cap is in texels, so quarter resolution reaches twice as far.
        const RES_SCALE = this._blurDownscale >= 4 ? 4.0 : 2.0;
        const MAX_SIGMA_TEXEL = 15.0;
        // The kernel is at least one texel wide so it absorbs the downsample's
        // aliasing; a smaller radius only lowers kernel_scale.
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
        const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);
        // A 4-sigma cutoff (3 sigma truncated visibly), two taps per fetch, and
        // at least two pairs.
        const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
        const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));
        const needsRecompile = this._gaussianFetchPairs !== fetchPairs ||
            (!this._gaussianKernel && !this._pendingGaussianKernel);
        if (needsRecompile) {
            const kernel = computeGaussianKernel(kernelSigma, fetchPairs);
            this._pendingGaussianKernel = kernel;
            this._gaussianPipelineDirty = true;
            this._gaussianFetchPairs = fetchPairs;
            this._gaussianBaseSigma = kernelSigma;
            this._gaussianScale = sigmaTexel / kernelSigma;
        }
        else {
            this._gaussianScale = this._gaussianBaseSigma > 0
                ? sigmaTexel / this._gaussianBaseSigma
                : 1.0;
        }
        // Coming from no blur or from Dual Kawase: the next paint rebuilds the pool.
        if (this.PASS_COUNT !== 1) {
            this.PASS_COUNT = 1;
            this._destroyTexturePool();
        }
        this._repaint();
    }

    // An empirical mapping (the preferences say a Dual Kawase radius is not
    // pixel-accurate). It is not scaled for glass-blur-downscale, since that
    // would also change the pass count; at quarter resolution the same value
    // gives a wider blur.
    _setDualKawaseBlurRadius(radius) {
        let newPassCount = 0;
        let offsetDown = 0.0;
        let offsetUp = 0.0;
        if (radius > 0) {
            let p = Math.floor(Math.log2(radius + 1));
            newPassCount = Math.max(1, Math.min(4, p));
            // Position within this pass count's radius range, eased with a cubic
            // Hermite (C1 continuous) and mapped onto the tap offset.
            let baseR = (newPassCount === 1) ? 0 : Math.pow(2, newPassCount) - 1;
            let nextR = Math.pow(2, newPassCount + 1) - 1;
            let t = (radius - baseR) / (nextR - baseR);
            t = Math.max(0.0, Math.min(1.0, t));
            let s = 0.25 * Math.pow(t, 3) - 0.75 * Math.pow(t, 2) + 1.5 * t;
            let minOffset = (newPassCount === 1) ? 0.0 : 0.5;
            let maxOffset = 1.0;
            let r = minOffset + s * (maxOffset - minOffset);
            offsetDown = r;
            offsetUp = r * 1.5;
        }
        if (this.PASS_COUNT !== newPassCount ||
            this._blurRadiusDown !== offsetDown ||
            this._blurRadiusUp !== offsetUp) {
            const passCountChanged = this.PASS_COUNT !== newPassCount;
            this.PASS_COUNT = newPassCount;
            this._blurRadiusDown = offsetDown;
            this._blurRadiusUp = offsetUp;
            if (passCountChanged)
                this._destroyTexturePool();
            this._repaint();
        }
    }
}
