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
     * `padding` (the shadow margin for application windows).
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
