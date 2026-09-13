import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { UIManager } from './uiManager.js';
import { Logger } from './logger.js';

// GSettings namespace for every detected panel dropdown. Separate from the
// Calendar's `menu-*` so these can be tuned without moving the date menu —
// the same split quick-settings-*, notification-*, osd-* and dock-* already
// have. UIManager builds its keys from this; see its _keyPrefix.
const PANEL_MENU_PREFIX = 'panel-menu';

// Preserve the preferences from the original keyboard/Vitals implementation.
const LEGACY_KEYS: Record<string, string> = {
  keyboard: 'enable-keyboard-menu-glass',
  vitalsMenu: 'enable-vitals-menu-glass',
};

export class PanelMenuManager {
  private _signals: { target: any; id: number }[] = [];
  private _buttons = new Map<any, number[]>();
  // menu actor -> the glass on it, tagged with the indicator name it was
  // found under so logs and teardown can name the menu that misbehaved.
  private _menus = new Map<any, { name: string; manager: UIManager }>();
  private _idleId = 0;
  private _active = false;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {}

  setup() {
    this._active = true;
    const schedule = () => this._scheduleScan();
    const watch = (target: any, signal: string) => {
      this._signals.push({ target, id: target.connect(signal, schedule) });
    };
    // Defer until addToStatusArea() has finished registering the indicator.
    const panel = Main.panel as any;
    for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
      watch(box, 'child-added');
      watch(box, 'child-removed');
    }
    watch(Main.extensionManager, 'extension-state-changed');
    for (const key of ['enable-extra-menu-glass', 'disabled-extra-menus', ...Object.values(LEGACY_KEYS)])
      watch(this._settings, `changed::${key}`);
    this._scheduleScan();
  }

  private _scheduleScan() {
    if (!this._active || this._idleId) return;
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleId = 0;
      this._scan();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _scan() {
    const panel = Main.panel as any;
    const buttons = new Set<any>();
    const wanted = new Map<any, any>();
    // Indicator name per menu, so each glass can be told apart in the log.
    const wantedNames = new Map<any, string>();
    const detected: string[] = [];
    const disabled = new Set(this._settings.get_strv('disabled-extra-menus'));
    const enabled = this._settings.get_boolean('enable-extra-menu-glass');
    const reserved = new Set([panel.statusArea.dateMenu?.menu, panel.statusArea.quickSettings?.menu]);

    for (const [name, button] of Object.entries<any>(panel.statusArea)) {
      if (!button || !panel.contains(button.container ?? button)) continue;
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
      if (enabled && allowed) {
        wanted.set(menu, button);
        wantedNames.set(menu, name);
      }
    }

    for (const [button, ids] of this._buttons) {
      if (buttons.has(button)) continue;
      for (const id of ids) button.disconnect(id);
      this._buttons.delete(button);
    }
    // Keep existing instances: a new indicator must not close another menu.
    for (const [menu, entry] of this._menus) {
      if (wanted.has(menu)) continue;
      this._menus.delete(menu);
      try { entry.manager.cleanup(); } catch (e) { this._logger.log(`[Liquid Glass] Menu cleanup (${entry.name}): ${e}`); }
    }
    for (const [menu, button] of wanted) {
      if (this._menus.has(menu)) continue;
      const name = wantedNames.get(menu) ?? '?';
      let manager: UIManager | null = null;
      try {
        manager = new UIManager(this._path, this._settings, this._logger, button, false,
          'enable-extra-menu-glass', PANEL_MENU_PREFIX, `menu:${name}`);
        manager.setup();
        this._menus.set(menu, { name, manager });
      } catch (e) {
        try { manager?.cleanup(); } catch (_) { /* partial setup */ }
        this._logger.log(`[Liquid Glass] Could not attach panel menu glass to "${name}": ${e}`);
      }
    }
    detected.sort();
    if (JSON.stringify(detected) !== JSON.stringify(this._settings.get_strv('detected-extra-menus')))
      this._settings.set_strv('detected-extra-menus', detected);
  }

  // [FIX] Teardown must not be all-or-nothing — the same guard UIManager,
  // NotificationManager and extension.js already use. These steps used to run
  // bare, so the first one that threw skipped every step after it, leaving
  // this manager's signal handlers and its per-menu UIManagers (each with its
  // own actors and per-frame later chain) alive across disable(). Disabling
  // is exactly when a throw is most likely: the shell is destroying the same
  // indicators we are.
  private _teardownStep(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this._logger?.log(`[Liquid Glass] PanelMenuManager.${name} failed during cleanup: ${e}`);
      } catch (_) {
        console.error(`[Liquid Glass] PanelMenuManager.${name} failed during cleanup: ${e}`);
      }
    }
  }

  cleanup() {
    // Set before anything that can throw, so a scan queued by a signal that
    // fires mid-teardown stops itself even if this method never finishes.
    this._active = false;

    this._teardownStep('idleScan', () => {
      if (this._idleId) GLib.Source.remove(this._idleId);
      this._idleId = 0;
    });

    this._teardownStep('signals', () => {
      for (const { target, id } of this._signals) {
        try { target.disconnect(id); } catch (e) { }
      }
      this._signals = [];
    });

    this._teardownStep('buttonSignals', () => {
      for (const [button, ids] of this._buttons)
        for (const id of ids) {
          try { button.disconnect(id); } catch (e) { }
        }
      this._buttons.clear();
    });

    // One step per menu: a menu that throws must not strand the others.
    for (const { name, manager } of [...this._menus.values()])
      this._teardownStep(`menu(${name})`, () => manager.cleanup());
    this._menus.clear();

    this._teardownStep('detectedList', () => this._settings.set_strv('detected-extra-menus', []));
  }
}
