"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.addBeforeRedraw = addBeforeRedraw;
exports.removeBeforeRedraw = removeBeforeRedraw;
exports.startLaterLoop = startLaterLoop;
exports.stopLaterLoop = stopLaterLoop;
exports.startStageLoop = startStageLoop;
exports.stopStageLoop = stopStageLoop;
exports.startSyncLoop = startSyncLoop;
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://Meta"));
const logging_js_1 = require("../diagnostics/logging.js");
const frameSync_js_1 = require("./frameSync.js");

function addBeforeRedraw(callback) {
    return global.compositor.get_laters().add(2.default.LaterType.BEFORE_REDRAW, callback);
}

function removeBeforeRedraw(id) {
    if (!id)
        return;
    global.compositor.get_laters().remove(id);
}
// A self-rescheduling BEFORE_REDRAW chain. The next tick is scheduled before
// step() runs, so an exception in step() is reported (rate-limited) instead of
// silently ending the chain and freezing the glass.

function startLaterLoop(slot, loop) {
    if (slot.get() !== 0)
        return false;
    const tick = () => {
        slot.set(0);
        if (!loop.alive())
            return 1.default.SOURCE_REMOVE;
        slot.set(addBeforeRedraw(tick));
        if (loop.honourFreeze && (0, frameSync_js_1.isFrameSyncFrozen)())
            return 1.default.SOURCE_REMOVE;
        try {
            loop.step();
        }
        catch (e) {
            (0, logging_js_1.reportFrameLoopError)(loop.errorTag, e);
        }
        return 1.default.SOURCE_REMOVE;
    };
    slot.set(addBeforeRedraw(tick));
    return true;
}

function stopLaterLoop(slot) {
    const id = slot.get();
    slot.set(0);
    removeBeforeRedraw(id);
}
// Follows the stage's own frames instead of requesting them, so an idle
// desktop does not keep the frame clock running. `first` covers the frame in
// which the loop starts.

function startStageLoop(signal, first, tick) {
    if (signal.get() !== 0)
        return false;
    signal.set(global.stage.connect('before-update', tick));
    first.set(addBeforeRedraw(() => {
        first.set(0);
        tick();
        return 1.default.SOURCE_REMOVE;
    }));
    return true;
}

function stopStageLoop(signal, first) {
    const signalId = signal.get();
    signal.set(0);
    if (signalId)
        global.stage.disconnect(signalId);
    stopLaterLoop(first);
}
/**
 * startStageLoop() for a manager's per-frame sync, taking the same loop as
 * startLaterLoop(). `step` runs at most once per frame (several stage views
 * update in the same one), and the loop stops itself once `alive()` is false.
 * Exceptions are reported rate-limited, and the loop keeps running.
 */

function startSyncLoop(signal, first, loop) {
    let lastUs = 0;
    return startStageLoop(signal, first, () => {
        if (!loop.alive()) {
            stopStageLoop(signal, first);
            return;
        }
        if (loop.honourFreeze && (0, frameSync_js_1.isFrameSyncFrozen)())
            return;
        const nowUs = 1.default.get_monotonic_time();
        if (nowUs - lastUs < frameSync_js_1.SAME_FRAME_WINDOW_US)
            return;
        lastUs = nowUs;
        try {
            loop.step();
        }
        catch (e) {
            (0, logging_js_1.reportFrameLoopError)(loop.errorTag, e);
        }
    });
}
