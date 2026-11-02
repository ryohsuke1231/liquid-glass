const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { RectTween } = loadModule(path.join(dist, 'animation.js'), {});

test('a tween reaches its target in its time and never passes it', () => {
  const tween = new RectTween(200);
  tween.start([0, 0, 100, 100], [0, 0, 100, 300], 0);
  let last = 100;
  for (let us = 0; us <= 250000; us += 16000) {
    const h = tween.rect(us)[3];
    assert.ok(h >= last && h <= 300, `${us}: ${h}`);
    last = h;
  }
  assert.deepEqual(tween.rect(200000), [0, 0, 100, 300]);
});

test('a new target eases on from where the rect is, and the same target does not restart it', () => {
  const tween = new RectTween(200);
  tween.start([0, 0, 100, 100], [0, 0, 100, 300], 0);
  const mid = tween.rect(100000);
  tween.setTarget([0, 0, 100, 300.2], 100000);
  assert.deepEqual(tween.rect(100000), mid);
  assert.equal(tween.rect(200000)[3], 300);
  tween.setTarget([0, 0, 100, 150], 100000);
  assert.deepEqual(tween.rect(100000), mid);
  assert.equal(tween.rect(300000)[3], 150);
});

test('a tween counts down to landing from its last restart', () => {
  const tween = new RectTween(200);
  tween.start([0, 0, 100, 100], [0, 0, 100, 300], 0);
  assert.equal(tween.remaining(0), 200);
  assert.ok(tween.remaining(199999) > 0);
  assert.equal(tween.remaining(200000), 0);
  tween.setTarget([0, 0, 100, 150], 200000);
  assert.equal(tween.remaining(300000), 100);
  assert.equal(tween.remaining(400000), 0);
});

const { RectSpring } = loadModule(path.join(dist, 'animation.js'), {});

test('a rect spring swings a little past its target and settles on it', () => {
  const spring = new RectSpring([0, 0, 100, 100]);
  spring.rect(0);
  spring.setTarget([0, 0, 100, 300], 0);
  let peak = 0;
  let us = 0;
  for (; us < 3000000 && !spring.settled(); us += 16000) peak = Math.max(peak, spring.rect(us)[3]);
  assert.ok(peak > 300 && peak < 340, `peak ${peak}`);
  assert.ok(spring.settled(), 'settled');
  assert.deepEqual(spring.rect(us), [0, 0, 100, 300]);
});
