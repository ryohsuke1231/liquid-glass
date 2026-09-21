/** Glass extents in shader coordinates; no Clutter or GPU dependencies. */
export class GlassGeometry {
    _uniforms;
    constructor(_uniforms) {
        this._uniforms = _uniforms;
        this.blurEnabled = GlassGeometry.USE_BLUR_RECT;
        this.compositeEnabled = GlassGeometry.USE_COMPOSITE_RECT;
    }
    // ── [PERF] Blurred sub-rect ────────────────────────────────────────────
    // The glass geometry the shader was last told about, kept so the paint
    // path can work out which part of the actor actually needs blurring.
    // Same coordinate space as setResolution()/setGlassGeometry().
    rect = [0, 0, 0, 0]; // [x, y, w, h]
    regions = []; // multi-region mode
    multiRegion = false;
    // Per-instance override of GlassGeometry.USE_BLUR_RECT.
    blurEnabled;
    // Per-instance override of GlassGeometry.USE_COMPOSITE_RECT.
    compositeEnabled;
    // ─── Crop pass ───────────────────────────────────────────────────────────
    //
    // get_texture() is sized to the actor's PAINT BOX, not its allocation, so it
    // carries a few pixels of padding. This pass copies out just the valid
    // region, which lets every later pass work in the plain 0..1 range.
    //
    // [PERF] It was removed outright, and put back behind this flag after the
    // one-frame texture lag from memo.md returned — with A1's blur reuse active,
    // which is the combination the removal had never been tested in. The two
    // interact: without the crop the blur chain samples the effect's own live
    // capture texture, and with the reuse in play that texture is read by passes
    // that no longer sit in a simple chain behind it.
    //
    // Kept switchable rather than simply reverted so the attribution can be
    // settled in one session: global._lgGlass.cropPass(false) turns it off.
    // ─── Blurred sub-rect (A3 alternative) ───────────────────────────────────
    //
    // The blur used to run over the whole capture, which for a full-screen FBO
    // is 1920x1080 downsampled and Gaussian-blurred every frame — even when the
    // only glass on it is a 600x100 dock. Almost all of that work was thrown
    // away: glass.frag multiplies the refracted color by `alpha = insideMask`,
    // so a pixel outside the glass body contributes nothing no matter what the
    // blur texture holds there.
    //
    // The obvious fix — shrink the FBO to the glass — is the one thing we must
    // NOT do. dockManager.ts sizes bgActor/liquidBox to the whole monitor
    // precisely so the offscreen's origin coincides with the stage's, because a
    // background-mode blur nested inside our subtree (Blur My Shell's panel)
    // resolves its source rect in STAGE coordinates and then blits out of the
    // CURRENT framebuffer. A dock-sized FBO makes those two spaces disagree and
    // brings back the offset/cache-pollution bugs recorded there.
    //
    // So the FBO, the actor, computeCaptureLayout() and every stage coordinate
    // stay exactly as they are, and only the region handed to the blur chain
    // shrinks. glass.frag's blur_rect_* uniforms tell the shader where that
    // region sits so layer 1 is sampled through the matching sub-rect mapping.
    //
    // global._lgGlass.blurRect(false) turns it off for A/B testing.
    static USE_BLUR_RECT = true;
    // Hard floor on the margin around the glass, on top of the computed
    // refraction reach. Covers edge_smoothing's feather, the 4-tap RGSS spread
    // and rounding.
    static BLUR_RECT_MIN_MARGIN = 12;
    // Below this the rect is not worth the extra uniforms: if it already covers
    // essentially the whole actor there is nothing to save. Kept close to 1
    // because an application window — where the glass IS the actor apart from
    // the shadow margin — lands around 0.8, and those are the surfaces that
    // paint most often.
    static BLUR_RECT_MIN_SAVING = 0.95;
    // The texture pool is keyed on the blurred region's SIZE, so every change
    // to it destroys and reallocates three textures and three framebuffers.
    // A menu whose width creeps by a pixel while it opens would do that on
    // every frame of the animation. Rounding the size up to a multiple of this
    // makes those changes land on the same pool; the rect's POSITION is free to
    // move as much as it likes, since nothing is keyed on it.
    static BLUR_RECT_QUANTUM = 64;
    // [PERF ①] Slack added on top of the refraction + blur reach when clipping
    // the CAPTURE (see getCaptureClipRect()). The clip is recomputed from the
    // same frame's uniforms, so this is not covering a lag — it is covering
    // rounding, the 4-tap RGSS spread, and the fact that being a little too
    // generous here costs a few thousand pixels while being a little too tight
    // shows up as a hard edge in the glass.
    static CAPTURE_CLIP_EXTRA_MARGIN = 24;
    // Do not bother clipping when the rect already covers this much of the
    // actor. Application windows sit above it (their glass IS the actor bar
    // the shadow margin, and applicationManager's clipBox already clips the
    // clone subtree), so they keep their current, un-scissored path.
    static CAPTURE_CLIP_MIN_SAVING = 0.85;
    // ─── Composite rect ──────────────────────────────────────────────────────
    //
    // The composite pass — glass.frag itself — was issued over the whole
    // capture. For a full-screen FBO that means running the fragment shader on
    // 1920x1080 pixels to light a 920x110 dock. The early exits at the top of
    // main() make most of those pixels cheap, but "cheap" is not "free": the
    // shader still starts, still evaluates the SDF, and the rasterisation and
    // the blend still cost their memory bandwidth.
    //
    // Everything the shader can actually put on screen is
    //   finalRgb = litColor * alpha + shadowColor * shadowContribution
    //            + panelTerm.rgb
    // and `alpha` is `insideMask`, which is 0 outside the body. So only the
    // body, the drop shadow's reach, and (if it were ever switched on) the
    // panel fallback fill can be non-transparent. The composite blend is
    // `ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))`, under which a
    // fully-transparent source is exactly a no-op — so NOT drawing those
    // pixels is bit-for-bit what drawing them did.
    //
    // Unlike the blurred sub-rect this needs no refraction margin: refraction
    // changes where a pixel SAMPLES from, not where it is drawn.
    //
    // global._lgGlass.compositeRect(false) turns it off for A/B testing.
    static USE_COMPOSITE_RECT = true;
    // As with the blur rect: not worth the arithmetic if it saves nothing.
    static COMPOSITE_RECT_MIN_SAVING = 0.95;
    /**
     * [PERF] Works out how much of the actor the composite pass has to cover.
     *
     * Returns integer [x, y, w, h] in the shader's own coordinate space
     * (`resolution_x/y`), or null for "cover everything" — the pre-existing
     * behavior, used whenever the answer is uncertain or not worth it.
     *
     * The shadow's real reach, from glass.frag:
     *   effectiveRadius = min(shadow_radius * dirRadius, maxRadius), dirRadius <= 1
     *   maxRadius       = max(shadow_max_radius, 5)
     *   umbra/penumbra are 0 at d >= effectiveRadius, and
     *   `shadowAlpha *= 1 - step(maxRadius, d)` zeroes it past maxRadius too.
     * so nothing is drawn beyond min(shadow_radius, maxRadius) from the body.
     * Multi-region mode sets shadowAlpha to 0 outright.
     */
    compositeRect() {
        if (!this.compositeEnabled)
            return null;
        // The debug visualisations are easier to read when they are not clipped
        // to the rect being debugged.
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
        // The edge feather widens the body itself, and the rim/AO bands live
        // inside it. 2px of slack absorbs the rounding.
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const m = Math.ceil(reach + feather + 2);
        x0 -= m;
        y0 -= m;
        x1 += m;
        y1 += m;
        // The panel fallback fill is drawn from panel_rect_* wherever
        // panel_bg_a > 0, independently of the glass body — including from the
        // first early exit. Nothing calls setPanelBackgroundColor() today, so
        // this is dead, but it must not become a clipping bug if it is wired up.
        if ((this._uniforms.get('panel_bg_a') ?? 0) > 0) {
            const px = this._uniforms.get('panel_rect_x') ?? 0;
            const py = this._uniforms.get('panel_rect_y') ?? 0;
            const pw = this._uniforms.get('panel_rect_w') ?? 0;
            const ph = this._uniforms.get('panel_rect_h') ?? 0;
            if (pw > 0 && ph > 0) {
                x0 = Math.min(x0, px - 2);
                y0 = Math.min(y0, py - 2);
                x1 = Math.max(x1, px + pw + 2);
                y1 = Math.max(y1, py + ph + 2);
            }
        }
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
     * [PERF] The union of the glass BODIES the shader will draw, as
     * [x0, y0, x1, y1] in the shader's coordinate space (`resolution_x/y`),
     * or null when there is nothing to draw.
     *
     * The rect a manager hands us is the BACKGROUND actor's box; the body
     * inside it is inset by `padding` on every side, which is exactly what the
     * shader does (`actual_size = size - padding * 2`, in both the single-rect
     * branch and findActiveRegion()). The dock branch insets by a further
     * edgeFeather * 2, which is deliberately not replicated — erring larger is
     * the safe direction. The inset matters most for application windows,
     * where `padding` is the shadow margin and reaches 120px.
     */
    _glassBodyUnion() {
        const pad = Math.max(this._uniforms.get('padding') ?? 0, 0);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const rects = this.multiRegion ? this.regions : [this.rect];
        for (const r of rects) {
            const [rx, ry, rw, rh] = r;
            if (!(rw > 0) || !(rh > 0))
                continue;
            // Never let the inset turn the box inside out; the shader clamps the
            // half-size to 1px, so a rect smaller than 2*padding is a 2px box at
            // its own centre.
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
    /**
     * [PERF ①] The rect of the CAPTURE that this glass can possibly need, in
     * shader space (= liquidBox-local pixels, the same space _computeBlurRect()
     * and the dock_x/y/w/h uniforms use).
     *
     * Why this exists separately from _computeBlurRect():
     *
     *   _computeBlurRect() answers "which part of the capture has to be
     *   BLURRED", and is allowed to return null whenever blurring the whole
     *   actor is no worse (BLUR_RECT_MIN_SAVING), or when the blur sub-rect
     *   feature is switched off. This one answers "which part of the capture
     *   has to be DRAWN AT ALL", which is a different question with a
     *   different safety margin and must stay available even when the blur
     *   sub-rect is off.
     *
     * The margin on top of the glass body is:
     *   - the refraction reach (same derivation as _computeBlurRect(): the
     *     shader samples the background through the displaced UV, so anything
     *     a refracted ray can reach must exist in the capture),
     *   - plus the blur's own reach. The blur passes sample the capture around
     *     each texel; if the capture were cleared exactly at the blur rect's
     *     border, those taps would pull in transparent pixels and smear them
     *     back inward. radius is a sigma in original-resolution pixels and is
     *     clamped to 30 by _setGaussianBlurRadius(), so 3 sigma is the whole
     *     of it.
     *
     * Deliberately NOT tightened to the blur rect: the cost being removed here
     * is fill rate over the REST of the monitor (a full-screen wallpaper clone
     * plus every window clone), so a hundred extra pixels of margin costs
     * nothing and buys immunity to an off-by-a-frame geometry read.
     */
    captureClip(radius) {
        const resW = this._uniforms.get('resolution_x') ?? 0;
        const resH = this._uniforms.get('resolution_y') ?? 0;
        if (!(resW >= 1) || !(resH >= 1))
            return null;
        const body = this._glassBodyUnion();
        if (!body)
            return null;
        const [x0, y0, x1, y1] = body;
        // Refraction reach — identical derivation to _computeBlurRect().
        const ior = this._uniforms.get('ior') ?? 1.5;
        const dispScale = this._uniforms.get('displacement_scale') ?? 0;
        const eta = 1.0 / Math.max(ior, 1.001);
        const bend = Math.min(eta / Math.sqrt(Math.max(1 - eta * eta, 1e-6)), 1 / 0.15);
        const minRes = Math.max(Math.min(resW, resH), 1);
        const dispUV = Math.min(0.30, bend * Math.max(dispScale, 0) / minRes);
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const blurReach = 3 * Math.max(Math.min(radius, 30), 0);
        const extra = GlassGeometry.BLUR_RECT_MIN_MARGIN + feather + 2.5 +
            blurReach + GlassGeometry.CAPTURE_CLIP_EXTRA_MARGIN;
        const mx = Math.ceil(dispUV * resW + extra);
        const my = Math.ceil(dispUV * resH + extra);
        const maxW = Math.round(resW);
        const maxH = Math.round(resH);
        let cx = Math.max(0, Math.floor(x0 - mx));
        let cy = Math.max(0, Math.floor(y0 - my));
        let cw = Math.min(maxW, Math.ceil(x1 + mx)) - cx;
        let ch = Math.min(maxH, Math.ceil(y1 + my)) - cy;
        if (!(cw >= 2) || !(ch >= 2))
            return null;
        // Quantised like the blur rect so a menu animating by a pixel does not
        // rewrite the clip (and therefore damage the whole glass) every frame.
        const q = GlassGeometry.BLUR_RECT_QUANTUM;
        cw = Math.min(maxW, Math.ceil(cw / q) * q);
        ch = Math.min(maxH, Math.ceil(ch / q) * q);
        cx = Math.max(0, Math.min(cx, maxW - cw));
        cy = Math.max(0, Math.min(cy, maxH - ch));
        // Covering (almost) the whole actor already: clipping would only add a
        // scissor for nothing. Application windows land here — their clipBox
        // already clips the clone subtree to the glass box.
        if (cw * ch >= resW * resH * GlassGeometry.CAPTURE_CLIP_MIN_SAVING)
            return null;
        return [cx, cy, cw, ch];
    }
    /**
     * [PERF] Works out which part of the actor actually has to be blurred.
     *
     * Returns integer [x, y, w, h] in the shader's own coordinate space
     * (`resolution_x/y`, the same space as dock_x/y/w/h), or null for "blur
     * everything" — the pre-existing behavior, used whenever the answer is
     * uncertain or not worth it.
     *
     * The margin is the distance a visible pixel's sample can travel away from
     * the glass rect:
     *
     *   - Refraction. getDisplacement() returns
     *     (refractedRay.xy / safe_z) * displacement_scale / minRes, in UV, so in
     *     pixels it is bounded by tan(asin(1/ior)) * displacement_scale *
     *     resolution / minRes. safe_z's own floor of 0.15 caps the ratio at
     *     1/0.15 for an ior approaching 1, and the shader additionally clamps
     *     the UV displacement to 0.30 — both bounds are applied here too, so
     *     this is an upper bound on the shader's behavior, not an estimate.
     *   - The 4-tap RGSS spread (at most 2.5px) and the edge feather.
     *
     * The drop shadow deliberately does NOT extend the rect: outside the body
     * `alpha` is 0, so `litColor * alpha` — the only term the blur feeds — is 0
     * there regardless of what layer 1 contains.
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
        const ior = this._uniforms.get('ior') ?? 1.5;
        const dispScale = this._uniforms.get('displacement_scale') ?? 0;
        const eta = 1.0 / Math.max(ior, 1.001);
        // tan(asin(eta)), i.e. the largest |xy/z| a refracted ray can reach,
        // capped the way the shader's safe_z floor caps it.
        const bend = Math.min(eta / Math.sqrt(Math.max(1 - eta * eta, 1e-6)), 1 / 0.15);
        const minRes = Math.max(Math.min(resW, resH), 1);
        const dispUV = Math.min(0.30, bend * Math.max(dispScale, 0) / minRes);
        const dispX = dispUV * resW;
        const dispY = dispUV * resH;
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const extra = GlassGeometry.BLUR_RECT_MIN_MARGIN + feather + 2.5;
        const mx = Math.ceil(dispX + extra);
        const my = Math.ceil(dispY + extra);
        const maxW = Math.round(resW);
        const maxH = Math.round(resH);
        let bx = Math.max(0, Math.floor(x0 - mx));
        let by = Math.max(0, Math.floor(y0 - my));
        let bw = Math.min(maxW, Math.ceil(x1 + mx)) - bx;
        let bh = Math.min(maxH, Math.ceil(y1 + my)) - by;
        if (!(bw >= 2) || !(bh >= 2))
            return null;
        // Round the size up (see BLUR_RECT_QUANTUM) and pull the origin back so
        // the grown rect still contains the region it was computed to cover.
        const q = GlassGeometry.BLUR_RECT_QUANTUM;
        bw = Math.min(maxW, Math.ceil(bw / q) * q);
        bh = Math.min(maxH, Math.ceil(bh / q) * q);
        bx = Math.max(0, Math.min(bx, maxW - bw));
        by = Math.max(0, Math.min(by, maxH - bh));
        // Not worth it when it barely shrinks anything.
        if (bw * bh >= resW * resH * GlassGeometry.BLUR_RECT_MIN_SAVING)
            return null;
        return [bx, by, bw, bh];
    }
}
