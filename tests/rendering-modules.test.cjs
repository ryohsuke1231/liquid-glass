const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, createModuleLoader } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

test('shader parsing preserves declarations and nested main blocks', () => {
  const { splitShader } = loadModule(path.join(dist, 'rendering/pipelines.js'));
  const decl = 'uniform float radius;\n';
  const body = '\n if (radius > 0.) { gl_FragColor = vec4(1.); }\n';
  assert.deepEqual(splitShader(`${decl}void main() {${body}}`), { decl, body });
  const warnings = [];
  assert.deepEqual(splitShader(decl, message => warnings.push(message)), { decl, body: '' });
  assert.equal(warnings.length, 1);
});

test('Gaussian tap merging preserves normalization, offsets and shader direction', () => {
  const { computeGaussianKernel, buildGaussianSnippet } = loadModule(path.join(dist, 'rendering/pipelines.js'));
  for (const sigma of [0.5, 1, 3, 12]) for (const pairs of [1, 2, 4, 8]) {
    const kernel = computeGaussianKernel(sigma, pairs);
    assert.equal(kernel.offsets.length, pairs + 1);
    assert.equal(kernel.offsets[0], 0);
    assert.ok(Math.abs(kernel.weights[0] + 2 * kernel.weights.slice(1).reduce((a,b) => a+b, 0) - 1) < 1e-12);
    for (let index = 1; index <= pairs; index++) {
      assert.ok(kernel.offsets[index] >= 2 * index - 1 - 1e-12 && kernel.offsets[index] <= 2 * index + 1e-12);
      assert.ok(kernel.weights[index] >= 0);
    }
    const horizontal = buildGaussianSnippet(kernel, 'h');
    const vertical = buildGaussianSnippet(kernel, 'v');
    assert.match(horizontal.body, /kernel_scale \* inv_size\.x, 0\.0/);
    assert.match(vertical.body, /0\.0, .*kernel_scale \* inv_size\.y/);
    assert.equal((horizontal.body.match(/texture2D/g) || []).length, 1 + 2 * pairs);
    assert.equal(horizontal.decl, vertical.decl);
  }
});

test('every registered glass is counted and the debug API goes with the last disable', () => {
  const globalThis = { global: {} };
  const registry = createModuleLoader({ globalThis, global: globalThis.global })(path.join(dist, 'diagnostics.js'));
  registry.installGlassDiagnostics();
  const glasses = [{}, {}];
  glasses.forEach(glass => registry.registerGlass(glass));
  assert.equal(globalThis.global._lgGlass.count(), 2);
  registry.unregisterGlass(glasses[0]);
  assert.equal(globalThis.global._lgGlass.count(), 1);
  registry.unregisterGlass(glasses[1]);
  assert.equal(globalThis.global._lgGlass.count(), 0);
  registry.removeGlassDiagnostics();
  assert.equal(globalThis.global._lgGlass, undefined);
});

function passesFixture() {
  const nodes = [];
  const Clutter = {
    ActorBox: class { constructor(rect) { Object.assign(this, rect); } },
    LayerNode: { new_to_framebuffer(fbo, pipeline) {
      const node = { fbo, pipeline, children: [], add_child(child) { this.children.push(child); } };
      nodes.push(node);
      return node;
    } },
    PipelineNode: { new(pipeline) { return { pipeline, add_texture_rectangle(...rect) { this.rect = rect; } }; } },
  };
  const module = loadModule(path.join(dist, 'rendering/pipelines.js'), { Clutter });
  const passes = new module.RenderPasses();
  return { ...module, passes, nodes };
}

test('deferred passes isolate pipeline copies and invalidate them when a shader changes', () => {
  const { passes } = passesFixture();
  const base = { copy: () => ({ set_blend(mode) { this.blend = mode; } }) };
  const first = passes.pipeline('horizontal', base);
  assert.equal(passes.pipeline('horizontal', base), first);
  const vertical = passes.pipeline('vertical', base);
  assert.notEqual(vertical, first);
  assert.equal(first.blend, 'RGBA = ADD(SRC_COLOR, 0)');
  const recompiled = { copy: base.copy };
  assert.notEqual(passes.pipeline('horizontal', recompiled), first);
  passes.clear();
  assert.notEqual(passes.pipeline('vertical', base), vertical);
});

test('paint passes enqueue geometry with the supplied UVs rather than drawing immediately', () => {
  const { passes, nodes } = passesFixture();
  const parent = { children: [], add_child(node) { this.children.push(node); } };
  const fbo = { orthographic(...args) { this.projection = args; }, draw_rectangle() { assert.fail('immediate draw'); } };
  const pipeline = {};
  passes.add(parent, fbo, pipeline, 100, 80, [0.1, 0.2, 0.8, 0.9]);
  assert.equal(parent.children[0], nodes[0]);
  assert.deepEqual(fbo.projection, [0, 0, 100, 80, -1, 1]);
  assert.equal(nodes[0].children[0].pipeline, pipeline);
  assert.deepEqual(nodes[0].children[0].rect.slice(1), [0.1, 0.2, 0.8, 0.9]);
  assert.deepEqual({ ...nodes[0].children[0].rect[0] }, { x1: 0, y1: 0, x2: 100, y2: 80 });
});

test('the composite is queued as a node over the destination with one UV range', () => {
  const { passes } = passesFixture();
  const parent = { children: [], add_child(node) { this.children.push(node); } };
  passes.composite(parent, {}, [10, 20, 50, 70], [0.1, 0.2, 0.8, 0.9]);
  assert.deepEqual({ ...parent.children[0].rect[0] }, { x1: 10, y1: 20, x2: 50, y2: 70 });
  assert.deepEqual(parent.children[0].rect.slice(1), [0.1, 0.2, 0.8, 0.9]);
});

test('uniform helpers preserve scalar and vec2 dimensions', () => {
  const { setPipelineFloat, setPipelineVec2 } = passesFixture();
  const writes = [];
  const pipeline = { get_uniform_location: name => name, set_uniform_float: (...args) => writes.push(args),
    set_uniform_1f: (...args) => writes.push(args) };
  setPipelineFloat(pipeline, 'radius', 4);
  setPipelineVec2(pipeline, 'inv_size', 0.01, 0.02);
  assert.deepEqual(writes, [['radius', 4], ['inv_size', 2, 1, [0.01, 0.02]]]);
});
