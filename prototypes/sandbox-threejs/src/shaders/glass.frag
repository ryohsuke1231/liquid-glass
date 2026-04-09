// ============================================================================
// Shader: glass.frag
// Purpose: Main refraction, chromatic aberration, and lighting shader.
// Description:
//   This shader simulates a thick glass or liquid capsule by raycasting 
//   through a mathematically defined signed distance field (SDF). It handles
//   refraction (via Snell's law), chromatic aberration, pseudo-MSAA for edges,
//   and complex multi-light interactions (rim light, specularity, sheen).
// ============================================================================

precision highp float;

// UV coordinates passed from vertex shader
varying vec2 vUv;

// Main rendered background texture to distort
uniform sampler2D cogl_sampler;
// Blurred version of the background texture
uniform sampler2D scene_blur;

// Display and resolution coordinates
uniform float resolution_x;
uniform float resolution_y;
uniform float pointer_x;
uniform float pointer_y;

// Visual properties / Material tuning
uniform float intensity;
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

// Lighting attributes
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

// Screen coordinates for texture projection mapping
uniform float viewport_x;
uniform float viewport_y;
uniform float viewport_w;
uniform float viewport_h;

// Calculate 2D Signed Distance to a rounded rectangle
float sdRoundRect(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + vec2(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}

// Convert a distance to a normalized [0,1] depth for height evaluation
float normalizedDepth(float d, vec2 b, float r) {
    float maxDepth = max(-sdRoundRect(vec2(0.0, 0.0), b, r), 1.0);
    float interiorDepth = max(-d, 0.0);
    return clamp(interiorDepth / maxDepth, 0.0, 1.0);
}

// Evaluate superellipse curve for the glass cross-section profile
float profileHeight(float t, float zScale) {
    // Superellipse profile: h = H * (1 - (1 - t)^n)^(1/n), t: edge=0 -> center=1.
    float n = max(profile_shape_n, 1.01);
    float invT = clamp(1.0 - t, 0.0, 1.0);
    float inner = max(1.0 - pow(invT, n), 0.0);
    float h = pow(inner, 1.0 / n);
    return h * zScale;
}

// Retrieve continuous geometry height from a 2D uv coordinate
float getHeight(vec2 p, vec2 b, float r, float zScale) {
    float d = sdRoundRect(p, b, r);

    // If outside the container (d > 0), return height 0
    if (d > 0.0)
        return 0.0;

    float t = normalizedDepth(d, b, r);
    return profileHeight(t, zScale);
}

// Compute the optimal step size to compute finite differences.
float gradientStep(vec2 resolution) {
    float minRes = max(min(resolution.x, resolution.y), 1.0);
    return clamp(minRes / 560.0, 0.45, 1.20);
}

// Compute the 2D gradient by sampling height in 4 compass directions.
vec2 heightGradient(vec2 p, vec2 b, float r, float zScale, vec2 resolution) {
    float e = gradientStep(resolution);

    float hR = getHeight(p + vec2(e, 0.0), b, r, zScale);
    float hL = getHeight(p - vec2(e, 0.0), b, r, zScale);
    float hB = getHeight(p + vec2(0.0, e), b, r, zScale);
    float hT = getHeight(p - vec2(0.0, e), b, r, zScale);

    return vec2((hR - hL) / (2.0 * e), (hB - hT) / (2.0 * e));
}

// Construct a 3D upward normal based on the derived 2D gradient
vec3 getNormal(vec2 gradH) {
    return normalize(vec3(-gradH.x, -gradH.y, 1.0));
}

// Calculate intersection displacement on the background plane via refraction
vec2 getDisplacement(float d, vec3 normal, vec2 resolution) {
    // Return early if evaluating outside the shape
    if (d > 0.0)
        return vec2(0.0);

    // Standard incident view vector (looking into the screen)
    vec3 viewDir = vec3(0.0, 0.0, -1.0);
    
    // Refract light using Snell's law (Air ~ 1.0 -> Glass ~ IOR)
    float eta = 1.0 / max(ior, 1.001);
    vec3 refractedRay = refract(viewDir, normal, eta);

    // If total internal reflection occurs, refractedRay is (0,0,0)
    if (length(refractedRay) < 0.0001)
        return vec2(0.0);

    // Normalize thickness relative to minimum viewport dimension
    float minRes = max(min(resolution.x, resolution.y), 1.0);
    float thicknessNorm = displacement_scale / minRes;
    
    // Project the refracted ray onto the background plane
    vec2 displacement = (refractedRay.xy / -refractedRay.z) * thicknessNorm;

    return displacement;
}

// Keep UV coordinates valid to avoid sampling artifacts around screen edges
vec2 stabilizedUV(vec2 candidate, vec2 fallback) {
    vec2 clamped = clamp(candidate, vec2(0.001), vec2(0.999));
    float edgeDist = min(min(candidate.x, candidate.y), min(1.0 - candidate.x, 1.0 - candidate.y));
    float keep = smoothstep(-0.04, 0.03, edgeDist);
    return mix(fallback, clamped, keep);
}

// Convert a local stage UV to a global scene UV using tracked viewport coordinates
vec2 stageToSceneUv(vec2 stageUv, vec2 resolution) {
    // vUv is bottom-left based; convert once to CSS top-left before applying viewport offsets.
    vec2 localPx = vec2(stageUv.x, 1.0 - stageUv.y) * resolution;
    vec2 scenePx = vec2(viewport_x, viewport_y) + localPx;
    vec2 sceneRes = max(vec2(viewport_w, viewport_h), vec2(1.0));
    vec2 topLeftUv = scenePx / sceneRes;
    return clamp(vec2(topLeftUv.x, 1.0 - topLeftUv.y), vec2(0.001), vec2(0.999));
}

void main() {
    // Initialize coordinate properties
    vec2 resolution = vec2(resolution_x, resolution_y);
    vec2 uv = vUv;
    vec2 pixel_coord = uv * resolution;
    vec2 center = resolution * 0.5;
    vec2 local_pos = pixel_coord - center;
    vec2 box_size = resolution * 0.5;

    // Calculate signed distance to evaluate if coordinate is inside or outside the object
    float d = sdRoundRect(local_pos, box_size, corner_radius);
    
    // Evaluate transition variables based on distance to soften the boundary and produce AA
    float edgeFeather = max(edge_smoothing, 0.001);
    float edgeTransition = smoothstep(0.0, edgeFeather, d);
    float insideMask = 1.0 - edgeTransition;
    float outsideMask = edgeTransition;
    
    // Acquire native background texture without modifications or blurring
    vec2 sceneUv = stageToSceneUv(uv, resolution);
    vec4 source = texture2D(cogl_sampler, sceneUv);

    // Calculate gradients to generate the 3-dimensional shape profile
    vec2 gradH = heightGradient(local_pos, box_size, corner_radius, max_z, resolution);
    vec3 normal = getNormal(gradH);

    // Get refraction displacement mapping based on the derived object curvature
    vec2 disp = getDisplacement(d, normal, resolution);
    vec2 refractedUv = stabilizedUV(uv + disp, uv);

    // Apply Chromatic aberration based on displacement vector. Red & Blue split while Green centers.
    float minRes = max(min(resolution.x, resolution.y), 1.0);
    vec2 chromaDir = length(disp) > 0.00001 ? normalize(disp) : vec2(0.0);
    vec2 chromaVec = chromaDir * (chroma_strength / minRes);
    vec2 uvR = stabilizedUV(refractedUv + chromaVec, refractedUv);
    vec2 uvG = refractedUv;
    vec2 uvB = stabilizedUV(refractedUv - chromaVec, refractedUv);

    // Compute separate sample UVs mapping them back to global scene coordinates
    vec2 sceneUvR = stageToSceneUv(uvR, resolution);
    vec2 sceneUvG = stageToSceneUv(uvG, resolution);
    vec2 sceneUvB = stageToSceneUv(uvB, resolution);

    // Step 1: Adaptive Anti-Aliasing Radius
    // Edge steepness increases as normal.z approaches 0.
    float edgeSteepness = 1.0 - normal.z;
    // Scale offset based on edge steepness and a fixed max pixel radius (e.g., 2.0 pixels)
    float aaRadius = smoothstep(0.0, 0.5, edgeSteepness) * (2.0 / minRes);

    // Step 2: Multi-tap Sampling (Pseudo-MSAA)
    // Sample in a 4-tap X pattern from blurred texture map to average out jaggies.
    vec2 off = vec2(aaRadius);
    
    vec3 refractedRgb = vec3(
        (texture2D(scene_blur, sceneUvR + vec2(off.x,  off.y)).r +
         texture2D(scene_blur, sceneUvR + vec2(-off.x, off.y)).r +
         texture2D(scene_blur, sceneUvR + vec2(off.x, -off.y)).r +
         texture2D(scene_blur, sceneUvR + vec2(-off.x,-off.y)).r) * 0.25,

        (texture2D(scene_blur, sceneUvG + vec2(off.x,  off.y)).g +
         texture2D(scene_blur, sceneUvG + vec2(-off.x, off.y)).g +
         texture2D(scene_blur, sceneUvG + vec2(off.x, -off.y)).g +
         texture2D(scene_blur, sceneUvG + vec2(-off.x,-off.y)).g) * 0.25,

        (texture2D(scene_blur, sceneUvB + vec2(off.x,  off.y)).b +
         texture2D(scene_blur, sceneUvB + vec2(-off.x, off.y)).b +
         texture2D(scene_blur, sceneUvB + vec2(off.x, -off.y)).b +
         texture2D(scene_blur, sceneUvB + vec2(-off.x,-off.y)).b) * 0.25
    );

    vec3 refracted = refractedRgb;
    vec3 tintColor = vec3(tint_r, tint_g, tint_b);
    vec3 insideBaseColor = mix(refracted, tintColor, tint_strength);

    vec3 baseColor = insideBaseColor * insideMask;

    // ----- Lighting Computations -----
    
    // Evaluate main directional light mapping
    float lightAngleRad = radians(light_angle_deg);
    vec3 lightDir = normalize(vec3(cos(lightAngleRad), sin(lightAngleRad), 0.38));
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 reflectDir = reflect(-lightDir, normal);
    float response = 1.0;

    // Define object edges masking for effects clipping
    float edgeBand = 1.0 - smoothstep(0.0, max(rim_width, 0.001), abs(d));

    // Calculate Rim effect simulating light hitting glancing boundaries (Fresnel approx)
    float rimDot = 1.0 - max(dot(normal, viewDir), 0.0);
    float rimFresnel = pow(max(rimDot, 0.0), max(rim_power, 0.001));
    float lightMask = pow(abs(dot(normal, lightDir)), max(rim_directional_power, 1.0));
    float rimShape = mix(pow(edgeBand, 0.85), rimFresnel, 0.55);
    float finalRimLight = rimShape * lightMask * rim_intensity * rim_light_color_intensity;
    finalRimLight *= response;

    // Calculate main Specular reflection off the curved surface
    float specularDot = max(dot(reflectDir, viewDir), 0.0);
    float specularLight = pow(specularDot, max(shininess, 1.0));
    specularLight *= specular_intensity * response;
    float specMask = mix(0.25, 1.0, insideMask) * clamp(edgeBand + insideMask * 0.65, 0.0, 1.0);
    specularLight *= specMask;

    // Subtle edge rim light simulation to preserve shape visibility in dark backdrops
    float idleRim = edgeBand * 0.008;

    // Background sheen uses 3D surface normal directly to brighten facing curves
    float sheenFacing = max(dot(normal, lightDir), 0.0);
    float surfaceSheen = pow(sheenFacing, 1.65);
    surfaceSheen *= insideMask * mix(1.0, 0.55, edgeBand);
    vec3 sheenColor = vec3(1.0) * surfaceSheen * sheen_intensity;

    // Define pixel alpha to render outer boundaries fully transparent
    float alpha = insideMask;

    // Accumulate final pixel color outputs
    vec3 litColor = baseColor + vec3(specularLight + finalRimLight + idleRim) + sheenColor;
    gl_FragColor = vec4(litColor, alpha);
}
