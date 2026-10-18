export const SAME_FRAME_WINDOW_US = 4000;
// Diagnostic switch (global._lgGlass.freezeSync): every per-frame sync tick
// keeps rescheduling but does no work, so the cost of the sync itself can be
// measured. The glass stops following anything that moves while it is on.
let _frameSyncFrozen = false;

export function setFrameSyncFrozen(frozen) {
    _frameSyncFrozen = !!frozen;
}

export function isFrameSyncFrozen() {
    return _frameSyncFrozen;
}
