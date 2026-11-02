// Glass composite, used as a Cogl fragment snippet by rendering/pipelines.ts.
uniform sampler2D cogl_sampler0; // Layer 0: the sharp capture
uniform sampler2D cogl_sampler1; // Layer 1: the blurred capture

uniform float resolution_x;
uniform float resolution_y;
uniform float corner_radius;
uniform float max_z;
uniform float displacement_scale;
uniform float edge_smoothing;
uniform float profile_shape_n;
uniform float ior;
uniform float chroma_strength;
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
// A line of this colour and width (px) along the inside of the glass edge; a width of 0 draws none.
uniform float outline_width;
uniform float outline_r;
uniform float outline_g;
uniform float outline_b;
// On/off for the rim, specular and sheen. Application windows turn it off and
// keep only the drop shadow and the inner AO.
uniform float surface_light_enabled;
// 1 = the highlights keep the backdrop's hue instead of washing out to white.
uniform float highlight_backdrop_color;
// Continuous corners, 0 = circular arcs. The curve starts up to (1 + s) times
// the corner radius from the corner, like Figma's corner smoothing.
uniform float corner_smoothing;
// 0 forces circular arcs, for glass that has to match a window's own corners.
uniform float corner_smoothing_enabled;
// Inner edge darkening, independent of the rim and of the drop shadow.
uniform float ao_intensity; // 0 = none, 1 = fully black at the edge
uniform float ao_radius;    // px inward over which the band fades out
uniform float light_angle_deg;
uniform float shadow_radius;
uniform float shadow_intensity;
// Room (px) the drop shadow has outside the glass before the actor clips it.
// `padding` is only the refraction and blur headroom.
uniform float shadow_max_radius;
uniform float padding;
uniform float isDock;

// The sub-rect of the actor that layer 1 holds, blurred, in actor-local px.
// Everything the shader draws lies inside it. w/h < 1 means the whole actor,
// which is also what an unset uniform reads as.
uniform float blur_rect_x;
uniform float blur_rect_y;
uniform float blur_rect_w;
uniform float blur_rect_h;
// Layer 1's real size in texels. The blur runs at half or quarter
// resolution, so blurUV() uses this to magnify it smoothly; 0 disables that.
uniform float blur_tex_w;
uniform float blur_tex_h;

// The bevel's lens. These are constants on purpose; the preferences shape the
// lens through three sliders that each do one job:
//   displacement_scale - magnitude of the whole displacement field
//   max_z              - dome height, i.e. how steep the normals get
//   profile_shape_n    - shape only (how square the dome is)
// EDGE_LENS_FALLOFF weights the displacement by (1 - depth/bevel)^falloff so
// it builds towards the rim. A slider for it would fight profile_shape_n.
#define EDGE_LENS_FALLOFF 2.4

// Hard limit (px) on how far the rim may sample. GlassGeometry.EDGE_LENS_REACH
// sizes the blurred region from the same figure; change both together.
#define EDGE_LENS_REACH 96.0

// Width (px) of the band along the edge where the dome rises and the lens
// acts. Fixed rather than tied to corner_radius, so every surface gets the
// same lens from the same settings, as on macOS. A glass too small to hold
// it gets the whole lens scaled down (lensScaleFor()).
#define EDGE_LENS_BAND 22.0

// Diagnostic switches, set through global._lgGlass. MaterialSettings seeds
// them because an unset uniform reads 0.0.
//   edge_taps_enabled  1 = footprint taps in sampleBackdrop(), 0 = plain RGSS
//   early_exit_enabled 1 = the two early exits in main(), 0 = full path
//   debug_view         0 = normal, 1 = shadow (red) and shape (green) masks
//                      gamma boosted, 2 = the same masks raw
uniform float edge_taps_enabled;
uniform float early_exit_enabled;
uniform float debug_view;

uniform float brightness;
uniform float contrast;
uniform float saturation;

// The glass rect in the actor's pixel space, which for the monitor-sized
// surfaces is monitor-local. Includes the padding on every side.
uniform float dock_x;
uniform float dock_y;
uniform float dock_w;
uniform float dock_h;

// Glass that grows out of a screen edge: 0 = floating, 1 = top, 2 = bottom,
// 3 = left, 4 = right. The side on that edge has no corners and widens into
// the edge through concave fillets of attach_radius px, so the glass reads as
// part of the screen's border rather than an object over it.
uniform float attach_edge;
uniform float attach_radius;

// Menus grown out of the glass (a top bar's): up to MAX_GLASS_GROWTHS boxes in
// actor px, each with its corners' radii (top left, top right, bottom right,
// bottom left), joined to the glass through concave fillets of grow_fillet px.
#define MAX_GLASS_GROWTHS 2
uniform float grow_count;
uniform float grow_fillet;
uniform float grow_x[MAX_GLASS_GROWTHS];
uniform float grow_y[MAX_GLASS_GROWTHS];
uniform float grow_w[MAX_GLASS_GROWTHS];
uniform float grow_h[MAX_GLASS_GROWTHS];
uniform float grow_r[MAX_GLASS_GROWTHS * 4];

// Multi-region mode, for Quick Settings' toggle-button glass: up to
// MAX_GLASS_REGIONS separate rounded rects drawn from the same blurred
// texture. The regions must not overlap, and they get no drop shadow.
#define MAX_GLASS_REGIONS 16
uniform float multi_region_mode; // 0 = the single dock_* rect, 1 = regions
uniform float region_count;
uniform float region_x[MAX_GLASS_REGIONS]; // includes the padding
uniform float region_y[MAX_GLASS_REGIONS];
uniform float region_w[MAX_GLASS_REGIONS];
uniform float region_h[MAX_GLASS_REGIONS];
uniform float region_tint_r[MAX_GLASS_REGIONS]; // the element's own colour
uniform float region_tint_g[MAX_GLASS_REGIONS];
uniform float region_tint_b[MAX_GLASS_REGIONS];
// Strength of each region's own colour, separate from tint_strength so the
// two tints stay independent. 0 when the colour could not be resolved.
uniform float region_base_strength[MAX_GLASS_REGIONS];

#ifdef LG_SHAPE_TEXTURE
// The outline as distance fields over the dock_* rect, for glass text: the
// outline itself in the texture's top half, and a softened copy the lens is
// shaped from in its bottom half. The distance is stored in 16 bits, high
// byte in red and low byte in green: the encoding is linear, so filtering
// interpolates the distance itself.
uniform float shape_range; // px of distance each way the fields hold
uniform float shape_band;  // the lens band, px
#endif

// Signed distance to a circular-cornered rounded rectangle.
float sdCircleRoundRect(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + vec2(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}

// The corner of a box with half-extents b and corner radius r, as
// (radius, exponent) of a superellipse. Above 2 the corner meets the sides
// with zero curvature, so the rim and the refraction do not crease there.
// The radius grows with the exponent so the corner's midpoint stays where the
// circular one's is. A corner that has no room to grow, such as a pill's end,
// gets a smaller exponent, down to a plain circle. A radius past the shorter
// half-extent would pinch the ends to a point, so it stops there.
vec2 cornerShape(vec2 b, float r) {
    r = min(r, min(b.x, b.y));
    float s = clamp(corner_smoothing, 0.0, 1.0) * corner_smoothing_enabled;
    float k = min(1.0 + s, max(min(b.x, b.y) / max(r, 1.0e-3), 1.0));
    // From the midpoint condition sqrt(2) * k * (1 - 2^(-1/n)) = sqrt(2) - 1.
    float n = -1.0 / log2(1.0 - 0.29289322 / k);
    return vec2(r * k, n);
}

// Superellipse norm (|x|^n + |y|^n)^(1/n) of q >= 0, scaled to stay in range.
float superLength(vec2 q, float n) {
    float m = max(q.x, q.y);
    if (m <= 0.0)
        return 0.0;
    vec2 u = q / m;
    return m * pow(pow(u.x, n) + pow(u.y, n), 1.0 / n);
}

// Signed distance to a rounded rectangle whose corners are superellipses
// (corner = cornerShape()): negative inside, 0 on the edge. The superellipse
// norm is not a distance, so it is divided by its gradient's length, which
// keeps the rim, the bevel and the antialiasing the same width all round.
// The division fades in from the corner's centre, where the gradient is
// undefined, so the field stays continuous inside.
float sdRoundRect(vec2 p, vec2 b, vec2 corner) {
    float r = corner.x;
    float n = corner.y;
    vec2 d = abs(p) - b + vec2(r);
    vec2 q = max(d, 0.0);
    float len = superLength(q, n);
    if (len <= 0.0)
        return max(d.x, d.y) - r;
    vec2 g = pow(q / len, vec2(n - 1.0));
    float gradLen = mix(1.0, length(g), clamp(len / max(r, 1.0e-3), 0.0, 1.0));
    return (len - r) / max(gradLen, 0.5);
}

// How far (px) the screen beyond an attached edge is taken to extend. Only
// has to reach past the actor; the rest is never drawn.
#define ATTACH_WALL_DEPTH 2048.0

// Into a frame where the attached edge lies towards -y, and back out of it.
vec2 toEdgeFrame(vec2 p) {
    if (attach_edge < 1.5)
        return p;
    if (attach_edge < 2.5)
        return vec2(p.x, -p.y);
    if (attach_edge < 3.5)
        return p.yx;
    return vec2(p.y, -p.x);
}

vec2 fromEdgeFrame(vec2 v) {
    if (attach_edge < 1.5)
        return v;
    if (attach_edge < 2.5)
        return vec2(v.x, -v.y);
    if (attach_edge < 3.5)
        return v.yx;
    return vec2(-v.y, v.x);
}

vec2 edgeFrameBox(vec2 b) {
    return attach_edge > 2.5 ? b.yx : b;
}

// The two pieces an attached glass is made of, in the edge frame: its box run
// out behind the edge by the corner radius r and the fillet, so the box's
// corners there are hidden, and the screen past the edge, only as wide as the
// box and its fillets. Each as the point and half-extents of a box.
void edgeParts(vec2 p, vec2 b, float r, out vec2 bodyP, out vec2 bodyB, out vec2 wallP, out vec2 wallB) {
    vec2 q = toEdgeFrame(p);
    vec2 bb = edgeFrameBox(b);
    float f = max(attach_radius, 0.0);
    float run = r + f;
    bodyP = q + vec2(0.0, run * 0.5);
    bodyB = vec2(bb.x, bb.y + run * 0.5);
    wallP = q + vec2(0.0, bb.y + ATTACH_WALL_DEPTH);
    wallB = vec2(bb.x + f, ATTACH_WALL_DEPTH);
}

// The rounded union of the body and the wall. For two perpendicular sides it
// is the exact distance to a circular fillet of radius attach_radius, so the
// rim, the bevel and the shadow follow the flare like any other edge.
float roundUnion(float a, float b, float f) {
    if (f < 0.5)
        return min(a, b);
    vec2 u = max(vec2(f - a, f - b), 0.0);
    return max(f, min(a, b)) - length(u);
}

float edgeUnion(float body, float wall) {
    return roundUnion(body, wall, max(attach_radius, 0.0));
}

// Signed distance to the glass: its rounded box, or that box grown out of the
// attached edge.
float sdGlassShape(vec2 p, vec2 b, vec2 corner) {
    if (attach_edge < 0.5)
        return sdRoundRect(p, b, corner);
    vec2 bodyP, bodyB, wallP, wallB;
    edgeParts(p, b, corner.x, bodyP, bodyB, wallP, wallB);
    return edgeUnion(sdRoundRect(bodyP, bodyB, corner), sdCircleRoundRect(wallP, wallB, 0.0));
}

// Where main() put the frame sdGlass() is called in: actor px = p + frame_origin.
vec2 frame_origin;

// Signed distance to a box with half-extents b and its own circular radius
// at each corner (top left, top right, bottom right, bottom left; y down).
float sdCornerBox(vec2 p, vec2 b, vec4 r) {
    float rr = p.x > 0.0 ? (p.y > 0.0 ? r.z : r.y) : (p.y > 0.0 ? r.w : r.x);
    rr = clamp(rr, 0.0, min(b.x, b.y));
    vec2 q = abs(p) - b + vec2(rr);
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rr;
}

// sdGlassShape() with the menus grown out of it.
float sdGlass(vec2 p, vec2 b, vec2 corner) {
    float d = sdGlassShape(p, b, corner);
    int count = int(min(grow_count, float(MAX_GLASS_GROWTHS)));
    vec2 q = p + frame_origin;
    for (int i = 0; i < MAX_GLASS_GROWTHS; i++) {
        if (i >= count) break;
        vec2 extent = vec2(grow_w[i], grow_h[i]) * 0.5;
        vec2 c = vec2(grow_x[i], grow_y[i]) + extent;
        vec4 r = vec4(grow_r[i * 4], grow_r[i * 4 + 1], grow_r[i * 4 + 2], grow_r[i * 4 + 3]);
        d = roundUnion(d, sdCornerBox(q - c, extent, r), max(grow_fillet, 0.0));
    }
    return d;
}

// The circular-cornered sdGlass(), cheap enough to pick a region with.
float sdGlassPick(vec2 p, vec2 b, float r) {
    if (attach_edge < 0.5)
        return sdCircleRoundRect(p, b, r);
    r = min(r, min(b.x, b.y));
    vec2 bodyP, bodyB, wallP, wallB;
    edgeParts(p, b, r, bodyP, bodyB, wallP, wallB);
    return edgeUnion(sdCircleRoundRect(bodyP, bodyB, r), sdCircleRoundRect(wallP, wallB, 0.0));
}

// The region this pixel is most inside of, with its local frame and colours.
// Far outside every region the local position stays large, which main()
// already treats as transparent.
void findActiveRegion(vec2 pixel_coord, float pad, out vec2 outLocalPos, out vec2 outBoxSize, out vec3 outTint, out float outBaseStrength) {
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

        // Picking the region needs no continuous corners; main() measures the
        // chosen one with them.
        float d = sdGlassPick(rLocal, rBox, corner_radius);
        if (d < bestD) {
            bestD = d;
            outLocalPos = rLocal;
            outBoxSize = rBox;
            outTint = vec3(region_tint_r[i], region_tint_g[i], region_tint_b[i]);
            outBaseStrength = region_base_strength[i];
        }
    }
}

// Depth into the bevel, 0 at the edge to 1 at its inner end. `r` is the band
// from lensBandFor(), so the dome stops rising past it.
float normalizedDepth(float d, vec2 b, float r) {
    float maxDepth = max(r, 1.0);

    float interiorDepth = max(-d, 0.0);
    return clamp(interiorDepth / maxDepth, 0.0, 1.0);
}

// Superellipse profile: h = H * (1 - (1 - t)^n)^(1/n), t: edge=0 -> center=1.
float profileHeight(float t, float zScale) {
    float n = max(profile_shape_n, 1.01);
    float invT = clamp(1.0 - t, 0.0, 1.0);
    float inner = max(1.0 - pow(invT, n), 0.0);
    float h = pow(inner, 1.0 / n);
    return h * zScale;
}

// Surface height at p. `corner` is the outline's corner (cornerShape()) and
// `band` the width the height builds up over (see lensBandFor()).
float getHeight(vec2 p, vec2 b, vec2 corner, float band, float zScale) {
    float d = sdGlass(p, b, corner);

    // Fades out over +-edge_smoothing px instead of stepping to 0 at the edge.
    // A step makes heightGradient()'s finite difference spike across it, which
    // shows as jagged refraction over busy backgrounds.
    float smoothZone = max(edge_smoothing, 1.0);
    if (d > smoothZone)
        return 0.0;

    float t = normalizedDepth(d, b, band);
    float h = profileHeight(t, zScale);

    float fade = 1.0 - smoothstep(-smoothZone, smoothZone, d);
    return h * fade;
}

// The bevel's width for a glass whose smaller half-extent is halfMin, px:
// EDGE_LENS_BAND, or halfMin when the glass is too small to hold it.
float lensBandFor(float halfMin) {
    return max(min(EDGE_LENS_BAND, halfMin), 1.0);
}

// How much the lens is scaled down to fit that band (1 = full size). The
// dome height and the displacement are scaled by the same factor as the
// band, so the surface keeps its slopes and the lens its shape.
float lensScaleFor(float band) {
    return band / max(EDGE_LENS_BAND, 1.0);
}

// Finite-difference step for the normal, scaled with the resolution.
float gradientStep(vec2 resolution) {
    float minRes = max(min(resolution.x, resolution.y), 1.0);
    return clamp(minRes / 560.0, 0.45, 1.20);
}

// Unit gradient of sdRoundRect() at p, i.e. straight out of the shape, in
// closed form. Along a straight side it is that side's axis; in a corner it
// is the superellipse's normal, which for a circle points away from its centre.
vec2 sdRoundRectDir(vec2 p, vec2 b, vec2 corner) {
    vec2 q = abs(p) - b + vec2(corner.x);
    if (max(q.x, q.y) < 0.0) {
        return (q.x > q.y) ? vec2(sign(p.x), 0.0) : vec2(0.0, sign(p.y));
    }
    vec2 u = max(q, 0.0) / max(max(q.x, q.y), 1.0e-6);
    return sign(p) * normalize(pow(u, vec2(corner.y - 1.0)) + vec2(1e-6));
}

// Unit gradient of sdGlass(). On the fillet it blends the two pieces'
// gradients as the rounded union does, which turns it along the arc.
vec2 sdGlassDir(vec2 p, vec2 b, vec2 corner) {
    // The menus' fillets have no closed form worth keeping; a central
    // difference of the whole field turns smoothly through them.
    if (grow_count > 0.5) {
        const float h = 0.5;
        vec2 g = vec2(sdGlass(p + vec2(h, 0.0), b, corner) - sdGlass(p - vec2(h, 0.0), b, corner),
                      sdGlass(p + vec2(0.0, h), b, corner) - sdGlass(p - vec2(0.0, h), b, corner));
        return normalize(g + vec2(1e-6));
    }
    if (attach_edge < 0.5)
        return sdRoundRectDir(p, b, corner);
    vec2 bodyP, bodyB, wallP, wallB;
    edgeParts(p, b, corner.x, bodyP, bodyB, wallP, wallB);
    float body = sdRoundRect(bodyP, bodyB, corner);
    float wall = sdCircleRoundRect(wallP, wallB, 0.0);
    vec2 gBody = sdRoundRectDir(bodyP, bodyB, corner);
    // A corner of exponent 2 and radius 0 is a sharp box's corner.
    vec2 gWall = sdRoundRectDir(wallP, wallB, vec2(0.0, 2.0));
    float f = max(attach_radius, 0.0);
    vec2 g = body < wall ? gBody : gWall;
    if (f >= 0.5 && min(body, wall) < f) {
        vec2 u = max(vec2(f - body, f - wall), 0.0);
        g = u.x * gBody + u.y * gWall;
    }
    return fromEdgeFrame(normalize(g + vec2(1e-6)));
}

// Height gradient of the glass surface at p. The height depends on the signed
// distance alone, so grad(H) = H'(d) * grad(d): grad(d) is closed-form, and H'(d)
// takes one central difference along it. Differencing along x and y instead
// tilts the normal on rounded corners.
//
// H'(d) is not taken in closed form: the superellipse is vertical at the
// edge, and the finite difference keeps that slope bounded.
vec2 heightGradient(vec2 p, vec2 b, vec2 corner, float band, float zScale, vec2 resolution) {
    vec2 dir = sdGlassDir(p, b, corner);
    float e = gradientStep(resolution);

    float hOut = getHeight(p + dir * e, b, corner, band, zScale);
    float hIn  = getHeight(p - dir * e, b, corner, band, zScale);

    return dir * ((hOut - hIn) / (2.0 * e));
}

vec3 getNormal(vec2 gradH) {
    return normalize(vec3(-gradH.x, -gradH.y, 1.0));
}

#ifdef LG_SHAPE_TEXTURE
float shapeDistanceAt(vec2 texel, vec2 texSize) {
    vec2 c = texture2D(cogl_sampler2, texel / texSize).rg;
    return mix(-shape_range, shape_range, (c.r * 65280.0 + c.g * 255.0) / 65535.0);
}

// The outline's distance at p, bilinear.
float shapeTextureSD(vec2 p) {
    vec2 size = max(vec2(dock_w, dock_h), vec2(1.0));
    vec2 st = p / size + 0.5;
    // Past the field's rect the distance keeps growing.
    vec2 beyond = max(abs(st - 0.5) - 0.5, 0.0) * size;
    vec2 texel = clamp(st * size, vec2(0.5), size - 0.5);
    return shapeDistanceAt(texel, size * vec2(1.0, 2.0)) + length(beyond);
}

// The softened distance at p, as a cubic B-spline of the texels from four
// bilinear taps: its slope is continuous, where a bilinear one steps at every
// texel and the lens would show the texels as facets.
float shapeLensSD(vec2 p) {
    vec2 size = max(vec2(dock_w, dock_h), vec2(1.0));
    vec2 st = p / size + 0.5;
    vec2 beyond = max(abs(st - 0.5) - 0.5, 0.0) * size;
    vec2 t = clamp(st, vec2(0.0), vec2(1.0)) * size - 0.5;
    vec2 i = floor(t);
    vec2 f = t - i;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1;
    vec2 g1 = w2 + w3;
    // Texel centres of the taps, kept inside the bottom half.
    vec2 lo = vec2(0.5, size.y + 0.5);
    vec2 hi = vec2(size.x - 0.5, size.y * 2.0 - 0.5);
    vec2 h0 = clamp(i - 0.5 + w1 / g0 + vec2(0.0, size.y), lo, hi);
    vec2 h1 = clamp(i + 1.5 + w3 / g1 + vec2(0.0, size.y), lo, hi);
    vec2 texSize = size * vec2(1.0, 2.0);
    float d = g0.y * (g0.x * shapeDistanceAt(h0, texSize) + g1.x * shapeDistanceAt(vec2(h1.x, h0.y), texSize)) +
              g1.y * (g0.x * shapeDistanceAt(vec2(h0.x, h1.y), texSize) + g1.x * shapeDistanceAt(h1, texSize));
    return d + length(beyond);
}
#endif

#ifdef LG_SHAPE_TEXTURE
// Unit gradient of the softened field, which turns smoothly where the
// outline's distance folds.
vec2 shapeDir(vec2 p) {
    const float e = 0.5;
    vec2 g = vec2(shapeLensSD(p + vec2(e, 0.0)) - shapeLensSD(p - vec2(e, 0.0)),
                  shapeLensSD(p + vec2(0.0, e)) - shapeLensSD(p - vec2(0.0, e)));
    float len = length(g);
    return len > 1.0e-5 ? g / len : vec2(1.0, 0.0);
}

// Surface height at signed distance d from the outline, for a lens `band`.
float heightAtDistance(float d, vec2 b, float band, float zScale) {
    float smoothZone = max(edge_smoothing, 1.0);
    if (d > smoothZone)
        return 0.0;
    float t = normalizedDepth(d, b, band);
    float h = profileHeight(t, zScale * lensScaleFor(band));
    float fade = 1.0 - smoothstep(-smoothZone, smoothZone, d);
    return h * fade;
}

// The height follows the outline itself, so the glass reaches right into its
// corners; only the slope's direction comes from the softened field. That
// field's gradient also shortens to nothing along a stroke's middle, so the
// slope does not flip there either.
vec2 shapeHeightGradient(vec2 p, vec2 b, float zScale, vec2 resolution) {
    float e = gradientStep(resolution);
    const float g = 0.5;
    vec2 grad = vec2(shapeLensSD(p + vec2(g, 0.0)) - shapeLensSD(p - vec2(g, 0.0)),
                     shapeLensSD(p + vec2(0.0, g)) - shapeLensSD(p - vec2(0.0, g))) / (2.0 * g);
    float d = shapeTextureSD(p);
    float band = max(shape_band, 1.0);
    float slope = (heightAtDistance(d + e, b, band, zScale) - heightAtDistance(d - e, b, band, zScale)) / (2.0 * e);
    return grad * slope;
}
#endif

// UV displacement from refraction through the surface.
vec2 getDisplacement(float d, vec3 normal, vec2 resolution) {
    if (d > 0.0)
        return vec2(0.0);

    // Looking straight into the screen, from air (1.0) into glass (ior).
    vec3 viewDir = vec3(0.0, 0.0, -1.0);
    float eta = 1.0 / max(ior, 1.001);
    vec3 refractedRay = refract(viewDir, normal, eta);

    // Total internal reflection.
    if (length(refractedRay) < 0.0001)
        return vec2(0.0);

    float minRes = max(min(resolution.x, resolution.y), 1.0);

    // Keeps near-grazing rays from stretching without bound.
    float safe_z = max(-refractedRay.z, 0.15);

    // displacement_scale is in pixels on both axes, so every surface shape
    // refracts the same. _computeBlurRect() sizes its margins from it.
    vec2 displacement = (refractedRay.xy / safe_z) *
                        (displacement_scale / max(resolution, vec2(1.0)));

    float max_disp_px = 0.30 * minRes;
    vec2 dispPx = displacement * resolution;
    float dispLenPx = length(dispPx);
    if (dispLenPx > max_disp_px) {
        displacement *= max_disp_px / dispLenPx;
    }

    return displacement;
}

// Pulls UVs near the texture edge back inside, so bilinear filtering never
// reads the black outside it.
vec2 stabilizedUV(vec2 candidate, vec2 fallback) {
    vec2 clamped = clamp(candidate, vec2(0.001), vec2(0.999));
    float edgeDist = min(min(candidate.x, candidate.y), min(1.0 - candidate.x, 1.0 - candidate.y));
    float keep = smoothstep(-0.04, 0.03, edgeDist);
    return mix(fallback, clamped, keep);
}

// Maps a full-actor UV into the blurred sub-rect's UV, clamped 1.2 texels
// inside it.
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

    // Smooth bilinear magnification: warping the coordinate inside its texel
    // with a smoothstep makes the reconstruction's slope continuous, which
    // removes the staircase plain bilinear leaves on diagonal edges. Skipped
    // at 1:1, where it would only move samples off their texel centres.
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

// Averages the blurred backdrop over the part of the source this pixel covers.
// Near the edge the refraction compresses tens of source pixels into a few
// screen pixels, and point sampling that aliases. `ext` is half that footprint
// as a UV vector along the compression; vec2(0) keeps the plain four RGSS taps.
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

    // Six more taps along the footprint, still on the rotated grid. The uneven
    // spacing weights the centre a little so the refraction does not smear.
    sum +=
        texture2D(cogl_sampler1, blurUV(uvc + ext * 0.90 + o1, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + ext * 0.55 + o2, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc + ext * 0.22 + o3, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc - ext * 0.22 + o4, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc - ext * 0.55 + o1, resolution)).rgb +
        texture2D(cogl_sampler1, blurUV(uvc - ext * 0.90 + o2, resolution)).rgb;

    return sum * 0.1;
}

// +-0.5/255 of noise before the 8-bit output. The blurred backdrop is a very
// shallow gradient that would otherwise band.
float ditherLSB(vec2 p) {
    return (fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
}

// erfc(x) for x >= 0 (Abramowitz and Stegun 7.1.27, error below 5e-4).
float erfcPositive(float x) {
    float p = 1.0 + x * (0.278393 + x * (0.230389 + x * (0.000972 + x * 0.078108)));
    float p2 = p * p;
    return 1.0 / (p2 * p2);
}

// How much more saturated than the backdrop a highlight is drawn.
#define HIGHLIGHT_CHROMA_GAIN 1.25

// sRGB-encoded colour to Oklab. A 2.2 gamma stands in for the sRGB curve,
// which is close enough for tinting a highlight.
vec3 toOklab(vec3 c) {
    vec3 lin = pow(max(c, 0.0), vec3(2.2));
    vec3 lms = vec3(
        dot(lin, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
        dot(lin, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
        dot(lin, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
    lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
    return vec3(
        dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
        dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
        dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}

// Oklab to linear RGB, unclamped.
vec3 oklabToLinear(vec3 lab) {
    vec3 lms = vec3(
        dot(lab, vec3(1.0, 0.3963377774, 0.2158037573)),
        dot(lab, vec3(1.0, -0.1055613458, -0.0638541728)),
        dot(lab, vec3(1.0, -0.0894841775, -1.2914855480)));
    lms = lms * lms * lms;
    return vec3(
        dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
        dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
        dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}

// How far from `from` a step of `delta` can go, as a fraction of it, before
// leaving [0, 1].
float gamutRoom(float from, float delta) {
    if (delta > 1.0e-6)
        return (1.0 - from) / delta;
    if (delta < -1.0e-6)
        return -from / delta;
    return 1.0;
}

// `lit` (base screen-blended with `light` of white) with the backdrop's hue
// put back. Blending with white washes a highlight out to grey; real glass
// lights up in the colour of what is behind it. The lightness stays as it
// was, so only the colour changes. The hue fades in over the first quarter
// of the light, so unlit glass keeps its colour.
//
// A bright saturated colour is often out of gamut. Scaling it back down would
// dim the highlight, so the colour is pulled towards the plain one instead,
// along a line of nearly constant luminance.
vec3 backdropHighlight(vec3 base, vec3 lit, float light) {
    vec3 litLab = toOklab(lit);
    vec2 baseChroma = toOklab(base).yz * HIGHLIGHT_CHROMA_GAIN;
    litLab.yz = mix(litLab.yz, baseChroma, clamp(light * 4.0, 0.0, 1.0));

    vec3 from = pow(max(lit, 0.0), vec3(2.2));
    vec3 delta = oklabToLinear(litLab) - from;
    float t = min(min(gamutRoom(from.r, delta.r), gamutRoom(from.g, delta.g)),
                  min(gamutRoom(from.b, delta.b), 1.0));
    return pow(clamp(from + delta * max(t, 0.0), 0.0, 1.0), vec3(1.0 / 2.2));
}

// Brightness, contrast around mid grey, and saturation with Rec. 601 luma.
vec3 applySCB(vec3 color, float b, float c, float s) {
    color *= b;

    color = mix(vec3(0.5), color, c);

    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, s);

    return max(color, 0.0);
}

void main() {
    vec2 resolution = vec2(resolution_x, resolution_y);
    vec2 uv = cogl_tex_coord_in[0].st;

    vec2 pixel_coord = uv * resolution;

    // Width of the antialiased edge.
    float edgeFeather = max(edge_smoothing, 0.75);

    vec2 local_pos;
    vec2 box_size;
    vec3 activeTint;
    // The element's own colour strength; 0 outside multi-region mode.
    float activeBaseStrength = 0.0;

    if (multi_region_mode > 0.5) {
        findActiveRegion(pixel_coord, padding, local_pos, box_size, activeTint, activeBaseStrength);
    } else {
        // The actor can be much larger than the glass (a monitor-sized
        // capture), so the shape comes from dock_*, not from the resolution.
        vec2 dock_center = vec2(dock_x + dock_w * 0.5, dock_y + dock_h * 0.5);
        local_pos = pixel_coord - dock_center;

        if (isDock > 0.5) {
            // The dock also keeps the feathered edge inside its background.
            vec2 actual_size = vec2(dock_w, dock_h) - vec2(padding * 2.0) - vec2(edgeFeather * 2.0);
            box_size = max(actual_size * 0.5, vec2(1.0));
        } else {
            vec2 actual_size = vec2(dock_w, dock_h) - vec2(padding * 2.0);
            box_size = max(actual_size * 0.5, vec2(1.0));
        }

        activeTint = vec3(tint_r, tint_g, tint_b);
    }

    vec2 corner = cornerShape(box_size, corner_radius);
    frame_origin = pixel_coord - local_pos;
    float d = sdGlass(local_pos, box_size, corner);

    // An attached glass has no far side across its thickness, so the whole of
    // it can hold the lens.
    vec2 lensBox = edgeFrameBox(box_size);
    float lensBand = lensBandFor(attach_edge < 0.5 ? min(lensBox.x, lensBox.y) : min(lensBox.x, lensBox.y * 2.0));

#ifdef LG_SHAPE_TEXTURE
    d = shapeTextureSD(local_pos);
    lensBand = max(shape_band, 1.0);
#endif
    float lensScale = lensScaleFor(lensBand);

    // Inside = 1, outside = 0. smoothstep() is undefined for edge0 >= edge1 and
    // some drivers get the reversed form wrong, so the edges stay increasing.
    float outsideTransition = smoothstep(-edgeFeather, edgeFeather, d);
    float insideMask = 1.0 - outsideTransition;
    float outsideMask = outsideTransition;

    // Two early exits for the regions where everything below collapses to a
    // constant. Together they cover most of every surface.

    // Beyond the shadow's reach nothing is drawn. Multi-region mode has no
    // shadow, so there it starts right at the edge.
    float shadowReach = (multi_region_mode > 0.5) ? 0.0 : max(shadow_max_radius, 5.0);
    if (early_exit_enabled > 0.5 && debug_view < 0.5 && d >= max(shadowReach, edgeFeather)) {
        cogl_color_out = vec4(0.0);
        return;
    }

    // Deep inside, the dome is flat: no displacement, and with a flat normal
    // the rim, the AO band and the shadow all vanish. What is left is the
    // backdrop plus a constant specular and sheen. The threshold clears all of
    // those terms and the gradient's sampling neighbourhood.
    float smoothZoneEarly = max(edge_smoothing, 1.0);
    float interiorThreshold = max(
        max(lensBand + gradientStep(resolution) + smoothZoneEarly,
            edgeFeather * 4.0),
        max(max(ao_radius, rim_width), outline_width + 1.0));
    if (early_exit_enabled > 0.5 && debug_view < 0.5 && -d >= interiorThreshold) {
        vec2 uvFlat = stabilizedUV(uv, uv);

        // The same RGSS taps and spread as the full path away from the edge.
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

        // Specular and sheen at N = (0, 0, 1): both reduce to the light's z,
        // and specMask to 0.65.
        vec3 lightDirFlat = normalize(vec3(cos(radians(light_angle_deg)),
                                           sin(radians(light_angle_deg)), 0.38));
        float facing = max(lightDirFlat.z, 0.0);
        float specFlat = pow(facing, max(shininess, 1.0)) * specular_intensity * 0.65;
        float sheenFlat = pow(facing, 1.65) * sheen_intensity;
        float lightFlat = (specFlat + sheenFlat) * surface_light_enabled;

        vec3 litFlat = flatRgb + lightFlat - (flatRgb * lightFlat);
        float maxChannelFlat = max(litFlat.r, max(litFlat.g, litFlat.b));
        if (maxChannelFlat > 1.0) {
            litFlat /= maxChannelFlat;
        }
        litFlat = max(litFlat, 0.0);
        if (highlight_backdrop_color > 0.5 && lightFlat > 0.0)
            litFlat = backdropHighlight(flatRgb, litFlat, lightFlat);

        litFlat = max(litFlat + ditherLSB(pixel_coord), 0.0);

        cogl_color_out = vec4(litFlat, 1.0) * cogl_color_in;
        return;
    }

    // Drop shadow: dark at the edge and fading smoothly outwards, slightly
    // longer away from the light, and a cool tint instead of pure black.

    // Screen-space direction the shadow falls in (y points down).
    float lightAngleRad = radians(light_angle_deg);
    vec2 lightDir2D = vec2(cos(lightAngleRad), -sin(lightAngleRad));
    vec2 shadowDir   = -lightDir2D;

    // 0 on the lit side, 1 opposite the light. The epsilon avoids NaN at the
    // centre.
#ifdef LG_SHAPE_TEXTURE
    vec2 outwardDir = shapeDir(local_pos);
#else
    vec2 outwardDir = normalize(local_pos + vec2(1e-4));
#endif
    float lightAlignment = max(dot(outwardDir, shadowDir), 0.0);

    // 85% on the lit side to 100% on the far side; gentle, since a bottom dock
    // has no room below it anyway.
    float dirRadius    = 0.85 + lightAlignment * 0.15;
    float dirIntensity = 0.85 + lightAlignment * 0.15;

    // Capped to the room the actor has, so the fade is never cut off.
    float maxRadius = max(shadow_max_radius, 5.0);
    float effectiveRadius    = min(shadow_radius * dirRadius, maxRadius);

    // A radius of 0 turns the shadow off; the radius floor below would
    // otherwise leave a thin dark band at the edge.
    float radiusEnable = smoothstep(0.0, 0.75, shadow_radius);
    float effectiveIntensity = shadow_intensity * dirIntensity * radiusEnable;

    // Avoids 0/0 on the edge at radius 0: the NaN survives the multiply by a
    // zero intensity and draws a dark hairline.
    float safeRadius = max(effectiveRadius, 0.001);

    // The shadow of a soft edge: a tight and a broad Gaussian-blurred edge,
    // faded out by (1 - t^2)^3, which reaches zero at the radius with zero
    // slope and curvature. A profile built from pieces creases where they
    // meet, and the eye reads the crease as the shadow's border.
    float shadow_t = clamp(d / safeRadius, 0.0, 1.0);
    float edgeShadow = 0.18 * erfcPositive(shadow_t * 2.619) +
        1.17 * erfcPositive(shadow_t * 0.895);
    float shadowWindow = 1.0 - shadow_t * shadow_t;
    shadowWindow = shadowWindow * shadowWindow * shadowWindow;

    // Only outside the glass shape.
    float shadowAlpha = clamp(
        edgeShadow * shadowWindow * outsideMask * effectiveIntensity,
        0.0, 1.0
    );

    // The framebuffer keeps 8 bits, so the faint tail ends in a visible
    // 1/255 step. Noise of half a step rounds it stochastically instead.
    if (shadowAlpha > 0.0)
        shadowAlpha = max(shadowAlpha + ditherLSB(pixel_coord + vec2(37.0, 17.0)), 0.0);

    if (multi_region_mode > 0.5) {
        shadowAlpha = 0.0;
    }

    if (debug_view > 0.5) {
        // Mode 1 lifts faint values (a default shadow peaks near 0.29) so they
        // do not read as black; 0 stays 0.
        float dbgShadow = (debug_view < 1.5) ? pow(shadowAlpha, 0.35) : shadowAlpha;
        float dbgInside = (debug_view < 1.5) ? pow(insideMask, 0.35) : insideMask;
        cogl_color_out = vec4(dbgShadow, dbgInside, 0.0, 1.0) * cogl_color_in;
        return;
    }

    vec3 shadowColor = vec3(0.03, 0.04, 0.08);

#ifdef LG_SHAPE_TEXTURE
    vec2 gradH = shapeHeightGradient(local_pos, box_size, max_z, resolution);
#else
    vec2 gradH = heightGradient(local_pos, box_size, corner, lensBand, max_z * lensScale, resolution);
#endif
    vec3 normal = getNormal(gradH);

    vec2 disp = getDisplacement(d, normal, resolution);

    // Edge lensing. `disp` points inward, and the weight grows towards the
    // rim, so the displacement bends one way across the whole bevel:
    //     D(u) = D_raw(u) * (1 - u/bevel)^falloff
    // The mapping may fold, as a thick glass edge does; sampleBackdrop()
    // pays for that with the footprint computed below.
    float bevelPx = lensBand;
    float depthPx = max(-d, 0.0);
    float edgeT = clamp(1.0 - depthPx / bevelPx, 0.0, 1.0);

    float lensShape = pow(edgeT, EDGE_LENS_FALLOFF);

    vec2 dispPx = disp * resolution * lensShape * lensScale;
    float dispLenPx = length(dispPx);
    vec2 dispDirPx = dispPx / max(dispLenPx, 1.0e-4);
    if (dispLenPx > EDGE_LENS_REACH) {
        dispLenPx = EDGE_LENS_REACH;
        dispPx = dispDirPx * EDGE_LENS_REACH;
    }

    disp = dispPx / max(resolution, vec2(1.0));

    // How far the sample point moves per screen pixel, i.e. this pixel's
    // footprint in the source. Computed analytically, since dFdx/dFdy are not
    // guaranteed on Cogl's GLES2 path: the weight's derivative plus the raw
    // field's change over the bevel, doubled for the rim's steepness.
    float shapeRate = EDGE_LENS_FALLOFF * pow(edgeT, EDGE_LENS_FALLOFF - 1.0) / bevelPx;
    float footprintPx = 2.0 * dispLenPx * (shapeRate + 1.0 / bevelPx);
    vec2 footprintExt = (footprintPx > 2.0 && edge_taps_enabled > 0.5)
        ? dispDirPx * (min(footprintPx, 64.0) * 0.5) / resolution
        : vec2(0.0);

    vec2 refractedUv = stabilizedUV(uv + disp, uv);

    // Chromatic aberration as dispersion: blue bends more than red, by a
    // fraction of the refraction, so the colours part only where the glass
    // bends the backdrop and most where it bends it most.
    vec2 chromaVec = disp * clamp(chroma_strength, 0.0, 1.0);
    vec2 uvG = refractedUv;

    // Below a hundredth of a pixel the three channels sample the same texels,
    // so one set of fetches serves all of them.
    vec2 chromaPx = chromaVec * resolution;
    bool chromaActive = dot(chromaPx, chromaPx) > 1.0e-4;

    // Rotated-grid supersampling, spread wider near the edge.
    float edgeProximity = 1.0 - smoothstep(0.0, edgeFeather * 4.0, -d);
    float aa_spread = mix(0.75, 2.5, edgeProximity);
    vec2 texel = vec2(aa_spread) / resolution;

    vec3 refractedRgb;
    if (chromaActive) {
        vec2 uvR = stabilizedUV(refractedUv - chromaVec, refractedUv);
        vec2 uvB = stabilizedUV(refractedUv + chromaVec, refractedUv);

        refractedRgb = vec3(
            sampleBackdrop(uvR, footprintExt, texel, resolution).r,
            sampleBackdrop(uvG, footprintExt, texel, resolution).g,
            sampleBackdrop(uvB, footprintExt, texel, resolution).b
        );
    } else {
        refractedRgb = sampleBackdrop(uvG, footprintExt, texel, resolution);
    }

    vec3 adjustedRefracted = applySCB(refractedRgb, brightness, contrast, saturation);
    vec3 refracted = adjustedRefracted;

    // Two tint layers: the element's own colour (multi-region mode only),
    // then the user's tint.
    vec3 insideBaseColor = mix(refracted, activeTint, activeBaseStrength);
    insideBaseColor = mix(insideBaseColor, vec3(tint_r, tint_g, tint_b), tint_strength);

    // Not multiplied by insideMask: the final composite applies the coverage
    // once, and applying it twice darkens the antialiased edge.
    vec3 baseColor = insideBaseColor;

    // Inner shadow: darkest at the edge, gone ao_radius px inward. It is
    // applied below, once the rim light is known.
    float aoMask = 1.0 - smoothstep(0.0, max(ao_radius, 0.001), -d);

    vec3 lightDir = normalize(vec3(cos(lightAngleRad), sin(lightAngleRad), 0.38));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 reflectDir = reflect(-lightDir, normal);
    float response = 1.0;

    // The rim band. The width is kept above 0 for smoothstep(), and the step()
    // makes a rim width of 0 really turn it off.
    float safeRimWidth = max(rim_width, 0.001);
    float edgeBand = (1.0 - smoothstep(0.0, safeRimWidth, abs(d))) * step(0.0005, rim_width);

    float rimDot = 1.0 - max(dot(normal, viewDir), 0.0);
    float rimFresnel = pow(max(rimDot, 0.0), max(rim_power, 0.001));
    float lightMask = pow(abs(dot(normal, lightDir)), max(rim_directional_power, 1.0));

    // The inner shadow falls where the rim light does not, as on macOS. With
    // the surface light off it runs all the way round.
    float aoLight = mix(1.0, 1.0 - lightMask, surface_light_enabled);
    baseColor *= (1.0 - aoMask * ao_intensity * aoLight);

    float rimShape = mix(pow(edgeBand, 0.85), rimFresnel, 0.55) * edgeBand;
    float finalRimLight = rimShape * lightMask * rim_intensity * rim_light_color_intensity;
    finalRimLight *= response;

    float specularDot = max(dot(reflectDir, viewDir), 0.0);
    float specularLight = pow(specularDot, max(shininess, 1.0));
    specularLight *= specular_intensity * response;
    float specMask = mix(0.25, 1.0, insideMask) * clamp(edgeBand + insideMask * 0.65, 0.0, 1.0);
    specularLight *= specMask;

    float idleRim = edgeBand * 0.008;

    float sheenFacing = max(dot(normal, lightDir), 0.0);
    float surfaceSheen = pow(sheenFacing, 1.65);
    surfaceSheen *= mix(1.0, 0.55, edgeBand);
    float sheenLight = surfaceSheen * sheen_intensity;

    float alpha = insideMask;

    float addedLight = (specularLight + finalRimLight + idleRim + sheenLight) * surface_light_enabled;

    // Screen blend, which cannot blow out a white background the way adding
    // does.
    vec3 litColor = baseColor + addedLight - (baseColor * addedLight);

    // Scale down by the brightest channel rather than clamping each, which
    // would shift the hue.
    float maxChannel = max(litColor.r, max(litColor.g, litColor.b));
    if (maxChannel > 1.0) {
        litColor /= maxChannel;
    }
    litColor = max(litColor, 0.0);

    // Pixels outside the glass are not drawn, so they skip the conversion.
    if (highlight_backdrop_color > 0.5 && addedLight > 0.0 && alpha > 0.0)
        litColor = backdropHighlight(baseColor, litColor, addedLight);

    // Over the lighting, so the line keeps its colour. Only its inner border
    // is blended here; the outer one is the glass's own coverage.
    if (outline_width > 0.0) {
        float outlineMask = smoothstep(-outline_width - 0.5, -outline_width + 0.5, d);
        litColor = mix(litColor, vec3(outline_r, outline_g, outline_b), outlineMask);
    }

    // Glass over shadow in premultiplied alpha. Cogl adds src.rgb regardless
    // of src.a, so a colour emitted at zero coverage would tint the whole
    // actor.
    float shadowContribution = shadowAlpha * (1.0 - alpha);
    vec3 finalRgb   = litColor * alpha + shadowColor * shadowContribution;
    float finalAlpha = alpha + shadowContribution;

    // Scaled by the coverage to keep the colour premultiplied.
    finalRgb = max(finalRgb + ditherLSB(pixel_coord) * finalAlpha, 0.0);

    cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;
}
