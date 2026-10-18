import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { reportFrameLoopError } from '../diagnostics/logging.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './frameSync.js';

export function addBeforeRedraw(callback) {
    return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
}

export function removeBeforeRedraw(id) {
    if (!id)
        return;
    global.compositor.get_laters().remove(id);
}

// A self-rescheduling BEFORE_REDRAW chain. The next tick is scheduled before
// step() runs, so an exception in step() is reported (rate-limited) instead of
// silently ending the chain and freezing the glass.
export function startLaterLoop(slot, loop) {
    if (slot.get() !== 0)
        return false;
    const tick = () => {
        slot.set(0);
        if (!loop.alive())
            return GLib.SOURCE_REMOVE;
        slot.set(addBeforeRedraw(tick));
        if (loop.honourFreeze && isFrameSyncFrozen())
            return GLib.SOURCE_REMOVE;
        try {
            loop.step();
        }
        catch (e) {
            reportFrameLoopError(loop.errorTag, e);
        }
        return GLib.SOURCE_REMOVE;
    };
    slot.set(addBeforeRedraw(tick));
    return true;
}

export function stopLaterLoop(slot) {
    const id = slot.get();
    slot.set(0);
    removeBeforeRedraw(id);
}

// Follows the stage's own frames instead of requesting them, so an idle
// desktop does not keep the frame clock running. `first` covers the frame in
// which the loop starts.
export function startStageLoop(signal, first, tick) {
    if (signal.get() !== 0)
        return false;
    signal.set(global.stage.connect('before-update', tick));
    first.set(addBeforeRedraw(() => {
        first.set(0);
        tick();
        return GLib.SOURCE_REMOVE;
    }));
    return true;
}

export function stopStageLoop(signal, first) {
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
export function startSyncLoop(signal, first, loop) {
    let lastUs = 0;
    return startStageLoop(signal, first, () => {
        if (!loop.alive()) {
            stopStageLoop(signal, first);
            return;
        }
        if (loop.honourFreeze && isFrameSyncFrozen())
            return;
        const nowUs = GLib.get_monotonic_time();
        if (nowUs - lastUs < SAME_FRAME_WINDOW_US)
            return;
        lastUs = nowUs;
        try {
            loop.step();
        }
        catch (e) {
            reportFrameLoopError(loop.errorTag, e);
        }
    });
}
