precision highp float;

varying vec2 vUv;

uniform sampler2D tInput;
uniform vec2 uDirection;
uniform vec2 uTexelSize;
uniform float uCenterWeight;
uniform int uPairCount;

const int MAX_GAUSS_PAIRS = 14;

uniform float uPairOffsets[MAX_GAUSS_PAIRS];
uniform float uPairWeights[MAX_GAUSS_PAIRS];

void main() {
    vec2 stepVec = uDirection * uTexelSize;

    vec4 color = texture2D(tInput, vUv) * uCenterWeight;

    for (int i = 0; i < MAX_GAUSS_PAIRS; i += 1) {
        if (i >= uPairCount)
            continue;

        float offset = uPairOffsets[i];
        float weight = uPairWeights[i];
        vec2 delta = stepVec * offset;

        color += texture2D(tInput, vUv + delta) * weight;
        color += texture2D(tInput, vUv - delta) * weight;
    }

    gl_FragColor = color;
}
