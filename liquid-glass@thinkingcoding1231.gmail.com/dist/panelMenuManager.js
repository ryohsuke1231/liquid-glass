import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DateMenu from 'resource:///org/gnome/shell/ui/dateMenu.js';
import { UIManager } from './uiManager.js';
// Settings prefix for every detected panel menu, separate from the calendar's
// `menu-*` keys (see UIManager._keyPrefix).
const PANEL_MENU_PREFIX = 'panel-menu';
// Menus that had their own switch before the generic detection existed.
const LEGACY_KEYS = {
    keyboard: 'enable-keyboard-menu-glass',
    vitalsMenu: 'enable-vitals-menu-glass',
};

// The popup menus a status area entry opens, with the names they are listed
// under. ArcMenu destroys the button's own menu and opens two of its own.
function menusOf(name, button) {
    if (button.arcMenu)
        return [[name, button.arcMenu], [`${name}ContextMenu`, button.arcMenuContextMenu]];
    return [[name, button.menu]];
}

// The settings Dash to Dock's menus get glass by: the panel menus' switch, and the dock growing its menus.
const DOCK_MENU_KEYS = ['enable-extra-menu-glass', 'dock-menus-grow'];

// Whether `actor` sits in Dash to Dock's dash. Some status area entries are not actors.
function inDock(actor) {
    if (!(actor instanceof Clutter.Actor))
        return false;
    for (let a = actor; a; a = a.get_parent())
        if (a.get_name() === 'dashtodockDashContainer')
            return true;
    return false;
}

export class PanelMenuManager {
    _path;
    _settings;
    _logger;
    _signals = [];
    _buttons = new Map();
    // Menu actor -> its glass, with the indicator name for the logs.
    _menus = new Map();
    _idleId = 0;

    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }

    setup() {
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
        for (const key of [...DOCK_MENU_KEYS, 'disabled-extra-menus', ...Object.values(LEGACY_KEYS)])
            watch(this._settings, `changed::${key}`);
        this._scheduleScan();
    }

    _scheduleScan() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const panel = Main.panel;
        const { buttons, wanted, detected } = this._discover(panel);
        this._forgetButtons(buttons);
        this._detachUnwanted(wanted);
        this._attachWanted(wanted);
        detected.sort();
        if (JSON.stringify(detected) !== JSON.stringify(this._settings.get_strv('detected-extra-menus')))
            this._settings.set_strv('detected-extra-menus', detected);
    }

    _discover(panel) {
        const buttons = new Set();
        const wanted = new Map();
        const detected = [];
        const disabled = new Set(this._settings.get_strv('disabled-extra-menus'));
        const enabled = this._settings.get_boolean('enable-extra-menu-glass');
        const reserved = new Set([panel.statusArea.dateMenu?.menu, panel.statusArea.quickSettings?.menu]);
        const dockMenus = this._settings.get_boolean('dock-menus-grow');
        for (const [name, button] of Object.entries(panel.statusArea)) {
            // On the bar, or moved into Dash to Dock (as Dock Tray does with the tray icons) while its menus grow out of it.
            const actor = button?.container ?? button;
            if (!button || !(panel.contains(actor) || (dockMenus && inDock(actor))))
                continue;
            buttons.add(button);
            this._watchButton(button);
            for (const [menuName, menu] of menusOf(name, button)) {
                // Dummy menus and custom non-popup actors cannot use UIManager.
                // Calendar and Quick Settings already have their own managers.
                if (!(menu instanceof PopupMenu.PopupMenu) || reserved.has(menu) || !menu.actor || !menu.box)
                    continue;
                detected.push(menuName);
                const allowed = LEGACY_KEYS[menuName]
                    ? this._settings.get_boolean(LEGACY_KEYS[menuName]) : !disabled.has(menuName);
                if (enabled && allowed)
                    wanted.set(menu, { name: menuName });
            }
        }
        return { buttons, wanted, detected };
    }

    _watchButton(button) {
        if (this._buttons.has(button))
            return;
        this._buttons.set(button, [
            button.connect('menu-set', () => this._scheduleScan()),
            button.connect('destroy', () => {
                this._buttons.delete(button);
                this._scheduleScan();
            }),
        ]);
    }

    _forgetButtons(present) {
        for (const [button, ids] of this._buttons) {
            if (present.has(button))
                continue;
            for (const id of ids)
                button.disconnect(id);
            this._buttons.delete(button);
        }
    }

    _detachUnwanted(wanted) {
        // Keep existing instances: a new indicator must not close another menu.
        for (const [menu, entry] of this._menus) {
            if (wanted.has(menu))
                continue;
            this._menus.delete(menu);
            entry.manager.cleanup();
        }
    }

    // Most of these menus belong to other extensions and may not be built the
    // way UIManager expects; such a menu is skipped instead of stopping the scan.
    _attachWanted(wanted) {
        for (const [menu, { name }] of wanted) {
            if (this._menus.has(menu))
                continue;
            const manager = new UIManager(this._path, this._settings, this._logger, { menu }, false, 'enable-extra-menu-glass', PANEL_MENU_PREFIX, `menu:${name}`, false);
            try {
                manager.setup();
                this._menus.set(menu, { name, manager });
            }
            catch (e) {
                manager.cleanup();
                this._logger.log(`[Liquid Glass] Could not attach panel menu glass to "${name}": ${e}`);
            }
        }
    }

    cleanup() {
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        for (const { target, id } of this._signals)
            target.disconnect(id);
        this._signals = [];
        for (const [button, ids] of this._buttons) {
            for (const id of ids)
                button.disconnect(id);
        }
        this._buttons.clear();
        for (const { manager } of this._menus.values())
            manager.cleanup();
        this._menus.clear();
        this._settings.set_strv('detected-extra-menus', []);
    }
}

// PopupMenu sets itself as its actor's _delegate.
function menuOf(actor) {
    const delegate = '_delegate' in actor ? actor._delegate : null;
    return delegate instanceof PopupMenu.PopupMenu ? delegate : null;
}

/**
 * Glass behind Dash to Dock's app icon menus (and its show-apps button's) while dock-menus-grow is on, which grow
 * out of the dock's glass. They follow the other panel menus' switch and settings.
 */
export class DockMenuManager {
    _path;
    _settings;
    _logger;
    _signals = [];
    _menus = new Map();
    _settingsIds = [];
    _attached = 0;

    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }

    setup() {
        const uiGroup = Main.layoutManager.uiGroup;
        // Dash to Dock builds a menu on its first popup, which adds itself to uiGroup and opens at once: it is attached
        // here, before it opens, rather than on a later scan.
        this._signals.push({ target: uiGroup, id: uiGroup.connect('child-added', (_group, actor) => this._attach(actor)) });
        this._settingsIds = DOCK_MENU_KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._rescan()));
        this._rescan();
    }

    _enabled() {
        return DOCK_MENU_KEYS.every(key => this._settings.get_boolean(key));
    }

    _rescan() {
        this._detachAll();
        if (!this._enabled())
            return;
        for (const child of Main.layoutManager.uiGroup.get_children())
            this._attach(child);
    }

    _attach(actor) {
        const menu = menuOf(actor);
        if (!menu || this._menus.has(menu) || !this._enabled())
            return;
        if (!(actor instanceof St.Widget) || !actor.has_style_class_name('dock-app-menu') || !menu.box)
            return;
        const manager = new UIManager(this._path, this._settings, this._logger, { menu }, false, 'enable-extra-menu-glass', PANEL_MENU_PREFIX, `menu:dock${++this._attached}`, false);
        manager.setup();
        const destroyId = actor.connect('destroy', () => {
            this._menus.delete(menu);
            manager.cleanup();
        });
        this._menus.set(menu, { manager, actor, destroyId });
    }

    _detachAll() {
        for (const { manager, actor, destroyId } of this._menus.values()) {
            actor.disconnect(destroyId);
            manager.cleanup();
        }
        this._menus.clear();
    }

    cleanup() {
        for (const { target, id } of this._signals)
            target.disconnect(id);
        this._signals = [];
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._detachAll();
    }
}

/**
 * Glass behind the calendar menus of the top bars other extensions put on further monitors,
 * such as Multi Monitors Bar. Those bars build their own DateMenuButton, which the main panel's
 * UIManager never sees. They follow the Calendar menu's switch and settings.
 */
export class ExtraDateMenuManager {
    _path;
    _settings;
    _logger;
    _signals = [];
    _menus = new Map();
    _idleId = 0;
    _attached = 0;

    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }

    setup() {
        // PanelMenu.Button puts its menu straight into uiGroup, so a bar created or destroyed later shows up here.
        const uiGroup = Main.layoutManager.uiGroup;
        for (const signal of ['child-added', 'child-removed'])
            this._signals.push({ target: uiGroup, id: uiGroup.connect(signal, () => this._scheduleScan()) });
        // The shell destroys uiGroup on shutdown without disabling extensions; a scan queued by the
        // removal of its children would run on a disposed actor.
        this._signals.push({ target: uiGroup, id: uiGroup.connect('destroy', () => this.cleanup()) });
        this._scheduleScan();
    }

    _scheduleScan() {
        if (this._idleId)
            return;
        // The menu is added while its button is still being built.
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        // Gone while the shell shuts down.
        const primary = Main.panel.statusArea.dateMenu?.menu;
        const found = new Set();
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            const menu = menuOf(child);
            if (menu && menu !== primary && menu.sourceActor instanceof DateMenu.DateMenuButton)
                found.add(menu);
        }
        for (const [menu, manager] of this._menus) {
            if (found.has(menu))
                continue;
            this._menus.delete(menu);
            manager.cleanup();
        }
        for (const menu of found) {
            if (this._menus.has(menu))
                continue;
            const manager = new UIManager(this._path, this._settings, this._logger, { menu }, false, 'enable-menu-glass', 'menu', `menu:dateMenu${++this._attached}`, false);
            // These buttons belong to other extensions and may not be built the way UIManager expects.
            try {
                manager.setup();
                this._menus.set(menu, manager);
            }
            catch (e) {
                manager.cleanup();
                this._logger.log(`[Liquid Glass] Could not attach glass to another top bar's calendar menu: ${e}`);
            }
        }
    }

    cleanup() {
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        for (const { target, id } of this._signals)
            target.disconnect(id);
        this._signals = [];
        for (const manager of this._menus.values())
            manager.cleanup();
        this._menus.clear();
    }
}
