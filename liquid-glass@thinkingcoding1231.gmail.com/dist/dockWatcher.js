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
exports.DockWatcher = void 0;
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://St"));
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const dockManager_js_1 = require("./dockManager.js");
const SEARCH_DELAY_MS = 2000;
const RESCAN_IDLE_TICKS = 2;
const RESCAN_INTERVAL_MS = 2000;
/**
 * Finds Dash to Dock's docks and gives each its glass. Dash to Dock may create its dock after we are enabled, and
 * recreates it when monitors change, when it is enabled again and for some of its settings, so it is looked for
 * after a delay and again whenever one may have appeared.
 */

class DockWatcher {
    _path;
    _settings;
    _logger;
    _icons;
    _docks = [];
    _searchId = 0;
    _rescanId = 0;
    _monitorsChangedId = 0;
    _childAddedId = 0;
    constructor(_path, _settings, _logger, _icons) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._icons = _icons;
    }
    setup() {
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleRescan());
        this._childAddedId = Main.layoutManager.uiGroup.connect('child-added', (_group, child) => {
            if (child.get_name() === 'dashtodockContainer')
                this._scheduleRescan();
        });
        this._searchId = 1.default.timeout_add(1.default.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchId = 0;
            this._find();
            this._scheduleRescan();
            return 1.default.SOURCE_REMOVE;
        });
    }
    cleanup() {
        Main.layoutManager.disconnect(this._monitorsChangedId);
        Main.layoutManager.uiGroup.disconnect(this._childAddedId);
        if (this._searchId)
            1.default.Source.remove(this._searchId);
        this._searchId = 0;
        if (this._rescanId)
            1.default.Source.remove(this._rescanId);
        this._rescanId = 0;
        for (const entry of this._docks)
            this._release(entry);
    }
    _containers() {
        const found = [];
        const walk = (actor) => {
            if (actor === global.window_group)
                return;
            if (actor instanceof 2.default.Widget && actor.get_name() === 'dashtodockDashContainer') {
                found.push(actor);
                return;
            }
            for (const child of actor.get_children())
                walk(child);
        };
        walk(Main.layoutManager.uiGroup);
        return found;
    }
    // True when a dock was found that had no glass yet.
    _find() {
        let added = 0;
        for (const container of this._containers()) {
            if (this._docks.some(entry => entry.container === container))
                continue;
            const manager = new dockManager_js_1.DashManager(this._path, container, this._settings, this._logger);
            manager.setup();
            this._icons.watchDock(container);
            const entry = { container, manager, destroyId: 0 };
            entry.destroyId = container.connect('destroy', () => {
                entry.destroyId = 0;
                this._release(entry);
                this._scheduleRescan();
            });
            this._docks.push(entry);
            added++;
        }
        if (added > 0)
            this._logger.log(`[Liquid Glass] Dash to Dock containers with glass: ${this._docks.length}`);
        return added > 0;
    }
    _release(entry) {
        this._docks = this._docks.filter(e => e !== entry);
        if (entry.destroyId)
            entry.container.disconnect(entry.destroyId);
        entry.destroyId = 0;
        entry.manager.cleanup();
        this._icons.unwatchDock(entry.container);
    }
    // Keeps looking until RESCAN_IDLE_TICKS scans in a row find nothing new.
    _scheduleRescan() {
        if (this._rescanId)
            1.default.Source.remove(this._rescanId);
        let idleTicks = 0;
        this._rescanId = 1.default.timeout_add(1.default.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
            idleTicks = this._find() ? 0 : idleTicks + 1;
            if (idleTicks < RESCAN_IDLE_TICKS)
                return 1.default.SOURCE_CONTINUE;
            this._rescanId = 0;
            return 1.default.SOURCE_REMOVE;
        });
    }
}
exports.DockWatcher = DockWatcher;
