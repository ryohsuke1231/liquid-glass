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
const { StageContrastSampler: Sampler, AdaptiveContrastConfig: config, _getActorRect, backdropLuminance } = load(
  'contrastSampler.js', 'StageContrastSampler, AdaptiveContrastConfig, _getActorRect, backdropLuminance', {
    Shell: { Screenshot: class {} }, getTransformedRect: actor => actor.rect,
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

class Actor {
  constructor(style = 'font-weight: bold; padding: 4px;') { this.style = style; this.visible = true; }
  get_style() { return this.style; }
  set_style(s) { this.style = s; }
  connect() { return 1; }
  get_theme_node() { return { get_foreground_color: () => ({ red: 242, green: 242, blue: 242, alpha: 255 }), get_background_color: () => ({red: 0, green: 0, blue: 0}) }; }
  remove_style_class_name() {}
}
for (const [file, name] of [['uiManager.js', 'UIManager'], ['notificationManager.js', 'NotificationManager'], ['osdManager.js', 'OsdManager'], ['quickSettingsManager.js', 'QuickSettingsManager']]) {
  test(`${name}: switches directly, preserves and restores native inline style`, () => {
    // Only the color methods run, with no frame loop or shader allocation.
    const C = load(file, name, { St: { Button: Actor },
      GLib: { get_monotonic_time: () => 0, source_remove() {}, timeout_add() { throw Error('Unexpected color fade'); } },
      adaptiveColorTweener: { cancel() {} },
    })[name];
    const manager = Object.create(C.prototype);
    manager._styledActors = new Map(); manager._hoverSignals = new Map();
    manager._pendingBackdropRoots = new Set(); manager._backdropRefreshId = 0;
    manager._backdropColored = new Set();
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
    St: { Button: Actor, Label: Unused, Icon: Unused, Widget: Unused },
    Clutter: { Text: Unused },
    GLib: { get_monotonic_time: () => 0, source_remove() {}, SOURCE_REMOVE: false,
      timeout_add() { throw Error('Unexpected color fade'); } },
    Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    global: { compositor: { get_laters: () => laters } },
    adaptiveColorTweener: { cancel() {} },
    isActorValid: () => true,
  })['UIManager'];

  const manager = Object.create(C.prototype);
  manager._styledActors = new Map();
  manager._hoverSignals = new Map();
  manager._pendingBackdropRoots = new Set();
  manager._backdropRefreshId = 0;
  manager._backdropColored = new Set();
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
    const holder = {
      get_parent: () => null,
      get_children: () => [row],
      connect: (name, fn) => { if (name === 'style-changed') handlers.push(fn); return 7 + i; },
      disconnect() {},
    };
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
