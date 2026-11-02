// An icon redrawn from its style map (src/iconStyle/styleMap.ts) as glass
// plates under a symbol. A Cogl fragment snippet for
// src/iconStyle/iconStyler.ts; the contact sheet (tools/icon-sheet) runs it in
// WebGL too. With LG_ICON_GLASS (the clear look) each plate is glass drawn
// the way shaders/glass.frag draws it, with the same settings, over what is
// behind the icon and the plates under it.
uniform sampler2D cogl_sampler0; // The icon as drawn, for the launch animation
uniform sampler2D cogl_sampler1; // The style map
uniform sampler2D cogl_sampler2; // The tones of the plates in it

// The icon's square in layer 0's texture coordinates.
uniform float box_x0;
uniform float box_y0;
uniform float box_x1;
uniform float box_y1;
// Map px per screen px, for the width of anti-aliased edges.
uniform float map_px;
// 1 while a clone draws the icon (the launch animation): its colours only.
uniform float clone;
uniform float plate_r;
uniform float plate_g;
uniform float plate_b;
uniform float plate_a;
uniform float inner_r;
uniform float inner_g;
uniform float inner_b;
uniform float inner_a;
uniform float symbol_r;
uniform float symbol_g;
uniform float symbol_b;
uniform float symbol_a;
uniform float symbol_inner_r;
uniform float symbol_inner_g;
uniform float symbol_inner_b;
uniform float symbol_inner_a;
// The lit rim: brightness, width (map px), and light on the sides away from the light.
uniform float rim_a;
uniform float rim_width;
uniform float rim_base;
// How much lighter the outer plate is at its top than at its bottom.
uniform float sheen;
// How far a plate's tone takes its colour towards white or black.
uniform float tone_spread;
// How much of a plate's colour is added to the backdrop rather than laid over it.
uniform float additive;
// How much a band inside a plate's rim darkens the backdrop.
uniform float edge_shade;
// How dark the soft shadow under the symbol is, which keeps a light symbol readable on a light backdrop.
uniform float symbol_shadow;
// The glass rim's width as a multiple of the glass's (LG_ICON_GLASS).
uniform float rim_scale;
uniform float tint_r;
uniform float tint_g;
uniform float tint_b;
uniform float opacity;

const float MAP_SIZE = 256.0;
const float MAP_RANGE = 16.0;

#ifdef LG_ICON_GLASS
uniform sampler2D cogl_sampler3; // The lens map
uniform sampler2D cogl_sampler4; // What is behind the icon, blurred

// 0 while what is behind the icon is not known: the plates are drawn without it, as above.
uniform float glass_ready;
// The icon's square in layer 4's texture coordinates, its size on screen (px), and layer 4's size on screen and in
// texels.
uniform float bd_x0;
uniform float bd_y0;
uniform float bd_x1;
uniform float bd_y1;
uniform float box_w_px;
uniform float box_h_px;
uniform float bd_w_px;
uniform float bd_h_px;
uniform float bd_tex_w;
uniform float bd_tex_h;
// glass.frag's settings of the same names.
uniform float glass_max_z;
uniform float glass_displacement_scale;
uniform float glass_edge_smoothing;
uniform float glass_profile_shape_n;
uniform float glass_ior;
uniform float glass_chroma_strength;
uniform float glass_specular_intensity;
uniform float glass_shininess;
uniform float glass_rim_width;
uniform float glass_rim_intensity;
uniform float glass_rim_directional_power;
uniform float glass_rim_power;
uniform float glass_rim_light_color_intensity;
uniform float glass_sheen_intensity;
uniform float glass_light_angle_deg;
uniform float glass_ao_intensity;
uniform float glass_ao_radius;
uniform float glass_highlight_backdrop_color;
uniform float glass_surface_light_enabled;
uniform float glass_brightness;
uniform float glass_contrast;
uniform float glass_saturation;

const float LENS_SIZE = 128.0;
const float LENS_RANGE = 128.0;
// As in glass.frag.
const float EDGE_LENS_FALLOFF = 2.4;
const float EDGE_LENS_REACH = 96.0;
const float EDGE_LENS_BAND = 22.0;
const float HIGHLIGHT_CHROMA_GAIN = 1.25;

// One plate's glass at a pixel: its distance (px), the slope of its surface and where it bends the view to (px).
struct Lens {
    float d;
    vec3 normal;
    vec2 shift;
};

float lensDistance(float high, float low) {
    return mix(-LENS_RANGE, LENS_RANGE, (high * 65280.0 + low * 255.0) / 65535.0);
}

// The lens map's top and bottom half at `at`, kept off the texels of the other half.
vec4 lensTop(vec2 at) {
    float m = 0.5 / LENS_SIZE;
    return texture2D(cogl_sampler3, vec2(at.x, clamp(at.y, m, 1.0 - m) * 0.5));
}

vec4 lensBottom(vec2 at) {
    float m = 0.5 / LENS_SIZE;
    return texture2D(cogl_sampler3, vec2(at.x, 0.5 + clamp(at.y, m, 1.0 - m) * 0.5));
}

// The three plates' distances (map px) at `at`.
vec3 lensDistances(vec4 top, vec4 bottom) {
    return vec3(lensDistance(top.r, top.g), lensDistance(top.b, top.a), lensDistance(bottom.r, bottom.g));
}

float profileHeight(float t, float zScale) {
    float n = max(glass_profile_shape_n, 1.01);
    float inner = max(1.0 - pow(clamp(1.0 - t, 0.0, 1.0), n), 0.0);
    return pow(inner, 1.0 / n) * zScale;
}

float heightAtDistance(float d, float band, float zScale) {
    float smoothZone = max(glass_edge_smoothing, 1.0);
    if (d > smoothZone)
        return 0.0;
    float t = clamp(max(-d, 0.0) / max(band, 1.0), 0.0, 1.0);
    return profileHeight(t, zScale) * (1.0 - smoothstep(-smoothZone, smoothZone, d));
}

// A plate at distance d (px), whose distance grows along `dir` (px, not normalised) and whose deepest point is
// `halfWidth` px in: glass.frag's bevel, sized and scaled for the plate the same way.
Lens lens(float d, vec2 dir, float halfWidth, float minRes) {
    Lens l;
    l.d = d;
    l.normal = vec3(0.0, 0.0, 1.0);
    l.shift = vec2(0.0);
    float band = max(min(EDGE_LENS_BAND, halfWidth), 1.0);
    float lensScale = band / EDGE_LENS_BAND;
    float e = clamp(minRes / 560.0, 0.45, 1.20);
    // Outside the plate and past its bevel the surface is flat.
    float smoothZone = max(glass_edge_smoothing, 1.0);
    if (d > smoothZone + e || -d > band + e + smoothZone)
        return l;
    float zScale = glass_max_z * lensScale;
    float slope = (heightAtDistance(d + e, band, zScale) - heightAtDistance(d - e, band, zScale)) / (2.0 * e);
    float len = length(dir);
    vec2 grad = (len > 1.0e-5 ? dir / len : vec2(0.0)) * slope;
    l.normal = normalize(vec3(-grad, 1.0));
    vec3 ray = refract(vec3(0.0, 0.0, -1.0), l.normal, 1.0 / max(glass_ior, 1.001));
    if (d <= 0.0 && length(ray) > 0.0001) {
        vec2 shift = ray.xy / max(-ray.z, 0.15) * glass_displacement_scale;
        float shiftLen = length(shift);
        if (shiftLen > 0.30 * minRes)
            shift *= 0.30 * minRes / shiftLen;
        shift *= pow(clamp(1.0 - max(-d, 0.0) / band, 0.0, 1.0), EDGE_LENS_FALLOFF) * lensScale;
        shiftLen = length(shift);
        if (shiftLen > EDGE_LENS_REACH)
            shift *= EDGE_LENS_REACH / shiftLen;
        l.shift = shift;
    }
    return l;
}

// What is behind the icon at `at` (the icon's square, 0 to 1) moved by `shift` px, smoothly magnified.
vec3 behind(vec2 at, vec2 shift) {
    vec2 uv = mix(vec2(bd_x0, bd_y0), vec2(bd_x1, bd_y1), at) + shift / vec2(bd_w_px, bd_h_px);
    vec2 texSize = max(vec2(bd_tex_w, bd_tex_h), vec2(1.0));
    uv = clamp(uv, 1.2 / texSize, 1.0 - 1.2 / texSize);
    if (texSize.x >= 2.0 && texSize.y >= 2.0 && min(bd_w_px / texSize.x, bd_h_px / texSize.y) > 1.05) {
        vec2 t = uv * texSize - 0.5;
        vec2 f = fract(t);
        f = f * f * (3.0 - 2.0 * f);
        uv = (floor(t) + 0.5 + f) / texSize;
    }
    return texture2D(cogl_sampler4, uv).rgb;
}

// Four rotated-grid taps around `shift`, as glass.frag takes away from the edge.
vec3 behindAround(vec2 at, vec2 shift) {
    return (behind(at, shift + vec2(0.28, -0.09)) + behind(at, shift + vec2(0.09, 0.28)) +
            behind(at, shift + vec2(-0.28, 0.09)) + behind(at, shift + vec2(-0.09, -0.28))) * 0.25;
}

vec3 applySCB(vec3 color) {
    color *= glass_brightness;
    color = mix(vec3(0.5), color, glass_contrast);
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    return max(mix(vec3(luma), color, glass_saturation), 0.0);
}

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

float gamutRoom(float from, float delta) {
    if (delta > 1.0e-6)
        return (1.0 - from) / delta;
    if (delta < -1.0e-6)
        return -from / delta;
    return 1.0;
}

// glass.frag's highlight in the colour of what is behind the glass.
vec3 backdropHighlight(vec3 base, vec3 lit, float light) {
    vec3 litLab = toOklab(lit);
    vec2 baseChroma = toOklab(base).yz * HIGHLIGHT_CHROMA_GAIN;
    litLab.yz = mix(litLab.yz, baseChroma, clamp(light * 4.0, 0.0, 1.0));
    vec3 from = pow(max(lit, 0.0), vec3(2.2));
    vec3 delta = oklabToLinear(litLab) - from;
    float t = min(min(gamutRoom(from.r, delta.r), gamutRoom(from.g, delta.g)), min(gamutRoom(from.b, delta.b), 1.0));
    return pow(clamp(from + delta * max(t, 0.0), 0.0, 1.0), vec3(1.0 / 2.2));
}

// One plate's glass over `under` (what is behind it, plates under it included, as it bends it): the colour
// adjustments, the inner shadow, a frost of `frost` white, and the rim, specular and sheen as glass.frag lights them.
vec3 glassOver(vec3 under, Lens l, float frost) {
    vec3 base = applySCB(under);
    float a = radians(glass_light_angle_deg);
    vec3 lightDir = normalize(vec3(cos(a), sin(a), 0.38));
    vec3 n = l.normal;
    float lightMask = pow(abs(dot(n, lightDir)), max(glass_rim_directional_power, 1.0));
    float aoMask = 1.0 - smoothstep(0.0, max(glass_ao_radius, 0.001), -l.d);
    base *= 1.0 - aoMask * glass_ao_intensity * mix(1.0, 1.0 - lightMask, glass_surface_light_enabled);
    base += (1.0 - base) * frost;

    float rimWidth = glass_rim_width * rim_scale;
    float edgeBand = (1.0 - smoothstep(0.0, max(rimWidth, 0.001), abs(l.d))) * step(0.0005, rimWidth);
    float rimFresnel = pow(max(1.0 - max(n.z, 0.0), 0.0), max(glass_rim_power, 0.001));
    float rim = mix(pow(edgeBand, 0.85), rimFresnel, 0.55) * edgeBand * lightMask * glass_rim_intensity *
        glass_rim_light_color_intensity;
    float specular = pow(max(reflect(-lightDir, n).z, 0.0), max(glass_shininess, 1.0)) * glass_specular_intensity *
        clamp(edgeBand + 0.65, 0.0, 1.0);
    float sheen = pow(max(dot(n, lightDir), 0.0), 1.65) * mix(1.0, 0.55, edgeBand) * glass_sheen_intensity;
    float light = (specular + rim + edgeBand * 0.008 + sheen) * glass_surface_light_enabled;

    vec3 lit = base + light - base * light;
    float maxChannel = max(lit.r, max(lit.g, lit.b));
    if (maxChannel > 1.0)
        lit /= maxChannel;
    lit = max(lit, 0.0);
    if (glass_highlight_backdrop_color > 0.5 && light > 0.0)
        lit = backdropHighlight(base, lit, light);
    return lit;
}
#endif

float field(float v) {
    return (0.5 - v) * 2.0 * MAP_RANGE;
}

vec4 over(vec4 dst, vec4 src) {
    return src + dst * (1.0 - src.a);
}

float coverage(float d) {
    return clamp(0.5 - d / max(map_px, 0.5), 0.0, 1.0);
}

// A plate whose outline is at distance d (map px) with outward normal n: a
// sheet of colour whose rim catches light on the sides facing the top left
// and the bottom right, as glass does.
vec4 plate(float d, vec2 n, vec3 rgb, float alpha) {
    float rim = 1.0 - clamp(-d / max(rim_width, 0.5), 0.0, 1.0);
    rim *= rim;
    float facing = abs(dot(n, normalize(vec2(-0.55, -0.83))));
    float light = rim_a * rim * mix(rim_base, 1.0, facing);
    float shade = edge_shade * (1.0 - clamp(-d / max(rim_width * 2.5, 0.5), 0.0, 1.0));
    // Premultiplied, so an alpha below the colour adds light instead of covering.
    vec4 c = vec4(rgb * alpha, alpha * (1.0 - additive));
    c = over(c, vec4(0.0, 0.0, 0.0, shade));
    c = over(c, vec4(vec3(light), light));
    return c * coverage(d);
}

// A plate's colour and opacity at a tone: 0.5 is the colour itself, 1 towards white and more opaque, 0 towards black
// and clearer. The opacity carries the difference where the colour is white already.
vec4 toned(vec3 rgb, float alpha, float tone) {
    float d = (tone - 0.5) * 2.0 * tone_spread;
    rgb = mix(mix(rgb, vec3(1.0), max(d, 0.0) * 0.55), vec3(0.0), max(-d, 0.0) * 0.45);
    return vec4(rgb, clamp(alpha * (1.0 + d * 0.6), 0.0, 1.0));
}

vec2 gradient(vec4 l, vec4 r, vec4 u, vec4 b, int channel) {
    vec2 g;
    if (channel == 0) g = vec2(l.r - r.r, u.r - b.r);
    else if (channel == 1) g = vec2(l.g - r.g, u.g - b.g);
    else g = vec2(l.b - r.b, u.b - b.b);
    float len = length(g);
    return len > 1e-5 ? g / len : vec2(0.0);
}

// No early return, and no texture read inside a branch: a mipmapped read in a
// branch that some neighbouring pixels skip picks a wrong level on real GPUs,
// which shows as dark lines along the square's edges. Cogl may add its own
// steps after this code.
void main() {
    vec2 st = cogl_tex_coord_in[0].st;
    vec2 uv = (st - vec2(box_x0, box_y0)) / vec2(box_x1 - box_x0, box_y1 - box_y0);
    vec2 at = clamp(uv, 0.0, 1.0);
    float t = 1.0 / MAP_SIZE;
    vec4 m = texture2D(cogl_sampler1, at);
    vec4 l = texture2D(cogl_sampler1, at - vec2(t, 0.0));
    vec4 r = texture2D(cogl_sampler1, at + vec2(t, 0.0));
    vec4 u = texture2D(cogl_sampler1, at - vec2(0.0, t));
    vec4 b = texture2D(cogl_sampler1, at + vec2(0.0, t));
    vec4 icon = texture2D(cogl_sampler0, st);
    vec4 tone = texture2D(cogl_sampler2, at);
    // A coarser mipmap level blurs the shadow.
    float shadowMask = texture2D(cogl_sampler1, at - vec2(0.0, 1.2 * map_px * t), 1.5).a;

    vec3 base = toned(vec3(plate_r, plate_g, plate_b), plate_a, tone.b).rgb * (1.0 + sheen * (0.5 - at.y));
    vec4 c = plate(field(m.r), gradient(l, r, u, b, 0), base, plate_a);
    vec3 inner = vec3(inner_r, inner_g, inner_b);
    vec4 firstTone = toned(inner, inner_a, tone.r);
    vec4 deeperTone = toned(inner, inner_a, tone.g);
    vec4 first = plate(field(m.g), gradient(l, r, u, b, 1), firstTone.rgb, firstTone.a);
    vec4 deeper = plate(field(m.b), gradient(l, r, u, b, 2), deeperTone.rgb, deeperTone.a);
    c = over(over(c, first), deeper);
    // Over a plate on the outer one the symbol takes its other colour, to stand apart from that plate.
    float onInner = max(first.a / max(firstTone.a, 0.01), deeper.a / max(deeperTone.a, 0.01));
    vec4 symbol = mix(vec4(symbol_r, symbol_g, symbol_b, symbol_a),
                      vec4(symbol_inner_r, symbol_inner_g, symbol_inner_b, symbol_inner_a), clamp(onInner, 0.0, 1.0));
    c = over(c, vec4(0.0, 0.0, 0.0, symbol_shadow * shadowMask * symbol.a));
    c = over(c, vec4(symbol.rgb, 1.0) * (symbol.a * m.a));
    float inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
    c *= inside;

    // The launch animation: lightness over the tint, from its dark to its light side.
    vec3 rgb = icon.a > 0.0 ? icon.rgb / icon.a : vec3(0.0);
    float lightness = smoothstep(0.08, 0.92, dot(rgb, vec3(0.2126, 0.7152, 0.0722)));
    vec3 tint = vec3(tint_r, tint_g, tint_b);
    vec4 launch = vec4(mix(tint * 0.3, mix(tint, vec3(1.0), 0.7), lightness) * icon.a, icon.a);

#ifdef LG_ICON_GLASS
    // The plates' glass. The view through all of them is bent by each in turn, and each lights what is under it,
    // the plates below included. Layers 3 and 4 are not mipmapped, so they can be read in branches.
    if (glass_ready > 0.5) {
        vec4 lensTopHere = lensTop(at);
        vec4 lensBottomHere = lensBottom(at);
        vec3 dist = lensDistances(lensTopHere, lensBottomHere);
        vec2 boxPx = max(vec2(box_w_px, box_h_px), vec2(1.0));
        float pxPerMap = (boxPx.x + boxPx.y) * 0.5 / MAP_SIZE;
        vec3 dx = vec3(0.0);
        vec3 dy = vec3(0.0);
        vec3 distPx = dist * pxPerMap;
        float lensReach = EDGE_LENS_BAND + 3.0 + max(glass_edge_smoothing, 1.0);
        vec3 nearEdge = step(vec3(-lensReach), distPx) * step(distPx, vec3(lensReach - EDGE_LENS_BAND));
        if (max(nearEdge.x, max(nearEdge.y, nearEdge.z)) > 0.5) {
            float lt = 1.0 / LENS_SIZE;
            dx = lensDistances(lensTop(at + vec2(lt, 0.0)), lensBottom(at + vec2(lt, 0.0))) -
                 lensDistances(lensTop(at - vec2(lt, 0.0)), lensBottom(at - vec2(lt, 0.0)));
            dy = lensDistances(lensTop(at + vec2(0.0, lt)), lensBottom(at + vec2(0.0, lt))) -
                 lensDistances(lensTop(at - vec2(0.0, lt)), lensBottom(at - vec2(0.0, lt)));
        }
        float minRes = min(boxPx.x, boxPx.y);
        // The outer plate is centred, so its deepest point is the middle.
        float outerHalf = -lensDistance(lensTop(vec2(0.5)).r, lensTop(vec2(0.5)).g);
        Lens outerLens = lens(dist.x * pxPerMap, vec2(dx.x / boxPx.x, dy.x / boxPx.y), outerHalf * pxPerMap, minRes);
        Lens firstLens = lens(dist.y * pxPerMap, vec2(dx.y / boxPx.x, dy.y / boxPx.y),
                              lensBottomHere.b * LENS_RANGE * pxPerMap, minRes);
        Lens deeperLens = lens(dist.z * pxPerMap, vec2(dx.z / boxPx.x, dy.z / boxPx.y),
                               lensBottomHere.a * LENS_RANGE * pxPerMap, minRes);
        float outerCover = coverage(field(m.r));
        float firstCover = coverage(field(m.g));
        float deeperCover = coverage(field(m.b));
        vec2 shift = outerLens.shift * outerCover + firstLens.shift * firstCover + deeperLens.shift * deeperCover;
        vec3 seen = behindAround(at, shift);
        vec2 chroma = shift * clamp(glass_chroma_strength, 0.0, 1.0);
        if (dot(chroma, chroma) > 1.0e-4)
            seen = vec3(behindAround(at, shift - chroma).r, seen.g, behindAround(at, shift + chroma).b);
        vec3 glass = seen;
        if (outerCover > 0.0)
            glass = mix(glass, glassOver(glass, outerLens, toned(vec3(1.0), plate_a, tone.b).a), outerCover);
        if (firstCover > 0.0)
            glass = mix(glass, glassOver(glass, firstLens, firstTone.a), firstCover);
        if (deeperCover > 0.0)
            glass = mix(glass, glassOver(glass, deeperLens, deeperTone.a), deeperCover);
        float cover = max(outerCover, max(firstCover, deeperCover));
        vec4 g = vec4(glass * cover, cover);
        g = over(g, vec4(0.0, 0.0, 0.0, symbol_shadow * shadowMask * symbol.a));
        g = over(g, vec4(symbol.rgb, 1.0) * (symbol.a * m.a));
        c = g * inside;
    }
#endif

    cogl_color_out = mix(c, launch, step(0.5, clone)) * opacity;
}
