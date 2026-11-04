/**
 * Static scope checker: catches the "let/const declared inside a block is
 * referenced outside that block" bug class (e.g. a `const driveCar` inside
 * `if (started) { ... }` read later by the audio block -> ReferenceError at
 * runtime, which syntax checks and the minifier both miss).
 *
 * Resolution rule (ES modules, strict mode):
 *   a reference is legal when some ENCLOSING scope declares the name.
 *   If not, but the same function/module declares that name in a non-
 *   enclosing (sibling/nested) block, it is a genuine out-of-scope use
 *   (ReferenceError) and gets flagged. `var` is function-scoped (hoisted)
 *   and never flagged.
 *
 *   node scripts/scope-check.mjs [files...]   (default: every JS file under src/)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

const SRC = new Set(['function', 'program']);

function* collect(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (e.endsWith('.js') || e.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const inside = (node, p) => node.start <= p && p <= node.end;

function checkFile(file, src) {
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  const issues = [];
  const scopes = []; // { node, kind: 'function'|'program'|'block', names:Set }
  const decls = []; // { name, scope, fnScope, hoisted }

  // Innermost scope = the enclosing one with the largest `start` (deepest),
  // independent of array order.
  const innermost = (p, kinds) => {
    let best = null;
    for (const s of scopes) {
      if (kinds.has(s.kind) && inside(s.node, p) && (!best || s.node.start > best.node.start))
        best = s;
    }
    return best;
  };
  const fnOf = (p) => innermost(p, SRC);
  const blockOf = (p) => innermost(p, new Set(['block']));

  function record(name, scope, fnScope, hoisted) {
    scope.names.add(name);
    decls.push({ name, scope, fnScope, hoisted });
  }

  // pass 1a: push every scope (functions + blocks + program)
  walk.full(ast, (node) => {
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      scopes.push({ node, kind: 'function', names: new Set() });
    } else if (node.type === 'BlockStatement') {
      scopes.push({ node, kind: 'block', names: new Set() });
    }
  });
  const program = { node: ast, kind: 'program', names: new Set() };
  scopes.push(program);

  // pass 1b: record declarations
  const recordParams = (params, fs) => {
    for (const p of params)
      (function flat(n) {
        if (n.type === 'Identifier') record(n.name, fs, fs, false);
        else if (n.type === 'AssignmentPattern') flat(n.left);
        else if (n.type === 'ObjectPattern' || n.type === 'ArrayPattern')
          n.properties.forEach((pr) => (pr.value ? flat(pr.value) : pr.key && flat(pr.key)));
        else if (n.type === 'RestElement') flat(n.argument);
      })(p);
  };
  walk.full(ast, (node) => {
    const fs = fnOf(node.start); // innermost function scope containing the decl
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const self = scopes.find((s) => s.node === node);
      if (node.type === 'FunctionDeclaration' && node.id) {
        // bound in the ENCLOSING scope (block-scoped in ESM), visible inside via recursion
        const outer = blockOf(node.start) || fs;
        record(node.id.name, outer, fs, false);
      } else if (node.id) {
        // named function expression: name visible only inside its own body
        record(node.id.name, self, fs, false);
      }
      recordParams(node.params, self);
    } else if (node.type === 'VariableDeclaration') {
      if (!fs) return;
      const scope = node.kind === 'var' ? fs : blockOf(node.start) || fs;
      for (const d of node.declarations)
        (function names(n) {
          if (n.type === 'Identifier') record(n.name, scope, fs, node.kind === 'var');
          else if (n.type === 'ObjectPattern' || n.type === 'ArrayPattern')
            n.properties.forEach((pr) => (pr.value ? names(pr.value) : pr.key && names(pr.key)));
          else if (n.type === 'RestElement') names(n.argument);
          else if (n.type === 'AssignmentPattern') names(n.left);
        })(d.id);
    } else if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) record(s.local.name, program, program, false);
    } else if (node.type === 'CatchClause' && node.param) {
      const cbody = blockOf(node.body.start) || fs;
      if (cbody)
        (function names(n) {
          if (n.type === 'Identifier') record(n.name, cbody, fs, false);
          else if (n.type === 'ObjectPattern' || n.type === 'ArrayPattern')
            n.properties.forEach((pr) => (pr.value ? names(pr.value) : pr.key && names(pr.key)));
          else if (n.type === 'RestElement') names(n.argument);
        })(node.param);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      const outer = blockOf(node.start) || fs || program;
      record(node.id.name, outer, fs || program, false);
    }
  });

  // pass 2: references
  walk.full(ast, (node) => {
    if (node.type !== 'Identifier') return;
    const name = node.name;
    // legal: some enclosing scope declares it (declaration ids resolve here too)
    for (const s of scopes) {
      if (inside(s.node, node.start) && s.names.has(name)) return;
    }
    // not in any enclosing scope: same function declaring it in a sibling
    // block = out-of-scope use (ReferenceError), unless hoisted (var)
    const F = fnOf(node.start);
    if (!F) return;
    for (const d of decls) {
      if (d.name === name && d.fnScope === F && !d.hoisted) {
        const line = src.slice(0, node.start).split('\n').length;
        issues.push(`${name} (line ${line})`);
        return;
      }
    }
  });

  return issues;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : [...collect('src')].sort();

let bad = 0;
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  let issues;
  try {
    issues = checkFile(f, src);
  } catch (e) {
    console.log(`PARSE FAIL ${f}: ${e.message}`);
    bad++;
    continue;
  }
  const seen = new Set();
  for (const i of issues) {
    const nm = i.split(' ')[0];
    if (seen.has(nm)) continue;
    seen.add(nm);
    console.log(`SCOPE BUG ${f}: "${i}" is declared in a non-enclosing block`);
    bad++;
  }
}
console.log(bad === 0 ? 'scope-check: clean' : `scope-check: ${bad} issue(s)`);
process.exit(bad === 0 ? 0 : 1);
