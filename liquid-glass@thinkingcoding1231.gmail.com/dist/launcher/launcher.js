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
exports.Launcher = void 0;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const SystemActions = __importStar(require("resource:///org/gnome/shell/misc/systemActions.js"));
const 4 = __importDefault(require("gi://Clutter"));
const 5 = __importDefault(require("gi://Gio"));
const 6 = __importDefault(require("gi://GLib"));
const 7 = __importDefault(require("gi://Meta"));
const 8 = __importDefault(require("gi://Pango"));
const 9 = __importDefault(require("gi://Shell"));
const 10 = __importDefault(require("gi://St"));
const backdropGlass_js_1 = require("../rendering/backdropGlass.js");
const contentLens_js_1 = require("../rendering/contentLens.js");
const allocation_js_1 = require("../actors/allocation.js");
const lifecycle_js_1 = require("../actors/lifecycle.js");
const frameLoops_js_1 = require("../animation/frameLoops.js");
const colors_js_1 = require("../animation/colors.js");
const tween_js_1 = require("../animation/tween.js");
const spring_js_1 = require("../animation/spring.js");
const adaptiveText_js_1 = require("../adaptiveText.js");
const contrastSampler_js_1 = require("../contrastSampler.js");
const shellVersion_js_1 = require("../shellVersion.js");
const calculator_js_1 = require("./calculator.js");
const pins_js_1 = require("./pins.js");
const pinnedGrid_js_1 = require("./pinnedGrid.js");
const software_js_1 = require("./software.js");
// The pinned items' page is this much wider than the search.
const PINNED_EXTRA_WIDTH = 80;
// The least room left at either side of the panel.
const SIDE_MARGIN = 16;
// The search field's top, as a fraction of the monitor's height.
const TOP = 0.2;
const MAX_RESULTS = 8;
const PER_PROVIDER = 5;
const ICON_SIZE = 32;
const SEARCH_DELAY_MS = 120;
// How long the previous results stay up while slow providers are still answering.
const SETTLE_MS = 400;
const SHADER_PADDING = 20;
const SHADOW_MARGIN = 60;
const FADE_MS = 150;
// The glass opens from this much larger, like SwiftUI's materialize.
const OPEN_SCALE = 1.06;
const SHAPE_MS = 220;
// Frames asked for past the glass's tween, and after the panel changes size.
const TICK_MS = 50;
const HINT_OPACITY = 178;
// The pinned page's content scrolls past this share of the monitor's height.
const PINNED_MAX_HEIGHT = 0.7;
const GRID_SPACING = 8;
const PIN_ICON_SIZE = 16;
// What a tile's pin takes at each side of its icon: the pin, its padding and the tile's padding in stylesheet.css.
const TILE_SIDE_ROOM = PIN_ICON_SIZE + 4 + 8;
// Changing page: the old content goes over SWITCH_OUT_MS, then the new comes over SWITCH_IN_MS.
const SWITCH_OUT_MS = 110;
const SWITCH_IN_MS = 280;
// Results that change from one search to the next have nothing worth keeping.
const UNPINNABLE = new Set(['org.gnome.Calculator.desktop']);
// The panel's padding in stylesheet.css.
const PANEL_PADDING = 10;
// The search field's height, to place the panel before it has been laid out, and the least room for results.
const ENTRY_HEIGHT = 56;
// Between the field and the results: .lg-launcher-page in stylesheet.css.
const PAGE_SPACING = 6;
const MIN_RESULTS_HEIGHT = 240;

function isCancelled(e) {
    return e instanceof 6.default.Error && e.matches(5.default.IOErrorEnum, 5.default.IOErrorEnum.CANCELLED);
}
/**
 * A search field on glass in the middle of the screen, like Spotlight, that
 * opens with a shortcut and asks the same search providers as the overview
 * (applications, settings, files, the calculator and whatever else is
 * installed and enabled in Settings).
 */

class Launcher {
    _path;
    _settings;
    _logger;
    _icons;
    // The open launcher, for the test driver.
    static instance = null;
    _settingsIds = [];
    // The look's watchers, while the launcher is open.
    _materialIds = [];
    _keybinding = false;
    _root = null;
    _panel = null;
    _entry = null;
    _list = null;
    _resultsBox = null;
    _searchBox = null;
    _pinnedBox = null;
    _view = 'search';
    _switch = null;
    _lens = null;
    // The glass's spring while it morphs between pages; the tween the rest of the time.
    _spring = null;
    _pins;
    _refreshId = 0;
    _glass = null;
    _grab = null;
    _shape = new tween_js_1.RectTween(SHAPE_MS);
    _shapeStarted = false;
    _ticker = null;
    _frameSyncId = 0;
    _frameSignalId = 0;
    _searchId = 0;
    _cancellable = null;
    // The running search's results so far, the providers it still waits for, and its deadline.
    _found = [];
    _waiting = 0;
    _settleId = 0;
    _results = [];
    _items = [];
    // Of _items on the pinned page, how many are application tiles before the list, and in how many columns.
    _tileCount = 0;
    _columns = 1;
    _selected = 0;
    _terms = [];
    _text;
    // The panel's top and height its text color was last chosen for.
    _coloredFor = '';
    constructor(_path, _settings, _logger, _icons) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._icons = _icons;
        // One color for the field and the results, set on the panel. Rows that come in take it at once, and the
        // color for the panel's new size is chosen as they come, while the glass is still growing to it.
        this._text = new adaptiveText_js_1.AdaptiveTextColor(() => (this._panel ? [this._panel] : []), () => (this._glass ? [this._glass] : []), _logger, 'launcher', { ownColor: true, held: () => this._shapeRemaining(6.default.get_monotonic_time()) > 0 });
        this._pins = new pins_js_1.PinStore(_settings);
    }
    setup() {
        Launcher.instance = this;
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        watch('enable-launcher', () => this._syncKeybinding());
        this._syncKeybinding();
    }
    _syncKeybinding() {
        const wanted = this._settings.get_boolean('enable-launcher');
        if (wanted && !this._keybinding) {
            Main.wm.addKeybinding('launcher-shortcut', this._settings, 7.default.KeyBindingFlags.NONE, 9.default.ActionMode.NORMAL | 9.default.ActionMode.OVERVIEW, () => this.toggle());
            this._keybinding = true;
        }
        else if (!wanted && this._keybinding) {
            Main.wm.removeKeybinding('launcher-shortcut');
            this._keybinding = false;
            this.close();
        }
    }
    toggle() {
        if (this._root)
            this.close();
        else
            this.open();
    }
    open() {
        if (this._root)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const root = new 10.default.Widget({
            name: 'liquid-glass-launcher', reactive: true,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, opacity: 0
        });
        const glass = new backdropGlass_js_1.BackdropGlass({
            extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'launcher',
        });
        glass.setPadding(SHADER_PADDING);
        glass.setIsDock(false);
        glass.setShadowMaxRadius(SHADOW_MARGIN - 10);
        root.add_child(glass);
        const width = this._panelWidth(false, monitor.width);
        const panel = new 10.default.BoxLayout({
            style_class: 'liquid-glass-launcher', reactive: true, can_focus: true, width,
            x: Math.round((monitor.width - width) / 2), y: this._panelTop(monitor.height), ...(0, shellVersion_js_1.verticalBoxParams)()
        });
        // Keys on the pinned page, where the panel has the focus.
        panel.connect('key-press-event', (_actor, event) => this._onPinnedKey(event));
        // A click outside the field closes it. Presses inside must not be stopped: from GNOME 49 a button clicks
        // through a gesture, and an actor that stops the press cancels it.
        root.connect('button-press-event', (_actor, event) => {
            if (panel.contains(global.stage.get_event_actor(event)))
                return 4.default.EVENT_PROPAGATE;
            this.close();
            return 4.default.EVENT_STOP;
        });
        // The glass follows the panel from before-update, which does not ask for frames and runs ahead of the layout
        // that resizes the panel. Without the ticker, an idle stage leaves the glass, and the clip that also limits
        // where rows can be hovered and clicked, at the old size. It runs for a set time, so that it stops even when
        // no JS can run.
        const ticker = new 4.default.Timeline({ actor: root, duration: TICK_MS });
        ticker.connect('completed', () => this._keepTicking());
        panel.connect('notify::allocation', () => {
            if (ticker.is_playing())
                return;
            ticker.set_duration(TICK_MS);
            ticker.start();
        });
        const entry = new 10.default.Entry({
            style_class: 'lg-launcher-entry', hint_text: 'Search', can_focus: true, x_expand: true,
            primary_icon: new 10.default.Icon({ icon_name: 'edit-find-symbolic', style_class: 'lg-launcher-entry-icon' })
        });
        // The hint takes the panel's color too, dimmed the way the theme dims it.
        entry.hint_actor.opacity = HINT_OPACITY;
        const list = new 10.default.BoxLayout({ style_class: 'lg-launcher-list', x_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)() });
        // Hidden while empty, so the panel's spacing does not add room below the field. Its height is limited in
        // _limitResults(), as St.BoxLayout ignores max-height.
        const resultsBox = new 10.default.ScrollView({
            style_class: 'lg-launcher-results', x_expand: true, visible: false,
            hscrollbar_policy: 10.default.PolicyType.NEVER, vscrollbar_policy: 10.default.PolicyType.AUTOMATIC, overlay_scrollbars: true
        });
        resultsBox.set_child(list);
        const searchBox = new 10.default.BoxLayout({ style_class: 'lg-launcher-page', x_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)() });
        searchBox.add_child(entry);
        searchBox.add_child(resultsBox);
        const pinnedBox = new 10.default.ScrollView({
            style_class: 'lg-launcher-pinned', x_expand: true, visible: false,
            hscrollbar_policy: 10.default.PolicyType.NEVER, vscrollbar_policy: 10.default.PolicyType.AUTOMATIC, overlay_scrollbars: true,
            // On the scroll view, as St.BoxLayout ignores min-height; inside the panel's padding.
            style: this._pinnedStyle(monitor.height)
        });
        panel.add_child(searchBox);
        panel.add_child(pinnedBox);
        root.add_child(panel);
        Main.layoutManager.uiGroup.add_child(root);
        this._root = root;
        this._panel = panel;
        this._entry = entry;
        this._list = list;
        this._resultsBox = resultsBox;
        this._searchBox = searchBox;
        this._pinnedBox = pinnedBox;
        this._view = 'search';
        this._switch = null;
        this._spring = null;
        this._glass = glass;
        this._ticker = ticker;
        this._results = [];
        this._items = [];
        this._selected = 0;
        this._applyMaterial();
        this._materialIds = (['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast',
            'saturation']).map(key => this._settings.connect(`changed::launcher-${key}`, () => this._applyMaterial()));
        this._limitResults();
        for (const key of ['width', 'pinned-height', 'pinned-icon-size'])
            this._materialIds.push(this._settings.connect(`changed::launcher-${key}`, () => this._applySize()));
        entry.clutter_text.connect('text-changed', () => this._queueSearch());
        entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        this._grab = Main.pushModal(root, { actionMode: 9.default.ActionMode.POPUP });
        global.stage.set_key_focus(entry.clutter_text);
        this._shapeStarted = false;
        (0, frameLoops_js_1.startSyncLoop)(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this._root,
            honourFreeze: true,
            errorTag: 'Launcher',
            step: () => this._sync(),
        });
        root.ease({ opacity: 255, duration: FADE_MS, mode: 4.default.AnimationMode.EASE_OUT_QUAD });
        this._coloredFor = '';
        if (this._settings.get_boolean('launcher-enable-adaptive-text-color')) {
            this._text.start(this._settings.get_int('launcher-sample-interval-ms'), (0, contrastSampler_js_1.sanitizeColorPreference)(this._settings.get_string('launcher-adaptive-text-preference')));
        }
        this._colorText();
    }
    close() {
        const root = this._root;
        if (!root)
            return;
        this._root = null;
        (0, frameLoops_js_1.stopStageLoop)(this._frameSignalSlot, this._frameSlot);
        this._ticker?.stop();
        this._ticker = null;
        this._cancelSearch();
        this._text.clear();
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        for (const id of this._materialIds)
            this._settings.disconnect(id);
        this._materialIds = [];
        const glass = this._glass;
        this._glass = null;
        this._panel = null;
        this._entry = null;
        this._list = null;
        this._resultsBox = null;
        this._searchBox = null;
        this._pinnedBox = null;
        this._lens = null;
        this._switch = null;
        this._spring = null;
        this._items = [];
        this._results = [];
        if (this._refreshId)
            global.compositor.get_laters().remove(this._refreshId);
        this._refreshId = 0;
        root.remove_all_transitions();
        glass?.cleanup();
        if ((0, lifecycle_js_1.isActorValid)(root))
            root.destroy();
    }
    /** Types `text` into the field, for the test driver. */
    setText(text) {
        if (this._entry)
            this._entry.text = text;
    }
    /** The pinned items' page, or the search again. */
    showView(view) {
        if (!this._root || view === (this._switch?.view ?? this._view))
            return;
        const morph = this._settings.get_string('launcher-pinned-transition') === 'morph';
        const sw = this._switch;
        if (sw) {
            // Turned back midway: the content goes again from as far as it had come, or comes back from as far as
            // it had gone.
            sw.view = view;
            if (sw.phase === 'in' && view !== this._view) {
                const now = 6.default.get_monotonic_time();
                const shown = 1 - (1 - Math.min((now - sw.startUs) / 1000 / SWITCH_IN_MS, 1)) ** 3;
                sw.phase = 'out';
                sw.startUs = now - (1 - shown) * SWITCH_OUT_MS * 1000;
            }
            return;
        }
        this._switch = { view, morph, phase: 'out', startUs: 6.default.get_monotonic_time() };
        if (morph) {
            this._lens = new contentLens_js_1.ContentLens();
            this._panel.add_effect(this._lens);
        }
        this._keepTicking();
    }
    // The search's width is a setting; the pinned page is wider. Neither outgrows a small screen.
    _panelWidth(pinned, monitorWidth) {
        const width = this._settings.get_int('launcher-width') + (pinned ? PINNED_EXTRA_WIDTH : 0);
        return Math.min(width, monitorWidth - SIDE_MARGIN * 2);
    }
    _pinnedStyle(monitorHeight) {
        const max = Math.round(monitorHeight * PINNED_MAX_HEIGHT);
        const min = Math.min(this._settings.get_int('launcher-pinned-height') - PANEL_PADDING * 2, max);
        return `min-height: ${min}px; max-height: ${max}px;`;
    }
    // The field sits at TOP of the screen's height, and higher on a screen too short to leave MIN_RESULTS_HEIGHT below it.
    _panelTop(monitorHeight) {
        const lowest = monitorHeight - SIDE_MARGIN - PANEL_PADDING * 2 - PAGE_SPACING - ENTRY_HEIGHT - MIN_RESULTS_HEIGHT;
        return Math.max(SIDE_MARGIN, Math.min(Math.round(monitorHeight * TOP), lowest));
    }
    // The results scroll past what is left of the screen below the field, so that they never run off it.
    _limitResults() {
        const panel = this._panel;
        const room = this._root.height - panel.y - SIDE_MARGIN - PANEL_PADDING * 2 - PAGE_SPACING - this._entry.get_preferred_height(-1)[1];
        this._resultsBox.set_style(`max-height: ${Math.max(Math.floor(room), 0)}px;`);
    }
    _applySize() {
        this._pinnedBox.set_style(this._pinnedStyle(this._root.height));
        this._setView(this._view);
        this._coloredFor = '';
    }
    _applyMaterial() {
        const glass = this._glass;
        if (!glass)
            return;
        const s = this._settings;
        glass.setTintColor(...(0, colors_js_1.hexToColorArray)(s.get_string('launcher-tint-color')));
        glass.setTintStrength(s.get_double('launcher-tint-strength'));
        glass.setBlurRadius(s.get_int('launcher-blur-radius'));
        glass.setCornerRadius(s.get_double('launcher-corner-radius'));
        glass.setBrightness(s.get_double('launcher-brightness'));
        glass.setContrast(s.get_double('launcher-contrast'));
        glass.setSaturation(s.get_double('launcher-saturation'));
    }
    // Every frame: the glass eases to the field and its results, which are cut
    // off where the glass ends.
    _sync() {
        const glass = this._glass;
        const panel = this._panel;
        const root = this._root;
        const [w, h] = [panel.width, panel.height];
        if (!(w >= 1) || !(h >= 1))
            return;
        const rest = [panel.x, panel.y, w, h];
        const now = 6.default.get_monotonic_time();
        if (!this._shapeStarted) {
            this._shapeStarted = true;
            const grow = (OPEN_SCALE - 1) / 2;
            this._shape.start([rest[0] - w * grow, rest[1] - h * grow, w * OPEN_SCALE, h * OPEN_SCALE], rest, now);
        }
        let x, y, gw, gh;
        if (this._spring) {
            this._spring.setTarget(rest, now);
            [x, y, gw, gh] = this._spring.rect(now);
        }
        else {
            this._shape.setTarget(rest, now);
            [x, y, gw, gh] = this._shape.rect(now);
        }
        const p = SHADER_PADDING;
        glass.set_position(0, 0);
        glass.set_size(root.width, root.height);
        glass.setResolution(root.width, root.height);
        glass.setGlassGeometry(x - p, y - p, gw + p * 2, gh + p * 2);
        const clip = [x - panel.x, y - panel.y, gw, gh];
        panel.set_clip(clip[0], clip[1], clip[2], clip[3]);
        this._stepSwitch(now, [x, y, gw, gh], clip);
        this._keepTicking();
        (0, allocation_js_1.ensureGlassAllocated)(glass);
        glass.syncSources();
    }
    _shapeRemaining(nowUs) {
        if (this._switch)
            return TICK_MS;
        if (this._spring)
            return this._spring.settled() ? 0 : TICK_MS;
        return this._shape.remaining(nowUs);
    }
    _keepTicking() {
        const ticker = this._ticker;
        const left = this._shapeRemaining(6.default.get_monotonic_time());
        if (!ticker || ticker.is_playing() || left <= 0)
            return;
        ticker.set_duration(Math.ceil(left) + TICK_MS);
        ticker.start();
    }
    // Changing page: the content goes (in a morph, sinking deep into the glass), the page is swapped, the glass
    // takes the new page's shape, and the new content comes up.
    _stepSwitch(now, rect, clip) {
        const sw = this._switch;
        if (!sw) {
            if (this._spring?.settled()) {
                this._shape.start(rect, rect, now);
                this._spring = null;
            }
            return;
        }
        const panel = this._panel;
        const elapsed = (now - sw.startUs) / 1000;
        let shown;
        if (sw.phase === 'out') {
            const k = Math.min(elapsed / SWITCH_OUT_MS, 1);
            shown = 1 - k;
            if (k >= 1 && sw.view === this._view) {
                // Turned back before the swap: the same page comes back.
                sw.phase = 'in';
                sw.startUs = now;
            }
            else if (k >= 1) {
                this._setView(sw.view);
                sw.phase = 'in';
                sw.startUs = now;
                if (sw.morph)
                    this._spring = new spring_js_1.RectSpring(rect);
            }
        }
        else {
            const k = Math.min(elapsed / SWITCH_IN_MS, 1);
            shown = 1 - (1 - k) ** 3;
            if (k >= 1) {
                this._switch = null;
                if (this._lens)
                    panel.remove_effect(this._lens);
                this._lens = null;
                panel.opacity = 255;
                return;
            }
        }
        panel.opacity = Math.round(255 * shown);
        this._lens?.shape(clip, 1, this._settings.get_double('launcher-corner-radius'), 1 - shown);
    }
    _setView(view) {
        const panel = this._panel;
        const root = this._root;
        this._view = view;
        const pinned = view === 'pinned';
        const width = this._panelWidth(pinned, root.width);
        panel.set_width(width);
        panel.x = Math.round((root.width - width) / 2);
        this._searchBox.visible = !pinned;
        this._pinnedBox.visible = pinned;
        if (pinned) {
            this._showPinned();
            global.stage.set_key_focus(panel);
        }
        else {
            this._showResults();
            global.stage.set_key_focus(this._entry.clutter_text);
        }
    }
    _isPinnedShortcut(event) {
        const key = event.get_key_symbol();
        return (event.get_state() & 4.default.ModifierType.CONTROL_MASK) !== 0 && (key === 4.default.KEY_p || key === 4.default.KEY_P);
    }
    _isEnter(key) {
        return key === 4.default.KEY_Return || key === 4.default.KEY_KP_Enter || key === 4.default.KEY_ISO_Enter;
    }
    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === 4.default.KEY_Escape) {
            this.close();
            return 4.default.EVENT_STOP;
        }
        if (this._isPinnedShortcut(event)) {
            this.showView('pinned');
            return 4.default.EVENT_STOP;
        }
        if (key === 4.default.KEY_Down || key === 4.default.KEY_Up) {
            const n = this._items.length;
            if (n > 0)
                this._select((this._selected + (key === 4.default.KEY_Down ? 1 : n - 1)) % n);
            return 4.default.EVENT_STOP;
        }
        if (this._isEnter(key)) {
            this._items[this._selected]?.activate();
            return 4.default.EVENT_STOP;
        }
        return 4.default.EVENT_PROPAGATE;
    }
    // The tiles are moved between as a grid, then the list below them row by row.
    _onPinnedKey(event) {
        if (this._view !== 'pinned')
            return 4.default.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === 4.default.KEY_Escape || key === 4.default.KEY_BackSpace || this._isPinnedShortcut(event)) {
            this.showView('search');
            return 4.default.EVENT_STOP;
        }
        if (this._isEnter(key)) {
            this._items[this._selected]?.activate();
            return 4.default.EVENT_STOP;
        }
        const n = this._items.length, tiles = this._tileCount, cols = this._columns, i = this._selected;
        let next = i;
        if (key === 4.default.KEY_Right)
            next = Math.min(i + 1, n - 1);
        else if (key === 4.default.KEY_Left)
            next = Math.max(i - 1, 0);
        else if (key === 4.default.KEY_Down)
            next = i < tiles ? (i + cols < tiles ? i + cols : Math.min(tiles, n - 1)) : Math.min(i + 1, n - 1);
        else if (key === 4.default.KEY_Up)
            next = i < tiles ? (i >= cols ? i - cols : i) : i === tiles ? Math.max(tiles - 1, 0) : i - 1;
        else {
            // Typing goes back to the search, with what was typed in the field.
            const text = event.get_key_unicode();
            if ((event.get_state() & 4.default.ModifierType.CONTROL_MASK) || !/^[^\p{C}]$/u.test(text))
                return 4.default.EVENT_PROPAGATE;
            this._entry.text = text;
            this.showView('search');
            return 4.default.EVENT_STOP;
        }
        if (n > 0)
            this._select(next);
        return 4.default.EVENT_STOP;
    }
    // Scrolls to the item only when the keys moved to it; with the pointer, the rows would move under it.
    _select(index, reveal = true) {
        this._items[this._selected]?.actor.remove_style_pseudo_class('selected');
        this._selected = index;
        const item = this._items[index];
        if (!item)
            return;
        item.actor.add_style_pseudo_class('selected');
        if (reveal)
            this._scrollTo(item.actor);
    }
    _scrollTo(actor) {
        const view = this._view === 'pinned' ? this._pinnedBox : this._resultsBox;
        const page = view.get_child();
        const adjustment = view.get_vadjustment();
        // Both are moved by the scrolling alike, so their difference is the actor's place on the page.
        const y1 = actor.get_transformed_position()[1] - page.get_transformed_position()[1];
        const y2 = y1 + actor.height;
        if (y1 < adjustment.value)
            adjustment.value = y1;
        else if (y2 > adjustment.value + adjustment.page_size)
            adjustment.value = y2 - adjustment.page_size;
    }
    _activateResult(result) {
        const { provider, meta } = result;
        const terms = this._terms;
        this.close();
        if (!provider) {
            // The calculation: its value goes to the clipboard.
            10.default.Clipboard.get_default().set_text(10.default.ClipboardType.CLIPBOARD, meta.value);
        }
        else if (provider.isRemoteProvider) {
            provider.activateResult(meta.id, terms);
        }
        else if (meta.id.endsWith('.desktop')) {
            9.default.AppSystem.get_default().lookup_app(meta.id)?.activate();
        }
        else {
            SystemActions.getDefault().activateAction(meta.id);
        }
    }
    _activatePin(pin) {
        this.close();
        if (pin.provider === 'applications') {
            if (pin.id.endsWith('.desktop'))
                9.default.AppSystem.get_default().lookup_app(pin.id)?.activate();
            else
                SystemActions.getDefault().activateAction(pin.id);
            return;
        }
        const provider = this._providers().find(p => p.id === pin.provider);
        if (provider)
            provider.activateResult(pin.id, []);
        else
            this._logger.log(`[Liquid Glass] No search provider ${pin.provider} for pinned ${pin.id}`);
    }
    _cancelSearch() {
        if (this._searchId)
            6.default.Source.remove(this._searchId);
        this._searchId = 0;
        if (this._settleId)
            6.default.Source.remove(this._settleId);
        this._settleId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }
    _queueSearch() {
        this._cancelSearch();
        this._searchId = 6.default.timeout_add(6.default.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchId = 0;
            this._search();
            return 6.default.SOURCE_REMOVE;
        });
    }
    // The overview's providers, applications first.
    _providers() {
        return Main.overview.searchController._searchResults._providers;
    }
    // The previous results stay up until every provider has answered, or SETTLE_MS have passed, so that the glass
    // does not shrink and grow back on each keystroke. Answers after the deadline are shown as they come.
    _search() {
        const text = this._entry?.text.trim() ?? '';
        this._terms = text ? text.split(/\s+/) : [];
        const providers = this._terms.length ? this._providers() : [];
        this._found = [];
        const value = (0, calculator_js_1.evaluate)(text);
        if (value !== null)
            this._found.push(this._calculation(text, value));
        this._waiting = providers.length;
        if (!this._waiting) {
            this._commit();
            return;
        }
        const cancellable = new 5.default.Cancellable();
        this._cancellable = cancellable;
        if (this._settleId)
            6.default.Source.remove(this._settleId);
        this._settleId = 6.default.timeout_add(6.default.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._commit();
            return 6.default.SOURCE_REMOVE;
        });
        providers.forEach((provider, order) => this._ask(provider, order, cancellable));
    }
    async _ask(provider, order, cancellable) {
        const terms = this._terms;
        let metas = [];
        try {
            let ids = await provider.getInitialResultSet(terms, cancellable);
            // GNOME Software also finds what is installed, which the applications' own results already show.
            if (provider.id === software_js_1.SOFTWARE_PROVIDER)
                ids = ids.filter(id => !this._isInstalled(id));
            // Pinned results go first, so that the cut to PER_PROVIDER keeps them.
            const pinned = this._pins.idsOf(provider.id);
            const ordered = pinned.size ? [...ids.filter(id => pinned.has(id)), ...ids.filter(id => !pinned.has(id))] : ids;
            const wanted = provider.filterResults(ordered, PER_PROVIDER);
            if (wanted.length > 0 && !cancellable.is_cancelled())
                metas = await provider.getResultMetas(wanted, cancellable);
        }
        catch (e) {
            if (!isCancelled(e))
                this._logger.log(`[Liquid Glass] Search provider failed: ${e}`);
        }
        if (cancellable.is_cancelled())
            return;
        const software = provider.id === software_js_1.SOFTWARE_PROVIDER;
        this._found.push(...metas.map(meta => ({ provider, order, meta, install: software && (0, software_js_1.softwareDesktopId)(meta.id) !== null })));
        this._waiting--;
        if (this._waiting === 0 || !this._settleId)
            this._commit();
    }
    _isInstalled(softwareId) {
        const desktopId = (0, software_js_1.softwareDesktopId)(softwareId);
        return !!desktopId && !!9.default.AppSystem.get_default().lookup_app(desktopId);
    }
    // The calculation, first of all results, with the value as its name.
    _calculation(text, value) {
        const formatted = (0, calculator_js_1.formatNumber)(value);
        return {
            provider: null, order: -1, meta: {
                id: 'liquid-glass-calculation', name: formatted, value: formatted,
                description: `${text.replace(/=\s*$/, '').trim()} = ${formatted} · Enter copies the result`,
                createIcon: (size) => new 10.default.Icon({ icon_name: 'accessories-calculator-symbolic', icon_size: size }),
            }
        };
    }
    _isPinned(result) {
        return !!result.provider && this._pins.has(result.provider.id, result.meta.id);
    }
    _commit() {
        if (this._settleId)
            6.default.Source.remove(this._settleId);
        this._settleId = 0;
        // The calculation first, then pinned results, then each provider's in the overview's order.
        const rank = (r) => (r.provider ? (this._isPinned(r) ? 1 : 2) : 0);
        this._results = [...this._found].sort((a, b) => rank(a) - rank(b) || a.order - b.order).slice(0, MAX_RESULTS);
        if (this._view === 'search' && !this._switch)
            this._showResults();
    }
    _showResults() {
        const list = this._list;
        if (!list)
            return;
        list.destroy_all_children();
        this._items = this._results.map((result, i) => {
            const icon = this._resultIcon(result, ICON_SIZE);
            const activate = () => this._activateResult(result);
            const row = this._row(icon, result.meta.name ?? '', result.meta.description || result.provider?.appInfo?.get_name() || '', this._pinOf(result, icon), activate, () => { }, result.install ? 'Install' : '');
            row.connect('notify::hover', () => { if (row.hover)
                this._select(i, false); });
            list.add_child(row);
            return { actor: row, activate };
        });
        this._resultsBox.visible = this._items.length > 0;
        this._resultsBox.get_vadjustment().value = 0;
        this._tileCount = 0;
        this._select(Math.min(this._selected, Math.max(this._items.length - 1, 0)), false);
        this._text.invalidate();
        this._colorText();
    }
    _resultIcon(result, size) {
        // A remote provider's result may come without an icon; its application's icon stands in.
        const gicon = result.provider?.appInfo?.get_icon();
        const icon = result.meta.createIcon(size) ?? (gicon ? new 10.default.Icon({ gicon, icon_size: size }) : null);
        if (icon instanceof 10.default.Icon && result.provider?.id === 'applications')
            this._icons.styleLauncherIcon(icon, result.meta.id, this._panel);
        return icon;
    }
    // What a result is kept as when pinned, or null when it cannot be.
    _pinOf(result, icon) {
        const { provider, meta } = result;
        if (!provider || UNPINNABLE.has(provider.id))
            return null;
        const gicon = (icon instanceof 10.default.Icon ? icon.gicon : null) ?? provider.appInfo?.get_icon() ?? null;
        return {
            provider: provider.id, id: meta.id, name: meta.name ?? '', description: meta.description ?? '',
            icon: gicon?.to_string() ?? ''
        };
    }
    // The pin to the left of a row or in a tile's corner: an outline while not pinned, shown on hover, and filled
    // while pinned, shown all the time. A click on it flips it; a click on the rest of the owner activates that.
    _pinToggle(owner, pin, activate, onChange) {
        const icon = new 10.default.Icon({ icon_size: PIN_ICON_SIZE });
        const toggle = new 10.default.Bin({
            style_class: 'lg-launcher-pin', reactive: true, track_hover: true, child: icon,
            y_align: 4.default.ActorAlign.CENTER
        });
        const sync = () => {
            const pinned = this._pins.has(pin.provider, pin.id);
            icon.gicon = 5.default.FileIcon.new(5.default.File.new_for_path(`${this._path}/media/${pinned ? 'pinned' : 'pin'}-symbolic.svg`));
            toggle.opacity = pinned || owner.hover ? 255 : 0;
        };
        owner.connect('notify::hover', sync);
        owner.connect('clicked', () => {
            // By position rather than toggle.hover: a pin that was transparent when the pointer came is not picked
            // until the pointer moves again.
            const [px, py] = global.get_pointer();
            const [x, y] = toggle.get_transformed_position();
            const [w, h] = toggle.get_transformed_size();
            if (!(px >= x && px < x + w && py >= y && py < y + h)) {
                activate();
                return;
            }
            this._pins.toggle(pin);
            sync();
            onChange();
        });
        sync();
        return toggle;
    }
    _row(icon, title, detail, pin, activate, onPinChange, badge = '') {
        const row = new 10.default.Button({ style_class: 'lg-launcher-result', can_focus: false, x_expand: true });
        const box = new 10.default.BoxLayout({ style_class: 'lg-launcher-result-box', x_expand: true });
        // The pin's room is kept on every row, so that the icons line up.
        if (pin) {
            box.add_child(this._pinToggle(row, pin, activate, onPinChange));
        }
        else {
            box.add_child(new 10.default.Widget({ style_class: 'lg-launcher-pin', width: PIN_ICON_SIZE }));
            row.connect('clicked', activate);
        }
        const text = new 10.default.BoxLayout({ y_align: 4.default.ActorAlign.CENTER, x_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)() });
        const name = new 10.default.Label({ text: title, style_class: 'lg-launcher-name' });
        name.clutter_text.ellipsize = 8.default.EllipsizeMode.END;
        text.add_child(name);
        if (detail) {
            const label = new 10.default.Label({ text: detail, style_class: 'lg-launcher-detail' });
            label.clutter_text.ellipsize = 8.default.EllipsizeMode.END;
            text.add_child(label);
        }
        if (icon)
            box.add_child(icon);
        box.add_child(text);
        if (badge)
            box.add_child(new 10.default.Label({ text: badge, style_class: 'lg-launcher-badge', y_align: 4.default.ActorAlign.CENTER }));
        row.set_child(box);
        return row;
    }
    _pinIcon(pin, size) {
        if (pin.provider === 'applications' && pin.id.endsWith('.desktop')) {
            const app = 9.default.AppSystem.get_default().lookup_app(pin.id);
            if (app) {
                const icon = app.create_icon_texture(size);
                this._icons.styleLauncherIcon(icon, pin.id, this._panel);
                return icon;
            }
        }
        let gicon = null;
        try {
            if (pin.icon)
                gicon = 5.default.icon_new_for_string(pin.icon);
        }
        catch (e) {
            this._logger.log(`[Liquid Glass] Pinned ${pin.id} has an unreadable icon: ${e}`);
        }
        return new 10.default.Icon({ gicon: gicon ?? 5.default.ThemedIcon.new('text-x-generic-symbolic'), icon_size: size });
    }
    // The pinned page: a back button, the applications in a grid of square tiles, and the rest as a list.
    _showPinned() {
        const view = this._pinnedBox;
        view.get_child()?.destroy();
        const page = new 10.default.BoxLayout({ style_class: 'lg-launcher-page', x_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)() });
        const header = new 10.default.BoxLayout({ style_class: 'lg-launcher-header' });
        const back = new 10.default.Button({
            style_class: 'lg-launcher-back', can_focus: false, accessible_name: 'Back to the search',
            child: new 10.default.Icon({ icon_name: 'go-previous-symbolic', icon_size: PIN_ICON_SIZE })
        });
        back.connect('clicked', () => this.showView('search'));
        header.add_child(back);
        header.add_child(new 10.default.Label({ text: 'Pinned', style_class: 'lg-launcher-title', y_align: 4.default.ActorAlign.CENTER }));
        page.add_child(header);
        const pins = this._pins.all();
        const apps = pins.filter(p => p.provider === 'applications');
        const rest = pins.filter(p => p.provider !== 'applications');
        this._items = [];
        // After the click that unpinned an item has been handled: the page is built again without it.
        const refresh = () => {
            if (this._refreshId)
                return;
            this._refreshId = global.compositor.get_laters().add(7.default.LaterType.BEFORE_REDRAW, () => {
                this._refreshId = 0;
                if (this._view === 'pinned' && this._pinnedBox)
                    this._showPinned();
                return 6.default.SOURCE_REMOVE;
            });
        };
        if (apps.length) {
            page.add_child(new 10.default.Label({ text: 'Applications', style_class: 'lg-launcher-section' }));
            const iconSize = this._settings.get_int('launcher-pinned-icon-size');
            const { columns, tile } = (0, pinnedGrid_js_1.pinnedGrid)(this._panelWidth(true, this._root.width) - PANEL_PADDING * 2, iconSize, GRID_SPACING, TILE_SIDE_ROOM);
            this._columns = columns;
            let line = null;
            apps.forEach((pin, i) => {
                if (i % columns === 0) {
                    line = new 10.default.BoxLayout({ style_class: 'lg-launcher-grid-row' });
                    page.add_child(line);
                }
                const app = pin.id.endsWith('.desktop') ? 9.default.AppSystem.get_default().lookup_app(pin.id) : null;
                const button = new 10.default.Button({ style_class: 'lg-launcher-tile', can_focus: false, width: tile });
                const content = new 10.default.BoxLayout({
                    style_class: 'lg-launcher-tile-box', x_align: 4.default.ActorAlign.CENTER,
                    y_align: 4.default.ActorAlign.CENTER, x_expand: true, y_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)()
                });
                const icon = this._pinIcon(pin, iconSize);
                icon.x_align = 4.default.ActorAlign.CENTER;
                content.add_child(icon);
                const name = new 10.default.Label({
                    text: app?.get_name() ?? pin.name, style_class: 'lg-launcher-tile-name',
                    x_align: 4.default.ActorAlign.CENTER
                });
                name.clutter_text.ellipsize = 8.default.EllipsizeMode.END;
                content.add_child(name);
                const toggle = this._pinToggle(button, pin, () => this._activatePin(pin), refresh);
                toggle.set({ x_align: 4.default.ActorAlign.START, y_align: 4.default.ActorAlign.START, x_expand: true, y_expand: true });
                const stack = new 10.default.Widget({ layout_manager: new 4.default.BinLayout(), x_expand: true, y_expand: true });
                stack.add_child(content);
                stack.add_child(toggle);
                button.set_child(stack);
                const index = this._items.length;
                button.connect('notify::hover', () => { if (button.hover)
                    this._select(index, false); });
                line.add_child(button);
                this._items.push({ actor: button, activate: () => this._activatePin(pin) });
            });
        }
        this._tileCount = this._items.length;
        if (rest.length) {
            page.add_child(new 10.default.Label({ text: 'Files', style_class: 'lg-launcher-section' }));
            const list = new 10.default.BoxLayout({ style_class: 'lg-launcher-list', ...(0, shellVersion_js_1.verticalBoxParams)() });
            for (const pin of rest) {
                const provider = this._providers().find(p => p.id === pin.provider);
                const row = this._row(this._pinIcon(pin, ICON_SIZE), pin.name, pin.description || provider?.appInfo?.get_name() || '', pin, () => this._activatePin(pin), refresh);
                const index = this._items.length;
                row.connect('notify::hover', () => { if (row.hover)
                    this._select(index, false); });
                list.add_child(row);
                this._items.push({ actor: row, activate: () => this._activatePin(pin) });
            }
            page.add_child(list);
        }
        if (!pins.length) {
            page.add_child(new 10.default.Label({
                text: 'Nothing pinned yet. Point at a search result and click the pin on its left.',
                style_class: 'lg-launcher-empty', x_align: 4.default.ActorAlign.CENTER, y_align: 4.default.ActorAlign.CENTER, y_expand: true
            }));
        }
        view.set_child(page);
        this._select(Math.min(this._selected, Math.max(this._items.length - 1, 0)));
        this._text.invalidate();
        this._colorText();
    }
    // Chooses the text color for where the panel is about to be, from its size with the rows it has now, before
    // the next layout gives it that size.
    _colorText() {
        const root = this._root;
        const panel = this._panel;
        const width = this._panelWidth(this._view === 'pinned', root.width);
        const [, height] = panel.get_preferred_height(width);
        const rect = { x: root.x + panel.x, y: root.y + panel.y, width, height: Math.ceil(height) };
        const key = `${rect.y},${rect.height}`;
        if (key === this._coloredFor)
            return;
        this._coloredFor = key;
        this._text.colorFor(rect);
    }
    cleanup() {
        this.close();
        if (this._keybinding)
            Main.wm.removeKeybinding('launcher-shortcut');
        this._keybinding = false;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        Launcher.instance = null;
    }
    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }
    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
exports.Launcher = Launcher;
