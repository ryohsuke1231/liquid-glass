const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  let clock = 0;
  const laters = { added: 0, add() { this.added++; return this.added; }, remove() {} };
  const stage = {
    handlers: new Map(),
    next: 1,
    connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; },
    disconnect(id) { this.handlers.delete(id); },
    emit(name) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(); },
  };
  const settings = {
    get_boolean: () => false, get_strv: () => [], get_double: () => 1.0,
    get_int: () => 0, get_string: () => '#ffffff', connect: () => 1, disconnect() {},
  };
  const code = fs.readFileSync(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/applicationManager.js'), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export class /g, 'class ');
  const bindings = {
    Meta: { WindowType: {}, LaterType: { BEFORE_REDRAW: 0 } },
    Main: { layoutManager: { primaryMonitor: { width: 1920, height: 1080 } } },
    GLib: { idle_add: () => 1, Source: { remove() {} }, SOURCE_REMOVE: false, PRIORITY_DEFAULT_IDLE: 0,
      get_monotonic_time: () => (clock += 20000) },
    SAME_FRAME_WINDOW_US: 4000,
    global: { stage, compositor: { get_laters: () => laters } },
    isFrameSyncFrozen: () => false,
    ensureWindowActorAllocated: () => null,
    ensureGlassAllocated: () => {},
  };
  const C = new Function(...Object.keys(bindings), `${code}\nreturn ApplicationManager;`)(...Object.values(bindings));
  const manager = new C('/ext', settings, { log() {}, error() {} });
  return { manager, stage, laters };
}

test('window glass follows compositor frames instead of requesting them', () => {
  const { manager, stage, laters } = fixture();
  let ticks = 0;
  manager._frameTick = () => { ticks++; };

  manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
  assert.equal(ticks, 1);
  assert.equal(laters.added, 0);

  for (let i = 0; i < 100; i++) stage.emit('before-update');
  assert.equal(ticks, 101);
  assert.equal(laters.added, 0);
});

test('repeated starts keep exactly one frame observer and stopping removes it', () => {
  const { manager, stage } = fixture();
  manager._frameTick = () => {};
  for (let i = 0; i < 5; i++) manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
  manager._stopFrameSync();
  assert.equal(stage.handlers.size, 0);
  manager._stopFrameSync();
  assert.equal(stage.handlers.size, 0);
  manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
});

test('a torn-down manager stops syncing even if frames keep arriving', () => {
  const { manager, stage } = fixture();
  let syncs = 0;
  const windowActor = { get_meta_window: () => ({ get_title: () => 'window' }) };
  manager._states.set(windowActor, { windowActor, effect: {} });
  manager._syncState = () => { syncs++; };
  manager._startFrameSync();
  stage.emit('before-update');
  assert.ok(syncs > 0);
  const seen = syncs;
  manager._torndown = true;
  stage.emit('before-update');
  assert.equal(syncs, seen);
});
