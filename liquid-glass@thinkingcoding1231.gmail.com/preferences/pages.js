import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import { BUNDLED_FAMILIES } from '../dist/desktop/bundledFonts.js';
import { PreferenceControls, Branch, ToggleBranch, uniformPatch, dumpSettings, parseSettings } from './controls.js';
import { IconStyleRules, WindowRules } from './apps.js';

// The surfaces whose glass the simple view sets as one. The clock keeps its own look.
const SURFACES = ['dock', 'menu', 'panel-menu', 'notification', 'quick-settings', 'osd', 'application', 'desktop-menu',
  'top-bar', 'desktop-widget', 'launcher'];

const sharedKeys = suffix => SURFACES.map(surface => `${surface}-${suffix}`);

const ADAPTIVE_SURFACES = ['menu', 'panel-menu', 'notification', 'quick-settings', 'osd', 'top-bar',
  'desktop-widget', 'launcher'];

const TEXT_KEYS = ADAPTIVE_SURFACES.map(surface => `${surface}-enable-adaptive-text-color`);
const MENU_KEYS = ['enable-menu-glass', 'enable-quick-settings-glass', 'enable-extra-menu-glass', 'enable-desktop-menu-glass'];
const POPUP_KEYS = ['enable-notification-glass', 'enable-osd-glass'];
const MOTION_KEYS = ['menu', 'panel-menu', 'quick-settings'].map(surface => `enable-${surface}-animation`);
const GROW_KEYS = ['menu', 'panel-menu'].map(surface => `${surface}-grow-from-button`);

const smoothMotion = Object.fromEntries(['menu', 'panel-menu', 'quick-settings'].flatMap(surface => [
  [`enable-${surface}-animation`, true],
  [`${surface}-spring-stiffness`, 120],
  [`${surface}-spring-damping`, 22],
  [`${surface}-spring-mass`, 1],
  [`${surface}-animation-interval-ms`, 16],
]));

const MOTION = [
  {
    title: 'Off', patch: {
      ...uniformPatch(MOTION_KEYS, false), 'quick-settings-toggle-animation': false, 'desktop-widget-menu-animation': 'off',
    }
  },
  { title: 'Smooth', patch: { ...smoothMotion, 'quick-settings-toggle-animation': true, 'desktop-widget-menu-animation': 'morph' } },
];

const QUALITY = [
  { title: 'Sharp', patch: { 'blur-method': 0, 'glass-blur-downscale': 2 } },
  { title: 'Balanced', patch: { 'blur-method': 1, 'glass-blur-downscale': 2 } },
  { title: 'Fast', patch: { 'blur-method': 1, 'glass-blur-downscale': 4 } },
];

const TOP_BAR = [
  { title: 'Off', patch: { 'top-bar-style': 'off' } },
  { title: 'One pill', patch: { 'top-bar-style': 'pill' } },
  { title: 'Three pills', patch: { 'top-bar-style': 'islands' } },
  { title: 'Centered pill', patch: { 'top-bar-style': 'center' } },
];

const QUICK_SETTINGS_GLASS = [
  { title: 'Whole menu', patch: { 'quick-settings-apply-to': 0 } },
  { title: 'Individual buttons', patch: { 'quick-settings-apply-to': 1 } },
];

const QUICK_SETTINGS_GLASS_HINT = 'Whole menu: one pane of glass behind the entire menu. ' +
  'Individual buttons: only the toggle buttons become glass, on the theme\'s own menu background';

const booleanChoices = keys => [
  { title: 'Off', patch: uniformPatch(keys, false) },
  { title: 'On', patch: uniformPatch(keys, true) },
];

// The surfaces of the advanced view: id (the prefix of its keys), title, the switch that shows its glass, and a hint for that switch.
const SURFACE_OPTIONS = [
  ['dock', 'Dock', 'enable-dock-glass'],
  ['menu', 'Calendar', 'enable-menu-glass'],
  ['panel-menu', 'Other top bar menus', 'enable-extra-menu-glass',
    'Menus of the other top bar indicators: keyboard layout, accessibility, extensions'],
  ['notification', 'Notifications', 'enable-notification-glass'],
  ['quick-settings', 'Quick settings', 'enable-quick-settings-glass'],
  ['osd', 'Volume and brightness', 'enable-osd-glass'],
  ['application', 'Application windows', 'enable-application-glass'],
  ['desktop-menu', 'Desktop menu', 'enable-desktop-menu-glass'],
  ['top-bar', 'Top bar', null],
  ['desktop-widget', 'Desktop widgets', null],
  ['glass-clock', 'Desktop clock', null],
  ['launcher', 'Launcher', null],
];

const APPEARANCE = [
  ['blur-radius', 'Blur', 0, 30, 1],
  ['corner-radius', 'Corners', 0, 200, 1],
  ['tint-strength', 'Tint strength', 0, 1, 0.01],
  ['brightness', 'Brightness', 0.5, 1.5, 0.01],
  ['contrast', 'Contrast', 0.5, 1.5, 0.01],
  ['saturation', 'Saturation', 0, 2, 0.01],
];

const LAYOUT = {
  dock: [['glass-expand', 'Glass expansion', 0, 50, 1], ['margin-bottom', 'Edge spacing', -5, 30, 1]],
  menu: [['glass-expand', 'Glass expansion', 0, 50, 1], ['x-offset', 'Horizontal offset', -200, 200, 1],
  ['y-offset', 'Vertical offset', -50, 100, 1], ['scale', 'Menu scale', 0.5, 1, 0.01]],
  'panel-menu': [['glass-expand', 'Glass expansion', 0, 50, 1], ['x-offset', 'Horizontal offset', -200, 200, 1],
  ['y-offset', 'Vertical offset', -50, 100, 1], ['scale', 'Menu scale', 0.5, 1, 0.01]],
  notification: [['glass-expand', 'Glass expansion', 0, 50, 1], ['y-offset', 'Vertical offset', 0, 100, 1]],
  'quick-settings': [['glass-expand', 'Glass expansion', 0, 50, 1], ['x-offset', 'Horizontal offset', -100, 100, 1],
  ['y-offset', 'Vertical offset', -100, 100, 1], ['toggle-tint-strength', 'Button base color', 0, 1, 0.01],
  ['toggle-corner-radius', 'Button corners', 0, 60, 1]],
  osd: [['glass-expand', 'Glass expansion', 0, 50, 1], ['y-offset', 'Vertical offset', -100, 100, 1]],
  application: [],
  'desktop-menu': [['content-opacity', 'Content opacity', 0, 1, 0.01]],
  'top-bar': [['margin-top', 'Margin top', 0, 50, 1], ['margin-bottom', 'Margin bottom', 0, 50, 1],
  ['margin-left', 'Margin left', 0, 50, 1], ['margin-right', 'Margin right', 0, 50, 1],
  ['padding-top', 'Padding top', 0, 50, 1], ['padding-bottom', 'Padding bottom', 0, 50, 1],
  ['padding-left', 'Padding left', 0, 50, 1], ['padding-right', 'Padding right', 0, 50, 1]],
  'desktop-widget': [],
  'glass-clock': [],
  launcher: [],
};

const SPRING = [
  ['spring-stiffness', 'Spring stiffness', 0, 1000, 0.1],
  ['spring-damping', 'Spring damping', 0, 1000, 0.1],
  ['spring-mass', 'Spring mass', 0, 1, 0.1],
  ['animation-interval-ms', 'Animation interval (ms)', 0, 50, 1],
];

const OPTICS = [
  ['glass-max-z', 'Thickness', 0, 100, 1],
  ['glass-displacement-scale', 'Refraction', 0, 200, 1],
  ['glass-edge-smoothing', 'Edge smoothing', 0, 10, 0.1],
  ['glass-profile-shape-n', 'Surface curvature', 1, 20, 0.1],
  ['glass-ior', 'Index of refraction', 1, 4, 0.01],
  ['glass-chroma-strength', 'Color separation', 0, 1, 0.01],
  ['glass-corner-smoothing', 'Corner smoothing', 0, 1, 0.01],
];

const LIGHTING = [
  ['glass-specular-intensity', 'Highlights', 0, 5, 0.1],
  ['glass-shininess', 'Shininess', 1, 200, 1],
  ['glass-rim-width', 'Edge light width', 0, 20, 0.1],
  ['glass-rim-intensity', 'Edge light', 0, 5, 0.1],
  ['glass-rim-directional-power', 'Edge directionality', 0, 10, 0.1],
  ['glass-rim-power', 'Edge falloff', 0, 20, 0.1],
  ['glass-rim-light-color-intensity', 'Edge color strength', 0, 5, 0.1],
  ['glass-sheen-intensity', 'Sheen', 0, 2, 0.01],
  ['glass-light-angle-deg', 'Light angle', 0, 360, 1],
];

const SHADOWS = [
  ['shadow-radius', 'Shadow radius', 0, 100, 1],
  ['shadow-intensity', 'Shadow strength', 0, 1, 0.01],
  ['glass-ao-intensity', 'Inner shading', 0, 1, 0.01],
  ['glass-ao-radius', 'Inner shading radius', 0, 50, 0.5],
];

const LEGACY_MENUS = {
  keyboard: ['enable-keyboard-menu-glass', 'Keyboard layout'],
  vitalsMenu: ['enable-vitals-menu-glass', 'Vitals'],
};

const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell';

// The parts of Blur my Shell that Liquid Glass can override.
const BMS_PARTS = [
  ['popups', 'Menus and popups', 'Blur my Shell blurs dialogs and switchers with the same setting'],
  ['panel', 'Top bar', ''],
  ['dock', 'Dock', ''],
  ['applications', 'Application windows', 'All of its window blur, on windows without glass too'],
];

const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const USER_AGENT = 'Liquid Glass GNOME Shell extension (https://github.com/ryohsuke1231/liquid-glass)';
const MAX_PLACES = 8;

const PLACES = [
  ['top-left', 'Top left'],
  ['top-right', 'Top right'],
  ['bottom-left', 'Bottom left'],
  ['bottom-right', 'Bottom right'],
  ['center', 'Center'],
];

const WIDGETS = [
  ['weather', 'Weather', 'For the place below, or the location set in GNOME Weather'],
  ['events', 'Up next', 'The rest of today and tomorrow from your calendars'],
  ['media', 'Now playing', 'Shown while a music or video player is running'],
];

const WEIGHTS = ['Light', 'Regular', 'SemiBold', 'Bold'];

// Open-Meteo matches names in the language it is asked for, so a name
// typed in another script is looked up again in the languages written in it.
const SCRIPTS = [[/[぀-ヿ]/, ['ja']], [/[一-鿿]/, ['ja', 'zh']], [/[가-힯]/, ['ko']],
[/[Ѐ-ӿ]/, ['ru', 'uk']]];

// Blur my Shell's settings for `part` (such as "popup"), from the schemas it
// ships in the user's or a system extension directory, as its own
// getSettings() reads them.
function blurMyShellSettings(part) {
  const id = `${BMS_SCHEMA}.${part}`;
  const defaultSource = Gio.SettingsSchemaSource.get_default();
  const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
    .map(dir => GLib.build_filenamev([dir, 'gnome-shell', 'extensions', BMS_UUID, 'schemas']));
  for (const dir of dirs) {
    if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) continue;
    // Loading a compiled schema file throws a GError when it is unreadable.
    try {
      const schema = Gio.SettingsSchemaSource.new_from_directory(dir, defaultSource, false).lookup(id, false);
      if (schema) return new Gio.Settings({ settings_schema: schema });
    } catch {
      continue;
    }
  }
  const schema = defaultSource?.lookup(id, true);
  return schema ? new Gio.Settings({ settings_schema: schema }) : null;
}

// Shown while the shell reports Blur my Shell's popup blur on: it repaints the
// menus, notifications and OSDs under the glass, where it shows through.
function addBlurMyShellWarning(page, controls) {
  const group = new Adw.PreferencesGroup();
  const bmsKeys = ['panel', 'dock', 'applications'].map(part => `blur-my-shell-${part}-blur`);
  const conflicting = () => controls.settings.get_boolean('enable-blur-my-shell')
    && bmsKeys.some(key => controls.settings.get_boolean(key));

  const overrideRow = new Adw.ActionRow({ title: 'Possible Blur My Shell conflict' });
  overrideRow.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
  const overrideButton = new Gtk.Button({ label: 'Go to override settings', valign: Gtk.Align.CENTER });
  overrideRow.add_suffix(overrideButton);
  let scrollTick = 0;
  overrideButton.connect('clicked', () => {
    const window = page.get_root();
    const targetGroup = findWidgetByName(window, 'compatibility-group');
    if (!targetGroup) return;
    window.visible_page_name = 'rendering';
    if (scrollTick) targetGroup.remove_tick_callback(scrollTick);
    // A page that has never been shown has no allocation yet, so wait for a frame where it has one.
    scrollTick = targetGroup.add_tick_callback(() => {
      const scrolled = targetGroup.get_ancestor(Gtk.ScrolledWindow);
      if (targetGroup.get_height() === 0 || scrolled.get_height() === 0) return GLib.SOURCE_CONTINUE;
      scrollTick = 0;
      // Focusing the row alone only scrolls until it peeks in at the bottom edge.
      // The point is relative to the viewport, so it is an offset from the current scroll position.
      const [, point] = targetGroup.compute_point(scrolled.get_child(), new Graphene.Point({ x: 0, y: 0 }));
      scrolled.vadjustment.value += point.y - 12;
      findWidgetByName(targetGroup, 'blur-my-shell-override').grab_focus();
      return GLib.SOURCE_REMOVE;
    });
  });
  group.add(overrideRow);
  page.add(group);
  controls.watch(['enable-blur-my-shell', ...bmsKeys], () => {
    group.visible = conflicting();
  });
}

function findWidgetByName(parent, name) {
  if (!parent) return null;
  if (parent.name === name) return parent;
  for (let child = parent.get_first_child(); child !== null; child = child.get_next_sibling()) {
    const found = findWidgetByName(child, name);
    if (found) return found;
  }
  return null;
}

// Shown while Blur my Shell is installed.
function addCompatibility(page, controls) {
  if (!blurMyShellSettings('popup')) return;
  const settings = controls.settings;
  const group = controls.group(page, 'Compatibility', '', 'compatibility-group');
  const override = controls.toggle(group, 'Override Blur my Shell', 'blur-my-shell-override',
    'Turns off Blur my Shell\'s blur where there is glass, and back on when this is off or Liquid Glass is turned off', 'blur-my-shell-override');
  const branch = new Branch(override);
  for (const [part, title, subtitle] of BMS_PARTS) {
    const row = branch.add(new Adw.SwitchRow({ title, subtitle }));
    group.add(row);
    row.connect('notify::active', () => {
      const parts = settings.get_strv('blur-my-shell-override-parts');
      if (row.active === parts.includes(part)) return;
      settings.set_strv('blur-my-shell-override-parts', row.active ? [...parts, part] : parts.filter(p => p !== part));
    });
    controls.watch(['blur-my-shell-override-parts'], () => {
      row.active = settings.get_strv('blur-my-shell-override-parts').includes(part);
    });
  }
  controls.watch(['blur-my-shell-override'], () => { branch.enabled = settings.get_boolean('blur-my-shell-override'); });
}

function addBackup(page, controls, window) {
  const group = controls.group(page, 'Backup', 'Keep your settings in a file, or move them to another computer.');
  const toast = title => window.add_toast(new Adw.Toast({ title }));
  const row = (title, subtitle, label, run) => {
    const action = new Adw.ActionRow({ title, subtitle });
    const button = new Gtk.Button({ label, valign: Gtk.Align.CENTER });
    button.connect('clicked', run);
    action.add_suffix(button);
    action.activatable_widget = button;
    group.add(action);
  };
  const dialog = title => new Gtk.FileDialog({ title, initial_name: 'liquid-glass-settings.txt' });

  row('Export settings', 'Saves every setting to a file', 'Export…', () => {
    dialog('Export Settings').save(window, null, (self, result) => {
      let file;
      try {
        file = self.save_finish(result);
      } catch (error) {
        if (!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) toast(`Could not export: ${error.message}`);
        return;
      }
      try {
        file.replace_contents(new TextEncoder().encode(dumpSettings(controls.settings)), null, false,
          Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        toast('Settings exported');
      } catch (error) {
        toast(`Could not export: ${error.message}`);
      }
    });
  });

  row('Import settings', 'Loads a file saved with Export; settings it does not hold stay as they are', 'Import…', () => {
    dialog('Import Settings').open(window, null, (self, result) => {
      let text;
      try {
        const [, bytes] = self.open_finish(result).load_contents(null);
        text = new TextDecoder().decode(bytes);
      } catch (error) {
        if (!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) toast(`Could not import: ${error.message}`);
        return;
      }
      const { changes, skipped } = parseSettings(controls.settings, text);
      if (changes.length === 0) {
        toast('Nothing to import in that file');
        return;
      }
      controls.commit(changes);
      toast(skipped ? `Imported ${changes.length} settings, skipped ${skipped}` : `Imported ${changes.length} settings`);
    });
  });
}

function addPanelMenus(page, controls) {
  const group = controls.group(page, 'Detected top bar menus',
    'Menus of the other top bar indicators. The calendar and quick settings have their own settings.');
  const empty = new Adw.ActionRow({ title: 'No additional menus detected' });
  group.add(empty);
  const rows = new Map();
  const settings = controls.settings;
  let syncing = false;
  const add = name => {
    const title = LEGACY_MENUS[name]?.[1] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
    const row = new Adw.SwitchRow({ title, use_markup: false });
    row.connect('notify::active', () => {
      if (syncing) return;
      if (LEGACY_MENUS[name]) {
        controls.write({ [LEGACY_MENUS[name][0]]: row.active });
        return;
      }
      const disabled = new Set(settings.get_strv('disabled-extra-menus'));
      if (row.active) disabled.delete(name);
      else disabled.add(name);
      controls.write({ 'disabled-extra-menus': [...disabled].sort() });
    });
    rows.set(name, row);
    group.add(row);
    return row;
  };
  controls.watch(['detected-extra-menus', 'disabled-extra-menus', 'enable-extra-menu-glass',
    ...Object.values(LEGACY_MENUS).map(([key]) => key)], () => {
      syncing = true;
      const names = settings.get_strv('detected-extra-menus');
      const disabled = new Set(settings.get_strv('disabled-extra-menus'));
      for (const [name, row] of rows) {
        if (names.includes(name)) continue;
        group.remove(row);
        rows.delete(name);
      }
      for (const name of names) {
        const row = rows.get(name) ?? add(name);
        row.active = LEGACY_MENUS[name] ? settings.get_boolean(LEGACY_MENUS[name][0]) : !disabled.has(name);
      }
      empty.visible = names.length === 0;
      group.sensitive = settings.get_boolean('enable-extra-menu-glass');
      syncing = false;
    });
  return group;
}

function jsonSetting(settings, key) {
  try {
    return JSON.parse(settings.get_value(key).deep_unpack()) ?? {};
  } catch {
    return {};
  }
}

const movedPositions = settings => jsonSetting(settings, 'desktop-item-positions');

// A place on the desktop for `key`: the clock's (`id` "clock") or the one
// the widgets share (`id` null). Moved items, and widgets given a place of
// their own from their menu, are reported; picking a place puts them back.
function placeRow(group, controls, title, key, id) {
  const settings = controls.settings;
  const row = new Adw.ComboRow({
    title,
    model: Gtk.StringList.new([...PLACES.map(([, name]) => name), id ? 'Where it was moved' : 'Where each was put']),
  });
  row.list_factory = controls.readoutListFactory(row, PLACES.length);
  group.add(row);
  let syncing = false;
  const refresh = () => {
    syncing = true;
    const value = settings.get_value(key).deep_unpack();
    const own = id ? false : Object.values(jsonSetting(settings, 'desktop-widget-anchors')).some(anchor => anchor !== value);
    const moved = id ? id in movedPositions(settings)
      : Object.keys(movedPositions(settings)).some(item => item !== 'clock');
    const index = PLACES.findIndex(([place]) => place === value);
    row.selected = moved || own ? PLACES.length : Math.max(index, 0);
    syncing = false;
  };
  row.connect('notify::selected', () => {
    if (syncing) return;
    if (row.selected >= PLACES.length) {
      refresh();
      return;
    }
    const positions = movedPositions(settings);
    for (const item of Object.keys(positions)) {
      if (id ? item === id : item !== 'clock') delete positions[item];
    }
    controls.write({
      [key]: PLACES[row.selected][0], 'desktop-item-positions': JSON.stringify(positions),
      ...id ? {} : { 'desktop-widget-anchors': '{}' },
    });
  });
  controls.watch([key, 'desktop-item-positions', 'desktop-widget-anchors'], refresh);
  return row;
}

// The weight in a description such as "Antonio SemiBold" after `family`, as an index into WEIGHTS.
function weightIndex(description, family) {
  const weight = Pango.FontDescription.from_string(`Sans${description.slice(family.length)}`).get_weight();
  const values = [300, 400, 600, 700];
  return values.reduce((best, v, i) => Math.abs(v - weight) < Math.abs(values[best] - weight) ? i : best, 0);
}

// The clock's font: one the extension ships, in one of its weights, the
// interface font in bold, or any installed font.
function fontRows(group, controls) {
  const settings = controls.settings;
  const families = Object.keys(BUNDLED_FAMILIES);
  const row = new Adw.ComboRow({
    title: 'Font',
    model: Gtk.StringList.new([...families, 'Interface font', 'Installed font']),
  });
  const button = new Gtk.FontDialogButton({
    valign: Gtk.Align.CENTER, level: Gtk.FontLevel.FACE,
    dialog: new Gtk.FontDialog({ title: 'Clock Font' }),
  });
  row.add_suffix(button);
  const weight = new Adw.ComboRow({ title: 'Weight', model: Gtk.StringList.new(WEIGHTS) });
  group.add(row);
  group.add(weight);
  const interfaceIndex = families.length;
  let syncing = false;
  const familyOf = value => families.find(name => value === name || value.startsWith(`${name} `));
  controls.watch(['glass-clock-font'], () => {
    syncing = true;
    const value = settings.get_value('glass-clock-font').deep_unpack();
    const family = familyOf(value);
    row.selected = family ? families.indexOf(family) : value === '' ? interfaceIndex : interfaceIndex + 1;
    weight.visible = !!family;
    if (family) weight.selected = weightIndex(value, family);
    button.visible = !family && value !== '';
    if (button.visible) button.font_desc = Pango.FontDescription.from_string(value);
    syncing = false;
  });
  const writeBundled = () => controls.write({
    'glass-clock-font': `${families[row.selected]} ${WEIGHTS[weight.selected]}`,
  });
  row.connect('notify::selected', () => {
    if (syncing) return;
    if (row.selected < families.length) {
      writeBundled();
    } else if (row.selected === interfaceIndex) {
      controls.write({ 'glass-clock-font': '' });
    } else {
      // Kept until a font is picked with the button.
      button.visible = true;
      weight.visible = false;
    }
  });
  weight.connect('notify::selected', () => {
    if (!syncing && row.selected < families.length) writeBundled();
  });
  button.connect('notify::font-desc', () => {
    if (syncing || !button.font_desc) return;
    const desc = button.font_desc.copy();
    desc.unset_fields(Pango.FontMask.SIZE);
    controls.write({ 'glass-clock-font': desc.to_string() });
  });
}

// The interface's language, as Open-Meteo takes it for place names.
function language() {
  const code = (GLib.get_language_names()[0] ?? 'en').split(/[_.@]/)[0];
  return code === 'C' || code === 'POSIX' ? 'en' : code;
}

async function searchPlaces(session, text, cancellable) {
  const tried = new Set();
  for (const lang of [language(), ...SCRIPTS.filter(([script]) => script.test(text)).flatMap(([, langs]) => langs)]) {
    if (tried.has(lang)) continue;
    tried.add(lang);
    const places = await searchPlacesIn(session, text, lang, cancellable);
    if (places.length > 0) return places;
  }
  return [];
}

function searchPlacesIn(session, text, lang, cancellable) {
  const message = Soup.Message.new('GET', `${GEOCODING}?format=json&count=${MAX_PLACES}` +
    `&language=${lang}&name=${encodeURIComponent(text)}`);
  return new Promise((resolve, reject) => {
    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, res) => {
      try {
        const bytes = session.send_and_read_finish(res);
        if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
        resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())).results ?? []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

// The weather widget's place: a town or city looked up by name, down to the
// smallest ones (GNOME Weather knows only the larger cities).
function weatherPlaceRows(group, controls) {
  const settings = controls.settings;
  const hasWeather = Gio.AppInfo.get_all().some(app => app.get_id() === 'org.gnome.Weather.desktop');
  const current = new Adw.ActionRow({ title: 'Weather place' });
  const reset = new Gtk.Button({
    icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
    tooltip_text: hasWeather ? 'Use the location set in GNOME Weather' : 'Forget the place',
  });
  current.add_suffix(reset);
  group.add(current);
  const search = new Adw.EntryRow({ title: 'Search for a city or town', show_apply_button: true });
  group.add(search);

  controls.watch(['weather-place'], () => {
    const [name] = settings.get_value('weather-place').deep_unpack();
    current.subtitle = name || (hasWeather ? 'The location set in GNOME Weather' : 'None');
    reset.sensitive = name !== '';
  });
  reset.connect('clicked', () => controls.write({ 'weather-place': ['', 0, 0] }));

  let found = [];
  let session = null;
  let cancellable = null;
  const showFound = rows => {
    for (const row of found) group.remove(row);
    found = rows;
    for (const row of rows) group.add(row);
  };
  const run = async text => {
    cancellable?.cancel();
    showFound([]);
    if (!text) return;
    cancellable = new Gio.Cancellable();
    session ??= new Soup.Session({ user_agent: USER_AGENT, timeout: 20 });
    let places;
    try {
      places = await searchPlaces(session, text, cancellable);
    } catch (error) {
      if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      showFound([new Adw.ActionRow({ title: 'The search failed', subtitle: String(error.message ?? error) })]);
      return;
    }
    if (places.length === 0) {
      showFound([new Adw.ActionRow({ title: `Nothing called “${text}” was found` })]);
      return;
    }
    showFound(places.map(place => {
      const row = new Adw.ActionRow({
        title: place.name, activatable: true,
        subtitle: [place.admin2 !== place.name ? place.admin2 : '', place.admin1, place.country].filter(Boolean).join(', '),
      });
      row.connect('activated', () => {
        controls.write({ 'weather-place': [place.name, place.latitude, place.longitude] });
        search.text = '';
        showFound([]);
      });
      return row;
    }));
  };
  search.connect('apply', () => {
    run(search.text.trim());
  });
  group.connect('destroy', () => cancellable?.cancel());
  return [current, search];
}

function addClock(page, controls) {
  const group = controls.group(page, 'Glass clock',
    'A large clock whose digits are glass. Right-click it to move or resize it. ' +
    'Its place, size, font and glass are set on the Appearance page, in the advanced view.');
  const show = controls.toggle(group, 'Show the clock', 'enable-glass-clock');
  const details = new Branch(show);
  details.add(controls.choice(group, 'Time format', [
    { title: 'As in Settings', patch: { 'glass-clock-format': 'system' } },
    { title: '24-hour', patch: { 'glass-clock-format': '24h' } },
    { title: '12-hour', patch: { 'glass-clock-format': '12h' } },
  ], '', false));
  details.add(controls.toggle(group, 'Show the date', 'glass-clock-show-date'));
  controls.watch(['enable-glass-clock'], () => { details.enabled = show.active; });
}

function addWidgets(page, controls) {
  const settings = controls.settings;
  const group = controls.group(page, 'Widgets',
    'Cards of glass on the desktop, below the windows. Right-click one to move it.');
  const show = controls.toggle(group, 'Show widgets', 'enable-desktop-widgets');
  const rows = [];
  for (const [id, title, subtitle] of WIDGETS) {
    const row = new Adw.SwitchRow({ title, subtitle });
    group.add(row);
    let syncing = false;
    controls.watch(['desktop-widgets'], () => {
      syncing = true;
      row.active = settings.get_strv('desktop-widgets').includes(id);
      syncing = false;
    });
    row.connect('notify::active', () => {
      if (syncing) return;
      const chosen = new Set(settings.get_strv('desktop-widgets'));
      if (row.active) chosen.add(id);
      else chosen.delete(id);
      controls.write({ 'desktop-widgets': WIDGETS.map(([w]) => w).filter(w => chosen.has(w)) });
    });
    rows.push(row);
  }
  rows.push(controls.toggle(group, 'Sound bars', 'media-visualizer',
    'On Now playing. GNOME shows the microphone indicator while they listen'));
  rows.push(placeRow(group, controls, 'Place', 'desktop-widgets-position', null));
  rows.push(controls.choice(group, 'Temperature', [
    { title: 'Automatic', patch: { 'weather-temperature-unit': 'auto' } },
    { title: 'Celsius', patch: { 'weather-temperature-unit': 'celsius' } },
    { title: 'Fahrenheit', patch: { 'weather-temperature-unit': 'fahrenheit' } },
  ], '', false));
  rows.push(...weatherPlaceRows(group, controls));
  controls.watch(['enable-desktop-widgets'], () => {
    for (const row of rows) row.sensitive = show.active;
  });
}

function addLauncher(page, controls) {
  const group = controls.group(page, 'Launcher',
    'A search field on glass, with the same results as the overview\'s search.');
  controls.toggle(group, 'Search launcher', 'enable-launcher');
  controls.shortcut(group, 'Shortcut', 'launcher-shortcut');
}

function addNumbers(group, controls, specs, prefix = '', slider = true) {
  return new Map(specs.map(([key, title, min, max, step]) => [key,
    controls.number(group, title, [`${prefix}${key}`], min, max, step, '', { slider })]));
}

function addMotion(group, controls, surface) {
  const key = `enable-${surface}-animation`;
  const growKey = `${surface}-grow-from-button`;
  const toggle = controls.toggle(group, 'Animations', key);
  // Individual buttons mode has an animation of its own, and nothing to tune.
  const buttonsToggle = surface === 'quick-settings'
    ? controls.toggle(group, 'Animations', 'quick-settings-toggle-animation', 'The buttons spring out of the middle of the menu as it opens')
    : null;
  const branch = new Branch(toggle);
  const morphToggle = branch.add(controls.toggle(group, 'Grow from the button', growKey,
    'The glass leaves the button as a drop and stretches into the menu'));
  // Spring constants and intervals mean their number; no slider.
  const morphBranch = new ToggleBranch(morphToggle, 2);
  morphBranch.add(controls.number(group, 'Morph speed', [`${surface}-morph-speed`], 0.1, 3, 0.1), 0);
  for (const row of addNumbers(group, controls, SPRING, `${surface}-`, false).values()) morphBranch.add(row, 1);
  const keys = surface === 'quick-settings' ? [key, 'quick-settings-apply-to'] : [key];
  controls.watch(keys, () => {
    const panel = surface !== 'quick-settings' || controls.settings.get_value('quick-settings-apply-to').deep_unpack() === 0;
    toggle.visible = panel;
    if (buttonsToggle) buttonsToggle.visible = !panel;
    branch.enabled = panel && controls.settings.get_boolean(key);
  });
  controls.watch([growKey], () => { morphBranch.switch = controls.settings.get_boolean(growKey) ? 0 : 1; });
}

function addOutline(group, controls, surface) {
  const key = `${surface}-outline-enabled`;
  const toggle = controls.toggle(group, 'Outline', key, 'A line along the visible edge of the glass, for seeing it better');
  const branch = new Branch(toggle);
  branch.add(controls.number(group, 'Outline width', [`${surface}-outline-width`], 0.5, 10, 0.5, '', { slider: true }));
  branch.add(controls.color(group, 'Outline color', [`${surface}-outline-color`]));
  controls.watch([key], () => { branch.enabled = controls.settings.get_boolean(key); });
}

// Glass that grows out of the screen edge instead of floating, with the margin to that edge turned off meanwhile.
// `shown` hides the rows while the surface has no glass, and is checked again when one of `shownKeys` changes.
function addEdgeAttachment(group, controls, surface, marginRow, shownKeys = [], shown = () => true) {
  const key = `${surface}-attach-to-edge`;
  const toggle = controls.toggle(group, 'Grow out of the screen edge', key,
    'The glass reaches the edge and curves outwards into it');
  const branch = new Branch(toggle);
  branch.add(controls.number(group, 'Edge flare radius', [`${surface}-edge-radius`], 0, 64, 1, '', { slider: true }));
  controls.watch([key, ...shownKeys], () => {
    const attached = controls.settings.get_boolean(key);
    toggle.visible = shown();
    branch.enabled = attached && shown();
    marginRow.sensitive = !attached;
  });
}

function addLayout(group, controls, surface, appearance) {
  const rows = addNumbers(group, controls, LAYOUT[surface], `${surface}-`);
  if (surface === 'menu' || surface === 'panel-menu') {
    const key = `${surface}-match-quick-settings-height`;
    controls.toggle(group, 'Match quick settings height', key);
    controls.watch([key], () => { rows.get('scale').sensitive = !controls.settings.get_boolean(key); });
  }
  if (surface === 'dock') addEdgeAttachment(group, controls, surface, rows.get('margin-bottom'));
  if (surface === 'top-bar') {
    const shown = () => controls.settings.get_value('top-bar-style').deep_unpack() !== 'off';
    controls.watch(['top-bar-style'], () => {
      for (const row of rows.values()) row.visible = shown();
    });
    addEdgeAttachment(group, controls, surface, rows.get('margin-top'), ['top-bar-style'], shown);
  }
  if (surface === 'quick-settings') {
    controls.watch(['quick-settings-apply-to'], () => {
      const buttons = controls.settings.get_value('quick-settings-apply-to').deep_unpack() === 1;
      for (const key of ['toggle-tint-strength', 'toggle-corner-radius']) rows.get(key).visible = buttons;
      for (const key of ['x-offset', 'y-offset']) rows.get(key).visible = !buttons;
      appearance.get('corner-radius').visible = !buttons;
    });
  }
}

function addClockShape(group, controls) {
  placeRow(group, controls, 'Place', 'glass-clock-position', 'clock');
  controls.number(group, 'Size', ['glass-clock-size'], 48, 960, 1, '', { slider: true });
  controls.number(group, 'Width', ['glass-clock-stretch'], 0.3, 4, 0.01, '', { slider: true });
  controls.number(group, 'Height', ['glass-clock-height'], 1, 3, 0.01, '', { slider: true });
  controls.choice(group, 'Taller digits', [
    { title: 'Evenly', patch: { 'glass-clock-tall-style': 'even' } },
    { title: 'Along upright strokes', patch: { 'glass-clock-tall-style': 'upright' } },
  ], 'How the digits grow when the height is above 1', false);
  fontRows(group, controls);
}

function addLauncherLayout(group, controls) {
  const transition = controls.choice(group, 'Change to pinned items', [
    { title: 'Morph', patch: { 'launcher-pinned-transition': 'morph' } },
    { title: 'Ease', patch: { 'launcher-pinned-transition': 'tween' } },
  ], 'Ctrl+P shows the pinned items.', false);
  const morphBranch = new Branch(transition);
  morphBranch.add(controls.number(group, 'Spring response', ['launcher-spring-response'], 0, 3, 0.01,
    'How fast the springs respond to changes in the menu\'s size'));
  morphBranch.add(controls.number(group, 'Spring damping fraction', ['launcher-spring-damping-fraction'], 0, 5, 0.01,
    'How much the springs damp when they reach their target'));
  controls.watch(['launcher-pinned-transition'], () => {
    morphBranch.enabled = controls.settings.get_value('launcher-pinned-transition').deep_unpack() === 'morph';
  });
  controls.number(group, 'Width', ['launcher-width'], 320, 1400, 10, 'Of the search field and its results', { slider: true });
  controls.number(group, 'Pinned items height', ['launcher-pinned-height'], 240, 1200, 10, '', { slider: true });
  controls.number(group, 'Pinned icon size', ['launcher-pinned-icon-size'], 32, 96, 4,
    'Fewer, larger tiles in a narrow launcher; the tiles are spread evenly over the row', { slider: true });
}

function addAdaptiveColor(group, controls, surface) {
  const key = `${surface}-enable-adaptive-text-color`;
  const toggle = controls.toggle(group, 'Adaptive color', key, 'Text and icons turn light or dark to stay readable on the glass');
  const branch = new Branch(toggle);
  branch.add(controls.number(group, 'Adaptive color interval (ms)', [`${surface}-sample-interval-ms`], 100, 2000, 50));
  const preferenceKey = `${surface}-adaptive-text-preference`;
  branch.add(controls.choice(group, 'Preferred text color', [
    { title: 'Automatic', patch: { [preferenceKey]: 'auto' } },
    { title: 'Light', patch: { [preferenceKey]: 'light' } },
    { title: 'Dark', patch: { [preferenceKey]: 'dark' } },
  ], 'Decides only when both colors are equally readable', false));
  controls.watch([key], () => { branch.enabled = controls.settings.get_boolean(key); });
}

function addSurface(page, controls, surface, title) {
  const group = controls.group(page, title);
  if (surface === 'top-bar') controls.choice(group, 'Style', TOP_BAR, 'The bar itself; menus have their own entries', false);
  if (surface === 'quick-settings') controls.choice(group, 'Apply glass to', QUICK_SETTINGS_GLASS, QUICK_SETTINGS_GLASS_HINT, false);

  // The clock's digits are glass of their own shape, without corners or an outline.
  const clock = surface === 'glass-clock';
  const appearance = addNumbers(group, controls, clock ? APPEARANCE.filter(([key]) => key !== 'corner-radius') : APPEARANCE,
    `${surface}-`);
  controls.color(group, 'Tint', [`${surface}-tint-color`]);
  if (!clock) addOutline(group, controls, surface);
  addLayout(group, controls, surface, appearance);
  if (['menu', 'panel-menu', 'quick-settings'].includes(surface)) addMotion(group, controls, surface);
  if (clock) addClockShape(group, controls);
  if (surface === 'launcher') addLauncherLayout(group, controls);
  if (surface === 'desktop-widget') {
    controls.choice(group, 'Menu animation', [
      { title: 'Morph', patch: { 'desktop-widget-menu-animation': 'morph' } },
      { title: 'Spring', patch: { 'desktop-widget-menu-animation': 'spring' } },
      { title: 'Off', patch: { 'desktop-widget-menu-animation': 'off' } },
    ], 'The right-click menu of the widgets and the clock. Its speed and springs are those of Other top bar menus', false);
  }
  if (ADAPTIVE_SURFACES.includes(surface)) addAdaptiveColor(group, controls, surface);
  return group;
}

function addRendering(page, controls) {
  const blur = controls.group(page, 'Blur');
  controls.choice(blur, 'Method', [
    { title: 'Gaussian', patch: { 'blur-method': 0 } },
    { title: 'Dual Kawase', patch: { 'blur-method': 1 } },
  ]);
  controls.choice(blur, 'Resolution', [
    { title: 'Half', patch: { 'glass-blur-downscale': 2 } },
    { title: 'Quarter', patch: { 'glass-blur-downscale': 4 } },
  ]);
  const groups = [blur];
  for (const [title, specs] of [['Optics', OPTICS], ['Lighting', LIGHTING], ['Shadows', SHADOWS]]) {
    const group = controls.group(page, title);
    addNumbers(group, controls, specs);
    if (specs === LIGHTING) {
      controls.toggle(group, 'Color from backdrop', 'glass-backdrop-highlights',
        'Light takes the color of what is behind the glass instead of white');
    }
    groups.push(group);
  }
  return groups;
}

// Builds the advanced view's groups, and returns the function that shows or hides them.
function buildAdvancedPreferences(pages, controls) {
  const selectorGroup = controls.group(pages.appearance, 'Individual effects');
  const selector = new Adw.ComboRow({
    title: 'Surface', selected: 0,
    model: Gtk.StringList.new(SURFACE_OPTIONS.map(([, title]) => title)),
  });
  selectorGroup.add(selector);
  const surfaces = new Map();
  const effects = controls.group(pages.effects, 'Individual effects');
  controls.choice(effects, 'Top bar', TOP_BAR, 'The bar itself; menus have their own entries', false);
  for (const [surface, title, key, hint] of SURFACE_OPTIONS)
    if (key && surface !== 'application') controls.toggle(effects, title, key, hint ?? '');
  const groups = [selectorGroup, effects, addPanelMenus(pages.effects, controls),
    ...addRendering(pages.rendering, controls)];
  let visible = false;
  // A surface's group is built the first time it is picked.
  const refresh = () => {
    const index = selector.selected;
    if (visible && !surfaces.has(index)) {
      const [surface, title] = SURFACE_OPTIONS[index];
      surfaces.set(index, addSurface(pages.appearance, controls, surface, title));
    }
    for (const [i, group] of surfaces) group.visible = visible && i === index;
  };
  selector.connect('notify::selected', refresh);
  return show => {
    visible = show;
    for (const group of groups) group.visible = show;
    refresh();
  };
}

function collectGroups(page, build) {
  const added = [];
  const add = page.add;
  page.add = group => { added.push(group); add.call(page, group); };
  try { build(); } finally { delete page.add; }
  return added;
}

function moveToEnd(page, groups) {
  for (const group of groups) {
    page.remove(group);
    page.add(group);
  }
}

// Function called by prefs.js, main builder of simple view
export function buildPreferences(window, settings) {
  window.set_default_size(720, 720);
  window.search_enabled = true;
  const controls = new PreferenceControls(settings, window);
  const page = (title, icon_name, name = '') => {
    const result = new Adw.PreferencesPage({ title, icon_name, name: name || null });
    window.add(result);
    return result;
  };

  const appearance = page('Appearance', 'preferences-desktop-appearance-symbolic');
  const effects = page('Effects', 'preferences-other-symbolic');
  const desktop = page('Desktop', 'user-desktop-symbolic');
  const advanced = page('Rendering', 'applications-engineering-symbolic', 'rendering');
  addBlurMyShellWarning(appearance, controls);
  const view = controls.group(appearance, 'Settings');
  controls.choice(view, 'Settings view', [
    { title: 'Simple', patch: { 'preferences-advanced': false } },
    { title: 'Advanced', patch: { 'preferences-advanced': true } },
  ], '', false);
  addBackup(appearance, controls, window);
  const glass = controls.group(appearance, 'Glass', 'One look for all effects. Existing differences stay until you change a control.');
  controls.number(glass, 'Blur', sharedKeys('blur-radius'), 0, 30, 1, '', { slider: true });
  controls.number(glass, 'Corners', [...sharedKeys('corner-radius'), 'quick-settings-toggle-corner-radius'], 0, 200, 1, '', { slider: true });
  controls.color(glass, 'Tint', sharedKeys('tint-color'));
  controls.number(glass, 'Tint strength', sharedKeys('tint-strength'), 0, 1, 0.05, '', { slider: true });
  const outlineKeys = sharedKeys('outline-enabled');
  controls.choice(glass, 'Outline', booleanChoices(outlineKeys), 'A line along the visible edge of the glass, for seeing it better');
  const outline = new Branch(null, { fold: false });
  outline.add(controls.number(glass, 'Outline width', sharedKeys('outline-width'), 0.5, 10, 0.5, '', { slider: true }));
  outline.add(controls.color(glass, 'Outline color', sharedKeys('outline-color')));
  controls.watch(outlineKeys, () => { outline.enabled = outlineKeys.some(key => settings.get_boolean(key)); });

  const behavior = controls.group(appearance, 'Behavior');
  controls.choice(behavior, 'Animations', MOTION);
  controls.choice(behavior, 'Menus grow from their button', booleanChoices(GROW_KEYS),
    'Calendar and other top bar menus, while animations are on');
  controls.choice(behavior, 'Adaptive color', booleanChoices(TEXT_KEYS),
    'Text and icons turn light or dark to stay readable on the glass');
  controls.choice(behavior, 'Match menu heights', booleanChoices([
    'menu-match-quick-settings-height', 'panel-menu-match-quick-settings-height',
  ]));

  const surfaces = controls.group(effects, 'Show glass on');
  controls.choice(surfaces, 'Top bar', TOP_BAR, 'The bar itself; menus are below', false);
  controls.toggle(surfaces, 'Dock', 'enable-dock-glass');
  controls.choice(surfaces, 'Menus', booleanChoices(MENU_KEYS), 'Calendar, quick settings, other top bar menus and desktop');
  controls.choice(surfaces, 'Apply quick settings glass to', QUICK_SETTINGS_GLASS, QUICK_SETTINGS_GLASS_HINT, false);
  controls.choice(surfaces, 'Popups', booleanChoices(POPUP_KEYS), 'Notifications and volume / brightness indicators');

  const rendering = controls.group(advanced, 'Rendering');
  controls.choice(rendering, 'Quality', QUALITY);
  controls.number(rendering, 'Refraction', ['glass-displacement-scale'], 0, 200, 1, '', { slider: true });
  controls.number(rendering, 'Edge light', ['glass-rim-intensity'], 0, 5, 0.1, '', { slider: true });
  controls.choice(rendering, 'Shadows', [
    { title: 'Off', patch: { 'shadow-intensity': 0 } },
    { title: 'Soft', patch: { 'shadow-radius': 50, 'shadow-intensity': 0.07 } },
    { title: 'Strong', patch: { 'shadow-radius': 50, 'shadow-intensity': 0.5 } },
  ]);
  controls.number(rendering, 'Edge shading', ['glass-ao-intensity'], 0, 1, 0.05, '', { slider: true });

  addClock(desktop, controls);
  addWidgets(desktop, controls);
  addLauncher(desktop, controls);

  const effectsTail = collectGroups(effects, () => {
    new IconStyleRules(settings, controls).add(effects);
    new WindowRules(settings, controls).add(effects);
  });

  const renderingTail = collectGroups(advanced, () => {
    addCompatibility(advanced, controls);
    const diagnostics = controls.group(advanced, 'Troubleshooting');
    controls.toggle(diagnostics, 'Logging', 'output-logs');
    controls.toggle(diagnostics, 'Render diagnostics', 'glass-debug-diagnostics', 'Adds rendering overhead; leave off for normal use.');
    const dump = controls.toggle(diagnostics, 'Dump shortcut', 'enable-dump-shortcut',
      'A global shortcut that records the glass state for bug reports');
    const dumpBranch = new Branch(dump, { fold: false });
    dumpBranch.add(controls.shortcut(diagnostics, 'Shortcut', 'dump-loop-keybinding'));
    controls.watch(['enable-dump-shortcut'], () => { dumpBranch.enabled = settings.get_boolean('enable-dump-shortcut'); });
  });
  let showAdvanced;
  controls.watch(['preferences-advanced'], () => {
    const enabled = settings.get_boolean('preferences-advanced');
    for (const group of [glass, behavior, surfaces, rendering]) group.visible = !enabled;
    if (enabled && !showAdvanced) {
      showAdvanced = buildAdvancedPreferences({ appearance, effects, rendering: advanced }, controls);
      moveToEnd(effects, effectsTail);
      moveToEnd(advanced, renderingTail);
    }
    showAdvanced?.(enabled);
  });
  return controls;
}
