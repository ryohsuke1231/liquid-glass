const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exercise built managers with shell actors stubbed; no GNOME session required.
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
class Settings extends Signals {
  values = { 'enable-extra-menu-glass': true, 'enable-keyboard-menu-glass': true,
    'enable-vitals-menu-glass': true, 'disabled-extra-menus': [], 'detected-extra-menus': [] };
  get_boolean(k) { return this.values[k] ?? false; }
  get_strv(k) { return [...this.values[k]]; }
  get_int() { return 10; }
  get_double() { return 0.1; }
  set_strv(k, value) { this.values[k] = [...value]; this.emit(`changed::${k}`); }
  set(k, value) { this.values[k] = value; this.emit(`changed::${k}`); }
}
function scheduler() {
  const pending = new Map(); let id = 0;
  return { GLib: { idle_add: (_, fn) => { pending.set(++id, fn); return id; },
    Source: { remove: id => pending.delete(id) }, SOURCE_REMOVE: false },
  flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } }, pending };
}
function panelFixture() {
  const clock = scheduler(); const settings = new Settings(); const instances = [];
  class Popup { actor = {}; box = {}; }
  class Manager {
    constructor(_p, _s, _l, button) { this.button = button; this.cleaned = 0; instances.push(this); }
    setup() { if (this.button.fail) throw Error('partial setup'); }
    cleanup() { this.cleaned++; }
  }
  const panel = { statusArea: {}, contains: b => b.attached,
    _leftBox: new Signals(), _centerBox: new Signals(), _rightBox: new Signals() };
  const Main = { panel, extensionManager: new Signals() };
  const C = loadClass('panelMenuManager.js', 'PanelMenuManager', {
    Main, PopupMenu: { PopupMenu: Popup }, GLib: clock.GLib, UIManager: Manager });
  const manager = new C('', settings, { log() {} });
  const add = (name, menu = new Popup()) => {
    const button = Object.assign(new Signals(), { menu, attached: true });
    panel._rightBox.emit('child-added', button);
    panel.statusArea[name] = button;
    return button;
  };
  manager.setup();
  return { ...clock, manager, settings, panel, instances, add, Popup };
}

test('discovers arbitrary and late menus, excluding built-ins and dummy menus', () => {
  const f = panelFixture();
  f.add('dateMenu'); f.add('quickSettings'); f.add('dummy', {}); f.add('keyboard'); f.flush();
  assert.deepEqual(f.settings.get_strv('detected-extra-menus'), ['keyboard']);
  f.add('thirdPartyExample'); f.flush();
  assert.deepEqual(f.settings.get_strv('detected-extra-menus'), ['keyboard', 'thirdPartyExample']);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[0].cleaned, 0); // existing open menu remains untouched
  f.manager.cleanup();
  assert.equal(f.pending.size, 0);
  assert.equal(f.settings.handlers.size, 0);
  assert.deepEqual(f.settings.get_strv('detected-extra-menus'), []);
});

test('per-menu exclusion and master toggle preserve detection and other instances', () => {
  const f = panelFixture(); f.add('custom'); f.add('vitalsMenu'); f.flush();
  f.settings.set_strv('disabled-extra-menus', ['custom']); f.flush();
  assert.equal(f.instances[0].cleaned, 1);
  assert.equal(f.instances[1].cleaned, 0);
  f.settings.set('enable-vitals-menu-glass', false); f.flush();
  assert.equal(f.instances[1].cleaned, 1);
  assert.deepEqual(f.settings.get_strv('detected-extra-menus'), ['custom', 'vitalsMenu']);
  f.settings.set('enable-extra-menu-glass', false); f.flush();
  f.settings.set_strv('disabled-extra-menus', []); f.flush();
  assert.equal(f.instances.length, 2);
  f.settings.set('enable-extra-menu-glass', true); f.flush();
  assert.equal(f.instances.length, 3);
  f.manager.cleanup();
});

test('menu replacement and removal clean up only affected managers', () => {
  const f = panelFixture(); const button = f.add('custom'); f.flush();
  button.menu = new f.Popup(); button.emit('menu-set'); f.flush();
  assert.equal(f.instances[0].cleaned, 1); assert.equal(f.instances.length, 2);
  button.attached = false; f.panel._rightBox.emit('child-removed', button); f.flush();
  assert.equal(f.instances[1].cleaned, 1); assert.equal(button.handlers.size, 0);
  assert.deepEqual(f.settings.get_strv('detected-extra-menus'), []);
  f.manager.cleanup();
});

test('partial setup is cleaned and duplicate menu aliases get one manager', () => {
  const f = panelFixture(); const b = f.add('first'); f.add('alias', b.menu);
  const broken = f.add('broken'); broken.fail = true; f.flush();
  assert.equal(f.instances.length, 2); assert.equal(f.instances[1].cleaned, 1);
  f.manager.cleanup(); assert.equal(f.instances[0].cleaned, 1);
});

function notificationFixture() {
  const clock = scheduler(); const tray = Object.assign(new Signals(), { visible: true, _bannerBin: new Signals() });
  tray._bannerBin.translation_y = 0;
  const monitor = { x: 1920, y: 200, width: 1600, height: 1000 };
  const C = loadClass('notificationManager.js', 'NotificationManager', {
    Main: { messageTray: tray }, GLib: clock.GLib,
    StageContrastSampler: class {}, AdaptiveContrastConfig: {},
    getTransformedRect: actor => actor.rect,
    resolveMonitorGeometry: () => monitor,
    // Perf helpers from the render branch; stubbed to their plain behaviour.
    setClipIfChanged: (actor, ...clip) => actor.set_clip(...clip),
    syncGlassCaptureClip: () => {},
    isFrameSyncFrozen: () => false,
  });
  const manager = new C('', new Settings(), { error() {} });
  return { ...clock, manager, tray, monitor };
}
function actorStub() {
  return { visible: false, opacity: 0, show() { this.visible = true; }, hide() { this.visible = false; },
    set_position(...v) { this.position = v; }, set_size(...v) { this.size = v; },
    set_clip() {}, remove_clip() {}, remove_transition() {} };
}
test('notification glass follows transformed dimensions and inherited opacity on offset monitor', () => {
  const { manager: m } = notificationFixture();
  m.currentBanner = { rect: [2100, 250, 360, 90], mapped: true, get_paint_opacity: () => 80 };
  m.bgActor = actorStub(); m.liquidBox = actorStub();
  m.effect = { setShadowMaxRadius() {}, setResolution() {}, setGlassGeometry(...v) { this.geometry = v; } };
  m._syncGeometry();
  assert.deepEqual(m.bgActor.position, [1920, 200]);
  assert.deepEqual(m.effect.geometry, [148, 18, 424, 154]);
  assert.equal(m.bgActor.opacity, 80);
  m.currentBanner.rect = [2100, 240, 400, 100]; m._syncGeometry();
  assert.deepEqual(m.effect.geometry, [148, 8, 464, 164]);
});

test('notification glass hides when ancestor is hidden or fully faded', () => {
  const { manager: m, tray } = notificationFixture();
  m.currentBanner = { rect: [2100, 250, 360, 90], mapped: true, get_paint_opacity: () => 0 };
  m.bgActor = actorStub(); m.bgActor.visible = true; m._syncGeometry();
  assert.equal(m.bgActor.visible, false);
  m.currentBanner.get_paint_opacity = () => 255; tray.visible = false;
  m.bgActor.visible = true; m._syncGeometry(); assert.equal(m.bgActor.visible, false);
});

test('removing a banner before deferred setup cancels its glass', () => {
  const f = notificationFixture(); let setups = 0;
  f.manager._setupBannerEffect = () => setups++;
  f.manager._cleanupCurrentBanner = () => { f.manager.currentBanner = null; };
  f.manager._applyEffect();
  const banner = { get_parent: () => f.tray._bannerBin };
  f.tray._bannerBin.emit('child-added', banner);
  f.tray._bannerBin.emit('child-removed', banner); f.flush();
  assert.equal(setups, 0);
  f.tray._bannerBin.emit('child-added', banner); f.manager._removeEffect(); f.flush();
  assert.equal(setups, 0); assert.equal(f.pending.size, 0);
  assert.equal(f.tray._bannerBin.handlers.size, 0);
});
