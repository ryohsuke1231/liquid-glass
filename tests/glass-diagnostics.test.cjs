const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { loadModule } = require('./helpers/load-module.cjs');

test('helper actors use the native hidden-from-pick flag used by GNOME drag and drop', () => {
  class Actor {
    constructor(params = {}) { this._init(params); }
    _init(params = {}) { Object.assign(this, params); }
  }
  const unpickable = loadModule(path.join(dist, 'actors.js'), {
    GObject: { registerClass: (...args) => args.at(-1) },
    Clutter: { Actor }, St: { Widget: Actor },
    Shell: { util_set_hidden_from_pick(actor, hidden) { actor.hiddenFromPick = hidden; } },
  });
  for (const name of ['UnpickableActor', 'UnpickableWidget', 'LayoutOpaqueActor'])
    assert.equal(new unpickable[name]().hiddenFromPick, true, name);
});

test('disabled diagnostic recorder has no timer and re-arming cannot multiply timers', () => {
  const pending = new Map(); let next = 1;
  const GLib = { PRIORITY_DEFAULT_IDLE: 0, SOURCE_CONTINUE: true,
    timeout_add(_, __, fn) { const id = next++; pending.set(id, fn); return id; },
    Source: { remove(id) { assert.ok(pending.delete(id)); } } };
  const ring = loadModule(path.join(dist, 'diagnostics.js'), { GLib });
  ring.startGlassRingSampler();
  assert.equal(pending.size, 0);
  ring.setGlassRingArmed(true);
  ring.setGlassRingArmed(true);
  assert.equal(pending.size, 1);
  ring.setGlassRingArmed(false);
  assert.equal(pending.size, 0);
  ring.setGlassRingArmed(true);
  ring.stopGlassRingSampler();
  assert.equal(pending.size, 0);
  ring.setGlassRingArmed(true);
  assert.equal(pending.size, 0);
  ring.startGlassRingSampler();
  assert.equal(pending.size, 1);
  ring.stopGlassRingSampler();
  assert.equal(pending.size, 0);
});
