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

test('a moved item\'s saved height keeps its top edge in place', () => {
  assert.deepEqual(placement.parsePositions('{"a":[0.5,0.25],"b":[0.1,0.2,80],"c":[1],"d":["x",1]}'),
    { a: [0.5, 0.25], b: [0.1, 0.2, 80] });
});

test('items put in a column stay a stack when one of them changes size or is hidden', () => {
  const area = { x: 0, y: 32, width: 1000, height: 800 };
  const saved = [
    { x: 24, y: 40, width: 270, height: 200 },
    { x: 24, y: 256, width: 270, height: 70 },
    { x: 24, y: 342, width: 270, height: 130 },
    { x: 600, y: 300, width: 270, height: 100 },
  ];
  const sizes = [[270, 200], [270, 70], [270, 130], [270, 100]];
  const place = (items, kept = items.map((_, i) => i)) =>
    placement.stackColumns(items.map((saved, i) => ({ saved, size: sizes[i], shown: kept.includes(i) })), area);
  assert.deepEqual(place(saved), [[24, 40], [24, 256], [24, 342], [600, 300]]);
  sizes[1] = [270, 120];
  assert.deepEqual(place(saved).slice(0, 3), [[24, 40], [24, 256], [24, 392]]);
  sizes[1] = [270, 70];
  assert.deepEqual(place(saved, [0, 2, 3]).slice(0, 2), [[24, 40], [24, 256]]);
});

test('a column that would run off the work area is moved up to fit', () => {
  const area = { x: 0, y: 0, width: 1000, height: 400 };
  const saved = [{ x: 0, y: 200, width: 200, height: 100 }, { x: 0, y: 316, width: 200, height: 80 }];
  assert.deepEqual(placement.stackColumns(saved.map(r => ({ saved: r, size: [200, r.height + 60], shown: true })), area),
    [[0, 84], [0, 260]]);
});

test('an arrow key moves the rect, pulls the edge on its side outwards, or scales it about its center', () => {
  assert.deepEqual(placement.keyEditRect(rect, -1, 0, 'move', 48), { x: 98, y: 200, width: 300, height: 150 });
  assert.deepEqual(placement.keyEditRect(rect, 0, 1, 'move', 48), { x: 100, y: 202, width: 300, height: 150 });
  // Right and down pull the far edges; left and up pull the near ones and keep the far ones.
  assert.deepEqual(placement.keyEditRect(rect, 1, 0, 'stretch', 48), { x: 100, y: 200, width: 304, height: 150 });
  assert.deepEqual(placement.keyEditRect(rect, -1, 0, 'stretch', 48), { x: 96, y: 200, width: 304, height: 150 });
  assert.deepEqual(placement.keyEditRect(rect, 0, -1, 'stretch', 48), { x: 100, y: 196, width: 300, height: 154 });
  assert.deepEqual(placement.keyEditRect(rect, 0, 1, 'stretch', 48), { x: 100, y: 200, width: 300, height: 154 });
  const larger = placement.keyEditRect(rect, 0, -1, 'scale', 48), smaller = placement.keyEditRect(rect, 0, 1, 'scale', 48);
  assert.ok(larger.width > 300 && Math.abs(larger.width / larger.height - 2) < 1e-9);
  assert.ok(smaller.width < 300 && Math.abs(smaller.x + smaller.width / 2 - 250) < 1e-9 && Math.abs(larger.y + larger.height / 2 - 275) < 1e-9);
  assert.equal(placement.keyEditRect(rect, 1, 0, 'scale', 48), null, 'left and right do not scale');
  assert.equal(placement.keyEditRect({ x: 0, y: 0, width: 60, height: 48 }, 0, 1, 'scale', 48), null, 'not below the minimum');
});
