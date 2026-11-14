// The two loops nearly all of a network's time goes into, written so they can
// run in the process that holds the network or in helper processes (see
// kernelPool.ts). Plain typed arrays only.
/** out[offset...] = a (n x k) times b (k x m), row-major. `out` must be zeroed there. */
export function matmul(a, b, n, k, m, out, offset = 0) {
    const k8 = k - (k % 8);
    for (let i = 0; i < n; i++) {
        const ai = i * k;
        const ci = offset + i * m;
        // Eight rows of b a pass, so each element of the output row is loaded and stored an eighth as often.
        for (let p = 0; p < k8; p += 8) {
            const a0 = a[ai + p], a1 = a[ai + p + 1], a2 = a[ai + p + 2], a3 = a[ai + p + 3];
            const a4 = a[ai + p + 4], a5 = a[ai + p + 5], a6 = a[ai + p + 6], a7 = a[ai + p + 7];
            const b0 = p * m, b1 = b0 + m, b2 = b1 + m, b3 = b2 + m, b4 = b3 + m, b5 = b4 + m, b6 = b5 + m, b7 = b6 + m;
            for (let j = 0; j < m; j++) {
                out[ci + j] += a0 * b[b0 + j] + a1 * b[b1 + j] + a2 * b[b2 + j] + a3 * b[b3 + j] +
                    a4 * b[b4 + j] + a5 * b[b5 + j] + a6 * b[b6 + j] + a7 * b[b7 + j];
            }
        }
        for (let p = k8; p < k; p++) {
            const a0 = a[ai + p];
            const b0 = p * m;
            for (let j = 0; j < m; j++)
                out[ci + j] += a0 * b[b0 + j];
        }
    }
}

/** Zero-pads `channels` planes of h x w by `pad` on every side. */
export function padPlanes(x, channels, h, w, pad) {
    if (pad === 0)
        return x;
    const ph = h + 2 * pad, pw = w + 2 * pad;
    const out = new Float32Array(channels * ph * pw);
    for (let c = 0; c < channels; c++) {
        for (let y = 0; y < h; y++) {
            const from = (c * h + y) * w;
            out.set(x.subarray(from, from + w), (c * ph + y + pad) * pw + pad);
        }
    }
    return out;
}

/**
 * A convolution's output channels for the `count` kernels in `weights`
 * (count x channels x kh x kw), over the padded input `x`. `bias` holds one
 * value a kernel, or nothing.
 */
export function convolve(x, weights, bias, count, s) {
    const { channels, width, kh, kw, stride, dilation, outHeight, outWidth } = s;
    const plane = s.height * width;
    const outPlane = outHeight * outWidth;
    const out = new Float32Array(count * outPlane);
    for (let o = 0; o < count; o++) {
        const yo = o * outPlane;
        if (bias.length)
            out.fill(bias[o], yo, yo + outPlane);
        if (kh === 1 && kw === 1 && stride === 1) {
            // Four input planes a pass, as in matmul().
            const wo = o * channels;
            const c4 = channels - (channels % 4);
            for (let c = 0; c < c4; c += 4) {
                const k0 = weights[wo + c], k1 = weights[wo + c + 1], k2 = weights[wo + c + 2], k3 = weights[wo + c + 3];
                const x0 = c * plane, x1 = x0 + plane, x2 = x1 + plane, x3 = x2 + plane;
                for (let i = 0; i < plane; i++)
                    out[yo + i] += k0 * x[x0 + i] + k1 * x[x1 + i] + k2 * x[x2 + i] + k3 * x[x3 + i];
            }
            for (let c = c4; c < channels; c++) {
                const k0 = weights[wo + c];
                const x0 = c * plane;
                for (let i = 0; i < plane; i++)
                    out[yo + i] += k0 * x[x0 + i];
            }
            continue;
        }
        for (let c = 0; c < channels; c++) {
            const xo = c * plane;
            const wo = (o * channels + c) * kh * kw;
            if (kh === 3 && kw === 3 && stride === 1) {
                // All nine taps a pass, so each output pixel is loaded and stored once a channel.
                const k0 = weights[wo], k1 = weights[wo + 1], k2 = weights[wo + 2];
                const k3 = weights[wo + 3], k4 = weights[wo + 4], k5 = weights[wo + 5];
                const k6 = weights[wo + 6], k7 = weights[wo + 7], k8 = weights[wo + 8];
                const d = dilation, d2 = 2 * dilation;
                for (let r = 0; r < outHeight; r++) {
                    const a = xo + r * width, b = a + d * width, e = b + d * width;
                    const yi = yo + r * outWidth;
                    for (let q = 0; q < outWidth; q++) {
                        out[yi + q] += k0 * x[a + q] + k1 * x[a + q + d] + k2 * x[a + q + d2] +
                            k3 * x[b + q] + k4 * x[b + q + d] + k5 * x[b + q + d2] +
                            k6 * x[e + q] + k7 * x[e + q + d] + k8 * x[e + q + d2];
                    }
                }
                continue;
            }
            for (let ky = 0; ky < kh; ky++) {
                const wk = wo + ky * kw;
                for (let kx = 0; kx < kw; kx++) {
                    const k = weights[wk + kx];
                    for (let r = 0; r < outHeight; r++) {
                        const xi = xo + (r * stride + ky * dilation) * width + kx * dilation;
                        const yi = yo + r * outWidth;
                        for (let q = 0; q < outWidth; q++)
                            out[yi + q] += k * x[xi + q * stride];
                    }
                }
            }
        }
    }
    return out;
}

export const localKernels = {
    matmulAll(jobs) {
        for (const j of jobs)
            matmul(j.a, j.b, j.n, j.k, j.m, j.out, j.offset);
    },
    convolveAll: convolve,
};
