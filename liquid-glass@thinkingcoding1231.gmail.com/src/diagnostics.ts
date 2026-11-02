import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
  setFrameSyncFrozen, isFrameSyncFrozen, setAdaptiveColorMode, getAdaptiveColorMode, type AdaptiveColorMode
} from './animation.js';
import {
  setDiffWritesEnabled, isDiffWritesEnabled, setWindowActorRescueMode, getWindowActorRescueMode,
  type WindowActorRescueMode, isActorValid
} from './actors.js';
import { diagnosticLog } from './logger.js';
import { paintNodeWithContext } from './shellVersion.js';

// Every live glass registers here so its last frame can be inspected from
// Looking Glass through global._lgGlass (installed by enable(), removed by
// disable()).
const _liveGlasses: Set<any> = new Set();

// A rolling in-memory record of the application glasses, written to the
// journal only when flushed. It exists for rare animation stalls: a capture
// started after the stall is noticed misses the frames leading up to it, and
// logging continuously from the compositor thread can stall the shell itself.
// A sample is stored only when a window's line changes, and RING_MAX caps
// the memory.
const RING_MAX = 4000;
const _ring: string[] = [];
let _ringLast: Map<any, string> = new Map();

function _ringTransition(wa: any): string {
  const trOp: any = wa.get_transition('opacity');
  if (!trOp) return '|tr=-';
  return `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
    `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`;
}

function _ringLine(glass: any): string | null {
  const wa: any = glass.get_parent();
  if (!wa) return null;
  const mw = wa.get_meta_window();
  // A stranded window has the glass, the window actor and the window group
  // all waiting for an allocation, so the group's state is recorded too.
  const wg: any = wa.get_parent();
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

function _isWindowGlass(glass: any): boolean {
  return glass._owner === 'application' || glass._owner === 'desktop-menu';
}

function _ringSampleOnce(): void {
  const t = GLib.get_monotonic_time();
  for (const glass of _liveGlasses) {
    if (!_isWindowGlass(glass)) continue;
    const line = _ringLine(glass);
    if (line === null || _ringLast.get(glass) === line) continue;
    _ringLast.set(glass, line);
    _ring.push(`${t} ${line}`);
    if (_ring.length > RING_MAX) _ring.shift();
  }
}

// Whether the shell's own animation is still attached to the window actor.
// A stall at a fixed scale/opacity looks the same from outside whether the
// timeline is not being ticked (playing, progress stuck; `clock=NULL` when no
// stage view reaches the actor), was stopped early (present, not playing), or
// has already been removed (absent).
function _dumpTransitions(wa: any, live: any): void {
  for (const prop of ['opacity', 'scale-x']) {
    const tr: any = wa.get_transition(prop);
    if (!tr) continue;
    live[`tr_${prop}`] =
      `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
      `,dur=${tr.get_duration()}` +
      `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
  }
}

// The window actor around a window's glass, next to the glass's own row: a
// frozen paint counter alone cannot tell minimised, unallocated and stuck
// apart.
function _dumpWindowState(glass: any): object {
  const wa: any = glass.get_parent();
  if (!wa) return {};
  const live: any = {
    hasAlloc: glass.has_allocation(),
    parentMapped: wa.mapped,
    parentHasAlloc: wa.has_allocation(),
    parentOpacity: wa.opacity,
    parentScale: `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`,
    shellDestroying: (Main.wm as any)._destroying.has(wa),
  };
  const mw = wa.get_meta_window();
  if (mw) {
    live.minimized = mw.minimized;
    const r = mw.get_frame_rect();
    live.wRect = `${r.x},${r.y},${r.width}x${r.height}`;
  }
  _dumpTransitions(wa, live);
  live.waViews = wa.peek_stage_views().length;
  const wg: any = wa.get_parent();
  if (wg) live.wgViews = wg.peek_stage_views().length;
  live.glassViews = glass.peek_stage_views().length;
  return live;
}

export function dumpGlassState(): string {
  const rows = [..._liveGlasses].map(glass => JSON.stringify({
    ...glass.describe(),
    ...(_isWindowGlass(glass) ? _dumpWindowState(glass) : {}),
  }));
  const out = rows.length ? rows.join('\n') : '(no live glass)';
  diagnosticLog(`[Liquid Glass][dump]\n${out}`);
  return out;
}

// While the recorder is armed, flush it automatically the first few times a
// window actor becomes stranded. Capped, because each flush writes to the
// journal.
let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;

export function noteStrandEntry(label: string, detail: string): void {
  if (!_ringArmed) return;
  if (_autoCaptures >= AUTO_CAPTURE_LIMIT) return;
  _autoCaptures++;
  diagnosticLog(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
    `on strand entry for "${label}" — ${detail}`);
  flushGlassRing();
}

// The recorder is off unless armed through global._lgGlass.ring(true), and
// its timer only exists while it is armed.
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
      _ringSampleOnce();
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

/**
 * Lets the sampler run whenever the recorder is armed. Pair with
 * stopGlassRingSampler() in disable().
 */
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
    diagnosticLog('[Liquid Glass][ring] empty');
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
  diagnosticLog(`[Liquid Glass][ring] BEGIN ${lines.length} samples spanning ` +
    `${Math.round((tN - t0) / 1000)}ms in ${total} chunk(s)`);
  for (let i = 0; i < total; i++) {
    diagnosticLog(`[Liquid Glass][ring] ${i + 1}/${total}\n` +
      lines.slice(i * CHUNK, (i + 1) * CHUNK).join('\n'));
  }
  diagnosticLog('[Liquid Glass][ring] END');

  _ring.length = 0;
  _ringLast = new Map();
}

function report(msg: string): string {
  diagnosticLog(`[Liquid Glass] ${msg}`);
  return msg;
}

function onOff(enabled: boolean): string {
  return enabled ? 'ENABLED' : 'DISABLED';
}

// Applies a setter to every live glass and returns how many it reached.
function onEveryGlass(apply: (glass: any) => void): number {
  for (const glass of _liveGlasses) apply(glass);
  return _liveGlasses.size;
}

function createDebugApi(): object {
  return {
    count: () => _liveGlasses.size,
    dump: () => dumpGlassState(),

    // 0 = normal, 1 = red where the shader computes the drop shadow and green
    // where it computes the glass shape, 2 = raw values.
    debugView: (mode: number) =>
      report(`debug_view = ${mode} on ${onEveryGlass(fx => fx.setDebugView(mode))} instance(s)`),

    // Every tick of every per-frame sync loop does nothing while frozen, so
    // the cost of the polling itself can be measured. The glass stops
    // following anything that moves.
    freezeSync: (frozen: boolean) => {
      setFrameSyncFrozen(frozen);
      return report(`per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`);
    },
    syncFrozen: () => isFrameSyncFrozen(),

    // 'cross-fade' (default) dissolves through alpha so a white/black flip
    // never sits at mid-grey; 'rgb-lerp' interpolates the channels.
    textColorMode: (mode: string) => {
      const m: AdaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
      setAdaptiveColorMode(m);
      return report(`adaptive text color mode = ${m}`);
    },
    textColorModeName: () => getAdaptiveColorMode(),

    // 'two-stage' (default) asks the window group to relayout first and only
    // then remaps the window actor; 'remap' goes straight to hide()/show();
    // 'off' never touches the window actor.
    windowRescue: (mode: string) => {
      setWindowActorRescueMode(mode as WindowActorRescueMode);
      return report(`window-actor rescue = ${getWindowActorRescueMode()}`);
    },
    windowRescueMode: () => getWindowActorRescueMode(),

    ring: (on: boolean) => {
      setGlassRingArmed(on);
      return report(`ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`);
    },
    ringArmed: () => isGlassRingArmed(),
    ringFlush: () => { flushGlassRing(); return 'flushed'; },

    // Compare-then-write in the per-frame sync loops. Changes how often the
    // stage is damaged, not what is drawn.
    diffWrites: (enabled: boolean) => {
      setDiffWritesEnabled(enabled);
      return report(`diff writes ${onOff(enabled)}`);
    },
    diffWritesEnabled: () => isDiffWritesEnabled(),

    // The rect each glass is drawing with right now, straight from its
    // uniforms, for per-frame tracking probes.
    geom: (owner?: string) => {
      const out: { owner: string, x: number, y: number, w: number, h: number }[] = [];
      const add = (glassOwner: string, u: ReadonlyMap<string, number>) => {
        if (owner && glassOwner !== owner) return;
        out.push({ owner: glassOwner, x: u.get('dock_x') ?? 0, y: u.get('dock_y') ?? 0,
          w: u.get('dock_w') ?? 0, h: u.get('dock_h') ?? 0 });
      };
      for (const glass of _liveGlasses) add(glass._owner, glass.uniformValues);
      return out;
    },

    // The live glass actors themselves, for scripted checks.
    glassObjects: () => [..._liveGlasses],

    // One journal line per second with what is on screen, every shown glass's
    // work and the GPU's busy percentage (see startGlassMonitor()).
    // 0 runs until monitorStop().
    monitor: (seconds: number = 30) => {
      startGlassMonitor(() => _liveGlasses, seconds);
      return report(`monitor running${seconds > 0 ? ` for ${seconds}s` : ''}; see journalctl -o cat | grep '\[monitor\]'`);
    },
    monitorStop: () => {
      stopGlassMonitor();
      return report('monitor stopped');
    },
    monitorRunning: () => isGlassMonitorRunning(),
    monitorLabel: (label: string | null) => setGlassMonitorLabel(label),

    blurRect: (enabled: boolean) =>
      report(`blur sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setBlurRectEnabled(enabled))} instance(s)`),
    compositeRect: (enabled: boolean) =>
      report(`composite sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setCompositeRectEnabled(enabled))} instance(s)`),
    // false = the plain four-tap pattern along the edge.
    edgeTaps: (enabled: boolean) =>
      report(`edge footprint taps ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEdgeTapsEnabled(enabled))} instance(s)`),
    earlyExit: (enabled: boolean) =>
      report(`early exits ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEarlyExitEnabled(enabled))} instance(s)`),
  };
}

/** Called from enable(): publishes global._lgGlass and the ring sampler. */
export function installGlassDiagnostics(): void {
  (global as any)._lgGlass = createDebugApi();
  startGlassRingSampler(50);
}

/** Called from disable(). */
export function removeGlassDiagnostics(): void {
  stopGlassMonitor();
  stopGlassRingSampler();
  delete (global as any)._lgGlass;
}

export function registerGlass(glass: any): void {
  _liveGlasses.add(glass);
}

export function unregisterGlass(glass: any): void {
  _liveGlasses.delete(glass);
}

const INTERVAL_MS = 100;
const TICKS = 600;
const KEYBINDING = 'dump-loop-keybinding';

/**
 * An optional shortcut (enable-dump-shortcut, off by default) that writes the state of every glass to the journal
 * for a minute, for bug reports. Pressed again, it stops early.
 */
export class DumpShortcut {
  private _settingId = 0;
  private _installed = false;
  private _loopId = 0;

  constructor(private _settings: Gio.Settings) {}

  setup(): void {
    this._settingId = this._settings.connect('changed::enable-dump-shortcut', () => this._sync());
    this._sync();
  }

  cleanup(): void {
    this._settings.disconnect(this._settingId);
    this._stop();
    if (this._installed) Main.wm.removeKeybinding(KEYBINDING);
    this._installed = false;
  }

  private _sync(): void {
    const wanted = this._settings.get_boolean('enable-dump-shortcut');
    if (wanted && !this._installed) {
      Main.wm.addKeybinding(KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
      this._installed = true;
    } else if (!wanted && this._installed) {
      Main.wm.removeKeybinding(KEYBINDING);
      this._installed = false;
      this._stop();
    }
  }

  // The accelerator as the user sees it, for the notifications.
  private _label(): string {
    const accel = this._settings.get_strv(KEYBINDING)[0];
    if (!accel) return 'the shortcut';
    return accel.replace(/<Control>/gi, 'Ctrl+').replace(/<Alt>/gi, 'Alt+').replace(/<Shift>/gi, 'Shift+')
      .replace(/<Super>/gi, 'Super+').replace(/\+([a-z])$/, (_, k: string) => `+${k.toUpperCase()}`);
  }

  private _stop(): boolean {
    if (!this._loopId) return false;
    GLib.Source.remove(this._loopId);
    this._loopId = 0;
    return true;
  }

  private _toggle(): void {
    if (this._stop()) {
      Main.notify('Liquid Glass', 'Diagnostic dump stopped');
      return;
    }
    // The ring buffer holds the frames before the key press, which the loop that starts now cannot capture.
    flushGlassRing();
    const seconds = (TICKS * INTERVAL_MS) / 1000;
    const endsAt = new Date(Date.now() + seconds * 1000);
    const hhmmss = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    // Marks where the capture starts in the journal.
    diagnosticLog(`[Liquid Glass][dump-loop] STARTED ${TICKS} ticks @ ${INTERVAL_MS}ms, ends ${hhmmss(endsAt)}`);
    Main.notify('Liquid Glass', `Diagnostic dump running ${seconds}s — ends at ${hhmmss(endsAt)} (${this._label()} to stop)`);
    let count = 0;
    this._loopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVAL_MS, () => {
      dumpGlassState();
      if (++count < TICKS) return GLib.SOURCE_CONTINUE;
      this._loopId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }
}

// A once-a-second journal line comparing the glass's work with the GPU's and
// the shell's in a real session: global._lgGlass.monitor(). It has amdgpu's
// busy percentage, shader clock and power (busy alone depends on the clock the
// driver picked; an APU's power includes the CPU), the shell's CPU time, the
// frames painted and how many redrew a whole monitor, a scene worked out from
// what is on screen, and each glass's copies and paints. A benchmark can label
// the lines. tools/perf/glass-monitor.sh averages them per scene or label.

const SAMPLE_MS = 100;
const REPORT_MS = 1000;
const BUSY_DAMAGE = 10;
const MAX_ACTIVE_WINDOWS = 4;
// /proc reports CPU time in USER_HZ, which is 100 on every Linux architecture.
const USER_HZ = 100;

// The live glasses, read every sample.
export type MonitorSources = () => Iterable<any>;

type FullRedrawProbe = Clutter.Actor & { rect: number[], full: number };

// Paints nothing; notes whether a frame redrew its whole monitor. Registered
// on first use, so the type exists only once someone monitors. Offscreen
// paints (clones, screenshots) have no redraw clip and are not counted.
let _probeClass: any = null;
function createProbe(rect: number[]): FullRedrawProbe {
  _probeClass ??= GObject.registerClass(paintNodeWithContext(
    class FullRedrawProbe extends Clutter.Actor {
      declare rect: number[];
      declare full: number;

      _init(r: number[]) {
        super._init({ name: 'liquid-glass-monitor-probe', reactive: false, x: r[0], y: r[1], width: r[2], height: r[3] });
        Shell.util_set_hidden_from_pick(this, true);
        this.rect = r;
        this.full = 0;
      }

      vfunc_pick(_pickContext: any): void {
      }

      vfunc_paint_node(_root: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
        const clip = paintContext.get_redraw_clip();
        const [x, y, width, height] = this.rect;
        if (clip && clip.contains_rectangle(new Mtk.Rectangle({ x, y, width, height })) === Mtk.RegionOverlap.IN)
          this.full++;
      }
    }
  ));
  return new _probeClass(rect);
}

interface WindowTrack {
  rect: string;
  look: string;
  moved: boolean;
  animated: boolean;
  damage: number;
  damagedId: number;
}

interface GlassTrack {
  owner: string;
  name: string;
  actor: Clutter.Actor;
  rect: number[] | null;
  shown: boolean;
  moved: boolean;
}

function displayName(owner: string): string {
  if (owner === 'menu') return 'calendar';
  if (owner === 'application') return 'app';
  return owner;
}

// Popups, tooltips and the like are not counted as windows.
function isCountedWindow(window: Meta.Window): boolean {
  const type = window.get_window_type();
  return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG || type === Meta.WindowType.MODAL_DIALOG;
}

function windowName(window: Meta.Window): string {
  const name = window.get_wm_class() || window.get_title() || '?';
  return (name.split('.').pop() ?? name).toLowerCase().replace(/[^a-z0-9_-]/g, '') || '?';
}

// The glass shape in stage coordinates: the shader's rect scaled from the
// shader's resolution onto the actor's box.
function glassStageRect(actor: Clutter.Actor, u: ReadonlyMap<string, number>): number[] | null {
  const ext = actor.get_transformed_extents();
  const { x, y } = ext.origin;
  const { width, height } = ext.size;
  if (!(width >= 1) || !(height >= 1)) return null;
  const resW = u.get('resolution_x') ?? 0;
  const resH = u.get('resolution_y') ?? 0;
  const w = u.get('dock_w') ?? 0;
  const h = u.get('dock_h') ?? 0;
  // Toggle mode draws regions and leaves the rect empty.
  if (!(resW >= 1) || !(resH >= 1) || !(w > 0) || !(h > 0))
    return [x, y, width, height].map(Math.round);
  const kx = width / resW;
  const ky = height / resH;
  return [x + (u.get('dock_x') ?? 0) * kx, y + (u.get('dock_y') ?? 0) * ky, w * kx, h * ky].map(Math.round);
}

function overlaps(a: number[], b: number[]): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

class GlassMonitor {
  private _sampleId = 0;
  private _reportId = 0;
  private _paintId = 0;
  private _workspaceId = 0;
  private _frames = 0;
  private _seconds = 0;
  private _sensors: GpuSensors = { busy: [], clock: [], power: [] };
  private _busy = new Gauge();
  private _clock = new Gauge();
  private _power = new Gauge();
  // The shell's CPU ticks at the last report, and as last read.
  private _cpuTicks: number | null = null;
  private _cpuTime = 0;
  private _latestTicks: number | null = null;
  private _latestTicksAt = 0;
  // Cancels the file reads still in flight when the record stops.
  private _cancellable = new Gio.Cancellable();
  private _label: string | null = null;
  private _labelChanged = false;
  private _probes: FullRedrawProbe[] = [];
  private _windows = new Map<Meta.WindowActor, WindowTrack>();
  private _glass = new Map<any, GlassTrack>();
  private _overview = false;
  private _fullscreen = false;
  private _locked = false;
  private _workspaceSwitched = false;
  private _last = new Map<any, Record<string, number>>();
  // Per-second totals for the summary.
  private _totals = { seconds: 0, gpu: 0, power: 0, cpu: 0, frames: 0, full: 0 };

  constructor(private _sources: MonitorSources, private _duration: number) {}

  start(): void {
    this._sensors = findGpuSensors();
    for (const m of Main.layoutManager.monitors) {
      const probe = createProbe([m.x, m.y, m.width, m.height]);
      // Painted last, after everything that can redraw.
      global.stage.add_child(probe);
      this._probes.push(probe);
    }
    this._paintId = global.stage.connect('after-paint', () => { this._frames++; });
    this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () => {
      this._workspaceSwitched = true;
    });
    this._snapshotCounters();
    this._sample();
    this._sampleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_MS, () => {
      this._sample();
      return GLib.SOURCE_CONTINUE;
    });
    this._reportId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPORT_MS, () => {
      this._report();
      if (this._duration > 0 && this._seconds >= this._duration) {
        stopGlassMonitor();
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
    diagnosticLog(`[Liquid Glass][monitor] started ${this._duration > 0 ? `for ${this._duration}s` : 'until monitorStop()'}; ` +
      `gpu sensors: ${[...this._sensors.busy, ...this._sensors.clock, ...this._sensors.power].join(', ') || 'none'}`);
  }

  // Lines from the next whole second on carry the label.
  setLabel(label: string | null): void {
    const clean = label ? label.replace(/[^\w./-]/g, '') || null : null;
    if (clean === this._label) return;
    this._label = clean;
    this._labelChanged = true;
  }

  stop(): void {
    this._cancellable.cancel();
    if (this._sampleId) GLib.Source.remove(this._sampleId);
    this._sampleId = 0;
    if (this._reportId) GLib.Source.remove(this._reportId);
    this._reportId = 0;
    if (this._paintId) global.stage.disconnect(this._paintId);
    this._paintId = 0;
    if (this._workspaceId) global.workspace_manager.disconnect(this._workspaceId);
    this._workspaceId = 0;
    for (const probe of this._probes) {
      if (isActorValid(probe)) probe.destroy();
    }
    this._probes = [];
    for (const [actor, track] of this._windows) {
      if (isActorValid(actor)) actor.disconnect(track.damagedId);
    }
    this._windows.clear();
    this._glass.clear();
    const t = this._totals;
    if (t.seconds > 0) {
      diagnosticLog(`[Liquid Glass][monitor] stopped after ${t.seconds}s: ` +
        `${this._sensors.busy.length ? `gpu avg ${(t.gpu / t.seconds).toFixed(1)}%, ` : ''}` +
        `${this._sensors.power.length ? `power avg ${(t.power / t.seconds).toFixed(1)}W, ` : ''}` +
        `cpu avg ${(t.cpu / t.seconds).toFixed(1)}%, ` +
        `${(t.frames / t.seconds).toFixed(1)} frames/s, ${(t.full / t.seconds).toFixed(1)} full redraws/s`);
    }
  }

  private _sample(): void {
    this._readCounters();
    this._sampleWindows();
    this._sampleGlass();
    this._overview ||= Main.overview.visible;
    this._locked ||= Main.sessionMode.isLocked;
    for (let i = 0; i < global.display.get_n_monitors(); i++)
      this._fullscreen ||= global.display.get_monitor_in_fullscreen(i);
  }

  // The GPU sensors and the shell's CPU time, read without blocking the
  // compositor.
  private async _readCounters(): Promise<void> {
    const cancellable = this._cancellable;
    const [busy, hz, microwatts, ticks] = await Promise.all([
      readMax(this._sensors.busy, cancellable),
      readMax(this._sensors.clock, cancellable),
      readSum(this._sensors.power, cancellable),
      readProcessTicks(cancellable),
    ]);
    if (cancellable.is_cancelled()) return;
    this._busy.add(busy);
    this._clock.add(hz === null ? null : hz / 1e6);
    this._power.add(microwatts === null ? null : microwatts / 1e6);
    if (ticks !== null) {
      this._latestTicks = ticks;
      this._latestTicksAt = GLib.get_monotonic_time();
    }
  }

  private _sampleWindows(): void {
    const seen = new Set<Meta.WindowActor>();
    for (const actor of global.get_window_actors()) {
      seen.add(actor);
      const r = actor.get_meta_window()?.get_frame_rect();
      const rect = r ? `${r.x},${r.y},${r.width},${r.height}` : '';
      const look = `${actor.scale_x},${actor.scale_y},${actor.translation_x},${actor.translation_y},${actor.opacity}`;
      const track = this._windows.get(actor);
      if (!track) {
        const created: WindowTrack = { rect, look, moved: false, animated: false, damage: 0, damagedId: 0 };
        created.damagedId = actor.connect('damaged', () => { created.damage++; });
        this._windows.set(actor, created);
        continue;
      }
      if (track.rect !== rect) track.moved = true;
      if (track.look !== look) track.animated = true;
      track.rect = rect;
      track.look = look;
    }
    // A destroyed window actor took its handler with it.
    for (const actor of this._windows.keys()) {
      if (!seen.has(actor)) this._windows.delete(actor);
    }
  }

  private _sampleGlass(): void {
    const stage = [0, 0, global.stage.width, global.stage.height];
    const seen = new Set<any>();
    for (const glass of this._sources()) {
      seen.add(glass);
      const painting = glass.mapped && glass.get_paint_opacity() > 0;
      const rect = painting ? glassStageRect(glass, glass.uniformValues) : null;
      const shown = painting && (rect === null || overlaps(rect, stage));
      let track = this._glass.get(glass);
      if (!track) {
        track = { owner: glass._owner, name: displayName(glass._owner), actor: glass, rect, shown: false, moved: false };
        this._glass.set(glass, track);
      } else if (shown && rect && track.rect && rect.join() !== track.rect.join()) {
        track.moved = true;
      }
      if (rect) track.rect = rect;
      track.shown ||= shown;
    }
    for (const key of this._glass.keys()) {
      if (!seen.has(key)) this._glass.delete(key);
    }
  }

  private _counters(glass: any): Record<string, number> {
    const s = glass.stats ?? {};
    return { copies: s.copies ?? 0, reuses: s.reuses ?? 0, paints: s.paints ?? 0, blurs: glass._blurRuns ?? 0 };
  }

  private _snapshotCounters(): void {
    for (const glass of this._sources()) this._last.set(glass, this._counters(glass));
  }

  // Kept as the scene's first field, which tools/perf/glass-monitor.sh groups
  // the summary by.
  private _mode(): string {
    return this._glass.size > 0 ? 'stage' : 'no-glass';
  }

  private _glassScene(): string {
    const counts = new Map<string, { n: number, moved: boolean }>();
    for (const track of this._glass.values()) {
      if (!track.shown) continue;
      const entry = counts.get(track.name) ?? { n: 0, moved: false };
      entry.n++;
      entry.moved ||= track.moved;
      counts.set(track.name, entry);
    }
    const names = [...counts.keys()].sort().map(name => {
      const { n, moved } = counts.get(name)!;
      return `${name}${n > 1 ? `(${n})` : ''}${moved ? '~' : ''}`;
    });
    return names.length ? names.join(' ') : 'no glass';
  }

  // The glass a window overlaps, leaving out its own window glass.
  private _behind(actor: Meta.WindowActor, rect: number[]): string[] {
    const names = new Set<string>();
    for (const track of this._glass.values()) {
      if (!track.shown || !track.rect || track.actor.get_parent() === actor) continue;
      if (overlaps(rect, track.rect)) names.add(track.name);
    }
    return [...names].sort();
  }

  private _windowScene(): string {
    let shown = 0;
    const active = new Map<string, number>();
    for (const [actor, track] of this._windows) {
      const window = actor.get_meta_window();
      if (!window || !actor.mapped || !actor.visible || window.minimized) continue;
      if (isCountedWindow(window)) shown++;
      const what: string[] = [];
      if (track.damage >= BUSY_DAMAGE) what.push('busy');
      if (track.moved) what.push('moving');
      if (track.animated) what.push('anim');
      if (!what.length) continue;
      const r = window.get_frame_rect();
      const behind = this._behind(actor, [r.x, r.y, r.width, r.height]);
      const entry = `${windowName(window)} ${what.join('+')}${behind.length ? `@${behind.join('+')}` : ''}`;
      active.set(entry, (active.get(entry) ?? 0) + 1);
    }
    const entries = [...active.keys()].sort().map(e => active.get(e)! > 1 ? `${e}(${active.get(e)})` : e);
    const listed = entries.slice(0, MAX_ACTIVE_WINDOWS);
    if (entries.length > listed.length) listed.push(`+${entries.length - listed.length} more`);
    return `${shown} win${listed.length ? `: ${listed.join(', ')}` : ''}`;
  }

  // Whether there is glass at all; the glass on screen (~ when it moved); the
  // windows shown and the busy (damaged BUSY_DAMAGE times), moving or
  // animating ones, with @ for each glass they overlap; then overview,
  // ws-switch, fullscreen and locked.
  private _scene(): string {
    const parts = [this._mode(), this._glassScene(), this._windowScene()];
    if (this._overview) parts.push('overview');
    if (this._workspaceSwitched) parts.push('ws-switch');
    if (this._fullscreen) parts.push('fullscreen');
    if (this._locked) parts.push('locked');
    return parts.join('; ');
  }

  private _report(): void {
    this._seconds++;
    const parts: string[] = [];

    const full = this._probes.reduce((n, p) => n + p.full, 0);
    const cpu = this._cpuPercent();
    const label = this._labelChanged ? null : this._label;
    this._labelChanged = false;
    parts.push(`t=${this._seconds}` +
      (label ? ` label=${label}` : '') +
      (this._busy.n ? ` gpu=${this._busy.mean.toFixed(0)}% (max ${this._busy.max})` : '') +
      (this._clock.n ? ` sclk=${this._clock.mean.toFixed(0)}MHz` : '') +
      (this._power.n ? ` power=${this._power.mean.toFixed(1)}W` : '') +
      (cpu === null ? '' : ` cpu=${cpu.toFixed(0)}%`) +
      ` frames=${this._frames} full=${full} scene=<${this._scene()}>`);
    this._totals.seconds++;
    this._totals.gpu += this._busy.mean;
    this._totals.power += this._power.mean;
    this._totals.cpu += cpu ?? 0;
    this._totals.frames += this._frames;
    this._totals.full += full;

    for (const glass of this._sources()) {
      const now = this._counters(glass);
      const last = this._last.get(glass) ?? now;
      this._last.set(glass, now);
      const d = (k: string) => now[k] - (last[k] ?? 0);
      if (!glass.mapped && d('paints') === 0) continue;
      const relays = glass.describe().relays?.length ?? 0;
      parts.push(`${displayName(glass._owner)} copies=${d('copies')} reuses=${d('reuses')} paints=${d('paints')} ` +
        `blurs=${d('blurs')} relays=${relays}${glass.mapped ? '' : ' (hidden)'}`);
    }

    diagnosticLog(`[Liquid Glass][monitor] ${parts.join(' | ')}`);
    this._frames = 0;
    for (const probe of this._probes) probe.full = 0;
    this._busy.reset();
    this._clock.reset();
    this._power.reset();
    for (const track of this._windows.values()) {
      track.moved = false;
      track.animated = false;
      track.damage = 0;
    }
    for (const track of this._glass.values()) {
      track.shown = false;
      track.moved = false;
    }
    this._overview = false;
    this._fullscreen = false;
    this._locked = false;
    this._workspaceSwitched = false;
  }

  // The shell's CPU time since the last report, as a percentage of one core.
  private _cpuPercent(): number | null {
    const ticks = this._latestTicks;
    const at = this._latestTicksAt;
    const last = this._cpuTicks;
    const seconds = (at - this._cpuTime) / 1e6;
    this._cpuTicks = ticks;
    this._cpuTime = at;
    if (ticks === null || last === null || !(seconds > 0)) return null;
    return (ticks - last) / USER_HZ / seconds * 100;
  }
}

class Gauge {
  sum = 0;
  n = 0;
  max = 0;

  add(value: number | null): void {
    if (value === null) return;
    this.sum += value;
    this.n++;
    if (value > this.max) this.max = value;
  }

  get mean(): number {
    return this.n ? this.sum / this.n : 0;
  }

  reset(): void {
    this.sum = 0;
    this.n = 0;
    this.max = 0;
  }
}

interface GpuSensors {
  busy: string[];
  clock: string[];
  power: string[];
}

function listDir(path: string): string[] {
  const names: string[] = [];
  let dir: GLib.Dir | null = null;
  try {
    dir = GLib.Dir.open(path, 0);
  } catch {
    return names;
  }
  for (let name = dir.read_name(); name !== null; name = dir.read_name()) names.push(name);
  dir.close();
  return names;
}

// amdgpu's busy percentage, and its hwmon shader clock and power, per card.
function findGpuSensors(): GpuSensors {
  const sensors: GpuSensors = { busy: [], clock: [], power: [] };
  const exists = (file: string) => GLib.file_test(file, GLib.FileTest.EXISTS);
  for (const card of listDir('/sys/class/drm')) {
    if (!/^card\d+$/.test(card)) continue;
    const device = `/sys/class/drm/${card}/device`;
    if (!exists(`${device}/gpu_busy_percent`)) continue;
    sensors.busy.push(`${device}/gpu_busy_percent`);
    for (const hwmon of listDir(`${device}/hwmon`)) {
      const base = `${device}/hwmon/${hwmon}`;
      if (exists(`${base}/freq1_input`)) sensors.clock.push(`${base}/freq1_input`);
      const power = [`${base}/power1_input`, `${base}/power1_average`].find(exists);
      if (power) sensors.power.push(power);
    }
  }
  return sensors;
}

async function readMax(files: string[], cancellable: Gio.Cancellable): Promise<number | null> {
  let result: number | null = null;
  for (const value of await Promise.all(files.map(file => readNumber(file, cancellable)))) {
    if (value !== null && (result === null || value > result)) result = value;
  }
  return result;
}

async function readSum(files: string[], cancellable: Gio.Cancellable): Promise<number | null> {
  let result: number | null = null;
  for (const value of await Promise.all(files.map(file => readNumber(file, cancellable)))) {
    if (value !== null) result = (result ?? 0) + value;
  }
  return result;
}

// load_contents_finish() throws a GError when the file cannot be read or the
// read was cancelled.
function readText(path: string, cancellable: Gio.Cancellable): Promise<string | null> {
  return new Promise(resolve => {
    const file = Gio.File.new_for_path(path);
    file.load_contents_async(cancellable, (_source, result) => {
      try {
        const [, bytes] = file.load_contents_finish(result);
        resolve(new TextDecoder().decode(bytes));
      } catch {
        resolve(null);
      }
    });
  });
}

// utime + stime of the whole process; the command name before them is in
// parentheses and may contain spaces.
async function readProcessTicks(cancellable: Gio.Cancellable): Promise<number | null> {
  const stat = await readText('/proc/self/stat', cancellable);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = parseInt(fields[11], 10) + parseInt(fields[12], 10);
  return Number.isFinite(ticks) ? ticks : null;
}

async function readNumber(file: string, cancellable: Gio.Cancellable): Promise<number | null> {
  const text = await readText(file, cancellable);
  if (text === null) return null;
  const value = parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

let _monitor: GlassMonitor | null = null;

/** Starts the record for `seconds` (0: until stopped), replacing a running one. */
export function startGlassMonitor(sources: MonitorSources, seconds: number): void {
  stopGlassMonitor();
  _monitor = new GlassMonitor(sources, Math.max(0, Math.floor(seconds)));
  _monitor.start();
}

export function stopGlassMonitor(): void {
  _monitor?.stop();
  _monitor = null;
}

/** Labels the running record's lines (a benchmark's scenario); null clears it. */
export function setGlassMonitorLabel(label: string | null): void {
  _monitor?.setLabel(label);
}

export function isGlassMonitorRunning(): boolean {
  return _monitor !== null;
}
