const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const depth = loadModule(path.join(dist, 'desktop/depthMap.js'), {});
const kernels = loadModule(path.join(dist, 'inference/kernels.js'), {});
const runner = loadModule(path.join(dist, 'inference/runner.js'), {});
const onnx = loadModule(path.join(dist, 'inference/onnx.js'), {});

// A map of w x h whose nearness and subject come from functions of (x, y), each 0..1.
function mapOf(w, h, near, subject = () => 0) {
  const d = new Float32Array(w * h), s = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    d[y * w + x] = near(x, y);
    s[y * w + x] = subject(x, y);
  }
  return depth.packDepthMap(d, s, w, h);
}

test('a picture lands on the monitor as the shell places it for each style', () => {
  assert.deepEqual(depth.pictureRect('zoom', 4000, 4000, 1920, 1080), [0, -420, 1920, 1920]);
  assert.deepEqual(depth.pictureRect('scaled', 4000, 4000, 1920, 1080), [420, 0, 1080, 1080]);
  assert.deepEqual(depth.pictureRect('stretched', 4000, 4000, 1920, 1080), [0, 0, 1920, 1080]);
  assert.deepEqual(depth.pictureRect('centered', 800, 600, 1920, 1080), [560, 240, 800, 600]);
});

test('the map and the depth model take the monitor\'s shape', () => {
  assert.deepEqual(depth.mapSize(3840, 2160), [1280, 720]);
  assert.deepEqual(depth.mapSize(1080, 1920), [720, 1280]);
  assert.deepEqual(depth.modelSize(1280, 720, 518, 14), [518, 294]);
  assert.deepEqual(depth.modelSize(720, 1280, 518, 14), [294, 518]);
});

test('a depth map survives its cache file, and other bytes are refused', () => {
  const map = mapOf(40, 30, (x, y) => x / 40, (x, y) => y / 30);
  const read = depth.decodeDepthMap(depth.encodeDepthMap(map));
  assert.equal(read.width, 40);
  assert.equal(read.height, 30);
  assert.deepEqual([...read.pixels], [...map.pixels]);
  assert.equal(depth.decodeDepthMap(new Uint8Array(20)), null);
  assert.equal(depth.decodeDepthMap(depth.encodeDepthMap(map).subarray(0, 100)), null);
});

test('a clock across a ridge hides behind it, one on a slope or in the open sky behind nothing', () => {
  // Sky above y = 300, a mountain coming nearer below it.
  const ridge = mapOf(1280, 720, (x, y) => y < 300 ? 0 : 0.3 + (y - 300) / 1000);
  const across = depth.chooseOcclusion(ridge, [400, 200, 480, 200], false);
  assert.equal(across.subject, false);
  assert.ok(across.threshold > 0.01 && across.threshold < 0.3, String(across.threshold));
  assert.ok(depth.chooseOcclusion(ridge, [400, 20, 480, 200], false).threshold > 1, 'in the sky');
  assert.ok(depth.chooseOcclusion(ridge, [400, 400, 480, 200], false).threshold > 1, 'on the mountain');
  const slope = mapOf(1280, 720, (x, y) => y / 720);
  assert.ok(depth.chooseOcclusion(slope, [400, 200, 480, 200], false).threshold > 1, 'a slope has no edge');
});

test('a firm subject is taken where it covers a part of the clock, a faint guess is not a subject', () => {
  const disc = (x, y) => Math.hypot(x - 640, y - 400) < 150 ? 1 : 0;
  const firm = mapOf(1280, 720, () => 0.5, disc);
  assert.equal(depth.hasSubject(firm), true);
  assert.deepEqual(depth.chooseOcclusion(firm, [400, 200, 480, 200], true), { threshold: 2, subject: true });
  assert.equal(depth.chooseOcclusion(firm, [0, 0, 300, 150], true).subject, false, 'away from the subject');
  assert.deepEqual(depth.chooseOcclusion(firm, [560, 340, 160, 120], true), depth.NO_OCCLUSION, 'the subject would hide all of it');
  const faint = mapOf(1280, 720, () => 0.5, (x, y) => disc(x, y) * 0.3);
  assert.equal(depth.hasSubject(faint), false);
});

test('the guided filter moves a soft edge onto the picture\'s edge and leaves flat parts alone', () => {
  const w = 64, h = 16;
  const guide = new Float32Array(w * h), plane = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    guide[y * w + x] = x < 32 ? 0.1 : 0.9;
    // The same edge three pixels off and eight wide.
    plane[y * w + x] = Math.min(Math.max((x - 31) / 8, 0), 1);
  }
  const out = depth.guidedFilter(plane, guide, w, h, 6, 4e-4);
  assert.ok(out[8 * w + 31] < 0.2 && out[8 * w + 32] > 0.4, `${out[8 * w + 31]} ${out[8 * w + 32]}`);
  assert.ok(out[8 * w + 5] < 0.02 && out[8 * w + 60] > 0.98);
});

test('the unrolled matrix product and convolution match the plain definitions', () => {
  const rnd = n => Float32Array.from({ length: n }, (_v, i) => Math.sin(i * 12.9898) * 0.5);
  const [n, k, m] = [5, 19, 7];
  const a = rnd(n * k), b = rnd(k * m), out = new Float32Array(n * m);
  kernels.matmul(a, b, n, k, m, out);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let sum = 0;
    for (let p = 0; p < k; p++) sum += a[i * k + p] * b[p * m + j];
    assert.ok(Math.abs(out[i * m + j] - sum) < 1e-5);
  }
  for (const [kh, stride, dilation, pad] of [[3, 1, 1, 1], [3, 1, 2, 2], [1, 1, 1, 0], [2, 2, 1, 0]]) {
    const [c, h, w, filters] = [5, 9, 8, 3];
    const x = rnd(c * h * w), weights = rnd(filters * c * kh * kh), bias = rnd(filters);
    const oh = Math.floor((h + 2 * pad - dilation * (kh - 1) - 1) / stride) + 1, ow = Math.floor((w + 2 * pad - dilation * (kh - 1) - 1) / stride) + 1;
    const got = kernels.convolve(kernels.padPlanes(x, c, h, w, pad), weights, bias, filters,
      { channels: c, height: h + 2 * pad, width: w + 2 * pad, kh, kw: kh, stride, dilation, outHeight: oh, outWidth: ow });
    for (let o = 0; o < filters; o++) for (let r = 0; r < oh; r++) for (let q = 0; q < ow; q++) {
      let sum = bias[o];
      for (let ch = 0; ch < c; ch++) for (let ky = 0; ky < kh; ky++) for (let kx = 0; kx < kh; kx++) {
        const y = r * stride - pad + ky * dilation, xx = q * stride - pad + kx * dilation;
        if (y >= 0 && y < h && xx >= 0 && xx < w) sum += x[(ch * h + y) * w + xx] * weights[((o * c + ch) * kh + ky) * kh + kx];
      }
      assert.ok(Math.abs(got[(o * oh + r) * ow + q] - sum) < 1e-5, `kernel ${kh} stride ${stride} dilation ${dilation}`);
    }
  }
});

// A protobuf field: a varint key, then the payload with its length for bytes.
function varint(v) {
  const out = [];
  for (; v > 127; v = Math.floor(v / 128)) out.push((v % 128) | 128);
  return [...out, v];
}
const bytes = (field, payload) => [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
const number = (field, v) => [...varint(field * 8), ...varint(v)];
const string = (field, s) => bytes(field, [...Buffer.from(s)]);

test('a model file is read and run: a graph of MatMul, Add and Relu over a stored weight', () => {
  const weight = new Uint8Array(new Float32Array([1, -2, 3, 4]).buffer);
  const tensor = [...number(1, 2), ...number(1, 2), ...number(2, 1), ...string(8, 'w'), ...bytes(9, [...weight])];
  const node = (op, inputs, output) => [...inputs.flatMap(i => string(1, i)), ...string(2, output), ...string(4, op)];
  const graph = [
    ...bytes(1, node('MatMul', ['x', 'w'], 'p')), ...bytes(1, node('Add', ['p', 'x'], 's')), ...bytes(1, node('Relu', ['s'], 'y')),
    ...bytes(5, tensor), ...bytes(11, string(1, 'x')), ...bytes(11, string(1, 'w')), ...bytes(12, string(1, 'y')),
  ];
  const model = onnx.parseModel(Uint8Array.from([...number(1, 8), ...bytes(7, graph)]));
  assert.deepEqual(model.inputs, ['x']);
  assert.deepEqual(model.nodes.map(n => n.op), ['MatMul', 'Add', 'Relu']);
  const out = runner.runModel(model, { x: { dims: [1, 2], data: new Float32Array([1, 1]) } }, kernels.localKernels);
  // [1, 1] x [[1, -2], [3, 4]] = [4, 2]; plus x = [5, 3].
  assert.deepEqual([...out.y.data], [5, 3]);
  const negative = runner.runModel(model, { x: { dims: [1, 2], data: new Float32Array([-1, 0]) } }, kernels.localKernels);
  assert.deepEqual([...negative.y.data], [0, 2]);
});
