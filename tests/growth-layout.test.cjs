const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { layoutGrowths, bodyCorner, filletShape, joinCurve, moveGrowth, GROWTH_CURVE_POINTS } =
  loadModule(path.join(dist, 'growthBars.js'), {});

// A dock at the bottom: its body 600 px wide and 64 high, things grow up out of it.
const BODY = [100, 900, 600, 64];
const TOP = BODY[1];
const END = BODY[0] + BODY[2];
const FILLET = 24;
const SMOOTHING = 0.6;
const CORNER = bodyCorner(30, SMOOTHING, 64);
const SMOOTHED = filletShape(FILLET, SMOOTHING);
const ROOM = SMOOTHED.reach + CORNER.reach;
const options = { minX: 0, maxX: 1000, fillet: FILLET, smoothing: SMOOTHING, direction: -1, corner: () => CORNER };
const layout = rect => layoutGrowths([[...BODY]], [{ rect, radius: 12 }], options);
// A menu from y 600 down to the dock, its right side `inside` px in from the body's right end.
const rightSideIn = inside => layout([500, 600, END - inside - 500, 300]);

// The direction each segment heads in and how sharply the curve turns at each point (1 / radius).
function bends(points) {
  const out = [];
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const turn = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
    out.push(turn / ((Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2));
  }
  return out;
}

test('a fillet is smoothed like a corner, and with no smoothing is a circle', () => {
  const circle = filletShape(16, 0);
  assert.ok(circle.reach === 16 && Math.abs(circle.exponent - 2) < 1e-6);
  const smoothed = filletShape(16, 0.6);
  assert.ok(Math.abs(smoothed.reach - 25.6) < 1e-9 && smoothed.exponent > 3);
});

test('a side clear of the fillet and the corner keeps its fillet', () => {
  const { growths: [g] } = rightSideIn(ROOM + 10);
  assert.deepEqual(g.fillets, [FILLET, FILLET]);
  assert.deepEqual(g.curves, [null, null]);
});

test('nearer the end the side stays put and joins the end along a curve', () => {
  for (const inside of [ROOM - 1, 40, 20, 8, 2]) {
    const { growths: [g], bodies } = rightSideIn(inside);
    assert.equal(g.x + g.w, END - inside);
    assert.equal(bodies[0][0] + bodies[0][2], END);
    assert.deepEqual(g.fillets, [FILLET, 0]);
    const { points, clip, box } = g.curves[1];
    assert.equal(points.length, GROWTH_CURVE_POINTS);
    // From the menu's side down to where the corner meets the end, always heading down.
    assert.ok(Math.abs(points[0][0] - (END - inside)) < 1e-9);
    assert.ok(Math.abs(points.at(-1)[0] - END) < 1e-9 && Math.abs(points.at(-1)[1] - (TOP + CORNER.reach)) < 1e-9);
    for (let i = 1; i < points.length; i++) assert.ok(points[i][1] >= points[i - 1][1], `inside ${inside}`);
    // It cuts the glass above where the corner ends; the menu's glass runs on from its side to the end.
    assert.deepEqual(clip, [TOP + CORNER.reach, 1]);
    assert.ok(Math.abs(box[0] - (END - inside - 64)) < 1e-9 && Math.abs(box[0] + box[2] - END) < 1e-9);
  }
});

test('the curve keeps the fillet\'s and the corner\'s curvature, turning less instead', () => {
  const full = bends(joinCurve(ROOM - 1e-6, SMOOTHED, CORNER));
  for (const inside of [40, 20, 8]) {
    const near = bends(joinCurve(inside, SMOOTHED, CORNER));
    const [concave, convex] = [Math.max(...near), -Math.min(...near)];
    assert.ok(Math.abs(concave / Math.max(...full) - 1) < 0.1, `inside ${inside}: ${concave} vs ${Math.max(...full)}`);
    assert.ok(Math.abs(convex / -Math.min(...full) - 1) < 0.1, `inside ${inside}`);
  }
  // Nearly at the end it is nearly straight.
  const flat = joinCurve(0.5, SMOOTHED, CORNER);
  const turn = Math.max(...flat.slice(1).map((p, i) => Math.abs(Math.atan2(p[0] - flat[i][0], p[1] - flat[i][1]))));
  assert.ok(turn < 0.25, `${turn}`);
});

test('where both just fit, the curve is the fillet and then the corner, meeting on the top', () => {
  const points = joinCurve(ROOM - 1e-6, SMOOTHED, CORNER);
  const mid = points[(GROWTH_CURVE_POINTS - 1) / 2];
  assert.ok(Math.abs(mid[0] + CORNER.reach) < 0.01 && Math.abs(mid[1]) < 0.01, `${mid}`);
  assert.equal(joinCurve(ROOM + 1e-6, SMOOTHED, CORNER), null);
});

test('a side past the end takes the end out with it and needs no curve', () => {
  const { bodies, growths: [g] } = layout([500, 600, 260, 300]);
  assert.equal(g.x + g.w, 760);
  assert.equal(bodies[0][0] + bodies[0][2], 760);
  assert.equal(g.fillets[1], 0);
  assert.equal(g.curves[1], null);
});

test('every curve is walked with the glass on its left: the left side of a dock, and a bar growing down', () => {
  const inside = (curve, x, y) => {
    // The segment spanning y decides, as glass.frag does.
    for (let i = 1; i < curve.points.length; i++) {
      const [a, b] = [curve.points[i - 1], curve.points[i]];
      if ((y - a[1]) * (y - b[1]) <= 0 && a[1] !== b[1])
        return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) > 0;
    }
    return null;
  };
  const dockLeft = layout([BODY[0] + 10, 600, 200, 300]).growths[0].curves[0];
  assert.equal(inside(dockLeft, BODY[0] + 60, TOP + 10), true);
  assert.equal(inside(dockLeft, BODY[0] - 20, TOP + 10), false);
  const corner = bodyCorner(30, SMOOTHING, 40);
  const bar = layoutGrowths([[0, 0, 600, 40]], [{ rect: [8, 30, 200, 300], radius: 12 }, { rect: [390, 30, 200, 300], radius: 12 }],
    { ...options, direction: 1, corner: () => corner }).growths;
  assert.equal(inside(bar[0].curves[0], 60, 30), true);
  assert.equal(inside(bar[0].curves[0], -20, 30), false);
  assert.equal(inside(bar[1].curves[1], 560, 30), true);
  assert.equal(inside(bar[1].curves[1], 620, 30), false);
  assert.deepEqual(bar[0].curves[0].clip, [40 - corner.reach, -1]);
});

test('moving a growth moves its curves with it', () => {
  const { growths: [g] } = rightSideIn(10);
  const moved = moveGrowth(g, -100, -50);
  const [c, m] = [g.curves[1], moved.curves[1]];
  assert.deepEqual(m.points[3], [c.points[3][0] - 100, c.points[3][1] - 50]);
  assert.deepEqual(m.clip, [c.clip[0] - 50, c.clip[1]]);
  assert.deepEqual(m.box, [c.box[0] - 100, c.box[1] - 50, c.box[2], c.box[3]]);
  assert.equal(moved.curves[0], null);
  assert.equal(moved.x, g.x - 100);
});
