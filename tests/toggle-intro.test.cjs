const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { ToggleIntro, introProgress, MIN_GLASS_GAP } = loadModule(path.join(dist, 'animation.js'), {});

// Quick Settings as laid out: the system buttons, a slider and two rows of toggles, 12px apart.
const RECTS = [[0, 0, 80, 40], [100, 0, 40, 40], [150, 0, 40, 40], [200, 0, 40, 40], [250, 0, 40, 40],
  [0, 52, 290, 40], [0, 104, 139, 48], [151, 104, 139, 48], [0, 164, 139, 48], [151, 164, 139, 48]];
const ANCHOR = [270, -30];

// How far apart two rects are; corner to corner for rects side by side diagonally.
function gap(a, b) {
  const gx = Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]);
  const gy = Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]);
  return gx > 0 && gy > 0 ? Math.hypot(gx, gy) : Math.max(gx, gy);
}

test('the spring goes past the end once, a little, and does not swing back noticeably', () => {
  let peak = 0, peakAt = 0;
  for (let t = 0; t < 1; t += 0.002) {
    const p = introProgress(t);
    if (p > peak) [peak, peakAt] = [p, t];
  }
  assert.ok(peak > 1.02 && peak < 1.1, `peak ${peak}`);
  for (let t = peakAt; t < 1; t += 0.002)
    assert.ok(introProgress(t) > 0.99, `${t}: ${introProgress(t)}`);
});

test('the buttons start small, gathered to the middle, with their content hidden, and end where they are', () => {
  const intro = new ToggleIntro(RECTS, ANCHOR, 0);
  const first = intro.frame(0);
  first.rects.forEach((r, i) => assert.ok(Math.abs(r[2] / RECTS[i][2] - 0.7) < 0.01, `button ${i} starts at ${r[2]}`));
  assert.deepEqual(first.opacity, RECTS.map(() => 0));
  assert.equal(first.done, false);
  const last = intro.frame(1);
  assert.equal(last.done, true);
  last.rects.forEach((r, i) => r.forEach((v, k) => assert.ok(Math.abs(v - RECTS[i][k]) < 0.5, `button ${i}: ${r}`)));
  last.opacity.forEach((o, i) => assert.ok(o > 0.999, `button ${i}: ${o}`));
});

test('buttons nearer the panel button come out first', () => {
  const intro = new ToggleIntro(RECTS, ANCHOR, 0);
  const f = intro.frame(0.06);
  // The power button, under the panel button, against the toggle at the bottom left.
  assert.ok(f.rects[4][2] / RECTS[4][2] > f.rects[8][2] / RECTS[8][2]);
  assert.ok(f.opacity[4] > f.opacity[8]);
});

test('every button starts to grow in the first frame', () => {
  for (const expand of [0, 5]) {
    const intro = new ToggleIntro(RECTS, ANCHOR, expand);
    const [a, b] = [intro.frame(0), intro.frame(1 / 60)];
    a.rects.forEach((r, i) => assert.ok(b.rects[i][2] > r[2] + 0.1, `expand ${expand}, button ${i}: ${r[2]} -> ${b.rects[i][2]}`));
  }
});

test('no button gets smaller on its way out, and none jumps from one frame to the next', () => {
  for (const expand of [0, 3, 5]) {
    const intro = new ToggleIntro(RECTS, ANCHOR, expand);
    let prev = null;
    for (let k = 0; k < 40; k++) {
      const widths = intro.frame(k / 60).rects.map(r => r[2]);
      prev?.forEach((w, i) => {
        const at = `expand ${expand}, frame ${k}, button ${i}: ${w} -> ${widths[i]}`;
        if (widths[i] < RECTS[i][2] * 0.99) assert.ok(widths[i] > w - 0.3, at);
        assert.ok(Math.abs(widths[i] - w) < RECTS[i][2] * 0.1, at);
      });
      prev = widths;
    }
  }
});

test('the glass of two buttons never comes closer than the least gap, nor than at rest', () => {
  for (const expand of [0, 3, 5]) {
    const intro = new ToggleIntro(RECTS, ANCHOR, expand);
    for (let t = 0; t <= 0.6; t += 0.002) {
      const { rects } = intro.frame(t);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const rest = gap(RECTS[i], RECTS[j]);
          if (rest < 2 * expand) continue;
          const least = Math.min(rest, 2 * expand + MIN_GLASS_GAP);
          assert.ok(gap(rects[i], rects[j]) >= least - 1e-6,
            `expand ${expand}, t ${t.toFixed(3)}: buttons ${i} and ${j} ${gap(rects[i], rects[j])} apart`);
        }
      }
    }
  }
});
