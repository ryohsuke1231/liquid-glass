const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { snapMove } = loadModule(path.join(dist, 'desktop/guides.js'), {});
const rect = (x, y, width, height) => ({ x, y, width, height });
const AREA = rect(0, 32, 1920, 1048);

test('an item near another\'s edge is pulled onto it and shows a line there', () => {
  const other = rect(100, 100, 300, 200);
  const { dx, dy, guides } = snapMove(rect(104, 500, 200, 100), [other], null, 6);
  assert.deepEqual([dx, dy], [-4, 0]);
  assert.deepEqual(guides, [{ vertical: true, at: 100, from: 100, to: 600, kind: 'align' }]);
});

test('the right, bottom and centre lines line up as well', () => {
  const other = rect(100, 100, 300, 200);
  assert.equal(snapMove(rect(203, 500, 200, 100), [other], null, 6).dx, -3);
  assert.equal(snapMove(rect(600, 197, 200, 100), [other], null, 6).dy, 3);
  // A (2, 2, 4, 6) and B (3, 3, 2, 8) share their vertical centre line.
  const { dx, guides } = snapMove(rect(31, 300, 20, 80), [rect(20, 20, 40, 60)], null, 6);
  assert.equal(dx, -1);
  assert.ok(guides.some(g => g.vertical && g.at === 40 && g.kind === 'align'));
});

test('nothing pulls from further than the reach, and nothing is shown then', () => {
  assert.deepEqual(snapMove(rect(110, 500, 200, 100), [rect(100, 100, 300, 200)], null, 6), { dx: 0, dy: 0, guides: [] });
});

test('the middle of the work area is a guide', () => {
  const { dx, guides } = snapMove(rect(862, 300, 200, 100), [], AREA, 6);
  assert.equal(dx, -2);
  assert.deepEqual(guides, [{ vertical: true, at: 960, from: 32, to: 1080, kind: 'align' }]);
});

test('a third item the same distance on from the second shows both gaps', () => {
  // A (2, 2, 2, 2), B (2, 5, 2, 2), C (2, 8, 2, 2), scaled up.
  const a = rect(20, 20, 20, 20), b = rect(20, 50, 20, 20);
  const { dx, dy, guides } = snapMove(rect(20, 82, 20, 20), [a, b], null, 6);
  assert.deepEqual([dx, dy], [0, -2]);
  const gaps = guides.filter(g => g.kind === 'spacing').map(g => [g.vertical, g.from, g.to]);
  assert.deepEqual(gaps.sort(), [[true, 40, 50], [true, 70, 80]]);
});

test('an item between two others goes as far from each', () => {
  const a = rect(100, 100, 100, 50), b = rect(400, 100, 100, 50);
  const { dx, guides } = snapMove(rect(253, 110, 100, 50), [a, b], null, 6);
  assert.equal(dx, -3);
  const gaps = guides.filter(g => g.kind === 'spacing').map(g => [g.vertical, g.from, g.to]);
  assert.deepEqual(gaps.sort(), [[false, 200, 250], [false, 350, 400]]);
});

test('items out of line with the moved one set no spacing', () => {
  const a = rect(20, 20, 20, 20), b = rect(20, 50, 20, 20);
  const { guides } = snapMove(rect(300, 80, 20, 20), [a, b], null, 6);
  assert.ok(guides.every(g => g.kind !== 'spacing'));
});
