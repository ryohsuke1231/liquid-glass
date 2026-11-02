const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

class Signals {
  handlers = new Map();
  next = 1;
  connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { assert.ok(this.handlers.delete(id), `unknown signal ${id}`); }
  emit(name, ...args) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

class Widget extends Signals {
  children = [];
  parent = null;
  styleClasses = new Set();
  x = 0;
  add_child(a) { this.children.push(a); a.parent = this; this.emit('child-added', a); }
  remove_child(a) { this.children.splice(this.children.indexOf(a), 1); a.parent = null; this.emit('child-removed', a); }
  get_children() { return [...this.children]; }
  get_parent() { return this.parent; }
  get_position() { return [this.x, 0]; }
  has_style_class_name(name) { return this.styleClasses.has(name); }
  add_style_class_name(name) { this.styleClasses.add(name); this.emit('notify::style-class'); }
  remove_style_class_name(name) { this.styleClasses.delete(name); this.emit('notify::style-class'); }
}
class BoxLayout extends Widget { }
const St = { Widget, BoxLayout };

function bar() {
  const panel = new Widget();
  for (const name of ['_leftBox', '_centerBox', '_rightBox']) {
    panel[name] = new BoxLayout();
    panel.add_child(panel[name]);
  }
  return panel;
}

// Multi Monitors Bar style: each bar in a box of its own in uiGroup.
function fixture() {
  const pending = new Map();
  let timerId = 0;
  const GLib = {
    idle_add: (_, fn) => { pending.set(++timerId, fn); return timerId; },
    Source: { remove: id => pending.delete(id) }, SOURCE_REMOVE: false, PRIORITY_DEFAULT_IDLE: 0,
  };
  const uiGroup = new Widget();
  const mainBox = new Widget();
  const mainPanel = bar();
  mainBox.add_child(mainPanel);
  uiGroup.add_child(mainBox);
  const Main = {
    panel: mainPanel,
    layoutManager: Object.assign(new Signals(), { uiGroup, panelBox: mainBox }),
    extensionManager: new Signals(),
  };
  const { TopBarManager, ExtraTopBarManager: C } = loadModule(path.join(dist, 'topBarManager.js'),
    { Main, St, GLib, AdaptiveTextColor: class {} });
  // Each bar's own glass is TopBarManager's to test; here it only records what it was given.
  const built = [];
  TopBarManager.prototype.setup = function () {
    Object.assign(this, { panel: this._panel, panelBox: this._panelBox, owner: this._owner, cleaned: 0 });
    built.push(this);
  };
  TopBarManager.prototype.cleanup = function () { this.cleaned++; };
  const manager = new C('', {}, { log() { } });
  return {
    manager, uiGroup, Main, built,
    flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    addBar() {
      const box = new Widget();
      uiGroup.add_child(box);
      const panel = bar();
      box.add_child(panel);
      return { box, panel };
    },
  };
}

test("another monitor's bar gets its own top bar glass, laid out in its own box", () => {
  const f = fixture();
  f.manager.setup();
  const { box, panel } = f.addBar();
  f.flush();
  assert.equal(f.built.length, 1);
  assert.equal(f.built[0].panel, panel);
  assert.equal(f.built[0].panelBox, box);
  assert.notEqual(f.built[0].owner, 'top-bar');
});

test("the shell's own bar and actors that are not bars are left alone", () => {
  const f = fixture();
  const box = new Widget();
  box.add_child(new Widget());
  f.uiGroup.add_child(box);
  f.manager.setup();
  f.flush();
  assert.deepEqual(f.built, []);
});

test('a bar moved to a side of the screen loses its glass, and gets it back when moved to the top', () => {
  const f = fixture();
  f.manager.setup();
  const { panel } = f.addBar();
  f.flush();
  panel.add_style_class_name('multimonitor-panel-vertical');
  f.flush();
  assert.equal(f.built[0].cleaned, 1);

  // Multi Monitors Bar only changes the style class; nothing in uiGroup changes.
  panel.remove_style_class_name('multimonitor-panel-vertical');
  f.flush();
  assert.equal(f.built.length, 2);
  assert.equal(f.built[1].panel, panel);
});

test('a destroyed bar takes its glass with it at once, and disabling removes the rest', () => {
  const f = fixture();
  f.manager.setup();
  const first = f.addBar();
  const second = f.addBar();
  f.flush();
  // The glass must go while the bar's actors are still alive, not on the next idle.
  first.panel.emit('destroy');
  assert.deepEqual(f.built.map(m => m.cleaned), [1, 0]);
  assert.equal(first.panel.handlers.size, 0);

  f.manager.cleanup();
  assert.deepEqual(f.built.map(m => m.cleaned), [1, 1]);
  assert.equal(second.panel.handlers.size, 0);
  assert.equal(f.uiGroup.handlers.size, 0);
  assert.equal(f.Main.layoutManager.handlers.size, 0);
  assert.equal(f.Main.extensionManager.handlers.size, 0);
});

test('a scan queued while the shell tears uiGroup down never runs', () => {
  const f = fixture();
  f.manager.setup();
  f.addBar();
  f.flush();
  f.uiGroup.remove_child(f.uiGroup.children[1]);
  f.uiGroup.emit('destroy');
  f.uiGroup.get_children = () => assert.fail('scanned a destroyed uiGroup');
  f.flush();
  assert.deepEqual(f.built.map(m => m.cleaned), [1]);
});

test("islands follow Multi Monitors Bar's center row, which sits inside _centerBox", () => {
  const panel = bar();
  const centerBin = new BoxLayout();
  panel._centerBox.x = 600;
  centerBin.x = 100;
  panel._centerBox.add_child(centerBin);
  panel._centerBin = centerBin;
  const clock = Object.assign(new Widget(), {
    visible: true, width: 100, get_allocation_box: () => ({ x1: 10, x2: 110 }),
  });
  centerBin.add_child(clock);

  const C = loadModule(path.join(dist, 'topBarManager.js'), {
    Main: {}, St, AdaptiveTextColor: class { },
  }).TopBarManager;
  const manager = new C('', {}, { log() { } }, panel, new Widget(), 'top-bar:1');
  assert.deepEqual(manager._sections(), [panel._leftBox, centerBin, panel._rightBox]);
  // In bar coordinates: _centerBox's and the row's offsets both count.
  assert.deepEqual(manager._boxExtent(centerBin), [710, 810]);
});
