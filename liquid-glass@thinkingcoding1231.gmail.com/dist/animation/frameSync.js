"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAME_FRAME_WINDOW_US = void 0;
exports.setFrameSyncFrozen = setFrameSyncFrozen;
exports.isFrameSyncFrozen = isFrameSyncFrozen;
exports.SAME_FRAME_WINDOW_US = 4000;
// Diagnostic switch (global._lgGlass.freezeSync): every per-frame sync tick
// keeps rescheduling but does no work, so the cost of the sync itself can be
// measured. The glass stops following anything that moves while it is on.
let _frameSyncFrozen = false;

function setFrameSyncFrozen(frozen) {
    _frameSyncFrozen = !!frozen;
}

function isFrameSyncFrozen() {
    return _frameSyncFrozen;
}
