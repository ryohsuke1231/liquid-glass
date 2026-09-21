/**
 * Splits a GLSL source string into { decl, body } at the "void main()" boundary.
 */
export function splitShader(src, warn) {
    const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
    if (!match || match.index === undefined) {
        warn?.('[Liquid Glass] void main() not found; treating entire source as decl.');
        return { decl: src, body: '' };
    }
    const decl = src.substring(0, match.index);
    const rest = src.substring(match.index + match[0].length);
    // Find the matching closing brace.
    let depth = 1;
    let bodyEnd = 0;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '{')
            depth++;
        else if (rest[i] === '}') {
            depth--;
            if (depth === 0) {
                bodyEnd = i;
                break;
            }
        }
    }
    return { decl, body: rest.substring(0, bodyEnd) };
}
// ─── Dynamic Gaussian kernel computation / shader generation ────────────────
/**
 * Computes a linear-sampling-optimized 1D Gaussian kernel from a standard
 * deviation (sigma, in half-res texels) and a target number of fetch pairs.
 *
 * Method:
 *   1. Compute discrete Gaussian weights for i = 0..(fetchPairs*2) and normalize.
 *   2. i = 0 (the center) stays a single, standalone sample.
 *   3. Merge each (i, i+1) pair into a single fetch (bilinear-tap merging):
 *        combined weight  = w(i) + w(i+1)
 *        combined offset  = (i * w(i) + (i+1) * w(i+1)) / combined weight
 *
 * For a fixed fetchPairs, the resulting offsets/weights (and therefore the
 * shader's structure) are deterministic. As long as fetchPairs doesn't
 * change, sigma changes only need to update the kernel_scale uniform — see
 * setBlurRadius() — without any shader recompilation.
 */
export function computeGaussianKernel(sigma, fetchPairs) {
    const sideTaps = Math.max(2, fetchPairs * 2);
    // Compute and normalize discrete Gaussian weights for i = 0..sideTaps.
    const raw = [];
    let sum = 0;
    for (let i = 0; i <= sideTaps; i++) {
        const w = Math.exp(-(i * i) / (2 * sigma * sigma));
        raw.push(w);
        sum += (i === 0) ? w : w * 2;
    }
    for (let i = 0; i <= sideTaps; i++) {
        raw[i] /= sum;
    }
    const offsets = [0];
    const weights = [raw[0]];
    for (let p = 0; p < fetchPairs; p++) {
        const i = p * 2 + 1;
        const j = i + 1;
        const w0 = raw[i] ?? 0;
        const w1 = (j <= sideTaps) ? raw[j] : 0;
        const wSum = w0 + w1;
        const offset = wSum > 0 ? (i * w0 + j * w1) / wSum : i;
        offsets.push(offset);
        weights.push(wSum);
    }
    return { offsets, weights };
}
/**
 * Builds a GLSL fragment shader snippet string from a GaussianKernel
 * (fully unrolled — no for loop is used at runtime).
 *
 * Offsets are baked in as GLSL constants; the kernel_scale uniform is
 * multiplied in at runtime so sigma can be fine-tuned without recompiling.
 * Weights define the kernel's shape (fetch count) and are only baked in
 * again when a recompile actually happens.
 */
export function buildGaussianSnippet(kernel, direction) {
    const decl = `uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */\n` +
        `uniform float kernel_scale; /* dynamic scale based on the sigma ratio, avoids recompiling */\n`;
    const lines = [];
    lines.push(`vec2 uv = cogl_tex_coord_in[0].st;`);
    lines.push(`vec4 col = texture2D(cogl_sampler0, uv) * ${kernel.weights[0].toFixed(8)};`);
    for (let i = 1; i < kernel.offsets.length; i++) {
        const off = kernel.offsets[i].toFixed(8);
        const w = kernel.weights[i].toFixed(8);
        const plusVec = direction === 'h'
            ? `vec2(${off} * kernel_scale * inv_size.x, 0.0)`
            : `vec2(0.0, ${off} * kernel_scale * inv_size.y)`;
        lines.push(`col += texture2D(cogl_sampler0, uv + ${plusVec}) * ${w};`);
        lines.push(`col += texture2D(cogl_sampler0, uv - ${plusVec}) * ${w};`);
    }
    lines.push(`cogl_color_out = col;`);
    return { decl, body: '\n    ' + lines.join('\n    ') + '\n' };
}
