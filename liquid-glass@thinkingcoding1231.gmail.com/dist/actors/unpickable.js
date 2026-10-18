"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LayoutOpaqueActor = exports.UnpickableWidget = exports.UnpickableActor = void 0;
const 1 = __importDefault(require("gi://GObject"));
const 2 = __importDefault(require("gi://Clutter"));
const 3 = __importDefault(require("gi://Shell"));
const 4 = __importDefault(require("gi://St"));
// Helper actors layered around real shell UI. They are hidden from picking so
// that pointer events and Looking Glass's picker reach the real actors
// instead.
// A plain Clutter.Actor rather than an St.Widget, so no theme padding gets in
// the way of pixel-exact layout.
exports.UnpickableActor = 1.default.registerClass(class UnpickableActor extends 2.default.Actor {
    _init(params = {}) {
        super._init(params);
        3.default.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
    }
});
/**
 * An St.Widget for the cases that need St styling. Giving it another widget's
 * style class makes St paint that widget's theme background (color, border,
 * radius) without cloning the widget and its children. Only selectors that
 * match the class itself apply, not descendant selectors.
 */
exports.UnpickableWidget = 1.default.registerClass(class UnpickableWidget extends 4.default.Widget {
    _init(params = {}) {
        super._init(params);
        3.default.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
    }
});
/**
 * Reports a preferred size of 0x0 whatever its children want, so an actor
 * with an explicit monitor-sized size can sit inside a layout container (for
 * z-order) without growing it. St.BoxLayout sums its children's preferred
 * sizes, and a full-screen child made Quick Settings cover the screen. The
 * caller positions it explicitly.
 */
exports.LayoutOpaqueActor = 1.default.registerClass(class LayoutOpaqueActor extends exports.UnpickableActor {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});
