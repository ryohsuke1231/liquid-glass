import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {SURFACE_OPTIONS, APPEARANCE, LAYOUT, SPRING, OPTICS, LIGHTING, SHADOWS} from './advanced-model.js';
import {ADAPTIVE_SURFACES, TOP_BAR} from './model.js';
import {addPanelMenus} from './panel-menus.js';

function addNumbers(group, controls, specs, prefix = '', slider = true) {
  return new Map(specs.map(([key, title, min, max, step]) => [key,
    controls.number(group, title, [`${prefix}${key}`], min, max, step, '', {slider})]));
}

function addMotion(group, controls, surface) {
  const key = `enable-${surface}-animation`;
  const toggle = controls.toggle(group, 'Animations', key);
  const grow = surface === 'quick-settings' ? null
    : controls.toggle(group, 'Grow from the button', `${surface}-grow-from-button`,
      'The glass leaves the button as a drop and stretches into the menu');
  // Spring constants and intervals mean their number; no slider.
  const rows = addNumbers(group, controls, SPRING, `${surface}-`, false);
  const keys = surface === 'quick-settings' ? [key, 'quick-settings-apply-to'] : [key];
  controls.watch(keys, () => {
    const panel = surface !== 'quick-settings' || controls.settings.get_value('quick-settings-apply-to').deep_unpack() === 0;
    toggle.visible = panel;
    if (grow) grow.visible = controls.settings.get_boolean(key);
    for (const row of rows.values()) row.visible = panel && controls.settings.get_boolean(key);
  });
}

function addLayout(group, controls, surface, appearance) {
  const rows = addNumbers(group, controls, LAYOUT[surface], `${surface}-`);
  if (surface === 'menu' || surface === 'panel-menu') {
    const key = `${surface}-match-quick-settings-height`;
    controls.toggle(group, 'Match quick settings height', key);
    controls.watch([key], () => { rows.get('scale').sensitive = !controls.settings.get_boolean(key); });
  }
  if (surface === 'top-bar') {
    controls.watch(['top-bar-style'], () => {
      const shown = controls.settings.get_value('top-bar-style').deep_unpack() !== 'off';
      for (const row of rows.values()) row.visible = shown;
    });
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

function addSurface(page, controls, surface, title) {
  const group = controls.group(page, title);
  if (surface === 'top-bar') controls.choice(group, 'Style', TOP_BAR, 'The bar itself; menus have their own entries', false);
  const appearance = addNumbers(group, controls, APPEARANCE, `${surface}-`);
  controls.color(group, 'Tint', [`${surface}-tint-color`]);
  addLayout(group, controls, surface, appearance);
  if (['menu', 'panel-menu', 'quick-settings'].includes(surface)) addMotion(group, controls, surface);
  if (ADAPTIVE_SURFACES.includes(surface)) {
    const key = `${surface}-enable-adaptive-text-color`;
    controls.toggle(group, 'Automatic text contrast', key);
    const row = controls.number(group, 'Contrast interval (ms)', [`${surface}-sample-interval-ms`], 100, 2000, 50);
    const preferenceKey = `${surface}-adaptive-text-preference`;
    const preference = controls.choice(group, 'Preferred text color', [
      {title: 'Automatic', patch: {[preferenceKey]: 'auto'}},
      {title: 'Light', patch: {[preferenceKey]: 'light'}},
      {title: 'Dark', patch: {[preferenceKey]: 'dark'}},
    ], 'Decides only when both colors are equally readable', false);
    controls.watch([key], () => {
      row.visible = controls.settings.get_boolean(key);
      preference.visible = row.visible;
    });
  }
  return group;
}

function addRendering(page, controls) {
  const blur = controls.group(page, 'Blur');
  controls.choice(blur, 'Method', [
    {title: 'Gaussian', patch: {'blur-method': 0}},
    {title: 'Dual Kawase', patch: {'blur-method': 1}},
  ]);
  controls.choice(blur, 'Resolution', [
    {title: 'Half', patch: {'glass-blur-downscale': 2}},
    {title: 'Quarter', patch: {'glass-blur-downscale': 4}},
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

export function buildAdvancedPreferences(pages, controls) {
  const selectorGroup = controls.group(pages.appearance, 'Individual effects');
  const selector = new Adw.ComboRow({title: 'Surface', selected: 0,
    model: Gtk.StringList.new(SURFACE_OPTIONS.map(([, title]) => title))});
  selectorGroup.add(selector);
  const surfaces = new Map();
  const effects = controls.group(pages.effects, 'Individual effects');
  for (const [surface, title, key, hint] of SURFACE_OPTIONS)
    if (key && surface !== 'application') controls.toggle(effects, title, key, hint ?? '');
  const groups = [selectorGroup, effects, addPanelMenus(pages.effects, controls),
    ...addRendering(pages.rendering, controls)];
  let visible = false;
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
