import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

export default class LiquidGlassPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com");

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
    this._addSpinRow(dockGroup, settings, 'dock-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSpinRow(dockGroup, settings, 'dock-margin-bottom', 'Margin Bottom', 'Bottom spacing', 0, 1000, 1);
    this._addColorRow(dockGroup, settings, 'dock-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSpinRow(dockGroup, settings, 'dock-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    this._addSpinRow(dockGroup, settings, 'dock-blur-radius', 'Blur Radius', 'Background blur intensity', 0, 100, 1);
    this._addSpinRow(dockGroup, settings, 'dock-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);


    // --- Menu タブ ---
    const menuPage = new Adw.PreferencesPage({
      title: 'Menu',
      icon_name: 'view-list-symbolic',
    });
    window.add(menuPage);

    const menuGroup = new Adw.PreferencesGroup({ title: 'Menu Settings' });
    menuPage.add(menuGroup);

    this._addSwitchRow(menuGroup, settings, 'enable-menu-glass', 'Enable Glass Effect', 'Apply to menus and popups');
    this._addSwitchRow(menuGroup, settings, "enable-menu-animation", "Enable Menu Animation", "Apply to menus and popups");

    const menuStiffnessRow = this._addSpinRow(menuGroup, settings, 'menu-spring-stiffness', 'Spring Stiffness', 'Spring stiffness', 0.0, 1000.0, 0.1);
    const menuDampingRow = this._addSpinRow(menuGroup, settings, 'menu-spring-damping', 'Spring Damping', 'Spring damping', 0.0, 1000.0, 0.1);
    const menuMassRow = this._addSpinRow(menuGroup, settings, 'menu-spring-mass', 'Spring Mass', 'Spring mass', 0.0, 1.0, 0.1);
    const menuIntervalRow = this._addSpinRow(menuGroup, settings, 'menu-animation-interval-ms', 'Animation Interval (ms)', 'Animation interval', 0, 1000, 1);

    settings.bind('enable-menu-animation', menuStiffnessRow, 'sensitive', Gio.SettingsBindFlags.GET);
    settings.bind('enable-menu-animation', menuDampingRow, 'sensitive', Gio.SettingsBindFlags.GET);
    settings.bind('enable-menu-animation', menuMassRow, 'sensitive', Gio.SettingsBindFlags.GET);
    settings.bind('enable-menu-animation', menuIntervalRow, 'sensitive', Gio.SettingsBindFlags.GET);

    this._addSpinRow(menuGroup, settings, 'menu-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSpinRow(menuGroup, settings, 'menu-x-offset', 'X Offset', 'Horizontal offset adjustment', -200, 200, 1);
    this._addSpinRow(menuGroup, settings, 'menu-y-offset', 'Y Offset', 'Vertical offset adjustment', -50, 100, 1);
    this._addSwitchRow(menuGroup, settings, 'menu-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    this._addSpinRow(menuGroup, settings, 'menu-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    this._addColorRow(menuGroup, settings, 'menu-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSpinRow(menuGroup, settings, 'menu-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    this._addSpinRow(menuGroup, settings, 'menu-blur-radius', 'Blur Radius', 'Background blur intensity', 0, 100, 1);
    this._addSpinRow(menuGroup, settings, 'menu-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);


    // --- Notifications タブ ---
    const notifPage = new Adw.PreferencesPage({
      title: 'Notifications',
      icon_name: 'preferences-system-notifications-symbolic',
    });
    window.add(notifPage);

    const notifGroup = new Adw.PreferencesGroup({ title: 'Notification Settings' });
    notifPage.add(notifGroup);

    this._addSwitchRow(notifGroup, settings, 'enable-notification-glass', 'Enable Glass Effect', 'Apply to notification banners');
    this._addSwitchRow(notifGroup, settings, 'notification-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    this._addSpinRow(notifGroup, settings, 'notification-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    this._addSpinRow(notifGroup, settings, 'notification-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSpinRow(notifGroup, settings, 'notification-y-offset', 'Y Offset', 'Vertical offset adjustment', 0, 100, 1);
    this._addColorRow(notifGroup, settings, 'notification-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSpinRow(notifGroup, settings, 'notification-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    this._addSpinRow(notifGroup, settings, 'notification-blur-radius', 'Blur Radius', 'Background blur intensity', 0, 100, 1);
    this._addSpinRow(notifGroup, settings, 'notification-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // --- Quick Settings タブ ---
    const qsPage = new Adw.PreferencesPage({
      title: 'Quick Settings',
      icon_name: 'shapes-large-symbolic',
    });
    window.add(qsPage);

    const qsGroup = new Adw.PreferencesGroup({ title: 'Quick Settings Settings (Experimental)' });
    qsPage.add(qsGroup);

    this._addSwitchRow(qsGroup, settings, 'enable-quick-settings-glass', 'Enable Glass Effect', 'Apply to quick settings panel');
    this._addSwitchRow(qsGroup, settings, "enable-quick-settings-animation", "Enable Quick Settings Animation", "Apply to quick settings panel");

    const quickSettingsStiffnessRow = this._addSpinRow(qsGroup, settings, 'quick-settings-spring-stiffness', 'Spring Stiffness', 'Spring stiffness', 0.0, 1000.0, 0.1);
    const quickSettingsDampingRow = this._addSpinRow(qsGroup, settings, 'quick-settings-spring-damping', 'Spring Damping', 'Spring damping', 0.0, 1000.0, 0.1);
    const quickSettingsMassRow = this._addSpinRow(qsGroup, settings, 'quick-settings-spring-mass', 'Spring Mass', 'Spring mass', 0.0, 1.0, 0.1);
    const quickSettingsIntervalRow = this._addSpinRow(qsGroup, settings, 'quick-settings-animation-interval-ms', 'Animation Interval (ms)', 'Animation interval', 0, 1000, 1);

    settings.bind('enable-quick-settings-animation', quickSettingsStiffnessRow, 'sensitive', Gio.SettingsBindFlags.GET);
    settings.bind('enable-quick-settings-animation', quickSettingsDampingRow, 'sensitive', Gio.SettingsBindFlags.GET);
    settings.bind('enable-quick-settings-animation', quickSettingsMassRow, 'sensitive', Gio.SettingsBindFlags.GET);
    settings.bind('enable-quick-settings-animation', quickSettingsIntervalRow, 'sensitive', Gio.SettingsBindFlags.GET);

    this._addSwitchRow(qsGroup, settings, 'quick-settings-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    this._addSpinRow(qsGroup, settings, 'quick-settings-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    this._addSpinRow(qsGroup, settings, 'quick-settings-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSpinRow(qsGroup, settings, 'quick-settings-x-offset', 'X Offset', 'Horizontal offset adjustment', -100, 100, 1);
    this._addSpinRow(qsGroup, settings, 'quick-settings-y-offset', 'Y Offset', 'Vertical offset adjustment', -100, 100, 1);
    this._addColorRow(qsGroup, settings, 'quick-settings-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSpinRow(qsGroup, settings, 'quick-settings-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    this._addSpinRow(qsGroup, settings, 'quick-settings-blur-radius', 'Blur Radius', 'Background blur intensity', 0, 100, 1);
    this._addSpinRow(qsGroup, settings, 'quick-settings-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

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
    this._addSpinRow(osdGroup, settings, 'osd-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    this._addSpinRow(osdGroup, settings, 'osd-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSpinRow(osdGroup, settings, 'osd-y-offset', 'Y Offset', 'Vertical offset adjustment', -100, 100, 1);
    this._addColorRow(osdGroup, settings, 'osd-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSpinRow(osdGroup, settings, 'osd-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    this._addSpinRow(osdGroup, settings, 'osd-blur-radius', 'Blur Radius', 'Background blur intensity', 0, 100, 1);
    this._addSpinRow(osdGroup, settings, 'osd-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

    // --- Glass Properties タブ ---
    const shaderPage = new Adw.PreferencesPage({
      title: 'Advanced Glass',
      icon_name: 'image-adjust-shadows-symbolic',
    });
    window.add(shaderPage);

    const physGroup = new Adw.PreferencesGroup({ title: 'Physical & Optical Properties' });
    shaderPage.add(physGroup);

    this._addSpinRow(physGroup, settings, 'glass-max-z', 'Maximum Z Depth', 'Physical thickness of the glass', 0.0, 100.0, 1.0);
    this._addSpinRow(physGroup, settings, 'glass-displacement-scale', 'Displacement Scale', 'Strength of light refraction', 0.0, 200.0, 1.0);
    this._addSpinRow(physGroup, settings, 'glass-edge-smoothing', 'Edge Smoothing', 'Anti-aliasing feathering width', 0.0, 10.0, 0.1);
    this._addSpinRow(physGroup, settings, 'glass-profile-shape-n', 'Profile Shape N', 'Curvature shape of the surface', 1.0, 20.0, 0.1);
    this._addSpinRow(physGroup, settings, 'glass-ior', 'Index of Refraction', 'Optical density (1.5 - 2.4)', 1.0, 4.0, 0.01);
    this._addSpinRow(physGroup, settings, 'glass-chroma-strength', 'Chroma Strength', 'RGB color separation', 0.0, 0.1, 0.001);

    const lightGroup = new Adw.PreferencesGroup({ title: 'Lighting & Reflections' });
    shaderPage.add(lightGroup);

    this._addSpinRow(lightGroup, settings, 'glass-specular-intensity', 'Specular Intensity', 'Brightness of highlights', 0.0, 5.0, 0.1);
    this._addSpinRow(lightGroup, settings, 'glass-shininess', 'Shininess', 'Sharpness of reflections', 1.0, 200.0, 1.0);
    this._addSpinRow(lightGroup, settings, 'glass-rim-width', 'Rim Width', 'Width of the edge lighting', 0.0, 20.0, 0.1);
    this._addSpinRow(lightGroup, settings, 'glass-rim-intensity', 'Rim Intensity', 'Brightness of rim light', 0.0, 5.0, 0.1);
    this._addSpinRow(lightGroup, settings, 'glass-rim-directional-power', 'Rim Directional Power', 'Light direction effect on rim', 0.0, 10.0, 0.1);
    this._addSpinRow(lightGroup, settings, 'glass-rim-power', 'Rim Fresnel Power', 'Fresnel falloff for rim light', 0.0, 20.0, 0.1);
    this._addSpinRow(lightGroup, settings, 'glass-rim-light-color-intensity', 'Rim Light Color Intensity', 'Multiplier for rim color', 0.0, 5.0, 0.1);
    this._addSpinRow(lightGroup, settings, 'glass-sheen-intensity', 'Sheen Intensity', 'Background sheen across surface', 0.0, 2.0, 0.01);
    this._addSpinRow(lightGroup, settings, 'glass-light-angle-deg', 'Light Angle (Deg)', 'Directional angle of light source', 0.0, 360.0, 1.0);

    const shadowGroup = new Adw.PreferencesGroup({
      title: 'Drop Shadow',
      description: 'Anchors the glass on light backgrounds (e.g. white wallpapers) so it does not visually disappear.'
    });
    shaderPage.add(shadowGroup);

    this._addSpinRow(shadowGroup, settings, 'shadow-radius', 'Shadow Radius (px)', 'How far the shadow extends past the glass edge. Set to 0 to disable.', 0.0, 100.0, 1.0);
    this._addSpinRow(shadowGroup, settings, 'shadow-intensity', 'Shadow Intensity', 'How dark the shadow is. 0 = invisible, 1 = pure black.', 0.0, 1.0, 0.01);

    const debugGroup = new Adw.PreferencesGroup({ title: 'Debug' });
    shaderPage.add(debugGroup);

    this._addSwitchRow(debugGroup, settings, 'output-logs', 'Output Logs', 'Output logs to the terminal');
  }

  // --- 便利メソッド群 ---

  // ON/OFFスイッチ
  _addSwitchRow(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({ title, subtitle });
    group.add(row);
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // 数値入力（整数・小数両対応）
  _addSpinRow(group, settings, key, title, subtitle, min, max, step) {
    // stepの値に応じて小数点以下の表示桁数を調整
    let digits = 0;
    if (step < 1) digits = 2;
    if (step < 0.01) digits = 3;
    const row = new Adw.SpinRow({
      title,
      subtitle,
      adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
      digits: digits,
    });
    group.add(row);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  // 色選択
  _addColorRow(group, settings, key, title, subtitle) {
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
    group.add(row);
  }
}
