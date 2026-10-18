import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
// Helper actors layered around real shell UI. They are hidden from picking so
// that pointer events and Looking Glass's picker reach the real actors
// instead.
// A plain Clutter.Actor rather than an St.Widget, so no theme padding gets in
// the way of pixel-exact layout.
export const UnpickableActor = GObject.registerClass(class UnpickableActor extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
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
export const UnpickableWidget = GObject.registerClass(class UnpickableWidget extends St.Widget {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
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
export const LayoutOpaqueActor = GObject.registerClass(class LayoutOpaqueActor extends UnpickableActor {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});
