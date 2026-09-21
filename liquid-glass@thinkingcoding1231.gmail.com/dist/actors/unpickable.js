import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
/**
 * A Clutter.Clone whose pick pass is a no-op, so Looking Glass's actor
 * picker sees through it to whatever is behind.
 */
export const UnpickableClone = GObject.registerClass(class UnpickableClone extends Clutter.Clone {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking.
    }
});
/**
 * A plain container actor with the same "invisible to picking" behavior as
 * UnpickableClone. Uses Clutter.Actor rather than St.Widget to avoid St's
 * CSS/theming padding interfering with pixel-precise layout.
 */
export const UnpickableActor = GObject.registerClass(class UnpickableActor extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking.
    }
});
/**
 * An St.Widget that never responds to picking, used purely to re-paint some
 * other widget's THEME BACKGROUND (background color / gradient / border-image
 * / border-radius) somewhere else.
 *
 * Copying the source widget's style class onto a bare widget makes St resolve
 * and paint exactly the same background material, without cloning — and
 * therefore without dragging the source's children (labels, icons, ...) along
 * with it, which is what a Clutter.Clone or a stage snapshot would do.
 *
 * Caveat: only selectors that match on the class itself apply; a rule written
 * as a descendant selector against the real widget's ancestry will not.
 */
export const UnpickableStyledWidget = GObject.registerClass(class UnpickableStyledWidget extends St.Widget {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking.
    }
});
/**
 * [FIX-5] "Quick Settings turns into a full-screen dark rectangle, Toggles
 * show nothing" the moment bgActor became a child of animActor (a real
 * St.BoxLayout, used for the actual quick-settings grid).
 *
 * Root cause: unlike a plain Clutter.Actor (which — absent an explicit
 * LayoutManager — does NOT roll its children's sizes into its own reported
 * preferred size; this is exactly why bgActor's own many manually-sized
 * descendants, or bgActor itself sitting under uiGroup, never caused any
 * such ballooning before), St.BoxLayout DOES actively query each direct
 * child's own get_preferred_width()/height() and stacks/sums them to
 * compute ITS OWN size. bgActor has an EXPLICIT fixed size set on it
 * directly (set_size(screenW, screenH) — see _syncToggleRegions()/
 * resolution-update code), and an actor's own explicitly-set size is
 * exactly what get_preferred_width()/height() reports back to a querying
 * parent, regardless of any layout manager. So animActor's BoxLayout was
 * faithfully doing its job: stacking a "child" that claims to want
 * 1920x1080, on top of the real ~1920x198 toggle content — hence the
 * ballooned (1958x1316) allocation and the screen-covering dark panel.
 *
 * Fix: LayoutOpaqueActor unconditionally reports (0,0) for both min and
 * natural size in both dimensions, no matter what its own children (e.g.
 * bgActor) request. A querying parent's LayoutManager takes exactly what
 * get_preferred_width()/height() returns as authoritative — it never looks
 * past that return value into the subtree — so this is a hard, guaranteed
 * "don't count anything below me towards your own size" boundary, usable
 * to wrap any actor (like bgActor) that must be dropped into a real
 * layout-managed container (like animActor) purely for z-order, with its
 * own geometry fully hand-managed instead of participating in that
 * container's size negotiation. Its own on-screen ORIGIN (x,y) still comes
 * from wherever the parent's layout manager decides to place a 0-sized
 * child — callers reposition it explicitly every frame regardless (see
 * quickSettingsManager.ts's animActor counter-transform), so that's fine.
 */
export const LayoutOpaqueActor = GObject.registerClass(class LayoutOpaqueActor extends UnpickableActor {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});
/**
 * St.Widget variant of the same "invisible to picking" behavior, for cases
 * that need St's styling/layout features.
 */
export const UnpickableWidget = GObject.registerClass(class UnpickableWidget extends St.Widget {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking.
    }
});
