import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import {commonValue, matches, uniformPatch} from './model.js';

export class PreferenceControls {
  constructor(settings, window) {
    this.settings = settings;
    this._ids = [];
    this._cleanups = [];
    window.connect('close-request', () => { this.dispose(); return false; });
  }

  onClose(callback) { this._cleanups.push(callback); }

  watch(keys, refresh) {
    for (const key of keys) this._ids.push(this.settings.connect(`changed::${key}`, refresh));
    refresh();
  }

  dispose() {
    for (const id of this._ids.splice(0)) this.settings.disconnect(id);
    for (const callback of this._cleanups.splice(0)) callback();
  }

  write(patch) {
    const transaction = new Gio.Settings({settings_schema: this.settings.settings_schema, path: this.settings.path});
    const changes = Object.entries(patch).map(([key, value]) => [key,
      new GLib.Variant(this.settings.get_value(key).get_type_string(), value)]);
    if (changes.some(([key, value]) => !transaction.is_writable(key) || !transaction.settings_schema.get_key(key).range_check(value)))
      throw new Error('These settings cannot be changed together');
    transaction.delay();
    for (const [key, value] of changes) transaction.set_value(key, value);
    transaction.apply();
  }

  group(page, title, description = '') {
    const group = new Adw.PreferencesGroup({title, description});
    page.add(group);
    return group;
  }

  toggle(group, title, key, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    group.add(row);
    this.settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  choice(group, title, choices, subtitle = '', custom = true) {
    const row = new Adw.ComboRow({title, subtitle,
      model: Gtk.StringList.new([...choices.map(choice => choice.title), ...(custom ? ['Custom'] : [])])});
    if (custom) row.list_factory = this.readoutListFactory(row, choices.length);
    group.add(row);
    let syncing = false;
    const refresh = () => {
      syncing = true;
      const index = choices.findIndex(choice => matches(this.settings, choice.patch));
      const fallback = custom ? choices.length : 0;
      row.selected = index < 0 ? fallback : index;
      syncing = false;
    };
    row.connect('notify::selected', () => {
      if (syncing) return;
      const choice = choices[row.selected];
      if (choice) this.write(choice.patch);
      refresh();
    });
    this.watch([...new Set(choices.flatMap(choice => Object.keys(choice.patch)))], refresh);
    return row;
  }

  // An entry such as "Custom" only reports how the values came to be; it
  // cannot be picked. Replaces the combo row's popup list so that entry is
  // greyed out and inert, keeping the checkmark the default list draws on the selection.
  readoutListFactory(row, readoutIndex) {
    const factory = new Gtk.SignalListItemFactory();
    // One handler on the row for every list item, rather than one per bound
    // item undone on unbind: unbind also runs while the window is collected,
    // when JS callbacks are blocked.
    const items = new Set();
    const syncCheck = item => { item._check.opacity = row.selected === item.position ? 1 : 0; };
    row.connect('notify::selected', () => items.forEach(syncCheck));
    factory.connect('setup', (_factory, item) => {
      const box = new Gtk.Box({spacing: 6});
      const label = new Gtk.Label({xalign: 0, hexpand: true});
      const check = new Gtk.Image({icon_name: 'object-select-symbolic'});
      box.append(label);
      box.append(check);
      item.child = box;
      item._label = label;
      item._check = check;
      items.add(item);
    });
    factory.connect('bind', (_factory, item) => {
      const isReadout = item.position === readoutIndex;
      item._label.label = item.item.string;
      item.child.sensitive = !isReadout;
      item.activatable = !isReadout;
      item.selectable = !isReadout;
      syncCheck(item);
    });
    return factory;
  }

  // `slider` adds a slider that shares the spin row's adjustment, for values
  // that are tuned by eye while watching the glass (blur, tint, refraction,
  // offsets, ...) rather than typed in as a number.
  number(group, title, keys, min, max, step, subtitle = '', {slider = false} = {}) {
    const digits = step < 1 ? 2 : 0;
    const row = new Adw.SpinRow({title, subtitle,
      adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
      digits});
    if (slider) this._addSlider(row, digits);
    group.add(row);
    let syncing = false;
    const refresh = () => {
      syncing = true;
      const current = commonValue(this.settings, keys);
      row.value = current.value;
      row.subtitle = current.mixed ? 'Custom · changing this applies everywhere' : subtitle;
      syncing = false;
    };
    row.connect('notify::value', () => {
      // A dragged slider lands between steps; store what the row displays.
      if (!syncing) this.write(uniformPatch(keys, Number(row.value.toFixed(digits))));
    });
    this.watch(keys, refresh);
    return row;
  }

  _addSlider(row, digits) {
    const scale = new Gtk.Scale({orientation: Gtk.Orientation.HORIZONTAL, adjustment: row.adjustment,
      draw_value: false, hexpand: true, valign: Gtk.Align.CENTER, width_request: 160, round_digits: digits});
    row.add_suffix(scale);
    // Adw.SpinRow packs its spin button into the suffix box first; move the
    // slider in front of it so the row reads title, slider, number.
    scale.get_parent().reorder_child_after(scale, null);
    row._slider = scale;
  }

  color(group, title, keys) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({valign: Gtk.Align.CENTER,
      dialog: new Gtk.ColorDialog({with_alpha: false})});
    row.add_suffix(button);
    row.activatable_widget = button;
    group.add(row);
    let syncing = false;
    this.watch(keys, () => {
      syncing = true;
      const current = commonValue(this.settings, keys);
      const rgba = new Gdk.RGBA();
      rgba.parse(current.value);
      button.rgba = rgba;
      row.subtitle = current.mixed ? 'Custom · changing this applies everywhere' : '';
      syncing = false;
    });
    button.connect('notify::rgba', () => {
      if (syncing) return;
      const color = button.rgba;
      const hex = '#' + [color.red, color.green, color.blue]
        .map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
      this.write(uniformPatch(keys, hex));
    });
  }
}
