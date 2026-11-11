import type Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isActorValid } from './actors.js';

// The quick settings button's icons, by the names of the shell's fields that hold them (`_network`, `_system`…).
const NAMES = [
  'remoteAccess', 'camera', 'volumeInput', 'location', 'brightness', 'thunderbolt', 'nightLight', 'network',
  'darkMode', 'doNotDisturb', 'backlight', 'bluetooth', 'rfkill', 'autoRotate', 'volumeOutput', 'unsafeMode',
  'powerProfiles', 'system',
];
// Stands for every icon that is none of them: those other extensions put on the button.
const OTHERS = 'others';

/** Hides the icons on the quick settings button that the settings leave out. The menu keeps their entries. */
export class QuickSettingsIndicators {
  // Each hidden icon, with the handler that hides it again.
  private _hidden = new Map<Clutter.Actor, number>();
  private _button: any = Main.panel.statusArea.quickSettings;
  private _box: Clutter.Actor = this._button._indicators;
  private _boxIds: number[] = [];
  private _settingsId = 0;

  constructor(private _settings: Gio.Settings) {}

  setup(): void {
    // The shell adds the network and bluetooth icons late, and extensions add theirs as they start.
    this._boxIds = [
      this._box.connect('child-added', () => this._apply()),
      this._box.connect('child-removed', (_box: Clutter.Actor, icon: Clutter.Actor) => this._release(icon)),
    ];
    this._settingsId = this._settings.connect('changed::quick-settings-hidden-indicators', () => this._apply());
    this._apply();
  }

  private _apply(): void {
    const leftOut = this._settings.get_strv('quick-settings-hidden-indicators');
    for (const icon of this._box.get_children()) {
      const name = NAMES.find(field => this._button[`_${field}`] === icon) ?? OTHERS;
      if (leftOut.includes(name)) this._hide(icon);
      else this._release(icon);
    }
  }

  private _hide(icon: Clutter.Actor): void {
    if (this._hidden.has(icon)) return;
    // Its owner shows it again whenever its state changes.
    this._hidden.set(icon, icon.connect('notify::visible', () => {
      if (icon.visible) icon.hide();
    }));
    icon.hide();
  }

  // Hands the icon back to its owner, shown if it has something to show.
  private _release(icon: Clutter.Actor): void {
    const id = this._hidden.get(icon);
    if (id === undefined) return;
    this._hidden.delete(icon);
    if (!isActorValid(icon)) return;
    icon.disconnect(id);
    // What the shell's SystemIndicator shows itself by. An icon without parts of its own is plainly shown.
    const parts = icon.get_children();
    icon.visible = parts.length === 0 || parts.some(part => part.visible);
  }

  cleanup(): void {
    this._settings.disconnect(this._settingsId);
    // The shell destroys the button on shutdown without disabling extensions.
    if (isActorValid(this._box))
      for (const id of this._boxIds) this._box.disconnect(id);
    this._boxIds = [];
    for (const icon of [...this._hidden.keys()]) this._release(icon);
  }
}
