import { utilsLog } from '../diagnostics/logging.js';
// ─── [PERF] Idle gating: write a clone property only when it changes ─────────
//
// Every manager's BEFORE_REDRAW tick used to re-write translation_x/y,
// size, scale, pivot and opacity onto every clone of every glass, every
// frame, whether or not anything had moved. Clutter's setters for the
// transform properties do not compare before storing: they go straight to
// transform_changed() + clutter_actor_queue_redraw(). So a completely
// static desktop still damaged every clone 60 times a second, which damaged
// the glass that contains it, which re-ran capture + blur + composite for
// the whole nested stack.
//
// Measured (2026-09-11, 3 glass windows + dock, log__2.log):
//
//   state                     stage    glass paints   GPU
//   normal                    60 fps   ~600/s         ~47%
//   freezeSync(true)          ~35 fps  ~234/s         ~21%
//   extension off             --       0              ~3%
//
// GPU is linear in glass-paints-per-second, and the stage only ran at a
// full 60 fps because we kept damaging it. Nothing here changes what is
// drawn — only whether a redundant write is issued at all.
//
// The last written value is cached on the clone itself rather than read
// back from C: a GObject property read costs ~180ns through gjs (measured),
// and with hundreds of clone syncs per frame that alone is a millisecond.
// A JS expando is free, it is dropped with the actor, and nothing but these
// helpers ever writes these particular properties on our clones.
//
// A/B: global._lgGlass.diffWrites(false) restores the unconditional writes.
let _diffWritesEnabled = true;
export function setDiffWritesEnabled(enabled) {
    _diffWritesEnabled = !!enabled;
}
export function isDiffWritesEnabled() {
    return _diffWritesEnabled;
}
/** Drops the cache so the next sync writes unconditionally. */
export function invalidateCloneWriteCache(actor) {
    if (!actor)
        return;
    const c = actor;
    c._lgTx = c._lgTy = c._lgW = c._lgH = undefined;
    c._lgSx = c._lgSy = c._lgPx = c._lgPy = c._lgOpacity = undefined;
}
export function setTranslationIfChanged(actor, x, y) {
    const c = actor;
    if (_diffWritesEnabled && c._lgTx === x && c._lgTy === y)
        return false;
    c._lgTx = x;
    c._lgTy = y;
    actor.translation_x = x;
    actor.translation_y = y;
    return true;
}
export function setSizeIfChanged(actor, w, h) {
    const c = actor;
    if (_diffWritesEnabled && c._lgW === w && c._lgH === h)
        return false;
    c._lgW = w;
    c._lgH = h;
    actor.set_size(w, h);
    return true;
}
export function setScaleIfChanged(actor, sx, sy) {
    const c = actor;
    if (_diffWritesEnabled && c._lgSx === sx && c._lgSy === sy)
        return false;
    c._lgSx = sx;
    c._lgSy = sy;
    actor.set_scale(sx, sy);
    return true;
}
export function setPivotIfChanged(actor, px, py) {
    const c = actor;
    if (_diffWritesEnabled && c._lgPx === px && c._lgPy === py)
        return false;
    c._lgPx = px;
    c._lgPy = py;
    actor.set_pivot_point(px, py);
    return true;
}
export function setClipIfChanged(actor, x, y, w, h) {
    const c = actor;
    if (_diffWritesEnabled &&
        c._lgClipX === x && c._lgClipY === y && c._lgClipW === w && c._lgClipH === h)
        return false;
    c._lgClipX = x;
    c._lgClipY = y;
    c._lgClipW = w;
    c._lgClipH = h;
    actor.set_clip(x, y, w, h);
    return true;
}
export function setPositionIfChanged(actor, x, y) {
    const c = actor;
    if (_diffWritesEnabled && c._lgPosX === x && c._lgPosY === y)
        return false;
    c._lgPosX = x;
    c._lgPosY = y;
    actor.set_position(x, y);
    return true;
}
/**
 * [PERF ①b] Culls a clone by OPACITY, not by visibility.
 *
 * clutter_actor_paint() opens with
 *
 *     if (!CLUTTER_ACTOR_IS_TOPLEVEL (self) &&
 *         ((priv->opacity_override >= 0) ? priv->opacity_override : priv->opacity) == 0)
 *       return;
 *
 * (clutter-actor.c:3526) — before the mapped check, before the paint node is
 * built. So a zero-opacity clone is skipped just as completely as a hidden
 * one, and its source is never painted through it: the nested glass does not
 * run either, which is the whole point of the cull.
 *
 * What it avoids is everything the `visible` route drags in. Toggling
 * visibility maps and unmaps the actor, which is landmine 8 in memo.md, and
 * setActorVisible()'s show path has to fire queue_relayout() on the clone AND
 * its parent to get an actor that was hidden mid-allocation unstuck. With a
 * cull that flips on every window drag that crosses a glass boundary, that is
 * a relayout storm — and a relayout is damage, which is exactly what this
 * whole line of work exists to stop producing.
 *
 * The clone's real opacity is restored by the caller's next
 * setOpacityIfChanged(): un-culling drops the cached value so the write
 * cannot be skipped.
 */
export function setCloneCulled(actor, culled, why) {
    if (!actor)
        return;
    const wasCulled = !!actor._lgCulled;
    if (wasCulled === !!culled)
        return;
    actor._lgCulled = !!culled;
    // [DIAG] Logged on the TRANSITION only, so a cull that flips once costs two
    // lines and a cull that flaps shows up as a flood. This is the probe for
    // "part of the glass background went black": the black is written to the
    // screen at the moment of a wrong cull and then stays there, because with
    // ④ in place nothing damages that region again — so the report taken
    // afterwards shows everything correct. The timeline is what identifies it.
    if (why) {
        let name = '(?)';
        try {
            name = actor.get_name?.() || '(unnamed)';
        }
        catch (_) { }
        utilsLog(`[Liquid Glass][cull] ${culled ? 'CULL ' : 'SHOW '} "${name}" ${why}`);
    }
    if (culled) {
        actor.opacity = 0;
    }
    else {
        // Force the next setOpacityIfChanged() to write: the cache still holds
        // the value from before the cull, which is no longer what the actor has.
        actor._lgOpacity = undefined;
    }
    // [FIX] Damage the PARENT, not just this actor.
    //
    // ClutterOffscreenEffect does not re-render its framebuffer on every paint:
    //
    //     if (priv->offscreen == NULL || (flags & CLUTTER_EFFECT_PAINT_ACTOR_DIRTY))
    //       parent_class->paint (...);            // re-render
    //     else
    //       clutter_offscreen_effect_paint_texture (...);   // reuse the cache
    //
    // (clutter-offscreen-effect.c:569). So a change inside the capture that
    // does not mark the glass actor dirty is simply never picked up — the glass
    // goes on showing the cached capture.
    //
    // The opacity write above normally does queue that damage, but
    // _clutter_actor_queue_redraw_full() drops it outright for an actor that is
    // not mapped and has no mapped clones (clutter-actor.c:7674) — which is
    // exactly the state of a clone that was built this frame and culled before
    // anything showed it. Poking the parent costs one call per TRANSITION (not
    // per frame) and cannot be dropped that way.
    try {
        actor.get_parent?.()?.queue_redraw();
    }
    catch (_) { /* noop */ }
}
/** True while setCloneCulled() is holding this clone at zero opacity. */
export function isCloneCulled(actor) {
    return !!(actor && actor._lgCulled);
}
export function setOpacityIfChanged(actor, opacity) {
    const c = actor;
    // While culled the actor is deliberately held at 0; setCloneCulled(false)
    // is what releases it (and drops the cache so this write lands).
    if (actor._lgCulled)
        return false;
    if (_diffWritesEnabled && c._lgOpacity === opacity)
        return false;
    c._lgOpacity = opacity;
    actor.opacity = opacity;
    return true;
}
