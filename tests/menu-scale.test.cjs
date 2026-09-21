const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

class Signals {
  handlers = new Map();
  next = 1;
  connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { this.handlers.delete(id); }
  emit(name, ...args) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

function actorStub() {
  return Object.assign(new Signals(), {
    allocated: 0,
    opacity: 255,
    scale: 1,
    has_allocation() { return this.allocated > 0; },
    set_pivot_point() {},
    set_scale(x) { this.scale = x; },
  });
}

function menuStub({ openHeight = 0 } = {}) {
  const actor = actorStub();
  return Object.assign(new Signals(), {
    actor,
    box: null,
    sourceActor: null,
    isOpen: false,
    opens: 0,
    open() { this.isOpen = true; this.opens++; actor.allocated = openHeight; },
    close() { this.isOpen = false; actor.allocated = 0; },
  });
}

function shell({ quickSettings = null, remembered = 0 } = {}) {
  const laters = { pending: [], add(_, fn) { this.pending.push(fn); return this.pending.length; }, remove() {} };
  const statusArea = quickSettings ? { quickSettings: { menu: quickSettings } } : {};
  const bindings = {
    Main: { layoutManager: { uiGroup: { get_children: () => [], add_child() {} }, primaryIndex: 0,
      findIndexForActor: () => 0 }, panel: { statusArea } },
    GLib: { idle_add: () => 1, timeout_add: () => 1, Source: { remove() {} },
      SOURCE_REMOVE: false, PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 0 },
    Gio: { Settings: class { connect() { return 1; } } },
    Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    global: { compositor: { get_laters: () => laters } },
    StageContrastSampler: class {},
    AdaptiveContrastConfig: {},
    isActorValid: actor => !!actor,
    getAllocatedSize: actor => [0, actor.allocated],
  };
  const { UIManager: C } = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/uiManager.js'), bindings);
  const written = {};
  const settings = { get_boolean: k => k.endsWith('match-quick-settings-height'), get_int: () => 0,
    get_double: k => (k.endsWith('settled-height-scale') ? remembered : 1.0),
    get_string: () => '#ffffff', get_strv: () => [], connect: () => 1,
    set_double(k, v) { written[k] = v; } };
  const drain = () => { let guard = 200; while (laters.pending.length && guard-- > 0) laters.pending.shift()(); };
  const makeManager = (own, ownsNamespace = true) => {
    const manager = new C('/ext', settings, { log() {}, error() {} }, { menu: own }, false,
      'enable-menu-glass', 'menu', 'menu', ownsNamespace);
    manager._matchQuickSettingsHeight = true;
    manager._settledHeightScale = remembered > 0 ? remembered : null;
    return manager;
  };
  return { makeManager, written, drain };
}

test('opting in measures Quick Settings invisibly and never touches the menu being scaled', () => {
  const quickSettings = menuStub({ openHeight: 700 });
  const own = menuStub({ openHeight: 900 });
  const { makeManager, drain } = shell({ quickSettings });
  const manager = makeManager(own);

  manager._measureHeightScale();
  drain();

  assert.equal(quickSettings.opens, 1);
  assert.equal(quickSettings.isOpen, false);
  assert.equal(quickSettings.actor.opacity, 255);
  assert.equal(own.opens, 0);
});

test('the ratio lands once the scaled menu is opened for real', () => {
  const quickSettings = menuStub({ openHeight: 700 });
  const own = menuStub({ openHeight: 900 });
  const { makeManager, written, drain } = shell({ quickSettings });
  const manager = makeManager(own);

  manager._measureHeightScale();
  drain();
  assert.equal(written['menu-settled-height-scale'], undefined);

  own.open();
  manager._noteOwnOpenedHeight();
  drain();

  assert.equal(written['menu-settled-height-scale'], 700 / 900);
  assert.equal(own.actor.scale, 700 / 900);
});

test('many panel menus opting in at once open Quick Settings exactly once', () => {
  const quickSettings = menuStub({ openHeight: 700 });
  const menus = [menuStub({ openHeight: 900 }), menuStub({ openHeight: 800 }), menuStub({ openHeight: 600 })];
  const { makeManager, drain } = shell({ quickSettings });
  const managers = menus.map(makeManager);

  for (const manager of managers) manager._measureHeightScale();
  drain();

  assert.equal(quickSettings.opens, 1);
  for (const menu of menus) assert.equal(menu.opens, 0);
});

test('a ratio remembered from an earlier session is used before anything is opened', () => {
  const own = menuStub({ openHeight: 900 });
  const { makeManager } = shell({ quickSettings: menuStub({ openHeight: 700 }), remembered: 0.75 });
  const manager = makeManager(own);

  assert.equal(manager._quickSettingsHeightScale(), 0.75);
  manager._applyMenuScale();
  assert.equal(own.actor.scale, 0.75);
});

test('an unmeasurable menu keeps its configured scale instead of shrinking to the floor', () => {
  const own = menuStub({ openHeight: 900 });
  const { makeManager } = shell({ quickSettings: menuStub({ openHeight: 700 }) });
  const manager = makeManager(own);

  manager._menuScale = 1.0;
  manager._applyMenuScale();
  assert.equal(own.actor.scale, 1.0);
});

test('starting a session never re-measures; the remembered ratio is used as it stands', () => {
  const quickSettings = menuStub({ openHeight: 700 });
  const own = menuStub({ openHeight: 900 });
  const { makeManager, drain } = shell({ quickSettings, remembered: 0.8 });
  const manager = makeManager(own);

  manager.setup();
  drain();

  assert.equal(quickSettings.opens, 0);
  assert.equal(own.opens, 0);
  assert.equal(own.actor.scale, 0.8);
});

test('a menu already shorter than Quick Settings is left alone and remembers nothing', () => {
  const quickSettings = menuStub({ openHeight: 700 });
  const own = menuStub({ openHeight: 200 });
  const { makeManager, written, drain } = shell({ quickSettings });
  const manager = makeManager(own);

  manager._measureHeightScale();
  drain();
  own.open();
  manager._noteOwnOpenedHeight();
  drain();

  assert.equal(written['menu-settled-height-scale'], undefined);
  assert.equal(own.actor.scale, 1);
});

test('menus sharing one settings namespace never write each other a ratio', () => {
  const quickSettings = menuStub({ openHeight: 700 });
  const own = menuStub({ openHeight: 900 });
  const { makeManager, written, drain } = shell({ quickSettings });
  const manager = makeManager(own, false);

  manager._measureHeightScale();
  drain();
  own.open();
  manager._noteOwnOpenedHeight();
  drain();

  assert.equal(written['menu-settled-height-scale'], undefined, 'nothing persisted');
  assert.equal(own.actor.scale, 700 / 900, 'but this session still scales');
});
