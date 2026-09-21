const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../liquid-glass@thinkingcoding1231.gmail.com/node_modules/typescript');
const extension = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com');

test('compiled modules have resolvable relative imports and no runtime dependency cycles', () => {
  const root = path.join(extension, 'dist');
  const graph = new Map();
  for (const name of fs.readdirSync(root, { recursive: true }).filter(name => name.endsWith('.js'))) {
    const file = path.join(root, name);
    const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const dependencies = [];
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      const specifier = node.moduleSpecifier?.text;
      if (!specifier?.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(fs.existsSync(target), `${name}: missing ${specifier}`);
      dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const visited = new Set();
  function visit(file, stack = []) {
    assert.equal(stack.includes(file), false, `runtime cycle: ${[...stack, file].map(p => path.relative(root, p)).join(' -> ')}`);
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...stack, file]);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
});

test('internal consumers use owning modules, not the compatibility utils barrel', () => {
  const root = path.join(extension, 'src');
  for (const name of fs.readdirSync(root, { recursive: true }).filter(name => name.endsWith('.ts'))) {
    const ast = ts.createSourceFile(name, fs.readFileSync(path.join(root, name), 'utf8'), ts.ScriptTarget.ES2022, true);
    for (const node of ast.statements) if (ts.isImportDeclaration(node))
      assert.doesNotMatch(node.moduleSpecifier.text, /(^|\/)utils\.js$/, name);
  }
});
