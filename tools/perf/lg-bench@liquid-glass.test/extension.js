// Puts the desktop through fixed situations one after another and labels
// Liquid Glass's monitor lines (global._lgGlass.monitor) with the situation,
// so tools/perf/glass-monitor.sh can average each one. A development tool.
//
// From Looking Glass:
//   global._lgBench.run('all')                every scenario, B1 to B22
//   global._lgBench.run('B7')                 one of them ('B9a', ['B2', 'B3'], ...)
//   global._lgBench.run('all', {ab: true})    once with the glass, then once with no UI glass at all
//   options:
//     seconds  measured per scenario (default 30)
//     settle   waited before measuring (default 4)
//     modes    any of 'stage' (freshly built glass), 'none' (no UI glass at all) and 'outline' (freshly built
//              glass with every surface's outline on), each run in turn;
//              ab: true is ['stage', 'none']. Without either, the glass is used as it is.
//   global._lgBench.stop()   global._lgBench.list()   global._lgBench.running
//
// Each measured second's monitor line carries label=<scenario>/<mode>.
//
// While it runs it minimizes every window it did not open, turns the
// application glass off (it would cover the benchmark's own windows) except in
// the scenarios about it, turns on the glass the scenarios need, switches
// Quick Settings between background and toggle mode, turns the features a
// scenario is about (top bar, widgets, launcher, icon glass, ...) on for that
// scenario only, keeps the screen from blanking and parks the pointer on the
// left edge. All of that is put back at the end, minimized windows too.
// The mouse and keyboard should be left alone meanwhile.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LG_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';
const MEDIA_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lg-bench']);
const VIDEO = GLib.build_filenamev([MEDIA_DIR, 'video.mp4']);
const STILL = GLib.build_filenamev([MEDIA_DIR, 'still.png']);
const VIDEO_ID = 'lg-bench-video';
const STILL_IDS = ['lg-bench-still-a', 'lg-bench-still-b'];
// How far above the dock a window kept away from it ends: clear of the rect
// the dock glass samples (its blur reaches past the dock) and of the margin
// in which windows are still watched for it.
const AWAY_GAP = 300;

const GLASS_KEYS = ['enable-dock-glass', 'enable-menu-glass', 'enable-quick-settings-glass',
    'enable-notification-glass', 'enable-osd-glass', 'enable-extra-menu-glass'];
const OUTLINE_SURFACES = ['dock', 'menu', 'panel-menu', 'notification', 'quick-settings', 'osd', 'application',
    'desktop-menu', 'top-bar', 'desktop-widget', 'launcher'];
// What the scenarios start from, so that what the user has set does not leak
// into them; the scenarios about a feature turn it on for themselves.
const BASELINE = {
    'enable-application-glass': false,
    'application-glass-all-windows': false,
    'top-bar-style': 'off',
    'enable-launcher': false,
    'enable-desktop-widgets': false,
    'enable-glass-clock': false,
    'icon-style-dock': false,
    'icon-style-launcher': false,
    'icon-style-app-grid': false,
    'menu-grow-from-button': false,
    'panel-menu-grow-from-button': false,
    ...Object.fromEntries(OUTLINE_SURFACES.map(surface => [`${surface}-outline-enabled`, false])),
};
const QS_MODE_KEY = 'quick-settings-apply-to';
const QS_BACKGROUND = 0;
const QS_TOGGLES = 1;
const APP_GLASS = {'enable-application-glass': true, 'application-glass-all-windows': true};
const ICON_GLASS = {'icon-style-dock': true, 'icon-style-launcher': true, 'icon-style-app-grid': true};

// A scenario's `glass` settings turn on the glass it is about, so the mode
// without UI glass leaves them out; its `set` settings are applied in every mode.
const SCENARIOS = [
    {id: 'B1', title: '静止（窓 2 枚）'},
    {id: 'B2', title: '動画が dock の裏', video: 'dock'},
    {id: 'B3', title: '動画がガラスから離れた所', video: 'away'},
    {id: 'B4', title: '窓ドラッグ（dock の上）', setup: b => b.dragStart('dock'), measure: b => b.drag('dock')},
    {id: 'B5', title: '窓ドラッグ（離れた所）', setup: b => b.dragStart('away'), measure: b => b.drag('away')},
    {id: 'B6', title: 'カレンダーを開いたまま', setup: b => b.open(b.calendar)},
    {id: 'B7', title: 'カレンダーの開閉（1 秒ごと）', measure: b => b.cycleMenu(b.calendar)},
    {id: 'B8', title: '動画の上でカレンダーを開いたまま', video: 'calendar', setup: b => b.open(b.calendar)},
    {id: 'B9a', title: 'クイック設定・背景モードを開いたまま', qsMode: QS_BACKGROUND, setup: b => b.open(b.quickSettings)},
    {id: 'B9b', title: 'クイック設定・背景モードの開閉（1 秒ごと）', qsMode: QS_BACKGROUND, measure: b => b.cycleMenu(b.quickSettings)},
    {id: 'B10a', title: 'クイック設定・トグルモードを開いたまま', qsMode: QS_TOGGLES, setup: b => b.open(b.quickSettings)},
    {id: 'B10b', title: 'クイック設定・トグルモードの開閉（1 秒ごと）', qsMode: QS_TOGGLES, measure: b => b.cycleMenu(b.quickSettings)},
    {id: 'B11', title: 'オーバービューの開閉（1.5 秒ごと）', measure: b => b.cycleOverview()},
    {id: 'B12', title: 'ワークスペースの切り替え（1.5 秒ごと）', measure: b => b.cycleWorkspace()},
    {id: 'B13', title: '通知バナー（4 秒表示・1 秒消す、の繰り返し）', measure: b => b.notifications()},
    {id: 'B14', title: 'OSD（音量表示を 0.25 秒ごとに更新）', measure: b => b.osd()},
    {id: 'B15', title: 'フルスクリーン動画', video: 'fullscreen'},
    {id: 'B16a', title: 'トップバー・1 枚（静止）', glass: {'top-bar-style': 'pill'}},
    {id: 'B16b', title: 'トップバー・3 枚（静止）', glass: {'top-bar-style': 'islands'}},
    {id: 'B16c', title: 'トップバー・1 枚（動画がバーのすぐ下）', glass: {'top-bar-style': 'pill'}, video: 'bar'},
    {id: 'B17a', title: 'アプリ窓のガラス・窓 2 枚（静止）', glass: APP_GLASS},
    {id: 'B17b', title: 'アプリ窓のガラス・窓ドラッグ（dock の上）', glass: APP_GLASS, setup: b => b.dragStart('dock'),
        measure: b => b.drag('dock')},
    {id: 'B17c', title: 'アプリ窓のガラス・動画の窓にガラス', glass: APP_GLASS, video: 'away'},
    {id: 'B18a', title: 'デスクトップウィジェット（天気・予定、静止）', glass: {'enable-desktop-widgets': true},
        set: {'desktop-widgets': ['weather', 'events']}, settle: 6},
    {id: 'B18b', title: 'デスクトップのガラス時計（静止）', glass: {'enable-glass-clock': true}, settle: 6},
    {id: 'B19a', title: 'ランチャーを開いたまま', glass: {'enable-launcher': true}, setup: b => b.openLauncher('')},
    {id: 'B19b', title: 'ランチャーの開閉（1.5 秒ごと）', glass: {'enable-launcher': true}, measure: b => b.cycleLauncher()},
    {id: 'B19c', title: 'ランチャーで検索結果を出したまま', glass: {'enable-launcher': true}, setup: b => b.openLauncher('a'),
        settle: 6},
    {id: 'B20a', title: 'Clear アイコン・dock（静止）', glass: ICON_GLASS, set: {'icon-style-mode': 'clear'}, settle: 10},
    {id: 'B20b', title: 'Clear アイコン・アプリ一覧を開いたまま', glass: ICON_GLASS, set: {'icon-style-mode': 'clear'},
        setup: b => b.showApps(), settle: 10},
    {id: 'B20c', title: 'Clear アイコン・アプリ一覧のページ送り（1.5 秒ごと）', glass: ICON_GLASS, set: {'icon-style-mode': 'clear'},
        setup: b => b.showApps(), measure: b => b.cyclePages(), settle: 10},
    {id: 'B20d', title: 'Clear アイコン・動画が dock の裏', glass: ICON_GLASS, set: {'icon-style-mode': 'clear'}, video: 'dock',
        settle: 10},
    {id: 'B21a', title: '他のトップバーメニューを開いたまま', setup: async b => {
        await b.addPanelMenuButton();
        await b.open(b.panelMenu);
    }},
    {id: 'B21b', title: '他のトップバーメニューの開閉（1 秒ごと）', setup: b => b.addPanelMenuButton(),
        measure: b => b.cycleMenu(b.panelMenu)},
    {id: 'B22', title: 'カレンダーが「ボタンから伸びる」開閉（1 秒ごと）', set: {'menu-grow-from-button': true},
        measure: b => b.cycleMenu(b.calendar)},
];

class Aborted extends Error {}

const lg = () => global._lgGlass;

function note(msg) {
    console.log(`[Liquid Glass][monitor] bench ${msg}`);
}

function plainSleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function pick(which) {
    if (which === 'all')
        return SCENARIOS;
    const ids = (Array.isArray(which) ? which : [which]).map(id => String(id).toLowerCase());
    return SCENARIOS.filter(s => ids.includes(s.id.toLowerCase()));
}

function findWindow(appId) {
    for (const actor of global.get_window_actors()) {
        const win = actor.get_meta_window();
        if (win?.get_wm_class() === appId)
            return win;
    }
    return null;
}

// The players draw on the CPU into shared memory. mpv's GPU renderers
// register the player's own memory with the GPU (pinned or host-imported
// buffers); killing such players repeatedly crashed amdgpu on kernel 7.0
// here. A software player also keeps the video's own GPU work out of the
// measurement.
const MPV = ['mpv', '--no-config', '--vo=wlshm', '--osc=no', '--osd-level=0', '--no-input-default-bindings',
    '--keepaspect-window=no'];

const MINIMIZED_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

class Bench {
    constructor() {
        this._sleeps = new Set();
        this._procs = new Map();
        this._aborted = false;
        this._running = false;
        this._deadline = 0;
        this._pointer = null;
        this._source = null;
        this._saved = new Map();
        this._scenarioBase = new Map();
        this._panelButton = null;
        this._launcherModule = null;
    }

    get running() {
        return this._running;
    }

    get calendar() {
        return Main.panel.statusArea.dateMenu.menu;
    }

    get quickSettings() {
        return Main.panel.statusArea.quickSettings.menu;
    }

    get panelMenu() {
        return this._panelButton.menu;
    }

    list() {
        return SCENARIOS.map(s => `${s.id} ${s.title}`).join('\n');
    }

    run(which = 'all', options = {}) {
        if (this._running)
            return 'already running; global._lgBench.stop() first';
        const scenarios = pick(which);
        if (!scenarios.length)
            return `no such scenario: ${which}`;
        const opts = {seconds: 30, settle: 4, ab: false, ...options};
        opts.modes ??= opts.ab ? ['stage', 'none'] : [null];
        if (opts.modes.some(m => m !== null && !['stage', 'none', 'outline'].includes(m)))
            return `unknown mode in ${opts.modes}`;
        this._running = true;
        this._aborted = false;
        this._run(scenarios, opts).catch(e => {
            if (e instanceof Aborted) {
                note('stopped');
            } else {
                note(`failed: ${e}`);
                console.error(e);
            }
        }).finally(() => {
            this._running = false;
        });
        const minutes = scenarios.length * (opts.seconds + opts.settle + 3) * opts.modes.length / 60;
        return `bench started: ${scenarios.map(s => s.id).join(' ')}, about ${Math.ceil(minutes)} min`;
    }

    stop() {
        this._aborted = true;
        for (const cancel of [...this._sleeps])
            cancel();
        return 'stopping';
    }

    async _run(scenarios, opts) {
        if (!lg())
            throw new Error('Liquid Glass is not enabled');
        if (Main.sessionMode.isLocked)
            throw new Error('the screen is locked');
        const state = this._saveState();
        try {
            await this._ensureMedia();
            this._applySettings();
            this._parkPointer();
            this._minimizeOthers(state);
            await this._toWorkspace(0);
            note(`start: ${scenarios.map(s => s.id).join(' ')} seconds=${opts.seconds} settle=${opts.settle} ` +
                `modes=${opts.modes.map(m => m ?? 'as-is').join(',')} ${this._describeDisplay()}`);
            for (const sc of scenarios)
                note(`title ${sc.id}: ${sc.title}`);
            await this._spawnStills();
            for (const mode of opts.modes) {
                await this._useMode(mode);
                this._startMonitor();
                for (const sc of scenarios)
                    await this._scenario(sc, opts);
                this._applyScenarioSettings({});
            }
            note('done');
        } finally {
            await this._restore(state);
        }
    }

    // Settings, windows and modes to put back afterwards. Liquid Glass's own
    // settings are saved the first time _put() changes them.
    _saveState() {
        const lgSettings = Extension.lookupByUUID(LG_UUID).getSettings();
        const session = new Gio.Settings({schema_id: 'org.gnome.desktop.session'});
        const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        const saved = [];
        saved.push([session, 'idle-delay', session.get_value('idle-delay')]);
        saved.push([notifications, 'show-banners', notifications.get_value('show-banners')]);
        this._lgSettings = lgSettings;
        this._session = session;
        this._notifications = notifications;
        this._saved.clear();
        this._scenarioBase.clear();
        return {
            saved,
            minimized: [],
            workspace: global.workspace_manager.get_active_workspace_index(),
            monitorWasRunning: lg().monitorRunning(),
        };
    }

    _put(key, value) {
        const current = this._lgSettings.get_value(key);
        if (!this._saved.has(key))
            this._saved.set(key, current);
        this._lgSettings.set_value(key, new GLib.Variant(current.get_type_string(), value));
    }

    _applySettings() {
        for (const key of GLASS_KEYS)
            this._put(key, true);
        for (const [key, value] of Object.entries(BASELINE))
            this._put(key, value);
        this._session.set_uint('idle-delay', 0);
        this._notifications.set_boolean('show-banners', true);
    }

    // The settings a scenario is about, on top of the baseline: what an
    // earlier scenario changed goes back first.
    _applyScenarioSettings(sc) {
        const wanted = {...(this._mode === 'none' ? {} : sc.glass), ...sc.set};
        for (const [key, base] of this._scenarioBase) {
            if (key in wanted)
                continue;
            this._put(key, base);
            this._scenarioBase.delete(key);
        }
        for (const [key, value] of Object.entries(wanted)) {
            if (!this._scenarioBase.has(key))
                this._scenarioBase.set(key, this._lgSettings.get_value(key).deep_unpack());
            this._put(key, value);
        }
    }

    async _restore(state) {
        lg()?.monitorLabel(null);
        this._closeMenus(false);
        if (Main.overview.visible)
            Main.overview.hide();
        Main.osdWindowManager.hideAll();
        this._dropNotifications();
        for (const appId of [...this._procs.keys()])
            await this._quit(appId);
        this._destroyPanelButton();
        this._closeLauncher();
        for (const [settings, key, value] of state.saved)
            settings.set_value(key, value);
        for (const [key, value] of this._saved)
            this._lgSettings.set_value(key, value);
        if (lg() && !state.monitorWasRunning)
            lg().monitorStop();
        for (const win of state.minimized) {
            if (win.get_compositor_private())
                win.unminimize();
        }
        global.workspace_manager.get_workspace_by_index(state.workspace)?.activate(global.get_current_time());
        this._pointer = null;
        note('restored');
    }

    _sleep(ms) {
        if (this._aborted)
            return Promise.reject(new Aborted());
        return new Promise((resolve, reject) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(ms)), () => {
                this._sleeps.delete(cancel);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            const cancel = () => {
                GLib.Source.remove(id);
                this._sleeps.delete(cancel);
                reject(new Aborted());
            };
            this._sleeps.add(cancel);
        });
    }

    _remainingMs() {
        return (this._deadline - GLib.get_monotonic_time()) / 1000;
    }

    // Sleeps `ms`, or until the measurement ends; false once it has.
    async _tick(ms) {
        const left = this._remainingMs();
        if (left <= 0)
            return false;
        await this._sleep(Math.min(ms, left));
        return this._remainingMs() > 0;
    }

    async _untilDeadline() {
        while (await this._tick(1000)) { /* wait */ }
    }

    async _scenario(sc, opts) {
        await this._reset(sc);
        this._applyScenarioSettings(sc);
        note(`scenario ${sc.id} mode=${this._mode}`);
        if (sc.video)
            await this._showVideo(sc.video);
        else
            await this._closeVideo();
        if (sc.setup)
            await sc.setup(this);
        await this._sleep((sc.settle ?? opts.settle) * 1000);
        this._dropNotifications();
        await this._sleep(600);
        this._deadline = GLib.get_monotonic_time() + opts.seconds * 1e6;
        lg().monitorLabel(`${sc.id}/${this._mode}`);
        try {
            await (sc.measure ? sc.measure(this) : this._untilDeadline());
        } finally {
            lg()?.monitorLabel(null);
        }
    }

    // Back to the plain desktop: menus closed, no overview, OSD or
    // fullscreen, the first workspace, both still windows in place.
    async _reset(sc) {
        this._closeMenus(false);
        this._closeLauncher();
        if (Main.overview.visible) {
            Main.overview.hide();
            await this._sleep(800);
        }
        Main.osdWindowManager.hideAll();
        this._dropNotifications();
        await this._toWorkspace(0);
        if (sc.qsMode !== undefined && this._lgSettings.get_int(QS_MODE_KEY) !== sc.qsMode) {
            this._lgSettings.set_int(QS_MODE_KEY, sc.qsMode);
            await this._sleep(1500);
        }
        this._parkPointer();
        await this._spawnStills();
    }

    _closeMenus(animate) {
        for (const menu of [this.calendar, this.quickSettings]) {
            if (menu.isOpen)
                menu.close(animate);
        }
    }

    async _toWorkspace(index) {
        const ws = global.workspace_manager.get_workspace_by_index(index);
        if (!ws || global.workspace_manager.get_active_workspace() === ws)
            return;
        ws.activate(global.get_current_time());
        await this._sleep(800);
    }

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _workArea() {
        return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    }

    _sizes() {
        const m = this._monitor();
        const sw = Math.round(m.width * 0.28);
        const vw = Math.round(m.width * 0.42);
        return {sw, sh: Math.round(sw * 0.625), vw, vh: Math.round(vw * 9 / 16)};
    }

    // The dock's visible background; a bottom strip if Dash to Dock is not there.
    _dock() {
        const container = Main.layoutManager.uiGroup.get_children().find(a => a.get_name() === 'dashtodockContainer');
        const bg = container?.dash?._background;
        if (bg?.mapped) {
            const e = bg.get_transformed_extents();
            return {x: e.origin.x, y: e.origin.y, w: e.size.width, h: e.size.height};
        }
        const m = this._monitor();
        return {x: m.x + m.width / 4, y: m.y + m.height - 100, w: m.width / 2, h: 90};
    }

    _parkPointer() {
        this._pointer ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const m = this._monitor();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), m.x + 1, m.y + Math.round(m.height * 0.55));
    }

    _minimizeOthers(state) {
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (!win || win.minimized || !win.can_minimize() || this._isOurs(win))
                continue;
            if (!MINIMIZED_TYPES.includes(win.get_window_type()))
                continue;
            win.minimize();
            state.minimized.push(win);
        }
    }

    _isOurs(win) {
        const id = win.get_wm_class();
        return id === VIDEO_ID || STILL_IDS.includes(id);
    }

    _describeDisplay() {
        const monitors = Main.layoutManager.monitors.map(m => `${m.width}x${m.height}@${m.geometry_scale}`);
        const rates = global.stage.peek_stage_views().map(v => `${v.get_refresh_rate().toFixed(0)}Hz`);
        return `monitors=${monitors.join(',')} refresh=${rates.join(',')}`;
    }

    async _ensureMedia() {
        GLib.mkdir_with_parents(MEDIA_DIR, 0o755);
        const lavfi = ['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i'];
        if (!GLib.file_test(VIDEO, GLib.FileTest.EXISTS)) {
            note(`making ${VIDEO}`);
            await this._exec([...lavfi, 'testsrc2=size=1280x720:rate=60', '-t', '10',
                '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', VIDEO]);
        }
        if (!GLib.file_test(STILL, GLib.FileTest.EXISTS)) {
            note(`making ${STILL}`);
            await this._exec([...lavfi, 'testsrc2=size=1280x720', '-frames:v', '1', STILL]);
        }
    }

    _exec(argv) {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE);
        return new Promise((resolve, reject) => {
            proc.wait_async(null, (p, res) => {
                p.wait_finish(res);
                if (p.get_successful())
                    resolve();
                else
                    reject(new Error(`${argv[0]} failed`));
            });
        });
    }

    async _spawn(appId, argv) {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        this._procs.set(appId, proc);
        const stderr = this._readAll(proc.get_stderr_pipe());
        for (let i = 0; i < 100; i++) {
            await this._sleep(100);
            // A shell that has just started shows the overview, where window actors are hidden.
            if (Main.overview.visible)
                Main.overview.hide();
            // A client that waits for a frame callback gets none from a stage nothing is drawing on.
            global.stage.queue_redraw();
            const win = findWindow(appId);
            // Placed and stacked only once shown.
            if (win?.get_compositor_private()?.mapped) {
                win.change_workspace_by_index(0, false);
                await this._sleep(300);
                return win;
            }
        }
        const output = await Promise.race([stderr, plainSleep(300).then(() => '(nothing)')]);
        throw new Error(`no window for ${appId}; ${argv[0]} said: ${output}`);
    }

    _readAll(stream) {
        return new Promise(resolve => stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            resolve(new TextDecoder().decode(src.read_bytes_finish(res).toArray()).trim());
        }));
    }

    async _spawnStills() {
        const {sw, sh} = this._sizes();
        for (const id of STILL_IDS) {
            if (findWindow(id))
                continue;
            await this._spawn(id, [...MPV, `--wayland-app-id=${id}`, `--title=${id}`,
                '--image-display-duration=inf', `--geometry=${sw}x${sh}`, STILL]);
        }
        await this._placeStills();
    }

    // A at the top left, B at the top right, away from the dock.
    async _placeStills() {
        const m = this._monitor();
        const wa = this._workArea();
        const {sw, sh} = this._sizes();
        const y = wa.y + Math.round(m.height * 0.05);
        const spots = [m.x + Math.round(m.width * 0.04), m.x + Math.round(m.width * 0.96) - sw];
        let moved = false;
        STILL_IDS.forEach((id, i) => {
            const win = findWindow(id);
            if (!win)
                return;
            if (win.minimized)
                win.unminimize();
            const r = win.get_frame_rect();
            if (r.x === spots[i] && r.y === y && r.width === sw && r.height === sh)
                return;
            win.move_resize_frame(true, spots[i], y, sw, sh);
            moved = true;
        });
        if (moved)
            await this._sleep(500);
    }

    async _showVideo(where) {
        let win = findWindow(VIDEO_ID);
        if (!win) {
            const {vw, vh} = this._sizes();
            win = await this._spawn(VIDEO_ID, [...MPV, `--wayland-app-id=${VIDEO_ID}`, `--title=${VIDEO_ID}`,
                '--loop-file=inf', '--no-audio', '--hwdec=no', `--geometry=${vw}x${vh}`, VIDEO]);
        }
        if (where === 'fullscreen') {
            win.move_to_monitor(Main.layoutManager.primaryIndex);
            win.make_fullscreen();
            await this._sleep(800);
            return;
        }
        if (win.is_fullscreen()) {
            win.unmake_fullscreen();
            await this._sleep(500);
        }
        const m = this._monitor();
        const wa = this._workArea();
        const dock = this._dock();
        const {vw, vh} = this._sizes();
        const centerX = m.x + Math.round((m.width - vw) / 2);
        let x = centerX, y;
        if (where === 'dock') {
            // Down to the dock's bottom edge, so the whole dock has video behind it.
            x = Math.round(dock.x + dock.w / 2 - vw / 2);
            y = Math.round(dock.y + dock.h) - vh;
        } else if (where === 'away') {
            y = Math.max(wa.y + 8, Math.round(dock.y) - AWAY_GAP - vh);
        } else if (where === 'bar') {
            y = wa.y;
        } else {
            y = wa.y + 8;
        }
        win.move_resize_frame(true, x, y, vw, vh);
        win.raise();
        await this._sleep(500);
    }

    async _closeVideo() {
        await this._quit(VIDEO_ID);
        for (let i = 0; i < 30 && findWindow(VIDEO_ID); i++)
            await this._sleep(100);
    }

    // Asks a player to quit and waits for it; only one still running after
    // 3 s is killed.
    async _quit(appId) {
        const proc = this._procs.get(appId);
        if (!proc)
            return;
        this._procs.delete(appId);
        const exited = new Promise(resolve => proc.wait_async(null, (p, res) => {
            p.wait_finish(res);
            resolve(true);
        }));
        proc.send_signal(15);
        if (!await Promise.race([exited, plainSleep(3000).then(() => false)]))
            proc.force_exit();
    }

    // Window B's band for the drag scenarios: over the dock, or clear of it.
    _dragBand(where) {
        const m = this._monitor();
        const dock = this._dock();
        const {sw, sh} = this._sizes();
        const y = where === 'dock' ? Math.round(dock.y + dock.h) - sh : Math.round(dock.y) - AWAY_GAP - sh;
        return {y, x0: m.x + Math.round(m.width * 0.04), x1: m.x + Math.round(m.width * 0.96) - sw};
    }

    async dragStart(where) {
        const {y, x0} = this._dragBand(where);
        findWindow(STILL_IDS[1])?.move_frame(true, x0, y);
        await this._sleep(300);
    }

    // Window B across the screen and back every 4 s, moved once per frame
    // like a drag.
    async drag(where) {
        const win = findWindow(STILL_IDS[1]);
        if (!win)
            throw new Error('the still window is gone');
        const {y, x0, x1} = this._dragBand(where);
        const timeline = new Clutter.Timeline({actor: global.stage, duration: 4000, repeat_count: -1});
        timeline.connect('new-frame', () => {
            const p = timeline.get_progress();
            const there = p < 0.5 ? p * 2 : 2 - p * 2;
            win.move_frame(true, Math.round(x0 + (x1 - x0) * there), y);
        });
        timeline.start();
        try {
            await this._untilDeadline();
        } finally {
            timeline.stop();
        }
    }

    async open(menu) {
        menu.open(true);
        await this._sleep(100);
    }

    async cycleMenu(menu) {
        do {
            if (menu.isOpen)
                menu.close(true);
            else
                menu.open(true);
        } while (await this._tick(1000));
    }

    // A bar menu of some other indicator, like the ones extensions add.
    async addPanelMenuButton() {
        if (this._panelButton)
            return;
        const button = new PanelMenu.Button(0.5, 'Liquid Glass bench', false);
        button.add_child(new St.Icon({icon_name: 'applications-system-symbolic', style_class: 'system-status-icon'}));
        for (let i = 1; i <= 6; i++)
            button.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Bench item ${i}`));
        Main.panel.addToStatusArea('lg-bench-menu', button);
        this._panelButton = button;
        // The glass is attached to a new indicator's menu after a scan.
        await this._sleep(2500);
    }

    _destroyPanelButton() {
        this._panelButton?.destroy();
        this._panelButton = null;
    }

    async _launcher() {
        this._launcherModule ??= await import(`file://${Extension.lookupByUUID(LG_UUID).path}/dist/launcherManager.js`);
        return this._launcherModule.Launcher.instance;
    }

    async openLauncher(query) {
        const launcher = await this._launcher();
        launcher.open();
        launcher.setText(query);
        await this._sleep(500);
    }

    _closeLauncher() {
        this._launcherModule?.Launcher.instance?.close();
    }

    async cycleLauncher() {
        const launcher = await this._launcher();
        let open = false;
        do {
            open = !open;
            if (open)
                launcher.open();
            else
                launcher.close();
        } while (await this._tick(1500));
        launcher.close();
    }

    async showApps() {
        Main.overview.showApps();
        await this._sleep(1000);
    }

    // The app grid's first two pages in turn.
    async cyclePages() {
        const grid = Main.overview._overview.controls._appDisplay;
        let page = 0;
        do
            grid.goToPage(page ^= 1);
        while (await this._tick(1500));
    }

    async cycleOverview() {
        do
            Main.overview.toggle();
        while (await this._tick(1500));
    }

    async cycleWorkspace() {
        const manager = global.workspace_manager;
        if (manager.n_workspaces < 2) {
            note('only one workspace; B12 just waits');
            await this._untilDeadline();
            return;
        }
        do {
            const next = manager.get_active_workspace_index() === 0 ? 1 : 0;
            manager.get_workspace_by_index(next).activate(global.get_current_time());
        } while (await this._tick(1500));
    }

    // A banner stays up until the user does something, so each one is
    // withdrawn after a while to see banners come and go. A source goes away
    // with its last notification, so each banner gets its own.
    async notifications() {
        let i = 0;
        for (;;) {
            const source = new MessageTray.Source({title: 'Liquid Glass bench', iconName: 'dialog-information-symbolic'});
            source.connect('destroy', () => {
                if (this._source === source)
                    this._source = null;
            });
            this._source = source;
            Main.messageTray.add(source);
            source.addNotification(new MessageTray.Notification({
                source, title: 'Liquid Glass bench', body: `Notification ${++i}`, isTransient: true,
            }));
            const more = await this._tick(4000);
            this._dropNotifications();
            if (!more || !await this._tick(1000))
                break;
        }
    }

    // The bench's own banner, and the one that says glass icons are being made
    // (the icon scenarios start that).
    _dropNotifications() {
        this._source?.destroy();
        for (const notification of [...MessageTray.getSystemSource().notifications]) {
            if (/glass icons/i.test(notification.title))
                notification.destroy();
        }
    }

    async osd() {
        const icon = new Gio.ThemedIcon({name: 'audio-volume-medium-symbolic'});
        const start = GLib.get_monotonic_time();
        do {
            const t = (GLib.get_monotonic_time() - start) / 1e6;
            Main.osdWindowManager.showOne(Main.layoutManager.primaryIndex, icon, null, 0.5 + 0.4 * Math.sin(t * 2), 1);
        } while (await this._tick(250));
        Main.osdWindowManager.hideAll();
    }

    _startMonitor() {
        if (!lg().monitorRunning())
            lg().monitor(0);
    }

    // 'stage' starts from freshly built glass; 'outline' is 'stage' with every
    // surface's outline on; 'none' turns the UI glass off; null keeps what is there.
    async _useMode(mode) {
        if (mode === null) {
            this._mode = 'stage';
            return;
        }
        this._mode = mode;
        for (const key of GLASS_KEYS)
            this._put(key, mode !== 'none');
        for (const surface of OUTLINE_SURFACES)
            this._put(`${surface}-outline-enabled`, mode === 'outline');
        if (mode === 'none') {
            await this._sleep(1500);
            return;
        }
        await this._rebuildGlass(ms => this._sleep(ms));
    }

    // The extension is restarted, as a user would toggle it, so every glass
    // starts fresh. Its own enable() and disable() are called, not the shell's
    // disableExtension(), which would also disable and enable every extension
    // that came after it, this one included.
    async _rebuildGlass(sleep) {
        const extension = Main.extensionManager.lookup(LG_UUID).stateObj;
        extension.disable();
        await sleep(1000);
        extension.enable();
        await sleep(4000);
    }
}

export default class LgBench extends Extension {
    enable() {
        this._bench = new Bench();
        global._lgBench = this._bench;
    }

    disable() {
        this._bench.stop();
        this._bench = null;
        delete global._lgBench;
    }
}
