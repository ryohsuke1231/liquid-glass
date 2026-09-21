import { isActorValid } from './lifecycle.js';
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
/**
 * [anim-jitter] Rescue for a stranded MetaWindowActor, gentlest option first.
 *
 * ensureGlassAllocated()'s rescue is hide() + show(). On OUR actors that is
 * fine. On mutter's own window actor it is not something to do lightly, and
 * the 100ms-interval capture of a stuttering minimise shows how often it was
 * happening: 171 remaps across 70 seconds, over five different windows, ~3 a
 * second, every one of them landing in the middle of a window animation.
 *
 * Why it was reached for at all: a glass root's queue_relayout() dies inside
 *
 *     _clutter_actor_queue_only_relayout (windowActor)
 *       if (needs_width_request && needs_height_request && needs_allocation)
 *         return;  // save some cpu cycles
 *
 * whenever the window actor itself is stranded, so the request never reaches
 * the stage and the subtree stays unallocated.
 *
 * But that short-circuit is tested against THAT actor's own flags, and
 * neither MetaWindowGroup nor MetaWindowActor implements an allocate vfunc or
 * sets CLUTTER_ACTOR_NO_LAYOUT — their children go through Clutter's default
 * allocate, which recurses. So asking the PARENT to relayout is not swallowed:
 * the window group is normally allocated, the request reaches the stage, and
 * the next relayout allocates the window actor (needs_allocation is set) and
 * with it the whole glass subtree.
 *
 * Two stages, so the proven repair is still there as a backstop:
 *   relayoutFrames  ask the parent to relayout — costs one relayout
 *   remapFrames     hide()/show() the window actor, as before
 *
 * Returns which stage ran, '' for none, so the caller can log them apart and
 * the next capture says outright whether stage 1 is doing the work.
 */
export function ensureWindowActorAllocated(actor, relayoutFrames, remapFrames) {
    try {
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
            // Walk up to an ancestor that can actually FORWARD the request.
            //
            // Queueing on the immediate parent was a no-op in practice, and the
            // chain diagnostic says why: in 242 of 289 strand events the window
            // group itself reported alloc=false —
            //
            //   wa(mapped=true,vis=true,alloc=false,op=255,scale=1.000)
            //   parent(Meta_WindowGroup,mapped=true,alloc=false)
            //   bg(mapped=true,vis=true,alloc=false) min=false
            //
            // and clutter_actor_queue_relayout() opens with
            //
            //   if (needs_width_request && needs_height_request && needs_allocation)
            //     return; /* save some cpu cycles */
            //
            // which is exactly the state an actor with no allocation is in. So the
            // request died in the window group the same way it used to die in the
            // window actor, and stage 2 kept firing (134 remaps against 155
            // relayouts in one 60s capture).
            //
            // An ancestor that still HAS an allocation is not in that state, so its
            // queue_relayout() propagates to the stage and the whole subtree is
            // allocated on the next pass.
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
    catch (_) {
        return '';
    }
}
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
