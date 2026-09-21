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
export const SAME_FRAME_WINDOW_US = 4000;
let _frameSyncFrozen = false;
export function setFrameSyncFrozen(frozen) {
    _frameSyncFrozen = !!frozen;
}
export function isFrameSyncFrozen() {
    return _frameSyncFrozen;
}
