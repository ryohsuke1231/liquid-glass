// Runs an ONNX graph node by node, for the operators the wallpaper models
// use. One image at a time: the batch size is 1 throughout.
import { type Kernels, type MatmulJob, padPlanes } from './kernels.js';
import type { Attribute, Model, Node, Tensor, TensorData } from './onnx.js';

function count(dims: number[]): number {
  let n = 1;
  for (const d of dims) n *= d;
  return n;
}

function floats(t: Tensor): Float32Array {
  return t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
}

function intTensor(values: number[], dims = [values.length]): Tensor {
  return { dims, data: Float64Array.from(values), int: true };
}

function ints(node: Node, name: string, fallback: number[]): number[] {
  const value = node.attributes[name];
  return Array.isArray(value) ? value : fallback;
}

function int(node: Node, name: string, fallback: number): number {
  const value = node.attributes[name];
  return typeof value === 'number' ? value : fallback;
}

function text(node: Node, name: string, fallback: string): string {
  const value = node.attributes[name];
  return typeof value === 'string' ? value : fallback;
}

// All of `values` must be the same; convolutions with different pads or strides along x and y are not used.
function same(values: number[], what: string): number {
  if (values.some(v => v !== values[0])) throw new Error(`uneven ${what} are not supported`);
  return values[0];
}

function broadcastDims(a: number[], b: number[]): number[] {
  const rank = Math.max(a.length, b.length);
  const out = new Array<number>(rank);
  for (let i = 0; i < rank; i++) {
    const da = a[i - (rank - a.length)] ?? 1;
    const db = b[i - (rank - b.length)] ?? 1;
    if (da !== db && da !== 1 && db !== 1) throw new Error(`cannot broadcast [${a}] with [${b}]`);
    out[i] = Math.max(da, db);
  }
  return out;
}

// How far `from`'s offset moves for a step along each of `to`'s axes; 0 where it is repeated.
function broadcastStrides(from: number[], to: number[]): number[] {
  const strides = new Array<number>(to.length).fill(0);
  let stride = 1;
  for (let i = from.length - 1; i >= 0; i--) {
    if (from[i] !== 1) strides[i + to.length - from.length] = stride;
    stride *= from[i];
  }
  return strides;
}

// Visits every element of a tensor of `dims` in order, with the offsets into operands whose strides are `strides`.
function walk(dims: number[], strides: number[][], visit: (i: number, offsets: number[]) => void): void {
  const rank = dims.length;
  const n = count(dims);
  const index = new Array<number>(rank).fill(0);
  const offsets = strides.map(() => 0);
  for (let i = 0; i < n; i++) {
    visit(i, offsets);
    for (let d = rank - 1; d >= 0; d--) {
      index[d]++;
      for (let s = 0; s < strides.length; s++) offsets[s] += strides[s][d];
      if (index[d] < dims[d]) break;
      for (let s = 0; s < strides.length; s++) offsets[s] -= strides[s][d] * dims[d];
      index[d] = 0;
    }
  }
}

// Whether `b`, without its leading 1s, is the tail of `a`'s dims.
function isTail(b: number[], a: number[]): boolean {
  let first = 0;
  while (first < b.length && b[first] === 1) first++;
  const tail = b.length - first;
  if (tail > a.length) return false;
  for (let i = 0; i < tail; i++) {
    if (b[first + i] !== a[a.length - tail + i]) return false;
  }
  return true;
}

function binary(a: Tensor, b: Tensor, f: (x: number, y: number) => number, kind: 'same' | 'bool' = 'same'): Tensor {
  const dims = broadcastDims(a.dims, b.dims);
  const n = count(dims);
  const isInt = !!a.int && !!b.int;
  const out: TensorData = kind === 'bool' ? new Uint8Array(n) : isInt ? new Float64Array(n) : new Float32Array(n);
  const x = a.data, y = b.data;
  if (x.length === n && y.length === n) {
    for (let i = 0; i < n; i++) out[i] = f(x[i], y[i]);
  } else if (y.length === 1) {
    const v = y[0];
    for (let i = 0; i < n; i++) out[i] = f(x[i], v);
  } else if (x.length === 1) {
    const v = x[0];
    for (let i = 0; i < n; i++) out[i] = f(v, y[i]);
  } else if (x.length === n && isTail(b.dims, a.dims)) {
    const m = y.length;
    for (let i = 0, j = 0; i < n; i++) {
      out[i] = f(x[i], y[j]);
      if (++j === m) j = 0;
    }
  } else {
    walk(dims, [broadcastStrides(a.dims, dims), broadcastStrides(b.dims, dims)], (i, at) => {
      out[i] = f(x[at[0]], y[at[1]]);
    });
  }
  return kind === 'same' && isInt ? { dims, data: out, int: true } : { dims, data: out };
}

// a + b, a - b, a * b or a / b for floats, without a call an element where the shapes allow.
function arithmetic(op: '+' | '-' | '*' | '/', a: Tensor, b: Tensor, f: (x: number, y: number) => number): Tensor {
  if ((op === '+' || op === '*') && a.data.length < b.data.length) [a, b] = [b, a];
  const x = a.data, y = b.data;
  const n = x.length, m = y.length;
  const dims = a.int || b.int ? [] : broadcastDims(a.dims, b.dims);
  const rank = a.dims.length;
  // One value of `y` for each row of `x`, as a mean along the last axis is.
  const perRow = b.dims.length === rank && b.dims[rank - 1] === 1 && b.dims.every((d, i) => i === rank - 1 || d === a.dims[i]);
  if (count(dims) !== n || !(m === n || m === 1 || perRow || isTail(b.dims, a.dims))) return binary(a, b, f);
  const out = new Float32Array(n);
  if (perRow && m !== n) {
    const width = n / m;
    for (let row = 0, start = 0; row < m; row++, start += width) {
      const v = y[row];
      if (op === '+') for (let i = start; i < start + width; i++) out[i] = x[i] + v;
      else if (op === '-') for (let i = start; i < start + width; i++) out[i] = x[i] - v;
      else if (op === '*') for (let i = start; i < start + width; i++) out[i] = x[i] * v;
      else for (let i = start; i < start + width; i++) out[i] = x[i] / v;
    }
  } else if (m === 1) {
    const v = y[0];
    if (op === '+') for (let i = 0; i < n; i++) out[i] = x[i] + v;
    else if (op === '-') for (let i = 0; i < n; i++) out[i] = x[i] - v;
    else if (op === '*') for (let i = 0; i < n; i++) out[i] = x[i] * v;
    else for (let i = 0; i < n; i++) out[i] = x[i] / v;
  } else {
    // `y` repeats every m elements; for the same shape m is n.
    for (let start = 0; start < n; start += m) {
      if (op === '+') for (let i = 0; i < m; i++) out[start + i] = x[start + i] + y[i];
      else if (op === '-') for (let i = 0; i < m; i++) out[start + i] = x[start + i] - y[i];
      else if (op === '*') for (let i = 0; i < m; i++) out[start + i] = x[start + i] * y[i];
      else for (let i = 0; i < m; i++) out[start + i] = x[start + i] / y[i];
    }
  }
  return { dims, data: out };
}

function map(t: Tensor, f: (x: number) => number): Tensor {
  const x = t.data;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = f(x[i]);
  return { dims: t.dims, data: out };
}

function like(t: Tensor, n: number): TensorData {
  return new (t.data.constructor as new (n: number) => TensorData)(n);
}

function expand(t: Tensor, dims: number[]): Tensor {
  const out = like(t, count(dims));
  const x = t.data;
  walk(dims, [broadcastStrides(t.dims, dims)], (i, at) => {
    out[i] = x[at[0]];
  });
  return { dims, data: out, int: t.int };
}

function transpose(t: Tensor, perm: number[]): Tensor {
  const rank = t.dims.length;
  const from = new Array<number>(rank);
  let stride = 1;
  for (let i = rank - 1; i >= 0; i--) {
    from[i] = stride;
    stride *= t.dims[i];
  }
  const dims = perm.map(p => t.dims[p]);
  const out = like(t, t.data.length);
  const x = t.data;
  walk(dims, [perm.map(p => from[p])], (i, at) => {
    out[i] = x[at[0]];
  });
  return { dims, data: out, int: t.int };
}

function concat(tensors: Tensor[], axis: number): Tensor {
  const first = tensors[0];
  if (axis < 0) axis += first.dims.length;
  const dims = [...first.dims];
  dims[axis] = tensors.reduce((sum, t) => sum + t.dims[axis], 0);
  const outer = count(first.dims.slice(0, axis));
  const out = like(first, count(dims));
  let at = 0;
  for (let o = 0; o < outer; o++) {
    for (const t of tensors) {
      const inner = t.data.length / outer;
      out.set(t.data.subarray(o * inner, (o + 1) * inner) as any, at);
      at += inner;
    }
  }
  return { dims, data: out, int: first.int };
}

function sliceAxis(t: Tensor, axis: number, start: number, end: number, step: number): Tensor {
  if (step < 1) throw new Error('slices going backwards are not supported');
  const dim = t.dims[axis];
  const clamp = (v: number) => Math.min(Math.max(v < 0 ? v + dim : v, 0), dim);
  start = clamp(start);
  end = clamp(end);
  const kept = Math.max(Math.ceil((end - start) / step), 0);
  const dims = [...t.dims];
  dims[axis] = kept;
  const inner = count(t.dims.slice(axis + 1));
  const outer = count(t.dims.slice(0, axis));
  const out = like(t, count(dims));
  let at = 0;
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < kept; i++) {
      const from = (o * dim + start + i * step) * inner;
      out.set(t.data.subarray(from, from + inner) as any, at);
      at += inner;
    }
  }
  return { dims, data: out, int: t.int };
}

function gather(t: Tensor, indices: Tensor, axis: number): Tensor {
  if (axis < 0) axis += t.dims.length;
  const dim = t.dims[axis];
  const inner = count(t.dims.slice(axis + 1));
  const outer = count(t.dims.slice(0, axis));
  const picked = indices.data.length;
  const dims = [...t.dims.slice(0, axis), ...indices.dims, ...t.dims.slice(axis + 1)];
  const out = like(t, count(dims));
  let at = 0;
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < picked; i++) {
      let index = indices.data[i];
      if (index < 0) index += dim;
      const from = (o * dim + index) * inner;
      out.set(t.data.subarray(from, from + inner) as any, at);
      at += inner;
    }
  }
  return { dims, data: out, int: t.int };
}

function reshape(t: Tensor, shape: number[]): Tensor {
  const dims = shape.map((d, i) => d === 0 ? t.dims[i] : d);
  const unknown = dims.indexOf(-1);
  if (unknown >= 0) {
    dims[unknown] = 1;
    dims[unknown] = t.data.length / count(dims);
  }
  return { dims, data: t.data, int: t.int };
}

function cast(t: Tensor, to: number): Tensor {
  // 1, 10 and 11 are the float types; all of them are held as 32-bit floats.
  if (to === 1 || to === 10 || to === 11) return { dims: t.dims, data: floats(t) };
  if (to === 6 || to === 7) return { dims: t.dims, data: Float64Array.from(t.data, Math.trunc), int: true };
  if (to === 2 || to === 9) return { dims: t.dims, data: Uint8Array.from(t.data, v => to === 9 ? Number(v !== 0) : v) };
  throw new Error(`unsupported cast to ${to}`);
}

// Abramowitz and Stegun 7.1.26, within 1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-x * x));
}

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function softmax(t: Tensor): Tensor {
  const width = t.dims[t.dims.length - 1];
  const x = t.data;
  const out = new Float32Array(x.length);
  for (let row = 0; row < x.length; row += width) {
    let max = -Infinity;
    for (let i = 0; i < width; i++) max = Math.max(max, x[row + i]);
    let sum = 0;
    for (let i = 0; i < width; i++) sum += out[row + i] = Math.exp(x[row + i] - max);
    for (let i = 0; i < width; i++) out[row + i] /= sum;
  }
  return { dims: t.dims, data: out };
}

function reduceMeanLast(t: Tensor): Tensor {
  const width = t.dims[t.dims.length - 1];
  const x = t.data;
  const out = new Float32Array(x.length / width);
  for (let row = 0; row < out.length; row++) {
    let sum = 0;
    for (let i = 0; i < width; i++) sum += x[row * width + i];
    out[row] = sum / width;
  }
  return { dims: [...t.dims.slice(0, -1), 1], data: out };
}

function conv(x: Tensor, weights: Tensor, bias: Float32Array, node: Node, kernels: Kernels): Tensor {
  const [, channels, h, w] = x.dims;
  const [filters, , kh, kw] = weights.dims;
  if (int(node, 'group', 1) !== 1) throw new Error('grouped convolutions are not supported');
  const pad = same(ints(node, 'pads', [0]), 'pads');
  const stride = same(ints(node, 'strides', [1]), 'strides');
  const dilation = same(ints(node, 'dilations', [1]), 'dilations');
  const outHeight = Math.floor((h + 2 * pad - dilation * (kh - 1) - 1) / stride) + 1;
  const outWidth = Math.floor((w + 2 * pad - dilation * (kw - 1) - 1) / stride) + 1;
  const data = kernels.convolveAll(padPlanes(floats(x), channels, h, w, pad), floats(weights), bias, filters, {
    channels, height: h + 2 * pad, width: w + 2 * pad, kh, kw, stride, dilation, outHeight, outWidth,
  });
  return { dims: [1, filters, outHeight, outWidth], data };
}

// Each input pixel adds its value times the kernel to a block of the output; the kernels here never overlap.
function convTranspose(x: Tensor, weights: Tensor, bias: Tensor | undefined, node: Node): Tensor {
  const [, channels, h, w] = x.dims;
  const [, filters, kh, kw] = weights.dims;
  const stride = same(ints(node, 'strides', [1]), 'strides');
  if (same(ints(node, 'pads', [0]), 'pads') !== 0 || int(node, 'group', 1) !== 1)
    throw new Error('padded or grouped transposed convolutions are not supported');
  const outHeight = (h - 1) * stride + kh, outWidth = (w - 1) * stride + kw;
  const out = new Float32Array(filters * outHeight * outWidth);
  const xs = x.data, ws = weights.data;
  for (let o = 0; o < filters; o++) {
    const yo = o * outHeight * outWidth;
    if (bias) out.fill(bias.data[o], yo, yo + outHeight * outWidth);
    for (let c = 0; c < channels; c++) {
      const wo = (c * filters + o) * kh * kw;
      for (let ky = 0; ky < kh; ky++) {
        for (let kx = 0; kx < kw; kx++) {
          const k = ws[wo + ky * kw + kx];
          for (let r = 0; r < h; r++) {
            const xi = (c * h + r) * w;
            const yi = yo + (r * stride + ky) * outWidth + kx;
            for (let q = 0; q < w; q++) out[yi + q * stride] += k * xs[xi + q];
          }
        }
      }
    }
  }
  return { dims: [1, filters, outHeight, outWidth], data: out };
}

function maxPool(x: Tensor, node: Node): Tensor {
  const [, channels, h, w] = x.dims;
  const k = same(ints(node, 'kernel_shape', [2]), 'kernels');
  const stride = same(ints(node, 'strides', [1]), 'strides');
  if (same(ints(node, 'pads', [0]), 'pads') !== 0) throw new Error('padded pooling is not supported');
  const round = int(node, 'ceil_mode', 0) ? Math.ceil : Math.floor;
  const outHeight = round((h - k) / stride) + 1, outWidth = round((w - k) / stride) + 1;
  const out = new Float32Array(channels * outHeight * outWidth);
  const xs = x.data;
  for (let c = 0; c < channels; c++) {
    for (let r = 0; r < outHeight; r++) {
      const y1 = Math.min(r * stride + k, h);
      for (let q = 0; q < outWidth; q++) {
        const x1 = Math.min(q * stride + k, w);
        let max = -Infinity;
        for (let y = r * stride; y < y1; y++) {
          const row = (c * h + y) * w;
          for (let i = q * stride; i < x1; i++) max = Math.max(max, xs[row + i]);
        }
        out[(c * outHeight + r) * outWidth + q] = max;
      }
    }
  }
  return { dims: [1, channels, outHeight, outWidth], data: out };
}

interface Taps {
  // For each output position, `width` source positions and their weights.
  width: number;
  index: Int32Array;
  weight: Float32Array;
}

function resizeTaps(from: number, to: number, scale: number, mode: string, transform: string): Taps {
  const width = mode === 'cubic' ? 4 : mode === 'linear' ? 2 : 1;
  const index = new Int32Array(to * width);
  const weight = new Float32Array(to * width);
  const clamp = (i: number) => Math.min(Math.max(i, 0), from - 1);
  for (let o = 0; o < to; o++) {
    let x: number;
    if (transform === 'align_corners') x = to > 1 ? o * (from - 1) / (to - 1) : 0;
    else if (transform === 'asymmetric') x = o / scale;
    else if (transform === 'pytorch_half_pixel' && to <= 1) x = 0;
    else x = (o + 0.5) / scale - 0.5;
    const at = o * width;
    if (mode === 'cubic') {
      const base = Math.floor(x);
      const t = x - base;
      const a = -0.75;
      const w0 = ((a * (t + 1) - 5 * a) * (t + 1) + 8 * a) * (t + 1) - 4 * a;
      const w1 = ((a + 2) * t - (a + 3)) * t * t + 1;
      const w2 = ((a + 2) * (1 - t) - (a + 3)) * (1 - t) * (1 - t) + 1;
      weight.set([w0, w1, w2, 1 - w0 - w1 - w2], at);
      for (let i = 0; i < 4; i++) index[at + i] = clamp(base - 1 + i);
    } else if (mode === 'linear') {
      x = Math.min(Math.max(x, 0), from - 1);
      const base = Math.floor(x);
      index[at] = base;
      index[at + 1] = clamp(base + 1);
      weight[at + 1] = x - base;
      weight[at] = 1 - weight[at + 1];
    } else {
      index[at] = clamp(Math.floor(x));
      weight[at] = 1;
    }
  }
  return { width, index, weight };
}

// Resizes the last two axes, one after the other.
function resize(x: Tensor, scales: Tensor | undefined, sizes: Tensor | undefined, node: Node): Tensor {
  const [n, channels, h, w] = x.dims;
  let outHeight: number, outWidth: number, scaleY: number, scaleX: number;
  if (sizes && sizes.data.length) {
    outHeight = sizes.data[2];
    outWidth = sizes.data[3];
    scaleY = outHeight / h;
    scaleX = outWidth / w;
  } else if (scales && scales.data.length) {
    scaleY = scales.data[2];
    scaleX = scales.data[3];
    outHeight = Math.floor(h * scaleY);
    outWidth = Math.floor(w * scaleX);
  } else {
    throw new Error('a resize without a size');
  }
  const mode = text(node, 'mode', 'nearest');
  const transform = text(node, 'coordinate_transformation_mode', 'half_pixel');
  const tx = resizeTaps(w, outWidth, scaleX, mode, transform);
  const ty = resizeTaps(h, outHeight, scaleY, mode, transform);
  const planes = n * channels;
  const xs = x.data;
  const wide = new Float32Array(planes * h * outWidth);
  for (let row = 0; row < planes * h; row++) {
    const from = row * w, to = row * outWidth;
    for (let o = 0; o < outWidth; o++) {
      let sum = 0;
      for (let t = o * tx.width; t < (o + 1) * tx.width; t++) sum += tx.weight[t] * xs[from + tx.index[t]];
      wide[to + o] = sum;
    }
  }
  const out = new Float32Array(planes * outHeight * outWidth);
  for (let p = 0; p < planes; p++) {
    for (let o = 0; o < outHeight; o++) {
      const to = (p * outHeight + o) * outWidth;
      for (let t = o * ty.width; t < (o + 1) * ty.width; t++) {
        const k = ty.weight[t];
        const from = (p * h + ty.index[t]) * outWidth;
        for (let i = 0; i < outWidth; i++) out[to + i] += k * wide[from + i];
      }
    }
  }
  return { dims: [n, channels, outHeight, outWidth], data: out };
}

function matMul(a: Tensor, b: Tensor, kernels: Kernels): Tensor {
  const n = a.dims[a.dims.length - 2], k = a.dims[a.dims.length - 1];
  const m = b.dims[b.dims.length - 1];
  const batch = count(a.dims.slice(0, -2));
  const batchB = count(b.dims.slice(0, -2));
  if (b.dims[b.dims.length - 2] !== k || (batchB !== 1 && batchB !== batch)) throw new Error(`cannot multiply [${a.dims}] by [${b.dims}]`);
  const x = floats(a), y = floats(b);
  const out = new Float32Array(batch * n * m);
  const jobs: MatmulJob[] = [];
  for (let i = 0; i < batch; i++) {
    jobs.push({
      a: x.subarray(i * n * k, (i + 1) * n * k),
      b: batchB === 1 ? y : y.subarray(i * k * m, (i + 1) * k * m),
      n, k, m, out, offset: i * n * m,
    });
  }
  kernels.matmulAll(jobs);
  return { dims: [...a.dims.slice(0, -1), m], data: out };
}

// The quantized copy of x that a ConvInteger takes, with its scale and zero point.
function quantize(x: Tensor): Tensor[] {
  let min = 0, max = 0;
  for (const v of x.data) {
    if (v < min) min = v;
    else if (v > max) max = v;
  }
  const scale = (max - min) / 255 || 1;
  const zero = Math.min(Math.max(roundHalfEven(-min / scale), 0), 255);
  const out = new Float32Array(x.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(Math.max(roundHalfEven(x.data[i] / scale) + zero, 0), 255);
  return [{ dims: x.dims, data: out }, { dims: [], data: Float32Array.of(scale) }, { dims: [], data: Uint8Array.of(zero) }];
}

function shifted(t: Tensor, zero: Tensor | undefined): Tensor {
  const z = zero ? zero.data[0] : 0;
  const out = new Float32Array(t.data.length);
  for (let i = 0; i < out.length; i++) out[i] = t.data[i] - z;
  return { dims: t.dims, data: out };
}

function axesOf(node: Node, input: Tensor | undefined): number[] {
  return input ? Array.from(input.data) : ints(node, 'axes', []);
}

function evaluate(node: Node, inputs: (Tensor | undefined)[], kernels: Kernels): Tensor[] {
  const [a, b, c] = inputs as Tensor[];
  switch (node.op) {
    case 'Add': return [arithmetic('+', a, b, (x, y) => x + y)];
    case 'Sub': return [arithmetic('-', a, b, (x, y) => x - y)];
    case 'Mul': return [arithmetic('*', a, b, (x, y) => x * y)];
    case 'Div': return [a.int && b.int ? binary(a, b, (x, y) => Math.trunc(x / y)) : arithmetic('/', a, b, (x, y) => x / y)];
    case 'Pow': return [b.data.length === 1 && b.data[0] === 2 ? map(a, x => x * x) : binary(a, b, Math.pow)];
    case 'Equal': return [binary(a, b, (x, y) => Number(x === y), 'bool')];
    case 'Sqrt': return [map(a, Math.sqrt)];
    case 'Erf': return [map(a, erf)];
    case 'Relu': return [map(a, x => x > 0 ? x : 0)];
    case 'Sigmoid': return [map(a, x => 1 / (1 + Math.exp(-x)))];
    case 'Softmax': {
      const axis = int(node, 'axis', -1);
      if (axis !== -1 && axis !== a.dims.length - 1) throw new Error('softmax along an inner axis is not supported');
      return [softmax(a)];
    }
    case 'ReduceMean': {
      const axes = ints(node, 'axes', []);
      if (axes.length !== 1 || (axes[0] !== -1 && axes[0] !== a.dims.length - 1) || !int(node, 'keepdims', 1))
        throw new Error('only the mean along the last axis is supported');
      return [reduceMeanLast(a)];
    }
    case 'MatMul': return [matMul(a, b, kernels)];
    case 'Conv': return [conv(a, b, c ? floats(c) : new Float32Array(0), node, kernels)];
    case 'ConvInteger': return [conv(shifted(a, inputs[2]), shifted(b, inputs[3]), new Float32Array(0), node, kernels)];
    case 'DynamicQuantizeLinear': return quantize(a);
    case 'ConvTranspose': return [convTranspose(a, b, c, node)];
    case 'MaxPool': return [maxPool(a, node)];
    case 'Resize': return [resize(a, inputs[2], inputs[3], node)];
    case 'Concat': return [concat(inputs as Tensor[], int(node, 'axis', 0))];
    case 'Transpose': return [transpose(a, ints(node, 'perm', a.dims.map((_d, i) => a.dims.length - 1 - i)))];
    case 'Reshape': return [reshape(a, Array.from(b.data))];
    case 'Shape': return [intTensor(a.dims)];
    case 'Cast': return [cast(a, int(node, 'to', 1))];
    case 'Gather': return [gather(a, b, int(node, 'axis', 0))];
    case 'Expand': return [expand(a, broadcastDims(a.dims, Array.from(b.data)))];
    case 'Where': {
      const dims = broadcastDims(broadcastDims(a.dims, b.dims), c.dims);
      const [cond, x, y] = [a, b, c].map(t => expand(t, dims));
      const out = like(x, x.data.length);
      for (let i = 0; i < out.length; i++) out[i] = cond.data[i] ? x.data[i] : y.data[i];
      return [{ dims, data: out, int: x.int }];
    }
    case 'Unsqueeze': {
      const axes = axesOf(node, b);
      const rank = a.dims.length + axes.length;
      const at = new Set(axes.map(axis => axis < 0 ? axis + rank : axis));
      const dims: number[] = [];
      for (let i = 0, from = 0; i < rank; i++) dims.push(at.has(i) ? 1 : a.dims[from++]);
      return [{ dims, data: a.data, int: a.int }];
    }
    case 'Squeeze': {
      const axes = axesOf(node, b).map(axis => axis < 0 ? axis + a.dims.length : axis);
      const dims = a.dims.filter((d, i) => axes.length ? !axes.includes(i) : d !== 1);
      return [{ dims, data: a.data, int: a.int }];
    }
    case 'Slice': {
      const starts = b.data, ends = c.data;
      const axes = inputs[3] ? Array.from(inputs[3].data) : Array.from(starts, (_v, i) => i);
      const steps = inputs[4] ? inputs[4].data : null;
      let out = a;
      axes.forEach((axis, i) => {
        out = sliceAxis(out, axis < 0 ? axis + a.dims.length : axis, starts[i], ends[i], steps ? steps[i] : 1);
      });
      return [out];
    }
    default:
      throw new Error(`unsupported operator ${node.op}`);
  }
}

// The operators nearly all the time goes into; progress is counted in them.
const HEAVY = new Set(['MatMul', 'Conv', 'ConvInteger']);

/**
 * Runs `model` on `feeds` (its inputs by name) and returns its outputs by
 * name. `progress` is told how far (0 to 1) the run has come, and `spent`
 * collects the milliseconds each kind of operator took.
 */
export function runModel(model: Model, feeds: Record<string, Tensor>, kernels: Kernels,
  progress?: (fraction: number) => void, spent?: Record<string, number>): Record<string, Tensor> {
  const values = new Map<string, Tensor>(Object.entries(feeds));
  // How many nodes still read each value; it is dropped after the last one.
  const readers = new Map<string, number>();
  for (const node of model.nodes) {
    for (const name of node.inputs) readers.set(name, (readers.get(name) ?? 0) + 1);
  }
  for (const name of model.outputs) readers.set(name, Infinity);
  const heavy = model.nodes.filter(node => HEAVY.has(node.op)).length;
  let done = 0;
  for (const node of model.nodes) {
    const inputs = node.inputs.map(name => name ? values.get(name) ?? model.initializer(name) : undefined);
    const constant = node.op === 'Constant' ? node.attributes.value as Attribute : null;
    const started = spent ? Date.now() : 0;
    const outputs = constant ? [constant as Tensor] : evaluate(node, inputs, kernels);
    if (spent) spent[node.op] = (spent[node.op] ?? 0) + Date.now() - started;
    if (progress && HEAVY.has(node.op)) progress(++done / heavy);
    node.outputs.forEach((name, i) => {
      if (name && readers.has(name)) values.set(name, outputs[i]);
    });
    for (const name of node.inputs) {
      const left = (readers.get(name) ?? 0) - 1;
      readers.set(name, left);
      if (left === 0) {
        values.delete(name);
        model.release(name);
      }
    }
  }
  const out: Record<string, Tensor> = {};
  for (const name of model.outputs) out[name] = values.get(name)!;
  return out;
}
