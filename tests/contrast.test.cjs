const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
function load(file, exports, bindings = {}) {
  const code = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export (class|const) /g, '$1 ');
  return new Function(...Object.keys(bindings), `${code}\nreturn {${exports}};`)(...Object.values(bindings));
}
const { StageContrastSampler: Sampler, AdaptiveContrastConfig: config, _getActorRect } = load(
  'contrastSampler.js', 'StageContrastSampler, AdaptiveContrastConfig, _getActorRect', {
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
    })[name];
    const manager = Object.create(C.prototype);
    manager._styledActors = new Map(); manager._adaptiveConfig = config;
    const actor = new Actor(); const original = actor.style;
    manager._setActorColor(actor, '#1a1a1a');
    assert.ok(actor.style.includes('font-weight: bold; padding: 4px;'));
    assert.ok(actor.style.includes('color:'));
    manager._setActorColor(actor, '#f2f2f2');
    manager._clearAdaptiveStyles();
    assert.equal(actor.style, original);
    assert.equal(actor._currentTargetColor, undefined);
    assert.equal(manager._styledActors.size, 0);
  });
}
