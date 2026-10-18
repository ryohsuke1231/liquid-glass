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
exports.TopBarManager = void 0;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const PopupMenu = __importStar(require("resource:///org/gnome/shell/ui/popupMenu.js"));
const 2 = __importDefault(require("gi://Clutter"));
const 3 = __importDefault(require("gi://St"));
const backdropGlass_js_1 = require("./rendering/backdropGlass.js");
const allocation_js_1 = require("./actors/allocation.js");
const lifecycle_js_1 = require("./actors/lifecycle.js");
const frameLoops_js_1 = require("./animation/frameLoops.js");
const colors_js_1 = require("./animation/colors.js");
const contrastSampler_js_1 = require("./contrastSampler.js");
const adaptiveText_js_1 = require("./adaptiveText.js");
// Extra space for shader edge effects.
const SHADER_PADDING = 20;
// Space for the pill shadow.
const SHADOW_ROOM = 48;
const SIDES = ['top', 'bottom', 'left', 'right'];

function sanitizeStyle(value) {
    return value === 'pill' || value === 'islands' ? value : 'off';
}
/** Glass behind the top bar: one pill or separate islands for its three button groups. */

class TopBarManager {
    _path;
    _settings;
    _logger;
    _style = 'off';
    _glass = null;
    _settingsIds = [];
    _frameSyncId = 0;
    _frameSignalId = 0;
    _lastKey = '';
    _lastIslandRects = [];
    _islandGeometryHoldFrames = 0;
    _text;
    // Original styles for the panel and its boxes.
    _savedStyles = [];
    _childrenStyles = [];
    _panelStyleId = 0;
    _margin = { top: 0, bottom: 0, left: 0, right: 0 };
    _padding = { top: 0, bottom: 0, left: 0, right: 0 };
    _boxSignalIds = [];
    _containerSignalIds = [];
    _containerTargets = [];
    _forwardedPresses = new Map();
    _stagePointerSignalId = 0;
    _applyingLayout = false;
    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._text = new adaptiveText_js_1.AdaptiveTextColor(() => this._textRoots(), () => (this._glass ? [this._glass] : []), _logger, 'top bar');
    }
    setup() {
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        watch('top-bar-style', () => this._apply());
        for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
            watch(`top-bar-${key}`, () => this._applyMaterial());
        for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
            watch(`top-bar-${key}`, () => this._syncText());
        for (const side of SIDES) {
            watch(`top-bar-margin-${side}`, () => this._applyLayout());
            watch(`top-bar-padding-${side}`, () => this._applyLayout());
        }
        this._apply();
    }
    _key(suffix) {
        return `top-bar-${suffix}`;
    }
    _apply() {
        const style = sanitizeStyle(this._settings.get_string('top-bar-style'));
        if (style === this._style)
            return;
        this._remove();
        this._style = style;
        if (style !== 'off')
            this._create();
    }
    _create() {
        const panel = Main.panel;
        const panelBox = Main.layoutManager.panelBox;
        panel.add_style_class_name('liquid-glass-transparent');
        const glass = new backdropGlass_js_1.BackdropGlass({
            extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'top-bar',
        });
        this._glass = glass;
        glass.reactive = false;
        glass.setPadding(SHADER_PADDING);
        glass.setIsDock(false);
        glass.setMultiRegionMode(this._style === 'islands');
        glass.setShadowMaxRadius(SHADOW_ROOM - 8);
        // Draw the glass below the panel.
        Main.layoutManager.uiGroup.insert_child_below(glass, panelBox);
        this._applyMaterial();
        this._lastKey = '';
        this._lastIslandRects = [];
        this._islandGeometryHoldFrames = 0;
        this._savedStyles = [panel, panel._leftBox, panel._centerBox, panel._rightBox].map(actor => [actor, actor.get_style()]);
        this._childrenStyles = [];
        // Reapply layout when the theme changes the bar height.
        this._panelStyleId = panel.connect('style-changed', () => this._applyLayout());
        this._applyLayout();
        this._connectBoxSignals();
        this._stagePointerSignalId = global.stage.connect('captured-event', (_actor, event) => this._onStageEvent(event));
        (0, frameLoops_js_1.startSyncLoop)(this._frameSignalSlot, this._frameSlot, {
            // The glass may be destroyed before shutdown cleanup runs.
            alive: () => !!this._glass && (0, lifecycle_js_1.isActorValid)(this._glass),
            honourFreeze: true,
            errorTag: 'TopBarManager',
            step: () => {
                (0, allocation_js_1.ensureGlassAllocated)(this._glass);
                this._sync();
            },
        });
        (0, allocation_js_1.ensureGlassAllocated)(this._glass);
        this._sync();
        this._syncText();
    }
    _connectBoxSignals() {
        const panel = Main.panel;
        for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
            const addedId = box.connect('child-added', () => this._applyLayout());
            // A removed button may be re-added elsewhere, so it gets its own styles back.
            const removedId = box.connect('child-removed', (_box, child) => this._releaseChild(child));
            this._boxSignalIds.push([box, addedId], [box, removedId]);
        }
    }
    _releaseChild(child) {
        const target = this._containerTargets.find(([container]) => container === child)?.[1];
        for (const [actor, style] of this._childrenStyles) {
            if (actor === child || actor === target)
                actor.set_style(style);
        }
        this._childrenStyles = this._childrenStyles.filter(([actor]) => actor !== child && actor !== target);
        if (!target)
            return;
        for (const [actor, id] of this._containerSignalIds) {
            if (actor === child || actor === target)
                actor.disconnect(id);
        }
        this._containerSignalIds = this._containerSignalIds.filter(([actor]) => actor !== child && actor !== target);
        this._containerTargets = this._containerTargets.filter(([container]) => container !== child);
        this._forwardedPresses.delete(child);
        child.reactive = false;
        target.remove_style_pseudo_class('hover');
        target.remove_style_pseudo_class('active');
    }
    _disconnectBoxSignals() {
        for (const [box, id] of this._boxSignalIds) {
            if ((0, lifecycle_js_1.isActorValid)(box)) {
                box.disconnect(id);
            }
        }
        this._boxSignalIds = [];
    }
    _applyMaterial() {
        const glass = this._glass;
        if (!glass)
            return;
        glass.setTintColor(...(0, colors_js_1.hexToColorArray)(this._settings.get_string(this._key('tint-color'))));
        glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
        glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
        glass.setCornerRadius(this._settings.get_double(this._key('corner-radius')));
        glass.setBrightness(this._settings.get_double(this._key('brightness')));
        glass.setContrast(this._settings.get_double(this._key('contrast')));
        glass.setSaturation(this._settings.get_double(this._key('saturation')));
    }
    _insets(kind) {
        return Object.fromEntries(SIDES.map(side => [side, this._settings.get_int(this._key(`${kind}-${side}`))]));
    }
    // Buttons made without a menu carry a dummy one and act on their own handlers.
    _targetMenu(target) {
        const anyTarget = target;
        const menu = anyTarget.menu ?? anyTarget._delegate?.menu;
        return menu instanceof PopupMenu.PopupMenuBase ? menu : null;
    }
    _eventComesFromTarget(target, event) {
        let source = event.get_source();
        while (source) {
            if (source === target)
                return true;
            source = source.get_parent();
        }
        return false;
    }
    // A bounds test rather than a pick: this runs every frame and a pick walks the whole stage.
    _pointerIsOverContainer(container) {
        if (!container.mapped)
            return false;
        const [px, py] = global.get_pointer();
        const [x, y] = container.get_transformed_position();
        const [w, h] = container.get_transformed_size();
        return px >= x && px < x + w && py >= y && py < y + h;
    }
    _syncForwardedHover() {
        for (const [container, target] of this._containerTargets) {
            if (!(0, lifecycle_js_1.isActorValid)(container) || !(0, lifecycle_js_1.isActorValid)(target))
                continue;
            if (this._pointerIsOverContainer(container)) {
                target.add_style_pseudo_class('hover');
            }
            else {
                // Overlays can suppress leave-event, so the state is also cleared here.
                target.remove_style_pseudo_class('hover');
                target.remove_style_pseudo_class('active');
                this._forwardedPresses.delete(container);
            }
        }
    }
    _isPress(event) {
        const type = event.type();
        if (type === 2.default.EventType.TOUCH_BEGIN)
            return true;
        return type === 2.default.EventType.BUTTON_PRESS && event.get_button() === 2.default.BUTTON_PRIMARY;
    }
    _toggleOverview() {
        if (Main.overview.shouldToggleByCornerOrButton())
            Main.overview.toggle();
    }
    // A press on the wrapper above or below the button. Menus open on press, as the panel's own
    // buttons do, so their release needs no handling; Activities and plain buttons act on release.
    _onWrapperPress(container, target, event) {
        const touch = event.type() === 2.default.EventType.TOUCH_BEGIN;
        if (target.get_name() !== 'panelActivities') {
            const menu = this._targetMenu(target);
            const wasOpen = menu?.isOpen;
            const handled = target.emit(touch ? 'touch-event' : 'button-press-event', event.copy());
            if (menu) {
                // AppIndicator buttons toggle their menu in the press handler, at once or after the
                // double-click wait, and still propagate; a second toggle here closes it mid-animation.
                const selfToggled = menu.isOpen !== wasOpen
                    || Boolean(target._waitDoubleClickPromise);
                if (handled !== 2.default.EVENT_STOP && !selfToggled)
                    menu.toggle();
                return 2.default.EVENT_STOP;
            }
        }
        target.add_style_pseudo_class('active');
        this._forwardedPresses.set(container, { touch, native: false });
        return 2.default.EVENT_STOP;
    }
    // The stage sees every release first, also one that ends outside the wrapper.
    _onStageEvent(event) {
        const type = event.type();
        if (this._isPress(event)) {
            // Layout changes can move the picked actor between press and release.
            for (const [container, target] of this._containerTargets) {
                if (!this._eventComesFromTarget(target, event))
                    continue;
                if (!this._targetMenu(target))
                    this._forwardedPresses.set(container, { touch: type === 2.default.EventType.TOUCH_BEGIN, native: true });
                break;
            }
            return 2.default.EVENT_PROPAGATE;
        }
        const touchEnd = type === 2.default.EventType.TOUCH_END;
        if (!touchEnd && (type !== 2.default.EventType.BUTTON_RELEASE || event.get_button() !== 2.default.BUTTON_PRIMARY))
            return 2.default.EVENT_PROPAGATE;
        for (const [container, press] of this._forwardedPresses) {
            if (press.touch !== touchEnd)
                continue;
            this._forwardedPresses.delete(container);
            const target = this._containerTargets.find(([candidate]) => candidate === container)?.[1];
            if (!target || !(0, lifecycle_js_1.isActorValid)(target))
                return 2.default.EVENT_STOP;
            target.remove_style_pseudo_class('active');
            if (press.native && this._eventComesFromTarget(target, event))
                return 2.default.EVENT_PROPAGATE;
            if (!this._pointerIsOverContainer(container))
                return 2.default.EVENT_PROPAGATE;
            if (target.get_name() === 'panelActivities')
                this._toggleOverview();
            else if (target instanceof 3.default.Button)
                target.emit('clicked', 2.default.BUTTON_PRIMARY);
            else
                target.emit(touchEnd ? 'touch-event' : 'button-release-event', event.copy());
            return 2.default.EVENT_STOP;
        }
        return 2.default.EVENT_PROPAGATE;
    }
    _setupContainerForwarding(container, target) {
        if (this._containerTargets.some(([actor]) => actor === container))
            return;
        const clearHover = () => {
            if (!this._pointerIsOverContainer(container)) {
                target.remove_style_pseudo_class('hover');
                target.remove_style_pseudo_class('active');
            }
            return 2.default.EVENT_PROPAGATE;
        };
        const enterId = container.connect('enter-event', () => {
            target.add_style_pseudo_class('hover');
            return 2.default.EVENT_PROPAGATE;
        });
        const leaveId = container.connect('leave-event', clearHover);
        const targetLeaveId = target.connect('leave-event', clearHover);
        // Presses that reach the button itself keep their normal path.
        const pressId = container.connect('captured-event', (_actor, event) => {
            if (!this._isPress(event) || this._eventComesFromTarget(target, event))
                return 2.default.EVENT_PROPAGATE;
            return this._onWrapperPress(container, target, event);
        });
        this._containerTargets.push([container, target]);
        this._containerSignalIds.push([container, enterId], [container, leaveId], [target, targetLeaveId], [container, pressId]);
    }
    _disconnectContainerSignals() {
        // The panel's wrappers are not reactive on their own.
        for (const [container] of this._containerTargets) {
            if ((0, lifecycle_js_1.isActorValid)(container))
                container.reactive = false;
        }
        for (const [actor, id] of this._containerSignalIds) {
            if ((0, lifecycle_js_1.isActorValid)(actor))
                actor.disconnect(id);
        }
        this._containerSignalIds = [];
        this._containerTargets = [];
        this._forwardedPresses.clear();
        if (this._stagePointerSignalId)
            global.stage.disconnect(this._stagePointerSignalId);
        this._stagePointerSignalId = 0;
    }
    // The bar grows by the margin and padding while each button keeps the theme's height. The
    // wrappers around the buttons fill the whole bar, so a press at the screen edge still lands.
    _applyLayout() {
        // set_style() below emits style-changed on the panel, which calls back in here.
        if (!this._glass || this._applyingLayout)
            return;
        this._applyingLayout = true;
        try {
            const panel = Main.panel;
            const margin = this._margin = this._insets('margin');
            const padding = this._padding = this._insets('padding');
            const top = margin.top + padding.top;
            const bottom = margin.bottom + padding.bottom;
            const own = (style) => style?.trim().replace(/;$/, '') || '';
            const withOwn = (style, extra) => (own(style) ? `${own(style)}; ${extra}` : extra);
            this._childrenStyles = this._childrenStyles.filter(([actor]) => (0, lifecycle_js_1.isActorValid)(actor));
            // Measure the theme's height with all of our styles removed.
            for (const [actor, original] of [...this._savedStyles, ...this._childrenStyles])
                actor.set_style(own(original));
            const themeHeight = panel.get_theme_node().get_height();
            const baseHeight = themeHeight > 0 ? themeHeight : panel.get_preferred_height(-1)[1];
            const totalHeight = baseHeight + top + bottom;
            for (const [actor, original] of this._savedStyles) {
                if (actor === panel) {
                    actor.set_style(withOwn(original, `height: ${totalHeight}px; min-height: ${totalHeight}px; padding-top: 0px; padding-bottom: 0px;`));
                    continue;
                }
                const leftInset = actor === panel._leftBox ? margin.left + padding.left : 0;
                const rightInset = actor === panel._rightBox ? margin.right + padding.right : 0;
                actor.set_style(withOwn(original, `height: ${totalHeight}px; padding: 0px ${rightInset}px 0px ${leftInset}px;`));
                for (const child of actor.get_children()) {
                    if (!(child instanceof 3.default.Widget))
                        continue;
                    const target = this._findPanelButton(child) ?? child;
                    if (target !== child) {
                        child.reactive = true;
                        this._setChildStyle(child, `height: ${totalHeight}px;`);
                        this._setupContainerForwarding(child, target);
                    }
                    this._setChildStyle(target, `height: ${baseHeight}px; margin-top: ${top}px; margin-bottom: ${bottom}px;`);
                }
            }
        }
        finally {
            this._applyingLayout = false;
        }
    }
    _findPanelButton(root) {
        const queue = [root];
        while (queue.length > 0) {
            const current = queue.shift();
            if (current instanceof 3.default.Widget && current.has_style_class_name('panel-button'))
                return current;
            queue.push(...current.get_children());
        }
        return null;
    }
    _setChildStyle(actor, extra) {
        let entry = this._childrenStyles.find(([a]) => a === actor);
        if (!entry) {
            entry = [actor, actor.get_style()];
            this._childrenStyles.push(entry);
        }
        const own = entry[1]?.trim().replace(/;$/, '');
        actor.set_style(own ? `${own}; ${extra}` : extra);
    }
    _syncText() {
        if (!this._glass || !this._settings.get_boolean(this._key('enable-adaptive-text-color'))) {
            this._text.clear();
            return;
        }
        this._text.start(this._settings.get_int(this._key('sample-interval-ms')), (0, contrastSampler_js_1.sanitizeColorPreference)(this._settings.get_string(this._key('adaptive-text-preference'))));
    }
    _textRoots() {
        const panel = Main.panel;
        return [panel._leftBox, panel._centerBox, panel._rightBox].filter(box => box && box.mapped);
    }
    // Visible child extent in bar coordinates.
    _boxExtent(box) {
        let x0 = Infinity, x1 = -Infinity;
        const [bx] = box.get_position();
        for (const child of box.get_children()) {
            if (!child.visible || child.width < 1)
                continue;
            const alloc = child.get_allocation_box();
            x0 = Math.min(x0, bx + alloc.x1);
            x1 = Math.max(x1, bx + alloc.x2);
        }
        return x1 > x0 ? [x0, x1] : null;
    }
    // Sync the glass beneath the panel, hiding it with the bar.
    _sync() {
        // Modal overlays may suppress leave-event; reconcile hover each frame.
        this._syncForwardedHover();
        const glass = this._glass;
        const panelBox = Main.layoutManager.panelBox;
        const panel = Main.panel;
        const shown = panelBox.visible && panelBox.mapped && panel.mapped;
        if (!shown) {
            if (glass.visible)
                glass.hide();
            return;
        }
        if (!glass.visible)
            glass.show();
        glass.opacity = Math.round(panelBox.opacity * panel.opacity / 255);
        const [x, y] = panelBox.get_transformed_position();
        const width = Math.round(panelBox.width);
        const height = Math.round(panel.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || width < 1 || height < 1)
            return;
        const { top, bottom } = this._margin;
        const pillHeight = height - top - bottom;
        const left = this._margin.left, right = width - this._margin.right;
        const rects = [];
        const textAnimating = this._style === 'islands' && this._text.isAnimating();
        if (textAnimating)
            this._islandGeometryHoldFrames = 4;
        else if (this._islandGeometryHoldFrames > 0)
            this._islandGeometryHoldFrames--;
        const holdIslandGeometry = textAnimating || this._islandGeometryHoldFrames > 0;
        if (this._style === 'pill') {
            rects.push([left, top, right - left, pillHeight]);
        }
        else if (holdIslandGeometry && this._lastIslandRects.length > 0) {
            // Text tweens can briefly disturb allocations; hold island geometry steady until they settle.
            rects.push(...this._lastIslandRects.map(rect => [...rect]));
        }
        else {
            for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
                const extent = this._boxExtent(box);
                if (!extent)
                    continue;
                const x0 = Math.max(extent[0] - this._padding.left, left);
                const x1 = Math.min(extent[1] + this._padding.right, right);
                if (x1 > x0)
                    rects.push([x0, top, x1 - x0, pillHeight]);
            }
        }
        if (this._style === 'islands' && !holdIslandGeometry) {
            this._lastIslandRects = rects.map(rect => [...rect]);
        }
        else if (this._style === 'islands' && this._lastIslandRects.length === 0 && rects.length > 0) {
            this._lastIslandRects = rects.map(rect => [...rect]);
        }
        const key = `${x},${y},${width},${height},${rects.flat().join(',')}`;
        if (key !== this._lastKey) {
            this._lastKey = key;
            glass.set_position(x, y);
            glass.set_size(width, height + SHADOW_ROOM);
            glass.setResolution(width, height + SHADOW_ROOM);
            const p = SHADER_PADDING;
            if (this._style === 'pill') {
                const [rx, ry, rw, rh] = rects[0];
                glass.setGlassGeometry(rx - p, ry - p, rw + p * 2, rh + p * 2);
            }
            else {
                const regions = rects.map(([rx, ry, rw, rh]) => ({
                    x: rx - p, y: ry - p, w: rw + p * 2, h: rh + p * 2, tintR: 1, tintG: 1, tintB: 1,
                }));
                glass.setGlassRegions(regions);
                glass.setGlassGeometry(0, 0, width, height);
            }
            this._text.invalidate();
        }
        glass.syncSources();
    }
    _remove() {
        (0, frameLoops_js_1.stopStageLoop)(this._frameSignalSlot, this._frameSlot);
        this._text.clear();
        const glass = this._glass;
        this._glass = null;
        this._disconnectBoxSignals();
        this._disconnectContainerSignals();
        if (glass) {
            glass.cleanup();
            if ((0, lifecycle_js_1.isActorValid)(glass))
                glass.destroy();
            Main.panel.remove_style_class_name('liquid-glass-transparent');
        }
        if (this._panelStyleId)
            Main.panel.disconnect(this._panelStyleId);
        this._panelStyleId = 0;
        for (const [actor, style] of this._savedStyles)
            if ((0, lifecycle_js_1.isActorValid)(actor))
                actor.set_style(style);
        for (const [actor, style] of this._childrenStyles)
            if ((0, lifecycle_js_1.isActorValid)(actor))
                actor.set_style(style);
        this._savedStyles = [];
        this._childrenStyles = [];
        this._lastIslandRects = [];
        this._islandGeometryHoldFrames = 0;
        this._style = 'off';
    }
    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._remove();
    }
    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }
    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
exports.TopBarManager = TopBarManager;
