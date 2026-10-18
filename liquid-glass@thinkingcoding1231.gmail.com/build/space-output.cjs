// tsc drops the blank lines between declarations. This puts one back between
// top-level functions and classes and between class members, and drops
// trailing whitespace, in place.
// Usage: node build/space-output.cjs <file or directory>...
const fs = require('node:fs');
const path = require('node:path');

function processFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  // Drop trailing whitespace per line.
  const original = text;
  text = text.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
  // Insert blank line before top-level function/class declarations.
  // Match at start of line or after whitespace/newline.
  text = text.replace(/(^[ \t]*)(function[ \t]+[a-zA-Z_$][\w$]*[ \t]*\(|class[ \t]+[a-zA-Z_$][\w$]*[ \t]*(?:{|extends))/gm, (m, indent) => '\n' + indent + m.trim());
  if (text !== original) fs.writeFileSync(file, text);
}

function walk(target) {
  if (fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) walk(path.join(target, name));
  } else if (target.endsWith('.js')) {
    processFile(target);
  }
}

for (const target of process.argv.slice(2)) walk(target);
/* Copyright (c) 2026 Dae Euhwa. MIT License. */
