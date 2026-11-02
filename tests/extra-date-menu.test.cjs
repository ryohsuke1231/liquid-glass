const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

class Signals {
  handlers = new Map();
  next = 1;
  connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { assert.ok(this.handlers.delete(id), `unknown signal ${id}`); }
  emit(name, ...args) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

class UiGroup extends Signals {
  children = [];
  add_child(a) { this.children.push(a); this.emit('child-added', a); }
  remove_child(a) { this.children.splice(this.children.indexOf(a), 1); this.emit('child-removed', a); }
  get_children() { return [...this.children]; }
}

// Top bars from Multi Monitors Bar or Dash to Panel: a DateMenuButton whose menu sits in uiGroup.
function fixture() {
  const pending = new Map();
  let timerId = 0;
  const GLib = {
    idle_add: (_, fn) => { pending.set(++timerId, fn); return timerId; },
    Source: { remove: id => pending.delete(id) }, SOURCE_REMOVE: false, PRIORITY_DEFAULT_IDLE: 0,
  };
  class Popup {
    constructor(sourceActor) {
      this.sourceActor = sourceActor;
      this.actor = { _delegate: this };
      this.box = {};
    }
  }
  class DateMenuButton { constructor() { this.menu = new Popup(this); } }
  class OtherButton { constructor() { this.menu = new Popup(this); } }
  const built = [];
  class Manager {
    constructor(_p, _s, _l, button, ownsAccentCss, enableKey, prefix, label, ownsSettingsNamespace) {
      Object.assign(this, { menu: button.menu, ownsAccentCss, enableKey, prefix, label, ownsSettingsNamespace });
      this.cleaned = 0;
      built.push(this);
    }
    setup() { }
    cleanup() { this.cleaned++; }
  }
  const uiGroup = new UiGroup();
  const mainDateMenu = new DateMenuButton();
  uiGroup.add_child(mainDateMenu.menu.actor);
  const C = loadModule(path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist/panelMenuManager.js'), {
    Main: { layoutManager: { uiGroup }, panel: { statusArea: { dateMenu: mainDateMenu } } },
    DateMenu: { DateMenuButton }, PopupMenu: { PopupMenu: Popup }, GLib, UIManager: Manager,
  }).ExtraDateMenuManager;
  const manager = new C('', {}, { log() { } });
  return {
    manager, uiGroup, built, DateMenuButton, OtherButton,
    flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    open(Button) { const b = new Button(); uiGroup.add_child(b.menu.actor); return b; },
  };
}

test("another top bar's calendar gets glass with the Calendar menu's switch and settings", () => {
  const f = fixture();
  f.manager.setup();
  const bar = f.open(f.DateMenuButton);
  f.flush();
  assert.equal(f.built.length, 1);
  const [m] = f.built;
  assert.equal(m.menu, bar.menu);
  assert.equal(m.enableKey, 'enable-menu-glass');
  assert.equal(m.prefix, 'menu');
  // The main calendar's UIManager owns the accent CSS and the remembered height.
  assert.equal(m.ownsAccentCss, false);
  assert.equal(m.ownsSettingsNamespace, false);
});

test("the main panel's calendar and other menus are left alone", () => {
  const f = fixture();
  f.open(f.OtherButton);
  f.manager.setup();
  f.flush();
  assert.deepEqual(f.built, []);
});

test('bars that exist before enabling are picked up, each once', () => {
  const f = fixture();
  f.open(f.DateMenuButton);
  f.open(f.DateMenuButton);
  f.manager.setup();
  f.flush();
  f.uiGroup.emit('child-added', {});
  f.flush();
  assert.equal(f.built.length, 2);
  assert.notEqual(f.built[0].label, f.built[1].label);
});

test("a bar that goes away takes its glass with it, and disabling removes the rest", () => {
  const f = fixture();
  f.manager.setup();
  const first = f.open(f.DateMenuButton);
  f.open(f.DateMenuButton);
  f.flush();
  f.uiGroup.remove_child(first.menu.actor);
  f.flush();
  assert.deepEqual(f.built.map(m => m.cleaned), [1, 0]);

  // A scan queued before disabling must not run afterwards.
  f.open(f.DateMenuButton);
  f.manager.cleanup();
  f.flush();
  assert.deepEqual(f.built.map(m => m.cleaned), [1, 1]);
  assert.equal(f.built.length, 2);
  assert.equal(f.uiGroup.handlers.size, 0);
});

test('a scan queued while the shell tears uiGroup down never runs', () => {
  const f = fixture();
  f.manager.setup();
  f.open(f.DateMenuButton);
  f.flush();
  f.uiGroup.remove_child(f.uiGroup.children[1]);
  f.uiGroup.emit('destroy');
  f.uiGroup.get_children = () => assert.fail('scanned a destroyed uiGroup');
  f.flush();
  assert.deepEqual(f.built.map(m => m.cleaned), [1]);
  assert.equal(f.uiGroup.handlers.size, 0);
});
