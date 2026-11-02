import Cogl from 'gi://Cogl';
import { BlurRenderer, ShaderPipelines, configureSamplerLayer, SHAPE_LAYER, RenderPasses } from './pipelines.js';
import { setUniformArray } from '../shellVersion.js';
import { hexToColorArray } from '../animation.js';
// Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
export const MAX_GLASS_REGIONS = 16;
const ATTACHED_EDGES = ['none', 'top', 'bottom', 'left', 'right'];
// Must match glass.frag's `#define MAX_GLASS_GROWTHS 2`.
export const MAX_GLASS_GROWTHS = 2;

/**
 * What every glass draws with, whatever supplies its backdrop: the shader
 * pipelines, the blur, the uniforms and the settings bound to them. The owner
 * decides when to repaint (`repaint` is called when a uniform changed) and
 * where the backdrop texture comes from.
 */
export class GlassRenderer {
    passes;
    pipelines;
    blur;
    uniforms;
    geometry;
    material;
    _outline = null;
    _repaint;
    _shapeTexture = null;

    constructor(params) {
        this._repaint = params.repaint;
        this.passes = new RenderPasses();
        this.pipelines = new ShaderPipelines(params.logger, params.shapeTexture ?? false);
        this.blur = new BlurRenderer(this.pipelines, this.passes, () => this._repaint());
        this.uniforms = new UniformState();
        this.geometry = new GlassGeometry(this.uniforms.values);
        this.material = new MaterialSettings(params.settings, this.uniforms, this.blur, params.setDiagnostics, () => this._repaintIfDirty());
        this.material.initialize();
        if (params.settings && params.outline) {
            this._outline = new OutlineBinding(params.settings, params.outline, this.uniforms, () => this._repaintIfDirty());
            this._outline.initialize();
        }
    }

    // Compiles the pipelines on the first paint, once a Cogl context exists,
    // and a tap-count change from setBlurRadius() afterwards.
    prepare(ctx) {
        if (!this.pipelines.composite) {
            this.pipelines.initialize(ctx);
            this.uniforms.attach(this.pipelines.composite);
        }
        if (this.blur.needsCompile)
            this.blur.compilePending(ctx);
    }

    /**
     * Binds the backdrop for glass.frag: the blurred one, or `unblurredTex`
     * when there is no blur. Both hold `blurRect`, the part of the glass the
     * backdrop was copied for, in shader space.
     */
    bindBackdrop(unblurredTex, blurRect) {
        const compPipeline = this.pipelines.composite;
        const haveBlur = this.blur.passCount > 0 && this.blur.result !== null;
        this.uniforms.set('blur_rect_x', blurRect[0]);
        this.uniforms.set('blur_rect_y', blurRect[1]);
        this.uniforms.set('blur_rect_w', blurRect[2]);
        this.uniforms.set('blur_rect_h', blurRect[3]);
        // Both layers get the same texture, so one UV range fits both. glass.frag
        // samples only layer 1; if it ever read layer 0 separately, the layers
        // would need their own ranges.
        const layerTex = haveBlur ? this.blur.result : unblurredTex;
        // The blur is magnified from half or quarter resolution; glass.frag needs
        // its real size to reconstruct it smoothly.
        this.uniforms.set('blur_tex_w', layerTex.get_width());
        this.uniforms.set('blur_tex_h', layerTex.get_height());
        compPipeline.set_layer_texture(0, layerTex);
        configureSamplerLayer(compPipeline, 0);
        compPipeline.set_layer_texture(1, layerTex);
        configureSamplerLayer(compPipeline, 1);
        if (this._shapeTexture) {
            compPipeline.set_layer_texture(SHAPE_LAYER, this._shapeTexture);
            configureSamplerLayer(compPipeline, SHAPE_LAYER);
        }
        // Uniforms set before the pipeline existed are written now.
        this.uniforms.flush();
    }

    /**
     * Queues glass.frag over `drawRect` [x1, y1, x2, y2]. glass.frag multiplies
     * its premultiplied output by the pipeline color, so fading means scaling
     * all four channels by the paint opacity (which already includes the
     * ancestors'); scaling alpha alone would wash the glass out.
     */
    addComposite(node, drawRect, drawUV, paintOpacity) {
        const color = new Cogl.Color();
        const opacity = paintOpacity / 255;
        color.init_from_4f(opacity, opacity, opacity, opacity);
        this.pipelines.composite.set_color(color);
        this.passes.composite(node, this.pipelines.composite, drawRect, drawUV);
    }

    // Rebuilds the pipelines on the next paint, for shader development. The
    // buffered uniforms are kept and re-applied to the new pipeline.
    reloadShaders() {
        this.pipelines.clear();
        this.uniforms.attach(null);
        this.blur.reload();
        this._repaint();
    }

    cleanup() {
        this._shapeTexture = null;
        this._outline?.clear();
        this._outline = null;
        this.material.clear();
        // Dropping the references frees the textures and pipelines; GJS owns them.
        this.blur.clear();
        this.passes.clear();
        this.pipelines.clear();
        this.uniforms.clear();
    }

    _repaintIfDirty() {
        if (this.uniforms.takeDirty())
            this._repaint();
    }

    getResolution() {
        return [
            this.uniforms.values.get('resolution_x') ?? 0,
            this.uniforms.values.get('resolution_y') ?? 0,
        ];
    }

    setBlurRectEnabled(enabled) {
        this.geometry.blurEnabled = enabled;
        // The pool is sized for the old rect.
        this.blur.invalidate();
        this._repaint();
    }

    setCompositeRectEnabled(enabled) {
        this.geometry.compositeEnabled = enabled;
        this._repaint();
    }

    setEdgeTapsEnabled(enabled) {
        this.uniforms.set('edge_taps_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setEarlyExitEnabled(enabled) {
        this.uniforms.set('early_exit_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setDebugView(mode) {
        this.uniforms.set('debug_view', mode);
        this._repaintIfDirty();
    }

    setIsDock(isDock) {
        this.uniforms.set('isDock', isDock ? 1.0 : 0.0);
    }

    setSurfaceLightEnabled(enabled) {
        this.uniforms.set('surface_light_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setCornerSmoothingEnabled(enabled) {
        this.uniforms.set('corner_smoothing_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setPadding(pad) {
        this.uniforms.set('padding', pad);
    }

    setShadowMaxRadius(radius) {
        this.uniforms.set('shadow_max_radius', radius);
    }

    setBlurMethod(method) {
        this.blur.setBlurMethod(method);
    }

    setBlurRadius(radius) {
        this.blur.setBlurRadius(radius);
    }

    setTintColor(r, g, b) {
        this.uniforms.set('tint_r', r);
        this.uniforms.set('tint_g', g);
        this.uniforms.set('tint_b', b);
        this._repaintIfDirty();
    }

    setTintStrength(strength) {
        this.uniforms.set('tint_strength', strength);
        this._repaintIfDirty();
    }

    setCornerRadius(radius) {
        this.uniforms.set('corner_radius', radius);
        this._repaintIfDirty();
    }

    /** Grows the glass out of `edge`, flaring into it with fillets of `radius` px. */
    setAttachedEdge(edge, radius) {
        this.uniforms.set('attach_edge', ATTACHED_EDGES.indexOf(edge));
        this.uniforms.set('attach_radius', Math.max(radius, 0));
        this._repaintIfDirty();
    }

    /** Joins `growths` (the first MAX_GLASS_GROWTHS) to the glass through concave fillets of `fillet` px. */
    setGrowths(growths, fillet) {
        const used = growths.slice(0, MAX_GLASS_GROWTHS);
        const slot = (pick) => Array.from({ length: MAX_GLASS_GROWTHS }, (_, i) => (used[i] ? pick(used[i]) : 0));
        this.uniforms.set('grow_count', used.length);
        this.uniforms.set('grow_fillet', Math.max(fillet, 0));
        this.uniforms.setArray('grow_x', slot(g => g.x));
        this.uniforms.setArray('grow_y', slot(g => g.y));
        this.uniforms.setArray('grow_w', slot(g => g.w));
        this.uniforms.setArray('grow_h', slot(g => g.h));
        this.uniforms.setArray('grow_r', Array.from({ length: MAX_GLASS_GROWTHS * 4 }, (_, i) => Math.max(used[Math.floor(i / 4)]?.radii[i % 4] ?? 0, 0)));
        this.geometry.growths = used.map(g => [g.x, g.y, g.w, g.h]);
        this._repaintIfDirty();
    }

    setAnimationScale(scale) {
        if (this.material.setAnimationScale(scale))
            this._repaintIfDirty();
    }

    setResolution(width, height) {
        this.uniforms.set('resolution_x', width);
        this.uniforms.set('resolution_y', height);
        this._repaintIfDirty();
    }

    setGlassGeometry(x, y, w, h) {
        this.uniforms.set('dock_x', x);
        this.uniforms.set('dock_y', y);
        this.uniforms.set('dock_w', w);
        this.uniforms.set('dock_h', h);
        this.geometry.rect[0] = x;
        this.geometry.rect[1] = y;
        this.geometry.rect[2] = w;
        this.geometry.rect[3] = h;
        this._repaintIfDirty();
    }

    /**
     * The distance field a shape-texture glass takes its outline from: it covers
     * the glass rect, holds `range` px each way, and the lens rises over `band`
     * px from the edge.
     */
    setShapeTexture(texture, range, band) {
        this._shapeTexture = texture;
        this.uniforms.set('shape_range', range);
        this.uniforms.set('shape_band', band);
        this.uniforms.takeDirty();
        this._repaint();
    }

    setMultiRegionMode(enabled) {
        this.uniforms.set('multi_region_mode', enabled ? 1.0 : 0.0);
        this.geometry.multiRegion = enabled;
        this._repaintIfDirty();
    }

    setGlassRegions(regions) {
        const clamped = regions.slice(0, MAX_GLASS_REGIONS);
        const rx = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const ry = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const rw = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const rh = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const rTintR = new Array(MAX_GLASS_REGIONS).fill(1.0);
        const rTintG = new Array(MAX_GLASS_REGIONS).fill(1.0);
        const rTintB = new Array(MAX_GLASS_REGIONS).fill(1.0);
        const rBaseStrength = new Array(MAX_GLASS_REGIONS).fill(0.0);
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
        this.geometry.regions = clamped.map(r => [r.x, r.y, r.w, r.h]);
        this.uniforms.set('region_count', clamped.length);
        this.uniforms.setArray('region_x', rx);
        this.uniforms.setArray('region_y', ry);
        this.uniforms.setArray('region_w', rw);
        this.uniforms.setArray('region_h', rh);
        this.uniforms.setArray('region_tint_r', rTintR);
        this.uniforms.setArray('region_tint_g', rTintG);
        this.uniforms.setArray('region_tint_b', rTintB);
        this.uniforms.setArray('region_base_strength', rBaseStrength);
        this._repaintIfDirty();
    }

    setBrightness(brightness) {
        this.uniforms.set('brightness', brightness);
        this._repaintIfDirty();
    }

    setContrast(contrast) {
        this.uniforms.set('contrast', contrast);
        this._repaintIfDirty();
    }

    setSaturation(saturation) {
        this.uniforms.set('saturation', saturation);
        this._repaintIfDirty();
    }
}

export class GlassGeometry {
    _uniforms;

    constructor(_uniforms) {
        this._uniforms = _uniforms;
        this.blurEnabled = GlassGeometry.USE_BLUR_RECT;
        this.compositeEnabled = GlassGeometry.USE_COMPOSITE_RECT;
    }

    // The glass rect [x, y, w, h] last given to the shader, in the space of
    // setResolution()/setGlassGeometry().
    rect = [0, 0, 0, 0];
    regions = [];
    multiRegion = false;
    // The menus grown out of the glass, [x, y, w, h] without padding (setGrowths()).
    growths = [];
    // Per-instance switches (global._lgGlass.blurRect()/compositeRect()).
    blurEnabled;
    compositeEnabled;
    // Copy and blur only the part of the backdrop the glass can sample.
    static USE_BLUR_RECT = true;
    // Must match EDGE_LENS_REACH in glass.frag (the refraction's maximum
    // displacement), or the rim samples past the blurred region and streaks.
    static EDGE_LENS_REACH = 96;
    static EDGE_FOOTPRINT_SPREAD = 0.9 * 32;
    // Extra margin for the edge feather, the 4-tap RGSS spread and rounding.
    static BLUR_RECT_MIN_MARGIN = 12;
    // A rect covering more than this share of the actor saves nothing. Kept
    // close to 1 so application windows (around 0.8) still benefit.
    static BLUR_RECT_MIN_SAVING = 0.95;
    // The texture pool is keyed on the rect's size, so the size is rounded up
    // to this quantum; otherwise an opening menu would reallocate the pool
    // every frame.
    static BLUR_RECT_QUANTUM = 64;
    // Run glass.frag only where it can draw something: the glass body and the
    // drop shadow's reach. Everywhere else the source is fully transparent,
    // which the premultiplied "over" blend leaves unchanged, so skipping those
    // pixels changes nothing. Refraction moves where a pixel samples, not where
    // it is drawn, so no refraction margin is needed.
    static USE_COMPOSITE_RECT = true;
    static COMPOSITE_RECT_MIN_SAVING = 0.95;

    /**
     * The rect [x, y, w, h] (shader space) the composite has to cover, or null
     * for the whole actor. glass.frag draws no shadow beyond
     * min(shadow_radius, max(shadow_max_radius, 5)) from the body, and none in
     * multi-region mode.
     */
    compositeRect() {
        if (!this.compositeEnabled)
            return null;
        // Debug views are easier to read unclipped.
        if ((this._uniforms.get('debug_view') ?? 0) > 0.5)
            return null;
        const resW = this._uniforms.get('resolution_x') ?? 0;
        const resH = this._uniforms.get('resolution_y') ?? 0;
        if (!(resW >= 1) || !(resH >= 1))
            return null;
        const body = this._glassBodyUnion();
        if (!body)
            return null;
        let [x0, y0, x1, y1] = body;
        const shadowMax = Math.max(this._uniforms.get('shadow_max_radius') ?? 0, 5);
        const shadowRadius = Math.max(this._uniforms.get('shadow_radius') ?? 0, 0);
        const shadowIntensity = this._uniforms.get('shadow_intensity') ?? 0;
        const reach = (this.multiRegion || !(shadowIntensity > 0))
            ? 0
            : Math.min(shadowRadius, shadowMax);
        // The feather widens the body; the rim and AO lie inside it.
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const m = Math.ceil(reach + feather + 2);
        x0 -= m;
        y0 -= m;
        x1 += m;
        y1 += m;
        const maxW = Math.round(resW);
        const maxH = Math.round(resH);
        const bx = Math.max(0, Math.floor(x0));
        const by = Math.max(0, Math.floor(y0));
        const bw = Math.min(maxW, Math.ceil(x1)) - bx;
        const bh = Math.min(maxH, Math.ceil(y1)) - by;
        if (!(bw >= 2) || !(bh >= 2))
            return null;
        if (bw * bh >= maxW * maxH * GlassGeometry.COMPOSITE_RECT_MIN_SAVING)
            return null;
        return [bx, by, bw, bh];
    }

    /**
     * The union [x0, y0, x1, y1] of the glass bodies, or null. The rect a
     * manager passes is the background box; the shader insets the body by
     * `padding` (the shadow margin for application windows), and an attached
     * glass flares out of it by its fillet radius.
     */
    _glassBodyUnion() {
        const pad = Math.max(this._uniforms.get('padding') ?? 0, 0);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const rects = this.multiRegion ? this.regions : [this.rect];
        for (const r of rects) {
            const [rx, ry, rw, rh] = r;
            if (!(rw > 0) || !(rh > 0))
                continue;
            // The shader clamps the half-size to 1px, so the inset never inverts
            // the box.
            const ix = Math.min(pad, Math.max(rw / 2 - 1, 0));
            const iy = Math.min(pad, Math.max(rh / 2 - 1, 0));
            if (rx + ix < x0)
                x0 = rx + ix;
            if (ry + iy < y0)
                y0 = ry + iy;
            if (rx + rw - ix > x1)
                x1 = rx + rw - ix;
            if (ry + rh - iy > y1)
                y1 = ry + rh - iy;
        }
        if (!(x1 > x0) || !(y1 > y0))
            return null;
        // The fillets only widen the side on the edge, but growing every side keeps this simple and costs little.
        const flare = (this._uniforms.get('attach_edge') ?? 0) > 0.5 ? Math.max(this._uniforms.get('attach_radius') ?? 0, 0) : 0;
        x0 -= flare;
        y0 -= flare;
        x1 += flare;
        y1 += flare;
        for (const [gx, gy, gw, gh] of this.growths) {
            if (!(gw > 0) || !(gh > 0))
                continue;
            x0 = Math.min(x0, gx);
            y0 = Math.min(y0, gy);
            x1 = Math.max(x1, gx + gw);
            y1 = Math.max(y1, gy + gh);
        }
        return [x0, y0, x1, y1];
    }

    _samplingReachPx(resW, resH) {
        // The color separation moves blue further along the refraction, by up
        // to this fraction of it.
        const chroma = Math.min(Math.max(this._uniforms.get('chroma_strength') ?? 0, 0), 1);
        const minRes = Math.max(Math.min(resW, resH), 1);
        return Math.min(0.30 * minRes, GlassGeometry.EDGE_LENS_REACH * (1 + chroma) + GlassGeometry.EDGE_FOOTPRINT_SPREAD);
    }

    /**
     * The part of the actor that has to be blurred, [x, y, w, h] in shader
     * space, or null for all of it. The margin is how far a visible pixel's
     * sample can travel from the glass (_samplingReachPx()): the refraction
     * (EDGE_LENS_REACH), stretched by the chromatic aberration, and the edge
     * footprint taps (EDGE_FOOTPRINT_SPREAD), capped at 0.30 of the shorter
     * side, plus the RGSS spread, the feather and BLUR_RECT_MIN_MARGIN. The
     * drop shadow does not sample the blur.
     */
    blurRect() {
        if (!this.blurEnabled)
            return null;
        const resW = this._uniforms.get('resolution_x') ?? 0;
        const resH = this._uniforms.get('resolution_y') ?? 0;
        if (!(resW >= 1) || !(resH >= 1))
            return null;
        const body = this._glassBodyUnion();
        if (!body)
            return null;
        const [x0, y0, x1, y1] = body;
        const dispPx = this._samplingReachPx(resW, resH);
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const extra = GlassGeometry.BLUR_RECT_MIN_MARGIN + feather + 2.5;
        const mx = Math.ceil(dispPx + extra);
        const my = Math.ceil(dispPx + extra);
        const maxW = Math.round(resW);
        const maxH = Math.round(resH);
        let bx = Math.max(0, Math.floor(x0 - mx));
        let by = Math.max(0, Math.floor(y0 - my));
        let bw = Math.min(maxW, Math.ceil(x1 + mx)) - bx;
        let bh = Math.min(maxH, Math.ceil(y1 + my)) - by;
        if (!(bw >= 2) || !(bh >= 2))
            return null;
        // Round the size up and pull the origin back so the rect still covers
        // the region.
        const q = GlassGeometry.BLUR_RECT_QUANTUM;
        bw = Math.min(maxW, Math.ceil(bw / q) * q);
        bh = Math.min(maxH, Math.ceil(bh / q) * q);
        bx = Math.max(0, Math.min(bx, maxW - bw));
        by = Math.max(0, Math.min(by, maxH - bh));
        if (bw * bh >= resW * resH * GlassGeometry.BLUR_RECT_MIN_SAVING)
            return null;
        return [bx, by, bw, bh];
    }
}

export class UniformState {
    _pipeline = null;

    get values() { return this._pendingUniforms; }

    attach(pipeline) {
        this._pipeline = pipeline;
        this._compUniforms.clear();
        this._compUniformArrays.clear();
        // A new pipeline holds none of the buffered values yet.
        this._appliedUniforms.clear();
        this._appliedUniformArrays.clear();
        if (pipeline)
            this.flush();
    }

    takeDirty() {
        const changed = this._uniformsDirty;
        this._uniformsDirty = false;
        return changed;
    }

    clear() {
        this.attach(null);
        this._pendingUniforms.clear();
        this._pendingUniformArrays.clear();
        this._uniformsDirty = false;
    }

    // Uniform locations in the current pipeline.
    _compUniforms = new Map();
    _compUniformArrays = new Map();
    // Every value set so far, kept so a new pipeline can be seeded with them.
    _pendingUniforms = new Map();
    _pendingUniformArrays = new Map();
    // What the pipeline currently holds, so flush() (every paint) writes only
    // changed values instead of about 60 scalars and 8 arrays.
    _appliedUniforms = new Map();
    _appliedUniformArrays = new Map();
    // Set when a value actually changed; the glass repaints only then.
    // Changes behind the glass arrive through the relays, not here.
    _uniformsDirty = false;

    // Sets a float uniform, buffered until attach() provides a pipeline.
    set(name, value) {
        if (this._pendingUniforms.get(name) === value)
            return;
        this._pendingUniforms.set(name, value);
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniform(name, value);
        }
    }

    _applyUniform(name, value) {
        if (!this._pipeline)
            return;
        if (this._appliedUniforms.get(name) === value)
            return;
        let loc = this._compUniforms.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniforms.set(name, loc);
        }
        this._pipeline.set_uniform_1f(loc, value);
        this._appliedUniforms.set(name, value);
    }

    flush() {
        for (const [name, value] of this._pendingUniforms) {
            this._applyUniform(name, value);
        }
        for (const [name, values] of this._pendingUniformArrays) {
            this._applyUniformArray(name, values);
        }
    }

    // Sets a float array uniform (e.g. region_x[16]), buffered like set().
    setArray(name, values) {
        const prev = this._pendingUniformArrays.get(name);
        if (prev && prev.length === values.length) {
            let same = true;
            for (let i = 0; i < values.length; i++) {
                if (prev[i] !== values[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        // Callers reuse their arrays, so keep a copy to compare against.
        this._pendingUniformArrays.set(name, values.slice());
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniformArray(name, values);
        }
    }

    _applyUniformArray(name, values) {
        if (!this._pipeline)
            return;
        const applied = this._appliedUniformArrays.get(name);
        if (applied && applied.length === values.length) {
            let same = true;
            for (let i = 0; i < values.length; i++) {
                if (applied[i] !== values[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        let loc = this._compUniformArrays.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniformArrays.set(name, loc);
        }
        setUniformArray(this._pipeline, loc, name, values);
        this._appliedUniformArrays.set(name, values.slice());
    }
}

export class MaterialSettings {
    _settings;
    _uniforms;
    _blur;
    _setDiagnostics;
    _repaintIfDirty;
    _settingsIds = [];

    constructor(_settings, _uniforms, _blur, _setDiagnostics, _repaintIfDirty) {
        this._settings = _settings;
        this._uniforms = _uniforms;
        this._blur = _blur;
        this._setDiagnostics = _setDiagnostics;
        this._repaintIfDirty = _repaintIfDirty;
    }

    initialize() {
        // Buffered until the pipeline exists.
        this._uniforms.set('resolution_x', 0.0);
        this._uniforms.set('resolution_y', 0.0);
        this._uniforms.set('corner_radius', 60.0);
        this._uniforms.set('brightness', 1.0);
        this._uniforms.set('contrast', 1.0);
        this._uniforms.set('saturation', 1.0);
        this._uniforms.set('padding', 20.0);
        // How far the drop shadow can extend before the glass actor's clip,
        // unlike the small optical 'padding'. The managers set the real value.
        this._uniforms.set('shadow_max_radius', 180.0);
        this._uniforms.set('isDock', 0.0);
        // Rim, specular and sheen highlights. Application windows turn them off
        // and keep only the drop shadow and the inner AO.
        this._uniforms.set('surface_light_enabled', 1.0);
        // Application windows turn continuous corners off to match the window.
        this._uniforms.set('corner_smoothing_enabled', 1.0);
        // No outline until a surface's settings ask for one.
        this._uniforms.set('outline_width', 0.0);
        this._uniforms.set('outline_r', 1.0);
        this._uniforms.set('outline_g', 1.0);
        this._uniforms.set('outline_b', 1.0);
        // Where the glass sits inside the actor, which for the UI glass covers
        // the monitor.
        this._uniforms.set('dock_x', 0.0);
        this._uniforms.set('dock_y', 0.0);
        this._uniforms.set('dock_w', 0.0);
        this._uniforms.set('dock_h', 0.0);
        // Floating, not grown out of a screen edge.
        this._uniforms.set('attach_edge', 0.0);
        this._uniforms.set('attach_radius', 0.0);
        // No menus grown out of it.
        this._uniforms.set('grow_count', 0.0);
        // One glass per region, for Quick Settings' toggle-button mode.
        this._uniforms.set('multi_region_mode', 0.0);
        this._uniforms.set('region_count', 0.0);
        // An unset uniform reads 0.0, which would disable these.
        this._uniforms.set('early_exit_enabled', 1.0);
        this._uniforms.set('debug_view', 0.0);
        // Zero means the whole actor until the paint path computes the rect.
        this._uniforms.set('blur_rect_x', 0.0);
        this._uniforms.set('blur_rect_y', 0.0);
        this._uniforms.set('blur_rect_w', 0.0);
        this._uniforms.set('blur_rect_h', 0.0);
        // Set on every paint, once layer 1's size is known.
        this._uniforms.set('blur_tex_w', 0.0);
        this._uniforms.set('blur_tex_h', 0.0);
        this._uniforms.set('edge_taps_enabled', 1.0);
        this._settingsIds = [];
        if (this._settings) {
            this._bindSettings();
        }
        else {
            // Without settings, the schema's defaults.
            this._uniforms.set('max_z', 88.0);
            this._uniforms.set('displacement_scale', 10.5);
            this._uniforms.set('edge_smoothing', 0.5);
            this._uniforms.set('profile_shape_n', 3.6);
            this._uniforms.set('ior', 2.40);
            this._uniforms.set('chroma_strength', 0.0);
            this._uniforms.set('corner_smoothing', 0.6);
            this._uniforms.set('highlight_backdrop_color', 1.0);
            this._uniforms.set('specular_intensity', 0.0);
            this._uniforms.set('shininess', 42.0);
            this._uniforms.set('rim_width', 2.3);
            this._uniforms.set('rim_intensity', 0.5);
            this._uniforms.set('rim_directional_power', 1.9);
            this._uniforms.set('rim_power', 3.0);
            this._uniforms.set('rim_light_color_intensity', 1.0);
            this._uniforms.set('sheen_intensity', 0.0);
            this._uniforms.set('light_angle_deg', 90.0);
            this._uniforms.set('shadow_radius', 50.0);
            this._uniforms.set('shadow_intensity', 0.22);
            this._uniforms.set('ao_intensity', 0.65);
            this._uniforms.set('ao_radius', 1.0);
            this._uniforms.set('tint_strength', 0.0);
            this._uniforms.set('tint_r', 1.0);
            this._uniforms.set('tint_g', 1.0);
            this._uniforms.set('tint_b', 1.0);
        }
    }

    clear() {
        if (this._settings)
            this._settingsIds.forEach(id => this._settings?.disconnect(id));
        this._settingsIds = [];
    }

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
            { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
            { key: 'glass-ao-radius', uniform: 'ao_radius' },
            { key: 'glass-corner-smoothing', uniform: 'corner_smoothing' },
        ];
        const settings = this._settings;
        if (!settings)
            return;
        mappings.forEach(map => {
            this._uniforms.set(map.uniform, settings.get_double(map.key));
            // Without a repaint only the parts of the glass that something else
            // damaged would pick up the new value.
            const id = settings.connect(`changed::${map.key}`, () => {
                this._uniforms.set(map.uniform, settings.get_double(map.key));
                this._repaintIfDirty();
            });
            this._settingsIds.push(id);
        });
        const applyBackdropHighlights = () => {
            this._uniforms.set('highlight_backdrop_color', settings.get_boolean('glass-backdrop-highlights') ? 1.0 : 0.0);
        };
        applyBackdropHighlights();
        const highlightsId = settings.connect('changed::glass-backdrop-highlights', () => {
            applyBackdropHighlights();
            this._repaintIfDirty();
        });
        this._settingsIds.push(highlightsId);
        // 2 = half resolution, 4 = quarter. Read before blur-method, since the
        // Gaussian kernel is expressed in texels of that level.
        const applyDownscale = () => {
            const factor = settings.get_int('glass-blur-downscale') >= 4 ? 4 : 2;
            this._blur.setDownscale(factor);
        };
        applyDownscale();
        const downscaleId = settings.connect('changed::glass-blur-downscale', applyDownscale);
        this._settingsIds.push(downscaleId);
        // 0 = Gaussian, 1 = Dual Kawase.
        const applyBlurMethod = () => {
            const raw = settings.get_int('blur-method');
            this._blur.setBlurMethod(raw === 0 ? 0 : 1);
        };
        applyBlurMethod();
        const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
        this._settingsIds.push(blurMethodId);
        // Cached, so the paint path does not query GSettings.
        const applyDiagFlag = () => {
            this._setDiagnostics(settings.get_boolean('glass-debug-diagnostics'));
        };
        applyDiagFlag();
        const diagId = settings.connect('changed::glass-debug-diagnostics', applyDiagFlag);
        this._settingsIds.push(diagId);
    }

    setAnimationScale(scale) {
        const settings = this._settings;
        if (!settings)
            return false;
        this._uniforms.set('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
        this._uniforms.set('max_z', settings.get_double('glass-max-z') * scale);
        // The color separation is a fraction of the displacement, so it already
        // scales with it.
        return true;
    }
}

// Keeps the outline uniforms of one glass in step with its surface's
// `<prefix>-outline-*` settings. A width of 0 is how the shader turns the
// outline off.
export class OutlineBinding {
    _settings;
    _prefix;
    _uniforms;
    _repaintIfDirty;
    _ids = [];

    constructor(_settings, _prefix, _uniforms, _repaintIfDirty) {
        this._settings = _settings;
        this._prefix = _prefix;
        this._uniforms = _uniforms;
        this._repaintIfDirty = _repaintIfDirty;
    }

    initialize() {
        this._apply();
        for (const suffix of ['enabled', 'width', 'color']) {
            this._ids.push(this._settings.connect(`changed::${this._prefix}-outline-${suffix}`, () => {
                this._apply();
                this._repaintIfDirty();
            }));
        }
    }

    clear() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
    }

    _apply() {
        const s = this._settings;
        const p = this._prefix;
        const [r, g, b] = hexToColorArray(s.get_string(`${p}-outline-color`));
        this._uniforms.set('outline_width', s.get_boolean(`${p}-outline-enabled`) ? s.get_double(`${p}-outline-width`) : 0.0);
        this._uniforms.set('outline_r', r);
        this._uniforms.set('outline_g', g);
        this._uniforms.set('outline_b', b);
    }
}
