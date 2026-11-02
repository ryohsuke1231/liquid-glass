const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

test('shared menu spring sub-steps its Euler integration and clamps the frame time', () => {
  const { Spring } = loadModule(path.join(dist, 'animation.js'));
  const spring = new Spring(120, 8, 1);
  spring.target = 1;
  spring.update(16);
  let x = 0, v = 0;
  for (let i = 0; i < 8; i++) { v += (-120 * (x - 1) - 8 * v) * 0.002; x += v * 0.002; }
  assert.ok(Math.abs(spring.velocity - v) < 1e-12 && Math.abs(spring.value - x) < 1e-12);
  const capped = new Spring(120, 8, 1), stalled = new Spring(120, 8, 1);
  capped.target = stalled.target = 1;
  capped.update(66); stalled.update(5000);
  assert.equal(capped.value, stalled.value);
  assert.equal(capped.velocity, stalled.velocity);
  for (let frame = 0; frame < 2000; frame++) spring.update(16);
  assert.ok(Math.abs(spring.value - 1) < 0.001);
});

test('analytical spring converges for under-, critically- and over-damped motion', () => {
  const { SwiftSpring } = loadModule(path.join(dist, 'animation.js'));
  for (const damping of [0.7, 1, 1.4]) {
    const spring = new SwiftSpring(0.4, damping);
    spring.target = 1;
    for (let frame = 0; frame < 1000; frame++) spring.update(16);
    assert.equal(spring.value, 1);
    assert.equal(spring.velocity, 0);
  }
  const spring = new SwiftSpring(0.4, 0.7);
  spring.target = 1; spring.value = NaN;
  assert.equal(spring.update(16), true);
  assert.equal(spring.value, 1);
});

function materialFixture(settings) {
  const { UniformState } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const { MaterialSettings } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const state = new UniformState(), events = [];
  const blur = { setDownscale: n => events.push(['downscale', n]), setBlurMethod: n => events.push(['method', n]) };
  const material = new MaterialSettings(settings, state, blur, enabled => events.push(['diagnostics', enabled]),
    () => events.push(['repaint']));
  material.initialize();
  return { state, material, events };
}

test('material fallback uses the macOS 27 optical defaults without settings', () => {
  const { state, material } = materialFixture(undefined);
  for (const [name, value] of Object.entries({ resolution_x: 0, corner_radius: 60,
    padding: 20, shadow_max_radius: 180, surface_light_enabled: 1, multi_region_mode: 0,
    early_exit_enabled: 1, edge_taps_enabled: 1, blur_tex_w: 0, displacement_scale: 10.5, max_z: 88,
    ior: 2.4, shadow_radius: 50, ao_radius: 1, corner_smoothing: 0.6, corner_smoothing_enabled: 1,
    highlight_backdrop_color: 1 }))
    assert.equal(state.values.get(name), value, name);
  assert.equal(material.setAnimationScale(0.5), false);
  material.clear();
});

test('material settings initialize downscale before method and disconnect every subscription', () => {
  const handlers = new Map(); let next = 1;
  const values = { 'glass-blur-downscale': 4, 'blur-method': 0, 'glass-debug-diagnostics': true,
    'glass-displacement-scale': 80, 'glass-max-z': 20, 'glass-chroma-strength': 0.2,
    'glass-corner-smoothing': 0.6, 'glass-backdrop-highlights': true };
  const settings = {
    get_double: key => values[key] ?? 1,
    get_int: key => values[key] ?? 0,
    get_boolean: key => !!values[key],
    connect(name, callback) { const id = next++; handlers.set(id, { name, callback }); return id; },
    disconnect(id) { assert.ok(handlers.delete(id)); },
  };
  const { material, state, events } = materialFixture(settings);
  assert.deepEqual(events, [['downscale', 4], ['method', 0], ['diagnostics', true]]);
  assert.ok(handlers.size > 20);
  assert.equal(material.setAnimationScale(0.5), true);
  assert.equal(state.values.get('displacement_scale'), 40);
  assert.equal(state.values.get('max_z'), 10);
  assert.equal(state.values.get('chroma_strength'), 0.2, 'the separation follows the scaled displacement on its own');
  assert.equal(state.values.get('corner_smoothing'), 0.6);
  assert.equal(state.values.get('highlight_backdrop_color'), 1);
  values['glass-backdrop-highlights'] = false;
  for (const h of handlers.values()) if (h.name === 'changed::glass-backdrop-highlights') h.callback();
  assert.equal(state.values.get('highlight_backdrop_color'), 0);
  values['glass-displacement-scale'] = 60;
  for (const h of handlers.values()) if (h.name === 'changed::glass-displacement-scale') h.callback();
  assert.equal(state.values.get('displacement_scale'), 60);
  material.clear(); material.clear();
  assert.equal(handlers.size, 0);
});

test('an outline follows its surface\'s settings, and a width of 0 is how it is turned off', () => {
  const { UniformState } = loadModule(path.join(dist, 'rendering/glassRenderer.js'));
  const { OutlineBinding } = loadModule(path.join(dist, 'rendering/glassRenderer.js'),
    { GLib: {}, Meta: {}, GObject: { Object: { prototype: {} } } });
  const handlers = new Map(); let next = 1; let repaints = 0;
  const values = { 'menu-outline-enabled': false, 'menu-outline-width': 2.5, 'menu-outline-color': '#ff8000' };
  const settings = {
    get_string: key => values[key], get_double: key => values[key], get_boolean: key => values[key],
    connect(name, callback) { const id = next++; handlers.set(id, { name, callback }); return id; },
    disconnect(id) { assert.ok(handlers.delete(id)); },
  };
  const state = new UniformState();
  const outline = new OutlineBinding(settings, 'menu', state, () => { repaints++; });
  outline.initialize();
  assert.equal(state.values.get('outline_width'), 0);
  assert.equal(state.values.get('outline_g'), 128 / 255);
  assert.equal(handlers.size, 3);
  values['menu-outline-enabled'] = true;
  for (const h of handlers.values()) if (h.name === 'changed::menu-outline-enabled') h.callback();
  assert.equal(state.values.get('outline_width'), 2.5);
  assert.equal(repaints, 1);
  values['menu-outline-color'] = '#000000';
  for (const h of handlers.values()) if (h.name === 'changed::menu-outline-color') h.callback();
  assert.equal(state.values.get('outline_r'), 0);
  outline.clear();
  assert.equal(handlers.size, 0);
});
