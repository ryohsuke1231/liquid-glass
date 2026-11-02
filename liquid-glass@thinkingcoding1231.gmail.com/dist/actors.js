import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
// gjs answers GObject.Object.prototype.toString from the JS wrapper, so it can
// report "(DISPOSED)" without touching the C object. String(actor) is not an
// option: the shell overrides Clutter.Actor.prototype.toString with
// St.describe_actor(), a C call that logs a critical on a disposed actor.
const _gobjectToString = GObject.Object.prototype.toString;

/**
 * Whether an actor is still alive. A disposed wrapper neither throws nor
 * returns undefined in gjs (it logs a critical and returns the property's
 * default), so this is the only reliable test.
 */
export function isActorValid(actor) {
    if (!actor)
        return false;
    const desc = _gobjectToString.call(actor);
    if (desc.includes('(DISPOSED)') || desc.includes('(FINALIZED)'))
        return false;
    // Rejects values that are not actors at all.
    return typeof actor.visible === 'boolean';
}

/**
 * An actor's allocated size. get_size() falls back to the preferred size
 * while a relayout is pending, which the per-frame syncs run into all the
 * time, and an actor sized by constraints prefers 0x0.
 */
export function getAllocatedSize(actor) {
    const box = actor.get_allocation_box();
    const w = box.get_width();
    const h = box.get_height();
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
        return [w, h];
    // Not allocated yet.
    const [sw, sh] = actor.get_size();
    return [sw, sh];
}

/**
 * An actor's on-screen rectangle [x, y, w, h] with every ancestor transform
 * applied. Pairing get_transformed_position() with a size is wrong while an
 * ancestor is scaled (menu open animations, window resizes): the origin is
 * transformed but the size is not. Use this for rects in screen space only.
 */
export function getTransformedRect(actor) {
    const r = actor.get_transformed_extents();
    const x = r.origin.x, y = r.origin.y;
    const w = r.size.width, h = r.size.height;
    if (Number.isFinite(x) && Number.isFinite(y) &&
        Number.isFinite(w) && Number.isFinite(h))
        return [x, y, w, h];
    const [px, py] = actor.get_transformed_position();
    const [aw, ah] = getAllocatedSize(actor);
    return [px, py, aw, ah];
}

export function resolveMonitorGeometry(candidates) {
    const layoutManager = Main.layoutManager;
    for (const actor of candidates) {
        if (!actor || !isActorValid(actor))
            continue;
        const [width, height] = actor.get_size();
        if (!(width > 0 && height > 0))
            continue;
        const index = layoutManager.findIndexForActor(actor);
        if (index >= 0)
            return layoutManager.monitors[index] || layoutManager.primaryMonitor;
    }
    return layoutManager.monitors[layoutManager.primaryIndex] || layoutManager.primaryMonitor;
}

export function getWindowActors() {
    return global.get_window_actors();
}

/**
 * Whether a window above `actor` (which is in the window group) may cover any
 * of the stage rect [x0, y0, x1, y1]. Mutter does not draw the wallpaper and
 * windows under the opaque part of such a window, so the framebuffer there
 * still holds an older frame when `actor` is painted. The opaque region is
 * not known here; the whole window counts. A window that is translucent or
 * has an effect is not culled against.
 */
export function windowMayCover(actor, rect) {
    let top = actor;
    while (top && top.get_parent() !== global.window_group)
        top = top.get_parent();
    if (!top)
        return false;
    for (let above = top.get_next_sibling(); above; above = above.get_next_sibling()) { // loop over all windows above. `for (init, cond, step)`
        if (!(above instanceof Meta.WindowActor) || !above.visible || above.get_paint_opacity() !== 255)
            continue;
        if (above.get_effects().some(effect => effect.enabled))
            continue;
        const box = above.get_transformed_extents();
        const [x, y] = [box.get_x(), box.get_y()];
        if (x < rect[2] && y < rect[3] && x + box.get_width() > rect[0] && y + box.get_height() > rect[1])
            return true;
    }
    return false;
}

// Clutter's transform setters queue a redraw even when the value is
// unchanged, and the per-frame syncs run in before-update, so every redundant
// write would ask for another frame. These helpers write only on change. The
// last written values are kept on the JS side, which is much cheaper than
// reading the GObject properties back.
// global._lgGlass.diffWrites(false) restores unconditional writes.
let _diffWritesEnabled = true;

export function setDiffWritesEnabled(enabled) {
    _diffWritesEnabled = !!enabled;
}

export function isDiffWritesEnabled() {
    return _diffWritesEnabled;
}

// What each actor was last given, per setter.
const _lastWritten = new WeakMap();

// Runs `write` unless `values` equal what the same setter last wrote to the
// actor.
function writeIfChanged(actor, setter, values, write) {
    let written = _lastWritten.get(actor);
    if (!written) {
        written = new Map();
        _lastWritten.set(actor, written);
    }
    const previous = written.get(setter);
    if (_diffWritesEnabled && previous && values.every((value, index) => value === previous[index]))
        return false;
    written.set(setter, values);
    write();
    return true;
}

export function setTranslationIfChanged(actor, x, y) {
    return writeIfChanged(actor, 'translation', [x, y], () => {
        actor.translation_x = x;
        actor.translation_y = y;
    });
}

export function setSizeIfChanged(actor, width, height) {
    return writeIfChanged(actor, 'size', [width, height], () => actor.set_size(width, height));
}

export function setScaleIfChanged(actor, scaleX, scaleY) {
    return writeIfChanged(actor, 'scale', [scaleX, scaleY], () => actor.set_scale(scaleX, scaleY));
}

export function setClipIfChanged(actor, x, y, width, height) {
    return writeIfChanged(actor, 'clip', [x, y, width, height], () => actor.set_clip(x, y, width, height));
}

export function setPositionIfChanged(actor, x, y) {
    return writeIfChanged(actor, 'position', [x, y], () => actor.set_position(x, y));
}

// Clutter can strand an actor without an allocation: if it is unmapped while
// queued for relayout, the stage drops it from the queue but its
// needs_width_request/needs_height_request/needs_allocation flags stay set,
// and clutter_actor_queue_relayout() returns early for exactly that state. A
// stranded ancestor swallows every request from below, so the whole subtree
// keeps painting from stale allocations. clutter_actor_real_map() clears the
// flags, so hide() + show() is the repair available from JS. The functions
// below apply it only after several consecutive stranded frames, since
// has_allocation() is also false while a normal relayout is pending.
const _strandedFrames = new WeakMap();
const STRANDED_FRAMES_BEFORE_RESCUE = 3;
const _windowActorStrandedFrames = new Map();
let _windowActorRescueMode = 'two-stage';
const WINDOW_ACTOR_RESCUE_MODES = ['two-stage', 'remap', 'off'];

export function setWindowActorRescueMode(mode) {
    _windowActorRescueMode =
        WINDOW_ACTOR_RESCUE_MODES.includes(mode) ? mode : 'two-stage';
}

export function getWindowActorRescueMode() {
    return _windowActorRescueMode;
}

/**
 * Rescues a stranded window actor, gentlest option first. Remapping mutter's
 * own window actor interrupts its animations, so the first attempt asks the
 * nearest ancestor that still has an allocation to relayout: its request is
 * not swallowed, and the next relayout allocates the whole subtree.
 *
 * Returns which stage ran ('' for none) so the caller can log them apart.
 */
export function ensureWindowActorAllocated(actor, relayoutFrames, remapFrames) {
    if (!actor)
        return '';
    if (_windowActorRescueMode === 'off')
        return '';
    if (!actor.visible || !actor.mapped || actor.has_allocation()) {
        _windowActorStrandedFrames.delete(actor);
        return '';
    }
    const strandedFor = (_windowActorStrandedFrames.get(actor) ?? 0) + 1;
    _windowActorStrandedFrames.set(actor, strandedFor);
    if (_windowActorRescueMode !== 'remap' && strandedFor === relayoutFrames) {
        // The window group is usually stranded too, so its own queue_relayout()
        // would be dropped the same way.
        let ancestor = actor.get_parent();
        while (ancestor && isActorValid(ancestor) && !ancestor.has_allocation())
            ancestor = ancestor.get_parent();
        if (ancestor && isActorValid(ancestor)) {
            ancestor.queue_relayout();
            return 'relayout';
        }
    }
    if (strandedFor >= remapFrames) {
        _windowActorStrandedFrames.delete(actor);
        actor.hide();
        actor.show();
        return 'remap';
    }
    return '';
}

/**
 * Forgets the frames `actor` has been waiting for an allocation. An actor
 * that moves has a relayout pending in every frame it is checked in, before
 * the layout runs, which is not a strand.
 */
export function clearStranded(actor) {
    _strandedFrames.delete(actor);
    _windowActorStrandedFrames.delete(actor);
}

/**
 * Remaps one of our own glass actors once it has been stranded for
 * `framesBeforeRescue` frames. Both calls happen before the frame is painted,
 * so there is no flicker. Returns true when a rescue ran.
 */
export function ensureGlassAllocated(actor, framesBeforeRescue = STRANDED_FRAMES_BEFORE_RESCUE) {
    if (!actor)
        return false;
    // An unmapped actor is merely waiting; real_map() will fix it on its own.
    if (!actor.visible || !actor.mapped || actor.has_allocation()) {
        _strandedFrames.delete(actor);
        return false;
    }
    const strandedFor = (_strandedFrames.get(actor) ?? 0) + 1;
    if (strandedFor < framesBeforeRescue) {
        _strandedFrames.set(actor, strandedFor);
        return false;
    }
    _strandedFrames.delete(actor);
    actor.hide();
    actor.show();
    return true;
}

/**
 * Shows or hides an actor. An actor hidden while it waited for an allocation
 * is left in the state above, so on show the relayout is queued on the actor
 * and its parent; otherwise it keeps painting from its old position.
 */
export function setActorVisible(actor, visible) {
    if (!actor)
        return;
    if (actor.visible === visible)
        return;
    actor.visible = visible;
    if (visible) {
        actor.queue_relayout();
        actor.get_parent()?.queue_relayout();
    }
}

export const GLASS_CLIP_PADDING = 200;
export const GLASS_SHADOW_MAX_RADIUS = GLASS_CLIP_PADDING - 20;

export function placeScreenGlass(glass, x, y, screenW, screenH, clip) {
    // The glass covers the whole monitor; the clip limits drawing to the glass
    // rect plus room for its shadow.
    glass.remove_transition('size');
    glass.remove_transition('position');
    glass.set_position(x, y);
    glass.set_size(screenW, screenH);
    glass.remove_transition('size');
    glass.remove_transition('position');
    setClipIfChanged(glass, clip.x - GLASS_CLIP_PADDING, clip.y - GLASS_CLIP_PADDING, clip.w + GLASS_CLIP_PADDING * 2, clip.h + GLASS_CLIP_PADDING * 2);
}

// The content actor's stage position. It can be NaN on the first frame of an
// animation, so fall back to the last good position, then to the caller's
// prediction.
export function resolveGlassOrigin(actor, memory, fallback) {
    const [x, y] = actor.get_transformed_position();
    if (!Number.isNaN(x) && !Number.isNaN(y)) {
        memory._lastValidAnimAbsX = x;
        memory._lastValidAnimAbsY = y;
        return [x, y];
    }
    if (memory._lastValidAnimAbsX !== undefined && memory._lastValidAnimAbsY !== undefined)
        return [memory._lastValidAnimAbsX, memory._lastValidAnimAbsY];
    return fallback();
}

export function applyGlassScale(effect, cornerRadius, scaleX, scaleY) {
    if (!effect)
        return;
    // The smaller scale keeps the corners round while the menu scales unevenly.
    const currentScale = Math.min(scaleX, scaleY);
    effect.setCornerRadius(cornerRadius * currentScale);
    effect.setAnimationScale(currentScale);
}

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
