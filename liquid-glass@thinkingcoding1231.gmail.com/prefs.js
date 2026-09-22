import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

// gnome-extensions-prefs runs in its own process and cannot touch Meta/Shell, so
// the list of open windows is fetched from the shell-side WindowListService over
// D-Bus (see src/windowListService.ts). The proxy is created lazily and shared by
// every picker in the window.
const WINDOW_LIST_BUS_NAME = 'org.gnome.Shell';
const WINDOW_LIST_OBJECT_PATH = '/org/gnome/Shell/Extensions/LiquidGlass';
const WINDOW_LIST_INTERFACE_NAME = 'org.gnome.Shell.Extensions.LiquidGlass';

class WindowListClient {
  constructor() {
    this._proxy = null;
    this._proxyError = null;
    this._watchers = new Set();
    this._signalId = 0;
  }

  _ensureProxy() {
    if (this._proxy || this._proxyError)
      return this._proxy;

    try {
      this._proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
        null,
        WINDOW_LIST_BUS_NAME,
        WINDOW_LIST_OBJECT_PATH,
        WINDOW_LIST_INTERFACE_NAME,
        null);

      this._signalId = this._proxy.connect('g-signal', (_proxy, _sender, signalName) => {
        if (signalName === 'WindowsChanged')
          this._notify();
      });
    } catch (e) {
      this._proxy = null;
      this._proxyError = e;
    }

    return this._proxy;
  }

  _notify() {
    for (const watcher of [...this._watchers])
      watcher();
  }

  // Registers a callback fired whenever the shell reports that the set of open
  // windows changed. Returns a function that unsubscribes it.
  addWatcher(callback) {
    this._ensureProxy();
    this._watchers.add(callback);
    return () => this._watchers.delete(callback);
  }

  // callback(windows, errorMessage): exactly one of the two is meaningful.
  listWindows(callback) {
    const proxy = this._ensureProxy();
    if (!proxy) {
      callback(null, 'Could not connect to GNOME Shell.');
      return;
    }

    proxy.call('ListWindows', null, Gio.DBusCallFlags.NONE, -1, null, (source, result) => {
      let windows = null;
      let error = null;
      try {
        const [json] = source.call_finish(result).deep_unpack();
        windows = JSON.parse(json);
      } catch (e) {
        // The usual cause is the extension being disabled: the object is only
        // exported while it is running, so the call fails with UnknownMethod.
        error = 'The window list is only available while the extension is enabled.';
      }
      callback(windows, error);
    });
  }
}

export default class LiquidGlassPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com");

    const blurRadiusRows = []; // blur-radius のテキストボックスの row を保持する

    // 拡張機能のディレクトリから resources.gresource の絶対パスを取得する
    const resourceFile = this.dir.get_child('resources.gresource');
    const resource = Gio.Resource.load(resourceFile.get_path());
    resource._register();
    const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    iconTheme.add_resource_path('/com/example/my-app/icons');

    // --- Dock タブ ---
    const dockPage = new Adw.PreferencesPage({
      title: 'Dock',
      icon_name: 'dock-bottom-symbolic',
    });
    window.add(dockPage);

    const dockGroup = new Adw.PreferencesGroup({
      title: 'Dock Settings',
      description: 'Configure the liquid glass effect for the Dash to Dock',
    });
    dockPage.add(dockGroup);

    // 有効化スイッチ
    this._addSwitchRow(dockGroup, settings, 'enable-dock-glass', 'Enable Glass Effect', 'Apply the effect to the dock');
    // 各種パラメータ
    this._addSliderRow(dockGroup, settings, 'dock-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(dockGroup, settings, 'dock-margin-bottom', 'Margin Bottom', 'Bottom spacing', -5, 30, 1);
    this._addColorRow(dockGroup, settings, 'dock-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(dockGroup, settings, 'dock-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const dockBlurRow = this._addSliderRow(dockGroup, settings, 'dock-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(dockBlurRow);
    this._addSliderRow(dockGroup, settings, 'dock-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // Advancedグループ (開閉可能)
    const dockAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    dockGroup.add(dockAdvanced);

    this._addSliderRow(dockAdvanced, settings, 'dock-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(dockAdvanced, settings, 'dock-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(dockAdvanced, settings, 'dock-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);


    // --- Menu タブ ---
    const menuPage = new Adw.PreferencesPage({
      title: 'Menu',
      icon_name: 'view-list-symbolic',
    });
    window.add(menuPage);

    const menuGroup = new Adw.PreferencesGroup({ title: 'Menu Settings' });
    menuPage.add(menuGroup);

    this._addSwitchRow(menuGroup, settings, 'enable-menu-glass', 'Enable Glass Effect', 'Apply to menus and popups');
    this._addSwitchRow(menuGroup, settings, "enable-menu-animation", "Enable Menu Animation", "Animate menu transitions using spring physics");

    this._addSliderRow(menuGroup, settings, 'menu-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(menuGroup, settings, 'menu-x-offset', 'X Offset', 'Horizontal offset adjustment', -200, 200, 1);
    this._addSliderRow(menuGroup, settings, 'menu-y-offset', 'Y Offset', 'Vertical offset adjustment', -50, 100, 1);

    this._addSwitchRow(menuGroup, settings, 'menu-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const menuSampleIntervalRow = this._addSliderRow(menuGroup, settings, 'menu-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('menu-enable-adaptive-text-color', menuSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);
    const menuTextPrefRow = this._addChoiceRow(menuGroup, settings, 'menu-adaptive-text-preference',
      'Preferred Text Color',
      'Which color to settle on when the background favours neither. Also stops the text flickering between the two.',
      [{ label: 'Automatic', value: 'auto' }, { label: 'Prefer Light Text', value: 'light' }, { label: 'Prefer Dark Text', value: 'dark' }]);
    settings.bind('menu-enable-adaptive-text-color', menuTextPrefRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addColorRow(menuGroup, settings, 'menu-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(menuGroup, settings, 'menu-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const menuBlurRow = this._addSliderRow(menuGroup, settings, 'menu-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(menuBlurRow);
    this._addSliderRow(menuGroup, settings, 'menu-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);
    this._addSwitchRow(menuGroup, settings, 'menu-match-quick-settings-height', 'Match Quick Settings Height', 'Scale the menu so both panel dropdowns open to the same height');

    const menuScaleRow = this._addSliderRow(menuGroup, settings, 'menu-scale', 'Menu Scale', 'Shrink or grow the whole menu, glass included', 0.5, 1.0, 0.01);
    settings.bind('menu-match-quick-settings-height', menuScaleRow, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);

    // Advancedグループ (開閉可能) - Spring関連とカラー調整をここに集約
    const menuAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Spring physics, color adjustments (Brightness, Contrast, Saturation)'
    });
    menuGroup.add(menuAdvanced);

    // 【修正】Spring物理挙動パラメータをAdvanced内へ移動
    const menuStiffnessRow = this._addSliderRow(menuAdvanced, settings, 'menu-spring-stiffness', 'Spring Stiffness', 'Spring stiffness', 0.0, 1000.0, 0.1);
    const menuDampingRow = this._addSliderRow(menuAdvanced, settings, 'menu-spring-damping', 'Spring Damping', 'Spring damping', 0.0, 1000.0, 0.1);
    const menuMassRow = this._addSliderRow(menuAdvanced, settings, 'menu-spring-mass', 'Spring Mass', 'Spring mass', 0.0, 1.0, 0.1);
    const menuIntervalRow = this._addSliderRow(menuAdvanced, settings, 'menu-animation-interval-ms', 'Animation Interval (ms)', 'Animation interval', 0, 1000, 1);

    // アニメーションOFF時に項目を非表示にするバインド（Advanced内にあっても正常に動作します）
    settings.bind('enable-menu-animation', menuStiffnessRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-menu-animation', menuDampingRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-menu-animation', menuMassRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-menu-animation', menuIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

    // カラー調整（Advanced内）
    this._addSliderRow(menuAdvanced, settings, 'menu-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(menuAdvanced, settings, 'menu-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(menuAdvanced, settings, 'menu-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);


    // --- Additional top panel menus ---
    const panelPage = new Adw.PreferencesPage({
      title: 'Panel Extensions',
      icon_name: 'application-x-addon-symbolic',
    });
    window.add(panelPage);
    const panelGroup = new Adw.PreferencesGroup({
      title: 'Top Bar Dropdowns',
      description: 'Automatically detect menus added to the top bar. These menus have their own appearance settings below; Calendar and Quick Settings keep theirs.',
    });
    panelPage.add(panelGroup);
    this._addSwitchRow(panelGroup, settings, 'enable-extra-menu-glass', 'Enable Glass for Panel Menus', 'Include newly detected menus automatically');
    const detectedGroup = new Adw.PreferencesGroup({ title: 'Detected Menus' });
    panelPage.add(detectedGroup);
    settings.bind('enable-extra-menu-glass', detectedGroup, 'sensitive', Gio.SettingsBindFlags.GET);
    const emptyRow = new Adw.ActionRow({
      title: 'No additional menus detected',
      subtitle: 'Enable a top bar extension to show its menu here.',
    });
    detectedGroup.add(emptyRow);
    const menuRows = new Map();
    const legacyMenus = {
      keyboard: { key: 'enable-keyboard-menu-glass', title: 'Keyboard Layout' },
      vitalsMenu: { key: 'enable-vitals-menu-glass', title: 'Vitals' },
    };
    let syncingMenus = false;
    const refreshMenus = () => {
      syncingMenus = true;
      try {
        const names = settings.get_strv('detected-extra-menus');
        const disabled = new Set(settings.get_strv('disabled-extra-menus'));
        for (const [name, row] of menuRows) {
          if (names.includes(name)) continue;
          detectedGroup.remove(row);
          menuRows.delete(name);
        }
        for (const name of names) {
          let row = menuRows.get(name);
          if (!row) {
            const legacy = legacyMenus[name];
            const title = legacy?.title ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
            row = new Adw.SwitchRow({ title, use_markup: false });
            detectedGroup.add(row);
            menuRows.set(name, row);
            if (legacy) {
              settings.bind(legacy.key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            } else {
              row.connect('notify::active', () => {
                if (syncingMenus) return;
                const excluded = new Set(settings.get_strv('disabled-extra-menus'));
                if (row.active) excluded.delete(name);
                else excluded.add(name);
                settings.set_strv('disabled-extra-menus', [...excluded].sort());
              });
            }
          }
          if (!legacyMenus[name]) row.active = !disabled.has(name);
        }
        emptyRow.visible = names.length === 0;
      } finally {
        syncingMenus = false;
      }
    };
    // Appearance for the detected dropdowns. Own keys, not the Menu tab's —
    // see the panel-menu-* block in the schema.
    const panelAppearance = new Adw.PreferencesGroup({
      title: 'Appearance',
      description: 'Applies to every detected panel menu. Independent of the Calendar menu.',
    });
    panelPage.add(panelAppearance);
    settings.bind('enable-extra-menu-glass', panelAppearance, 'sensitive', Gio.SettingsBindFlags.GET);

    this._addSwitchRow(panelAppearance, settings, 'enable-panel-menu-animation', 'Enable Menu Animation', 'Animate menu transitions using spring physics');

    this._addSliderRow(panelAppearance, settings, 'panel-menu-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(panelAppearance, settings, 'panel-menu-x-offset', 'X Offset', 'Horizontal offset adjustment', -200, 200, 1);
    this._addSliderRow(panelAppearance, settings, 'panel-menu-y-offset', 'Y Offset', 'Vertical offset adjustment', -50, 100, 1);

    this._addSwitchRow(panelAppearance, settings, 'panel-menu-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const panelSampleIntervalRow = this._addSliderRow(panelAppearance, settings, 'panel-menu-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    settings.bind('panel-menu-enable-adaptive-text-color', panelSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);
    const panelTextPrefRow = this._addChoiceRow(panelAppearance, settings, 'panel-menu-adaptive-text-preference',
      'Preferred Text Color',
      'Which color to settle on when the background favours neither. Also stops the text flickering between the two.',
      [{ label: 'Automatic', value: 'auto' }, { label: 'Prefer Light Text', value: 'light' }, { label: 'Prefer Dark Text', value: 'dark' }]);
    settings.bind('panel-menu-enable-adaptive-text-color', panelTextPrefRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addColorRow(panelAppearance, settings, 'panel-menu-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(panelAppearance, settings, 'panel-menu-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const panelBlurRow = this._addSliderRow(panelAppearance, settings, 'panel-menu-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(panelBlurRow);
    this._addSliderRow(panelAppearance, settings, 'panel-menu-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);
    this._addSwitchRow(panelAppearance, settings, 'panel-menu-match-quick-settings-height', 'Match Quick Settings Height', 'Scale the menu so both panel dropdowns open to the same height');

    const panelScaleRow = this._addSliderRow(panelAppearance, settings, 'panel-menu-scale', 'Menu Scale', 'Shrink or grow the whole menu, glass included', 0.5, 1.0, 0.01);
    settings.bind('panel-menu-match-quick-settings-height', panelScaleRow, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);

    const panelAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Spring physics, color adjustments (Brightness, Contrast, Saturation)'
    });
    panelAppearance.add(panelAdvanced);

    const panelStiffnessRow = this._addSliderRow(panelAdvanced, settings, 'panel-menu-spring-stiffness', 'Spring Stiffness', 'Spring stiffness', 0.0, 1000.0, 0.1);
    const panelDampingRow = this._addSliderRow(panelAdvanced, settings, 'panel-menu-spring-damping', 'Spring Damping', 'Spring damping', 0.0, 1000.0, 0.1);
    const panelMassRow = this._addSliderRow(panelAdvanced, settings, 'panel-menu-spring-mass', 'Spring Mass', 'Spring mass', 0.0, 1.0, 0.1);
    const panelIntervalRow = this._addSliderRow(panelAdvanced, settings, 'panel-menu-animation-interval-ms', 'Animation Interval (ms)', 'Animation interval', 0, 1000, 1);

    settings.bind('enable-panel-menu-animation', panelStiffnessRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-panel-menu-animation', panelDampingRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-panel-menu-animation', panelMassRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-panel-menu-animation', panelIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addSliderRow(panelAdvanced, settings, 'panel-menu-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(panelAdvanced, settings, 'panel-menu-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(panelAdvanced, settings, 'panel-menu-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);

    const menuWatchIds = ['detected-extra-menus', 'disabled-extra-menus'].map(key =>
      settings.connect(`changed::${key}`, refreshMenus));
    window.connect('close-request', () => {
      for (const id of menuWatchIds) settings.disconnect(id);
      return false;
    });
    refreshMenus();

    const notifPage = new Adw.PreferencesPage({
      title: 'Notifications',
      icon_name: 'preferences-system-notifications-symbolic',
    });
    window.add(notifPage);

    const notifGroup = new Adw.PreferencesGroup({ title: 'Notification Settings' });
    notifPage.add(notifGroup);

    this._addSwitchRow(notifGroup, settings, 'enable-notification-glass', 'Enable Glass Effect', 'Apply to notification banners');

    this._addSwitchRow(notifGroup, settings, 'notification-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const notifSampleIntervalRow = this._addSliderRow(notifGroup, settings, 'notification-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('notification-enable-adaptive-text-color', notifSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);
    const notifTextPrefRow = this._addChoiceRow(notifGroup, settings, 'notification-adaptive-text-preference',
      'Preferred Text Color',
      'Which color to settle on when the background favours neither. Also stops the text flickering between the two.',
      [{ label: 'Automatic', value: 'auto' }, { label: 'Prefer Light Text', value: 'light' }, { label: 'Prefer Dark Text', value: 'dark' }]);
    settings.bind('notification-enable-adaptive-text-color', notifTextPrefRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addSliderRow(notifGroup, settings, 'notification-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(notifGroup, settings, 'notification-y-offset', 'Y Offset', 'Vertical offset adjustment', 0, 100, 1);
    this._addColorRow(notifGroup, settings, 'notification-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(notifGroup, settings, 'notification-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const notifBlurRow = this._addSliderRow(notifGroup, settings, 'notification-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(notifBlurRow);
    this._addSliderRow(notifGroup, settings, 'notification-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // Advancedグループ (開閉可能)
    const notifAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    notifGroup.add(notifAdvanced);

    this._addSliderRow(notifAdvanced, settings, 'notification-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(notifAdvanced, settings, 'notification-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(notifAdvanced, settings, 'notification-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);


    // --- Quick Settings タブ ---
    const qsPage = new Adw.PreferencesPage({
      title: 'Quick Settings',
      icon_name: 'shapes-large-symbolic',
    });
    window.add(qsPage);

    const qsGroup = new Adw.PreferencesGroup({ title: 'Quick Settings Settings (Experimental)' });
    qsPage.add(qsGroup);

    this._addSwitchRow(qsGroup, settings, 'enable-quick-settings-glass', 'Enable Glass Effect', 'Apply to quick settings panel');
    // Apply to (Background / Toggles) を選択する ComboRow を追加し、GSettingsにバインド
    const qsApplyToRow = new Adw.ComboRow({
      title: 'Apply to',
      subtitle: 'Whether the glass effect covers the whole panel or only individual toggles',
      model: Gtk.StringList.new([
        'Background',
        'Toggles'
      ])
    });
    this._addRowToContainer(qsGroup, qsApplyToRow);
    settings.bind('quick-settings-apply-to', qsApplyToRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
    const qsEnableAnimRow = this._addSwitchRow(qsGroup, settings, "enable-quick-settings-animation", "Enable Quick Settings Animation", "Apply to quick settings panel");

    this._addSwitchRow(qsGroup, settings, 'quick-settings-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const qsSampleIntervalRow = this._addSliderRow(qsGroup, settings, 'quick-settings-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('quick-settings-enable-adaptive-text-color', qsSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);
    const qsTextPrefRow = this._addChoiceRow(qsGroup, settings, 'quick-settings-adaptive-text-preference',
      'Preferred Text Color',
      'Which color to settle on when the background favours neither. Also stops the text flickering between the two.',
      [{ label: 'Automatic', value: 'auto' }, { label: 'Prefer Light Text', value: 'light' }, { label: 'Prefer Dark Text', value: 'dark' }]);
    settings.bind('quick-settings-enable-adaptive-text-color', qsTextPrefRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addSliderRow(qsGroup, settings, 'quick-settings-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    const qsXOffsetRow = this._addSliderRow(qsGroup, settings, 'quick-settings-x-offset', 'X Offset', 'Horizontal offset adjustment', -100, 100, 1);
    const qsYOffsetRow = this._addSliderRow(qsGroup, settings, 'quick-settings-y-offset', 'Y Offset', 'Vertical offset adjustment', -100, 100, 1);

    this._addColorRow(qsGroup, settings, 'quick-settings-tint-color', 'Tint Color', 'Color of the glass tint');
    // "Custom Color Strength" / "Base Color Strength": the two tint layers are
    // independent (see glass.frag's mix() chain), so they are named for what
    // each one actually applies rather than for how they used to be blended
    // together. Setting KEYS are unchanged.
    this._addSliderRow(qsGroup, settings, 'quick-settings-tint-strength', 'Custom Color Strength', 'How strongly the Tint Color above is applied', 0.0, 1.0, 0.01);
    const qsBlurRow = this._addSliderRow(qsGroup, settings, 'quick-settings-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(qsBlurRow);
    const qsCornerRadiusRow = this._addSliderRow(qsGroup, settings, 'quick-settings-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // Toggles モード専用の設定（quick-settings-apply-to が Toggles の時だけ表示）
    const qsToggleTintStrengthRow = this._addSliderRow(qsGroup, settings, 'quick-settings-toggle-tint-strength', 'Base Color Strength', "How strongly each toggle's own original color is applied, independently of Custom Color Strength", 0.0, 1.0, 0.01);
    const qsToggleCornerRadiusRow = this._addSliderRow(qsGroup, settings, 'quick-settings-toggle-corner-radius', 'Toggle Corner Radius', 'Roundness of each individual toggle glass shape', 0, 60, 1);

    // Toggles モードは各トグルの矩形を毎フレーム個別に追跡するだけで、パネル全体を
    // 1枚板として動かしたり曲げたりはしない。そのため Corner Radius / X・Y Offset、
    // および Advanced 内の Spring・Animation 関連は Background モード専用の設定
    // として扱い、Toggles モードのときは非表示にする。
    const updateQsApplyToVisibility = () => {
      const isToggles = settings.get_int('quick-settings-apply-to') === 1;
      qsToggleTintStrengthRow.visible = isToggles;
      qsToggleCornerRadiusRow.visible = isToggles;

      qsCornerRadiusRow.visible = !isToggles;
      qsXOffsetRow.visible = !isToggles;
      qsYOffsetRow.visible = !isToggles;

      // Spring/Animationはパネル全体を動かす演出なので、Togglesモードでは
      // スイッチ自体を隠す。Advanced内の各行は「スイッチ ON かつ Backgroundモード」の
      // 場合だけ表示する（updateQsAnimationSubRowsVisibilityと合わせて判定）。
      qsEnableAnimRow.visible = !isToggles;
      updateQsAnimationSubRowsVisibility();
    };
    settings.connect('changed::quick-settings-apply-to', updateQsApplyToVisibility);

    // Advancedグループ (開閉可能) - Spring関連とカラー調整をここに集約
    const qsAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Spring physics, color adjustments (Brightness, Contrast, Saturation)'
    });
    qsGroup.add(qsAdvanced);

    const quickSettingsStiffnessRow = this._addSliderRow(qsAdvanced, settings, 'quick-settings-spring-stiffness', 'Spring Stiffness', 'Spring stiffness', 0.0, 1000.0, 0.1);
    const quickSettingsDampingRow = this._addSliderRow(qsAdvanced, settings, 'quick-settings-spring-damping', 'Spring Damping', 'Spring damping', 0.0, 1000.0, 0.1);
    const quickSettingsMassRow = this._addSliderRow(qsAdvanced, settings, 'quick-settings-spring-mass', 'Spring Mass', 'Spring mass', 0.0, 1.0, 0.1);
    const quickSettingsIntervalRow = this._addSliderRow(qsAdvanced, settings, 'quick-settings-animation-interval-ms', 'Animation Interval (ms)', 'Animation interval', 0, 1000, 1);

    // アニメーションOFF、またはTogglesモードのときは非表示にする
    // (単純な settings.bind だと片方の条件しか見られないため関数化して両方の
    // 変化を監視する。updateQsApplyToVisibility からも呼ばれる)
    const updateQsAnimationSubRowsVisibility = () => {
      const animOn = settings.get_boolean('enable-quick-settings-animation');
      const isToggles = settings.get_int('quick-settings-apply-to') === 1;
      const visible = animOn && !isToggles;
      quickSettingsStiffnessRow.visible = visible;
      quickSettingsDampingRow.visible = visible;
      quickSettingsMassRow.visible = visible;
      quickSettingsIntervalRow.visible = visible;
    };
    settings.connect('changed::enable-quick-settings-animation', updateQsAnimationSubRowsVisibility);

    // 両方の関数定義が揃ってから初期状態を反映する
    updateQsApplyToVisibility();
    updateQsAnimationSubRowsVisibility();

    // カラー調整（Advanced内）
    this._addSliderRow(qsAdvanced, settings, 'quick-settings-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(qsAdvanced, settings, 'quick-settings-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(qsAdvanced, settings, 'quick-settings-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);


    // --- OSD タブ ---
    const osdPage = new Adw.PreferencesPage({
      title: 'OSD',
      icon_name: 'audio-volume-medium-symbolic',
    });
    window.add(osdPage);

    const osdGroup = new Adw.PreferencesGroup({ title: 'OSD Settings (Experimental)' });
    osdPage.add(osdGroup);

    this._addSwitchRow(osdGroup, settings, 'enable-osd-glass', 'Enable Glass Effect', 'Apply to on-screen displays (like volume changes)');

    this._addSwitchRow(osdGroup, settings, 'osd-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const osdSampleIntervalRow = this._addSliderRow(osdGroup, settings, 'osd-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('osd-enable-adaptive-text-color', osdSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);
    const osdTextPrefRow = this._addChoiceRow(osdGroup, settings, 'osd-adaptive-text-preference',
      'Preferred Text Color',
      'Which color to settle on when the background favours neither. Also stops the text flickering between the two.',
      [{ label: 'Automatic', value: 'auto' }, { label: 'Prefer Light Text', value: 'light' }, { label: 'Prefer Dark Text', value: 'dark' }]);
    settings.bind('osd-enable-adaptive-text-color', osdTextPrefRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addSliderRow(osdGroup, settings, 'osd-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(osdGroup, settings, 'osd-y-offset', 'Y Offset', 'Vertical offset adjustment', -100, 100, 1);
    this._addColorRow(osdGroup, settings, 'osd-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(osdGroup, settings, 'osd-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const osdBlurRow = this._addSliderRow(osdGroup, settings, 'osd-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(osdBlurRow);
    this._addSliderRow(osdGroup, settings, 'osd-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // Advancedグループ (開閉可能)
    const osdAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    osdGroup.add(osdAdvanced);

    this._addSliderRow(osdAdvanced, settings, 'osd-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(osdAdvanced, settings, 'osd-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(osdAdvanced, settings, 'osd-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);


    // --- Applications タブ ---
    const appPage = new Adw.PreferencesPage({
      title: 'Applications',
      icon_name: 'applications-system-symbolic',
    });
    window.add(appPage);

    const appGroup = new Adw.PreferencesGroup({
      title: 'Application Window Settings',
      description: 'Apply the liquid glass effect to application windows',
    });
    appPage.add(appGroup);

    this._addSwitchRow(appGroup, settings, 'enable-application-glass', 'Enable Glass Effect', 'Apply to application windows');
    // Switch to apply to all windows: the whitelist is bypassed and the blacklist
    // below takes over as the way to exclude individual applications.
    this._addSwitchRow(appGroup, settings, 'application-glass-all-windows', 'Apply to All Windows', 'Apply to all application windows, using the blacklist below instead of the whitelist');
    this._addColorRow(appGroup, settings, 'application-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(appGroup, settings, 'application-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const appBlurRow = this._addSliderRow(appGroup, settings, 'application-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(appBlurRow);
    this._addSliderRow(appGroup, settings, 'application-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);
    this._addSliderRow(appGroup, settings, 'application-content-opacity', 'Window Content Opacity', 'Opacity of the window content layer, so the glass shows through it', 0.0, 1.0, 0.01);

    // Advancedグループ (開閉可能)
    const appAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    appGroup.add(appAdvanced);

    this._addSliderRow(appAdvanced, settings, 'application-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(appAdvanced, settings, 'application-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(appAdvanced, settings, 'application-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);

    // Whitelist (used when "Apply to All Windows" is off) and blacklist (used
    // when it is on). Both are edited through the same live picker of open
    // windows, so the user never has to look a WM_CLASS up by hand.
    const windowListClient = new WindowListClient();

    this._addWindowClassEditor(appPage, settings, windowListClient, {
      key: 'application-window-whitelist',
      title: 'Whitelist',
      description: 'Only these applications get the glass effect. Used while "Apply to All Windows" is off.',
      emptyTitle: 'No applications whitelisted',
      emptySubtitle: 'Add one below to enable the effect on it',
      pickerTitle: 'Add to Whitelist',
      activeKey: 'application-glass-all-windows',
      activeWhen: false,
    });

    this._addWindowClassEditor(appPage, settings, windowListClient, {
      key: 'application-window-blacklist',
      title: 'Blacklist',
      description: 'These applications never get the glass effect. Used while "Apply to All Windows" is on.',
      emptyTitle: 'No applications blacklisted',
      emptySubtitle: 'Add one below to exclude it from the effect',
      pickerTitle: 'Add to Blacklist',
      activeKey: 'application-glass-all-windows',
      activeWhen: true,
    });

    // The desktop's own right-click menu. Handled by the same manager as
    // application windows — on Wayland it is a real toplevel, not a shell
    // widget — but it is not an application, so it gets its own switch and
    // its own appearance keys rather than inheriting the window look.
    const desktopMenuGroup = new Adw.PreferencesGroup({
      title: 'Desktop Menu',
      description: 'The menu that opens when you right-click the desktop. Separate from the application window settings above; in-app popups are not affected.',
    });
    appPage.add(desktopMenuGroup);

    this._addSwitchRow(desktopMenuGroup, settings, 'enable-desktop-menu-glass', 'Enable Glass Effect', 'Apply to the desktop right-click menu');
    this._addColorRow(desktopMenuGroup, settings, 'desktop-menu-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(desktopMenuGroup, settings, 'desktop-menu-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const desktopMenuBlurRow = this._addSliderRow(desktopMenuGroup, settings, 'desktop-menu-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(desktopMenuBlurRow);
    this._addSliderRow(desktopMenuGroup, settings, 'desktop-menu-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);
    this._addSliderRow(desktopMenuGroup, settings, 'desktop-menu-content-opacity', 'Menu Content Opacity', 'Opacity of the menu content layer, so the glass shows through it', 0.0, 1.0, 0.01);

    const desktopMenuAdvanced = new Adw.ExpanderRow({
      title: 'Advanced',
      subtitle: 'Color adjustments (Brightness, Contrast, Saturation)'
    });
    desktopMenuGroup.add(desktopMenuAdvanced);

    this._addSliderRow(desktopMenuAdvanced, settings, 'desktop-menu-brightness', 'Brightness', 'Adjusts brightness', 0.5, 1.5, 0.01);
    this._addSliderRow(desktopMenuAdvanced, settings, 'desktop-menu-contrast', 'Contrast', 'Adjusts contrast', 0.5, 1.5, 0.01);
    this._addSliderRow(desktopMenuAdvanced, settings, 'desktop-menu-saturation', 'Saturation', 'Adjusts saturation', 0.0, 2.0, 0.01);


    // --- Glass Properties タブ ---
    const shaderPage = new Adw.PreferencesPage({
      title: 'Glass',
      icon_name: 'image-adjust-shadows-symbolic',
    });
    window.add(shaderPage);

    const physGroup = new Adw.PreferencesGroup({ title: 'Physical &amp; Optical Properties' });
    shaderPage.add(physGroup);

    // Blur Method を選択する ComboRow を追加し、GSettingsにバインド
    const blurMethodRow = new Adw.ComboRow({
      title: 'Blur Method',
      model: Gtk.StringList.new([
        'Gaussian Blur (Recommended)',
        'Dual Kawase (Performance)'
      ])
    });
    this._addRowToContainer(physGroup, blurMethodRow);
    settings.bind('blur-method', blurMethodRow, 'selected', Gio.SettingsBindFlags.DEFAULT);

    // Blur Resolution。値が 2 / 4 なので selected を直接バインドできず、
    // インデックス <-> 値 を手動で対応させている。
    const BLUR_DOWNSCALE_VALUES = [2, 4];
    const blurDownscaleRow = new Adw.ComboRow({
      title: 'Blur Resolution',
      subtitle: 'Quarter resolution makes every blur pass a quarter as expensive, but the blur gets visibly coarser and fine detail behind the glass is lost.',
      model: Gtk.StringList.new([
        'Half (Recommended)',
        'Quarter (Performance)'
      ])
    });
    this._addRowToContainer(physGroup, blurDownscaleRow);
    const syncBlurDownscaleRow = () => {
      const idx = BLUR_DOWNSCALE_VALUES.indexOf(settings.get_int('glass-blur-downscale'));
      blurDownscaleRow.selected = idx < 0 ? 0 : idx;
    };
    syncBlurDownscaleRow();
    settings.connect('changed::glass-blur-downscale', syncBlurDownscaleRow);
    blurDownscaleRow.connect('notify::selected', () => {
      const value = BLUR_DOWNSCALE_VALUES[blurDownscaleRow.selected] ?? 2;
      if (settings.get_int('glass-blur-downscale') !== value)
        settings.set_int('glass-blur-downscale', value);
    });

    this._addSliderRow(physGroup, settings, 'glass-max-z', 'Maximum Z Depth', 'Physical thickness of the glass', 0.0, 100.0, 1.0);
    this._addSliderRow(physGroup, settings, 'glass-displacement-scale', 'Displacement Scale', 'Strength of light refraction', 0.0, 200.0, 1.0);
    this._addSliderRow(physGroup, settings, 'glass-edge-smoothing', 'Edge Smoothing', 'Anti-aliasing feathering width', 0.0, 10.0, 0.1);
    this._addSliderRow(physGroup, settings, 'glass-profile-shape-n', 'Profile Shape N', 'Curvature shape of the surface', 1.0, 20.0, 0.1);
    this._addSliderRow(physGroup, settings, 'glass-ior', 'Index of Refraction', 'Optical density (1.5 - 2.4)', 1.0, 4.0, 0.01);
    this._addSliderRow(physGroup, settings, 'glass-chroma-strength', 'Chroma Strength', 'RGB color separation at the refracted edge, in pixels', 0.0, 5.0, 0.1);

    const lightGroup = new Adw.PreferencesGroup({ title: 'Lighting &amp; Reflections' });
    shaderPage.add(lightGroup);

    this._addSliderRow(lightGroup, settings, 'glass-specular-intensity', 'Specular Intensity', 'Brightness of highlights', 0.0, 5.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-shininess', 'Shininess', 'Sharpness of reflections', 1.0, 200.0, 1.0);
    this._addSliderRow(lightGroup, settings, 'glass-rim-width', 'Rim Width', 'Width of the edge lighting', 0.0, 20.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-intensity', 'Rim Intensity', 'Brightness of rim light', 0.0, 5.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-directional-power', 'Rim Directional Power', 'Light direction effect on rim', 0.0, 10.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-power', 'Rim Fresnel Power', 'Fresnel falloff for rim light', 0.0, 20.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-rim-light-color-intensity', 'Rim Light Color Intensity', 'Multiplier for rim color', 0.0, 5.0, 0.1);
    this._addSliderRow(lightGroup, settings, 'glass-sheen-intensity', 'Sheen Intensity', 'Background sheen across surface', 0.0, 2.0, 0.01);
    this._addSliderRow(lightGroup, settings, 'glass-light-angle-deg', 'Light Angle (Deg)', 'Directional angle of light source', 0.0, 360.0, 1.0);

    const shadowGroup = new Adw.PreferencesGroup({
      title: 'Drop Shadow',
      description: 'Anchors the glass on light backgrounds (e.g. white wallpapers) so it does not visually disappear.'
    });
    shaderPage.add(shadowGroup);

    this._addSliderRow(shadowGroup, settings, 'shadow-radius', 'Shadow Radius (px)', 'How far the shadow extends past the glass edge. Set to 0 to disable.', 0.0, 100.0, 1.0);
    this._addSliderRow(shadowGroup, settings, 'shadow-intensity', 'Shadow Intensity', 'How dark the shadow is. 0 = invisible, 1 = pure black.', 0.0, 1.0, 0.01);

    const aoGroup = new Adw.PreferencesGroup({
      title: 'Inner Edge Darkening (AO)',
      description: 'A separate ambient-occlusion darkening just inside the glass edge, independent of the outer drop shadow above.'
    });
    shaderPage.add(aoGroup);

    this._addSliderRow(aoGroup, settings, 'glass-ao-intensity', 'AO Intensity', 'How dark the inner edge band gets. 0 = invisible, 1 = pure black.', 0.0, 1.0, 0.01);
    this._addSliderRow(aoGroup, settings, 'glass-ao-radius', 'AO Radius (px)', 'How far inward from the edge the darkening extends before fading out.', 0.0, 50.0, 0.5);

    const debugGroup = new Adw.PreferencesGroup({ title: 'Debug' });
    shaderPage.add(debugGroup);

    this._addSwitchRow(debugGroup, settings, 'output-logs', 'Output Logs', 'Output logs to the terminal');
    this._addSwitchRow(debugGroup, settings, 'glass-debug-diagnostics', 'Render Diagnostics', 'Collect per-paint render state for global._lgGlass.dump(). This runs on every paint of every glass surface and costs performance even with logging off — leave it disabled unless you are debugging a rendering problem.');

    // Blur Methodの選択に応じて、各Blur Radiusの注釈（subtitle）を動的に切り替える処理
    const updateBlurSubtitles = () => {
      // get_int() が 1 (Dual Kawase) の時だけ注意書きを追加する
      const isDualKawase = settings.get_int('blur-method') === 1;
      const subtitle = isDualKawase
        ? 'Background blur intensity (Uses Dual Kawase blur; radius may not be pixel-accurate)'
        : 'Background blur intensity';

      // 登録しておいたすべての Blur Radius 行のサブタイトルを更新
      blurRadiusRows.forEach(row => {
        row.subtitle = subtitle;
      });
    };

    // 設定変更時のシグナル接続と、初期起動時の実行
    settings.connect('changed::blur-method', updateBlurSubtitles);
    updateBlurSubtitles();
  }

  // --- 便利メソッド群 ---

  _addRowToContainer(container, row) {
    if (container.add_row) {
      container.add_row(row);
    } else {
      container.add(row);
    }
  }

  // 文字列値を選ぶ ComboRow。Adw.ComboRow の `selected` は整数インデックスなので
  // GSettings の文字列キーには直接 bind できず、双方向の対応づけを手で書いている
  // （Blur Resolution の行と同じ事情）。
  _addChoiceRow(container, settings, key, title, subtitle, options) {
    const row = new Adw.ComboRow({
      title,
      subtitle,
      model: Gtk.StringList.new(options.map(o => o.label)),
    });
    this._addRowToContainer(container, row);

    const values = options.map(o => o.value);
    const sync = () => {
      const idx = values.indexOf(settings.get_string(key));
      row.selected = idx < 0 ? 0 : idx;
    };
    sync();
    row.connect('notify::selected', () => {
      const value = values[row.selected];
      if (value !== undefined && value !== settings.get_string(key))
        settings.set_string(key, value);
    });
    // The handler outlives nothing: `settings` is created per preferences
    // window and dies with it, so there is no disconnect to arrange here
    // (and GTK4 gives no reliable per-row hook to hang one on).
    settings.connect(`changed::${key}`, sync);
    return row;
  }

  // ON/OFFスイッチ
  _addSwitchRow(container, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({ title, subtitle });
    this._addRowToContainer(container, row);
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // スライダーと標準のスピンボタン（+/-）を配置するメソッド
  _addSliderRow(container, settings, key, title, subtitle, min, max, step) {
    const row = new Adw.ActionRow({ title, subtitle });

    // 小数点のステップ数に応じて入力欄の表示桁数を自動判定
    let digits = 0;
    if (step < 1) digits = 2;
    if (step < 0.01) digits = 3;

    // スライダーとスピンボタンで共有する Adjustment
    const adjustment = new Gtk.Adjustment({
      lower: min,
      upper: max,
      step_increment: step
    });

    // 1. スライダー (Gtk.Scale) の生成
    const scale = Gtk.Scale.new(Gtk.Orientation.HORIZONTAL, adjustment);
    scale.set_hexpand(true);
    scale.set_valign(Gtk.Align.CENTER);
    scale.set_draw_value(false);
    scale.set_size_request(160, -1); // 最低限の横幅

    // 2. 標準の数値入力＆上下ボタン (Gtk.SpinButton) の生成
    const spinButton = new Gtk.SpinButton({
      adjustment: adjustment,
      climb_rate: step,
      digits: digits,
      numeric: true,
      valign: Gtk.Align.CENTER,
    });

    // スライダーとスピンボタンを並べるコンテナ
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      valign: Gtk.Align.CENTER
    });
    box.append(scale);
    box.append(spinButton);

    row.add_suffix(box);
    this._addRowToContainer(container, row);

    // 設定とAdjustmentをバインド（これだけで両方が連動して保存・読み込みされます）
    settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

    return row;
  }

  // 数値入力（整数・小数両対応）※念のため維持
  _addSpinRow(container, settings, key, title, subtitle, min, max, step) {
    let digits = 0;
    if (step < 1) digits = 2;
    if (step < 0.01) digits = 3;
    const row = new Adw.SpinRow({
      title,
      subtitle,
      adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
      digits: digits,
    });
    this._addRowToContainer(container, row);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // アプリケーションウィンドウのホワイトリスト／ブラックリスト編集UI。
  // WM_CLASS を直接打たせるのはユーザーフレンドリーではないので、開いている
  // ウィンドウ一覧（リアルタイム更新）から選んで追加できるようにしてある。
  _addWindowClassEditor(page, settings, client, options) {
    const { key, title, description, emptyTitle, emptySubtitle, pickerTitle, activeKey, activeWhen } = options;

    const listGroup = new Adw.PreferencesGroup({ title, description });
    page.add(listGroup);

    // The list that is not currently in effect is greyed out, so it is obvious
    // which of the two the "Apply to All Windows" switch is consulting.
    if (activeKey) {
      let flags = Gio.SettingsBindFlags.GET;
      if (!activeWhen)
        flags |= Gio.SettingsBindFlags.INVERT_BOOLEAN;
      settings.bind(activeKey, listGroup, 'sensitive', flags);
    }

    const addButton = new Gtk.Button({
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
      icon_name: 'list-add-symbolic',
      tooltip_text: pickerTitle,
    });
    addButton.connect('clicked', () => {
      this._presentWindowPicker(addButton, settings, client, key, pickerTitle);
    });
    listGroup.set_header_suffix(addButton);

    const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    listBox.add_css_class('boxed-list');
    listGroup.add(listBox);

    const refreshList = () => {
      let child = listBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        listBox.remove(child);
        child = next;
      }

      const items = settings.get_strv(key);
      for (const item of items) {
        const row = new Adw.ActionRow({ title: item, subtitle: 'WM_CLASS' });
        const removeButton = new Gtk.Button({
          icon_name: 'user-trash-symbolic',
          valign: Gtk.Align.CENTER,
          css_classes: ['flat', 'error'],
          tooltip_text: 'Remove',
        });
        removeButton.connect('clicked', () => {
          settings.set_strv(key, settings.get_strv(key).filter((v) => v !== item));
        });
        row.add_suffix(removeButton);
        listBox.append(row);
      }

      if (items.length === 0) {
        const emptyRow = new Adw.ActionRow({ title: emptyTitle, subtitle: emptySubtitle });
        emptyRow.add_css_class('dim-label');
        listBox.append(emptyRow);
      }
    };

    const changedId = settings.connect(`changed::${key}`, refreshList);
    listBox.connect('destroy', () => settings.disconnect(changedId));
    refreshList();

    // Manual entry is kept for windows that are not currently open (or that the
    // shell cannot report), but it is folded away so the picker is the default.
    const manualExpander = new Adw.ExpanderRow({
      title: 'Enter a WM_CLASS manually',
      subtitle: 'For applications that are not running right now (run: xprop WM_CLASS)',
    });
    listGroup.add(manualExpander);

    const entryRow = new Adw.EntryRow({ title: 'WM_CLASS', show_apply_button: true });
    entryRow.connect('apply', () => {
      const value = entryRow.get_text().trim();
      if (!value) return;
      this._addWindowClass(settings, key, value);
      entryRow.set_text('');
    });
    manualExpander.add_row(entryRow);
  }

  // 追加は大文字小文字を区別せずに重複チェックする（マッチング側も同様）
  _addWindowClass(settings, key, wmClass) {
    const value = wmClass.trim();
    if (!value) return false;

    const normalized = value.toLowerCase();
    const items = settings.get_strv(key);
    if (items.some((v) => v.toLowerCase() === normalized))
      return false;

    settings.set_strv(key, [...items, value]);
    return true;
  }

  // 開いているウィンドウ一覧のピッカー。開いている間は WindowsChanged シグナルを
  // 購読し、ウィンドウの開閉に追従して中身を更新する。
  _presentWindowPicker(parentWidget, settings, client, key, title) {
    const dialog = new Adw.Dialog({
      title,
      content_width: 500,
      content_height: 560,
    });

    const toolbarView = new Adw.ToolbarView();
    toolbarView.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(toolbarView);

    const contentBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      margin_top: 12,
      margin_bottom: 12,
      margin_start: 12,
      margin_end: 12,
    });

    const scrolled = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      vexpand: true,
      child: contentBox,
    });
    toolbarView.set_content(scrolled);

    const clearContent = () => {
      let child = contentBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        contentBox.remove(child);
        child = next;
      }
    };

    const showStatus = (iconName, statusTitle, statusDescription) => {
      clearContent();
      contentBox.append(new Adw.StatusPage({
        icon_name: iconName,
        title: statusTitle,
        description: statusDescription,
        vexpand: true,
      }));
    };

    const showWindows = (windows) => {
      clearContent();

      if (!windows || windows.length === 0) {
        showStatus('window-symbolic', 'No open windows',
          'Open an application window and it will appear here.');
        return;
      }

      const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
      listBox.add_css_class('boxed-list');
      contentBox.append(listBox);

      const current = settings.get_strv(key).map((v) => v.toLowerCase());

      for (const info of windows) {
        const wmClass = info.wmClass;
        if (!wmClass) continue;

        const rowTitle = info.appName || wmClass;
        const details = [];
        // The WM_CLASS is what actually gets stored, so it is worth showing —
        // except when it is already the row's title.
        if (rowTitle !== wmClass)
          details.push(wmClass);
        if (info.count > 1)
          details.push(`${info.count} windows`);
        if (!info.normal)
          details.push('not a normal window — the effect cannot apply');

        const row = new Adw.ActionRow({
          title: rowTitle,
          subtitle: details.join(' · '),
          tooltip_text: (info.titles && info.titles.length) ? info.titles.join('\n') : null,
        });

        const image = new Gtk.Image({ pixel_size: 32, valign: Gtk.Align.CENTER });
        let icon = null;
        try {
          if (info.iconName)
            icon = Gio.Icon.new_for_string(info.iconName);
        } catch (e) {
          icon = null;
        }
        if (icon)
          image.set_from_gicon(icon);
        else
          image.set_from_icon_name('application-x-executable-symbolic');
        row.add_prefix(image);

        if (current.includes(wmClass.toLowerCase())) {
          const added = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Already in the list',
          });
          added.add_css_class('success');
          row.add_suffix(added);
          row.set_sensitive(false);
        } else {
          const button = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Add',
          });
          // The `changed::` handler below re-renders the list, so the row flips
          // to the "already added" state on its own.
          button.connect('clicked', () => this._addWindowClass(settings, key, wmClass));
          row.add_suffix(button);
          row.activatable_widget = button;
        }

        listBox.append(row);
      }
    };

    const refresh = () => {
      client.listWindows((windows, error) => {
        if (error)
          showStatus('dialog-warning-symbolic', 'Window list unavailable', error);
        else
          showWindows(windows);
      });
    };

    // Live updates: the shell tells us when windows come and go, and the settings
    // change tells us when this list itself was edited.
    const unwatch = client.addWatcher(refresh);
    const changedId = settings.connect(`changed::${key}`, refresh);
    dialog.connect('closed', () => {
      unwatch();
      settings.disconnect(changedId);
    });

    showStatus('content-loading-symbolic', 'Loading…', null);
    refresh();

    dialog.present(parentWidget);
  }

  // 色選択
  _addColorRow(container, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({ title, subtitle });
    const colorButton = new Gtk.ColorDialogButton({
      valign: Gtk.Align.CENTER,
      dialog: new Gtk.ColorDialog(),
    });

    // 保存されたHEX文字列をRGBAに変換してセット
    const rgba = new Gdk.RGBA();
    rgba.parse(settings.get_string(key));
    colorButton.rgba = rgba;

    // 色が変わったらHEXに変換して保存
    colorButton.connect('notify::rgba', () => {
      const color = colorButton.rgba;
      const r = Math.floor(color.red * 255).toString(16).padStart(2, '0');
      const g = Math.floor(color.green * 255).toString(16).padStart(2, '0');
      const b = Math.floor(color.blue * 255).toString(16).padStart(2, '0');
      const hex = `#${r}${g}${b}`;

      settings.set_string(key, hex);
    });

    row.add_suffix(colorButton);
    this._addRowToContainer(container, row);
  }
}
