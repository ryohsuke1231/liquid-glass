import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isActorValid } from './lifecycle.js';
/** True when the two rects share at least one pixel. */
export function rectsIntersect(ax, ay, aw, ah, b) {
    return ax < b[0] + b[2] && ax + aw > b[0] &&
        ay < b[1] + b[3] && ay + ah > b[1];
}
/** Grows `a` in place so it also contains `b`. */
export function unionRectInto(a, b) {
    const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
    const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
    a[0] = Math.min(a[0], b[0]);
    a[1] = Math.min(a[1], b[1]);
    a[2] = x1 - a[0];
    a[3] = y1 - a[1];
}
/**
 * Reads an actor's *allocated* size, instead of Clutter.Actor.get_size().
 *
 * get_size() returns the actor's natural (preferred) size whenever
 * `needs_allocation` is set — i.e. whenever anything in its subtree has
 * queued a relayout that the stage has not processed yet. Every per-frame
 * clone sync in this extension runs from a Meta.LaterType.BEFORE_REDRAW
 * later, and those fire in the stage's "before update" phase — *before*
 * clutter_stage_maybe_relayout() — so we hit that window constantly.
 *
 * That is fatal for GNOME's overviewGroup. ControlsManagerLayout reports
 * [0, 0] as its preferred size on purpose ("the MonitorConstraint will
 * allocate us a fixed size anyway"), and both OverviewActor and
 * overviewGroup take their size from constraints, which feed the allocation
 * only — never the preferred size. So the instant anything inside the
 * overview queues a relayout (an app icon's label changing on hover, a
 * layout update), overviewGroup.get_size() answers [0, 0] for that frame,
 * syncProperties() culls the clone as zero-sized, and the wallpaper flashes
 * through the glass for exactly one frame.
 *
 * get_allocation_box() has no such fallback: it returns the last allocation
 * verbatim — which is precisely what was on screen last frame.
 */
export function getAllocatedSize(actor) {
    try {
        const box = actor.get_allocation_box();
        const w = box.get_width();
        const h = box.get_height();
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            return [w, h];
        }
    }
    catch (_) { /* noop */ }
    // Never allocated yet (or the call failed): fall back to get_size(), whose
    // answer is at least as good as nothing.
    try {
        const [w, h] = actor.get_size();
        return [w, h];
    }
    catch (_) {
        return [0, 0];
    }
}
/**
 * An actor's on-screen rectangle — [x, y, w, h] in stage coordinates, with
 * every ancestor transform (scale, translation) already folded in.
 *
 * Pairing get_transformed_position() with a raw size is a trap, and one this
 * extension has fallen into repeatedly: the position is fully transformed,
 * but neither get_size() nor the allocation box carries the scale an
 * ancestor is applying. So anything that animates by scaling a container —
 * BoxPointer.open() easing scale from 0.96 to 1.0, this extension's own
 * spring animation, GNOME's window resize animation — produces a rect whose
 * origin is correct and whose size is too large by the inherited scale, for
 * the entire duration of the animation.
 *
 * get_transformed_extents() pushes the actor's *allocation box* through the
 * full accumulated matrix and returns its bounds, so the origin and the size
 * can never disagree. (It reads the allocation, so it inherits none of
 * get_size()'s preferred-size fallback either — see getAllocatedSize.)
 *
 * Use this wherever a rect is consumed in SCREEN space. Do not use it to
 * compute an actor's own position/translation, which lives in its parent's
 * unscaled local space.
 */
export function getTransformedRect(actor) {
    try {
        const r = actor.get_transformed_extents();
        const x = r.origin.x, y = r.origin.y;
        const w = r.size.width, h = r.size.height;
        if (Number.isFinite(x) && Number.isFinite(y) &&
            Number.isFinite(w) && Number.isFinite(h)) {
            return [x, y, w, h];
        }
    }
    catch (_) { /* noop */ }
    try {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = getAllocatedSize(actor);
        return [x, y, w, h];
    }
    catch (_) {
        return [0, 0, 0, 0];
    }
}
/**
 * [FIX round 13] Works out where the actor's own pixels live inside the
 * padded capture texture, and where the composite quad has to be drawn so
 * that it lands exactly back on the actor.
 *
 * Two things were wrong before, and both came from the same guess — that
 * the capture's padding is split evenly around the actor.
 *
 * 1. The padding is NOT centred. ClutterOffscreenEffect.pre_paint() sizes
 *    its FBO from _clutter_actor_box_enlarge_for_effects(), which does:
 *
 *        w  = nearbyint(raw.x2 - raw.x1)
 *        x2 = ceilf(raw.x2 + 0.75)
 *        x1 = x2 - w - 3
 *
 *    For an integer-sized actor at a whole-pixel origin that yields
 *    x1 = -2, x2 = w + 1 — i.e. 2px of padding on the left/top and 1px on
 *    the right/bottom, for the 3px total this extension has always
 *    measured (964x563 capture for a 961x560 actor). Sampling from
 *    padding/2 = 1.5px therefore read half a pixel too far left/up.
 *
 * 2. Far more visibly: vfunc_paint_target() does NOT run in the actor's
 *    own coordinate space. clutter_offscreen_effect_paint_texture() wraps
 *    the paint_target call in a ClutterTransformNode carrying
 *    translate(fbo_offset_x, fbo_offset_y) — the very offset above — and
 *    then Clutter's own default paint_target draws the FULL texture at
 *    (0, 0, texWidth, texHeight). So in this space one unit is one capture
 *    TEXEL and the origin is the texture's top-left corner, which sits at
 *    actor-local (-2, -2). Drawing the composite at (0, 0, w, h), as this
 *    did, therefore shifted the entire glass up and to the left by that
 *    offset — the reported "-3px, -3px offset" on the dock, menus,
 *    notifications, application windows and the OSD.
 *
 * Returns UVs into the capture plus the destination rect in that texel
 * space. Everything is derived from the actor's paint volume, exactly as
 * Clutter derives it; the result is sanity-checked against the texture's
 * real size and falls back to the old centred assumption if the
 * replication ever stops matching (a Clutter change, a rotated actor, a
 * paint volume we can't read).
 */
export function computeCaptureLayout(actor, srcW, srcH, allocW, allocH) {
    const centredFallback = () => {
        const padW = srcW - allocW;
        const padH = srcH - allocH;
        if (padW === 0 && padH === 0) {
            return { uv: [0, 0, 1, 1], dest: [0, 0, allocW, allocH] };
        }
        const x0 = padW / 2, y0 = padH / 2;
        return {
            uv: [
                x0 / srcW, y0 / srcH,
                Math.min(1.0, (x0 + allocW) / srcW),
                Math.min(1.0, (y0 + allocH) / srcH),
            ],
            dest: [x0, y0, x0 + allocW, y0 + allocH],
        };
    };
    if (!actor)
        return centredFallback();
    // The paint volume is in the actor's own coordinate space and is what
    // pre_paint() feeds to _clutter_actor_box_enlarge_for_effects(). When it
    // can't be obtained, Clutter falls back to the allocation box, which for
    // our purposes is the same rectangle with its origin at (0, 0).
    let rawX1 = 0, rawY1 = 0, rawX2 = allocW, rawY2 = allocH;
    try {
        const pv = actor.get_paint_volume?.();
        if (pv) {
            const origin = pv.get_origin();
            rawX1 = origin.x;
            rawY1 = origin.y;
            rawX2 = rawX1 + pv.get_width();
            rawY2 = rawY1 + pv.get_height();
        }
    }
    catch (e) {
        // Keep the allocation-derived box.
    }
    if (!Number.isFinite(rawX1) || !Number.isFinite(rawY1) ||
        !Number.isFinite(rawX2) || !Number.isFinite(rawY2)) {
        return centredFallback();
    }
    // CLUTTER_NEARBYINT: round half away from zero, truncated to an int.
    const nearbyint = (v) => Math.trunc(v < 0 ? v - 0.5 : v + 0.5);
    let x1 = rawX1, y1 = rawY1, x2 = rawX2, y2 = rawY2;
    // _clutter_actor_box_enlarge_for_effects leaves a zero-area box alone.
    if ((rawX2 - rawX1) * (rawY2 - rawY1) !== 0) {
        const w = nearbyint(rawX2 - rawX1);
        const h = nearbyint(rawY2 - rawY1);
        x2 = Math.ceil(rawX2 + 0.75);
        y2 = Math.ceil(rawY2 + 0.75);
        x1 = x2 - w - 3;
        y1 = y2 - h - 3;
    }
    const boxW = x2 - x1;
    const boxH = y2 - y1;
    if (!(boxW > 0) || !(boxH > 0))
        return centredFallback();
    // priv->fbo_offset_{x,y} is the INTEGER truncation of the enlarged box's
    // origin, and the offscreen's modelview translates by its negation, so
    // capture texel = (actorLocal - fboOffset) * scale.
    const fboOffX = Math.trunc(x1);
    const fboOffY = Math.trunc(y1);
    // pre_paint scales the box by ceilf(resourceScale) and ceils the result
    // into the texture size, so the scale is recoverable from the texture
    // itself — no HiDPI-only API needed, and the check below rejects the
    // answer outright if the replication doesn't reproduce srcW/srcH.
    const scale = Math.max(1, Math.round(srcW / boxW));
    if (Math.ceil(boxW * scale) !== srcW || Math.ceil(boxH * scale) !== srcH) {
        return centredFallback();
    }
    const padLeft = -fboOffX * scale;
    const padTop = -fboOffY * scale;
    const contentW = allocW * scale;
    const contentH = allocH * scale;
    if (!(padLeft >= 0) || !(padTop >= 0) ||
        padLeft + contentW > srcW || padTop + contentH > srcH) {
        return centredFallback();
    }
    return {
        uv: [
            padLeft / srcW, padTop / srcH,
            (padLeft + contentW) / srcW, (padTop + contentH) / srcH,
        ],
        dest: [padLeft, padTop, padLeft + contentW, padTop + contentH],
    };
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
