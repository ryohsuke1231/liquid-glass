const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createModuleLoader} = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const transparent = {red: 0, green: 0, blue: 0, alpha: 0};
const dark = {red: 51, green: 51, blue: 51, alpha: 204};
const bright = {red: 240, green: 240, blue: 240, alpha: 255};

test('button alpha keeps a coloured toggle child visible and makes its container transparent', () => {
  const f = fixture();
  f.button.has_style_class_name = name => name === 'quick-toggle';
  const child = new f.Button(bright, f.button);
  f.manager._styledButtons.set(f.button, f.button.get_style());
  f.manager._styledButtons.set(child, child.get_style());
  f.manager._updateSingleButtonAlpha(child, 0.4);
  assert.match(child.get_style(), /rgba\(240, 240, 240, 0.4\)/);
  assert.match(f.button.get_style(), /background-color: transparent !important/);
  assert.equal(f.button._isUpdatingAlpha, false);
  assert.equal(child._isUpdatingAlpha, false);
});

function fixture(background = dark, luma = 0.7) {
  let reads = 0;
  let nextId = 1;
  const pending = new Map();
  class Widget {
    constructor(background = transparent, parent = null) {
      Object.assign(this, {background, parent, children: [], visible: true, mapped: true,
        reactive: true, rect: [10, 10, 100, 30], style: 'padding: 4px;', signals: new Map()});
      parent?.children.push(this);
    }
    get_children() { return this.children; }
    get_parent() { return this.parent; }
    get_style() { return this.style; }
    set_style(style) { this.style = style || ''; this.emit('style-changed'); }
    connect(name, callback) { const id = nextId++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(name) { for (const signal of [...this.signals.values()]) if (signal.name === name) signal.callback(); }
    has_style_pseudo_class() { return false; }
    has_style_class_name() { return false; }
    remove_style_class_name() {}
    ensure_style() {}
    get_theme_node() {
      reads++;
      return {get_background_color: () => {
        const match = [...this.style.matchAll(/background-color: rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/g)].at(-1);
        return match ? {red: +match[1], green: +match[2], blue: +match[3], alpha: Math.round(+match[4] * 255)} : this.background;
      }, get_foreground_color: () => ({red: 242, green: 242, blue: 242, alpha: 255})};
    }
  }
  class Button extends Widget {}
  class Label extends Widget {}
  class Unused {}
  const laters = {add(_type, fn) { const id = nextId++; pending.set(id, fn); return id; }, remove(id) { pending.delete(id); }};
  const handlers = new Map();
  const clock = {now: 0};
  const stage = {width: 1920, height: 1200,
    connect(name, fn) { const id = nextId++; handlers.set(id, {name, fn}); return id; },
    disconnect(id) { handlers.delete(id); },
    emit(name) { for (const h of [...handlers.values()]) if (h.name === name) h.fn(); }};
  const load = createModuleLoader({
    St: {Widget, Button, Label, Icon: Unused}, Clutter: {Text: Unused},
    Shell: {Screenshot: class {}}, getTransformedRect: actor => actor.rect,
    global: {stage, compositor: {get_laters: () => laters}},
    Meta: {LaterType: {BEFORE_REDRAW: 0}},
    GLib: {get_monotonic_time: () => clock.now, SOURCE_REMOVE: false, source_remove() {}},
    adaptiveColorTweener: {cancel() {}, add(_actor, entry) { entry.apply(entry.targetRgb.r, entry.targetRgb.g, entry.targetRgb.b, entry.targetAlpha); }},
    resolveCrossFade: () => false,
  });
  const {StageContrastSampler, AdaptiveContrastConfig} = load(path.join(dist, 'contrastSampler.js'));
  const {QuickSettingsManager} = load(path.join(dist, 'quickSettingsManager.js'));
  const root = new Widget();
  const button = new Button(background, root);
  const label = new Label(transparent, button);
  const sampler = new StageContrastSampler();
  sampler.sampleLuminance = async () => luma;
  const manager = Object.create(QuickSettingsManager.prototype);
  Object.assign(manager, {_adaptiveConfig: {...AdaptiveContrastConfig}, _adaptiveInFlight: false,
    _contrastSampler: sampler, _styledActors: new Map(), _styledButtons: new Map(),
    _buttonSignalIds: new Map(), _adaptiveTimerId: 0, _buttonTimerId: 0, _buttonIdleIds: new Set(),
    _backdropColors: new Map(), _backdropSignals: new Map(), _sampleColors: new Map(),
    _dirtyBackdropRoots: new Set(), _backdropRefreshId: 0, _applyingForeground: false, _adaptiveGeneration: 0,
    menu: {actor: root, isOpen: true}, _logger: {error(message) { throw Error(message); }}});
  const sample = async () => { manager._updateAdaptiveTextColors(true); await new Promise(resolve => setImmediate(resolve)); };
  const flush = () => {
    let rounds = 0;
    while (pending.size) {
      assert.ok(rounds++ < 5, 'style updates must settle, not create a frame loop');
      const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn());
    }
  };
  return {manager, sampler, root, button, label, sample, flush, pending, load, reads: () => reads, Button, Label,
    stage, handlers, clock};
}

for (const alpha of [255, 204]) test(`dark Quick Settings tile (alpha=${alpha}) keeps light text on bright glass`, async () => {
  const f = fixture({...dark, alpha});
  await f.sample();
  assert.equal(f.label._currentTargetColor, '#f2f2f2');
  assert.equal(f.button._currentTargetColor, '#f2f2f2');
  f.flush();
  const reads = f.reads();
  await f.sample();
  assert.equal(f.reads(), reads, 'unchanged sampling rounds do not read theme nodes');
  assert.equal(f.label._currentTargetColor, '#f2f2f2');
});

test('bright tile gets dark text even when the glass is dark', async () => {
  const f = fixture(bright, 0.01); await f.sample();
  assert.equal(f.label._currentTargetColor, '#1a1a1a');
});

test('transparent controls still follow the glass', async () => {
  const f = fixture(transparent); await f.sample();
  assert.equal(f.label._currentTargetColor, '#1a1a1a');
});

test('hover or checked style changes update descendants without another screenshot', async () => {
  const f = fixture(dark, 0.01); await f.sample(); f.flush();
  f.button.background = bright;
  f.button.emit('style-changed'); f.button.emit('style-changed');
  assert.equal(f.pending.size, 1, 'coalesce restyles before redraw');
  f.flush();
  assert.equal(f.label._currentTargetColor, '#1a1a1a');
  f.button.background = transparent; f.button.emit('style-changed'); f.flush();
  assert.equal(f.label._currentTargetColor, '#f2f2f2', 'transparent backdrop returns to the last glass color');
});

test('button alpha only dims: translucent theme backgrounds keep their own alpha', () => {
  const f = fixture({red: 255, green: 255, blue: 255, alpha: 38});
  f.manager._styledButtons.set(f.button, f.button.style);
  f.manager._updateSingleButtonAlpha(f.button, 0.8);
  assert.equal(f.button.style, 'padding: 4px;');
});

test('alpha and foreground updates preserve each other and restore native styles', async () => {
  const f = fixture({...dark, alpha: 255}); const original = f.button.style;
  f.manager._styledButtons.set(f.button, original);
  await f.sample();
  f.manager._updateSingleButtonAlpha(f.button, 0.8);
  assert.match(f.button.style, /color: rgba\(242, 242, 242, 1.000\)/);
  assert.match(f.button.style, /background-color: rgba\(51, 51, 51, 0.8\)/);
  f.manager._setActorColor(f.button, '#1a1a1a', true);
  assert.match(f.button.style, /background-color: rgba\(51, 51, 51, 0.8\)/);
  f.manager._clearAdaptiveStyles(); f.manager._clearButtonStyles();
  assert.equal(f.button.style, original);
  assert.equal(f.pending.size, 0);
});

test('closing the menu rejects an in-flight sample', async () => {
  const f = fixture(); let finish;
  f.sampler.sampleLuminance = () => new Promise(resolve => { finish = resolve; });
  f.manager._updateAdaptiveTextColors(true);
  f.manager.menu.isOpen = false; f.manager._stopAdaptiveColorSampling();
  finish(0.7); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.manager._styledActors.size, 0);
});

test('cleanup disconnects watchers and cancels pending recoloring', async () => {
  const f = fixture(); await f.sample();
  f.button.emit('style-changed');
  f.manager._clearAdaptiveStyles();
  assert.equal(f.pending.size, 0);
  for (const actor of [f.root, f.button, f.label]) {
    assert.equal([...actor.signals.values()].filter(s => s.name === 'style-changed').length, 0);
  }
});

test('a rebuilt row adopts its own backdrop and destroyed rows are released', async () => {
  const f = fixture(); await f.sample();
  const button = new f.Button(bright, f.root);
  const label = new f.Label(transparent, button);
  await f.sample();
  assert.equal(label._currentTargetColor, '#1a1a1a');
  label.emit('destroy');
  assert.equal(f.manager._sampleColors.has(label), false);
  assert.equal(f.manager._backdropColors.has(label), false);
  assert.equal(f.manager._styledActors.has(label), false);
  button.emit('style-changed'); f.flush();
});

test('buttons destroyed while the menu is open are not touched on cleanup', () => {
  const f = fixture();
  f.manager._findAllButtons = () => [f.button];
  f.manager._updateSingleButtonAlpha = () => {};
  f.manager._updateButtonAlpha();
  assert.ok(f.manager._buttonSignalIds.has(f.button));
  f.button.emit('destroy');
  f.button.disconnect = () => assert.fail('disconnect on a destroyed button');
  f.button.set_style = () => assert.fail('set_style on a destroyed button');
  f.manager._clearButtonStyles();
  assert.equal(f.manager._styledButtons.size, 0);
});

test('reparenting a row updates the backdrop and watches the new parent', async () => {
  const f = fixture(); await f.sample();
  const button = new f.Button(bright, f.root);
  f.label.parent = button; f.label.emit('notify::parent'); f.flush();
  assert.equal(f.label._currentTargetColor, '#1a1a1a');
  button.background = dark; button.emit('style-changed'); f.flush();
  assert.equal(f.label._currentTargetColor, '#f2f2f2');
});

test('turning adaptive contrast off rejects an in-flight sample', async () => {
  const f = fixture(); let finish;
  f.sampler.sampleLuminance = () => new Promise(resolve => { finish = resolve; });
  f.manager._updateAdaptiveTextColors(true);
  f.manager._adaptiveConfig.enabled = false;
  finish(0.7); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.manager._styledActors.size, 0);
});

test('turning adaptive contrast off also rejects an already queued hover update', async () => {
  const f = fixture(); await f.sample();
  f.button.background = bright; f.button.emit('style-changed');
  f.manager._adaptiveConfig.enabled = false;
  f.flush();
  assert.equal(f.label._currentTargetColor, '#f2f2f2');
});

for (const honourFreeze of [true, false]) test(`quick-settings frame sync keeps one loop (freeze honoured: ${honourFreeze}) and stops cleanly`, () => {
  const { manager, pending, load, stage, handlers, clock } = fixture();
  const { setFrameSyncFrozen } = load(path.join(dist, 'animation.js'));
  let syncs = 0;
  Object.assign(manager, { _frameSyncId: 0, _frameSignalId: 0, _torndown: false, targetActor: { mapped: true },
    glass: { get_parent: () => null, mapped: false, visible: false } });
  const runFirst = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()); };
  const frame = () => { clock.now += 16000; stage.emit('before-update'); };
  manager._startFrameSync(() => syncs++, 'test', honourFreeze);
  manager._startFrameSync(() => syncs++, 'test', honourFreeze);
  assert.equal(handlers.size, 1, 'one before-update handler');
  assert.equal(pending.size, 1, 'one later for the frame the loop starts in');
  clock.now += 16000;
  runFirst();
  frame();
  assert.equal(syncs, 2);
  assert.equal(pending.size, 0, 'the loop follows frames instead of requesting them');
  clock.now += 1000;
  stage.emit('before-update');
  assert.equal(syncs, 2, 'a second stage view in the same frame does not sync again');
  setFrameSyncFrozen(true);
  try {
    frame();
    assert.equal(syncs, honourFreeze ? 2 : 3);
    assert.equal(handlers.size, 1);
  } finally {
    setFrameSyncFrozen(false);
  }
  manager.targetActor.mapped = false;
  frame();
  assert.equal(handlers.size, 0, 'an unmapped menu ends the loop');
  manager.targetActor.mapped = true;
  manager._startFrameSync(() => syncs++, 'test', honourFreeze);
  manager._stopFrameSync();
  assert.equal(pending.size, 0);
  assert.equal(handlers.size, 0);
  assert.equal(manager._frameSyncId, 0);
  assert.equal(manager._frameSignalId, 0);
});

test('equal numbers in the other coordinate space still move the quick-settings glass', () => {
  const { manager } = fixture();
  const positions = [];
  const glass = { remove_transition() {}, set_size() {}, set_clip() {}, set_position(x, y) { positions.push([x, y]); },
    setShadowMaxRadius() {}, setResolution() {}, setGlassGeometry() {} };
  Object.assign(manager, { glass });
  manager._applyPanelBounds(glass, 10, 20, 300, 200, 0, 0, 1920, 1080);
  manager._applyPanelBounds(glass, 10, 20, 300, 200, 0, 0, 1920, 1080);
  assert.equal(positions.length, 1, 'unchanged panel bounds are skipped');
  manager._applyToggleBounds(glass, 10, 20, 300, 200, -5, -5, 1920, 1080);
  assert.equal(positions.length, 2, 'the toggle path does not reuse the panel path cache');
  assert.deepEqual(positions[1], [-5, -5]);
});
