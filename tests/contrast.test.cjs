const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
function load(file, exports, bindings = {}) {
  const code = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export (class|const|function) /g, '$1 ');
  return new Function(...Object.keys(bindings), `${code}\nreturn {${exports}};`)(...Object.values(bindings));
}
const { StageContrastSampler: Sampler, AdaptiveContrastConfig: config, _getActorRect, backdropLuminance, luminanceSamples,
  glassToneOf, tonedLuminance } = load(
  'contrastSampler.js', 'StageContrastSampler, AdaptiveContrastConfig, _getActorRect, backdropLuminance, luminanceSamples, glassToneOf, tonedLuminance', {
    Shell: { Screenshot: class {} }, getTransformedRect: actor => actor.rect,
    GLib: { get_monotonic_time: () => 0 },
    global: { stage: { width: 3840, height: 2160 } },
  });
const linear = byte => byte / 255 <= 0.04045 ? byte / 255 / 12.92 : ((byte / 255 + 0.055) / 1.055) ** 2.4;
const luma = hex => { const n = parseInt(hex.slice(1), 16); return 0.2126 * linear(n >> 16) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255); };
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test('chooses higher-contrast polarity for every fresh grey background', () => {
  for (let grey = 0; grey <= 255; grey++) {
    const background = linear(grey);
    const selected = new Sampler().decideTextColor(background);
    assert.equal(ratio(background, luma(selected)), Math.max(ratio(background, luma(config.lightTextColor)), ratio(background, luma(config.darkTextColor))), `grey ${grey}`);
  }
});
test('mid-grey background gets dark text instead of low-contrast white', () => {
  const selected = new Sampler().decideTextColor(0.25);
  assert.equal(selected, config.darkTextColor);
  assert.ok(ratio(0.25, luma(selected)) > 4.9);
  assert.ok(ratio(0.25, luma(config.lightTextColor)) < 3.2);
});
test('sudden bright/dark changes correct immediately, with no smoothing delay', () => {
  const sampler = new Sampler();
  for (let i = 0; i < 20; i++) sampler.decideTextColor(0.01);
  assert.equal(sampler.decideTextColor(0.9), config.darkTextColor);
  assert.equal(sampler.decideTextColor(0.01), config.lightTextColor);
});
test('noise near the crossover does not alternate text polarity', () => {
  const sampler = new Sampler();
  const first = sampler.decideTextColor(0.18);
  for (let i = 0; i < 100; i++) assert.equal(sampler.decideTextColor(i % 2 ? 0.18 : 0.195), first);
});
test('with a contrast floor, the preferred colour stays while it reads that well', () => {
  const light = { ...config, preference: 'light', preferredMinContrast: 3 };
  // Dark reads better here, but light still reads 3.3:1.
  const background = 0.94 / 3.3 - 0.05;
  assert.equal(new Sampler().decideTextColor(background, { ...light, preferredMinContrast: 0 }), config.darkTextColor);
  const sampler = new Sampler();
  for (let i = 0; i < 20; i++) assert.equal(sampler.decideTextColor(background, light), config.lightTextColor);
  assert.equal(new Sampler().decideTextColor(0.3, light), config.darkTextColor);
});
test('the preferred colour comes back only once it reads clearly better than the floor', () => {
  const light = { ...config, preference: 'light', preferredMinContrast: 3 };
  const sampler = new Sampler();
  assert.equal(sampler.decideTextColor(0.3, light), config.darkTextColor);
  // Light reads 3.1:1: enough to stay on it, not to go back to it.
  for (let i = 0; i < 30; i++) assert.equal(sampler.decideTextColor(0.25, light), config.darkTextColor);
  let colour = null;
  for (let i = 0; i < 30; i++) colour = sampler.decideTextColor(0.18, light);
  assert.equal(colour, config.lightTextColor);
});
test('with a contrast floor, unreadable preferred text still switches at once', () => {
  const light = { ...config, preference: 'light', preferredMinContrast: 3 };
  const sampler = new Sampler();
  for (let i = 0; i < 10; i++) sampler.decideTextColor(0.1, light);
  assert.equal(sampler.decideTextColor(0.6, light), config.darkTextColor);
});
test('sampling uses transformed bounds, clips screen edges, ignores hidden actors', () => {
  assert.deepEqual(_getActorRect({ mapped: true, rect: [100.5, 50.25, 80, 20] }), { x: 100, y: 50, width: 81, height: 21 });
  assert.deepEqual(_getActorRect({ mapped: true, rect: [-10, 10, 30, 20] }), { x: 0, y: 10, width: 20, height: 20 });
  assert.equal(_getActorRect({ mapped: false, rect: [0, 0, 50, 50] }), null);
  assert.equal(_getActorRect({ mapped: true, rect: [4000, 0, 50, 50] }), null);
});
test('a moved menu does not inherit the previous region color decision', async () => {
  const sampler = new Sampler(); let value = 0.18;
  sampler.sampleLuminance = async () => value;
  const actor = { mapped: true, rect: [0, 0, 100, 20] };
  assert.equal((await sampler.chooseColorsForActors([actor])).get(actor), config.lightTextColor);
  actor.rect = [1000, 0, 100, 20]; value = 0.20;
  assert.equal((await sampler.chooseColorsForActors([actor])).get(actor), config.darkTextColor);
});

const colorHelpers = load('animation/colors.js', 'hexToRgb, hexToColorArray, rgbToHex');

class Actor {
  constructor(style = 'font-weight: bold; padding: 4px;') { this.style = style; this.visible = true; }
  get_style() { return this.style; }
  set_style(s) { this.style = s; }
  connect() { return 1; }
  disconnect() {}
  get_theme_node() { return { get_foreground_color: () => ({ red: 242, green: 242, blue: 242, alpha: 255 }), get_background_color: () => ({red: 0, green: 0, blue: 0}) }; }
  remove_style_class_name() {}
  has_style_class_name() { return false; }
}
for (const [file, name] of [['uiManager.js', 'UIManager'], ['notificationManager.js', 'NotificationManager'], ['osdManager.js', 'OsdManager'], ['quickSettingsManager.js', 'QuickSettingsManager']]) {
  test(`${name}: switches directly, preserves and restores native inline style`, () => {
    // Only the color methods run, with no frame loop or shader allocation.
    const C = load(file, name, { St: { Button: Actor, Widget: Actor },
      GLib: { get_monotonic_time: () => 0, source_remove() {}, timeout_add() { throw Error('Unexpected color fade'); } },
      adaptiveColorTweener: { cancel() {} }, ...colorHelpers,
    })[name];
    const manager = Object.create(C.prototype);
    manager._styledActors = new Map(); manager._hoverSignals = new Map();
    manager._pendingBackdropRoots = new Set(); manager._backdropRefreshId = 0;
    manager._backdropColored = new Set();
    Object.assign(manager, { _backdropColors: new Map(), _backdropSignals: new Map(),
      _sampleColors: new Map(), _dirtyBackdropRoots: new Set(), _adaptiveGeneration: 0 });
    manager._adaptiveConfig = config;
    const actor = new Actor(); const original = actor.style;
    manager._setActorColor(actor, '#1a1a1a', true);
    assert.ok(actor.style.includes('font-weight: bold; padding: 4px;'));
    assert.ok(actor.style.includes('color:'));
    manager._setActorColor(actor, '#f2f2f2', true);
    manager._clearAdaptiveStyles();
    assert.equal(actor.style, original);
    assert.equal(actor._currentTargetColor, undefined);
    assert.equal(manager._styledActors.size, 0);
  });
}

function themed({ background = null, parent = null } = {}) {
  const actor = {
    mapped: true,
    rect: [0, 0, 10, 10],
    get_parent() { return parent; },
    get_theme_node() { return { get_background_color: () => background }; },
  };
  return actor;
}

const rgba = (r, g, b, alpha) => ({ red: r, green: g, blue: b, alpha });

test('an opaque section backdrop is what the text is measured against, not the glass', () => {
  const dark = themed({ background: rgba(40, 40, 40, 255) });
  assert.ok(backdropLuminance(dark).luminance < 0.05);
  assert.equal(backdropLuminance(dark).alpha, 255);
});

test('a backdrop the glass still shows through is ignored', () => {
  const faint = themed({ background: rgba(40, 40, 40, 60) });
  assert.equal(backdropLuminance(faint), null);
});

test('a label inside an expanded section finds the section backdrop above it', () => {
  const section = themed({ background: rgba(40, 40, 40, 255) });
  const row = themed({ background: rgba(0, 0, 0, 0), parent: section });
  const label = themed({ background: null, parent: row });
  assert.ok(backdropLuminance(label).luminance < 0.05);
});

test('the search stops at the menu root instead of escaping into the shell', () => {
  const outside = themed({ background: rgba(255, 255, 255, 255) });
  const root = themed({ background: rgba(0, 0, 0, 0), parent: outside });
  const label = themed({ background: rgba(0, 0, 0, 0), parent: root });
  assert.equal(backdropLuminance(label, root), null);
});

test('the periodic round reads no theme nodes and gives every actor one colour', async () => {
  const sampler = new Sampler();
  sampler.sampleLuminance = async () => 0.9;
  let themeReads = 0;
  const watched = () => {
    const actor = themed({ background: rgba(30, 30, 30, 255) });
    const inner = actor.get_theme_node;
    actor.get_theme_node = () => { themeReads++; return inner(); };
    return actor;
  };
  const first = watched();
  const second = watched();

  const colors = await sampler.chooseColorsForActors([first, second], config, null);

  assert.equal(themeReads, 0, 'sampling must not resolve styles');
  assert.equal(colors.get(first), config.darkTextColor);
  assert.equal(colors.get(second), config.darkTextColor);
});

test('a backdrop still decides the colour when the manager asks for one', () => {
  const sampler = new Sampler();
  const onDarkSection = themed({ background: rgba(30, 30, 30, 255) });
  assert.equal(sampler._backdropColorFor(onDarkSection, config, null), config.lightTextColor);
  assert.equal(sampler._backdropColorFor(themed({ background: rgba(0, 0, 0, 0) }), config, null), null);
});

test('a backdrop decision never disturbs the shared smoothing state', async () => {
  const sampler = new Sampler();
  sampler.sampleLuminance = async () => 0.9;

  await sampler.chooseColorsForActors([themed({ background: rgba(0, 0, 0, 0) })], config, null);
  const before = sampler._lastIsBright;

  sampler._backdropColorFor(themed({ background: rgba(30, 30, 30, 255) }), config, null);
  assert.equal(sampler._lastIsBright, before);
});

function hoverFixture(rowCount = 1) {
  const laters = { pending: [], add(_, fn) { this.pending.push(fn); return this.pending.length; }, remove() {} };
  class Unused {}
  const C = load('uiManager.js', 'UIManager', {
    St: { Button: Actor, Label: Unused, Icon: Unused, Widget: Actor },
    Clutter: { Text: Unused },
    GLib: { get_monotonic_time: () => 0, source_remove() {}, SOURCE_REMOVE: false,
      timeout_add() { throw Error('Unexpected color fade'); } },
    Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    global: { compositor: { get_laters: () => laters } },
    adaptiveColorTweener: { cancel() {} }, ...colorHelpers,
    isActorValid: () => true,
  })['UIManager'];

  const manager = Object.create(C.prototype);
  manager._styledActors = new Map();
  manager._hoverSignals = new Map();
  manager._pendingBackdropRoots = new Set();
  manager._backdropRefreshId = 0;
  manager._backdropColored = new Set();
  manager._sampleColors = new Map();
  manager._adaptiveConfig = config;
  manager._isEffectActive = true;
  manager._actorDestroyed = false;
  manager._contrastSampler = new Sampler();
  manager.menu = { actor: null };

  const handlers = [];
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = new Actor();
    row.get_theme_node = () => ({
      get_foreground_color: () => ({ red: 242, green: 242, blue: 242, alpha: 255 }),
      get_background_color: () => ({ red: 30, green: 30, blue: 30, alpha: 255 }),
    });
    row.get_children = () => [];
    row.connect = () => 100 + i;
    // The row's parent is an St widget too (the menu item's box).
    const holder = Object.assign(Object.create(Actor.prototype), {
      get_parent: () => null,
      get_children: () => [row],
      connect: (name, fn) => { if (name === 'style-changed') handlers.push(fn); return 7 + i; },
      disconnect() {},
    });
    row.get_parent = () => holder;
    rows.push(row);
  }
  manager._watchHoverFor(rows);
  return { manager, laters, rows, handlers };
}

test('a style change repaints the text immediately instead of waiting for the sample timer', () => {
  const { manager, laters, rows, handlers } = hoverFixture(1);
  const row = rows[0];
  const hoverHandler = handlers[0];
  assert.equal(manager._hoverSignals.size, 1);
  assert.ok(hoverHandler, 'style changes are watched');

  hoverHandler();
  assert.equal(laters.pending.length, 1, 'one frame pass queued, not an immediate style storm');
  laters.pending.shift()();
  assert.ok(row.style.includes('color:'), 'colour applied without a sampling round');

  manager._clearAdaptiveStyles();
  assert.equal(manager._hoverSignals.size, 0);
});

test('a burst of style changes collapses into a single pass over the rows touched', () => {
  const { manager, laters, rows, handlers } = hoverFixture(3);

  for (const fire of handlers) { fire(); fire(); }
  assert.equal(laters.pending.length, 1, 'six style-changed signals, one queued pass');

  laters.pending.shift()();
  for (const row of rows) assert.ok(row.style.includes('color:'));
  assert.equal(laters.pending.length, 0);
});

test('a sampling round does not walk theme nodes across the whole menu', () => {
  const { manager, rows } = hoverFixture(3);
  let themeReads = 0;
  for (const row of rows) {
    row.get_theme_node = () => {
      themeReads++;
      return {
        get_foreground_color: () => ({ red: 242, green: 242, blue: 242, alpha: 255 }),
        get_background_color: () => ({ red: 30, green: 30, blue: 30, alpha: 255 }),
      };
    };
  }
  manager._collectAdaptiveTextTargets = () => rows;
  manager._contrastSampler.chooseColorsForActors = async () => new Map();
  manager._adaptiveInFlight = false;

  manager._updateAdaptiveTextColors();

  assert.equal(themeReads, 0, 'the periodic round leaves theme nodes alone');
});

test('text destroyed while it is measured is left alone', async () => {
  const { manager, rows } = hoverFixture(2);
  const destroyHandlers = new Map();
  const disconnected = [];
  for (const row of rows) {
    row.connect = (name, fn) => { if (name === 'destroy') destroyHandlers.set(row, fn); return 50; };
    row.disconnect = () => disconnected.push(row);
  }
  let finish;
  manager._collectAdaptiveTextTargets = () => rows;
  manager._contrastSampler.chooseColorsForActors = () => new Promise(resolve => { finish = resolve; });
  manager._adaptiveInFlight = false;
  manager._isEffectActive = true;
  const applied = [];
  manager._setActorColor = actor => applied.push(actor);

  manager._updateAdaptiveTextColors();
  destroyHandlers.get(rows[0])();
  finish(new Map(rows.map(row => [row, '#000000'])));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(applied, [rows[1]]);
  assert.deepEqual(disconnected, [rows[1]], 'a destroyed actor is not disconnected');
});

test('a menu whose rows are rebuilt keeps one stable sampling region', async () => {
  const sampler = new Sampler();
  const sampled = [];
  sampler.sampleLuminance = async rect => { sampled.push(rect); return 0.5; };
  const root = { mapped: true, rect: [0, 0, 300, 400] };

  await sampler.chooseColorsForActors([{ mapped: true, rect: [10, 10, 100, 20] }], config, root);
  await sampler.chooseColorsForActors([{ mapped: true, rect: [10, 10, 100, 20] },
    { mapped: true, rect: [10, 200, 280, 20] }], config, root);

  assert.deepEqual(sampled[0], sampled[1], 'the rebuilt row must not move the sampled region');
});

test('polarity does not flap when the collected rows change underneath it', async () => {
  const sampler = new Sampler();
  let value = 0.18;
  sampler.sampleLuminance = async () => value;
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rowsFor = n => Array.from({ length: n }, (_, i) =>
    ({ mapped: true, rect: [10, 10 + i * 30, 100 + i * 7, 20] }));

  const first = (await sampler.chooseColorsForActors(rowsFor(3), config, root)).values().next().value;
  for (let i = 0; i < 20; i++) {
    value = i % 2 ? 0.18 : 0.195;
    const colors = await sampler.chooseColorsForActors(rowsFor(3 + (i % 4)), config, root);
    for (const color of colors.values()) assert.equal(color, first, `round ${i}`);
  }
});

test('recolouring the text cannot drive the polarity back and forth', async () => {
  const sampler = new Sampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];

  // The sampled region contains the text we just recoloured, so what comes
  // back depends on the last decision. That loop is what flickered.
  let current = null;
  sampler.sampleLuminance = async () => (current === config.lightTextColor ? 0.46 : 0.40);

  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    current = (await sampler.chooseColorsForActors(rows, config, root)).get(rows[0]);
    if (i > 4) seen.add(current);
  }
  assert.equal(seen.size, 1, `polarity settled on one colour, saw ${[...seen].join(' and ')}`);
});

test('a real background change still corrects on the very next sample', async () => {
  const sampler = new Sampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  let value = 0.02;
  sampler.sampleLuminance = async () => value;

  for (let i = 0; i < 5; i++) await sampler.chooseColorsForActors(rows, config, root);
  value = 0.95;
  assert.equal((await sampler.chooseColorsForActors(rows, config, root)).get(rows[0]),
    config.darkTextColor);
});

test('the cards this extension actually draws count as a backdrop, faint overlays do not', () => {
  // stylesheet.css: rgba(51,51,51,0.8) and rgba(65,65,65,0.8) -> alpha 204
  assert.ok(backdropLuminance(themed({ background: rgba(51, 51, 51, 204) })));
  assert.ok(backdropLuminance(themed({ background: rgba(65, 65, 65, 204) })));
  // rgba(0,0,0,0.5) -> 128, rgba(255,255,255,0.3) -> 76: the glass still reads through
  assert.equal(backdropLuminance(themed({ background: rgba(0, 0, 0, 128) })), null);
  assert.equal(backdropLuminance(themed({ background: rgba(255, 255, 255, 76) })), null);
});

test('the sampling round leaves rows that sit on their own backdrop alone', () => {
  const { manager, laters, rows, handlers } = hoverFixture(2);
  const onGlass = new Actor();
  onGlass.get_theme_node = () => ({
    get_foreground_color: () => ({ red: 242, green: 242, blue: 242, alpha: 255 }),
    get_background_color: () => ({ red: 0, green: 0, blue: 0, alpha: 0 }),
  });
  onGlass.get_children = () => [];
  manager._collectAdaptiveTextTargets = () => [rows[0], onGlass];

  handlers[0]();
  laters.pending.shift()();
  const afterBackdrop = rows[0].style;
  assert.ok(afterBackdrop.includes('color:'));

  manager._applyAdaptiveColorMap(new Map([[rows[0], '#1a1a1a'], [onGlass, '#1a1a1a']]), true);

  assert.equal(rows[0].style, afterBackdrop, 'the row on a dark card keeps its own colour');
  assert.ok(onGlass.style.includes('color:'), 'the row on glass takes the sampled colour');
});

test('our own restyling does not feed back into another refresh', () => {
  const { manager, laters, rows, handlers } = hoverFixture(1);
  manager._collectAdaptiveTextTargets = () => rows;

  handlers[0]();
  assert.equal(laters.pending.length, 1);
  const pass = laters.pending.shift();
  manager._setActorColor = function (actor, color) {
    Actor.prototype.set_style.call(actor, `color: ${color};`);
    handlers[0]();
  };
  pass();

  assert.equal(laters.pending.length, 0, 'no refresh queued from our own restyle');
});

test('the container is watched, never the label we restyle ourselves', () => {
  const { manager, rows } = hoverFixture(1);
  assert.equal(manager._hoverSignals.size, 1);
  assert.equal(manager._hoverSignals.has(rows[0]), false, 'the restyled label is not the one watched');
  assert.equal(manager._hoverSignals.has(rows[0].get_parent()), true);
});

test('a style change repaints only the container that changed', () => {
  const { manager, laters, rows, handlers } = hoverFixture(3);
  let fullScans = 0;
  manager._collectAdaptiveTextTargets = () => { fullScans++; return rows; };

  handlers[0]();
  laters.pending.shift()();

  assert.equal(fullScans, 0, 'the whole menu is never walked for one row');
  assert.ok(rows[0].style.includes('color:'));
  assert.equal(rows[1].style.includes('color:'), false, 'untouched rows stay untouched');
});

test('an unrepainted glass skips the capture once the decision has settled', async () => {
  const sampler = new Sampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  let paints = 0, captures = 0, value = 0.9;
  sampler.sampleLuminance = async () => { captures++; paints++; return value; };
  const choose = () => sampler.chooseColorsForActors(rows, config, root, () => paints);

  for (let i = 0; i < 20; i++) await choose();
  const settled = captures;
  assert.ok(settled > 1 && settled < 20, `sampled ${settled} times before settling`);
  const skipped = await choose();
  assert.equal(captures, settled);
  assert.equal(skipped.size, 0, 'a skipped round leaves the applied colours alone');

  paints++;
  value = 0.02;
  assert.equal((await choose()).get(rows[0]), config.lightTextColor, 'a repaint samples again');
  assert.equal(captures, settled + 1);
});

for (const samplePerElement of [false, true]) {
  test(`changing preferred text colour resamples idle glass (per element: ${samplePerElement})`, async () => {
    const sampler = new Sampler();
    const root = {mapped: true, rect: [0, 0, 300, 400]};
    const rows = [{mapped: true, rect: [10, 10, 100, 20]}];
    const settings = {...config, samplePerElement, preference: 'light'};
    let captures = 0;
    sampler.sampleLuminance = async () => { captures++; return 0.19; };
    const choose = () => sampler.chooseColorsForActors(rows, settings, root, () => 7);
    assert.equal((await choose()).get(rows[0]), config.lightTextColor);
    for (let i = 0; i < 20; i++) await choose();
    const settled = captures;
    assert.equal((await choose()).size, 0);
    assert.equal(captures, settled);

    settings.preference = 'dark';
    assert.equal((await choose()).get(rows[0]), config.darkTextColor);
    assert.equal(captures, settled + 1);
    settings.preference = 'light';
    assert.equal((await choose()).get(rows[0]), config.lightTextColor);
  });
}

test('the skip baseline is dropped when the region, config or screen changes', async () => {
  const sampler = new Sampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  let paints = 0, captures = 0;
  sampler.sampleLuminance = async () => { captures++; paints++; return 0.9; };
  for (let i = 0; i < 20; i++) await sampler.chooseColorsForActors(rows, config, root, () => paints);
  const settled = captures;

  root.rect = [0, 0, 300, 420];
  await sampler.chooseColorsForActors(rows, config, root, () => paints);
  assert.equal(captures, settled + 1, 'a moved region samples');
  for (let i = 0; i < 20; i++) await sampler.chooseColorsForActors(rows, config, root, () => paints);
  const again = captures;
  await sampler.chooseColorsForActors(rows, { ...config, darkTextColor: '#000000' }, root, () => paints);
  assert.equal(captures, again + 1, 'new text colours sample');

  sampler.sampleLuminance = async () => { captures++; paints += 3; return 0.9; };
  for (let i = 0; i < 5; i++) await sampler.chooseColorsForActors(rows, config, root, () => paints);
  assert.equal(captures, again + 6, 'a screen that changed during the capture keeps sampling');

  const plain = captures;
  for (let i = 0; i < 5; i++) await sampler.chooseColorsForActors(rows, config, root);
  assert.equal(captures, plain + 5, 'without a paint signature nothing is skipped');
});

test('invalidating the sampler forces the next round to sample', async () => {
  const sampler = new Sampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  let paints = 0, captures = 0;
  sampler.sampleLuminance = async () => { captures++; paints++; return 0.9; };
  for (let i = 0; i < 20; i++) await sampler.chooseColorsForActors(rows, config, root, () => paints);
  const settled = captures;
  sampler.invalidate();
  await sampler.chooseColorsForActors(rows, config, root, () => paints);
  assert.equal(captures, settled + 1);
  await sampler.chooseColorsForActors([...rows, { mapped: true, rect: [10, 40, 100, 20] }], config, root, () => paints);
  assert.equal(captures, settled + 2, 'new text inside an unchanged root samples');
});

test('pixel luminance sampling matches the original un-premultiplying loop', () => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rgb = (r, g, b) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const reference = ({ data, width, height, stride, channels, step }) => {
    const values = [];
    for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
      const idx = y * stride + x * channels;
      if (channels > 3) {
        const a = data[idx + 3];
        if (a < 32) continue;
        if (a < 255) {
          const inv = 255.0 / a;
          values.push(rgb(clamp(Math.round(data[idx] * inv), 0, 255), clamp(Math.round(data[idx + 1] * inv), 0, 255),
            clamp(Math.round(data[idx + 2] * inv), 0, 255)));
          continue;
        }
      }
      values.push(rgb(data[idx], data[idx + 1], data[idx + 2]));
    }
    return values;
  };
  let seed = 11;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) % 256;
  for (const channels of [3, 4]) for (const step of [1, 2, 3]) {
    const width = 17, height = 9, stride = width * channels + 3;
    const data = Uint8Array.from({ length: stride * height }, rand);
    const shot = { data, width, height, stride, channels, step };
    assert.deepEqual(luminanceSamples(shot), reference(shot), `channels=${channels} step=${step}`);
  }
});

test('a flip is held while the colour tween runs, then measurements count again', () => {
  let now = 0;
  const { StageContrastSampler: TimedSampler } = load('contrastSampler.js', 'StageContrastSampler', {
    Shell: { Screenshot: class {} }, getTransformedRect: actor => actor.rect,
    GLib: { get_monotonic_time: () => now },
    global: { stage: { width: 3840, height: 2160 } },
  });
  const sampler = new TimedSampler();
  now = 1e6;
  assert.equal(sampler.decideTextColor(0.9), config.darkTextColor);
  assert.equal(sampler.decideTextColor(0.0), config.lightTextColor, 'a real change flips at once');
  // Neither colour reaches 4.5:1 on 0.2, so readability forces nothing and
  // the smoothed history would flip straight back: the tween's own pixels.
  now += 100e3;
  assert.equal(sampler.decideTextColor(0.2), config.lightTextColor, 'held during the tween');
  now += 600e3;
  assert.equal(sampler.decideTextColor(0.2), config.darkTextColor, 'released after the hold');
});

test('an unreadable colour is never held after a flip', () => {
  let now = 0;
  const { StageContrastSampler: TimedSampler } = load('contrastSampler.js', 'StageContrastSampler', {
    Shell: { Screenshot: class {} }, getTransformedRect: actor => actor.rect,
    GLib: { get_monotonic_time: () => now },
    global: { stage: { width: 3840, height: 2160 } },
  });
  const sampler = new TimedSampler();
  now = 1e6;
  sampler.decideTextColor(0.9);
  assert.equal(sampler.decideTextColor(0.0), config.lightTextColor);
  now += 50e3;
  assert.equal(sampler.decideTextColor(0.95), config.darkTextColor);
});

test('glyphs covering a large minority of the sample do not move the measured background', async () => {
  // 70% dark background, 30% light glyphs: the interquartile mean sees only
  // the background, where a 10% trim would have let the glyphs through.
  const width = 10, height = 10, channels = 3;
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) data.fill(i < 30 ? 242 : 20, i * channels, (i + 1) * channels);
  const painted = [];
  const { StageContrastSampler: ShotSampler } = load('contrastSampler.js', 'StageContrastSampler', {
    Mtk: { Rectangle: class { constructor(r) { Object.assign(this, r); } } },
    paintStageToContent: (rect, scale) => {
      painted.push([rect, scale]);
      return { get_texture: () => ({ get_width: () => width, get_height: () => height }) };
    },
    Shell: { Screenshot: {
      composite_to_stream: (...args) => args[args.length - 1](null, null),
      composite_to_stream_finish: () => ({
        get_width: () => width, get_height: () => height, get_rowstride: () => width * channels,
        get_n_channels: () => channels, get_pixels: () => data,
      }),
    } },
    Gio: { MemoryOutputStream: { new_resizable: () => ({}) } },
    Cogl: { Pipeline: { new: () => ({ set_layer_texture() {}, set_layer_filters() {} }) }, PipelineFilter: {}, BufferBit: {} },
    coglContext: () => null,
    createTarget: () => ({ texture: {}, framebuffer: { orthographic() {}, clear4f() {}, draw_textured_rectangle() {}, flush() {} } }),
    getTransformedRect: actor => actor.rect, GLib: { get_monotonic_time: () => 0 },
    global: { stage: { width: 3840, height: 2160 } },
  });
  const measured = await new ShotSampler().sampleLuminance({ x: 0, y: 0, width, height });
  assert.ok(Math.abs(measured - linear(20)) < 1e-9, `measured ${measured}, background ${linear(20)}`);
  await new ShotSampler().sampleLuminance({ x: 10.5, y: 20, width: 960, height: 480 });
  assert.deepEqual([{ ...painted[1][0] }, painted[1][1]], [{ x: 10, y: 20, width: 960, height: 480 }, 0.05],
    'the stage is painted small rather than read at full size');
});

test('changing the preferred colour ends the settle hold at once', () => {
  let now = 0;
  const { StageContrastSampler: TimedSampler } = load('contrastSampler.js', 'StageContrastSampler', {
    Shell: { Screenshot: class {} }, getTransformedRect: actor => actor.rect,
    GLib: { get_monotonic_time: () => now },
    global: { stage: { width: 3840, height: 2160 } },
  });
  const sampler = new TimedSampler();
  now = 1e6;
  const light = { ...config, preference: 'light' }, dark = { ...config, preference: 'dark' };
  assert.equal(sampler.decideTextColor(0.19, light), config.lightTextColor);
  assert.equal(sampler.decideTextColor(0.19, dark), config.darkTextColor);
  now += 50e3;
  assert.equal(sampler.decideTextColor(0.19, light), config.lightTextColor, 'not held by the flip 50 ms ago');
  now += 50e3;
  assert.equal(sampler.decideTextColor(0.2, light), config.lightTextColor);
});

const plainTone = glassToneOf(new Map());
const toneWith = values => glassToneOf(new Map(Object.entries(values)));

test('a glass with no colour adjustments predicts the backdrop unchanged', () => {
  for (const grey of [0, 20, 128, 200, 255])
    assert.ok(Math.abs(tonedLuminance(grey, grey, grey, plainTone) - linear(grey)) < 1e-9, `grey ${grey}`);
});

test('the glass tone predicts what the tint and the surface light do to a backdrop', () => {
  const white = toneWith({ tint_r: 1, tint_g: 1, tint_b: 1, tint_strength: 0.5 });
  assert.ok(tonedLuminance(10, 10, 10, white) > 0.2, 'a strong white tint lifts a dark backdrop');
  assert.equal(tonedLuminance(10, 10, 10, toneWith({ tint_r: 1, tint_g: 1, tint_b: 1, tint_strength: 1 })), 1);
  const dimmed = toneWith({ brightness: 0.5 });
  assert.ok(tonedLuminance(200, 200, 200, dimmed) < linear(200) / 2);
  const sheen = toneWith({ sheen_intensity: 0.5 });
  assert.ok(tonedLuminance(10, 10, 10, sheen) > linear(10));
  assert.equal(tonedLuminance(10, 10, 10, toneWith({ sheen_intensity: 0.5, surface_light_enabled: 0 })), tonedLuminance(10, 10, 10, plainTone));
});

function glassSource({ drawn = true, copyRect = [0, 0, 300, 400], values = {} } = {}) {
  return {
    mapped: drawn, uniformValues: new Map(Object.entries(values)),
    get_paint_opacity: () => drawn ? 255 : 0,
    backdropCopy: () => copyRect ? { texture: 'copy', rect: copyRect } : null,
  };
}

function measuringSampler() {
  const sampler = new Sampler();
  const calls = [];
  sampler.sampleLuminance = async (rect, tone) => { calls.push({ path: 'screen', tone }); return 0.9; };
  sampler.sampleBackdropLuminance = async (copy, rect, tone) => { calls.push({ path: 'backdrop', copy, tone }); return 0.9; };
  return { sampler, calls };
}

test('a drawn glass is measured from its backdrop copy, not from the screen', async () => {
  const { sampler, calls } = measuringSampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  await sampler.chooseColorsForActors(rows, config, root, undefined, () => [glassSource({ values: { tint_strength: 0.3 } })]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'backdrop');
  assert.equal(calls[0].tone.tintStrength, 0.3);
});

test('before the glass is drawn the screen is measured with the glass tone applied', async () => {
  const { sampler, calls } = measuringSampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  await sampler.chooseColorsForActors(rows, config, root, undefined, () => [glassSource({ drawn: false, values: { tint_strength: 0.3 } })]);
  assert.equal(calls[0].path, 'screen');
  assert.equal(calls[0].tone.tintStrength, 0.3, 'the screen shows the bare backdrop');
});

test('a drawn glass without a fresh copy falls back to the screen as it is', async () => {
  const { sampler, calls } = measuringSampler();
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  await sampler.chooseColorsForActors(rows, config, root, undefined, () => [glassSource({ copyRect: null })]);
  assert.deepEqual(calls, [{ path: 'screen', tone: undefined }], 'the screen already shows the glass');
  calls.length = 0;
  sampler.invalidate();
  await sampler.chooseColorsForActors(rows, config, root, undefined, () => [glassSource({ copyRect: [1000, 0, 1200, 100] })]);
  assert.deepEqual(calls, [{ path: 'screen', tone: undefined }], 'a copy elsewhere on the screen is not used');
});

test('of several glasses, the one whose copy covers the text is measured', async () => {
  const { sampler, calls } = measuringSampler();
  const rows = [{ mapped: true, rect: [1950, 10, 100, 20] }];
  const left = glassSource({ copyRect: [0, 0, 1920, 1080] });
  const right = glassSource({ copyRect: [1920, 0, 3840, 1080], values: { brightness: 0.8 } });
  await sampler.chooseColorsForActors(rows, config, null, undefined, () => [left, right]);
  assert.equal(calls[0].path, 'backdrop');
  assert.equal(calls[0].tone.brightness, 0.8);
});

test('a reset sampler decides afresh instead of smoothing towards the last decision', async () => {
  const sampler = new Sampler(); let value = 0.02;
  sampler.sampleLuminance = async () => value;
  const root = { mapped: true, rect: [0, 0, 300, 400] };
  const rows = [{ mapped: true, rect: [10, 10, 100, 20] }];
  for (let i = 0; i < 10; i++) await sampler.chooseColorsForActors(rows, config, root);
  value = 0.2;
  const held = new Sampler(); held.sampleLuminance = async () => 0.02;
  for (let i = 0; i < 10; i++) await held.chooseColorsForActors(rows, config, root);
  held.sampleLuminance = async () => 0.2;
  held.invalidate();
  assert.equal((await held.chooseColorsForActors(rows, config, root)).get(rows[0]), config.lightTextColor,
    'without a reset the old decision holds');
  sampler.reset();
  assert.equal((await sampler.chooseColorsForActors(rows, config, root)).get(rows[0]), config.darkTextColor);
});

test('text leaving a highlight goes straight back to the colour the other rows have', () => {
  const { manager, laters, rows, handlers } = hoverFixture(1);
  const row = rows[0];
  manager._applyAdaptiveColorMap(new Map([[row, '#1a1a1a']]), true);
  let background = { red: 30, green: 30, blue: 30, alpha: 255 };
  row.get_theme_node = () => ({
    get_foreground_color: () => ({ red: 26, green: 26, blue: 26, alpha: 255 }),
    get_background_color: () => background,
  });
  handlers[0]();
  laters.pending.shift()();
  assert.equal(row._currentTargetColor, '#f2f2f2', 'light text on the dark highlight');

  background = { red: 0, green: 0, blue: 0, alpha: 0 };
  handlers[0]();
  laters.pending.shift()();
  assert.equal(row._currentTargetColor, '#1a1a1a', 'back to the sampled colour without waiting for a sample');
});

test('the menu keeps its open colours while the open animation runs', () => {
  const timers = [];
  const idles = [];
  const C = load('uiManager.js', 'UIManager', {
    GLib: { PRIORITY_DEFAULT: 0, PRIORITY_HIGH: -100, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
      timeout_add: (_p, _ms, fn) => { timers.push(fn); return 1; },
      idle_add: (priority, fn) => { idles.push([priority, fn]); return 2; } },
  })['UIManager'];
  const manager = Object.create(C.prototype);
  manager._adaptiveConfig = config;
  manager._adaptiveTimerId = 0;
  manager._contrastSampler = new Sampler();
  manager.menu = { isOpen: true };
  const rounds = [];
  manager._updateAdaptiveTextColors = skip => rounds.push(skip);

  manager._openSampleId = 0;
  manager._tickId = 5;
  manager._startAdaptiveColorSampling(true);
  assert.deepEqual(rounds, [], 'not inside open-state-changed, which GNOME 51 emits before showing the menu');
  assert.equal(idles[0][0], -100, 'ahead of the frame');
  idles.shift()[1]();
  assert.deepEqual(rounds, [true], 'sampled once at open, without a tween');
  manager._awaitingOpenColors = false;
  timers[0]();
  assert.deepEqual(rounds, [true], 'held while the spring runs');
  manager._tickId = 0;
  timers[0]();
  assert.deepEqual(rounds, [true, false], 'sampled again once it has settled');

  rounds.length = 0;
  manager._tickId = 5;
  manager._adaptiveTimerId = 0;
  manager._startAdaptiveColorSampling(true);
  idles.shift()[1]();
  timers[1]();
  assert.deepEqual(rounds, [true, true], 'an open sample that found nothing is retried during the animation');
});

test('text a menu adds after opening takes the menu colour before it is drawn', () => {
  const { manager, laters, rows } = hoverFixture(2);
  manager.menu = { actor: null, isOpen: true };
  manager._sharedColor = '#1a1a1a';
  manager._newTextId = 0;
  manager._adaptiveInFlight = false;
  rows[0].get_theme_node = rows[1].get_theme_node = () => ({
    get_foreground_color: () => ({ red: 255, green: 255, blue: 255, alpha: 255 }),
    get_background_color: () => ({ red: 0, green: 0, blue: 0, alpha: 0 }),
  });
  manager._collectAdaptiveTextTargets = () => rows;
  manager._queueNewTextColors();
  assert.equal(laters.pending.length, 1, 'once per frame');
  laters.pending.shift()();
  assert.deepEqual(rows.map(r => r._currentTargetColor), ['#1a1a1a', '#1a1a1a']);

  manager._sharedColor = null;
  manager._awaitingOpenColors = true;
  let sampled = null;
  manager._updateAdaptiveTextColors = skip => { sampled = skip; };
  manager._queueNewTextColors();
  laters.pending.shift()();
  assert.equal(sampled, true, 'with no colour yet, the new items are sampled at once');
});
