const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(monitor) {
  const pending = new Map();
  let next = 1;
  const laters = {
    add(_, fn) { const id = next++; pending.set(id, fn); return id; },
    remove(id) { pending.delete(id); },
  };
  class Actor {
    constructor() {
      Object.assign(this, { width: 0, height: 0, x: 0, y: 0, children: [],
        handlers: new Map(), mapped: true, opacity: 255, visible: true });
    }
    set_name(name) { this.name = name; }
    get_name() { return this.name; }
    get_parent() { return this.parent; }
    get_children() { return this.children; }
    add_child(actor) { actor.parent = this; this.children.push(actor); }
    insert_child_below(actor) { this.add_child(actor); }
    get_size() { return [this.width, this.height]; }
    set_size(width, height) { this.width = width; this.height = height; }
    set_position(x, y) { this.x = x; this.y = y; }
    get_transformed_position() { return [this.x, this.y]; }
    set_clip_to_allocation() {}
    set_opacity(value) { this.opacity = value; }
    set_clip() {}
    add_effect() {}
    remove_transition() {}
    add_style_class_name() {}
    remove_style_class_name() {}
    has_style_class_name() { return false; }
    get_style() { return ''; }
    set_style() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; }
    connect(name, fn) { const id = next++; this.handlers.set(id, { name, fn }); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(); }
  }
  const group = new Actor(), root = new Actor(), target = new Actor();
  group.add_child(root);
  root.add_child(target);
  target.set_size(1000, 80);
  target.set_position(monitor.x + 300, monitor.y + monitor.height - 90);
  class Effect {
    setPadding() {} setTintColor() {} setTintStrength() {} setCornerRadius() {}
    setBrightness() {} setContrast() {} setSaturation() {} setBlurRadius() {}
    setIsDock() {} setShadowMaxRadius() {} setResolution() {} setGlassGeometry() {}
    cleanup() { this.cleaned = true; }
  }
  class Sampler {
    addExclusion() {} rebuildClones() {} rebindSelf() {} refresh() {} sync() {}
    setOffset() {} destroy() { this.destroyed = true; }
  }
  const bindings = {
    Main: { layoutManager: { uiGroup: group, primaryIndex: 0,
      primaryMonitor: monitor, monitors: [monitor], findIndexForActor: () => 0 } },
    GLib: { SOURCE_REMOVE: false }, Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    global: { compositor: { get_laters: () => laters } },
    UnpickableActor: Actor, LiquidEffect: Effect,
    WindowCloneManager: Sampler, UILayerSampler: Sampler,
    ensureGlassAllocated() {}, isFrameSyncFrozen: () => false,
    isActorValid: actor => !!actor && !actor.destroyed,
    reportFrameLoopError(_, error) { throw error; }, syncGlassCaptureClip() {},
    setClipIfChanged(actor, ...args) { actor.set_clip(...args); },
  };
  const code = fs.readFileSync(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/dockManager.js'), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace('export class DashManager', 'class DashManager');
  const Manager = new Function(...Object.keys(bindings), `${code}; return DashManager;`)(...Object.values(bindings));
  const settings = { get_int: () => 0, get_double: () => 0,
    get_string: () => '#ffffff', get_boolean: () => false };
  const manager = new Manager('/ext', target, settings, { log() {}, error() {} });
  manager._findReferenceActor = () => null;
  return { manager, target, pending };
}

for (const monitor of [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1920, height: 1200 },
  { x: -1920, y: -120, width: 1920, height: 1200 },
]) {
  test(`re-enabling dock glass recreates full-size capture at ${monitor.x},${monitor.y}`, () => {
    const { manager } = fixture(monitor);
    for (let cycle = 0; cycle < 3; cycle++) {
      manager._applyEffect();
      manager._syncGeometry();
      assert.deepEqual(manager.bgActor.get_size(), [monitor.width, monitor.height]);
      assert.deepEqual(manager.liquidBox.get_size(), [monitor.width, monitor.height]);
      assert.deepEqual(manager.bgActor.get_transformed_position(), [monitor.x, monitor.y]);
      manager._removeEffect();
    }
  });
}

test('monitor origin changes update the capture even when dock bounds stay unchanged', () => {
  const monitor = { x: 1920, y: 0, width: 1920, height: 1200 };
  const { manager } = fixture(monitor);
  manager._applyEffect();
  manager._syncGeometry();
  monitor.x += 100;
  manager._syncGeometry();
  assert.equal(manager.bgActor.x, monitor.x);
});

test('rapid dock hide/show keeps exactly one pending render callback', () => {
  const { manager, target, pending } = fixture({ x: 0, y: 0, width: 1920, height: 1080 });
  manager._applyEffect();
  for (let i = 0; i < 5; i++) {
    target.mapped = false;
    target.emit('notify::mapped');
    assert.equal(pending.size, 0);
    target.mapped = true;
    target.emit('notify::mapped');
    assert.equal(pending.size, 1);
  }
  manager._removeEffect();
  assert.equal(pending.size, 0);
});

test('a failing target style cannot leave capture actors, effects or callbacks behind', () => {
  const { manager, target, pending } = fixture({ x: 0, y: 0, width: 1920, height: 1080 });
  manager._applyEffect();
  const { bgActor, effect, _uiSampler, _windowCloneManager } = manager;
  target.remove_style_class_name = () => { throw new Error('target no longer usable'); };
  manager._removeEffect();
  assert.equal(pending.size, 0);
  assert.equal(target.handlers.size, 0);
  assert.equal(bgActor.destroyed, true);
  assert.equal(effect.cleaned, true);
  assert.equal(_uiSampler.destroyed, true);
  assert.equal(_windowCloneManager.destroyed, true);
  assert.equal(manager.bgActor, null);
  assert.doesNotThrow(() => manager._removeEffect());
});
