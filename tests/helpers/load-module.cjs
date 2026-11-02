const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../liquid-glass@thinkingcoding1231.gmail.com/node_modules/typescript');

// Execute the built module graph with explicit GNOME adapters. Relative imports
// use real implementations; bindings replace only dependencies supplied by a test.
// Each fixture gets a fresh cache, so module-owned settings never leak between tests.
// shellVersion.ts reads the shell version when it loads; tests get GNOME 50
// unless they bind their own Config. Modules register their GObject classes when
// they load, and actors.ts keeps GObject's toString, so the classes they extend
// are always there; a test's own GObject, Clutter, St or Shell adds to them.
const LOAD_TIME = {
  Config: { PACKAGE_VERSION: '50.0' },
  GObject: { Object: { prototype: { toString: () => '' } }, registerClass: (...args) => args.at(-1) },
  Clutter: { Actor: class {}, Clone: class {}, Effect: class {}, OffscreenEffect: class {} },
  St: { Widget: class {} },
  Shell: {},
};

function createModuleLoader(bindings = {}) {
  const merged = { ...LOAD_TIME, ...bindings };
  for (const name of ['GObject', 'Clutter', 'St', 'Shell'])
    if (bindings[name]) merged[name] = { ...LOAD_TIME[name], ...bindings[name] };
  bindings = merged;
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
    const imports = new Map();
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node)) continue;
      const names = new Map();
      const clause = node.importClause;
      if (clause?.name) names.set('default', clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.set('*', clause.namedBindings.name.text);
        else for (const item of clause.namedBindings.elements)
          names.set(item.propertyName?.text ?? item.name.text, item.name.text);
      }
      imports.set(node.moduleSpecifier.text, names);
    }
    const module = { exports: {} };
    cache.set(file, module);
    const requireModule = specifier => new Proxy({}, {
      get(_target, name) {
        const names = imports.get(specifier);
        const local = names?.get(name);
        if (local && Object.hasOwn(bindings, local)) return bindings[local];
        const namespace = names?.get('*');
        if (namespace && Object.hasOwn(bindings, namespace)) return bindings[namespace][name];
        if (specifier.startsWith('.')) return load(path.resolve(path.dirname(file), specifier))[name];
        throw new Error(`Missing test adapter for ${specifier}:${String(name)} in ${file}`);
      },
    });
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: false },
    });
    const execute = new Function(...Object.keys(bindings),
      `return function(require, exports, module) {\n${outputText}\n};`)(...Object.values(bindings));
    execute(requireModule, module.exports, module);
    return module.exports;
  }
  return load;
}

function loadModule(filename, bindings = {}) {
  return createModuleLoader(bindings)(filename);
}

module.exports = { loadModule, createModuleLoader };
