// src/windowListService.ts
//
// prefs.js runs in its own process (gnome-extensions-prefs) and therefore has no
// access to Meta/Shell, so it cannot enumerate the user's open windows on its
// own. This service runs inside gnome-shell and publishes that list over D-Bus
// on the object path below, under the bus name gnome-shell already owns
// (org.gnome.Shell), plus a `WindowsChanged` signal so the preferences window
// can keep its picker up to date in real time.
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Logger } from './logger.js';

export const WINDOW_LIST_OBJECT_PATH = '/org/gnome/Shell/Extensions/LiquidGlass';
export const WINDOW_LIST_INTERFACE_NAME = 'org.gnome.Shell.Extensions.LiquidGlass';

// The payload is passed as a JSON string rather than a typed D-Bus structure so
// that adding a field later does not break an older preferences process.
const WINDOW_LIST_IFACE = `
<node>
  <interface name="${WINDOW_LIST_INTERFACE_NAME}">
    <method name="ListWindows">
      <arg type="s" direction="out" name="windows"/>
    </method>
    <signal name="WindowsChanged"/>
  </interface>
</node>`;

interface WindowEntry {
  wmClass: string;
  appName: string;
  iconName: string;
  titles: string[];
  count: number;
  // True when at least one window of this class is a plain toplevel/dialog, i.e.
  // the kind of window the application glass effect can actually be applied to.
  normal: boolean;
}

export class WindowListService {
  private _logger: Logger;
  private _dbusImpl: any = null;
  private _displaySignals: { obj: any, id: number }[] = [];
  // Per-window signal handlers, so a window whose class/title arrives late (very
  // common: X11 clients set WM_CLASS after mapping) still refreshes the picker.
  private _windowSignals: Map<Meta.Window, number[]> = new Map();
  private _emitIdleId: number = 0;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  setup() {
    try {
      this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(WINDOW_LIST_IFACE, this);
      this._dbusImpl.export(Gio.DBus.session, WINDOW_LIST_OBJECT_PATH);
    } catch (e) {
      this._logger.log('[Liquid Glass] Failed to export the window list service: ' + e);
      this._dbusImpl = null;
      return;
    }

    const connectDisplay = (signal: string, callback: (...args: any[]) => void) => {
      try {
        this._displaySignals.push({ obj: global.display, id: global.display.connect(signal as any, callback) });
      } catch (e) { /* signal not present on this mutter — skip */ }
    };

    connectDisplay('window-created', (_display: any, metaWindow: Meta.Window) => {
      this._trackWindow(metaWindow);
      this._queueChanged();
    });
    connectDisplay('restacked', () => this._queueChanged());

    for (const metaWindow of this._listMetaWindows())
      this._trackWindow(metaWindow);

    this._logger.log('[Liquid Glass] WindowListService exported at ' + WINDOW_LIST_OBJECT_PATH);
  }

  cleanup() {
    if (this._emitIdleId) {
      GLib.Source.remove(this._emitIdleId);
      this._emitIdleId = 0;
    }

    for (const sig of this._displaySignals) {
      try { sig.obj.disconnect(sig.id); } catch (e) { }
    }
    this._displaySignals = [];

    for (const [metaWindow, ids] of this._windowSignals) {
      for (const id of ids) {
        try { metaWindow.disconnect(id); } catch (e) { }
      }
    }
    this._windowSignals.clear();

    if (this._dbusImpl) {
      try { this._dbusImpl.unexport(); } catch (e) { }
      this._dbusImpl = null;
    }
  }

  // ── D-Bus method ──────────────────────────────────────────────────────────
  ListWindows(): string {
    try {
      return JSON.stringify(this._collectWindows());
    } catch (e) {
      this._logger.log('[Liquid Glass] ListWindows failed: ' + e);
      return '[]';
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private _trackWindow(metaWindow: Meta.Window) {
    if (!metaWindow || this._windowSignals.has(metaWindow))
      return;

    const ids: number[] = [];
    for (const signal of ['notify::wm-class', 'notify::title', 'notify::window-type']) {
      try {
        ids.push(metaWindow.connect(signal as any, () => this._queueChanged()));
      } catch (e) { /* property not present — skip */ }
    }
    try {
      ids.push(metaWindow.connect('unmanaged', () => {
        this._untrackWindow(metaWindow);
        this._queueChanged();
      }));
    } catch (e) { }

    this._windowSignals.set(metaWindow, ids);
  }

  private _untrackWindow(metaWindow: Meta.Window) {
    const ids = this._windowSignals.get(metaWindow);
    if (!ids)
      return;
    for (const id of ids) {
      try { metaWindow.disconnect(id); } catch (e) { }
    }
    this._windowSignals.delete(metaWindow);
  }

  private _listMetaWindows(): Meta.Window[] {
    try {
      return global.display.list_all_windows() ?? [];
    } catch (e) {
      this._logger.log('[Liquid Glass] list_all_windows() failed: ' + e);
      return [];
    }
  }

  // Collapse the open windows into one entry per WM_CLASS, since that is the
  // granularity the white/blacklists match on.
  private _collectWindows(): WindowEntry[] {
    // Resolved lazily so that a run with no windows never touches the tracker.
    let tracker: Shell.WindowTracker | null | undefined = undefined;
    const getTracker = (): Shell.WindowTracker | null => {
      if (tracker === undefined) {
        try {
          tracker = Shell.WindowTracker.get_default();
        } catch (e) {
          tracker = null;
        }
      }
      return tracker;
    };

    const byClass: Map<string, WindowEntry> = new Map();

    for (const metaWindow of this._listMetaWindows()) {
      let wmClass = '';
      let windowType: Meta.WindowType | null = null;
      let title = '';
      try {
        wmClass = metaWindow.get_wm_class() ?? '';
        windowType = metaWindow.get_window_type();
        title = metaWindow.get_title() ?? '';
      } catch (e) {
        continue;
      }

      if (!wmClass)
        continue;

      // Skip the shell's own override-redirect/utility surfaces; they can never
      // be targeted by the effect and would only clutter the picker.
      if (windowType === Meta.WindowType.DESKTOP ||
        windowType === Meta.WindowType.DOCK ||
        windowType === Meta.WindowType.SPLASHSCREEN)
        continue;

      const isNormal = windowType === Meta.WindowType.NORMAL ||
        windowType === Meta.WindowType.DIALOG ||
        windowType === Meta.WindowType.MODAL_DIALOG;

      let entry = byClass.get(wmClass);
      if (!entry) {
        entry = { wmClass, appName: '', iconName: '', titles: [], count: 0, normal: false };
        byClass.set(wmClass, entry);
      }

      entry.count += 1;
      entry.normal = entry.normal || isNormal;
      if (title && entry.titles.length < 8 && !entry.titles.includes(title))
        entry.titles.push(title);

      const trackerRef = entry.appName ? null : getTracker();
      if (trackerRef) {
        try {
          const app = trackerRef.get_window_app(metaWindow);
          if (app) {
            entry.appName = app.get_name() ?? '';
            const appInfo = app.get_app_info();
            const icon = appInfo?.get_icon();
            // Serialized Gio.Icon: the prefs process turns it back into an icon
            // with Gio.Icon.new_for_string().
            if (icon)
              entry.iconName = icon.to_string() ?? '';
          }
        } catch (e) { /* app may have gone away mid-iteration */ }
      }
    }

    const entries = [...byClass.values()];
    entries.sort((a, b) => (a.appName || a.wmClass).toLowerCase()
      .localeCompare((b.appName || b.wmClass).toLowerCase()));
    return entries;
  }

  // Windows open and close in bursts (and 'restacked' fires constantly), so the
  // signal is coalesced onto an idle rather than emitted per event.
  private _queueChanged() {
    if (this._emitIdleId)
      return;

    this._emitIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._emitIdleId = 0;
      if (this._dbusImpl) {
        try {
          this._dbusImpl.emit_signal('WindowsChanged', null);
        } catch (e) {
          this._logger.log('[Liquid Glass] Failed to emit WindowsChanged: ' + e);
        }
      }
      return GLib.SOURCE_REMOVE;
    });
  }
}
