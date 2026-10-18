// The preferences process cannot use Meta or Shell, so this service publishes
// the list of open windows over D-Bus (on the shell's own bus name) for the
// window picker, with a WindowsChanged signal to keep it current.
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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

function readWindow(metaWindow) {
    const wmClass = metaWindow.get_wm_class() ?? '';
    const windowType = metaWindow.get_window_type();
    const title = metaWindow.get_title() ?? '';
    // Desktop, dock and splash surfaces cannot get the effect.
    if (!wmClass || windowType === Meta.WindowType.DESKTOP ||
        windowType === Meta.WindowType.DOCK || windowType === Meta.WindowType.SPLASHSCREEN)
        return null;
    const normal = windowType === Meta.WindowType.NORMAL ||
        windowType === Meta.WindowType.DIALOG || windowType === Meta.WindowType.MODAL_DIALOG;
    return { wmClass, title, normal };
}

function readApplication(entry, metaWindow, tracker) {
    const app = tracker.get_window_app(metaWindow);
    if (!app)
        return;
    entry.appName = app.get_name() ?? '';
    // Serialized; the preferences turn it back into an icon with
    // Gio.Icon.new_for_string().
    const icon = app.get_app_info()?.get_icon();
    if (icon)
        entry.iconName = icon.to_string() ?? '';
}

export class WindowListService {
    _logger;
    _dbusImpl = null;
    _displaySignals = [];
    // A window's class and title can arrive after it is created.
    _windowSignals = new Map();
    _emitIdleId = 0;

    constructor(logger) {
        this._logger = logger;
    }

    setup() {
        // Exporting fails with a GError if the path is already taken.
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(WINDOW_LIST_IFACE, this);
            this._dbusImpl.export(Gio.DBus.session, WINDOW_LIST_OBJECT_PATH);
        }
        catch (e) {
            this._logger.log('[Liquid Glass] Failed to export the window list service: ' + e);
            this._dbusImpl = null;
            return;
        }
        const connectDisplay = (signal, callback) => {
            this._displaySignals.push({ obj: global.display, id: global.display.connect(signal, callback) });
        };
        connectDisplay('window-created', (_display, metaWindow) => {
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
        for (const sig of this._displaySignals)
            sig.obj.disconnect(sig.id);
        this._displaySignals = [];
        for (const [metaWindow, ids] of this._windowSignals) {
            for (const id of ids)
                metaWindow.disconnect(id);
        }
        this._windowSignals.clear();
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }

    // D-Bus method.
    ListWindows() {
        return JSON.stringify(this._collectWindows());
    }

    _trackWindow(metaWindow) {
        if (this._windowSignals.has(metaWindow))
            return;
        const ids = [];
        for (const signal of ['notify::wm-class', 'notify::title', 'notify::window-type'])
            ids.push(metaWindow.connect(signal, () => this._queueChanged()));
        ids.push(metaWindow.connect('unmanaged', () => {
            this._untrackWindow(metaWindow);
            this._queueChanged();
        }));
        this._windowSignals.set(metaWindow, ids);
    }

    _untrackWindow(metaWindow) {
        const ids = this._windowSignals.get(metaWindow);
        if (!ids)
            return;
        for (const id of ids)
            metaWindow.disconnect(id);
        this._windowSignals.delete(metaWindow);
    }

    _listMetaWindows() {
        return global.display.list_all_windows();
    }

    // One entry per WM_CLASS, the granularity the window lists match on.
    _collectWindows() {
        const tracker = Shell.WindowTracker.get_default();
        const byClass = new Map();
        for (const metaWindow of this._listMetaWindows()) {
            const window = readWindow(metaWindow);
            if (!window)
                continue;
            const { wmClass, title, normal } = window;
            let entry = byClass.get(wmClass);
            if (!entry) {
                entry = { wmClass, appName: '', iconName: '', titles: [], count: 0, normal: false };
                byClass.set(wmClass, entry);
            }
            entry.count += 1;
            entry.normal = entry.normal || normal;
            if (title && entry.titles.length < 8 && !entry.titles.includes(title))
                entry.titles.push(title);
            if (!entry.appName)
                readApplication(entry, metaWindow, tracker);
        }
        const entries = [...byClass.values()];
        entries.sort((a, b) => (a.appName || a.wmClass).toLowerCase()
            .localeCompare((b.appName || b.wmClass).toLowerCase()));
        return entries;
    }

    // Windows open and close in bursts and 'restacked' fires often, so the
    // signal is coalesced onto an idle.
    _queueChanged() {
        if (this._emitIdleId)
            return;
        this._emitIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._emitIdleId = 0;
            this._dbusImpl?.emit_signal('WindowsChanged', null);
            return GLib.SOURCE_REMOVE;
        });
    }
}
