import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import { isActorValid } from './actors.js';
import { startSyncLoop, stopStageLoop } from './animation.js';
import { GeneratedStylesheet } from './generatedStylesheet.js';
import { isTopBar } from './topBarManager.js';
/** On the two boxes that hold the top bar's buttons in a dock. */
export const DOCK_BAR_CLASS = 'liquid-glass-dock-bar';
// The entry of the order that stands for the dock's apps: what is before it goes left of them, the rest right.
const APPS = 'apps';
// Dock Tray moves these into the dock itself. Without it they go along, unlisted, next to the apps on the right.
const TRAY_ROLE = 'appindicator-';
const DOCK_TRAY_UUID = 'dock-tray@alessandrot';
const ACTIVE = ExtensionState.ACTIVE;
// Dash to Dock builds its new docks right after it tears the old ones down. The top bar stays hidden in between,
// and comes back only if no dock is there after this long.
const RESCAN_MS = 1000;
// A button's highlight is this high (px), in the middle of the dock; the button takes the pointer across the dock.
const PILL = 44;
// The screen recording and sharing indicators are a filled pill at all times, which at the others' height would be
// nearly a circle.
const INDICATOR_PILL = 28;
// The room beside a button's content, inside its highlight (px).
const ROOM = 10;
const INDICATOR_ROOM = 8;
const MIN_BORDER = 3;
// How strongly the highlight under the pointer, and of a pressed or open button, shows.
const HOVER_ALPHA = 0.17;
const ACTIVE_ALPHA = 0.28;
const SIDES = ['left', 'right'];

/**
 * `saved` with the buttons it does not list yet written into it next to the apps, on the side of the top bar they
 * come from and in the top bar's order, so the preferences can show and move them.
 */
export function dockBarOrder(saved, buttons) {
    const order = saved.includes(APPS) ? [...saved] : [...saved, APPS];
    let added = 0;
    for (const { role, side } of [...buttons].sort((a, b) => a.index - b.index)) {
        if (order.includes(role) || role.startsWith(TRAY_ROLE))
            continue;
        if (side === 'left')
            order.splice(order.indexOf(APPS), 0, role);
        else
            order.splice(order.indexOf(APPS) + 1 + added++, 0, role);
    }
    return order;
}

/** `roles` in `order`, split at the apps. Unlisted ones (tray icons) sit next to the apps, on the right. */
export function splitDockBar(order, entries) {
    const apps = order.indexOf(APPS);
    const rank = (entry) => {
        const index = order.indexOf(entry.role);
        return index < 0 ? apps + 0.5 : index;
    };
    const sorted = [...entries].sort((a, b) => rank(a) - rank(b));
    return { left: sorted.filter(entry => rank(entry) < apps), right: sorted.filter(entry => rank(entry) > apps) };
}

/**
 * The rules that depend on the dock's thickness and the theme's text color `rgb` ("r, g, b"). The buttons span the
 * dock, so the pointer has them from the screen edge on, as it has the apps; transparent borders `border` px wide
 * (`small` for the recording indicators) cut their highlight down to a pill in the middle, as the theme does in the
 * top bar. The borders are as wide on all four sides: St takes each side's border off the corner radius, so uneven
 * ones would make the pill's ends elliptical.
 */
export function dockBarCss(border, small, rgb) {
    // A panel button asks for its content's width and this padding, and leaves the borders out: they come off the
    // padding. So the padding is the borders' width and the room wanted beside the content.
    const inset = (width, room) => `  border: ${width}px solid transparent;\n` +
        `  -natural-hpadding: ${width + room}px;\n  -minimum-hpadding: ${width + Math.round(room / 2)}px;\n`;
    const shade = (alpha) => `box-shadow: inset 0 0 0 100px rgba(${rgb}, ${alpha});`;
    const button = `.${DOCK_BAR_CLASS} .panel-button`;
    // The clock's highlight is on its label, which counts its borders itself.
    const clock = `${button}.clock-display`;
    return `${button} {\n  color: rgb(${rgb});\n${inset(border, ROOM)}}\n` +
        `${button}:focus, ${button}:hover {\n  ${shade(HOVER_ALPHA)}\n}\n` +
        `${button}:active, ${button}:checked {\n  ${shade(ACTIVE_ALPHA)}\n}\n` +
        `${button}#panelActivities .workspace-dot {\n  background-color: rgb(${rgb});\n}\n` +
        `${clock} {\n  border: 0px solid transparent;\n  -natural-hpadding: 0px;\n  -minimum-hpadding: 0px;\n}\n` +
        `${clock} .clock {\n  border: ${border}px solid transparent;\n}\n` +
        `${clock}:focus .clock, ${clock}:hover .clock {\n  ${shade(HOVER_ALPHA)}\n}\n` +
        `${clock}:active .clock, ${clock}:checked .clock {\n  ${shade(ACTIVE_ALPHA)}\n}\n` +
        `${button}.screen-recording-indicator, ${button}.screen-sharing-indicator {\n${inset(small, INDICATOR_ROOM)}}\n`;
}

function findDash(actor) {
    if (actor instanceof St.Widget && actor.get_name() === 'dashtodockDashContainer')
        return actor;
    for (const child of actor.get_children()) {
        const found = findDash(child);
        if (found)
            return found;
    }
    return null;
}

/**
 * The "top bar in the dock" mode: while a Dash to Dock dock runs along the top or bottom of a monitor, the top
 * bar's buttons sit in it, on both sides of the apps, and the top bars are hidden. The buttons keep their menus.
 * Without such a dock the buttons are in the top bar, which shows.
 *
 * There is one set of buttons. With docks on several monitors they are in one of them, the host, and move into a
 * dock as the pointer comes onto its ends. The other docks show clones.
 */
export class DockBarManager {
    _settings;
    _logger;
    _slots = [];
    _host = null;
    _origins = new Map();
    _menus = new Map();
    // The button containers hidden by the "left out" setting.
    _hiddenByUs = new Set();
    // The top bars' boxes held hidden, with the handler that hides each again.
    _held = new Map();
    _disconnects = [];
    _idleId = 0;
    _timeoutId = 0;
    _syncIdleId = 0;
    _closeIdleId = 0;
    _moveLaterId = 0;
    _frameSyncId = 0;
    _frameSignalId = 0;
    // The dash that was told a menu is open, until it is told the menu closed.
    _announcedDash = null;
    _syncing = false;
    _quickSettings = null;
    _style;
    // The theme's text color in the top bar, "r, g, b", read again after a theme change.
    _textRgb = null;
    // The border widths and color the stylesheet was last written for.
    _styleKey = '';

    constructor(_settings, _logger) {
        this._settings = _settings;
        this._logger = _logger;
        this._style = new GeneratedStylesheet('liquid-glass-dock-bar.css', _logger);
    }

    get _panelBoxes() {
        const panel = Main.panel;
        return [panel._leftBox, panel._centerBox, panel._rightBox];
    }

    setup() {
        const uiGroup = Main.layoutManager.uiGroup;
        const connect = (target, signal, handler) => {
            const id = target.connect(signal, handler);
            this._disconnects.push(() => target.disconnect(id));
        };
        for (const signal of ['child-added', 'child-removed'])
            connect(uiGroup, signal, () => this._schedule());
        // The shell destroys uiGroup on shutdown without disabling extensions.
        connect(uiGroup, 'destroy', () => this.cleanup());
        // Other extensions add buttons to the top bar at any time, and some put theirs back in it.
        for (const box of this._panelBoxes)
            connect(box, 'child-added', () => this._queueSync());
        connect(this._settings, 'changed::top-bar-in-dock', () => this._scan(true));
        connect(this._settings, 'changed::dock-bar-order', () => this._syncButtons());
        connect(this._settings, 'changed::dock-bar-hidden', () => this._syncButtons());
        connect(Main.extensionManager, 'extension-state-changed', () => this._schedule());
        connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => {
            this._textRgb = null;
            this._styleKey = '';
        });
        this._scan(true);
    }

    _schedule() {
        if (!this._idleId) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idleId = 0;
                this._scan(false);
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_MS, () => {
            this._timeoutId = 0;
            this._scan(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    // `final` says no dock is on its way: without one, the top bar comes back.
    _scan(final) {
        const wanted = this._settings.get_boolean('top-bar-in-dock');
        const found = new Map();
        if (wanted) {
            for (const root of Main.layoutManager.uiGroup.get_children()) {
                if (!(root instanceof St.Widget) || root.get_name() !== 'dashtodockContainer')
                    continue;
                if (!root.has_style_class_name('top') && !root.has_style_class_name('bottom'))
                    continue;
                const container = findDash(root);
                if (container && isActorValid(container.get_parent()))
                    found.set(container, root);
            }
        }
        for (const slot of [...this._slots])
            if (!found.has(slot.container))
                this._removeSlot(slot);
        for (const [container, root] of found)
            if (!this._slots.some(slot => slot.container === container))
                this._addSlot(root, container);
        if (this._slots.length > 0) {
            const primary = Main.layoutManager.primaryIndex;
            this._host ??= this._slots.find(slot => (slot.root.monitorIndex ?? primary) === primary) ?? this._slots[0];
            this._holdTopBars(true);
            this._syncButtons();
            startSyncLoop(this._frameSignalSlot, this._frameSlot, {
                alive: () => this._slots.length > 0,
                honourFreeze: false,
                errorTag: 'DockBarManager',
                step: () => this._frame(),
            });
        }
        else {
            this._restoreAll();
            if (final || !wanted) {
                this._holdTopBars(false);
                this._style.set(null);
                this._styleKey = '';
            }
        }
    }

    _addSlot(root, container) {
        const box = (side) => new St.BoxLayout({
            style_class: `${DOCK_BAR_CLASS} ${side}`,
            // Set, so the buttons' own wish to expand does not reach the dock.
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            reactive: true,
            track_hover: true,
        });
        const slot = { root, container, dash: container.get_parent(), left: box('left'), right: box('right') };
        for (const end of [slot.left, slot.right]) {
            // Not from inside the crossing event: Clutter is still picking the actors that would move.
            end.connect('notify::hover', () => {
                if (end.hover && slot !== this._host)
                    this._queueMove();
            });
            // Dash to Dock tears its docks down on settings and monitor changes. Handlers run before Clutter destroys
            // the children, so the buttons are back in the top bar before they would go with the dock.
            end.connect('destroy', () => this._onSlotDestroyed(slot));
        }
        container.insert_child_at_index(slot.left, 0);
        container.add_child(slot.right);
        this._slots.push(slot);
    }

    _onSlotDestroyed(slot) {
        const index = this._slots.indexOf(slot);
        if (index < 0)
            return;
        this._slots.splice(index, 1);
        if (slot === this._host) {
            // The dock is going: there is nothing left to tell it.
            if (this._announcedDash === slot.dash)
                this._announcedDash = null;
            this._restoreAll();
            this._host = null;
        }
        this._schedule();
    }

    _removeSlot(slot) {
        const index = this._slots.indexOf(slot);
        if (index < 0)
            return;
        this._slots.splice(index, 1);
        if (slot === this._host) {
            this._restoreAll();
            this._host = null;
        }
        for (const end of [slot.left, slot.right])
            if (isActorValid(end))
                end.destroy();
    }

    // Hides every top bar along the top or bottom of a monitor, the shell's and those other extensions build for
    // further monitors, or lets them show again.
    _holdTopBars(hold) {
        const boxes = new Set();
        if (hold) {
            for (const box of Main.layoutManager.uiGroup.get_children()) {
                if (!(box instanceof St.Widget))
                    continue;
                // Multi Monitors Bar marks the bars it puts along a side of the screen, which are left alone.
                if (box.get_children().some(child => isTopBar(child) && !child.has_style_class_name('multimonitor-panel-vertical')))
                    boxes.add(box);
            }
        }
        for (const [box, id] of [...this._held]) {
            if (boxes.has(box))
                continue;
            this._held.delete(box);
            if (!isActorValid(box))
                continue;
            box.disconnect(id);
            box.show();
        }
        for (const box of boxes) {
            if (this._held.has(box))
                continue;
            // The shell shows the bar's box again after a fullscreen window, and Hide Top Bar on edge pressure.
            this._held.set(box, box.connect('notify::visible', () => {
                if (box.visible)
                    box.hide();
            }));
            box.hide();
        }
    }

    // child-added comes from inside the panel's own code, which goes on with the button.
    _queueSync() {
        if (this._syncIdleId || !this._host)
            return;
        this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncIdleId = 0;
            this._syncButtons();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Takes every button the top bar has into the host dock and puts them in the set order. Moving a button makes
    // the top bar report a new child, which would start this again.
    _syncButtons() {
        const host = this._host;
        if (!host || this._syncing)
            return;
        this._syncing = true;
        try {
            const entries = this._takeButtons(host);
            const saved = this._settings.get_strv('dock-bar-order');
            const order = dockBarOrder(saved, entries.map(entry => ({ ...entry, index: this._origins.get(entry.container).index })));
            if (order.length !== saved.length)
                this._settings.set_strv('dock-bar-order', order);
            const { left, right } = splitDockBar(order, entries);
            this._fill(host.left, left);
            this._fill(host.right, right);
            this._hideLeftOut(entries);
            this._centerQuickSettings();
            this._syncClones();
        }
        finally {
            this._syncing = false;
        }
    }

    _takeButtons(host) {
        const dockTray = Main.extensionManager.lookup(DOCK_TRAY_UUID)?.state === ACTIVE;
        const panelBoxes = this._panelBoxes;
        const entries = [];
        // Where each is in the top bar, read before any of them leaves it.
        const places = new Map();
        for (const box of panelBoxes)
            box.get_children().forEach((child, index) => places.set(child, index));
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            const container = indicator?.container;
            if (!container || !isActorValid(container))
                continue;
            const parent = container.get_parent();
            if (parent && panelBoxes.includes(parent)) {
                if (dockTray && role.startsWith(TRAY_ROLE))
                    continue;
                const destroyId = this._origins.get(container)?.destroyId ??
                    container.connect('destroy', () => this._origins.delete(container));
                this._origins.set(container, {
                    parent,
                    index: places.get(container),
                    side: parent === panelBoxes[0] ? 'left' : 'right',
                    destroyId,
                });
                parent.remove_child(container);
                this._trackMenu(indicator);
            }
            else if (!this._origins.has(container)) {
                continue;
            }
            else if (parent && parent !== host.left && parent !== host.right) {
                // Another extension took it out of the dock: it is theirs now.
                this._forget(container, indicator);
                continue;
            }
            entries.push({ role, container, side: this._origins.get(container).side });
        }
        return entries;
    }

    _fill(box, entries) {
        entries.forEach(({ container }, i) => {
            const parent = container.get_parent();
            if (parent !== box) {
                parent?.remove_child(container);
                box.add_child(container);
            }
            box.set_child_at_index(container, i);
        });
    }

    // Hides the buttons the settings leave out, and shows again those that are back in. A button that hides itself,
    // as the keyboard layout's does with one layout, is not touched.
    _hideLeftOut(entries) {
        const leftOut = this._settings.get_strv('dock-bar-hidden');
        for (const { role, container } of entries) {
            if (leftOut.includes(role)) {
                if (container.visible) {
                    this._hiddenByUs.add(container);
                    container.hide();
                }
            }
            else if (this._hiddenByUs.delete(container)) {
                container.show();
            }
        }
    }

    // Quick settings opens from its button's left edge and counts on the screen edge to push it back. In the dock
    // it would hang past the dock's end, so there it opens centered on its button.
    _centerQuickSettings() {
        const indicator = Main.panel.statusArea.quickSettings;
        if (this._quickSettings || !indicator || !this._inDock(indicator))
            return;
        const menu = indicator.menu;
        this._quickSettings = { menu, alignment: menu._arrowAlignment };
        menu._arrowAlignment = 0.5;
    }

    _uncenterQuickSettings() {
        if (!this._quickSettings)
            return;
        const { menu, alignment } = this._quickSettings;
        this._quickSettings = null;
        menu._arrowAlignment = alignment;
    }

    _forget(container, indicator) {
        const origin = this._origins.get(container);
        if (!origin)
            return;
        this._origins.delete(container);
        container.disconnect(origin.destroyId);
        this._untrackMenu(indicator);
    }

    // Puts every button back where it was in the top bar, in the top bar's order.
    _restoreAll() {
        this._endMenu();
        this._uncenterQuickSettings();
        const ours = new Set(this._slots.flatMap(slot => [slot.left, slot.right]));
        if (this._host) {
            ours.add(this._host.left);
            ours.add(this._host.right);
        }
        for (const container of this._hiddenByUs)
            if (isActorValid(container))
                container.show();
        this._hiddenByUs.clear();
        const origins = [...this._origins].sort(([, a], [, b]) => a.index - b.index);
        this._origins.clear();
        for (const [container, origin] of origins) {
            if (!isActorValid(container))
                continue;
            container.disconnect(origin.destroyId);
            const parent = container.get_parent();
            // Elsewhere, another extension has it.
            if (parent && !ours.has(parent))
                continue;
            parent?.remove_child(container);
            const home = isActorValid(origin.parent) ? origin.parent : this._panelBoxes[2];
            home.insert_child_at_index(container, Math.min(origin.index, home.get_n_children()));
        }
        for (const indicator of [...this._menus.keys()])
            this._untrackMenu(indicator);
        // The clones' buttons are gone from the dock.
        for (const slot of this._slots) {
            if (slot === this._host)
                continue;
            for (const end of [slot.left, slot.right])
                if (isActorValid(end))
                    end.destroy_all_children();
        }
    }

    // Every dock but the host shows a clone of each button, in the same order.
    _syncClones() {
        const host = this._host;
        if (!host)
            return;
        for (const slot of this._slots) {
            if (slot === host)
                continue;
            for (const side of SIDES) {
                slot[side].destroy_all_children();
                for (const container of host[side].get_children()) {
                    const button = container.child;
                    if (!button)
                        continue;
                    const clone = new Clutter.Clone({ source: button, y_align: Clutter.ActorAlign.FILL });
                    // A hidden button leaves no gap in the other docks either.
                    const update = () => { clone.visible = container.visible && button.visible; };
                    const watched = [container, button].map(actor => [actor, actor.connect('notify::visible', update)]);
                    clone.connect('destroy', () => {
                        for (const [actor, id] of watched)
                            if (isActorValid(actor))
                                actor.disconnect(id);
                    });
                    update();
                    slot[side].add_child(clone);
                }
            }
        }
    }

    _queueMove() {
        if (this._moveLaterId)
            return;
        this._moveLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._moveLaterId = 0;
            const hovered = this._slots.find(slot => slot.left.hover || slot.right.hover);
            if (hovered)
                this._moveTo(hovered);
            return GLib.SOURCE_REMOVE;
        });
    }

    _moveTo(slot) {
        const from = this._host;
        // A menu stays with its button: the buttons are not pulled from under an open one.
        if (!from || slot === from || !this._slots.includes(slot) || this._menuOpen())
            return;
        for (const side of SIDES) {
            slot[side].destroy_all_children();
            for (const container of from[side].get_children()) {
                from[side].remove_child(container);
                slot[side].add_child(container);
            }
        }
        this._host = slot;
        this._syncClones();
    }

    _inDock(indicator) {
        const host = this._host;
        const container = indicator.container;
        return !!host && isActorValid(container) && (host.left.contains(container) || host.right.contains(container));
    }

    _menuOpen() {
        return [...this._menus].some(([indicator, { menu }]) => menu.isOpen && this._inDock(indicator));
    }

    _trackMenu(indicator) {
        if (this._menus.has(indicator) || !(indicator.menu instanceof PopupMenu.PopupMenu))
            return;
        const menu = indicator.menu;
        // The menu manager grabs the pointer as the menu opens, before any open-state-changed handler runs. The dock
        // then sees the pointer leave and starts hiding, which telling it about the menu afterwards does not stop. So
        // it is told before the menu opens, as Dash to Dock does for its app icons' menus.
        const ownOpen = Object.hasOwn(menu, 'open') ? menu.open : undefined;
        const open = menu.open;
        menu.open = (...args) => {
            if (!menu.isOpen && this._inDock(indicator)) {
                // The menus were added to uiGroup before the dock was: they go above it.
                Main.layoutManager.uiGroup.set_child_above_sibling(menu.actor, null);
                this._announceMenu();
            }
            const result = open.apply(menu, args);
            if (!menu.isOpen)
                this._queueMenuClosed();
            return result;
        };
        const entry = { menu, ownOpen, lastY: null, id: 0, destroyId: 0 };
        entry.id = menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!this._inDock(indicator))
                return;
            entry.lastY = null;
            if (isOpen)
                this._announceMenu();
            else
                this._queueMenuClosed();
            return undefined;
        });
        entry.destroyId = indicator.connect('destroy', () => this._menus.delete(indicator));
        this._menus.set(indicator, entry);
    }

    _untrackMenu(indicator) {
        const entry = this._menus.get(indicator);
        if (!entry)
            return;
        this._menus.delete(indicator);
        indicator.disconnect(entry.destroyId);
        entry.menu.disconnect(entry.id);
        if (entry.ownOpen)
            entry.menu.open = entry.ownOpen;
        else
            delete entry.menu.open;
    }

    // Keeps a dock that hides by itself shown while one of the menus is open.
    _announceMenu() {
        if (this._closeIdleId) {
            GLib.Source.remove(this._closeIdleId);
            this._closeIdleId = 0;
        }
        const dash = this._host?.dash;
        if (this._announcedDash || !dash || !isActorValid(dash))
            return;
        this._announcedDash = dash;
        dash.emit('menu-opened');
    }

    // Lets the dock hide again once no menu is open. Going from one button to the next closes a menu and opens
    // another, and the dock must not start hiding in between: this waits for an idle.
    _queueMenuClosed() {
        if (this._closeIdleId || !this._announcedDash)
            return;
        this._closeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._closeIdleId = 0;
            if (!this._menuOpen()) {
                this._endMenu();
                // The pointer may have gone to another dock while the menu held it.
                this._queueMove();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _endMenu() {
        if (this._closeIdleId) {
            GLib.Source.remove(this._closeIdleId);
            this._closeIdleId = 0;
        }
        const dash = this._announcedDash;
        this._announcedDash = null;
        if (dash && isActorValid(dash))
            dash.emit('menu-closed');
    }

    _frame() {
        for (const { container, left, right } of this._slots) {
            if (!isActorValid(container))
                continue;
            // Dash to Dock and Dock Tray put theirs at the ends too.
            if (container.get_first_child() !== left)
                container.set_child_below_sibling(left, null);
            if (container.get_last_child() !== right)
                container.set_child_above_sibling(right, null);
        }
        if (!this._host)
            return;
        this._fitHighlight(this._host);
        // A menu opened by a shortcut while the dock was hidden was placed off its button, which then slides in.
        for (const [indicator, entry] of this._menus) {
            if (!entry.menu.isOpen || !this._inDock(indicator))
                continue;
            const [, y] = indicator.get_transformed_position();
            if (entry.lastY !== null && y !== entry.lastY)
                entry.menu._boxPointer.setPosition(entry.menu.sourceActor, entry.menu._arrowAlignment);
            entry.lastY = y;
        }
    }

    // The apps set the dock's thickness, whatever the buttons need.
    _fitHighlight(host) {
        const apps = host.container.get_children().find(child => child.get_name() === 'dashtodockDashScrollview');
        const thickness = apps ? apps.get_preferred_height(-1)[1] : 0;
        if (!(thickness > 0))
            return;
        const logical = thickness / St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const border = (pill) => Math.max(MIN_BORDER, Math.round((logical - pill) / 2));
        if (!this._textRgb) {
            const color = Main.panel.get_theme_node().get_foreground_color();
            this._textRgb = `${color.red}, ${color.green}, ${color.blue}`;
        }
        const key = `${border(PILL)},${border(INDICATOR_PILL)},${this._textRgb}`;
        if (key === this._styleKey)
            return;
        this._styleKey = key;
        this._style.set(dockBarCss(border(PILL), border(INDICATOR_PILL), this._textRgb));
    }

    cleanup() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        for (const key of ['_idleId', '_timeoutId', '_syncIdleId']) {
            if (this[key])
                GLib.Source.remove(this[key]);
            this[key] = 0;
        }
        if (this._moveLaterId)
            global.compositor.get_laters().remove(this._moveLaterId);
        this._moveLaterId = 0;
        for (const disconnect of this._disconnects)
            disconnect();
        this._disconnects = [];
        for (const slot of [...this._slots])
            this._removeSlot(slot);
        this._restoreAll();
        this._holdTopBars(false);
        this._style.cleanup();
    }

    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
