const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { gpuFixture, dist } = require('./helpers/gpu.cjs');

test('uniform state buffers before compilation and skips unchanged scalar and array writes', () => {
  const { UniformState } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const state = new UniformState();
  const writes = [], locations = [];
  const pipeline = { get_uniform_location: name => { locations.push(name); return name; },
    set_uniform_float: (...args) => writes.push(structuredClone(args)),
    set_uniform_1f: (loc, value) => writes.push([loc, 1, 1, [value]]) };
  state.set('radius', 5);
  const regions = [10, 20];
  state.setArray('regions', regions);
  assert.equal(state.takeDirty(), true);
  assert.equal(state.takeDirty(), false);
  state.attach(pipeline);
  assert.equal(writes.length, 2);
  state.set('radius', 5);
  state.setArray('regions', [10, 20]);
  state.flush();
  assert.equal(writes.length, 2);
  assert.equal(state.takeDirty(), false);
  regions[0] = 99;
  state.setArray('regions', regions);
  assert.deepEqual(writes.at(-1), ['regions', 1, 2, [99, 20]]);
  assert.equal(locations.length, 2, 'uniform locations are cached');
  state.attach(null);
  state.set('radius', 7);
  state.attach(pipeline);
  assert.equal(locations.length, 4, 'new pipeline cannot reuse old locations');
  assert.equal(writes.length, 5, 'new pipeline receives all buffered parameters');
  state.clear();
  assert.equal(state.values.size, 0);
  assert.equal(state.takeDirty(), false);
});

test('geometry clipping remains conservative for shadows, blur reach and multiple regions', () => {
  const { GlassGeometry } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const uniforms = new Map(Object.entries({ resolution_x: 1920, resolution_y: 1080,
    padding: 10, shadow_radius: 20, shadow_max_radius: 30, shadow_intensity: 1,
    edge_smoothing: 2, displacement_scale: 0 }));
  const geometry = new GlassGeometry(uniforms);
  geometry.rect = [500, 400, 300, 120];
  const composite = geometry.compositeRect();
  assert.deepEqual(composite, [486, 386, 328, 148]);
  const blur = geometry.blurRect();
  assert.equal(blur[2] % GlassGeometry.BLUR_RECT_QUANTUM, 0);
  assert.equal(blur[3] % GlassGeometry.BLUR_RECT_QUANTUM, 0);
  geometry.multiRegion = true;
  geometry.regions = [[500, 400, 100, 80], [800, 500, 80, 100]];
  assert.deepEqual(geometry.compositeRect(), [506, 406, 368, 188], 'multi-region glass does not paint a drop shadow');
  uniforms.set('debug_view', 1);
  assert.equal(geometry.compositeRect(), null);
  geometry.blurEnabled = false;
  assert.equal(geometry.blurRect(), null);
});

test('refraction margins cover the shader sampling reach on both axes and nothing more', () => {
  const { GlassGeometry } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const reach = GlassGeometry.EDGE_LENS_REACH + GlassGeometry.EDGE_FOOTPRINT_SPREAD;
  const margins = extra => {
    const uniforms = new Map(Object.entries({ resolution_x: 3840, resolution_y: 2160,
      padding: 0, shadow_radius: 0, shadow_max_radius: 0, shadow_intensity: 0,
      edge_smoothing: 0.5, displacement_scale: 10.5, ior: 2.4, chroma_strength: 0, ...extra }));
    const geometry = new GlassGeometry(uniforms);
    geometry.rect = [1800, 1000, 120, 80];
    const blur = geometry.blurRect();
    return { blurX: 1800 - blur[0], blurY: 1000 - blur[1], blurW: blur[2], blurH: blur[3] };
  };
  const base = margins({});
  assert.ok(base.blurX >= reach && base.blurY >= reach, `blur margin ${base.blurX}x${base.blurY} covers ${reach}`);
  assert.deepEqual(margins({ ior: 1.2, displacement_scale: 200 }), base, 'refraction settings cannot grow the margin past the shader clamp');
  const chroma = margins({ chroma_strength: 0.25 });
  const chromaPx = GlassGeometry.EDGE_LENS_REACH * 0.25;
  assert.ok(chroma.blurX >= base.blurX + chromaPx - 1, 'chroma offset is covered');
  assert.deepEqual(margins({ chroma_strength: 5 }), margins({ chroma_strength: 1 }), 'the separation is capped at the whole displacement');
});

test('the lens reach constant matches the shader clamp', () => {
  const { GlassGeometry } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const shader = require('node:fs').readFileSync(path.join(dist, '../shaders/glass.frag'), 'utf8');
  assert.equal(Number(shader.match(/#define EDGE_LENS_REACH ([\d.]+)/)[1]), GlassGeometry.EDGE_LENS_REACH);
  assert.match(shader, /min\(footprintPx, 64\.0\) \* 0\.5/, 'footprint spread still caps at 32 px');
});

test('invalid, empty and almost-fullscreen geometry falls back to the whole glass', () => {
  const { GlassGeometry } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const uniforms = new Map();
  const geometry = new GlassGeometry(uniforms);
  for (const operation of [() => geometry.blurRect(), () => geometry.compositeRect()]) assert.equal(operation(), null);
  uniforms.set('resolution_x', 100); uniforms.set('resolution_y', 100);
  geometry.rect = [0, 0, 100, 100];
  assert.equal(geometry.blurRect(), null);
  assert.equal(geometry.compositeRect(), null);
});

function blurFixture() {
  const f = gpuFixture();
  f.bases.initialize(f.context);
  const { BlurRenderer } = f.load(path.join(dist, 'rendering/pipelines.js'));
  let repaints = 0;
  const blur = new BlurRenderer(f.bases, f.passes, () => repaints++);
  return { ...f, blur, repaints: () => repaints };
}

for (const method of [0, 1]) test(`blur method ${method} queues an acyclic graph and releases its pool`, () => {
  const { blur, context, layers, root, texture, errors } = blurFixture();
  blur.setBlurMethod(method); blur.setBlurRadius(15);
  if (blur.needsCompile) blur.compilePending(context);
  blur.resize(context, 800, 600);
  assert.equal(blur.ready, true);
  blur.render(root(), texture(800, 600), [0, 0, 1, 1]);
  assert.equal(blur.result.get_width(), 400);
  assert.equal(blur.result.get_height(), 300);
  const alreadyRead = new Set();
  for (const layer of layers) {
    assert.equal(alreadyRead.has(layer.fbo.texture), false, 'no output may overwrite a texture an earlier node depends on');
    assert.notEqual(layer.fbo.texture, layer.pipeline.layers.get(0));
    alreadyRead.add(layer.pipeline.layers.get(0));
  }
  assert.deepEqual(errors, []);
  blur.clear();
  assert.equal(blur.result, null);
  assert.equal(blur.width, 0);
  assert.equal(blur.ready, false);
});

test('Gaussian radius updates recompile only when the kernel shape changes', () => {
  const { blur, context, root, texture } = blurFixture();
  blur.setBlurMethod(0); blur.setBlurRadius(10);
  assert.equal(blur.needsCompile, true);
  blur.compilePending(context);
  blur.setBlurRadius(9.9);
  assert.equal(blur.needsCompile, false);
  blur.setBlurRadius(20);
  assert.equal(blur.needsCompile, true);
  blur.compilePending(context);
  blur.setDownscale(4);
  blur.resize(context, 800, 600);
  if (blur.needsCompile) blur.compilePending(context);
  blur.render(root(), texture(800, 600), [0, 0, 1, 1]);
  assert.equal(blur.result.get_width(), 200);
  blur.setBlurRadius(0);
  assert.equal(blur.passCount, 0);
  assert.equal(blur.result, null);
  blur.setBlurRadius(10);
  assert.equal(blur.passCount, 1);
  assert.equal(blur.ready, false);
});

for (const method of [0, 1]) test(`blur method ${method} is reused across frames only while its input and configuration are unchanged`, () => {
  const { blur, context, root, texture } = blurFixture();
  blur.setBlurMethod(method); blur.setBlurRadius(15);
  if (blur.needsCompile) blur.compilePending(context);
  blur.resize(context, 800, 600);
  const capture = texture(800, 600), uv = [0, 0, 1, 1];
  const input = serial => [serial, capture, ...uv];
  assert.equal(blur.canReuse(input(1)), false);
  blur.render(root(), capture, uv, input(1));
  assert.equal(blur.canReuse(input(1)), true);
  assert.equal(blur.canReuse(input(2)), false, 'a re-rendered capture needs a new blur');
  assert.equal(blur.canReuse([1, texture(800, 600), ...uv]), false, 'a reallocated capture needs a new blur');
  assert.equal(blur.canReuse([1, capture, 0, 0, 0.5, 1]), false);
  blur.setBlurRadius(method === 0 ? 14 : 3);
  if (blur.needsCompile) blur.compilePending(context);
  if (!blur.ready) blur.resize(context, 800, 600);
  assert.equal(blur.canReuse(input(1)), false, 'a new radius needs a new blur');
  blur.render(root(), capture, uv, input(1));
  assert.equal(blur.canReuse(input(1)), true);
  blur.resize(context, 800, 600);
  assert.equal(blur.canReuse(input(1)), false, 'a rebuilt pool holds nothing');
  blur.render(root(), capture, uv, input(1));
  blur.reload();
  if (blur.needsCompile) blur.compilePending(context);
  assert.equal(blur.canReuse(input(1)), method === 1, 'recompiled Gaussian kernels need a new blur');
  blur.render(root(), capture, uv, input(1));
  blur.setBlurMethod(method === 0 ? 1 : 0);
  assert.equal(blur.canReuse(input(1)), false);
  if (blur.needsCompile) blur.compilePending(context);
  blur.resize(context, 800, 600);
  blur.render(root(), capture, uv);
  assert.equal(blur.canReuse(input(1)), false, 'a render without an input key is never reused');
  blur.clear();
  assert.equal(blur.canReuse(input(1)), false);
});
