// utils.ts
//
// Shared helpers for the Liquid Glass extension: actors that stay invisible
// to Looking Glass's picker, the UI-layer sampler that clones the desktop
// behind the glass, and the special-case handling needed to render a blurred
// panel (from the Blur My Shell extension) inside the glass without breaking
// the real panel's own blur.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Mtk from 'gi://Mtk';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
let _utilsLogger = null;
export function setUtilsLogger(logger) {
    _utilsLogger = logger;
}
function utilsLog(msg) {
    try {
        _utilsLogger?.log(msg);
    }
    catch (_) { /* noop */ }
}
/**
 * Detects and repairs a glass subtree that Clutter has stopped allocating.
 *
 * ── The bug, from mutter's own source (clutter/clutter/clutter-actor.c,
 *    clutter/clutter/clutter-stage.c, GNOME 50) ────────────────────────────
 *
 * 1. `clutter_actor_allocate()` opens with
 *
 *        if (!CLUTTER_ACTOR_IS_TOPLEVEL (self) &&
 *            !clutter_actor_is_mapped (self) &&
 *            !clutter_actor_has_mapped_clones (self))
 *          return;
 *
 *    — an early return that does NOT clear needs_width_request /
 *    needs_height_request / needs_allocation.
 *
 * 2. `clutter_stage_maybe_relayout()` STEALS the pending list before
 *    servicing it (`stolen_list = g_steal_pointer (&priv->pending_relayouts)`)
 *    and drops any entry it skips. So an actor that is queued and then
 *    unmapped before the stage gets to it is removed from the queue while
 *    keeping all three "needs" flags set.
 *
 * 3. From then on it is unreachable, because the PUBLIC entry point is
 *
 *        void clutter_actor_queue_relayout (ClutterActor *self)
 *        { _clutter_actor_queue_only_relayout (self); ... }
 *
 *    and `_clutter_actor_queue_only_relayout()` begins with
 *
 *        if (needs_width_request && needs_height_request && needs_allocation)
 *          return; /* save some cpu cycles *\/
 *
 *    It returns before emitting the signal, so nothing re-registers the
 *    actor with the stage. This is why every earlier attempt to fix this
 *    from JS by calling queue_relayout() — on the root, on each node of the
 *    chain, on the whole subtree — did exactly nothing.
 *
 * 4. A stranded ancestor also swallows every request from below, because
 *    children propagate through that same guarded function. The whole
 *    subtree stops being allocated: existing actors keep their last
 *    allocation, and actors created afterwards never get a first one at all
 *    (alloc = -Infinity, so nothing to paint with — the missing Overview /
 *    app-grid clone).
 *
 * ── The repair ────────────────────────────────────────────────────────────
 *
 * Clutter has exactly one escape hatch, and it uses it itself. In
 * `clutter_actor_real_map()`:
 *
 *        /* Avoid the early return in clutter_actor_queue_relayout() *\/
 *        priv->needs_width_request = FALSE;
 *        priv->needs_height_request = FALSE;
 *        priv->needs_allocation = FALSE;
 *        clutter_actor_queue_relayout (self);
 *
 * Those fields are private, so JS cannot clear them — but it can make
 * `real_map()` run, and `real_map()` runs for every actor of a subtree
 * being mapped. hide() followed by show() therefore unmaps and remaps the
 * whole glass subtree and clears the trap on every node in it.
 *
 * That is also, at last, the real explanation for the workaround found by
 * hand at the very start of this investigation: hiding the dock and showing
 * it again fixed the stuck clones. Not because the clones were rebuilt —
 * because the remap ran Clutter's own rescue.
 *
 * Both calls happen inside one frame tick, before any paint, so there is no
 * flicker. Gated on several consecutive stranded frames so a normal pending
 * relayout — `has_allocation()` is legitimately false whenever a relayout is
 * merely outstanding — can never trigger it.
 *
 * Returns true when a rescue was performed.
 */
const _strandedFrames = new WeakMap();
const STRANDED_FRAMES_BEFORE_RESCUE = 3;
/**
 * @param framesBeforeRescue how many consecutive stranded frames to require
 *   before remapping. The default is fine for our own glass actors, which
 *   nothing else owns. Callers that hand this an actor belonging to Mutter —
 *   see ApplicationManager._frameTick(), which has to rescue the
 *   MetaWindowActor itself because point 4 of the comment above means a
 *   stranded window actor swallows every relayout request its glass children
 *   make (and MetaWindowActor is NOT flagged NO_LAYOUT: it has no allocate
 *   vfunc at all, so its children go through
 *   `_clutter_actor_queue_only_relayout(parent)` and die there, instead of
 *   through `clutter_actor_queue_shallow_relayout(child)` straight onto the
 *   stage) — should ask for a longer streak, so a live window is never
 *   remapped for a relayout that was merely slow.
 */
export function ensureGlassAllocated(actor, framesBeforeRescue = STRANDED_FRAMES_BEFORE_RESCUE) {
    try {
        if (!actor)
            return false;
        // Only a visible, mapped actor can be stranded in the sense above; an
        // unmapped one is simply waiting, and will be rescued by real_map() when
        // it comes back.
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
    catch (_) {
        return false;
    }
}
/**
 * Shows/hides an actor and, on the hidden -> visible transition, forces the
 * allocation to be re-requested.
 *
 * Clutter's queue_relayout() short-circuits ("save some cpu cycles") as soon
 * as the actor already has needs_width_request / needs_height_request /
 * needs_allocation all set — which is precisely the state an actor is left
 * in when it gets hidden while still waiting for an allocation. show()
 * alone then does not get the request to the stage, and the actor is stuck:
 * Clutter reports it with
 *   "Can't update stage views actor <name> is on because it needs an
 *    allocation."
 * every single frame, and it goes on painting from its last, stale
 * allocation — i.e. a clone frozen at the coordinates it had when it was
 * hidden, no matter how many set_position() calls it receives afterwards.
 *
 * Poking the parent too restarts the chain above the short-circuit.
 * Cheap: it only runs on an actual visibility change, never per frame.
 */
export function setActorVisible(actor, visible) {
    try {
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
    catch (_) { /* noop */ }
}
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
// ─── [PERF ①/①b] Capture clipping and clone culling ──────────────────────────
//
// Every glass is a ClutterOffscreenEffect, so each paint is
//
//   1. bind the offscreen FBO and clear it
//   2. paint the whole clone subtree into it
//        (wallpaper clone + every window clone + UI clones + BMS replica)
//   3. run the blur and the composite (vfunc_paint_target)
//
// The blur sub-rect (phase 8) and the composite sub-rect (②) only ever
// shrank step 3. Step 2 is still paid in full, and for the dock / menus /
// notifications / OSD / quick settings it is paid over the WHOLE MONITOR,
// because their bgActor is monitor-sized on purpose (see landmine 9 in
// memo.md: shrinking it breaks Blur My Shell's stage-coordinate blit).
//
// Application windows already avoid this: applicationManager builds a
// `clipBox` with clip_to_allocation and sizes it to the glass box, so their
// clone subtree is clipped to the glass already. These two switches bring
// the same saving to the other five.
//
// ①  captureClip — set_clip() on the clone container.
//    Verified against mutter 50.1 rather than assumed:
//      * clutter-actor.c:3570  a clip becomes a ClutterClipNode wrapping the
//        actor's node, INSIDE the actor's own transform node. So the clip
//        rect is in the same local space the children are positioned in, and
//        it is pushed while the offscreen framebuffer is current — which is
//        exactly why the existing bgActor.set_clip() never helped: bgActor
//        sits OUTSIDE the effect, so its clip only ever scissored the
//        composite into the stage framebuffer.
//      * clutter-offscreen-effect.c:346 sizes the FBO from
//        clutter_actor_get_paint_volume() of the effect's actor, and
//        clutter-actor.c:5586 builds that volume starting FROM THE ACTOR'S
//        OWN ALLOCATION and only ever unions children into it. liquidBox is
//        set_size(monitor) already, so clipping a descendant cannot shrink
//        it. The FBO keeps its size AND its origin => computeCaptureLayout(),
//        _lgCaptureOffset and BMS's stage-coordinate blit are all untouched.
//        This is what keeps landmine 9 out of the picture.
//
// ①b cloneCull — hide clones that fall outside that same rect.
//    set_clip() only scissors: the clipped-out actors still build and run
//    their paint nodes, and a NESTED glass renders into its own FBO, which
//    the parent's scissor does not touch at all. A clone with visible=false,
//    on the other hand, makes clutter_actor_paint() return immediately, so
//    its source is never painted THROUGH IT and the nested glass never runs.
//
//    That is the part that matters: it turns the 2^N nesting into
//    2^(number of windows actually overlapping this glass) without removing
//    the nesting itself. Nothing changes visually — a window that does not
//    intersect the glass box contributed zero pixels to the capture anyway.
//
//    UILayerSampler.syncProperties() has always done this test, but against
//    the CONTAINER's bounds, which are the whole monitor — so it never culled
//    anything. setCullRect() gives it a rect that means something.
//
// A/B: global._lgGlass.captureClip(false) / .cloneCull(false).
//
// ─── MEASURED (2026-09-13, 3 glass windows + dock, while moving things) ───
//
//   both off (④ only, the previous baseline)   36-38%
//   ① on, ①b off                               40-42%   ← WORSE than neither
//   ① off, ①b on                               26-30%
//   both on                                    29%
//
// ① costs about 4 points and returns nothing, so it ships OFF. The reason is
// visible in the numbers rather than guessed at: the wallpaper and the window
// clones are a handful of large quads, and scissoring them saves far less
// fill than the extra clip push/pop and the batching it breaks costs — while
// the FBO is cleared at full size either way (clutter-paint-nodes.c:1034
// clears the whole layer node unconditionally).
//
// ①b is the one that pays, and for a different reason: it removes whole
// nested glass renders, which no amount of scissoring can.
//
// The ① code is kept, and kept working, because it is the only lever left if
// the capture's fill rate ever does become the bottleneck (a much larger
// monitor, say). Turn it on with global._lgGlass.captureClip(true).
let _captureClipEnabled = false;
let _cloneCullEnabled = true;
export function setCaptureClipEnabled(enabled) {
    _captureClipEnabled = !!enabled;
}
export function isCaptureClipEnabled() {
    return _captureClipEnabled;
}
export function setCloneCullEnabled(enabled) {
    _cloneCullEnabled = !!enabled;
}
export function isCloneCullEnabled() {
    return _cloneCullEnabled;
}
// [DIAG] ①b runs at three independent sites, and the cull log showed every
// decision to be geometrically correct — so the next question is not "is the
// rect wrong" but "which of the three breaks the picture". These split the
// master switch so one paste answers that:
//
//   global._lgGlass.cullApp(false)      ApplicationManager._syncClones()
//                                       (behind-window clones inside a
//                                        window's own glass)
//   global._lgGlass.cullWindows(false)  WindowCloneManager.sync()
//                                       (window clones inside dock / menu /
//                                        notification / OSD / quick settings)
//   global._lgGlass.cullUi(false)       UILayerSampler.syncProperties()
//                                       (uiGroup clones in those same five)
//
// Each is ANDed with the master cloneCull switch.
let _cullApp = true;
let _cullWindows = true;
let _cullUi = true;
export function setCullSiteEnabled(site, enabled) {
    if (site === 'app')
        _cullApp = !!enabled;
    else if (site === 'windows')
        _cullWindows = !!enabled;
    else
        _cullUi = !!enabled;
}
export function isCullSiteEnabled(site) {
    if (!_cloneCullEnabled)
        return false;
    if (site === 'app')
        return _cullApp;
    if (site === 'windows')
        return _cullWindows;
    return _cullUi;
}
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
/**
 * Reports an exception that escaped one of the per-frame sync loops.
 *
 * Deliberately NOT routed through the Logger: every one of those loops is a
 * self-rescheduling Meta.LaterType.BEFORE_REDRAW chain, and an exception
 * that reaches the `later` callback used to skip the reschedule at the end
 * of the tick — which silently froze that glass instance's clones (they
 * keep painting their source's live content at whatever position they were
 * last given) until the menu/dock was hidden and shown again, because
 * `startFrameSync()` is only reachable from 'notify::mapped'. That is a
 * hard failure, not diagnostics, so it must be visible with `output-logs`
 * off too.
 *
 * Rate-limited per tag: the throw is usually a per-frame condition (a
 * disposed actor that stays disposed), and 60 identical backtraces a second
 * is what makes a journal useless.
 */
const _frameLoopErrorLastLogged = new Map();
const FRAME_LOOP_ERROR_LOG_INTERVAL_MS = 5000;
export function reportFrameLoopError(tag, e) {
    try {
        const now = Date.now();
        const last = _frameLoopErrorLastLogged.get(tag) ?? 0;
        if (now - last < FRAME_LOOP_ERROR_LOG_INTERVAL_MS)
            return;
        _frameLoopErrorLastLogged.set(tag, now);
        console.error(`[Liquid Glass] exception in ${tag} frame sync (loop kept alive): ${e}`);
        const stack = e?.stack;
        if (stack)
            console.error(`[Liquid Glass] ${stack}`);
    }
    catch (_) { /* noop */ }
}
export function crossFadeColorAt(start, startAlpha, target, targetAlpha, progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (p < 0.5) {
        const local = p / 0.5;
        // easeInQuad on the fade-out: holds the readable colour a little longer.
        const a = startAlpha * (1 - local * local);
        return { r: start.r, g: start.g, b: start.b, a };
    }
    const local = (p - 0.5) / 0.5;
    // easeOutQuad on the fade-in: mirrors the curve above.
    const e = 1 - (1 - local) * (1 - local);
    return { r: target.r, g: target.g, b: target.b, a: targetAlpha * e };
}
// Only a real light<->dark flip earns the dissolve. A small nudge (the theme's
// own off-white to pure white, say) has no grey to walk through, and dipping
// the alpha for it would invent a flicker where a plain lerp is invisible.
// Rec. 709 luma, 0..1; the threshold is far below a white/black flip (1.0) and
// far above any within-palette adjustment.
const CROSS_FADE_LUMA_DELTA = 0.4;
export function shouldCrossFadeColors(start, target) {
    const luma = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return Math.abs(luma(target) - luma(start)) > CROSS_FADE_LUMA_DELTA;
}
/**
 * The plain channel-by-channel interpolation, kept as the A/B alternative to
 * the dissolve. easeInOutQuad, exactly what every manager used to run inline.
 * It walks white->black through mid-grey, which is the legibility problem the
 * dissolve exists to avoid — that is the trade being switched between.
 */
export function lerpColorAt(start, startAlpha, target, targetAlpha, progress) {
    const p = Math.max(0, Math.min(1, progress));
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    return {
        r: Math.round(start.r + (target.r - start.r) * e),
        g: Math.round(start.g + (target.g - start.g) * e),
        b: Math.round(start.b + (target.b - start.b) * e),
        a: startAlpha + (targetAlpha - startAlpha) * e,
    };
}
let _adaptiveColorMode = 'cross-fade';
export function setAdaptiveColorMode(mode) {
    _adaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
}
export function getAdaptiveColorMode() {
    return _adaptiveColorMode;
}
/**
 * True when this particular change should dissolve rather than lerp: only in
 * 'cross-fade' mode, and only for a real light<->dark flip.
 */
export function resolveCrossFade(start, target) {
    return _adaptiveColorMode === 'cross-fade' && shouldCrossFadeColors(start, target);
}
class AdaptiveColorTweener {
    _entries = new Map();
    _laterId = 0;
    /**
     * @param batchStart monotonic timestamp shared by every actor updated in the
     *   same turn. Callers pass one value for a whole colour map so the actors
     *   move in lockstep; omitted, the actor starts from now.
     */
    add(actor, entry, batchStart) {
        if (!actor)
            return;
        const prev = this._entries.get(actor);
        // Restarting mid-tween: begin from what is actually on screen, not from
        // the theme node — St has not necessarily re-resolved it yet this frame,
        // and starting from a stale colour is a visible jump.
        const startRgb = prev?.last
            ? { r: prev.last.r, g: prev.last.g, b: prev.last.b }
            : entry.startRgb;
        const startAlpha = prev?.last ? prev.last.a : entry.startAlpha;
        this._entries.set(actor, {
            ...entry,
            startRgb,
            startAlpha,
            crossFade: entry.crossFade && shouldCrossFadeColors(startRgb, entry.targetRgb),
            startTime: batchStart ?? GLib.get_monotonic_time(),
        });
        this._schedule();
    }
    cancel(actor) {
        this._entries.delete(actor);
    }
    stopAll() {
        this._entries.clear();
        this._unschedule();
    }
    isAnimating(actor) {
        return this._entries.has(actor);
    }
    _schedule() {
        if (this._laterId !== 0)
            return;
        try {
            this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => { this._tick(); return false; });
        }
        catch (_) {
            this._laterId = 0;
        }
    }
    _unschedule() {
        if (this._laterId === 0)
            return;
        try {
            global.compositor.get_laters().remove(this._laterId);
        }
        catch (_) { }
        this._laterId = 0;
    }
    _tick() {
        this._laterId = 0;
        const now = GLib.get_monotonic_time();
        for (const [actor, e] of [...this._entries]) {
            if (!isActorValid(actor)) {
                this._entries.delete(actor);
                continue;
            }
            const elapsedMs = (now - e.startTime) / 1000;
            const progress = e.durationMs > 0 ? Math.min(elapsedMs / e.durationMs, 1) : 1;
            const c = e.crossFade
                ? crossFadeColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress)
                : lerpColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress);
            const a = Math.max(0, Math.min(1, c.a));
            // set_style() re-parses CSS and dirties the actor's layout, so it is by
            // far the expensive half of this. Skip it when the frame would write the
            // value that is already there (the flat ends of the easing curve).
            const same = e.coalesce !== false && e.last &&
                e.last.r === c.r && e.last.g === c.g && e.last.b === c.b &&
                Math.abs(e.last.a - a) < 0.002;
            if (!same) {
                e.last = { r: c.r, g: c.g, b: c.b, a };
                try {
                    e.apply(c.r, c.g, c.b, a, progress);
                }
                catch (_) { }
            }
            if (progress >= 1)
                this._entries.delete(actor);
        }
        if (this._entries.size > 0)
            this._schedule();
    }
}
export const adaptiveColorTweener = new AdaptiveColorTweener();
// [black-frame] 'off' is the default again, and all three repairs below are
// now legacy A/B material.
//
// Every one of them is a workaround for the SAME underlying bug, attacked
// from the wrong end: they force extra full re-captures so that a glass
// whose FBO captured a partially-painted wallpaper gets a corrected one soon
// after. The actual cause was that a Clutter.Clone of _backgroundGroup makes
// the wallpaper inherit the real background actor's per-frame culling state,
// so it paints ONLY inside the current frame's damage region — see
// BackgroundMirror above. With the mirror in place the capture is correct
// the first time, and paying for extra repaints every frame a background
// window updates is exactly the idle-GPU cost we want back.
//
// Historical notes, for anyone re-running the comparison:
//   'damage'    0/26 black against 4/26 with no repair, ~7 extra repaints/s.
//   'recapture' also fixed it, but repaints every window every frame forever.
//   'propagate' cheap, but reads the inner's serial one frame too late, so
//               the black became a flicker instead of going away.
let _nestedGlassFix = 'off';
const NESTED_FIX_MODES = ['off', 'recapture', 'propagate', 'damage'];
export function setNestedGlassFix(mode) {
    _nestedGlassFix = NESTED_FIX_MODES.includes(mode) ? mode : 'off';
}
export function getNestedGlassFix() {
    return _nestedGlassFix;
}
/**
 * The LiquidEffect sitting on a window actor's own glass root, or null when
 * that window has no glass. Used to read the inner effect's re-capture
 * counter; see NestedGlassFix.
 */
// ─── Focus-debug: opt-in, because it froze the shell ─────────────────────────
//
// _armFocusDebug() used to fire on every 'restacked' / 'grab-op-*' and log,
// for eight frames, one line per tracked window plus one per behind-clone.
// Restacks are not rare, so in practice that never stopped: the session of
// 2026-09-17 06:37 wrote 30,440 focus-debug lines out of 31,692 gnome-shell
// lines total — 96% — at a sustained 240-476 lines a second, journald
// answered with "Forwarding to syslog missed 1149 messages", and the shell
// froze at 07:01:05 and had to be killed. Writing to the journal from the
// compositor's main thread blocks when journald stops draining, so this is
// not merely noise; it is a hang.
//
// It stays available because it is the only tool for the clone-placement
// bugs it was written for, but it is now off unless asked for:
// global._lgGlass.focusDebug(true).
let _focusDebugEnabled = false;
export function setFocusDebugEnabled(on) { _focusDebugEnabled = !!on; }
export function isFocusDebugEnabled() { return _focusDebugEnabled; }
export function innerGlassEffectOf(windowActor) {
    try {
        if (!windowActor || !isActorValid(windowActor))
            return null;
        for (const c of windowActor.get_children()) {
            if ((c.name || '') !== 'lgw-bg')
                continue;
            const fx = c.get_effects()[0];
            if (fx && typeof fx._recaptureSerial === 'number')
                return fx;
        }
    }
    catch (_) { /* noop */ }
    return null;
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
/**
 * Captures a small rectangle of the screen (the panel area) into a
 * `Clutter.Content`, for use as the "blurred panel" backdrop inside the
 * glass, while structurally guaranteeing the glass never captures itself.
 *
 * Background: Blur My Shell (BMS) blurs the real top panel using a native
 * (non-JS) Clutter effect. That effect has no public API to read its result,
 * and — critically — it assumes it is the *only* consumer of its target
 * actor's paint output. Cloning the BMS target directly (`Clutter.Clone`)
 * makes BMS think a second consumer has taken over, and the *real* panel
 * loses its blur. So we never clone or paint the BMS actor at all; instead
 * we take an independent snapshot of "what the screen looks like there".
 *
 * Why `paint_to_content()` specifically: it performs a one-off, synchronous
 * render of a stage rectangle into an offscreen buffer, completely separate
 * from the actual on-screen frame. That gives us two things a live
 * `Clutter.Clone` cannot:
 *   1. Self-exclusion: our own glass root (`bgActor`) sits directly above
 *      the panel in z-order and can visually overlap it (e.g. when a
 *      panel-anchored popup is open). If we captured "the whole composited
 *      screen" while our own glass was visible, we would capture our own
 *      glass along with the panel — and since we redraw using that captured
 *      image every frame, this becomes a runaway feedback loop: each new
 *      capture already contains yesterday's capture, nested one level
 *      deeper, forever. (Diagnostic tip that confirmed this: the nesting
 *      alternated right-side-up / upside-down with each additional level,
 *      matching a V-flip correction from an older capture method being
 *      compounded once per loop iteration.)
 *      We avoid this entirely by hiding our own root actor for the single
 *      synchronous `paint_to_content()` call, then restoring it immediately
 *      — so the glass structurally cannot appear in its own snapshot.
 *   2. No visible flicker: hide → capture → show all happens synchronously,
 *      before control returns to Clutter's normal repaint cycle, so the
 *      actual displayed frame is never affected.
 *
 * We also always pass `Clutter.PaintFlag.NO_CURSORS`. GNOME Shell's own
 * screenshot code (shell-screenshot.c) does the same for this exact API —
 * without it, the mouse pointer sprite gets composited into the snapshot,
 * which shows up as cursor smearing inside the glass.
 */
export class SelfExcludingSnapshotCapture {
    _content = null;
    _rectGetter;
    _hideActors = new Set();
    _stage;
    _refCount = 0;
    _afterPaintId = 0;
    _destroyed = false;
    // Re-capture on every 'after-paint' rather than a fixed timer: this way
    // updates only happen (and only cost anything) while the screen is
    // actually changing, and are as fresh as the display's own refresh rate.
    // Raise FRAME_SKIP if this ever proves too expensive on slower hardware
    // (2 = every other frame, etc.) — 1 keeps it perfectly in sync.
    static FRAME_SKIP = 1;
    _frameCounter = 0;
    // [DIAG] Every failure path in _captureOnce() used to be swallowed by a
    // bare `catch (e) {}`, so a capture that never produced anything looked
    // from the outside exactly like a capture that worked — the glass simply
    // showed whatever was layered beneath it (the wallpaper/window clones)
    // with no hint as to why. These make the first failure of each kind, and
    // then every 300th, visible in the journal.
    _label;
    _failCount = 0;
    _okCount = 0;
    // When set and it returns false, _captureOnce() is a no-op (and reports
    // nothing): the capture is dormant rather than failing. Without it, a
    // capture created for a popup keeps hiding its hide-actor and re-painting
    // the whole stage into an offscreen on every single frame for as long as it
    // lives, popup open or not.
    _activeCheck;
    constructor(stage, hideActor, rectGetter, label = 'snapshot', activeCheck = null) {
        this._stage = stage;
        this._label = label;
        this._activeCheck = activeCheck;
        if (hideActor)
            this._hideActors.add(hideActor);
        this._rectGetter = rectGetter;
        this._captureOnce();
        try {
            this._afterPaintId = this._stage.connect('after-paint', () => {
                if (this._destroyed)
                    return;
                this._frameCounter++;
                if (this._frameCounter % SelfExcludingSnapshotCapture.FRAME_SKIP !== 0)
                    return;
                this._captureOnce();
            });
        }
        catch (e) {
        }
    }
    retain() { this._refCount++; }
    release() {
        this._refCount--;
        if (this._refCount <= 0) {
            this.destroy();
            return true;
        }
        return false;
    }
    /** Registers another Liquid Glass instance's root as needing to be hidden during capture. */
    addHideActor(actor) {
        if (actor)
            this._hideActors.add(actor);
    }
    /** Unregisters a previously-added hide actor (called when that instance releases the capture). */
    removeHideActor(actor) {
        if (actor)
            this._hideActors.delete(actor);
    }
    /** [DIAG] Throttled: reports the 1st, 2nd and then every 300th occurrence. */
    _report(kind, detail) {
        this._failCount++;
        if (this._failCount <= 2 || this._failCount % 300 === 0) {
            console.warn(`[Liquid Glass][snapshot:${this._label}] ${kind} (failures=${this._failCount}, ` +
                `successes=${this._okCount}): ${detail}`);
        }
    }
    _captureOnce() {
        if (this._activeCheck) {
            try {
                if (!this._activeCheck())
                    return;
            }
            catch (e) {
                return;
            }
        }
        const [x, y, w, h] = this._rectGetter();
        if (w <= 0 || h <= 0) {
            this._report('empty capture rect', `x=${x} y=${y} w=${w} h=${h}`);
            return;
        }
        // Hide every registered instance's root, not just a single
        // one, so a shared capture never leaks any glass instance into itself.
        const hidden = [];
        try {
            for (const actor of this._hideActors) {
                try {
                    if (actor && actor.visible) {
                        actor.hide();
                        hidden.push(actor);
                    }
                }
                catch (_) { /* actor may have been destroyed; skip it */ }
            }
            const rect = new Mtk.Rectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
            const scale = 1; // TODO: honor per-monitor resource scale if this is ever used on HiDPI setups.
            // Signature is (rect, scale, color_state, paint_flags); color_state
            // of null uses the default color space. NO_CURSORS excludes the
            // mouse pointer sprite from the snapshot (see class doc comment).
            // CLEAR matters: clutter_stage_paint_to_framebuffer() only clears the
            // offscreen when this flag is set, and the texture it allocates starts
            // out with undefined contents — anything the stage does not paint over
            // is garbage without it.
            const NO_CURSORS = Clutter.PaintFlag?.NO_CURSORS ?? 0;
            const CLEAR = Clutter.PaintFlag?.CLEAR ?? 0;
            const paintFlags = NO_CURSORS | CLEAR;
            const content = this._stage.paint_to_content?.(rect, scale, null, paintFlags);
            if (content) {
                this._content = content;
                this._okCount++;
            }
            else {
                this._report('paint_to_content returned null', `rect=${rect.x},${rect.y} ${rect.width}x${rect.height}`);
            }
        }
        catch (e) {
            this._report('paint_to_content threw', `${e}`);
        }
        finally {
            for (const actor of hidden) {
                try {
                    actor.show();
                }
                catch (_) { /* actor may have been destroyed; skip it */ }
            }
        }
    }
    getContent() {
        return this._content;
    }
    destroy() {
        this._destroyed = true;
        if (this._afterPaintId) {
            try {
                this._stage.disconnect(this._afterPaintId);
            }
            catch (_) { /* noop */ }
            this._afterPaintId = 0;
        }
    }
}
// Shared pool: multiple UILayerSampler instances (e.g. a permanent dock glass
// and a popup-menu glass) may want to capture the same BMS target. Keying by
// source actor lets them share a single capture instead of duplicating work.
const _selfExcludingSnapshotRegistry = new Map();
function acquireSelfExcludingSnapshot(sourceActor, stage, hideActor, rectGetter, label = 'bms') {
    let cap = _selfExcludingSnapshotRegistry.get(sourceActor);
    if (!cap) {
        cap = new SelfExcludingSnapshotCapture(stage, hideActor, rectGetter, label);
        _selfExcludingSnapshotRegistry.set(sourceActor, cap);
    }
    else {
        cap.addHideActor(hideActor);
    }
    cap.retain();
    return cap;
}
function releaseSelfExcludingSnapshot(sourceActor, hideActor) {
    const cap = _selfExcludingSnapshotRegistry.get(sourceActor);
    if (!cap)
        return;
    // Unregister our hide actor first so a capture that outlives us (still
    // retained by another instance) doesn't keep trying to hide an actor we
    // no longer care about.
    cap.removeHideActor(hideActor);
    if (cap.release()) {
        _selfExcludingSnapshotRegistry.delete(sourceActor);
    }
}
/**
 * A Clutter.Clone whose pick pass is a no-op, so Looking Glass's actor
 * picker sees through it to whatever is behind.
 */
export const UnpickableClone = GObject.registerClass(class UnpickableClone extends Clutter.Clone {
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
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking.
    }
});
/**
 * [black-frame] Stand-in for
 *   `new UnpickableClone({ source: Main.layoutManager._backgroundGroup })`
 * that renders the wallpaper WITHOUT going through Clutter.Clone.
 *
 * WHY THIS EXISTS — the "black frame" bug
 * ---------------------------------------
 * `MetaBackgroundContent` (the ClutterContent that actually paints the
 * wallpaper) culls itself against two regions that mutter stores ON THE
 * CONTENT OBJECT itself — mutter 50.1,
 * src/compositor/meta-background-content.c:
 *
 *   clip_region       the CURRENT FRAME'S DAMAGE REGION. Pushed down by
 *                     meta_window_group_paint() ->
 *                     meta_cullable_cull_redraw_clip() immediately before
 *                     the window group paints its children, and reset to
 *                     NULL immediately after.
 *   unobscured_region what is left of the wallpaper after the opaque
 *                     windows above it subtract themselves.
 *
 * meta_background_content_paint_content() applies BOTH unconditionally —
 * including while it runs inside a Clutter.Clone's paint. It even has an
 * explicit `clutter_actor_is_in_clone_paint()` branch, and that branch
 * still intersects with clip_region:
 *
 *     if (self->clip_region && mtk_region_is_empty (self->clip_region))
 *       return;                                      // paints NOTHING
 *     ...
 *     if (clutter_actor_is_in_clone_paint (actor))
 *       untransformed = FALSE;
 *     ...
 *     if (self->clip_region) {
 *       region = mtk_region_copy (self->clip_region);
 *       mtk_region_intersect_rectangle (region, &rect_within_actor);
 *     }
 *     ...
 *     if (self->unobscured_region)
 *       mtk_region_intersect (region, self->unobscured_region);
 *
 * A Clone paints its SOURCE actor, so it uses the SOURCE's content object —
 * which means a clone of _backgroundGroup inherits the real wallpaper's
 * per-frame culling state wholesale. In one sentence:
 *
 *   The wallpaper inside our glass only painted where THIS FRAME happened
 *   to be damaged.
 *
 * That is the whole bug. When a window behind the glass repaints on its own
 * (a system monitor, a terminal, a video), the frame's damage region is just
 * that window's rectangle. Any glass that re-captures its
 * ClutterOffscreenEffect FBO on that frame therefore captures the wallpaper
 * ONLY inside that rectangle and black everywhere else. Because
 * ClutterOffscreenEffect caches the FBO, the black then LATCHES until
 * something forces a full re-capture.
 *
 * Which is exactly the reported symptom, down to the details:
 *   - a bright rectangle around the updating background window, the rest of
 *     the glass filled flat (the tint over black);
 *   - a ~padding-wide gradient ring, darkening outwards, where the blur
 *     smears that black inwards from the FBO edge;
 *   - dump() / queue_redraw() / opening a menu clears it, because they force
 *     a full-screen damage and therefore a full, correct re-capture;
 *   - no reproduction steps, because it depends on which rectangle of the
 *     screen happened to be damaged on the frame the FBO was captured.
 *
 * THE FIX — and why it MUST still be painted through a Clone
 * ----------------------------------------------------------
 * Own the content, then clone OUR content. Both halves are required.
 *
 * Half 1: build our OWN Meta.BackgroundActor for each of the shell's,
 * sharing the same Meta.Background (no second wallpaper decode, no extra
 * texture) but carrying its own MetaBackgroundContent. Our actors hang off
 * a plain Clutter.Actor outside the window group, and
 * cull_out_children_common() in meta-cullable.c stops at any child that is
 * not a MetaCullable:
 *
 *     if (!META_IS_CULLABLE (child))
 *       continue;
 *
 * so our content's clip_region and unobscured_region stay NULL forever.
 *
 * Half 2 — THE PART THE FIRST ATTEMPT MISSED. Killing clip_region is not
 * enough, because paint_content has a SECOND clip and it reads the damage
 * region straight off the paint context:
 *
 *     if (untransformed) {
 *         if (self->clip_region) { ... }
 *         else {
 *             redraw_clip = clutter_paint_context_get_redraw_clip (paint_context);
 *             if (redraw_clip) { region = copy (redraw_clip); ... }   // <-- still partial!
 *         }
 *     } else {
 *         if (self->clip_region) { ... }
 *         else
 *             region = mtk_region_create_rectangle (&rect_within_actor);  // <-- FULL
 *     }
 *
 * and clutter_paint_context_push_framebuffer() does NOT reset redraw_clip,
 * so inside a glass's offscreen FBO it is still the frame's stage damage.
 *
 * `untransformed` is true exactly when the actor's stage rect equals its own
 * content box — which is precisely the case for a wallpaper actor parked at
 * (0,0) at monitor size, i.e. ours. So painting our mirror DIRECTLY lands in
 * the redraw_clip branch and is clipped to the damage region anyway. That is
 * what the first attempt did, and it was strictly WORSE than the clone it
 * replaced: dock / menu / OSD glasses paint from uiGroup, OUTSIDE the window
 * group, where clip_region has already been reset to NULL — so their clones
 * used to paint in full. Measured on two screencasts of the same bug:
 * 8% of frames flat-filled before, 34% after.
 *
 * The `else` branch is unconditional and full, and the way into it is
 * `clutter_actor_is_in_clone_paint()`, which is ancestor-aware:
 *
 *     if (self->priv->in_clone_paint) return TRUE;
 *     ... walks priv->parent while in_cloned_branch != 0 ...
 *
 * So: keep ONE shared source actor holding our uncalled background contents,
 * and give every glass a Clutter.Clone of it. In the clone paint
 * untransformed is FALSE and clip_region is NULL, which is the one
 * combination that paints the whole wallpaper unconditionally.
 *
 * It also restores the shell's wallpaper cross-fade inside the glass for
 * free: the glass clones a GROUP holding both the outgoing and incoming
 * background actors at their live opacities, exactly as cloning
 * _backgroundGroup used to.
 */
export const BackgroundMirror = GObject.registerClass(class BackgroundMirror extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        this._mirrors = new Map();
        this._groupHandlers = [];
        this._sourceGroup = null;
        const group = Main.layoutManager?._backgroundGroup ?? null;
        if (!group)
            return;
        this._sourceGroup = group;
        this._groupHandlers.push(group.connect('child-added', (_g, child) => this._addMirror(child)), group.connect('child-removed', (_g, child) => this._removeMirror(child)), 
        // [wallpaper-ease] Reordering is NOT child-added/child-removed.
        //
        // BackgroundManager._createBackgroundActor() (js/ui/background.js)
        // does add_child() and then, immediately:
        //
        //     this._container.set_child_below_sibling(backgroundActor, null);
        //
        // and clutter_actor_set_child_below_sibling() re-links the child with
        // ADD_CHILD_NOTIFY_FIRST_LAST / REMOVE_CHILD_NOTIFY_FIRST_LAST —
        // single bits that notify first-child/last-child and deliberately do
        // NOT emit child-added/child-removed. So our restack ran while the new
        // wallpaper was still on top, and never ran again once the shell moved
        // it to the bottom.
        //
        // That inverted our stacking for the whole cross-fade: the shell fades
        // the OLD actor 255 -> 0 on top of the new one
        // (_swapBackgroundActor(), FADE_ANIMATION_TIME), so with our order
        // flipped the incoming wallpaper sat opaque ON TOP and the glass
        // simply snapped to it while the desktop faded correctly.
        group.connect('notify::first-child', () => this._restack()), group.connect('notify::last-child', () => this._restack()));
        this.connect('destroy', () => this._onDestroy());
        for (const child of group.get_children())
            this._addMirror(child);
    }
    // Every MetaBackgroundContent property worth mirroring. `background` is
    // the important one (it carries the wallpaper texture); the rest are what
    // the shell animates for the overview dim / login vignette, and mirroring
    // them keeps the glass consistent with the desktop underneath it.
    _contentProps() {
        return [
            'background',
            'brightness',
            'vignette',
            'vignette-sharpness',
            'gradient',
            'gradient-height',
            'gradient-max-darkness',
            'rounded-clip-radius',
        ];
    }
    _addMirror(child) {
        try {
            this._addMirrorUnsafe(child);
        }
        catch (e) {
            // A glass with a stale wallpaper is a cosmetic problem; a glass that
            // failed to build is a broken window. Never let this path throw into
            // ApplicationManager's actor construction.
            utilsLog(`[bg-mirror] _addMirror failed: ${e}`);
        }
    }
    _addMirrorUnsafe(child) {
        if (!child || this._mirrors.has(child))
            return;
        const srcContent = child.content;
        // Only MetaBackgroundActors carry a MetaBackgroundContent. Anything
        // else another extension parked in the background group is not ours
        // to reproduce, and cloning it would reintroduce the very coupling
        // this class exists to remove.
        if (!srcContent || !(srcContent instanceof Meta.BackgroundContent))
            return;
        let mirror;
        try {
            mirror = new Meta.BackgroundActor({
                meta_display: global.display,
                monitor: child.monitor,
                reactive: false,
            });
        }
        catch (e) {
            utilsLog(`[bg-mirror] could not create Meta.BackgroundActor: ${e}`);
            return;
        }
        mirror.set_name('lg-bg-mirror');
        // [CRASH] Start hidden, and stay hidden until the content actually has
        // a MetaBackground. This is not defensive padding — it is load-bearing.
        //
        // meta_background_get_texture() (mutter 50.1,
        // src/compositor/meta-background.c) reads self->display in its variable
        // declarations, i.e. BEFORE its own guard:
        //
        //     MetaContext *context = meta_display_get_context (self->display);
        //     ...
        //     g_return_val_if_fail (META_IS_BACKGROUND (self), NULL);
        //
        // so painting a MetaBackgroundContent whose background is NULL
        // dereferences NULL and takes the whole compositor down with SIGSEGV --
        // confirmed the hard way, a full session loss to greetd
        // (2026-09-17 20:42:59, org.gnome.Shell@ubuntu.service status=11/SEGV,
        // stack: clutter_frame_clock_dispatch -> clutter_stage_paint_view ->
        // ... -> clutter_actor_continue_paint -> libmutter).
        //
        // The shell adds a background actor to the group and assigns its
        // MetaBackground afterwards, so 'child-added' genuinely can reach us
        // with background == NULL. A hidden actor is never painted, so gating
        // visibility on it is what keeps that window closed.
        mirror.visible = false;
        const dstContent = mirror.content;
        if (dstContent) {
            for (const prop of this._contentProps()) {
                try {
                    srcContent.bind_property(prop, dstContent, prop, GObject.BindingFlags.SYNC_CREATE);
                }
                catch (e) {
                    // A property that does not exist on this mutter version is not
                    // fatal — the wallpaper itself ('background') is what matters.
                    utilsLog(`[bg-mirror] skipped content prop '${prop}': ${e}`);
                }
            }
            // Belt and braces: SYNC_CREATE should have carried the background
            // across already, but the whole class is worthless (and dangerous)
            // if it did not, so set it outright too.
            try {
                if (!dstContent.background && srcContent.background)
                    dstContent.set_background(srcContent.background);
            }
            catch (e) {
                utilsLog(`[bg-mirror] set_background failed: ${e}`);
            }
        }
        try {
            child.bind_property('opacity', mirror, 'opacity', GObject.BindingFlags.SYNC_CREATE);
        }
        catch (e) {
            utilsLog(`[bg-mirror] opacity binding failed: ${e}`);
        }
        // Visibility is computed rather than bound, because it has to answer to
        // the background-is-NULL gate above as well as to the real actor.
        const syncVisible = () => {
            if (!isActorValid(mirror))
                return;
            let hasBackground = false;
            try {
                hasBackground = !!(mirror.content && mirror.content.background);
            }
            catch (_) { /* noop */ }
            const wanted = hasBackground && isActorValid(child) && child.visible;
            if (mirror.visible !== wanted)
                mirror.visible = wanted;
        };
        const watchers = [];
        try {
            watchers.push([child, child.connect('notify::visible', syncVisible)]);
            // notify::first-child / last-child cannot see a reorder among MIDDLE
            // children, and the group holds two actors per monitor mid-fade. The
            // fade itself ticks opacity every frame, so piggyback on it; _restack()
            // compares before it writes, so the steady state costs one loop over
            // two or three actors.
            watchers.push([child, child.connect('notify::opacity', () => this._restack())]);
            if (dstContent)
                watchers.push([dstContent, dstContent.connect('notify::background', syncVisible)]);
        }
        catch (e) {
            utilsLog(`[bg-mirror] visibility watchers failed: ${e}`);
        }
        mirror.connect('destroy', () => {
            for (const [obj, id] of watchers) {
                try {
                    obj.disconnect(id);
                }
                catch (_) { /* noop */ }
            }
            watchers.length = 0;
        });
        syncVisible();
        // Geometry follows the real actor's allocation. Both live at the same
        // origin (the background group is at 0,0 and so are we), so a straight
        // BindConstraint is all that is needed — and it keeps tracking through
        // monitor changes without any signal bookkeeping of our own.
        mirror.set_position(child.x, child.y);
        mirror.set_size(child.width, child.height);
        // Four separate constraints, NOT BindCoordinate.ALL: Clutter 18's
        // ClutterBindCoordinate enum only defines X, Y, WIDTH and HEIGHT (0-3).
        // The POSITION/SIZE/ALL members that older Clutter had are gone, so
        // `Clutter.BindCoordinate.ALL` is undefined here and would have bound
        // nothing useful — leaving the mirror at 0x0, i.e. a glass with no
        // wallpaper in it at all.
        for (const coordinate of [
            Clutter.BindCoordinate.X,
            Clutter.BindCoordinate.Y,
            Clutter.BindCoordinate.WIDTH,
            Clutter.BindCoordinate.HEIGHT,
        ]) {
            mirror.add_constraint(new Clutter.BindConstraint({ source: child, coordinate }));
        }
        this._mirrors.set(child, mirror);
        this.add_child(mirror);
        // Keep our stacking identical to the group's: the shell's cross-fade
        // relies on the incoming wallpaper sitting ABOVE the outgoing one.
        this._restack();
    }
    _removeMirror(child) {
        const mirror = this._mirrors.get(child);
        if (!mirror)
            return;
        this._mirrors.delete(child);
        if (isActorValid(mirror))
            mirror.destroy();
    }
    // Puts our children in the same order as the real background group's.
    //
    // Compare-then-write: set_child_at_index() re-links the child and queues a
    // relayout even when the index does not change, and this runs from the
    // fade's opacity ticks as well as from the reorder notifications.
    _restack() {
        if (!isActorValid(this._sourceGroup))
            return;
        const wanted = [];
        for (const child of this._sourceGroup.get_children()) {
            const mirror = this._mirrors.get(child);
            if (mirror && isActorValid(mirror))
                wanted.push(mirror);
        }
        const current = this.get_children();
        let ordered = current.length === wanted.length;
        if (ordered) {
            for (let i = 0; i < wanted.length; i++) {
                if (current[i] !== wanted[i]) {
                    ordered = false;
                    break;
                }
            }
        }
        if (ordered)
            return;
        for (let i = 0; i < wanted.length; i++)
            this.set_child_at_index(wanted[i], i);
        // Only ever logged when the order really moved, which in practice means
        // a wallpaper cross-fade just started.
        utilsLog(`[bg-mirror] restacked ${wanted.length} wallpaper mirror(s)`);
    }
    _onDestroy() {
        if (isActorValid(this._sourceGroup)) {
            for (const id of this._groupHandlers) {
                try {
                    this._sourceGroup.disconnect(id);
                }
                catch (_) { /* noop */ }
            }
        }
        this._groupHandlers = [];
        this._mirrors.clear();
        this._sourceGroup = null;
    }
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking, exactly like UnpickableClone.
    }
});
// [black-frame] A/B switch for the fix above. `true` clones our own
// BackgroundMirror (uncalled MetaBackgroundContent, painted through a Clone so
// paint_content takes its unconditional full-rect branch); `false` restores
// the historical Clone of _backgroundGroup, which is what produced the black
// frame. Default on.
let _backgroundMirrorEnabled = true;
export function setBackgroundMirrorEnabled(enabled) {
    _backgroundMirrorEnabled = !!enabled;
}
export function isBackgroundMirrorEnabled() {
    return _backgroundMirrorEnabled;
}
// The single BackgroundMirror every glass clones.
//
// One shared source, not one per glass: the contents are identical, and
// WindowCloneManager.rebuildClones() throws its wallpaper actor away and
// builds a new one often enough that creating a MetaBackgroundContent (and
// its Cogl pipeline) per rebuild was a real cost.
let _sharedBackgroundSource = null;
function ensureSharedBackgroundSource() {
    if (isActorValid(_sharedBackgroundSource))
        return _sharedBackgroundSource;
    _sharedBackgroundSource = null;
    const uiGroup = Main.layoutManager?.uiGroup ?? null;
    const group = Main.layoutManager?._backgroundGroup ?? null;
    if (!uiGroup || !group)
        return null;
    const source = new BackgroundMirror();
    source.set_name('lg-bg-mirror-source');
    source.set_position(0, 0);
    source.set_size(group.width, group.height);
    // Track the group through monitor changes: every caller does
    // clone.set_size(monitor...), and ClutterClone scales the source into that,
    // so a stale source size would scale the wallpaper.
    for (const coordinate of [Clutter.BindCoordinate.WIDTH, Clutter.BindCoordinate.HEIGHT]) {
        try {
            source.add_constraint(new Clutter.BindConstraint({ source: group, coordinate }));
        }
        catch (e) {
            utilsLog(`[bg-mirror] source size constraint failed: ${e}`);
        }
    }
    // Opacity 0, NOT visible=false. clutter_actor_paint() bails out at the top
    // on a zero paint opacity:
    //
    //     if (!CLUTTER_ACTOR_IS_TOPLEVEL (self) &&
    //         ((priv->opacity_override >= 0) ? priv->opacity_override : priv->opacity) == 0)
    //       return;
    //
    // so on the real screen this costs one comparison and draws nothing — while
    // ClutterClone sets opacity_override to ITS OWN paint opacity before
    // painting the source, so every glass still gets a fully opaque wallpaper.
    // Hiding it instead would take it out of the mapped/allocated set and make
    // the clones depend on the has_mapped_clones path, which is a far subtler
    // contract to rely on.
    source.opacity = 0;
    source.reactive = false;
    // uiGroup, deliberately: it is a sibling of global.window_group, so
    // meta_window_group_paint()'s cull walk can never reach our contents.
    uiGroup.add_child(source);
    source.connect('destroy', () => {
        if (_sharedBackgroundSource === source)
            _sharedBackgroundSource = null;
    });
    _sharedBackgroundSource = source;
    return source;
}
/**
 * [window-clone-clip] Makes mutter stop clipping a window we CLONE to the
 * current frame's damage region.
 *
 * Same trap as BackgroundMirror, one actor further along. MetaSurfaceActor
 * implements MetaCullable, and its cull methods stash the frame's damage on
 * the texture that actually paints the window
 * (mutter 50.1, src/compositor/meta-surface-actor.c):
 *
 *     meta_surface_actor_cull_redraw_clip (cullable, clip_region)
 *       -> set_clip_region()  -> meta_shaped_texture_set_clip_region (stex, ...)
 *     meta_surface_actor_cull_unobscured (cullable, unobscured_region)
 *       -> set_unobscured_region()
 *
 * and meta_shaped_texture_paint_content() applies it with NO clone escape
 * hatch at all — unlike MetaBackgroundContent, it never even looks at
 * clutter_actor_is_in_clone_paint():
 *
 *     if (stex->clip_region && mtk_region_is_empty (stex->clip_region))
 *       return;                                    // paints NOTHING
 *     ...
 *     blended_tex_region = mtk_region_ref (stex->clip_region);
 *
 * So a Clutter.Clone of a MetaWindowActor paints that window only where the
 * frame happened to be damaged. Inside a glass that reads as: the wallpaper
 * is there (BackgroundMirror fixed that), but the windows behind the glass
 * are missing or smeared — the glass shows plain wallpaper where a behind-
 * window should be, a repaint leaves the previous frame's colours behind,
 * and opening a menu or clicking the panel makes the behind-window clones
 * vanish entirely for a frame while the wallpaper stays put.
 *
 * mutter has an opt-out for exactly this, in meta-cullable.c, and says so:
 *
 *     // If an actor has effects applied, then that can change the area
 *     // it paints and the opacity ... so we skip the actor.
 *     //
 *     // This has a secondary beneficial effect: if a ClutterOffscreenEffect
 *     // is applied to an actor, then our clipped redraws interfere with the
 *     // caching of the FBO ...  So, skipping actors with effects applied
 *     // also prevents these bugs.
 *     if (needs_culling && has_active_effects (child))
 *       needs_culling = FALSE;
 *     ...
 *     else
 *       method (META_CULLABLE (child), NULL);      // clip/unobscured := NULL
 *
 * has_active_effects() is just "does this actor carry an enabled
 * ClutterEffect", so parking a do-nothing effect on a window actor we clone
 * makes mutter hand its surface actor a NULL clip region and the clone paints
 * in full.
 *
 * Cost: that branch `continue`s without subtracting the actor's opaque region,
 * so a window carrying the opt-out no longer occludes what is behind it.
 * Only windows currently cloned into a glass get one, and the effect is
 * dropped again as soon as the last clone of them goes away.
 */
export const CullOptOutEffect = GObject.registerClass(
// Deliberately empty: ClutterEffectClass->paint defaults to
// clutter_effect_real_paint(), which ends in add_actor_node() — a plain
// pass-through. The effect exists only to be counted by has_active_effects().
class CullOptOutEffect extends Clutter.Effect {
});
const CULL_OPT_OUT_NAME = 'lg-cull-opt-out';
const _cullOptOutOwners = new Map();
const _cullOptOutEffects = new Map();
let _cullOptOutEnabled = true;
function _reconcileCullOptOut() {
    const before = _cullOptOutEffects.size;
    const wanted = new Set();
    if (_cullOptOutEnabled) {
        for (const actors of _cullOptOutOwners.values()) {
            for (const actor of actors) {
                if (isActorValid(actor))
                    wanted.add(actor);
            }
        }
    }
    for (const actor of wanted) {
        if (_cullOptOutEffects.has(actor))
            continue;
        try {
            const effect = new CullOptOutEffect();
            actor.add_effect_with_name(CULL_OPT_OUT_NAME, effect);
            _cullOptOutEffects.set(actor, effect);
        }
        catch (e) {
            utilsLog(`[cull-opt-out] could not attach: ${e}`);
        }
    }
    for (const [actor, effect] of [..._cullOptOutEffects.entries()]) {
        if (wanted.has(actor))
            continue;
        _cullOptOutEffects.delete(actor);
        try {
            if (isActorValid(actor))
                actor.remove_effect(effect);
        }
        catch (_) { /* noop */ }
    }
    if (_cullOptOutEffects.size !== before) {
        // Only ever logged when the set really moved, i.e. a window started or
        // stopped being cloned into some glass.
        utilsLog(`[cull-opt-out] holding ${_cullOptOutEffects.size} window actor(s)` +
            ` [${[..._cullOptOutEffects.keys()].map(a => {
                try {
                    return a.get_meta_window()?.get_title() ?? '?';
                }
                catch (_) {
                    return '?';
                }
            }).join(', ')}]`);
    }
}
function _sameSet(a, b) {
    if (!a)
        return false;
    let n = 0;
    for (const x of b) {
        if (!a.has(x))
            return false;
        n++;
    }
    return n === a.size;
}
/**
 * Declares which window actors `owner` currently clones. Safe to call every
 * frame: it returns immediately unless the set actually changed.
 */
export function reportClonedWindowActors(owner, actors) {
    if (_sameSet(_cullOptOutOwners.get(owner), actors))
        return;
    _cullOptOutOwners.set(owner, new Set(actors));
    _reconcileCullOptOut();
}
/** Drops `owner`'s claim; call when a manager or a window's glass goes away. */
export function releaseClonedWindowActors(owner) {
    if (_cullOptOutOwners.delete(owner))
        _reconcileCullOptOut();
}
/** Drops every claim and every effect; call from the extension's disable(). */
export function releaseAllClonedWindowActors() {
    _cullOptOutOwners.clear();
    _reconcileCullOptOut();
}
// A/B switch. false restores mutter's normal culling of cloned windows, i.e.
// the damage-clipped behaviour described above, and with it the occlusion
// culling that the opt-out gives up.
export function setCullOptOutEnabled(enabled) {
    _cullOptOutEnabled = !!enabled;
    _reconcileCullOptOut();
}
export function isCullOptOutEnabled() {
    return _cullOptOutEnabled;
}
/** The shared source if one exists; never creates one. */
export function getSharedBackgroundSource() {
    return isActorValid(_sharedBackgroundSource) ? _sharedBackgroundSource : null;
}
/** Tears the shared source down; call from the extension's disable(). */
export function destroySharedBackgroundSource() {
    const source = _sharedBackgroundSource;
    _sharedBackgroundSource = null;
    if (isActorValid(source)) {
        try {
            source.destroy();
        }
        catch (_) { /* noop */ }
    }
}
/**
 * Builds the wallpaper actor that sits at the back of a glass.
 *
 * Always a Clutter.Clone — see BackgroundMirror's comment for why painting
 * the background content directly would put it back under the frame's damage
 * region. What changes is WHAT is cloned: our own uncalled mirror normally,
 * or the shell's _backgroundGroup when the A/B switch is off.
 */
export function createBackgroundMirror(name) {
    let source = null;
    if (_backgroundMirrorEnabled) {
        try {
            source = ensureSharedBackgroundSource();
        }
        catch (e) {
            utilsLog(`[bg-mirror] shared source unavailable, falling back: ${e}`);
            source = null;
        }
    }
    if (!source)
        source = Main.layoutManager._backgroundGroup;
    const clone = new UnpickableClone({ source });
    clone.set_name(name);
    return clone;
}
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
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking.
    }
});
/**
 * Paints a captured texture stretched to fill its own allocation, without
 * ever triggering the source actor's own paint. Used for the "read an
 * existing OffscreenEffect's texture" fallback path (see
 * UILayerSampler._createExistingEffectBlitActor): unlike Clutter.Clone,
 * this never re-evaluates the source's effect chain, so it can't cause the
 * "two consumers" ownership conflict described on SelfExcludingSnapshotCapture.
 */
export const TextureBlitActor = GObject.registerClass({
    GTypeName: 'LiquidGlassTextureBlitActor',
}, class TextureBlitActor extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        this._getTexture = null;
        this._sourceActor = null;
        this._pipeline = null;
    }
    vfunc_pick(_pickContext) { }
    setTextureGetter(fn) {
        this._getTexture = fn;
    }
    setSourceActor(actor) {
        this._sourceActor = actor;
    }
    _getCoglContext() {
        try {
            const backend = Clutter.get_default_backend();
            return backend.get_cogl_context();
        }
        catch (e) {
            return null;
        }
    }
    vfunc_paint(paintContext) {
        if (!this._getTexture)
            return;
        const tex = this._getTexture();
        if (!tex)
            return;
        try {
            if (!this._pipeline) {
                const ctx = this._getCoglContext();
                if (!ctx)
                    return;
                this._pipeline = Cogl.Pipeline.new(ctx);
                this._pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
                this._pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            }
            const texW = tex.get_width();
            const texH = tex.get_height();
            // A ClutterOffscreenEffect's captured texture is a few pixels larger
            // than the actor's logical size, and — contrary to what this used to
            // assume — that padding is NOT centred: it is 2px on the left/top and
            // 1px on the right/bottom (see computeCaptureLayout()). Sample only
            // the sub-rectangle that actually holds the source's own pixels.
            let uMin = 0, vMin = 0, uMax = 1, vMax = 1;
            const src = this._sourceActor;
            if (src) {
                const [rawW, rawH] = getAllocatedSize(src);
                const allocW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : texW;
                const allocH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : texH;
                if ((allocW !== texW || allocH !== texH) && texW > 0 && texH > 0) {
                    const uv = computeCaptureLayout(src, texW, texH, allocW, allocH).uv;
                    uMin = uv[0];
                    vMin = uv[1];
                    uMax = uv[2];
                    vMax = uv[3];
                }
            }
            this._pipeline.set_layer_texture(0, tex);
            const [w, h] = this.get_size();
            if (!(w > 0) || !(h > 0))
                return;
            const fb = paintContext.get_framebuffer();
            fb.draw_textured_rectangle(this._pipeline, 0, 0, w, h, uMin, vMin, uMax, vMax);
        }
        catch (e) {
        }
    }
});
/**
 * Clones every actor under `Main.layoutManager.uiGroup` into a private
 * container so the glass can render a distorted/blurred view of "everything
 * behind it" (panel, windows, other extensions' UI). One instance per glass
 * (permanent dock glass, popup-menu glass, etc).
 */
/**
 * How UILayerSampler supplies a uiGroup child that has a Blur My Shell target
 * under it.
 *
 * Neither of the first two is right, and which one is in use decides which
 * symptom appears — measured in a native session by toggling the two
 * extensions on in either order:
 *
 *   SNAPSHOT — Liquid Glass sees BMS at clone time and takes a self-excluding
 *     stage snapshot of the child's rect. BMS itself keeps working, but the
 *     snapshot is of the WHOLE stage cropped to that rect, so anything else
 *     overlapping it is captured too: with the dock moved to the top edge it
 *     overlaps the panel and its icons show up as ghosts inside the dock's own
 *     glass. The window texture lag was reported in this configuration as well.
 *
 *   CLONE — Liquid Glass was enabled first, found no BMS target, and made an
 *     ordinary Clutter.Clone. No ghosts and no lag, but BMS's own panel
 *     rendering drifts by about 10px wherever the dock overlaps the panel:
 *     Shell.BlurEffect in background mode samples the framebuffer under the
 *     actor, and painting that actor a second time inside our offscreen gives
 *     it a second, differently-positioned consumer.
 *
 *   SKIP — leave the child out of the glass entirely. No ghosts, no lag, BMS
 *     untouched; the cost is that the panel simply does not appear in the
 *     blurred backdrop.
 *
 * Switchable at runtime (global._lgGlass.bmsMode(n)) so the attribution can be
 * settled inside one session instead of by rebuilding between orders.
 */
export const BMS_MODE = { SNAPSHOT: 0, CLONE: 1, SKIP: 2, REPLICATE: 3 };
// [FIX] SKIP is the default, confirmed by switching all three modes in one
// native session with BMS's dynamic panel blur on:
//
//   0 SNAPSHOT -> window texture lag + the dock's own icons ghosted into its
//                 glass (the snapshot is the whole stage cropped to the
//                 child's rect, and it runs a full stage paint with our root
//                 hidden on every after-paint — the very "toggle live UI
//                 visibility every frame" that memo.md's addendum 3 records
//                 as breaking Clutter's damage bookkeeping)
//   1 CLONE    -> lag and ghosts gone, but BMS's own panel drifts ~10px
//                 wherever the dock overlaps it
//   2 SKIP     -> all three gone; the panel simply is not in the glass
//
// SKIP breaks nothing, but it gives up the panel: with the dock at the top
// edge the dock's glass is drawn ABOVE panelBox, so a panel that is not in the
// glass is a panel that is not on screen there at all.
//
//   3 REPLICATE -> the default. None of the three costs above.
//
// REPLICATE works because of one structural detail of BMS: it inserts its
// blur widget into panel_box as a SIBLING of the panel
// (components/panel.js — `panel_box.insert_child_at_index(background_group, 0)`),
// not as a child of it. So "the panel without BMS's blur widget" is not
// something that has to be filtered out of a clone — it is simply a different
// actor to clone. BMS is then never painted a second time, which is the whole
// of the CLONE problem, and nothing is snapshotted, which is the whole of the
// SNAPSHOT problem.
//
// What that leaves missing is the blurred backdrop BMS draws behind the panel,
// so we draw our own in its place: the same effect class BMS uses
// (Shell.BlurEffect in BACKGROUND mode — see BMS's
// effects/native_dynamic_gaussian_blur.js) with the same live radius and
// brightness, sitting under the panel clone inside our own offscreen, where
// what is "behind" it is our own cloned wallpaper and windows. Same effect,
// same parameters, same input relationship — so it reproduces what BMS draws
// rather than approximating it.
let _bmsMode = BMS_MODE.REPLICATE;
// Every live sampler, so a mode change can rebuild the affected clones.
const _liveSamplers = new Set();
export function setBmsMode(mode) {
    _bmsMode = mode;
    let n = 0;
    for (const sampler of _liveSamplers) {
        try {
            sampler.rebuildBmsClones();
            n++;
        }
        catch (_) { }
    }
    const name = mode === BMS_MODE.SNAPSHOT ? 'SNAPSHOT'
        : mode === BMS_MODE.CLONE ? 'CLONE'
            : mode === BMS_MODE.SKIP ? 'SKIP'
                : mode === BMS_MODE.REPLICATE ? 'REPLICATE' : `? (${mode})`;
    const msg = `[Liquid Glass] BMS mode = ${name} on ${n} sampler(s)`;
    console.log(msg);
    return msg;
}
export function getBmsMode() {
    return _bmsMode;
}
export class UILayerSampler {
    _selfActor;
    _container;
    _extraExclusions;
    _selfRoot = null;
    _label = '?';
    // Per cloned child: whether a Blur My Shell target was found under it at the
    // moment its clone was built.
    _bmsStateAtClone = new Map();
    // The BMS target actor as of the last refresh(), so a change can be noticed.
    _lastBmsTarget = undefined;
    _ancestorExclusionSources = [];
    // Names of the uiGroup children currently cloned, so a change can be logged
    // once instead of every frame.
    _clonedNamesLogged = '';
    _clones = new Map();
    _uiClonesContainer = null;
    // Read-only cache: for each uiGroup child, either the (actor, effect) pair
    // of an existing Clutter.OffscreenEffect found in its subtree, or null if
    // none was found. Never written to by us (no actor tree mutation), so
    // sharing this cache across multiple UILayerSampler instances is safe.
    _existingEffectCache = new Map();
    // While true, a uiGroup child containing the Blur My Shell target is
    // rendered via _createExistingEffectBlitActor() if a usable
    // Clutter.OffscreenEffect is found in its subtree. BMS's actual blur is a
    // native (non-JS) effect that never matches this, so BMS itself always
    // falls through — this toggle mainly matters for *other* extensions that
    // implement their effects as a JS Clutter.OffscreenEffect subclass.
    _useCaptureFixForBms = true;
    // clone actor -> { source actor (BMS target's uiGroup child), hideActor (our own selfRoot) }
    // Both are needed on destroy to release exactly what we registered on the
    // (possibly shared) SelfExcludingSnapshotCapture.
    _delayedCaptureOwners = new Map();
    // Clones currently rendering somewhere other than their source's own
    // screen rect — see _checkCloneDrift().
    _driftingClones = new Set();
    // [PERF ①b] Screen-coordinate rect this glass can actually show, or null
    // for "no culling" (the pre-① behaviour: cull only against the container,
    // i.e. the whole monitor). Set once per frame by syncGlassCaptureClip().
    _cullRect = null;
    // [PERF ①] Screen rects of the Blur My Shell replicas drawn this frame.
    //
    // A BACKGROUND-mode BMS blur takes its source rect in STAGE coordinates
    // and blits it out of whatever framebuffer is current — here, our
    // offscreen. If the capture clip stops the wallpaper and the window clones
    // from being painted under the panel, BMS blurs TRANSPARENT pixels, and
    // its gaussian smears that transparency back across the whole panel: the
    // "the blur peels away from the top" symptom from memo.md's 追記4, back
    // again. The panel is full width, so with the dock at the top edge (where
    // it overlaps the panel) the clip has to widen to the full screen — but
    // the HEIGHT still collapses, which is where most of the saving is.
    _bmsScreenRects = [];
    constructor(selfActor, container, extraExclusions = [], cloneContainer = null, label = '?', 
    /**
     * [FIX] Actors whose uiGroup ANCESTOR should be excluded, resolved fresh on
     * every refresh() instead of once at construction.
     *
     * extraExclusions above holds fixed actors, which is only correct while
     * the thing being excluded keeps the same uiGroup child as its root.
     * dockManager's use does not: it passes the uiGroup ancestor it walked to
     * at setup time, and Dash to Dock destroys and rebuilds its container
     * whenever its settings change — moving the dock to the top edge does
     * exactly that ("Dash to Dock container destroyed (settings changed?)" in
     * the log). A stale entry there means the sampler starts cloning the dock
     * into the dock's own glass, which shows up as ghost icons inside it.
     */
    ancestorExclusions = []) {
        this._selfActor = selfActor;
        this._container = container;
        this._extraExclusions = new Set(extraExclusions);
        this._ancestorExclusionSources = ancestorExclusions.slice();
        this._label = label;
        this._selfRoot = this._findUiGroupAncestor(selfActor);
        _liveSamplers.add(this);
        this._uiClonesContainer = new UnpickableActor();
        this._uiClonesContainer.set_name("ui-clones-container");
        // Connect to the destroy signal and assign null
        this._uiClonesContainer.connect('destroy', () => {
            this._uiClonesContainer = null;
        });
        if (cloneContainer) {
            cloneContainer.add_child(this._uiClonesContainer);
        }
        else {
            this._container.add_child(this._uiClonesContainer);
        }
    }
    /**
     * [PERF ①b] Restricts clone culling to `rect` (screen coordinates), or
     * null to fall back to culling against the container's own bounds.
     */
    setCullRect(rect) {
        this._cullRect = rect;
    }
    /**
     * [PERF ①] Screen rects of the BMS replicas painted during the LAST sync.
     * One frame old by construction (they are recorded while the clones are
     * synced, and the clip is computed before that) — harmless, because the
     * panel does not move. Empty when this glass draws no BMS replica.
     */
    getBmsScreenRects() {
        return this._bmsScreenRects;
    }
    /** True when this sampler has a BMS replica whose rect is not known yet. */
    hasUnmeasuredBmsReplica() {
        if (this._bmsScreenRects.length > 0)
            return false;
        for (const clone of this._clones.values()) {
            if (clone._lgBmsReplica)
                return true;
        }
        return false;
    }
    _findUiGroupAncestor(actor) {
        const uiGroup = Main.layoutManager.uiGroup;
        let current = actor;
        while (current) {
            if (current.get_parent() === uiGroup)
                return current;
            current = current.get_parent();
        }
        return null;
    }
    /** Adds an actor to the set of uiGroup children that should never be cloned. */
    addExclusion(actor) {
        if (!actor)
            return;
        this._extraExclusions.add(actor);
    }
    /**
     * Resolves the Blur My Shell panel-blur target actor via
     * Main.extensionManager, if BMS is installed and enabled and its internal
     * structure matches what we expect. Everything here is best-effort and
     * guarded: if BMS is absent or has changed shape, this simply returns
     * null and callers fall back to normal cloning.
     */
    _resolveBmsTargetActor() {
        try {
            const ext = Main.extensionManager?.lookup?.('blur-my-shell@aunetx');
            const actor = ext?.stateObj?._panel_blur?.actors_list?.[0]?.bg_manager?.backgroundActor;
            return actor ?? null;
        }
        catch (_) {
            return null;
        }
    }
    /**
     * Returns the BMS target actor if `child` (a direct uiGroup child) either
     * *is* the BMS target or contains it as a descendant — i.e. whether
     * cloning `child` would also clone BMS's blurred panel.
     */
    _findBmsDescendant(child) {
        const target = this._resolveBmsTargetActor();
        if (!target)
            return null;
        if (child === target)
            return target;
        try {
            if (typeof child.contains === 'function' && child.contains(target)) {
                return target;
            }
        }
        catch (_) { /* noop */ }
        return null;
    }
    /**
     * @deprecated no-op, kept only so older callers that still toggle these
     * debug switches don't break. The multi-paint diagnostic probe and the
     * "force-hide the BMS clone" A/B switch they used to control have both
     * been removed now that the real fix (SelfExcludingSnapshotCapture) is in
     * place.
     */
    setDebugDisableBmsClone(_disabled) { }
    /** @deprecated no-op, see setDebugDisableBmsClone. */
    setDebugBmsProbeEnabled(_enabled) { }
    /**
     * Builds the stand-in for a uiGroup child that holds a Blur My Shell target
     * (in practice: panelBox).
     *
     * Two actors, in this order:
     *
     *   1. an St.Widget carrying our own Shell.BlurEffect in BACKGROUND mode,
     *      standing exactly where BMS puts its own blurred widget, with BMS's
     *      current radius and brightness copied off its live effect;
     *   2. a clone of every OTHER child of panel_box — the panel itself.
     *
     * BMS's blur widget is deliberately not among them. It is a sibling of the
     * panel rather than a child (components/panel.js inserts background_group
     * into panel_box), so leaving it out costs nothing but choosing a different
     * actor to clone — and it is what keeps BMS's own effect from being painted
     * a second time, from a second framebuffer, which is what made the real
     * panel drift.
     *
     * Our blur samples what is behind it in OUR offscreen, which is the cloned
     * wallpaper and windows — the same relationship BMS's has to the real
     * framebuffer. So the panel appears inside the glass blurred the way BMS
     * blurs it, and our own glass blur then applies on top as it does to
     * everything else.
     */
    _createBmsReplicaActor(child) {
        try {
            const target = this._findBmsDescendant(child);
            if (!target)
                return null;
            // BMS's blur widget lives inside its own background group; that group is
            // the child of panel_box we must not clone.
            let bmsGroup = target;
            while (bmsGroup && bmsGroup.get_parent() !== child) {
                bmsGroup = bmsGroup.get_parent();
            }
            if (!bmsGroup)
                return null;
            const container = new UnpickableActor();
            container.set_name(`${child.name ?? 'bms'}-replica`);
            const blurWidget = new St.Widget({ name: 'lg-bms-replica-blur' });
            blurWidget.add_effect(this._buildReplicaBlurEffect(target));
            container.add_child(blurWidget);
            const parts = [];
            for (const c of child.get_children()) {
                if (c === bmsGroup)
                    continue;
                const clone = new UnpickableClone({ source: c });
                clone.set_name(`${c.name ?? 'part'}-replicaClone`);
                container.add_child(clone);
                parts.push({ src: c, clone });
            }
            if (parts.length === 0) {
                container.destroy();
                return null;
            }
            container._lgBmsReplica = { blurWidget, parts, bmsTarget: target };
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica built for ` +
                `name="${child.name ?? '(unnamed)'}" with ${parts.length} part(s)`);
            return container;
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler._createBmsReplicaActor', e);
            return null;
        }
    }
    /**
     * Where the actor's own pixels start inside the offscreen this sampler's
     * clones are drawn into, in pixels. Published by LiquidEffect each paint;
     * (0, 0) until then, and for any container that carries no such effect.
     */
    _captureOffset() {
        try {
            const off = this._container?._lgCaptureOffset;
            if (Array.isArray(off) && Number.isFinite(off[0]) && Number.isFinite(off[1]))
                return [off[0], off[1]];
        }
        catch (_) { /* noop */ }
        return [0, 0];
    }
    /**
     * Builds the blur effect for a replica, as the SAME CLASS Blur My Shell is
     * using on the real panel.
     *
     * [FIX] This used to hardcode Shell.BlurEffect, and that was a different
     * implementation from the one BMS had picked. BMS chooses at load time:
     *
     *   // blur-my-shell/effects/native_dynamic_gaussian_blur.js
     *   let BlurOrShell = await utils.import_in_shell_only('gi://Blur');
     *   if (BlurOrShell === null)
     *       BlurOrShell = await utils.import_in_shell_only('gi://Shell');
     *
     * Blur-1.0 is present on this system, so the real panel runs the Blur
     * module's effect while the replica ran gnome-shell's — which visibly
     * diverges as the radius grows. gnome-shell's blur only downscales while
     * BOTH dimensions exceed 256px (shell-blur-effect.c's
     * calculate_downscale_factor, and again in mutter's clutter-blur.c), and the
     * panel is 46px tall, so nothing is ever downscaled and the gaussian is asked
     * for ceil(1.5 * sigma) * 2 taps at full size: 18 at sigma 6, but 240 at
     * sigma 80. The result degrades toward unblurred exactly as reported, while
     * the real panel — a different implementation — stayed sharp-free.
     *
     * Rather than re-derive which module to import, take the class off BMS's own
     * live effect. That matches whatever it chose, including its subclass and
     * the corner-radius handling that only exists on the Blur module's branch.
     */
    _buildReplicaBlurEffect(bmsTarget) {
        try {
            const theirs = (bmsTarget.get_effects() ?? [])
                .find((e) => typeof e?.radius === 'number');
            if (theirs) {
                const Ctor = Object.getPrototypeOf(theirs)?.constructor;
                if (typeof Ctor === 'function') {
                    // corner_radius must ALWAYS be a number. BMS's constructor
                    // destructures it and, on the Blur-module branch, hands it straight
                    // to super() — `undefined` there is rejected by GObject with
                    // "Invalid value 'undefined' for property corner-radius", which is
                    // exactly what sent this down the fallback path on the first
                    // attempt. Its own unscaled_corner_radius getter reads a field that
                    // only its setter writes, and DummyPipeline sets `corner_radius`
                    // instead, so the unscaled one is undefined in practice.
                    const cornerRadius = theirs.unscaled_corner_radius ?? theirs.corner_radius ?? 0;
                    const params = {
                        unscaled_radius: theirs.unscaled_radius ?? theirs.radius ?? 0,
                        brightness: theirs.brightness ?? 1.0,
                        corner_radius: cornerRadius,
                    };
                    const ours = new Ctor(params);
                    utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica blur uses ` +
                        `${Ctor.name ?? '?'} (matching BMS's own effect), ` +
                        `unscaled_radius=${params.unscaled_radius} brightness=${params.brightness} ` +
                        `corner_radius=${params.corner_radius}`);
                    return ours;
                }
            }
        }
        catch (e) {
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] could not mirror BMS's ` +
                `blur effect (${e}); falling back to Shell.BlurEffect`);
        }
        // Fallback only: BMS not reachable, or its effect could not be copied.
        return new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: 0,
            brightness: 1.0,
        });
    }
    /**
     * Per-frame geometry for a replica built above. `source` is panel_box, so
     * every part is placed at its own position inside it, and the blur widget
     * takes the panel's rect — the same rect BMS gives its own widget in
     * update_size()'s dynamic branch (`background.x = panel.x`, etc).
     */
    _syncBmsReplica(source, replica) {
        try {
            const parts = replica.parts;
            let panelRect = null;
            for (const { src, clone } of parts) {
                if (!isActorValid(src) || !isActorValid(clone))
                    continue;
                const [w, h] = getAllocatedSize(src);
                if (!(w > 0) || !(h > 0)) {
                    setActorVisible(clone, false);
                    continue;
                }
                setPositionIfChanged(clone, src.x, src.y);
                setSizeIfChanged(clone, w, h);
                setOpacityIfChanged(clone, src.opacity);
                setActorVisible(clone, src.visible && src.mapped);
                if (!panelRect)
                    panelRect = [src.x, src.y, w, h];
            }
            const blurWidget = replica.blurWidget;
            if (isActorValid(blurWidget) && panelRect) {
                replica.panelRect = panelRect;
                // [FIX] Compensate for the offscreen's capture padding.
                //
                // A background-mode blur asks for its source by STAGE coordinates and
                // then blits that rectangle out of whatever framebuffer is current.
                // On the real panel those two spaces are the same. Inside our
                // offscreen they are not: ClutterOffscreenEffect enlarges the paint
                // box by 3px, so actor-local (0, 0) sits at texel (2, 2) and a blit
                // asking for stage (0, 0) reads two rows and columns of cleared
                // padding instead.
                //
                // That is what "the blur peels away from the top, by more the larger
                // the sigma" is: the gaussian smears those transparent rows down over
                // its whole radius, and where the blurred result is transparent the
                // sharp clone behind it shows through. At sigma 100 the smear is wider
                // than the 46px panel, which is why the blur looked like it had
                // vanished entirely. The real panel never shows it because it is not
                // being drawn into an offscreen at all.
                //
                // Shifting the widget by the padding makes the blit land on the actor's
                // own pixels. The visible backdrop moves by those same 2px, which on a
                // blurred image is not detectable.
                const [offX, offY] = this._captureOffset();
                setPositionIfChanged(blurWidget, panelRect[0] + offX, panelRect[1] + offY);
                setSizeIfChanged(blurWidget, panelRect[2], panelRect[3]);
                setActorVisible(blurWidget, true);
                // Track BMS's live values rather than re-reading its settings: the
                // effect already holds them scaled by the theme's scale factor.
                const src = replica.bmsTarget;
                let ours = blurWidget.get_effects()[0];
                if (ours && isActorValid(src)) {
                    const theirs = (src.get_effects() ?? []).find((e) => typeof e?.radius === 'number');
                    if (theirs) {
                        // [FIX] Self-heal a class mismatch. The replica is built once, and
                        // if BMS's effect was not on its actor yet — or constructing its
                        // class failed — the fallback would otherwise stay for the life of
                        // the clone, silently blurring by a different implementation than
                        // the real panel. Rebuilding it here costs one comparison a frame.
                        if (Object.getPrototypeOf(ours)?.constructor !==
                            Object.getPrototypeOf(theirs)?.constructor) {
                            try {
                                blurWidget.remove_effect(ours);
                                blurWidget.add_effect(this._buildReplicaBlurEffect(src));
                                ours = blurWidget.get_effects()[0];
                            }
                            catch (_) { /* keep the one we have */ }
                        }
                        if (ours.radius !== theirs.radius)
                            ours.radius = theirs.radius;
                        if (ours.brightness !== theirs.brightness)
                            ours.brightness = theirs.brightness;
                    }
                }
            }
            this._reportReplicaGeometry(source, replica);
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler._syncBmsReplica', e);
        }
    }
    /**
     * [DIAG] Logs the replica's real geometry whenever it changes.
     *
     * The blurred band inside the glass not lining up with the panel is a
     * question about coordinates — where the blur widget ended up, and which
     * space Shell.BlurEffect resolved it in — and none of that is visible from
     * the outside. Reported on change only, so a stable panel costs one line.
     */
    _reportReplicaGeometry(source, replica) {
        if (!_utilsLogger)
            return;
        try {
            const blurWidget = replica.blurWidget;
            const [srcAbsX, srcAbsY] = source.get_transformed_position();
            const [bwAbsX, bwAbsY] = blurWidget.get_transformed_position();
            const [bwW, bwH] = blurWidget.get_size();
            const ours = blurWidget.get_effects()[0];
            const theirs = (replica.bmsTarget?.get_effects?.() ?? [])
                .find((e) => typeof e?.radius === 'number');
            const parts = replica.parts
                .map((p) => `${p.src.name ?? '?'}@(${p.src.x},${p.src.y})` +
                `${getAllocatedSize(p.src)[0]}x${getAllocatedSize(p.src)[1]}`)
                .join(' ');
            const line = `src=${source.name ?? '?'}@(${Math.round(srcAbsX)},${Math.round(srcAbsY)}) ` +
                `parts=[${parts}] ` +
                `blur=(${blurWidget.x},${blurWidget.y}) ${bwW}x${bwH} ` +
                `blurAbs=(${Math.round(bwAbsX)},${Math.round(bwAbsY)}) ` +
                `r=${ours?.radius}/${theirs?.radius} b=${ours?.brightness}/${theirs?.brightness} ` +
                `capOff=(${this._captureOffset()[0]},${this._captureOffset()[1]}) ` +
                `cls=${Object.getPrototypeOf(ours ?? {})?.constructor?.name ?? '?'}/` +
                `${Object.getPrototypeOf(theirs ?? {})?.constructor?.name ?? '?'}`;
            if (line === replica.lastGeomLine)
                return;
            replica.lastGeomLine = line;
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica geom ${line}`);
        }
        catch (_) { /* noop */ }
    }
    /**
     * Primary path for rendering the BMS-blurred panel inside the glass. See
     * SelfExcludingSnapshotCapture for the full rationale. Returns null (and
     * lets the caller fall back) if this Clutter version lacks
     * `Stage.paint_to_content()`.
     */
    _createSelfExcludingSnapshotActor(child) {
        try {
            const stage = child.get_stage();
            if (!stage)
                return null;
            if (typeof stage.paint_to_content !== 'function')
                return null;
            if (!this._selfRoot)
                return null;
            const selfRoot = this._selfRoot;
            const rectGetter = () => {
                const [x, y] = child.get_transformed_position();
                const [w, h] = getAllocatedSize(child);
                if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0) {
                    return [0, 0, 0, 0];
                }
                return [x, y, w, h];
            };
            const capture = acquireSelfExcludingSnapshot(child, stage, selfRoot, rectGetter);
            const actor = new UnpickableActor();
            actor.set_name(`${child.name}-selfExcludingSnapshot`);
            // Push new content onto the actor whenever the capture updates,
            // rather than polling on a timer, so this stays in lockstep with
            // SelfExcludingSnapshotCapture's own 'after-paint'-driven refresh.
            const applyContent = () => {
                if (actor._isDisposed)
                    return;
                const content = capture.getContent();
                if (content && actor.content !== content) {
                    actor.content = content;
                }
            };
            let afterPaintId = 0;
            try {
                afterPaintId = stage.connect('after-paint', applyContent);
            }
            catch (e) {
            }
            applyContent();
            this._delayedCaptureOwners.set(actor, { source: child, hideActor: selfRoot });
            actor.connect('destroy', () => {
                actor._isDisposed = true;
                if (afterPaintId) {
                    try {
                        stage.disconnect(afterPaintId);
                    }
                    catch (_) { /* noop */ }
                }
                const owner = this._delayedCaptureOwners.get(actor);
                if (owner) {
                    releaseSelfExcludingSnapshot(owner.source, owner.hideActor);
                    this._delayedCaptureOwners.delete(actor);
                }
            });
            return actor;
        }
        catch (e) {
            return null;
        }
    }
    /** Toggle for the OffscreenEffect-reading fallback (see _useCaptureFixForBms). */
    setUseCaptureFixForBms(enabled) {
        this._useCaptureFixForBms = enabled;
    }
    /**
     * Searches `root`'s subtree (read-only, no mutation) for an existing
     * Clutter.OffscreenEffect — e.g. a blur implemented as a JS effect by some
     * other extension. Our own debug effects (GTypeName starting with
     * "LiquidGlass") are skipped so we never pick up our own instrumentation.
     */
    _findExistingOffscreenEffect(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const effects = actor.get_effects?.() ?? [];
                for (const effect of effects) {
                    if (!(effect instanceof Clutter.OffscreenEffect))
                        continue;
                    const gtypeName = effect.constructor?.$gtype?.name ?? '';
                    if (gtypeName.startsWith('LiquidGlass'))
                        continue;
                    return { actor, effect: effect };
                }
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch (_) { /* noop */ }
        }
        return null;
    }
    /**
     * Fallback for BMS-target children when SelfExcludingSnapshotCapture is
     * unavailable: reads an existing OffscreenEffect's captured texture
     * directly, without adding anything to the actor tree. This never
     * matches BMS's own native blur effect (see class doc comment on
     * _useCaptureFixForBms) but can help other, JS-effect-based extensions.
     * Returns null if nothing suitable was found.
     */
    _createExistingEffectBlitActor(child) {
        let found = this._existingEffectCache.get(child);
        if (found === undefined) {
            found = this._findExistingOffscreenEffect(child);
            this._existingEffectCache.set(child, found);
        }
        if (!found)
            return null;
        const { actor: effectOwner, effect } = found;
        const blit = new TextureBlitActor();
        blit.setSourceActor(effectOwner);
        blit.setTextureGetter(() => effect.get_texture());
        return blit;
    }
    rebindSelf() {
        this._selfRoot = this._findUiGroupAncestor(this._selfActor);
    }
    /**
     * Returns true if `root`'s subtree contains the root actor of *another*
     * Liquid Glass instance (bgActor, named 'liquid-glass-bg-actor', or its
     * child liquidBox, named 'liquid-box'). Searched recursively with no
     * depth limit — a shallow, direct-child-only check is not enough: if a
     * glass instance's root ends up nested more than one level below a
     * uiGroup child (e.g. when multiple popups are open at once, or another
     * container wraps it), a shallow check silently misses it and that whole
     * instance — including whatever it has already rendered — gets cloned
     * into this glass, producing a visible "glass inside glass" nesting
     * artifact.
     */
    _containsOtherLiquidGlassRoot(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const name = actor.name;
                if (name === 'liquid-glass-bg-actor' || name === 'liquid-box')
                    return true;
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch (_) { /* noop */ }
        }
        return false;
    }
    /**
     * Repositions a freshly-added clone within `_uiClonesContainer` to match
     * `child`'s real z-order among `uiGroup`'s children, rather than leaving
     * it wherever `add_child()` put it (always the front).
     *
     * Without this, any uiGroup child that appears *after* the glass was
     * already showing other clones — e.g. the full-screen blurred backdrop
     * GNOME's Activities/Overview creates — ends up rendered in front of
     * clones added earlier, regardless of its real stacking order on screen.
     * (The real screen is unaffected since this only concerns our own clone
     * container's internal ordering.)
     */
    _insertCloneInZOrder(child, clone) {
        if (!this._uiClonesContainer)
            return;
        try {
            const uiGroup = Main.layoutManager.uiGroup;
            const siblings = uiGroup.get_children();
            const idx = siblings.indexOf(child);
            if (idx < 0)
                return; // Not found: leave it at the front.
            let insertAboveClone = null;
            for (let i = idx - 1; i >= 0; i--) {
                const prevClone = this._clones.get(siblings[i]);
                if (prevClone && !prevClone._isDisposed) {
                    insertAboveClone = prevClone;
                    break;
                }
            }
            if (insertAboveClone) {
                this._uiClonesContainer.set_child_above_sibling(clone, insertAboveClone);
            }
            else {
                // No cloned sibling sits below `child` in uiGroup's real order, so
                // this one is currently the backmost among cloned siblings.
                this._uiClonesContainer.set_child_below_sibling(clone, null);
            }
        }
        catch (e) {
        }
    }
    /**
     * Scans uiGroup's current children, creating/destroying clones as needed.
     * Call whenever the set of top-level UI actors may have changed (e.g. a
     * menu opening or closing).
     */
    refresh() {
        if (!this._selfRoot)
            this._selfRoot = this._findUiGroupAncestor(this._selfActor);
        const uiGroup = Main.layoutManager.uiGroup;
        const children = uiGroup.get_children();
        const seen = new Set();
        // [FIX] One lookup per refresh, not per child: notice BMS appearing or
        // disappearing and rebuild only the clones whose answer moved.
        const bmsTarget = this._resolveBmsTargetActor();
        if (this._lastBmsTarget !== bmsTarget) {
            const first = this._lastBmsTarget === undefined;
            this._lastBmsTarget = bmsTarget;
            if (!first)
                this._reevaluateBmsClones();
        }
        // [FIX] Resolved every refresh: see ancestorExclusions in the constructor.
        const dynamicExclusions = new Set();
        for (const src of this._ancestorExclusionSources) {
            try {
                if (!isActorValid(src))
                    continue;
                const root = this._findUiGroupAncestor(src);
                if (root)
                    dynamicExclusions.add(root);
            }
            catch (_) { /* noop */ }
        }
        for (const child of children) {
            // Per-child containment: refresh() runs from the same per-frame
            // BEFORE_REDRAW tick as everything else, and one uiGroup child going
            // away mid-iteration must not cost the caller its reschedule (see
            // reportFrameLoopError).
            try {
                if (child._isDisposed)
                    continue;
                if (!isActorValid(child))
                    continue;
                if (child === this._selfActor || child === this._selfRoot)
                    continue;
                if (child === Main.layoutManager._backgroundGroup)
                    continue;
                // [black-frame] Same reasoning as the line above: the shared wallpaper
                // mirror lives in uiGroup so the window group's cull walk cannot reach
                // it, but it IS the wallpaper. Every glass already clones it directly
                // as its own bgClone, so letting the UI-layer sampler clone it too
                // would paint the wallpaper into the UI layer a second time.
                if (child === getSharedBackgroundSource())
                    continue;
                if (this._extraExclusions.has(child))
                    continue;
                if (dynamicExclusions.has(child))
                    continue;
                if (!child.visible || !child.mapped)
                    continue;
                // if (this._containsOtherLiquidGlassRoot(child)) continue;
                // Deep scan for nested Liquid Glass roots only once per newly discovered actor.
                // Doing this every frame causes massive performance drops in the Overview.
                if (!this._clones.has(child) && this._containsOtherLiquidGlassRoot(child)) {
                    // NOTE: addExclusion() is PERMANENT for the life of this sampler,
                    // and the deep scan that reaches here only runs for a child that
                    // currently has no clone. So a child whose clone was dropped for a
                    // single frame (it went unmapped, or syncProperties() culled it) is
                    // re-scanned, and if another glass instance happens to be nested
                    // under it at that instant, it is banned from the sampler for good
                    // — which is a candidate explanation for "the UI clones are just
                    // missing" persisting until the menu is reopened. Logged so a repro
                    // says outright whether that is what happened.
                    utilsLog(`[Liquid Glass][ui-sampler] permanent exclusion of uiGroup child ` +
                        `name="${child.name ?? '(unnamed)'}" ` +
                        `type=${child.constructor?.name} ` +
                        `(nested liquid-glass root found during deep scan)`);
                    this.addExclusion(child);
                    continue;
                }
                seen.add(child);
                if (!this._clones.has(child)) {
                    child.connect('destroy', () => {
                        child._isDisposed = true;
                        const clone = this._clones.get(child);
                        if (clone) {
                            this._clones.delete(child);
                            try {
                                clone.destroy();
                            }
                            catch (_) { }
                        }
                    });
                    const bmsTarget = this._findBmsDescendant(child);
                    // SKIP: leave the BMS target out of the glass altogether. Done here
                    // rather than in the exclusion block above so the child is still
                    // tracked (and rebuilt) when the mode or the BMS state changes.
                    if (bmsTarget && _bmsMode === BMS_MODE.SKIP) {
                        seen.delete(child);
                        continue;
                    }
                    let sourceClone = null;
                    if (bmsTarget && _bmsMode === BMS_MODE.REPLICATE) {
                        sourceClone = this._createBmsReplicaActor(child);
                        if (!sourceClone) {
                            // Do NOT quietly fall through to the ordinary clone here: that
                            // is the path that makes BMS's own panel drift. Leaving the
                            // child out is the lesser failure, and it is logged.
                            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica ` +
                                `could not be built for name="${child.name ?? '(unnamed)'}"; ` +
                                `leaving it out of the glass rather than cloning BMS's target`);
                            seen.delete(child);
                            continue;
                        }
                    }
                    if (!sourceClone && bmsTarget && _bmsMode === BMS_MODE.SNAPSHOT) {
                        // 1st: the real fix — a snapshot that structurally cannot
                        // include ourselves (see SelfExcludingSnapshotCapture).
                        sourceClone = this._createSelfExcludingSnapshotActor(child);
                        // 2nd: read an existing OffscreenEffect's texture (useful for
                        // other extensions; BMS's native effect never matches this).
                        if (!sourceClone && this._useCaptureFixForBms) {
                            sourceClone = this._createExistingEffectBlitActor(child);
                        }
                    }
                    // Fallback: an ordinary unpickable clone.
                    if (!sourceClone) {
                        sourceClone = new UnpickableClone({ source: child });
                    }
                    // [FIX] Remember whether this child was cloned as "BMS present" or
                    // not, so the answer can be re-checked when the extension set
                    // changes. See _reevaluateBmsClones().
                    this._bmsStateAtClone.set(child, !!bmsTarget);
                    sourceClone.set_name(`${child.name}-sourceClone`);
                    sourceClone.connect('destroy', () => {
                        this._clones.delete(child);
                    });
                    this._uiClonesContainer?.add_child(sourceClone);
                    this._clones.set(child, sourceClone);
                    this._insertCloneInZOrder(child, sourceClone);
                }
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler.refresh', e);
            }
        }
        for (const [actor, sourceClone] of this._clones) {
            if (!seen.has(actor)) {
                try {
                    sourceClone.destroy();
                }
                catch (_) { }
                this._clones.delete(actor);
            }
        }
        this._reportClonedSet();
    }
    static _stageToLocal(actor, stageX, stageY) {
        try {
            const res = actor.transform_stage_point(stageX, stageY);
            if (Array.isArray(res) && res[0] === true) {
                return [res[1], res[2]];
            }
        }
        catch (_) { }
        try {
            const [cx, cy] = actor.get_transformed_position();
            return [
                stageX - (Number.isNaN(cx) ? 0 : cx),
                stageY - (Number.isNaN(cy) ? 0 : cy),
            ];
        }
        catch (_) {
            return [stageX, stageY];
        }
    }
    /**
     * Copies `source`'s current position/size/opacity/visibility onto its
     * clone, and culls the clone if it falls outside the given container
     * bounds.
     */
    syncProperties(source, sourceClone, containerW, containerH, cX, cY) {
        if (!source || !sourceClone)
            return;
        try {
            const [absX, absY] = source.get_transformed_position();
            const [w, h] = getAllocatedSize(source);
            if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
                setActorVisible(sourceClone, false);
                return;
            }
            const scaleX = source.scale_x;
            const scaleY = source.scale_y;
            // get_transformed_position() already folds in source's own
            // scale/pivot (it maps the local origin through the full accumulated
            // transform). So we must NOT also apply scale/pivot again on the
            // clone — doing so double-counts the pivot offset
            // (pivot * size * (1 - scale)), which is invisible when scale is 1
            // and pivot is (0,0) but shows up as a few pixels of drift on
            // anything that scales on hover/press (e.g. the calendar's "today"
            // highlight, panel buttons). Instead, bake the visual scale directly
            // into the clone's size and leave its own scale at 1.
            const scaledW = w * scaleX;
            const scaledH = h * scaleY;
            // Placed by translation rather than allocation — see the long note in
            // WindowCloneManager.sync(). This is what keeps a UI clone (the
            // Overview's controls, the panel) from freezing at a stale rect when
            // the glass subtree stops being allocated.
            // [PERF ①b] Cull against the rect this glass can actually show, when
            // one has been handed to us. Decided here, before the writes, so a
            // culled clone costs nothing at all this frame.
            //
            // Two clones are never culled:
            //   - one carrying a BMS replica, because the replica's blur reads the
            //     framebuffer and the clip rect was widened to keep its band
            //     intact (see _bmsScreenRects);
            //   - one whose source has no usable size or position yet, because a
            //     degenerate rect intersects nothing and would cull a clone that is
            //     merely waiting for its first allocation. Fail open: not culling
            //     costs a frame of fill, culling wrongly leaves a hole in the glass.
            const cull = this._cullRect;
            const cullable = !!cull && isCullSiteEnabled('ui') &&
                !sourceClone._lgBmsReplica &&
                scaledW > 0 && scaledH > 0 &&
                Number.isFinite(absX) && Number.isFinite(absY);
            if (cullable && !rectsIntersect(absX, absY, scaledW, scaledH, cull)) {
                setCloneCulled(sourceClone, true, `src=(${Math.round(absX)},${Math.round(absY)},${Math.round(scaledW)}x${Math.round(scaledH)}) ` +
                    `cullRect=[${cull.map(Math.round)}] label=${this._label}`);
                return;
            }
            setCloneCulled(sourceClone, false, `label=${this._label}`);
            // [PERF] Compare-then-write: see setTranslationIfChanged(). The UI
            // sampler runs this for every uiGroup child of every open glass, on
            // every frame; unconditional transform writes damaged all of them
            // even with nothing on screen moving.
            if (sourceClone.x !== 0 || sourceClone.y !== 0)
                sourceClone.set_position(0, 0);
            setTranslationIfChanged(sourceClone, absX, absY);
            setSizeIfChanged(sourceClone, scaledW, scaledH);
            setScaleIfChanged(sourceClone, 1.0, 1.0);
            setPivotIfChanged(sourceClone, 0, 0);
            setOpacityIfChanged(sourceClone, source.opacity);
            const replica = sourceClone._lgBmsReplica;
            if (replica) {
                this._syncBmsReplica(source, replica);
                // [PERF ①] Remember where this replica lands on screen so the
                // capture clip can be widened to cover it — see _bmsScreenRects.
                // panelRect is local to this clone, and the clone's local origin is
                // at (absX, absY) in screen space.
                const pr = replica.panelRect;
                if (pr && pr[2] > 0 && pr[3] > 0)
                    this._bmsScreenRects.push([absX + pr[0], absY + pr[1], pr[2], pr[3]]);
            }
            this._checkCloneDrift(source, sourceClone, absX, absY);
            const localX = absX - cX;
            const localY = absY - cY;
            const isVisible = source.visible && source.mapped;
            // The pre-① containment test. It runs against the container, which is
            // the whole monitor for every glass with a monitor-sized bgActor, so
            // in practice it only catches clones that are genuinely off-screen.
            // The real culling happens above, against _cullRect.
            if (isVisible && containerW > 0 && containerH > 0) {
                const isIntersecting = localX < containerW &&
                    (localX + scaledW) > 0 &&
                    localY < containerH &&
                    (localY + scaledH) > 0;
                setActorVisible(sourceClone, isIntersecting);
            }
            else {
                setActorVisible(sourceClone, isVisible);
            }
        }
        catch (_) { }
    }
    // A clone is supposed to land on its source's own screen rect. When it
    // does not, the glass shows a piece of the desktop from somewhere else
    // entirely — the "the clone is showing a completely different place"
    // report. Logged on entry and exit only, so a stuck clone costs two lines
    // instead of 60 per second.
    _checkCloneDrift(source, sourceClone, expectX, expectY) {
        if (!_utilsLogger)
            return;
        try {
            const [gotX, gotY] = sourceClone.get_transformed_position();
            const drifted = !Number.isFinite(gotX) || !Number.isFinite(gotY) ||
                Math.abs(gotX - expectX) > 1 || Math.abs(gotY - expectY) > 1;
            const known = this._driftingClones.has(sourceClone);
            if (drifted && !known) {
                this._driftingClones.add(sourceClone);
                utilsLog(`[Liquid Glass][ui-sampler] DRIFT clone for ` +
                    `name="${source.name ?? '(unnamed)'}" ` +
                    `type=${source.constructor?.name} ` +
                    `expected=(${Math.round(expectX)},${Math.round(expectY)}) ` +
                    `got=(${Math.round(gotX)},${Math.round(gotY)}) ` +
                    `containerPos=${this._uiClonesContainer?.get_transformed_position()} ` +
                    `clone.hasAlloc=${sourceClone.has_allocation()}`);
            }
            else if (!drifted && known) {
                this._driftingClones.delete(sourceClone);
                utilsLog(`[Liquid Glass][ui-sampler] RECOVERED clone for name="${source.name ?? '(unnamed)'}"`);
            }
        }
        catch (_) { /* noop */ }
    }
    // Repositions the UI-clone container and culls off-screen clones.
    //
    // In the full-screen-FBO architecture, callers pass
    //   sync(monitor.x, monitor.y, screenW, screenH)
    // rather than the dock's own local (bgX, bgY, bgW, bgH).
    //
    // Effect: _uiClonesContainer is placed at (-monitor.x, -monitor.y) so a
    // clone at absolute screen position (absX, absY) ends up at:
    //   monitor.x + (-monitor.x + absX) = absX  ✓
    // The wider container dimensions (screenW, screenH) relax the cull
    // frustum to the full monitor; actual rendering is still limited to the
    // dock area by the clip applied to liquidBox/blurBox elsewhere.
    sync(cX, cY, cW, cH) {
        // [PERF ①] Rebuilt every frame by syncProperties(); see _bmsScreenRects.
        this._bmsScreenRects = [];
        let contW = cW ?? 0;
        let contH = cH ?? 0;
        let contAbsX = cX ?? 0;
        let contAbsY = cY ?? 0;
        if (cX === undefined || cY === undefined) {
            try {
                const [cw, ch] = this._container.get_size();
                if (!Number.isNaN(cw))
                    contW = cw;
                if (!Number.isNaN(ch))
                    contH = ch;
                const [tx, ty] = this._container.get_transformed_position();
                contAbsX = Number.isNaN(tx) ? 0 : tx;
                contAbsY = Number.isNaN(ty) ? 0 : ty;
            }
            catch (_) { }
        }
        // Always bring the UI clones container to the front, regardless of its parent.
        // This prevents WindowCloneManager's rebuilds from placing windows above the UI.
        try {
            const parent = this._uiClonesContainer?.get_parent();
            if (parent && this._uiClonesContainer) {
                const siblings = parent.get_children();
                if (siblings[siblings.length - 1] !== this._uiClonesContainer) {
                    parent.set_child_above_sibling(this._uiClonesContainer, null);
                }
            }
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler.sync', e);
        }
        // Sign is flipped relative to WindowCloneManager.setOffset(x, y).
        // Translation, not position — see WindowCloneManager.sync().
        if (this._uiClonesContainer) {
            if (this._uiClonesContainer.x !== 0 || this._uiClonesContainer.y !== 0)
                this._uiClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this._uiClonesContainer, -contAbsX, -contAbsY);
        }
        for (const [actor, sourceClone] of this._clones) {
            this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
        }
    }
    /**
     * [FIX] Re-checks the Blur My Shell decision when BMS comes or goes.
     *
     * Which clone a uiGroup child gets depends on whether a BMS target is found
     * underneath it, and that was decided once, when the clone was first built.
     * So the two extensions behaved differently depending on the order they were
     * switched on:
     *
     *   BMS first, then this one — the target is found, the child is supplied as
     *     a self-excluding snapshot, and BMS keeps working.
     *   This one first, then BMS — nothing was found, so the child is an
     *     ordinary Clutter.Clone. BMS then installs its effect on an actor that
     *     already has a second consumer, and its own panel rendering drifts
     *     (reported: about 10px, whenever the dock overlaps the panel).
     *
     * Driven by comparing the resolved target each refresh rather than by
     * extension-state-changed: BMS populates _panel_blur.actors_list during and
     * after its own enable(), so a signal handler can easily look too early,
     * while "the target is not what it was" is true whenever it settles.
     */
    _reevaluateBmsClones() {
        // The cache is keyed by actor and holds "is there an offscreen effect
        // under here", which is exactly what an extension being toggled changes.
        this._existingEffectCache.clear();
        for (const [child, wasBms] of [...this._bmsStateAtClone]) {
            try {
                if (!isActorValid(child)) {
                    this._bmsStateAtClone.delete(child);
                    continue;
                }
                const isBms = !!this._findBmsDescendant(child);
                if (isBms === wasBms)
                    continue;
                utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS state changed for ` +
                    `name="${child.name ?? '(unnamed)'}" (${wasBms} -> ${isBms}); rebuilding its clone`);
                const clone = this._clones.get(child);
                if (clone) {
                    this._clones.delete(child);
                    try {
                        clone.destroy();
                    }
                    catch (_) { }
                }
                this._bmsStateAtClone.delete(child);
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler._reevaluateBmsClones', e);
            }
        }
        // refresh() runs from each manager's per-frame tick and rebuilds whatever
        // is missing, so nothing else is needed here.
    }
    /**
     * Drops every clone built for a child that currently has a BMS target under
     * it, so the next refresh() rebuilds it down whatever path the mode now
     * selects. Called when the mode is switched at runtime.
     */
    rebuildBmsClones() {
        this._existingEffectCache.clear();
        for (const [child] of [...this._bmsStateAtClone]) {
            try {
                if (isActorValid(child) && !this._findBmsDescendant(child))
                    continue;
                const clone = this._clones.get(child);
                if (clone) {
                    this._clones.delete(child);
                    try {
                        clone.destroy();
                    }
                    catch (_) { }
                }
                this._bmsStateAtClone.delete(child);
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler.rebuildBmsClones', e);
            }
        }
        this._clonedNamesLogged = '';
    }
    /**
     * Logs which uiGroup children this sampler is cloning, whenever that set
     * changes.
     *
     * Exists because "what ended up inside this glass" is otherwise invisible:
     * a wrongly-included child shows up only as a ghost of itself in the blurred
     * backdrop, with nothing in the log to say why. The dock cloning ITSELF is
     * the case this was written for.
     */
    _reportClonedSet() {
        let names = '';
        for (const actor of this._clones.keys()) {
            let n = '(unnamed)';
            try {
                n = actor.name || actor.constructor?.name || '(unnamed)';
            }
            catch (_) { }
            names += (names ? ', ' : '') + n;
        }
        if (names === this._clonedNamesLogged)
            return;
        this._clonedNamesLogged = names;
        utilsLog(`[Liquid Glass][ui-sampler:${this._label}] cloning [${names}]`);
    }
    destroy() {
        _liveSamplers.delete(this);
        this._bmsStateAtClone.clear();
        if (this._uiClonesContainer) {
            try {
                this._uiClonesContainer.destroy();
            }
            catch (_) { }
        }
        this._clones.clear();
        this._driftingClones.clear();
        this._selfRoot = null;
        this._existingEffectCache.clear();
    }
}
export class WindowCloneManager {
    // [PERF ①b] See setCullRect(). Null until a manager hands one over, so a
    // caller that never calls setCullRect() keeps the old behaviour exactly.
    _cullRect = null;
    windowClonesContainer = null;
    _windowClones;
    // [nested-glass] MetaWindowActor::damaged handlers on the cloned windows
    // that own a glass. See NestedGlassFix and _syncDamageHooks().
    _damageHooks = new Map();
    // [black-frame] A BackgroundMirror, or (A/B off) an UnpickableClone of
    // _backgroundGroup. Typed as the common base so either fits.
    bgClone = null;
    container = null;
    cloneContainer = null;
    // Prefix for every actor this manager creates. Clutter's own diagnostics
    // print an actor's NAME — "Can't update stage views actor <name> ... needs
    // an allocation" is the one warning that reliably accompanies the
    // "clone stuck at an old position" bug, and it read "unnamed" for every
    // clone in this file, which made it useless for telling the dock's clones
    // apart from a menu's or from ApplicationManager's. Everything is named now.
    label;
    constructor(container, cloneContainer = null, label = 'lg') {
        this.container = container;
        this.label = label;
        this._windowClones = new Map();
        // [black-frame] Not a Clone of _backgroundGroup any more — see
        // BackgroundMirror for why cloning it made the wallpaper paint only
        // inside the current frame's damage region.
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        this.cloneContainer = cloneContainer;
        // windowClonesContainer can only have one parent, so it's added either
        // to cloneContainer or to container directly — never both. As long as
        // cloneContainer is added to container after bgClone, the intended
        // z-order (bgClone behind, window clones in front) holds regardless.
        if (this.cloneContainer) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        // bgClone (the wallpaper) always sits at the very back of container.
        this.container.insert_child_at_index(this.bgClone, 0);
    }
    rebuildClones() {
        if (!isActorValid(this.container))
            return;
        if (isActorValid(this.bgClone)) {
            this.bgClone.destroy();
        }
        if (isActorValid(this.windowClonesContainer)) {
            this.windowClonesContainer.destroy();
        }
        // destroy() above fires each clone's 'destroy' handler, which prunes
        // _windowClones — but a clone whose handler never ran (e.g. it was
        // already disposed) would leave a dead wrapper behind, so clear the map
        // outright rather than relying on that.
        this._windowClones.clear();
        // [black-frame] Not a Clone of _backgroundGroup any more — see
        // BackgroundMirror for why cloning it made the wallpaper paint only
        // inside the current frame's damage region.
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        if (isActorValid(this.cloneContainer)) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        this.container.insert_child_at_index(this.bgClone, 0);
        this.sync();
    }
    // Shifts the entire clone subtree within the full-screen FBO.
    //
    // In the full-screen-FBO architecture, the caller (dockManager) passes
    // (-monitor.x, -monitor.y) rather than the dock's own (-bgX, -bgY).
    //
    // Rationale: clones sit at their absolute screen coordinates (w.x, w.y).
    // blurBox/liquidBox start at (0,0) inside bgActor, which itself sits at
    // (monitor.x, monitor.y). Offsetting this container by
    // (-monitor.x, -monitor.y) makes each clone's net screen position:
    //   monitor.x + 0 + (-monitor.x + w.x) = w.x  ✓
    setOffset(x, y) {
        // Translation, not position, for the same reason as the clones
        // themselves (see sync()): a container shifted by an allocation can be
        // starved along with everything under it.
        if (this.windowClonesContainer) {
            if (this.windowClonesContainer.x !== 0 || this.windowClonesContainer.y !== 0)
                this.windowClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this.windowClonesContainer, x, y);
        }
        if (this.bgClone) {
            if (this.bgClone.x !== 0 || this.bgClone.y !== 0)
                this.bgClone.set_position(0, 0);
            setTranslationIfChanged(this.bgClone, x, y);
        }
    }
    /**
     * [PERF ①b] Screen-coordinate rect this glass can actually show, or null
     * for "draw every window". See the long note on setCaptureClipEnabled().
     */
    setCullRect(rect) {
        this._cullRect = rect;
    }
    /**
     * [PERF ①] Clips the wallpaper clone.
     *
     * bgClone is inserted into `container` (liquidBox) rather than into
     * `cloneContainer` — see rebuildClones(), where it is deliberately put at
     * index 0 of the container so it sits behind everything. So the clip that
     * syncGlassCaptureClip() applies to the clone container does NOT reach it,
     * and the wallpaper is the single biggest full-screen quad in the capture.
     *
     * `rect` is in SCREEN coordinates, not shader space: setOffset() gives
     * bgClone translation (-monitorX, -monitorY) and leaves its position at
     * (0, 0), so a point at bgClone-local p paints at liquidBox-local
     * p - monitorOrigin, i.e. at screen p. Clutter applies the clip inside the
     * actor's own transform (clutter-actor.c:3570: the clip node is a CHILD of
     * the transform node), so the rect is read in exactly that local space.
     */
    applyBgCloneClip(rect) {
        const bg = this.bgClone;
        if (!bg || !isActorValid(bg))
            return;
        if (rect) {
            setClipIfChanged(bg, rect[0], rect[1], rect[2], rect[3]);
        }
        else if (bg._lgClipW !== undefined) {
            bg._lgClipW = undefined;
            try {
                bg.remove_clip();
            }
            catch (_) { }
        }
    }
    /**
     * The nested-glass repair, for every glass that is not an application
     * window's — the dock, the menus, notifications, the OSD, quick settings.
     *
     * They clone windows exactly like ApplicationManager does, so they take the
     * same damage: a cloned window that owns a glass drags its offscreen effect
     * in, and this glass's capture is blanked the moment that inner effect
     * re-renders. It shows up as "the area outside the black ring goes black
     * for an instant whenever a menu or the dock appears".
     *
     * MetaWindowActor::damaged runs while damage is being processed, before the
     * frame clock paints, so marking this glass dirty from it lands on the same
     * frame the inner effect re-renders — see ApplicationManager's copy for the
     * measurements behind choosing this over the other two repairs.
     */
    _syncDamageHooks() {
        const container = this.container;
        if (getNestedGlassFix() !== 'damage' || !container || !isActorValid(container)) {
            this._releaseDamageHooks();
            return;
        }
        for (const src of this._windowClones.keys()) {
            if (this._damageHooks.has(src))
                continue;
            if (!isActorValid(src) || !innerGlassEffectOf(src))
                continue;
            try {
                const id = src.connect('damaged', () => {
                    if (isActorValid(container) && container.mapped && container.visible)
                        container.queue_redraw();
                });
                this._damageHooks.set(src, id);
            }
            catch (_) { /* a source that cannot be connected simply goes unhooked */ }
        }
        if (this._damageHooks.size > this._windowClones.size) {
            for (const [src, id] of [...this._damageHooks]) {
                if (this._windowClones.has(src))
                    continue;
                try {
                    if (isActorValid(src))
                        src.disconnect(id);
                }
                catch (_) { }
                this._damageHooks.delete(src);
            }
        }
    }
    _releaseDamageHooks() {
        if (this._damageHooks.size === 0)
            return;
        for (const [src, id] of this._damageHooks) {
            try {
                if (isActorValid(src))
                    src.disconnect(id);
            }
            catch (_) { }
        }
        this._damageHooks.clear();
    }
    sync() {
        this._syncDamageHooks();
        // [window-clone-clip] Keep the cull opt-out in step with what we clone.
        // reportClonedWindowActors() diffs first, so this is a set comparison over
        // a handful of actors on a normal frame.
        reportClonedWindowActors(this, this._windowClones.keys());
        let windows = getWindowActors();
        let activeWindows = new Set();
        let zIndex = 0;
        // Nothing below may throw out of here. sync() is the tail of every
        // manager's per-frame BEFORE_REDRAW tick, and a single disposed actor
        // used to take the whole tick — and with it that glass instance's
        // reschedule — down with it (see reportFrameLoopError).
        if (!isActorValid(this.windowClonesContainer))
            return;
        for (let w of windows) {
            if (!isActorValid(w))
                continue;
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible)
                continue;
            // Read position/size directly rather than via the more expensive
            // get_transformed_position(). Size comes from the allocation, not
            // w.width/w.height: those fall back to the preferred size while a
            // relayout is pending, and a bogus 0 here would `continue` past the
            // window and destroy its clone for a frame (see getAllocatedSize).
            let [width, height] = getAllocatedSize(w);
            if (width <= 0 || height <= 0)
                continue;
            // The clone is placed at the window's own screen position (see the
            // long note further down), so the source rect below is already in the
            // same space as _cullRect.
            const wX = w.x + w.translation_x;
            const wY = w.y + w.translation_y;
            // [PERF ①b] A window that does not overlap the rect this glass can
            // show contributes nothing to the capture — the clip (and, for
            // applicationManager, clipBox's clip_to_allocation) would throw away
            // every one of its pixels anyway. Hiding the clone instead of merely
            // scissoring it is what makes the difference: clutter_actor_paint()
            // returns immediately for an invisible actor, so the source is never
            // painted through this clone, and if that source is a window with its
            // own glass, ITS capture/blur/composite does not run either.
            //
            // Still counted as active: the clone stays alive and correctly placed,
            // it is only culled, so nothing has to be rebuilt when the window comes
            // back into range.
            activeWindows.add(w);
            const sxSafe = Number.isFinite(w.scale_x) && w.scale_x > 0 ? w.scale_x : 1;
            const sySafe = Number.isFinite(w.scale_y) && w.scale_y > 0 ? w.scale_y : 1;
            // [FIX ①b] The cull decision is taken here but ACTED ON below, after
            // the clone exists and has been given its stacking index.
            //
            // The first cut skipped the whole iteration with `continue`, which had
            // two consequences that turned out to matter more than the work it
            // saved:
            //
            //   * a window that was culled before its clone existed never got one,
            //     so every crossing of a glass boundary destroyed and rebuilt a
            //     clone — and a brand new Clutter actor is visible=false and
            //     unallocated, i.e. exactly the state in which
            //     _clutter_actor_queue_redraw_full() throws its damage away
            //     (clutter-actor.c:7674). Inside a ClutterOffscreenEffect that is
            //     not cosmetic: the capture FBO is only re-rendered when the glass
            //     actor is dirty (clutter-offscreen-effect.c:569), so lost damage
            //     means the glass keeps showing a stale capture.
            //
            //   * zIndex was not advanced for culled windows, so every cull and
            //     un-cull renumbered the whole stack and set_child_at_index() ran
            //     on clones that had not moved.
            //
            // Now the clone is always built, always placed and always indexed; the
            // only thing the cull changes is whether it gets painted. That is where
            // the saving was anyway — an opacity-0 clone never paints its source,
            // so the nested glass inside that source never runs.
            const culled = !!this._cullRect && isCullSiteEnabled('windows') &&
                !rectsIntersect(wX, wY, width * sxSafe, height * sySafe, this._cullRect);
            let clone = this._windowClones.get(w);
            // A clone can be destroyed out from under this map — its container is
            // torn down and rebuilt by rebuildClones(), and Clutter destroys
            // children with their parent. Touching the stale wrapper throws, so
            // treat a dead entry as "no clone" and build a fresh one.
            if (clone && !isActorValid(clone)) {
                this._windowClones.delete(w);
                clone = undefined;
            }
            if (!clone) {
                clone = new UnpickableClone({ source: w });
                const wTitle = (() => {
                    try {
                        return metaWindow.get_title() || '(untitled)';
                    }
                    catch (_) {
                        return '(?)';
                    }
                })();
                clone.set_name(`${this.label}-winclone:${wTitle}`);
                clone.connect('destroy', () => { this._windowClones.delete(w); });
                this.windowClonesContainer?.add_child(clone);
                this._windowClones.set(w, clone);
            }
            // [PERF ①b] Map the clone first — an unmapped actor cannot even report
            // damage — then apply this frame's cull decision. setCloneCulled() is
            // a no-op when the state has not changed.
            setActorVisible(clone, true);
            setCloneCulled(clone, culled, culled
                ? `src=(${Math.round(wX)},${Math.round(wY)},${Math.round(width * sxSafe)}x${Math.round(height * sySafe)}) ` +
                    `cullRect=[${this._cullRect.map(Math.round)}] label=${this.label}`
                : `label=${this.label}`);
            // [PERF] The WRITES below are now conditional (see
            // setTranslationIfChanged), but these removals stay unconditional on
            // purpose: removing a transition that does not exist is a hash lookup
            // that queues no damage, whereas leaving a live transition in place
            // while the write is skipped would let the transition keep driving the
            // property and desync the cache from the actor.
            const tX = wX;
            const tY = wY;
            const pX = w.pivot_point ? w.pivot_point.x : 0;
            const pY = w.pivot_point ? w.pivot_point.y : 0;
            clone.remove_transition('position');
            clone.remove_transition('size');
            clone.remove_transition('translation-x');
            clone.remove_transition('translation-y');
            // [FIX] Place the clone with translation_x/y, NOT set_position().
            //
            // set_position() only moves the actor once Clutter has run a relayout
            // and handed it a new allocation. translation is a paint-time
            // transform: it needs a redraw and nothing else. Clutter adds the two
            // together in exactly the same place —
            //     translate(allocation.x1 + translation_x, ...)
            // happens before the pivot/scale block — so this is arithmetically
            // identical while depending on strictly less machinery.
            //
            // Why it matters: the Looking Glass audit caught this clone with
            //     pos=(507,89)      <- set_position() had been applied, correctly
            //     screen=(642,767)  <- the allocation, hundreds of px out of date
            //     hasAlloc=false
            // and the same for every ancestor up to the glass root, i.e. the
            // subtree had stopped receiving allocations while our per-frame sync
            // went on setting the property. Everything downstream of that reads
            // the allocation, so the clone painted where the window used to be.
            //
            // The decisive contrast is in the same audit: ApplicationManager's
            // per-window glass, which has always placed its clones with
            // translation and pins x/y at 0, was completely healthy in the very
            // same snapshot (DELTA=(0,0), hasAlloc=true everywhere). Positioning
            // that cannot be starved by the layout system does not go stale.
            if (clone.x !== 0 || clone.y !== 0)
                clone.set_position(0, 0);
            setTranslationIfChanged(clone, tX, tY);
            setSizeIfChanged(clone, width, height);
            clone.remove_transition('scale-x');
            clone.remove_transition('scale-y');
            setScaleIfChanged(clone, w.scale_x, w.scale_y);
            setPivotIfChanged(clone, pX, pY);
            // Clutter.Clone paints its source with the clone's own opacity, not
            // the source's — so without this the glass shows a window at full
            // opacity for the whole of GNOME's map/destroy animation, which eases
            // MetaWindowActor.opacity from 0 (and back) while scale animates.
            // That is the "the clone is offset/too solid during the open and
            // close animation" artifact: the geometry follows the animation but
            // the fade does not.
            setOpacityIfChanged(clone, w.opacity);
            // [PERF] set_child_at_index() unparents and re-adds the child, which
            // queues a relayout on the container even when the index is the one
            // it already has — i.e. it damaged the whole glass every frame all by
            // itself. The stacking order only changes on a restack.
            //
            // Culled clones are indexed too (zIndex advances for them below), so
            // the numbering does not shift every time one is culled.
            if (!isDiffWritesEnabled() || clone._lgZIndex !== zIndex) {
                clone._lgZIndex = zIndex;
                this.windowClonesContainer?.set_child_at_index(clone, zIndex);
            }
            zIndex++;
        }
        // Remove clones for windows that closed, or all of them when the
        // Overview starts.
        for (let [w, clone] of this._windowClones.entries()) {
            if (!activeWindows.has(w)) {
                if (isActorValid(clone))
                    clone.destroy();
                this._windowClones.delete(w);
            }
        }
    }
    destroy() {
        // First: these live on Mutter's own window actors, which outlive this
        // manager. A missed disconnect keeps the closure, and the container with
        // it, alive against a destroyed glass.
        this._releaseDamageHooks();
        // Same reasoning: the opt-out effects sit on Mutter's window actors.
        releaseClonedWindowActors(this);
        if (isActorValid(this.windowClonesContainer)) {
            try {
                this.windowClonesContainer.destroy();
            }
            catch (_) { /* noop */ }
        }
        this._windowClones.clear();
        if (isActorValid(this.bgClone)) {
            try {
                this.bgClone.destroy();
            }
            catch (_) { /* noop */ }
        }
        this.container = null;
    }
}
/**
 * A ShaderEffect that punches a rounded-rectangle hole out of whatever it's
 * attached to, leaving only the (inset) corner regions visible.
 *
 * Used by ApplicationManager: real application windows have square surfaces,
 * but the liquid-glass background behind them is rendered with rounded
 * corners (via LiquidEffect's corner_radius uniform). Without this effect the
 * window's own opaque content would square off the corners again, breaking
 * the illusion. Applied to a small overlay actor stacked above the window's
 * content and fed a clone of the true (unblurred) background, it reveals
 * exactly the true corner pixels while leaving the rest of the window alone.
 */
export const InverseCornerEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassInverseCornerEffect',
}, class InverseCornerEffect extends Clutter.ShaderEffect {
    _radius = 0;
    _inset = 0;
    // The glass shape's OWN corner radius. _radius is that plus a couple of
    // pixels (CORNER_PADDING) so the cut safely over-reveals past the glass's
    // antialiased corner; keeping both lets the shader tell the two arcs
    // apart, which is what confines the reveal to the corners.
    _glassRadius = 0;
    setRadius(radius) {
        this._radius = radius;
        this._updateShader();
    }
    setGlassRadius(radius) {
        this._glassRadius = radius;
        this._updateShader();
    }
    setInset(inset) {
        this._inset = inset;
        this._updateShader();
    }
    _updateShader() {
        const shader = `
        uniform sampler2D cogl_sampler;
        uniform float radius;
        uniform float glass_radius;
        uniform float inset;
        uniform float width;
        uniform float height;

        float sdRoundRect(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b + vec2(r);
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
        }

        void main() {
          vec2 st = cogl_tex_coord_in[0].st;
          vec2 resolution = vec2(width, height);
          vec2 p = (st * resolution) - (resolution * 0.5);

          // [FIX] Box half-size at the window's TRUE edge, not shrunk by
          // "inset" on every side. This overlay's actor is padded by
          // SHADER_PADDING beyond the real window bounds on all sides, and
          // "inset" here is exactly that padding — so windowHalf lands
          // precisely on the real window edge.
          //
          // Previously this used (resolution - inset*2)*0.5 with
          // inset = SHADER_PADDING + CORNER_PADDING, which shrank the box by
          // the SAME amount on every side, not just near the corners. Per
          // sdRoundRect's construction, its straight-edge (non-corner)
          // zero-crossing sits exactly at the box half-size regardless of
          // "radius" — only points within "radius" of an actual corner get
          // pulled inward. So shrinking the box itself (rather than only
          // widening "radius") revealed a uniform band along the ENTIRE
          // perimeter — straight edges included — instead of just the 4
          // corners. That band unconditionally painted this overlay's raw,
          // unblurred/untinted/un-shadowed source at full alpha, erasing the
          // drop shadow right next to the window on every edge (reported as
          // an unnatural halo/"frame" around the window), and — since its
          // width is a fixed pixel count independent of actor scale — became
          // sharply more visible whenever GNOME Shell's open/close animation
          // scaled the window down (the same fixed-pixel band read as a much
          // larger fraction of the shrunk window).
          //
          // "radius" (cornerRadius + CORNER_PADDING, set by the caller) is
          // intentionally a couple pixels larger than the glass shape's own
          // corner_radius so the cut safely over-reveals past the glass's
          // own antialiased corner — but that over-cut should only pull the
          // 4 corners inward, not shift the straight edges too.
          vec2 windowHalf = max(resolution * 0.5 - vec2(inset), vec2(1.0));

          // [FIX] This overlay redraws the raw, sharp background on top of the
          // glass, so every pixel it covers is a pixel of drop shadow that
          // cannot be seen. It must therefore cover the corner arcs and
          // NOTHING else. Three terms, each removing one way it used to
          // overreach:
          //
          //   1. outside the cut arc          — the original test
          //   2. still inside the glass shape — stops it reaching outward into
          //                                     the shadow at all
          //   3. only where the two arcs differ — zero along the straight
          //                                     edges, so no seam there
          //
          // History: with only term 1, sdRoundRect is positive everywhere
          // outside the box, so the overlay painted the ENTIRE margin ring and
          // erased the whole drop shadow. Bounding it by the window's square
          // bounds fixed the straight edges but not the corners: the notch
          // between the rounded arc and the square corner is precisely where
          // the shadow wraps around, and the overlay was still sitting on it.
          // Bounding by the glass shape instead is what actually separates
          // "erase the glass's corner" from "do not touch the shadow".
          float dCut = sdRoundRect(p, windowHalf, radius);
          float dGlass = sdRoundRect(p, windowHalf, max(glass_radius, 0.0));

          // 1. Outside the cut arc.
          float alpha = smoothstep(-0.5, 0.5, dCut);

          // 2. Inside the glass, plus a small outward guard so the glass's own
          //    antialiased boundary is covered rather than left as a fringe.
          //    Term 3 keeps this guard from eating shadow along the edges.
          alpha *= 1.0 - smoothstep(-0.5, 0.5, dGlass - 1.5);

          // 3. Corner-only. A rounded rect with a larger radius is a subset of
          //    one with a smaller radius, and the two coincide exactly along
          //    the straight sides — so this difference is 0 there and grows to
          //    about 0.41 * (radius - glass_radius) at the square corner.
          alpha *= smoothstep(0.15, 0.6, dCut - dGlass);

          // Fade out at the very edges of the overlay actor to ensure it blends seamlessly
          // with the background and hides any potential window shadow cutoff.
          // (With the notch restriction above this is normally already 1
          // throughout the painted region — the notches sit at least "inset"
          // px in from the actor edge — but it still guards a degenerate
          // inset smaller than the fade distance.)
          vec2 edgeDist = min(st, 1.0 - st) * resolution;
          float edgeFade = smoothstep(0.0, 10.0, min(edgeDist.x, edgeDist.y));
          alpha *= edgeFade;

          cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
        }
      `;
        this.set_shader_source(shader);
        this._updateUniforms();
    }
    _setUniform(name, value) {
        let gval = new GObject.Value();
        gval.init(GObject.TYPE_FLOAT);
        gval.set_float(value);
        this.set_uniform_value(name, gval);
    }
    _updateUniforms() {
        let actor = this.get_actor();
        if (!actor)
            return;
        let w = actor.width;
        let h = actor.height;
        if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0)
            return;
        this._setUniform('radius', this._radius);
        this._setUniform('glass_radius', this._glassRadius);
        this._setUniform('inset', this._inset);
        this._setUniform('width', w);
        this._setUniform('height', h);
    }
    vfunc_paint_target(node, paint_context) {
        this._updateUniforms();
        super.vfunc_paint_target(node, paint_context);
    }
});
/**
 * Safe helper to retrieve window actors, compatible with GNOME Shell
 * pre-48 (global.get_window_actors) and 48+/GNOME 50 (Mutter moved it to
 * global.compositor.get_window_actors). Every call site in this extension
 * that needs the current list of window actors should go through this
 * instead of calling either API directly.
 */
export function getWindowActors() {
    if (global.compositor && typeof global.compositor.get_window_actors === 'function') {
        return global.compositor.get_window_actors();
    }
    if (typeof global.get_window_actors === 'function') {
        return global.get_window_actors();
    }
    return [];
}
/**
 * Safe helper to check whether a Clutter actor (GObject) is still valid and
 * has not been disposed. Used to guard both the per-frame sync loops and
 * every teardown path; see the traps documented on isActorValid() itself —
 * a disposed GObject neither throws nor returns undefined, so this is the
 * only reliable test.
 */
// ─── [DIAG] Frame-sync freeze ────────────────────────────────────────────────
//
// Every manager keeps a self-rescheduling Meta.LaterType.BEFORE_REDRAW chain
// alive for as long as its target is mapped, and re-syncs its geometry and its
// clones on every single tick. That is a poll, not an event: the dock's glass
// was measured running vfunc_paint_target 119 times in 2.0s (= 59.5/s) with
// the desktop sitting still.
//
// This switch makes every tick reschedule itself and do nothing else. It does
// NOT stop the laters — so if the GPU load collapses, the cost is the per-frame
// sync work and the repaint it dirties into existence, and the fix is to make
// those ticks conditional. If the load barely moves, the cost is elsewhere and
// idle gating would be wasted effort.
//
// Diagnostic only: while frozen the glass stops following anything that moves.
// global._lgGlass.freezeSync(true) / (false).
let _frameSyncFrozen = false;
export function setFrameSyncFrozen(frozen) {
    _frameSyncFrozen = !!frozen;
}
export function isFrameSyncFrozen() {
    return _frameSyncFrozen;
}
// gjs answers this one from the JS side without touching the C object (that
// is how it can report the state at all), and it is the ONLY spelling that
// works inside gnome-shell — see the two traps below.
//
// Trap 1: `String(actor)` does NOT reach gjs here. gnome-shell's
// environment.js:366 replaces Clutter.Actor.prototype.toString with
//     Clutter.Actor.prototype.toString = function () {
//         return St.describe_actor(this);
//     };
// St.describe_actor() is a C call, so on a disposed actor it (a) emits the
// very "impossible to access it" critical this function exists to prevent —
// with a backtrace pointing at the String() line — and (b) returns a plain
// description that never contains "(DISPOSED)". Going through
// GObject.Object.prototype.toString bypasses the override.
//
// Trap 2: reading a property off a disposed wrapper does not throw AND does
// not return undefined — gjs logs the critical and hands back the type's
// default, so `actor.visible` is `false`, a perfectly good boolean, and the
// old `typeof actor.visible === 'boolean'` test passed for dead actors.
// Method calls behave the same way (critical, no throw). That is why every
// try/catch guard in this file was a no-op and why _cleanupState() went on
// to call remove_constraint()/destroy() on disposed actors.
// Verified against gjs 1.88.0 with a standalone run_dispose() repro.
const _gobjectToString = GObject.Object.prototype.toString;
export function isActorValid(actor) {
    if (!actor)
        return false;
    let desc;
    try {
        desc = _gobjectToString.call(actor);
    }
    catch (e) {
        return false;
    }
    // "[object (DISPOSED) instance wrapper GType:... ]" /
    // "[object (FINALIZED) instance wrapper ...]"
    if (desc.indexOf('(DISPOSED)') >= 0 || desc.indexOf('(FINALIZED)') >= 0)
        return false;
    // Alive as far as gjs is concerned, so this read cannot be the disposed
    // case any more. It stays only to reject things that are not actors at
    // all (a plain object, a GObject that is not a Clutter.Actor).
    try {
        return typeof actor.visible === 'boolean';
    }
    catch (e) {
        return false;
    }
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
export const InvertedPositionConstraint = GObject.registerClass({
    GTypeName: 'InvertedPositionConstraint',
    Properties: {
        'source': GObject.ParamSpec.object('source', 'Source', 'Source Actor', GObject.ParamFlags.READWRITE, Clutter.Actor.$gtype),
        'offset-x': GObject.ParamSpec.double('offset-x', 'Offset X', 'X Offset', GObject.ParamFlags.READWRITE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0),
        'offset-y': GObject.ParamSpec.double('offset-y', 'Offset Y', 'Y Offset', GObject.ParamFlags.READWRITE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0),
    },
}, class InvertedPositionConstraint extends Clutter.Constraint {
    _sourceXId = 0;
    _sourceYId = 0;
    _init(props) {
        super._init(props);
        // sourceプロパティ自体が変更されたときの監視
        this.connect('notify::source', this._onSourceChanged.bind(this));
        // [FIX] オフセット変更でもレイアウトを無効化する。
        //
        // vfunc_update_allocation() は「このアクターが allocate される」ときにしか
        // 走らない。以前はそれを促すトリガーが source の notify::x / notify::y
        // だけだった ＝ **ウィンドウが動いたときだけ**。
        //
        // ところが offset は毎フレーム作り直される動的な値で、しかも
        // ApplicationManager._syncStateInner() では
        //     offsetX = -(translation_x + pivot_px * (1 - scale)) - localX
        // と、**scale の関数**になっている。GNOME のウィンドウ開閉アニメーションは
        // 位置を一切変えず scale と pivot だけを動かすので、まさにオフセットが
        // 毎フレーム大きく変わる場面で notify::x / notify::y が一度も飛ばない。
        // その間 allocation は据え置かれ、ガラスの箱だけが縮み/伸びして、中身
        // （壁紙クローン・背後ウィンドウのクローン）は前の位置に取り残される。
        // これが「開く/閉じるアニメーション中にクローンの位置がズレる（オフセット
        // が遅れているように見える）」の正体。
        this.connect('notify::offset-x', () => this._queueRelayout());
        this.connect('notify::offset-y', () => this._queueRelayout());
        if (this.source) {
            this._onSourceChanged();
        }
    }
    _queueRelayout() {
        try {
            const actor = this.get_actor();
            if (actor)
                actor.queue_relayout();
        }
        catch (_) { /* noop */ }
    }
    /**
     * Assigns both offsets and invalidates the allocation exactly once.
     *
     * Preferred over writing `offset_x` / `offset_y` directly: it skips the
     * work entirely when nothing changed (the steady state, 60 times a second
     * per constrained actor) and guarantees the relayout even if GJS's
     * generated property setter ever stops emitting `notify` for an unchanged
     * value.
     */
    setOffset(x, y) {
        const nx = Number.isFinite(x) ? x : 0;
        const ny = Number.isFinite(y) ? y : 0;
        if (this.offset_x === nx && this.offset_y === ny)
            return;
        this.offset_x = nx;
        this.offset_y = ny;
        this._queueRelayout();
    }
    _onSourceChanged() {
        this._disconnectSignals();
        if (this.source) {
            const queueRelayout = () => {
                const actor = this.get_actor();
                if (actor) {
                    actor.queue_relayout(); // 変更があったら再割り当てを要求
                }
            };
            // sourceが移動した時にレイアウト再計算を走らせる
            this._sourceXId = this.source.connect('notify::x', queueRelayout);
            this._sourceYId = this.source.connect('notify::y', queueRelayout);
            // 登録時にも1度レイアウトを要求
            queueRelayout();
        }
    }
    _disconnectSignals() {
        if (!this.source)
            return;
        if (this._sourceXId) {
            this.source.disconnect(this._sourceXId);
            this._sourceXId = 0;
        }
        if (this._sourceYId) {
            this.source.disconnect(this._sourceYId);
            this._sourceYId = 0;
        }
    }
    vfunc_update_allocation(actor, allocation) {
        if (!this.source)
            return;
        // 1. 基準アクターの座標を取得
        const [x, y] = this.source.get_position();
        // 2. 追従アクターの現在の幅と高さを保持
        const width = allocation.get_width();
        const height = allocation.get_height();
        // 3. 反転座標にオフセットを加算
        const targetX = -x + (this.offset_x ?? 0.0);
        const targetY = -y + (this.offset_y ?? 0.0);
        // 4. allocation (Clutter.ActorBox) の領域を直接書き換える
        allocation.x1 = targetX;
        allocation.y1 = targetY;
        allocation.x2 = targetX + width;
        allocation.y2 = targetY + height;
    }
});
/**
 * [PERF ①/①b] Per-frame entry point for the capture clip and the clone cull.
 *
 * Call it from the manager's own sync, AFTER setResolution()/
 * setGlassGeometry() (so the effect's uniforms describe this frame) and
 * BEFORE uiSampler.sync()/windowCloneManager.sync() (so the cull rect this
 * computes is the one those two use this frame, not next frame).
 *
 * Coordinate spaces, because getting one of these wrong makes the glass show
 * an empty background and nothing else:
 *
 *   shader space  liquidBox-local pixels. What LiquidEffect works in
 *                 (resolution_x/y, dock_x/y/w/h, getCaptureClipRect()).
 *   screen space  absolute stage coordinates. What the clones are positioned
 *                 in — both WindowCloneManager and UILayerSampler place
 *                 their clones at the SOURCE's absolute position and let a
 *                 container-level translation map them into the FBO.
 *
 * They differ by the glass's own origin on screen, which the caller passes as
 * originX/originY (the monitor origin for every current caller).
 *
 * The clip goes on the clone container, whose own transform is identity, so
 * its local space IS shader space and the rect can be applied as-is.
 */
export function syncGlassCaptureClip(opts) {
    const { cloneContainer, effect, originX, originY } = opts;
    const uiSampler = opts.uiSampler ?? null;
    const windowCloneManager = opts.windowCloneManager ?? null;
    const clear = () => {
        if (cloneContainer && isActorValid(cloneContainer) &&
            cloneContainer._lgClipW !== undefined) {
            cloneContainer._lgClipX = undefined;
            cloneContainer._lgClipY = undefined;
            cloneContainer._lgClipW = undefined;
            cloneContainer._lgClipH = undefined;
            try {
                cloneContainer.remove_clip();
            }
            catch (_) { }
        }
        uiSampler?.setCullRect(null);
        windowCloneManager?.setCullRect(null);
        windowCloneManager?.applyBgCloneClip(null);
        if (effect)
            effect._lgCaptureClip = null;
    };
    if (!isCaptureClipEnabled() && !isCloneCullEnabled()) {
        clear();
        return;
    }
    if (!effect || typeof effect.getCaptureClipRect !== 'function') {
        clear();
        return;
    }
    let rect = null;
    try {
        const r = effect.getCaptureClipRect();
        if (r)
            rect = [r[0], r[1], r[2], r[3]];
    }
    catch (_) {
        clear();
        return;
    }
    if (!rect) {
        clear();
        return;
    }
    // A BMS replica whose rect we have not measured yet: sit this frame out
    // rather than risk clipping the panel's band away for one frame. It costs
    // a single unclipped paint, once, right after the replica is built.
    if (uiSampler?.hasUnmeasuredBmsReplica()) {
        clear();
        return;
    }
    // Widen to cover every BMS replica this glass draws. A BACKGROUND-mode BMS
    // blur reads the framebuffer over the panel's full stage rect, so any part
    // of that rect we stop painting into comes back as blurred transparency
    // smeared across the whole panel (memo.md 追記4). The panel is full width,
    // so with the dock at the top edge this widens the clip to the full screen
    // — the height still collapses, which is where the saving is.
    const bmsRects = uiSampler?.getBmsScreenRects() ?? [];
    for (const b of bmsRects) {
        unionRectInto(rect, [b[0] - originX, b[1] - originY, b[2], b[3]]);
    }
    const [resW, resH] = typeof effect.getResolution === 'function'
        ? effect.getResolution() : [0, 0];
    if (resW >= 1 && resH >= 1) {
        const x1 = Math.min(resW, rect[0] + rect[2]);
        const y1 = Math.min(resH, rect[1] + rect[3]);
        rect[0] = Math.max(0, rect[0]);
        rect[1] = Math.max(0, rect[1]);
        rect[2] = x1 - rect[0];
        rect[3] = y1 - rect[1];
        if (!(rect[2] >= 2) || !(rect[3] >= 2)) {
            clear();
            return;
        }
    }
    if (isCaptureClipEnabled() && cloneContainer && isActorValid(cloneContainer)) {
        setClipIfChanged(cloneContainer, rect[0], rect[1], rect[2], rect[3]);
    }
    else if (cloneContainer && isActorValid(cloneContainer) &&
        cloneContainer._lgClipW !== undefined) {
        cloneContainer._lgClipW = undefined;
        try {
            cloneContainer.remove_clip();
        }
        catch (_) { }
    }
    // [DIAG] Visible in global._lgGlass.dump() as `captureClip`.
    effect._lgCaptureClip = rect.slice();
    const screenRect = [rect[0] + originX, rect[1] + originY, rect[2], rect[3]];
    // The wallpaper clone is not under cloneContainer, so it needs its own
    // clip — in screen space. See applyBgCloneClip().
    windowCloneManager?.applyBgCloneClip(isCaptureClipEnabled() ? screenRect : null);
    uiSampler?.setCullRect(screenRect);
    windowCloneManager?.setCullRect(screenRect);
}
