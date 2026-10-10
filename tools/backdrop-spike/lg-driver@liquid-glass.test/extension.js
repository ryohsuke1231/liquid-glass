// Drives the real Liquid Glass extension (and Dash to Dock) in the headless
// shell started by run-glass.sh. Reports through "[drv] ..." log lines and
// PNGs in $LG_SPIKE_OUT, then terminates the shell.
//
// Scenarios ($LG_DRV_SCENARIO):
//   dock       the dock over windows, a changing background and UI actors
//   ui         the calendar menu, Quick Settings, a notification and the OSD
//   toggles    Quick Settings in toggle mode
//   fullstage  how many frames redraw the whole stage while the calendar opens
//   monitor    global._lgGlass.monitor() while windows move and a menu opens
//   lifecycle  disables and enables Liquid Glass with every glass shown once
//   window     application glass on a foot window: drag, a busy window behind,
//              a change in front, minimise, resize and close
//   arcmenu    ArcMenu's menu in several layouts and locations, its context
//              menu, and ArcMenu disabled and enabled again (run-glass.sh with
//              LG_EXTRA_EXTENSIONS=arcmenu@arcmenu.com)
//   adaptive   adaptive text colour: the backdrop read against a bare screen,
//              the colours while a menu opens, hovered rows, and the OSD while
//              its level changes
//   features   the top bar, menus growing out of their buttons, the desktop
//              widgets, the glass clock and the launcher, on a photo wallpaper
//              ($LG_DRV_WALLPAPER); LG_DRV_FEATURES picks parts (comma
//              separated: morph, topbar, widgets, clock, launcher; default all;
//              also morphtrace, qssub, clockshot, media, guides)
//   bench      global._lgBench.run() (run-glass.sh with LG_BENCH=1); LG_DRV_BENCH
//              picks scenarios (comma separated, default all), LG_DRV_BENCH_SECONDS
//              the seconds per scenario (default 3), LG_DRV_BENCH_AB=1 adds a run without UI glass
//
// Screenshots are off-stage paints, where a stage-reading glass draws with
// its last on-screen copy. The camera shows what was really on screen: while
// armed it copies a stage rect out of the framebuffer on every frame and
// draws that copy, so a screenshot of the camera is the on-screen result.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT_DIR = GLib.getenv('LG_SPIKE_OUT') ?? GLib.get_tmp_dir();
const SCENARIO = GLib.getenv('LG_DRV_SCENARIO') ?? 'dock';
const LG_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';
const ARCMENU_UUID = 'arcmenu@arcmenu.com';
const COLORS = ['rgb(255,0,255)', 'rgb(255,255,0)'];

function log(msg) {
  console.log(`[drv] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);

// The same version split as the extension's shellVersion.ts.
function coglContext() {
  const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
  return backend.get_cogl_context();
}

// GNOME 46 calls paint_node without the paint context; see paintNodeWithContext()
// in the extension's shellVersion.ts.
function paintNodeWithContext(klass) {
  if (SHELL_MAJOR >= 47)
    return klass;
  const proto = klass.prototype;
  const paintNode = proto.vfunc_paint_node;
  delete proto.vfunc_paint_node;
  const parentPaint = Object.getPrototypeOf(proto).vfunc_paint;
  proto.vfunc_paint = function (paintContext) {
    const root = Clutter.ClipNode.new();
    paintNode.call(this, root, paintContext);
    root.paint(paintContext);
    parentPaint.call(this, paintContext);
  };
  return klass;
}

function newRootNode(framebuffer, colorState) {
  if (SHELL_MAJOR >= 48)
    return Clutter.RootNode.new(framebuffer, colorState, new Cogl.Color(), 0);
  return Clutter.RootNode.new(framebuffer, SHELL_MAJOR >= 47 ? new Cogl.Color() : new Clutter.Color(), 0);
}

function shot(name, [x, y, w, h]) {
  return new Promise(resolve => {
    const path = `${OUT_DIR}/${name}.png`;
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    new Shell.Screenshot().screenshot_area(x, y, w, h, stream, (obj, res) => {
      try {
        obj.screenshot_area_finish(res);
      } catch (e) {
        log(`shot ${name} failed: ${e}`);
      }
      stream.close(null);
      resolve();
    });
  });
}

const Camera = GObject.registerClass(paintNodeWithContext(
class Camera extends Clutter.Actor {
  _init(rect) {
    super._init({name: 'drv-camera', reactive: false});
    this.rect = rect;
    this.tex = null;
    this.off = null;
    this.armed = false;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(root, paintContext) {
    const fb = paintContext.get_framebuffer();
    const view = this.peek_stage_views().find(v => v.get_framebuffer() === fb);
    if (this.armed && view && !this.is_in_clone_paint()) {
      const s = view.get_scale();
      const l = view.layout;
      const [x, y, w, h] = this.rect;
      const fx = Math.floor(x * s) + Math.round(-l.x * s);
      const fy = Math.floor(y * s) + Math.round(-l.y * s);
      const fw = Math.ceil(w * s);
      const fh = Math.ceil(h * s);
      if (!this.tex || this.tex.get_width() !== fw || this.tex.get_height() !== fh) {
        this.tex = Cogl.Texture2D.new_with_size(coglContext(), fw, fh);
        this.off = Cogl.Offscreen.new_with_texture(this.tex);
        this.off.allocate();
      }
      const target = newRootNode(this.off, view.color_state);
      root.add_child(target);
      const blit = Clutter.BlitNode.new(fb);
      blit.add_blit_rectangle(fx, fy, 0, 0, fw, fh);
      target.add_child(blit);
    }
    if (!this.tex)
      return;
    const pipeline = Cogl.Pipeline.new(coglContext());
    pipeline.set_layer_texture(0, this.tex);
    const node = Clutter.PipelineNode.new(pipeline);
    const [w, h] = this.get_size();
    node.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}), 0, 0, 1, 1);
    root.add_child(node);
  }
}));

// Paints nothing; records whether each frame redrew the whole stage.
const ClipProbe = GObject.registerClass(paintNodeWithContext(
class ClipProbe extends Clutter.Actor {
  _init(rect) {
    super._init({name: 'drv-clip-probe', reactive: false});
    this.set_position(rect[0], rect[1]);
    this.set_size(rect[2], rect[3]);
    this.rect = rect;
    this.last = null;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(_root, paintContext) {
    const clip = paintContext.get_redraw_clip();
    const [x, y, width, height] = this.rect;
    this.last = clip
      ? ['OUT', 'IN', 'PART'][clip.contains_rectangle(new Mtk.Rectangle({x, y, width, height}))]
      : 'NOCLIP';
  }
}));

function lg() {
  return global._lgGlass;
}

function glassRows() {
  const out = lg()?.dump() ?? '';
  const rows = [];
  for (const line of out.split('\n')) {
    try {
      rows.push(JSON.parse(line));
    } catch {
    }
  }
  return rows;
}

function glassRow(owner) {
  return glassRows().find(r => r.owner === owner) ?? null;
}

function findActors(root, test) {
  const out = test(root) ? [root] : [];
  for (const child of root.get_children())
    out.push(...findActors(child, test));
  return out;
}

function findActor(root, name) {
  return findActors(root, a => a.get_name() === name)[0] ?? null;
}

function delta(a, b) {
  if (!a || !b)
    return 'n/a';
  return Object.keys(a).filter(k => typeof a[k] === 'number').map(k => `${k}=${b[k] - a[k]}`).join(' ');
}

export default class LgDriver extends Extension {
  enable() {
    this._actors = [];
    this._procs = [];
    this._signals = [];
    this._frames = 0;
    this._camera = null;
    this._cameraAway = false;
    this._signals.push([global.stage, global.stage.connect('after-paint', () => this._frames++)]);
    this._signals.push([global.stage, global.stage.connect('before-update', () => {
      if (this._camera?.armed)
        this._camera.queue_redraw();
    })]);
    // Disabling Liquid Glass makes the shell disable and enable the
    // extensions enabled after it, possibly this one: run the scenario once.
    if (globalThis._lgDriverStarted)
      return;
    globalThis._lgDriverStarted = true;
    this._run().catch(e => log(`FAILED ${e}\n${e.stack}`)).finally(() => this._finish());
  }

  disable() {
    for (const [obj, id] of this._signals)
      obj.disconnect(id);
    this._signals = [];
    for (const actor of this._actors)
      actor.destroy();
    this._actors = [];
    for (const proc of this._procs)
      proc.force_exit();
    this._procs = [];
  }

  async _run() {
    if (Main.layoutManager._startingUp) {
      await new Promise(resolve => {
        const id = Main.layoutManager.connect('startup-complete', () => {
          Main.layoutManager.disconnect(id);
          resolve();
        });
      });
    }
    if (Main.overview.visible)
      Main.overview.hide();
    await sleep(1500);
    // A banner's glass redraws while it is shown; the scenarios want a quiet stage.
    for (const source of Main.messageTray.getSources())
      source.destroy();
    await sleep(1500);
    for (const view of global.stage.peek_stage_views()) {
      const l = view.layout;
      log(`view layout=[${l.x},${l.y},${l.width},${l.height}] scale=${view.get_scale()}`);
    }
    this._camera = this._add(new Camera([0, 0, 10, 10]));
    this._camera.set_position(20, 60);
    for (let i = 0; i < 40 && !this._glass('dock'); i++)
      await sleep(250);

    if (SCENARIO === 'dock')
      await this._dockScenario();
    else if (SCENARIO === 'ui')
      await this._uiScenario();
    else if (SCENARIO === 'toggles')
      await this._togglesScenario();
    else if (SCENARIO === 'fullstage')
      await this._fullStageScenario();
    else if (SCENARIO === 'monitor')
      await this._monitorScenario();
    else if (SCENARIO === 'lifecycle')
      await this._lifecycleScenario();
    else if (SCENARIO === 'window')
      await this._windowScenario();
    else if (SCENARIO === 'bench')
      await this._benchScenario();
    else if (SCENARIO === 'arcmenu')
      await this._arcMenuScenario();
    else if (SCENARIO === 'adaptive')
      await this._adaptiveScenario();
    else if (SCENARIO === 'features')
      await this._featuresScenario();
    log(`dump\n${lg().dump()}`);
  }

  _add(actor, below = null) {
    if (below)
      Main.layoutManager.uiGroup.insert_child_below(actor, below);
    else
      Main.layoutManager.uiGroup.add_child(actor);
    this._actors.push(actor);
    return actor;
  }

  _drop(actor) {
    actor.destroy();
    this._actors = this._actors.filter(a => a !== actor);
  }

  _lgSettings() {
    return Extension.lookupByUUID(LG_UUID).getSettings();
  }

  // Rebuilds one surface's glass by switching it off and on.
  async _rebuild(key) {
    const settings = this._lgSettings();
    settings.set_boolean(key, false);
    await sleep(300);
    settings.set_boolean(key, true);
    await sleep(2500);
  }

  _glass(owner) {
    return lg()?.glassObjects().find(g => g._owner === owner) ?? null;
  }

  _stats(owner) {
    return this._glass(owner)?.stats ?? null;
  }

  // A glass's rect plus room for its shadow, in stage coordinates.
  _region(owner) {
    let g = lg()?.geom(owner)[0];
    // Toggle mode draws regions; its composite rect covers them.
    if (!(g?.w > 0)) {
      const r = glassRow(owner)?.compositeRect ?? glassRow(owner)?.u?.compositeRect;
      g = r ? {x: r[0], y: r[1], w: r[2], h: r[3]} : null;
    }
    if (!g || !(g.w > 0))
      return null;
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, Math.floor(m.x + g.x - 40));
    const y = Math.max(0, Math.floor(m.y + g.y - 40));
    const w = Math.min(m.width - x, Math.ceil(g.w + 80));
    const h = Math.min(m.height - y, Math.ceil(g.h + 80));
    return [x, y, w, h];
  }

  async _shots(tag, rect, owner) {
    // Menus at the top left would cover the camera's usual place.
    if (this._cameraAway) {
      const m = Main.layoutManager.primaryMonitor;
      this._camera.set_position(rect[0] + rect[2] / 2 < m.width / 2 ? m.width - rect[2] : 0, 60);
    }
    this._camera.rect = rect;
    this._camera.set_size(rect[2], rect[3]);
    this._camera.armed = true;
    // On a quiet stage nothing else asks for a frame.
    this._camera.queue_redraw();
    await sleep(200);
    const name = tag.replace(/ /g, '-');
    await shot(`${name}-screen`, rect);
    await shot(`${name}-camera`, [this._camera.x, this._camera.y, rect[2], rect[3]]);
    this._camera.armed = false;
    const row = glassRow(owner);
    if (!row) {
      log(`${tag}: no ${owner} glass row`);
      return;
    }
    const keys = ['mode', 'paints', 'copies', 'reuses', 'offStage', 'misses', 'materialCopies', 'blurRuns',
      'blurSkips', 'relayChanges', 'copy', 'desktop', 'material', 'blurRect', 'composited'];
    const picked = Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
    log(`${tag} frames=${this._frames} ${JSON.stringify(picked)} relays=${JSON.stringify(row.relays ?? null)}`);
  }

  // A window that redraws every frame. glxgears needs an X server, which the
  // shell in a distrobox runs without; there a terminal printing without
  // pause stands in.
  _spawnGears() {
    if (GLib.getenv('DISPLAY') && GLib.find_program_in_path('glxgears'))
      return this._spawn(['glxgears'], 'gears');
    return this._spawn(['foot', '-T', 'lgdrv-gears', 'sh', '-c', 'while :; do echo $RANDOM$RANDOM$RANDOM; done'], 'gears');
  }

  async _spawn(argv, title) {
    let proc;
    try {
      proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
      log(`spawn ${argv[0]} failed: ${e}`);
      return null;
    }
    this._procs.push(proc);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const actor = global.get_window_actors().find(a => (a.get_meta_window()?.get_title() ?? '').includes(title));
      if (actor)
        return {proc, actor, win: actor.get_meta_window()};
    }
    log(`no window for ${title}`);
    return null;
  }

  // Runs `step` between frames and checks the frame after each step: with
  // the backdrop changing behind the glass, that frame must take a new copy.
  // With `expectCopy` false (a change in front of the glass), it must not.
  async _audit(tag, owner, steps, intervalMs, step, expectCopy = true) {
    const glass = typeof owner === 'string' ? this._glass(owner) : owner;
    if (!glass) {
      log(`${tag} audit: no stage-reading ${owner} glass`);
      return;
    }
    const rec = [];
    let prev = glass.stats;
    let pending = false;
    const id = global.stage.connect('after-paint', () => {
      const cur = glass.stats;
      if (pending) {
        rec.push({painted: cur.paints > prev.paints, copied: cur.copies > prev.copies,
          reused: cur.reuses > prev.reuses, missed: cur.misses > prev.misses});
      }
      pending = false;
      prev = cur;
    });
    for (let i = 0; i < steps; i++) {
      step(i);
      pending = true;
      await sleep(intervalMs);
    }
    await sleep(100);
    global.stage.disconnect(id);
    const count = f => rec.filter(f).length;
    const bad = expectCopy ? count(r => !r.copied || !r.painted) : count(r => r.copied);
    log(`${tag} audit steps=${steps} frames=${rec.length} painted=${count(r => r.painted)} ` +
      `copied=${count(r => r.copied)} reused=${count(r => r.reused)} missed=${count(r => r.missed)} ` +
      `${expectCopy ? 'stale' : 'needless-copy'}=${bad} ${bad === 0 ? 'OK' : 'NG'}`);
  }

  // Frames and glass counters over a quiet period; both should stay put.
  async _idle(tag, owner, ms) {
    const before = this._stats(owner);
    const frames = this._frames;
    await sleep(ms);
    log(`${tag} idle ${ms}ms frames=${this._frames - frames} ${delta(before, this._stats(owner))}`);
  }

  // A plain widget behind a glass in paint order, inside `rect`.
  _behind(owner, rect, w = 120, h = 60) {
    const glass = this._glass(owner);
    const anchor = glass?.reader ?? glass;
    const widget = new St.Widget({name: `drv-behind-${owner}`, reactive: false, style: `background-color: ${COLORS[1]};`});
    widget.set_position(rect[0] + 60, rect[1] + 60);
    widget.set_size(w, h);
    return this._add(widget, anchor?.get_parent() === Main.layoutManager.uiGroup ? anchor : null);
  }

  // Counts whole-stage redraws while `run` runs.
  async _countFullStage(run) {
    const m = Main.layoutManager.primaryMonitor;
    const probe = this._add(new ClipProbe([m.x, m.y, m.width, m.height]));
    let frames = 0, full = 0;
    const id = global.stage.connect('after-paint', () => {
      frames++;
      if (probe.last === 'IN')
        full++;
      probe.last = null;
    });
    await run();
    global.stage.disconnect(id);
    this._drop(probe);
    return `frames=${frames} full-stage=${full}`;
  }

  async _dockScenario() {
    const region = this._region('dock');
    if (!region) {
      log('no dock glass');
      return;
    }
    log(`dock region=${JSON.stringify(region)}`);
    await this._shots('d0 baseline', region, 'dock');
    await this._idle('d0', 'dock', 2000);

    // An actor behind the glass and one in front of it.
    const [rx, ry, rw] = region;
    const behind = this._behind('dock', region);
    const front = this._add(new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'}));
    front.set_position(rx + rw - 140, ry + 50);
    front.set_size(30, 30);
    await sleep(500);
    await this._audit('d0a behind-colour', 'dock', 10, 120, i => behind.set_style(`background-color: ${COLORS[i % 2]};`));
    await this._audit('d0b behind-move', 'dock', 10, 120, i => { behind.translation_x = (i + 1) * 12; });
    await this._audit('d0c front-colour', 'dock', 10, 120, i => front.set_style(`background-color: ${COLORS[i % 2]};`), false);
    this._drop(behind);
    this._drop(front);
    await sleep(300);

    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no', '-T', 'lgdrv-a'], 'lgdrv-a');
    if (a) {
      a.win.move_resize_frame(true, rx + 80, ry - 300, 420, 380);
      await sleep(1200);
      await this._shots('d1 window', region, 'dock');
      await this._idle('d1', 'dock', 2000);
      await this._audit('d2 window-drag', 'dock', 20, 50, i => a.win.move_frame(true, rx + 80 + (i + 1) * 15, ry - 300));
      await sleep(300);
      await this._shots('d2 moved', region, 'dock');
    }

    const g = await this._spawnGears();
    if (g) {
      g.win.move_frame(true, rx + rw - 350, ry - 150);
      await sleep(800);
      await this._audit('d3 gears', 'dock', 30, 40, () => {});
      g.proc.force_exit();
      await sleep(800);
      await this._shots('d3b gears-gone', region, 'dock');
    }

    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#2050c0');
    await sleep(1500);
    await this._shots('d5 background', region, 'dock');

    if (a) {
      a.win.move_frame(true, rx + 200, ry - 200);
      await sleep(800);
    }
    await this._shots('d6 backdrop', region, 'dock');
    await this._rebuild('enable-dock-glass');
    await this._shots('d7 rebuilt', region, 'dock');
  }

  // Opens, checks and closes one menu-like surface.
  async _surface(tag, owner, open, close, keepOpen = () => {}) {
    const dockBefore = this._stats('dock');
    const full = await this._countFullStage(async () => {
      open();
      await sleep(1200);
    });
    const opening = `${full}, dock ${delta(dockBefore, this._stats('dock'))}`;
    const region = this._region(owner) ?? this._menuRegion();
    if (!region) {
      log(`${tag} no ${owner} glass`);
      close();
      await sleep(800);
      return;
    }
    log(`${tag} region=${JSON.stringify(region)} opening: ${opening}`);
    await this._shots(`${tag} open`, region, owner);
    await this._idle(tag, owner, 1500);
    keepOpen();
    await sleep(200);
    const behind = this._behind(owner, region);
    await sleep(300);
    await this._audit(`${tag} behind-colour`, owner, 10, 120, i => behind.set_style(`background-color: ${COLORS[i % 2]};`));
    keepOpen();
    await sleep(200);
    await this._audit(`${tag} behind-move`, owner, 10, 120, i => { behind.translation_x = (i + 1) * 8; });
    keepOpen();
    await sleep(200);
    await this._shots(`${tag} behind`, region, owner);
    this._drop(behind);
    const dockBeforeClose = this._stats('dock');
    close();
    await sleep(1200);
    log(`${tag} closing: dock ${delta(dockBeforeClose, this._stats('dock'))}`);
  }

  // Quick Settings' menu on screen, for toggle mode, whose glass has regions
  // rather than one rect.
  _menuRegion() {
    const actor = Main.panel.statusArea.quickSettings.menu.actor;
    const ext = actor.get_transformed_extents();
    if (!(ext.size.width > 0))
      return null;
    return [Math.floor(ext.origin.x), Math.floor(ext.origin.y), Math.ceil(ext.size.width), Math.ceil(ext.size.height)];
  }

  async _uiScenario() {
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    await this._surface('m1 calendar', 'menu', () => dateMenu.open(true), () => dateMenu.close(true));
    const qs = Main.panel.statusArea.quickSettings.menu;
    await this._surface('q1 quick-settings', 'quick-settings', () => qs.open(true), () => qs.close(true));
    await this._surface('n1 notification', 'notification',
      () => Main.notify('Liquid Glass driver', 'A banner over the desktop'),
      () => {
        for (const source of Main.messageTray.getSources())
          source.destroy();
      });
    const icon = Gio.ThemedIcon.new('audio-volume-high-symbolic');
    // showAll() is GNOME 49's; before, show() with no monitor index.
    const showOsd = () => SHELL_MAJOR >= 49
      ? Main.osdWindowManager.showAll(icon, 'Volume', 0.6, 1)
      : Main.osdWindowManager.show(-1, icon, 'Volume', 0.6, 1);
    await this._surface('o1 osd', 'osd', showOsd, () => Main.osdWindowManager.hideAll(), showOsd);

    await this._menuShot('m2 calendar-again', dateMenu, 'menu');
  }

  async _togglesScenario() {
    const settings = this._lgSettings();
    settings.set_int('quick-settings-apply-to', 1);
    await sleep(1500);
    const qs = Main.panel.statusArea.quickSettings.menu;
    qs.open(true);
    await sleep(1200);
    const ext = qs.actor.get_transformed_extents();
    log(`t0 menu extents=${ext.origin.x},${ext.origin.y},${ext.size.width}x${ext.size.height} ` +
      `mapped=${qs.actor.mapped} glass=${JSON.stringify(this._glass('quick-settings-toggles')?.describe() ?? null)}`);
    qs.close(true);
    await sleep(1000);
    await this._surface('t1 toggles', 'quick-settings-toggles', () => qs.open(true), () => qs.close(true));
    await this._menuShot('t2 toggles-again', qs, 'quick-settings-toggles');
  }

  async _menuShot(tag, menu, owner) {
    menu.open(false);
    await sleep(1200);
    const region = this._region(owner) ?? this._menuRegion();
    if (region)
      await this._shots(tag, region, owner);
    else
      log(`${tag}: no region`);
    menu.close(false);
    await sleep(600);
  }

  async _fullStageScenario() {
    const settings = this._lgSettings();
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    const open = async () => {
      dateMenu.open(true);
      await sleep(1200);
    };
    log(`calendar first open: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
    log(`calendar second open: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
    settings.set_boolean('enable-menu-glass', false);
    await sleep(500);
    log(`calendar without glass: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
  }

  async _arcMenuButton() {
    for (let i = 0; i < 40; i++) {
      const button = Main.panel.statusArea.ArcMenu;
      if (button?.arcMenu && button._menuLayout)
        return button;
      await sleep(250);
    }
    return null;
  }

  _arcMenuGlasses() {
    return lg().glassObjects().filter(g => g._owner.startsWith('menu:ArcMenu')).map(g => g._owner);
  }

  async _arcMenuScenario() {
    this._cameraAway = true;
    let button = await this._arcMenuButton();
    if (!button) {
      log('a0 no ArcMenu button');
      return;
    }
    const detected = this._lgSettings().get_strv('detected-extra-menus');
    log(`a0 detected=${JSON.stringify(detected)} glasses=${JSON.stringify(this._arcMenuGlasses())}`);
    const arcSettings = Extension.lookupByUUID(ARCMENU_UUID).getSettings();
    const toggle = () => button.toggleMenu();

    await this._surface('a1 arcmenu', 'menu:ArcMenu', toggle, toggle);
    for (const layout of ['11', 'raven', 'runner', 'plasma']) {
      arcSettings.set_string('menu-layout', layout);
      await sleep(2000);
      await this._menuShotWith(`a2 layout-${layout}`, toggle, toggle, 'menu:ArcMenu');
    }
    arcSettings.set_string('menu-layout', 'arcmenu');
    await sleep(2000);

    arcSettings.set_string('force-menu-location', 'BottomCentered');
    await sleep(1000);
    await this._menuShotWith('a3 bottom-centered', toggle, toggle, 'menu:ArcMenu');
    arcSettings.reset('force-menu-location');
    await sleep(1000);

    const context = button.arcMenuContextMenu;
    await this._surface('a4 context', 'menu:ArcMenuContextMenu', () => context.open(true), () => context.close(true));

    // Moving the button recreates it, and with it both menus.
    arcSettings.set_string('position-in-panel', 'Right');
    await sleep(2500);
    button = await this._arcMenuButton();
    log(`a5 moved glasses=${JSON.stringify(this._arcMenuGlasses())} leftovers=${this._leftovers().length}`);
    if (button)
      await this._menuShotWith('a5 moved', () => button.toggleMenu(), () => button.toggleMenu(), 'menu:ArcMenu');
    arcSettings.reset('position-in-panel');
    await sleep(2500);

    Main.extensionManager.disableExtension(ARCMENU_UUID);
    await sleep(1500);
    log(`a6 arcmenu disabled glasses=${JSON.stringify(this._arcMenuGlasses())} ` +
      `detected=${JSON.stringify(this._lgSettings().get_strv('detected-extra-menus'))}`);
    Main.extensionManager.enableExtension(ARCMENU_UUID);
    button = await this._arcMenuButton();
    await sleep(1500);
    log(`a7 arcmenu enabled glasses=${JSON.stringify(this._arcMenuGlasses())}`);
    if (button)
      await this._surface('a7 arcmenu-again', 'menu:ArcMenu', () => button.toggleMenu(), () => button.toggleMenu());

    this._lgSettings().set_strv('disabled-extra-menus', ['ArcMenu']);
    await sleep(1000);
    log(`a8 switched off glasses=${JSON.stringify(this._arcMenuGlasses())}`);
    this._lgSettings().reset('disabled-extra-menus');
    await sleep(1000);
    log(`a9 switched on glasses=${JSON.stringify(this._arcMenuGlasses())}`);
  }

  async _menuShotWith(tag, open, close, owner) {
    open();
    await sleep(1200);
    const region = this._region(owner);
    if (region)
      await this._shots(tag, region, owner);
    else
      log(`${tag}: no region`);
    close();
    await sleep(800);
  }

  async _setBackground(color) {
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', color);
    await sleep(1500);
  }

  // Counts the sampler's measurements by path: the glass's backdrop, the
  // screen before the glass is drawn (with the glass tone), or the screen.
  _countPaths(sampler) {
    const counts = {backdrop: 0, bare: 0, screen: 0};
    const screen = sampler.sampleLuminance.bind(sampler);
    const backdrop = sampler.sampleBackdropLuminance.bind(sampler);
    sampler.sampleLuminance = (rect, tone) => {
      counts[tone ? 'bare' : 'screen']++;
      return screen(rect, tone);
    };
    sampler.sampleBackdropLuminance = (...args) => {
      counts.backdrop++;
      return backdrop(...args);
    };
    return counts;
  }

  _fg(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    return `#${[c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }

  _stageRect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h)};
  }

  async _adaptiveScenario() {
    const ext = Extension.lookupByUUID(LG_UUID);
    const mod = await import(`file://${ext.path}/dist/contrastSampler.js`);
    const ui = ext.stateObj?._uiManager ?? ext._uiManager;
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    const fresh = () => new mod.StageContrastSampler();
    const f3 = v => v === null ? 'null' : v.toFixed(3);

    // e1: the backdrop read through the glass's copy against a screenshot of
    // the same rect with the menu closed, for plain colours and for a
    // backdrop that is bright only in its top half.
    for (const color of ['#f0f0f0', '#202020', '#7a7a7a', '#3060c0']) {
      await this._setBackground(color);
      dateMenu.open(true);
      await sleep(1800);
      const rect = this._stageRect(ui.menu.actor);
      const copy = ui.glass.backdropCopy();
      const tone = mod.glassToneOf(ui.glass.uniformValues);
      const read = copy ? await fresh().sampleBackdropLuminance(copy, rect, tone) : null;
      const onScreen = await fresh().sampleLuminance(rect);
      dateMenu.close(true);
      await sleep(1500);
      const bare = await fresh().sampleLuminance(rect, tone);
      const ok = read !== null && bare !== null && Math.abs(read - bare) < 0.02;
      log(`e1 ${color} rect=${JSON.stringify(rect)} copy=${copy ? JSON.stringify(copy.rect.map(Math.round)) : null} ` +
        `backdrop=${f3(read)} bare=${f3(bare)} screen-with-glass=${f3(onScreen)} ${ok ? 'OK' : 'NG'}`);
    }
    await this._setBackground('#202020');
    dateMenu.open(true);
    await sleep(1800);
    const rect = this._stageRect(ui.menu.actor);
    dateMenu.close(true);
    await sleep(1200);
    const top = {...rect, height: Math.round(rect.height / 2)};
    const bottom = {...rect, y: rect.y + top.height, height: rect.height - top.height};
    const bright = this._behind('menu', [rect.x - 60, rect.y - 60, 0, 0], rect.width, top.height);
    bright.set_style('background-color: rgb(240,240,240);');
    await sleep(500);
    dateMenu.open(true);
    await sleep(1800);
    const tone = mod.glassToneOf(ui.glass.uniformValues);
    const copy = ui.glass.backdropCopy();
    const readTop = await fresh().sampleBackdropLuminance(copy, top, tone);
    const readBottom = await fresh().sampleBackdropLuminance(copy, bottom, tone);
    dateMenu.close(true);
    await sleep(1500);
    const bareTop = await fresh().sampleLuminance(top, tone);
    const bareBottom = await fresh().sampleLuminance(bottom, tone);
    const halvesOk = Math.abs(readTop - bareTop) < 0.03 && Math.abs(readBottom - bareBottom) < 0.03 && readTop > readBottom;
    log(`e1 halves top backdrop=${f3(readTop)} bare=${f3(bareTop)} bottom backdrop=${f3(readBottom)} bare=${f3(bareBottom)} ` +
      `${halvesOk ? 'OK' : 'NG'}`);
    this._drop(bright);

    // e2: the text colour from the moment a menu opens, after it last opened
    // over the other background.
    const timeline = async (tag, manager, open, close) => {
      const counts = this._countPaths(manager._contrastSampler);
      for (const color of ['#101010', '#f0f0f0', '#101010']) {
        await this._setBackground(color);
        for (const k of Object.keys(counts))
          counts[k] = 0;
        const t0 = GLib.get_monotonic_time();
        const applied = [];
        const apply = manager._applyAdaptiveColorMap;
        manager._applyAdaptiveColorMap = function (map, skip) {
          applied.push(`${Math.round((GLib.get_monotonic_time() - t0) / 1000)}ms:${map.size}${skip ? 's' : ''}` +
            `${label && map.has(label) ? `:${map.get(label)}` : ''}`);
          return apply.call(this, map, skip);
        };
        // A label on the glass itself, not on a card of its own. Picked again
        // at every mark: some menus (Kiwi Menu) rebuild their items on open.
        const pick = () => {
          const onGlass = manager._collectAdaptiveTextTargets()
            .filter(a => a instanceof St.Label && a.text && mod.backdropLuminance(a, manager.menu.actor) === null);
          return onGlass.find(a => a.mapped) ?? onGlass[0];
        };
        let label = pick();
        // Frames drawn with the label in another colour than the one it ends up with.
        const painted = [];
        const paintId = global.stage.connect('after-paint', () => {
          const l = pick();
          if (l?.mapped && GLib.get_monotonic_time() - t0 < 1500e3)
            painted.push(this._fg(l));
        });
        open();
        const marks = [];
        for (const at of [0, 30, 60, 100, 200, 400, 700, 1000, 1400, 2000]) {
          const wait = at - (GLib.get_monotonic_time() - t0) / 1000;
          if (wait > 0)
            await sleep(wait);
          label = pick() ?? label;
          marks.push(`${at}:${label ? this._fg(label) : '-'}`);
        }
        global.stage.disconnect(paintId);
        const final = label ? this._fg(label) : null;
        const wrongFrames = painted.filter(c => c !== final).length;
        const settledAt = marks.findIndex(m => m.endsWith(final));
        const steady = marks.slice(settledAt).every(m => m.endsWith(final));
        const want = color === '#f0f0f0' ? '#1a1a1a' : '#f2f2f2';
        // The first colours applied are the final ones, without a tween.
        const first = applied.find(a => !/:0s?(:#[0-9a-f]+)?$/.test(a)) ?? '';
        manager._applyAdaptiveColorMap = apply;
        // From the 30 ms mark on, the label shows the final colour.
        log(`e2 ${tag} ${color} ${marks.join(' ')} paths=${JSON.stringify(counts)} applied=${applied.join(',')} ` +
          `first=${first.split(':')[0]} frames=${painted.length} wrong-frames=${wrongFrames} ` +
          `${final === want && steady && settledAt <= 3 ? 'OK' : 'NG'}`);
        close();
        await sleep(1500);
      }
    };
    await timeline('calendar', ui, () => dateMenu.open(true), () => dateMenu.close(true));

    const button = new PanelMenu.Button(0.0, 'lgdrv-menu', false);
    button.add_child(new St.Label({text: 'Drv', y_align: Clutter.ActorAlign.CENTER}));
    const items = [];
    for (let i = 0; i < 6; i++) {
      const item = new PopupMenu.PopupMenuItem(`Row ${i}`);
      button.menu.addMenuItem(item);
      items.push(item);
    }
    Main.panel.addToStatusArea('lgdrvMenu', button);
    let panelManager = null;
    for (let i = 0; i < 20 && !panelManager; i++) {
      await sleep(250);
      const pmm = ext.stateObj?._panelMenuManager ?? ext._panelMenuManager;
      panelManager = [...(pmm?._menus?.values() ?? [])].find(e => e.name === 'lgdrvMenu')?.manager ?? null;
    }
    if (!panelManager) {
      log('e2 no glass for the driver menu');
      button.destroy();
      return;
    }
    await timeline('panel-menu', panelManager, () => button.menu.open(true), () => button.menu.close(true));

    // e3: hovered rows take the highlight's colour, and the others keep theirs.
    // A row can stay highlighted after it is left, through its key focus
    // (GNOME 46).
    const hoverCheck = async (tag, rows) => {
      const labelsOf = row => {
        const found = [];
        const walk = a => {
          if (a instanceof St.Label && a.mapped && a.text)
            found.push(a);
          a.get_children().forEach(walk);
        };
        walk(row);
        return found;
      };
      const lit = row => row.get_theme_node().get_background_color().alpha >= 190;
      const shared = this._fg(labelsOf(rows[rows.length - 1])[0]);
      const check = () => {
        const plain = [...new Set(rows.filter(r => !lit(r)).flatMap(r => labelsOf(r).map(l => this._fg(l))))];
        const highlighted = rows.filter(lit).flatMap(r => labelsOf(r).map(l => this._fg(l)));
        return {plain, highlighted, ok: plain.length === 1 && plain[0] === shared && highlighted.every(c => c !== shared)};
      };
      rows[0].active = true;
      await sleep(60);
      const hovered = check();
      rows[0].active = false;
      await sleep(60);
      const left = check();
      log(`e3 ${tag} hover shared=${shared} hovered=${JSON.stringify(hovered)} left=${JSON.stringify(left)} ` +
        `${hovered.ok && left.ok ? 'OK' : 'NG'}`);
      for (let round = 0; round < 3; round++) {
        for (const row of rows) {
          row.active = true;
          await sleep(25);
          row.active = false;
        }
      }
      await sleep(60);
      const swept = check();
      log(`e3 ${tag} sweep ${JSON.stringify(swept)} ${swept.ok ? 'OK' : 'NG'}`);
      await sleep(1000);
      const later = check();
      log(`e3 ${tag} sweep+1s ${JSON.stringify(later)} ${later.ok ? 'OK' : 'NG'}`);
    };
    await this._setBackground('#f0f0f0');
    button.menu.open(true);
    await sleep(1800);
    await hoverCheck('panel-menu', items);
    button.menu.close(true);
    await sleep(1200);
    button.destroy();
    await sleep(500);

    // ArcMenu, when the run enables it (LG_EXTRA_EXTENSIONS=arcmenu@arcmenu.com).
    const arcButton = Main.panel.statusArea.ArcMenu;
    const pmm = ext.stateObj?._panelMenuManager ?? ext._panelMenuManager;
    const arcManager = [...(pmm?._menus?.values() ?? [])].find(e => e.name === 'ArcMenu')?.manager ?? null;
    if (arcButton && arcManager) {
      this._cameraAway = true;
      await timeline('arcmenu', arcManager, () => arcButton.toggleMenu(), () => arcButton.toggleMenu());
      await this._setBackground('#f0f0f0');
      arcButton.toggleMenu();
      await sleep(1800);
      const rows = [];
      const walk = a => {
        if (typeof a._setSelectedStyle === 'function' && a.mapped && a.reactive)
          rows.push(a);
        a.get_children().forEach(walk);
      };
      walk(arcButton.arcMenu.box);
      log(`e3 arcmenu rows=${rows.length}`);
      if (rows.length > 1)
        await hoverCheck('arcmenu', rows.slice(0, 8));
      arcButton.toggleMenu();
      await sleep(1500);
    }

    // Kiwi Menu, when the run enables it (LG_EXTRA_EXTENSIONS=kiwimenu@kemma). It
    // rebuilds its items every time it opens.
    const kiwiButton = Main.panel.statusArea.KiwiMenuButton;
    const kiwiManager = [...(pmm?._menus?.values() ?? [])].find(e => e.name === 'KiwiMenuButton')?.manager ?? null;
    if (kiwiButton && kiwiManager) {
      this._cameraAway = true;
      await timeline('kiwimenu', kiwiManager, () => kiwiButton.menu.open(true), () => kiwiButton.menu.close(true));
    } else if (kiwiButton) {
      log('e2 kiwimenu has no glass');
    }

    const qs = ext.stateObj?._quickSettingsManager ?? ext._quickSettingsManager;
    if (qs) {
      this._lgSettings().set_boolean('quick-settings-enable-adaptive-text-color', true);
      await sleep(500);
      const qsMenu = Main.panel.statusArea.quickSettings.menu;
      await timeline('quick-settings', qs, () => qsMenu.open(true), () => qsMenu.close(true));
    }

    // e4: the OSD's text while its level bar moves.
    const osd = ext.stateObj?._osdManager ?? ext._osdManager;
    const icon = Gio.ThemedIcon.new('audio-volume-high-symbolic');
    const showOsd = level => SHELL_MAJOR >= 49
      ? Main.osdWindowManager.showAll(icon, 'Volume', level, 1)
      : Main.osdWindowManager.show(-1, icon, 'Volume', level, 1);
    for (const color of ['#f0f0f0', '#101010', '#8a8a8a']) {
      await this._setBackground(color);
      const counts = this._countPaths(osd._contrastSampler);
      const seen = [];
      for (let i = 0; i < 14; i++) {
        showOsd(i % 2 ? 1.0 : 0.0);
        await sleep(250);
        const label = osd._collectAdaptiveTextTargets().find(a => a instanceof St.Label);
        if (label && i > 1)
          seen.push(this._fg(label));
      }
      const distinct = [...new Set(seen)];
      log(`e4 osd ${color} colours=${JSON.stringify(distinct)} paths=${JSON.stringify(counts)} ` +
        `${distinct.length === 1 && counts.screen === 0 ? 'OK' : 'NG'}`);
      Main.osdWindowManager.hideAll();
      await sleep(1500);
    }
  }

  async _monitorScenario() {
    lg().monitor(0);
    await sleep(2200);
    const region = this._region('dock');
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-T', 'lgdrv-a'], 'lgdrv-a');
    const g = await this._spawnGears();
    if (a && region) {
      a.win.move_frame(true, region[0] + 80, region[1] - 300);
      g?.win.move_frame(true, region[0] + region[2] - 350, region[1] - 150);
      for (let i = 0; i < 30; i++) {
        a.win.move_frame(true, region[0] + 80 + i * 10, region[1] - 300);
        await sleep(50);
      }
    }
    await sleep(1500);
    g?.proc.force_exit();
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    dateMenu.open(true);
    await sleep(2000);
    dateMenu.close(true);
    await sleep(2000);
    lg().monitorStop();
  }

  async _benchScenario() {
    const which = GLib.getenv('LG_DRV_BENCH') ?? 'all';
    const seconds = Number(GLib.getenv('LG_DRV_BENCH_SECONDS') ?? 3);
    log(global._lgBench.run(which === 'all' ? 'all' : which.split(','),
      {seconds, settle: 2, ab: GLib.getenv('LG_DRV_BENCH_AB') === '1'}));
    await sleep(1000);
    while (global._lgBench.running)
      await sleep(500);
    log(`after bench: leftovers=${JSON.stringify(this._leftovers())} windows=${global.get_window_actors().length}`);
  }

  // Our own actors left anywhere on the stage.
  _leftovers() {
    const names = [];
    const walk = a => {
      const name = a.get_name() ?? '';
      if (/^liquid-(glass|box)|^clone-container|^optimization-breaker/.test(name))
        names.push(name);
      for (const c of a.get_children())
        walk(c);
    };
    walk(global.stage);
    return names;
  }

  // The glass inside a window actor.
  _windowGlass(actor) {
    return lg()?.glassObjects().find(g => g.get_parent() === actor) ?? null;
  }

  _windowRegion(win, margin = 90) {
    const r = win.get_frame_rect();
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, r.x - margin), y = Math.max(0, r.y - margin);
    return [x, y, Math.min(m.width - x, r.width + margin * 2), Math.min(m.height - y, r.height + margin * 2)];
  }

  async _windowScenario() {
    // A white desktop, where a drop shadow's banding shows most.
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#ffffff');
    const settings = this._lgSettings();
    settings.set_strv('application-window-whitelist', ['foot']);
    settings.set_boolean('enable-application-glass', true);
    await sleep(500);
    const b = await this._spawn(['foot', '-o', 'colors.background=20a040', '-o', 'cursor.blink=no', '-T', 'lgdrv-b'], 'lgdrv-b');
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no', '-T', 'lgdrv-a'], 'lgdrv-a');
    if (!a || !b) {
      log('window: no windows');
      return;
    }
    b.win.move_resize_frame(true, 300, 200, 500, 400);
    a.win.move_resize_frame(true, 600, 300, 500, 400);
    a.win.activate(global.get_current_time());
    await sleep(1500);
    const glass = this._windowGlass(a.actor);
    log(`w0 glass=${glass ? JSON.stringify(glass.describe()) : 'none'} wmclass=${a.win.get_wm_class()}`);
    if (!glass)
      return;
    await this._shots('w0 window', this._windowRegion(a.win), 'application');
    await this._idle('w0', 'application', 2000);

    // The window behind moves under the glass.
    await this._audit('w1 behind-move', glass, 15, 80, i => b.win.move_frame(true, 300 + (i + 1) * 10, 200));
    // The glass's own window is dragged.
    await this._audit('w2 window-drag', glass, 20, 50, i => a.win.move_frame(true, 600 + (i + 1) * 12, 300));
    await sleep(300);
    await this._shots('w2 moved', this._windowRegion(a.win), 'application');

    // A window behind that redraws every frame.
    const g = await this._spawnGears();
    if (g) {
      const r = a.win.get_frame_rect();
      g.win.move_frame(true, r.x - 150, r.y + 100);
      a.win.activate(global.get_current_time());
      await sleep(1000);
      await this._audit('w3 gears-behind', glass, 30, 40, () => {});
      await this._shots('w3 gears', this._windowRegion(a.win), 'application');
      g.proc.force_exit();
      await sleep(800);
    }

    // A change in front of the window is not behind its glass.
    const r = a.win.get_frame_rect();
    const front = this._add(new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'}));
    front.set_position(r.x + 100, r.y + 100);
    front.set_size(60, 60);
    await sleep(500);
    await this._audit('w4 front-colour', glass, 10, 120, i => front.set_style(`background-color: ${COLORS[i % 2]};`), false);
    this._drop(front);

    // Resize, then minimise and restore.
    a.win.move_resize_frame(true, r.x, r.y, 640, 460);
    await sleep(1200);
    log(`w5 resized glass=${JSON.stringify({size: glass.get_size(), pos: [glass.x, glass.y]})}`);
    await this._shots('w5 resized', this._windowRegion(a.win), 'application');
    a.win.minimize();
    await sleep(1200);
    a.win.unminimize();
    a.win.activate(global.get_current_time());
    await sleep(1500);
    log(`w6 restored mapped=${glass.mapped} alloc=${glass.has_allocation()} stats=${JSON.stringify(glass.stats)}`);
    await this._shots('w6 restored', this._windowRegion(a.win), 'application');

    // Closing the window takes its glass along.
    a.proc.force_exit();
    await sleep(1500);
    log(`w7 closed glasses=${lg().glassObjects().filter(x => x._owner === 'application').length}`);
    settings.set_boolean('enable-application-glass', false);
    await sleep(800);
    log(`w8 disabled glasses=${lg().glassObjects().filter(x => x._owner === 'application').length} ` +
      `windowActorChildren=${b.actor.get_n_children()}`);
  }

  async _lifecycleScenario() {
    const settings = this._lgSettings();
    settings.set_int('quick-settings-apply-to', 1);
    await sleep(1500);
    const qs = Main.panel.statusArea.quickSettings.menu;
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    for (const menu of [qs, dateMenu]) {
      menu.open(true);
      await sleep(800);
      menu.close(true);
      await sleep(600);
    }
    Main.notify('Liquid Glass driver', 'lifecycle');
    await sleep(800);
    // Disabling has to stop a running monitor and take its probes along.
    lg().monitor(0);
    await sleep(1200);
    log(`before disable: glasses=${lg().glassObjects().length} actors=${this._leftovers().length}`);
    Main.extensionManager.disableExtension(LG_UUID);
    await sleep(1000);
    log(`after disable: _lgGlass=${global._lgGlass === undefined ? 'gone' : 'present'} leftovers=${JSON.stringify(this._leftovers())}`);
    Main.extensionManager.enableExtension(LG_UUID);
    await sleep(4000);
    const dock = this._glass('dock');
    log(`after enable: glasses=${lg()?.glassObjects().length} dock=${dock ? JSON.stringify(dock.stats) : 'none'}`);
    qs.open(true);
    await sleep(800);
    log(`toggles after enable: ${JSON.stringify(this._glass('quick-settings-toggles')?.stats ?? null)}`);
    qs.close(true);
    await sleep(600);
  }

  async _lgModule(path) {
    return import(`file://${Extension.lookupByUUID(LG_UUID).path}/dist/${path}`);
  }

  // Runs the menus' morphs `factor` times slower, so shots catch them midway.
  async _slowMorph(factor) {
    const {MenuMorphMotion} = await this._lgModule('animation/menuMorph.js');
    const step = MenuMorphMotion.prototype._drvStep ?? MenuMorphMotion.prototype.step;
    MenuMorphMotion.prototype._drvStep = step;
    MenuMorphMotion.prototype.step = function (elapsed) {
      return step.call(this, elapsed / factor);
    };
  }

  async _timedShots(tag, rect, times) {
    const start = GLib.get_monotonic_time();
    for (const t of times) {
      const wait = t - (GLib.get_monotonic_time() - start) / 1000;
      if (wait > 0)
        await sleep(wait);
      await shot(`${tag}-${t}`, rect);
    }
  }

  // Moves the weather card through its menu until its centre is a few px
  // off the clock's, and reports the guides shown while it is held there.
  async _editGuides(settings, m) {
    settings.set_string('desktop-item-positions', '{}');
    settings.set_boolean('enable-glass-clock', true);
    settings.set_string('glass-clock-position', 'center');
    settings.set_strv('desktop-widgets', ['weather', 'events']);
    settings.set_boolean('enable-desktop-widgets', true);
    await sleep(4000);
    const clock = findActor(global.window_group, 'liquid-glass-desktop-clock');
    const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
    if (!clock || !weather?.mapped) {
      log(`guides: clock=${!!clock} weather=${weather?.mapped}`);
      return;
    }
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
    const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    await sleep(300);
    if (Main.overview.visible) {
      Main.overview.hide();
      await sleep(1500);
    }
    const t = () => GLib.get_monotonic_time();
    const move = async (x, y) => {
      pointer.notify_absolute_motion(t(), x, y);
      await sleep(60);
    };
    const button = async state => {
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, state);
      await sleep(60);
    };
    const rectOf = a => [...a.get_transformed_position(), ...a.get_transformed_size()].map(Math.round);
    const [wx, wy, ww, wh] = rectOf(weather);
    await move(wx + 40, wy + 40);
    pointer.notify_button(t(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
    await sleep(60);
    pointer.notify_button(t(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
    await sleep(500);
    const entry = Main.layoutManager.uiGroup.get_children()
      .flatMap(c => findActors(c, a => a instanceof PopupMenu.PopupMenuItem && a.mapped)).find(i => i.label.text === 'Move');
    if (!entry) return;
    const [ex, ey] = entry.get_transformed_position();
    await move(ex + 20, ey + 10);
    await button(Clutter.ButtonState.PRESSED);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(500);
    const layer = Main.layoutManager.uiGroup.get_children().find(c => c.get_name() === 'liquid-glass-edit');
    if (!layer) return;
    const [cx, cy, cw] = rectOf(clock);
    const guides = () => layer.get_children().filter(c => c.has_style_class_name('liquid-glass-edit-guide') && c.visible)
      .map(c => `[${rectOf(c)}]`).join(',');
    // The weather card's shown part is the card itself; its centre goes 4 px right of the clock's.
    const start = [wx + ww / 2, wy + wh / 2];
    const to = [cx + cw / 2 + 4, Math.max(m.y + 60 + wh / 2, cy - wh)];
    await move(...start);
    await button(Clutter.ButtonState.PRESSED);
    for (let i = 1; i <= 12; i++) await move(start[0] + (to[0] - start[0]) * i / 12, start[1] + (to[1] - start[1]) * i / 12);
    await sleep(300);
    const [nx, , nw] = rectOf(weather);
    log(`guides: clock centre=${cx + cw / 2} weather centre=${nx + nw / 2} (pointer +4) guides=${guides()}`);
    await shot('guides-centre', [m.x, m.y, m.width, m.height]);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(300);
    log(`guides: after release guides=${guides() || 'none'} positions=${settings.get_string('desktop-item-positions')}`);
    await move(m.x + 40, m.y + m.height - 60);
    await button(Clutter.ButtonState.PRESSED);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(300);
  }

  // Moves and resizes the clock through its menu and edit frame, with a
  // virtual pointer. With Desktop Icons (run-glass.sh with
  // LG_EXTRA_EXTENSIONS=ding@rastersoft.com) the clock has to be above its window.
  async _editClock(settings, m) {
    const clock = findActor(global.window_group, 'liquid-glass-desktop-clock');
    if (!clock) {
      log('edit: no clock');
      return;
    }
    // A new pointer starts in the hot corner and would open the overview.
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    await sleep(300);
    const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
    const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    await sleep(300);
    if (Main.overview.visible) {
      Main.overview.hide();
      await sleep(1500);
    }
    const t = () => GLib.get_monotonic_time();
    const move = async (x, y) => {
      pointer.notify_absolute_motion(t(), x, y);
      await sleep(60);
    };
    const click = async (x, y, button = Clutter.BUTTON_PRIMARY) => {
      await move(x, y);
      pointer.notify_button(t(), button, Clutter.ButtonState.PRESSED);
      await sleep(60);
      pointer.notify_button(t(), button, Clutter.ButtonState.RELEASED);
      await sleep(300);
    };
    const drag = async ([x, y], [dx, dy]) => {
      await move(x, y);
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
      for (let i = 1; i <= 10; i++)
        await move(x + dx * i / 10, y + dy * i / 10);
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
      await sleep(300);
    };
    const pickChain = (x, y) => {
      const chain = [];
      for (let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y); a; a = a.get_parent())
        chain.push(a.get_name() || a.constructor.name);
      return chain.slice(0, 4).join(' < ');
    };
    const container = clock.get_parent();
    const below = container.get_previous_sibling();
    log(`edit: container parent=${container.get_parent().constructor.name} ` +
      `below=${below?.get_meta_window?.()?.get_title() ?? below?.constructor.name}`);

    const [cx, cy] = clock.get_transformed_position();
    const [cw, ch] = clock.get_transformed_size();
    const centre = [cx + cw / 2, cy + ch * 0.7];
    log(`edit: pick on the clock: ${pickChain(...centre)}`);
    // A plain drag must not move it.
    await drag(centre, [-200, 0]);
    log(`edit: plain drag moved it by ${Math.round(clock.get_transformed_position()[0] - cx)}`);

    await click(...centre, Clutter.BUTTON_SECONDARY);
    await sleep(500);
    const menuItems = Main.layoutManager.uiGroup.get_children()
      .flatMap(c => findActors(c, a => a instanceof PopupMenu.PopupMenuItem && a.mapped));
    log(`edit: menu items=${menuItems.map(i => i.label.text).join(',')}`);
    await shot('clock-menu', [m.x, m.y, m.width, m.height]);
    const editItem = menuItems.find(i => i.label.text === 'Move and Resize');
    if (!editItem) return;
    const [ix, iy] = editItem.get_transformed_position();
    await click(ix + 20, iy + 10);
    await sleep(500);
    const layer = Main.layoutManager.uiGroup.get_children().find(c => c.get_name() === 'liquid-glass-edit');
    log(`edit: frame=${!!layer} modal=${Main.modalCount}`);
    await shot('clock-edit', [m.x, m.y, m.width, m.height]);
    if (!layer) return;

    // Down onto the dock: the Done button moves off it.
    const doneButton = layer.get_children().find(c => c.has_style_class_name('liquid-glass-edit-done'));
    const rectOf = a => [...a.get_transformed_position(), ...a.get_transformed_size()].map(Math.round);
    const frameActor = layer.get_children().find(c => c.has_style_class_name('liquid-glass-edit-frame'));
    const lower = m.y + m.height - 40 - (frameActor.get_transformed_position()[1] + frameActor.height);
    await drag(centre, [0, lower]);
    await sleep(800);
    const docks = Main.layoutManager.uiGroup.get_children().filter(c => c.get_name() === 'dashtodockContainer');
    log(`edit: low frame=${rectOf(frameActor)} done=${rectOf(doneButton)} docks=${docks.map(d => `[${rectOf(d)}]`).join(',')}`);
    await shot('clock-edit-low', [m.x, m.y, m.width, m.height]);
    const [lx, ly] = clock.get_transformed_position();
    await drag([centre[0] + lx - cx, centre[1] + ly - cy], [cx - lx, cy - ly]);
    await sleep(800);
    log(`edit: back frame=${rectOf(frameActor)} done=${rectOf(doneButton)}`);

    await drag(centre, [-300, -100]);
    await sleep(800);
    log(`edit: moved by ${Math.round(clock.get_transformed_position()[0] - cx)},` +
      `${Math.round(clock.get_transformed_position()[1] - cy)} positions=${settings.get_string('desktop-item-positions')}`);

    // The right edge's handle, then the bottom's.
    const handles = layer.get_children().filter(c => c.has_style_class_name('liquid-glass-edit-handle'));
    const handleCentre = h => {
      const [hx, hy] = h.get_transformed_position();
      return [hx + h.width / 2, hy + h.height / 2];
    };
    const sizeBefore = [settings.get_int('glass-clock-size'), settings.get_double('glass-clock-stretch')];
    await drag(handleCentre(handles[3]), [200, 0]);
    await sleep(2500);
    log(`edit: wider: size,stretch ${sizeBefore} -> ${settings.get_int('glass-clock-size')},` +
      `${settings.get_double('glass-clock-stretch')}`);
    await shot('clock-wider', [m.x, m.y, m.width, m.height]);
    await drag(handleCentre(handles[5]), [0, 120]);
    await sleep(2500);
    log(`edit: taller: size,stretch,height ${settings.get_int('glass-clock-size')},` +
      `${settings.get_double('glass-clock-stretch')},${settings.get_double('glass-clock-height')}`);
    await shot('clock-taller', [m.x, m.y, m.width, m.height]);

    // A click outside ends it.
    await click(m.x + 40, m.y + m.height - 60);
    await sleep(500);
    log(`edit: ended frame=${!!Main.layoutManager.uiGroup.get_children().find(c => c.get_name() === 'liquid-glass-edit')} ` +
      `modal=${Main.modalCount}`);
    await shot('clock-edited', [m.x, m.y, m.width, m.height]);

    // Position > Top Left puts it back at a corner.
    const [ex, ey] = clock.get_transformed_position();
    const [ew, eh] = clock.get_transformed_size();
    await click(ex + ew / 2, ey + eh * 0.7, Clutter.BUTTON_SECONDARY);
    await sleep(500);
    const items = () => Main.layoutManager.uiGroup.get_children()
      .flatMap(c => findActors(c, a => a instanceof PopupMenu.PopupBaseMenuItem && a.mapped));
    const label = i => i.label?.text ?? '';
    const sub = items().find(i => label(i) === 'Position');
    if (!sub) return;
    const [sx, sy] = sub.get_transformed_position();
    await click(sx + 20, sy + 10);
    await sleep(600);
    await shot('clock-position-menu', [m.x, m.y, m.width, m.height]);
    const topLeft = items().find(i => label(i) === 'Top Left');
    log(`edit: position items=${items().map(label).join(',')}`);
    if (!topLeft) return;
    const [tx, ty] = topLeft.get_transformed_position();
    await click(tx + 20, ty + 10);
    await sleep(1500);
    log(`edit: placed position=${settings.get_string('glass-clock-position')} ` +
      `moved=${settings.get_string('desktop-item-positions')} at=${clock.get_transformed_position().map(Math.round)}`);

    // A widget goes to a corner of its own the same way.
    const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
    if (!weather?.mapped) return;
    const [wx, wy] = weather.get_transformed_position();
    await click(wx + 40, wy + 40, Clutter.BUTTON_SECONDARY);
    await sleep(500);
    const wsub = items().find(i => label(i) === 'Position');
    if (!wsub) return;
    const [wsx, wsy] = wsub.get_transformed_position();
    await click(wsx + 20, wsy + 10);
    await sleep(600);
    const bottomLeft = items().find(i => label(i) === 'Bottom Left');
    if (!bottomLeft) return;
    const [bx, by] = bottomLeft.get_transformed_position();
    await click(bx + 20, by + 10);
    await sleep(1500);
    log(`edit: weather placed anchors=${settings.get_string('desktop-widget-anchors')} ` +
      `at=${weather.get_transformed_position().map(Math.round)}`);
    await shot('widget-position', [m.x, m.y, m.width, m.height]);
  }

  async _featuresScenario() {
    const parts = (GLib.getenv('LG_DRV_FEATURES') ?? 'morph,topbar,widgets,clock,launcher').split(',');
    const settings = this._lgSettings();
    const wallpaper = GLib.getenv('LG_DRV_WALLPAPER');
    if (wallpaper) {
      const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
      bg.set_string('picture-uri', `file://${wallpaper}`);
      bg.set_string('picture-uri-dark', `file://${wallpaper}`);
      bg.set_string('picture-options', 'zoom');
      await sleep(2000);
    }
    const m = Main.layoutManager.primaryMonitor;
    // Menus grow from their button only when asked to.
    if (parts.some(p => p.startsWith('morph'))) {
      for (const surface of ['menu', 'panel-menu']) settings.set_boolean(`${surface}-grow-from-button`, true);
      await sleep(500);
    }
    if (parts.includes('morph')) {
      await this._slowMorph(12);
      const dateMenu = Main.panel.statusArea.dateMenu.menu;
      dateMenu.open(true);
      await this._timedShots('morph-open', [m.x + m.width / 4, m.y, m.width / 2, 700],
        [150, 700, 1300, 1800, 2400, 3000, 4500, 7000, 9500]);
      await sleep(1000);
      dateMenu.close(true);
      await this._timedShots('morph-close', [m.x + m.width / 4, m.y, m.width / 2, 700],
        [150, 1600, 3000, 4500, 6000, 7000, 8000, 9000, 10000, 11500]);
      await sleep(2000);
      await this._slowMorph(1);
    }
    if (parts.includes('morphtrace')) {
      // Every frame of the calendar's glass at full speed.
      const {MenuMorphMotion} = await this._lgModule('animation/menuMorph.js');
      const step = MenuMorphMotion.prototype.step;
      const t0 = GLib.get_monotonic_time();
      MenuMorphMotion.prototype.step = function (elapsed) {
        const f = step.call(this, elapsed);
        const r = n => n.map(v => v.toFixed(1)).join(',');
        log(`trace t=${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} opening=${this.opening} ` +
          `body=${r(f.body)} radius=${f.bodyRadius.toFixed(1)} ` +
          `content=${f.contentScale.toFixed(2)}/${f.contentOpacity.toFixed(2)} lens=${f.lens.toFixed(2)} ` +
          `glass=${f.glassOpacity.toFixed(2)}`);
        return f;
      };
      const retarget = MenuMorphMotion.prototype.retarget;
      MenuMorphMotion.prototype.retarget = function (button, menu, radius) {
        const key = menu ? menu.map(v => v.toFixed(1)).join(',') : 'null';
        if (key !== this._drvMenuKey) {
          log(`trace t=${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} menu=${key}`);
          this._drvMenuKey = key;
        }
        return retarget.call(this, button, menu, radius);
      };
      // $LG_DRV_TRACE_NOTIFY: a few notifications in the calendar's list first.
      for (let i = 0; i < Number(GLib.getenv('LG_DRV_TRACE_NOTIFY') ?? 0); i++)
        Main.notify(`Driver ${i}`, 'A notification for the calendar menu');
      await sleep(1500);
      const dateMenu = Main.panel.statusArea.dateMenu.menu;
      const clock = Main.panel.statusArea.dateMenu._clockDisplay;
      log(`trace clock label at ${clock.get_transformed_position().map(Math.round)} size ${clock.get_transformed_size().map(Math.round)}`);
      dateMenu.open(true);
      await sleep(2500);
      dateMenu.close(true);
      await sleep(1500);
      MenuMorphMotion.prototype.step = step;
      MenuMorphMotion.prototype.retarget = retarget;
    }
    if (parts.includes('qssub')) {
      // A Quick Settings submenu stays centred under the panel when the shell
      // moves it after the last frame that would have noticed.
      const qs = Main.panel.statusArea.quickSettings.menu;
      qs.open(true);
      // The shell reads the submenus' offset with the panel's opening scale on it.
      await sleep(60);
      log(`qssub: panel scale while opening ${qs.box.scale_x.toFixed(2)}`);
      qs._grid.notify('x');
      await sleep(1500);
      const toggle = qs._grid.get_children().find(c => c.menu?.actor && c.visible && c.reactive);
      const centres = () => {
        const sub = toggle.menu.box;
        const [bx] = qs.box.get_transformed_position();
        const [sx] = sub.get_transformed_position();
        return `${Math.round(sx + sub.get_transformed_size()[0] / 2 - bx - qs.box.get_transformed_size()[0] / 2)}`;
      };
      if (toggle) {
        toggle.menu.open(true);
        await sleep(1500);
        const before = centres();
        const xConstraint = qs._overlay.get_constraints().find(c => c.coordinate === Clutter.BindCoordinate.X);
        xConstraint.offset += 30;
        await sleep(1000);
        log(`qssub: ${toggle.constructor.name} submenu off centre by ${before}, after the shell moved it by 30: ${centres()}`);
        await shot('qs-submenu', [m.x + m.width - 700, m.y, 700, 900]);
        xConstraint.offset -= 30;
        toggle.menu.close(false);
      } else {
        log('qssub: no toggle with a submenu');
      }
      qs.close(false);
      await sleep(1000);
    }
    if (parts.includes('media')) {
      // A player of our own on the session bus, and its card's buttons clicked
      // with a virtual pointer.
      const calls = [];
      const xml = `<node><interface name="org.mpris.MediaPlayer2.Player">
        <method name="Previous"/><method name="PlayPause"/><method name="Next"/>
        <property name="PlaybackStatus" type="s" access="read"/>
        <property name="Metadata" type="a{sv}" access="read"/></interface></node>`;
      const player = Gio.DBusExportedObject.wrapJSObject(xml, {
        Previous: () => calls.push('Previous'),
        PlayPause: () => calls.push('PlayPause'),
        Next: () => calls.push('Next'),
        get PlaybackStatus() { return 'Playing'; },
        get Metadata() {
          return {'xesam:title': new GLib.Variant('s', 'Driver Song'),
            'xesam:artist': new GLib.Variant('as', ['Driver']),
            'mpris:artUrl': new GLib.Variant('s', `file://${GLib.getenv('LG_DRV_WALLPAPER') ?? '/usr/share/pixmaps/debian-logo.png'}`)};
        },
      });
      player.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
      let owner = 0;
      await new Promise(resolve => {
        owner = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.mpris.MediaPlayer2.lgdrv',
          Gio.BusNameOwnerFlags.NONE, resolve, null);
      });
      settings.set_boolean('output-logs', true);
      settings.set_strv('desktop-widgets', GLib.getenv('LG_DRV_MEDIA_WITH')?.split(',') ?? ['media']);
      settings.set_boolean('media-visualizer', true);
      // Settings to measure under, as "key=gvariant;key=gvariant".
      for (const pair of (GLib.getenv('LG_DRV_MEDIA_SETTINGS') ?? '').split(';').filter(Boolean)) {
        const at = pair.indexOf('=');
        settings.set_value(pair.slice(0, at), GLib.Variant.parse(null, pair.slice(at + 1), null, null));
      }
      settings.set_boolean('enable-desktop-widgets', true);
      let card = null;
      for (let i = 0; i < 40 && !card?.mapped; i++) {
        await sleep(250);
        card = findActor(global.window_group, 'liquid-glass-desktop-media');
      }
      log(`media: card shown=${card?.visible} mapped=${card?.mapped}`);
      if (card?.mapped) {
        new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
        const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
        const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        await sleep(300);
        if (Main.overview.visible) {
          Main.overview.hide();
          await sleep(1500);
        }
        const t = () => GLib.get_monotonic_time();
        const buttons = findActors(card, a => a instanceof St.Button);
        for (const button of buttons) {
          const [bx, by] = button.get_transformed_position();
          const [bw, bh] = button.get_transformed_size();
          pointer.notify_absolute_motion(t(), bx + bw / 2, by + bh / 2);
          await sleep(100);
          pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
          await sleep(60);
          pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
          await sleep(500);
        }
        log(`media: ${buttons.length} buttons clicked, the player got: ${calls.join(',') || 'nothing'}`);
        const [cx, cy] = card.get_transformed_position();
        const [cw, ch] = card.get_transformed_size();
        if (GLib.getenv('LG_DRV_MEDIA_BARS')) {
          // Bars that jump between silent and loudest, without a sound server.
          const {MediaWidget} = await this._lgModule('desktop/media.js');
          const draw = MediaWidget.prototype._drawBars;
          let loud = false;
          MediaWidget.prototype._drawBars = function () {
            this._levels = this._levels.map(() => loud ? 1 : 0);
            draw.call(this);
          };
          const bars = findActors(card, a => a instanceof St.DrawingArea)[0];
          for (let i = 0; i < 40; i++) {
            loud = i % 8 < 4;
            for (let f = 0; f < 6; f++) {
              bars.queue_repaint();
              await sleep(16);
            }
            if (i % 4 === 0) log(`media: bars ${loud ? 'loud' : 'silent'} title colour=${findActors(card, a => a instanceof St.Label)[0].get_theme_node().get_foreground_color().to_string()}`);
          }
          MediaWidget.prototype._drawBars = draw;
        }
        // With PULSE_SERVER set to a running sound server, the bars follow what it plays.
        for (let i = 0; i < 4; i++) {
          await shot(`media-${i}`, [cx - 20, cy - 20, cw + 40, ch + 40]);
          await sleep(350);
        }
      }
      settings.set_boolean('enable-desktop-widgets', false);
      Gio.bus_unown_name(owner);
      player.unexport();
      await sleep(500);
    }
    if (parts.includes('clocktick')) {
      // How long the main loop stalls when the clock's minute changes, once
      // its digits are drawn ($LG_DRV_CLOCK_SIZE, $LG_DRV_CLOCK_HEIGHT, $LG_DRV_CLOCK_FONT).
      settings.set_boolean('output-logs', true);
      settings.set_int('glass-clock-size', Number(GLib.getenv('LG_DRV_CLOCK_SIZE') ?? 240));
      settings.set_double('glass-clock-height', Number(GLib.getenv('LG_DRV_CLOCK_HEIGHT') ?? 1));
      settings.set_double('glass-clock-stretch', Number(GLib.getenv('LG_DRV_CLOCK_STRETCH') ?? 1));
      settings.set_string('glass-clock-tall-style', GLib.getenv('LG_DRV_CLOCK_STYLE') ?? 'even');
      const font = GLib.getenv('LG_DRV_CLOCK_FONT');
      if (font !== null) settings.set_string('glass-clock-font', font);
      const {GlassClock} = await this._lgModule('desktop/clock.js');
      let text = '10:00';
      let clock = null;
      const timeText = GlassClock.prototype._timeText;
      const tick = GlassClock.prototype._tick;
      GlassClock.prototype._timeText = () => text;
      GlassClock.prototype._tick = function () {
        clock = this;
        return tick.call(this);
      };
      // The longest the main loop stops from now until `done` resolves.
      const stalls = async done => {
        let last = GLib.get_monotonic_time(), worst = 0;
        const probe = GLib.timeout_add(GLib.PRIORITY_HIGH, 2, () => {
          const now = GLib.get_monotonic_time();
          worst = Math.max(worst, now - last);
          last = now;
          return GLib.SOURCE_CONTINUE;
        });
        await done;
        GLib.Source.remove(probe);
        return (worst / 1000).toFixed(0);
      };
      // Every digit drawn once, as a clock that has run for a while has them.
      log(`clocktick: first digits, longest stall ${await stalls((async () => {
        settings.set_boolean('enable-glass-clock', true);
        for (const t of ['01:23', '45:67', '89:00']) {
          text = t;
          clock?._tick();
          await sleep(6000);
        }
      })())} ms`);
      log(`clocktick: resized, longest stall ${await stalls((async () => {
        settings.set_int('glass-clock-size', settings.get_int('glass-clock-size') - 20);
        await sleep(8000);
      })())} ms`);
      for (const t of ['10:01', '10:02', '17:38', '23:59']) {
        let last = GLib.get_monotonic_time(), worst = 0;
        const probe = GLib.timeout_add(GLib.PRIORITY_HIGH, 2, () => {
          const now = GLib.get_monotonic_time();
          worst = Math.max(worst, now - last);
          last = now;
          return GLib.SOURCE_CONTINUE;
        });
        text = t;
        const start = GLib.get_monotonic_time();
        clock?._tick();
        await sleep(3000);
        GLib.Source.remove(probe);
        log(`clocktick: ${t} longest stall ${(worst / 1000).toFixed(0)} ms (from ${((GLib.get_monotonic_time() - start) / 1000).toFixed(0)} ms)`);
      }
      GlassClock.prototype._timeText = timeText;
      GlassClock.prototype._tick = tick;
      settings.set_boolean('enable-glass-clock', false);
      await sleep(500);
    }
    if (parts.includes('clockshot')) {
      // The clock alone, large, for a close look at its glass ($LG_DRV_CLOCK_SIZE,
      // $LG_DRV_CLOCK_HEIGHT, $LG_DRV_CLOCK_FONT, $LG_DRV_CLOCK_TEXT).
      settings.set_boolean('output-logs', true);
      settings.set_string('glass-clock-position', 'center');
      settings.set_int('glass-clock-size', Number(GLib.getenv('LG_DRV_CLOCK_SIZE') ?? 240));
      settings.set_double('glass-clock-height', Number(GLib.getenv('LG_DRV_CLOCK_HEIGHT') ?? 1));
      const font = GLib.getenv('LG_DRV_CLOCK_FONT');
      if (font !== null) settings.set_string('glass-clock-font', font);
      settings.set_boolean('glass-clock-show-date', false);
      // $LG_DRV_CLOCK_TEXT shows that instead of the time.
      const text = GLib.getenv('LG_DRV_CLOCK_TEXT');
      if (text) (await this._lgModule('desktop/clock.js')).GlassClock.prototype._timeText = () => text;
      settings.set_boolean('enable-glass-clock', true);
      await sleep(Number(GLib.getenv('LG_DRV_CLOCK_WAIT') ?? 4000));
      const clock = findActor(global.window_group, 'liquid-glass-desktop-clock');
      log(`clockshot: font=${settings.get_string('glass-clock-font')} size=${clock.get_transformed_size()}`);
      const [x, y] = clock.get_transformed_position();
      const [w, h] = clock.get_transformed_size();
      await shot('clock-alone', [x, y, w, h]);
    }
    if (parts.includes('topbar')) {
      for (const style of ['pill', 'islands']) {
        settings.set_string('top-bar-style', style);
        await sleep(1500);
        await shot(`topbar-${style}`, [m.x, m.y, m.width, 80]);
        const dateMenu = Main.panel.statusArea.dateMenu.menu;
        dateMenu.open(true);
        await sleep(1500);
        await shot(`topbar-${style}-menu`, [m.x, m.y, m.width, 700]);
        dateMenu.close(true);
        await sleep(1000);
        const sides = ['top', 'bottom', 'left', 'right'];
        const before = Main.panel.height;
        sides.forEach((side, i) => {
          settings.set_int(`top-bar-margin-${side}`, [10, 6, 24, 24][i]);
          settings.set_int(`top-bar-padding-${side}`, [4, 4, 12, 12][i]);
        });
        await sleep(1500);
        const boxes = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
        log(`topbar ${style} spacing: panel ${before} -> ${Main.panel.height}, ` +
          `boxes ${boxes.map(b => `${b.get_allocation_box().x1},${b.get_allocation_box().x2}`).join(' ')}, ` +
          `first button ${boxes[0].get_first_child()?.get_allocation_box().y1}..${boxes[0].get_first_child()?.get_allocation_box().y2}, ` +
          `workarea y ${Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex).y}`);
        await shot(`topbar-${style}-spacing`, [m.x, m.y, m.width, 80]);
        for (const side of sides) {
          settings.reset(`top-bar-margin-${side}`);
          settings.reset(`top-bar-padding-${side}`);
        }
        await sleep(1000);
      }
      settings.set_string('top-bar-style', 'off');
      await sleep(1000);
      log(`topbar off: panel ${Main.panel.height}, styles ${[Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox].map(b => b.get_style()).join('|')}`);
    }
    if (parts.includes('widgets')) {
      // A town GNOME Weather has no location for.
      settings.set_value('weather-place', new GLib.Variant('(sdd)', ['喜多方市', 37.65, 139.86667]));
      settings.set_boolean('enable-desktop-widgets', true);
      await sleep(8000);
      const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
      const texts = weather ? findActors(weather, a => a instanceof St.Label).map(l => l.text).filter(Boolean) : [];
      log(`weather: ${texts.join(' | ').replace(/\n/g, ' / ')}`);
      await shot('widgets', [m.x, m.y, m.width, m.height]);
    }
    if (parts.includes('clock')) {
      settings.set_boolean('enable-glass-clock', true);
      await sleep(3000);
      await shot('clock', [m.x, m.y, m.width, m.height]);
      for (const position of ['top-left', 'bottom-right']) {
        settings.set_string('glass-clock-position', position);
        await sleep(1500);
        await shot(`clock-${position}`, [m.x, m.y, m.width, m.height]);
      }
      await this._editClock(settings, m);
    }
    if (parts.includes('guides'))
      await this._editGuides(settings, m);
    if (parts.includes('launcher')) {
      settings.set_boolean('enable-launcher', true);
      await sleep(1000);
      const {Launcher} = await this._lgModule('launcher/launcher.js');
      const launcher = Launcher.instance;
      launcher?.open();
      await sleep(1200);
      await shot('launcher-empty', [m.x, m.y, m.width, m.height]);
      launcher?.setText('set');
      await sleep(2500);
      await shot('launcher-results', [m.x, m.y, m.width, m.height]);
      launcher?.close();
      await sleep(1000);
    }
    // Everything switched on, the launcher open: disabling has to leave nothing.
    (await this._lgModule('launcher/launcher.js')).Launcher.instance?.open();
    await sleep(500);
    Main.extensionManager.disableExtension(LG_UUID);
    await sleep(1000);
    log(`features disabled: leftovers=${JSON.stringify(this._leftovers())} ` +
      `panel transparent=${Main.panel.has_style_class_name('liquid-glass-transparent')} modal=${Main.modalCount}`);
    Main.extensionManager.enableExtension(LG_UUID);
    await sleep(4000);
    log(`features enabled again: glasses=${lg()?.glassObjects().map(g => g._owner).join(',')}`);
  }

  _finish() {
    log('DONE');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      global.context.terminate();
      return GLib.SOURCE_REMOVE;
    });
  }
}
