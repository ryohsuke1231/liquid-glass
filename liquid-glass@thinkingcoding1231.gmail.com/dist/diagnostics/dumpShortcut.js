import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { dumpGlassState, flushGlassRing } from './glass.js';
import { diagnosticLog } from './logging.js';
const INTERVAL_MS = 100;
const TICKS = 600;
const KEYBINDING = 'dump-loop-keybinding';
/**
 * An optional shortcut (enable-dump-shortcut, off by default) that writes the state of every glass to the journal
 * for a minute, for bug reports. Pressed again, it stops early.
 */
export class DumpShortcut {
    _settings;
    _settingId = 0;
    _installed = false;
    _loopId = 0;
    constructor(_settings) {
        this._settings = _settings;
    }
    setup() {
        this._settingId = this._settings.connect('changed::enable-dump-shortcut', () => this._sync());
        this._sync();
    }
    cleanup() {
        this._settings.disconnect(this._settingId);
        this._stop();
        if (this._installed)
            Main.wm.removeKeybinding(KEYBINDING);
        this._installed = false;
    }
    _sync() {
        const wanted = this._settings.get_boolean('enable-dump-shortcut');
        if (wanted && !this._installed) {
            Main.wm.addKeybinding(KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
            this._installed = true;
        }
        else if (!wanted && this._installed) {
            Main.wm.removeKeybinding(KEYBINDING);
            this._installed = false;
            this._stop();
        }
    }
    // The accelerator as the user sees it, for the notifications.
    _label() {
        const accel = this._settings.get_strv(KEYBINDING)[0];
        if (!accel)
            return 'the shortcut';
        return accel.replace(/<Control>/gi, 'Ctrl+').replace(/<Alt>/gi, 'Alt+').replace(/<Shift>/gi, 'Shift+')
            .replace(/<Super>/gi, 'Super+').replace(/\+([a-z])$/, (_, k) => `+${k.toUpperCase()}`);
    }
    _stop() {
        if (!this._loopId)
            return false;
        GLib.Source.remove(this._loopId);
        this._loopId = 0;
        return true;
    }
    _toggle() {
        if (this._stop()) {
            Main.notify('Liquid Glass', 'Diagnostic dump stopped');
            return;
        }
        // The ring buffer holds the frames before the key press, which the loop that starts now cannot capture.
        flushGlassRing();
        const seconds = (TICKS * INTERVAL_MS) / 1000;
        const endsAt = new Date(Date.now() + seconds * 1000);
        const hhmmss = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
        // Marks where the capture starts in the journal.
        diagnosticLog(`[Liquid Glass][dump-loop] STARTED ${TICKS} ticks @ ${INTERVAL_MS}ms, ends ${hhmmss(endsAt)}`);
        Main.notify('Liquid Glass', `Diagnostic dump running ${seconds}s — ends at ${hhmmss(endsAt)} (${this._label()} to stop)`);
        let count = 0;
        this._loopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVAL_MS, () => {
            dumpGlassState();
            if (++count < TICKS)
                return GLib.SOURCE_CONTINUE;
            this._loopId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
