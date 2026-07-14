import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

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
    this._addSwitchRow(menuGroup, settings, "enable-menu-animation", "Enable Menu Animation", "Apply to menus and popups");

    this._addSliderRow(menuGroup, settings, 'menu-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(menuGroup, settings, 'menu-x-offset', 'X Offset', 'Horizontal offset adjustment', -200, 200, 1);
    this._addSliderRow(menuGroup, settings, 'menu-y-offset', 'Y Offset', 'Vertical offset adjustment', -50, 100, 1);

    this._addSwitchRow(menuGroup, settings, 'menu-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const menuSampleIntervalRow = this._addSliderRow(menuGroup, settings, 'menu-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('menu-enable-adaptive-text-color', menuSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addColorRow(menuGroup, settings, 'menu-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(menuGroup, settings, 'menu-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const menuBlurRow = this._addSliderRow(menuGroup, settings, 'menu-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(menuBlurRow);
    this._addSliderRow(menuGroup, settings, 'menu-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

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
    const notifSampleIntervalRow = this._addSliderRow(notifGroup, settings, 'notification-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('notification-enable-adaptive-text-color', notifSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

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
    this._addSwitchRow(qsGroup, settings, "enable-quick-settings-animation", "Enable Quick Settings Animation", "Apply to quick settings panel");

    this._addSwitchRow(qsGroup, settings, 'quick-settings-enable-adaptive-text-color', 'Adaptive Text Color', 'Adjust text contrast automatically');
    const qsSampleIntervalRow = this._addSliderRow(qsGroup, settings, 'quick-settings-sample-interval-ms', 'Sample Interval (ms)', 'Contrast update frequency', 100, 2000, 50);
    // Adaptive Text Color連動の非表示化
    settings.bind('quick-settings-enable-adaptive-text-color', qsSampleIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

    this._addSliderRow(qsGroup, settings, 'quick-settings-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
    this._addSliderRow(qsGroup, settings, 'quick-settings-x-offset', 'X Offset', 'Horizontal offset adjustment', -100, 100, 1);
    this._addSliderRow(qsGroup, settings, 'quick-settings-y-offset', 'Y Offset', 'Vertical offset adjustment', -100, 100, 1);
    this._addColorRow(qsGroup, settings, 'quick-settings-tint-color', 'Tint Color', 'Color of the glass tint');
    this._addSliderRow(qsGroup, settings, 'quick-settings-tint-strength', 'Tint Strength', 'Intensity of the color tint', 0.0, 1.0, 0.01);
    const qsBlurRow = this._addSliderRow(qsGroup, settings, 'quick-settings-blur-radius', 'Blur Radius', '', 0, 30, 1);
    blurRadiusRows.push(qsBlurRow);
    this._addSliderRow(qsGroup, settings, 'quick-settings-corner-radius', 'Corner Radius', 'Roundness of the corners', 0, 200, 1);

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

    // アニメーションOFF時に項目を非表示にするバインド
    settings.bind('enable-quick-settings-animation', quickSettingsStiffnessRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-quick-settings-animation', quickSettingsDampingRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-quick-settings-animation', quickSettingsMassRow, 'visible', Gio.SettingsBindFlags.GET);
    settings.bind('enable-quick-settings-animation', quickSettingsIntervalRow, 'visible', Gio.SettingsBindFlags.GET);

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


    // --- Glass Properties タブ ---
    const shaderPage = new Adw.PreferencesPage({
      title: 'Glass',
      icon_name: 'image-adjust-shadows-symbolic',
    });
    window.add(shaderPage);

    const physGroup = new Adw.PreferencesGroup({ title: 'Physical & Optical Properties' });
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

    this._addSliderRow(physGroup, settings, 'glass-max-z', 'Maximum Z Depth', 'Physical thickness of the glass', 0.0, 100.0, 1.0);
    this._addSliderRow(physGroup, settings, 'glass-displacement-scale', 'Displacement Scale', 'Strength of light refraction', 0.0, 200.0, 1.0);
    this._addSliderRow(physGroup, settings, 'glass-edge-smoothing', 'Edge Smoothing', 'Anti-aliasing feathering width', 0.0, 10.0, 0.1);
    this._addSliderRow(physGroup, settings, 'glass-profile-shape-n', 'Profile Shape N', 'Curvature shape of the surface', 1.0, 20.0, 0.1);
    this._addSliderRow(physGroup, settings, 'glass-ior', 'Index of Refraction', 'Optical density (1.5 - 2.4)', 1.0, 4.0, 0.01);
    this._addSliderRow(physGroup, settings, 'glass-chroma-strength', 'Chroma Strength', 'RGB color separation', 0.0, 0.1, 0.001);

    const lightGroup = new Adw.PreferencesGroup({ title: 'Lighting & Reflections' });
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
