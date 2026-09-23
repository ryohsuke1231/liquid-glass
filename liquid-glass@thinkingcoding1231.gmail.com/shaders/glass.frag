// shaders/glass.frag
uniform sampler2D cogl_sampler0; // Layer 0: 元のシャープな背景
uniform sampler2D cogl_sampler1; // Layer 1: ブラー済み背景

uniform float resolution_x;
uniform float resolution_y;
uniform float pointer_x;
uniform float pointer_y;
uniform float intensity;
uniform float corner_radius;
uniform float max_z;
uniform float displacement_scale;
uniform float edge_smoothing;
uniform float profile_shape_n;
uniform float ior;
uniform float chroma_strength;
uniform float blur_strength;
uniform float tint_strength;
uniform float tint_r;
uniform float tint_g;
uniform float tint_b;
uniform float specular_intensity;
uniform float rim_width;
uniform float rim_intensity;
uniform float rim_directional_power;
uniform float rim_power;
uniform float rim_light_color_intensity;
uniform float sheen_intensity;
uniform float shininess;
// Master on/off for the rim/specular/sheen "glass surface glint" group,
// set via LiquidEffect.setSurfaceLightEnabled(). Defaults to 1.0 (on) when
// unset, so surfaces that never call the setter (dock, menu, notification,
// quick-settings, OSD) are unaffected. applicationManager.ts sets this to
// 0.0 for application windows, which should read as plain "shadow + AO"
// (both computed independently of this uniform, see main()) rather than a
// dock-style glass glint hugging the window edge.
uniform float surface_light_enabled;
// [NEW] Inner edge ambient-occlusion darkening, independent of rim_width and
// of the outer drop shadow (shadow_radius / shadow_intensity above). Lets
// the user tune the "shadow under the glass" band on its own instead of it
// being derived from rim_width and gated by the drop shadow's radiusEnable.
uniform float ao_intensity; // 0 = no inner darkening, 1 = fully black at the edge
uniform float ao_radius;    // px inward from the edge over which the AO band fades out
uniform float light_angle_deg;
uniform float mouse_radius;
uniform float bg_glow_intensity;
uniform float shadow_radius;
uniform float shadow_intensity;
// [FIX] How much room (px) the drop shadow actually has to render outward,
// synced from dockManager's CLIP_PADDING. Previously the shadow reused
// `padding` (below) for this, which is a small, fixed value meant only for
// refraction/blur headroom (20px) — that silently capped shadow_radius's
// usable range at ~18px regardless of the 0-100 prefs.js slider.
uniform float shadow_max_radius;
uniform float padding;
uniform float isDock;

// [PERF] Blurred sub-rect (actor-local px, same space as `pixel_coord` and
// dock_x/y/w/h). Layer 1 no longer holds a blurred copy of the WHOLE actor;
// it holds only this rectangle, blurred. Everything the shader actually
// draws — the glass body plus its refraction/AA reach — lives inside it, so
// the pixels that used to be blurred and then thrown away are never produced
// in the first place. The FBO, the actor and every stage coordinate are
// unchanged: only the area handed to the blur chain shrank. That distinction
// matters — a background-mode blur inside our subtree (Blur My Shell's panel)
// resolves its source in STAGE coordinates and blits from the CURRENT
// framebuffer, so shrinking the FBO itself would misalign it. See
// dockManager.ts's "Full-screen FBO geometry" note.
//
// blur_rect_w/h < 1 means "the whole actor", which is what an unset uniform
// (0.0) reads as — so the fallback is also the safe default.
uniform float blur_rect_x;
uniform float blur_rect_y;
uniform float blur_rect_w;
uniform float blur_rect_h;
// [FIX] The real texel grid of the texture bound to layer 1, in texels. The
// blur chain runs at half (or quarter) resolution, so that texture is
// MAGNIFIED when it is sampled back here — a 704x256 rect arrives as a
// 352x128 image. Plain bilinear magnification is only C0: its first
// derivative jumps at every texel boundary, which the eye reads as a
// staircase along any diagonal edge in the background and as faint creases
// across smooth gradients. That is the jaggedness that survives however much
// the SHAPE's own antialiasing is turned up, because it is not the shape's
// edge at all — it is the backdrop's reconstruction. blurUV() uses these to
// reconstruct it smoothly instead; 0 (an unset uniform) disables that, which
// is also the correct behaviour when layer 1 is the full-resolution capture.
uniform float blur_tex_w;
uniform float blur_tex_h;

// ── The bevel's lens: two FIXED constants, deliberately not settings ───────
//
// EDGE_LENS_FALLOFF shapes the ramp: the raw refraction is multiplied by
// (1 - depth/bevel)^falloff, so the displacement builds towards the rim and
// dies where the bevel meets the flat interior.
//
// [!] It is a constant and must STAY one. It overlaps with profile_shape_n,
// which is a real preferences slider, and shipping both would be two sliders
// fighting over one effect with no way for anyone to reason about which to
// reach for. Measured on the shipped configuration (bevel 30px, max_z 32.5,
// displacement_scale 47, ior 2.4) — displacement in px at depth u:
//
//     u =            0     2     5     8    12    18
//   falloff 2.4    66    47    23    12     5     1     <- this constant
//   shape_n 6      82    46    14     5   1.5   0.1     <- the surface itself
//   shape_n 12     84    34     4   0.8   0.1     0
//
// i.e. profile_shape_n reaches the same shape and further, because it is what
// actually decides how square the dome is, and a square dome IS "the
// refraction builds up abruptly at the rim". The three optical sliders divide
// the job cleanly between them and none of them needs a fourth:
//
//   displacement_scale — the glass's optical thickness. Multiplies the whole
//       field uniformly (47 -> 94 doubles every row above). Pure magnitude.
//   max_z              — the dome's height, i.e. how steep the normals get.
//       Magnitude too, but weighted towards wherever the profile is steep.
//   profile_shape_n    — pure shape, no magnitude.
//
// The value here is the one the look was signed off with; changing it would
// silently re-tune every surface behind the user's back.
#define EDGE_LENS_FALLOFF 2.4

// EDGE_LENS_REACH is not a look knob at all: it is the hard ceiling in pixels
// on how far the rim may sample, and _computeBlurRect() on the JS side sizes
// the blurred region from the same figure (LiquidEffect.EDGE_LENS_REACH).
// Sampling past it would just read that region's clamped border and streak.
// The two must be changed together.
#define EDGE_LENS_REACH 96.0

// [DEBUG] The footprint taps in sampleBackdrop(), 1.0 = on (normal).
// Setting it to 0.0 forces the four-tap RGSS pattern everywhere, which is the
// direct A/B for "is the edge antialiasing actually doing anything" — turn it
// off and the rim should visibly break up over a busy background.
// global._lgGlass.edgeTaps(false). Seeded to 1.0 in _init(); an unset Cogl
// uniform reads 0.0, which would silently disable the taps.
uniform float edge_taps_enabled;

// [PERF/DEBUG] Master switch for the two early exits at the top of main().
// 1.0 = on (normal). 0.0 = take the full per-pixel path everywhere, which is
// what the shader did before those exits existed. Flipped at runtime from
// Looking Glass via global._lgGlass.earlyExit(false) so a suspected rendering
// difference can be A/B'd inside one session instead of across rebuilds.
// LiquidEffect seeds it to 1.0 in _init(); an unset Cogl uniform reads 0.0,
// which would silently disable the exits.
uniform float early_exit_enabled;

// [DEBUG] Diagnostic visualisation, 0 = off (normal rendering).
//   1 = paint the shape and shadow masks directly, fully opaque, with a
//       gamma boost so faint values are still legible:
//         RED   = shadowAlpha  (the drop shadow's own coverage)
//         GREEN = insideMask   (the glass shape itself)
//         BLACK = neither
//   2 = the same, with the raw un-boosted values.
// This answers "is the shader computing a shadow at all, and where" without
// any of the compositing, ordering or clipping that sits between this
// shader's output and the screen. Set from Looking Glass with
// global._lgGlass.debugView(1). Disables the early exits while active so the
// whole surface is visualised.
uniform float debug_view;

// [NEW] SCB (Saturation, Contrast, Brightness) 調整用の変数
uniform float brightness;
uniform float contrast;
uniform float saturation;

// [NEW] Dock geometry in monitor-local pixel coordinates.
// In full-screen FBO mode the actor covers the whole monitor, so the shader
// must know the dock's position and size within that space to correctly
// compute local_pos and box_size. Supplied each frame by LiquidEffect::setDockGeometry().
uniform float dock_x;  // dock background left edge  (monitor-relative px)
uniform float dock_y;  // dock background top  edge  (monitor-relative px)
uniform float dock_w;  // dock background width       (px, includes SHADER_PADDING)
uniform float dock_h;  // dock background height      (px, includes SHADER_PADDING)

// [NEW] Multi-region compositing (used by Quick Settings "Toggles" apply-to
// mode, see quickSettingsManager.ts::_syncToggleRegions). Instead of one big
// dock/panel-sized rectangle, glass.frag can draw up to MAX_GLASS_REGIONS
// independent small rounded-rect "windows" into the SAME shared blurred
// texture (computed once per frame regardless of region count). Each pixel
// picks at most one region to render (regions are expected not to overlap);
// pixels outside every region are fully transparent. Drop shadows are
// unconditionally skipped in this mode (see main()) — they only make sense
// for one big panel, not many small independent chips.
//
// When multi_region_mode is 0 (the default, used by Dock/Menu/Notification/
// OSD/Application and the Quick Settings "Background" mode), none of this
// is evaluated differently from before — the legacy single dock_* rect path
// below is used exactly as-is.
#define MAX_GLASS_REGIONS 16
uniform float multi_region_mode;              // 0 = legacy single dock_* rect, 1 = multi-region
uniform float region_count;                   // valid entries in the arrays below (0..MAX_GLASS_REGIONS)

// [FIX] Optional flat "panel background" fallback fill color, composited
// UNDER the glass+shadow result (see the very end of main()). Defaults to
// panel_bg_a = 0 (fully off, a no-op) so existing usages (Background mode,
// application windows) are completely unaffected — only Toggles mode sets
// this, to a = 1 with the quick-settings panel's real background color.
uniform float panel_bg_r;
uniform float panel_bg_g;
uniform float panel_bg_b;
uniform float panel_bg_a;
// [FIX] The panel's REAL widget bounds (monitor-relative px, NOT padded —
// no SHADER_PADDING/CLIP_PADDING/glassExpand), so the panel_bg_* fallback
// fill above can be restricted to that rect instead of covering the whole
// (much larger) bgActor. bgActor is full-monitor-sized and clipped to the
// toggle-region bounding box PLUS a 200px CLIP_PADDING margin (see
// quickSettingsManager.ts::_syncToggleRegions) purely to give the
// blur/refraction shader sampling headroom past the panel's real edges.
// Without this mask, panel_bg_a=1 flood-fills that entire padded/clipped
// rectangle wherever finalAlpha < 1 — including the ~200px margin OUTSIDE
// the real panel — producing a solid rectangle visibly larger than the
// panel itself (reported as a black box surrounding Quick Settings).
uniform float panel_rect_x;
uniform float panel_rect_y;
uniform float panel_rect_w;
uniform float panel_rect_h;
uniform float region_x[MAX_GLASS_REGIONS];    // monitor-relative px, includes SHADER_PADDING/expand
uniform float region_y[MAX_GLASS_REGIONS];
uniform float region_w[MAX_GLASS_REGIONS];
uniform float region_h[MAX_GLASS_REGIONS];
uniform float region_tint_r[MAX_GLASS_REGIONS]; // per-region BASE color (the element's own, sampled on the TS side)
uniform float region_tint_g[MAX_GLASS_REGIONS];
uniform float region_tint_b[MAX_GLASS_REGIONS];
// [FIX-8] How strongly each region's own base color is applied, INDEPENDENTLY
// of tint_strength. Formerly the TS side pre-blended the element's own color
// with the user's tint color into one `region_tint_*` triple, which meant a
// single tint_strength governed both: turning the user's tint down to 0.21
// also faded the element's own color (e.g. Do Not Disturb's solid white when
// ON) down to 0.21, so the only way to see an element's own color strongly
// was to crank the custom tint strongly too. They are now two separate,
// composable layers over `refracted` — see the mix() chain in main().
// Per-region rather than a single uniform so a region whose real color could
// not be resolved at all can simply opt out with 0.
uniform float region_base_strength[MAX_GLASS_REGIONS];

// Signed Distance Field (SDF) function for a rounded rectangle.
// Returns negative values inside the shape, positive outside, and 0 on the exact edge.
float sdRoundRect(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + vec2(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}

// [NEW] Multi-region mode: finds the region nearest to (i.e. most "inside"
// for) the given pixel, and outputs the local coordinate frame / tint for
// that region — mirroring the single dock_* rect's local_pos/box_size
// derivation below, just repeated per-region using the shared `corner_radius`
// uniform (set once via LiquidEffect.setCornerRadius(), same as legacy mode).
//
// Regions are expected not to overlap (toggle pods never overlap on
// screen), so at most one region is actually "inside" for any given pixel;
// ties (or the zero-region case) are resolved by picking the smallest SDF
// distance, which correctly degrades to "outside everything" — the normal
// insideMask/outsideMask smoothstep further down in main() already treats
// a large positive distance as fully transparent, so no extra handling is
// needed here for the empty/out-of-range case.
float findActiveRegion(vec2 pixel_coord, float pad, out vec2 outLocalPos, out vec2 outBoxSize, out vec3 outTint, out float outBaseStrength) {
    float bestD = 1.0e6;
    outLocalPos = vec2(1.0e6);
    outBoxSize = vec2(1.0);
    outTint = vec3(1.0);
    outBaseStrength = 0.0;

    int count = int(min(region_count, float(MAX_GLASS_REGIONS)));

    for (int i = 0; i < MAX_GLASS_REGIONS; i++) {
        if (i >= count) break;

        vec2 rPos = vec2(region_x[i], region_y[i]);
        vec2 rSize = vec2(region_w[i], region_h[i]);
        vec2 rCenter = rPos + rSize * 0.5;
        vec2 rLocal = pixel_coord - rCenter;

        vec2 actual_size = rSize - vec2(pad * 2.0);
        vec2 rBox = max(actual_size * 0.5, vec2(1.0));

        float d = sdRoundRect(rLocal, rBox, corner_radius);
        if (d < bestD) {
            bestD = d;
            outLocalPos = rLocal;
            outBoxSize = rBox;
            outTint = vec3(region_tint_r[i], region_tint_g[i], region_tint_b[i]);
            outBaseStrength = region_base_strength[i];
        }
    }

    return bestD;
}

// Normalizes the depth value based on the edge curvature.
float normalizedDepth(float d, vec2 b, float r) {
    // Limits the height build-up strictly to the pixel width defined by 'corner_radius'.
    // This prevents the glass from curving endlessly towards the center.
    float maxDepth = max(r, 1.0); 
    
    float interiorDepth = max(-d, 0.0);
    return clamp(interiorDepth / maxDepth, 0.0, 1.0);
}

// Calculates the surface height profile using a superellipse formula.
float profileHeight(float t, float zScale) {
    // Superellipse profile: h = H * (1 - (1 - t)^n)^(1/n), t: edge=0 -> center=1.
    float n = max(profile_shape_n, 1.01);
    float invT = clamp(1.0 - t, 0.0, 1.0);
    float inner = max(1.0 - pow(invT, n), 0.0);
    float h = pow(inner, 1.0 / n);
    return h * zScale;
}

// Computes the absolute height at a specific 2D coordinate.
float getHeight(vec2 p, vec2 b, float r, float zScale) {
    float d = sdRoundRect(p, b, r);

    // [FIX 1] Soft boundary fade instead of a hard step at d=0.
    // A hard "if (d > 0) return 0" causes a discontinuous jump in the height
    // field. When heightGradient() straddles this boundary via finite
    // differences, it produces a large spurious gradient spike that manifests
    // as jaggy displacement especially against high-frequency backgrounds.
    // Allowing a smooth fade over ±edge_smoothing pixels eliminates the spike.
    float smoothZone = max(edge_smoothing, 1.0);
    if (d > smoothZone)
        return 0.0;

    float t = normalizedDepth(d, b, r);
    float h = profileHeight(t, zScale);

    // Taper height continuously to zero as d approaches the boundary from inside,
    // and continue fading through the thin outer fringe (0 < d < smoothZone).
    // [FIX] Same edge0>edge1 undefined-behavior pattern as insideMask/edgeBand
    // above (harmless here in practice since the `d > smoothZone` guard above
    // already bounds this call's domain, but corrected for consistency).
    float fade = 1.0 - smoothstep(-smoothZone, smoothZone, d);
    return h * fade;
}

// Dynamically adjusts the sampling step size for normal estimation based on resolution.
float gradientStep(vec2 resolution) {
    float minRes = max(min(resolution.x, resolution.y), 1.0);
    return clamp(minRes / 560.0, 0.45, 1.20);
}

// Unit gradient of sdRoundRect() at p — i.e. the direction of steepest
// increase of the signed distance, which for an SDF is simply "straight out
// of the shape". Closed form, no sampling.
//
// This is the same construction the distance function itself is built from:
// inside the cross (both q components negative) the nearest edge is whichever
// axis is closest, so the gradient is that axis; in the corner quadrant the
// distance is length(max(q, 0)) and its gradient is that vector normalized.
// sign(p) mirrors the result back out of the abs() folded first quadrant.
vec2 sdRoundRectDir(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    if (max(q.x, q.y) < 0.0) {
        // Edge region: nearest boundary is a straight side.
        return (q.x > q.y) ? vec2(sign(p.x), 0.0) : vec2(0.0, sign(p.y));
    }
    // Corner region: radially outward from the corner circle's centre.
    return sign(p) * normalize(max(q, 0.0) + vec2(1e-6));
}

// Height gradient of the glass surface at p.
//
// The height is a function of the signed distance alone — getHeight(p) is
// profileHeight(t(d)) * fade(d) with d = sdRoundRect(p) — so by the chain
// rule its gradient is
//
//     grad(H) = H'(d) * grad(d)
//
// and grad(d) is available in closed form from sdRoundRectDir() above. Only
// the scalar H'(d) is left to estimate, which takes one central difference
// ALONG that direction instead of two along each axis.
//
// [PERF] 4 getHeight() calls -> 2, i.e. 8 pow() -> 4 and 5 sdRoundRect() -> 3.
// (Do not expect this to move the GPU needle: the earlyExit A/B measurement
// showed this shader's arithmetic is a small fraction of the frame. The
// reasons to do it are accuracy and deleting the fast_mode fork, which this
// change removed outright.)
//
// [FIX] More accurate than the axis-aligned version it replaces, not just
// cheaper. Differencing along x and y separately picks up the SDF's curvature
// across the step, so the resulting vector was never exactly parallel to
// grad(d) — most visible on rounded corners, where the two axes disagree
// about the surface orientation. Differencing along the true gradient
// direction cannot tilt the normal that way.
//
// H'(d) is NOT evaluated in closed form on purpose. It exists — but the
// superellipse profile has an infinite slope at t = 0 (the surface is
// vertical exactly at the glass edge; profileHeight's inner^(1/n) term has an
// unbounded derivative there for n > 1). The finite difference is what keeps
// that bounded, at a magnitude tied to gradientStep(), which is precisely the
// smoothing the current look depends on.
vec2 heightGradient(vec2 p, vec2 b, float r, float zScale, vec2 resolution) {
    vec2 dir = sdRoundRectDir(p, b, r);
    float e = gradientStep(resolution);

    float hOut = getHeight(p + dir * e, b, r, zScale);
    float hIn  = getHeight(p - dir * e, b, r, zScale);

    return dir * ((hOut - hIn) / (2.0 * e));
}

// Converts the 2D gradient into a 3D normal vector.
vec3 getNormal(vec2 gradH) {
    return normalize(vec3(-gradH.x, -gradH.y, 1.0));
}

// Calculates the UV coordinate displacement caused by light refraction.
vec2 getDisplacement(float d, vec3 normal, vec2 resolution) {
    if (d > 0.0)
        return vec2(0.0);

    // Standard incident view vector (looking directly into the screen)
    vec3 viewDir = vec3(0.0, 0.0, -1.0);
    
    // Refract light using Snell's law (Air ~ 1.0 -> Glass ~ IOR)
    float eta = 1.0 / max(ior, 1.001);
    vec3 refractedRay = refract(viewDir, normal, eta);

    // If total internal reflection occurs, refractedRay is (0,0,0)
    if (length(refractedRay) < 0.0001)
        return vec2(0.0);

    float minRes = max(min(resolution.x, resolution.y), 1.0);

    // Safety clamp: Prevent infinite stretching artifacts near extreme curves
    // by ensuring the Z component never gets dangerously close to 0.
    float safe_z = max(-refractedRay.z, 0.15);

    // [FIX] displacement_scale is now in PIXELS, on both axes.
    //
    // It used to be divided by minRes — the SHORTER side of the actor — and
    // the resulting UV offset then covered `resolution`, which is the longer
    // side too. So the same refraction came out 1.78x stronger horizontally
    // than vertically on a full-screen (1920x1080) FBO, and a different
    // strength again on every differently-shaped application window: the
    // surfaces that share one "Displacement Scale" slider were not sharing
    // one displacement. Wide surfaces got their left and right edges
    // over-refracted, which is precisely where the smeared, stretched-looking
    // edge is worst.
    //
    // Dividing by `resolution` per axis makes the offset exactly
    // displacement_scale pixels in every direction, on every surface — the
    // same correction chroma_strength already received below (and the JS side
    // derives the blur/capture margins from the same figure, see
    // _computeBlurRect()).
    vec2 displacement = (refractedRay.xy / safe_z) *
                        (displacement_scale / max(resolution, vec2(1.0)));

    // The cap is expressed in the same pixel terms. 0.30 of the shorter side
    // is what the old UV-space clamp worked out to, so nothing that was
    // previously in range starts clipping now.
    float max_disp_px = 0.30 * minRes;
    vec2 dispPx = displacement * resolution;
    float dispLenPx = length(dispPx);
    if (dispLenPx > max_disp_px) {
        displacement *= max_disp_px / dispLenPx;
    }

    return displacement;
}

// Stabilizes UV coordinates near the edges to prevent black borders from bilinear filtering.
vec2 stabilizedUV(vec2 candidate, vec2 fallback) {
    vec2 clamped = clamp(candidate, vec2(0.001), vec2(0.999));
    float edgeDist = min(min(candidate.x, candidate.y), min(1.0 - candidate.x, 1.0 - candidate.y));
    float keep = smoothstep(-0.04, 0.03, edgeDist);
    return mix(fallback, clamped, keep);
}

// [PERF] Maps a full-actor UV (0..1 across `resolution`) into the blurred
// sub-rect's own UV, clamped 1.2 texels inside it — the same margin the old
// SAFE() macro kept from the capture's edge, just measured against the rect.
// When the rect covers the whole actor this is exactly the old expression.
vec2 blurUV(vec2 fullUV, vec2 resolution) {
    vec2 uv;
    vec2 size;
    if (blur_rect_w < 1.0 || blur_rect_h < 1.0) {
        vec2 mFull = vec2(1.2) / max(resolution, vec2(1.0));
        uv = clamp(fullUV, mFull, vec2(1.0) - mFull);
        size = max(resolution, vec2(1.0));
    } else {
        size = vec2(blur_rect_w, blur_rect_h);
        vec2 m = vec2(1.2) / size;
        uv = clamp((fullUV * resolution - vec2(blur_rect_x, blur_rect_y)) / size,
                   m, vec2(1.0) - m);
    }

    // [FIX] Smooth-bilinear reconstruction (see the blur_tex_* uniforms).
    //
    // Bilinear filtering reconstructs a magnified texture with a tent kernel:
    // continuous in value, discontinuous in slope exactly at every texel
    // centre. Warping the coordinate inside its texel by a smoothstep before
    // the hardware interpolates turns that tent into a cubic-like kernel with
    // a continuous first derivative — the standard trick, and it costs four
    // ALU ops rather than the 16 fetches a real bicubic would.
    //
    // Only applied where the texture is actually being magnified: at 1:1 the
    // warp would MOVE samples away from their texel centres for no benefit.
    vec2 texSize = vec2(blur_tex_w, blur_tex_h);
    if (texSize.x >= 2.0 && texSize.y >= 2.0 &&
        min(size.x / texSize.x, size.y / texSize.y) > 1.05) {
        vec2 t = uv * texSize - 0.5;
        vec2 f = fract(t);
        f = f * f * (3.0 - 2.0 * f);
        uv = (floor(t) + 0.5 + f) / texSize;
    }
    return uv;
}

// Averages the blurred backdrop over the area of the source this pixel
// actually covers.
//
// [FIX] Why an anisotropic footprint is needed at all.
//
// Refraction is a MINIFICATION near the glass edge: the displacement grows
// from zero to its maximum across a band only a few pixels wide, so those few
// pixels between them have to represent everything the ray sweeps past — tens
// of source pixels. Point-sampling that (which four RGSS taps spread over
// 2.5px effectively are) is textbook undersampling, and it looks exactly like
// what it is: the edge band sparkles and breaks up over high-frequency
// backgrounds, and any strong colour boundary crossing it turns into a
// jagged, unstable line. No amount of shape antialiasing touches it, because
// the geometry is not what is aliasing — the texture lookup is.
//
// `ext` is HALF that footprint, as a UV vector pointing along the direction
// the compression happens in (see the derivation in main()). vec2(0) selects
// the original four-tap behaviour unchanged, which is what every pixel
// outside the compressed band passes in.
vec3 sampleBackdrop(vec2 uvc, vec2 ext, vec2 texel, vec2 resolution) {
    vec2 o1 = vec2( 0.375, -0.125) * texel;
    vec2 o2 = vec2( 0.125,  0.375) * texel;
    vec2 o3 = vec2(-0.375,  0.125) * texel;
    vec2 o4 = vec2(-0.125, -0.375) * texel;

    vec3 sum =
        texture2D(cogl_sampler1, blurUV(uvc + o1, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + o2, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + o3, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + o4, resolution)).rgb;

    if (dot(ext, ext) <= 0.0)
        return sum * 0.25;

    // Six more taps along the footprint, keeping the rotated-grid offsets so
    // the line is not sampled on a single scanline. Uneven spacing (0.9 /
    // 0.55 / 0.22) weights the centre a little more than a plain box filter
    // would, which keeps the refraction from looking smeared while still
    // covering the whole span.
    sum +=
        texture2D(cogl_sampler1, blurUV(uvc + ext * 0.90 + o1, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + ext * 0.55 + o2, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + ext * 0.22 + o3, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc - ext * 0.22 + o4, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc - ext * 0.55 + o1, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc - ext * 0.90 + o2, resolution)).rgb;

    return sum * 0.1;
}

// Screen-static ordered-ish noise, +-0.5/255, added just before the result is
// quantised to 8 bits.
//
// [NEW] The backdrop behind the glass is blurred, which means it is almost
// always a very shallow gradient — and a shallow gradient in 8 bits banks up
// into visible Mach bands (the "steps" across the glass over a smooth
// wallpaper). One LSB of noise breaks the quantisation up into dithering
// noise the eye integrates away instead. It is also, not coincidentally, part
// of why the real thing reads as a material rather than as a gradient.
float ditherLSB(vec2 p) {
    return (fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
}

// [NEW] Adjust color saturation, contrast, brightness
vec3 applySCB(vec3 color, float b, float c, float s) {
    // 1. 輝度 (Brightness): 単純な乗算
    color *= b;
    
    // 2. コントラスト (Contrast): 0.5のグレーを基準に距離を拡大・縮小
    color = mix(vec3(0.5), color, c);
    
    // 3. 彩度 (Saturation): グレースケール値とのブレンド
    // 人間の目の感度に基づいた重み（Rec. 601）を使用
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, s);
    
    // コントラスト調整等でマイナスになった値を0に丸める
    return max(color, 0.0);
}

// The flat "panel background" fallback fill, composited UNDER the glass+shadow
// result. Extracted from the tail of main() so the fast paths there can apply
// the identical term; see the panel_bg_* / panel_rect_* uniform comments.
//
// Returns the PREMULTIPLIED contribution: .rgb is already scaled by .a, which
// is what the caller adds to finalRgb / finalAlpha respectively.
//
// `coveredAlpha` is how much the glass itself already covers this pixel — the
// fill only shows through whatever is left.
vec4 panelFallback(vec2 pixel_coord, float coveredAlpha) {
    vec2 panelCenter = vec2(panel_rect_x, panel_rect_y) + vec2(panel_rect_w, panel_rect_h) * 0.5;
    vec2 panelLocal = pixel_coord - panelCenter;
    vec2 panelBox = max(vec2(panel_rect_w, panel_rect_h) * 0.5, vec2(1.0));
    float panelDist = sdRoundRect(panelLocal, panelBox, corner_radius);
    float panelMask = 1.0 - smoothstep(-1.0, 1.0, panelDist);

    float contribution = panel_bg_a * (1.0 - coveredAlpha) * panelMask;
    return vec4(vec3(panel_bg_r, panel_bg_g, panel_bg_b) * contribution, contribution);
}

void main() {
    vec2 resolution = vec2(resolution_x, resolution_y);
    vec2 uv = cogl_tex_coord_in[0].st;
    
    vec2 pixel_coord = uv * resolution;

    // [CHANGED] Full-screen FBO coordinate reconstruction.
    //
    // Previously the effect actor was sized to the dock area, so "center" was
    // simply resolution * 0.5 and local_pos was measured from that center.
    //
    // Now the effect actor spans the entire monitor (full-screen FBO).
    // We reconstruct the dock center from the dock_* uniforms supplied by
    // dockManager, giving us the same dock-centred local coordinate system
    // without any FBO size / BMS absolute-coordinate mismatch.
    //
    // Pre-calculate geometry anti-aliasing feathering width.
    float edgeFeather = max(edge_smoothing, 0.75);

    // [NEW] Multi-region branch (Quick Settings "Toggles" mode): pick the
    // nearest of up to MAX_GLASS_REGIONS small rounded rects instead of the
    // single dock_* rect. See findActiveRegion() above.
    vec2 local_pos;
    vec2 box_size;
    vec3 activeTint;
    // [FIX-8] Base-color layer strength for the winning region. Stays 0 in
    // legacy (single-rect) mode, which has no per-element "own color" concept
    // — that path is bit-for-bit unchanged.
    float activeBaseStrength = 0.0;
    float d;

    if (multi_region_mode > 0.5) {
        d = findActiveRegion(pixel_coord, padding, local_pos, box_size, activeTint, activeBaseStrength);
    } else {
        // dock_center is in the same pixel space as pixel_coord (monitor-local).
        vec2 dock_center = vec2(dock_x + dock_w * 0.5, dock_y + dock_h * 0.5);

        // local_pos: pixel offset from the dock center — identical semantics to
        // the old (pixel_coord - resolution*0.5) but now pinned to the dock, not
        // to the actor boundary.
        local_pos = pixel_coord - dock_center;

        // [CHANGED] box_size is derived from dock_w / dock_h instead of resolution.
        // Previously the whole actor was dock-sized so resolution == dock size.
        // Now resolution is the full monitor size; using it here would produce a
        // vastly oversized rounded rectangle.  dock_w/dock_h give the true extents
        // of the glass shape (including SHADER_PADDING on all sides).
        if (isDock > 0.5) {
            // For the dock, shrink the box so the feathered edges don't reach
            // the dock background boundary.
            vec2 actual_size = vec2(dock_w, dock_h) - vec2(padding * 2.0) - vec2(edgeFeather * 2.0);
            box_size = max(actual_size * 0.5, vec2(1.0));
        } else {
            vec2 actual_size = vec2(dock_w, dock_h) - vec2(padding * 2.0);
            box_size = max(actual_size * 0.5, vec2(1.0));
        }

        // Distance from the current pixel to the rounded rectangle boundary.
        d = sdRoundRect(local_pos, box_size, corner_radius);
        activeTint = vec3(tint_r, tint_g, tint_b);
    }
    
    // Geometry Anti-Aliasing: Smoothstep forces a sub-pixel soft transition.
    // Inside = 1.0, Outside = 0.0.
    //
    // [FIX] Root cause of the "whole screen darkens by a flat amount as
    // shadow_radius/shadow_intensity increase" bug.
    //
    // This used to be `smoothstep(edgeFeather, -edgeFeather, d)` — edge0
    // (+edgeFeather) is numerically LARGER than edge1 (-edgeFeather). Per the
    // GLSL spec, smoothstep()'s result is *undefined* whenever edge0 >= edge1;
    // it is only guaranteed to behave as documented when edge0 < edge1.
    //
    // With the standard textbook implementation
    // (t = clamp((x-edge0)/(edge1-edge0), 0, 1)) the swapped call still
    // happens to evaluate correctly, which is why the drop shadow itself
    // renders correctly right next to the dock (where |d| is small, so any
    // implementation difference is hard to notice). But several real
    // GLSL/GLSL-ES compilers (and fixed-function/optimized paths some
    // drivers substitute for smoothstep) implement it as sequential branches
    // that assume edge0 < edge1, e.g. `x <= edge0 -> 0`, `x >= edge1 -> 1`.
    // Evaluated with our swapped edges, ANY pixel with d > edgeFeather
    // (i.e. every pixel more than a couple of px outside the dock — the
    // entire rest of the monitor) satisfies `x >= edge1` (edge1 is negative)
    // and is misclassified as insideMask = 1.0 / outsideMask = 0.0 — or, in
    // the mirror-image cases, leaves outsideMask pinned to a non-decaying
    // constant far past where the umbra/penumbra falloff was supposed to
    // reach zero. Either way, the fixed, flat-looking tint over the whole
    // screen that scales with shadow_intensity (and is gated by
    // radiusEnable/shadow_radius) is exactly this outsideMask term failing
    // to fall back to 0 away from the dock.
    //
    // Fix: compute the same 0..1 transition using a call whose edges are
    // always in increasing order (-edgeFeather < edgeFeather), which is
    // well-defined on every driver, and derive insideMask as its complement.
    // Mathematically this produces IDENTICAL values to the original
    // (well-behaved) formula — only the undefined-behavior input ordering is
    // removed.
    float outsideTransition = smoothstep(-edgeFeather, edgeFeather, d);
    float insideMask = 1.0 - outsideTransition;
    float outsideMask = outsideTransition;

    // ══════════════════════════════════════════════════════════════════════
    // [PERF] Two early exits. Everything between here and the final composite
    // is per-pixel work that provably collapses to a constant in these two
    // regions, and the two of them together cover the large majority of every
    // glass surface — the whole monitor minus the dock for the full-screen
    // FBO surfaces (dock/menu/notification/OSD/quick-settings), and ~80% of
    // the area for an application window.
    //
    // Both are spatially coherent (one big contiguous region each), so a GPU
    // wavefront takes one side or the other wholesale rather than paying for
    // both.
    // ══════════════════════════════════════════════════════════════════════

    // ── Exit 1: beyond the shadow's reach ─────────────────────────────────
    // Past maxRadius the shadow block below multiplies its result by
    // `1.0 - step(maxRadius, d)` (and by a boundsMask that is already 0
    // there), and insideMask is 0 for any d >= edgeFeather. So alpha,
    // shadowContribution and finalRgb are all exactly 0, and the only thing
    // that can still write a pixel is the panel fallback fill.
    //
    // Multi-region mode (Quick Settings "Toggles") zeroes shadowAlpha
    // outright further down, so there the shape's own edge is the only thing
    // that can produce a pixel and the exit can start right at edgeFeather.
    float shadowReach = (multi_region_mode > 0.5) ? 0.0 : max(shadow_max_radius, 5.0);
    if (early_exit_enabled > 0.5 && debug_view < 0.5 && d >= max(shadowReach, edgeFeather)) {
        cogl_color_out = panelFallback(pixel_coord, 0.0) * cogl_color_in;
        return;
    }

    // ── Exit 2: the flat interior ─────────────────────────────────────────
    // Deep enough inside the shape that the height profile has reached its
    // plateau, which makes the surface geometrically flat:
    //
    //   getHeight() == max_z everywhere in a gradientStep() neighbourhood
    //     => heightGradient() == 0
    //     => normal == (0, 0, 1)
    //     => refract() returns (0, 0, -1) => displacement == 0
    //
    // and with a flat normal every edge term vanishes as well: rimDot is
    // 1 - dot(N, viewDir) = 0 so the Fresnel rim is 0, edgeBand is 0 past
    // rim_width, the AO band is 0 past ao_radius, insideMask is 1 so the
    // shadow contributes nothing, and the panel fill is masked out by
    // (1 - finalAlpha) == 0.
    //
    // What survives is constant across the whole region: the specular and
    // sheen lobes evaluated at N = (0, 0, 1). Both are folded in below.
    //
    // The threshold has to clear every one of those terms at once, including
    // the finite-difference neighbourhood the gradient samples (the SDF is
    // 1-Lipschitz, so a step of `e` moves d by at most `e`).
    float smoothZoneEarly = max(edge_smoothing, 1.0);
    float interiorThreshold = max(
        max(corner_radius + gradientStep(resolution) + smoothZoneEarly,
            edgeFeather * 4.0),
        max(ao_radius, rim_width));
    if (early_exit_enabled > 0.5 && debug_view < 0.5 && -d >= interiorThreshold) {
        // Refraction is zero here, so this is the same coordinate the full
        // path would arrive at: stabilizedUV(uv + 0, uv).
        vec2 uvFlat = stabilizedUV(uv, uv);

        // Same 4-tap RGSS pattern, with the same aa_spread the full path
        // would compute (edgeProximity == 0 => mix(0.75, 2.5, 0) == 0.75).
        vec2 texelFlat = vec2(0.75) / resolution;
        vec3 flatRgb = (
            texture2D(cogl_sampler1, blurUV(uvFlat + vec2( 0.375, -0.125) * texelFlat, resolution)).rgb +
            texture2D(cogl_sampler1, blurUV(uvFlat + vec2( 0.125,  0.375) * texelFlat, resolution)).rgb +
            texture2D(cogl_sampler1, blurUV(uvFlat + vec2(-0.375,  0.125) * texelFlat, resolution)).rgb +
            texture2D(cogl_sampler1, blurUV(uvFlat + vec2(-0.125, -0.375) * texelFlat, resolution)).rgb
        ) * 0.25;

        flatRgb = applySCB(flatRgb, brightness, contrast, saturation);
        flatRgb = mix(flatRgb, activeTint, activeBaseStrength);
        flatRgb = mix(flatRgb, vec3(tint_r, tint_g, tint_b), tint_strength);

        // Specular and sheen at N = (0, 0, 1). reflect(-L, N) is
        // (-L.x, -L.y, L.z), so dot(reflectDir, viewDir) is L.z; the sheen's
        // facing term dot(N, L) is L.z as well. specMask reduces to
        // mix(0.25, 1.0, 1.0) * clamp(0.0 + 0.65, 0, 1) == 0.65.
        vec3 lightDirFlat = normalize(vec3(cos(radians(light_angle_deg)),
                                           sin(radians(light_angle_deg)), 0.38));
        float facing = max(lightDirFlat.z, 0.0);
        float specFlat = pow(facing, max(shininess, 1.0)) * specular_intensity * 0.65;
        float sheenFlat = pow(facing, 1.65) * sheen_intensity;
        vec3 addedFlat = vec3(specFlat + sheenFlat) * surface_light_enabled;

        // Screen blend, then the same overflow normalization as the full path.
        vec3 litFlat = flatRgb + addedFlat - (flatRgb * addedFlat);
        float maxChannelFlat = max(litFlat.r, max(litFlat.g, litFlat.b));
        if (maxChannelFlat > 1.0) {
            litFlat /= maxChannelFlat;
        }
        litFlat = max(litFlat, 0.0);

        // [NEW] See ditherLSB(). The flat interior is where banding shows the
        // most: it is a blurred gradient with nothing else drawn over it.
        litFlat = max(litFlat + ditherLSB(pixel_coord), 0.0);

        // alpha == insideMask == 1, so the shadow and panel terms are both 0.
        cogl_color_out = vec4(litFlat, 1.0) * cogl_color_in;
        return;
    }

    // ------------------------------------------------------------------
    // Realistic drop shadow (anchors the glass on light backgrounds).
    //
    // Real shadows from a glass object have:
    //   * UMBRA   - a tight, dark core where the glass fully blocks the
    //               light source. Sharpest right at the edge.
    //   * PENUMBRA - a wider, softer halo where the glass partially blocks
    //                the light. Decays slowly with distance.
    //   * DIRECTIONAL EXTENSION - the shadow extends slightly further on
    //                the side opposite the light source (governed by
    //                light_angle_deg), not symmetrically in all directions.
    //   * COLOR TINT - real shadows are never pure black. They pick up
    //                ambient light (cool/blue cast for typical lighting).
    //
    // Composited via the Cogl premultiplied-alpha pipeline: a tinted-dark
    // color with alpha `s` darkens the destination by (1 - s) -> drop shadow.
    // ------------------------------------------------------------------

    // 1) Compute the 2D shadow direction in screen space (y points down).
    float lightAngleRad = radians(light_angle_deg);
    vec2 lightDir2D = vec2(cos(lightAngleRad), -sin(lightAngleRad));
    vec2 shadowDir   = -lightDir2D;   // shadow falls away from the light

    // 2) Outward direction from the glass center to this pixel. (Small
    //    epsilon avoids NaN at the exact center where local_pos == 0.)
    vec2 outwardDir = normalize(local_pos + vec2(1e-4));

    // 3) How much this pixel "faces" the shadow side. 0 = on the lit side,
    //    1 = directly opposite the light. max() clamps the lit side to 0.
    float lightAlignment = max(dot(outwardDir, shadowDir), 0.0);

    // 4) Subtle directional factor: 85% on the lit side, 100% on the shadow
    //    side. Gentle so the shadow still feels symmetric on bottom docks
    //    (where there's no room for it to extend "down" anyway).
    float dirRadius    = 0.85 + lightAlignment * 0.15;
    float dirIntensity = 0.85 + lightAlignment * 0.15;

    // 5) Clamp the effective radius to the bgActor's clipped render area so
    //    the shadow's penumbra cannot get hard-clipped at the actor boundary.
    //    [FIX] This used to derive from `padding` (a fixed 20px optical
    //    margin for refraction/blur, unrelated to the shadow feature), which
    //    capped every shadow_radius setting above ~18-21 to the same fixed,
    //    disproportionately dark ~18px band — no matter how far past that
    //    the 0-100 slider was pushed. shadow_max_radius instead reflects the
    //    real room available (synced from dockManager's CLIP_PADDING), so a
    //    large shadow_radius produces a correspondingly wide, gradual, soft
    //    shadow instead of the same intensity compressed into a tiny band.
    float maxRadius = max(shadow_max_radius, 5.0);
    float effectiveRadius    = min(shadow_radius * dirRadius, maxRadius);

    // 5b) [FIX] Master on/off switch driven purely by the user's radius
    //     setting. Previously effectiveIntensity depended only on
    //     shadow_intensity, so setting shadow_radius to 0 still left a
    //     visible shadow: the umbra term below stabilizes its divisor with
    //     a fixed max(..., 0.5) floor, which keeps producing a ~0.5px-wide,
    //     up-to-0.8-alpha dark band right at the glass edge no matter how
    //     small effectiveRadius gets. A short smoothstep ramp (rather than a
    //     hard step()) avoids a visible pop for very small nonzero radii.
    float radiusEnable = smoothstep(0.0, 0.75, shadow_radius);
    float effectiveIntensity = shadow_intensity * dirIntensity * radiusEnable;

    // [FIX] Guard against a 0/0 division when effectiveRadius collapses to
    // 0 (shadow_radius = 0): penumbra_t below used to divide by
    // effectiveRadius directly, which produces NaN exactly at d == 0 -
    // i.e. exactly on the glass boundary. NaN survives the later
    // "* effectiveIntensity" multiply (NaN * 0 is still NaN, not 0), so it
    // was reaching the final composite and rendering as a dark hairline
    // right on the glass edge even after the radiusEnable fix above.
    float safeRadius = max(effectiveRadius, 0.001);

    // 6) UMBRA: tight, dark core. Linear decay over 0.4 * effectiveRadius.
    //    This is the "contact shadow" band - very close to the glass.
    float umbra_t = clamp(d / max(safeRadius * 0.40, 0.5), 0.0, 1.0);
    float umbra  = (1.0 - umbra_t) * 0.80;

    // 7) PENUMBRA: wider, softer halo.
    //    [FIX] Previously a plain squared falloff (pow(1-t, 2)): its value
    //    reaches exactly 0 at t=1 with zero SLOPE, but its CURVATURE
    //    (2nd derivative) at t=1 is still nonzero (d^2/dt^2 of (1-t)^2 is a
    //    constant 2, not 0). Right where the curve meets the flat "outside
    //    shadow" region (which has zero value, slope, AND curvature), that
    //    curvature mismatch reads as a faint but visible bend/ring at the
    //    shadow's outer edge instead of a truly continuous fade.
    //
    //    Replaced with a quintic "smootherstep" ease (6t^5-15t^4+10t^3,
    //    Perlin's improved curve) applied to the fading term. It has zero
    //    value, zero 1st derivative, AND zero 2nd derivative at t=1, so the
    //    penumbra flattens smoothly INTO the surrounding zero rather than
    //    just touching it — matching curvature with the "no shadow" region
    //    outside, for a genuinely continuous transition.
    float penumbra_t = clamp(d / safeRadius, 0.0, 1.0);
    float penumbraFade = 1.0 - penumbra_t; // 1 at glass edge -> 0 at outer radius
    float penumbraEase = penumbraFade * penumbraFade * penumbraFade *
        (penumbraFade * (penumbraFade * 6.0 - 15.0) + 10.0);
    float penumbra = penumbraEase * 0.55;

    // 8) Combined shadow alpha, applied only OUTSIDE the glass shape.
    float shadowAlpha = clamp(
        (umbra + penumbra) * outsideMask * effectiveIntensity,
        0.0, 1.0
    );

    // [FIX] Use the same clamped `maxRadius` here that effectiveRadius/
    // safeRadius above are derived from, instead of the raw
    // `shadow_max_radius` uniform. They happen to be numerically identical
    // whenever shadow_max_radius >= 5 (the normal case, since dockManager
    // syncs it from CLIP_PADDING - 20 = 180), but keeping every cutoff in
    // this block anchored to the exact same value removes a latent
    // inconsistency: if shadow_max_radius were ever synced to something
    // below 5 (e.g. transiently, before the first geometry sync completes,
    // or on a future call site that forgets the CLIP_PADDING margin), this
    // bound and effectiveRadius's cap would silently disagree.
    // [FIX] Previously started fading at just 10% of maxRadius. Whenever
    // effectiveRadius (the penumbra's own natural falloff distance) was
    // smaller than maxRadius — the common case — this made boundsMask start
    // clipping the shadow *while the penumbra curve above was still
    // decaying*, layering a second, independent smoothstep on top of it.
    // Two smooth-but-different curves multiplied together bend the combined
    // curve at a point that has nothing to do with the shadow's actual
    // outer edge, which reads as an extra "shoulder" partway through the
    // fade. boundsMask only exists to guarantee the shadow can't get
    // hard-clipped at the bgActor's physical boundary (maxRadius) — it
    // should stay at 1.0 (no-op) through the entire range the penumbra
    // curve is already handling, and only engage in the last stretch right
    // before maxRadius. Starting at 85% keeps it out of the way for
    // virtually every shadow_radius setting, only smoothing the rare case
    // where effectiveRadius is pushed all the way up to maxRadius.
    float boundsFade = 1.0 - smoothstep(maxRadius * 0.85, maxRadius, d);
    // Same quintic ease as the penumbra above, so this safety fade also
    // reaches zero value/slope/curvature together at d = maxRadius,
    // continuous with the (curvature-free) fully-outside region beyond it.
    float boundsMask = boundsFade * boundsFade * boundsFade *
        (boundsFade * (boundsFade * 6.0 - 15.0) + 10.0);
    shadowAlpha *= boundsMask;

    // [FIX] Defense-in-depth hard cutoff, independent of any smoothstep().
    // `step(edge, x)` has only a single comparison point (no edge0/edge1
    // ordering to get wrong) and is well-defined on every driver: it
    // returns 0 once d passes maxRadius, guaranteeing the shadow can never
    // bleed past its own configured range no matter what a given GPU/driver
    // does with the smoothstep() calls above.
    shadowAlpha *= 1.0 - step(maxRadius, d);

    // [NEW] Multi-region mode never draws a drop shadow: a per-region shadow
    // makes little visual sense for many small independent chips, and
    // shadow-radius/shadow-intensity are shared global settings that other
    // consumers (dock, menu, notification, background QS) still control
    // independently. Zeroing here (rather than skipping the computation
    // above) keeps this a minimal, low-risk addition.
    if (multi_region_mode > 0.5) {
        shadowAlpha = 0.0;
    }

    // [DEBUG] See the debug_view uniform. Placed here because shadowAlpha is
    // final at this point (the multi-region zeroing above is the last thing
    // that touches it).
    if (debug_view > 0.5) {
        // Mode 1 gamma-boosts both channels because the raw values are easy
        // to misread: a drop shadow at the default intensity peaks around
        // 0.29, and RGB(0.29, 0, 0) on black reads as "black" to the eye.
        // pow(x, 0.35) lifts that to ~0.64 while still mapping 0 to 0, so
        // "no shadow at all" stays unambiguous. Mode 2 leaves the values raw
        // for when the exact magnitude matters.
        float dbgShadow = (debug_view < 1.5) ? pow(shadowAlpha, 0.35) : shadowAlpha;
        float dbgInside = (debug_view < 1.5) ? pow(insideMask, 0.35) : insideMask;
        cogl_color_out = vec4(dbgShadow, dbgInside, 0.0, 1.0) * cogl_color_in;
        return;
    }

    // 9) Shadow color: dark with a subtle cool/blue cast. Suggests ambient
    //    sky light bleeding into the shadow (a hallmark of realistic
    //    outdoor / window-lit shadow rendering). Avoids the "painted-on
    //    pure black" look.
    vec3 shadowColor = vec3(0.03, 0.04, 0.08);

    // [PERF] A `vec4 source = texture2D(cogl_sampler1, uv);` used to sit here
    // and was never read by anything below — the body samples the blurred
    // layer through the RGSS block further down and nowhere else. Most
    // drivers dead-code-eliminate an unused fetch, but not all of them do it
    // reliably for a texture lookup, and there is nothing to gain by leaving
    // it to chance.

    vec2 gradH = heightGradient(local_pos, box_size, corner_radius, max_z, resolution);
    vec3 normal = getNormal(gradH);

    vec2 disp = getDisplacement(d, normal, resolution);

    // ── Edge lensing ──────────────────────────────────────────────────────
    //
    // [FIX] The rim used to refract in the OPPOSITE direction to the band
    // just inside it — "centre: barely refracts / middle: refracts / rim:
    // refracts the other way".
    //
    // `disp` points inward, so a pixel at depth `u` inside the boundary shows
    // the background from `u + D(u)`. What the eye reads as "which way does
    // it bend" is the sign of dD/du, and the old `edgeDampen` ramp inverted
    // it on purpose: it pulled the displacement back to ZERO at the boundary,
    // so across the outermost few pixels the sample point swept back the way
    // it came. Widening that ramp did not remove the reversal, it only made
    // it big enough to name.
    //
    // The ramp is gone. What shapes the edge now is a weight that GROWS
    // towards the rim, so D grows towards the rim too and there is one
    // direction across the whole bevel:
    //
    //     D(u) = D_raw(u) * (1 - u/bevel)^falloff
    //
    // The raw refraction keeps its full magnitude at the rim — with the
    // shipped settings that is ~66px, where the previous fraction-of-bevel
    // envelope allowed 11px — and `falloff` decides how much of the bevel the
    // build-up is packed into. Deeper in, the weight and the raw field fall
    // off together, which is what leaves the middle flat.
    //
    // The mapping is allowed to fold (dD/du > 1, the image doubling back),
    // because that is what a thick glass edge does and it is part of the look
    // this is after. Folding costs sampling density, not correctness — so it
    // is paid for in sampleBackdrop(), which spreads its taps over the
    // footprint computed below.
    float bevelPx = max(min(corner_radius, min(box_size.x, box_size.y)), 1.0);
    float depthPx = max(-d, 0.0);
    float edgeT = clamp(1.0 - depthPx / bevelPx, 0.0, 1.0);

    float lensShape = pow(edgeT, EDGE_LENS_FALLOFF);

    vec2 dispPx = disp * resolution * lensShape;
    float dispLenPx = length(dispPx);
    vec2 dispDirPx = dispPx / max(dispLenPx, 1.0e-4);
    // The one hard limit left. It exists because the blurred region is sized
    // from it (see _computeBlurRect), so sampling past it would just read the
    // clamped border of that region and streak.
    if (dispLenPx > EDGE_LENS_REACH) {
        dispLenPx = EDGE_LENS_REACH;
        dispPx = dispDirPx * EDGE_LENS_REACH;
    }

    // Inward, always. An outward bevel (the surroundings squeezed INTO the
    // rim) was built and evaluated on 2026-09-23 and rejected outright — it
    // is a different effect, not a stronger one. memo.md 追記28 keeps the
    // geometry and the measurements; the code does not keep the branch.
    disp = dispPx / max(resolution, vec2(1.0));

    // How far the sample point travels per screen pixel — the width of this
    // pixel's footprint in the source, and therefore how far the extra taps
    // have to spread to stop it aliasing. Two contributions, both analytic
    // (no dFdx/dFdy, which is not guaranteed on the GLES2 path Cogl can take):
    // the weight's own derivative, falloff*(edgeT^(falloff-1))/bevel, and the
    // raw field's, which spreads its change over roughly the bevel. The
    // factor of 2 is headroom for the raw term's steepness right at the rim.
    float shapeRate = EDGE_LENS_FALLOFF * pow(edgeT, EDGE_LENS_FALLOFF - 1.0) / bevelPx;
    float footprintPx = 2.0 * dispLenPx * (shapeRate + 1.0 / bevelPx);
    vec2 footprintExt = (footprintPx > 2.0 && edge_taps_enabled > 0.5)
        ? dispDirPx * (min(footprintPx, 64.0) * 0.5) / resolution
        : vec2(0.0);

    vec2 refractedUv = stabilizedUV(uv + disp, uv);

    vec2 chromaDir = length(disp) > 0.00001 ? normalize(disp) : vec2(0.0);

    // Calculate Chromatic Aberration vectors (separating RGB channels slightly).
    //
    // [FIX] chroma_strength is now in PIXELS. It used to be divided by
    // minRes (the shorter side of the FBO), which made the uniform mean "a
    // fraction of the screen" — so the 0.0-0.1 slider produced a channel
    // split of at most 0.18px on a 1920x1080 dock surface and 0.011px at the
    // default of 0.006. That is far below one texel of an already-blurred
    // source, which is why moving the slider had no visible effect anywhere
    // in its range.
    //
    // The giveaway was displacement_scale a few lines up: it carries the
    // same `/ minRes` normalization but ships with a default of 78.5 and a
    // 0-200 range, i.e. the two sliders were ~2000x apart in units for the
    // same maths. Dividing by `resolution` (the vec2, per axis) instead
    // makes the offset exactly chroma_strength pixels in every direction,
    // since chromaDir is a unit vector.
    //
    // The schema default and the prefs range are rescaled to match (1.5px
    // default, 0-5px range).
    vec2 chromaVec = chromaDir * (chroma_strength / resolution) * lensShape;
    vec2 uvG = refractedUv;

    // [PERF] Is the channel split large enough to change any sampled texel?
    // chromaVec is a UV offset, so multiplying by the resolution converts it
    // to pixels. Below a hundredth of a pixel the three channels provably
    // resolve to the same coordinates (see the single-fetch branch below),
    // and the 12-fetch path is pure waste. This is true across the whole
    // glass whenever chroma_strength is 0, and everywhere the refraction
    // itself vanishes (the flat interior: disp == 0 makes chromaDir == 0)
    // regardless of the setting.
    vec2 chromaPx = chromaVec * resolution;
    bool chromaActive = dot(chromaPx, chromaPx) > 1.0e-4;

    // Step 1: RGSS (Rotated Grid Super-Sampling) Pattern Implementation
    // Instead of sampling in a simple square, sampling in a slanted diamond pattern
    // provides significantly better anti-aliasing for both horizontal and vertical edges.
    float edgeProximity = 1.0 - smoothstep(0.0, edgeFeather * 4.0, -d);
    float aa_spread = mix(0.75, 2.5, edgeProximity);
    // The four rotated-grid offsets themselves live in sampleBackdrop(); this
    // is the scale they are applied at.
    vec2 texel = vec2(aa_spread) / resolution;

    // Hard limit sampling coordinates to 1.2px inside the texture bounds.
    // This prevents bilinear filtering from accidentally pulling in black/transparent
    // pixels from the void outside the texture space.
    // [PERF] SAFE() used to clamp against the capture's own edge; blurUV()
    // does the same job against the blurred sub-rect (see its definition).
    // [FIX] Both the clamping and the tap pattern now live in
    // sampleBackdrop(), which additionally spreads the taps across the
    // pixel's real source footprint wherever the refraction compresses the
    // background (footprintExt above). Outside that band footprintExt is
    // vec2(0) and this is the same four-tap RGSS average as before.

    // Step 2: Multi-tap Sampling (Averaging sub-pixels to smooth out the image)
    vec3 refractedRgb;
    if (chromaActive) {
        // Each channel walks its own refracted path.
        vec2 uvR = stabilizedUV(refractedUv + chromaVec, refractedUv);
        vec2 uvB = stabilizedUV(refractedUv - chromaVec, refractedUv);

        refractedRgb = vec3(
            sampleBackdrop(uvR, footprintExt, texel, resolution).r,
            sampleBackdrop(uvG, footprintExt, texel, resolution).g,
            sampleBackdrop(uvB, footprintExt, texel, resolution).b
        );
    } else {
        // [PERF] Same taps, all three channels taken from each — a third of
        // the fetches, and bit-for-bit the same result.
        //
        // Why the coordinates really are identical, not merely close: with
        // chromaVec == 0 the R/B coordinate is stabilizedUV(refractedUv,
        // refractedUv) = mix(refractedUv, clamp(refractedUv, .001, .999),
        // keep), which equals refractedUv (== uvG) for every refractedUv
        // already inside [.001, .999] — i.e. everywhere except within one
        // thousandth of the texture border. In that last sliver the two
        // differ by at most 0.001 in UV, and blurUV() then clamps both to the
        // same 1.2-texel margin inside the blurred rect. So the sampled
        // texels match on both sides of the branch.
        refractedRgb = sampleBackdrop(uvG, footprintExt, texel, resolution);
    }

    // Apply color saturation, contrast, brightness
    vec3 adjustedRefracted = applySCB(refractedRgb, brightness, contrast, saturation); 
    vec3 refracted = adjustedRefracted;

    // [FIX-8] Two independent, composable tint layers over the refracted
    // backdrop, applied back to front:
    //
    //   1. BASE  — the element's own color (multi-region/Toggles mode only;
    //              activeBaseStrength is 0 everywhere else), at
    //              region_base_strength. This is what makes a toggle that
    //              genuinely turns solid white when ON read as white.
    //   2. CUSTOM — the user's configured tint color, at tint_strength.
    //
    // Previously these were a single mix() against one pre-blended color, so
    // tint_strength scaled BOTH: a low custom tint strength also suppressed
    // the element's own color, and the only way to bring an element's own
    // color back was to raise the custom tint too. Layering them keeps each
    // slider doing exactly one thing, and the legacy path is unchanged
    // (activeBaseStrength == 0 collapses layer 1 to a no-op, leaving
    // mix(refracted, tint, tint_strength) exactly as before).
    vec3 insideBaseColor = mix(refracted, activeTint, activeBaseStrength);
    insideBaseColor = mix(insideBaseColor, vec3(tint_r, tint_g, tint_b), tint_strength);

    // [FIX] Do NOT multiply by insideMask here. insideMask is the same
    // value used as `alpha` below, and the final composite already
    // multiplies the fully-lit color by it exactly once
    // (finalRgb = litColor * alpha), matching Cogl/Clutter's
    // premultiplied-alpha compositing (out = src.rgb + dst.rgb*(1-src.a)).
    //
    // Baking insideMask into baseColor here AS WELL made rgb fall off as
    // insideMask^2 instead of insideMask^1 across the antialiased edge band
    // (the +-edge_smoothing px zone where insideMask is fractional, i.e.
    // exactly where the visible glass boundary sits). An under-premultiplied
    // color (rgb/alpha < true color) reads as a dark ring right at that
    // boundary once composited over the background — invisible at small
    // edge_smoothing (the transition band is only ~1-2px wide, too thin to
    // notice) but clearly visible once edge_smoothing is turned up, since
    // the band widens and the darkening becomes visible.
    //
    // This is independent of shadow_radius/shadow_intensity (radiusEnable
    // below already zeroes the drop shadow correctly at shadow_radius=0);
    // the ring persists even with the drop shadow fully disabled, which is
    // exactly the "Shadow Radius 0, Edge Smoothing >0" symptom reported.
    vec3 baseColor = insideBaseColor;

    // ------------------------------------------------------------------
    // Inner depth effects — make the glass look 3D on LIGHT backgrounds
    // where refraction and rim alone are not visible.
    //
    // A curved glass body has two visual cues that read as "3D" even
    // when the refracted background is invisible (e.g. on a white wall):
    //   (a) AMBIENT OCCLUSION near the inside edge — the glass body
    //       itself blocks light, so the inside edge is darker than
    //       the center. (This is the "shadow under the glass" the user
    //       asked about.)
    //   (b) A FOCAL HIGHLIGHT where light converges through the curved
    //       surface, biased slightly toward the light source.
    //
    // These are baked into the base color BEFORE the screen-blend
    // lighting pass, so they interact correctly with the rim / sheen
    // / specular that follow.
    // ------------------------------------------------------------------

    // (a) Inner shadow: dark band just inside the glass edge.
    //     aoMask = 1 at d=0 (right at the edge), fading to 0 at
    //     d = -ao_radius (ao_radius px inward from the edge).
    //     Strength is controlled independently by ao_intensity (0-1).
    //     [CHANGED] Previously this reused rim_width for its falloff
    //     distance and was multiplied by the drop shadow's radiusEnable
    //     (so it silently disappeared whenever shadow_radius was 0). Both
    //     couplings are removed here so the inner AO darkening has its own
    //     independent radius/intensity controls, matching the outer drop
    //     shadow's separate radius/intensity pair.
    float aoMask = 1.0 - smoothstep(0.0, max(ao_radius, 0.001), -d);
    baseColor *= (1.0 - aoMask * ao_intensity);

    // (b) Center focal highlight: bright spot offset slightly toward
    //     the light source, simulating where the curved glass focuses
    //     light. Uses lightDir2D (computed in the shadow block earlier
    //     in main()) so it tracks the user's light-angle setting.
    //     `-lightDir2D` because the focal point sits on the same side
    //     as the light, not the shadow side.
    /*
    vec2 focalOffset = -lightDir2D * box_size * 0.15;
    vec2 fromFocal  = (local_pos - focalOffset) / box_size;
    float radialDist = length(fromFocal);
    float focalHighlight = (1.0 - smoothstep(0.0, 0.85, radialDist)) * 0.20;
    baseColor += vec3(focalHighlight);
    */

    // lightAngleRad was declared earlier in main() (in the shadow block) and
    // is reused here for the 3D lighting direction.
    vec3 lightDir = normalize(vec3(cos(lightAngleRad), sin(lightAngleRad), 0.38));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 reflectDir = reflect(-lightDir, normal);
    float response = 1.0;

    // Create a sharp band for the rim lighting near the edges.
    // [FIX] Same undefined-behavior ordering issue as insideMask above
    // (edge0 = rim_width > edge1 = 0.0). Rewritten with increasing edges and
    // complemented, so it's well-defined on every driver instead of only
    // "happening to work" with the textbook smoothstep formula.
    // [FIX 2] The above rewrite still hit smoothstep(0.0, rim_width, ...)
    // with rim_width == 0.0, i.e. edge0 == edge1 — GLSL spec: "results are
    // undefined if edge0 >= edge1", which includes equality. In practice
    // this meant setting "Rim Width" to 0 in prefs did NOT reliably disable
    // the rim highlight (observed: driver-dependent, could keep rendering
    // a full-strength or garbage edgeBand instead of 0). Clamp the width
    // used inside smoothstep away from 0, and separately force-zero the
    // whole band with an explicit step() gate on the *unclamped* rim_width,
    // so "0 truly means off" regardless of what the clamped smoothstep does.
    float safeRimWidth = max(rim_width, 0.001);
    float edgeBand = (1.0 - smoothstep(0.0, safeRimWidth, abs(d))) * step(0.0005, rim_width);
    
    float rimDot = 1.0 - max(dot(normal, viewDir), 0.0);
    float rimFresnel = pow(max(rimDot, 0.0), max(rim_power, 0.001));
    float lightMask = pow(abs(dot(normal, lightDir)), max(rim_directional_power, 1.0));
    
    // Mix the fresnel effect with the edge mask to keep light strictly on the bevels.
    float rimShape = mix(pow(edgeBand, 0.85), rimFresnel, 0.55) * edgeBand;
    float finalRimLight = rimShape * lightMask * rim_intensity * rim_light_color_intensity;
    finalRimLight *= response;
    
    // [FIX] Previously also multiplied by insideMask here to "mask out
    // light bleeding past the actual geometry boundary" — but the final
    // composite (finalRgb = litColor * alpha, alpha = insideMask) already
    // does that exactly once for the whole litColor (baseColor + all added
    // light, combined via screen blend below). Multiplying by insideMask
    // here too caused the same insideMask^2 under-premultiplication as
    // baseColor above, deepening the dark ring in the antialiased edge band
    // whenever edge_smoothing is large. No bleeding actually occurs from
    // removing this: outside the shape insideMask (and therefore the final
    // alpha) is still 0, so the pixel is still fully transparent regardless
    // of finalRimLight's magnitude.

    float specularDot = max(dot(reflectDir, viewDir), 0.0);
    float specularLight = pow(specularDot, max(shininess, 1.0));
    specularLight *= specular_intensity * response;
    float specMask = mix(0.25, 1.0, insideMask) * clamp(edgeBand + insideMask * 0.65, 0.0, 1.0);
    specularLight *= specMask;

    float idleRim = edgeBand * 0.008;
    // [FIX] Same redundant-insideMask issue as finalRimLight above — removed.
    // The final `litColor * alpha` composite already applies insideMask once.

    // Background sheen uses 3D surface normal directly (no 2D radial fallback).
    float sheenFacing = max(dot(normal, lightDir), 0.0);
    float surfaceSheen = pow(sheenFacing, 1.65);
    // [FIX] Dropped the extra insideMask factor here too — same
    // double-premultiplication issue as baseColor/finalRimLight/idleRim
    // above; the final `litColor * alpha` composite already covers it.
    surfaceSheen *= mix(1.0, 0.55, edgeBand);
    vec3 sheenColor = vec3(1.0) * surfaceSheen * sheen_intensity;

    float alpha = insideMask;
    
    // --- Light Blending Strategy ---
    
    // 1. Group all additive lighting components together
    // Gated by surface_light_enabled: application windows turn this whole
    // group off (see LiquidEffect.setSurfaceLightEnabled) so only the
    // (already-independent) outer drop shadow and inner AO darkening in
    // baseColor remain — no rim/specular/sheen glint hugging the edge.
    vec3 addedLight = (vec3(specularLight + finalRimLight + idleRim) + sheenColor) * surface_light_enabled;

    // 2. Screen Blend Mode (A + B - A*B)
    // Instead of simply adding lights (which causes intense overexposure and blows out 
    // white backgrounds), this smoothly limits the maximum brightness to 1.0.
    vec3 litColor = baseColor + addedLight - (baseColor * addedLight);

    // [CHANGED] 3. Hue-preserving clamp (色相を維持する安全処理)
    // RGBのいずれかが1.0を超えた場合、白飛びによる色変（黄ばみ等）を防ぐため、
    // 最も強い色を基準にRGB全体の比率を保ったまま縮小する。
    float maxChannel = max(litColor.r, max(litColor.g, litColor.b));
    if (maxChannel > 1.0) {
        litColor /= maxChannel;
    }
    // マイナス値への侵入を防ぐ
    litColor = max(litColor, 0.0);

    // Composite the glass OVER the shadow, in PREMULTIPLIED-alpha space.
    //
    // Cogl/Clutter blends with `out = src.rgb + dst.rgb * (1 - src.a)`, which
    // adds src.rgb directly — independent of src.a. Therefore the emitted RGB
    // must already be multiplied by its coverage, otherwise any non-zero color
    // at zero coverage leaks as a constant tint across the whole actor.
    //
    // That leak is exactly what produced the dark rectangle behind the dock:
    // outside the shape `shadowColor` (a non-zero navy) was emitted even where
    // `shadowAlpha` had decayed to 0, painting the entire bgActor rectangle.
    //
    // Premultiplied "A over B":
    //   rgb = A.rgb*A.a + B.rgb*B.a*(1 - A.a)
    //   a   = A.a       + B.a*(1 - A.a)
    // with A = glass (litColor, alpha), B = shadow (shadowColor, shadowAlpha).
    // At zero total coverage this is exactly vec4(0) -> no rectangle.
    float shadowContribution = shadowAlpha * (1.0 - alpha);
    vec3 finalRgb   = litColor * alpha + shadowColor * shadowContribution;
    float finalAlpha = alpha + shadowContribution;

    // [FIX] Panel-background fallback fill — see the uniform declarations
    // above for why this exists (Toggles mode). Composited UNDERNEATH the
    // glass+shadow result using the same premultiplied "A over B" formula,
    // so it only shows through where the glass/shadow didn't already cover
    // the pixel (i.e. everywhere outside every toggle's glass region).
    // At panel_bg_a = 0 (the default for every other use of this shader)
    // panelContribution is always 0, making this an exact no-op.
    //
    // [FIX] Mask the fill to panel_rect_* (the panel's real widget bounds)
    // so it can never bleed into the SHADER_PADDING/CLIP_PADDING sampling
    // margin around it — see the uniform declarations above. Reuses the
    // same sdRoundRect() used for dock/regions and the shared corner_radius
    // uniform; this is an approximation of the panel's true corner radius
    // (rectangular corners would be visible only in the ~1-2px outside a
    // rounded corner, which is preferable to a few-hundred-px black box).
    // [PERF] Extracted to panelFallback() so the early-out paths below can
    // apply the exact same term without duplicating it. Identical maths.
    vec4 panelTerm = panelFallback(pixel_coord, finalAlpha);
    finalRgb += panelTerm.rgb;
    finalAlpha += panelTerm.a;

    // [NEW] See ditherLSB(). Scaled by the coverage because finalRgb is
    // premultiplied — dithering a transparent pixel's colour would break that
    // invariant and show up as a faint haze outside the glass.
    finalRgb = max(finalRgb + ditherLSB(pixel_coord) * finalAlpha, 0.0);

    // Output with premultiplied alpha format, required by Clutter/Cogl pipeline.
    cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;
}
