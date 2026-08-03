#!/usr/bin/env node
'use strict';

/**
 * TWO-PRODUCT SEPARATION GATE — runs in CI (`npm test`) and is safe to run locally.
 *
 * PILOT carries two loan products and they are two separate systems (owner-directed
 * 2026-08-02, CLAUDE.md → "TWO PRODUCTS, TWO SYSTEMS"):
 *
 *   • RTL — Residential Transition Loans (bridge / ground-up / fix & flip). Everything
 *     built before 2026-08-02. The main product.
 *   • LT  — Long-Term Loans. Brand new, starts at zero, side build, not live.
 *     Lives ONLY in src/longterm/**, /api/lt/*, lt_* tables, db/NNN_lt_*.sql,
 *     scripts/test-lt-*.js.
 *
 * The owner's rule: nothing crosses between them without explicit WRITTEN
 * authorization, recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md. A rule that only
 * lives in prose gets forgotten at 2am by the next session; this gate is the rule
 * with teeth. It fails the build on:
 *
 *   1. an LT module importing RTL code                       (src/longterm/** → elsewhere)
 *   2. RTL code importing LT code                            (elsewhere → src/longterm/**)
 *      — except the ONE permitted seam: src/server.js mounting the LT router
 *   3. an lt_* table with a foreign key to an RTL table (or an RTL table pointing at lt_*)
 *   4. an LT-named column added to an RTL table              (ALTER TABLE applications ADD lt_…)
 *   5. one migration file touching BOTH products
 *   6. a trigger on an LT table running an RTL function, or the reverse
 *   7. the rule documents themselves going missing
 *
 * Everything is checked from the filesystem — no database, no network, no deps.
 *
 * DO NOT weaken, baseline, or "temporarily" disable this gate. If it blocks you the
 * answer is to fix the crossing, or to get the owner's written authorization and add
 * it to the ledger — never to edit this file.
 *
 *   node scripts/check-product-separation.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');          // yscap-repo-root_8/
const GIT_ROOT = path.join(ROOT, '..');           // repository top level
const LT_SRC = path.join(ROOT, 'src', 'longterm');
const DB_DIR = path.join(ROOT, 'db');
const LEDGER = path.join(ROOT, 'docs', 'LONG-TERM-AUTHORIZED-COPIES.md');

// The single permitted back-end seam: server.js must be able to mount the LT router.
const MOUNT_SEAM = 'src/server.js';

const errors = [];
const notes = [];
const fail = (where, msg, how) => errors.push({ where, msg, how });

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const isLtName = (s) => /^"?lt_/i.test(String(s || ''));

// ---------------------------------------------------------------------------
// The ledger — the owner's written authorizations. Anything not listed here is a
// violation, which is exactly what "written authorization" is supposed to mean.
// ---------------------------------------------------------------------------
function readLedger() {
  const allow = { import: new Set(), 'rtl-import': new Set(), 'sql-ref': new Set() };
  if (!fs.existsSync(LEDGER)) {
    fail(rel(LEDGER), 'The crossing ledger is missing.',
      'Restore docs/LONG-TERM-AUTHORIZED-COPIES.md — it is the only record of what the owner authorized to cross between the two products.');
    return allow;
  }
  const src = fs.readFileSync(LEDGER, 'utf8');
  const blocks = src.match(/```authorized\n([\s\S]*?)```/g) || [];
  if (!blocks.length) {
    fail(rel(LEDGER), 'The ledger has no ```authorized``` block.',
      'Keep the fenced ```authorized block in the file (it may be empty) — the gate reads it.');
    return allow;
  }
  for (const block of blocks) {
    const body = block.replace(/```authorized\n/, '').replace(/```$/, '');
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(import|rtl-import|sql-ref)\s+(\S+)\s*$/);
      if (!m) {
        fail(rel(LEDGER), `Unreadable ledger line: "${line}"`,
          'Each line must be "import <path>", "rtl-import <path>" or "sql-ref <table>" — see the entry-kinds table in the ledger.');
        continue;
      }
      allow[m[1]].add(m[2].replace(/^\.\//, ''));
    }
  }
  const n = allow.import.size + allow['rtl-import'].size + allow['sql-ref'].size;
  notes.push(n === 0
    ? 'ledger: no crossings authorized (nothing from RTL may be re-used by Long-Term, or the reverse)'
    : `ledger: ${n} crossing(s) authorized in writing`);
  return allow;
}

// ---------------------------------------------------------------------------
// Tiny scanners. Comments are stripped first so a module named in a comment — this
// repo is full of long explanatory comments — is never mistaken for a real import.
// ---------------------------------------------------------------------------
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^-])--[^\n]*/g, '$1 ');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// require('x') / import … from 'x' / import 'x' / await import('x')
function importsOf(src) {
  const code = stripJsComments(src);
  const found = [];
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) { let m; while ((m = re.exec(code))) found.push(m[1]); }
  return found;
}

// Resolve a relative specifier the way node would, enough to know WHERE it points.
function resolveFrom(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const tries = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.jsx', path.join(base, 'index.js')];
  for (const t of tries) { if (fs.existsSync(t) && fs.statSync(t).isFile()) return t; }
  return base; // unresolved (not built yet) — still tells us which side it points at
}

const insideLt = (abs) => {
  const r = path.relative(LT_SRC, abs);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};

// ---------------------------------------------------------------------------
// 1 + 2. Import isolation, both directions.
// ---------------------------------------------------------------------------
function checkImports(allow) {
  // 1. Long-Term may not reach into RTL.
  const ltFiles = walk(LT_SRC);
  for (const f of ltFiles) {
    for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // npm package / node builtin — shared plumbing, fine
      const abs = resolveFrom(f, spec);
      if (insideLt(abs)) continue;                                     // stays inside Long-Term — fine
      const target = rel(abs);
      if (allow.import.has(target)) continue;                          // authorized in writing
      fail(rel(f), `Long-Term code imports RTL code: "${spec}" → ${target}`,
        `Long-Term starts at zero. Either build what you need inside src/longterm/, or get the owner's WRITTEN authorization for this exact module and add "import ${target}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
    }
  }
  notes.push(`long-term modules scanned: ${ltFiles.length}${ltFiles.length ? '' : ' (none built yet)'}`);

  // 2. RTL may not reach into Long-Term — except server.js mounting the router.
  const srcFiles = walk(path.join(ROOT, 'src')).filter((f) => !insideLt(f));
  for (const f of srcFiles) {
    const from = rel(f);
    for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      if (!insideLt(resolveFrom(f, spec))) continue;
      if (from === MOUNT_SEAM) continue;                               // the one permitted seam
      if (allow['rtl-import'].has(from)) continue;                     // authorized in writing
      fail(from, `RTL code imports Long-Term code: "${spec}"`,
        `Only ${MOUNT_SEAM} may reach into src/longterm/ (to mount the router). For anything else, get the owner's WRITTEN authorization and add "rtl-import ${from}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
    }
  }
}

// ---------------------------------------------------------------------------
// SQL statement helpers.
// ---------------------------------------------------------------------------
function tableBody(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') { depth--; if (depth === 0) return sql.slice(openIdx + 1, i); }
  }
  return sql.slice(openIdx + 1);
}

// ---------------------------------------------------------------------------
// 3-6. Schema isolation: foreign keys, columns, mixed migrations, triggers.
// ---------------------------------------------------------------------------
function checkSql(allow) {
  if (!fs.existsSync(DB_DIR)) return;
  const files = fs.readdirSync(DB_DIR).filter((f) => f.endsWith('.sql')).sort();
  let ltFileCount = 0;

  for (const name of files) {
    const where = 'db/' + name;
    const sql = stripSqlComments(fs.readFileSync(path.join(DB_DIR, name), 'utf8'));

    // ---- which tables does this file define or change, per side? ----
    const ltTouched = new Set();
    const rtlTouched = new Set();
    const noteTable = (t) => {
      if (!t) return;
      const clean = t.replace(/^public\./i, '').replace(/"/g, '');
      (isLtName(clean) ? ltTouched : rtlTouched).add(clean);
    };

    let m;
    const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi;
    while ((m = CREATE_TABLE.exec(sql))) {
      noteTable(m[1]);
      // 3. foreign keys may never cross between the two products.
      const open = sql.indexOf('(', CREATE_TABLE.lastIndex);
      if (open === -1) continue;
      const body = tableBody(sql, open);
      const table = m[1].replace(/"/g, '');
      const REFS = /\bREFERENCES\s+("?[\w.]+"?)/gi;
      let r;
      while ((r = REFS.exec(body))) {
        const target = r[1].replace(/^public\./i, '').replace(/"/g, '');
        if (isLtName(table) && !isLtName(target)) {
          if (allow['sql-ref'].has(target)) continue;
          fail(where, `Long-Term table "${table}" has a foreign key to the RTL table "${target}".`,
            `A Long-Term table may only reference other lt_* tables. If Long-Term genuinely must hang off an RTL table, get the owner's WRITTEN authorization and add "sql-ref ${target}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
        }
        if (!isLtName(table) && isLtName(target)) {
          fail(where, `RTL table "${table}" has a foreign key to the Long-Term table "${target}".`,
            'RTL must never depend on Long-Term. Long-Term is a side build that is not live — an RTL table pointing at it welds the two products together.');
        }
      }
    }

    const ALTER = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[\w.]+"?)([\s\S]*?);/gi;
    while ((m = ALTER.exec(sql))) {
      const table = m[1].replace(/^public\./i, '').replace(/"/g, '');
      noteTable(table);
      const rest = m[2] || '';
      // 4. an LT-named column may never be bolted onto an RTL table.
      const ADD_COL = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/gi;
      let c;
      while ((c = ADD_COL.exec(rest))) {
        const col = c[1].replace(/"/g, '');
        if (!isLtName(table) && /^(lt_|long_?term)/i.test(col)) {
          fail(where, `Column "${col}" is being added to the RTL table "${table}".`,
            'Long-Term does not get columns on RTL tables — it gets its own lt_* tables. The owner: "don\'t add any columns don\'t add any mapping unless we specifically ask you to."');
        }
      }
      // 3 (continued): a cross-product foreign key added after the fact.
      const REFS = /\bREFERENCES\s+("?[\w.]+"?)/gi;
      let r;
      while ((r = REFS.exec(rest))) {
        const target = r[1].replace(/^public\./i, '').replace(/"/g, '');
        if (isLtName(table) && !isLtName(target) && !allow['sql-ref'].has(target)) {
          fail(where, `Long-Term table "${table}" gains a foreign key to the RTL table "${target}".`,
            `Authorize it in writing and add "sql-ref ${target}" to docs/LONG-TERM-AUTHORIZED-COPIES.md, or keep the reference inside lt_*.`);
        }
        if (!isLtName(table) && isLtName(target)) {
          fail(where, `RTL table "${table}" gains a foreign key to the Long-Term table "${target}".`,
            'RTL must never depend on Long-Term.');
        }
      }
    }

    const TRIGGER = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("?[\w]+"?)([\s\S]*?);/gi;
    while ((m = TRIGGER.exec(sql))) {
      const stmt = m[2] || '';
      const on = (stmt.match(/\bON\s+("?[\w.]+"?)/i) || [])[1];
      const fn = (stmt.match(/\bEXECUTE\s+(?:PROCEDURE|FUNCTION)\s+("?[\w.]+"?)/i) || [])[1];
      if (!on) continue;
      const onTable = on.replace(/^public\./i, '').replace(/"/g, '');
      noteTable(onTable);
      if (!fn) continue;
      const fnName = fn.replace(/^public\./i, '').replace(/"/g, '');
      // 6. a trigger may not carry one product's logic onto the other's table.
      const definedHere = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fnName}"?\\b`, 'i').test(sql);
      if (isLtName(onTable) && !isLtName(fnName) && !definedHere) {
        fail(where, `Trigger "${m[1]}" runs the RTL function ${fnName}() on the Long-Term table "${onTable}".`,
          'A Long-Term table may only be driven by Long-Term logic (an lt_* function, or one defined in the same Long-Term migration). RTL triggers reopen RTL pricing, RTL conditions and RTL sync — none of that exists on the Long-Term side.');
      }
      if (!isLtName(onTable) && isLtName(fnName)) {
        fail(where, `Trigger "${m[1]}" runs the Long-Term function ${fnName}() on the RTL table "${onTable}".`,
          'Long-Term logic must never fire on an RTL table. RTL is the live product.');
      }
    }

    // 5. one migration file may not touch both products.
    if (ltTouched.size) ltFileCount++;
    if (ltTouched.size && rtlTouched.size) {
      fail(where, `This migration touches BOTH products — Long-Term (${[...ltTouched].join(', ')}) and RTL (${[...rtlTouched].join(', ')}).`,
        'Split it into two migrations: a Long-Term one that only touches lt_* tables, and (only if the owner asked for it) a separate RTL one. A mixed migration is how the two products quietly grow into one.');
    }
  }
  notes.push(`migrations scanned: ${files.length} (${ltFileCount} long-term)`);
}

// ---------------------------------------------------------------------------
// 7. The rules themselves must stay in place, in every home they were given.
// ---------------------------------------------------------------------------
function checkRuleDocsPresent() {
  const required = [
    [path.join(ROOT, 'CLAUDE.md'), /TWO PRODUCTS, TWO SYSTEMS/, 'CLAUDE.md must keep the "TWO PRODUCTS, TWO SYSTEMS" section — it is the master copy of the rule.'],
    [path.join(GIT_ROOT, 'AGENTS.md'), /TWO products/i, 'AGENTS.md (git root) must keep the two-product rule so every AI agent reads it before working.'],
    [path.join(GIT_ROOT, '.github', 'PRODUCT-SEPARATION.md'), /TWO products/i, '.github/PRODUCT-SEPARATION.md is the GitHub-side copy of the rule.'],
    [path.join(GIT_ROOT, '.github', 'pull_request_template.md'), /Which product is this for/i, 'The PR template must keep asking which product a change is for.'],
    [path.join(ROOT, 'docs', 'LONG-TERM-LOANS-SEPARATION-CHARTER.md'), /./, 'The charter explains how the two products stay apart.'],
    [LEDGER, /```authorized/, 'The ledger records every crossing the owner authorized in writing.'],
  ];
  for (const [file, re, why] of required) {
    if (!fs.existsSync(file)) {
      fail(path.relative(GIT_ROOT, file), 'Rule document is missing.', why);
      continue;
    }
    if (!re.test(fs.readFileSync(file, 'utf8'))) {
      fail(path.relative(GIT_ROOT, file), 'Rule document no longer states the rule.', why);
    }
  }
}

// ---------------------------------------------------------------------------
const allow = readLedger();
checkImports(allow);
checkSql(allow);
checkRuleDocsPresent();

console.log('Two-product separation gate (RTL vs Long-Term)');
for (const n of notes) console.log('  · ' + n);

if (errors.length) {
  console.error(`\n  ✗ ${errors.length} separation violation(s) — the two products are growing into each other:\n`);
  for (const e of errors) {
    console.error(`  ✗ ${e.where}\n      ${e.msg}\n      → ${e.how}\n`);
  }
  console.error('  The rule (owner-directed 2026-08-02): RTL and Long-Term are two separate systems, and');
  console.error('  nothing crosses without the owner\'s explicit WRITTEN authorization, recorded in');
  console.error('  docs/LONG-TERM-AUTHORIZED-COPIES.md. Fix the crossing or get it authorized — never edit this gate.');
  process.exit(1);
}

console.log('  ✓ clean — the two products are still fully separate.');
