import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';

import {BUNDLED_FAMILIES} from '../dist/desktop/bundledFonts.js';

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
  const row = new Adw.ComboRow({title,
    model: Gtk.StringList.new([...PLACES.map(([, name]) => name), id ? 'Where it was moved' : 'Where each was put'])});
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
    controls.write({[key]: PLACES[row.selected][0], 'desktop-item-positions': JSON.stringify(positions),
      ...id ? {} : {'desktop-widget-anchors': '{}'}});
  });
  controls.watch([key, 'desktop-item-positions', 'desktop-widget-anchors'], refresh);
  return row;
}

const WEIGHTS = ['Light', 'Regular', 'SemiBold', 'Bold'];

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
  const row = new Adw.ComboRow({title: 'Font',
    model: Gtk.StringList.new([...families, 'Interface font', 'Installed font'])});
  const button = new Gtk.FontDialogButton({valign: Gtk.Align.CENTER, level: Gtk.FontLevel.FACE,
    dialog: new Gtk.FontDialog({title: 'Clock Font'})});
  row.add_suffix(button);
  const weight = new Adw.ComboRow({title: 'Weight', model: Gtk.StringList.new(WEIGHTS)});
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
      controls.write({'glass-clock-font': ''});
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
    controls.write({'glass-clock-font': desc.to_string()});
  });
  return [row, weight];
}

function entryRow(group, controls, title, key, {read = v => v, write = v => v, valid = () => true} = {}) {
  const row = new Adw.EntryRow({title, show_apply_button: true});
  group.add(row);
  controls.watch([key], () => { row.text = read(controls.settings.get_value(key).deep_unpack()); });
  row.connect('apply', () => {
    const text = row.text.trim();
    if (!valid(text)) {
      row.add_css_class('error');
      return;
    }
    row.remove_css_class('error');
    controls.write({[key]: write(text)});
  });
  return row;
}

// The interface's language, as Open-Meteo takes it for place names.
function language() {
  const code = (GLib.get_language_names()[0] ?? 'en').split(/[_.@]/)[0];
  return code === 'C' || code === 'POSIX' ? 'en' : code;
}

// Open-Meteo matches names in the language it is asked for, so a name
// typed in another script is looked up again in the languages written in it.
const SCRIPTS = [[/[\u3040-\u30ff]/, ['ja']], [/[\u4e00-\u9fff]/, ['ja', 'zh']], [/[\uac00-\ud7af]/, ['ko']],
  [/[\u0400-\u04ff]/, ['ru', 'uk']]];

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
  const current = new Adw.ActionRow({title: 'Weather place'});
  const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
    tooltip_text: hasWeather ? 'Use the location set in GNOME Weather' : 'Forget the place'});
  current.add_suffix(reset);
  group.add(current);
  const search = new Adw.EntryRow({title: 'Search for a city or town', show_apply_button: true});
  group.add(search);

  controls.watch(['weather-place'], () => {
    const [name] = settings.get_value('weather-place').deep_unpack();
    current.subtitle = name || (hasWeather ? 'The location set in GNOME Weather' : 'None');
    reset.sensitive = name !== '';
  });
  reset.connect('clicked', () => controls.write({'weather-place': ['', 0, 0]}));

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
    session ??= new Soup.Session({user_agent: USER_AGENT, timeout: 20});
    let places;
    try {
      places = await searchPlaces(session, text, cancellable);
    } catch (error) {
      if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      showFound([new Adw.ActionRow({title: 'The search failed', subtitle: String(error.message ?? error)})]);
      return;
    }
    if (places.length === 0) {
      showFound([new Adw.ActionRow({title: `Nothing called “${text}” was found`})]);
      return;
    }
    showFound(places.map(place => {
      const row = new Adw.ActionRow({title: place.name, activatable: true,
        subtitle: [place.admin2 !== place.name ? place.admin2 : '', place.admin1, place.country].filter(Boolean).join(', ')});
      row.connect('activated', () => {
        controls.write({'weather-place': [place.name, place.latitude, place.longitude]});
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
    'A large clock whose digits are glass. Right-click it to move or resize it.');
  const show = controls.toggle(group, 'Show the clock', 'enable-glass-clock');
  const rows = [
    placeRow(group, controls, 'Place', 'glass-clock-position', 'clock'),
    controls.number(group, 'Size', ['glass-clock-size'], 48, 480, 1, '', {slider: true}),
    controls.number(group, 'Width', ['glass-clock-stretch'], 0.3, 4, 0.01, '', {slider: true}),
    controls.number(group, 'Height', ['glass-clock-height'], 1, 3, 0.01, '', {slider: true}),
    controls.choice(group, 'Taller digits', [
      {title: 'Evenly', patch: {'glass-clock-tall-style': 'even'}},
      {title: 'Along upright strokes', patch: {'glass-clock-tall-style': 'upright'}},
    ], 'How the digits grow when the height is above 1', false),
    controls.choice(group, 'Time format', [
      {title: 'As in Settings', patch: {'glass-clock-format': 'system'}},
      {title: '24-hour', patch: {'glass-clock-format': '24h'}},
      {title: '12-hour', patch: {'glass-clock-format': '12h'}},
    ], '', false),
    controls.toggle(group, 'Show the date', 'glass-clock-show-date'),
    controls.number(group, 'Blur', ['glass-clock-blur-radius'], 0, 30, 1, '', {slider: true}),
    controls.number(group, 'Tint strength', ['glass-clock-tint-strength'], 0, 1, 0.01, '', {slider: true}),
    ...fontRows(group, controls),
  ];
  controls.watch(['enable-glass-clock'], () => {
    for (const row of rows) row.sensitive = show.active;
  });
}

function addWidgets(page, controls) {
  const settings = controls.settings;
  const group = controls.group(page, 'Widgets',
    'Cards of glass on the desktop, below the windows. Right-click one to move it.');
  const show = controls.toggle(group, 'Show widgets', 'enable-desktop-widgets');
  const rows = [];
  for (const [id, title, subtitle] of WIDGETS) {
    const row = new Adw.SwitchRow({title, subtitle});
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
      controls.write({'desktop-widgets': WIDGETS.map(([w]) => w).filter(w => chosen.has(w))});
    });
    rows.push(row);
  }
  rows.push(controls.toggle(group, 'Sound bars', 'media-visualizer',
    'On Now playing. GNOME shows the microphone indicator while they listen'));
  rows.push(placeRow(group, controls, 'Place', 'desktop-widgets-position', null));
  rows.push(controls.choice(group, 'Temperature', [
    {title: 'Automatic', patch: {'weather-temperature-unit': 'auto'}},
    {title: 'Celsius', patch: {'weather-temperature-unit': 'celsius'}},
    {title: 'Fahrenheit', patch: {'weather-temperature-unit': 'fahrenheit'}},
  ], '', false));
  rows.push(...weatherPlaceRows(group, controls));
  controls.watch(['enable-desktop-widgets'], () => {
    for (const row of rows) row.sensitive = show.active;
  });
}

function addLauncher(page, controls) {
  const group = controls.group(page, 'Launcher',
    'A search field on glass, with the same results as the overview\'s search.');
  const show = controls.toggle(group, 'Search launcher', 'enable-launcher');
  const shortcut = entryRow(group, controls, 'Shortcut', 'launcher-shortcut', {
    read: value => value[0] ?? '',
    write: text => [text],
    valid: text => {
      const [ok, key] = Gtk.accelerator_parse(text);
      return ok && key !== 0;
    },
  });
  controls.watch(['enable-launcher'], () => { shortcut.sensitive = show.active; });
}

export function buildDesktopPage(page, controls) {
  addClock(page, controls);
  addWidgets(page, controls);
  addLauncher(page, controls);
}
