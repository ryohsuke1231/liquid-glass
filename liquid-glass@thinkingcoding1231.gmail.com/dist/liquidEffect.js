// src/liquidEffect.ts
//
// ─── Design overview ───────────────────────────────────────────────────────
//
//  Old implementation: subclassed Clutter.ShaderEffect and did refraction,
//          rim lighting, and shadowing all in a single glass.frag shader.
//          Blur relied solely on ShaderEffect's cogl_sampler texture
//          sampling, with no dedicated blur pass.
//
//  New implementation: subclasses Clutter.OffscreenEffect and overrides
//          vfunc_paint_target to run a custom multi-pass FBO pipeline.
//
//  Rendering pipeline (per frame):
//
//    ┌──────────────────────────────────────────────────────┐
//    │  OffscreenEffect automatically captures the actor's   │
//    │  painted content into an internal FBO                │
//    │  (retrievable via get_texture())                      │
//    └────────────────────┬─────────────────────────────────┘
//                         │ srcTex (full monitor resolution)
//                         ▼
//    ┌──────────────── Downsample ──────────────────────────┐
//    │  Pass 0: srcTex    → _blurFbos[0]  (w/2  × h/2)      │
//    │  Pass 1: _tex[0]   → _blurFbos[1]  (w/4  × h/4)      │
//    │  Pass 2: _tex[1]   → _blurFbos[2]  (w/8  × h/8)      │
//    │  Pass 3: _tex[2]   → _blurFbos[3]  (w/16 × h/16)     │
//    │  (shaders/downsample.frag – Dual Kawase, 5-tap)       │
//    └────────────────────┬─────────────────────────────────┘
//                         │
//    ┌──────────────── Upsample ────────────────────────────┐
//    │  Pass 3→2: _tex[3] → _blurFbos[2]                    │
//    │  Pass 2→1: _tex[2] → _blurFbos[1]                    │
//    │  Pass 1→0: _tex[1] → _blurFbos[0]  (w/2 × h/2)       │
//    │  (shaders/upsample.frag – Dual Kawase tent, 8-tap)    │
//    └────────────────────┬─────────────────────────────────┘
//                         │ _blurTextures[0] (blurred, w/2 × h/2)
//                         ▼
//    ┌──────────────── Glass composite ─────────────────────┐
//    │  shaders/glass.frag is parsed at runtime into a Cogl  │
//    │  snippet. cogl_sampler0 = the blurred texture.        │
//    │  Applies refraction / chromatic aberration / rim      │
//    │  lighting / shadow, then draws into screenFb (the     │
//    │  on-screen framebuffer Clutter has prepared).          │
//    └─────────────────────────────────────────────────────┘
//
//  The texture pool is rebuilt whenever the resolution changes.
//  Cogl pipelines are compiled once on the first frame and reused after that.
//
// ─────────────────────────────────────────────────────────────────────────────
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
// ─── Main class ───────────────────────────────────────────────────────────────
export const LiquidEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {
    // ─── _init ──────────────────────────────────────────────────────────────────
    _init(params) {
        const extensionPath = params.extensionPath;
        const settings = params.settings;
        delete params.extensionPath;
        delete params.settings;
        super._init(params);
        this._blurTextures = [];
        this._blurFbos = [];
        this._gaussianTempTextures = [];
        this._gaussianTempFbos = [];
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compositePipeline = null;
        this._compUniforms = new Map();
        this._pendingUniforms = new Map();
        this._poolWidth = 0;
        this._poolHeight = 0;
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
        this.PASS_COUNT = 4;
        this._blurRadiusDown = 0.5;
        this._blurRadiusUp = 1.0;
        this._blurMethod = 1; // default: Dual Kawase
        this._targetRadius = 15.0;
        this._gaussianKernel = null;
        this._pendingGaussianKernel = null;
        this._gaussianPipelineDirty = false;
        this._gaussianBaseSigma = 0;
        this._gaussianScale = 1.0;
        this._gaussianFetchPairs = 0;
        this._extensionPath = extensionPath;
        this._settings = settings;
        // ── Default values for the composite shader's uniforms ──
        // The pipeline doesn't exist yet at this point, so these are buffered
        // into _pendingUniforms and applied once the pipeline is created.
        this._setFloat('resolution_x', 0.0);
        this._setFloat('resolution_y', 0.0);
        this._setFloat('pointer_x', -100.0);
        this._setFloat('pointer_y', -100.0);
        this._setFloat('intensity', 0.0);
        this._setFloat('corner_radius', 60.0);
        this._setFloat('brightness', 1.0);
        this._setFloat('contrast', 1.0);
        this._setFloat('saturation', 1.0);
        this._setFloat('padding', 20.0);
        // [FIX] Distinct from the small optical 'padding' uniform (20px, only
        // meant to give the refraction/blur shader room past the actor's strict
        // bounds). shadow_max_radius instead reflects how much room the drop
        // shadow actually has to render outward before it would run into the
        // bgActor's own clip in dockManager.ts (CLIP_PADDING). Previously the
        // shader reused 'padding' for this, capping shadow_radius at ~18px no
        // matter how high the 0-100 prefs.js slider was set. Overwritten by
        // setShadowMaxRadius() once dockManager starts syncing geometry; this
        // default only matters before the first sync.
        this._setFloat('shadow_max_radius', 180.0);
        this._setFloat('isDock', 0.0);
        // Full-screen FBO mode: lets the shader know where the dock sits.
        this._setFloat('dock_x', 0.0);
        this._setFloat('dock_y', 0.0);
        this._setFloat('dock_w', 0.0);
        this._setFloat('dock_h', 0.0);
        this._settingsIds = [];
        if (this._settings) {
            this._bindSettings();
        }
        else {
            // Fallback defaults used when no GSettings schema is available.
            this._setFloat('max_z', 25.0);
            this._setFloat('displacement_scale', 78.5);
            this._setFloat('edge_smoothing', 2.0);
            this._setFloat('profile_shape_n', 7.0);
            this._setFloat('ior', 2.40);
            this._setFloat('chroma_strength', 0.006);
            this._setFloat('specular_intensity', 0.0);
            this._setFloat('shininess', 42.0);
            this._setFloat('rim_width', 5.0);
            this._setFloat('rim_intensity', 0.6);
            this._setFloat('rim_directional_power', 2.7);
            this._setFloat('rim_power', 6.0);
            this._setFloat('rim_light_color_intensity', 1.4);
            this._setFloat('sheen_intensity', 0.32);
            this._setFloat('light_angle_deg', 0.0);
            this._setFloat('shadow_radius', 8.0);
            this._setFloat('shadow_intensity', 0.55);
            // [NEW] Inner edge AO darkening (independent of rim_width/shadow_radius).
            // ~7.5px matches the old rim_width*1.5-derived falloff at the default
            // rim_width of 5.0, so the look is unchanged until the user retunes it.
            this._setFloat('ao_intensity', 0.25);
            this._setFloat('ao_radius', 7.5);
            this._setFloat('tint_strength', 0.0);
            this._setFloat('tint_r', 1.0);
            this._setFloat('tint_g', 1.0);
            this._setFloat('tint_b', 1.0);
        }
    }
    // ─── Pipeline initialization (deferred until the first frame, once a Cogl context exists) ──
    /**
     * Compiles and caches the downsample / upsample / composite Cogl.Pipeline
     * objects. Call only once.
     */
    _initPipelines(ctx) {
        // ── Downsample pipeline ──────────────────────────────────────────────────
        this._downsamplePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._downsamplePipeline, 0);
        const downSnippet = this._loadShaderSnippet(`${this._extensionPath}/shaders/downsample.frag`);
        if (downSnippet) {
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, downSnippet.decl, null);
            s.set_replace(downSnippet.body);
            this._downsamplePipeline.add_snippet(s);
        }
        // ── Upsample pipeline ────────────────────────────────────────────────────
        this._upsamplePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._upsamplePipeline, 0);
        const upSnippet = this._loadShaderSnippet(`${this._extensionPath}/shaders/upsample.frag`);
        if (upSnippet) {
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, upSnippet.decl, null);
            s.set_replace(upSnippet.body);
            this._upsamplePipeline.add_snippet(s);
        }
        // ── Gaussian H/V pipelines ───────────────────────────────────────────────
        // Not precompiled here: the separable Gaussian blur builds its shader
        // source dynamically from the kernel computed in setBlurRadius(), and
        // _compileGaussianPipelines() compiles it lazily inside
        // vfunc_paint_target (see _computeGaussianKernel / _buildGaussianSnippet).
        // ── Composite pipeline (glass.frag) ──────────────────────────────────────
        this._compositePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._compositePipeline, 0);
        // Standard premultiplied-alpha blending, equivalent to ShaderEffect's default:
        // "src.rgb + dst.rgb * (1 - src.a)"
        this._compositePipeline.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
        this._loadCompositeShader();
        // Apply any uniforms that were buffered before the pipeline existed.
        this._applyPendingUniforms();
    }
    /**
     * Shared helper: sets bilinear filtering and clamp-to-edge wrapping on
     * layer 0 of a pipeline.
     */
    _configureSamplerLayer(pipeline, layer) {
        pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        pipeline.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, // minification
        Cogl.PipelineFilter.LINEAR // magnification
        );
    }
    /**
     * Loads a shader file and parses it into a ShaderSnippet, splitting on
     * "void main()" into:
     *   decl = the declaration section (uniforms / helper functions)
     *   body = the body of main()
     * Returns null on failure.
     */
    _loadShaderSnippet(path) {
        const file = Gio.File.new_for_path(path);
        let bytes;
        try {
            const [ok, b] = file.load_contents(null);
            if (!ok)
                throw new Error('load_contents returned false');
            bytes = b;
        }
        catch (e) {
            console.error(`[Liquid Glass] Failed to load shader: ${path}\n${e}`);
            return null;
        }
        const src = new TextDecoder('utf-8').decode(bytes);
        return this._splitShader(src);
    }
    /**
     * Splits a GLSL source string into { decl, body } at the "void main()" boundary.
     */
    _splitShader(src) {
        const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
        if (!match || match.index === undefined) {
            console.warn('[Liquid Glass] void main() not found; treating entire source as decl.');
            return { decl: src, body: '' };
        }
        const decl = src.substring(0, match.index);
        const rest = src.substring(match.index + match[0].length);
        // Find the matching closing brace.
        let depth = 1;
        let bodyEnd = 0;
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '{')
                depth++;
            else if (rest[i] === '}') {
                depth--;
                if (depth === 0) {
                    bodyEnd = i;
                    break;
                }
            }
        }
        return { decl, body: rest.substring(0, bodyEnd) };
    }
    /**
     * Loads glass.frag, rewrites its "cogl_sampler" (the uniform name used by
     * the old ShaderEffect) to "cogl_sampler0" (the name Cogl auto-declares for
     * a FRAGMENT-hook layer 0), and adds it to the composite pipeline as a
     * snippet.
     *
     * The original "uniform sampler2D cogl_sampler;" declaration is stripped
     * since cogl_sampler0 is already declared automatically by Cogl.
     */
    _loadCompositeShader() {
        if (!this._compositePipeline)
            return;
        const snippetData = this._loadShaderSnippet(`${this._extensionPath}/shaders/glass.frag`);
        if (!snippetData)
            return;
        let { decl, body } = snippetData;
        // Rewrite the ShaderEffect-style sampler name to the FRAGMENT-hook name.
        decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
        body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, null);
        snippet.set_replace(body);
        this._compositePipeline.add_snippet(snippet);
    }
    // ─── Dynamic Gaussian kernel computation / shader generation ────────────────
    /**
     * Computes a linear-sampling-optimized 1D Gaussian kernel from a standard
     * deviation (sigma, in half-res texels) and a target number of fetch pairs.
     *
     * Method:
     *   1. Compute discrete Gaussian weights for i = 0..(fetchPairs*2) and normalize.
     *   2. i = 0 (the center) stays a single, standalone sample.
     *   3. Merge each (i, i+1) pair into a single fetch (bilinear-tap merging):
     *        combined weight  = w(i) + w(i+1)
     *        combined offset  = (i * w(i) + (i+1) * w(i+1)) / combined weight
     *
     * For a fixed fetchPairs, the resulting offsets/weights (and therefore the
     * shader's structure) are deterministic. As long as fetchPairs doesn't
     * change, sigma changes only need to update the kernel_scale uniform — see
     * setBlurRadius() — without any shader recompilation.
     */
    _computeGaussianKernel(sigma, fetchPairs) {
        const sideTaps = Math.max(2, fetchPairs * 2);
        // Compute and normalize discrete Gaussian weights for i = 0..sideTaps.
        const raw = [];
        let sum = 0;
        for (let i = 0; i <= sideTaps; i++) {
            const w = Math.exp(-(i * i) / (2 * sigma * sigma));
            raw.push(w);
            sum += (i === 0) ? w : w * 2;
        }
        for (let i = 0; i <= sideTaps; i++) {
            raw[i] /= sum;
        }
        const offsets = [0];
        const weights = [raw[0]];
        for (let p = 0; p < fetchPairs; p++) {
            const i = p * 2 + 1;
            const j = i + 1;
            const w0 = raw[i] ?? 0;
            const w1 = (j <= sideTaps) ? raw[j] : 0;
            const wSum = w0 + w1;
            const offset = wSum > 0 ? (i * w0 + j * w1) / wSum : i;
            offsets.push(offset);
            weights.push(wSum);
        }
        return { offsets, weights };
    }
    /**
     * Builds a GLSL fragment shader snippet string from a GaussianKernel
     * (fully unrolled — no for loop is used at runtime).
     *
     * Offsets are baked in as GLSL constants; the kernel_scale uniform is
     * multiplied in at runtime so sigma can be fine-tuned without recompiling.
     * Weights define the kernel's shape (fetch count) and are only baked in
     * again when a recompile actually happens.
     */
    _buildGaussianSnippet(kernel, direction) {
        const decl = `uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */\n` +
            `uniform float kernel_scale; /* dynamic scale based on the sigma ratio, avoids recompiling */\n`;
        const lines = [];
        lines.push(`vec2 uv = cogl_tex_coord_in[0].st;`);
        lines.push(`vec4 col = texture2D(cogl_sampler0, uv) * ${kernel.weights[0].toFixed(8)};`);
        for (let i = 1; i < kernel.offsets.length; i++) {
            const off = kernel.offsets[i].toFixed(8);
            const w = kernel.weights[i].toFixed(8);
            const plusVec = direction === 'h'
                ? `vec2(${off} * kernel_scale * inv_size.x, 0.0)`
                : `vec2(0.0, ${off} * kernel_scale * inv_size.y)`;
            lines.push(`col += texture2D(cogl_sampler0, uv + ${plusVec}) * ${w};`);
            lines.push(`col += texture2D(cogl_sampler0, uv - ${plusVec}) * ${w};`);
        }
        lines.push(`cogl_color_out = col;`);
        return { decl, body: '\n    ' + lines.join('\n    ') + '\n' };
    }
    /**
     * Compiles the H/V pipelines from a dynamically generated GaussianKernel.
     * The caller is responsible for having already dropped any previous
     * pipeline reference (we never call run_dispose(), see _destroyTexturePool).
     */
    _compileGaussianPipelines(ctx, kernel) {
        this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._gaussianHPipeline, 0);
        const hSnippet = this._buildGaussianSnippet(kernel, 'h');
        const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, hSnippet.decl, null);
        hSnip.set_replace(hSnippet.body);
        this._gaussianHPipeline.add_snippet(hSnip);
        this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._gaussianVPipeline, 0);
        const vSnippet = this._buildGaussianSnippet(kernel, 'v');
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
     * Index-to-resolution mapping:
     *   [0]: w>>1 × h>>1  (= w/2)
     *   [1]: w>>2 × h>>2  (= w/4)
     *   ...
     *   [PASS_COUNT-1]: w >> PASS_COUNT
     */
    _buildTexturePool(ctx, w, h) {
        this._destroyTexturePool();
        let pw = Math.max(w >> 1, 1);
        let ph = Math.max(h >> 1, 1);
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
            }
            catch (e) {
                console.error(`[Liquid Glass] Failed to build texture pool at pass ${i} (${pw}x${ph}): ${e}`);
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
    _runDualKawaseBlur(srcTex) {
        let currentSrc = srcTex;
        // ── Downsample phase ────────────────────────────────────────────────────
        for (let i = 0; i < this.PASS_COUNT; i++) {
            const destFbo = this._blurFbos[i];
            const destTex = this._blurTextures[i];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / currentSrc.get_width();
            const invH = 1.0 / currentSrc.get_height();
            this._downsamplePipeline.set_layer_texture(0, currentSrc);
            this._setPipelineVec2(this._downsamplePipeline, 'inv_size', invW, invH);
            this._setPipelineFloat(this._downsamplePipeline, 'blur_radius', this._blurRadiusDown);
            destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
            destFbo.orthographic(0, 0, destW, destH, -1, 1);
            destFbo.draw_textured_rectangle(this._downsamplePipeline, 0, 0, destW, destH, 0, 0, 1, 1);
            // Flush right after each pass to break the FBO dependency chain.
            destFbo.flush();
            currentSrc = destTex;
        }
        // ── Upsample phase ──────────────────────────────────────────────────────
        for (let i = this.PASS_COUNT - 1; i > 0; i--) {
            const srcTexture = this._blurTextures[i];
            const destFbo = this._blurFbos[i - 1];
            const destTex = this._blurTextures[i - 1];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / srcTexture.get_width();
            const invH = 1.0 / srcTexture.get_height();
            this._upsamplePipeline.set_layer_texture(0, srcTexture);
            this._setPipelineVec2(this._upsamplePipeline, 'inv_size', invW, invH);
            this._setPipelineFloat(this._upsamplePipeline, 'blur_radius', this._blurRadiusUp);
            destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
            destFbo.orthographic(0, 0, destW, destH, -1, 1);
            destFbo.draw_textured_rectangle(this._upsamplePipeline, 0, 0, destW, destH, 0, 0, 1, 1);
            destFbo.flush();
        }
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
    _runGaussianBlur(srcTex) {
        const tempFbo = this._gaussianTempFbos[0];
        const tempTex = this._gaussianTempTextures[0];
        const destFbo = this._blurFbos[0];
        const destTex = this._blurTextures[0];
        const destW = destTex.get_width();
        const destH = destTex.get_height();
        const srcW = srcTex.get_width();
        const srcH = srcTex.get_height();
        // ── 0. Pre-pass: srcTex (full res) → destTex (half res) ─────────────────
        // A plain bilinear downsample so the H/V passes can operate entirely in
        // half-resolution space. (Reuses the Dual Kawase downsample pipeline with
        // radius 0.)
        this._downsamplePipeline.set_layer_texture(0, srcTex);
        this._setPipelineVec2(this._downsamplePipeline, 'inv_size', 1.0 / srcW, 1.0 / srcH);
        this._setPipelineFloat(this._downsamplePipeline, 'blur_radius', 0.0);
        destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        destFbo.orthographic(0, 0, destW, destH, -1, 1);
        destFbo.draw_textured_rectangle(this._downsamplePipeline, 0, 0, destW, destH, 0, 0, 1, 1);
        destFbo.flush();
        // ── 1. Horizontal pass: destTex (half res) → tempTex (half res) ─────────
        // Input is already half-resolution, so inv_size uses destW/destH directly.
        this._gaussianHPipeline.set_layer_texture(0, destTex);
        this._setPipelineVec2(this._gaussianHPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        this._setPipelineFloat(this._gaussianHPipeline, 'kernel_scale', this._gaussianScale);
        tempFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        tempFbo.orthographic(0, 0, destW, destH, -1, 1);
        tempFbo.draw_textured_rectangle(this._gaussianHPipeline, 0, 0, destW, destH, 0, 0, 1, 1);
        tempFbo.flush();
        // ── 2. Vertical pass: tempTex (half res) → destTex (half res) ───────────
        this._gaussianVPipeline.set_layer_texture(0, tempTex);
        this._setPipelineVec2(this._gaussianVPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        this._setPipelineFloat(this._gaussianVPipeline, 'kernel_scale', this._gaussianScale);
        destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        destFbo.orthographic(0, 0, destW, destH, -1, 1);
        destFbo.draw_textured_rectangle(this._gaussianVPipeline, 0, 0, destW, destH, 0, 0, 1, 1);
        destFbo.flush();
    }
    /**
     * Drops the texture pool and resets the related fields.
     *
     * We never call run_dispose() on these GJS-managed Cogl objects: GJS's own
     * garbage collector would later try to unref them again, causing a double
     * free ("free(): invalid size" → SIGABRT). Simply clearing the references
     * lets the GC reclaim the VRAM safely.
     */
    _destroyTexturePool() {
        this._blurFbos = [];
        this._blurTextures = [];
        this._gaussianTempFbos = [];
        this._gaussianTempTextures = [];
        this._poolWidth = 0;
        this._poolHeight = 0;
    }
    // ─── Crop pass (works around OffscreenEffect FBO padding) ───────────────────
    //
    // Background: on some Cogl/Clutter versions, the texture returned by
    // get_texture() can be a few pixels larger than the actor's logical size
    // (e.g. alloc=1920x1080 but tex=1923x1083). This appears to be fixed
    // internal padding added by OffscreenEffect's FBO allocation, unrelated to
    // any user setting.
    //
    // If vfunc_paint_target treated that padded size as the "true" resolution,
    // the extra pixels would leak into both the final composite draw rect and
    // the blur texture pool's resolution chain, producing undefined-content
    // artifacts and small misalignments between sharp and blurred layers.
    //
    // Fix: never trust get_texture()'s size — actor.get_size() is always the
    // source of truth. When they differ, crop out just the valid region into
    // a dedicated texture (_cropTexture) once per frame, and use that as the
    // input for every later pass. No extra shader is needed: downsample.frag
    // run with blur_radius = 0 collapses its 5-tap Kawase kernel onto the
    // center sample, so it doubles as a plain UV-remapping passthrough.
    /**
     * (Re)allocates the crop FBO/texture at size (w, h), reusing the existing
     * one if the size hasn't changed.
     */
    _ensureCropTarget(ctx, w, h) {
        if (this._cropTexture && this._cropFbo &&
            this._cropPoolW === w && this._cropPoolH === h) {
            return true;
        }
        // Just clear the old references and let the GC handle them (same
        // reasoning as _destroyTexturePool).
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
        try {
            const tex = Cogl.Texture2D.new_with_size(ctx, w, h);
            const fbo = Cogl.Offscreen.new_with_texture(tex);
            this._cropTexture = tex;
            this._cropFbo = fbo;
            this._cropPoolW = w;
            this._cropPoolH = h;
            return true;
        }
        catch (e) {
            console.error(`[Liquid Glass] Failed to create crop texture (${w}x${h}): ${e}`);
            return false;
        }
    }
    /**
     * Crops srcTex (the OffscreenEffect's raw texture, which may include
     * padding) down to exactly the actor's logical size (allocW x allocH).
     * If no cropping is needed (no padding), returns srcTex unchanged.
     *
     * Padding is assumed to be distributed evenly around the content (i.e. the
     * valid region is centered within srcTex). This anchor was determined
     * empirically to match observed behavior across the tested Cogl/Clutter
     * versions.
     */
    _cropSourceTexture(ctx, srcTex, srcW, srcH, allocW, allocH) {
        if (allocW === srcW && allocH === srcH) {
            return srcTex;
        }
        if (!this._downsamplePipeline) {
            // Pipeline isn't ready yet, so cropping isn't possible; fall back to the raw texture.
            return srcTex;
        }
        if (!this._ensureCropTarget(ctx, allocW, allocH)) {
            return srcTex;
        }
        // Assume padding is split evenly on all sides (center anchor).
        const padW = srcW - allocW;
        const padH = srcH - allocH;
        const offX = padW / 2;
        const offY = padH / 2;
        const uMin = offX / srcW;
        const vMin = offY / srcH;
        const uMax = Math.min(1.0, (offX + allocW) / srcW);
        const vMax = Math.min(1.0, (offY + allocH) / srcH);
        const fbo = this._cropFbo;
        const pipeline = this._downsamplePipeline;
        pipeline.set_layer_texture(0, srcTex);
        this._setPipelineVec2(pipeline, 'inv_size', 1.0 / srcW, 1.0 / srcH);
        // blur_radius = 0 collapses every tap in the 5-tap kernel onto the center
        // sample, turning this into a plain UV resample (i.e. a crop).
        this._setPipelineFloat(pipeline, 'blur_radius', 0.0);
        fbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        fbo.orthographic(0, 0, allocW, allocH, -1, 1);
        // Draw across the full (0,0)-(allocW,allocH) output rect while sampling
        // only the (uMin,vMin)-(uMax,vMax) input UV range — stretching the
        // padding-free region to fill the output, i.e. cropping.
        fbo.draw_textured_rectangle(pipeline, 0, 0, allocW, allocH, uMin, vMin, uMax, vMax);
        fbo.flush();
        return this._cropTexture;
    }
    _destroyCropTarget() {
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
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
    vfunc_paint_target(_paintNode, paintContext) {
        // ── Deferred pipeline initialization ─────────────────────────────────────
        if (!this._compositePipeline) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._initPipelines(ctx);
            }
            catch (e) {
                console.error(`[Liquid Glass] Pipeline initialization failed: ${e}`);
                // Fall back to OffscreenEffect's default drawing.
                super.vfunc_paint_target(_paintNode, paintContext);
                return;
            }
        }
        // ── Guard check ───────────────────────────────────────────────────────────
        // The Gaussian H/V pipelines don't exist until a radius has been set
        // (they're built dynamically), so they're intentionally excluded from
        // this required-pipeline check.
        if (!this._compositePipeline || !this._downsamplePipeline || !this._upsamplePipeline) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // ── Deferred compilation of the Gaussian shaders ─────────────────────────
        // Whenever setBlurRadius() changes the tap count, compile the new H/V
        // pipelines here, where a Cogl context is guaranteed to be available.
        // Old pipeline references are left for GJS's GC rather than disposed
        // manually.
        if (this._gaussianPipelineDirty && this._pendingGaussianKernel) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._gaussianHPipeline = null;
                this._gaussianVPipeline = null;
                this._compileGaussianPipelines(ctx, this._pendingGaussianKernel);
            }
            catch (e) {
                console.error(`[Liquid Glass] Failed to build Gaussian pipelines: ${e}`);
            }
        }
        // Grab the FBO texture OffscreenEffect captured from the actor.
        const srcTex = this.get_texture();
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
            if (Number.isFinite(aw) && aw > 0)
                allocW = Math.round(aw);
            if (Number.isFinite(ah) && ah > 0)
                allocH = Math.round(ah);
        }
        // ── Only run the crop pass when padding is actually present ─────────────
        // (When sizes match, _cropSourceTexture just returns srcTex unchanged,
        //  so the normal-case overhead is a single size comparison.)
        let effectiveTex = srcTex;
        let effectiveW = srcW;
        let effectiveH = srcH;
        if (allocW !== srcW || allocH !== srcH) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                effectiveTex = this._cropSourceTexture(ctx, srcTex, srcW, srcH, allocW, allocH);
                // Only update the effective dimensions if cropping actually succeeded
                // (on failure, _cropSourceTexture returns srcTex unchanged, so we keep
                // the padded dimensions).
                if (effectiveTex !== srcTex) {
                    effectiveW = allocW;
                    effectiveH = allocH;
                }
            }
            catch (e) {
                console.error(`[Liquid Glass] Crop pass failed; continuing with the padded texture: ${e}`);
            }
        }
        // ── Rebuild the texture pool when the resolution changes ────────────────
        // Based on the cropped ("true") resolution — using the padded size here
        // would cause rounding error from bit-shifting (w >> 1) an odd value to
        // accumulate across passes, misaligning the sharp and blurred layers.
        if (effectiveW !== this._poolWidth || effectiveH !== this._poolHeight) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._buildTexturePool(ctx, effectiveW, effectiveH);
            }
            catch (e) {
                console.error(`[Liquid Glass] Failed to rebuild the texture pool: ${e}`);
                super.vfunc_paint_target(_paintNode, paintContext);
                return;
            }
        }
        if (this.PASS_COUNT > 0 && !this._blurFbos.length) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // ─────────────────────────────────────────────────────────────────────
        // Blur pass: which blur method runs depends on _blurMethod
        //   0: Separable Gaussian blur
        //   1: Dual Kawase blur (original implementation)
        // Always takes effectiveTex (cropped, padding-free) as input.
        // ─────────────────────────────────────────────────────────────────────
        if (this.PASS_COUNT > 0) {
            if (this._blurMethod === 0) {
                if (this._gaussianHPipeline && this._gaussianVPipeline) {
                    this._runGaussianBlur(effectiveTex);
                }
            }
            else {
                this._runDualKawaseBlur(effectiveTex);
            }
        }
        // ─────────────────────────────────────────────────────────────────────
        // Final pass: glass composite.
        //   Binds _blurTextures[0] (blurred, w/2 × h/2) as cogl_sampler0 and runs
        //   glass.frag (refraction / rim lighting / shadow) to draw onto the screen.
        //
        //   Clutter has already set up the actor's model-view transform on
        //   screenFb, so drawing in actor-local coordinates
        //   (0, 0)-(effectiveW, effectiveH) is all that's needed. Using
        //   (0,0,srcW,srcH) here used to leak the padding onto the screen.
        // ─────────────────────────────────────────────────────────────────────
        const compFb = paintContext.get_framebuffer();
        const compPipeline = this._compositePipeline;
        // Layer 0: the sharp, unblurred capture (used as the basis for refraction).
        // Using the cropped texture means UV (0,0)-(1,1) lines up exactly with
        // the actor's logical size.
        compPipeline.set_layer_texture(0, effectiveTex);
        this._configureSamplerLayer(compPipeline, 0);
        // Layer 1: the heavily blurred texture (used for the background blur).
        // Falls back to effectiveTex when no blur pass ran.
        if (this.PASS_COUNT > 0 && this._blurTextures.length > 0) {
            compPipeline.set_layer_texture(1, this._blurTextures[0]);
        }
        else {
            compPipeline.set_layer_texture(1, effectiveTex);
        }
        this._configureSamplerLayer(compPipeline, 1);
        // Manually sync pending uniforms into the composite pipeline.
        // Without this, values like dock_x would stay at 0 and the whole screen
        // would be misdetected as being inside the dock mask.
        this._applyPendingUniforms();
        compFb.push_matrix();
        const screenFb = paintContext.get_framebuffer();
        screenFb.draw_textured_rectangle(this._compositePipeline, 0, 0, effectiveW, effectiveH, 0, 0, 1, 1);
        compFb.pop_matrix();
    }
    // ─── Uniform helpers ─────────────────────────────────────────────────────────
    /**
     * Sets a vec2 uniform on a pipeline. Cogl caches the uniform location
     * internally, so calling this every frame is safe.
     */
    _setPipelineVec2(pipeline, name, x, y) {
        const loc = pipeline.get_uniform_location(name);
        // set_uniform_float(loc, n_components, count, values[])
        pipeline.set_uniform_float(loc, 2, 1, [x, y]);
    }
    /**
     * Sets a scalar float uniform on a pipeline.
     */
    _setPipelineFloat(pipeline, name, value) {
        const loc = pipeline.get_uniform_location(name);
        pipeline.set_uniform_float(loc, 1, 1, [value]);
    }
    /**
     * Sets a float uniform on the composite pipeline. If the pipeline hasn't
     * been created yet, the value is buffered in _pendingUniforms and applied
     * later in _applyPendingUniforms().
     */
    _setFloat(name, value) {
        this._pendingUniforms.set(name, value);
        if (this._compositePipeline) {
            this._applyUniform(name, value);
        }
    }
    _applyUniform(name, value) {
        if (!this._compositePipeline)
            return;
        // Cache the uniform location to avoid a get_uniform_location() call every frame.
        let loc = this._compUniforms.get(name);
        if (loc === undefined) {
            loc = this._compositePipeline.get_uniform_location(name);
            this._compUniforms.set(name, loc);
        }
        // set_uniform_float(loc, 1 component, 1 element, [value])
        this._compositePipeline.set_uniform_float(loc, 1, 1, [value]);
    }
    _applyPendingUniforms() {
        for (const [name, value] of this._pendingUniforms) {
            this._applyUniform(name, value);
        }
    }
    // ─── Cogl context lookup ─────────────────────────────────────────────────────
    _getCoglContext() {
        try {
            // Clutter.get_default_backend() is available from GJS.
            // On GNOME 50, get_cogl_context() returns a Cogl.Context.
            const backend = Clutter.get_default_backend();
            return backend.get_cogl_context();
        }
        catch (e) {
            console.error(`[Liquid Glass] Failed to obtain the Cogl context: ${e}`);
            return null;
        }
    }
    // ─── GSettings bindings ───────────────────────────────────────────────────────
    _bindSettings() {
        const mappings = [
            { key: 'glass-max-z', uniform: 'max_z' },
            { key: 'glass-displacement-scale', uniform: 'displacement_scale' },
            { key: 'glass-edge-smoothing', uniform: 'edge_smoothing' },
            { key: 'glass-profile-shape-n', uniform: 'profile_shape_n' },
            { key: 'glass-ior', uniform: 'ior' },
            { key: 'glass-chroma-strength', uniform: 'chroma_strength' },
            { key: 'glass-specular-intensity', uniform: 'specular_intensity' },
            { key: 'glass-shininess', uniform: 'shininess' },
            { key: 'glass-rim-width', uniform: 'rim_width' },
            { key: 'glass-rim-intensity', uniform: 'rim_intensity' },
            { key: 'glass-rim-directional-power', uniform: 'rim_directional_power' },
            { key: 'glass-rim-power', uniform: 'rim_power' },
            { key: 'glass-rim-light-color-intensity', uniform: 'rim_light_color_intensity' },
            { key: 'glass-sheen-intensity', uniform: 'sheen_intensity' },
            { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' },
            { key: 'shadow-radius', uniform: 'shadow_radius' },
            { key: 'shadow-intensity', uniform: 'shadow_intensity' },
            // [NEW] Inner edge AO darkening — independent of rim_width and of the
            // outer drop shadow's radius/intensity pair above.
            { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
            { key: 'glass-ao-radius', uniform: 'ao_radius' },
        ];
        const settings = this._settings;
        if (!settings)
            return;
        mappings.forEach(map => {
            // Apply the initial value.
            this._setFloat(map.uniform, settings.get_double(map.key));
            // Watch for changes.
            const id = settings.connect(`changed::${map.key}`, () => {
                this._setFloat(map.uniform, settings.get_double(map.key));
            });
            this._settingsIds.push(id);
        });
        // ── blur-method (int): 0 = Gaussian, 1 = Dual Kawase ──────────────────
        // Assumes the GSettings schema defines this key as an int.
        const applyBlurMethod = () => {
            const raw = settings.get_int('blur-method');
            this.setBlurMethod(raw === 0 ? 0 : 1);
        };
        applyBlurMethod();
        const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
        this._settingsIds.push(blurMethodId);
    }
    // ─── Public API (compatible with the previous ShaderEffect-based interface) ──
    cleanup() {
        // Disconnect GSettings signal handlers.
        if (this._settings && this._settingsIds) {
            this._settingsIds.forEach(id => this._settings?.disconnect(id));
            this._settingsIds = [];
        }
        // Free the texture pool (reference clear only — run_dispose() would double-free).
        this._destroyTexturePool();
        this._destroyCropTarget();
        // Clear pipeline references (GJS's GC reclaims the VRAM).
        // Never call run_dispose() here — it would double-unref a GJS-managed object.
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compositePipeline = null;
        this._compUniforms.clear();
        this._pendingUniforms.clear();
        // Reset the dynamic Gaussian shader generation state too.
        this._gaussianKernel = null;
        this._pendingGaussianKernel = null;
        this._gaussianPipelineDirty = false;
        this._gaussianBaseSigma = 0;
        this._gaussianScale = 1.0;
        this._gaussianFetchPairs = 0;
    }
    setIsDock(isDock) {
        this._setFloat('isDock', isDock ? 1.0 : 0.0);
    }
    setPadding(pad) {
        this._setFloat('padding', pad);
    }
    /**
     * [FIX] Tells the shader how much room (in px) the drop shadow actually
     * has to render outward, independent of the small optical `padding`
     * uniform. Should be kept in sync with dockManager's CLIP_PADDING (minus
     * a small safety margin) so shadow_radius can use its full prefs.js
     * range (0-100) without being invisibly clamped or hitting a hard edge
     * at the bgActor's own clip boundary.
     */
    setShadowMaxRadius(radius) {
        this._setFloat('shadow_max_radius', radius);
    }
    /**
     * [DEBUG] Forces glass.frag (and the downsample/upsample shaders) to be
     * re-read from disk and recompiled into fresh Cogl.Pipelines on the next
     * paint.
     *
     * Why this exists: _initPipelines() only ever runs once per LiquidEffect
     * instance, guarded by `if (!this._compositePipeline)` in
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
    reloadShaders() {
        this._compositePipeline = null;
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._gaussianKernel = null;
        this._gaussianFetchPairs = 0;
        this._compUniforms.clear();
        // _pendingUniforms is intentionally left intact: it holds every uniform
        // value currently in effect, and _initPipelines() re-applies all of them
        // to the freshly-compiled pipeline via _applyPendingUniforms().
        // Re-derive the Gaussian kernel (if that's the active blur method) so
        // _gaussianPipelineDirty / _pendingGaussianKernel get set correctly
        // instead of leaving the Gaussian pass permanently skipped.
        this.setBlurRadius(this._targetRadius);
        this.queue_repaint();
    }
    setTintColor(r, g, b) {
        this._setFloat('tint_r', r);
        this._setFloat('tint_g', g);
        this._setFloat('tint_b', b);
        this.queue_repaint();
    }
    setTintStrength(strength) {
        this._setFloat('tint_strength', strength);
        this.queue_repaint();
    }
    setCornerRadius(radius) {
        this._setFloat('corner_radius', radius);
        this.queue_repaint();
    }
    setAnimationScale(scale) {
        const settings = this._settings;
        if (!settings)
            return;
        this._setFloat('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
        this._setFloat('max_z', settings.get_double('glass-max-z') * scale);
        this._setFloat('chroma_strength', settings.get_double('glass-chroma-strength') * scale);
        this.queue_repaint();
    }
    setPointerPosition(x, y, intensity) {
        this._setFloat('pointer_x', x);
        this._setFloat('pointer_y', y);
        this._setFloat('intensity', intensity);
    }
    /**
     * Syncs the actor's logical size to the shader's resolution uniform.
     *
     * The texture pool itself is rebuilt automatically inside
     * vfunc_paint_target based on get_texture()'s size, so no extra work is
     * needed here.
     */
    setResolution(width, height) {
        this._setFloat('resolution_x', width);
        this._setFloat('resolution_y', height);
        this.queue_repaint();
    }
    /**
     * Full-screen FBO mode: passes the dock's monitor-relative geometry to the
     * shader (see the dock_x/y/w/h comments in glass.frag for details).
     */
    setGlassGeometry(x, y, w, h) {
        this._setFloat('dock_x', x);
        this._setFloat('dock_y', y);
        this._setFloat('dock_w', w);
        this._setFloat('dock_h', h);
        this.queue_repaint();
    }
    setBrightness(brightness) {
        this._setFloat('brightness', brightness);
        this.queue_repaint();
    }
    setContrast(contrast) {
        this._setFloat('contrast', contrast);
        this.queue_repaint();
    }
    setSaturation(saturation) {
        this._setFloat('saturation', saturation);
        this.queue_repaint();
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
    setBlurMethod(method) {
        if (this._blurMethod === method)
            return;
        this._blurMethod = method;
        this.setBlurRadius(this._targetRadius);
        this.queue_repaint();
    }
    /**
     * Dynamically sets the blur radius. The calculation branches depending on
     * the active method (Gaussian / Dual Kawase).
     */
    setBlurRadius(radius) {
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
    _setGaussianBlurRadius(radius) {
        const RES_SCALE = 2.0; // half resolution: 1 texel = 2 original pixels
        const MAX_SIGMA_TEXEL = 15.0; // physical cap of 30px (= 15 texels in half-res space)
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
            this.queue_repaint();
            return;
        }
        const sigmaTexel = Math.min(radius / RES_SCALE, MAX_SIGMA_TEXEL);
        // Use a sigma floored at MIN_SIGMA_TEXEL to decide the kernel shape
        // (fetch-pair count), so a wide-enough kernel gets compiled even for
        // small radii.
        const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);
        // Number of one-sided taps needed to satisfy the 3-sigma rule, converted
        // to fetch pairs (2 taps per fetch). At least 2 pairs (5-tap equivalent)
        // are guaranteed so bilinear-downsample aliasing is reliably absorbed.
        const sideTaps = Math.max(2, Math.ceil(kernelSigma * 3));
        const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));
        const needsRecompile = this._gaussianFetchPairs !== fetchPairs ||
            (!this._gaussianKernel && !this._pendingGaussianKernel);
        if (needsRecompile) {
            const kernel = this._computeGaussianKernel(kernelSigma, fetchPairs);
            this._pendingGaussianKernel = kernel;
            this._gaussianPipelineDirty = true;
            this._gaussianFetchPairs = fetchPairs;
            this._gaussianBaseSigma = kernelSigma;
            // kernel_scale = actual sigma / sigma at compile time.
            // When sigmaTexel < kernelSigma, scale < 1.0, giving a weaker blur.
            this._gaussianScale = sigmaTexel / kernelSigma;
        }
        else {
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
        this.queue_repaint();
    }
    /**
     * Radius setter for the Dual Kawase blur (original implementation, logic unchanged).
     */
    _setDualKawaseBlurRadius(radius) {
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
            this.queue_repaint();
        }
    }
});
