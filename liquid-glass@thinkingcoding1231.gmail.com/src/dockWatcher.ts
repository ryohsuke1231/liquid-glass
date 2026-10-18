import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DashManager } from './dockManager.js';
import type { IconStyler } from './iconStyle/iconStyler.js';
import type { Logger } from './logger.js';

const SEARCH_DELAY_MS = 2000;
const RESCAN_IDLE_TICKS = 2;
const RESCAN_INTERVAL_MS = 2000;

interface DockEntry {
  container: St.Widget;
  manager: DashManager;
  destroyId: number;
}

/**
 * Finds Dash to Dock's docks and gives each its glass. Dash to Dock may create its dock after we are enabled, and
 * recreates it when monitors change, when it is enabled again and for some of its settings, so it is looked for
 * after a delay and again whenever one may have appeared.
 */
export class DockWatcher {
  private _docks: DockEntry[] = [];
  private _searchId = 0;
  private _rescanId = 0;
  private _monitorsChangedId = 0;
  private _childAddedId = 0;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger, private _icons: IconStyler) {}

  setup(): void {
    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleRescan());
    this._childAddedId = Main.layoutManager.uiGroup.connect('child-added', (_group: Clutter.Actor, child: Clutter.Actor) => {
      if (child.get_name() === 'dashtodockContainer') this._scheduleRescan();
    });
    this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
      this._searchId = 0;
      this._find();
      this._scheduleRescan();
      return GLib.SOURCE_REMOVE;
    });
  }

  cleanup(): void {
    Main.layoutManager.disconnect(this._monitorsChangedId);
    Main.layoutManager.uiGroup.disconnect(this._childAddedId);
    if (this._searchId) GLib.Source.remove(this._searchId);
    this._searchId = 0;
    if (this._rescanId) GLib.Source.remove(this._rescanId);
    this._rescanId = 0;
    for (const entry of this._docks) this._release(entry);
  }

  private _containers(): St.Widget[] {
    const found: St.Widget[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor === global.window_group) return;
      if (actor instanceof St.Widget && actor.get_name() === 'dashtodockDashContainer') {
        found.push(actor);
        return;
      }
      for (const child of actor.get_children()) walk(child);
    };
    walk(Main.layoutManager.uiGroup);
    return found;
  }

  // True when a dock was found that had no glass yet.
  private _find(): boolean {
    let added = 0;
    for (const container of this._containers()) {
      if (this._docks.some(entry => entry.container === container)) continue;
      const manager = new DashManager(this._path, container, this._settings, this._logger);
      manager.setup();
      this._icons.watchDock(container);
      const entry: DockEntry = { container, manager, destroyId: 0 };
      entry.destroyId = container.connect('destroy', () => {
        entry.destroyId = 0;
        this._release(entry);
        this._scheduleRescan();
      });
      this._docks.push(entry);
      added++;
    }
    if (added > 0) this._logger.log(`[Liquid Glass] Dash to Dock containers with glass: ${this._docks.length}`);
    return added > 0;
  }

  private _release(entry: DockEntry): void {
    this._docks = this._docks.filter(e => e !== entry);
    if (entry.destroyId) entry.container.disconnect(entry.destroyId);
    entry.destroyId = 0;
    entry.manager.cleanup();
    this._icons.unwatchDock(entry.container);
  }

  // Keeps looking until RESCAN_IDLE_TICKS scans in a row find nothing new.
  private _scheduleRescan(): void {
    if (this._rescanId) GLib.Source.remove(this._rescanId);
    let idleTicks = 0;
    this._rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
      idleTicks = this._find() ? 0 : idleTicks + 1;
      if (idleTicks < RESCAN_IDLE_TICKS) return GLib.SOURCE_CONTINUE;
      this._rescanId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }
}
