const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createModuleLoader } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

function fixture() {
  let next = 1;
  const pending = new Map(), handlers = new Map(), errors = [];
  const laters = { add(_type, fn) { const id = next++; pending.set(id, fn); return id; }, remove(id) { pending.delete(id); } };
  const stage = { connect(name, fn) { const id = next++; handlers.set(id, { name, fn }); return id; },
    disconnect(id) { assert.ok(handlers.delete(id), 'disconnects a live handler'); } };
  const clock = { now: 0 };
  const load = createModuleLoader({
    GLib: { SOURCE_REMOVE: false, get_monotonic_time: () => clock.now }, Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    global: { compositor: { get_laters: () => laters }, stage },
    reportFrameLoopError: (tag, e) => errors.push([tag, String(e)]),
  });
  const loops = load(path.join(dist, 'animation.js'));
  const sync = load(path.join(dist, 'animation.js'));
  const run = () => { const cbs = [...pending.values()]; pending.clear(); cbs.forEach(fn => fn()); };
  const slot = () => { let id = 0; return { get: () => id, set: v => { id = v; } }; };
  const frame = () => { clock.now += 16000; for (const h of [...handlers.values()]) h.fn(); };
  return { loops, sync, pending, handlers, errors, run, slot, frame, clock };
}

test('a later loop keeps exactly one later, survives a throwing step and stops when no longer alive', () => {
  const f = fixture();
  const id = f.slot();
  let alive = true, steps = 0;
  const loop = { alive: () => alive, errorTag: 't', step: () => { steps++; if (steps === 2) throw new Error('boom'); } };
  assert.equal(f.loops.startLaterLoop(id, loop), true);
  assert.equal(f.loops.startLaterLoop(id, loop), false, 'a running loop is not started twice');
  for (let i = 0; i < 3; i++) f.run();
  assert.equal(steps, 3);
  assert.equal(f.pending.size, 1);
  assert.deepEqual(f.errors, [['t', 'Error: boom']]);
  alive = false;
  f.run();
  assert.equal(f.pending.size, 0);
  assert.equal(id.get(), 0);
});

test('only loops that honour the freeze pause while frame sync is frozen, and stopping cancels the later', () => {
  const f = fixture();
  const counts = [0, 0];
  const ids = [f.slot(), f.slot()];
  [true, false].forEach((honourFreeze, i) =>
    f.loops.startLaterLoop(ids[i], { alive: () => true, errorTag: 't', honourFreeze, step: () => counts[i]++ }));
  f.sync.setFrameSyncFrozen(true);
  try { f.run(); } finally { f.sync.setFrameSyncFrozen(false); }
  assert.deepEqual(counts, [0, 1]);
  assert.equal(f.pending.size, 2);
  f.loops.stopLaterLoop(ids[0]);
  f.loops.stopLaterLoop(ids[1]);
  assert.equal(f.pending.size, 0);
});

test('a stage loop runs once immediately and on every before-update, and stop disconnects both sources', () => {
  const f = fixture();
  const signal = f.slot(), first = f.slot();
  let ticks = 0;
  assert.equal(f.loops.startStageLoop(signal, first, () => ticks++), true);
  assert.equal(f.loops.startStageLoop(signal, first, () => ticks++), false);
  f.run();
  for (const h of f.handlers.values()) h.fn();
  assert.equal(ticks, 2);
  f.loops.startStageLoop(signal, first, () => {});
  f.loops.stopStageLoop(signal, first);
  assert.equal(f.handlers.size, 0, 'the before-update handler is disconnected');
  assert.equal(f.pending.size, 0);
  assert.equal(signal.get(), 0);
  assert.equal(first.get(), 0);
});

test('stopping or restarting a later loop from inside its own step is honoured', () => {
  const f = fixture();
  const id = f.slot();
  let steps = 0;
  const loop = { alive: () => true, errorTag: 't', step: () => { steps++; f.loops.stopLaterLoop(id); } };
  f.loops.startLaterLoop(id, loop);
  f.run();
  assert.equal(f.pending.size, 0, 'a stop from inside the step cancels the next frame');
  f.run();
  assert.equal(steps, 1);
  const again = f.slot();
  let runs = 0;
  const restarting = { alive: () => true, errorTag: 't', step: () => { runs++; f.loops.startLaterLoop(again, restarting); } };
  f.loops.startLaterLoop(again, restarting);
  for (let i = 0; i < 3; i++) f.run();
  assert.equal(runs, 3, 'a start from inside the step does not add a second loop');
  assert.equal(f.pending.size, 1);
});

test('a sync loop survives a throwing step and stops itself once no longer alive', () => {
  const f = fixture();
  const signal = f.slot(), first = f.slot();
  let alive = true, steps = 0;
  f.loops.startSyncLoop(signal, first, { alive: () => alive, errorTag: 'sync',
    step: () => { steps++; if (steps === 1) throw new Error('boom'); } });
  f.clock.now += 16000;
  f.run();
  f.frame();
  assert.equal(steps, 2);
  assert.deepEqual(f.errors, [['sync', 'Error: boom']]);
  alive = false;
  f.frame();
  assert.equal(steps, 2);
  assert.equal(f.handlers.size, 0);
  assert.equal(signal.get(), 0);
});
