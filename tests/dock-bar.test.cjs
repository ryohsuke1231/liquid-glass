const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { dockBarOrder, splitDockBar, dockBarCss, DOCK_BAR_CLASS } = loadModule(path.join(dist, 'dockBar.js'), {
  Main: {}, St: {}, ExtensionState: { ACTIVE: 1 }, AdaptiveTextColor: class { },
});

const button = (role, side, index) => ({ role, side, index });

test('buttons the order does not list yet go next to the apps, on their side of the top bar and in its order', () => {
  const order = dockBarOrder(['activities', 'apps', 'quickSettings', 'dateMenu'], [
    button('quickSettings', 'right', 3), button('vitals', 'right', 1), button('keyboard', 'right', 2),
    button('activities', 'left', 0), button('appMenu', 'left', 1), button('dateMenu', 'right', 0),
  ]);
  assert.deepEqual(order, ['activities', 'appMenu', 'apps', 'vitals', 'keyboard', 'quickSettings', 'dateMenu']);
});

test('an order without the apps gets them at its end, and tray icons are never written into it', () => {
  const order = dockBarOrder(['dateMenu'], [button('appindicator-:1.42', 'right', 0), button('dateMenu', 'right', 1)]);
  assert.deepEqual(order, ['dateMenu', 'apps']);
});

test('the order splits at the apps, with unlisted tray icons first on the right', () => {
  const entries = ['quickSettings', 'appindicator-:1.42', 'dateMenu', 'activities'].map(role => ({ role }));
  const { left, right } = splitDockBar(['dateMenu', 'activities', 'apps', 'quickSettings'], entries);
  assert.deepEqual(left.map(entry => entry.role), ['dateMenu', 'activities']);
  assert.deepEqual(right.map(entry => entry.role), ['appindicator-:1.42', 'quickSettings']);
});

test('the generated rules give a button its borders inside its padding and the theme\'s text color', () => {
  const css = dockBarCss(10, 18, '36, 31, 49');
  const rule = selector => css.split('}\n').find(block => block.startsWith(`${selector} {`));
  const button = rule(`.${DOCK_BAR_CLASS} .panel-button`);
  assert.match(button, /color: rgb\(36, 31, 49\);/);
  assert.match(button, /border: 10px solid transparent;/);
  assert.match(button, /-natural-hpadding: 20px;/);
  assert.match(button, /-minimum-hpadding: 15px;/);
  // The clock's borders are on its label, so its highlight is the label's.
  assert.match(rule(`.${DOCK_BAR_CLASS} .panel-button.clock-display`), /border: 0px solid transparent;/);
  assert.match(rule(`.${DOCK_BAR_CLASS} .panel-button.clock-display .clock`), /border: 10px solid transparent;/);
  assert.match(css, /screen-sharing-indicator \{\n  border: 18px solid transparent;/);
});
