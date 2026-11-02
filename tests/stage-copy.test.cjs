const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const IN = 0, PART = 1;

function fixture(layout, scale, fbSize) {
  const blits = [];
  class Offscreen { static new_with_texture() { return { allocate() {} }; } }
  class Rectangle { constructor(r) { Object.assign(this, r); } }
  const handlers = new Map();
  const stage = { connect: (name, handler) => { handlers.set(name, handler); return handlers.size; }, disconnect() {} };
  const { StageCopier, trackViewPaints } = loadModule(path.join(dist, 'rendering/backdropGlass.js'), {
    global: { stage },
    Clutter: { BlitNode: { new: () => ({ add_blit_rectangle: (...r) => blits.push(r) }) } },
    Cogl: { Offscreen, Texture2D: { new_with_size: (_ctx, w, h) => ({ w, h }) } },
    Mtk: { Rectangle, RegionOverlap: { IN, PART } },
    coglContext: () => ({}),
    newRootNode: () => ({ add_child() {} }),
    offscreenFormat: () => null,
  });
  const fb = { get_width: () => fbSize[0], get_height: () => fbSize[1] };
  const view = { layout, get_scale: () => scale, get_framebuffer: () => fb, color_state: null };
  // A full redraw: the clip is the view's rect in stage coordinates.
  const clip = { contains_rectangle: r => r.x >= layout.x && r.y >= layout.y
    && r.x + r.width <= layout.x + layout.width && r.y + r.height <= layout.y + layout.height ? IN : PART };
  const actor = { is_in_clone_paint: () => false, peek_stage_views: () => [view] };
  const paint = { framebufferReads: 0, get_framebuffer() { this.framebufferReads++; return fb; }, get_redraw_clip: () => clip };
  const copier = new StageCopier();
  const take = rect => copier.take(actor, { add_child() {} }, paint, rect);
  trackViewPaints();
  handlers.get('before-paint')(stage, view);
  const endPaint = () => handlers.get('after-paint')(stage, view);
  return { take, blits, paint, endPaint };
}

test('glass at the edge of a fractionally scaled monitor off the stage origin is still copied', () => {
  // 2560x1600 at 133 %, right of a 1920 px wide monitor; the dock's glass runs past its bottom edge.
  const f = fixture({ x: 1920, y: 0, width: 1920, height: 1200 }, 1.3333333730697632, [2560, 1600]);
  const { copy, missed, fresh } = f.take([2615, 1000, 3144, 1250]);
  assert.ok(fresh && !missed && copy);
  const [x, y, , , w, h] = f.blits[0];
  assert.ok(x >= 0 && y >= 0 && x + w <= 2560 && y + h <= 1600, `blit ${f.blits[0]}`);
  assert.equal(y + h, 1600);
  // A menu at the right edge.
  assert.ok(f.take([3500, 0, 3900, 400]).fresh);
});

test('a whole-number scale copies the rect as it is', () => {
  const f = fixture({ x: 0, y: 0, width: 1920, height: 1080 }, 1, [1920, 1080]);
  assert.ok(f.take([100, 980, 900, 1100]).fresh);
  assert.deepEqual(f.blits[0], [100, 980, 0, 0, 800, 100]);
});

test('a paint outside a frame of the view (a screenshot) draws the last copy and leaves its framebuffer alone', () => {
  const f = fixture({ x: 0, y: 0, width: 1920, height: 1080 }, 1, [1920, 1080]);
  const first = f.take([100, 980, 900, 1080]);
  assert.ok(first.fresh);
  f.endPaint();
  const reads = f.paint.framebufferReads;
  const shot = f.take([100, 980, 900, 1080]);
  assert.ok(!shot.fresh && !shot.missed);
  assert.equal(shot.copy, first.copy);
  assert.equal(f.blits.length, 1);
  assert.equal(f.paint.framebufferReads, reads);
});
