import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import GLib from 'gi://GLib';
import { UIManager } from './uiManager.js';
// Preserve the preferences from the original keyboard/Vitals implementation.
const LEGACY_KEYS = {
    keyboard: 'enable-keyboard-menu-glass',
    vitalsMenu: 'enable-vitals-menu-glass',
};
export class PanelMenuManager {
    _path;
    _settings;
    _logger;
    _signals = [];
    _buttons = new Map();
    _menus = new Map();
    _idleId = 0;
    _active = false;
    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }
    setup() {
        this._active = true;
        const schedule = () => this._scheduleScan();
        const watch = (target, signal) => {
            this._signals.push({ target, id: target.connect(signal, schedule) });
        };
        // Defer until addToStatusArea() has finished registering the indicator.
        const panel = Main.panel;
        for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
            watch(box, 'child-added');
            watch(box, 'child-removed');
        }
        watch(Main.extensionManager, 'extension-state-changed');
        for (const key of ['enable-extra-menu-glass', 'disabled-extra-menus', ...Object.values(LEGACY_KEYS)])
            watch(this._settings, `changed::${key}`);
        this._scheduleScan();
    }
    _scheduleScan() {
        if (!this._active || this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }
    _scan() {
        const panel = Main.panel;
        const buttons = new Set();
        const wanted = new Map();
        const detected = [];
        const disabled = new Set(this._settings.get_strv('disabled-extra-menus'));
        const enabled = this._settings.get_boolean('enable-extra-menu-glass');
        const reserved = new Set([panel.statusArea.dateMenu?.menu, panel.statusArea.quickSettings?.menu]);
        for (const [name, button] of Object.entries(panel.statusArea)) {
            if (!button || !panel.contains(button.container ?? button))
                continue;
            buttons.add(button);
            if (!this._buttons.has(button)) {
                this._buttons.set(button, [
                    button.connect('menu-set', () => this._scheduleScan()),
                    button.connect('destroy', () => {
                        this._buttons.delete(button);
                        this._scheduleScan();
                    }),
                ]);
            }
            const menu = button.menu;
            // Dummy menus and custom non-popup actors cannot use UIManager.
            // Calendar and Quick Settings already have their own managers.
            if (!(menu instanceof PopupMenu.PopupMenu) || reserved.has(menu) || !menu.actor || !menu.box)
                continue;
            detected.push(name);
            const allowed = LEGACY_KEYS[name]
                ? this._settings.get_boolean(LEGACY_KEYS[name]) : !disabled.has(name);
            if (enabled && allowed)
                wanted.set(menu, button);
        }
        for (const [button, ids] of this._buttons) {
            if (buttons.has(button))
                continue;
            for (const id of ids)
                button.disconnect(id);
            this._buttons.delete(button);
        }
        // Keep existing instances: a new indicator must not close another menu.
        for (const [menu, manager] of this._menus) {
            if (wanted.has(menu))
                continue;
            this._menus.delete(menu);
            try {
                manager.cleanup();
            }
            catch (e) {
                this._logger.log(`[Liquid Glass] Menu cleanup: ${e}`);
            }
        }
        for (const [menu, button] of wanted) {
            if (this._menus.has(menu))
                continue;
            let manager = null;
            try {
                manager = new UIManager(this._path, this._settings, this._logger, button, false, 'enable-extra-menu-glass');
                manager.setup();
                this._menus.set(menu, manager);
            }
            catch (e) {
                try {
                    manager?.cleanup();
                }
                catch (_) { /* partial setup */ }
                this._logger.log(`[Liquid Glass] Could not attach panel menu glass: ${e}`);
            }
        }
        detected.sort();
        if (JSON.stringify(detected) !== JSON.stringify(this._settings.get_strv('detected-extra-menus')))
            this._settings.set_strv('detected-extra-menus', detected);
    }
    cleanup() {
        this._active = false;
        if (this._idleId)
            GLib.Source.remove(this._idleId);
        this._idleId = 0;
        for (const { target, id } of this._signals)
            target.disconnect(id);
        this._signals = [];
        for (const [button, ids] of this._buttons)
            for (const id of ids)
                button.disconnect(id);
        this._buttons.clear();
        for (const manager of this._menus.values()) {
            try {
                manager.cleanup();
            }
            catch (e) {
                this._logger.log(`[Liquid Glass] Menu cleanup: ${e}`);
            }
        }
        this._menus.clear();
        this._settings.set_strv('detected-extra-menus', []);
    }
}
