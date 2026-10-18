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
exports.DesktopLayer = exports.WIDGET_IDS = void 0;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const PopupMenu = __importStar(require("resource:///org/gnome/shell/ui/popupMenu.js"));
const 3 = __importDefault(require("gi://GLib"));
const 4 = __importDefault(require("gi://Meta"));
const 5 = __importDefault(require("gi://St"));
const lifecycle_js_1 = require("../actors/lifecycle.js");
const frameLoops_js_1 = require("../animation/frameLoops.js");
const shellVersion_js_1 = require("../shellVersion.js");
const uiManager_js_1 = require("../uiManager.js");
const editFrame_js_1 = require("./editFrame.js");
const placement_js_1 = require("./placement.js");
const weather_js_1 = require("./weather.js");
const events_js_1 = require("./events.js");
const media_js_1 = require("./media.js");
const clock_js_1 = require("./clock.js");
exports.WIDGET_IDS = ['weather', 'events', 'media'];
const ANCHOR_NAMES = [
    ['top-left', 'Top Left'], ['top-right', 'Top Right'], ['bottom-left', 'Bottom Left'], ['bottom-right', 'Bottom Right'],
    ['center', 'Center'],
];
/**
 * The glass clock and the desktop widgets, above the wallpaper and below
 * every window, so they are hidden with the windows in the overview. Each
 * sits at a corner or the center of the primary monitor's work area, stacked
 * with the others there, unless the user moved it somewhere else. A right
 * click on one opens its menu, from which it can be moved (and the clock
 * resized).
 */

class DesktopLayer {
    _path;
    _settings;
    _logger;
    _openPreferences;
    _container = null;
    _items = new Map();
    _settingsIds = [];
    _signals = [];
    _frameSyncId = 0;
    _frameSignalId = 0;
    _needsLayout = true;
    _layoutLaterId = 0;
    _env;
    _menu = null;
    _menuManager = null;
    _menuGlass = null;
    _edit = null;
    constructor(_path, _settings, _logger, _openPreferences) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._openPreferences = _openPreferences;
        this._env = {
            path: _path, settings: _settings, logger: _logger,
            menu: (item, x, y) => this._openMenu(item, x, y),
            relayout: () => this._queueLayout(),
        };
    }
    setup() {
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        for (const key of ['enable-desktop-widgets', 'desktop-widgets', 'enable-glass-clock'])
            watch(key, () => this._sync());
        for (const key of ['desktop-widgets-position', 'glass-clock-position', 'desktop-item-positions', 'desktop-widget-anchors'])
            watch(key, () => this._queueLayout());
        this._sync();
    }
    _wanted() {
        const ids = [];
        if (this._settings.get_boolean('enable-glass-clock'))
            ids.push('clock');
        if (this._settings.get_boolean('enable-desktop-widgets')) {
            const chosen = new Set(this._settings.get_strv('desktop-widgets'));
            ids.push(...exports.WIDGET_IDS.filter(id => chosen.has(id)));
        }
        return ids;
    }
    _create(id) {
        switch (id) {
            case 'clock': return new clock_js_1.GlassClock(this._env);
            case 'weather': return new weather_js_1.WeatherWidget(this._env);
            case 'events': return new events_js_1.EventsWidget(this._env);
            default: return new media_js_1.MediaWidget(this._env);
        }
    }
    _sync() {
        const wanted = this._wanted();
        for (const [id, item] of this._items) {
            if (wanted.includes(id))
                continue;
            if (this._edit?.item === item)
                this._edit.end();
            item.destroy();
            this._items.delete(id);
        }
        if (wanted.length === 0) {
            this._removeContainer();
            return;
        }
        this._ensureContainer();
        for (const id of wanted) {
            if (this._items.has(id))
                continue;
            const item = this._create(id);
            this._items.set(id, item);
            this._container.add_child(item.actor);
        }
        this._queueLayout();
    }
    _ensureContainer() {
        if (this._container)
            return;
        const container = new 5.default.Widget({ name: 'liquid-glass-desktop', x: 0, y: 0 });
        this._container = container;
        Main.layoutManager._backgroundGroup.add_child(container);
        this._restack();
        const relayout = () => {
            this._edit?.end();
            this._queueLayout();
        };
        this._signals.push({ target: Main.layoutManager, id: Main.layoutManager.connect('monitors-changed', relayout) });
        this._signals.push({ target: global.display, id: global.display.connect('workareas-changed', relayout) });
        this._signals.push({ target: Main.overview, id: Main.overview.connect('showing', () => this._edit?.end()) });
        // Mutter restacks the windows without telling; this runs before every
        // frame is drawn, so the items are back in place before anyone sees them.
        this._signals.push({ target: global.stage, id: global.stage.connect('before-update', () => this._restack()) });
        (0, frameLoops_js_1.startSyncLoop)(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this._container,
            honourFreeze: true,
            errorTag: 'DesktopLayer',
            step: () => this._step(),
        });
        const menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, 5.default.Side.TOP);
        Main.layoutManager.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menu = menu;
        this._menuManager = new PopupMenu.PopupMenuManager(container);
        this._menuManager.addMenu(menu);
        this._menuGlass = new uiManager_js_1.UIManager(this._path, this._settings, this._logger, { menu }, false, 'enable-extra-menu-glass', 'panel-menu', 'menu:desktop', false);
        this._menuGlass.setup();
    }
    _removeContainer() {
        this._edit?.end();
        (0, frameLoops_js_1.stopStageLoop)(this._frameSignalSlot, this._frameSlot);
        (0, frameLoops_js_1.removeBeforeRedraw)(this._layoutLaterId);
        this._layoutLaterId = 0;
        for (const { target, id } of this._signals)
            target.disconnect(id);
        this._signals = [];
        this._menuGlass?.cleanup();
        this._menuGlass = null;
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;
        const container = this._container;
        this._container = null;
        if (container && (0, lifecycle_js_1.isActorValid)(container))
            container.destroy();
    }
    // The topmost window of desktop icons (DING and the like): it covers the
    // whole desktop and would take every click meant for the items. DING hides
    // its window from global.get_window_actors(), hence the window group.
    _desktopWindow() {
        let top = null;
        for (const actor of global.window_group.get_children()) {
            if (!(actor instanceof 4.default.WindowActor))
                continue;
            const window = actor.get_meta_window();
            if (window && (window.customJS_ding || window.get_window_type() === 4.default.WindowType.DESKTOP))
                top = actor;
        }
        return top;
    }
    // Right above the desktop icons' window when there is one, so the items
    // get the pointer; otherwise on top of the wallpaper.
    _restack() {
        const container = this._container;
        if (!container)
            return;
        const icons = this._desktopWindow();
        const parent = icons ? global.window_group : Main.layoutManager._backgroundGroup;
        if (container.get_parent() !== parent) {
            container.get_parent()?.remove_child(container);
            parent.add_child(container);
        }
        if (icons) {
            if (container.get_previous_sibling() !== icons)
                parent.set_child_above_sibling(container, icons);
        }
        else if (container.get_next_sibling()) {
            parent.set_child_above_sibling(container, null);
        }
    }
    // Lays the items out before the next frame, and makes sure there is one.
    _queueLayout() {
        this._needsLayout = true;
        if (this._layoutLaterId || !this._container)
            return;
        this._layoutLaterId = (0, frameLoops_js_1.addBeforeRedraw)(() => {
            this._layoutLaterId = 0;
            if (this._container)
                this._step();
            return 3.default.SOURCE_REMOVE;
        });
    }
    _step() {
        for (const item of this._items.values()) {
            if (item.sync())
                this._needsLayout = true;
        }
        if (this._needsLayout) {
            this._needsLayout = false;
            this._layout();
        }
        this._edit?.sync();
    }
    _workArea() {
        return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    }
    _anchorOf(id) {
        if (id === 'clock')
            return (0, placement_js_1.sanitizeAnchor)(this._settings.get_string('glass-clock-position'), 'center');
        return (0, placement_js_1.parseAnchors)(this._settings.get_string('desktop-widget-anchors'))[id] ??
            (0, placement_js_1.sanitizeAnchor)(this._settings.get_string('desktop-widgets-position'));
    }
    // Places every item: where it was moved to, or stacked at its anchor.
    _layout() {
        const area = this._workArea();
        const moved = (0, placement_js_1.parsePositions)(this._settings.get_string('desktop-item-positions'));
        const stacks = new Map();
        const movedItems = [];
        for (const [id, item] of this._items) {
            // The frame holds the item while it is being dragged.
            if (this._edit?.dragging && this._edit.item === item)
                continue;
            const fraction = moved[id];
            // A hidden item still counts for which of the others sit in its column.
            if (fraction) {
                const [w, h] = item.size();
                const [x, y] = (0, placement_js_1.placeAtFraction)([fraction[0], fraction[1]], area, [w, fraction[2] ?? h]);
                movedItems.push({ item, saved: { x, y, width: w, height: fraction[2] ?? h }, size: [w, h], shown: item.shown });
                continue;
            }
            if (!item.shown)
                continue;
            const anchor = this._anchorOf(id);
            if (!stacks.has(anchor))
                stacks.set(anchor, []);
            stacks.get(anchor).push(item);
        }
        const positions = (0, placement_js_1.stackColumns)(movedItems, area);
        movedItems.forEach(({ item, shown }, i) => {
            if (shown)
                item.actor.set_position(...positions[i]);
        });
        for (const [anchor, items] of stacks) {
            const stacked = (0, placement_js_1.stackAt)(anchor, area, items.map(item => item.size()));
            items.forEach((item, i) => item.actor.set_position(...stacked[i]));
        }
    }
    _savePosition(item, pos, size) {
        const positions = (0, placement_js_1.parsePositions)(this._settings.get_string('desktop-item-positions'));
        positions[item.id] = [...(0, placement_js_1.fractionOf)(pos, this._workArea(), size), size[1]];
        this._settings.set_string('desktop-item-positions', JSON.stringify(positions));
    }
    _resetPosition(id) {
        const positions = (0, placement_js_1.parsePositions)(this._settings.get_string('desktop-item-positions'));
        delete positions[id];
        this._settings.set_string('desktop-item-positions', JSON.stringify(positions));
    }
    // Puts an item back in the stack at `anchor`. A widget alone gets its own
    // anchor; the others keep the one they share.
    _placeAt(id, anchor) {
        if (id === 'clock') {
            this._settings.set_string('glass-clock-position', anchor);
        }
        else {
            const anchors = (0, placement_js_1.parseAnchors)(this._settings.get_string('desktop-widget-anchors'));
            anchors[id] = anchor;
            this._settings.set_string('desktop-widget-anchors', JSON.stringify(anchors));
        }
        this._resetPosition(id);
    }
    _openMenu(item, x, y) {
        const menu = this._menu;
        if (!menu || this._edit)
            return;
        menu.removeAll();
        const clock = item instanceof clock_js_1.GlassClock ? item : null;
        menu.addAction(clock ? 'Move and Resize' : 'Move', () => this._startEdit(item));
        if (clock?.resized)
            menu.addAction('Reset Size', () => clock.resetSize());
        const moved = item.id in (0, placement_js_1.parsePositions)(this._settings.get_string('desktop-item-positions'));
        const position = new PopupMenu.PopupSubMenuMenuItem('Position', false);
        const current = this._anchorOf(item.id);
        for (const [anchor, name] of ANCHOR_NAMES) {
            const entry = position.menu.addAction(name, () => this._placeAt(item.id, anchor));
            entry.setOrnament(!moved && anchor === current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        }
        menu.addMenuItem(position);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Desktop Settings', () => this._openPreferences());
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        menu.open(shellVersion_js_1.MENU_ANIMATION);
    }
    _startEdit(item) {
        if (this._edit || !this._items.has(item.id))
            return;
        const clock = item instanceof clock_js_1.GlassClock ? item : null;
        const edit = new editFrame_js_1.EditFrame(item, {
            moved: (x, y) => this._savePosition(item, [x, y], item.size()),
            resized: clock ? (from, to) => this._resized(clock, from, to) : undefined,
            others: () => [...this._items.values()].filter(other => other !== item && other.shown).map(editFrame_js_1.itemRect),
            ended: () => {
                if (this._edit === edit)
                    this._edit = null;
            },
        });
        this._edit = edit;
        edit.start();
    }
    // Keeps the clock's center where the resized frame's is, as far as the
    // frame and the clock's shown part differ.
    _resized(clock, from, to) {
        const sx = to.width / from.width;
        const sy = to.height / from.height;
        const [w, h] = clock.size();
        const [bx, by, bw, bh] = clock.bounds();
        const size = [w * sx, h * sy];
        const center = [to.x + to.width / 2 + (w / 2 - bx - bw / 2) * sx, to.y + to.height / 2 + (h / 2 - by - bh / 2) * sy];
        this._savePosition(clock, [center[0] - size[0] / 2, center[1] - size[1] / 2], size);
        clock.resizeBy(sx, sy);
    }
    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._edit?.end();
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._removeContainer();
    }
    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }
    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
exports.DesktopLayer = DesktopLayer;
