const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const referenceDock = require('./fixtures/dock-geometry-reference.cjs');

function fixture(reference, monitor, attachment = { attached: false, radius: 0 }) {
  const writes = [];
  const actor = (name, props = {}) => ({ x: 0, y: 0, w: 600, h: 80, mapped: true, opacity: 255, children: [],
    get_size() { return [this.w, this.h]; }, get_transformed_position() { return [this.x, this.y]; },
    get_children() { return this.children; }, has_style_class_name: () => name === 'background',
    remove_transition: (...args) => writes.push([name, 'transition', ...args]),
    set_position(x, y) { writes.push([name, 'position', x, y]); this.x = x; this.y = y; },
    set_size(w, h) { writes.push([name, 'size', w, h]); this.w = w; this.h = h; },
    show() { this.visible = true; writes.push([name, 'show']); },
    hide() { this.visible = false; writes.push([name, 'hide']); }, ...props });
  const bindings = {
    Main: { layoutManager: { findIndexForActor: () => -1, primaryIndex: 0, monitors: [monitor], primaryMonitor: monitor } },
    setClipIfChanged: (_actor, ...args) => writes.push(['clip', ...args]),
  };
  const Class = reference ? referenceDock(bindings) : loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/dockManager.js'), bindings).DashManager;
  const manager = Object.create(Class.prototype);
  const target = actor('target'), background = actor('background'), ref = actor('reference');
  // The glass is an actor that also takes the shader setters, which are recorded.
  const glassActor = actor('glass', { visible: undefined });
  const glass = new Proxy(glassActor, { get: (t, key) => key in t ? t[key]
    : (...args) => writes.push(['glass', key, ...args]) });
  Object.assign(manager, { targetActor: target, glass,
    _settings: { get_boolean: key => key === 'dock-attach-to-edge' && attachment.attached,
      get_double: () => attachment.radius, get_int: () => 0 },
    _marginValue: 0, _glassExpand: 0, _logger: { log: text => writes.push(['log', text]) },
    _findReferenceActor: () => manager.reference ? ref : null });
  // The manager reads these when it binds its settings, which the fixture skips.
  if (!reference) manager._readEdgeSettings();
  return { manager, target, background, ref, sync() {
    writes.length = 0;
    manager._syncGeometry();
    // The original has no attachment; a floating dock only clears it.
    const compared = writes.filter(([owner, key]) => owner !== 'glass' || key !== 'setAttachedEdge');
    return { writes: structuredClone(compared), state: Object.fromEntries(Object.entries(manager).filter(([k]) =>
      k.startsWith('_last') || k.startsWith('_stable'))),
      visible: manager.glass.visible, opacity: manager.glass.opacity, backgroundOpacity: background.opacity };
  }, rect: () => writes.findLast(([owner, key]) => owner === 'glass' && key === 'setGlassGeometry')?.slice(2) };
}

test('dock geometry matches the original across edges, margins, movement and reference gaps', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (const monitor of [{ x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1920, y: -200, width: 1920, height: 1200 }, { x: 1920, y: 120, width: 2560, height: 1440 }]) {
    for (let edge = 0; edge < 4; edge++) {
      const current = fixture(false, monitor), original = fixture(true, monitor);
      for (let frame = 0; frame < 160; frame++) {
        const horizontal = edge < 2;
        const width = horizontal ? 400 + Math.floor(random() * 100) : 60 + Math.floor(random() * 15);
        const height = horizontal ? 60 + Math.floor(random() * 15) : 400 + Math.floor(random() * 100);
        const movement = frame % 4 ? 0 : random() * 160 - 80;
        const x = monitor.x + (horizontal ? 200 : edge === 2 ? 0 : monitor.width - width) + movement;
        const y = monitor.y + (horizontal ? edge === 0 ? 0 : monitor.height - height : 200) + movement;
        const gapX = random() * 60 - 20, gapY = random() * 60 - 20;
        for (const f of [current, original]) {
          Object.assign(f.target, { x, y, w: width, h: height, opacity: frame % 256, mapped: frame % 17 !== 0 });
          Object.assign(f.background, { x: x - 5, y: y - 5, w: width + 10, h: height + 10 });
          f.target.children = frame % 3 ? [f.background] : [];
          f.manager.reference = frame % 5 !== 0;
          Object.assign(f.ref, { x: x + gapX, y: y + gapY, w: width - 30, h: height - 30 });
          f.manager._marginValue = frame % 7 ? 12 : 0;
          f.manager._glassExpand = frame % 8;
          if (frame % 19 === 0) f.target.w = f.target.h = 4;
          if (frame % 23 === 0) f.background.x = NaN;
        }
        assert.deepEqual(current.sync(), original.sync(), `${monitor.x} edge ${edge} frame ${frame}`);
      }
    }
  }
});

test('a bottom dock growing sideways keeps its margin from the screen edge', () => {
  const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
  const f = fixture(false, monitor);
  f.manager._marginValue = 8;
  f.target.children = [f.background];
  const heights = [];
  // A centered dock 8px off the bottom edge whose background reaches the edge, widening as an icon comes in.
  for (let width = 400; width <= 480; width += 16) {
    Object.assign(f.target, { x: 960 - width / 2, y: 964, w: width, h: 108 });
    Object.assign(f.background, { x: 960 - width / 2, y: 964, w: width, h: 116 });
    f.sync();
    heights.push(f.manager._lastBgH);
  }
  assert.deepEqual(new Set(heights).size, 1, `glass heights ${heights}`);
});

test('an attached dock glass reaches its screen edge and draws back into it as the dock slides out', () => {
  const pad = 20;
  const bottom = fixture(false, { x: 0, y: 0, width: 1920, height: 1080 }, { attached: true, radius: 16 });
  bottom.manager._glassExpand = 6;
  bottom.target.children = [bottom.background];
  Object.assign(bottom.target, { x: 760, y: 990, w: 400, h: 82 });
  Object.assign(bottom.background, { x: 760, y: 994, w: 400, h: 70 });
  bottom.sync();
  // The expansion widens the free sides; the side on the edge ends at it, past the 16px gap Dash to Dock leaves.
  assert.deepEqual(bottom.rect(), [760 - pad - 6, 994 - pad - 6, 400 + 2 * (pad + 6), 1080 + pad - (994 - pad - 6)]);
  Object.assign(bottom.target, { y: 1030 });
  Object.assign(bottom.background, { y: 1034 });
  bottom.sync();
  assert.deepEqual(bottom.rect(), [760 - pad - 6, 1034 - pad - 6, 400 + 2 * (pad + 6), 1080 + pad - (1034 - pad - 6)]);

  const left = fixture(false, { x: 1920, y: 120, width: 1920, height: 1200 }, { attached: true, radius: 16 });
  left.target.children = [left.background];
  Object.assign(left.target, { x: 1920, y: 400, w: 82, h: 500 });
  Object.assign(left.background, { x: 1928, y: 410, w: 60, h: 480 });
  left.sync();
  assert.deepEqual(left.rect(), [-pad, 410 - 120 - pad, 8 + 60 + 2 * pad, 480 + 2 * pad]);
});
