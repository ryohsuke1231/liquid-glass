const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadClass(file, name, bindings) {
  const code = fs.readFileSync(path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist', file), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export class /g, 'class ');
  return new Function(...Object.keys(bindings), `${code}\nreturn ${name};`)(...Object.values(bindings));
}

// Mutter's enum, in its real order — the matcher compares against these values.
const WindowType = {
  NORMAL: 0, DESKTOP: 1, DOCK: 2, DIALOG: 3, MODAL_DIALOG: 4, TOOLBAR: 5, MENU: 6,
  UTILITY: 7, SPLASHSCREEN: 8, DROPDOWN_MENU: 9, POPUP_MENU: 10, TOOLTIP: 11,
  NOTIFICATION: 12, COMBO: 13, DND: 14, OVERRIDE_OTHER: 15,
};

class WindowActor {
  constructor(metaWindow) { this._w = metaWindow; }
  get_meta_window() { return this._w; }
}

function metaWindow({ type, overrideRedirect = false, wmClass = null, transientFor = null, title = '' }) {
  return {
    get_window_type: () => type,
    is_override_redirect: () => overrideRedirect,
    get_wm_class: () => wmClass,
    get_transient_for: () => transientFor,
    get_title: () => title,
  };
}

function managerFixture(values = {}) {
  const settings = {
    values: {
      'enable-application-glass': false,
      'enable-desktop-menu-glass': true,
      'application-glass-all-windows': false,
      'application-window-whitelist': [],
      'application-window-blacklist': [],
      ...values,
    },
    get_boolean(k) { return !!this.values[k]; },
    get_strv(k) { return [...(this.values[k] ?? [])]; },
    get_double(k) { return this.values[k] ?? 1.0; },
    get_int(k) { return this.values[k] ?? 0; },
    get_string(k) { return this.values[k] ?? '#ffffff'; },
    connect() { return 1; },
  };
  const C = loadClass('applicationManager.js', 'ApplicationManager', {
    Meta: { WindowType, WindowActor },
    Main: { layoutManager: { primaryMonitor: { width: 1920, height: 1080 } } },
    GLib: { idle_add: () => 1, Source: { remove() { } }, SOURCE_REMOVE: false, PRIORITY_DEFAULT_IDLE: 0 },
  });
  return { manager: new C('/ext', settings, { log() { }, error() { } }), settings };
}

// The desktop window the menu hangs off: DING runs as a gjs process and owns a
// DESKTOP-type toplevel. Measured on GNOME Shell 50 / Wayland.
const desktopWindow = metaWindow({ type: WindowType.DESKTOP, wmClass: 'gjs' });

// The measured shape of the desktop right-click menu: every identifying field
// is null, so only (menu type + transient for the desktop) can select it.
const desktopMenu = () => metaWindow({
  type: WindowType.DROPDOWN_MENU, overrideRedirect: false, wmClass: null,
  transientFor: desktopWindow,
});

test('the desktop right-click menu is recognised', () => {
  const { manager } = managerFixture();
  assert.equal(manager._isDesktopMenuWindow(desktopMenu()), true);
  assert.equal(manager._profileForWindow(new WindowActor(desktopMenu())), 'desktop-menu');
});

test('a submenu of the desktop menu is recognised through the chain', () => {
  const { manager } = managerFixture();
  const sub = metaWindow({ type: WindowType.POPUP_MENU, transientFor: desktopMenu() });
  assert.equal(manager._isDesktopMenuWindow(sub), true);
});

test("Chrome's in-app popup is left alone", () => {
  const { manager } = managerFixture({ 'enable-application-glass': true,
    'application-glass-all-windows': true });
  // Measured: type=OVERRIDE_OTHER or=true class=null, no transient parent.
  const popup = metaWindow({ type: WindowType.OVERRIDE_OTHER, overrideRedirect: true });
  assert.equal(manager._isDesktopMenuWindow(popup), false);
  assert.equal(manager._profileForWindow(new WindowActor(popup)), null);

  // Even an override-redirect window that *does* claim a menu type stays out.
  const orMenu = metaWindow({ type: WindowType.DROPDOWN_MENU, overrideRedirect: true,
    transientFor: desktopWindow });
  assert.equal(manager._isDesktopMenuWindow(orMenu), false);
});

test("an app's own menu is not mistaken for the desktop's", () => {
  const { manager } = managerFixture();
  const appWindow = metaWindow({ type: WindowType.NORMAL, wmClass: 'Google-chrome' });
  const appMenu = metaWindow({ type: WindowType.DROPDOWN_MENU, transientFor: appWindow });
  assert.equal(manager._isDesktopMenuWindow(appMenu), false);
  assert.equal(manager._profileForWindow(new WindowActor(appMenu)), null);
});

test('a transient_for cycle terminates instead of hanging', () => {
  const { manager } = managerFixture();
  const a = metaWindow({ type: WindowType.POPUP_MENU });
  const b = metaWindow({ type: WindowType.POPUP_MENU, transientFor: a });
  a.get_transient_for = () => b;
  assert.equal(manager._isDesktopMenuWindow(b), false);
});

test('each switch only governs its own profile', () => {
  const menuActor = new WindowActor(desktopMenu());
  const appActor = new WindowActor(metaWindow({ type: WindowType.NORMAL, wmClass: 'Firefox' }));

  // Desktop menu on, application glass off: the menu still gets glass. This is
  // the case the old single `enable-application-glass` gate made impossible.
  let f = managerFixture({ 'enable-application-glass': false, 'enable-desktop-menu-glass': true });
  assert.equal(f.manager._profileForWindow(menuActor), 'desktop-menu');
  assert.equal(f.manager._profileForWindow(appActor), null);
  assert.equal(f.manager._isEffectEnabled(), true);

  // And the other way round.
  f = managerFixture({ 'enable-application-glass': true, 'enable-desktop-menu-glass': false,
    'application-glass-all-windows': true });
  assert.equal(f.manager._profileForWindow(menuActor), null);
  assert.equal(f.manager._profileForWindow(appActor), 'application');
  assert.equal(f.manager._isEffectEnabled(), true);

  // Both off: the manager reports nothing to do, so the frame loop stays down.
  f = managerFixture({ 'enable-application-glass': false, 'enable-desktop-menu-glass': false });
  assert.equal(f.manager._isEffectEnabled(), false);
  assert.equal(f.manager._profileForWindow(menuActor), null);
});

test('"apply to all windows" cannot swallow the desktop menu', () => {
  // Application glass on and applying to everything, desktop menu explicitly
  // off: the menu must not fall through to the application namespace.
  const { manager } = managerFixture({ 'enable-application-glass': true,
    'application-glass-all-windows': true, 'enable-desktop-menu-glass': false });
  assert.equal(manager._profileForWindow(new WindowActor(desktopMenu())), null);
});

test('settings keys resolve into the right namespace', () => {
  const { manager } = managerFixture();
  assert.equal(manager._profileKey('application', 'tint-color'), 'application-tint-color');
  assert.equal(manager._profileKey('desktop-menu', 'tint-color'), 'desktop-menu-tint-color');
  assert.equal(manager._profileEnableKey('desktop-menu'), 'enable-desktop-menu-glass');
  assert.equal(manager._profileEnableKey('application'), 'enable-application-glass');
});
