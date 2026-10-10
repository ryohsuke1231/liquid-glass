import Adw from 'gi://Adw';
import {PreferenceControls} from './controls.js';
import {WindowRules} from './windows.js';
import {sharedKeys, TEXT_KEYS, MENU_KEYS, POPUP_KEYS, MOTION, GROW_KEYS, QUALITY, TOP_BAR, booleanChoices} from './model.js';
import {buildAdvancedPreferences} from './advanced.js';
import {addBlurMyShellWarning} from './blur-my-shell.js';
import {buildDesktopPage} from './desktop.js';

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

export function buildPreferences(window, settings) {
  window.set_default_size(720, 720);
  window.search_enabled = true;
  const controls = new PreferenceControls(settings, window);
  const page = (title, icon_name) => {
    const result = new Adw.PreferencesPage({title, icon_name});
    window.add(result);
    return result;
  };

  const appearance = page('Appearance', 'preferences-desktop-appearance-symbolic');
  const effects = page('Effects', 'preferences-other-symbolic');
  const desktop = page('Desktop', 'user-desktop-symbolic');
  const advanced = page('Rendering', 'applications-engineering-symbolic');
  addBlurMyShellWarning(appearance, controls);
  const view = controls.group(appearance, 'Settings');
  controls.choice(view, 'Settings view', [
    {title: 'Simple', patch: {'preferences-advanced': false}},
    {title: 'Advanced', patch: {'preferences-advanced': true}},
  ], '', false);
  const glass = controls.group(appearance, 'Glass', 'One look for all effects. Existing differences stay until you change a control.');
  controls.number(glass, 'Blur', sharedKeys('blur-radius'), 0, 30, 1, '', {slider: true});
  controls.number(glass, 'Corners', [...sharedKeys('corner-radius'), 'quick-settings-toggle-corner-radius'], 0, 200, 1, '', {slider: true});
  controls.color(glass, 'Tint', sharedKeys('tint-color'));
  controls.number(glass, 'Tint strength', sharedKeys('tint-strength'), 0, 1, 0.05, '', {slider: true});

  const behavior = controls.group(appearance, 'Behavior');
  controls.choice(behavior, 'Animations', MOTION);
  controls.choice(behavior, 'Menus grow from their button', booleanChoices(GROW_KEYS),
    'Calendar and other top bar menus, while animations are on');
  controls.choice(behavior, 'Automatic text contrast', booleanChoices(TEXT_KEYS));
  controls.choice(behavior, 'Match menu heights', booleanChoices([
    'menu-match-quick-settings-height', 'panel-menu-match-quick-settings-height',
  ]));

  const surfaces = controls.group(effects, 'Show glass on');
  controls.choice(surfaces, 'Top bar', TOP_BAR, 'The bar itself; menus are below', false);
  controls.toggle(surfaces, 'Dock', 'enable-dock-glass');
  controls.choice(surfaces, 'Menus', booleanChoices(MENU_KEYS), 'Calendar, quick settings, other top bar menus and desktop');
  controls.choice(surfaces, 'Popups', booleanChoices(POPUP_KEYS), 'Notifications and volume / brightness indicators');

  const rendering = controls.group(advanced, 'Rendering');
  controls.choice(rendering, 'Quality', QUALITY);
  controls.number(rendering, 'Refraction', ['glass-displacement-scale'], 0, 200, 1, '', {slider: true});
  controls.number(rendering, 'Edge light', ['glass-rim-intensity'], 0, 5, 0.1, '', {slider: true});
  controls.choice(rendering, 'Shadows', [
    {title: 'Off', patch: {'shadow-intensity': 0}},
    {title: 'Soft', patch: {'shadow-radius': 50, 'shadow-intensity': 0.07}},
    {title: 'Strong', patch: {'shadow-radius': 50, 'shadow-intensity': 0.5}},
  ]);
  controls.number(rendering, 'Edge shading', ['glass-ao-intensity'], 0, 1, 0.05, '', {slider: true});

  buildDesktopPage(desktop, controls);

  const effectsTail = collectGroups(effects, () => {
    new WindowRules(settings, controls).add(effects);
  });

  const renderingTail = collectGroups(advanced, () => {
    const compatibility = controls.group(advanced, 'Compatibility');
    controls.choice(compatibility, 'Quick settings glass', [
      {title: 'Whole menu', patch: {'quick-settings-apply-to': 0}},
      {title: 'Individual buttons', patch: {'quick-settings-apply-to': 1}},
    ]);
    const diagnostics = controls.group(advanced, 'Troubleshooting');
    controls.toggle(diagnostics, 'Logging', 'output-logs');
    controls.toggle(diagnostics, 'Render diagnostics', 'glass-debug-diagnostics', 'Adds rendering overhead; leave off for normal use.');
    controls.toggle(diagnostics, 'Dump shortcut', 'enable-dump-shortcut', 'A global shortcut that records the glass state for bug reports (Ctrl+Alt+L unless rebound).');
  });
  let showAdvanced;
  controls.watch(['preferences-advanced'], () => {
    const enabled = settings.get_boolean('preferences-advanced');
    for (const group of [glass, behavior, surfaces, rendering]) group.visible = !enabled;
    if (enabled && !showAdvanced) {
      showAdvanced = buildAdvancedPreferences({appearance, effects, rendering: advanced}, controls);
      moveToEnd(effects, effectsTail);
      moveToEnd(advanced, renderingTail);
    }
    showAdvanced?.(enabled);
  });
  return controls;
}
