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
/**
 * A linear-sampling Gaussian kernel for `sigma` (half-res texels) with
 * `fetchPairs` merged tap pairs: the center stays a single sample, and each
 * (i, i+1) pair becomes one fetch at the weighted mean offset. The shader's
 * structure depends only on fetchPairs, so a sigma change within it only
 * updates the kernel_scale uniform.
 */
export function computeGaussianKernel(sigma, fetchPairs) {
    const sideTaps = Math.max(2, fetchPairs * 2);
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
 * An unrolled GLSL snippet for `kernel`. Offsets and weights are constants;
 * kernel_scale scales the offsets at runtime.
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
