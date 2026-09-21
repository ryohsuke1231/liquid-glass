const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { loadModule } = require('./helpers/load-module.cjs');

function fixture() {
  class Actor {
    constructor(params = {}) { this._init(params); }
    _init(params = {}) {
      Object.assign(this, { visible: true, mapped: true, handlers: new Map(),
        nextId: 1, children: [], parent: null }, params);
    }
    connect(name, fn) { const id = this.nextId++; this.handlers.set(id, { name, fn }); return id; }
    disconnect(id) { assert.ok(this.handlers.delete(id)); }
    get_parent() { return this.parent; }
    get_children() { return [...this.children]; }
    get_name() { return this.name; }
    set_name(name) { this.name = name; }
    add_child(child) { child.parent = this; this.children.push(child); }
    destroy() {
      for (const h of [...this.handlers.values()]) if (h.name === 'destroy') h.fn();
      for (const child of [...this.children]) child.destroy();
      this.handlers.clear();
      this.children = [];
      this.destroyed = true;
    }
  }
  const uiGroup = new Actor(), self = new Actor(), content = new Actor();
  uiGroup.add_child(self);
  uiGroup.add_child(content);
  const monitors = new Set();
  const bindings = {
    GObject: { registerClass: (...args) => args.at(-1), Object,
      ParamSpec: { object() {}, double() {}, boolean() {}, int() {} },
      ParamFlags: { READWRITE: 0 } },
    Clutter: { Actor, Clone: Actor, Effect: Actor, ShaderEffect: Actor, Constraint: Actor },
    St: { Widget: Actor }, Shell: { util_set_hidden_from_pick(actor, hidden) { actor.hiddenFromPick = hidden; } },
    Main: { layoutManager: { uiGroup } },
    DND: { DragMotionResult: { CONTINUE: 3 },
      addDragMonitor(m) { monitors.add(m); }, removeDragMonitor(m) { monitors.delete(m); } },
    GLib: { get_monotonic_time: () => 0 }, Meta: {},
  };
  const utils = loadModule(path.join(dist, 'utils.js'), bindings);
  const classes = Object.fromEntries(['UILayerSampler', 'UnpickableActor', 'UnpickableClone',
    'UnpickableWidget', 'UnpickableStyledWidget', 'TextureBlitActor', 'LayoutOpaqueActor']
    .map(name => [name, utils[name]]));
  const sampler = new classes.UILayerSampler(self, self);
  sampler._resolveBmsTargetActor = () => null;
  sampler._containsOtherLiquidGlassRoot = () => false;
  sampler._findBmsDescendant = () => null;
  sampler._insertCloneInZOrder = () => {};
  sampler._reportClonedSet = () => {};
  sampler._reportClonedWindowGroups = () => {};
  return { sampler, content, monitors, classes };
}

test('100 menu hide/show cycles do not accumulate source destroy handlers', () => {
  const { sampler, content, monitors } = fixture();
  for (let i = 0; i < 100; i++) {
    content.visible = true;
    sampler.refresh();
    sampler.refresh();
    assert.equal(content.handlers.size, 1);
    content.visible = false;
    sampler.refresh();
    assert.equal(content.handlers.size, 0);
  }
  content.visible = true;
  sampler.refresh();
  sampler.destroy();
  assert.equal(content.handlers.size, 0);
  assert.equal(monitors.size, 0);
  assert.equal(sampler._clones.size, 0);
});

test('drag actor is excluded from glass and drag motion continues to the dock', () => {
  const { sampler, content, monitors } = fixture();
  sampler.refresh();
  assert.equal(sampler._clones.has(content), true);
  for (const monitor of monitors)
    assert.equal(monitor.dragMotion({ dragActor: content }), 3);
  sampler.refresh();
  assert.equal(sampler._clones.has(content), false);
  assert.equal(content.handlers.size, 0);
  assert.equal(content.destroyed, undefined);
  assert.equal(content.visible, true);
  sampler.destroy();
  assert.equal(monitors.size, 0);
});

test('source destruction releases tracking and its clone', () => {
  const { sampler, content } = fixture();
  sampler.refresh();
  const clone = sampler._clones.get(content);
  content.destroy();
  assert.equal(clone.destroyed, true);
  assert.equal(sampler._sourceDestroyIds.size, 0);
  assert.equal(sampler._clones.size, 0);
  assert.doesNotThrow(() => sampler.destroy());
});

test('glass actors use the native hidden-from-pick flag used by GNOME drag and drop', () => {
  const { classes, sampler } = fixture();
  for (const [name, Class] of Object.entries(classes)) {
    if (name === 'UILayerSampler') continue;
    assert.equal(new Class().hiddenFromPick, true, name);
  }
  sampler.destroy();
});

test('disabled diagnostic recorder has no timer and re-arming cannot multiply timers', () => {
  const pending = new Map(); let next = 1;
  const GLib = { PRIORITY_DEFAULT_IDLE: 0, SOURCE_CONTINUE: true,
    timeout_add(_, __, fn) { const id = next++; pending.set(id, fn); return id; },
    Source: { remove(id) { assert.ok(pending.delete(id)); } } };
  const ring = loadModule(path.join(dist, 'diagnostics/glass.js'), { GLib });
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
