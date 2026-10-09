import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { isActorValid } from '../actors/lifecycle.js';
import { resetHoverCursor, setHoverCursor } from '../shellVersion.js';
import { placeBeside, resizeRect } from './placement.js';
// Room between the item and its frame, px.
const FRAME_GAP = 8;
const HANDLE_SIZE = 14;
// How far (px) from a handle's centre a press still takes it.
const HANDLE_REACH = 12;
// The smallest the frame can be resized to, px.
const MIN_SIZE = 48;
// The handles: which edges each one moves, and its cursor.
const HANDLES = [
    [-1, -1, 'nw'], [0, -1, 'n'], [1, -1, 'ne'], [1, 0, 'e'],
    [1, 1, 'se'], [0, 1, 's'], [-1, 1, 'sw'], [-1, 0, 'w'],
];

/**
 * A blue frame round a desktop item, over everything else, that moves the
 * item when dragged and resizes it by its handles (when `resized` is given).
 * It holds the pointer and keyboard until Escape, Enter, the Done button or
 * a click outside it.
 */
export class EditFrame {
    item;
    _callbacks;
    _layer;
    _frame;
    _handles = [];
    _done;
    _grab = null;
    _drag = null;
    // The frame being resized, while it is.
    _resizing = null;

    constructor(item, _callbacks) {
        this.item = item;
        this._callbacks = _callbacks;
        this._layer = new St.Widget({ name: 'liquid-glass-edit', reactive: true, x: 0, y: 0 });
        this._layer.set_size(global.stage.width, global.stage.height);
        this._frame = new St.Widget({ style_class: 'liquid-glass-edit-frame', reactive: true });
        setHoverCursor(this._frame, 'move');
        this._layer.add_child(this._frame);
        if (_callbacks.resized) {
            for (const [, , cursor] of HANDLES) {
                const handle = new St.Widget({ style_class: 'liquid-glass-edit-handle', reactive: true,
                    width: HANDLE_SIZE, height: HANDLE_SIZE });
                setHoverCursor(handle, cursor);
                this._layer.add_child(handle);
                this._handles.push(handle);
            }
        }
        this._done = new St.Button({ style_class: 'liquid-glass-edit-done', label: 'Done', can_focus: true });
        this._done.connect('clicked', () => this.end());
        this._layer.add_child(this._done);
        // Presses are told apart by where they are, not by the actor they reach:
        // the actor under the pointer is only looked up again when the stage is
        // redrawn, and the handles move with the item.
        this._layer.connect('button-press-event', (_a, event) => this._press(event));
        this._layer.connect('motion-event', (_a, event) => this._motion(event));
        this._layer.connect('button-release-event', (_a, event) => this._release(event));
        this._layer.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_Escape && key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;
            this.end();
            return Clutter.EVENT_STOP;
        });
    }

    get dragging() {
        return this._drag !== null;
    }

    start() {
        Main.layoutManager.uiGroup.add_child(this._layer);
        this._grab = Main.pushModal(this._layer, { actionMode: Shell.ActionMode.POPUP });
        this.sync();
    }

    // The item's top left corner, stage coordinates. Its x and y, not its
    // allocation, which lags a frame behind a new position.
    _itemOrigin() {
        const [px, py] = this.item.actor.get_parent().get_transformed_position();
        return [px + this.item.actor.x, py + this.item.actor.y];
    }

    // The item's shown part, stage coordinates.
    _itemRect() {
        const [x, y] = this._itemOrigin();
        const [bx, by, width, height] = this.item.bounds();
        return { x: x + bx, y: y + by, width, height };
    }

    // The frame round the item, or round the size it is being resized to.
    _frameRect() {
        const r = this._resizing ?? this._itemRect();
        const g = FRAME_GAP;
        return { x: r.x - g, y: r.y - g, width: r.width + g * 2, height: r.height + g * 2 };
    }

    _handleCentre(f, hx, hy) {
        return [f.x + (hx + 1) / 2 * f.width, f.y + (hy + 1) / 2 * f.height];
    }

    sync() {
        const f = this._frameRect();
        this._frame.set_position(Math.round(f.x), Math.round(f.y));
        this._frame.set_size(Math.round(f.width), Math.round(f.height));
        const half = HANDLE_SIZE / 2;
        HANDLES.forEach(([hx, hy], i) => {
            const [cx, cy] = this._handleCentre(f, hx, hy);
            this._handles[i]?.set_position(Math.round(cx - half), Math.round(cy - half));
        });
        const [, doneW] = this._done.get_preferred_width(-1);
        const [, doneH] = this._done.get_preferred_height(doneW);
        this._done.set_position(...placeBeside(f, [doneW, doneH], HANDLE_SIZE, this._workArea(f), this._docks()));
    }

    // The work area of the monitor the frame's centre is on.
    _workArea(f) {
        const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
        const layout = Main.layoutManager;
        const monitor = layout.monitors.find(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
        return layout.getWorkAreaForMonitor(monitor?.index ?? layout.primaryIndex);
    }

    // Dash to Dock's docks. One that hides itself leaves the work area as it is
    // but still covers the Done button when it slides in.
    _docks() {
        return Main.layoutManager.uiGroup.get_children()
            .filter(actor => actor.get_name() === 'dashtodockContainer' && actor.visible)
            .map(actor => {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            return { x, y, width, height };
        });
    }

    // What a press at (x, y) takes: the handle there [hx, hy], the frame
    // [0, 0], or nothing.
    _hit(x, y) {
        const f = this._frameRect();
        for (let i = 0; i < this._handles.length; i++) {
            const [cx, cy] = this._handleCentre(f, HANDLES[i][0], HANDLES[i][1]);
            if (Math.abs(x - cx) <= HANDLE_REACH && Math.abs(y - cy) <= HANDLE_REACH)
                return [HANDLES[i][0], HANDLES[i][1]];
        }
        return x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height ? [0, 0] : null;
    }

    _press(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        const hit = this._hit(x, y);
        if (!hit) {
            this.end();
            return Clutter.EVENT_STOP;
        }
        this._drag = { start: [x, y], origin: this._itemOrigin(), rect: this._itemRect(), hx: hit[0], hy: hit[1] };
        return Clutter.EVENT_STOP;
    }

    _motion(event) {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - drag.start[0], dy = y - drag.start[1];
        if (drag.hx === 0 && drag.hy === 0) {
            const [px, py] = this.item.actor.get_parent().get_transformed_position();
            this.item.actor.set_position(Math.round(drag.origin[0] + dx - px), Math.round(drag.origin[1] + dy - py));
        }
        else {
            this._resizing = resizeRect(drag.rect, drag.hx, drag.hy, dx, dy, MIN_SIZE);
        }
        this.sync();
        return Clutter.EVENT_STOP;
    }

    _release(event) {
        const drag = this._drag;
        if (!drag || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        const resized = this._resizing;
        this._resizing = null;
        if (resized)
            this._callbacks.resized?.(drag.rect, resized);
        else
            this._callbacks.moved(...this._itemOrigin());
        this.sync();
        return Clutter.EVENT_STOP;
    }

    /** Takes the frame away. */
    end() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (isActorValid(this._layer))
            this._layer.destroy();
        resetHoverCursor();
        this._callbacks.ended();
    }
}
