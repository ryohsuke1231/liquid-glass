const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

function fixture() {
  let now = 0;
  const pending = new Map();
  let next = 1;
  const laters = {
    add(_type, fn) { const id = next++; pending.set(id, fn); return id; },
    remove(id) { pending.delete(id); },
  };
  const errors = [];
  const ticker = loadModule(path.join(dist, 'animation.js'), {
    Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    GLib: { get_monotonic_time: () => now, SOURCE_REMOVE: false },
    global: { compositor: { get_laters: () => laters } },
    reportFrameLoopError: (tag, e) => errors.push([tag, e]),
  });
  const frame = (ms = 16.667) => {
    now += Math.round(ms * 1000);
    const due = [...pending.entries()];
    pending.clear();
    for (const [, fn] of due) fn();
  };
  return { ticker, frame, pending, errors };
}

test('a ticker runs at most once per frame and stops when the callback returns false', () => {
  const { ticker, frame, pending } = fixture();
  let calls = 0;
  ticker.addFrameTicker(() => ++calls < 3);
  assert.equal(calls, 0);
  assert.equal(pending.size, 1);
  for (let i = 0; i < 10; i++) frame();
  assert.equal(calls, 3);
  assert.equal(pending.size, 0);
});

test('removing a ticker cancels its pending frame', () => {
  const { ticker, frame, pending } = fixture();
  let calls = 0;
  const id = ticker.addFrameTicker(() => { calls++; return true; });
  frame(); frame();
  ticker.removeFrameTicker(id);
  assert.equal(pending.size, 0);
  frame();
  assert.equal(calls, 2);
  ticker.removeFrameTicker(id);
});

test('a minimum interval caps the rate but tolerates frame jitter', () => {
  const { ticker, frame } = fixture();
  let calls = 0;
  ticker.addFrameTicker(() => { calls++; return true; }, 33);
  for (let i = 0; i < 60; i++) frame(i % 2 ? 16.9 : 16.4);
  assert.equal(calls, 30);
  let every = 0;
  ticker.addFrameTicker(() => { every++; return true; }, 16);
  for (let i = 0; i < 60; i++) frame(15.9);
  assert.equal(every, 60);
});

test('a throwing callback is reported and not rescheduled', () => {
  const { ticker, frame, pending, errors } = fixture();
  ticker.addFrameTicker(() => { throw new Error('boom'); });
  frame();
  assert.equal(pending.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'frameTicker');
});

test('interval settings up to one 60Hz frame mean every frame, larger ones are a bounded cap', () => {
  const { ticker } = fixture();
  for (const v of [0, 1, 8, 16, NaN, -5]) assert.equal(ticker.normalizeAnimationIntervalMs(v), 0);
  assert.equal(ticker.normalizeAnimationIntervalMs(33), 33);
  assert.equal(ticker.normalizeAnimationIntervalMs(1000), 50);
});

test('a second stage view updating in the same frame does not step the animation again', () => {
  const { ticker, frame } = fixture();
  let calls = 0;
  ticker.addFrameTicker(() => { calls++; return true; });
  for (let i = 0; i < 10; i++) { frame(16.667); frame(1); }
  assert.equal(calls, 10);
});
