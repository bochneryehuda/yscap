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
 *     Back end lives ONLY in src/longterm/**; front end ONLY in
 *     app-v2/src/longterm/**; HTTP ONLY under /api/lt/*;
 *     tables ONLY lt_*; migrations db/NNN_lt_*.sql; tests scripts/test-lt-*.js.
 *
 * The owner's rule: nothing crosses between them without explicit WRITTEN
 * authorization, recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md. A rule that only
 * lives in prose gets forgotten at 2am by the next session; this gate is the rule
 * with teeth. It fails the build on:
 *
 *   1. an LT module importing RTL code (back end or front end)
 *   2. RTL code importing LT code — except the ONE seam: src/server.js mounting the
 *      LT router, and scripts/test-lt-*.js which exist to test it
 *   3. an lt_* table with a foreign key to an RTL table (or an RTL table pointing at lt_*)
 *   4. an LT-named column added to an RTL table (ALTER TABLE applications ADD lt_…)
 *   5. one migration file touching BOTH products
 *   6. a trigger carrying one product's logic onto the other's table, and an LT
 *      migration redefining an RTL function
 *   7. LT code reaching an RTL table by raw SQL (the crossing that needs no import),
 *      RTL code reaching an lt_* table the same way, and RTL back-end code calling /api/lt
 *   8. an LT migration that creates a table not named lt_*, or that touches ONLY
 *      RTL tables (the opposite of 5 — a both-sides rule cannot catch it)
 *   9. the rule documents, or this gate's own wiring, going missing
 *
 * Everything is checked from the filesystem — no database, no network, no deps.
 *
 * WHAT THIS GATE CANNOT SEE — a green run is not proof that nothing crossed:
 *   • RTL code COPIED BY VALUE into a Long-Term folder (there is no import to find)
 *   • a table named in SQL by interpolation, concatenation or a query builder
 *   • a plainly-named new column added to an RTL table for Long-Term's benefit, a new
 *     ClickUp/Encompass mapping, or a new checklist template
 *   • anything under web/ (built bundles plus a handful of frozen static tools)
 *   • SQL inside scripts/test-lt-*.js — a Long-Term test may name ANY table, in
 *     either product, because it exists to exercise them
 * Those rest on the person doing the work and on the PR checklist.
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
const DB_DIR = path.join(ROOT, 'db');
const LEDGER = path.join(ROOT, 'docs', 'LONG-TERM-AUTHORIZED-COPIES.md');

// Where Long-Term code is allowed to live. Everything else is RTL.
const LT_ROOTS = [
  path.join(ROOT, 'src', 'longterm'),
  path.join(ROOT, 'app-v2', 'src', 'longterm'),
];   // V1 `app/` is frozen — Long-Term never lands there

// Where we look for code at all (built bundles under web/ are generated, never scanned).
const CODE_ROOTS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'app-v2', 'src'),
  path.join(ROOT, 'app', 'src'),
  path.join(ROOT, 'scripts'),
  path.join(ROOT, 'db'),          // migrate.js / create-admin.js live here
];
// The single permitted back-end seam: server.js must be able to mount the LT router.
const MOUNT_SEAM = 'src/server.js';
// Long-Term's own tests must be able to reach Long-Term's code — that is their job.
const isLtTest = (r) => /^scripts\/test-lt-[\w-]*\.(js|mjs|cjs)$/.test(r);

const errors = [];
const notes = [];
const fail = (where, msg, how) => errors.push({ where, msg, how });

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
// Strip quotes FIRST, then the schema prefix — "public"."lt_loans" must read as lt_loans.
const cleanIdent = (s) => String(s || '').replace(/"/g, '').replace(/^public\./i, '');
const isLtName = (s) => /^lt_/i.test(cleanIdent(s));
const insideAny = (abs, roots) => roots.some((r) => {
  const x = path.relative(r, abs);
  return x !== '' && !x.startsWith('..') && !path.isAbsolute(x);
});
const isLtFile = (abs) => insideAny(abs, LT_ROOTS);

// ---------------------------------------------------------------------------
// The ledger — the owner's written authorizations. Anything not listed here is a
// violation, which is exactly what "written authorization" is supposed to mean.
// Only the FIRST ```authorized block counts, so a later example block in the prose
// can never quietly become a real permission.
// ---------------------------------------------------------------------------
function readLedger() {
  const allow = { import: new Set(), 'rtl-import': new Set(), 'sql-ref': new Set(), 'sql-read': new Set(), 'sql-write': new Set() };
  if (!fs.existsSync(LEDGER)) {
    fail(rel(LEDGER), 'The crossing ledger is missing.',
      'Restore docs/LONG-TERM-AUTHORIZED-COPIES.md — it is the only record of what the owner authorized to cross between the two products.');
    return allow;
  }
  const src = fs.readFileSync(LEDGER, 'utf8');
  const block = src.match(/```authorized\n([\s\S]*?)```/);
  if (!block) {
    fail(rel(LEDGER), 'The ledger has no ```authorized``` block.',
      'Keep the fenced ```authorized block in the file (it may be empty) — the gate reads it.');
    return allow;
  }
  for (const raw of block[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(import|rtl-import|sql-ref|sql-read|sql-write)\s+(\S+)\s*$/);
    if (!m) {
      fail(rel(LEDGER), `Unreadable ledger line: "${line}"`,
        'Each line must be "import <path>", "rtl-import <path>", "sql-ref <table>", "sql-read <table>" or "sql-write <table>" — see the entry-kinds table in the ledger.');
      continue;
    }
    allow[m[1]].add(m[2].replace(/^\.\//, ''));
  }
  const n = Object.values(allow).reduce((a, s) => a + s.size, 0);
  notes.push(n === 0
    ? 'ledger: no crossings authorized (nothing from RTL may be re-used by Long-Term, or the reverse)'
    : `ledger: ${n} crossing(s) authorized in writing`);
  return allow;
}

// ---------------------------------------------------------------------------
// A small JS scanner. It has to be careful about two things this repo is full of:
// enormous explanatory comments that name modules, and strings that quote code.
// A module named in either is NOT an import. It also has to survive a regex
// literal containing "//" (e.g. /https?:\/\//), which a naive scanner reads as the
// start of a comment and then swallows the rest of the line — including a real
// crossing sitting after it.
// ---------------------------------------------------------------------------
const REGEX_OK_AFTER = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '\n', '']);

function scanJs(src) {
  let code = '';                 // comments removed, everything else index-preserved in `code`
  const strings = [];            // { start, end, text } — ranges WITHIN `code`
  let i = 0;
  const n = src.length;
  let prevSig = '';              // last significant character emitted

  const emit = (ch) => { code += ch; if (!/\s/.test(ch)) prevSig = ch; };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // Comments. A regex can never start with "/" or "*", so "//" and "/*" here are
    // always comments — the regex case is handled below.
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }

    // Regex literal — consume it whole so an escaped slash inside can't look like a comment.
    if (c === '/' && REGEX_OK_AFTER.has(prevSig)) {
      emit(c); i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { emit(ch); emit(src[i + 1] || ''); i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { emit(ch); i++; break; }
        else if (ch === '\n') break;
        emit(ch); i++;
      }
      continue;
    }

    // String / template literal — kept, but its span is recorded so an "import"
    // that lives inside it is not mistaken for a real one.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      emit(c); i++;
      const start = code.length;
      let text = '';
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { text += ch + (src[i + 1] || ''); emit(ch); emit(src[i + 1] || ''); i += 2; continue; }
        if (ch === quote) break;
        text += ch; emit(ch); i++;
      }
      strings.push({ start, end: code.length, text });
      if (i < n) { emit(src[i]); i++; }
      continue;
    }

    emit(c); i++;
  }

  const inString = (idx) => strings.some((s) => idx >= s.start && idx < s.end);
  return { code, strings, inString };
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const allCodeFiles = () => {
  const seen = new Set();
  const out = [];
  for (const r of CODE_ROOTS) for (const f of walk(r)) if (!seen.has(f)) { seen.add(f); out.push(f); }
  return out;
};

// require('x') / import … from 'x' / import 'x' / await import('x') — real ones only.
function importsOf(scan) {
  const found = [];
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(scan.code))) { if (!scan.inString(m.index)) found.push(m[1]); }
  }
  return found;
}

// Resolve a relative specifier the way node would, enough to know WHERE it points.
function resolveFrom(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const tries = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.jsx', base + '.ts', base + '.tsx',
    path.join(base, 'index.js'), path.join(base, 'index.jsx')];
  for (const t of tries) { if (fs.existsSync(t) && fs.statSync(t).isFile()) return t; }
  return base; // not built yet — still tells us which side it points at
}

// ---------------------------------------------------------------------------
// 1 + 2. Import isolation, both directions, back end and front end.
// ---------------------------------------------------------------------------
function checkImports(allow, files) {
  let ltCount = 0;
  for (const f of files) {
    const from = rel(f);
    const lt = isLtFile(f);
    if (lt) ltCount++;
    const scan = scanJs(fs.readFileSync(f, 'utf8'));

    // A dynamic require — require(path.join(…)) or a template literal — points
    // somewhere this gate cannot see. It is a live idiom in RTL code and stays
    // allowed there, but Long-Term starts at zero, so it never gets to open a
    // door nobody can look through.
    if (lt) {
      const DYN = /\brequire\s*\(\s*(?!['"])/g;
      let d;
      while ((d = DYN.exec(scan.code))) {
        if (scan.inString(d.index)) continue;
        fail(from, 'Long-Term code uses a dynamic require() — the gate cannot see where it points.',
          'Name the module with a plain string so the separation can be checked. A computed path is the one import shape that could reach RTL code invisibly.');
        break;
      }
    }

    for (const spec of importsOf(scan)) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // npm package / node builtin — shared plumbing
      const abs = resolveFrom(f, spec);
      const targetIsLt = isLtFile(abs);
      if (lt === targetIsLt) continue;                                 // both sides the same — fine

      if (lt) {
        const target = rel(abs);
        if (allow.import.has(target)) continue;
        fail(from, `Long-Term code imports RTL code: "${spec}" → ${target}`,
          `Long-Term starts at zero. Either build what you need inside Long-Term's own folders, or get the owner's WRITTEN authorization for this exact file and add "import ${target}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
      } else {
        if (from === MOUNT_SEAM && /^src\/longterm\/(routes\/|index\.)/.test(rel(abs))) continue;  // the one seam
        if (isLtTest(from)) continue;                                  // Long-Term's own tests
        if (allow['rtl-import'].has(from)) continue;
        fail(from, `RTL code imports Long-Term code: "${spec}"`,
          `Only ${MOUNT_SEAM} may reach into src/longterm/ (to mount the router), and only scripts/test-lt-*.js may import Long-Term for testing. For anything else, get the owner's WRITTEN authorization and add "rtl-import ${from}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
      }
    }
  }
  notes.push(`code files scanned: ${files.length} (${ltCount} long-term${ltCount ? '' : ' — none built yet'})`);
}

// ---------------------------------------------------------------------------
// 7. The crossing that needs no import: raw SQL, and RTL back-end code calling /api/lt.
// ---------------------------------------------------------------------------
// Things that legitimately follow FROM/JOIN/INTO/UPDATE and are not tables.
// Words that follow FROM/INTO/UPDATE in ordinary English but can never be a table
// here. Without this, a plain label in a Long-Term screen ("Select a program from
// the dropdown") trips the raw-SQL rule — the same failure mode that used to block
// Long-Term's own tests.
const ENGLISH_NOT_A_TABLE = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'them',
  'one', 'all', 'any', 'each', 'my', 'your', 'our', 'their', 'us', 'me', 'you', 'here', 'there',
  'master', 'now', 'then', 'both', 'either', 'every']);

// `excluded` and `new`/`old` are Postgres PSEUDO-RELATIONS — the proposed row inside
// an upsert, and the trigger rows. They are never a real table and can never be a
// crossing, so naming one must never be reported (and a report naming "EXCLUDED"
// as an RTL table sends the reader hunting for a table that does not exist).
const SQL_NON_TABLE = new Set(['excluded', 'new', 'old',
  'lateral', 'only', 'select', 'unnest', 'values', 'dual', 'generate_series',
  'jsonb_array_elements', 'jsonb_array_elements_text', 'jsonb_each', 'jsonb_each_text', 'jsonb_to_recordset',
  'json_array_elements', 'json_each', 'regexp_split_to_table', 'string_to_table', 'each', 'rows', 'set']);

// Returns [{ name, mode }] where mode is 'read' (FROM / JOIN) or 'write'
// (INSERT INTO / UPDATE … SET / DELETE FROM). The distinction matters: the owner
// authorized Long-Term to SHARE the borrower record, which is not the same as
// authorizing Long-Term to rewrite it.
function tablesNamedIn(sqlText) {
  const out = [];
  // CTE names are not tables — collect them so they are never reported.
  const ctes = new Set();
  const CTE = /(?:\bWITH\b(?:\s+RECURSIVE\b)?|,)\s*("?[A-Za-z_][\w]*"?)\s+AS\s*\(/gi;
  let c;
  while ((c = CTE.exec(sqlText))) ctes.add(cleanIdent(c[1]).toLowerCase());

  const keep = (name, at, whole) => {
    const lower = name.toLowerCase();
    if (SQL_NON_TABLE.has(lower) || ctes.has(lower)) return false;
    if (ENGLISH_NOT_A_TABLE.has(lower)) return false;   // a label, not a query
    if (sqlText[at + whole.length] === '(') return false;              // a function call, not a table
    return true;
  };

  // Writes first, remembering where they matched so the FROM inside "DELETE FROM"
  // is never counted a second time as a read.
  const writeSpans = [];
  for (const re of [/\bINSERT\s+INTO\s+("?[\w."]+"?)/gi,
    // `UPDATE t SET`, `UPDATE ONLY t SET`, `UPDATE t AS x SET`, `UPDATE t x SET` — an
    // alias is the cheapest way to hide the one write the owner refused.
    /\bUPDATE\s+(?:ONLY\s+)?("?[\w."]+"?)(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b/gi,
    /\bDELETE\s+FROM\s+(?:ONLY\s+)?("?[\w."]+"?)/gi,
    /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?("?[\w."]+"?)/gi,
    /\bMERGE\s+INTO\s+("?[\w."]+"?)/gi]) {
    let m;
    while ((m = re.exec(sqlText))) {
      writeSpans.push([m.index, m.index + m[0].length]);
      const name = cleanIdent(m[1]);
      if (keep(name, m.index, m[0])) out.push({ name, mode: 'write' });
    }
  }

  // `TRUNCATE a, b;` — the continuation is walked only from the TRUNCATE itself.
  const TRUNC = /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?("?[\w."]+"?)/gi;
  let t;
  while ((t = TRUNC.exec(sqlText))) {
    let at = t.index + t[0].length;
    const MORE_T = /^\s*,\s*(?:ONLY\s+)?("?[\w."]+"?)/i;
    for (;;) {
      const more = sqlText.slice(at).match(MORE_T);
      if (!more) break;
      const nm = cleanIdent(more[1]);
      writeSpans.push([at, at + more[0].length]);
      if (keep(nm, at + more[0].length - more[1].length, more[1])) out.push({ name: nm, mode: 'write' });
      at += more[0].length;
    }
  }

  // `IS DISTINCT FROM x` / `IS NOT DISTINCT FROM x` is a COMPARISON OPERATOR whose
  // last word happens to be FROM. It names no table and opens no clause. Without
  // this, the ordinary upsert guard `WHERE t.col IS DISTINCT FROM EXCLUDED.col` —
  // the idiom that stops a no-op write churning a row — is reported as a
  // cross-product table read, and the report even names "EXCLUDED.col" as the
  // table. Narrow on purpose: it exempts only the two spellings of that operator,
  // never a FROM that could be a clause.
  const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;
  const distinctSpans = [];
  for (let d; (d = DISTINCT_FROM.exec(sqlText));) {
    // The span starts at this match's own FROM, so a table named anywhere else is
    // still seen.
    distinctSpans.push(d.index + d[0].length - 'FROM'.length);
  }

  const READ = /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?("?[\w."]+"?)/gi;
  let m;
  while ((m = READ.exec(sqlText))) {
    if (writeSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
    if (distinctSpans.includes(m.index)) continue;
    const name = cleanIdent(m[1]);
    if (keep(name, m.index, m[0])) out.push({ name, mode: 'read' });
    // The old-style comma join — `FROM lt_loans l, applications a`. Walked only
    // from a real FROM clause, so a SELECT list or an INSERT column list
    // (`INSERT INTO t (borrower_id, staff_id)`) is never mistaken for tables.
    let at = m.index + m[0].length;
    const MORE = /^(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*,\s*("?[\w."]+"?)/i;
    for (;;) {
      const tail = sqlText.slice(at);
      const more = tail.match(MORE);
      if (!more) break;
      const nm = cleanIdent(more[1]);
      if (keep(nm, at + more[0].length - more[1].length, more[1])) out.push({ name: nm, mode: 'read' });
      at += more[0].length;
    }
  }
  return out;
}

function looksLikeSql(text) {
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i.test(text) && /\b(FROM|INTO|SET|JOIN)\b/i.test(text)) return true;
  // TRUNCATE / MERGE carry no FROM or SET, so they need their own shape — tight
  // enough that ordinary prose ("truncate the string") is not read as SQL.
  if (/\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?"?[\w."]+"?(?:\s*,\s*(?:ONLY\s+)?"?[\w."]+"?)*\s*(?:;|$|CASCADE|RESTART|RESTRICT)/i.test(text)) return true;
  if (/\bMERGE\s+INTO\s+"?[\w."]+"?[\s\S]{0,80}?\bUSING\b[\s\S]{0,160}?\bON\b/i.test(text)) return true;
  return false;
}

// The enforcement machinery itself has to contain both products' shapes as fixture
// text — that is its whole job. These two exact files, and no others, are exempt
// from the raw-SQL scan. (Their imports are still checked like everything else.)
const SQL_SCAN_EXEMPT = new Set(['scripts/check-product-separation.js', 'scripts/test-product-separation-gate.js']);

function checkRawSql(allow, files) {
  for (const f of files) {
    const from = rel(f);
    if (SQL_SCAN_EXEMPT.has(from)) continue;
    const lt = isLtFile(f);
    const src = fs.readFileSync(f, 'utf8');
    const scan = scanJs(src);

    for (const s of scan.strings) {
      if (!looksLikeSql(s.text)) continue;
      for (const { name: t, mode } of tablesNamedIn(s.text)) {
        if (lt && !isLtName(t)) {
          // A table Long-Term may write, it may certainly read.
          if (allow['sql-write'].has(t)) continue;
          if (mode === 'read' && allow['sql-read'].has(t)) continue;
          if (mode === 'write' && allow['sql-read'].has(t)) {
            fail(from, `Long-Term code WRITES the RTL table "${t}" — it is only authorized to READ it.`,
              `Reading a shared record and rewriting it are different permissions. If Long-Term really must change "${t}", get the owner's WRITTEN authorization and add "sql-write ${t}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
            continue;
          }
          fail(from, `Long-Term code ${mode === 'write' ? 'writes' : 'reads'} the RTL table "${t}" directly in SQL.`,
            `An import is not the only way to cross — this is the same crossing without the require(). Long-Term may only touch lt_* tables. If it genuinely must ${mode === 'write' ? 'change' : 'read'} an RTL table, get the owner's WRITTEN authorization and add "sql-${mode === 'write' ? 'write' : 'read'} ${t}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
        }
        if (!lt && !isLtTest(from) && isLtName(t)) {
          fail(from, `RTL code ${mode === 'write' ? 'writes' : 'reads'} the Long-Term table "${t}" directly in SQL.`,
            'RTL is the live product and must never depend on the Long-Term side build.');
        }
      }
    }

    // RTL back-end code must not call the Long-Term API. (The FRONT END may — the
    // owner allows one screen to show both, so front-end files are not checked here.)
    if (!lt && from.startsWith('src/') && from !== MOUNT_SEAM && scan.code.includes('/api/lt')) {
      fail(from, 'RTL back-end code refers to the Long-Term API path /api/lt.',
        `Only ${MOUNT_SEAM} may name the Long-Term mount path. Back-end RTL code calling Long-Term is a crossing; the combined pipeline is assembled at the read/view layer, not inside RTL.`);
    }
  }
}

// ---------------------------------------------------------------------------
// SQL statement helpers.
// ---------------------------------------------------------------------------
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^-])--[^\n]*/g, '$1 ');
}

function tableBody(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') { depth--; if (depth === 0) return sql.slice(openIdx + 1, i); }
  }
  return sql.slice(openIdx + 1);
}

// ---------------------------------------------------------------------------
// 3-6 + 8. Schema isolation.
// ---------------------------------------------------------------------------
function checkSql(allow) {
  if (!fs.existsSync(DB_DIR)) return;
  const files = fs.readdirSync(DB_DIR).filter((f) => f.endsWith('.sql')).sort();
  let ltFileCount = 0;

  for (const name of files) {
    const where = 'db/' + name;
    const sql = stripSqlComments(fs.readFileSync(path.join(DB_DIR, name), 'utf8'));
    const declaredLtMigration = /^\d+_lt_/i.test(name);   // db/NNN_lt_*.sql — anchored, so db/430_default_lt_value.sql is NOT one

    const ltTouched = new Set();
    const rtlTouched = new Set();
    const noteTable = (t) => {
      const clean = cleanIdent(t);
      if (!clean) return;
      (isLtName(clean) ? ltTouched : rtlTouched).add(clean);
    };
    const refCheck = (table, scope, verb) => {
      const REFS = /\bREFERENCES\s+("?[\w."]+"?)/gi;
      let r;
      while ((r = REFS.exec(scope))) {
        const target = cleanIdent(r[1]);
        if (isLtName(table) && !isLtName(target)) {
          if (allow['sql-ref'].has(target)) continue;
          fail(where, `Long-Term table "${table}" ${verb} a foreign key to the RTL table "${target}".`,
            `A Long-Term table may only reference other lt_* tables. If Long-Term genuinely must hang off an RTL table, get the owner's WRITTEN authorization and add "sql-ref ${target}" to docs/LONG-TERM-AUTHORIZED-COPIES.md.`);
        }
        if (!isLtName(table) && isLtName(target)) {
          fail(where, `RTL table "${table}" ${verb} a foreign key to the Long-Term table "${target}".`,
            'RTL must never depend on Long-Term. Long-Term is a side build that is not live — an RTL table pointing at it welds the two products together.');
        }
      }
    };

    let m;

    // ---- CREATE TABLE ----
    const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w."]+"?)/gi;
    while ((m = CREATE_TABLE.exec(sql))) {
      const table = cleanIdent(m[1]);
      noteTable(table);
      if (declaredLtMigration && !isLtName(table)) {
        fail(where, `A Long-Term migration creates the table "${table}", which is not named lt_*.`,
          'Every Long-Term table must be named lt_* — the whole separation, in the database and in this gate, keys off that prefix.');
      }
      // A Long-Term-sounding table that misses the prefix would be invisible to
      // every SQL rule here, wherever it was declared.
      if (!isLtName(table) && /^(long_?term|lt[^_a-z])/i.test(table)) {
        fail(where, `Table "${table}" is named for Long-Term but does not use the lt_ prefix.`,
          'Rename it lt_… — every schema rule in this gate keys off that prefix, so a Long-Term table without it is unprotected.');
      }
      const open = sql.indexOf('(', CREATE_TABLE.lastIndex);
      if (open === -1) continue;
      refCheck(table, tableBody(sql, open), 'has');
    }

    // ---- ALTER TABLE (a statement need not end in ';' — the last one in a file often doesn't) ----
    const ALTER = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[\w."]+"?)([\s\S]*?)(?:;|$)/gi;
    while ((m = ALTER.exec(sql))) {
      const table = cleanIdent(m[1]);
      noteTable(table);
      const rest = m[2] || '';
      const ADD_COL = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/gi;
      let c;
      while ((c = ADD_COL.exec(rest))) {
        const col = cleanIdent(c[1]);
        if (!isLtName(table) && /^(lt_|long_?term)/i.test(col)) {
          fail(where, `Column "${col}" is being added to the RTL table "${table}".`,
            'Long-Term does not get columns on RTL tables — it gets its own lt_* tables. The owner: "don\'t add any columns don\'t add any mapping unless we specifically ask you to."');
        }
      }
      refCheck(table, rest, 'gains');
    }

    // ---- other statements that touch a table (so a mixed migration can't hide in an UPDATE/DROP) ----
    const TOUCH = [
      /\bINSERT\s+INTO\s+("?[\w."]+"?)/gi,
      /\bUPDATE\s+("?[\w."]+"?)\s+SET\b/gi,
      /\bDELETE\s+FROM\s+(?:ONLY\s+)?("?[\w."]+"?)/gi,
      /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w."]+"?)/gi,
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\w"]+\s+ON\s+("?[\w."]+"?)/gi,
      /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?[\w"]+\s+ON\s+("?[\w."]+"?)/gi,
    ];
    for (const re of TOUCH) { while ((m = re.exec(sql))) noteTable(m[1]); }

    // ---- triggers ----
    const TRIGGER = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("?[\w]+"?)([\s\S]*?)(?:;|$)/gi;
    while ((m = TRIGGER.exec(sql))) {
      const stmt = m[2] || '';
      const on = (stmt.match(/\bON\s+("?[\w."]+"?)/i) || [])[1];
      const fn = (stmt.match(/\bEXECUTE\s+(?:PROCEDURE|FUNCTION)\s+("?[\w."]+"?)/i) || [])[1];
      if (!on) continue;
      const onTable = cleanIdent(on);
      noteTable(onTable);
      if (!fn) continue;
      const fnName = cleanIdent(fn);
      if (isLtName(onTable) && !isLtName(fnName)) {
        fail(where, `Trigger "${cleanIdent(m[1])}" runs the non-Long-Term function ${fnName}() on the Long-Term table "${onTable}".`,
          'A Long-Term table may only be driven by an lt_*-named function. RTL triggers reopen RTL pricing, RTL conditions and RTL sync — none of that exists on the Long-Term side. Name Long-Term\'s trigger function lt_… so it can never be confused with, or silently replace, an RTL one.');
      }
      if (!isLtName(onTable) && isLtName(fnName)) {
        fail(where, `Trigger "${cleanIdent(m[1])}" runs the Long-Term function ${fnName}() on the RTL table "${onTable}".`,
          'Long-Term logic must never fire on an RTL table. RTL is the live product.');
      }
    }

    // ---- a Long-Term migration may not redefine a function that is not its own ----
    // CREATE OR REPLACE FUNCTION pilot_reopen_pricing() inside an LT migration would
    // silently replace the LIVE RTL function — the single most damaging thing an LT
    // migration could do to RTL.
    const FUNC = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w."]+"?)/gi;
    const funcs = [];
    while ((m = FUNC.exec(sql))) funcs.push(cleanIdent(m[1]));
    if (declaredLtMigration || ltTouched.size) {
      for (const fnName of funcs) {
        if (!isLtName(fnName)) {
          fail(where, `A Long-Term migration defines the function ${fnName}(), which is not named lt_*.`,
            'CREATE OR REPLACE FUNCTION with an RTL name silently replaces the live RTL function. Every Long-Term function must be named lt_….');
        }
      }
    }

    // ---- 5. one migration file may not touch both products ----
    if (ltTouched.size || declaredLtMigration) ltFileCount++;
    if (ltTouched.size && rtlTouched.size) {
      fail(where, `This migration touches BOTH products — Long-Term (${[...ltTouched].join(', ')}) and RTL (${[...rtlTouched].join(', ')}).`,
        'Split it into two migrations: a Long-Term one that only touches lt_* tables, and (only if the owner asked for it) a separate RTL one. A mixed migration is how the two products quietly grow into one.');
    } else if (declaredLtMigration && rtlTouched.size) {
      // A file named db/NNN_lt_*.sql that touches ONLY RTL tables would have slipped
      // past the both-sides rule above, which needs a table from each side.
      fail(where, `This is a Long-Term migration, but every table it touches is RTL (${[...rtlTouched].join(', ')}).`,
        'A Long-Term migration may only touch lt_* tables. If the owner asked for a change to an RTL table, it belongs in its own migration that is not named _lt_.');
    }
  }
  notes.push(`migrations scanned: ${files.length} (${ltFileCount} long-term)`);
}

// ---------------------------------------------------------------------------
// 9. The rules — and this gate's own wiring — must stay in place.
// ---------------------------------------------------------------------------
function checkRuleDocsPresent() {
  const required = [
    [path.join(ROOT, 'CLAUDE.md'), /TWO PRODUCTS, TWO SYSTEMS/, 'CLAUDE.md must keep the "TWO PRODUCTS, TWO SYSTEMS" section — it is the master copy of the rule.'],
    [path.join(GIT_ROOT, 'AGENTS.md'), /TWO products/i, 'AGENTS.md (git root) must keep the two-product rule so every AI agent reads it before working.'],
    [path.join(GIT_ROOT, '.github', 'PRODUCT-SEPARATION.md'), /TWO products/i, '.github/PRODUCT-SEPARATION.md is the GitHub-side copy of the rule.'],
    [path.join(GIT_ROOT, '.github', 'pull_request_template.md'), /Which product is this for/i, 'The PR template must keep asking which product a change is for.'],
    [path.join(ROOT, 'docs', 'LONG-TERM-LOANS-SEPARATION-CHARTER.md'), /./, 'The charter explains how the two products stay apart.'],
    [LEDGER, /```authorized/, 'The ledger records every crossing the owner authorized in writing.'],
    // The gate is only a gate while it actually runs. package.json is one of the
    // rule's homes too: unwiring two steps would leave every document intact and
    // every check silent.
    [path.join(ROOT, 'package.json'), /node scripts\/check-product-separation\.js/,
      'package.json must keep running scripts/check-product-separation.js in the `test` chain — that is what makes CI block a crossing.'],
    [path.join(ROOT, 'package.json'), /node scripts\/test-product-separation-gate\.js/,
      'package.json must keep running scripts/test-product-separation-gate.js — the test that proves this gate still catches what it claims.'],
    [path.join(GIT_ROOT, '.github', 'workflows', 'test.yml'), /npm test/,
      'The CI workflow must keep running `npm test`, or none of these checks reach a pull request.'],
  ];
  for (const [file, re, why] of required) {
    if (!fs.existsSync(file)) { fail(path.relative(GIT_ROOT, file), 'Rule document is missing.', why); continue; }
    if (!re.test(fs.readFileSync(file, 'utf8'))) {
      fail(path.relative(GIT_ROOT, file), 'Rule document no longer states the rule.', why);
    }
  }
}

// ---------------------------------------------------------------------------
const allow = readLedger();
const files = allCodeFiles();
checkImports(allow, files);
checkRawSql(allow, files);
checkSql(allow);
checkRuleDocsPresent();

console.log('Two-product separation gate (RTL vs Long-Term)');
for (const n of notes) console.log('  · ' + n);

if (errors.length) {
  console.error(`\n  ✗ ${errors.length} separation violation(s) — the two products are growing into each other:\n`);
  for (const e of errors) console.error(`  ✗ ${e.where}\n      ${e.msg}\n      → ${e.how}\n`);
  console.error('  The rule (owner-directed 2026-08-02): RTL and Long-Term are two separate systems, and');
  console.error('  nothing crosses without the owner\'s explicit WRITTEN authorization, recorded in');
  console.error('  docs/LONG-TERM-AUTHORIZED-COPIES.md. Fix the crossing or get it authorized — never edit this gate.');
  process.exit(1);
}

console.log('  ✓ clean — the two products are still fully separate.');
