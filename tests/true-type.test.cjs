const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { TrueTypeFont, traceGlyph } = loadModule(path.join(dist, 'desktop/fonts.js'), {});
const fonts = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/fonts');
const load = name => new TrueTypeFont(new Uint8Array(fs.readFileSync(path.join(fonts, name))));

// [font, char, advance, xMin, yMin, xMax, yMax, contours], as fontTools reads them.
const EXPECTED = [
  ['Antonio-Bold.ttf', '0', 1010, 103, -21, 899, 1781, 2],
  ['Antonio-Bold.ttf', '4', 951, 90, 0, 899, 1760, 2],
  ['BarlowCondensed-Bold.ttf', '4', 484, 14, 0, 470, 700, 1],
  ['BarlowCondensed-Bold.ttf', ':', 275, 60, 1, 218, 487, 2],
  ['SairaExtraCondensed-Regular.ttf', '0', 397, 43, -8, 354, 696, 2],
  ['SairaExtraCondensed-Regular.ttf', ':', 178, 51, 0, 127, 510, 2],
];

test('glyphs come out with the advances, bounds and contours the font has', () => {
  for (const [file, ch, advance, xMin, yMin, xMax, yMax, contours] of EXPECTED) {
    const g = load(file).glyph(ch.codePointAt(0));
    assert.deepEqual([g.advance, g.xMin, g.yMin, g.xMax, g.yMax, g.contours.length],
      [advance, xMin, yMin, xMax, yMax, contours], `${file} ${ch}`);
  }
  const antonio = load('Antonio-Bold.ttf');
  assert.deepEqual([antonio.unitsPerEm, antonio.ascender, antonio.descender], [2048, 2365, -285]);
});

test('a traced glyph stays inside its bounds and closes every contour', () => {
  for (const [file, ch] of EXPECTED) {
    const g = load(file).glyph(ch.codePointAt(0));
    const ops = [];
    const cr = {
      moveTo: (x, y) => ops.push(['M', x, y]), lineTo: (x, y) => ops.push(['L', x, y]),
      curveTo: (...a) => ops.push(['C', ...a]), closePath: () => ops.push(['Z']),
    };
    traceGlyph(cr, g, 0, 0, 1);
    assert.equal(ops.filter(o => o[0] === 'Z').length, g.contours.length, `${file} ${ch}`);
    for (const op of ops) {
      for (let i = 1; i < op.length; i += 2) {
        assert.ok(op[i] >= g.xMin - 1 && op[i] <= g.xMax + 1, `${file} ${ch} x ${op[i]}`);
        assert.ok(-op[i + 1] >= g.yMin - 1 && -op[i + 1] <= g.yMax + 1, `${file} ${ch} y ${op[i + 1]}`);
      }
    }
  }
});
