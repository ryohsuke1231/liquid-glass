"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dumpGlassState = dumpGlassState;
exports.noteStrandEntry = noteStrandEntry;
exports.setGlassRingArmed = setGlassRingArmed;
exports.isGlassRingArmed = isGlassRingArmed;
exports.startGlassRingSampler = startGlassRingSampler;
exports.stopGlassRingSampler = stopGlassRingSampler;
exports.flushGlassRing = flushGlassRing;
exports.installGlassDiagnostics = installGlassDiagnostics;
exports.removeGlassDiagnostics = removeGlassDiagnostics;
exports.registerGlass = registerGlass;
exports.unregisterGlass = unregisterGlass;
const 1 = __importDefault(require("gi://GLib"));
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const frameSync_js_1 = require("../animation/frameSync.js");
const writes_js_1 = require("../actors/writes.js");
const colors_js_1 = require("../animation/colors.js");
const allocation_js_1 = require("../actors/allocation.js");
const logging_js_1 = require("./logging.js");
const monitor_js_1 = require("./monitor.js");
// Every live glass registers here so its last frame can be inspected from
// Looking Glass through global._lgGlass (installed by enable(), removed by
// disable()).
const _liveGlasses = new Set();
// A rolling in-memory record of the application glasses, written to the
// journal only when flushed. It exists for rare animation stalls: a capture
// started after the stall is noticed misses the frames leading up to it, and
// logging continuously from the compositor thread can stall the shell itself.
// A sample is stored only when a window's line changes, and RING_MAX caps
// the memory.
const RING_MAX = 4000;
const _ring = [];
let _ringLast = new Map();

function _ringTransition(wa) {
    const trOp = wa.get_transition('opacity');
    if (!trOp)
        return '|tr=-';
    return `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
        `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`;
}

function _ringLine(glass) {
    const wa = glass.get_parent();
    if (!wa)
        return null;
    const mw = wa.get_meta_window();
    // A stranded window has the glass, the window actor and the window group
    // all waiting for an allocation, so the group's state is recorded too.
    const wg = wa.get_parent();
    const wgAllocated = wg?.has_allocation() ? 1 : 0;
    return `${glass._diagOwnerLabel || '?'}|sc=${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}` +
        `|op=${wa.opacity}|pos=${Math.round(wa.x)},${Math.round(wa.y)}` +
        `|map=${wa.mapped ? 1 : 0}|alloc=${wa.has_allocation() ? 1 : 0}` +
        `|gAlloc=${glass.has_allocation() ? 1 : 0}|gPos=${Math.round(glass.x)},${Math.round(glass.y)}` +
        `|gSize=${Math.round(glass.width)}x${Math.round(glass.height)}` +
        `|min=${mw?.minimized ? 1 : 0}` +
        `|wgAlloc=${wg ? wgAllocated : '-'}` +
        `|views=${wa.peek_stage_views().length}` +
        _ringTransition(wa);
}

function _isWindowGlass(glass) {
    return glass._owner === 'application' || glass._owner === 'desktop-menu';
}

function _ringSampleOnce() {
    const t = 1.default.get_monotonic_time();
    for (const glass of _liveGlasses) {
        if (!_isWindowGlass(glass))
            continue;
        const line = _ringLine(glass);
        if (line === null || _ringLast.get(glass) === line)
            continue;
        _ringLast.set(glass, line);
        _ring.push(`${t} ${line}`);
        if (_ring.length > RING_MAX)
            _ring.shift();
    }
}
// Whether the shell's own animation is still attached to the window actor.
// A stall at a fixed scale/opacity looks the same from outside whether the
// timeline is not being ticked (playing, progress stuck; `clock=NULL` when no
// stage view reaches the actor), was stopped early (present, not playing), or
// has already been removed (absent).

function _dumpTransitions(wa, live) {
    for (const prop of ['opacity', 'scale-x']) {
        const tr = wa.get_transition(prop);
        if (!tr)
            continue;
        live[`tr_${prop}`] =
            `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
                `,dur=${tr.get_duration()}` +
                `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
    }
}
// The window actor around a window's glass, next to the glass's own row: a
// frozen paint counter alone cannot tell minimised, unallocated and stuck
// apart.

function _dumpWindowState(glass) {
    const wa = glass.get_parent();
    if (!wa)
        return {};
    const live = {
        hasAlloc: glass.has_allocation(),
        parentMapped: wa.mapped,
        parentHasAlloc: wa.has_allocation(),
        parentOpacity: wa.opacity,
        parentScale: `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`,
        shellDestroying: Main.wm._destroying.has(wa),
    };
    const mw = wa.get_meta_window();
    if (mw) {
        live.minimized = mw.minimized;
        const r = mw.get_frame_rect();
        live.wRect = `${r.x},${r.y},${r.width}x${r.height}`;
    }
    _dumpTransitions(wa, live);
    live.waViews = wa.peek_stage_views().length;
    const wg = wa.get_parent();
    if (wg)
        live.wgViews = wg.peek_stage_views().length;
    live.glassViews = glass.peek_stage_views().length;
    return live;
}

function dumpGlassState() {
    const rows = [..._liveGlasses].map(glass => JSON.stringify({
        ...glass.describe(),
        ...(_isWindowGlass(glass) ? _dumpWindowState(glass) : {}),
    }));
    const out = rows.length ? rows.join('\n') : '(no live glass)';
    (0, logging_js_1.diagnosticLog)(`[Liquid Glass][dump]\n${out}`);
    return out;
}
// While the recorder is armed, flush it automatically the first few times a
// window actor becomes stranded. Capped, because each flush writes to the
// journal.
let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;

function noteStrandEntry(label, detail) {
    if (!_ringArmed)
        return;
    if (_autoCaptures >= AUTO_CAPTURE_LIMIT)
        return;
    _autoCaptures++;
    (0, logging_js_1.diagnosticLog)(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
        `on strand entry for "${label}" — ${detail}`);
    flushGlassRing();
}
// The recorder is off unless armed through global._lgGlass.ring(true), and
// its timer only exists while it is armed.
let _ringArmed = false;
let _ringSamplerEnabled = false;
let _ringSamplerId = 0;
let _ringSamplerInterval = 50;

function syncGlassRingSampler() {
    if (!_ringArmed || !_ringSamplerEnabled) {
        if (_ringSamplerId)
            1.default.Source.remove(_ringSamplerId);
        _ringSamplerId = 0;
    }
    else if (!_ringSamplerId) {
        _ringSamplerId = 1.default.timeout_add(1.default.PRIORITY_DEFAULT_IDLE, _ringSamplerInterval, () => {
            _ringSampleOnce();
            return 1.default.SOURCE_CONTINUE;
        });
    }
}

function setGlassRingArmed(armed) {
    _ringArmed = !!armed;
    syncGlassRingSampler();
    if (!_ringArmed) {
        _ring.length = 0;
        _ringLast = new Map();
        _autoCaptures = 0;
    }
}

function isGlassRingArmed() {
    return _ringArmed;
}
/**
 * Lets the sampler run whenever the recorder is armed. Pair with
 * stopGlassRingSampler() in disable().
 */

function startGlassRingSampler(intervalMs = 50) {
    _ringSamplerInterval = intervalMs;
    _ringSamplerEnabled = true;
    syncGlassRingSampler();
}

function stopGlassRingSampler() {
    _ringSamplerEnabled = false;
    setGlassRingArmed(false);
}
/** Writes the ring buffer out and clears it. */

function flushGlassRing() {
    if (!_ring.length) {
        (0, logging_js_1.diagnosticLog)('[Liquid Glass][ring] empty');
        return;
    }
    const t0 = parseInt(_ring[0].split(' ')[0], 10);
    const tN = parseInt(_ring[_ring.length - 1].split(' ')[0], 10);
    const lines = _ring.map(r => {
        const sp = r.indexOf(' ');
        const ms = Math.round((parseInt(r.slice(0, sp), 10) - t0) / 1000);
        return `+${String(ms).padStart(6)}ms ${r.slice(sp + 1)}`;
    });
    // Medium-sized chunks: journald truncates a very long message, and a flood
    // of small ones can block the compositor thread.
    const CHUNK = 150;
    const total = Math.ceil(lines.length / CHUNK);
    (0, logging_js_1.diagnosticLog)(`[Liquid Glass][ring] BEGIN ${lines.length} samples spanning ` +
        `${Math.round((tN - t0) / 1000)}ms in ${total} chunk(s)`);
    for (let i = 0; i < total; i++) {
        (0, logging_js_1.diagnosticLog)(`[Liquid Glass][ring] ${i + 1}/${total}\n` +
            lines.slice(i * CHUNK, (i + 1) * CHUNK).join('\n'));
    }
    (0, logging_js_1.diagnosticLog)('[Liquid Glass][ring] END');
    _ring.length = 0;
    _ringLast = new Map();
}

function report(msg) {
    (0, logging_js_1.diagnosticLog)(`[Liquid Glass] ${msg}`);
    return msg;
}

function onOff(enabled) {
    return enabled ? 'ENABLED' : 'DISABLED';
}
// Applies a setter to every live glass and returns how many it reached.

function onEveryGlass(apply) {
    for (const glass of _liveGlasses)
        apply(glass);
    return _liveGlasses.size;
}

function createDebugApi() {
    return {
        count: () => _liveGlasses.size,
        dump: () => dumpGlassState(),
        // 0 = normal, 1 = red where the shader computes the drop shadow and green
        // where it computes the glass shape, 2 = raw values.
        debugView: (mode) => report(`debug_view = ${mode} on ${onEveryGlass(fx => fx.setDebugView(mode))} instance(s)`),
        // Every tick of every per-frame sync loop does nothing while frozen, so
        // the cost of the polling itself can be measured. The glass stops
        // following anything that moves.
        freezeSync: (frozen) => {
            (0, frameSync_js_1.setFrameSyncFrozen)(frozen);
            return report(`per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`);
        },
        syncFrozen: () => (0, frameSync_js_1.isFrameSyncFrozen)(),
        // 'cross-fade' (default) dissolves through alpha so a white/black flip
        // never sits at mid-grey; 'rgb-lerp' interpolates the channels.
        textColorMode: (mode) => {
            const m = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
            (0, colors_js_1.setAdaptiveColorMode)(m);
            return report(`adaptive text color mode = ${m}`);
        },
        textColorModeName: () => (0, colors_js_1.getAdaptiveColorMode)(),
        // 'two-stage' (default) asks the window group to relayout first and only
        // then remaps the window actor; 'remap' goes straight to hide()/show();
        // 'off' never touches the window actor.
        windowRescue: (mode) => {
            (0, allocation_js_1.setWindowActorRescueMode)(mode);
            return report(`window-actor rescue = ${(0, allocation_js_1.getWindowActorRescueMode)()}`);
        },
        windowRescueMode: () => (0, allocation_js_1.getWindowActorRescueMode)(),
        ring: (on) => {
            setGlassRingArmed(on);
            return report(`ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`);
        },
        ringArmed: () => isGlassRingArmed(),
        ringFlush: () => { flushGlassRing(); return 'flushed'; },
        // Compare-then-write in the per-frame sync loops. Changes how often the
        // stage is damaged, not what is drawn.
        diffWrites: (enabled) => {
            (0, writes_js_1.setDiffWritesEnabled)(enabled);
            return report(`diff writes ${onOff(enabled)}`);
        },
        diffWritesEnabled: () => (0, writes_js_1.isDiffWritesEnabled)(),
        // The rect each glass is drawing with right now, straight from its
        // uniforms, for per-frame tracking probes.
        geom: (owner) => {
            const out = [];
            const add = (glassOwner, u) => {
                if (owner && glassOwner !== owner)
                    return;
                out.push({ owner: glassOwner, x: u.get('dock_x') ?? 0, y: u.get('dock_y') ?? 0,
                    w: u.get('dock_w') ?? 0, h: u.get('dock_h') ?? 0 });
            };
            for (const glass of _liveGlasses)
                add(glass._owner, glass.uniformValues);
            return out;
        },
        // The live glass actors themselves, for scripted checks.
        glassObjects: () => [..._liveGlasses],
        // One journal line per second with what is on screen, every shown glass's
        // work and the GPU's busy percentage (see diagnostics/monitor.ts).
        // 0 runs until monitorStop().
        monitor: (seconds = 30) => {
            (0, monitor_js_1.startGlassMonitor)(() => _liveGlasses, seconds);
            return report(`monitor running${seconds > 0 ? ` for ${seconds}s` : ''}; see journalctl -o cat | grep '[monitor]'`);
        },
        monitorStop: () => {
            (0, monitor_js_1.stopGlassMonitor)();
            return report('monitor stopped');
        },
        monitorRunning: () => (0, monitor_js_1.isGlassMonitorRunning)(),
        monitorLabel: (label) => (0, monitor_js_1.setGlassMonitorLabel)(label),
        blurRect: (enabled) => report(`blur sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setBlurRectEnabled(enabled))} instance(s)`),
        compositeRect: (enabled) => report(`composite sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setCompositeRectEnabled(enabled))} instance(s)`),
        // false = the plain four-tap pattern along the edge.
        edgeTaps: (enabled) => report(`edge footprint taps ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEdgeTapsEnabled(enabled))} instance(s)`),
        earlyExit: (enabled) => report(`early exits ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEarlyExitEnabled(enabled))} instance(s)`),
    };
}
/** Called from enable(): publishes global._lgGlass and the ring sampler. */

function installGlassDiagnostics() {
    global._lgGlass = createDebugApi();
    startGlassRingSampler(50);
}
/** Called from disable(). */

function removeGlassDiagnostics() {
    (0, monitor_js_1.stopGlassMonitor)();
    stopGlassRingSampler();
    delete global._lgGlass;
}

function registerGlass(glass) {
    _liveGlasses.add(glass);
}

function unregisterGlass(glass) {
    _liveGlasses.delete(glass);
}
