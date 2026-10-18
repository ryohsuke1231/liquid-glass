"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DumpShortcut = void 0;
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://Meta"));
const 3 = __importDefault(require("gi://Shell"));
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const glass_js_1 = require("./glass.js");
const logging_js_1 = require("./logging.js");
const INTERVAL_MS = 100;
const TICKS = 600;
const KEYBINDING = 'dump-loop-keybinding';
/**
 * An optional shortcut (enable-dump-shortcut, off by default) that writes the state of every glass to the journal
 * for a minute, for bug reports. Pressed again, it stops early.
 */

class DumpShortcut {
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
            Main.wm.addKeybinding(KEYBINDING, this._settings, 2.default.KeyBindingFlags.NONE, 3.default.ActionMode.NORMAL | 3.default.ActionMode.OVERVIEW, () => this._toggle());
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
        1.default.Source.remove(this._loopId);
        this._loopId = 0;
        return true;
    }
    _toggle() {
        if (this._stop()) {
            Main.notify('Liquid Glass', 'Diagnostic dump stopped');
            return;
        }
        // The ring buffer holds the frames before the key press, which the loop that starts now cannot capture.
        (0, glass_js_1.flushGlassRing)();
        const seconds = (TICKS * INTERVAL_MS) / 1000;
        const endsAt = new Date(Date.now() + seconds * 1000);
        const hhmmss = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
        // Marks where the capture starts in the journal.
        (0, logging_js_1.diagnosticLog)(`[Liquid Glass][dump-loop] STARTED ${TICKS} ticks @ ${INTERVAL_MS}ms, ends ${hhmmss(endsAt)}`);
        Main.notify('Liquid Glass', `Diagnostic dump running ${seconds}s — ends at ${hhmmss(endsAt)} (${this._label()} to stop)`);
        let count = 0;
        this._loopId = 1.default.timeout_add(1.default.PRIORITY_DEFAULT, INTERVAL_MS, () => {
            (0, glass_js_1.dumpGlassState)();
            if (++count < TICKS)
                return 1.default.SOURCE_CONTINUE;
            this._loopId = 0;
            return 1.default.SOURCE_REMOVE;
        });
    }
}
exports.DumpShortcut = DumpShortcut;
