const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Same trick as panel-notification.test.cjs: run the built class against
// stubbed shell actors, no GNOME session required.
function loadClass(file, name, bindings) {
  const code = fs.readFileSync(path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist', file), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export class /g, 'class ');
  return new Function(...Object.keys(bindings), `${code}\nreturn ${name};`)(...Object.values(bindings));
}

class Signals {
  handlers = new Map();
  next = 1;
  connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { assert.ok(this.handlers.delete(id), `unknown signal ${id}`); }
  emit(name, ...args) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

// Records every key read, so a test can assert which namespace was used.
class RecordingSettings extends Signals {
  reads = [];
  get_boolean(k) { this.reads.push(k); return false; }
  get_int(k) { this.reads.push(k); return 0; }
  get_double(k) { this.reads.push(k); return 1.0; }
  get_string(k) { this.reads.push(k); return '#ffffff'; }
  get_strv(k) { this.reads.push(k); return []; }
  set_strv() { }
}

// Minimal stand-in for a Clutter actor that can sit in a Group.
function actorStub(name = 'actor', extra = {}) {
  return Object.assign(new Signals(), {
    name,
    parent: null,
    get_parent() { return this.parent; },
    set_pivot_point() { },
    set_scale() { },
    get_size() { return [100, 100]; },
    get_preferred_height() { return [100, 100]; },
  }, extra);
}

// A uiGroup whose child order is observable, with just the reordering API
// _restackGlass() uses.
class Group {
  children = [];
  add_child(a) { this.children.push(a); a.parent = this; }
  insert_child_below(a, sibling) {
    const i = this.children.indexOf(sibling);
    this.children.splice(i < 0 ? this.children.length : i, 0, a);
    a.parent = this;
  }
  set_child_below_sibling(a, sibling) {
    this.children.splice(this.children.indexOf(a), 1);
    const i = this.children.indexOf(sibling);
    this.children.splice(i < 0 ? this.children.length : i, 0, a);
    this.restacks = (this.restacks ?? 0) + 1;
  }
  get_children() { return [...this.children]; }
}

// The stubs are structurally identical, so compare stacking by name.
const order = group => group.children.map(a => a.name);

function uiManagerFixture({ prefix, label } = {}) {
  const uiGroup = new Group();
  const menuBox = actorStub('menu-box');
  const menuActor = actorStub('menu-root');
  const menu = Object.assign(new Signals(), { actor: menuActor, box: menuBox, sourceActor: null });
  const settings = new RecordingSettings();
  const C = loadClass('uiManager.js', 'UIManager', {
    Main: { layoutManager: { uiGroup }, panel: { statusArea: {} } },
    GLib: { idle_add: () => 1, timeout_add: () => 1, Source: { remove() { } }, SOURCE_REMOVE: false,
      PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 0 },
    Gio: { Settings: class { connect() { return 1; } } },
    StageContrastSampler: class { },
    AdaptiveContrastConfig: {},
    isActorValid: actor => !!actor,
  });
  const args = ['/ext', settings, { log() { }, error() { } }, { menu }, false, 'enable-extra-menu-glass'];
  if (prefix !== undefined) args.push(prefix, label);
  return { manager: new C(...args), settings, uiGroup, menuActor };
}

test('the date menu keeps the menu-* namespace', () => {
  const { manager, settings } = uiManagerFixture();
  manager.setup();
  assert.ok(settings.reads.includes('enable-menu-animation'));
  assert.ok(settings.reads.includes('menu-scale'));
  assert.equal(settings.reads.filter(k => k.startsWith('panel-menu-')).length, 0);
});

test('panel menus read their own namespace, never the Calendar menu keys', () => {
  const { manager, settings } = uiManagerFixture({ prefix: 'panel-menu', label: 'menu:keyboard' });
  manager.setup();
  assert.ok(settings.reads.includes('enable-panel-menu-animation'));
  assert.ok(settings.reads.includes('panel-menu-scale'));
  assert.ok(settings.reads.includes('panel-menu-match-quick-settings-height'));
  // The only unprefixed key it may touch is the enable switch it was given.
  const strays = settings.reads.filter(k => k.startsWith('menu-') || k === 'enable-menu-animation');
  assert.deepEqual(strays, []);
});

test('opening a menu lifts its glass off the bottom of uiGroup, above the dock', () => {
  const { manager, uiGroup, menuActor } = uiManagerFixture();
  const panelBox = actorStub('panel-box');
  const bgActor = actorStub('menu-glass');
  const dockGlass = actorStub('dock-glass');
  const dock = actorStub('dock');

  // The stacking this used to produce: the glass pinned just above panelBox
  // near the bottom of uiGroup, the dock and its own glass above it, and the
  // menu itself near the top. That is the reported symptom — the dropdown's
  // text drew over the dock while its backdrop drew under it.
  uiGroup.add_child(panelBox);
  uiGroup.add_child(bgActor);
  uiGroup.add_child(dockGlass);
  uiGroup.add_child(dock);
  uiGroup.add_child(menuActor);

  manager.bgActor = bgActor;
  manager._menuRoot = menuActor;
  assert.ok(uiGroup.children.indexOf(bgActor) < uiGroup.children.indexOf(dock));

  manager._restackGlass();

  assert.deepEqual(order(uiGroup), ['panel-box', 'dock-glass', 'dock', 'menu-glass', 'menu-root']);
  // Glass and menu now travel together, both above the dock and its glass.
  assert.ok(uiGroup.children.indexOf(bgActor) > uiGroup.children.indexOf(dockGlass));
  assert.ok(uiGroup.children.indexOf(bgActor) > uiGroup.children.indexOf(dock));
  assert.equal(uiGroup.children.indexOf(bgActor), uiGroup.children.indexOf(menuActor) - 1);
});

test('a menu created before the dock still ends up with its glass under it', () => {
  const { manager, uiGroup, menuActor } = uiManagerFixture();
  const bgActor = actorStub('menu-glass');
  uiGroup.add_child(menuActor);
  uiGroup.insert_child_below(bgActor, menuActor);
  manager.bgActor = bgActor;
  manager._menuRoot = menuActor;

  // Dash to Dock arrives afterwards and lands on top of both.
  uiGroup.add_child(actorStub('dock'));
  manager._restackGlass();

  // The glass follows its own menu, which is now genuinely below the dock —
  // restacking must not invent a position the menu does not have.
  assert.deepEqual(order(uiGroup), ['menu-glass', 'menu-root', 'dock']);
});

test('restacking is skipped when the order is already right', () => {
  const { manager, uiGroup, menuActor } = uiManagerFixture();
  uiGroup.add_child(menuActor);
  manager.bgActor = actorStub('menu-glass');
  manager._menuRoot = menuActor;
  uiGroup.insert_child_below(manager.bgActor, menuActor);

  manager._restackGlass();
  manager._restackGlass();
  assert.equal(uiGroup.restacks, undefined);
});

test('restacking tolerates a menu that has left uiGroup', () => {
  const { manager, uiGroup, menuActor } = uiManagerFixture();
  manager.bgActor = actorStub('menu-glass');
  manager._menuRoot = menuActor; // never added to uiGroup
  assert.doesNotThrow(() => manager._restackGlass());
  assert.deepEqual(order(uiGroup), []);
});

function panelFixture() {
  const pending = new Map();
  let timerId = 0;
  const GLib = {
    idle_add: (_, fn) => { pending.set(++timerId, fn); return timerId; },
    Source: { remove: id => pending.delete(id) }, SOURCE_REMOVE: false, PRIORITY_DEFAULT_IDLE: 0,
  };
  const settings = Object.assign(new Signals(), {
    values: { 'enable-extra-menu-glass': true, 'enable-keyboard-menu-glass': true,
      'enable-vitals-menu-glass': true, 'disabled-extra-menus': [], 'detected-extra-menus': [] },
    get_boolean(k) { return this.values[k] ?? false; },
    get_strv(k) { return [...(this.values[k] ?? [])]; },
    set_strv(k, v) { this.values[k] = [...v]; },
  });
  class Popup { actor = {}; box = {}; }
  const built = [];
  class Manager {
    constructor(_p, _s, _l, _b, _own, enableKey, prefix, label) {
      Object.assign(this, { enableKey, prefix, label });
      this.cleaned = 0;
      built.push(this);
    }
    setup() { }
    cleanup() { this.cleaned++; if (this.failCleanup) throw Error(`cleanup blew up: ${this.label}`); }
  }
  const panel = { statusArea: {}, contains: b => b.attached,
    _leftBox: new Signals(), _centerBox: new Signals(), _rightBox: new Signals() };
  const C = loadClass('panelMenuManager.js', 'PanelMenuManager', {
    Main: { panel, extensionManager: new Signals() },
    PopupMenu: { PopupMenu: Popup }, GLib, UIManager: Manager,
  });
  const manager = new C('', settings, { log() { } });
  const add = name => {
    const button = Object.assign(new Signals(), { menu: new Popup(), attached: true });
    panel._rightBox.emit('child-added', button);
    panel.statusArea[name] = button;
    return button;
  };
  manager.setup();
  return { manager, settings, built, add,
    flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } } };
}

test('each detected menu gets the panel namespace and its own diagnostic label', () => {
  const f = panelFixture();
  f.add('keyboard'); f.add('vitalsMenu'); f.flush();
  assert.deepEqual(f.built.map(m => m.prefix), ['panel-menu', 'panel-menu']);
  assert.deepEqual(f.built.map(m => m.label).sort(), ['menu:keyboard', 'menu:vitalsMenu']);
  // The enable switch stays the shared one; only the appearance keys moved.
  assert.deepEqual([...new Set(f.built.map(m => m.enableKey))], ['enable-extra-menu-glass']);
});

test('one menu failing to clean up does not strand the others', () => {
  const f = panelFixture();
  f.add('alpha'); f.add('beta'); f.add('gamma'); f.flush();
  assert.equal(f.built.length, 3);
  f.built[1].failCleanup = true;

  f.manager.cleanup();
  assert.deepEqual(f.built.map(m => m.cleaned), [1, 1, 1]);
  // The step after the throwing menu still ran.
  assert.deepEqual(f.settings.get_strv('detected-extra-menus'), []);
});
