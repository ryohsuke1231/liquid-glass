const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(overrides = {}) {
  let clock = 0;
  const laters = { added: 0, add() { this.added++; return this.added; }, remove() {} };
  const emitter = () => ({
    handlers: new Map(),
    next: 1,
    connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; },
    disconnect(id) { this.handlers.delete(id); },
    emit(name) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(); },
  });
  const stage = emitter();
  const display = emitter();
  const settings = {
    get_boolean: () => false, get_strv: () => [], get_double: () => 1.0,
    get_int: () => 0, get_string: () => '#ffffff', connect: () => 1, disconnect() {},
  };
  const code = fs.readFileSync(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/applicationManager.js'), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export class /g, 'class ');
  const bindings = {
    Meta: { WindowType: {}, LaterType: { BEFORE_REDRAW: 0 } },
    Main: { layoutManager: { primaryMonitor: { width: 1920, height: 1080 } } },
    GLib: { idle_add: () => 1, Source: { remove() {} }, SOURCE_REMOVE: false, PRIORITY_DEFAULT_IDLE: 0,
      get_monotonic_time: () => (clock += 20000) },
    SAME_FRAME_WINDOW_US: 4000,
    global: { stage, display, compositor: { get_laters: () => laters } },
    isFrameSyncFrozen: () => false,
    ensureWindowActorAllocated: () => null,
    ensureGlassAllocated: () => {},
    clearStranded: () => {},
    ...overrides,
  };
  const C = new Function(...Object.keys(bindings), `${code}\nreturn ApplicationManager;`)(...Object.values(bindings));
  const manager = new C('/ext', settings, { log() {}, error() {} });
  return { manager, stage, display, laters };
}

test('window glass follows compositor frames instead of requesting them', () => {
  const { manager, stage, laters } = fixture();
  let ticks = 0;
  manager._frameTick = () => { ticks++; };

  manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
  assert.equal(ticks, 1);
  assert.equal(laters.added, 0);

  for (let i = 0; i < 100; i++) stage.emit('before-update');
  assert.equal(ticks, 101);
  assert.equal(laters.added, 0);
});

test('repeated starts keep exactly one frame observer and stopping removes it', () => {
  const { manager, stage } = fixture();
  manager._frameTick = () => {};
  for (let i = 0; i < 5; i++) manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
  manager._stopFrameSync();
  assert.equal(stage.handlers.size, 0);
  manager._stopFrameSync();
  assert.equal(stage.handlers.size, 0);
  manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
});

test('cleanup disconnects the frame observer and every display handler', () => {
  const { manager, stage, display } = fixture();
  manager.setup();
  manager._startFrameSync();
  assert.equal(stage.handlers.size, 1);
  assert.ok(display.handlers.size > 0);
  manager.cleanup();
  assert.equal(stage.handlers.size, 0);
  assert.equal(display.handlers.size, 0);
});

function windowFixture() {
  const { loadModule } = require('./helpers/load-module.cjs');
  const handlers = () => ({
    handlers: new Map(), next: 1,
    connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; },
    disconnect(id) { this.handlers.delete(id); },
  });
  const glasses = [];
  class Glass {
    constructor(params) {
      Object.assign(this, { params, visible: true, calls: [], x: 0, y: 0, width: 0, height: 0 });
      glasses.push(this);
    }
    set_name(name) { this.name = name; }
    set_position(x, y) { this.x = x; this.y = y; this.calls.push(['position', x, y]); }
    set_size(w, h) { this.width = w; this.height = h; this.calls.push(['size', w, h]); }
    setResolution(w, h) { this.calls.push(['resolution', w, h]); }
    setGlassGeometry(...rect) { this.calls.push(['geometry', ...rect]); }
    syncSources(moved) { this.calls.push(['sources', moved]); }
    beginBatch() {} endBatch() {}
    cleanup() { this.cleaned = true; }
    destroy() { this.destroyed = true; }
  }
  for (const name of ['setPadding', 'setTintColor', 'setTintStrength', 'setCornerRadius', 'setBlurRadius',
    'setBrightness', 'setContrast', 'setSaturation', 'setIsDock', 'setSurfaceLightEnabled',
    'setCornerSmoothingEnabled', 'setShadowMaxRadius'])
    Glass.prototype[name] = function () {};
  const workspace = {};
  const frame = { x: 130, y: 90, width: 800, height: 600 };
  const buffer = { x: 100, y: 60, width: 860, height: 660 };
  const metaWindow = Object.assign(handlers(), {
    get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...buffer }),
    get_workspace: () => workspace, get_title: () => 'test', get_window_type: () => 0,
    is_override_redirect: () => false, get_transient_for: () => null, get_wm_class: () => 'test',
    minimized: false,
  });
  const surface = { opacity: 255 };
  const windowActor = Object.assign(handlers(), {
    x: 100, y: 60, translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1, mapped: true,
    get_stage: () => ({}), get_meta_window: () => metaWindow, get_first_child: () => surface,
    get_parent: () => ({}), get_pivot_point: () => [0, 0],
    get_allocation_box: () => ({ get_width: () => 860, get_height: () => 660 }),
    insert_child_below(child) { this.glass = child; },
  });
  const settings = {
    get_boolean: key => key === 'enable-application-glass' || key === 'application-glass-all-windows',
    get_strv: () => [], get_double: key => key === 'shadow-radius' ? 50 : key === 'shadow-intensity' ? 0.2 : 0.85,
    get_int: () => 10, get_string: () => '#ffffff', connect: () => 1, disconnect() {},
  };
  const writes = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/actors.js'), { utilsLog() {} });
  const { ApplicationManager } = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/applicationManager.js'), {
    Meta: { WindowType: { NORMAL: 0, DIALOG: 1, MODAL_DIALOG: 2, DESKTOP: 9, DROPDOWN_MENU: 5, POPUP_MENU: 6, MENU: 7 },
      LaterType: { BEFORE_REDRAW: 0 } },
    GLib: { get_monotonic_time: () => 0, SOURCE_REMOVE: false },
    global: { stage: handlers(), display: handlers(), workspace_manager: { get_active_workspace: () => workspace },
      compositor: { get_laters: () => ({ add: () => 1, remove() {} }) } },
    BackdropGlass: Glass, getWindowActors: () => [windowActor], isActorValid: a => !!a && !a.destroyed,
    getAllocatedSize: a => [a.get_allocation_box().get_width(), a.get_allocation_box().get_height()],
    setActorVisible(actor, visible) { actor.visible = visible; },
    ensureGlassAllocated() {}, ensureWindowActorAllocated: () => '',
    setPositionIfChanged: writes.setPositionIfChanged, setSizeIfChanged: writes.setSizeIfChanged,
    isFrameSyncFrozen: () => false, SAME_FRAME_WINDOW_US: 4000,
    hexToColorArray: () => [1, 1, 1], noteStrandEntry() {}, reportFrameLoopError(_, e) { throw e; },
  });
  const manager = new ApplicationManager('/ext', settings, { log() {}, error() {} });
  manager._glassMargin = manager._computeGlassMargin();
  return { manager, glasses, windowActor, metaWindow, frame, buffer, workspace, surface };
}

test('window glass sits on the frame rect inside the window actor and syncs its sources every frame', () => {
  const { manager, glasses, windowActor } = windowFixture();
  manager._setupWindow(windowActor);
  const glass = glasses[0];
  assert.equal(windowActor.glass, glass, 'inserted below the surface');
  const state = manager._states.get(windowActor);
  manager._syncState(state);
  // Margin = shadow radius 50 + 20 headroom; frame offset (30, 30) inside the buffer.
  assert.deepEqual(glass.calls.filter(c => c[0] !== 'sources'), [
    ['position', -40, -40], ['size', 940, 740], ['resolution', 940, 740], ['geometry', 0, 0, 940, 740]]);
  assert.deepEqual(glass.calls.at(-1), ['sources', true]);

  glass.calls.length = 0;
  manager._syncState(state);
  assert.deepEqual(glass.calls, [['sources', false]], 'an unchanged window only syncs its sources');
});

test('moving or scaling the window marks the glass as moved without resizing it', () => {
  const { manager, glasses, windowActor, buffer, frame } = windowFixture();
  manager._setupWindow(windowActor);
  const state = manager._states.get(windowActor);
  manager._syncState(state);
  const glass = glasses[0];

  glass.calls.length = 0;
  windowActor.x += 50; buffer.x += 50; frame.x += 50;
  manager._syncState(state);
  assert.deepEqual(glass.calls.filter(c => c[0] === 'position' || c[0] === 'size'), []);
  assert.deepEqual(glass.calls.at(-1), ['sources', true]);

  glass.calls.length = 0;
  windowActor.scale_x = windowActor.scale_y = 0.5;
  manager._syncState(state);
  assert.deepEqual(glass.calls.filter(c => c[0] === 'position' || c[0] === 'size'), []);
  assert.deepEqual(glass.calls.at(-1), ['sources', true]);
});

test('a window on another workspace hides its glass, and cleanup restores the surface', () => {
  const { manager, glasses, windowActor, metaWindow, surface } = windowFixture();
  manager._setupWindow(windowActor);
  assert.equal(surface.opacity, Math.round(0.85 * 255));
  const state = manager._states.get(windowActor);
  metaWindow.get_workspace = () => ({});
  manager._syncState(state);
  assert.equal(glasses[0].visible, false);
  manager.cleanup();
  assert.equal(surface.opacity, 255);
  assert.equal(glasses[0].cleaned, true);
  assert.equal(glasses[0].destroyed, true);
  assert.equal(windowActor.handlers.size, 0);
  assert.equal(metaWindow.handlers.size, 0);
});

test('a window that moved this frame is not rescued as stranded, one that stayed put is', () => {
  const calls = [];
  const { manager } = fixture({
    ensureWindowActorAllocated: () => { calls.push('window'); return ''; },
    ensureGlassAllocated: () => { calls.push('glass'); },
    clearStranded: actor => { calls.push(`clear ${actor.name}`); },
  });
  const state = { windowActor: { name: 'actor', get_meta_window: () => ({ get_title: () => 'w' }) }, glass: { name: 'glass' } };
  manager._syncState = () => true;
  manager._syncFrameState(state);
  assert.deepEqual(calls, ['clear actor', 'clear glass']);
  calls.length = 0;
  manager._syncState = () => false;
  manager._syncFrameState(state);
  assert.deepEqual(calls, ['window', 'glass']);
});
