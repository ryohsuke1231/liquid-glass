import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isActorValid } from './lifecycle.js';

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
