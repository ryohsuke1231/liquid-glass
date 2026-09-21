const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

function fixture() {
  class Widget {
    constructor(classes = '', background = [0, 0, 0, 0]) {
      this.classes = classes.split(' '); this.background = background;
      this.visible = true; this.style = 'color: white;'; this.children = [];
      this.handlers = new Map(); this.states = new Set(); this.nextId = 1;
    }
    add(child) { child.parent = this; this.children.push(child); return child; }
    get_children() { return this.children; }
    get_parent() { return this.parent ?? null; }
    has_style_class_name(name) { return this.classes.includes(name); }
    get_style_class_name() { return this.classes.join(' '); }
    has_style_pseudo_class(name) { return this.states.has(name); }
    get_style() { return this.style; }
    set_style(style) { this.style = style; }
    ensure_style() {}
    get_theme_node() { return { get_background_color: () => {
      const [red, green, blue, alpha] = this.style?.includes('background-color: transparent') ? [0,0,0,0] : this.background;
      return { red, green, blue, alpha };
    } }; }
    connect(name, callback) { const id = this.nextId++; this.handlers.set(id, { name, callback }); return id; }
    disconnect(id) { assert.ok(this.handlers.delete(id)); }
  }
  const timers = new Map(); let next = 1, open = true;
  const GLib = { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    timeout_add(_priority, _interval, callback) { const id = next++; timers.set(id, callback); return id; },
    source_remove(id) { assert.ok(timers.delete(id)); } };
  const { ToggleStyles } = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/quickSettings/toggleStyles.js'), { St: { Widget }, GLib });
  const styles = new ToggleStyles({ log() {} }, () => open);
  const root = new Widget('menu', [36, 36, 36, 255]);
  const tick = () => { for (const [id, callback] of [...timers]) if (!callback()) timers.delete(id); };
  return { Widget, root, styles, timers, tick, close() { open = false; } };
}

test('split toggles form one glass region and their MacTahoe icon controls the base colour', () => {
  const { Widget, root, styles, tick } = fixture();
  const pod = root.add(new Widget('quick-toggle-has-menu', [255, 255, 255, 38]));
  const primary = pod.add(new Widget()).add(new Widget('quick-toggle'));
  const icon = primary.add(new Widget('quick-toggle-icon', [255, 255, 255, 255]));
  assert.deepEqual(styles.sync(root), [pod]);
  assert.deepEqual(styles.colorFor(pod).baseColor, [1, 1, 1]);
  assert.match(primary.get_style(), /background-color: transparent/);
  styles.start();
  icon.background = [255, 255, 255, 38]; icon.states.add('checked');
  tick();
  assert.ok(styles.colorFor(pod).baseColor[0] < 0.5);
  styles.clear();
  assert.equal(primary.get_style(), 'color: white;');
  assert.equal(icon.get_style(), 'color: white;');
});

test('sampling owns one timer and stops when the menu closes or styles are cleared', () => {
  const { Widget, root, styles, timers, tick, close } = fixture();
  root.add(new Widget('quick-toggle', [100, 100, 100, 255]));
  styles.sync(root); styles.start(); styles.start();
  assert.equal(timers.size, 1);
  close(); tick();
  assert.equal(timers.size, 0);
  styles.start(); styles.clear(); styles.clear();
  assert.equal(timers.size, 0);
});

test('a slider is released when its new theme stops painting a background', () => {
  const { Widget, root, styles } = fixture();
  const slider = root.add(new Widget('quick-slider', [255, 255, 255, 38]));
  assert.deepEqual(styles.sync(root), [slider]);
  slider.background = [0, 0, 0, 0];
  styles.start();
  assert.equal(styles.colorFor(slider), undefined);
  assert.equal(slider.get_style(), 'color: white;');
  assert.deepEqual(styles.sync(root), []);
  assert.equal(slider.handlers.size, 0);
  styles.clear();
});

test('repeated adoption and cleanup do not accumulate pod destroy handlers', () => {
  const { Widget, root, styles } = fixture();
  const pod = root.add(new Widget('quick-toggle', [100, 100, 100, 255]));
  for (let i = 0; i < 100; i++) {
    styles.sync(root);
    assert.equal(pod.handlers.size, 1);
    styles.clear();
    assert.equal(pod.handlers.size, 0);
    assert.equal(pod.get_style(), 'color: white;');
  }
});
