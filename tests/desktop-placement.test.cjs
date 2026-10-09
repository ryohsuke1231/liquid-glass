const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const placement = loadModule(path.join(dist, 'desktop/placement.js'), {});
const rect = { x: 100, y: 200, width: 300, height: 150 };

test('a right or bottom handle grows the rect away from its left and top edges', () => {
  assert.deepEqual(placement.resizeRect(rect, 1, 0, 50, 999, 48), { x: 100, y: 200, width: 350, height: 150 });
  assert.deepEqual(placement.resizeRect(rect, 0, 1, 999, -30, 48), { x: 100, y: 200, width: 300, height: 120 });
});

test('a left or top handle keeps the opposite edge where it was', () => {
  const r = placement.resizeRect(rect, -1, -1, 40, -20, 48);
  assert.deepEqual(r, { x: 140, y: 180, width: 260, height: 170 });
  assert.equal(r.x + r.width, rect.x + rect.width);
  assert.equal(r.y + r.height, rect.y + rect.height);
});

test('a rect is never resized below the minimum, whichever edge moves', () => {
  assert.equal(placement.resizeRect(rect, 1, 0, -1000, 0, 48).width, 48);
  const r = placement.resizeRect(rect, -1, 0, 1000, 0, 48);
  assert.deepEqual([r.x, r.width], [rect.x + rect.width - 48, 48]);
});

test('a moved item keeps its centre as a fraction of the work area', () => {
  const area = { x: 0, y: 32, width: 1920, height: 1048 };
  const fraction = placement.fractionOf([860, 500], area, [200, 100]);
  assert.deepEqual(placement.placeAtFraction(fraction, area, [200, 100]), [860, 500]);
  assert.deepEqual(placement.placeAtFraction([1, 1], area, [200, 100]), [1720, 980]);
});

test('widget anchors keep only known places', () => {
  assert.deepEqual(placement.parseAnchors('{"weather":"bottom-left","events":"middle","media":3}'), { weather: 'bottom-left' });
  assert.deepEqual(placement.parseAnchors('not json'), {});
});

test('the Done button goes below its frame, or above, right or left when that is off the work area or on a dock', () => {
  const area = { x: 0, y: 32, width: 1920, height: 1048 };
  const frame = { x: 800, y: 400, width: 300, height: 150 };
  assert.deepEqual(placement.placeBeside(frame, [80, 30], 14, area, []), [910, 564]);
  const dock = { x: 96, y: 520, width: 1728, height: 80 };
  const low = { ...frame, y: 380 };
  assert.deepEqual(placement.placeBeside(low, [80, 30], 14, area, [dock]), [910, 336]);
  const tall = { x: 800, y: 40, width: 300, height: 1030 };
  assert.deepEqual(placement.placeBeside(tall, [80, 30], 14, area, []), [1114, 540]);
  const wide = { x: 1500, y: 40, width: 410, height: 1030 };
  assert.deepEqual(placement.placeBeside(wide, [80, 30], 14, area, []), [1406, 540]);
});

test('the Done button stays on the work area when nowhere beside its frame is free', () => {
  const area = { x: 0, y: 32, width: 1920, height: 1048 };
  const full = { x: -10, y: 20, width: 1940, height: 1070 };
  assert.deepEqual(placement.placeBeside(full, [80, 30], 14, area, []), [920, 1050]);
});
