const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { gpuFixture, dist } = require('./helpers/gpu.cjs');

test('uniform state buffers before compilation and skips unchanged scalar and array writes', () => {
  const { UniformState } = loadModule(path.join(dist, 'rendering/uniforms.js'));
  const state = new UniformState();
  const writes = [], locations = [];
  const pipeline = { get_uniform_location: name => { locations.push(name); return name; },
    set_uniform_float: (...args) => writes.push(structuredClone(args)) };
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
  const { GlassGeometry } = loadModule(path.join(dist, 'rendering/geometry.js'));
  const uniforms = new Map(Object.entries({ resolution_x: 1920, resolution_y: 1080,
    padding: 10, shadow_radius: 20, shadow_max_radius: 30, shadow_intensity: 1,
    edge_smoothing: 2, displacement_scale: 0 }));
  const geometry = new GlassGeometry(uniforms);
  geometry.rect = [500, 400, 300, 120];
  const composite = geometry.compositeRect();
  assert.deepEqual(composite, [486, 386, 328, 148]);
  const blur = geometry.blurRect(), capture = geometry.captureClip(15);
  assert.ok(capture[0] <= blur[0] && capture[1] <= blur[1]);
  assert.ok(capture[0] + capture[2] >= blur[0] + blur[2]);
  assert.equal(blur[2] % GlassGeometry.BLUR_RECT_QUANTUM, 0);
  assert.equal(blur[3] % GlassGeometry.BLUR_RECT_QUANTUM, 0);
  geometry.multiRegion = true;
  geometry.regions = [[500, 400, 100, 80], [800, 500, 80, 100]];
  assert.deepEqual(geometry.compositeRect(), [506, 406, 368, 188], 'multi-region glass does not paint a drop shadow');
  uniforms.set('debug_view', 1);
  assert.equal(geometry.compositeRect(), null);
  geometry.blurEnabled = false;
  assert.equal(geometry.blurRect(), null);
  assert.ok(geometry.captureClip(15), 'capture clipping is independent of blur clipping');
});

test('invalid, empty and almost-fullscreen geometry falls back to the full capture', () => {
  const { GlassGeometry } = loadModule(path.join(dist, 'rendering/geometry.js'));
  const uniforms = new Map();
  const geometry = new GlassGeometry(uniforms);
  for (const operation of [() => geometry.blurRect(), () => geometry.compositeRect(), () => geometry.captureClip(10)]) assert.equal(operation(), null);
  uniforms.set('resolution_x', 100); uniforms.set('resolution_y', 100);
  geometry.rect = [0, 0, 100, 100];
  assert.equal(geometry.blurRect(), null);
  assert.equal(geometry.compositeRect(), null);
  assert.equal(geometry.captureClip(10), null);
});

function blurFixture() {
  const f = gpuFixture();
  f.bases.initialize(f.context);
  const { BlurRenderer } = f.load(path.join(dist, 'rendering/blur.js'));
  let repaints = 0;
  const blur = new BlurRenderer(f.bases, f.passes, () => repaints++, f.logger);
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

test('failed blur allocation drops a partial pool and can recover on the next paint', () => {
  const { blur, context, failAllocation, errors } = blurFixture();
  failAllocation(true); blur.resize(context, 800, 600);
  assert.equal(blur.ready, false);
  assert.equal(blur.width, 0);
  assert.equal(errors.length, 1);
  failAllocation(false); blur.resize(context, 800, 600);
  assert.equal(blur.ready, true);
});

test('crop target is reused until dimensions change and falls back on allocation failure', () => {
  const { load, bases, passes, logger, context, texture, root, textures, failAllocation } = gpuFixture();
  bases.initialize(context);
  const { CropPass } = load(path.join(dist, 'rendering/crop.js'));
  const crop = new CropPass(bases, passes, logger), src = texture(803, 603);
  const render = (w, h) => crop.render(root(), context, src, 803, 603, w, h, [0, 0, 1, 1]);
  const first = render(800, 600);
  assert.equal(render(800, 600), first);
  assert.equal(textures.length, 1);
  assert.notEqual(render(790, 590), first);
  crop.clear();
  failAllocation(true);
  assert.equal(render(800, 600), src);
  failAllocation(false);
  assert.notEqual(render(800, 600), src);
});

async function effectFixture() {
  const f = gpuFixture();
  const { LiquidEffect } = f.load(path.join(dist, 'liquidEffect.js'));
  const actor = { redraws: 0, get_size: () => [800, 600], get_paint_opacity: () => 128,
    get_name: () => 'test-glass', queue_redraw() { this.redraws++; }, get_parent: () => null };
  const effect = new LiquidEffect({ extensionPath: '/ext', logger: f.logger, actor, texture: f.texture(803, 603) });
  await new Promise(resolve => setImmediate(resolve));
  effect.setResolution(800, 600); effect.setGlassGeometry(0, 0, 800, 600);
  const paint = () => { const node = f.root(); effect.vfunc_paint_target(node, { get_framebuffer: () => ({}) }); return node; };
  return { ...f, effect, actor, paint, LiquidEffect };
}

test('effect integration preserves same-frame blur reuse, shader reload and faded opacity', async () => {
  const { effect, paint, layers, actor, stageHandlers, errors } = await effectFixture();
  assert.ok(actor.redraws > 0, 'async shader readiness damages the actor');
  const first = paint();
  const count = layers.length;
  assert.ok(count > 0);
  assert.equal(effect.fallbacks, 0);
  assert.deepEqual(first.children.at(-1).pipeline.color, [128 / 255, 128 / 255, 128 / 255, 128 / 255]);
  paint();
  assert.equal(layers.length, count, 'repeat paint reuses the same frame’s blur');
  for (const callback of stageHandlers.values()) callback();
  paint();
  assert.ok(layers.length > count);
  effect.reloadShaders();
  paint();
  assert.equal(effect.fallbacks, 0);
  assert.deepEqual(errors, []);
  effect.cleanup();
  assert.equal(stageHandlers.size, 0);
});

test('geometry changes in the same frame invalidate reuse even when the quantized pool size matches', async () => {
  const { effect, paint, layers, actor } = await effectFixture();
  actor.get_size = () => [1920, 1080];
  effect.texture = { get_width: () => 1920, get_height: () => 1080 };
  effect.setResolution(1920, 1080); effect.setGlassGeometry(600, 600, 300, 100);
  paint();
  const before = layers.length;
  effect.setGlassGeometry(610, 600, 300, 100);
  paint();
  assert.ok(layers.length > before);
  effect.cleanup();
});

test('effect setters batch repaints and unchanged values do not dirty the capture', async () => {
  const { effect } = await effectFixture();
  effect.setTintStrength(0.5);
  const before = effect.repaints;
  effect.setTintStrength(0.5);
  assert.equal(effect.repaints, before);
  effect.beginBatch(); effect.setTintStrength(0.6); effect.setCornerRadius(25); effect.setBrightness(1.1); effect.endBatch();
  assert.equal(effect.repaints, before + 1);
  effect.cleanup();
});
