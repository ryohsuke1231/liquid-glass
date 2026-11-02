const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { evaluate, formatNumber } = loadModule(path.join(dist, 'launcherManager.js'), {});

test('arithmetic is worked out, with or without a trailing equals sign', () => {
  assert.equal(evaluate('3*8='), 24);
  assert.equal(evaluate('3*8'), 24);
  assert.equal(evaluate('1-5'), -4);
  assert.equal(evaluate('2 + 3 * 4'), 14);
  assert.equal(evaluate('(2 + 3) * 4'), 20);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), 4);
  assert.equal(evaluate('7 % 3'), 1);
  assert.equal(evaluate('6 ÷ 4'), 1.5);
  assert.equal(evaluate('3 × 8'), 24);
  assert.equal(evaluate('.5 + .25'), 0.75);
});

test('text that is not a calculation gives nothing', () => {
  for (const text of ['', '5', '-5', 'settings', '3*', '(1+2', '1+2)', '2(3)', '1/0', 'alert(1)', '3*8==', '1..2+1'])
    assert.equal(evaluate(text), null, text);
});

test('results are shown without floating point noise', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(24), '24');
  assert.equal(formatNumber(1 / 3), '0.333333333333');
});
