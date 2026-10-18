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
exports.BlurMyShellWatch = void 0;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const extensionUtils_js_1 = require("resource:///org/gnome/shell/misc/extensionUtils.js");
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://Gio"));
const UUID = 'blur-my-shell@aunetx';
const POPUP_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.popup';
// The typings still call this state by its pre-46 name, ENABLED.
const ACTIVE = extensionUtils_js_1.ExtensionState.ACTIVE;
// Blur my Shell's settings for popups, from its own schemas the way its
// getSettings() finds them, or null for a version without popup blur.

function popupSettings(extensionPath) {
    const defaultSource = 2.default.SettingsSchemaSource.get_default();
    const dir = 1.default.build_filenamev([extensionPath, 'schemas']);
    let source = defaultSource;
    if (1.default.file_test(1.default.build_filenamev([dir, 'gschemas.compiled']), 1.default.FileTest.EXISTS)) {
        // Loading a compiled schema file throws a GError when it is unreadable.
        try {
            source = 2.default.SettingsSchemaSource.new_from_directory(dir, defaultSource, false);
        }
        catch {
            return null;
        }
    }
    const schema = source?.lookup(POPUP_SCHEMA, true);
    return schema ? new 2.default.Settings({ settings_schema: schema }) : null;
}
/**
 * Blur my Shell 74 blurs popup menus, notifications and OSDs by
 * default and repaints their backgrounds, which then show through the glass.
 * Publishes whether that is on for the preferences window and logs it.
 */

class BlurMyShellWatch {
    _settings;
    _logger;
    _stateId = 0;
    _popup = null;
    _popupId = 0;
    _blurring = null;
    constructor(_settings, _logger) {
        this._settings = _settings;
        this._logger = _logger;
    }
    setup() {
        this._stateId = Main.extensionManager.connect('extension-state-changed', (_manager, extension) => {
            if (extension.uuid === UUID)
                this._sync();
        });
        this._sync();
    }
    _sync() {
        const extension = Main.extensionManager.lookup(UUID);
        const path = extension?.state === ACTIVE ? extension.path : null;
        if (path && !this._popup) {
            this._popup = popupSettings(path);
            if (this._popup)
                this._popupId = this._popup.connect('changed::blur', () => this._update());
        }
        else if (!path) {
            this._dropPopup();
        }
        this._update();
    }
    _update() {
        const blurring = this._popup?.get_boolean('blur') ?? false;
        if (blurring === this._blurring)
            return;
        this._blurring = blurring;
        if (blurring !== this._settings.get_boolean('blur-my-shell-popup-blur'))
            this._settings.set_boolean('blur-my-shell-popup-blur', blurring);
        if (blurring) {
            this._logger.warn('[Liquid Glass] Blur my Shell is blurring popups, which shows through the glass on menus, '
                + 'notifications and OSDs. Turn off Popups in Blur my Shell.');
        }
    }
    _dropPopup() {
        if (this._popupId)
            this._popup.disconnect(this._popupId);
        this._popupId = 0;
        this._popup = null;
    }
    cleanup() {
        Main.extensionManager.disconnect(this._stateId);
        this._stateId = 0;
        this._dropPopup();
        this._settings.set_boolean('blur-my-shell-popup-blur', false);
    }
}
exports.BlurMyShellWatch = BlurMyShellWatch;
