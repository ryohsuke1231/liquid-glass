// A once-a-second journal line comparing the glass's work with the GPU's and
// the shell's in a real session: global._lgGlass.monitor(). It has amdgpu's
// busy percentage, shader clock and power (busy alone depends on the clock the
// driver picked; an APU's power includes the CPU), the shell's CPU time, the
// frames painted and how many redrew a whole monitor, a scene worked out from
// what is on screen, and each glass's copies and paints. A benchmark can label
// the lines. tools/perf/glass-monitor.sh averages them per scene or label.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { diagnosticLog } from './logging.js';
import { isActorValid } from '../actors/lifecycle.js';
import { paintNodeWithContext } from '../shellVersion.js';
const SAMPLE_MS = 100;
const REPORT_MS = 1000;
const BUSY_DAMAGE = 10;
const MAX_ACTIVE_WINDOWS = 4;
// /proc reports CPU time in USER_HZ, which is 100 on every Linux architecture.
const USER_HZ = 100;
// Paints nothing; notes whether a frame redrew its whole monitor. Registered
// on first use, so the type exists only once someone monitors. Offscreen
// paints (clones, screenshots) have no redraw clip and are not counted.
let _probeClass = null;

function createProbe(rect) {
    _probeClass ??= GObject.registerClass(paintNodeWithContext(class FullRedrawProbe extends Clutter.Actor {
        _init(r) {
            super._init({ name: 'liquid-glass-monitor-probe', reactive: false, x: r[0], y: r[1], width: r[2], height: r[3] });
            Shell.util_set_hidden_from_pick(this, true);
            this.rect = r;
            this.full = 0;
        }

        vfunc_pick(_pickContext) {
        }

        vfunc_paint_node(_root, paintContext) {
            const clip = paintContext.get_redraw_clip();
            const [x, y, width, height] = this.rect;
            if (clip && clip.contains_rectangle(new Mtk.Rectangle({ x, y, width, height })) === Mtk.RegionOverlap.IN)
                this.full++;
        }
    }));
    return new _probeClass(rect);
}

function displayName(owner) {
    if (owner === 'menu')
        return 'calendar';
    if (owner === 'application')
        return 'app';
    return owner;
}

// Popups, tooltips and the like are not counted as windows.
function isCountedWindow(window) {
    const type = window.get_window_type();
    return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG || type === Meta.WindowType.MODAL_DIALOG;
}

function windowName(window) {
    const name = window.get_wm_class() || window.get_title() || '?';
    return (name.split('.').pop() ?? name).toLowerCase().replace(/[^a-z0-9_-]/g, '') || '?';
}

// The glass shape in stage coordinates: the shader's rect scaled from the
// shader's resolution onto the actor's box.
function glassStageRect(actor, u) {
    const ext = actor.get_transformed_extents();
    const { x, y } = ext.origin;
    const { width, height } = ext.size;
    if (!(width >= 1) || !(height >= 1))
        return null;
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

function overlaps(a, b) {
    return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

class GlassMonitor {
    _sources;
    _duration;
    _sampleId = 0;
    _reportId = 0;
    _paintId = 0;
    _workspaceId = 0;
    _frames = 0;
    _seconds = 0;
    _sensors = { busy: [], clock: [], power: [] };
    _busy = new Gauge();
    _clock = new Gauge();
    _power = new Gauge();
    // The shell's CPU ticks at the last report, and as last read.
    _cpuTicks = null;
    _cpuTime = 0;
    _latestTicks = null;
    _latestTicksAt = 0;
    // Cancels the file reads still in flight when the record stops.
    _cancellable = new Gio.Cancellable();
    _label = null;
    _labelChanged = false;
    _probes = [];
    _windows = new Map();
    _glass = new Map();
    _overview = false;
    _fullscreen = false;
    _locked = false;
    _workspaceSwitched = false;
    _last = new Map();
    // Per-second totals for the summary.
    _totals = { seconds: 0, gpu: 0, power: 0, cpu: 0, frames: 0, full: 0 };

    constructor(_sources, _duration) {
        this._sources = _sources;
        this._duration = _duration;
    }

    start() {
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
    setLabel(label) {
        const clean = label ? label.replace(/[^\w./-]/g, '') || null : null;
        if (clean === this._label)
            return;
        this._label = clean;
        this._labelChanged = true;
    }

    stop() {
        this._cancellable.cancel();
        if (this._sampleId)
            GLib.Source.remove(this._sampleId);
        this._sampleId = 0;
        if (this._reportId)
            GLib.Source.remove(this._reportId);
        this._reportId = 0;
        if (this._paintId)
            global.stage.disconnect(this._paintId);
        this._paintId = 0;
        if (this._workspaceId)
            global.workspace_manager.disconnect(this._workspaceId);
        this._workspaceId = 0;
        for (const probe of this._probes) {
            if (isActorValid(probe))
                probe.destroy();
        }
        this._probes = [];
        for (const [actor, track] of this._windows) {
            if (isActorValid(actor))
                actor.disconnect(track.damagedId);
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

    _sample() {
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
    async _readCounters() {
        const cancellable = this._cancellable;
        const [busy, hz, microwatts, ticks] = await Promise.all([
            readMax(this._sensors.busy, cancellable),
            readMax(this._sensors.clock, cancellable),
            readSum(this._sensors.power, cancellable),
            readProcessTicks(cancellable),
        ]);
        if (cancellable.is_cancelled())
            return;
        this._busy.add(busy);
        this._clock.add(hz === null ? null : hz / 1e6);
        this._power.add(microwatts === null ? null : microwatts / 1e6);
        if (ticks !== null) {
            this._latestTicks = ticks;
            this._latestTicksAt = GLib.get_monotonic_time();
        }
    }

    _sampleWindows() {
        const seen = new Set();
        for (const actor of global.get_window_actors()) {
            seen.add(actor);
            const r = actor.get_meta_window()?.get_frame_rect();
            const rect = r ? `${r.x},${r.y},${r.width},${r.height}` : '';
            const look = `${actor.scale_x},${actor.scale_y},${actor.translation_x},${actor.translation_y},${actor.opacity}`;
            const track = this._windows.get(actor);
            if (!track) {
                const created = { rect, look, moved: false, animated: false, damage: 0, damagedId: 0 };
                created.damagedId = actor.connect('damaged', () => { created.damage++; });
                this._windows.set(actor, created);
                continue;
            }
            if (track.rect !== rect)
                track.moved = true;
            if (track.look !== look)
                track.animated = true;
            track.rect = rect;
            track.look = look;
        }
        // A destroyed window actor took its handler with it.
        for (const actor of this._windows.keys()) {
            if (!seen.has(actor))
                this._windows.delete(actor);
        }
    }

    _sampleGlass() {
        const stage = [0, 0, global.stage.width, global.stage.height];
        const seen = new Set();
        for (const glass of this._sources()) {
            seen.add(glass);
            const painting = glass.mapped && glass.get_paint_opacity() > 0;
            const rect = painting ? glassStageRect(glass, glass.uniformValues) : null;
            const shown = painting && (rect === null || overlaps(rect, stage));
            let track = this._glass.get(glass);
            if (!track) {
                track = { owner: glass._owner, name: displayName(glass._owner), actor: glass, rect, shown: false, moved: false };
                this._glass.set(glass, track);
            }
            else if (shown && rect && track.rect && rect.join() !== track.rect.join()) {
                track.moved = true;
            }
            if (rect)
                track.rect = rect;
            track.shown ||= shown;
        }
        for (const key of this._glass.keys()) {
            if (!seen.has(key))
                this._glass.delete(key);
        }
    }

    _counters(glass) {
        const s = glass.stats ?? {};
        return { copies: s.copies ?? 0, reuses: s.reuses ?? 0, paints: s.paints ?? 0, blurs: glass._blurRuns ?? 0 };
    }

    _snapshotCounters() {
        for (const glass of this._sources())
            this._last.set(glass, this._counters(glass));
    }

    // Kept as the scene's first field, which tools/perf/glass-monitor.sh groups
    // the summary by.
    _mode() {
        return this._glass.size > 0 ? 'stage' : 'no-glass';
    }

    _glassScene() {
        const counts = new Map();
        for (const track of this._glass.values()) {
            if (!track.shown)
                continue;
            const entry = counts.get(track.name) ?? { n: 0, moved: false };
            entry.n++;
            entry.moved ||= track.moved;
            counts.set(track.name, entry);
        }
        const names = [...counts.keys()].sort().map(name => {
            const { n, moved } = counts.get(name);
            return `${name}${n > 1 ? `(${n})` : ''}${moved ? '~' : ''}`;
        });
        return names.length ? names.join(' ') : 'no glass';
    }

    // The glass a window overlaps, leaving out its own window glass.
    _behind(actor, rect) {
        const names = new Set();
        for (const track of this._glass.values()) {
            if (!track.shown || !track.rect || track.actor.get_parent() === actor)
                continue;
            if (overlaps(rect, track.rect))
                names.add(track.name);
        }
        return [...names].sort();
    }

    _windowScene() {
        let shown = 0;
        const active = new Map();
        for (const [actor, track] of this._windows) {
            const window = actor.get_meta_window();
            if (!window || !actor.mapped || !actor.visible || window.minimized)
                continue;
            if (isCountedWindow(window))
                shown++;
            const what = [];
            if (track.damage >= BUSY_DAMAGE)
                what.push('busy');
            if (track.moved)
                what.push('moving');
            if (track.animated)
                what.push('anim');
            if (!what.length)
                continue;
            const r = window.get_frame_rect();
            const behind = this._behind(actor, [r.x, r.y, r.width, r.height]);
            const entry = `${windowName(window)} ${what.join('+')}${behind.length ? `@${behind.join('+')}` : ''}`;
            active.set(entry, (active.get(entry) ?? 0) + 1);
        }
        const entries = [...active.keys()].sort().map(e => active.get(e) > 1 ? `${e}(${active.get(e)})` : e);
        const listed = entries.slice(0, MAX_ACTIVE_WINDOWS);
        if (entries.length > listed.length)
            listed.push(`+${entries.length - listed.length} more`);
        return `${shown} win${listed.length ? `: ${listed.join(', ')}` : ''}`;
    }

    // Whether there is glass at all; the glass on screen (~ when it moved); the
    // windows shown and the busy (damaged BUSY_DAMAGE times), moving or
    // animating ones, with @ for each glass they overlap; then overview,
    // ws-switch, fullscreen and locked.
    _scene() {
        const parts = [this._mode(), this._glassScene(), this._windowScene()];
        if (this._overview)
            parts.push('overview');
        if (this._workspaceSwitched)
            parts.push('ws-switch');
        if (this._fullscreen)
            parts.push('fullscreen');
        if (this._locked)
            parts.push('locked');
        return parts.join('; ');
    }

    _report() {
        this._seconds++;
        const parts = [];
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
            const d = (k) => now[k] - (last[k] ?? 0);
            if (!glass.mapped && d('paints') === 0)
                continue;
            const relays = glass.describe().relays?.length ?? 0;
            parts.push(`${displayName(glass._owner)} copies=${d('copies')} reuses=${d('reuses')} paints=${d('paints')} ` +
                `blurs=${d('blurs')} relays=${relays}${glass.mapped ? '' : ' (hidden)'}`);
        }
        diagnosticLog(`[Liquid Glass][monitor] ${parts.join(' | ')}`);
        this._frames = 0;
        for (const probe of this._probes)
            probe.full = 0;
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
    _cpuPercent() {
        const ticks = this._latestTicks;
        const at = this._latestTicksAt;
        const last = this._cpuTicks;
        const seconds = (at - this._cpuTime) / 1e6;
        this._cpuTicks = ticks;
        this._cpuTime = at;
        if (ticks === null || last === null || !(seconds > 0))
            return null;
        return (ticks - last) / USER_HZ / seconds * 100;
    }
}

class Gauge {
    sum = 0;
    n = 0;
    max = 0;

    add(value) {
        if (value === null)
            return;
        this.sum += value;
        this.n++;
        if (value > this.max)
            this.max = value;
    }

    get mean() {
        return this.n ? this.sum / this.n : 0;
    }

    reset() {
        this.sum = 0;
        this.n = 0;
        this.max = 0;
    }
}

function listDir(path) {
    const names = [];
    let dir = null;
    try {
        dir = GLib.Dir.open(path, 0);
    }
    catch {
        return names;
    }
    for (let name = dir.read_name(); name !== null; name = dir.read_name())
        names.push(name);
    dir.close();
    return names;
}

// amdgpu's busy percentage, and its hwmon shader clock and power, per card.
function findGpuSensors() {
    const sensors = { busy: [], clock: [], power: [] };
    const exists = (file) => GLib.file_test(file, GLib.FileTest.EXISTS);
    for (const card of listDir('/sys/class/drm')) {
        if (!/^card\d+$/.test(card))
            continue;
        const device = `/sys/class/drm/${card}/device`;
        if (!exists(`${device}/gpu_busy_percent`))
            continue;
        sensors.busy.push(`${device}/gpu_busy_percent`);
        for (const hwmon of listDir(`${device}/hwmon`)) {
            const base = `${device}/hwmon/${hwmon}`;
            if (exists(`${base}/freq1_input`))
                sensors.clock.push(`${base}/freq1_input`);
            const power = [`${base}/power1_input`, `${base}/power1_average`].find(exists);
            if (power)
                sensors.power.push(power);
        }
    }
    return sensors;
}

async function readMax(files, cancellable) {
    let result = null;
    for (const value of await Promise.all(files.map(file => readNumber(file, cancellable)))) {
        if (value !== null && (result === null || value > result))
            result = value;
    }
    return result;
}

async function readSum(files, cancellable) {
    let result = null;
    for (const value of await Promise.all(files.map(file => readNumber(file, cancellable)))) {
        if (value !== null)
            result = (result ?? 0) + value;
    }
    return result;
}

// load_contents_finish() throws a GError when the file cannot be read or the
// read was cancelled.
function readText(path, cancellable) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(cancellable, (_source, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                resolve(new TextDecoder().decode(bytes));
            }
            catch {
                resolve(null);
            }
        });
    });
}

// utime + stime of the whole process; the command name before them is in
// parentheses and may contain spaces.
async function readProcessTicks(cancellable) {
    const stat = await readText('/proc/self/stat', cancellable);
    if (!stat)
        return null;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = parseInt(fields[11], 10) + parseInt(fields[12], 10);
    return Number.isFinite(ticks) ? ticks : null;
}

async function readNumber(file, cancellable) {
    const text = await readText(file, cancellable);
    if (text === null)
        return null;
    const value = parseInt(text, 10);
    return Number.isFinite(value) ? value : null;
}

let _monitor = null;

/** Starts the record for `seconds` (0: until stopped), replacing a running one. */
export function startGlassMonitor(sources, seconds) {
    stopGlassMonitor();
    _monitor = new GlassMonitor(sources, Math.max(0, Math.floor(seconds)));
    _monitor.start();
}

export function stopGlassMonitor() {
    _monitor?.stop();
    _monitor = null;
}

/** Labels the running record's lines (a benchmark's scenario); null clears it. */
export function setGlassMonitorLabel(label) {
    _monitor?.setLabel(label);
}

export function isGlassMonitorRunning() {
    return _monitor !== null;
}
