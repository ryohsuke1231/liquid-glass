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
//
//  RENDERING MODEL — READ THIS BEFORE CHANGING ANY DRAWING CODE
//
//  Every pass in this effect is issued as a Clutter PAINT NODE. None of it may
//  be drawn with Cogl's immediate-mode API. This is not a style preference; it
//  is the fix for a long-standing bug, and reverting it silently reintroduces
//  that bug. Four traps are involved, all of them found the hard way.
//
//  ── Trap 1: paint_target runs BEFORE the capture exists ─────────────────────
//
//  Clutter paints in two phases: it BUILDS a ClutterPaintNode tree, then
//  EXECUTES it. ClutterOffscreenEffect adds a LayerNode that renders the actor
//  into the capture texture, and that node runs in the EXECUTE phase — but
//  vfunc_paint_target() is called during the BUILD phase, when the node has
//  only been added to the tree. So at the moment paint_target runs,
//  get_texture() still holds the PREVIOUS frame's content.
//
//  Immediate-mode drawing (draw_textured_rectangle + flush) executes right
//  there, in the build phase, and therefore samples that stale capture. That
//  was the cause of the "background inside the window lags one frame behind
//  while dragging" bug. Clutter's own default paint_target implementation adds
//  nodes rather than drawing, precisely for this reason.
//
//  Drawing straight to the screen framebuffer APPEARED to work, but only by
//  accident: Cogl journals those draws and flushes them later, by which time
//  the capture has landed. It is not a guarantee. Adding a single flush()
//  after such a draw reproduced the identical one-frame lag with no
//  intermediate framebuffer involved at all — that experiment is what finally
//  identified the cause. Do not rely on it.
//
//  ── Trap 2: deferred passes cannot share a Cogl pipeline ────────────────────
//
//  With immediate drawing, "set uniforms, draw, overwrite uniforms for the
//  next pass" worked. Nodes execute after paint_target returns, so a shared
//  pipeline means every pass draws with whatever the LAST pass left behind.
//  Each pass gets its own copy via _passPipeline().
//
//  ── Trap 3: deferred passes must form an acyclic framebuffer graph ──────────
//
//  With immediate drawing, ping-ponging between framebuffers was harmless.
//  Deferred nodes make Cogl build a real dependency graph, and ping-ponging is
//  a CYCLE in it (e.g. Gaussian: temp reads blur0, then blur0 reads temp).
//  Cogl rejects the dependency with
//    "_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed"
//  and the passes lose their ordering, so the composite samples a
//  never-written blur texture. On screen: a flat tint with no background in it,
//  while rim lighting (which does not read the blur layer) still works.
//
//  Hence the separate _upTextures/_upFbos output targets: no pass ever writes
//  into a framebuffer that an earlier pass read from.
//
//  ── Trap 4: add_multitexture_rectangle() segfaults the shell ────────────────
//
//  Clutter.PaintNode.add_multitexture_rectangle() has a broken introspection
//  annotation on this stack: text_coords is exposed as a plain `number`
//  instead of an array, so passing an array makes the native side read a JS
//  object as a float pointer -> SIGSEGV. The TypeScript error it produces is
//  CORRECT and must not be silenced with a cast.
//
//  (Cogl.Framebuffer.draw_multitextured_rectangle IS annotated correctly, so
//  the two are easy to confuse.)
//
//  Consequence: all composite layers must share one UV range, which is why the
//  capture's padding is removed by a crop pass instead of by per-layer UVs.
//
// ─────────────────────────────────────────────────────────────────────────────
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { computeCaptureLayout } from './utils.js';
// ─── Looking Glass diagnostics ───────────────────────────────────────────────
//
// Every live LiquidEffect registers itself here so its last resolved frame
// state can be inspected from Looking Glass:
//
//     global._lgGlass.dump()      // one line per instance
//     global._lgGlass.count()
//
// This exists mainly to settle "is the blur actually reaching the composite?"
// without a rebuild: glass.frag samples ONLY layer 1, so `blurResult: NULL`
// in the dump means the glass is showing the raw, unblurred capture.
const _liveEffects = new Set();
function _registerGlassDebugHooks() {
    const g = globalThis;
    if (!g.global || g.global._lgGlass)
        return;
    g.global._lgGlass = {
        count: () => _liveEffects.size,
        dump: () => {
            const rows = [];
            for (const fx of _liveEffects) {
                rows.push(fx._diagLast ? JSON.stringify(fx._diagLast) : '(never painted)');
            }
            const out = rows.length ? rows.join('\n') : '(no live LiquidEffect)';
            console.log(`[Liquid Glass][dump]\n${out}`);
            return out;
        },
    };
}
// ─── Main class ───────────────────────────────────────────────────────────────
export const LiquidEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {
    // Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
    static MAX_GLASS_REGIONS = 16;
    // ─── _init ──────────────────────────────────────────────────────────────────
    _init(params) {
        const extensionPath = params.extensionPath;
        const settings = params.settings;
        const logger = params.logger;
        delete params.extensionPath;
        delete params.settings;
        delete params.logger;
        super._init(params);
        this._blurTextures = [];
        this._blurFbos = [];
        this._gaussianTempTextures = [];
        this._gaussianTempFbos = [];
        this._upTextures = [];
        this._upFbos = [];
        this._blurResultTex = null;
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compositePipeline = null;
        this._compUniforms = new Map();
        this._pendingUniforms = new Map();
        this._compUniformArrays = new Map();
        this._pendingUniformArrays = new Map();
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
        this._downsampleSource = null;
        this._upsampleSource = null;
        this._glassSource = null;
        this._shadersLoaded = false;
        this._diagPaintCount = 0;
        this._diagLast = null;
        _liveEffects.add(this);
        _registerGlassDebugHooks();
        this._diagCompositedPaintCount = 0;
        this._diagLastPaintLogAt = 0;
        this._uvMismatchWarned = false;
        this._passPipelines = new Map();
        this._diagFirstPaintLogged = false;
        this._passPipelines = new Map();
        this._uvMismatchWarned = false;
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
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
        // Distinct from the small optical 'padding' uniform (20px, only
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
        // Rim/specular/sheen "glass surface glint" terms, gated together by
        // setSurfaceLightEnabled(). Defaults to enabled (1.0) so dock/menu/
        // notification/quick-settings/osd — which never call the setter — keep
        // their existing look unchanged. applicationManager.ts turns this off
        // for application windows, which should only show the outer drop
        // shadow and the inner AO darkening (both already independent of this
        // uniform — see the addedLight gating in glass.frag), not the
        // dock-style rim/specular/sheen highlight.
        this._setFloat('surface_light_enabled', 1.0);
        // Full-screen FBO mode: lets the shader know where the dock sits.
        this._setFloat('dock_x', 0.0);
        this._setFloat('dock_y', 0.0);
        this._setFloat('dock_w', 0.0);
        this._setFloat('dock_h', 0.0);
        // Multi-region compositing (Quick Settings "Toggles" apply-to mode).
        // Disabled by default so every other consumer (dock, menu, notification,
        // OSD, application, and Quick Settings' own "Background" mode) is
        // completely unaffected. See setMultiRegionMode()/setGlassRegions().
        this._setFloat('multi_region_mode', 0.0);
        this._setFloat('region_count', 0.0);
        this._setFloat('fast_mode', LiquidEffect.DRAG_PERF_MODE_ENABLED ? 1.0 : 0.0);
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
            // Inner edge AO darkening (independent of rim_width/shadow_radius).
            // ~7.5px matches the old rim_width*1.5-derived falloff at the default
            // rim_width of 5.0, so the look is unchanged until the user retunes it.
            this._setFloat('ao_intensity', 0.25);
            this._setFloat('ao_radius', 7.5);
            this._setFloat('tint_strength', 0.0);
            this._setFloat('tint_r', 1.0);
            this._setFloat('tint_g', 1.0);
            this._setFloat('tint_b', 1.0);
        }
        this._loadAllShadersAsync();
    }
    /**
    * Load all shader files asynchronously.
    */
    async _loadAllShadersAsync() {
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
            this._downsampleSource = await this._readFileAsync(`${this._extensionPath}/shaders/downsample.frag`);
            this._upsampleSource = await this._readFileAsync(`${this._extensionPath}/shaders/upsample.frag`);
            this._glassSource = await this._readFileAsync(`${this._extensionPath}/shaders/glass.frag`);
            this._shadersLoaded = true;
            const elapsedMs = (GLib.get_monotonic_time() - diagStart) / 1000;
            this._logger?.log(`[Liquid Glass][diag] LiquidEffect: async shader load finished in ${elapsedMs.toFixed(1)}ms, ` +
                `calling queue_repaint() now. If the on-screen black-background bug is still visible ` +
                `after this point, the shader load itself is not the (sole) cause -- the issue is in ` +
                `getting this repaint request actually flushed to the display.`);
            // 読み込み完了後に再描画をリクエストし、パイプラインを初期化させる
            this.queue_repaint();
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to load shaders asynchronously: ${e}`);
        }
    }
    /**
    * Gio.File を使ってファイルを非同期で読み込み、文字列として返すPromise関数
    */
    _readFileAsync(path) {
        return new Promise((resolve, reject) => {
            const file = Gio.File.new_for_path(path);
            file.load_contents_async(null, (_, res) => {
                try {
                    const [ok, bytes] = file.load_contents_finish(res);
                    if (!ok) {
                        reject(new Error(`load_contents_finish returned false for ${path}`));
                    }
                    else {
                        resolve(new TextDecoder('utf-8').decode(bytes));
                    }
                }
                catch (e) {
                    reject(e);
                }
            });
        });
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
        if (this._downsampleSource) {
            const downSnippet = this._splitShader(this._downsampleSource);
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, downSnippet.decl, null);
            s.set_replace(downSnippet.body);
            this._downsamplePipeline.add_snippet(s);
        }
        // ── Upsample pipeline ────────────────────────────────────────────────────
        this._upsamplePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._upsamplePipeline, 0);
        if (this._upsampleSource) {
            const upSnippet = this._splitShader(this._upsampleSource);
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
     * Splits a GLSL source string into { decl, body } at the "void main()" boundary.
     */
    _splitShader(src) {
        const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
        if (!match || match.index === undefined) {
            this._logger?.warn('[Liquid Glass] void main() not found; treating entire source as decl.');
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
        if (!this._compositePipeline || !this._glassSource)
            return;
        let { decl, body } = this._splitShader(this._glassSource);
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
                // [FIX round 12] Output target for this level (see _upTextures).
                const upTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
                const upFbo = Cogl.Offscreen.new_with_texture(upTex);
                this._upTextures.push(upTex);
                this._upFbos.push(upFbo);
            }
            catch (e) {
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
    _runDualKawaseBlur(parentNode, srcTex, srcUV) {
        let currentSrc = srcTex;
        // ── Downsample phase ────────────────────────────────────────────────────
        for (let i = 0; i < this.PASS_COUNT; i++) {
            const destFbo = this._blurFbos[i];
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
            const pipeline = this._passPipeline(`kawase-down-${i}`, this._downsamplePipeline);
            pipeline.set_layer_texture(0, currentSrc);
            this._setPipelineVec2(pipeline, 'inv_size', invW, invH);
            this._setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusDown);
            this._addPassNode(parentNode, destFbo, pipeline, destW, destH, uv);
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
            const destFbo = this._upFbos[i - 1];
            const destTex = this._upTextures[i - 1];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / srcTexture.get_width();
            const invH = 1.0 / srcTexture.get_height();
            const pipeline = this._passPipeline(`kawase-up-${i}`, this._upsamplePipeline);
            pipeline.set_layer_texture(0, srcTexture);
            this._setPipelineVec2(pipeline, 'inv_size', invW, invH);
            this._setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusUp);
            this._addPassNode(parentNode, destFbo, pipeline, destW, destH, [0, 0, 1, 1]);
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
    _runGaussianBlur(parentNode, srcTex, srcUV) {
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
        const prePipeline = this._passPipeline('gauss-pre', this._downsamplePipeline);
        prePipeline.set_layer_texture(0, srcTex);
        this._setPipelineVec2(prePipeline, 'inv_size', 1.0 / srcW, 1.0 / srcH);
        this._setPipelineFloat(prePipeline, 'blur_radius', 0.0);
        // [FIX] Sample only the valid sub-rect of the raw capture (see the
        // matching comment in _runDualKawaseBlur). The H/V passes below read
        // our own pool textures and keep the full 0..1 range.
        this._addPassNode(parentNode, destFbo, prePipeline, destW, destH, srcUV);
        // ── 1. Horizontal pass: destTex (half res) → tempTex (half res) ─────────
        // Input is already half-resolution, so inv_size uses destW/destH directly.
        const hPipeline = this._passPipeline('gauss-h', this._gaussianHPipeline);
        hPipeline.set_layer_texture(0, destTex);
        this._setPipelineVec2(hPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        this._setPipelineFloat(hPipeline, 'kernel_scale', this._gaussianScale);
        this._addPassNode(parentNode, tempFbo, hPipeline, destW, destH, [0, 0, 1, 1]);
        // ── 2. Vertical pass: tempTex (half res) → destTex (half res) ───────────
        // [FIX round 12] Writes into the separate output target rather than back
        // into destFbo. Going back would make destFbo depend on tempFbo while
        // tempFbo already depends on destFbo (the horizontal pass read destTex) —
        // the exact cycle Cogl rejects now that these passes are deferred nodes.
        const vPipeline = this._passPipeline('gauss-v', this._gaussianVPipeline);
        vPipeline.set_layer_texture(0, tempTex);
        this._setPipelineVec2(vPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        this._setPipelineFloat(vPipeline, 'kernel_scale', this._gaussianScale);
        const outFbo = this._upFbos[0];
        this._addPassNode(parentNode, outFbo, vPipeline, destW, destH, [0, 0, 1, 1]);
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
    _destroyTexturePool() {
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
            this._logger?.error(`[Liquid Glass] Failed to create crop texture (${w}x${h}): ${e}`);
            return false;
        }
    }
    /**
     * [FIX round 11] Node-based crop pass.
     *
     * Round 10 removed the crop entirely and expressed the capture's padding as
     * a UV sub-rect instead, which meant layer 0 (the raw capture) and layer 1
     * (a padding-free pool texture) needed different coordinate ranges in the
     * composite. That required Clutter.PaintNode.add_multitexture_rectangle(),
     * which is NOT safely callable from GJS on this build: its introspection
     * annotation types text_coords as a plain number rather than an array, so
     * passing an array makes the native side read a JS object as a float
     * pointer. That is what crashed the shell with SIGSEGV.
     *
     * (Note Cogl.Framebuffer.draw_multitextured_rectangle IS annotated
     * correctly — only the Clutter PaintNode variant is broken, so the fix
     * cannot simply mirror the old immediate-mode call.)
     *
     * So the crop comes back, but as a paint node like every other pass. The
     * original reason for removing it — that its intermediate FBO served
     * last frame's content — no longer applies: that was never about the crop
     * itself, it was about immediate-mode drawing running before the capture
     * had been rendered. As a node it executes after the capture, so it reads
     * current content.
     *
     * With a padding-free full-resolution texture available again, every
     * downstream consumer (blur input and both composite layers) uses the plain
     * 0..1 range, and no multitexture coordinates are needed anywhere.
     *
     * Costs one full-resolution pass per frame per window. If that ever matters,
     * the way to avoid it is a per-layer texture matrix
     * (Cogl.Pipeline.set_layer_matrix) on layer 0, which would let the padding
     * be expressed without either an extra pass or multitexture coordinates —
     * worth trying only once the current path is confirmed correct.
     */
    _addCropPassNode(parentNode, ctx, srcTex, srcW, srcH, allocW, allocH, uv) {
        if (allocW === srcW && allocH === srcH)
            return srcTex;
        if (!this._downsamplePipeline)
            return srcTex;
        if (!this._ensureCropTarget(ctx, allocW, allocH))
            return srcTex;
        const pipeline = this._passPipeline('crop', this._downsamplePipeline);
        pipeline.set_layer_texture(0, srcTex);
        this._setPipelineVec2(pipeline, 'inv_size', 1.0 / srcW, 1.0 / srcH);
        // blur_radius = 0 collapses every tap in the 5-tap kernel onto the center
        // sample, turning this into a plain UV resample (i.e. a crop).
        this._setPipelineFloat(pipeline, 'blur_radius', 0.0);
        this._addPassNode(parentNode, this._cropFbo, pipeline, allocW, allocH, uv);
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
        // ── [DIAG] Black-background investigation ──────────────────────────────
        // If Clutter culls/skips this actor entirely (e.g. because it decides
        // it's fully occluded by the window content painted above it), this
        // function never runs at all -- which would show up here as a call count
        // that never advances past whatever it was when the window opened, even
        // though _frameTick keeps calling set_size()/queue_redraw() at 60fps.
        this._diagPaintCount++;
        {
            const now = GLib.get_monotonic_time();
            const actorTitle = (() => {
                try {
                    const a = this.get_actor();
                    return a?.get_meta_window?.()?.get_title?.() ?? a?.get_name?.() ?? '?';
                }
                catch (e) {
                    return '?';
                }
            })();
            if (!this._diagFirstPaintLogged) {
                this._diagFirstPaintLogged = true;
                this._diagLastPaintLogAt = now;
                this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: FIRST call for "${actorTitle}" ` +
                    `(paintCount=${this._diagPaintCount}, shadersLoaded=${this._shadersLoaded})`);
            }
            else if (now - this._diagLastPaintLogAt > 2000 * 1000) {
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
        if (!this._compositePipeline) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._initPipelines(ctx);
            }
            catch (e) {
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
                this._logger?.error(`[Liquid Glass] Failed to build Gaussian pipelines: ${e}`);
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
        // ── Handle the capture's padding ────────────────────────────────────────
        //
        // get_texture() is sized to the actor's PAINT BOX, not its allocation, so
        // it carries a few pixels of padding (measured: 964x563 capture for a
        // 961x560 actor). computeCaptureLayout() derives exactly where the actor's own
        // pixels sit inside that padded texture, and where the composite quad has
        // to be drawn so it lands back on the actor. See that function (utils.ts)
        // for why the padding is NOT centred and why the draw rect is not
        // (0, 0, w, h).
        let effectiveTex = srcTex;
        const effectiveW = allocW;
        const effectiveH = allocH;
        const layout = computeCaptureLayout(actor, srcW, srcH, effectiveW, effectiveH);
        const srcUV = layout.uv;
        // [FIX round 11] Queue the crop as a node pass. Everything downstream
        // then works on a padding-free, full-resolution texture and uses the
        // plain 0..1 range — no multitexture coordinates anywhere.
        if (srcW !== effectiveW || srcH !== effectiveH) {
            try {
                const cropCtx = this._getCoglContext();
                if (cropCtx) {
                    effectiveTex = this._addCropPassNode(_paintNode, cropCtx, srcTex, srcW, srcH, effectiveW, effectiveH, srcUV);
                }
            }
            catch (e) {
                this._logger?.error(`[Liquid Glass] Crop pass node failed; continuing with the padded texture: ${e}`);
            }
        }
        // Whether the crop actually ran decides the range every later pass uses:
        // the cropped texture is padding-free (0..1), the raw capture is not.
        const inputUV = (effectiveTex === srcTex) ? srcUV : [0, 0, 1, 1];
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
                this._logger?.error(`[Liquid Glass] Failed to rebuild the texture pool: ${e}`);
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
        this._blurResultTex = null;
        if (this.PASS_COUNT > 0) {
            if (this._blurMethod === 0) {
                if (this._gaussianHPipeline && this._gaussianVPipeline) {
                    this._runGaussianBlur(_paintNode, effectiveTex, inputUV);
                }
            }
            else {
                this._runDualKawaseBlur(_paintNode, effectiveTex, inputUV);
            }
        }
        // ─────────────────────────────────────────────────────────────────────
        // Final pass: glass composite.
        //   Binds _blurTextures[0] (blurred, w/2 × h/2) as cogl_sampler0 and runs
        //   glass.frag (refraction / rim lighting / shadow) to draw onto the screen.
        //
        //   Clutter has already set up the actor's model-view transform on
        //   screenFb — but with the capture's FBO offset folded in, so this
        //   space is measured in capture TEXELS from the texture's top-left
        //   corner, not in actor-local pixels from the actor's. The rect to draw
        //   is therefore layout.dest, not (0, 0, effectiveW, effectiveH); see
        //   computeCaptureLayout() in utils.ts.
        // ─────────────────────────────────────────────────────────────────────
        const compFb = paintContext.get_framebuffer();
        const compPipeline = this._compositePipeline;
        // Layer 0: the sharp, unblurred capture (used as the basis for refraction).
        // Using the cropped texture means UV (0,0)-(1,1) lines up exactly with
        // the actor's logical size.
        compPipeline.set_layer_texture(0, effectiveTex);
        this._configureSamplerLayer(compPipeline, 0);
        // [FIX] Layer 0 is now the RAW capture rather than a cropped copy, so it
        // must be sampled over srcUV. Layer 1 (below) is one of our own pool
        // textures, which is already padding-free and uses the full 0..1 range —
        // hence the per-layer coordinates at the draw call.
        const layer0UV = inputUV;
        // Layer 1: the heavily blurred texture (used for the background blur).
        // Falls back to effectiveTex when no blur pass ran.
        let layer1UV;
        // [FIX round 12] The finished blur no longer always lands in
        // _blurTextures[0]; whichever runner executed records its output here.
        if (this.PASS_COUNT > 0 && this._blurResultTex) {
            compPipeline.set_layer_texture(1, this._blurResultTex);
            layer1UV = [0, 0, 1, 1];
        }
        else {
            // No blur ran, so layer 1 falls back to the same raw capture as
            // layer 0 and therefore needs the same sub-rect.
            compPipeline.set_layer_texture(1, effectiveTex);
            layer1UV = inputUV;
        }
        this._configureSamplerLayer(compPipeline, 1);
        // Manually sync pending uniforms into the composite pipeline.
        // Without this, values like dock_x would stay at 0 and the whole screen
        // would be misdetected as being inside the dock mask.
        this._applyPendingUniforms();
        // [FIX] Feed the actor's real, cascaded paint opacity into the pipeline
        // color used for the final draw. glass.frag's very last line already
        // does `cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;`
        // — i.e. it was ALWAYS ready to respect the actor's opacity — but
        // nothing on the JS/Cogl side was ever setting this pipeline's color,
        // so Cogl defaulted it to opaque white (255,255,255,255) and that
        // multiply was a permanent no-op. get_paint_opacity() (rather than the
        // actor's own local .opacity) is used because it already returns the
        // value cascaded through the actor's ancestors, so a child of an
        // animating windowActor fades correctly without any extra plumbing.
        //
        // IMPORTANT — this must be (op, op, op, op), NOT (255, 255, 255, op):
        // finalRgb is already PREMULTIPLIED by the shape's own alpha (see
        // `finalRgb = litColor * alpha + shadowColor * shadowContribution`
        // above). Fading premultiplied color by an additional opacity factor
        // requires scaling BOTH the color and the alpha by that same factor —
        // `vec4(finalRgb, finalAlpha) * vec4(1,1,1,op)` only scales alpha and
        // leaves finalRgb at full brightness, which breaks the premultiplied
        // invariant (rgb should never exceed alpha) and — combined with the
        // ADD-based premultiplied blend function above — reads as abnormally
        // bright/washed-out at any opacity below 255, exactly matching the
        // "glass looks way too bright while the window is fading" symptom seen
        // during open/close animations. Scaling all four channels by the same
        // factor keeps it correctly premultiplied at every opacity level.
        const paintOpacity = actor ? actor.get_paint_opacity() : 255;
        const color = new Cogl.Color();
        const paintOpacity_f = paintOpacity / 255;
        color.init_from_4f(paintOpacity_f, paintOpacity_f, paintOpacity_f, paintOpacity_f);
        this._compositePipeline.set_color(color);
        // [FIX round 10] The push_matrix()/pop_matrix() pair that used to wrap
        // this draw is gone: nothing modified the matrix between them (so it was
        // already a no-op), and now that the draw is queued as a node rather than
        // issued here, bracketing immediate framebuffer state around it would not
        // affect it anyway. The node inherits the actor's model-view transform
        // from the paint context at execution time, which is what positions it.
        // [FIX round 13] The draw rect is layout.dest, NOT (0, 0, w, h).
        // vfunc_paint_target runs inside the transform node ClutterOffscreenEffect
        // wraps around it, whose translation is the capture's own FBO offset —
        // i.e. the coordinate space here has its origin at the capture texture's
        // top-left corner, not at the actor's. Drawing at (0, 0) therefore put
        // the whole glass ~2-3px up and to the left of the actor. See
        // computeCaptureLayout() in utils.ts for how the correct rect is derived.
        this._addCompositeNode(_paintNode, layout.dest, layer0UV, layer1UV);
        this._diagCompositedPaintCount++;
        // [DIAG] "Blur is not visible — the background inside the glass stays
        // sharp — but changing the blur radius does change the look, and
        // refraction works." glass.frag reads ONLY cogl_sampler1 for the body
        // (cogl_sampler0 and blur_strength are declared but unused), so a sharp
        // body means layer 1 is bound to something sharp — which happens exactly
        // when _blurResultTex is null and the fallback below binds the raw
        // capture. This records the state that decides it, per instance, for
        // global._lgGlass.dump().
        this._diagLast = {
            actor: (() => { try {
                return this.get_actor()?.get_name?.() ?? '?';
            }
            catch (e) {
                return '?';
            } })(),
            src: `${srcW}x${srcH}`,
            alloc: `${allocW}x${allocH}`,
            uv: layout.uv.map(v => +v.toFixed(5)),
            dest: layout.dest.map(v => +v.toFixed(2)),
            cropRan: effectiveTex !== srcTex,
            blurMethod: this._blurMethod,
            passCount: this.PASS_COUNT,
            pool: `${this._poolWidth}x${this._poolHeight}`,
            poolLevels: this._blurFbos.length,
            blurResult: (() => {
                const t = this._blurResultTex;
                return t ? `${t.get_width()}x${t.get_height()}`
                    : 'NULL (layer 1 falls back to the SHARP capture)';
            })(),
            radiusDown: this._blurRadiusDown,
            radiusUp: this._blurRadiusUp,
            targetRadius: this._targetRadius,
            gaussianPipelines: !!(this._gaussianHPipeline && this._gaussianVPipeline),
            paintOpacity,
            paints: this._diagPaintCount,
        };
    }
    /**
     * [FIX round 10] Returns a private copy of `base` dedicated to one pass.
     *
     * Immediate-mode drawing let every pass share one pipeline object: set the
     * uniforms, draw, then overwrite the uniforms for the next pass. Paint
     * nodes execute AFTER vfunc_paint_target returns, so a shared pipeline
     * would have every pass drawn with whatever uniform values the LAST pass
     * happened to leave behind. Each pass therefore needs its own pipeline.
     *
     * Cogl pipelines are copy-on-write, so the copies are cheap, and they are
     * cached and only re-copied when the base pipeline object itself is
     * replaced (which is what happens when a shader is recompiled — a radius
     * change that only updates kernel_scale keeps the same object, and the
     * uniform is set on the copy every frame anyway).
     *
     * Blending is forced to plain replace so each pass overwrites its target
     * rather than compositing onto the previous frame's contents. The
     * immediate-mode code got that from an explicit clear before every draw;
     * a LayerNode does no clearing, and since every pass covers its whole
     * target rect, replace-blending achieves the same result without one.
     */
    _passPipeline(key, base) {
        const cached = this._passPipelines.get(key);
        if (cached && cached.base === base)
            return cached.copy;
        const copy = base.copy();
        try {
            copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] set_blend failed for pass '${key}': ${e}`);
        }
        this._passPipelines.set(key, { base, copy });
        return copy;
    }
    /**
     * [FIX round 10] Queues one render-to-texture pass as a paint node instead
     * of drawing it immediately.
     *
     * This is the core of the drag-lag fix. vfunc_paint_target() runs while the
     * paint node tree is being BUILT; ClutterOffscreenEffect renders the actor
     * into its capture texture when that tree is later EXECUTED. Immediate-mode
     * Cogl calls therefore sampled the capture before it had been drawn for
     * this frame, yielding the previous frame's contents — the one-frame lag.
     *
     * Adding the pass as a child of the effect's node instead makes it execute
     * after the capture layer node that OffscreenEffect already put there, so
     * it samples this frame's content. The projection is set on the target
     * framebuffer here; that is persistent framebuffer state rather than a
     * queued operation, so setting it at build time is fine.
     */
    _addPassNode(parentNode, targetFbo, pipeline, destW, destH, uv) {
        targetFbo.orthographic(0, 0, destW, destH, -1, 1);
        const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
        parentNode.add_child(layerNode);
        const drawNode = Clutter.PipelineNode.new(pipeline);
        layerNode.add_child(drawNode);
        drawNode.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }), uv[0], uv[1], uv[2], uv[3]);
    }
    /**
     * [FIX] Queues the final composite as a paint node.
     *
     * It has to be a node, like every other pass, so it executes after the
     * capture layer node and after the blur passes queued above it. Immediate
     * drawing here only looked correct because Cogl happened to defer it far
     * enough — adding a single flush() was enough to reproduce the same
     * one-frame lag on this path too.
     *
     * Both layers share one coordinate range by construction: the crop pass
     * guarantees layer 0 is padding-free whenever layer 1 is, so
     * add_texture_rectangle is sufficient. This deliberately does NOT use
     * add_multitexture_rectangle — see _addCropPassNode() for why that call
     * segfaults the shell on this build.
     */
    _addCompositeNode(parentNode, dest, layer0UV, layer1UV) {
        if (layer0UV[0] !== layer1UV[0] || layer0UV[1] !== layer1UV[1] ||
            layer0UV[2] !== layer1UV[2] || layer0UV[3] !== layer1UV[3]) {
            // Should be unreachable: the crop pass exists precisely so the two
            // layers always agree. Log once rather than silently misdrawing, since
            // the only remedy available here is to favour layer 0.
            if (!this._uvMismatchWarned) {
                this._uvMismatchWarned = true;
                this._logger?.error('[Liquid Glass] composite layers disagree on UV range ' +
                    `(layer0=[${layer0UV}] layer1=[${layer1UV}]); drawing with layer 0's range. ` +
                    'This means the crop pass did not run when it was needed.');
            }
        }
        const drawNode = Clutter.PipelineNode.new(this._compositePipeline);
        parentNode.add_child(drawNode);
        drawNode.add_texture_rectangle(new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }), layer0UV[0], layer0UV[1], layer0UV[2], layer0UV[3]);
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
        for (const [name, values] of this._pendingUniformArrays) {
            this._applyUniformArray(name, values);
        }
    }
    /**
     * Sets a float ARRAY uniform on the composite pipeline (e.g.
     * `uniform float region_x[16];` in glass.frag). Same buffering behavior as
     * _setFloat(): if the pipeline hasn't been created yet, the value is
     * buffered and applied later in _applyPendingUniforms().
     */
    _setFloatArray(name, values) {
        this._pendingUniformArrays.set(name, values);
        if (this._compositePipeline) {
            this._applyUniformArray(name, values);
        }
    }
    _applyUniformArray(name, values) {
        if (!this._compositePipeline)
            return;
        let loc = this._compUniformArrays.get(name);
        if (loc === undefined) {
            loc = this._compositePipeline.get_uniform_location(name);
            this._compUniformArrays.set(name, loc);
        }
        // set_uniform_float(loc, 1 component, count elements, values[])
        this._compositePipeline.set_uniform_float(loc, 1, values.length, values);
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
            this._logger?.error(`[Liquid Glass] Failed to obtain the Cogl context: ${e}`);
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
            // Inner edge AO darkening — independent of rim_width and of the
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
        _liveEffects.delete(this);
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
        this._compUniformArrays.clear();
        this._pendingUniformArrays.clear();
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
    setSurfaceLightEnabled(enabled) {
        this._setFloat('surface_light_enabled', enabled ? 1.0 : 0.0);
        this.queue_repaint();
    }
    setPadding(pad) {
        this._setFloat('padding', pad);
    }
    /**
     * Tells the shader how much room (in px) the drop shadow actually
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
        this._compUniformArrays.clear();
        // _pendingUniforms/_pendingUniformArrays are intentionally left intact:
        // they hold every uniform value currently in effect, and
        // _initPipelines() re-applies all of them to the freshly-compiled
        // pipeline via _applyPendingUniforms().
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
    // Sets the flat fallback fill composited underneath the glass/shadow
    // result, for areas outside every glass region — see glass.frag's
    // panel_bg_* uniforms for the full rationale. Pass alpha = 0 (the
    // default) to disable it entirely.
    setPanelBackgroundColor(r, g, b, a) {
        this._setFloat('panel_bg_r', r);
        this._setFloat('panel_bg_g', g);
        this._setFloat('panel_bg_b', b);
        this._setFloat('panel_bg_a', a);
        this.queue_repaint();
    }
    // [FIX] The panel's REAL widget bounds (monitor-relative px, no
    // SHADER_PADDING/CLIP_PADDING/glassExpand) — masks
    // setPanelBackgroundColor()'s fallback fill to this rect in glass.frag so
    // it can't bleed into the sampling-headroom margin around bgActor. See
    // the panel_rect_* uniform comments in glass.frag for the full
    // rationale. Harmless to call regardless of panel_bg_a.
    setPanelRect(x, y, w, h) {
        this._setFloat('panel_rect_x', x);
        this._setFloat('panel_rect_y', y);
        this._setFloat('panel_rect_w', w);
        this._setFloat('panel_rect_h', h);
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
    /**
     * Enables/disables multi-region compositing mode (see glass.frag's
     * multi_region_mode uniform). When enabled, setGlassRegions() draws up to
     * MAX_GLASS_REGIONS independent small rounded-rect "windows" instead of
     * the single dock_x/y/w/h rect. Used by Quick Settings' "Toggles"
     * apply-to mode; every other consumer leaves this at its default (false)
     * and is completely unaffected.
     */
    setMultiRegionMode(enabled) {
        this._setFloat('multi_region_mode', enabled ? 1.0 : 0.0);
        this.queue_repaint();
    }
    // [PERF] "Window background rendering gets noticeably more expensive
    // (CLUTTER_SHOW_FPS: per-frame paint time roughly triples, ~1.8ms ->
    // ~5-6ms, though FPS itself stays near 60) the moment a window is open,
    // and moving it is the worst case." Single master switch for every
    // drag-time cost-reduction change below — false keeps current behavior
    // byte-for-byte; only flip to true to test the combined effect. Flip
    // this one line, nothing else, to compare.
    static DRAG_PERF_MODE_ENABLED = true;
    beginBatch() {
        if (!LiquidEffect.DRAG_PERF_MODE_ENABLED)
            return;
        this._batchDepth = (this._batchDepth || 0) + 1;
    }
    endBatch() {
        if (!LiquidEffect.DRAG_PERF_MODE_ENABLED)
            return;
        if (!this._batchDepth)
            return; // beginBatch() was never called, or the flag flipped mid-batch
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
    queue_repaint() {
        if (LiquidEffect.DRAG_PERF_MODE_ENABLED && this._batchDepth) {
            this._batchDirty = true;
            return;
        }
        // @ts-ignore
        super.queue_repaint();
    }
    /**
     * [PERF] See DRAG_PERF_MODE_ENABLED above and glass.frag's fast_mode
     * uniform: swaps the 4-tap numerical height-gradient estimate for a
     * 2-tap one using an analytically-known SDF gradient direction, and
     * skips the outer drop-shadow result. No-op (uniform stays 0) unless the
     * master flag is also on — callers (applicationManager.ts) can call this
     * unconditionally every frame regardless of the flag's state.
     */
    setFastMode(enabled) {
        const value = (LiquidEffect.DRAG_PERF_MODE_ENABLED && enabled) ? 1.0 : 0.0;
        this._setFloat('fast_mode', value);
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
    setGlassRegions(regions) {
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
        this._setFloat('region_count', clamped.length);
        this._setFloatArray('region_x', rx);
        this._setFloatArray('region_y', ry);
        this._setFloatArray('region_w', rw);
        this._setFloatArray('region_h', rh);
        this._setFloatArray('region_tint_r', rTintR);
        this._setFloatArray('region_tint_g', rTintG);
        this._setFloatArray('region_tint_b', rTintB);
        this._setFloatArray('region_base_strength', rBaseStrength);
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
        // Number of one-sided taps needed to satisfy the 4-sigma rule (changed from 3
        // to prevent abrupt truncation ringing/grid artifacts at integer multiples),
        // converted to fetch pairs (2 taps per fetch). At least 2 pairs (5-tap equivalent)
        // are guaranteed so bilinear-downsample aliasing is reliably absorbed.
        const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
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
