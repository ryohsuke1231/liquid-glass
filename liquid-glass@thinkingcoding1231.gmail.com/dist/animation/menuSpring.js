import { MAX_STEP_S } from './spring.js';
const CLOSE_SPEED = 15.0;
const CLOSED_BELOW = 0.005;
const OPEN_SNAP_DISTANCE = 0.002;
const OPEN_SNAP_VELOCITY = 0.03;

function clampOpacity(v) {
    return Math.min(255, Math.max(0, v));
}

// Closing uses exponential decay: faster than the spring and never bounces.
function stepClosing(scale, elapsedMs) {
    const dt = Math.min(elapsedMs / 1000, MAX_STEP_S);
    const k = 1.0 - Math.exp(-CLOSE_SPEED * dt);
    scale.value += (0 - scale.value) * k;
    if (scale.value < CLOSED_BELOW)
        return { s: 0, stopped: true };
    return { s: scale.value, stopped: false };
}

// Opening uses the spring, which gives the bounce.
function stepOpening(scale, elapsedMs) {
    const settled = scale.update(elapsedMs);
    const s = scale.value;
    // Snap to 1.0 once the bounce has almost settled, instead of micro-stepping forever.
    if (Math.abs(1.0 - s) < OPEN_SNAP_DISTANCE && Math.abs(scale.velocity) < OPEN_SNAP_VELOCITY)
        return { s: 1.0, stopped: true };
    return { s, stopped: settled };
}

export function stepMenuSpring(scale, elapsedMs) {
    const closing = scale.target === 0;
    const { s, stopped } = closing ? stepClosing(scale, elapsedMs) : stepOpening(scale, elapsedMs);
    // Scale 0 crashes Cogl, hence the 0.001 floor. Opacity fades out between
    // scale 1.0 and 0.3, ahead of the shrink.
    if (closing)
        return { closing, stopped, scale: Math.max(0.001, s), opacity: clampOpacity((s - 0.3) / 0.7 * 255) };
    return { closing, stopped, scale: 0.2 + s * 0.8, opacity: clampOpacity((s / 0.3) * 255) };
}

export function applyMenuFrame(frame, animActor, glass, menuActor, sync) {
    animActor.set_scale(frame.scale, frame.scale);
    glass.opacity = frame.opacity;
    animActor.opacity = frame.opacity;
    sync();
    if (!frame.stopped)
        return;
    if (frame.closing) {
        if (!menuActor)
            return;
        menuActor.hide();
        glass.opacity = 0;
        animActor.opacity = 0;
        return;
    }
    animActor.set_scale(1.0, 1.0);
    animActor.opacity = 255;
    glass.opacity = 255;
    sync();
}

export function showMenuAtRest(glass, animActor) {
    if (!glass)
        return;
    glass.remove_all_transitions();
    glass.opacity = 255;
    glass.set_scale(1.0, 1.0);
    if (!animActor)
        return;
    animActor.set_scale(1.0, 1.0);
    animActor.opacity = 255;
}
