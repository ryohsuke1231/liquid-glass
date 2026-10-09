const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { MenuMorphMotion } = loadModule(path.join(dist, 'animation/menuMorph.js'), {});

// The date button in the middle of the top bar and the calendar under it.
const BUTTON = [860, 4, 200, 26];
const MENU = [610, 40, 700, 420];
const RADIUS = 20;
const centre = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const near = (a, b, within) => a.every((v, i) => Math.abs(v - b[i]) <= within);
const fixed = (...values) => () => values.length > 1 ? values.shift() : values[0];

// Steps at 60 fps until done (or 3 s), calling `each` with every frame and its time.
function run(motion, each = () => {}) {
  let frame = motion.frame;
  for (let t = 1 / 60; t < 3; t += 1 / 60) {
    frame = motion.step(1 / 60);
    each(frame, t);
    if (frame.done) return { frame, t };
  }
  return { frame, t: Infinity };
}

test('opening starts as the button\'s capsule and comes to rest on the menu', () => {
  const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  const first = motion.frame;
  assert.ok(near(first.body, BUTTON, 0), `body ${first.body}`);
  assert.equal(first.bodyRadius, BUTTON[3] / 2);
  assert.ok(first.contentOpacity === 0 && first.lens === 1);

  const { frame, t } = run(motion);
  assert.ok(t < 1.6, `took ${t}s`);
  assert.ok(near(frame.body, MENU, 0.5), `body ${frame.body}`);
  assert.equal(frame.bodyRadius, RADIUS);
  assert.equal(frame.contentScale, 1);
  assert.ok(frame.contentOpacity > 0.99 && frame.lens === 0 && frame.glassOpacity === 1);
});

test('the capsule draws into a round drop as it drops out of the button', () => {
  const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  const frames = [];
  run(motion, (f, t) => frames.push({ f, t }));
  const { f: drop, t } = frames.filter(({ t }) => t <= 0.14).pop();
  const [x, y, w, h] = drop.body;
  assert.ok(Math.abs(w - h) < 3 && Math.abs(h - BUTTON[3] * 1.15) < 1, `drop ${drop.body}`);
  assert.equal(drop.bodyRadius, Math.min(w, h) / 2);
  // Straight down, twice its height below the button.
  const fall = BUTTON[3] * 2 * (t / 0.14) ** 1.5;
  assert.ok(near(centre([x, y, w, h]), [centre(BUTTON)[0], centre(BUTTON)[1] + fall], 0.5), `drop ${drop.body}`);
  // Still a capsule halfway down.
  const half = frames.filter(({ t }) => t <= 0.07).pop().f;
  assert.ok(half.body[2] > half.body[3] * 2, `halfway ${half.body}`);
  // Always one round body: never rounder than it can be, never a corner sharper than the menu's.
  for (const { f } of frames) {
    assert.ok(f.bodyRadius <= Math.min(f.body[2], f.body[3]) / 2 + 1e-9);
    assert.ok(f.bodyRadius >= Math.min(RADIUS, f.body[2] / 2, f.body[3] / 2) - 1e-9, `${f.body} ${f.bodyRadius}`);
  }
});

test('the grown glass does not shoot back up over the menu', () => {
  for (const random of [fixed(0.5, 1), fixed(0, 0), fixed(1, 1)]) {
    const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS, null, null, random);
    let grownTop = null, highest = Infinity;
    run(motion, f => {
      if (f.body[3] < MENU[3] - 0.5) return;
      grownTop ??= f.body[1];
      highest = Math.min(highest, f.body[1]);
    });
    assert.ok(grownTop - MENU[1] < 20, `grown ${grownTop - MENU[1]}px below the menu's top`);
    assert.ok(highest > MENU[1] - 4, `up to ${MENU[1] - highest}px over the menu's top`);
  }
});

test('each opening is pushed somewhere downwards, never far', () => {
  const path = random => {
    const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS, null, null, random);
    const centres = [];
    run(motion, f => centres.push(centre(f.body)));
    return centres;
  };
  // Where it would be without a push: pushed straight down it does not go
  // aside, and pushed straight aside it falls as if it were not pushed.
  const down = path(fixed(0.5, 1)), aside = path(fixed(0, 1));
  const still = down.map((c, i) => [c[0], aside[Math.min(i, aside.length - 1)][1]]);
  const target = centre(MENU);
  for (const [angle, strength] of [[0, 1], [0.5, 1], [1, 1], [0.25, 0.4], [0.9, 0]]) {
    const pushed = path(fixed(angle, strength));
    // The furthest it goes from where it would have been is aside or down,
    // and no more than about 6% of the menu's shorter side.
    let furthest = [0, 0];
    pushed.forEach((c, i) => {
      const off = [c[0] - still[Math.min(i, still.length - 1)][0], c[1] - still[Math.min(i, still.length - 1)][1]];
      if (Math.hypot(...off) > Math.hypot(...furthest)) furthest = off;
    });
    assert.ok(Math.hypot(...furthest) <= 0.07 * MENU[3], `angle ${angle} strength ${strength}: ${furthest}`);
    assert.ok(furthest[1] >= -0.5, `angle ${angle}: ${furthest}`);
    if (strength > 0.3 && angle > 0) assert.ok(Math.hypot(...furthest) > 5, `angle ${angle}: only ${furthest}`);
    assert.ok(near(pushed[pushed.length - 1], target, 0.5));
  }
});

test('closing stays in sight until it is the button\'s capsule, then fades out', () => {
  const motion = new MenuMorphMotion(false, BUTTON, MENU, RADIUS);
  assert.ok(near(motion.frame.body, MENU, 0), `body ${motion.frame.body}`);
  let capsuleAt = null, fadingAt = null, opacityAtCapsule = null;
  const { frame, t } = run(motion, (f, time) => {
    if (fadingAt === null && f.glassOpacity < 1) fadingAt = time;
    if (capsuleAt === null && near(f.body, BUTTON, 0.01)) {
      capsuleAt = time;
      opacityAtCapsule = f.glassOpacity;
    }
    // One body: never taller than the button once it is down there.
    if (capsuleAt !== null) assert.ok(f.body[3] <= BUTTON[3] + 0.01);
  });
  assert.ok(capsuleAt !== null && capsuleAt < 0.8, `capsule at ${capsuleAt}`);
  assert.ok(t < 0.9, `took ${t}s`);
  assert.equal(frame.glassOpacity, 0);
  assert.ok(fadingAt < capsuleAt, `fades from ${fadingAt}s, on the button at ${capsuleAt}s`);
  assert.ok(opacityAtCapsule >= 0.85, `${opacityAtCapsule} when it is the capsule`);
  assert.ok(t - capsuleAt <= 0.12, `${t - capsuleAt}s on the button`);
});

test('opening, the corners square off while the glass grows, not after', () => {
  const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  let grown = null;
  run(motion, (f, t) => {
    if (grown === null && f.body[2] >= MENU[2] - 0.01) grown = { t, radius: f.bodyRadius };
  });
  assert.ok(Math.abs(grown.radius - RADIUS) < 0.01, `radius ${grown.radius} when grown at ${grown.t}s`);
});

test('closing, the drop widens into the capsule while it is still rising', () => {
  const motion = new MenuMorphMotion(false, BUTTON, MENU, RADIUS);
  let widening = null;
  run(motion, (f, t) => {
    if (widening === null && t > 0.25 && f.body[2] > BUTTON[3] * 1.15 + 2) widening = f;
  });
  const below = centre(widening.body)[1] - centre(BUTTON)[1];
  assert.ok(below > 10, `starts widening ${below}px below the button`);
});

test('reversing midway carries on from where the glass is', () => {
  const opening = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  let frame;
  for (let i = 0; i < 20; i++) frame = opening.step(1 / 60);
  const closing = new MenuMorphMotion(false, BUTTON, MENU, RADIUS, frame, opening.velocities);
  const next = closing.step(1 / 60);
  assert.ok(near(next.body, frame.body, 70), `${frame.body} -> ${next.body}`);
  assert.ok(Math.abs(next.contentScale - frame.contentScale) < 0.1);
  assert.ok(run(closing).frame.done);

  const back = new MenuMorphMotion(true, BUTTON, MENU, RADIUS, next, closing.velocities);
  const again = back.step(1 / 60);
  assert.ok(near(again.body, next.body, 70), `${next.body} -> ${again.body}`);
  assert.ok(near(run(back).frame.body, MENU, 0.5));
});

test('the glass never jumps from one frame to the next', () => {
  for (const opening of [true, false]) {
    const motion = new MenuMorphMotion(opening, BUTTON, MENU, RADIUS, null, null, fixed(0.2, 1));
    let last = motion.frame;
    run(motion, f => {
      for (let i = 0; i < 4; i++) {
        // The body grows fastest at the end of its 0.3 s ease: about 3.4x its mean rate.
        assert.ok(Math.abs(f.body[i] - last.body[i]) < 120, `${opening} ${last.body} -> ${f.body}`);
      }
      last = f;
    });
  }
});
