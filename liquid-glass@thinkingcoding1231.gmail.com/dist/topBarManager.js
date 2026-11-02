import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { MAX_GLASS_GROWTHS } from './rendering/glassRenderer.js';
import { ensureGlassAllocated, isActorValid } from './actors.js';
import { startSyncLoop, stopStageLoop, hexToColorArray } from './animation.js';
import { sanitizeColorPreference, AdaptiveTextColor } from './contrastSampler.js';
// Extra space for shader edge effects.
const SHADER_PADDING = 20;
// Space for the pill shadow.
const SHADOW_ROOM = 48;
const SIDES = ['top', 'bottom', 'left', 'right'];
// The bars with glass, which the menus opened from them can grow out of.
const liveBars = new Set();

/** The bar the menu opened from `source` grows out of (top-bar-menus-grow), or null while menus float. */
export function barGrowingMenuFrom(source) {
    if (!source)
        return null;
    for (const bar of liveBars)
        if (bar.growsMenuFrom(source))
            return bar;
    return null;
}

function sanitizeStyle(value) {
    return value === 'pill' || value === 'islands' || value === 'center' ? value : 'off';
}

/**
 * Width at which the shell's Panel fits its boxes at their natural widths. It puts the center box in the
 * middle and gives both sides the same room, shifted by the work area's offset when a dock is fixed to a side.
 */
export function centeredBarWidth(left, center, right, centerOffset) {
    return Math.ceil(center + 2 * Math.max(left, right) + Math.abs(centerOffset));
}

/** Glass behind the top bar: one pill, separate islands for its three button groups, or one pill the bar shrinks to. */
export class TopBarManager {
    _path;
    _settings;
    _logger;
    _panel;
    _panelBox;
    _owner;
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
    // The bar's width while the centered style shrinks it, and what it replaced on the bar and quick settings.
    _centeredWidth = 0;
    _savedXAlign = 0;
    _savedQuickSettingsAlignment = 0;
    // The menus grown out of this bar, by the manager that holds each: [x, y, w, h] on the stage and the radius of
    // the corners that are free of the bar. The latest are drawn.
    _growths = new Map();
    // The bar's glass bodies on the stage, [x, y, w, h], before the menus widen them, and the glass actor's size and
    // the bar's height.
    _bodies = [];
    _glassSize = [0, 0, 0];

    constructor(_path, _settings, _logger,
    // The panel's boxes are not part of the shell's typings.
    _panel = Main.panel, _panelBox = Main.layoutManager.panelBox,
    // Names this glass in diagnostics.
    _owner = 'top-bar') {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._panel = _panel;
        this._panelBox = _panelBox;
        this._owner = _owner;
        this._text = new AdaptiveTextColor(() => this._textRoots(), () => (this._glass ? [this._glass] : []), _logger, 'top bar');
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
        watch('top-bar-attach-to-edge', () => {
            this._applyAttach();
            this._applyLayout();
        });
        watch('top-bar-edge-radius', () => {
            this._applyAttach();
            this._applyGrowths();
        });
        watch('top-bar-menus-grow', () => {
            // The glass reaches down the monitor only while menus grow out of it.
            this._lastKey = '';
            this._growths.clear();
            this._applyGrowths();
        });
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
        const panel = this._panel;
        const panelBox = this._panelBox;
        panel.add_style_class_name('liquid-glass-transparent');
        const glass = new BackdropGlass({
            extensionPath: this._path, settings: this._settings, logger: this._logger, owner: this._owner, outline: 'top-bar',
        });
        this._glass = glass;
        liveBars.add(this);
        glass.reactive = false;
        glass.setPadding(SHADER_PADDING);
        glass.setIsDock(false);
        glass.setMultiRegionMode(this._style === 'islands');
        glass.setShadowMaxRadius(SHADOW_ROOM - 8);
        // Draw the glass below the panel.
        Main.layoutManager.uiGroup.insert_child_below(glass, panelBox);
        this._applyMaterial();
        this._applyAttach();
        this._lastKey = '';
        this._lastIslandRects = [];
        this._islandGeometryHoldFrames = 0;
        const styled = new Set([panel, panel._leftBox, panel._centerBox, ...this._sections()]);
        this._savedStyles = [...styled].map(actor => [actor, actor.get_style()]);
        this._childrenStyles = [];
        if (this._style === 'center') {
            // panelBox keeps the monitor's width, so the bar stays above maximized windows.
            this._savedXAlign = panel.x_align;
            panel.x_align = Clutter.ActorAlign.CENTER;
            // Quick settings opens from its button's left edge and counts on the screen edge to push it back, so in
            // the middle of the screen it would hang past the bar. The other monitors' bars open this same menu.
            if (this._owner === 'top-bar') {
                const menu = Main.panel.statusArea.quickSettings.menu;
                this._savedQuickSettingsAlignment = menu._arrowAlignment;
                menu._arrowAlignment = 0.5;
            }
        }
        // Reapply layout when the theme changes the bar height.
        this._panelStyleId = panel.connect('style-changed', () => this._applyLayout());
        this._applyLayout();
        this._connectBoxSignals();
        this._stagePointerSignalId = global.stage.connect('captured-event', (_actor, event) => this._onStageEvent(event));
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            // The glass may be destroyed before shutdown cleanup runs.
            alive: () => !!this._glass && isActorValid(this._glass),
            honourFreeze: true,
            errorTag: 'TopBarManager',
            step: () => {
                ensureGlassAllocated(this._glass);
                this._sync();
            },
        });
        ensureGlassAllocated(this._glass);
        this._sync();
        this._syncText();
    }

    _connectBoxSignals() {
        for (const box of this._sections()) {
            const addedId = box.connect('child-added', () => this._applyLayout());
            // A removed button may be re-added elsewhere, so it gets its own styles back.
            const removedId = box.connect('child-removed', (_box, child) => this._releaseChild(child));
            this._boxSignalIds.push([box, addedId], [box, removedId]);
        }
    }

    // The boxes the buttons sit in.
    _sections() {
        const panel = this._panel;
        return [panel._leftBox, panel._centerBin ?? panel._centerBox, panel._rightBox];
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
            if (isActorValid(box)) {
                box.disconnect(id);
            }
        }
        this._boxSignalIds = [];
    }

    _applyMaterial() {
        const glass = this._glass;
        if (!glass)
            return;
        glass.setTintColor(...hexToColorArray(this._settings.get_string(this._key('tint-color'))));
        glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
        glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
        glass.setCornerRadius(this._settings.get_double(this._key('corner-radius')));
        glass.setBrightness(this._settings.get_double(this._key('brightness')));
        glass.setContrast(this._settings.get_double(this._key('contrast')));
        glass.setSaturation(this._settings.get_double(this._key('saturation')));
    }

    _applyAttach() {
        const attached = this._settings.get_boolean(this._key('attach-to-edge'));
        this._glass?.setAttachedEdge(attached ? 'top' : 'none', this._settings.get_double(this._key('edge-radius')));
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
            if (!isActorValid(container) || !isActorValid(target))
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
        if (type === Clutter.EventType.TOUCH_BEGIN)
            return true;
        return type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY;
    }

    _toggleOverview() {
        if (Main.overview.shouldToggleByCornerOrButton())
            Main.overview.toggle();
    }

    // A press on the wrapper above or below the button. Menus open on press, as the panel's own
    // buttons do, so their release needs no handling; Activities and plain buttons act on release.
    _onWrapperPress(container, target, event) {
        const touch = event.type() === Clutter.EventType.TOUCH_BEGIN;
        if (target.get_name() !== 'panelActivities') {
            const menu = this._targetMenu(target);
            const wasOpen = menu?.isOpen;
            const handled = target.emit(touch ? 'touch-event' : 'button-press-event', event.copy());
            if (menu) {
                // AppIndicator buttons toggle their menu in the press handler, at once or after the
                // double-click wait, and still propagate; a second toggle here closes it mid-animation.
                const selfToggled = menu.isOpen !== wasOpen
                    || Boolean(target._waitDoubleClickPromise);
                if (handled !== Clutter.EVENT_STOP && !selfToggled)
                    menu.toggle();
                return Clutter.EVENT_STOP;
            }
        }
        target.add_style_pseudo_class('active');
        this._forwardedPresses.set(container, { touch, native: false });
        return Clutter.EVENT_STOP;
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
                    this._forwardedPresses.set(container, { touch: type === Clutter.EventType.TOUCH_BEGIN, native: true });
                break;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        const touchEnd = type === Clutter.EventType.TOUCH_END;
        if (!touchEnd && (type !== Clutter.EventType.BUTTON_RELEASE || event.get_button() !== Clutter.BUTTON_PRIMARY))
            return Clutter.EVENT_PROPAGATE;
        for (const [container, press] of this._forwardedPresses) {
            if (press.touch !== touchEnd)
                continue;
            this._forwardedPresses.delete(container);
            const target = this._containerTargets.find(([candidate]) => candidate === container)?.[1];
            if (!target || !isActorValid(target))
                return Clutter.EVENT_STOP;
            target.remove_style_pseudo_class('active');
            if (press.native && this._eventComesFromTarget(target, event))
                return Clutter.EVENT_PROPAGATE;
            if (!this._pointerIsOverContainer(container))
                return Clutter.EVENT_PROPAGATE;
            if (target.get_name() === 'panelActivities')
                this._toggleOverview();
            else if (target instanceof St.Button)
                target.emit('clicked', Clutter.BUTTON_PRIMARY);
            else
                target.emit(touchEnd ? 'touch-event' : 'button-release-event', event.copy());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _setupContainerForwarding(container, target) {
        if (this._containerTargets.some(([actor]) => actor === container))
            return;
        const clearHover = () => {
            if (!this._pointerIsOverContainer(container)) {
                target.remove_style_pseudo_class('hover');
                target.remove_style_pseudo_class('active');
            }
            return Clutter.EVENT_PROPAGATE;
        };
        const enterId = container.connect('enter-event', () => {
            target.add_style_pseudo_class('hover');
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = container.connect('leave-event', clearHover);
        const targetLeaveId = target.connect('leave-event', clearHover);
        // Presses that reach the button itself keep their normal path.
        const pressId = container.connect('captured-event', (_actor, event) => {
            if (!this._isPress(event) || this._eventComesFromTarget(target, event))
                return Clutter.EVENT_PROPAGATE;
            return this._onWrapperPress(container, target, event);
        });
        this._containerTargets.push([container, target]);
        this._containerSignalIds.push([container, enterId], [container, leaveId], [target, targetLeaveId], [container, pressId]);
    }

    _disconnectContainerSignals() {
        // The panel's wrappers are not reactive on their own.
        for (const [container] of this._containerTargets) {
            if (isActorValid(container))
                container.reactive = false;
        }
        for (const [actor, id] of this._containerSignalIds) {
            if (isActorValid(actor))
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
            const panel = this._panel;
            const sections = this._sections();
            const margin = this._margin = this._insets('margin');
            // Grown out of the screen's top, the glass starts at it.
            if (this._settings.get_boolean(this._key('attach-to-edge')))
                margin.top = 0;
            const padding = this._padding = this._insets('padding');
            const top = margin.top + padding.top;
            const bottom = margin.bottom + padding.bottom;
            const own = (style) => style?.trim().replace(/;$/, '') || '';
            const withOwn = (style, extra) => (own(style) ? `${own(style)}; ${extra}` : extra);
            this._childrenStyles = this._childrenStyles.filter(([actor]) => isActorValid(actor));
            // Measure the theme's height with all of our styles removed.
            for (const [actor, original] of [...this._savedStyles, ...this._childrenStyles])
                actor.set_style(own(original));
            const themeHeight = panel.get_theme_node().get_height();
            const baseHeight = themeHeight > 0 ? themeHeight : panel.get_preferred_height(-1)[1];
            const totalHeight = baseHeight + top + bottom;
            for (const [actor, original] of this._savedStyles) {
                if (actor === panel) {
                    // Inline styles win over the stylesheet's transparent background, and Multi Monitors Bar
                    // colors its bars with one.
                    actor.set_style(withOwn(original, `height: ${totalHeight}px; min-height: ${totalHeight}px; padding-top: 0px; ` +
                        'padding-bottom: 0px; background-color: transparent !important;'));
                    continue;
                }
                const leftInset = actor === panel._leftBox ? margin.left + padding.left : 0;
                const rightInset = actor === panel._rightBox ? margin.right + padding.right : 0;
                actor.set_style(withOwn(original, `height: ${totalHeight}px; padding: 0px ${rightInset}px 0px ${leftInset}px;`));
                // Multi Monitors Bar's _centerBox only holds the row its buttons are in.
                if (!sections.includes(actor))
                    continue;
                for (const child of actor.get_children()) {
                    if (!(child instanceof St.Widget))
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
            if (current instanceof St.Widget && current.has_style_class_name('panel-button'))
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
        this._text.start(this._settings.get_int(this._key('sample-interval-ms')), sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference'))));
    }

    _textRoots() {
        return this._sections().filter(box => box.mapped);
    }

    // Visible child extent in bar coordinates.
    _boxExtent(box) {
        let x0 = Infinity, x1 = -Infinity;
        // A section may sit inside another box (Multi Monitors Bar's center row).
        let bx = 0;
        for (let actor = box; actor && actor !== this._panel; actor = actor.get_parent())
            bx += actor.get_position()[0];
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
        // Lays the stage out now if this bar waits for it, so the reads below see allocations. On a bar queued for
        // relayout, size getters re-measure part of its tree mid-frame, and Multi Monitors Bar's mirrored buttons then
        // miss their next resize.
        const panelAllocation = this._panel.get_allocation_box();
        // Modal overlays may suppress leave-event; reconcile hover each frame.
        this._syncForwardedHover();
        const glass = this._glass;
        const panelBox = this._panelBox;
        const panel = this._panel;
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
        const width = Math.round(panelBox.allocation.get_width());
        const height = Math.round(panelAllocation.get_height());
        if (!Number.isFinite(x) || !Number.isFinite(y) || width < 1 || height < 1)
            return;
        const { top, bottom } = this._margin;
        const pillHeight = height - top - bottom;
        let left = this._margin.left, right = width - this._margin.right;
        if (this._style === 'center') {
            const barWidth = this._fitCenteredWidth(width);
            // Where panelBox puts the bar once it lays out this frame, so the glass does not lag a frame behind.
            left += Math.floor((width - barWidth) / 2);
            right = left - this._margin.left + barWidth - this._margin.right;
        }
        const rects = [];
        const textAnimating = this._style === 'islands' && this._text.isAnimating();
        if (textAnimating)
            this._islandGeometryHoldFrames = 4;
        else if (this._islandGeometryHoldFrames > 0)
            this._islandGeometryHoldFrames--;
        const holdIslandGeometry = textAnimating || this._islandGeometryHoldFrames > 0;
        if (this._style === 'pill' || this._style === 'center') {
            rects.push([left, top, right - left, pillHeight]);
        }
        else if (holdIslandGeometry && this._lastIslandRects.length > 0) {
            // Text tweens can briefly disturb allocations; hold island geometry steady until they settle.
            rects.push(...this._lastIslandRects.map(rect => [...rect]));
        }
        else {
            for (const box of this._sections()) {
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
        this._bodies = rects.map(([rx, ry, rw, rh]) => [x + rx, y + ry, rw, rh]);
        // Menus grown out of the bar reach down the monitor, so the glass does too.
        let glassHeight = height + SHADOW_ROOM;
        if (this._settings.get_boolean(this._key('menus-grow'))) {
            const monitor = Main.layoutManager.findMonitorForActor(panelBox);
            if (monitor)
                glassHeight = Math.max(glassHeight, Math.round(monitor.y + monitor.height - y));
        }
        const key = `${x},${y},${width},${glassHeight},${rects.flat().join(',')}`;
        if (key !== this._lastKey) {
            this._lastKey = key;
            glass.set_position(x, y);
            glass.set_size(width, glassHeight);
            glass.setResolution(width, glassHeight);
            this._glassSize = [width, glassHeight, height];
            this._applyGrowths();
            this._text.invalidate();
        }
        glass.syncSources();
    }

    /** Whether the menu opened from `source`, a button on this bar, grows out of it instead of floating. */
    growsMenuFrom(source) {
        return !!this._glass?.visible && this._bodies.length > 0 && this._settings.get_boolean(this._key('menus-grow')) &&
            isActorValid(source) && this._panel.contains(source);
    }

    /** The bottom of the bar's glass, a stage y. */
    glassBottom() {
        return Math.max(...this._bodies.map(([, y, , h]) => y + h));
    }

    /**
     * Grows the menu `owner` holds out of the bar as `rect` ([x, y, w, h] on the stage, its top inside the bar's
     * glass), its free corners rounded by `radius`; null takes it back into the bar.
     */
    setMenuGrowth(owner, rect, radius) {
        this._growths.delete(owner);
        if (rect)
            this._growths.set(owner, { rect, radius });
        this._applyGrowths();
    }

    // Draws the bar, widened for the menus growing out of it, and the menus.
    _applyGrowths() {
        const glass = this._glass;
        if (!glass || this._bodies.length === 0)
            return;
        const barCorner = this._settings.get_double(this._key('corner-radius'));
        const drawn = [...this._growths.values()].slice(-MAX_GLASS_GROWTHS);
        const bodies = this._widenedBodies(drawn.map(({ rect }) => rect), barCorner);
        const p = SHADER_PADDING;
        const [width, , height] = this._glassSize;
        const local = bodies.map(([x, y, w, h]) => [x - glass.x, y - glass.y, w, h]);
        if (this._style !== 'islands') {
            const [rx, ry, rw, rh] = local[0];
            glass.setGlassGeometry(rx - p, ry - p, rw + p * 2, rh + p * 2);
        }
        else {
            const regions = local.map(([rx, ry, rw, rh]) => ({
                x: rx - p, y: ry - p, w: rw + p * 2, h: rh + p * 2, tintR: 1, tintG: 1, tintB: 1,
            }));
            glass.setGlassRegions(regions);
            glass.setGlassGeometry(0, 0, width, height);
        }
        // A top corner under the straight part of the bar runs into it. Only one held back by the monitor's side is
        // still beside the bar, and is rounded.
        const underBar = (x) => bodies.some(([bx, , bw, bh]) => {
            const inset = Math.min(barCorner, bh / 2);
            return x >= bx + inset - 0.5 && x <= bx + bw - inset + 0.5;
        });
        const growths = drawn.map(({ rect: [x, y, w, h], radius }) => ({
            x: x - glass.x, y: y - glass.y, w, h,
            radii: [underBar(x) ? 0 : radius, underBar(x + w) ? 0 : radius, radius, radius],
        }));
        glass.setGrowths(growths, this._settings.get_double(this._key('edge-radius')));
        glass.syncSources();
    }

    /**
     * The bar's bodies widened so each menu in `menus` ([x, y, w, h] on the stage) hangs from the straight part of
     * the body it grows out of, past which the body's rounded end runs by its corner radius. Within the glass actor;
     * islands that come to touch become one.
     */
    _widenedBodies(menus, barCorner) {
        const bodies = this._bodies.map(body => [...body]);
        const minX = this._glass.x, maxX = minX + this._glassSize[0];
        for (const [mx, , mw] of menus) {
            // The body the menu comes out of: the one it overlaps most, or else the nearest.
            let body = bodies[0], best = -Infinity;
            for (const b of bodies) {
                const overlap = Math.min(b[0] + b[2], mx + mw) - Math.max(b[0], mx);
                if (overlap > best) {
                    best = overlap;
                    body = b;
                }
            }
            const inset = Math.min(barCorner, body[3] / 2);
            const x0 = Math.max(minX, Math.min(body[0], mx - inset));
            const x1 = Math.min(maxX, Math.max(body[0] + body[2], mx + mw + inset));
            body[0] = x0;
            body[2] = x1 - x0;
        }
        bodies.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const b of bodies) {
            const last = merged[merged.length - 1];
            if (last && b[0] <= last[0] + last[2])
                last[2] = Math.max(last[0] + last[2], b[0] + b[2]) - last[0];
            else
                merged.push(b);
        }
        return merged;
    }

    _fitCenteredWidth(maxWidth) {
        const panel = this._panel;
        const natural = (box) => box.get_preferred_width(-1)[1];
        // Panel adds the work area's offset when it centers its middle box, as for a dock fixed to a side.
        const monitor = Main.layoutManager.findMonitorForActor(panel);
        let centerOffset = 0;
        if (monitor) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            centerOffset = 2 * (workArea.x - monitor.x) + workArea.width - monitor.width;
        }
        const barWidth = Math.min(maxWidth, centeredBarWidth(natural(panel._leftBox), natural(panel._centerBox), natural(panel._rightBox), centerOffset));
        if (barWidth !== this._centeredWidth) {
            this._centeredWidth = barWidth;
            panel.width = barWidth;
        }
        return barWidth;
    }

    _remove() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._text.clear();
        const glass = this._glass;
        this._glass = null;
        liveBars.delete(this);
        this._growths.clear();
        this._bodies = [];
        this._disconnectBoxSignals();
        this._disconnectContainerSignals();
        if (glass) {
            glass.cleanup();
            if (isActorValid(glass))
                glass.destroy();
            this._panel.remove_style_class_name('liquid-glass-transparent');
        }
        if (this._panelStyleId)
            this._panel.disconnect(this._panelStyleId);
        this._panelStyleId = 0;
        if (this._style === 'center') {
            this._panel.width = -1;
            this._panel.x_align = this._savedXAlign;
            this._centeredWidth = 0;
            if (this._owner === 'top-bar')
                Main.panel.statusArea.quickSettings.menu._arrowAlignment = this._savedQuickSettingsAlignment;
        }
        for (const [actor, style] of this._savedStyles)
            if (isActorValid(actor))
                actor.set_style(style);
        for (const [actor, style] of this._childrenStyles)
            if (isActorValid(actor))
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

// Built like the shell's Panel, whose three boxes the glass follows.
function isTopBar(actor) {
    return actor instanceof St.Widget
        && '_leftBox' in actor && actor._leftBox instanceof St.BoxLayout
        && '_centerBox' in actor && actor._centerBox instanceof St.BoxLayout
        && '_rightBox' in actor && actor._rightBox instanceof St.BoxLayout;
}

/**
 * Top bar glass for the bars other extensions put on further monitors, such as Multi Monitors Bar.
 * Each bar sits in a box of its own in uiGroup and gets its own TopBarManager, which follows the
 * top bar settings. Bars along a side of the screen are left alone: the glass is laid out for a
 * horizontal bar.
 */
export class ExtraTopBarManager {
    _path;
    _settings;
    _logger;
    _disconnects = [];
    _bars = new Map();
    // Every bar found, side bars too: Multi Monitors Bar moves a bar back to the top by changing its style class only.
    _watched = new Map();
    _idleId = 0;
    _attached = 0;

    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }

    setup() {
        const uiGroup = Main.layoutManager.uiGroup;
        // The shell's own signal emitters type their handlers as returning a stop flag.
        const scan = () => {
            this._scheduleScan();
            return undefined;
        };
        // A bar's box is added to uiGroup before the bar is put in it; the scan waits for an idle.
        for (const signal of ['child-added', 'child-removed']) {
            const id = uiGroup.connect(signal, scan);
            this._disconnects.push(() => uiGroup.disconnect(id));
        }
        const monitorsId = Main.layoutManager.connect('monitors-changed', scan);
        this._disconnects.push(() => Main.layoutManager.disconnect(monitorsId));
        const extensionsId = Main.extensionManager.connect('extension-state-changed', scan);
        this._disconnects.push(() => Main.extensionManager.disconnect(extensionsId));
        // The shell destroys uiGroup on shutdown without disabling extensions; a scan queued by the
        // removal of its children would run on disposed actors.
        const destroyId = uiGroup.connect('destroy', () => this.cleanup());
        this._disconnects.push(() => uiGroup.disconnect(destroyId));
        this._scheduleScan();
    }

    _scheduleScan() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const bars = new Set();
        const found = new Map();
        for (const box of Main.layoutManager.uiGroup.get_children()) {
            if (box === Main.layoutManager.panelBox || !(box instanceof St.Widget))
                continue;
            for (const child of box.get_children()) {
                if (!isTopBar(child))
                    continue;
                bars.add(child);
                if (!child.has_style_class_name('multimonitor-panel-vertical'))
                    found.set(child, box);
            }
        }
        for (const panel of [...this._bars.keys()])
            if (!found.has(panel))
                this._detach(panel);
        for (const panel of [...this._watched.keys()])
            if (!bars.has(panel))
                this._unwatch(panel);
        for (const panel of bars)
            if (!this._watched.has(panel))
                this._watch(panel);
        for (const [panel, box] of found) {
            if (this._bars.has(panel))
                continue;
            const manager = new TopBarManager(this._path, this._settings, this._logger, panel, box, `top-bar:${++this._attached}`);
            // These bars belong to other extensions and may not be built the way TopBarManager expects.
            try {
                manager.setup();
            }
            catch (e) {
                manager.cleanup();
                this._logger.log(`[Liquid Glass] Could not attach glass to another top bar: ${e}`);
                continue;
            }
            this._bars.set(panel, manager);
        }
    }

    _watch(panel) {
        // The glass and the styles must go while the bar's actors still exist.
        const destroyId = panel.connect('destroy', () => this._unwatch(panel));
        // Multi Monitors Bar marks a bar it moves to a side of the screen.
        const styleId = panel.connect('notify::style-class', () => this._scheduleScan());
        this._watched.set(panel, [destroyId, styleId]);
    }

    _unwatch(panel) {
        this._detach(panel);
        for (const id of this._watched.get(panel) ?? [])
            panel.disconnect(id);
        this._watched.delete(panel);
    }

    _detach(panel) {
        const manager = this._bars.get(panel);
        if (!manager)
            return;
        this._bars.delete(panel);
        manager.cleanup();
    }

    cleanup() {
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        for (const disconnect of this._disconnects)
            disconnect();
        this._disconnects = [];
        for (const panel of [...this._watched.keys()])
            this._unwatch(panel);
    }
}
