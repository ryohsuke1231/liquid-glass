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
exports.EditFrame = void 0;
exports.itemRect = itemRect;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const 2 = __importDefault(require("gi://Clutter"));
const 3 = __importDefault(require("gi://Shell"));
const 4 = __importDefault(require("gi://St"));
const lifecycle_js_1 = require("../actors/lifecycle.js");
const shellVersion_js_1 = require("../shellVersion.js");
const guides_js_1 = require("./guides.js");
const placement_js_1 = require("./placement.js");
// Room between the item and its frame, px.
const FRAME_GAP = 8;
const HANDLE_SIZE = 14;
// How far (px) from a handle's center a press still takes it.
const HANDLE_REACH = 12;
// The smallest the frame can be resized to, px.
const MIN_SIZE = 48;
// A moved item this near (px) to a guide goes onto it.
const SNAP_REACH = 6;
// How thick a guide is drawn, and how long the ticks at the ends of a gap are, px.
const GUIDE_WIDTH = 2;
const GAP_TICK = 9;
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

class EditFrame {
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
    // Drawn guides, reused from one move to the next, and what each one shows.
    _guideActors = [];
    _guides = [];
    constructor(item, _callbacks) {
        this.item = item;
        this._callbacks = _callbacks;
        this._layer = new 4.default.Widget({ name: 'liquid-glass-edit', reactive: true, x: 0, y: 0 });
        this._layer.set_size(global.stage.width, global.stage.height);
        this._frame = new 4.default.Widget({ style_class: 'liquid-glass-edit-frame', reactive: true });
        (0, shellVersion_js_1.setHoverCursor)(this._frame, 'move');
        this._layer.add_child(this._frame);
        if (_callbacks.resized) {
            for (const [, , cursor] of HANDLES) {
                const handle = new 4.default.Widget({ style_class: 'liquid-glass-edit-handle', reactive: true,
                    width: HANDLE_SIZE, height: HANDLE_SIZE });
                (0, shellVersion_js_1.setHoverCursor)(handle, cursor);
                this._layer.add_child(handle);
                this._handles.push(handle);
            }
        }
        this._done = new 4.default.Button({ style_class: 'liquid-glass-edit-done', label: 'Done', can_focus: true });
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
            if (key !== 2.default.KEY_Escape && key !== 2.default.KEY_Return && key !== 2.default.KEY_KP_Enter)
                return 2.default.EVENT_PROPAGATE;
            this.end();
            return 2.default.EVENT_STOP;
        });
    }
    get dragging() {
        return this._drag !== null;
    }
    start() {
        Main.layoutManager.uiGroup.add_child(this._layer);
        this._grab = Main.pushModal(this._layer, { actionMode: 3.default.ActionMode.POPUP });
        this.sync();
    }
    // The frame round the item, or round the size it is being resized to.
    _frameRect() {
        const r = this._resizing ?? itemRect(this.item);
        const g = FRAME_GAP;
        return { x: r.x - g, y: r.y - g, width: r.width + g * 2, height: r.height + g * 2 };
    }
    _handleCenter(f, hx, hy) {
        return [f.x + (hx + 1) / 2 * f.width, f.y + (hy + 1) / 2 * f.height];
    }
    sync() {
        const f = this._frameRect();
        this._frame.set_position(Math.round(f.x), Math.round(f.y));
        this._frame.set_size(Math.round(f.width), Math.round(f.height));
        const half = HANDLE_SIZE / 2;
        HANDLES.forEach(([hx, hy], i) => {
            const [cx, cy] = this._handleCenter(f, hx, hy);
            this._handles[i]?.set_position(Math.round(cx - half), Math.round(cy - half));
        });
        const [, doneW] = this._done.get_preferred_width(-1);
        const [, doneH] = this._done.get_preferred_height(doneW);
        this._done.set_position(...(0, placement_js_1.placeBeside)(f, [doneW, doneH], HANDLE_SIZE, this._workArea(f), this._docks()));
    }
    _showGuides(guides) {
        this._guides = guides;
        while (this._guideActors.length < guides.length) {
            const actor = new 4.default.DrawingArea({ style_class: 'liquid-glass-edit-guide' });
            const index = this._guideActors.length;
            actor.connect('repaint', () => this._drawGuide(actor, this._guides[index]));
            this._layer.insert_child_below(actor, this._frame);
            this._guideActors.push(actor);
        }
        this._guideActors.forEach((actor, i) => {
            const g = guides[i];
            actor.visible = !!g;
            if (!g)
                return;
            const thick = g.kind === 'spacing' ? GAP_TICK : GUIDE_WIDTH;
            const at = Math.round(g.at - thick / 2), from = Math.round(g.from), length = Math.max(Math.round(g.to - g.from), 1);
            if (g.vertical) {
                actor.set_position(at, from);
                actor.set_size(thick, length);
            }
            else {
                actor.set_position(from, at);
                actor.set_size(length, thick);
            }
            actor.queue_repaint();
        });
    }
    // A dotted line along the guide; a gap also gets a tick across each end.
    _drawGuide(actor, g) {
        if (!g)
            return;
        const cr = actor.get_context();
        const [w, h] = actor.get_surface_size();
        const color = actor.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        cr.setLineWidth(GUIDE_WIDTH);
        const [long, across] = g.vertical ? [h, w] : [w, h];
        const line = (a0, b0, a1, b1) => {
            if (g.vertical) {
                cr.moveTo(b0, a0);
                cr.lineTo(b1, a1);
            }
            else {
                cr.moveTo(a0, b0);
                cr.lineTo(a1, b1);
            }
        };
        if (g.kind === 'spacing') {
            line(GUIDE_WIDTH / 2, 0, GUIDE_WIDTH / 2, across);
            line(long - GUIDE_WIDTH / 2, 0, long - GUIDE_WIDTH / 2, across);
            cr.stroke();
        }
        cr.setDash([4, 4], 0);
        line(0, across / 2, long, across / 2);
        cr.stroke();
        cr.$dispose();
    }
    // The work area of the monitor the frame's center is on.
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
            const [cx, cy] = this._handleCenter(f, HANDLES[i][0], HANDLES[i][1]);
            if (Math.abs(x - cx) <= HANDLE_REACH && Math.abs(y - cy) <= HANDLE_REACH)
                return [HANDLES[i][0], HANDLES[i][1]];
        }
        return x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height ? [0, 0] : null;
    }
    _press(event) {
        if (event.get_button() !== 2.default.BUTTON_PRIMARY)
            return 2.default.EVENT_STOP;
        const [x, y] = event.get_coords();
        const hit = this._hit(x, y);
        if (!hit) {
            this.end();
            return 2.default.EVENT_STOP;
        }
        this._drag = { start: [x, y], origin: itemOrigin(this.item), rect: itemRect(this.item), hx: hit[0], hy: hit[1] };
        return 2.default.EVENT_STOP;
    }
    _motion(event) {
        const drag = this._drag;
        if (!drag)
            return 2.default.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - drag.start[0], dy = y - drag.start[1];
        if (drag.hx === 0 && drag.hy === 0) {
            const [px, py] = this.item.actor.get_parent().get_transformed_position();
            const moved = { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy };
            const snap = (0, guides_js_1.snapMove)(moved, this._callbacks.others(), this._workArea(moved), SNAP_REACH);
            this.item.actor.set_position(Math.round(drag.origin[0] + dx + snap.dx - px), Math.round(drag.origin[1] + dy + snap.dy - py));
            this._showGuides(snap.guides);
        }
        else {
            this._resizing = (0, placement_js_1.resizeRect)(drag.rect, drag.hx, drag.hy, dx, dy, MIN_SIZE);
        }
        this.sync();
        return 2.default.EVENT_STOP;
    }
    _release(event) {
        const drag = this._drag;
        if (!drag || event.get_button() !== 2.default.BUTTON_PRIMARY)
            return 2.default.EVENT_PROPAGATE;
        this._drag = null;
        this._showGuides([]);
        const resized = this._resizing;
        this._resizing = null;
        if (resized)
            this._callbacks.resized?.(drag.rect, resized);
        else
            this._callbacks.moved(...itemOrigin(this.item));
        this.sync();
        return 2.default.EVENT_STOP;
    }
    /** Takes the frame away. */
    end() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if ((0, lifecycle_js_1.isActorValid)(this._layer))
            this._layer.destroy();
        (0, shellVersion_js_1.resetHoverCursor)();
        this._callbacks.ended();
    }
}
exports.EditFrame = EditFrame;
// An item's top left corner, stage coordinates. Its x and y, not its
// allocation, which lags a frame behind a new position.

function itemOrigin(item) {
    const [px, py] = item.actor.get_parent().get_transformed_position();
    return [px + item.actor.x, py + item.actor.y];
}
/** An item's shown part, stage coordinates. */

function itemRect(item) {
    const [x, y] = itemOrigin(item);
    const [bx, by, width, height] = item.bounds();
    return { x: x + bx, y: y + by, width, height };
}
