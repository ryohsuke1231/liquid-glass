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
        this._addSpinRow(menuGroup, settings, 'menu-glass-expand', 'Glass Expand', 'Extra area for the effect', 0, 50, 1);
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
    }

    // --- 便利メソッド群 ---

    // ON/OFFスイッチ
    _addSwitchRow(group, settings, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({ title, subtitle });
        group.add(row);
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    // 数値入力（整数・小数両対応）
    _addSpinRow(group, settings, key, title, subtitle, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
            digits: step < 1 ? 2 : 0, // 小数の場合は小数点第2位まで表示
        });
        group.add(row);
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
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