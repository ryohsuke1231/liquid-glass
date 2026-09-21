const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

test('shared menu spring preserves Euler integration and the frame-time clamp', () => {
  const { Spring } = loadModule(path.join(dist, 'animation/spring.js'));
  const spring = new Spring(120, 8, 1);
  spring.target = 1;
  spring.update(16);
  assert.equal(spring.velocity, 120 * 0.016);
  assert.equal(spring.value, spring.velocity * 0.016);
  const capped = new Spring(120, 8, 1), stalled = new Spring(120, 8, 1);
  capped.target = stalled.target = 1;
  capped.update(33); stalled.update(5000);
  assert.equal(capped.value, stalled.value);
  assert.equal(capped.velocity, stalled.velocity);
  for (let frame = 0; frame < 2000; frame++) spring.update(16);
  assert.ok(Math.abs(spring.value - 1) < 0.001);
});

test('analytical spring converges for under-, critically- and over-damped motion', () => {
  const { SwiftSpring } = loadModule(path.join(dist, 'animation/spring.js'));
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
  const { UniformState } = loadModule(path.join(dist, 'rendering/uniforms.js'));
  const { MaterialSettings } = loadModule(path.join(dist, 'rendering/material.js'));
  const state = new UniformState(), events = [];
  const blur = { setDownscale: n => events.push(['downscale', n]), setBlurMethod: n => events.push(['method', n]) };
  const material = new MaterialSettings(settings, state, blur, enabled => events.push(['diagnostics', enabled]));
  material.initialize();
  return { state, material, events };
}

test('material fallback preserves the old optical defaults without settings', () => {
  const { state, material } = materialFixture(undefined);
  for (const [name, value] of Object.entries({ resolution_x: 0, pointer_x: -100, corner_radius: 60,
    padding: 20, shadow_max_radius: 180, surface_light_enabled: 1, multi_region_mode: 0,
    early_exit_enabled: 1, displacement_scale: 78.5, ior: 2.4, shadow_radius: 8, ao_radius: 7.5 }))
    assert.equal(state.values.get(name), value, name);
  assert.equal(material.setAnimationScale(0.5), false);
  material.clear();
});

test('material settings initialize downscale before method and disconnect every subscription', () => {
  const handlers = new Map(); let next = 1;
  const values = { 'glass-blur-downscale': 4, 'blur-method': 0, 'glass-debug-diagnostics': true,
    'glass-displacement-scale': 80, 'glass-max-z': 20, 'glass-chroma-strength': 0.01 };
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
  assert.equal(state.values.get('chroma_strength'), 0.005);
  values['glass-displacement-scale'] = 60;
  for (const h of handlers.values()) if (h.name === 'changed::glass-displacement-scale') h.callback();
  assert.equal(state.values.get('displacement_scale'), 60);
  material.clear(); material.clear();
  assert.equal(handlers.size, 0);
});
