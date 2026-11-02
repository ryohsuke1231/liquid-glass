const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { Spring, SwiftSpring } = loadModule(path.join(dist, 'animation.js'));
const { stepMenuSpring } = loadModule(path.join(dist, 'animation.js'));

function referenceStep(scaleSpring, elapsedMs) {
  const isClosing = scaleSpring.target === 0;
  let dt = elapsedMs / 1000;
  if (dt > 0.066) dt = 0.066;
  let stopped = false;
  let s;
  if (isClosing) {
    const speed = 15.0;
    scaleSpring.value += (0 - scaleSpring.value) * (1.0 - Math.exp(-speed * dt));
    s = scaleSpring.value;
    if (s < 0.005) { s = 0; stopped = true; }
  } else {
    stopped = scaleSpring.update(elapsedMs);
    s = scaleSpring.value;
    if (Math.abs(1.0 - s) < 0.002 && Math.abs(scaleSpring.velocity) < 0.03) { s = 1.0; stopped = true; }
  }
  let scale, opacity;
  if (isClosing) {
    scale = Math.max(0.001, s);
    opacity = Math.min(255, Math.max(0, (s - 0.3) / 0.7 * 255));
  } else {
    scale = 0.2 + (s * 0.8);
    opacity = Math.min(255, Math.max(0, (s / 0.3) * 255));
  }
  return { closing: isClosing, stopped, scale, opacity };
}

function spring(kind) {
  return kind === 'swift' ? new SwiftSpring(0.4, 0.7) : new Spring(120, 8, 1);
}

function lcg(seed) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

for (const kind of ['euler', 'swift']) test(`${kind} open/close steps match the scale-only reference`, () => {
  const rand = lcg(kind === 'swift' ? 7 : 3);
  for (let run = 0; run < 40; run++) {
    const a = spring(kind), b = spring(kind);
    let target = 1;
    for (let frame = 0; frame < 400; frame++) {
      if (rand() < 0.01) target = target ? 0 : 1;
      a.target = b.target = target;
      const ms = rand() < 0.05 ? 40 + rand() * 200 : 6 + rand() * 12;
      assert.deepEqual(stepMenuSpring(a, ms), referenceStep(b, ms), `run ${run} frame ${frame}`);
      assert.deepEqual([a.value, a.velocity], [b.value, b.velocity]);
    }
  }
});

test('opening stops as soon as the scale spring settles', () => {
  const settled = { value: 0.5, velocity: 1, target: 1, update() { return true; } };
  assert.equal(stepMenuSpring(settled, 16).stopped, true);
  const moving = { value: 0.5, velocity: 1, target: 1, update() { return false; } };
  assert.equal(stepMenuSpring(moving, 16).stopped, false);
});

test('a 20 fps cap opens at the same speed as every frame', () => {
  const run = frameMs => {
    const s = new Spring(120, 8, 1);
    s.target = 1;
    for (let t = 0; t < 400; t += frameMs) s.update(frameMs);
    return s.value;
  };
  assert.ok(Math.abs(run(50) - run(16)) < 0.01, `20 fps ${run(50)}, 60 fps ${run(16)}`);
});

test('the stiffest spring the preferences allow stays stable at 30 fps', () => {
  const s = new Spring(1000, 100, 1);
  s.target = 1;
  for (let frame = 0; frame < 60; frame++) s.update(33);
  assert.ok(Number.isFinite(s.value) && Math.abs(s.value - 1) < 0.01, `value ${s.value}`);
});
