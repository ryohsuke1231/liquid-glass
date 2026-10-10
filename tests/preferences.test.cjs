const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createModuleLoader} = require('./helpers/load-module.cjs');
const root = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com');

// `blurMyShell`, when given, stands for Blur my Shell's popup settings, installed for the user.
function fixture(overrides = {}, dbusResponses = [], blurMyShell = null) {
  const values = new Map();
  const types = new Map();
  const ranges = new Map();
  const xml = fs.readFileSync(path.join(root, 'schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml'), 'utf8');
  for (const [, key, type, body] of xml.matchAll(/<key name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/key>/g)) {
    const raw = body.match(/<default>([\s\S]*?)<\/default>/)[1].trim();
    const value = type === 'as' ? [] : type === 's' ? raw.slice(1, -1) : type === 'b' ? raw === 'true'
      : type.startsWith('(') ? JSON.parse(`[${raw.slice(1, -1)}]`) : Number(raw);
    types.set(key, type); values.set(key, value);
    const range = body.match(/<range min="([^"]+)" max="([^"]+)"\s*\/>/);
    if (range) ranges.set(key, {min: Number(range[1]), max: Number(range[2])});
  }
  for (const [key, value] of Object.entries(overrides)) values.set(key, value);
  const listeners = new Map(); const widgets = []; const writes = []; let nextId = 1;
  class Variant {
    constructor(type, value) { this.type = type; this.value = value; }
    deep_unpack() { return this.value; }
    get_type_string() { return this.type; }
  }
  class Settings {
    constructor() {
      this.path = '/test/';
      this.settings_schema = {get_key: key => ({range_check: variant => {
        const range = ranges.get(key);
        return !range || (variant.value >= range.min && variant.value <= range.max);
      }})};
    }
    get_value(key) { assert.ok(types.has(key), `unknown schema key ${key}`); return new Variant(types.get(key), values.get(key)); }
    get_boolean(key) { return this.get_value(key).deep_unpack(); }
    get_strv(key) { return this.get_value(key).deep_unpack(); }
    connect(signal, fn) { const id = nextId++; listeners.set(id, {signal, fn}); return id; }
    disconnect(id) { listeners.delete(id); }
    is_writable() { return true; }
    delay() { this.pending = new Map(); }
    set_value(key, variant) { this.get_value(key); this.pending.set(key, variant.deep_unpack()); return true; }
    apply() {
      const patch = Object.fromEntries(this.pending); writes.push(patch);
      for (const [key, value] of this.pending) values.set(key, value);
      for (const key of this.pending.keys()) for (const {signal, fn} of [...listeners.values()]) if (signal === `changed::${key}`) fn();
      this.pending.clear();
    }
    revert() { this.pending.clear(); }
    bind(key, widget, property) { this.connect(`changed::${key}`, () => { widget[property] = values.get(key); }); widget[property] = values.get(key); }
  }
  class Widget {
    constructor(props = {}) { Object.assign(this, {children: [], signals: new Map(), visible: true}, props); widgets.push(this); }
    add(child) { this.children.push(child); }
    add_row(child) { this.add(child); }
    append(child) { this.add(child); }
    remove(child) { this.children = this.children.filter(item => item !== child); }
    add_prefix() {} add_suffix(child) { child._parent = this; } add_css_class() {} set_header_suffix() {} set_default_size() {}
    get_parent() { return this._parent ?? null; }
    reorder_child_after() {}
    get_first_child() { return this.children[0] ?? null; }
    get_next_sibling() { return null; }
    connect(signal, fn) { const id = nextId++; this.signals.set(id, {signal, fn}); return id; }
    emit(signal) { for (const entry of this.signals.values()) if (entry.signal === signal) entry.fn(); }
    set selected(value) { this._selected = value; this.emit('notify::selected'); }
    get selected() { return this._selected; }
    set value(value) { this._value = value; this.emit('notify::value'); }
    get value() { return this._value; }
    set active(value) { this._active = value; this.emit('notify::active'); }
    get active() { return this._active; }
  }
  class RGBA { parse() { this.red = this.green = this.blue = 1; } }
  const Adw = Object.fromEntries(['PreferencesPage', 'PreferencesGroup', 'SwitchRow', 'ComboRow', 'SpinRow', 'ActionRow', 'EntryRow', 'ExpanderRow'].map(name => [name, class extends Widget {}]));
  const Gtk = {Adjustment: Widget, ColorDialogButton: Widget, ColorDialog: Widget, Button: Widget, ListBox: Widget,
    Scale: Widget, Orientation: {HORIZONTAL: 0},
    SignalListItemFactory: Widget, Box: Widget, Label: Widget, Image: Widget,
    StringList: {new: titles => titles}, Align: {CENTER: 0}, SelectionMode: {NONE: 0},
    FontDialogButton: Widget, FontDialog: Widget, FontLevel: {FACE: 2},
    accelerator_parse: text => [text.length > 0, text.length > 0 ? 1 : 0, 0]};
  const WEIGHTS = {Light: 300, Regular: 400, SemiBold: 600, Bold: 700};
  const fontDescription = text => ({copy() { return fontDescription(text); }, unset_fields() {}, to_string: () => text,
    get_weight: () => WEIGHTS[text.split(' ').pop()] ?? 400});
  const Pango = {FontDescription: {from_string: fontDescription}, FontMask: {SIZE: 1}};
  const dbusCalls = [];
  const bmsSchemas = '/home/test/.local/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas';
  const GioSettings = function (props) {
    return props?.settings_schema === 'blur-my-shell-popup' ? blurMyShell : new Settings(props);
  };
  const Gio = {Settings: GioSettings, SettingsBindFlags: {GET: 1, DEFAULT: 0}, DBusCallFlags: {NONE: 0},
    AppInfo: {get_all: () => []},
    SettingsSchemaSource: {get_default: () => null,
      new_from_directory: dir => ({lookup: id => dir === bmsSchemas && id === 'org.gnome.shell.extensions.blur-my-shell.popup'
        ? 'blur-my-shell-popup' : null})},
    Cancellable: class { cancel() { this.cancelled = true; } },
    DBus: {session: {
      call(_name, _path, _interface, method, _args, _type, _flags, _timeout, cancellable, callback) {
        dbusCalls.push(method);
        const response = dbusResponses.shift();
        queueMicrotask(() => callback({call_finish() {
          if (cancellable.cancelled) throw Error('Cancelled');
          if (response instanceof Error) throw response;
          return {deep_unpack: () => [response]};
        }}, {}));
      },
    }}};
  const GLib = {Variant, FileTest: {EXISTS: 16}, build_filenamev: parts => parts.join('/'),
    file_test: file => blurMyShell !== null && file === `${bmsSchemas}/gschemas.compiled`,
    get_user_data_dir: () => '/home/test/.local/share', get_system_data_dirs: () => ['/usr/share']};
  const load = createModuleLoader({Adw, Gtk, Gio, Gdk: {RGBA}, GLib, Pango});
  const settings = new Settings(); const window = new Widget();
  const {buildPreferences} = load(path.join(root, 'preferences/pages.js'));
  const controls = buildPreferences(window, settings);
  return {settings, window, controls, writes, values, ranges, widgets, load, listeners, dbusCalls,
    row: title => widgets.find(widget => widget.title === title)};
}

test('preferences expose four pages and eight shared appearance controls', () => {
  const f = fixture();
  assert.deepEqual(f.window.children.map(page => page.title), ['Appearance', 'Effects', 'Desktop', 'Rendering']);
  assert.equal(f.window.children[0].children.filter(group => group.title !== 'Settings' && group.visible !== false).flatMap(group => group.children).length, 8);
  assert.equal(f.widgets.filter(widget => /Spring|Sample Interval|X Offset|Y Offset/.test(widget.title ?? '')).length, 0);
  assert.equal(f.window.search_enabled, true);
});

test('opening and closing preferences preserves a customized configuration without writes', () => {
  const f = fixture({'dock-blur-radius': 3, 'menu-blur-radius': 20, 'menu-scale': 0.83,
    'quick-settings-apply-to': 1, 'shadow-intensity': 0});
  assert.match(f.row('Blur').subtitle, /Custom/);
  assert.equal(f.writes.length, 0);
  f.window.emit('close-request');
  assert.equal(f.writes.length, 0);
  assert.equal(f.values.get('menu-scale'), 0.83);
});

test('editing shared blur updates all eleven surfaces in one transaction and no other settings', () => {
  const f = fixture();
  f.row('Blur').value = 12;
  assert.equal(f.writes.length, 1);
  assert.equal(Object.keys(f.writes[0]).length, 11);
  assert.ok(Object.keys(f.writes[0]).every(key => key.endsWith('-blur-radius')));
  assert.ok(Object.values(f.writes[0]).every(value => value === 12));
  assert.equal(f.row('Blur').subtitle, '');
});

test('corners include toggle glass and changing them does not enable any effect', () => {
  const f = fixture(); f.row('Corners').value = 24;
  assert.equal(f.values.get('quick-settings-toggle-corner-radius'), 24);
  assert.equal(Object.keys(f.writes[0]).length, 12);
  assert.equal(f.values.get('enable-application-glass'), false);
  assert.equal(f.values.get('top-bar-style'), 'off');
});

test('Smooth uses critically damped motion across menus without changing their appearance', () => {
  const f = fixture(); f.row('Animations').selected = 1;
  for (const surface of ['menu', 'panel-menu', 'quick-settings']) {
    assert.equal(f.values.get(`enable-${surface}-animation`), true);
    const damping = f.values.get(`${surface}-spring-damping`);
    assert.ok(damping >= 2 * Math.sqrt(f.values.get(`${surface}-spring-stiffness`) * f.values.get(`${surface}-spring-mass`)));
  }
  assert.equal(f.values.get('menu-blur-radius'), 8);
  f.row('Animations').selected = 0;
  assert.equal(f.values.get('enable-menu-animation'), false);
});

test('Custom is a readout, not a reset preset', () => {
  const f = fixture(); f.row('Quality').selected = 3;
  assert.equal(f.writes.length, 0);
  assert.equal(f.row('Quality').selected, 0);
});

test('external settings updates refresh controls without a write feedback loop', () => {
  const f = fixture(); f.controls.write({'dock-blur-radius': 19});
  assert.equal(f.writes.length, 1);
  assert.equal(f.row('Blur').value, 19);
  assert.match(f.row('Blur').subtitle, /Custom/);
});

test('window rules only show the active list while window glass is enabled', () => {
  const f = fixture();
  assert.equal(f.row('Included applications').visible, false);
  assert.equal(f.row('Excluded applications').visible, false);
  f.controls.write({'enable-application-glass': true});
  assert.equal(f.row('Included applications').visible, true);
  f.controls.write({'application-glass-all-windows': true});
  assert.equal(f.row('Included applications').visible, false);
  assert.equal(f.row('Excluded applications').visible, true);
});

test('closing disconnects manually owned settings subscriptions', () => {
  const f = fixture(); const ownedIds = [...f.controls._ids];
  f.window.emit('close-request');
  assert.ok(ownedIds.every(id => !f.listeners.has(id)));
  f.controls.dispose();
});

test('switching preference views preserves effect settings and reuses advanced widgets', () => {
  const f = fixture({'dock-blur-radius': 3, 'menu-blur-radius': 20, 'menu-scale': 0.83});
  const before = new Map(f.values);
  assert.deepEqual(f.row('Settings view').model, ['Simple', 'Advanced']);
  f.row('Settings view').selected = 1;
  const count = f.widgets.length;
  assert.equal(f.row('Glass').visible, false);
  f.row('Settings view').selected = 0;
  assert.equal(f.row('Glass').visible, true);
  f.row('Settings view').selected = 1;
  assert.equal(f.widgets.length, count);
  for (const [key, value] of before) if (key !== 'preferences-advanced') assert.deepEqual(f.values.get(key), value, key);
  assert.ok(f.writes.every(patch => Object.keys(patch).join() === 'preferences-advanced'));
});

test('persisted advanced view opens without writes and exposes every surface', () => {
  const f = fixture({'preferences-advanced': true});
  const selector = f.row('Surface');
  for (let i = 0; i < selector.model.length; i++) selector.selected = i;
  assert.equal(f.writes.length, 0);
  const ownedIds = [...f.controls._ids];
  f.controls.dispose();
  assert.ok(ownedIds.every(id => !f.listeners.has(id)));
});

test('advanced surface edit changes only its own setting', () => {
  const f = fixture({'preferences-advanced': true});
  f.row('Surface').selected = 1;
  const group = f.window.children[0].children.find(group => group.title === 'Calendar');
  group.children.find(row => row.title === 'Blur').value = 17;
  assert.deepEqual(f.writes, [{'menu-blur-radius': 17}]);
  assert.match(f.row('Blur').subtitle, /Custom/);
  f.row('Surface').selected = 0;
  assert.equal(group.visible, false);
});

test('advanced top bar group owns its style and shows spacing only for pills', () => {
  const f = fixture({'preferences-advanced': true});
  const effects = f.window.children.find(page => page.title === 'Effects').children
    .find(group => group.title === 'Individual effects');
  assert.ok(!effects.children.some(row => row.title === 'Top bar'));
  f.row('Surface').selected = 8;
  const group = f.window.children[0].children.find(group => group.title === 'Top bar');
  const style = group.children.find(row => row.title === 'Style');
  const margin = group.children.find(row => row.title === 'Margin top');
  const padding = group.children.find(row => row.title === 'Padding right');
  assert.equal(margin.visible, false);
  style.selected = 1;
  assert.deepEqual(f.writes.at(-1), {'top-bar-style': 'pill'});
  assert.equal(margin.visible, true);
  assert.equal(padding.visible, true);
  margin.value = 12;
  assert.deepEqual(f.writes.at(-1), {'top-bar-margin-top': 12});
  style.selected = 2;
  assert.equal(margin.visible, true);
  style.selected = 0;
  assert.equal(padding.visible, false);
});

test('advanced animation intervals stay within their schema ranges on every animated surface', () => {
  const f = fixture({'preferences-advanced': true});
  for (const [index, title, surface] of [[1, 'Calendar', 'menu'], [2, 'Other top bar menus', 'panel-menu'],
    [4, 'Quick settings', 'quick-settings']]) {
    f.row('Surface').selected = index;
    const group = f.window.children[0].children.find(group => group.title === title);
    const row = group.children.find(widget => widget.title === 'Animation interval (ms)');
    const key = `${surface}-animation-interval-ms`;
    assert.equal(row.adjustment.lower, f.ranges.get(key).min, key);
    assert.equal(row.adjustment.upper, f.ranges.get(key).max, key);
    row.value = row.adjustment.upper;
    assert.equal(f.values.get(key), row.value);
    assert.deepEqual(f.writes.at(-1), {[key]: row.value});
  }
});

test('detected menus preserve exclusions and support legacy Vitals controls', () => {
  const f = fixture({'preferences-advanced': true, 'detected-extra-menus': ['vitalsMenu', 'exampleMenu'],
    'disabled-extra-menus': ['missingMenu', 'exampleMenu']});
  assert.equal(f.row('example Menu').active, false);
  f.row('example Menu').active = true;
  assert.deepEqual(f.values.get('disabled-extra-menus'), ['missingMenu']);
  f.row('Vitals').active = false;
  assert.equal(f.values.get('enable-vitals-menu-glass'), false);
  f.controls.write({'detected-extra-menus': []});
  assert.equal(f.row('No additional menus detected').visible, true);
});

test('advanced groups sit above the always-visible groups on each page', () => {
  const f = fixture({'preferences-advanced': true});
  const titles = name => f.window.children.find(page => page.title === name).children
    .filter(group => group.visible !== false).map(group => group.title);
  const effects = titles('Effects'), rendering = titles('Rendering');
  assert.ok(effects.indexOf('Individual effects') < effects.indexOf('Application windows'), effects.join(' | '));
  assert.ok(rendering.indexOf('Blur') < rendering.indexOf('Compatibility'), rendering.join(' | '));
  assert.ok(rendering.indexOf('Shadows') < rendering.indexOf('Troubleshooting'), rendering.join(' | '));
});

test('a fresh install shows the default shadow as the Soft preset, not Custom', () => {
  const f = fixture();
  assert.equal(f.row('Shadows').selected, 1);
});

test('the preferred text colour writes only its own surface key, and the dump shortcut has a switch', () => {
  const f = fixture({'preferences-advanced': true});
  f.row('Surface').selected = 1;
  const row = f.row('Preferred text color');
  assert.ok(row, 'calendar shows the preferred text colour');
  const before = f.writes.length;
  row.selected = 2;
  assert.deepEqual(f.writes.slice(before), [{'menu-adaptive-text-preference': 'dark'}]);
  assert.ok(f.row('Dump shortcut'));
});

test('visual controls get a slider on the same adjustment, spring constants do not', () => {
  const f = fixture({'preferences-advanced': true});
  for (const title of ['Blur', 'Corners', 'Tint strength', 'Refraction', 'Edge light', 'Edge shading'])
    assert.ok(f.row(title)._slider, `${title} has a slider`);
  assert.equal(f.row('Blur')._slider.adjustment, f.row('Blur').adjustment);
  f.row('Surface').selected = 1;
  const group = f.window.children[0].children.find(g => g.title === 'Calendar');
  const byTitle = title => group.children.find(row => row.title === title);
  for (const title of ['Blur', 'Brightness', 'Glass expansion', 'Horizontal offset', 'Menu scale'])
    assert.ok(byTitle(title)._slider, `${title} has a slider`);
  for (const title of ['Spring stiffness', 'Spring damping', 'Spring mass', 'Animation interval (ms)', 'Contrast interval (ms)'])
    assert.equal(byTitle(title)?._slider, undefined, `${title} stays a plain number`);
});

test('a slider dragged between steps stores the value the row displays', () => {
  const f = fixture();
  f.row('Blur').value = 12.6;
  assert.ok(Object.values(f.writes[0]).every(value => value === 13));
  f.row('Tint strength').value = 0.4567;
  assert.ok(Object.values(f.writes[1]).every(value => value === 0.46));
});

test('the Blur my Shell warning shows only while the shell reports popup blur, and can turn it off', () => {
  const popup = {blur: true, set_boolean(key, value) { this[key] = value; }};
  const f = fixture({}, [], popup);
  const row = f.row('Blur my Shell is blurring popups');
  const group = f.widgets.find(widget => widget instanceof Object && widget.children?.includes(row));
  assert.equal(group.visible, false);
  f.values.set('blur-my-shell-popup-blur', true);
  for (const {signal, fn} of f.listeners.values()) if (signal === 'changed::blur-my-shell-popup-blur') fn();
  assert.equal(group.visible, true);
  const button = f.widgets.find(widget => widget.label === 'Turn Off');
  button.emit('clicked');
  assert.equal(popup.blur, false);
  assert.equal(f.writes.length, 0, 'turning it off writes only Blur my Shell\'s setting');
});

test('the warning offers no button when Blur my Shell\'s settings cannot be found', () => {
  const f = fixture();
  assert.ok(f.row('Blur my Shell is blurring popups'));
  assert.equal(f.widgets.find(widget => widget.label === 'Turn Off'), undefined);
});
