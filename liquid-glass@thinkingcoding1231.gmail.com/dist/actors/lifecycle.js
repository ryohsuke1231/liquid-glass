import GObject from 'gi://GObject';
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
