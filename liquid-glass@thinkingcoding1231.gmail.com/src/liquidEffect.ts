// src/liquidEffect.ts
//
// ─── Design overview ───────────────────────────────────────────────────────
//
//  Old implementation: subclassed Clutter.ShaderEffect and did refraction,
//          rim lighting, and shadowing all in a single glass.frag shader.
//          Blur relied solely on ShaderEffect's cogl_sampler texture
//          sampling, with no dedicated blur pass.
//
//  New implementation: subclasses Clutter.OffscreenEffect and overrides
//          vfunc_paint_target to run a custom multi-pass FBO pipeline.
//
//  Rendering pipeline (per frame):
//
//    ┌──────────────────────────────────────────────────────┐
//    │  OffscreenEffect automatically captures the actor's   │
//    │  painted content into an internal FBO                │
//    │  (retrievable via get_texture())                      │
//    └────────────────────┬─────────────────────────────────┘
//                         │ srcTex (full monitor resolution)
//                         ▼
//    ┌──────────────── Downsample ──────────────────────────┐
//    │  Pass 0: srcTex    → _blurFbos[0]  (w/2  × h/2)      │
//    │  Pass 1: _tex[0]   → _blurFbos[1]  (w/4  × h/4)      │
//    │  Pass 2: _tex[1]   → _blurFbos[2]  (w/8  × h/8)      │
//    │  Pass 3: _tex[2]   → _blurFbos[3]  (w/16 × h/16)     │
//    │  (shaders/downsample.frag – Dual Kawase, 5-tap)       │
//    └────────────────────┬─────────────────────────────────┘
//                         │
//    ┌──────────────── Upsample ────────────────────────────┐
//    │  Pass 3→2: _tex[3] → _blurFbos[2]                    │
//    │  Pass 2→1: _tex[2] → _blurFbos[1]                    │
//    │  Pass 1→0: _tex[1] → _blurFbos[0]  (w/2 × h/2)       │
//    │  (shaders/upsample.frag – Dual Kawase tent, 8-tap)    │
//    └────────────────────┬─────────────────────────────────┘
//                         │ _blurTextures[0] (blurred, w/2 × h/2)
//                         ▼
//    ┌──────────────── Glass composite ─────────────────────┐
//    │  shaders/glass.frag is parsed at runtime into a Cogl  │
//    │  snippet. cogl_sampler0 = the blurred texture.        │
//    │  Applies refraction / chromatic aberration / rim      │
//    │  lighting / shadow, then draws into screenFb (the     │
//    │  on-screen framebuffer Clutter has prepared).          │
//    └─────────────────────────────────────────────────────┘
//
//  The texture pool is rebuilt whenever the resolution changes.
//  Cogl pipelines are compiled once on the first frame and reused after that.
//
// ─────────────────────────────────────────────────────────────────────────────
//
//  RENDERING MODEL — READ THIS BEFORE CHANGING ANY DRAWING CODE
//
//  Every pass in this effect is issued as a Clutter PAINT NODE. None of it may
//  be drawn with Cogl's immediate-mode API. This is not a style preference; it
//  is the fix for a long-standing bug, and reverting it silently reintroduces
//  that bug. Four traps are involved, all of them found the hard way.
//
//  ── Trap 1: paint_target runs BEFORE the capture exists ─────────────────────
//
//  Clutter paints in two phases: it BUILDS a ClutterPaintNode tree, then
//  EXECUTES it. ClutterOffscreenEffect adds a LayerNode that renders the actor
//  into the capture texture, and that node runs in the EXECUTE phase — but
//  vfunc_paint_target() is called during the BUILD phase, when the node has
//  only been added to the tree. So at the moment paint_target runs,
//  get_texture() still holds the PREVIOUS frame's content.
//
//  Immediate-mode drawing (draw_textured_rectangle + flush) executes right
//  there, in the build phase, and therefore samples that stale capture. That
//  was the cause of the "background inside the window lags one frame behind
//  while dragging" bug. Clutter's own default paint_target implementation adds
//  nodes rather than drawing, precisely for this reason.
//
//  Drawing straight to the screen framebuffer APPEARED to work, but only by
//  accident: Cogl journals those draws and flushes them later, by which time
//  the capture has landed. It is not a guarantee. Adding a single flush()
//  after such a draw reproduced the identical one-frame lag with no
//  intermediate framebuffer involved at all — that experiment is what finally
//  identified the cause. Do not rely on it.
//
//  ── Trap 2: deferred passes cannot share a Cogl pipeline ────────────────────
//
//  With immediate drawing, "set uniforms, draw, overwrite uniforms for the
//  next pass" worked. Nodes execute after paint_target returns, so a shared
//  pipeline means every pass draws with whatever the LAST pass left behind.
//  Each pass gets its own copy via _passPipeline().
//
//  ── Trap 3: deferred passes must form an acyclic framebuffer graph ──────────
//
//  With immediate drawing, ping-ponging between framebuffers was harmless.
//  Deferred nodes make Cogl build a real dependency graph, and ping-ponging is
//  a CYCLE in it (e.g. Gaussian: temp reads blur0, then blur0 reads temp).
//  Cogl rejects the dependency with
//    "_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed"
//  and the passes lose their ordering, so the composite samples a
//  never-written blur texture. On screen: a flat tint with no background in it,
//  while rim lighting (which does not read the blur layer) still works.
//
//  Hence the separate _upTextures/_upFbos output targets: no pass ever writes
//  into a framebuffer that an earlier pass read from.
//
//  ── Trap 4: add_multitexture_rectangle() segfaults the shell ────────────────
//
//  Clutter.PaintNode.add_multitexture_rectangle() has a broken introspection
//  annotation on this stack: text_coords is exposed as a plain `number`
//  instead of an array, so passing an array makes the native side read a JS
//  object as a float pointer -> SIGSEGV. The TypeScript error it produces is
//  CORRECT and must not be silenced with a cast.
//
//  (Cogl.Framebuffer.draw_multitextured_rectangle IS annotated correctly, so
//  the two are easy to confuse.)
//
//  Consequence: all composite layers must share one UV range, which is why the
//  capture's padding is removed by a crop pass instead of by per-layer UVs.
//
// ─────────────────────────────────────────────────────────────────────────────

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Logger } from './logger.js';
import { setBmsMode, BMS_MODE, computeCaptureLayout, setFrameSyncFrozen, isFrameSyncFrozen,
  setDiffWritesEnabled, isDiffWritesEnabled,
  setCaptureClipEnabled, isCaptureClipEnabled, setCloneCullEnabled, isCloneCullEnabled,
  setCullSiteEnabled, isCullSiteEnabled,
  setAdaptiveColorMode, getAdaptiveColorMode, AdaptiveColorMode,
  setNestedGlassFix, getNestedGlassFix, NestedGlassFix,
  setFocusDebugEnabled, isFocusDebugEnabled,
  setBackgroundMirrorEnabled, isBackgroundMirrorEnabled,
  setCullOptOutEnabled, isCullOptOutEnabled,
  setWindowActorRescueMode, getWindowActorRescueMode, WindowActorRescueMode } from './utils.js';

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
const _liveEffects: Set<any> = new Set();

// ─── Frame serial ────────────────────────────────────────────────────────────
//
// [PERF] Counts painted frames, so an effect can tell "this is the first time
// I have been asked to paint this frame" from "I am being painted again".
//
// The second case is not rare — it is the dominant cost of this extension.
// A glass surface is a child of its window actor, and every OTHER glass
// surface that shows this window renders it through a Clutter.Clone, which
// repaints the whole source subtree including its effect. The dock clones
// every window; each window clones every window below it. Measured with
// dock + 3 windows, per frame:
//
//     dock              0.98 paints
//     top window        1.97
//     middle window     5.90
//     bottom window    13.78
//     ---------------------------
//     total            22.63 blur+composite chains for 4 glass surfaces
//
// Each of those re-ran the full crop -> downsample -> H -> V chain to produce
// a texture bit-identical to the one the frame's first paint had already
// produced from the very same capture. Only the composite genuinely differs
// (it draws into a different framebuffer).
//
// Incremented on the stage's 'after-paint'. Multi-monitor is handled by
// construction rather than by special-casing: the signal fires once per stage
// view, so each view's first paint re-runs the chain into that view's frame.
let _frameSerial = 0;
let _frameSerialStage: any = null;
let _frameSerialHandler = 0;

function _ensureFrameSerialHook(): boolean {
  if (_frameSerialHandler) return true;
  try {
    const stage = (globalThis as any).global?.stage;
    if (!stage) return false;
    _frameSerialStage = stage;
    _frameSerialHandler = stage.connect('after-paint', () => { _frameSerial++; });
  } catch (e) {
    _frameSerialStage = null;
    _frameSerialHandler = 0;
  }
  return _frameSerialHandler !== 0;
}

// Whether the counter is actually advancing. Load-bearing: without the hook
// _frameSerial is frozen at 0, every paint after the first would look like a
// repeat, and the blur would be computed once and then reused forever — the
// glass would freeze on whatever the first frame contained. The reuse is
// therefore gated on this rather than assuming the connect() worked.
function _frameSerialIsLive(): boolean {
  return _frameSerialHandler !== 0;
}

function _releaseFrameSerialHook(): void {
  if (!_frameSerialHandler) return;
  try { _frameSerialStage?.disconnect(_frameSerialHandler); } catch (e) { }
  _frameSerialStage = null;
  _frameSerialHandler = 0;
}

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
const _ring: string[] = [];
let _ringLast: Map<any, string> = new Map();

function _ringSampleOnce(): void {
  const t = GLib.get_monotonic_time();
  for (const fx of _liveEffects) {
    if (fx._owner !== 'application') continue;
    let line = '';
    try {
      const a: any = fx.get_actor();
      if (!a) continue;
      const wa: any = a.get_parent();
      if (!wa) continue;
      const trOp: any = wa.get_transition ? wa.get_transition('opacity') : null;
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
        `|wgAlloc=${(() => { const wg: any = wa.get_parent();
          return wg ? (wg.has_allocation() ? 1 : 0) : '-'; })()}` +
        `|views=${(wa.peek_stage_views() || []).length}` +
        (trOp
          ? `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
            `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`
          : '|tr=-');
    } catch (_) {
      continue;
    }
    if (_ringLast.get(fx) === line) continue;
    _ringLast.set(fx, line);
    _ring.push(`${t} ${line}`);
    if (_ring.length > RING_MAX) _ring.shift();
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

export function noteStrandEntry(label: string, detail: string): void {
  // Disarmed by default: nothing is sampled and nothing is written unless the
  // recorder was switched on for an investigation.
  if (!_ringArmed) return;
  if (_autoCaptures >= AUTO_CAPTURE_LIMIT) return;
  _autoCaptures++;
  console.log(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
    `on strand entry for "${label}" — ${detail}`);
  try { flushGlassRing(); } catch (e) { console.error(`[Liquid Glass][ring] ${e}`); }
}

// Off unless an investigation switches it on: a 20Hz timer that exists only
// for a fault which is now mitigated has no business running on every desktop.
// global._lgGlass.ring(true) arms it; Ctrl+Alt+L then flushes whatever it holds.
let _ringArmed = false;
let _ringSamplerEnabled = false;
let _ringSamplerId = 0;
let _ringSamplerInterval = 50;

function syncGlassRingSampler(): void {
  if (!_ringArmed || !_ringSamplerEnabled) {
    if (_ringSamplerId) GLib.Source.remove(_ringSamplerId);
    _ringSamplerId = 0;
  } else if (!_ringSamplerId) {
    _ringSamplerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, _ringSamplerInterval, () => {
      try { _ringSampleOnce(); } catch (_) { }
      return GLib.SOURCE_CONTINUE;
    });
  }
}

export function setGlassRingArmed(armed: boolean): void {
  _ringArmed = !!armed;
  syncGlassRingSampler();
  if (!_ringArmed) {
    _ring.length = 0;
    _ringLast = new Map();
    _autoCaptures = 0;
  }
}
export function isGlassRingArmed(): boolean {
  return _ringArmed;
}

export function startGlassRingSampler(intervalMs: number = 50): void {
  _ringSamplerInterval = intervalMs;
  _ringSamplerEnabled = true;
  syncGlassRingSampler();
}

export function stopGlassRingSampler(): void {
  _ringSamplerEnabled = false;
  setGlassRingArmed(false);
}

/** Writes the ring buffer out and clears it. */
export function flushGlassRing(): void {
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

function _registerGlassDebugHooks(): void {
  const g = globalThis as any;
  if (!g.global || g.global._lgGlass) return;
  g.global._lgGlass = {
    count: () => _liveEffects.size,
    // A/B switch for the glass.frag early exits across every live instance.
    // Diagnostic visualisation: 1 = red where the shader computes a drop
    // shadow, green where it computes the glass shape itself, 0 = normal.
    debugView: (mode: number) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setDebugView(mode); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] debug_view = ${mode} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    // A/B switch for how a Blur My Shell target is supplied to the glass:
    // 0 = SNAPSHOT (default), 1 = CLONE, 2 = SKIP. See BMS_MODE in utils.ts.
    bmsMode: (mode: number) => setBmsMode(mode),
    BMS_MODE,

    // A/B switch for the blurred sub-rect across every live instance.
    blurRect: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setBlurRectEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] blur sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },

    // [DIAG] Freezes every manager's per-frame sync loop. The loops keep
    // rescheduling but do no work, so what the polling itself costs can be
    // read straight off gpu_busy_percent. The glass stops following anything
    // that moves while this is on — diagnostic only.
    freezeSync: (frozen: boolean) => {
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
    textColorMode: (mode: string) => {
      const m: AdaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
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
    nestedFix: (mode: string) => {
      const m = mode as NestedGlassFix;
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
    bgMirror: (on: boolean) => {
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
    cullOptOut: (on: boolean) => {
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
    windowRescue: (mode: string) => {
      setWindowActorRescueMode(mode as WindowActorRescueMode);
      const msg = `[Liquid Glass] window-actor rescue = ${getWindowActorRescueMode()}`;
      console.log(msg);
      return msg;
    },
    windowRescueMode: () => getWindowActorRescueMode(),

    // [diag] The rolling pre-fault recorder. Off by default; arm it only when
    // chasing something, then press Ctrl+Alt+L to flush what led up to it.
    ring: (on: boolean) => {
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
    focusDebug: (on: boolean) => {
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
    diffWrites: (enabled: boolean) => {
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
    captureClip: (enabled: boolean) => {
      setCaptureClipEnabled(enabled);
      const msg = `[Liquid Glass] capture clip ${enabled ? 'ENABLED' : 'DISABLED'}`;
      console.log(msg);
      return msg;
    },
    captureClipEnabled: () => isCaptureClipEnabled(),

    // [PERF ①b] A/B switch for hiding clones that fall outside that same
    // rect. This is the one that removes nested glass paints (an invisible
    // clone never paints its source), so it is the interesting half.
    cloneCull: (enabled: boolean) => {
      setCloneCullEnabled(enabled);
      const msg = `[Liquid Glass] clone cull ${enabled ? 'ENABLED' : 'DISABLED'}`;
      console.log(msg);
      return msg;
    },
    cloneCullEnabled: () => isCloneCullEnabled(),

    // [DIAG ①b] The three cull sites, individually. Each is ANDed with
    // cloneCull above. See setCullSiteEnabled() in utils.ts.
    cullApp: (enabled: boolean) => {
      setCullSiteEnabled('app', enabled);
      const msg = `[Liquid Glass] cull site app (behind-window clones) ${enabled ? 'ON' : 'OFF'}`;
      console.log(msg);
      return msg;
    },
    cullWindows: (enabled: boolean) => {
      setCullSiteEnabled('windows', enabled);
      const msg = `[Liquid Glass] cull site windows (dock/menu window clones) ${enabled ? 'ON' : 'OFF'}`;
      console.log(msg);
      return msg;
    },
    cullUi: (enabled: boolean) => {
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
    treeReport: (maxDepth: number = 4) => {
      const lines: string[] = [];
      for (const fx of _liveEffects) {
        let actor: any = null;
        try { actor = (fx as any).get_actor?.(); } catch (e) { }
        const owner = (() => {
          try { return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)'; }
          catch (e) { return '(?)'; }
        })();
        const res = (() => { try { return (fx as any).getResolution(); } catch (e) { return [0, 0]; } })();
        lines.push(`── ${owner} res=${res[0]}x${res[1]}`);
        const walk = (a: any, depth: number) => {
          if (depth > maxDepth) return;
          let children: any[] = [];
          try { children = a.get_children(); } catch (e) { return; }
          for (const c of children) {
            let name = '(?)', vis = true, op = 255, geom = '?';
            try { name = c.get_name() || '(unnamed)'; } catch (e) { }
            try {
              vis = c.visible; op = c.opacity;
              geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                `p=(${Math.round(c.x)},${Math.round(c.y)}) size=${Math.round(c.width)}x${Math.round(c.height)}`;
            } catch (e) { }
            lines.push(`   ${'  '.repeat(depth)}${vis && op > 0 ? '   ' : 'XX '}"${name}" ` +
              `vis=${vis} op=${op} culled=${!!(c as any)._lgCulled} ${geom}`);
            walk(c, depth + 1);
          }
        };
        if (actor) walk(actor, 0);
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
      const lines: string[] = [];
      for (const fx of _liveEffects) {
        let actor: any = null;
        try { actor = (fx as any).get_actor?.(); } catch (e) { }
        const owner = (() => {
          try { return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)'; }
          catch (e) { return '(?)'; }
        })();
        const res = (() => { try { return (fx as any).getResolution(); } catch (e) { return [0, 0]; } })();
        lines.push(`── ${owner} res=${res[0]}x${res[1]} captureClip=${JSON.stringify((fx as any)._lgCaptureClip ?? null)}`);
        const walk = (a: any, depth: number) => {
          let children: any[] = [];
          try { children = a.get_children(); } catch (e) { return; }
          for (const c of children) {
            let name = '(?)', vis = true, op = 255;
            try { name = c.get_name() || `(${c.constructor?.name ?? 'actor'})`; } catch (e) { }
            try { vis = c.visible; op = c.opacity; } catch (e) { }
            if (!vis || op === 0) {
              let geom = '?';
              try {
                geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                  `size=${Math.round(c.width)}x${Math.round(c.height)}`;
              } catch (e) { }
              lines.push(`   ${'  '.repeat(depth)}NOT PAINTED "${name}" vis=${vis} op=${op} ` +
                `culled=${!!(c as any)._lgCulled} ${geom}`);
            } else if (depth < 6) {
              walk(c, depth + 1);
            }
          }
        };
        if (actor) walk(actor, 0);
      }
      const out = lines.join('\n');
      console.log(out);
      return out;
    },

    // A/B switch for the composite sub-rect across every live instance.
    compositeRect: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setCompositeRectEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] composite sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },

    // A/B switch for the crop pass across every live instance.
    cropPass: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setCropPassEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] crop pass ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    earlyExit: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setEarlyExitEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] early exits ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    dump: () => {
      const rows: string[] = [];
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
        let live: any = {};
        try {
          const a: any = fx.get_actor();
          if (a) {
            live = {
              mapped: a.mapped,
              visible: a.visible,
              hasAlloc: a.has_allocation(),
              opacity: a.opacity,
              pos: `${Math.round(a.x)},${Math.round(a.y)}`,
            };
            const wa: any = a.get_parent();
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
              } catch (_) { /* not a window actor */ }

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
                  const tr: any = wa.get_transition(prop);
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
                } catch (_) { /* no such transition */ }
              }
              try {
                live.waViews = (wa.peek_stage_views() || []).length;
                const wg: any = wa.get_parent();
                if (wg) live.wgViews = (wg.peek_stage_views() || []).length;
                live.glassViews = (a.peek_stage_views() || []).length;
              } catch (_) { /* noop */ }
              try {
                const destroying: any = (Main as any).wm?._destroying;
                if (destroying) live.shellDestroying = destroying.has(wa);
              } catch (_) { /* noop */ }
            }
          }
        } catch (_) { /* noop */ }

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


// ─── Type helpers ───────────────────────────────────────────────────────────
// In GJS, Cogl.Offscreen inherits from Cogl.Framebuffer, but TypeScript's
// type definitions sometimes require an explicit cast to see that.
type CoglFB = Cogl.Framebuffer;

interface LiquidEffectParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  logger?: Logger;
  /**
   * Which manager owns this effect ('dock', 'menu', 'notification', 'osd',
   * 'quick-settings', 'quick-settings-toggles', 'application'). Diagnostic
   * only. Without it every popup surface shows up in global._lgGlass.dump()
   * as the same actor name, "liquid-box", and telling the dock's instance
   * apart from a menu's needs cross-referencing creation timestamps in the
   * log — which is exactly the step that made the first round of paint-rate
   * analysis ambiguous.
   */
  owner?: string;
  [key: string]: any; // spread into super._init(params)
}

// ─── Parsed shader source ───────────────────────────────────────────────────
interface ShaderSnippet {
  /** Everything before void main() (uniform declarations / helper functions) */
  decl: string;
  /** The body of void main(), with the surrounding braces stripped */
  body: string;
}

// ─── Blur method ─────────────────────────────────────────────────────────────
// 0: Separable Gaussian blur (shader source generated dynamically on the TS side)
// 1: Dual Kawase blur (downsample.frag + upsample.frag) — the original implementation
type BlurMethod = 0 | 1;

// ─── Dynamic Gaussian kernel ─────────────────────────────────────────────────
// A 1D Gaussian kernel optimized for linear-sampling ("bilinear tap merging").
//   offsets[0] / weights[0] is the center sample (offset is always 0).
//   offsets[i] / weights[i] for i >= 1 is the combined offset/weight for a
//   symmetric left-right (or up-down) pair of taps merged into one fetch.
// Number of texture fetches = 1 (center) + 2 * (offsets.length - 1) (side pairs).
interface GaussianKernel {
  offsets: number[];
  weights: number[];
}

// ─── Main class ───────────────────────────────────────────────────────────────

export const LiquidEffect = GObject.registerClass({
  GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {

  // Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
  static MAX_GLASS_REGIONS = 16;

  // ─── Private fields ────────────────────────────────────────────────────────

  declare private _extensionPath: string | undefined;
  // Diagnostic label naming the owning manager; see LiquidEffectParams.owner.
  declare private _owner: string;
  // [anim-diag] Human-readable identity of what this glass belongs to (a
  // window title, usually), set by the owning manager. The dump had no way to
  // tell two glasses apart: five 'application' rows with only a size to go on
  // meant "is this the same instance resized, or a second one?" could not be
  // answered from a log, which is exactly the question the animation and
  // leftover-glass reports turn on.
  declare _diagOwnerLabel: string;
  declare private _settings: Gio.Settings | undefined;
  declare private _settingsIds: number[];
  declare private _logger: Logger | undefined;

  // ── Blur texture pool ──
  // Index 0 = w/2 × h/2 (first half-res level)
  // Index N = w/(2^(N+1)) × h/(2^(N+1))
  declare private _blurTextures: Cogl.Texture2D[];
  declare private _blurFbos: Cogl.Offscreen[];

  // ── Intermediate buffers for the Gaussian blur ──
  // Holds the output of the horizontal pass (same resolution as _blurTextures
  // at the corresponding index).
  declare private _gaussianTempTextures: Cogl.Texture2D[];
  declare private _gaussianTempFbos: Cogl.Offscreen[];

  // [FIX round 12] Dedicated output targets, one per pool level, so no pass
  // ever writes into a framebuffer that an earlier pass read from.
  //
  // Immediate-mode drawing let the passes ping-pong freely: each pass ran and
  // flushed on the spot, so reusing _blurFbos[i] as both a downsample target
  // and an upsample target was harmless. Deferred paint nodes make Cogl build
  // a real dependency graph between framebuffers, and that ping-pong is a
  // CYCLE in it (_blurFbos[0] reads the Gaussian temp buffer while the temp
  // buffer reads _blurFbos[0]; adjacent Kawase levels do the same). Cogl
  // detects the cycle, refuses the dependency
  // ("_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed")
  // and the passes lose their ordering, so the composite samples an
  // never-written blur texture — which is exactly the flat tint with no
  // background in it, while the rim lighting (which does not read the blur
  // layer) kept working.
  //
  // Writing upsample/vertical output into separate targets makes the pass
  // graph a strict DAG. Costs one extra half-resolution texture per level.
  declare private _upTextures: Cogl.Texture2D[];
  declare private _upFbos: Cogl.Offscreen[];

  // The texture holding the finished blur for this frame; set by whichever
  // blur runner executed, read by the composite.
  declare private _blurResultTex: Cogl.Texture | null;

  // ── Compiled pipelines, reused across frames ──
  // Dual Kawase
  declare private _downsamplePipeline: Cogl.Pipeline | null;
  declare private _upsamplePipeline: Cogl.Pipeline | null;
  // Separable Gaussian
  declare private _gaussianHPipeline: Cogl.Pipeline | null; // horizontal pass
  declare private _gaussianVPipeline: Cogl.Pipeline | null; // vertical pass
  declare private _compositePipeline: Cogl.Pipeline | null;
  // [PERF] Plain 1-tap resample. Two passes only ever needed a straight copy
  // with a UV remap — the crop, and the Gaussian's half-res pre-pass — and
  // both got it by running downsample.frag with blur_radius = 0, which
  // collapses that shader's 5-tap Kawase kernel onto the center sample. The
  // maths is right but the cost is not: the four collapsed taps still issue
  // four texture fetches at the same coordinate. A pipeline with no fragment
  // snippet at all does exactly one fetch — Cogl's default layer combine for
  // layer 0 is MODULATE(pipeline color, texture), and the pipeline color is
  // opaque white — so it is the same passthrough for a quarter of the
  // bandwidth. The crop pass runs at FULL resolution, so this is the larger
  // of the two savings.
  declare private _passthroughPipeline: Cogl.Pipeline | null;
  // [PERF] Exact 4x4 box filter, used as the first pass when
  // glass-blur-downscale is 4. See _initPipelines().
  declare private _boxDownPipeline: Cogl.Pipeline | null;

  // ── Active blur method (0: Gaussian, 1: Dual Kawase) ──
  declare private _blurMethod: BlurMethod;

  // ── State for dynamic Gaussian shader generation ──
  // The kernel currently compiled into the H/V pipelines (its tap count
  // determines the shader's structure).
  declare private _gaussianKernel: GaussianKernel | null;
  // A kernel waiting to be compiled; picked up safely inside vfunc_paint_target.
  declare private _pendingGaussianKernel: GaussianKernel | null;
  // While true, the Gaussian H/V pipelines will be recompiled on the next paint.
  declare private _gaussianPipelineDirty: boolean;
  // The sigma (in half-res texels) that the currently compiled kernel targets.
  // Small changes in radius that don't change the tap count are absorbed via
  // the kernel_scale ratio below instead of triggering a recompile.
  declare private _gaussianBaseSigma: number;
  // kernel_scale uniform sent to the shader (= current sigma / _gaussianBaseSigma).
  declare private _gaussianScale: number;
  // Number of fetch pairs in the currently compiled (or pending) kernel.
  declare private _gaussianFetchPairs: number;

  // ── Uniform location cache for the composite pipeline ──
  declare private _compUniforms: Map<string, number>;

  // ── Uniforms set before the pipeline existed, applied once it's created ──
  declare private _pendingUniforms: Map<string, number>;

  // ── Same as above, but for array uniforms (region_x[], region_tint_r[], etc.) ──
  declare private _compUniformArrays: Map<string, number>;
  declare private _pendingUniformArrays: Map<string, number[]>;

  // [PERF] What is ACTUALLY sitting in the composite pipeline right now, as
  // opposed to _pendingUniforms (the authoritative buffered state, which has
  // to stay complete so a freshly compiled pipeline can be seeded from it).
  //
  // _applyPendingUniforms() runs on every paint and used to push all ~60
  // scalars plus 8 sixteen-element arrays into Cogl unconditionally, even
  // though a steady-state frame changes none of them. Two costs came out of
  // that: Cogl re-hashing the pipeline's uniform state, and — larger in
  // practice — one throwaway JS array per call from
  // `set_uniform_float(loc, 1, 1, [value])`. With paint running twice per
  // frame per instance (measured), that was several thousand short-lived
  // allocations per second feeding a GC that runs on the compositor thread.
  //
  // Cleared whenever the pipeline object is replaced, since a new pipeline
  // starts with none of these values.
  declare private _appliedUniforms: Map<string, number>;
  declare private _appliedUniformArrays: Map<string, number[]>;

  // [PERF] Set by _setFloat()/_setFloatArray() whenever a value they were
  // handed actually differs from what is already buffered, and cleared by
  // _queueRepaintIfDirty(). This is what lets the uniform setters stop
  // requesting a repaint unconditionally.
  //
  // Why that is safe: queue_repaint() exists for "the actor's content is
  // unchanged but MY parameters changed". The opposite case — the content
  // behind the glass changed — never went through it. A damaged source
  // window queues a redraw, Clutter.Clone forwards it from the source's
  // queue-redraw signal, it propagates up to bgActor, and Clutter re-runs
  // the whole effect with CLUTTER_EFFECT_PAINT_ACTOR_DIRTY. So dropping the
  // unconditional call loses nothing except the repaints nobody asked for.
  //
  // Measured before this change: dock 0.99 paints/frame (already damage
  // driven, because dockManager only touches geometry when it moves), but
  // every application window well above 1.0 — applicationManager's
  // per-frame _syncState() called setResolution()/setGlassGeometry() with
  // identical values every single frame and each one queued a repaint.
  declare private _uniformsDirty: boolean;

  // Reused scratch buffer for the 1-component set_uniform_float() calls, so
  // the common path allocates nothing at all. Cogl copies the values out
  // during the call, so handing it the same array every time is safe.
  declare private _uniformScratch: number[];

  // ── Crop texture pool ── see the crop pass section below.
  declare private _cropTexture: Cogl.Texture2D | null;
  declare private _cropFbo: Cogl.Offscreen | null;
  declare private _cropPoolW: number;
  declare private _cropPoolH: number;
  // Per-instance override of LiquidEffect.USE_CROP_PASS.
  declare private _cropPassEnabled: boolean;

  // [DIAG] Last frame's resolved pipeline state, dumped by global._lgGlass.
  declare private _diagLast: any;

  declare private _poolWidth: number;
  declare private _poolHeight: number;

  // ── [PERF] Blurred sub-rect ────────────────────────────────────────────
  // The glass geometry the shader was last told about, kept so the paint
  // path can work out which part of the actor actually needs blurring.
  // Same coordinate space as setResolution()/setGlassGeometry().
  declare private _glassRect: number[];            // [x, y, w, h]
  declare private _regionRects: number[][];        // multi-region mode
  declare private _multiRegion: boolean;
  // The rect handed to the blur chain on the last paint, in that same
  // space, or null when the whole actor is blurred (the old behavior).
  declare private _blurRect: number[] | null;
  // The rect the blur result currently in _blurResultTex was actually
  // produced with, so a reuse can tell whether it still describes it.
  declare private _blurRectUsed: number[] | null;
  // Per-instance override of LiquidEffect.USE_BLUR_RECT.
  declare private _blurRectEnabled: boolean;
  // The composite quad's sub-rect on the last paint, or null for the whole
  // actor. Diagnostics only; see _computeCompositeRect().
  declare private _compositeRect: number[] | null;
  // Per-instance override of LiquidEffect.USE_COMPOSITE_RECT.
  declare private _compositeRectEnabled: boolean;
  // glass-blur-downscale: 2 = half resolution (default), 4 = quarter.
  declare private _blurDownscale: number;

  // Number of blur passes. Each direction runs PASS_COUNT passes.
  // With 4: 1/2 → 1/4 → 1/8 → 1/16 → (turnaround) → 1/8 → 1/4 → 1/2
  declare private PASS_COUNT: number;

  // Blur radius, forwarded to the down/upsample shaders' blur_radius uniform.
  // Any real number >= 0.5; larger values produce a stronger blur.
  // Default for downsample is 0.5 (the original Kawase value), default for
  // upsample is 1.0 (the original tent-filter value).
  declare private _blurRadiusDown: number;
  declare private _blurRadiusUp: number;

  // The last radius requested by the caller (before method-specific mapping).
  declare private _targetRadius: number;

  // ── Shader Sources ──
  declare private _downsampleSource: string | null;
  declare private _upsampleSource: string | null;
  declare private _glassSource: string | null;
  declare private _shadersLoaded: boolean;

  // ── [DIAG] Black-background investigation ──
  // Tracks whether/how often vfunc_paint_target actually gets invoked by
  // Clutter for this instance, and whether it ever renders a frame that
  // doesn't fall back to super.vfunc_paint_target() (i.e. an actual glass
  // composite). If this instance's window is showing the black-background
  // bug and _diagPaintCount never advances (or never reaches "composited"),
  // that's direct evidence Clutter is skipping/culling this actor's paint
  // entirely rather than the content being wrong.
  declare private _diagPaintCount: number;
  declare private _diagCompositedPaintCount: number;
  declare private _diagLastPaintLogAt: number;
  declare private _diagFirstPaintLogged: boolean;

  // [PERF] Mirrors the glass-debug-diagnostics GSettings key. Everything the
  // block above describes used to run unconditionally on every paint,
  // including a closure that walked get_actor().get_meta_window().get_title()
  // for a string that is thrown away unless logging is on, and a fresh
  // _diagLast object built with .map()/.toFixed(). That is per paint, per
  // glass surface, and paint runs more than once per frame per surface.
  //
  // Kept separate from output-logs on purpose: someone turning logging on to
  // read a message should not silently take on per-paint diagnostic work.
  declare private _diagEnabled: boolean;

  // Wall-clock of the last _diagLast refresh, so global._lgGlass.dump() still
  // reports something useful (about a second stale) with diagnostics off.
  declare private _diagLastSnapshotAt: number;

  // [PERF] Frame serial of the paint that last ran this instance's blur chain.
  // A paint carrying the same serial is a repeat within one frame — see the
  // _frameSerial comment above.
  //
  // Keying on the serial ALONE is deliberate. An earlier attempt also compared
  // the paint context's framebuffer, on the theory that a nested clone paint
  // would share the real paint's framebuffer; it does not, and that mistake
  // silently disabled the whole optimization (measured: blurSkips 0 across the
  // board). ClutterActorNode's draw handler calls clutter_actor_continue_paint()
  // during the EXECUTION phase, by which point the enclosing LayerNode has
  // pushed its offscreen — so a nested paint sees that offscreen, not the
  // stage view's framebuffer.
  //
  // That same fact gives the reuse its ordering guarantee, and it is stronger
  // than "clones paint after their source": the stage's node tree is BUILT
  // completely and only then executed, and an effect's own paint_target runs
  // during the build. So within one stage paint every real paint_target
  // happens before every nested one, and the pool is always written before a
  // repeat reads it.
  declare private _blurFrameSerial: number;
  // Diagnostics: how many chains were skipped, and how many paints asked.
  declare private _blurRuns: number;
  declare private _blurSkips: number;

  // Bumped every time Clutter re-renders this effect's offscreen, i.e. every
  // time the capture actually changes rather than being blitted from cache.
  //
  // This is the signal the nested-glass repair needs. A glass whose capture
  // contains a clone of a window that owns a glass of its own gets its
  // capture blanked at the moment that INNER effect re-renders its own
  // offscreen — measured 2026-09-16: a static inner glass never triggers it
  // (0/14 black frames), an inner glass that keeps re-rendering does
  // (11/14), and once blanked the outer capture stays blank until something
  // marks the outer actor dirty again. Counting re-renders here is what lets
  // ApplicationManager notice an inner re-render and repair the outer.
  declare private _recaptureSerial: number;


  // Per-pass pipeline copies. See _passPipeline() for why a shared pipeline
  // cannot work now that the passes are deferred paint nodes.
  declare private _passPipelines: Map<string, { base: Cogl.Pipeline, copy: Cogl.Pipeline }>;

  // Latch so the "composite layers disagree on UV range" warning is logged at
  // most once; see _addCompositeNode().
  declare private _uvMismatchWarned: boolean;

  // ─── _init ──────────────────────────────────────────────────────────────────

  _init(params: LiquidEffectParams) {
    const extensionPath = params.extensionPath;
    const settings = params.settings;
    const logger = params.logger;
    const owner = params.owner;
    delete params.extensionPath;
    delete params.settings;
    delete params.logger;
    delete params.owner;

    super._init(params);

    this._owner = owner ?? '?';
    this._diagOwnerLabel = '';

    this._blurTextures = [];
    this._blurFbos = [];
    this._gaussianTempTextures = [];
    this._gaussianTempFbos = [];
    this._upTextures = [];
    this._upFbos = [];
    this._blurResultTex = null;
    this._downsamplePipeline = null;
    this._upsamplePipeline = null;
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._compositePipeline = null;
    this._passthroughPipeline = null;
    this._boxDownPipeline = null;
    this._compUniforms = new Map();
    this._pendingUniforms = new Map();
    this._compUniformArrays = new Map();
    this._pendingUniformArrays = new Map();
    this._appliedUniforms = new Map();
    this._appliedUniformArrays = new Map();
    this._uniformScratch = [0];
    this._uniformsDirty = false;
    this._poolWidth = 0;
    this._poolHeight = 0;

    this.PASS_COUNT = 4;
    this._blurRadiusDown = 0.5;
    this._blurRadiusUp = 1.0;
    this._blurMethod = 1; // default: Dual Kawase
    this._targetRadius = 15.0;

    this._gaussianKernel = null;
    this._pendingGaussianKernel = null;
    this._gaussianPipelineDirty = false;
    this._gaussianBaseSigma = 0;
    this._gaussianScale = 1.0;
    this._gaussianFetchPairs = 0;


    this._downsampleSource = null;
    this._upsampleSource = null;
    this._glassSource = null;
    this._shadersLoaded = false;
    this._diagPaintCount = 0;
    this._diagLast = null;
    _liveEffects.add(this);
    _registerGlassDebugHooks();
    this._diagCompositedPaintCount = 0;
    this._diagLastPaintLogAt = 0;
    this._diagEnabled = false;
    this._diagLastSnapshotAt = 0;
    this._blurFrameSerial = -1;
    this._cropTexture = null;
    this._cropFbo = null;
    this._cropPoolW = 0;
    this._cropPoolH = 0;
    this._cropPassEnabled = LiquidEffect.USE_CROP_PASS;
    this._glassRect = [0, 0, 0, 0];
    this._regionRects = [];
    this._multiRegion = false;
    this._blurRect = null;
    this._blurRectUsed = null;
    this._blurRectEnabled = LiquidEffect.USE_BLUR_RECT;
    this._compositeRect = null;
    this._compositeRectEnabled = LiquidEffect.USE_COMPOSITE_RECT;
    this._blurDownscale = 2;
    this._blurRuns = 0;
    this._blurSkips = 0;
    this._recaptureSerial = 0;
    _ensureFrameSerialHook();
    this._uvMismatchWarned = false;
    this._passPipelines = new Map();
    this._diagFirstPaintLogged = false;
    this._passPipelines = new Map();
    this._uvMismatchWarned = false;

    this._extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;

    // ── Default values for the composite shader's uniforms ──
    // The pipeline doesn't exist yet at this point, so these are buffered
    // into _pendingUniforms and applied once the pipeline is created.

    this._setFloat('resolution_x', 0.0);
    this._setFloat('resolution_y', 0.0);
    this._setFloat('pointer_x', -100.0);
    this._setFloat('pointer_y', -100.0);
    this._setFloat('intensity', 0.0);
    this._setFloat('corner_radius', 60.0);
    this._setFloat('brightness', 1.0);
    this._setFloat('contrast', 1.0);
    this._setFloat('saturation', 1.0);
    this._setFloat('padding', 20.0);
    // Distinct from the small optical 'padding' uniform (20px, only
    // meant to give the refraction/blur shader room past the actor's strict
    // bounds). shadow_max_radius instead reflects how much room the drop
    // shadow actually has to render outward before it would run into the
    // bgActor's own clip in dockManager.ts (CLIP_PADDING). Previously the
    // shader reused 'padding' for this, capping shadow_radius at ~18px no
    // matter how high the 0-100 prefs.js slider was set. Overwritten by
    // setShadowMaxRadius() once dockManager starts syncing geometry; this
    // default only matters before the first sync.
    this._setFloat('shadow_max_radius', 180.0);
    this._setFloat('isDock', 0.0);
    // Rim/specular/sheen "glass surface glint" terms, gated together by
    // setSurfaceLightEnabled(). Defaults to enabled (1.0) so dock/menu/
    // notification/quick-settings/osd — which never call the setter — keep
    // their existing look unchanged. applicationManager.ts turns this off
    // for application windows, which should only show the outer drop
    // shadow and the inner AO darkening (both already independent of this
    // uniform — see the addedLight gating in glass.frag), not the
    // dock-style rim/specular/sheen highlight.
    this._setFloat('surface_light_enabled', 1.0);

    // Full-screen FBO mode: lets the shader know where the dock sits.
    this._setFloat('dock_x', 0.0);
    this._setFloat('dock_y', 0.0);
    this._setFloat('dock_w', 0.0);
    this._setFloat('dock_h', 0.0);

    // Multi-region compositing (Quick Settings "Toggles" apply-to mode).
    // Disabled by default so every other consumer (dock, menu, notification,
    // OSD, application, and Quick Settings' own "Background" mode) is
    // completely unaffected. See setMultiRegionMode()/setGlassRegions().
    this._setFloat('multi_region_mode', 0.0);
    this._setFloat('region_count', 0.0);

    // [PERF/DEBUG] An unset Cogl uniform reads 0.0, which would turn the two
    // early exits in glass.frag OFF. Seed it explicitly; global._lgGlass
    // .earlyExit(false) is the A/B switch.
    this._setFloat('early_exit_enabled', 1.0);
    this._setFloat('debug_view', 0.0);

    // [PERF] "Blur the whole actor" until the paint path computes a real
    // rect — see glass.frag's blur_rect_* uniforms.
    this._setFloat('blur_rect_x', 0.0);
    this._setFloat('blur_rect_y', 0.0);
    this._setFloat('blur_rect_w', 0.0);
    this._setFloat('blur_rect_h', 0.0);

    this._settingsIds = [];
    if (this._settings) {
      this._bindSettings();
    } else {
      // Fallback defaults used when no GSettings schema is available.
      this._setFloat('max_z', 25.0);
      this._setFloat('displacement_scale', 78.5);
      this._setFloat('edge_smoothing', 2.0);
      this._setFloat('profile_shape_n', 7.0);
      this._setFloat('ior', 2.40);
      this._setFloat('chroma_strength', 0.006);
      this._setFloat('specular_intensity', 0.0);
      this._setFloat('shininess', 42.0);
      this._setFloat('rim_width', 5.0);
      this._setFloat('rim_intensity', 0.6);
      this._setFloat('rim_directional_power', 2.7);
      this._setFloat('rim_power', 6.0);
      this._setFloat('rim_light_color_intensity', 1.4);
      this._setFloat('sheen_intensity', 0.32);
      this._setFloat('light_angle_deg', 0.0);
      this._setFloat('shadow_radius', 8.0);
      this._setFloat('shadow_intensity', 0.55);
      // Inner edge AO darkening (independent of rim_width/shadow_radius).
      // ~7.5px matches the old rim_width*1.5-derived falloff at the default
      // rim_width of 5.0, so the look is unchanged until the user retunes it.
      this._setFloat('ao_intensity', 0.25);
      this._setFloat('ao_radius', 7.5);
      this._setFloat('tint_strength', 0.0);
      this._setFloat('tint_r', 1.0);
      this._setFloat('tint_g', 1.0);
      this._setFloat('tint_b', 1.0);
    }
    this._loadAllShadersAsync();
  }

  /**
  * Load all shader files asynchronously.
  */
  private async _loadAllShadersAsync(): Promise<void> {
    // [DIAG] Black-background investigation: each LiquidEffect instance loads
    // its own copy of the 3 shader files independently (no cross-instance
    // cache), so a brand-new window's glass literally cannot render until
    // this completes. Log start/duration to see how long this actually takes
    // relative to the window's own open animation, and to correlate with the
    // applicationManager diag logs (search for "[Liquid Glass][diag]").
    const diagStart = GLib.get_monotonic_time();
    this._logger?.log(`[Liquid Glass][diag] LiquidEffect: starting async shader load at t=${diagStart}us ` +
      `(extensionPath=${this._extensionPath})`);
    try {
      this._downsampleSource = await this._readFileAsync(`${this._extensionPath}/shaders/downsample.frag`);
      this._upsampleSource = await this._readFileAsync(`${this._extensionPath}/shaders/upsample.frag`);
      this._glassSource = await this._readFileAsync(`${this._extensionPath}/shaders/glass.frag`);

      this._shadersLoaded = true;

      const elapsedMs = (GLib.get_monotonic_time() - diagStart) / 1000;
      this._logger?.log(`[Liquid Glass][diag] LiquidEffect: async shader load finished in ${elapsedMs.toFixed(1)}ms, ` +
        `calling queue_repaint() now. If the on-screen black-background bug is still visible ` +
        `after this point, the shader load itself is not the (sole) cause -- the issue is in ` +
        `getting this repaint request actually flushed to the display.`);

      // 読み込み完了後に再描画をリクエストし、パイプラインを初期化させる
      this.queue_repaint();
      const actor = this.get_actor();
      actor?.queue_redraw();
      actor?.get_parent()?.queue_redraw();
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to load shaders asynchronously: ${e}`);
    }
  }

  /**
  * Gio.File を使ってファイルを非同期で読み込み、文字列として返すPromise関数
  */
  private _readFileAsync(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = Gio.File.new_for_path(path);
      file.load_contents_async(null, (_, res) => {
        try {
          const [ok, bytes] = file.load_contents_finish(res);
          if (!ok) {
            reject(new Error(`load_contents_finish returned false for ${path}`));
          } else {
            resolve(new TextDecoder('utf-8').decode(bytes));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // ─── Pipeline initialization (deferred until the first frame, once a Cogl context exists) ──

  /**
   * Compiles and caches the downsample / upsample / composite Cogl.Pipeline
   * objects. Call only once.
   */
  private _initPipelines(ctx: Cogl.Context): void {
    // ── Downsample pipeline ──────────────────────────────────────────────────
    this._downsamplePipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._downsamplePipeline, 0);

    if (this._downsampleSource) {
      const downSnippet = this._splitShader(this._downsampleSource);
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, downSnippet.decl, null);
      s.set_replace(downSnippet.body);
      this._downsamplePipeline.add_snippet(s);
    }

    // ── Upsample pipeline ────────────────────────────────────────────────────
    this._upsamplePipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._upsamplePipeline, 0);

    if (this._upsampleSource) {
      const upSnippet = this._splitShader(this._upsampleSource);
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, upSnippet.decl, null);
      s.set_replace(upSnippet.body);
      this._upsamplePipeline.add_snippet(s);
    }
    // ── Passthrough pipeline ─────────────────────────────────────────────────
    // Deliberately has NO fragment snippet: Cogl's default processing for a
    // pipeline with one layer is a single texture fetch modulated by the
    // pipeline color (opaque white by default), i.e. exactly a 1-tap copy.
    // Used by the crop pass and the Gaussian pre-pass; see the field comment.
    this._passthroughPipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._passthroughPipeline, 0);

    // ── 4x4 box downsample pipeline ─────────────────────────────────────────
    // [PERF] The correct minification filter for a 4x reduction, used as the
    // first blur pass when glass-blur-downscale is 4.
    //
    // Why not the passthrough (which IS correct at 2x): a destination texel
    // covers a 4x4 source block, and one bilinear fetch at its centre averages
    // only the inner 2x2 — it point-samples one texel in four and aliases hard
    // on text and on anything moving.
    //
    // Why not downsample.frag: its kernel is centre*4 + four corners, all /8,
    // which leaves the inner 2x2 weighted five times as heavily as the outer
    // ring — better than one tap, still not flat.
    //
    // These four taps land exactly on source texel corners (the destination
    // texel centre maps to source position 4i+2, and +-1 from there is 4i+1 /
    // 4i+3), so each bilinear fetch averages one 2x2 quadrant and the four
    // quadrants tile the 4x4 block with equal weight — a true box filter, in
    // four fetches instead of five.
    this._boxDownPipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._boxDownPipeline, 0);
    {
      const boxSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        'uniform vec2 inv_size;\n', null);
      boxSnip.set_replace(
        'vec2 uv = cogl_tex_coord_in[0].st;\n' +
        'vec4 c  = texture2D(cogl_sampler0, uv + vec2( 1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2( 1.0, -1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0, -1.0) * inv_size);\n' +
        'cogl_color_out = c * 0.25;\n');
      this._boxDownPipeline.add_snippet(boxSnip);
    }

    // ── Gaussian H/V pipelines ───────────────────────────────────────────────
    // Not precompiled here: the separable Gaussian blur builds its shader
    // source dynamically from the kernel computed in setBlurRadius(), and
    // _compileGaussianPipelines() compiles it lazily inside
    // vfunc_paint_target (see _computeGaussianKernel / _buildGaussianSnippet).

    // ── Composite pipeline (glass.frag) ──────────────────────────────────────
    this._compositePipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._compositePipeline, 0);

    // Standard premultiplied-alpha blending, equivalent to ShaderEffect's default:
    // "src.rgb + dst.rgb * (1 - src.a)"
    this._compositePipeline.set_blend(
      'RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
    );

    this._loadCompositeShader();

    // Apply any uniforms that were buffered before the pipeline existed.
    // The pipeline is brand new, so nothing has been written to it yet — drop
    // the "already applied" bookkeeping so _applyUniform() cannot skip a
    // value on the belief that it is still in there.
    this._appliedUniforms.clear();
    this._appliedUniformArrays.clear();
    this._applyPendingUniforms();
  }

  /**
   * Shared helper: sets bilinear filtering and clamp-to-edge wrapping on
   * layer 0 of a pipeline.
   */
  private _configureSamplerLayer(pipeline: Cogl.Pipeline, layer: number): void {
    pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    pipeline.set_layer_filters(
      layer,
      Cogl.PipelineFilter.LINEAR,     // minification
      Cogl.PipelineFilter.LINEAR      // magnification
    );
  }

  /**
   * Splits a GLSL source string into { decl, body } at the "void main()" boundary.
   */
  private _splitShader(src: string): ShaderSnippet {
    const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
    if (!match || match.index === undefined) {
      this._logger?.warn('[Liquid Glass] void main() not found; treating entire source as decl.');
      return { decl: src, body: '' };
    }

    const decl = src.substring(0, match.index);
    const rest = src.substring(match.index + match[0].length);

    // Find the matching closing brace.
    let depth = 1;
    let bodyEnd = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }

    return { decl, body: rest.substring(0, bodyEnd) };
  }

  /**
   * Loads glass.frag, rewrites its "cogl_sampler" (the uniform name used by
   * the old ShaderEffect) to "cogl_sampler0" (the name Cogl auto-declares for
   * a FRAGMENT-hook layer 0), and adds it to the composite pipeline as a
   * snippet.
   *
   * The original "uniform sampler2D cogl_sampler;" declaration is stripped
   * since cogl_sampler0 is already declared automatically by Cogl.
   */
  private _loadCompositeShader(): void {
    if (!this._compositePipeline || !this._glassSource) return;

    let { decl, body } = this._splitShader(this._glassSource);

    // Rewrite the ShaderEffect-style sampler name to the FRAGMENT-hook name.
    decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
    body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');

    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, null);
    snippet.set_replace(body);
    this._compositePipeline.add_snippet(snippet);
  }

  // ─── Dynamic Gaussian kernel computation / shader generation ────────────────

  /**
   * Computes a linear-sampling-optimized 1D Gaussian kernel from a standard
   * deviation (sigma, in half-res texels) and a target number of fetch pairs.
   *
   * Method:
   *   1. Compute discrete Gaussian weights for i = 0..(fetchPairs*2) and normalize.
   *   2. i = 0 (the center) stays a single, standalone sample.
   *   3. Merge each (i, i+1) pair into a single fetch (bilinear-tap merging):
   *        combined weight  = w(i) + w(i+1)
   *        combined offset  = (i * w(i) + (i+1) * w(i+1)) / combined weight
   *
   * For a fixed fetchPairs, the resulting offsets/weights (and therefore the
   * shader's structure) are deterministic. As long as fetchPairs doesn't
   * change, sigma changes only need to update the kernel_scale uniform — see
   * setBlurRadius() — without any shader recompilation.
   */
  private _computeGaussianKernel(sigma: number, fetchPairs: number): GaussianKernel {
    const sideTaps = Math.max(2, fetchPairs * 2);

    // Compute and normalize discrete Gaussian weights for i = 0..sideTaps.
    const raw: number[] = [];
    let sum = 0;
    for (let i = 0; i <= sideTaps; i++) {
      const w = Math.exp(-(i * i) / (2 * sigma * sigma));
      raw.push(w);
      sum += (i === 0) ? w : w * 2;
    }
    for (let i = 0; i <= sideTaps; i++) {
      raw[i] /= sum;
    }

    const offsets: number[] = [0];
    const weights: number[] = [raw[0]];

    for (let p = 0; p < fetchPairs; p++) {
      const i = p * 2 + 1;
      const j = i + 1;
      const w0 = raw[i] ?? 0;
      const w1 = (j <= sideTaps) ? raw[j] : 0;
      const wSum = w0 + w1;
      const offset = wSum > 0 ? (i * w0 + j * w1) / wSum : i;
      offsets.push(offset);
      weights.push(wSum);
    }

    return { offsets, weights };
  }

  /**
   * Builds a GLSL fragment shader snippet string from a GaussianKernel
   * (fully unrolled — no for loop is used at runtime).
   *
   * Offsets are baked in as GLSL constants; the kernel_scale uniform is
   * multiplied in at runtime so sigma can be fine-tuned without recompiling.
   * Weights define the kernel's shape (fetch count) and are only baked in
   * again when a recompile actually happens.
   */
  private _buildGaussianSnippet(kernel: GaussianKernel, direction: 'h' | 'v'): ShaderSnippet {
    const decl =
      `uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */\n` +
      `uniform float kernel_scale; /* dynamic scale based on the sigma ratio, avoids recompiling */\n`;

    const lines: string[] = [];
    lines.push(`vec2 uv = cogl_tex_coord_in[0].st;`);
    lines.push(`vec4 col = texture2D(cogl_sampler0, uv) * ${kernel.weights[0].toFixed(8)};`);

    for (let i = 1; i < kernel.offsets.length; i++) {
      const off = kernel.offsets[i].toFixed(8);
      const w = kernel.weights[i].toFixed(8);
      const plusVec = direction === 'h'
        ? `vec2(${off} * kernel_scale * inv_size.x, 0.0)`
        : `vec2(0.0, ${off} * kernel_scale * inv_size.y)`;
      lines.push(`col += texture2D(cogl_sampler0, uv + ${plusVec}) * ${w};`);
      lines.push(`col += texture2D(cogl_sampler0, uv - ${plusVec}) * ${w};`);
    }

    lines.push(`cogl_color_out = col;`);

    return { decl, body: '\n    ' + lines.join('\n    ') + '\n' };
  }

  /**
   * Compiles the H/V pipelines from a dynamically generated GaussianKernel.
   * The caller is responsible for having already dropped any previous
   * pipeline reference (we never call run_dispose(), see _destroyTexturePool).
   */
  private _compileGaussianPipelines(ctx: Cogl.Context, kernel: GaussianKernel): void {
    this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._gaussianHPipeline, 0);
    const hSnippet = this._buildGaussianSnippet(kernel, 'h');
    const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, hSnippet.decl, null);
    hSnip.set_replace(hSnippet.body);
    this._gaussianHPipeline.add_snippet(hSnip);

    this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
    this._configureSamplerLayer(this._gaussianVPipeline, 0);
    const vSnippet = this._buildGaussianSnippet(kernel, 'v');
    const vSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, vSnippet.decl, null);
    vSnip.set_replace(vSnippet.body);
    this._gaussianVPipeline.add_snippet(vSnip);

    this._gaussianKernel = kernel;
    this._gaussianPipelineDirty = false;
    this._pendingGaussianKernel = null;
  }

  // ─── Texture pool management ─────────────────────────────────────────────────

  /**
   * Allocates the blur texture + FBO pairs for resolution (w, h).
   *
   * Index-to-resolution mapping (with glass-blur-downscale at its default 2):
   *   [0]: w>>1 × h>>1  (= w/2)
   *   [1]: w>>2 × h>>2  (= w/4)
   *   ...
   *   [PASS_COUNT-1]: w >> PASS_COUNT
   *
   * [PERF] glass-blur-downscale = 4 shifts the whole ladder down one more
   * step, so level 0 is w/4 × h/4 — a quarter of the fill and a quarter of
   * the texture memory of the default, at the cost of a visibly coarser
   * blur. See _setGaussianBlurRadius(), which converts the radius into the
   * matching texel space, and _runGaussianBlur()'s pre-pass, which switches
   * filter to keep a 4x downsample from aliasing.
   */
  private _buildTexturePool(ctx: Cogl.Context, w: number, h: number): void {
    this._destroyTexturePool();
    this._destroyCropTarget();

    const shift = this._blurDownscale >= 4 ? 2 : 1;
    let pw = Math.max(w >> shift, 1);
    let ph = Math.max(h >> shift, 1);

    for (let i = 0; i < this.PASS_COUNT; i++) {
      try {
        // Main buffer, shared by Dual Kawase and Gaussian.
        const tex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
        const fbo = Cogl.Offscreen.new_with_texture(tex);
        this._blurTextures.push(tex);
        this._blurFbos.push(fbo);

        // Intermediate buffer for the Gaussian horizontal pass (same resolution).
        const tmpTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
        const tmpFbo = Cogl.Offscreen.new_with_texture(tmpTex);
        this._gaussianTempTextures.push(tmpTex);
        this._gaussianTempFbos.push(tmpFbo);

        // [FIX round 12] Output target for this level (see _upTextures).
        const upTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
        const upFbo = Cogl.Offscreen.new_with_texture(upTex);
        this._upTextures.push(upTex);
        this._upFbos.push(upFbo);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to build texture pool at pass ${i} (${pw}x${ph}): ${e}`);
        this._destroyTexturePool();
        return;
      }

      pw = Math.max(pw >> 1, 1);
      ph = Math.max(ph >> 1, 1);
    }

    this._poolWidth = w;
    this._poolHeight = h;
  }

  /**
   * Runs the Dual Kawase blur.
   *
   *   Downsample phase: srcTex → [0] → [1] → ... → [PASS_COUNT-1]
   *   Upsample phase:   [PASS_COUNT-1] → ... → [0]
   *
   * The result ends up in _blurTextures[0].
   */
  private _runDualKawaseBlur(parentNode: any, srcTex: Cogl.Texture, srcUV: number[]): void {
    let currentSrc: Cogl.Texture = srcTex;

    // ── Downsample phase ────────────────────────────────────────────────────
    for (let i = 0; i < this.PASS_COUNT; i++) {
      const destFbo = this._blurFbos[i] as unknown as CoglFB;
      const destTex = this._blurTextures[i];
      const destW = destTex.get_width();
      const destH = destTex.get_height();

      const invW = 1.0 / currentSrc.get_width();
      const invH = 1.0 / currentSrc.get_height();

      // [FIX] Only the FIRST pass reads the raw capture, which may carry
      // padding; it samples just the valid sub-rect via srcUV. Every later
      // pass reads one of our own pool textures, which contain the
      // padding-free region already and so use the full 0..1 range.
      // inv_size stays 1/textureSize either way — it is a texel step in
      // texture space, unaffected by which sub-rect we sample.
      const uv = (i === 0) ? srcUV : [0, 0, 1, 1];

      // [PERF] glass-blur-downscale = 4 makes the FIRST pass a 4x reduction
      // rather than 2x, and Kawase's kernel is not a 4x minification filter —
      // at the smallest radius _blurRadiusDown is 0.0, which collapses all
      // five taps onto one texel. The box filter is used for that one pass
      // instead; the remaining passes still give the blur its character.
      const boxFirst = i === 0 && this._blurDownscale >= 4 && this._boxDownPipeline !== null;
      const pipeline = boxFirst
        ? this._passPipeline('kawase-down-0-box', this._boxDownPipeline!)
        : this._passPipeline(`kawase-down-${i}`, this._downsamplePipeline!);
      pipeline.set_layer_texture(0, currentSrc);
      this._setPipelineVec2(pipeline, 'inv_size', invW, invH);
      if (!boxFirst)
        this._setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusDown);

      this._addPassNode(parentNode, destFbo, pipeline, destW, destH, uv);

      currentSrc = destTex;
    }

    // ── Upsample phase ──────────────────────────────────────────────────────
    // [FIX round 12] Reads the downsample chain but writes into the separate
    // _up* targets, so no framebuffer is ever both an input to one pass and
    // the output of a later one. That mutual dependency is what Cogl's cycle
    // check rejected once the passes became deferred nodes.
    if (this.PASS_COUNT <= 1) {
      this._blurResultTex = this._blurTextures[0];
      return;
    }

    for (let i = this.PASS_COUNT - 1; i > 0; i--) {
      // First step reads the deepest downsample level; later steps read the
      // previous upsample output.
      const srcTexture = (i === this.PASS_COUNT - 1)
        ? this._blurTextures[i]
        : this._upTextures[i];
      const destFbo = this._upFbos[i - 1] as unknown as CoglFB;
      const destTex = this._upTextures[i - 1];
      const destW = destTex.get_width();
      const destH = destTex.get_height();

      const invW = 1.0 / srcTexture.get_width();
      const invH = 1.0 / srcTexture.get_height();

      const pipeline = this._passPipeline(`kawase-up-${i}`, this._upsamplePipeline!);
      pipeline.set_layer_texture(0, srcTexture);
      this._setPipelineVec2(pipeline, 'inv_size', invW, invH);
      this._setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusUp);

      this._addPassNode(parentNode, destFbo, pipeline, destW, destH, [0, 0, 1, 1]);
    }

    this._blurResultTex = this._upTextures[0];
  }

  /**
   * Runs the separable Gaussian blur.
   *
   * PASS_COUNT is always fixed to 1 for this method, and the texture pool
   * only uses a single w/2 × h/2 level (no pool rebuild / pass-count change
   * happens when the radius changes).
   *
   *   srcTex → [gaussianTemp[0]] (horizontal pass) → [blurTextures[0]] (vertical pass)
   *
   * The H/V pipelines are the ones dynamically built from the kernel
   * computed in setBlurRadius() (fully unrolled). Result ends up in
   * _blurTextures[0].
   */
  private _runGaussianBlur(parentNode: any, srcTex: Cogl.Texture, srcUV: number[]): void {
    const tempFbo = this._gaussianTempFbos[0] as unknown as CoglFB;
    const tempTex = this._gaussianTempTextures[0];
    const destFbo = this._blurFbos[0] as unknown as CoglFB;
    const destTex = this._blurTextures[0];
    const destW = destTex.get_width();
    const destH = destTex.get_height();

    // ── 0. Pre-pass: srcTex (full res) → destTex (half res) ─────────────────
    // A plain bilinear downsample so the H/V passes can operate entirely in
    // half-resolution space.
    // [PERF] Uses the snippet-less passthrough pipeline rather than
    // downsample.frag with blur_radius = 0. Identical output (the collapsed
    // kernel averaged four fetches of the same texel), one fetch instead of
    // five. No inv_size / blur_radius to set — the pipeline has no uniforms.
    // [PERF] At the default downscale of 2 a single bilinear fetch already
    // averages the 2x2 source footprint exactly, so the passthrough is both
    // cheapest and correct. At 4 it would point-sample one texel in sixteen,
    // so the exact 4x4 box filter is used instead — see _boxDownPipeline.
    const wideDownsample = this._blurDownscale >= 4 && this._boxDownPipeline !== null;
    const prePipeline = wideDownsample
      ? this._passPipeline('gauss-pre-box', this._boxDownPipeline!)
      : this._passPipeline('gauss-pre', this._passthroughPipeline!);
    prePipeline.set_layer_texture(0, srcTex);
    if (wideDownsample) {
      // inv_size is a texel step in the SOURCE texture, so it uses the
      // capture's own size regardless of which sub-rect we sample.
      this._setPipelineVec2(prePipeline, 'inv_size',
        1.0 / srcTex.get_width(), 1.0 / srcTex.get_height());
    }

    // [FIX] Sample only the valid sub-rect of the raw capture (see the
    // matching comment in _runDualKawaseBlur). The H/V passes below read
    // our own pool textures and keep the full 0..1 range.
    this._addPassNode(parentNode, destFbo, prePipeline, destW, destH, srcUV);

    // ── 1. Horizontal pass: destTex (half res) → tempTex (half res) ─────────
    // Input is already half-resolution, so inv_size uses destW/destH directly.
    const hPipeline = this._passPipeline('gauss-h', this._gaussianHPipeline!);
    hPipeline.set_layer_texture(0, destTex);
    this._setPipelineVec2(hPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
    this._setPipelineFloat(hPipeline, 'kernel_scale', this._gaussianScale);

    this._addPassNode(parentNode, tempFbo, hPipeline, destW, destH, [0, 0, 1, 1]);

    // ── 2. Vertical pass: tempTex (half res) → destTex (half res) ───────────
    // [FIX round 12] Writes into the separate output target rather than back
    // into destFbo. Going back would make destFbo depend on tempFbo while
    // tempFbo already depends on destFbo (the horizontal pass read destTex) —
    // the exact cycle Cogl rejects now that these passes are deferred nodes.
    const vPipeline = this._passPipeline('gauss-v', this._gaussianVPipeline!);
    vPipeline.set_layer_texture(0, tempTex);
    this._setPipelineVec2(vPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
    this._setPipelineFloat(vPipeline, 'kernel_scale', this._gaussianScale);

    const outFbo = this._upFbos[0] as unknown as CoglFB;
    this._addPassNode(parentNode, outFbo, vPipeline, destW, destH, [0, 0, 1, 1]);

    this._blurResultTex = this._upTextures[0];
  }

  /**
   * Drops the texture pool and resets the related fields.
   *
   * We never call run_dispose() on these GJS-managed Cogl objects: GJS's own
   * garbage collector would later try to unref them again, causing a double
   * free ("free(): invalid size" → SIGABRT). Simply clearing the references
   * lets the GC reclaim the VRAM safely.
   */
  private _destroyTexturePool(): void {
    this._blurFbos = [];
    this._blurTextures = [];
    this._gaussianTempFbos = [];
    this._gaussianTempTextures = [];
    this._upFbos = [];
    this._upTextures = [];
    this._blurResultTex = null;
    this._poolWidth = 0;
    this._poolHeight = 0;
  }


  /**
   * Overrides the Clutter.OffscreenEffect hook.
   *
   * Called after OffscreenEffect has rendered the actor's content into its
   * internal FBO, at the point where that FBO texture is normally composited
   * onto the screen.
   *
   * The default super.vfunc_paint_target() just draws the FBO straight to
   * the screen; here we instead run the blur pipeline followed by the glass
   * composite pass.
   *
   * @param _paintNode   Clutter's paint node (new signature since GNOME 45+)
   * @param paintContext Current paint context, holding a reference to the on-screen framebuffer
   */
  /**
   * Overrides Clutter.Effect's paint hook purely to observe the dirty flag.
   *
   * ACTOR_DIRTY is the only place the "the offscreen is about to be
   * re-rendered" fact is visible from JS: vfunc_paint_target() runs on every
   * paint, cached or not, so it cannot tell the two apart. Everything else is
   * left to the base class.
   */
  vfunc_paint(node: Clutter.PaintNode, paintContext: Clutter.PaintContext,
    flags: Clutter.EffectPaintFlags): void {
    if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY) this._recaptureSerial++;
    super.vfunc_paint(node, paintContext, flags);
  }

  vfunc_paint_target(_paintNode: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
    // ── [DIAG] Black-background investigation ──────────────────────────────
    // If Clutter culls/skips this actor entirely (e.g. because it decides
    // it's fully occluded by the window content painted above it), this
    // function never runs at all -- which would show up here as a call count
    // that never advances past whatever it was when the window opened, even
    // though _frameTick keeps calling set_size()/queue_redraw() at 60fps.
    //
    // [PERF] The counter itself is one increment and stays unconditional so
    // dump()'s "paints" figure remains exact. Everything below it — a
    // monotonic-time read and a closure that resolves the window title — is
    // gated: the title is only ever used inside a log line that the logger
    // discards unless output-logs is on, yet it was being built on every
    // paint of every glass surface regardless.
    this._diagPaintCount++;
    if (this._diagEnabled) {
      const now = GLib.get_monotonic_time();
      const actorTitle = (() => {
        try {
          const a = this.get_actor() as any;
          return a?.get_meta_window?.()?.get_title?.() ?? a?.get_name?.() ?? '?';
        } catch (e) { return '?'; }
      })();
      if (!this._diagFirstPaintLogged) {
        this._diagFirstPaintLogged = true;
        this._diagLastPaintLogAt = now;
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: FIRST call for "${actorTitle}" ` +
          `(paintCount=${this._diagPaintCount}, shadersLoaded=${this._shadersLoaded})`);
      } else if (now - this._diagLastPaintLogAt > 2000 * 1000) {
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: heartbeat for "${actorTitle}", ` +
          `paintCount=${this._diagPaintCount}, compositedCount=${this._diagCompositedPaintCount}`);
        this._diagLastPaintLogAt = now;
      }
    }

    // ── Wait for async shaders ──────────────────────────────────────────────
    if (!this._shadersLoaded) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }
    // ── Deferred pipeline initialization ─────────────────────────────────────
    if (!this._compositePipeline) {
      try {
        const ctx = this._getCoglContext();
        if (!ctx) throw new Error('Could not obtain a Cogl context');
        this._initPipelines(ctx);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Pipeline initialization failed: ${e}`);
        // Fall back to OffscreenEffect's default drawing.
        super.vfunc_paint_target(_paintNode, paintContext);
        return;
      }
    }

    // ── Guard check ───────────────────────────────────────────────────────────
    // The Gaussian H/V pipelines don't exist until a radius has been set
    // (they're built dynamically), so they're intentionally excluded from
    // this required-pipeline check.
    if (!this._compositePipeline || !this._downsamplePipeline || !this._upsamplePipeline) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    // ── Deferred compilation of the Gaussian shaders ─────────────────────────
    // Whenever setBlurRadius() changes the tap count, compile the new H/V
    // pipelines here, where a Cogl context is guaranteed to be available.
    // Old pipeline references are left for GJS's GC rather than disposed
    // manually.
    if (this._gaussianPipelineDirty && this._pendingGaussianKernel) {
      try {
        const ctx = this._getCoglContext();
        if (!ctx) throw new Error('Could not obtain a Cogl context');
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compileGaussianPipelines(ctx, this._pendingGaussianKernel);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to build Gaussian pipelines: ${e}`);
      }
    }

    // ── [PERF] Is this a repeat paint of the same frame? ───────────────────
    // See _frameSerial. The frame's FIRST paint of this instance runs the
    // whole chain; the repeats reuse what it produced.
    //
    // Correctness rests on two facts:
    //
    //   1. The input is identical. Every paint of this instance in this frame
    //      renders the same actor subtree into the same capture texture, so
    //      the blur of it cannot differ.
    //   2. The first paint's nodes execute first. Paint nodes run in tree
    //      order, and a Clutter.Clone is always painted after its source (the
    //      dock sits above the windows it clones; a window sits above the
    //      windows below it). So the pool is written before any repeat reads
    //      it — the reuse is same-frame, not last-frame, and a change in what
    //      is behind the glass shows up with zero frames of delay.
    // Retried here rather than only in _init(): an effect can be constructed
    // before global.stage is reachable, and one failed attempt must not
    // disable the optimization for the rest of the session.
    if (!_frameSerialIsLive()) _ensureFrameSerialHook();

    // Without a live counter every paint is treated as a first paint, which is
    // exactly the behavior from before this optimization existed. _blurFrame
    // Serial is deliberately left untouched in that case, so it cannot later
    // collide with a real serial once the hook does come up.
    const serialIsLive = _frameSerialIsLive();
    const firstPaintThisFrame = !serialIsLive || this._blurFrameSerial !== _frameSerial;
    if (serialIsLive) this._blurFrameSerial = _frameSerial;

    // Grab the FBO texture OffscreenEffect captured from the actor.
    const srcTex = this.get_texture() as Cogl.Texture2D | null;
    if (!srcTex) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    const srcW = srcTex.get_width();
    const srcH = srcTex.get_height();

    // ── Trust the actor's logical size over get_texture()'s reported size ──
    // get_texture() can be a few pixels larger than the actor's logical size
    // due to internal FBO padding (see the crop-pass comment above), so
    // actor.get_size() is used as the source of truth from here on.
    const actor = this.get_actor();
    let allocW = srcW;
    let allocH = srcH;
    if (actor) {
      const [aw, ah] = actor.get_size();
      if (Number.isFinite(aw) && aw > 0) allocW = Math.round(aw);
      if (Number.isFinite(ah) && ah > 0) allocH = Math.round(ah);
    }

    // ── Handle the capture's padding ────────────────────────────────────────
    //
    // get_texture() is sized to the actor's PAINT BOX, not its allocation, so
    // it carries a few pixels of padding (measured: 964x563 capture for a
    // 961x560 actor). computeCaptureLayout() derives exactly where the actor's own
    // pixels sit inside that padded texture, and where the composite quad has
    // to be drawn so it lands back on the actor. See that function (utils.ts)
    // for why the padding is NOT centred and why the draw rect is not
    // (0, 0, w, h).
    // The capture itself, padding and all. Nothing copies it any more; every
    // consumer works on it directly and sampling is confined to the valid
    // sub-rect by srcUV below.
    const effectiveW = allocW;
    const effectiveH = allocH;

    const layout = computeCaptureLayout(actor, srcW, srcH, effectiveW, effectiveH);
    const srcUV: number[] = layout.uv;

    // [FIX] Publish where the actor's own pixels start inside the capture.
    //
    // ClutterOffscreenEffect sizes its offscreen to the actor's PAINT BOX,
    // which mutter enlarges by a fixed 3px (2 on the left/top, 1 on the
    // right/bottom — see computeCaptureLayout and memo.md's first addendum).
    // So actor-local (0, 0) is NOT texel (0, 0) of the framebuffer everything
    // inside this effect draws into; it is texel (dest[0], dest[1]).
    //
    // That matters to anything inside our subtree that samples the
    // FRAMEBUFFER by stage coordinates rather than by its own — which is
    // exactly what a background-mode blur does. Without this correction such
    // an effect reads a region shifted up and to the left, whose first rows
    // are the cleared padding, and a blur then smears that transparency down
    // over its whole radius. See UILayerSampler._syncBmsReplica().
    try {
      (actor as any)._lgCaptureOffset = [layout.dest[0], layout.dest[1]];
    } catch (e) { /* diagnostic only */ }

    // ── [PERF] Blurred sub-rect ─────────────────────────────────────────────
    // See _computeBlurRect() and glass.frag's blur_rect_* uniforms. The rect
    // lives in the shader's coordinate space (resolution_x/y) while the
    // capture mapping below is in allocation space; they are the same space
    // for every current caller, but if they ever drift the rect is dropped
    // rather than trusted.
    const resW = this._pendingUniforms.get('resolution_x') ?? 0;
    const resH = this._pendingUniforms.get('resolution_y') ?? 0;
    const spacesAgree =
      Math.abs(resW - effectiveW) <= 1 && Math.abs(resH - effectiveH) <= 1;
    // With no blur running, layer 1 is the raw capture over the FULL actor,
    // so the shader must keep the identity mapping.
    const blurRect =
      (this.PASS_COUNT > 0 && spacesAgree) ? this._computeBlurRect() : null;
    // NOTE: the blur_rect_* uniforms are NOT set here. They describe what
    // layer 1 actually holds, and layer 1 only holds the sub-rect if the blur
    // really ran — several paths below fall back to binding the raw capture.
    // They are set once that is known, just before _applyPendingUniforms().

    // The blur chain's own resolution, and the slice of the capture it reads.
    const blurW = blurRect ? blurRect[2] : effectiveW;
    const blurH = blurRect ? blurRect[3] : effectiveH;
    const blurSrcUV: number[] = blurRect
      ? [
        srcUV[0] + (blurRect[0] / effectiveW) * (srcUV[2] - srcUV[0]),
        srcUV[1] + (blurRect[1] / effectiveH) * (srcUV[3] - srcUV[1]),
        srcUV[0] + ((blurRect[0] + blurRect[2]) / effectiveW) * (srcUV[2] - srcUV[0]),
        srcUV[1] + ((blurRect[1] + blurRect[3]) / effectiveH) * (srcUV[3] - srcUV[1]),
      ]
      : srcUV;

    // [PERF] A repeat paint can reuse the blur only if the pool it was written
    // into is still the right one — a resize between paints destroys it.
    // The rect has to match too, not just the pool size: geometry can change
    // between two paints of the same frame, and the quantized size would
    // often survive a move that shifts the rect's ORIGIN. Reusing a blur
    // taken somewhere else would draw the wrong background.
    const a = this._blurRectUsed;
    const rectUnchanged = (a === null)
      ? (blurRect === null)
      : (blurRect !== null && a[0] === blurRect[0] && a[1] === blurRect[1] &&
        a[2] === blurRect[2] && a[3] === blurRect[3]);
    const reuseBlur = !firstPaintThisFrame &&
      this.PASS_COUNT > 0 &&
      this._blurResultTex !== null &&
      rectUnchanged &&
      this._poolWidth === blurW &&
      this._poolHeight === blurH;

    // [PERF] The crop runs only for a paint that is going to blur — the blur
    // is its only consumer now that both composite layers share one texture.
    // With a sub-rect in play it has nothing left to do: its whole job was to
    // hand the blur a padding-free 0..1 texture, and the blur is reading an
    // arbitrary sub-rect of the capture anyway. Cropping first would mean a
    // full-resolution copy of exactly the pixels we are trying not to touch.
    let effectiveTexOut: Cogl.Texture = srcTex;
    if (this._cropPassEnabled && !blurRect && !reuseBlur &&
      (srcW !== effectiveW || srcH !== effectiveH)) {
      try {
        const cropCtx = this._getCoglContext();
        if (cropCtx) {
          effectiveTexOut = this._addCropPassNode(
            _paintNode, cropCtx, srcTex, srcW, srcH, effectiveW, effectiveH, layout.uv
          );
        }
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Crop pass node failed; continuing with the padded texture: ${e}`);
      }
    }

    // [PERF] When the crop is off. It used to copy the capture into a
    // padding-free texture of its own, at FULL resolution, once per paint per
    // glass surface — 1920x1080 for every full-screen surface.
    //
    // Its only purpose was to make the composite's two layers agree on a
    // texture-coordinate range. Layer 1 (a pool texture) is padding-free and
    // wants 0..1; layer 0 (the raw capture) carries the padding
    // ClutterOffscreenEffect adds and wants the sub-rect. One
    // add_texture_rectangle() carries a single range, and the per-layer
    // variant (add_multitexture_rectangle) is not safely callable from GJS —
    // its annotation types the coordinate array as a bare number, and passing
    // an array through it segfaults the shell (memo.md 6.1). So the crop
    // existed to erase the difference.
    //
    // The difference can be erased for free instead: glass.frag samples ONLY
    // cogl_sampler1, so layer 0's contents are irrelevant, and binding the
    // blur result to BOTH layers makes one range correct for both. The blur
    // chain never needed the crop either — its first pass already samples the
    // capture over srcUV (see _runGaussianBlur / _runDualKawaseBlur).
    //
    // This is not a new code path: it is the one A1's reuse case has been
    // taking for the majority of paints, verified on hardware.
    const effectiveTex: Cogl.Texture = effectiveTexOut;
    // Whether the crop actually ran decides the range every later pass uses:
    // the cropped texture is padding-free (0..1), the raw capture is not.
    const inputUV: number[] = (effectiveTex === srcTex) ? srcUV : [0, 0, 1, 1];
    // What the blur's first pass reads. Identical to inputUV unless a
    // sub-rect is active, in which case the crop is off and this is the
    // rect's slice of the raw capture.
    const blurInputUV: number[] = blurRect ? blurSrcUV : inputUV;

    // ── Rebuild the texture pool when the resolution changes ────────────────
    // Based on the cropped ("true") resolution — using the padded size here
    // would cause rounding error from bit-shifting (w >> 1) an odd value to
    // accumulate across passes, misaligning the sharp and blurred layers.
    if (!reuseBlur && (blurW !== this._poolWidth || blurH !== this._poolHeight)) {
      try {
        const ctx = this._getCoglContext();
        if (!ctx) throw new Error('Could not obtain a Cogl context');
        this._buildTexturePool(ctx, blurW, blurH);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to rebuild the texture pool: ${e}`);
        super.vfunc_paint_target(_paintNode, paintContext);
        return;
      }
    }

    if (this.PASS_COUNT > 0 && !this._blurFbos.length) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Blur pass: which blur method runs depends on _blurMethod
    //   0: Separable Gaussian blur
    //   1: Dual Kawase blur (original implementation)
    // Always takes the raw capture as input, sampled over srcUV.
    // ─────────────────────────────────────────────────────────────────────
    if (reuseBlur) {
      // _blurResultTex is left exactly as the frame's first paint set it.
      this._blurSkips++;
    } else {
      this._blurResultTex = null;
      this._blurRectUsed = blurRect;
      if (this.PASS_COUNT > 0) {
        this._blurRuns++;
        if (this._blurMethod === 0) {
          if (this._gaussianHPipeline && this._gaussianVPipeline) {
            this._runGaussianBlur(_paintNode, effectiveTex, blurInputUV);
          }
        } else {
          this._runDualKawaseBlur(_paintNode, effectiveTex, blurInputUV);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Final pass: glass composite.
    //   Binds _blurTextures[0] (blurred, w/2 × h/2) as cogl_sampler0 and runs
    //   glass.frag (refraction / rim lighting / shadow) to draw onto the screen.
    //
    //   Clutter has already set up the actor's model-view transform on
    //   screenFb — but with the capture's FBO offset folded in, so this
    //   space is measured in capture TEXELS from the texture's top-left
    //   corner, not in actor-local pixels from the actor's. The rect to draw
    //   is therefore layout.dest, not (0, 0, effectiveW, effectiveH); see
    //   computeCaptureLayout() in utils.ts.
    // ─────────────────────────────────────────────────────────────────────
    const compFb = paintContext.get_framebuffer();
    const compPipeline = this._compositePipeline!;

    // [PERF] Both layers are bound to the SAME texture so that one
    // texture-coordinate range is correct for both — see the note where the
    // crop pass used to be. Whenever a blur exists that is the blur result
    // (0..1); with blur disabled it is the raw capture (srcUV).
    //
    // Sound only because glass.frag samples cogl_sampler1 and never
    // cogl_sampler0. If a future revision starts reading layer 0 as "the
    // sharp capture", it needs its own coordinate range again, and that means
    // either bringing the crop back or finding a working per-layer
    // coordinate call.
    const haveBlur = this.PASS_COUNT > 0 && this._blurResultTex !== null;

    // [PERF] Now that it is settled whether layer 1 is the blurred sub-rect
    // or the whole raw capture, tell the shader which it is. Zero means "the
    // whole actor", i.e. the identity mapping glass.frag used before the
    // sub-rect existed — so every fallback path above lands on the correct
    // sampling automatically.
    const activeRect = (haveBlur && blurRect) ? blurRect : null;
    this._blurRect = activeRect;
    this._setFloat('blur_rect_x', activeRect ? activeRect[0] : 0.0);
    this._setFloat('blur_rect_y', activeRect ? activeRect[1] : 0.0);
    this._setFloat('blur_rect_w', activeRect ? activeRect[2] : 0.0);
    this._setFloat('blur_rect_h', activeRect ? activeRect[3] : 0.0);
    // Layer 0 is never sampled by glass.frag, so it exists only to not
    // contradict layer 1's coordinate range. Bind whichever texture already
    // uses the range layer 1 needs.
    const layer0Tex = haveBlur ? this._blurResultTex! : effectiveTex;
    compPipeline.set_layer_texture(0, layer0Tex);
    this._configureSamplerLayer(compPipeline, 0);
    const layer0UV = haveBlur ? [0, 0, 1, 1] : inputUV;

    // Layer 1 is the one glass.frag actually samples: the blurred background,
    // or the raw capture when blur is disabled.
    // [FIX round 12] The finished blur no longer always lands in
    // _blurTextures[0]; whichever runner executed records its output here.
    const layer1UV: number[] = layer0UV;
    compPipeline.set_layer_texture(1, layer0Tex);
    this._configureSamplerLayer(compPipeline, 1);

    // Manually sync pending uniforms into the composite pipeline.
    // Without this, values like dock_x would stay at 0 and the whole screen
    // would be misdetected as being inside the dock mask.
    this._applyPendingUniforms();

    // [FIX] Feed the actor's real, cascaded paint opacity into the pipeline
    // color used for the final draw. glass.frag's very last line already
    // does `cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;`
    // — i.e. it was ALWAYS ready to respect the actor's opacity — but
    // nothing on the JS/Cogl side was ever setting this pipeline's color,
    // so Cogl defaulted it to opaque white (255,255,255,255) and that
    // multiply was a permanent no-op. get_paint_opacity() (rather than the
    // actor's own local .opacity) is used because it already returns the
    // value cascaded through the actor's ancestors, so a child of an
    // animating windowActor fades correctly without any extra plumbing.
    //
    // IMPORTANT — this must be (op, op, op, op), NOT (255, 255, 255, op):
    // finalRgb is already PREMULTIPLIED by the shape's own alpha (see
    // `finalRgb = litColor * alpha + shadowColor * shadowContribution`
    // above). Fading premultiplied color by an additional opacity factor
    // requires scaling BOTH the color and the alpha by that same factor —
    // `vec4(finalRgb, finalAlpha) * vec4(1,1,1,op)` only scales alpha and
    // leaves finalRgb at full brightness, which breaks the premultiplied
    // invariant (rgb should never exceed alpha) and — combined with the
    // ADD-based premultiplied blend function above — reads as abnormally
    // bright/washed-out at any opacity below 255, exactly matching the
    // "glass looks way too bright while the window is fading" symptom seen
    // during open/close animations. Scaling all four channels by the same
    // factor keeps it correctly premultiplied at every opacity level.
    const paintOpacity = actor ? actor.get_paint_opacity() : 255;
    const color = new Cogl.Color();
    const paintOpacity_f = paintOpacity / 255;
    color.init_from_4f(paintOpacity_f, paintOpacity_f, paintOpacity_f, paintOpacity_f);
    this._compositePipeline!.set_color(color);

    // [FIX round 10] The push_matrix()/pop_matrix() pair that used to wrap
    // this draw is gone: nothing modified the matrix between them (so it was
    // already a no-op), and now that the draw is queued as a node rather than
    // issued here, bracketing immediate framebuffer state around it would not
    // affect it anyway. The node inherits the actor's model-view transform
    // from the paint context at execution time, which is what positions it.
    // [FIX round 13] The draw rect is layout.dest, NOT (0, 0, w, h).
    // vfunc_paint_target runs inside the transform node ClutterOffscreenEffect
    // wraps around it, whose translation is the capture's own FBO offset —
    // i.e. the coordinate space here has its origin at the capture texture's
    // top-left corner, not at the actor's. Drawing at (0, 0) therefore put
    // the whole glass ~2-3px up and to the left of the actor. See
    // computeCaptureLayout() in utils.ts for how the correct rect is derived.
    // [PERF] Draw only the part of the quad that can be non-transparent.
    //
    // The rect is in the shader's coordinate space, and the quad is in
    // capture-texel space; the two are related by layout.dest. `uv` doubles
    // as the shader's notion of "where am I in the actor"
    // (`pixel_coord = uv * resolution`), so the sub-range handed to the draw
    // has to be interpolated with `resolution` as the denominator, or
    // pixel_coord would no longer agree with where the quad actually lands.
    // That is only exactly true when the two spaces coincide, so the rect is
    // dropped unless they do — a sub-pixel disagreement here is a visible
    // clip, not a sampling error.
    const compRect = (resW === effectiveW && resH === effectiveH)
      ? this._computeCompositeRect()
      : null;
    this._compositeRect = compRect;

    let drawRect = layout.dest;
    let drawUV = layer0UV;
    if (compRect) {
      const sx = (layout.dest[2] - layout.dest[0]) / effectiveW;
      const sy = (layout.dest[3] - layout.dest[1]) / effectiveH;
      drawRect = [
        layout.dest[0] + compRect[0] * sx,
        layout.dest[1] + compRect[1] * sy,
        layout.dest[0] + (compRect[0] + compRect[2]) * sx,
        layout.dest[1] + (compRect[1] + compRect[3]) * sy,
      ];
      const [u0, v0, u1, v1] = layer0UV;
      drawUV = [
        u0 + (compRect[0] / resW) * (u1 - u0),
        v0 + (compRect[1] / resH) * (v1 - v0),
        u0 + ((compRect[0] + compRect[2]) / resW) * (u1 - u0),
        v0 + ((compRect[1] + compRect[3]) / resH) * (v1 - v0),
      ];
    }

    this._addCompositeNode(_paintNode, drawRect, drawUV, drawUV);

    this._diagCompositedPaintCount++;

    // [DIAG] "Blur is not visible — the background inside the glass stays
    // sharp — but changing the blur radius does change the look, and
    // refraction works." glass.frag reads ONLY cogl_sampler1 for the body
    // (cogl_sampler0 and blur_strength are declared but unused), so a sharp
    // body means layer 1 is bound to something sharp — which happens exactly
    // when _blurResultTex is null and the fallback below binds the raw
    // capture. This records the state that decides it, per instance, for
    // global._lgGlass.dump().
    //
    // [PERF] Two allocations for the arrays, one for the object, four
    // toFixed() strings, two get_width()/get_height() round trips and a
    // closure — per paint, per glass surface. With diagnostics off this is
    // throttled to roughly once a second instead of being dropped entirely,
    // so dump() still answers (very slightly stale) without anyone having to
    // enable a setting first and reproduce the problem again.
    const diagNow = GLib.get_monotonic_time();
    if (this._diagEnabled || diagNow - this._diagLastSnapshotAt > 1000 * 1000) {
      this._diagLastSnapshotAt = diagNow;
      this._diagLast = {
        owner: this._owner,
        actor: (() => { try { return (this.get_actor() as any)?.get_name?.() ?? '?'; } catch (e) { return '?'; } })(),
        src: `${srcW}x${srcH}`,
        alloc: `${allocW}x${allocH}`,
        uv: layout.uv.map(v => +v.toFixed(5)),
        dest: layout.dest.map(v => +v.toFixed(2)),
        blurMethod: this._blurMethod,
        passCount: this.PASS_COUNT,
        pool: `${this._poolWidth}x${this._poolHeight}`,
        poolLevels: this._blurFbos.length,
        blurResult: (() => {
          const t = this._blurResultTex as Cogl.Texture | null;
          return t ? `${t.get_width()}x${t.get_height()}`
            : 'NULL (layer 1 falls back to the SHARP capture)';
        })(),
        radiusDown: this._blurRadiusDown,
        radiusUp: this._blurRadiusUp,
        targetRadius: this._targetRadius,
        gaussianPipelines: !!(this._gaussianHPipeline && this._gaussianVPipeline),
        paintOpacity,
        paints: this._diagPaintCount,
        // [PERF] How the paints split: blurRuns is the chains actually
        // executed, blurSkips the repeat paints that reused one. With nested
        // glass, blurSkips is where the saving is.
        cropRan: effectiveTex !== srcTex,
        blurRuns: this._blurRuns,
        blurSkips: this._blurSkips,
        // The uniforms that decide whether a drop shadow can appear at all.
        // Read straight out of the buffered state, which is by definition
        // what was last handed to the pipeline — so a value that looks wrong
        // here is a JS-side problem, and a value that looks right here with
        // no shadow on screen puts the fault in the shader or in what is
        // drawn over it.
        u: {
          shadowRadius: this._pendingUniforms.get('shadow_radius'),
          shadowIntensity: this._pendingUniforms.get('shadow_intensity'),
          shadowMaxRadius: this._pendingUniforms.get('shadow_max_radius'),
          edgeSmoothing: this._pendingUniforms.get('edge_smoothing'),
          cornerRadius: this._pendingUniforms.get('corner_radius'),
          padding: this._pendingUniforms.get('padding'),
          isDock: this._pendingUniforms.get('isDock'),
          multiRegion: this._pendingUniforms.get('multi_region_mode'),
          earlyExit: this._pendingUniforms.get('early_exit_enabled'),
          dockRect: [
            this._pendingUniforms.get('dock_x'),
            this._pendingUniforms.get('dock_y'),
            this._pendingUniforms.get('dock_w'),
            this._pendingUniforms.get('dock_h'),
          ],
          blurRect: this._blurRect ? this._blurRect.slice() : null,
          captureClip: this._lgCaptureClip ? this._lgCaptureClip.slice() : null,
          compositeRect: this._compositeRect ? this._compositeRect.slice() : null,
          blurPool: [this._poolWidth, this._poolHeight, this._blurDownscale],
        },
      };
    }
  }

  // ─── Crop pass ───────────────────────────────────────────────────────────
  //
  // get_texture() is sized to the actor's PAINT BOX, not its allocation, so it
  // carries a few pixels of padding. This pass copies out just the valid
  // region, which lets every later pass work in the plain 0..1 range.
  //
  // [PERF] It was removed outright, and put back behind this flag after the
  // one-frame texture lag from memo.md returned — with A1's blur reuse active,
  // which is the combination the removal had never been tested in. The two
  // interact: without the crop the blur chain samples the effect's own live
  // capture texture, and with the reuse in play that texture is read by passes
  // that no longer sit in a simple chain behind it.
  //
  // Kept switchable rather than simply reverted so the attribution can be
  // settled in one session: global._lgGlass.cropPass(false) turns it off.

  // ─── Blurred sub-rect (A3 alternative) ───────────────────────────────────
  //
  // The blur used to run over the whole capture, which for a full-screen FBO
  // is 1920x1080 downsampled and Gaussian-blurred every frame — even when the
  // only glass on it is a 600x100 dock. Almost all of that work was thrown
  // away: glass.frag multiplies the refracted color by `alpha = insideMask`,
  // so a pixel outside the glass body contributes nothing no matter what the
  // blur texture holds there.
  //
  // The obvious fix — shrink the FBO to the glass — is the one thing we must
  // NOT do. dockManager.ts sizes bgActor/liquidBox to the whole monitor
  // precisely so the offscreen's origin coincides with the stage's, because a
  // background-mode blur nested inside our subtree (Blur My Shell's panel)
  // resolves its source rect in STAGE coordinates and then blits out of the
  // CURRENT framebuffer. A dock-sized FBO makes those two spaces disagree and
  // brings back the offset/cache-pollution bugs recorded there.
  //
  // So the FBO, the actor, computeCaptureLayout() and every stage coordinate
  // stay exactly as they are, and only the region handed to the blur chain
  // shrinks. glass.frag's blur_rect_* uniforms tell the shader where that
  // region sits so layer 1 is sampled through the matching sub-rect mapping.
  //
  // global._lgGlass.blurRect(false) turns it off for A/B testing.
  static USE_BLUR_RECT = true;

  // Hard floor on the margin around the glass, on top of the computed
  // refraction reach. Covers edge_smoothing's feather, the 4-tap RGSS spread
  // and rounding.
  static BLUR_RECT_MIN_MARGIN = 12;

  // Below this the rect is not worth the extra uniforms: if it already covers
  // essentially the whole actor there is nothing to save. Kept close to 1
  // because an application window — where the glass IS the actor apart from
  // the shadow margin — lands around 0.8, and those are the surfaces that
  // paint most often.
  static BLUR_RECT_MIN_SAVING = 0.95;

  // The texture pool is keyed on the blurred region's SIZE, so every change
  // to it destroys and reallocates three textures and three framebuffers.
  // A menu whose width creeps by a pixel while it opens would do that on
  // every frame of the animation. Rounding the size up to a multiple of this
  // makes those changes land on the same pool; the rect's POSITION is free to
  // move as much as it likes, since nothing is keyed on it.
  static BLUR_RECT_QUANTUM = 64;

  // [PERF ①] Slack added on top of the refraction + blur reach when clipping
  // the CAPTURE (see getCaptureClipRect()). The clip is recomputed from the
  // same frame's uniforms, so this is not covering a lag — it is covering
  // rounding, the 4-tap RGSS spread, and the fact that being a little too
  // generous here costs a few thousand pixels while being a little too tight
  // shows up as a hard edge in the glass.
  static CAPTURE_CLIP_EXTRA_MARGIN = 24;

  // Do not bother clipping when the rect already covers this much of the
  // actor. Application windows sit above it (their glass IS the actor bar
  // the shadow margin, and applicationManager's clipBox already clips the
  // clone subtree), so they keep their current, un-scissored path.
  static CAPTURE_CLIP_MIN_SAVING = 0.85;

  // ─── Composite rect ──────────────────────────────────────────────────────
  //
  // The composite pass — glass.frag itself — was issued over the whole
  // capture. For a full-screen FBO that means running the fragment shader on
  // 1920x1080 pixels to light a 920x110 dock. The early exits at the top of
  // main() make most of those pixels cheap, but "cheap" is not "free": the
  // shader still starts, still evaluates the SDF, and the rasterisation and
  // the blend still cost their memory bandwidth.
  //
  // Everything the shader can actually put on screen is
  //   finalRgb = litColor * alpha + shadowColor * shadowContribution
  //            + panelTerm.rgb
  // and `alpha` is `insideMask`, which is 0 outside the body. So only the
  // body, the drop shadow's reach, and (if it were ever switched on) the
  // panel fallback fill can be non-transparent. The composite blend is
  // `ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))`, under which a
  // fully-transparent source is exactly a no-op — so NOT drawing those
  // pixels is bit-for-bit what drawing them did.
  //
  // Unlike the blurred sub-rect this needs no refraction margin: refraction
  // changes where a pixel SAMPLES from, not where it is drawn.
  //
  // global._lgGlass.compositeRect(false) turns it off for A/B testing.
  static USE_COMPOSITE_RECT = true;

  // As with the blur rect: not worth the arithmetic if it saves nothing.
  static COMPOSITE_RECT_MIN_SAVING = 0.95;

  /**
   * [PERF] Works out how much of the actor the composite pass has to cover.
   *
   * Returns integer [x, y, w, h] in the shader's own coordinate space
   * (`resolution_x/y`), or null for "cover everything" — the pre-existing
   * behavior, used whenever the answer is uncertain or not worth it.
   *
   * The shadow's real reach, from glass.frag:
   *   effectiveRadius = min(shadow_radius * dirRadius, maxRadius), dirRadius <= 1
   *   maxRadius       = max(shadow_max_radius, 5)
   *   umbra/penumbra are 0 at d >= effectiveRadius, and
   *   `shadowAlpha *= 1 - step(maxRadius, d)` zeroes it past maxRadius too.
   * so nothing is drawn beyond min(shadow_radius, maxRadius) from the body.
   * Multi-region mode sets shadowAlpha to 0 outright.
   */
  private _computeCompositeRect(): number[] | null {
    if (!this._compositeRectEnabled) return null;

    // The debug visualisations are easier to read when they are not clipped
    // to the rect being debugged.
    if ((this._pendingUniforms.get('debug_view') ?? 0) > 0.5) return null;

    const resW = this._pendingUniforms.get('resolution_x') ?? 0;
    const resH = this._pendingUniforms.get('resolution_y') ?? 0;
    if (!(resW >= 1) || !(resH >= 1)) return null;

    const body = this._glassBodyUnion();
    if (!body) return null;
    let [x0, y0, x1, y1] = body;

    const shadowMax = Math.max(this._pendingUniforms.get('shadow_max_radius') ?? 0, 5);
    const shadowRadius = Math.max(this._pendingUniforms.get('shadow_radius') ?? 0, 0);
    const shadowIntensity = this._pendingUniforms.get('shadow_intensity') ?? 0;
    const reach = (this._multiRegion || !(shadowIntensity > 0))
      ? 0
      : Math.min(shadowRadius, shadowMax);

    // The edge feather widens the body itself, and the rim/AO bands live
    // inside it. 2px of slack absorbs the rounding.
    const feather = Math.max(this._pendingUniforms.get('edge_smoothing') ?? 0, 0.75);
    const m = Math.ceil(reach + feather + 2);

    x0 -= m; y0 -= m; x1 += m; y1 += m;

    // The panel fallback fill is drawn from panel_rect_* wherever
    // panel_bg_a > 0, independently of the glass body — including from the
    // first early exit. Nothing calls setPanelBackgroundColor() today, so
    // this is dead, but it must not become a clipping bug if it is wired up.
    if ((this._pendingUniforms.get('panel_bg_a') ?? 0) > 0) {
      const px = this._pendingUniforms.get('panel_rect_x') ?? 0;
      const py = this._pendingUniforms.get('panel_rect_y') ?? 0;
      const pw = this._pendingUniforms.get('panel_rect_w') ?? 0;
      const ph = this._pendingUniforms.get('panel_rect_h') ?? 0;
      if (pw > 0 && ph > 0) {
        x0 = Math.min(x0, px - 2); y0 = Math.min(y0, py - 2);
        x1 = Math.max(x1, px + pw + 2); y1 = Math.max(y1, py + ph + 2);
      }
    }

    const maxW = Math.round(resW);
    const maxH = Math.round(resH);
    const bx = Math.max(0, Math.floor(x0));
    const by = Math.max(0, Math.floor(y0));
    const bw = Math.min(maxW, Math.ceil(x1)) - bx;
    const bh = Math.min(maxH, Math.ceil(y1)) - by;
    if (!(bw >= 2) || !(bh >= 2)) return null;
    if (bw * bh >= maxW * maxH * LiquidEffect.COMPOSITE_RECT_MIN_SAVING) return null;

    return [bx, by, bw, bh];
  }


  /**
   * [PERF] The union of the glass BODIES the shader will draw, as
   * [x0, y0, x1, y1] in the shader's coordinate space (`resolution_x/y`),
   * or null when there is nothing to draw.
   *
   * The rect a manager hands us is the BACKGROUND actor's box; the body
   * inside it is inset by `padding` on every side, which is exactly what the
   * shader does (`actual_size = size - padding * 2`, in both the single-rect
   * branch and findActiveRegion()). The dock branch insets by a further
   * edgeFeather * 2, which is deliberately not replicated — erring larger is
   * the safe direction. The inset matters most for application windows,
   * where `padding` is the shadow margin and reaches 120px.
   */
  private _glassBodyUnion(): number[] | null {
    const pad = Math.max(this._pendingUniforms.get('padding') ?? 0, 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const rects = this._multiRegion ? this._regionRects : [this._glassRect];
    for (const r of rects) {
      const [rx, ry, rw, rh] = r;
      if (!(rw > 0) || !(rh > 0)) continue;
      // Never let the inset turn the box inside out; the shader clamps the
      // half-size to 1px, so a rect smaller than 2*padding is a 2px box at
      // its own centre.
      const ix = Math.min(pad, Math.max(rw / 2 - 1, 0));
      const iy = Math.min(pad, Math.max(rh / 2 - 1, 0));
      if (rx + ix < x0) x0 = rx + ix;
      if (ry + iy < y0) y0 = ry + iy;
      if (rx + rw - ix > x1) x1 = rx + rw - ix;
      if (ry + rh - iy > y1) y1 = ry + rh - iy;
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return [x0, y0, x1, y1];
  }

  /**
   * [PERF] Works out which part of the actor actually has to be blurred.
   *
   * Returns integer [x, y, w, h] in the shader's own coordinate space
   * (`resolution_x/y`, the same space as dock_x/y/w/h), or null for "blur
   * everything" — the pre-existing behavior, used whenever the answer is
   * uncertain or not worth it.
   *
   * The margin is the distance a visible pixel's sample can travel away from
   * the glass rect:
   *
   *   - Refraction. getDisplacement() returns
   *     (refractedRay.xy / safe_z) * displacement_scale / minRes, in UV, so in
   *     pixels it is bounded by tan(asin(1/ior)) * displacement_scale *
   *     resolution / minRes. safe_z's own floor of 0.15 caps the ratio at
   *     1/0.15 for an ior approaching 1, and the shader additionally clamps
   *     the UV displacement to 0.30 — both bounds are applied here too, so
   *     this is an upper bound on the shader's behavior, not an estimate.
   *   - The 4-tap RGSS spread (at most 2.5px) and the edge feather.
   *
   * The drop shadow deliberately does NOT extend the rect: outside the body
   * `alpha` is 0, so `litColor * alpha` — the only term the blur feeds — is 0
   * there regardless of what layer 1 contains.
   */
  /**
   * [PERF ①] The rect of the CAPTURE that this glass can possibly need, in
   * shader space (= liquidBox-local pixels, the same space _computeBlurRect()
   * and the dock_x/y/w/h uniforms use).
   *
   * Why this exists separately from _computeBlurRect():
   *
   *   _computeBlurRect() answers "which part of the capture has to be
   *   BLURRED", and is allowed to return null whenever blurring the whole
   *   actor is no worse (BLUR_RECT_MIN_SAVING), or when the blur sub-rect
   *   feature is switched off. This one answers "which part of the capture
   *   has to be DRAWN AT ALL", which is a different question with a
   *   different safety margin and must stay available even when the blur
   *   sub-rect is off.
   *
   * The margin on top of the glass body is:
   *   - the refraction reach (same derivation as _computeBlurRect(): the
   *     shader samples the background through the displaced UV, so anything
   *     a refracted ray can reach must exist in the capture),
   *   - plus the blur's own reach. The blur passes sample the capture around
   *     each texel; if the capture were cleared exactly at the blur rect's
   *     border, those taps would pull in transparent pixels and smear them
   *     back inward. radius is a sigma in original-resolution pixels and is
   *     clamped to 30 by _setGaussianBlurRadius(), so 3 sigma is the whole
   *     of it.
   *
   * Deliberately NOT tightened to the blur rect: the cost being removed here
   * is fill rate over the REST of the monitor (a full-screen wallpaper clone
   * plus every window clone), so a hundred extra pixels of margin costs
   * nothing and buys immunity to an off-by-a-frame geometry read.
   */
  /** Shader-space size of this glass, i.e. the resolution_x/y uniforms. */
  getResolution(): [number, number] {
    return [
      this._pendingUniforms.get('resolution_x') ?? 0,
      this._pendingUniforms.get('resolution_y') ?? 0,
    ];
  }

  // [DIAG] The capture clip rect syncGlassCaptureClip() applied last, purely
  // so global._lgGlass.dump() can show it. Written from utils.ts.
  declare _lgCaptureClip: number[] | null;

  getCaptureClipRect(): number[] | null {
    const resW = this._pendingUniforms.get('resolution_x') ?? 0;
    const resH = this._pendingUniforms.get('resolution_y') ?? 0;
    if (!(resW >= 1) || !(resH >= 1)) return null;

    const body = this._glassBodyUnion();
    if (!body) return null;
    const [x0, y0, x1, y1] = body;

    // Refraction reach — identical derivation to _computeBlurRect().
    const ior = this._pendingUniforms.get('ior') ?? 1.5;
    const dispScale = this._pendingUniforms.get('displacement_scale') ?? 0;
    const eta = 1.0 / Math.max(ior, 1.001);
    const bend = Math.min(eta / Math.sqrt(Math.max(1 - eta * eta, 1e-6)), 1 / 0.15);
    const minRes = Math.max(Math.min(resW, resH), 1);
    const dispUV = Math.min(0.30, bend * Math.max(dispScale, 0) / minRes);

    const feather = Math.max(this._pendingUniforms.get('edge_smoothing') ?? 0, 0.75);
    const blurReach = 3 * Math.max(Math.min(this._targetRadius, 30), 0);
    const extra = LiquidEffect.BLUR_RECT_MIN_MARGIN + feather + 2.5 +
      blurReach + LiquidEffect.CAPTURE_CLIP_EXTRA_MARGIN;

    const mx = Math.ceil(dispUV * resW + extra);
    const my = Math.ceil(dispUV * resH + extra);

    const maxW = Math.round(resW);
    const maxH = Math.round(resH);
    let cx = Math.max(0, Math.floor(x0 - mx));
    let cy = Math.max(0, Math.floor(y0 - my));
    let cw = Math.min(maxW, Math.ceil(x1 + mx)) - cx;
    let ch = Math.min(maxH, Math.ceil(y1 + my)) - cy;
    if (!(cw >= 2) || !(ch >= 2)) return null;

    // Quantised like the blur rect so a menu animating by a pixel does not
    // rewrite the clip (and therefore damage the whole glass) every frame.
    const q = LiquidEffect.BLUR_RECT_QUANTUM;
    cw = Math.min(maxW, Math.ceil(cw / q) * q);
    ch = Math.min(maxH, Math.ceil(ch / q) * q);
    cx = Math.max(0, Math.min(cx, maxW - cw));
    cy = Math.max(0, Math.min(cy, maxH - ch));

    // Covering (almost) the whole actor already: clipping would only add a
    // scissor for nothing. Application windows land here — their clipBox
    // already clips the clone subtree to the glass box.
    if (cw * ch >= resW * resH * LiquidEffect.CAPTURE_CLIP_MIN_SAVING) return null;

    return [cx, cy, cw, ch];
  }

  private _computeBlurRect(): number[] | null {
    if (!this._blurRectEnabled) return null;

    const resW = this._pendingUniforms.get('resolution_x') ?? 0;
    const resH = this._pendingUniforms.get('resolution_y') ?? 0;
    if (!(resW >= 1) || !(resH >= 1)) return null;

    const body = this._glassBodyUnion();
    if (!body) return null;
    const [x0, y0, x1, y1] = body;

    const ior = this._pendingUniforms.get('ior') ?? 1.5;
    const dispScale = this._pendingUniforms.get('displacement_scale') ?? 0;
    const eta = 1.0 / Math.max(ior, 1.001);
    // tan(asin(eta)), i.e. the largest |xy/z| a refracted ray can reach,
    // capped the way the shader's safe_z floor caps it.
    const bend = Math.min(eta / Math.sqrt(Math.max(1 - eta * eta, 1e-6)), 1 / 0.15);
    const minRes = Math.max(Math.min(resW, resH), 1);
    const dispUV = Math.min(0.30, bend * Math.max(dispScale, 0) / minRes);
    const dispX = dispUV * resW;
    const dispY = dispUV * resH;

    const feather = Math.max(this._pendingUniforms.get('edge_smoothing') ?? 0, 0.75);
    const extra = LiquidEffect.BLUR_RECT_MIN_MARGIN + feather + 2.5;

    const mx = Math.ceil(dispX + extra);
    const my = Math.ceil(dispY + extra);

    const maxW = Math.round(resW);
    const maxH = Math.round(resH);
    let bx = Math.max(0, Math.floor(x0 - mx));
    let by = Math.max(0, Math.floor(y0 - my));
    let bw = Math.min(maxW, Math.ceil(x1 + mx)) - bx;
    let bh = Math.min(maxH, Math.ceil(y1 + my)) - by;
    if (!(bw >= 2) || !(bh >= 2)) return null;

    // Round the size up (see BLUR_RECT_QUANTUM) and pull the origin back so
    // the grown rect still contains the region it was computed to cover.
    const q = LiquidEffect.BLUR_RECT_QUANTUM;
    bw = Math.min(maxW, Math.ceil(bw / q) * q);
    bh = Math.min(maxH, Math.ceil(bh / q) * q);
    bx = Math.max(0, Math.min(bx, maxW - bw));
    by = Math.max(0, Math.min(by, maxH - bh));

    // Not worth it when it barely shrinks anything.
    if (bw * bh >= resW * resH * LiquidEffect.BLUR_RECT_MIN_SAVING) return null;

    return [bx, by, bw, bh];
  }

  static USE_CROP_PASS = true;

  /**
   * (Re)allocates the crop FBO/texture at size (w, h), reusing the existing
   * one if the size hasn't changed.
   */
  private _ensureCropTarget(ctx: Cogl.Context, w: number, h: number): boolean {
    if (this._cropTexture && this._cropFbo &&
      this._cropPoolW === w && this._cropPoolH === h) {
      return true;
    }

    // Just clear the old references and let the GC handle them (same
    // reasoning as _destroyTexturePool).
    this._cropTexture = null;
    this._cropFbo = null;
    this._cropPoolW = 0;
    this._cropPoolH = 0;

    try {
      const tex = Cogl.Texture2D.new_with_size(ctx, w, h);
      const fbo = Cogl.Offscreen.new_with_texture(tex);
      this._cropTexture = tex;
      this._cropFbo = fbo;
      this._cropPoolW = w;
      this._cropPoolH = h;
      return true;
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to create crop texture (${w}x${h}): ${e}`);
      return false;
    }
  }

  /**
   * [FIX round 11] Node-based crop pass.
   *
   * Round 10 removed the crop entirely and expressed the capture's padding as
   * a UV sub-rect instead, which meant layer 0 (the raw capture) and layer 1
   * (a padding-free pool texture) needed different coordinate ranges in the
   * composite. That required Clutter.PaintNode.add_multitexture_rectangle(),
   * which is NOT safely callable from GJS on this build: its introspection
   * annotation types text_coords as a plain number rather than an array, so
   * passing an array makes the native side read a JS object as a float
   * pointer. That is what crashed the shell with SIGSEGV.
   *
   * (Note Cogl.Framebuffer.draw_multitextured_rectangle IS annotated
   * correctly — only the Clutter PaintNode variant is broken, so the fix
   * cannot simply mirror the old immediate-mode call.)
   *
   * So the crop comes back, but as a paint node like every other pass. The
   * original reason for removing it — that its intermediate FBO served
   * last frame's content — no longer applies: that was never about the crop
   * itself, it was about immediate-mode drawing running before the capture
   * had been rendered. As a node it executes after the capture, so it reads
   * current content.
   *
   * With a padding-free full-resolution texture available again, every
   * downstream consumer (blur input and both composite layers) uses the plain
   * 0..1 range, and no multitexture coordinates are needed anywhere.
   *
   * Costs one full-resolution pass per frame per window. If that ever matters,
   * the way to avoid it is a per-layer texture matrix
   * (Cogl.Pipeline.set_layer_matrix) on layer 0, which would let the padding
   * be expressed without either an extra pass or multitexture coordinates —
   * worth trying only once the current path is confirmed correct.
   */
  private _addCropPassNode(
    parentNode: any, ctx: Cogl.Context, srcTex: Cogl.Texture,
    srcW: number, srcH: number, allocW: number, allocH: number, uv: number[]
  ): Cogl.Texture {
    if (allocW === srcW && allocH === srcH) return srcTex;
    if (!this._passthroughPipeline) return srcTex;
    if (!this._ensureCropTarget(ctx, allocW, allocH)) return srcTex;

    // Snippet-less 1-tap copy; see _passthroughPipeline.
    const pipeline = this._passPipeline('crop', this._passthroughPipeline);
    pipeline.set_layer_texture(0, srcTex);

    this._addPassNode(parentNode, this._cropFbo, pipeline, allocW, allocH, uv);
    return this._cropTexture!;
  }

  private _destroyCropTarget(): void {
    this._cropTexture = null;
    this._cropFbo = null;
    this._cropPoolW = 0;
    this._cropPoolH = 0;
  }

  /**
   * [FIX round 10] Returns a private copy of `base` dedicated to one pass.
   *
   * Immediate-mode drawing let every pass share one pipeline object: set the
   * uniforms, draw, then overwrite the uniforms for the next pass. Paint
   * nodes execute AFTER vfunc_paint_target returns, so a shared pipeline
   * would have every pass drawn with whatever uniform values the LAST pass
   * happened to leave behind. Each pass therefore needs its own pipeline.
   *
   * Cogl pipelines are copy-on-write, so the copies are cheap, and they are
   * cached and only re-copied when the base pipeline object itself is
   * replaced (which is what happens when a shader is recompiled — a radius
   * change that only updates kernel_scale keeps the same object, and the
   * uniform is set on the copy every frame anyway).
   *
   * Blending is forced to plain replace so each pass overwrites its target
   * rather than compositing onto the previous frame's contents. The
   * immediate-mode code got that from an explicit clear before every draw;
   * a LayerNode does no clearing, and since every pass covers its whole
   * target rect, replace-blending achieves the same result without one.
   */
  private _passPipeline(key: string, base: Cogl.Pipeline): Cogl.Pipeline {
    const cached = this._passPipelines.get(key);
    if (cached && cached.base === base) return cached.copy;

    const copy = base.copy();
    try {
      copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
    } catch (e) {
      this._logger?.error(`[Liquid Glass] set_blend failed for pass '${key}': ${e}`);
    }
    this._passPipelines.set(key, { base, copy });
    return copy;
  }

  /**
   * [FIX round 10] Queues one render-to-texture pass as a paint node instead
   * of drawing it immediately.
   *
   * This is the core of the drag-lag fix. vfunc_paint_target() runs while the
   * paint node tree is being BUILT; ClutterOffscreenEffect renders the actor
   * into its capture texture when that tree is later EXECUTED. Immediate-mode
   * Cogl calls therefore sampled the capture before it had been drawn for
   * this frame, yielding the previous frame's contents — the one-frame lag.
   *
   * Adding the pass as a child of the effect's node instead makes it execute
   * after the capture layer node that OffscreenEffect already put there, so
   * it samples this frame's content. The projection is set on the target
   * framebuffer here; that is persistent framebuffer state rather than a
   * queued operation, so setting it at build time is fine.
   */
  private _addPassNode(
    parentNode: any, targetFbo: any, pipeline: Cogl.Pipeline,
    destW: number, destH: number, uv: number[]
  ): void {
    (targetFbo as unknown as CoglFB).orthographic(0, 0, destW, destH, -1, 1);

    const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
    parentNode.add_child(layerNode);

    const drawNode = Clutter.PipelineNode.new(pipeline);
    layerNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }),
      uv[0], uv[1], uv[2], uv[3]
    );
  }

  /**
   * [FIX] Queues the final composite as a paint node.
   *
   * It has to be a node, like every other pass, so it executes after the
   * capture layer node and after the blur passes queued above it. Immediate
   * drawing here only looked correct because Cogl happened to defer it far
   * enough — adding a single flush() was enough to reproduce the same
   * one-frame lag on this path too.
   *
   * Both layers share one coordinate range by construction: the crop pass
   * guarantees layer 0 is padding-free whenever layer 1 is, so
   * add_texture_rectangle is sufficient. This deliberately does NOT use
   * add_multitexture_rectangle — that call segfaults the shell on this build
   * (memo.md 6.1), which is why both layers share one coordinate range.
   */
  private _addCompositeNode(
    parentNode: any, dest: number[], layer0UV: number[], layer1UV: number[]
  ): void {
    if (layer0UV[0] !== layer1UV[0] || layer0UV[1] !== layer1UV[1] ||
      layer0UV[2] !== layer1UV[2] || layer0UV[3] !== layer1UV[3]) {
      // Should be unreachable: the crop pass exists precisely so the two
      // layers always agree. Log once rather than silently misdrawing, since
      // the only remedy available here is to favour layer 0.
      if (!this._uvMismatchWarned) {
        this._uvMismatchWarned = true;
        this._logger?.error(
          '[Liquid Glass] composite layers disagree on UV range ' +
          `(layer0=[${layer0UV}] layer1=[${layer1UV}]); drawing with layer 0's range. ` +
          'This means the crop pass did not run when it was needed.'
        );
      }
    }

    const drawNode = Clutter.PipelineNode.new(this._compositePipeline!);
    parentNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }),
      layer0UV[0], layer0UV[1], layer0UV[2], layer0UV[3]
    );
  }

  // ─── Uniform helpers ─────────────────────────────────────────────────────────

  /**
   * Sets a vec2 uniform on a pipeline. Cogl caches the uniform location
   * internally, so calling this every frame is safe.
   */
  private _setPipelineVec2(
    pipeline: Cogl.Pipeline, name: string, x: number, y: number
  ): void {
    const loc = pipeline.get_uniform_location(name);
    // set_uniform_float(loc, n_components, count, values[])
    pipeline.set_uniform_float(loc, 2, 1, [x, y]);
  }

  /**
   * Sets a scalar float uniform on a pipeline.
   */
  private _setPipelineFloat(
    pipeline: Cogl.Pipeline, name: string, value: number
  ): void {
    const loc = pipeline.get_uniform_location(name);
    pipeline.set_uniform_float(loc, 1, 1, [value]);
  }

  /**
   * Sets a float uniform on the composite pipeline. If the pipeline hasn't
   * been created yet, the value is buffered in _pendingUniforms and applied
   * later in _applyPendingUniforms().
   */
  private _setFloat(name: string, value: number): void {
    // [PERF] _pendingUniforms is the authoritative buffered state, so an
    // unchanged value needs no work at all: it is already in the map, and
    // (if the pipeline exists) already in the pipeline.
    if (this._pendingUniforms.get(name) === value) return;

    this._pendingUniforms.set(name, value);
    this._uniformsDirty = true;
    if (this._compositePipeline) {
      this._applyUniform(name, value);
    }
  }

  /**
   * [PERF] Requests a repaint only if something actually changed since the
   * last one. See _uniformsDirty for why this is safe.
   */
  private _queueRepaintIfDirty(): void {
    if (!this._uniformsDirty) return;
    this._uniformsDirty = false;
    this.queue_repaint();
  }

  private _applyUniform(name: string, value: number): void {
    if (!this._compositePipeline) return;

    // [PERF] Skip the write when the pipeline already holds this exact value.
    // See _appliedUniforms. NaN can never satisfy === so it would be written
    // every time, but no uniform here is ever legitimately NaN.
    if (this._appliedUniforms.get(name) === value) return;

    // Cache the uniform location to avoid a get_uniform_location() call every frame.
    let loc = this._compUniforms.get(name);
    if (loc === undefined) {
      loc = this._compositePipeline.get_uniform_location(name);
      this._compUniforms.set(name, loc);
    }
    // set_uniform_float(loc, 1 component, 1 element, [value])
    this._uniformScratch[0] = value;
    this._compositePipeline.set_uniform_float(loc, 1, 1, this._uniformScratch);
    this._appliedUniforms.set(name, value);
  }

  private _applyPendingUniforms(): void {
    for (const [name, value] of this._pendingUniforms) {
      this._applyUniform(name, value);
    }
    for (const [name, values] of this._pendingUniformArrays) {
      this._applyUniformArray(name, values);
    }
  }

  /**
   * Sets a float ARRAY uniform on the composite pipeline (e.g.
   * `uniform float region_x[16];` in glass.frag). Same buffering behavior as
   * _setFloat(): if the pipeline hasn't been created yet, the value is
   * buffered and applied later in _applyPendingUniforms().
   */
  private _setFloatArray(name: string, values: number[]): void {
    const prev = this._pendingUniformArrays.get(name);
    if (prev && prev.length === values.length) {
      let same = true;
      for (let i = 0; i < values.length; i++) {
        if (prev[i] !== values[i]) { same = false; break; }
      }
      if (same) return;
    }

    // Store a copy: callers reuse and mutate their arrays between frames, so
    // keeping the caller's object would make the comparison above compare a
    // value against itself and never see a change.
    this._pendingUniformArrays.set(name, values.slice());
    this._uniformsDirty = true;
    if (this._compositePipeline) {
      this._applyUniformArray(name, values);
    }
  }

  private _applyUniformArray(name: string, values: number[]): void {
    if (!this._compositePipeline) return;

    // [PERF] Same dedup as _applyUniform, elementwise. The copy kept here is
    // deliberately ours: callers hand us arrays they may mutate in place, so
    // comparing against the array object itself would miss changes.
    const applied = this._appliedUniformArrays.get(name);
    if (applied && applied.length === values.length) {
      let same = true;
      for (let i = 0; i < values.length; i++) {
        if (applied[i] !== values[i]) { same = false; break; }
      }
      if (same) return;
    }

    let loc = this._compUniformArrays.get(name);
    if (loc === undefined) {
      loc = this._compositePipeline.get_uniform_location(name);
      this._compUniformArrays.set(name, loc);
    }
    // set_uniform_float(loc, 1 component, count elements, values[])
    this._compositePipeline.set_uniform_float(loc, 1, values.length, values);
    this._appliedUniformArrays.set(name, values.slice());
  }

  // ─── Cogl context lookup ─────────────────────────────────────────────────────

  private _getCoglContext(): Cogl.Context | null {
    try {
      // Clutter.get_default_backend() is available from GJS.
      // On GNOME 50, get_cogl_context() returns a Cogl.Context.
      const backend = Clutter.get_default_backend();
      return backend.get_cogl_context() as Cogl.Context;
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to obtain the Cogl context: ${e}`);
      return null;
    }
  }

  // ─── GSettings bindings ───────────────────────────────────────────────────────

  _bindSettings(): void {
    const mappings: { key: string; uniform: string }[] = [
      { key: 'glass-max-z', uniform: 'max_z' },
      { key: 'glass-displacement-scale', uniform: 'displacement_scale' },
      { key: 'glass-edge-smoothing', uniform: 'edge_smoothing' },
      { key: 'glass-profile-shape-n', uniform: 'profile_shape_n' },
      { key: 'glass-ior', uniform: 'ior' },
      { key: 'glass-chroma-strength', uniform: 'chroma_strength' },
      { key: 'glass-specular-intensity', uniform: 'specular_intensity' },
      { key: 'glass-shininess', uniform: 'shininess' },
      { key: 'glass-rim-width', uniform: 'rim_width' },
      { key: 'glass-rim-intensity', uniform: 'rim_intensity' },
      { key: 'glass-rim-directional-power', uniform: 'rim_directional_power' },
      { key: 'glass-rim-power', uniform: 'rim_power' },
      { key: 'glass-rim-light-color-intensity', uniform: 'rim_light_color_intensity' },
      { key: 'glass-sheen-intensity', uniform: 'sheen_intensity' },
      { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' },
      { key: 'shadow-radius', uniform: 'shadow_radius' },
      { key: 'shadow-intensity', uniform: 'shadow_intensity' },
      // Inner edge AO darkening — independent of rim_width and of the
      // outer drop shadow's radius/intensity pair above.
      { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
      { key: 'glass-ao-radius', uniform: 'ao_radius' },
    ];

    const settings = this._settings;
    if (!settings) return;

    mappings.forEach(map => {
      // Apply the initial value.
      this._setFloat(map.uniform, settings.get_double(map.key));
      // Watch for changes.
      const id = settings.connect(`changed::${map.key}`, () => {
        this._setFloat(map.uniform, settings.get_double(map.key));
      });
      this._settingsIds.push(id);
    });

    // ── glass-blur-downscale (int): 2 = half res, 4 = quarter res ─────────
    // [PERF] A quality/cost trade the user opts into: the blur runs on a
    // quarter-size buffer, so every pass touches a quarter of the pixels, at
    // the cost of a visibly coarser blur. Read before blur-method below,
    // because the Gaussian kernel is expressed in texels of the level this
    // chooses.
    const applyDownscale = () => {
      const factor = settings.get_int('glass-blur-downscale') >= 4 ? 4 : 2;
      if (factor === this._blurDownscale) return;
      this._blurDownscale = factor;
      // Level 0 changes size, so the pool is stale; vfunc_paint_target
      // rebuilds it on the next paint once it sees the mismatch.
      this._destroyTexturePool();
      this.setBlurRadius(this._targetRadius);
      this.queue_repaint();
    };
    applyDownscale();
    const downscaleId = settings.connect('changed::glass-blur-downscale', applyDownscale);
    this._settingsIds.push(downscaleId);

    // ── blur-method (int): 0 = Gaussian, 1 = Dual Kawase ──────────────────
    // Assumes the GSettings schema defines this key as an int.
    const applyBlurMethod = () => {
      const raw = settings.get_int('blur-method');
      this.setBlurMethod(raw === 0 ? 0 : 1);
    };
    applyBlurMethod();
    const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
    this._settingsIds.push(blurMethodId);

    // ── glass-debug-diagnostics (bool) ────────────────────────────────────
    // Read into a plain field rather than calling get_boolean() from the
    // paint path: that call is a GSettings lookup, which is exactly the kind
    // of per-paint cost this flag exists to remove.
    const applyDiagFlag = () => {
      this._diagEnabled = settings.get_boolean('glass-debug-diagnostics');
    };
    applyDiagFlag();
    const diagId = settings.connect('changed::glass-debug-diagnostics', applyDiagFlag);
    this._settingsIds.push(diagId);
  }

  // ─── Public API (compatible with the previous ShaderEffect-based interface) ──

  cleanup(): void {
    _liveEffects.delete(this);
    // The frame-serial hook is one signal shared by every instance; drop it
    // once nothing is left to use it, so disabling the extension leaves
    // nothing connected to the stage.
    if (_liveEffects.size === 0) _releaseFrameSerialHook();

    // Disconnect GSettings signal handlers.
    if (this._settings && this._settingsIds) {
      this._settingsIds.forEach(id => this._settings?.disconnect(id));
      this._settingsIds = [];
    }

    // Free the texture pool (reference clear only — run_dispose() would double-free).
    this._destroyTexturePool();

    // Clear pipeline references (GJS's GC reclaims the VRAM).
    // Never call run_dispose() here — it would double-unref a GJS-managed object.
    this._downsamplePipeline = null;
    this._upsamplePipeline = null;
    this._passthroughPipeline = null;
    this._boxDownPipeline = null;
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._compositePipeline = null;
    this._compUniforms.clear();
    this._pendingUniforms.clear();
    this._compUniformArrays.clear();
    this._pendingUniformArrays.clear();
    this._appliedUniforms.clear();
    this._appliedUniformArrays.clear();

    // Reset the dynamic Gaussian shader generation state too.
    this._gaussianKernel = null;
    this._pendingGaussianKernel = null;
    this._gaussianPipelineDirty = false;
    this._gaussianBaseSigma = 0;
    this._gaussianScale = 1.0;
    this._gaussianFetchPairs = 0;
  }

  /**
   * [PERF/DEBUG] Turns glass.frag's two early exits on/off at runtime.
   *
   * They are meant to be exactly equivalent to the full per-pixel path, so
   * anything that looks different with them on is a bug in the thresholds.
   * Being able to flip this inside a running session — rather than
   * rebuilding and reproducing the state again — is what makes such a
   * report cheap to settle. Reachable as global._lgGlass.earlyExit(bool).
   */
  /**
   * [PERF/DEBUG] Turns the crop pass on/off at runtime; see USE_CROP_PASS.
   * Reachable as global._lgGlass.cropPass(bool).
   */
  setCropPassEnabled(enabled: boolean): void {
    this._cropPassEnabled = enabled;
    this.queue_repaint();
  }

  /**
   * [PERF/DEBUG] Turns the blurred sub-rect on/off at runtime; see
   * USE_BLUR_RECT. Off means the blur runs over the whole capture again,
   * which is what it did before that optimization existed.
   */
  setBlurRectEnabled(enabled: boolean): void {
    this._blurRectEnabled = enabled;
    // The pool is keyed on the blurred region's size, so it is stale now.
    this._destroyTexturePool();
    this.queue_repaint();
  }

  /**
   * [PERF/DEBUG] Turns the composite sub-rect on/off at runtime; see
   * USE_COMPOSITE_RECT. Off means glass.frag runs over the whole capture
   * again, which is what it did before that optimization existed.
   */
  setCompositeRectEnabled(enabled: boolean): void {
    this._compositeRectEnabled = enabled;
    this.queue_repaint();
  }

  setEarlyExitEnabled(enabled: boolean): void {
    this._setFloat('early_exit_enabled', enabled ? 1.0 : 0.0);
    this._queueRepaintIfDirty();
  }

  /**
   * [DEBUG] Diagnostic visualisation mode; see glass.frag's debug_view.
   * 0 = normal, 1 = shadow/shape mask view. Reachable as
   * global._lgGlass.debugView(n).
   */
  setDebugView(mode: number): void {
    this._setFloat('debug_view', mode);
    this._queueRepaintIfDirty();
  }

  setIsDock(isDock: boolean): void {
    this._setFloat('isDock', isDock ? 1.0 : 0.0);
  }

  /**
   * Enables/disables the rim light + specular + sheen "glass surface
   * glint" terms as a group (see addedLight in glass.frag). The outer
   * drop shadow and inner AO edge-darkening are unaffected either way —
   * they're computed independently of this uniform. Used by
   * applicationManager.ts to give application windows a plainer
   * "shadow + AO only" edge instead of the dock/menu-style glass glint,
   * without touching the shared rim/specular/sheen settings that dock,
   * menu, notification, quick-settings and OSD still use.
   */
  setSurfaceLightEnabled(enabled: boolean): void {
    this._setFloat('surface_light_enabled', enabled ? 1.0 : 0.0);
    this._queueRepaintIfDirty();
  }

  setPadding(pad: number): void {
    this._setFloat('padding', pad);
  }

  /**
   * Tells the shader how much room (in px) the drop shadow actually
   * has to render outward, independent of the small optical `padding`
   * uniform. Should be kept in sync with dockManager's CLIP_PADDING (minus
   * a small safety margin) so shadow_radius can use its full prefs.js
   * range (0-100) without being invisibly clamped or hitting a hard edge
   * at the bgActor's own clip boundary.
   */
  setShadowMaxRadius(radius: number): void {
    this._setFloat('shadow_max_radius', radius);
  }

  /**
   * [DEBUG] Forces glass.frag (and the downsample/upsample shaders) to be
   * re-read from disk and recompiled into fresh Cogl.Pipelines on the next
   * paint.
   *
   * Why this exists: _initPipelines() only ever runs once per LiquidEffect
   * instance, guarded by `if (!this._compositePipeline)` in
   * vfunc_paint_target(). The instance itself only gets recreated when
   * dockManager tears down and rebuilds the effect (extension disable/
   * re-enable, or the dock actor being destroyed). So editing glass.frag on
   * disk while the shell keeps running has NO effect on what's on screen
   * until one of those happens — the exact same (possibly still-buggy)
   * compiled shader keeps executing every frame regardless of what the
   * source file now says. This silently made prior shader fixes look like
   * they hadn't worked. Call this after saving shader edits to pick them up
   * immediately instead.
   */
  reloadShaders(): void {
    this._compositePipeline = null;
    this._downsamplePipeline = null;
    this._upsamplePipeline = null;
    this._passthroughPipeline = null;
    this._boxDownPipeline = null;
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._gaussianKernel = null;
    this._gaussianFetchPairs = 0;
    this._compUniforms.clear();
    this._compUniformArrays.clear();
    this._appliedUniforms.clear();
    this._appliedUniformArrays.clear();
    // _pendingUniforms/_pendingUniformArrays are intentionally left intact:
    // they hold every uniform value currently in effect, and
    // _initPipelines() re-applies all of them to the freshly-compiled
    // pipeline via _applyPendingUniforms().
    // Re-derive the Gaussian kernel (if that's the active blur method) so
    // _gaussianPipelineDirty / _pendingGaussianKernel get set correctly
    // instead of leaving the Gaussian pass permanently skipped.
    this.setBlurRadius(this._targetRadius);
    this.queue_repaint();
  }

  setTintColor(r: number, g: number, b: number): void {
    this._setFloat('tint_r', r);
    this._setFloat('tint_g', g);
    this._setFloat('tint_b', b);
    this._queueRepaintIfDirty();
  }

  // Sets the flat fallback fill composited underneath the glass/shadow
  // result, for areas outside every glass region — see glass.frag's
  // panel_bg_* uniforms for the full rationale. Pass alpha = 0 (the
  // default) to disable it entirely.
  setPanelBackgroundColor(r: number, g: number, b: number, a: number): void {
    this._setFloat('panel_bg_r', r);
    this._setFloat('panel_bg_g', g);
    this._setFloat('panel_bg_b', b);
    this._setFloat('panel_bg_a', a);
    this._queueRepaintIfDirty();
  }

  // [FIX] The panel's REAL widget bounds (monitor-relative px, no
  // SHADER_PADDING/CLIP_PADDING/glassExpand) — masks
  // setPanelBackgroundColor()'s fallback fill to this rect in glass.frag so
  // it can't bleed into the sampling-headroom margin around bgActor. See
  // the panel_rect_* uniform comments in glass.frag for the full
  // rationale. Harmless to call regardless of panel_bg_a.
  setPanelRect(x: number, y: number, w: number, h: number): void {
    this._setFloat('panel_rect_x', x);
    this._setFloat('panel_rect_y', y);
    this._setFloat('panel_rect_w', w);
    this._setFloat('panel_rect_h', h);
    this._queueRepaintIfDirty();
  }

  setTintStrength(strength: number): void {
    this._setFloat('tint_strength', strength);
    this._queueRepaintIfDirty();
  }

  setCornerRadius(radius: number): void {
    this._setFloat('corner_radius', radius);
    this._queueRepaintIfDirty();
  }

  setAnimationScale(scale: number): void {
    const settings = this._settings;
    if (!settings) return;
    this._setFloat('displacement_scale',
      settings.get_double('glass-displacement-scale') * scale);
    this._setFloat('max_z',
      settings.get_double('glass-max-z') * scale);
    this._setFloat('chroma_strength',
      settings.get_double('glass-chroma-strength') * scale);
    this._queueRepaintIfDirty();
  }

  setPointerPosition(x: number, y: number, intensity: number): void {
    this._setFloat('pointer_x', x);
    this._setFloat('pointer_y', y);
    this._setFloat('intensity', intensity);
  }

  /**
   * Syncs the actor's logical size to the shader's resolution uniform.
   *
   * The texture pool itself is rebuilt automatically inside
   * vfunc_paint_target based on get_texture()'s size, so no extra work is
   * needed here.
   */
  setResolution(width: number, height: number): void {
    this._setFloat('resolution_x', width);
    this._setFloat('resolution_y', height);
    this._queueRepaintIfDirty();
  }

  /**
   * Full-screen FBO mode: passes the dock's monitor-relative geometry to the
   * shader (see the dock_x/y/w/h comments in glass.frag for details).
   */
  setGlassGeometry(x: number, y: number, w: number, h: number): void {
    this._setFloat('dock_x', x);
    this._setFloat('dock_y', y);
    this._setFloat('dock_w', w);
    this._setFloat('dock_h', h);
    // [PERF] Mirrored for _computeBlurRect(); reading it back out of
    // _pendingUniforms every paint would work too, but four Map lookups per
    // paint per surface is exactly the kind of cost that section removes.
    this._glassRect[0] = x;
    this._glassRect[1] = y;
    this._glassRect[2] = w;
    this._glassRect[3] = h;
    this._queueRepaintIfDirty();
  }

  /**
   * Enables/disables multi-region compositing mode (see glass.frag's
   * multi_region_mode uniform). When enabled, setGlassRegions() draws up to
   * MAX_GLASS_REGIONS independent small rounded-rect "windows" instead of
   * the single dock_x/y/w/h rect. Used by Quick Settings' "Toggles"
   * apply-to mode; every other consumer leaves this at its default (false)
   * and is completely unaffected.
   */
  setMultiRegionMode(enabled: boolean): void {
    this._setFloat('multi_region_mode', enabled ? 1.0 : 0.0);
    this._multiRegion = enabled;
    this._queueRepaintIfDirty();
  }

  // [PERF] "Window background rendering gets noticeably more expensive
  // (CLUTTER_SHOW_FPS: per-frame paint time roughly triples, ~1.8ms ->
  // ~5-6ms, though FPS itself stays near 60) the moment a window is open,
  // and moving it is the worst case." Single master switch for every
  // drag-time cost-reduction change below — false keeps current behavior
  // byte-for-byte; only flip to true to test the combined effect. Flip
  // this one line, nothing else, to compare.
  static DRAG_PERF_MODE_ENABLED = true;

  // [PERF] Batches every queue_repaint() call made between beginBatch()
  // and endBatch() into at most one. _syncState() in applicationManager.ts
  // calls roughly a dozen individual setXxx() methods per window per
  // frame — several of them (see setSurfaceLightEnabled, setMultiRegionMode
  // above, and others below) each call queue_repaint() independently, so a
  // single frame's worth of updates for one window was queuing that many
  // separate repaint requests. Clutter itself coalesces same-frame
  // queue_redraw()s on a plain actor, but queue_repaint() is Clutter.Effect
  // API with its own per-call bookkeeping (walking to the effect's actor
  // and invalidating it), so the per-call overhead here was real, not just
  // theoretical — this was the direct cause the FPS counter's rising
  // average frame time pointed at.
  private declare _batchDepth: number;
  private declare _batchDirty: boolean;

  beginBatch(): void {
    if (!LiquidEffect.DRAG_PERF_MODE_ENABLED) return;
    this._batchDepth = (this._batchDepth || 0) + 1;
  }

  endBatch(): void {
    if (!LiquidEffect.DRAG_PERF_MODE_ENABLED) return;
    if (!this._batchDepth) return; // beginBatch() was never called, or the flag flipped mid-batch
    this._batchDepth--;
    if (this._batchDepth === 0 && this._batchDirty) {
      this._batchDirty = false;
      // @ts-ignore — calling the inherited Clutter.Effect implementation
      // directly, bypassing our own override below.
      Clutter.Effect.prototype.queue_repaint.call(this);
    }
  }

  // Overrides (does not shadow via vfunc_, so this is a plain JS-level
  // method override — GJS resolves method lookups the normal JS-prototype
  // way, so every one of this file's existing `this.queue_repaint()` call
  // sites transparently goes through here without needing to change any
  // of them individually) the inherited Clutter.Effect.queue_repaint().
  queue_repaint(): void {
    if (LiquidEffect.DRAG_PERF_MODE_ENABLED && this._batchDepth) {
      this._batchDirty = true;
      return;
    }
    // @ts-ignore
    super.queue_repaint();
  }

  /**
   * Supplies the list of glass regions to draw when multi-region mode is
   * enabled. Each region is a small rounded rect (monitor-relative pixel
   * coordinates, same space as setGlassGeometry()/setResolution()) carrying
   * its own BASE color — the color the underlying element actually paints
   * itself — plus how strongly that base color should be applied. Silently
   * truncated to LiquidEffect.MAX_GLASS_REGIONS (must match glass.frag's
   * MAX_GLASS_REGIONS #define) if more are supplied.
   *
   * [FIX-8] `tintR/G/B` used to arrive pre-blended with the user's configured
   * tint color, leaving the shader's single `tint_strength` to scale the
   * element's own color and the user's tint together. They are separate
   * layers now: the base color/strength here, and setTintColor()/
   * setTintStrength() for the custom tint on top. `baseStrength` 0 means
   * "this region has no usable base color", which is how a region whose real
   * color could not be sampled opts out.
   */
  setGlassRegions(regions: {
    x: number; y: number; w: number; h: number;
    tintR: number; tintG: number; tintB: number;
    baseStrength?: number;
  }[]): void {
    const clamped = regions.slice(0, LiquidEffect.MAX_GLASS_REGIONS);

    const rx = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const ry = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const rw = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const rh = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
    const rTintR = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
    const rTintG = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
    const rTintB = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
    const rBaseStrength = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);

    clamped.forEach((region, i) => {
      rx[i] = region.x;
      ry[i] = region.y;
      rw[i] = region.w;
      rh[i] = region.h;
      rTintR[i] = region.tintR;
      rTintG[i] = region.tintG;
      rTintB[i] = region.tintB;
      rBaseStrength[i] = Math.max(0.0, Math.min(1.0, region.baseStrength ?? 0.0));
    });

    // [PERF] Mirrored for _computeBlurRect() — see setGlassGeometry().
    this._regionRects = clamped.map(r => [r.x, r.y, r.w, r.h]);

    this._setFloat('region_count', clamped.length);
    this._setFloatArray('region_x', rx);
    this._setFloatArray('region_y', ry);
    this._setFloatArray('region_w', rw);
    this._setFloatArray('region_h', rh);
    this._setFloatArray('region_tint_r', rTintR);
    this._setFloatArray('region_tint_g', rTintG);
    this._setFloatArray('region_tint_b', rTintB);
    this._setFloatArray('region_base_strength', rBaseStrength);
    this._queueRepaintIfDirty();
  }

  setBrightness(brightness: number): void {
    this._setFloat('brightness', brightness);
    this._queueRepaintIfDirty();
  }

  setContrast(contrast: number): void {
    this._setFloat('contrast', contrast);
    this._queueRepaintIfDirty();
  }

  setSaturation(saturation: number): void {
    this._setFloat('saturation', saturation);
    this._queueRepaintIfDirty();
  }

  /**
   * Dynamically switches the blur method.
   *
   * @param method 0: separable Gaussian blur, 1: Dual Kawase blur
   *
   * The Dual Kawase pipelines are already compiled in _initPipelines on the
   * first frame. The Gaussian pipelines are built dynamically: setBlurRadius()
   * computes the kernel for the current radius, and it's lazily compiled on
   * the next vfunc_paint_target only if needed.
   * The texture pool is shared between both methods (see _buildTexturePool),
   * so no manual rebuild is required when switching — queue_repaint() alone
   * is enough for the new method to take effect on the next frame.
   */
  setBlurMethod(method: BlurMethod): void {
    if (this._blurMethod === method) return;
    this._blurMethod = method;
    this.setBlurRadius(this._targetRadius);
    this.queue_repaint();
  }

  /**
   * Dynamically sets the blur radius. The calculation branches depending on
   * the active method (Gaussian / Dual Kawase).
   */
  setBlurRadius(radius: number): void {
    this._targetRadius = radius;

    if (this._blurMethod === 0) {
      this._setGaussianBlurRadius(radius);
      return;
    }

    this._setDualKawaseBlurRadius(radius);
  }

  /**
   * Radius setter for the separable Gaussian blur (dynamic shader generation).
   *
   * Basic approach:
   *   - PASS_COUNT is always fixed to 1. The texture pool only uses a single
   *     w/2 × h/2 level, so changing the radius never triggers a pool
   *     rebuild (avoids visible stutter).
   *   - The number of fetch pairs (tap count) is derived from the radius
   *     (= sigma, in original-resolution pixels). As long as the fetch count
   *     doesn't change, the existing compiled shader is reused as-is and only
   *     the kernel_scale uniform is updated (skips an unnecessary recompile).
   *
   * Derivation:
   *   1. Compute the effective standard deviation sigma in half-resolution
   *      space: sigma = radius / RES_SCALE (RES_SCALE = 2.0; at half
   *      resolution, 1 texel = 2 original pixels).
   *   2. Clamp to a maximum radius of 30px (15 texels in half-res space).
   *   3. Determine how many one-sided taps are needed for the Gaussian
   *      weights to decay close enough to zero (the "3 sigma" rule), then
   *      convert that into a fetch-pair count (2 taps merged per fetch).
   *   4. If the fetch-pair count matches the previous one, skip regenerating
   *      the shader string and recompiling the pipeline — just update
   *      kernel_scale = sigma / base sigma.
   *      If it changed, stage a new kernel in _pendingGaussianKernel to be
   *      compiled safely on the next vfunc_paint_target.
   */
  private _setGaussianBlurRadius(radius: number): void {
    // [PERF] glass-blur-downscale: 2 (half res, 1 texel = 2 original px) or
    // 4 (quarter res, 1 texel = 4). The radius the user asks for is in
    // original pixels either way, so the conversion is the only thing that
    // changes — and because MAX_SIGMA_TEXEL is a texel cap, quarter
    // resolution also raises the largest reachable blur from 30px to 60px.
    const RES_SCALE = this._blurDownscale >= 4 ? 4.0 : 2.0;
    const MAX_SIGMA_TEXEL = 15.0; // texel cap: 30px at half res, 60px at quarter

    // ── Minimum sigma guarantee ────────────────────────────────────────────
    // Downsampling to half resolution (bilinear 2x) is effectively a 2px-wide
    // box filter, which aliases high-frequency content such as text. To
    // counteract that aliasing, the H/V kernel's effective width needs to
    // exceed 1.0 half-res texel (= 2 original pixels).
    // So sigma is floored at MIN_SIGMA_TEXEL = 1.0, guaranteeing at least a
    // minimal amount of smoothing even for a very small requested radius.
    // For small radii, kernel_scale ends up < 1.0, pulling the taps toward
    // the center — functioning simply as a "weaker blur" (the anti-aliasing
    // effect is preserved).
    const MIN_SIGMA_TEXEL = 1.0;

    if (radius <= 0) {
      if (this.PASS_COUNT !== 0) {
        this.PASS_COUNT = 0;
        this._destroyTexturePool();
      }
      this._gaussianScale = 0.0;
      this.queue_repaint();
      return;
    }

    const sigmaTexel = Math.min(radius / RES_SCALE, MAX_SIGMA_TEXEL);

    // Use a sigma floored at MIN_SIGMA_TEXEL to decide the kernel shape
    // (fetch-pair count), so a wide-enough kernel gets compiled even for
    // small radii.
    const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);

    // Number of one-sided taps needed to satisfy the 4-sigma rule (changed from 3
    // to prevent abrupt truncation ringing/grid artifacts at integer multiples),
    // converted to fetch pairs (2 taps per fetch). At least 2 pairs (5-tap equivalent)
    // are guaranteed so bilinear-downsample aliasing is reliably absorbed.
    const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
    const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));

    const needsRecompile =
      this._gaussianFetchPairs !== fetchPairs ||
      (!this._gaussianKernel && !this._pendingGaussianKernel);

    if (needsRecompile) {
      const kernel = this._computeGaussianKernel(kernelSigma, fetchPairs);
      this._pendingGaussianKernel = kernel;
      this._gaussianPipelineDirty = true;
      this._gaussianFetchPairs = fetchPairs;
      this._gaussianBaseSigma = kernelSigma;
      // kernel_scale = actual sigma / sigma at compile time.
      // When sigmaTexel < kernelSigma, scale < 1.0, giving a weaker blur.
      this._gaussianScale = sigmaTexel / kernelSigma;
    } else {
      // Fetch count (shader structure) is unchanged — only update
      // kernel_scale and skip the recompile.
      this._gaussianScale = this._gaussianBaseSigma > 0
        ? sigmaTexel / this._gaussianBaseSigma
        : 1.0;
    }

    // Gaussian always uses a single level (w/2 × h/2).
    // A pool rebuild is only needed when PASS_COUNT transitions 0 → 1
    // (recovering from a disabled-blur state).
    if (this.PASS_COUNT !== 1) {
      this.PASS_COUNT = 1;
      // Only force a rebuild if the pool wasn't built yet, or previously had
      // a different number of levels (e.g. coming from Dual Kawase). The
      // actual rebuild happens next frame once vfunc_paint_target notices
      // the resolution mismatch.
      this._destroyTexturePool();
    }

    this.queue_repaint();
  }

  /**
   * Radius setter for the Dual Kawase blur (original implementation, logic unchanged).
   */
  private _setDualKawaseBlurRadius(radius: number): void {
    // [PERF] Deliberately NOT compensated for glass-blur-downscale, unlike
    // _setGaussianBlurRadius()'s RES_SCALE. This mapping is empirical — the
    // prefs slider already warns that a Dual Kawase radius is not
    // pixel-accurate — and its pass count is what decides how deep the
    // pyramid goes, so scaling it here would trade one arbitrary mapping for
    // another while also changing the number of passes. At quarter
    // resolution the same slider position therefore reads as a wider blur,
    // which is consistent with what the setting says it does.
    let newPassCount = 0;
    let offsetDown = 0.0;
    let offsetUp = 0.0;

    if (radius > 0) {
      // 1. Derive the optimal integer pass count P from the physical radius R
      //    (empirical blur-falloff model).
      let p = Math.floor(Math.log2(radius + 1));

      // Clamp the pass count to the shader/FBO limit of [1, 4].
      newPassCount = Math.max(1, Math.min(4, p));

      // 2. Compute a linear normalized progress t within the pass interval.
      let baseR = (newPassCount === 1) ? 0 : Math.pow(2, newPassCount) - 1;
      let nextR = Math.pow(2, newPassCount + 1) - 1;

      let t = (radius - baseR) / (nextR - baseR);
      t = Math.max(0.0, Math.min(1.0, t));

      // 3. A piecewise cubic Hermite spline, chosen for C1 continuity.
      let s = 0.25 * Math.pow(t, 3) - 0.75 * Math.pow(t, 2) + 1.5 * t;

      // 4. Map to an offset range that guarantees anti-aliasing.
      let minOffset = (newPassCount === 1) ? 0.0 : 0.5;
      let maxOffset = 1.0;

      let r = minOffset + s * (maxOffset - minOffset);

      offsetDown = r;
      offsetUp = r * 1.5;
    }

    // Check whether anything actually changed.
    if (this.PASS_COUNT !== newPassCount ||
      this._blurRadiusDown !== offsetDown ||
      this._blurRadiusUp !== offsetUp) {

      const passCountChanged = this.PASS_COUNT !== newPassCount;

      this.PASS_COUNT = newPassCount;
      this._blurRadiusDown = offsetDown;
      this._blurRadiusUp = offsetUp;

      // A pass-count change requires rebuilding the FBO pool.
      if (passCountChanged) {
        this._destroyTexturePool();
      }

      this.queue_repaint();
    }
  }
});

export type LiquidEffect = InstanceType<typeof LiquidEffect>;
