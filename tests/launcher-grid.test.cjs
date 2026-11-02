const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { pinnedGrid } = loadModule(path.join(dist, 'launcherManager.js'), {});
const { softwareDesktopId } = loadModule(path.join(dist, 'launcherManager.js'), {});

test('a tile keeps room for the pin at each side of its icon', () => {
  for (let width = 300; width <= 1400; width += 7) {
    for (const icon of [32, 56, 96]) {
      const { columns, tile } = pinnedGrid(width, icon, 8, 20);
      assert.ok(columns >= 1);
      if (width >= icon + 40) assert.ok(tile >= icon + 40, `${width} wide, ${icon} icons: tile ${tile}`);
      assert.ok(tile * columns + 8 * (columns - 1) <= width);
    }
  }
});

test('the tiles use up the row, within a pixel for each', () => {
  const { columns, tile } = pinnedGrid(740, 56, 8, 20);
  assert.equal(columns, 7);
  assert.ok(740 - (tile * columns + 8 * (columns - 1)) < columns);
});

test('fewer columns when the icons are larger or the row narrower', () => {
  assert.ok(pinnedGrid(380, 56, 8, 20).columns < pinnedGrid(740, 56, 8, 20).columns);
  assert.ok(pinnedGrid(740, 96, 8, 20).columns < pinnedGrid(740, 56, 8, 20).columns);
  assert.equal(pinnedGrid(50, 96, 8, 20).columns, 1);
});

test('the desktop file of a software result comes from its id', () => {
  assert.equal(softwareDesktopId('system/flatpak/flathub/com.google.Chrome/stable'), 'com.google.Chrome.desktop');
  assert.equal(softwareDesktopId('system/package/ubuntu-universe/mkchromecast.desktop/*'), 'mkchromecast.desktop');
  assert.equal(softwareDesktopId('system/snap/snapcraft/firefox/stable'), null);
  assert.equal(softwareDesktopId('whatever'), null);
});
