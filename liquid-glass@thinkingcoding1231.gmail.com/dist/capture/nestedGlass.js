import { isActorValid } from '../actors/lifecycle.js';
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
