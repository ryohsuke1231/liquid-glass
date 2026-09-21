import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { releaseFrameSerialHook } from '../rendering/frameClock.js';
import { setBmsMode, BMS_MODE } from '../capture/uiLayerSampler.js';
import { setFrameSyncFrozen, isFrameSyncFrozen } from '../animation/frameSync.js';
import { setDiffWritesEnabled, isDiffWritesEnabled } from '../actors/writes.js';
import { setCaptureClipEnabled, isCaptureClipEnabled, setCloneCullEnabled, isCloneCullEnabled, setCullSiteEnabled, isCullSiteEnabled } from '../capture/options.js';
import { setAdaptiveColorMode, getAdaptiveColorMode } from '../animation/colors.js';
import { setNestedGlassFix, getNestedGlassFix, setFocusDebugEnabled, isFocusDebugEnabled } from '../capture/nestedGlass.js';
import { setBackgroundMirrorEnabled, isBackgroundMirrorEnabled } from '../capture/background.js';
import { setCullOptOutEnabled, isCullOptOutEnabled } from '../capture/windowCulling.js';
import { setWindowActorRescueMode, getWindowActorRescueMode } from '../actors/allocation.js';
// ─── Looking Glass diagnostics ───────────────────────────────────────────────
//
// Every live LiquidEffect registers itself here so its last resolved frame
// state can be inspected from Looking Glass:
//
//     global._lgGlass.dump()      // one line per instance
//     global._lgGlass.count()
//
// This exists mainly to settle "is the blur actually reaching the composite?"
// without a rebuild: glass.frag samples ONLY layer 1, so `blurResult: NULL`
// in the dump means the glass is showing the raw, unblurred capture.
const _liveEffects = new Set();
/**
 * [anim-stall] A rolling in-memory record of what every window glass is doing,
 * flushed to the journal only when asked.
 *
 * The fault this exists for is rare and has no known trigger, and a capture
 * that starts AFTER it is noticed necessarily misses the one thing worth
 * seeing: the frames where a perfectly normal animation turns into a stuck
 * one. Logging continuously to the journal instead is not an option -- an
 * earlier version of this extension hung the compositor by doing exactly that
 * (journald backpressure on the main thread).
 *
 * So: sample cheaply into a ring buffer, write nothing, and dump the buffer
 * when the capture key is pressed. Pressing it just after seeing the glitch
 * then yields the seconds LEADING UP TO it.
 *
 * Kept small on purpose:
 *   - only the fields that separate a healthy animation from a stuck one;
 *   - a sample is stored only when a window's line actually CHANGED, so an
 *     idle desktop costs one string compare per window per tick and the
 *     buffer keeps spanning back to the last thing that moved;
 *   - RING_MAX caps the memory regardless.
 */
const RING_MAX = 4000;
const _ring = [];
let _ringLast = new Map();
function _ringSampleOnce() {
    const t = GLib.get_monotonic_time();
    for (const fx of _liveEffects) {
        if (fx._owner !== 'application')
            continue;
        let line = '';
        try {
            const a = fx.get_actor();
            if (!a)
                continue;
            const wa = a.get_parent();
            if (!wa)
                continue;
            const trOp = wa.get_transition ? wa.get_transition('opacity') : null;
            const mw = wa.get_meta_window ? wa.get_meta_window() : null;
            line =
                `${fx._diagOwnerLabel || '?'}|sc=${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}` +
                    `|op=${wa.opacity}|pos=${Math.round(wa.x)},${Math.round(wa.y)}` +
                    `|map=${wa.mapped ? 1 : 0}|alloc=${wa.has_allocation() ? 1 : 0}` +
                    `|gAlloc=${a.has_allocation() ? 1 : 0}|gPos=${Math.round(a.x)},${Math.round(a.y)}` +
                    `|gSize=${Math.round(a.width)}x${Math.round(a.height)}` +
                    `|min=${mw && mw.minimized ? 1 : 0}` +
                    // [anim-stall] The window GROUP's allocation is the variable the whole
                    // diagnosis turns on -- being stranded means glass, window actor AND
                    // the group all have needs_allocation, and it is the group being in
                    // that state that swallows every repair request raised from inside the
                    // chain. The ring was recording everything except it.
                    `|wgAlloc=${(() => {
                        const wg = wa.get_parent();
                        return wg ? (wg.has_allocation() ? 1 : 0) : '-';
                    })()}` +
                    `|views=${(wa.peek_stage_views() || []).length}` +
                    (trOp
                        ? `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
                            `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`
                        : '|tr=-');
        }
        catch (_) {
            continue;
        }
        if (_ringLast.get(fx) === line)
            continue;
        _ringLast.set(fx, line);
        _ring.push(`${t} ${line}`);
        if (_ring.length > RING_MAX)
            _ring.shift();
    }
}
/**
 * [anim-stall] Flushes the ring the first few times the stranded state is
 * ENTERED, without anyone having to press anything.
 *
 * The exit fix means the chain now recovers in a few frames, so the user has
 * nothing to react to -- but the entry still happens tens of times a minute
 * (35 relayouts and 16 remaps in one healthy 60s capture). Waiting for a
 * latch that no longer forms would be waiting for the wrong event; the entry
 * is already abundant, and it is the entry we do not understand.
 *
 * Capped, because this writes to the journal: a diagnostic that fires without
 * a limit is how this extension hung the compositor once before.
 */
let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;
export function noteStrandEntry(label, detail) {
    // Disarmed by default: nothing is sampled and nothing is written unless the
    // recorder was switched on for an investigation.
    if (!_ringArmed)
        return;
    if (_autoCaptures >= AUTO_CAPTURE_LIMIT)
        return;
    _autoCaptures++;
    console.log(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
        `on strand entry for "${label}" — ${detail}`);
    try {
        flushGlassRing();
    }
    catch (e) {
        console.error(`[Liquid Glass][ring] ${e}`);
    }
}
// Off unless an investigation switches it on: a 20Hz timer that exists only
// for a fault which is now mitigated has no business running on every desktop.
// global._lgGlass.ring(true) arms it; Ctrl+Alt+L then flushes whatever it holds.
let _ringArmed = false;
let _ringSamplerEnabled = false;
let _ringSamplerId = 0;
let _ringSamplerInterval = 50;
function syncGlassRingSampler() {
    if (!_ringArmed || !_ringSamplerEnabled) {
        if (_ringSamplerId)
            GLib.Source.remove(_ringSamplerId);
        _ringSamplerId = 0;
    }
    else if (!_ringSamplerId) {
        _ringSamplerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, _ringSamplerInterval, () => {
            try {
                _ringSampleOnce();
            }
            catch (_) { }
            return GLib.SOURCE_CONTINUE;
        });
    }
}
export function setGlassRingArmed(armed) {
    _ringArmed = !!armed;
    syncGlassRingSampler();
    if (!_ringArmed) {
        _ring.length = 0;
        _ringLast = new Map();
        _autoCaptures = 0;
    }
}
export function isGlassRingArmed() {
    return _ringArmed;
}
export function startGlassRingSampler(intervalMs = 50) {
    _ringSamplerInterval = intervalMs;
    _ringSamplerEnabled = true;
    syncGlassRingSampler();
}
export function stopGlassRingSampler() {
    _ringSamplerEnabled = false;
    setGlassRingArmed(false);
}
/** Writes the ring buffer out and clears it. */
export function flushGlassRing() {
    if (!_ring.length) {
        console.log('[Liquid Glass][ring] empty');
        return;
    }
    const t0 = parseInt(_ring[0].split(' ')[0], 10);
    const tN = parseInt(_ring[_ring.length - 1].split(' ')[0], 10);
    const lines = _ring.map(r => {
        const sp = r.indexOf(' ');
        const ms = Math.round((parseInt(r.slice(0, sp), 10) - t0) / 1000);
        return `+${String(ms).padStart(6)}ms ${r.slice(sp + 1)}`;
    });
    // Chunked, NOT one giant message: journald truncates an over-long line, and
    // a flood of tiny ones is what hung the compositor once before (backpressure
    // on the main thread). A few dozen medium messages is neither.
    const CHUNK = 150;
    const total = Math.ceil(lines.length / CHUNK);
    console.log(`[Liquid Glass][ring] BEGIN ${lines.length} samples spanning ` +
        `${Math.round((tN - t0) / 1000)}ms in ${total} chunk(s)`);
    for (let i = 0; i < total; i++) {
        console.log(`[Liquid Glass][ring] ${i + 1}/${total}\n` +
            lines.slice(i * CHUNK, (i + 1) * CHUNK).join('\n'));
    }
    console.log('[Liquid Glass][ring] END');
    _ring.length = 0;
    _ringLast = new Map();
}
function _registerGlassDebugHooks() {
    const g = globalThis;
    if (!g.global || g.global._lgGlass)
        return;
    g.global._lgGlass = {
        count: () => _liveEffects.size,
        // A/B switch for the glass.frag early exits across every live instance.
        // Diagnostic visualisation: 1 = red where the shader computes a drop
        // shadow, green where it computes the glass shape itself, 0 = normal.
        debugView: (mode) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setDebugView(mode);
                    n++;
                }
                catch (e) { }
            }
            const msg = `[Liquid Glass] debug_view = ${mode} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        // A/B switch for how a Blur My Shell target is supplied to the glass:
        // 0 = SNAPSHOT (default), 1 = CLONE, 2 = SKIP. See BMS_MODE in utils.ts.
        bmsMode: (mode) => setBmsMode(mode),
        BMS_MODE,
        // A/B switch for the blurred sub-rect across every live instance.
        blurRect: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setBlurRectEnabled(enabled);
                    n++;
                }
                catch (e) { }
            }
            const msg = `[Liquid Glass] blur sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        // [DIAG] Freezes every manager's per-frame sync loop. The loops keep
        // rescheduling but do no work, so what the polling itself costs can be
        // read straight off gpu_busy_percent. The glass stops following anything
        // that moves while this is on — diagnostic only.
        freezeSync: (frozen) => {
            setFrameSyncFrozen(frozen);
            const msg = `[Liquid Glass] per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`;
            console.log(msg);
            return msg;
        },
        syncFrozen: () => isFrameSyncFrozen(),
        // A/B switch for how the adaptive text colour gets from one colour to the
        // other. 'cross-fade' (default) dissolves through alpha so a white<->black
        // flip never sits at mid-grey; 'rgb-lerp' is the plain channel
        // interpolation, which does. Both run on the same shared frame-clock
        // driver, so this changes the curve and nothing else.
        textColorMode: (mode) => {
            const m = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
            setAdaptiveColorMode(m);
            const msg = `[Liquid Glass] adaptive text colour mode = ${m}`;
            console.log(msg);
            return msg;
        },
        textColorModeName: () => getAdaptiveColorMode(),
        // A/B switch for the nested-glass repair. 'off' is the behaviour with the
        // bug (a glass that clones a glassed window latches to black when that
        // inner glass re-renders); 'recapture' never reuses the outer capture;
        // 'propagate' repairs only after an inner re-render, one frame late.
        // See NestedGlassFix in utils.ts for the measurements behind this.
        nestedFix: (mode) => {
            const m = mode;
            setNestedGlassFix(m);
            const msg = `[Liquid Glass] nested-glass repair = ${m}`;
            console.log(msg);
            return msg;
        },
        nestedFixMode: () => getNestedGlassFix(),
        // [black-frame] A/B switch for the actual fix: true (default) gives every
        // glass its own Meta.BackgroundContent instead of cloning
        // _backgroundGroup, so the wallpaper no longer inherits the real
        // background actor's per-frame damage-region culling. false restores the
        // Clutter.Clone that produced the black frame.
        //
        // Only affects glass created AFTER the switch — toggle the extension off
        // and on (not a re-login; that is only needed for new CODE) to rebuild
        // the existing ones.
        bgMirror: (on) => {
            setBackgroundMirrorEnabled(on);
            const msg = `[Liquid Glass] background mirror ${on ? 'ENABLED' : 'disabled'} ` +
                '(toggle the extension off/on to rebuild existing glass)';
            console.log(msg);
            return msg;
        },
        bgMirrorEnabled: () => isBackgroundMirrorEnabled(),
        // [window-clone-clip] A/B switch for the cloned-window cull opt-out: true
        // (default) parks a do-nothing ClutterEffect on every window actor a glass
        // currently clones, which makes meta-cullable.c hand its surface actor a
        // NULL clip region instead of this frame's damage. false restores mutter's
        // normal culling — and with it both the damage clipping AND the occlusion
        // culling that the opt-out gives up, so this is the switch to flip when
        // comparing idle GPU. Takes effect on the next frame, no rebuild needed.
        cullOptOut: (on) => {
            setCullOptOutEnabled(on);
            const msg = `[Liquid Glass] cloned-window cull opt-out ${on ? 'ENABLED' : 'disabled'}`;
            console.log(msg);
            return msg;
        },
        cullOptOutEnabled: () => isCullOptOutEnabled(),
        // [anim-jitter] A/B switch for the stranded-window-actor rescue.
        //   'two-stage' (default) ask the window group to relayout first, and only
        //               fall back to unmapping/remapping mutter's window actor if
        //               that did not land;
        //   'remap'     straight to hide()/show(), the historical behaviour that
        //               the 100ms capture caught firing ~3x a second mid-animation;
        //   'off'       never touch mutter's window actor -- diagnostic only, the
        //               clones can then freeze at stale coordinates.
        // Watch "[strand] relayout via parent" vs "[strand] remapped" in the log
        // to see which stage is actually doing the work.
        windowRescue: (mode) => {
            setWindowActorRescueMode(mode);
            const msg = `[Liquid Glass] window-actor rescue = ${getWindowActorRescueMode()}`;
            console.log(msg);
            return msg;
        },
        windowRescueMode: () => getWindowActorRescueMode(),
        // [diag] The rolling pre-fault recorder. Off by default; arm it only when
        // chasing something, then press Ctrl+Alt+L to flush what led up to it.
        ring: (on) => {
            setGlassRingArmed(on);
            const msg = `[Liquid Glass] ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`;
            console.log(msg);
            return msg;
        },
        ringArmed: () => isGlassRingArmed(),
        ringFlush: () => { flushGlassRing(); return 'flushed'; },
        // The clone-placement diagnostic. OFF by default: left armed it wrote
        // ~400 journal lines a second from the compositor's main thread and hung
        // the shell (2026-09-17). See setFocusDebugEnabled() in utils.ts.
        focusDebug: (on) => {
            setFocusDebugEnabled(on);
            const msg = `[Liquid Glass] focus-debug logging ${on ? 'ENABLED' : 'disabled'}`;
            console.log(msg);
            return msg;
        },
        focusDebugEnabled: () => isFocusDebugEnabled(),
        // [PERF] A/B switch for compare-then-write in every per-frame sync loop
        // (the "idle gating" of memo ④). true (default) = a clone property is
        // only written when its value actually changed; false = the old
        // unconditional writes. Unlike freezeSync this is not diagnostic-only:
        // it changes nothing about what is drawn, only how often the stage is
        // damaged. See setDiffWritesEnabled() in utils.ts.
        diffWrites: (enabled) => {
            setDiffWritesEnabled(enabled);
            const msg = `[Liquid Glass] diff writes ${enabled ? 'ENABLED' : 'DISABLED'}`;
            console.log(msg);
            return msg;
        },
        diffWritesEnabled: () => isDiffWritesEnabled(),
        // [PERF ①] A/B switch for clipping the offscreen CAPTURE to the region
        // the glass can actually show. **Ships OFF**: measured at 40-42% against
        // 36-38% without it, i.e. it costs about 4 points and returns nothing.
        // See the measurement table above setCaptureClipEnabled() in utils.ts.
        captureClip: (enabled) => {
            setCaptureClipEnabled(enabled);
            const msg = `[Liquid Glass] capture clip ${enabled ? 'ENABLED' : 'DISABLED'}`;
            console.log(msg);
            return msg;
        },
        captureClipEnabled: () => isCaptureClipEnabled(),
        // [PERF ①b] A/B switch for hiding clones that fall outside that same
        // rect. This is the one that removes nested glass paints (an invisible
        // clone never paints its source), so it is the interesting half.
        cloneCull: (enabled) => {
            setCloneCullEnabled(enabled);
            const msg = `[Liquid Glass] clone cull ${enabled ? 'ENABLED' : 'DISABLED'}`;
            console.log(msg);
            return msg;
        },
        cloneCullEnabled: () => isCloneCullEnabled(),
        // [DIAG ①b] The three cull sites, individually. Each is ANDed with
        // cloneCull above. See setCullSiteEnabled() in utils.ts.
        cullApp: (enabled) => {
            setCullSiteEnabled('app', enabled);
            const msg = `[Liquid Glass] cull site app (behind-window clones) ${enabled ? 'ON' : 'OFF'}`;
            console.log(msg);
            return msg;
        },
        cullWindows: (enabled) => {
            setCullSiteEnabled('windows', enabled);
            const msg = `[Liquid Glass] cull site windows (dock/menu window clones) ${enabled ? 'ON' : 'OFF'}`;
            console.log(msg);
            return msg;
        },
        cullUi: (enabled) => {
            setCullSiteEnabled('ui', enabled);
            const msg = `[Liquid Glass] cull site ui (uiGroup clones) ${enabled ? 'ON' : 'OFF'}`;
            console.log(msg);
            return msg;
        },
        // [DIAG] Full subtree of every glass — painted AND not — so the capture's
        // actual contents can be compared against what the screen shows. Use it
        // when something is missing from a glass and cullReport() says nothing is
        // culled: what is missing is then either absent from the tree entirely or
        // present and still not drawn.
        treeReport: (maxDepth = 4) => {
            const lines = [];
            for (const fx of _liveEffects) {
                let actor = null;
                try {
                    actor = fx.get_actor?.();
                }
                catch (e) { }
                const owner = (() => {
                    try {
                        return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)';
                    }
                    catch (e) {
                        return '(?)';
                    }
                })();
                const res = (() => { try {
                    return fx.getResolution();
                }
                catch (e) {
                    return [0, 0];
                } })();
                lines.push(`── ${owner} res=${res[0]}x${res[1]}`);
                const walk = (a, depth) => {
                    if (depth > maxDepth)
                        return;
                    let children = [];
                    try {
                        children = a.get_children();
                    }
                    catch (e) {
                        return;
                    }
                    for (const c of children) {
                        let name = '(?)', vis = true, op = 255, geom = '?';
                        try {
                            name = c.get_name() || '(unnamed)';
                        }
                        catch (e) { }
                        try {
                            vis = c.visible;
                            op = c.opacity;
                            geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                                `p=(${Math.round(c.x)},${Math.round(c.y)}) size=${Math.round(c.width)}x${Math.round(c.height)}`;
                        }
                        catch (e) { }
                        lines.push(`   ${'  '.repeat(depth)}${vis && op > 0 ? '   ' : 'XX '}"${name}" ` +
                            `vis=${vis} op=${op} culled=${!!c._lgCulled} ${geom}`);
                        walk(c, depth + 1);
                    }
                };
                if (actor)
                    walk(actor, 0);
            }
            const out = lines.join('\n');
            console.log(out);
            return out;
        },
        cullSites: () => ({
            app: isCullSiteEnabled('app'),
            windows: isCullSiteEnabled('windows'),
            ui: isCullSiteEnabled('ui'),
        }),
        // [DIAG ①b] Lists every live glass and every clone inside it that is
        // currently not being painted — culled (opacity 0) or hidden. This is
        // the probe for "part of the glass background went black": whatever is
        // missing on screen shows up here as a clone that should not be in the
        // list.
        cullReport: () => {
            const lines = [];
            for (const fx of _liveEffects) {
                let actor = null;
                try {
                    actor = fx.get_actor?.();
                }
                catch (e) { }
                const owner = (() => {
                    try {
                        return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)';
                    }
                    catch (e) {
                        return '(?)';
                    }
                })();
                const res = (() => { try {
                    return fx.getResolution();
                }
                catch (e) {
                    return [0, 0];
                } })();
                lines.push(`── ${owner} res=${res[0]}x${res[1]} captureClip=${JSON.stringify(fx._lgCaptureClip ?? null)}`);
                const walk = (a, depth) => {
                    let children = [];
                    try {
                        children = a.get_children();
                    }
                    catch (e) {
                        return;
                    }
                    for (const c of children) {
                        let name = '(?)', vis = true, op = 255;
                        try {
                            name = c.get_name() || `(${c.constructor?.name ?? 'actor'})`;
                        }
                        catch (e) { }
                        try {
                            vis = c.visible;
                            op = c.opacity;
                        }
                        catch (e) { }
                        if (!vis || op === 0) {
                            let geom = '?';
                            try {
                                geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                                    `size=${Math.round(c.width)}x${Math.round(c.height)}`;
                            }
                            catch (e) { }
                            lines.push(`   ${'  '.repeat(depth)}NOT PAINTED "${name}" vis=${vis} op=${op} ` +
                                `culled=${!!c._lgCulled} ${geom}`);
                        }
                        else if (depth < 6) {
                            walk(c, depth + 1);
                        }
                    }
                };
                if (actor)
                    walk(actor, 0);
            }
            const out = lines.join('\n');
            console.log(out);
            return out;
        },
        // A/B switch for the composite sub-rect across every live instance.
        compositeRect: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setCompositeRectEnabled(enabled);
                    n++;
                }
                catch (e) { }
            }
            const msg = `[Liquid Glass] composite sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        // A/B switch for the crop pass across every live instance.
        cropPass: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setCropPassEnabled(enabled);
                    n++;
                }
                catch (e) { }
            }
            const msg = `[Liquid Glass] crop pass ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        earlyExit: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setEarlyExitEnabled(enabled);
                    n++;
                }
                catch (e) { }
            }
            const msg = `[Liquid Glass] early exits ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        dump: () => {
            const rows = [];
            const now = GLib.get_monotonic_time();
            for (const fx of _liveEffects) {
                if (!fx._diagLast) {
                    rows.push(`(never painted) owner=${fx._owner ?? '?'}${fx._diagOwnerLabel ? ' label=' + fx._diagOwnerLabel : ''}`);
                    continue;
                }
                // `paints` and the snapshot's age are read live rather than taken
                // from the snapshot: with glass-debug-diagnostics off the rest of
                // _diagLast is only refreshed about once a second, and a stale paint
                // counter would break the main use of this dump — sampling it twice
                // to work out how many paints each surface costs per frame.
                // [anim-diag] Live actor state alongside the snapshot. A frozen
                // paint counter is ambiguous on its own -- minimised, culled,
                // unallocated and genuinely stuck all look the same in the numbers --
                // so record what the actor itself says at dump time.
                let live = {};
                try {
                    const a = fx.get_actor();
                    if (a) {
                        live = {
                            mapped: a.mapped,
                            visible: a.visible,
                            hasAlloc: a.has_allocation(),
                            opacity: a.opacity,
                            pos: `${Math.round(a.x)},${Math.round(a.y)}`,
                        };
                        const wa = a.get_parent();
                        if (wa) {
                            live.parentMapped = wa.mapped;
                            live.parentHasAlloc = wa.has_allocation();
                            live.parentOpacity = wa.opacity;
                            live.parentScale = `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`;
                            try {
                                const mw = wa.get_meta_window ? wa.get_meta_window() : null;
                                if (mw) {
                                    live.minimized = mw.minimized;
                                    live.wRect = (() => {
                                        const r = mw.get_frame_rect();
                                        return `${r.x},${r.y},${r.width}x${r.height}`;
                                    })();
                                }
                            }
                            catch (_) { /* not a window actor */ }
                            // [anim-stall] Is the shell's own animation still attached and
                            // running on this window actor?
                            //
                            // The capture that motivated this shows a window-close animation
                            // frozen at exactly scale 0.810 / opacity 13 -- GNOME's destroy
                            // animation targets scale 0.8 and opacity 0 -- and staying there
                            // for the rest of the run, window still mapped with a valid
                            // frame rect. Three very different faults look identical from
                            // outside, and only the transition itself tells them apart:
                            //
                            //   playing, progress stuck   the timeline is not being ticked
                            //   present, not playing      it was stopped without completing,
                            //                             so onStopped never ran and the
                            //                             shell never called completed_destroy
                            //   absent                    it finished or was removed, and the
                            //                             leftover values came from elsewhere
                            //
                            // _destroying is the shell's own set of actors whose destroy
                            // animation it believes is still in flight.
                            for (const prop of ['opacity', 'scale-x']) {
                                try {
                                    const tr = wa.get_transition(prop);
                                    if (tr) {
                                        // [anim-stall] frameClock is the field that matters.
                                        //
                                        // The capture showed playing=true with progress frozen at
                                        // 0.556 of a 150ms animation for a full minute, so the
                                        // timeline is neither finished nor stopped -- nothing is
                                        // ticking it. A frame clock holding timelines keeps itself
                                        // awake (maybe_reschedule_update() reschedules whenever
                                        // frame_clock->timelines is non-empty), so a live clock
                                        // would have advanced it. That leaves the timeline having
                                        // no clock at all:
                                        //
                                        //     update_frame_clock():
                                        //       frame_clock = clutter_actor_pick_frame_clock (actor, ...);
                                        //       ...
                                        //     out:
                                        //       set_frame_clock_internal (timeline, frame_clock);  // may be NULL
                                        //
                                        //     maybe_add_timeline():
                                        //       if (!priv->frame_clock) return;   // silently never ticked
                                        //
                                        // and pick_frame_clock() returns NULL when the actor -- and
                                        // every ancestor -- has an empty stage_views list, which is
                                        // why the view counts are recorded next to it.
                                        live[`tr_${prop}`] =
                                            `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
                                                `,dur=${tr.get_duration()}` +
                                                `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
                                    }
                                }
                                catch (_) { /* no such transition */ }
                            }
                            try {
                                live.waViews = (wa.peek_stage_views() || []).length;
                                const wg = wa.get_parent();
                                if (wg)
                                    live.wgViews = (wg.peek_stage_views() || []).length;
                                live.glassViews = (a.peek_stage_views() || []).length;
                            }
                            catch (_) { /* noop */ }
                            try {
                                const destroying = Main.wm?._destroying;
                                if (destroying)
                                    live.shellDestroying = destroying.has(wa);
                            }
                            catch (_) { /* noop */ }
                        }
                    }
                }
                catch (_) { /* noop */ }
                rows.push(JSON.stringify({
                    ...fx._diagLast,
                    label: fx._diagOwnerLabel || undefined,
                    paints: fx._diagPaintCount,
                    composited: fx._diagCompositedPaintCount,
                    blurRuns: fx._blurRuns,
                    blurSkips: fx._blurSkips,
                    snapshotAgeMs: Math.round((now - fx._diagLastSnapshotAt) / 1000),
                    ...live,
                }));
            }
            const out = rows.length ? rows.join('\n') : '(no live LiquidEffect)';
            console.log(`[Liquid Glass][dump]\n${out}`);
            return out;
        },
    };
}
export function registerGlassEffect(effect) {
    _liveEffects.add(effect);
    _registerGlassDebugHooks();
}
export function unregisterGlassEffect(effect) {
    _liveEffects.delete(effect);
    if (_liveEffects.size === 0)
        releaseFrameSerialHook();
}
