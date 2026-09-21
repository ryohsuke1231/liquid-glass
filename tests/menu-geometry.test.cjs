const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

const utils = fs.readFileSync(path.join(dist, 'utils.js'), 'utf8');
const allocatedSizeCode = utils.match(/^export function getAllocatedSize\([\s\S]*?^}/m)[0];
const getAllocatedSize = new Function(`${allocatedSizeCode.replace('export ', '')}; return getAllocatedSize;`)();

function fixture() {
  const monitor = { x: 1920, y: 0, width: 1920, height: 1200 };
  const geometry = [];
  const bindings = {
    St: { Side: { LEFT: 0, RIGHT: 1, TOP: 2, BOTTOM: 3 } },
    Main: { layoutManager: { primaryMonitor: monitor }, panel: { height: 28 } },
    getAllocatedSize, setClipIfChanged() {}, syncGlassCaptureClip() {},
  };
  const code = fs.readFileSync(path.join(dist, 'uiManager.js'), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  const Manager = new Function(...Object.keys(bindings), `${code}; return UIManager;`)(...Object.values(bindings));
  const manager = Object.create(Manager.prototype);
  const body = {
    width: 360, height: 420, needsAllocation: false, scale: 1,
    // Restyling invalidates layout: Clutter then returns preferred size,
    // including margins, even though the on-screen allocation has not changed.
    get_size() { return [this.width + (this.needsAllocation ? 24 : 0), this.height + (this.needsAllocation ? 16 : 0)]; },
    get_allocation_box() { return { get_width: () => this.width, get_height: () => this.height }; },
    get_scale() { return [this.scale, this.scale]; },
    get_theme_node: () => ({ get_margin: side => [12, 12, 8, 8][side] }),
    get_transformed_position: () => [2040, 64],
  };
  const outer = {
    mapped: true, opacity: 255, needsAllocation: false, scale: 1,
    get_size() { return [body.width + (this.needsAllocation ? 48 : 24), body.height + 32]; },
    get_scale() { return [this.scale, this.scale]; },
  };
  const background = {
    visible: true, show() { this.visible = true; }, hide() { this.visible = false; },
    remove_transition() {}, set_position() {}, set_size() {},
  };
  Object.assign(manager, {
    animActor: body, targetActor: outer, bgActor: background,
    _enableAnimation: true, _glassExpand: 0, _cornerRadius: 30,
    _menuXoffset: 0, _menuYoffset: 0,
    _getMenuMonitorGeometry: () => monitor,
    effect: { setShadowMaxRadius() {}, setResolution() {}, setCornerRadius() {},
      setAnimationScale() {}, setGlassGeometry(...rect) { geometry.push(rect); } },
  });
  return { manager, body, outer, geometry, monitor };
}

test('hover restyling does not expand the right edge while allocation is pending', () => {
  const { manager, body, outer, geometry } = fixture();
  manager._syncGeometry();
  const expected = [...geometry.at(-1)];
  for (let round = 0; round < 20; round++) {
    for (const [innerPending, outerPending] of [[true, false], [true, true], [false, true], [false, false]]) {
      body.needsAllocation = innerPending;
      outer.needsAllocation = outerPending;
      manager._syncGeometry();
      assert.deepEqual(geometry.at(-1), expected, `inner pending=${innerPending}, outer pending=${outerPending}`);
    }
  }
  assert.equal(geometry.length, 1, 'unchanged allocation does not repeatedly update the shader');
});

test('a real submenu expansion still changes the glass dimensions', () => {
  const { manager, body, geometry } = fixture();
  manager._syncGeometry();
  const before = geometry.at(-1);
  body.width += 60;
  body.height += 100;
  manager._syncGeometry();
  const after = geometry.at(-1);
  assert.equal(after[2], before[2] + 60);
  assert.equal(after[3], before[3] + 100);
});

test('menu opening animation and configured scale still scale the allocated body', () => {
  const { manager, body, outer, geometry } = fixture();
  outer.scale = 0.8;
  for (const scale of [0.2, 0.6, 1]) {
    body.scale = scale;
    body.needsAllocation = outer.needsAllocation = true;
    manager._syncGeometry();
    const [x, y, width, height] = geometry.at(-1);
    assert.equal(x, 100);
    assert.equal(y, 44);
    assert.ok(Math.abs(width - (body.width * scale * 0.8 + 40)) < 1e-9);
    assert.ok(Math.abs(height - (body.height * scale * 0.8 + 40)) < 1e-9);
  }
});
