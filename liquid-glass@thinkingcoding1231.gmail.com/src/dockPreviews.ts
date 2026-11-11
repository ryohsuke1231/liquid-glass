import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import type Gio from 'gi://Gio';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isActorValid } from './actors.js';
import { dashOf } from './dockLabels.js';
import type { Logger } from './logger.js';

const DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com';
const KEY = 'dock-window-previews';
// How often the pointer is looked at while it is on a dock or a preview is up (ms).
const POLL_MS = 50;
// How long the pointer rests before a preview opens, moves to another app, or closes (ms).
const OPEN_MS = 250;
const SWITCH_MS = 80;
const CLOSE_MS = 300;

// The Dash to Dock app icon `actor` is in, or null.
function appIconOf(actor: Clutter.Actor | null): any {
  for (let a: any = actor; a; a = a.get_parent()) {
    if (a.get_name() === 'dashtodockDashContainer') return null;
    if (a.app && typeof a.getInterestingWindows === 'function' && typeof a.shouldShowTooltip === 'function') return a;
  }
  return null;
}

/**
 * Hovering an app on a Dash to Dock dock opens its window previews in place of its name. They are Dash to Dock's
 * own preview menu, opened without a grab or keyboard focus, so the pointer can move on along the dock and the
 * focused window keeps the keyboard. Being a popup menu of the dock, it gets glass as the dock's other menus do.
 */
export class DockPreviews {
  private _menuClass: any = null;
  private _menus = new Map<any, any>();
  // The app icons whose shouldShowTooltip() is replaced, with their destroy handlers.
  private _patched = new Map<any, number>();
  private _open: any = null;
  // The app whose previews are about to be shown (null: closed), and since when.
  private _pending: any;
  private _pendingSince = 0;
  // The app that was clicked, whose previews stay away until the pointer leaves it.
  private _suppressed: any = null;
  // Whether the menu class was asked for.
  private _loading = false;
  private _pollId = 0;
  private _eventId = 0;
  private _settingsId = 0;

  constructor(private _settings: Gio.Settings, private _logger: Logger) {}

  setup(): void {
    this._eventId = global.stage.connect('captured-event', (_stage, event: Clutter.Event) => this._onEvent(event));
    this._settingsId = this._settings.connect(`changed::${KEY}`, () => {
      if (!this._enabled) this._close();
    });
  }

  private get _enabled(): boolean {
    return this._menuClass !== null && this._settings.get_boolean(KEY);
  }

  // Dash to Dock's preview menu, from the very module it runs, which keeps its settings and dock position. Loaded
  // when the pointer first comes onto a dock: Dash to Dock may start after this extension.
  private async _loadMenuClass(): Promise<void> {
    const path = Main.extensionManager.lookup(DASH_TO_DOCK)?.path;
    if (!path) return;
    this._loading = true;
    try {
      const module = await import(GLib.filename_to_uri(GLib.build_filenamev([path, 'windowPreview.js']), null));
      // Still set up, after the wait.
      if (this._eventId) this._menuClass = module.WindowPreviewMenu ?? null;
    } catch (e) {
      this._logger.error(`[Liquid Glass] Dash to Dock's window previews could not be loaded: ${e}`);
    }
  }

  private _onEvent(event: Clutter.Event): boolean {
    if (!this._settings.get_boolean(KEY)) return Clutter.EVENT_PROPAGATE;
    const type = event.type();
    const press = type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN;
    if (!press && type !== Clutter.EventType.MOTION && type !== Clutter.EventType.ENTER) return Clutter.EVENT_PROPAGATE;
    const actor = global.stage.get_event_actor(event);
    const dash = dashOf(actor);
    if (!dash && !this._open) return Clutter.EVENT_PROPAGATE;
    if (!this._menuClass) {
      if (!this._loading) this._loadMenuClass();
      return Clutter.EVENT_PROPAGATE;
    }
    const icon = dash ? appIconOf(actor) : null;
    if (icon) this._patchTooltip(icon);
    // A click on an app does what Dash to Dock does with it, and its preview stays away until the pointer leaves.
    if (icon && press) {
      this._suppressed = icon;
      this._close();
    }
    this._startPolling();
    return Clutter.EVENT_PROPAGATE;
  }

  // The app's name gives way to its previews while it has windows.
  private _patchTooltip(icon: any): void {
    if (this._patched.has(icon)) return;
    this._patched.set(icon, icon.connect('destroy', () => this._patched.delete(icon)));
    icon.shouldShowTooltip = () => Object.getPrototypeOf(icon).shouldShowTooltip.call(icon) &&
      !(this._enabled && this._suppressed !== icon && icon.getInterestingWindows().length > 0);
  }

  private _startPolling(): void {
    if (this._pollId) return;
    this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
      if (this._poll()) return GLib.SOURCE_CONTINUE;
      this._pollId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }

  // Decides which app's previews should be up for where the pointer is, and changes to it once the pointer has
  // rested there long enough. True while it should keep looking.
  private _poll(): boolean {
    if (!this._enabled) {
      this._close();
      return false;
    }
    const [x, y] = global.get_pointer();
    const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    const dash = dashOf(actor);
    const icon = dash ? appIconOf(actor) : null;
    if (this._suppressed && icon !== this._suppressed) this._suppressed = null;
    const openMenu = this._open ? this._menus.get(this._open) : null;
    const inMenu = openMenu && isActorValid(openMenu.actor) && openMenu.actor.contains(actor);

    let target = null;
    // Another menu, the overview or a dialog has the screen: the previews stay out of their way.
    const free = Main.modalCount === 0;
    if (free && icon && icon !== this._suppressed && icon.mapped && icon.getInterestingWindows().length > 0)
      target = icon;
    else if (free && this._open && (inMenu || (dash && !icon) || icon === this._open))
      target = this._open;

    const now = GLib.get_monotonic_time();
    if (target === this._open) {
      this._pending = undefined;
    } else if (target !== this._pending) {
      this._pending = target;
      this._pendingSince = now;
    } else {
      const delay = !target ? CLOSE_MS : this._open ? SWITCH_MS : OPEN_MS;
      if ((now - this._pendingSince) / 1000 >= delay) {
        this._pending = undefined;
        if (target) this._show(target);
        else this._close();
      }
    }
    return Boolean(dash || this._open || this._pending !== undefined);
  }

  private _menuFor(icon: any): any {
    let menu = this._menus.get(icon);
    if (menu && isActorValid(menu.actor)) return menu;
    menu = new this._menuClass(icon);
    // Nothing to hold on to: no grab is taken.
    menu.blockSourceEvents = false;
    menu.connect('open-state-changed', (_menu: unknown, open: boolean) => {
      if (!open && this._open === icon) this._closed(icon);
    });
    menu.connect('destroy', () => {
      if (this._menus.get(icon) === menu) this._menus.delete(icon);
      if (this._open === icon) this._closed(icon);
    });
    this._menus.set(icon, menu);
    return menu;
  }

  private _show(icon: any): void {
    this._close();
    const menu = this._menuFor(icon);
    // What WindowPreviewMenu.popup() does, short of taking the keyboard focus.
    menu._redisplay();
    this._open = icon;
    // Keeps a dock that hides by itself shown, and the app's name hidden, as for its other menus.
    icon.emit('menu-state-changed', true);
    menu.open(BoxPointer.PopupAnimation.FULL);
  }

  private _close(): void {
    const icon = this._open;
    if (!icon) return;
    const menu = this._menus.get(icon);
    this._closed(icon);
    if (menu?.isOpen) menu.close(BoxPointer.PopupAnimation.FULL);
  }

  private _closed(icon: any): void {
    if (this._open !== icon) return;
    this._open = null;
    if (isActorValid(icon)) icon.emit('menu-state-changed', false);
  }

  cleanup(): void {
    if (this._pollId) GLib.Source.remove(this._pollId);
    this._pollId = 0;
    global.stage.disconnect(this._eventId);
    this._eventId = 0;
    this._settings.disconnect(this._settingsId);
    this._close();
    for (const menu of [...this._menus.values()]) menu.destroy();
    this._menus.clear();
    for (const [icon, destroyId] of this._patched) {
      icon.disconnect(destroyId);
      delete icon.shouldShowTooltip;
    }
    this._patched.clear();
    this._menuClass = null;
    this._loading = false;
  }
}
