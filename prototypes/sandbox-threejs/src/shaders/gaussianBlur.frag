// ============================================================================
// Shader: gaussianBlur.frag
// Purpose: A separable Gaussian blur fragment shader for post-processing.
// Description:
//   This shader performs one pass of a separable Gaussian blur (either
//   horizontal or vertical, depending on `uDirection`). It leverages linear
//   sampling to sample two pixels at once using optimized offsets and weights
//   calculated on the CPU.
// ============================================================================

precision highp float;

// Texture coordinates passed from the vertex shader.
varying vec2 vUv;

// Input texture (the image to be blurred).
uniform sampler2D tInput;

// Direction of the blur: (1.0, 0.0) for horizontal, (0.0, 1.0) for vertical.
uniform vec2 uDirection;

// Size of a single texel passed from CPU (1.0 / width, 1.0 / height).
uniform vec2 uTexelSize;

// Weight of the center pixel (tap 0) in the Gaussian kernel.
uniform float uCenterWeight;

// The number of sampled pixel pairs (each pair uses linear sampling optimization).
uniform int uPairCount;

// The maximum number of sample pairs allowed to keep execution bound.
const int MAX_GAUSS_PAIRS = 14;

// Pre-calculated offsets and weights for the linear sampling optimization.
uniform float uPairOffsets[MAX_GAUSS_PAIRS];
uniform float uPairWeights[MAX_GAUSS_PAIRS];

void main() {
    // Calculate the step vector for looking up neighboring texels.
    vec2 stepVec = uDirection * uTexelSize;

    // Start with the center texel multiplied by its weight.
    vec4 color = texture2D(tInput, vUv) * uCenterWeight;

    // Iterate through the pre-calculated pairs.
    for (int i = 0; i < MAX_GAUSS_PAIRS; i += 1) {
        // Break early if we've reached the required number of pairs for the current blur radius.
        if (i >= uPairCount)
            continue;

        float offset = uPairOffsets[i];
        float weight = uPairWeights[i];
        vec2 delta = stepVec * offset;

        // Sample in the positive and negative directions and accumulate the color.
        color += texture2D(tInput, vUv + delta) * weight;
        color += texture2D(tInput, vUv - delta) * weight;
    }

    gl_FragColor = color;
}
