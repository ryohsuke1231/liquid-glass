// shaders/glass.frag
uniform sampler2D cogl_sampler;

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
uniform float light_angle_deg;
uniform float mouse_radius;
uniform float bg_glow_intensity;
uniform float shadow_radius;
uniform float shadow_intensity;
uniform float padding;
uniform float isDock;

// Signed Distance Field (SDF) function for a rounded rectangle.
// Returns negative values inside the shape, positive outside, and 0 on the exact edge.
float sdRoundRect(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + vec2(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
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
    float fade = smoothstep(smoothZone, -smoothZone, d);
    return h * fade;
}

// Dynamically adjusts the sampling step size for normal estimation based on resolution.
float gradientStep(vec2 resolution) {
    float minRes = max(min(resolution.x, resolution.y), 1.0);
    return clamp(minRes / 560.0, 0.45, 1.20);
}

// Estimates the height gradient (slope) by sampling neighboring pixels.
vec2 heightGradient(vec2 p, vec2 b, float r, float zScale, vec2 resolution) {
    float e = gradientStep(resolution);

    float hR = getHeight(p + vec2(e, 0.0), b, r, zScale);
    float hL = getHeight(p - vec2(e, 0.0), b, r, zScale);
    float hB = getHeight(p + vec2(0.0, e), b, r, zScale);
    float hT = getHeight(p - vec2(0.0, e), b, r, zScale);

    return vec2((hR - hL) / (2.0 * e), (hB - hT) / (2.0 * e));
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
    float thicknessNorm = displacement_scale / minRes;

    // Safety clamp: Prevent infinite stretching artifacts near extreme curves
    // by ensuring the Z component never gets dangerously close to 0.
    float safe_z = max(-refractedRay.z, 0.15); 
    vec2 displacement = (refractedRay.xy / safe_z) * thicknessNorm;
    float max_disp = 0.30;
    if (length(displacement) > max_disp) {
        displacement = normalize(displacement) * max_disp;
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

void main() {
    vec2 resolution = vec2(resolution_x, resolution_y);
    vec2 uv = cogl_tex_coord_in[0].st;
    
    vec2 pixel_coord = uv * resolution;
    vec2 center = resolution * 0.5;

    // Pre-calculate geometry anti-aliasing feathering width.
    float edgeFeather = max(edge_smoothing, 0.75);

    vec2 local_pos = pixel_coord - center; 
    vec2 box_size;

    // Adjust the internal rendering box size based on the element type.
    if (isDock > 0.5) {
        // For the dock, dynamically shrink the box so the feathered edges 
        // don't get clipped by the hard screen boundaries.
        vec2 actual_size = resolution - vec2(padding * 2.0) - vec2(edgeFeather * 2.0);
        
        // Ensure size never goes below 1x1 to prevent division-by-zero crashes.
        box_size = max(actual_size * 0.5, vec2(1.0)); 
    } else {
        vec2 actual_size = resolution - vec2(padding * 2.0);
        box_size = max(actual_size * 0.5, vec2(1.0)); 
    }

    // Distance from the current pixel to the rounded rectangle boundary.
    float d = sdRoundRect(local_pos, box_size, corner_radius);
    
    // Geometry Anti-Aliasing: Smoothstep forces a sub-pixel soft transition.
    // Inside = 1.0, Outside = 0.0.
    float insideMask = smoothstep(edgeFeather, -edgeFeather, d);
    float outsideMask = 1.0 - insideMask;

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

    // 5) Clamp the effective radius to the bgActor's padded area so the
    //    shadow's penumbra cannot get hard-clipped at the actor boundary.
    //    (padding is the bgActor's expansion beyond the glass shape.)
    float maxRadius = max(padding - 2.0, 5.0);
    float effectiveRadius    = min(shadow_radius * dirRadius, maxRadius);
    float effectiveIntensity = shadow_intensity * dirIntensity;

    // 6) UMBRA: tight, dark core. Linear decay over 0.4 * effectiveRadius.
    //    This is the "contact shadow" band - very close to the glass.
    float umbra_t = clamp(d / max(effectiveRadius * 0.40, 0.5), 0.0, 1.0);
    float umbra  = (1.0 - umbra_t) * 0.80;

    // 7) PENUMBRA: wider, softer halo. Squared falloff gives a natural
    //    convex curve: sharper near the umbra edge, long faint tail.
    float penumbra_t = clamp(d / effectiveRadius, 0.0, 1.0);
    float penumbra   = (1.0 - penumbra_t) * (1.0 - penumbra_t) * 0.55;

    // 8) Combined shadow alpha, applied only OUTSIDE the glass shape.
    float shadowAlpha = clamp(
        (umbra + penumbra) * outsideMask * effectiveIntensity,
        0.0, 1.0
    );

    // 9) Shadow color: dark with a subtle cool/blue cast. Suggests ambient
    //    sky light bleeding into the shadow (a hallmark of realistic
    //    outdoor / window-lit shadow rendering). Avoids the "painted-on
    //    pure black" look.
    vec3 shadowColor = vec3(0.03, 0.04, 0.08);

    vec4 source = texture2D(cogl_sampler, uv);

    vec2 gradH = heightGradient(local_pos, box_size, corner_radius, max_z, resolution);
    vec3 normal = getNormal(gradH);

    vec2 disp = getDisplacement(d, normal, resolution);

    // Dampen the refraction near the exact boundaries to eliminate jagged artifacts.
    float edgeDampen = smoothstep(0.0, edgeFeather * 3.0, -d);
    disp *= edgeDampen;

    vec2 refractedUv = stabilizedUV(uv + disp, uv);

    float minRes = max(min(resolution.x, resolution.y), 1.0);
    vec2 chromaDir = length(disp) > 0.00001 ? normalize(disp) : vec2(0.0);
    
    // Calculate Chromatic Aberration vectors (separating RGB channels slightly).
    vec2 chromaVec = chromaDir * (chroma_strength / minRes) * edgeDampen;
    vec2 uvR = stabilizedUV(refractedUv + chromaVec, refractedUv);
    vec2 uvG = refractedUv;
    vec2 uvB = stabilizedUV(refractedUv - chromaVec, refractedUv);

    // Step 1: RGSS (Rotated Grid Super-Sampling) Pattern Implementation
    // Instead of sampling in a simple square, sampling in a slanted diamond pattern
    // provides significantly better anti-aliasing for both horizontal and vertical edges.
    float edgeProximity = 1.0 - smoothstep(0.0, edgeFeather * 4.0, -d);
    float aa_spread = mix(0.75, 2.5, edgeProximity);
    vec2 texel = vec2(aa_spread) / resolution;

    vec2 off1 = vec2( 0.375, -0.125) * texel;
    vec2 off2 = vec2( 0.125,  0.375) * texel;
    vec2 off3 = vec2(-0.375,  0.125) * texel;
    vec2 off4 = vec2(-0.125, -0.375) * texel;

    // Hard limit sampling coordinates to 1.2px inside the texture bounds.
    // This prevents bilinear filtering from accidentally pulling in black/transparent 
    // pixels from the void outside the texture space.
    vec2 margin = vec2(1.2) / resolution;
    #define SAFE(u) clamp(u, margin, 1.0 - margin)

    // Step 2: Multi-tap Sampling (Averaging 4 sub-pixels to smooth out the image)
    vec3 refractedRgb = vec3(
        (texture2D(cogl_sampler, SAFE(uvR + off1)).r +
         texture2D(cogl_sampler, SAFE(uvR + off2)).r +
         texture2D(cogl_sampler, SAFE(uvR + off3)).r +
         texture2D(cogl_sampler, SAFE(uvR + off4)).r) * 0.25,

        (texture2D(cogl_sampler, SAFE(uvG + off1)).g +
         texture2D(cogl_sampler, SAFE(uvG + off2)).g +
         texture2D(cogl_sampler, SAFE(uvG + off3)).g +
         texture2D(cogl_sampler, SAFE(uvG + off4)).g) * 0.25,

        (texture2D(cogl_sampler, SAFE(uvB + off1)).b +
         texture2D(cogl_sampler, SAFE(uvB + off2)).b +
         texture2D(cogl_sampler, SAFE(uvB + off3)).b +
         texture2D(cogl_sampler, SAFE(uvB + off4)).b) * 0.25
    );

    vec3 refracted = refractedRgb;
    vec3 tintColor = vec3(tint_r, tint_g, tint_b);
    vec3 insideBaseColor = mix(refracted, tintColor, tint_strength);

    vec3 baseColor = insideBaseColor * insideMask;

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
    //     d = -rim_width*1.5 (about 1.5 rim widths inward). Multiplied
    //     by 0.25 for a subtle but visible darkening on white bgs.
    float aoMask = 1.0 - smoothstep(0.0, max(rim_width * 1.5, 1.0), -d);
    baseColor *= (1.0 - aoMask * 0.25);

    // (b) Center focal highlight: bright spot offset slightly toward
    //     the light source, simulating where the curved glass focuses
    //     light. Uses lightDir2D (computed in the shadow block earlier
    //     in main()) so it tracks the user's light-angle setting.
    //     `-lightDir2D` because the focal point sits on the same side
    //     as the light, not the shadow side.
    vec2 focalOffset = -lightDir2D * box_size.x * 0.15;
    vec2 fromFocal  = (local_pos - focalOffset) / box_size;
    float radialDist = length(fromFocal);
    float focalHighlight = (1.0 - smoothstep(0.0, 0.85, radialDist)) * 0.20;
    baseColor += vec3(focalHighlight);

    // lightAngleRad was declared earlier in main() (in the shadow block) and
    // is reused here for the 3D lighting direction.
    vec3 lightDir = normalize(vec3(cos(lightAngleRad), sin(lightAngleRad), 0.38));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 reflectDir = reflect(-lightDir, normal);
    float response = 1.0;

    // Create a sharp band for the rim lighting near the edges.
    float edgeBand = smoothstep(rim_width, 0.0, abs(d));
    
    float rimDot = 1.0 - max(dot(normal, viewDir), 0.0);
    float rimFresnel = pow(max(rimDot, 0.0), max(rim_power, 0.001));
    float lightMask = pow(abs(dot(normal, lightDir)), max(rim_directional_power, 1.0));
    
    // Mix the fresnel effect with the edge mask to keep light strictly on the bevels.
    float rimShape = mix(pow(edgeBand, 0.85), rimFresnel, 0.55) * edgeBand;
    float finalRimLight = rimShape * lightMask * rim_intensity * rim_light_color_intensity;
    finalRimLight *= response;
    
    // Mask out light bleeding past the actual geometry boundary.
    finalRimLight *= insideMask; 

    float specularDot = max(dot(reflectDir, viewDir), 0.0);
    float specularLight = pow(specularDot, max(shininess, 1.0));
    specularLight *= specular_intensity * response;
    float specMask = mix(0.25, 1.0, insideMask) * clamp(edgeBand + insideMask * 0.65, 0.0, 1.0);
    specularLight *= specMask;

    float idleRim = edgeBand * 0.008;
    idleRim *= insideMask; 

    // Background sheen uses 3D surface normal directly (no 2D radial fallback).
    float sheenFacing = max(dot(normal, lightDir), 0.0);
    float surfaceSheen = pow(sheenFacing, 1.65);
    surfaceSheen *= insideMask * mix(1.0, 0.55, edgeBand);
    vec3 sheenColor = vec3(1.0) * surfaceSheen * sheen_intensity;

    float alpha = insideMask;
    
    // --- Light Blending Strategy ---
    
    // 1. Group all additive lighting components together
    vec3 addedLight = vec3(specularLight + finalRimLight + idleRim) + sheenColor;

    // 2. Screen Blend Mode (A + B - A*B)
    // Instead of simply adding lights (which causes intense overexposure and blows out 
    // white backgrounds), this smoothly limits the maximum brightness to 1.0.
    vec3 litColor = baseColor + addedLight - (baseColor * addedLight);

    // 3. Final safety clamp to absolutely prevent illegal HDR values.
    litColor = clamp(litColor, 0.0, 1.0);

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

    // Output with premultiplied alpha format, required by Clutter/Cogl pipeline.
    cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;
}
