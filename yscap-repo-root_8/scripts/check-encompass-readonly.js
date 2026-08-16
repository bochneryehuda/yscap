#!/usr/bin/env node
'use strict';

/**
 * ENCOMPASS IS READ-ONLY — the hard gate (runs in `npm test` and CI).
 *
 * Owner-directed 2026-08-14, the HARDEST rule, on top of every other rule, for BOTH
 * products (RTL and Long-Term) and every program: PILOT ↔ Encompass is ONE-WAY. We
 * READ (loans, fields, milestones, settings, inbound webhooks — unlimited). We NEVER
 * WRITE. The ONLY writes allowed are the ones a super-admin authorized IN WRITING for
 * a SPECIFIC endpoint/field, recorded in the pad docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md.
 * No agent, and no person, may ever GUESS a write.
 *
 * This gate fails the build on:
 *   1. an Encompass HTTP client that can WRITE and is not authorized in the pad;
 *   2. a read-only Encompass client that grew a write helper or an over-wide allowlist;
 *   3. a raw Encompass fetch (literal /encompass/ or /oauth2/ or api.elliemae.com URL)
 *      that bypasses a guarded client;
 *   4. a write verb (POST/PUT/PATCH/DELETE) aimed at Encompass from a file that is not
 *      an authorized writer (POST is allowed ONLY for the read-shaped token / pipeline
 *      search / fieldReader calls inside a recognized read-only client);
 *   5. the pad, this gate's wiring, or the rule docs going missing.
 *
 * DO NOT weaken or disable this gate. To add a write, get the owner's WRITTEN
 * authorization for the specific thing and add it to the pad — never edit this file.
 *
 *   node scripts/check-encompass-readonly.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GIT_ROOT = path.join(ROOT, '..');
const PAD = path.join(ROOT, 'docs', 'ENCOMPASS-WRITE-AUTHORIZATIONS.md');

const CODE_ROOTS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'app-v2', 'src'),
  path.join(ROOT, 'scripts'),
];

// This gate and its self-test contain both shapes as fixture text — exempt from the
// raw-scan (their pad-membership / doc checks still run).
const SCAN_EXEMPT = new Set([
  'scripts/check-encompass-readonly.js',
  'scripts/test-encompass-readonly-gate.js',
  // The per-client read-only proofs contain client-shaped Encompass fixtures + the
  // exact strings they assert on — they exercise the guard, they are not clients.
  'scripts/test-encompass-readonly.js',
  'scripts/test-lt-encompass-readonly.js',
]);

const errors = [];
const notes = [];
const fail = (where, msg, how) => errors.push({ where, msg, how });
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Encompass URL markers that identify an ICE/Encompass HTTP call. Deliberately the
// ICE v3 API path and host ONLY — NOT bare "/encompass/" (that also matches our own
// /api/lt/encompass/ routes) and NOT bare "/oauth2/" (USPS and others use OAuth too).
const ENCOMPASS_URL = /\/encompass\/v3\/|api\.elliemae\.com/;
// A file "concerns Encompass" if it imports the client/config or names an Encompass path.
const CONCERNS_ENCOMPASS = /integrations\/encompass|longterm\/encompass|encompass-field-map|require\([^)]*config[^)]*\)\.encompass|\bconfig\.encompass\b|\/encompass\/v3|elliemae/;
// The read-shaped POST endpoints allowed inside a read-only client.
const READ_SHAPED = /oauth2\/v1\/token|loanPipeline|fieldReader/;

// Strip // and /* */ comments (string-safe enough for our greps: we only use the
// stripped text to avoid matching commented-out code / prose that names a verb).
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) { if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; } if (src[i] === q) break; out += src[i]; i++; }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── The pad — the ONLY source of authorized writes ───────────────────────────
function readPad() {
  const writers = new Set();      // module paths allowed to write
  if (!fs.existsSync(PAD)) {
    fail('docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md', 'The Encompass write-authorization pad is missing.',
      'Restore docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md — it is the only record of what the owner authorized to write to Encompass.');
    return writers;
  }
  const src = fs.readFileSync(PAD, 'utf8');
  for (const [needle, re] of [['one-way', /one-way/i], ['read-only', /read-only/i], ['no-guess clause', /guess/i], ['encompass-writes block', /encompass-writes/]]) {
    if (!re.test(src)) fail('docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md', `The pad no longer states the rule (${needle} missing).`, 'Keep the hard read-only rule + the no-guess clause + the encompass-writes block intact.');
  }
  const block = src.match(/```encompass-writes\n([\s\S]*?)```/);
  if (!block) {
    fail('docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md', 'The pad has no ```encompass-writes``` block.', 'Keep the fenced block (it may list zero writes) — the gate reads it.');
    return writers;
  }
  for (const raw of block[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^write\s+(\S+)\s*(?:\|.*)?$/);
    if (!m) { fail('docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md', `Unreadable pad line: "${line}"`, 'Each write line must be "write <module-path> | <endpoints> | <purpose>".'); continue; }
    writers.add(m[1].replace(/^\.\//, ''));
  }
  notes.push(writers.size === 0 ? 'pad: no Encompass writes authorized (fully read-only)' : `pad: ${writers.size} authorized write module(s)`);
  return writers;
}

// A read-only Encompass client must carry these markers and NO write helpers.
const WRITE_HELPERS = ['apiPost', 'apiPut', 'apiPatch', 'apiDelete', 'updateLoan', 'createLoan', 'patchLoan', 'setField', 'writeField'];
function checkReadOnlyClient(where, code) {
  if (!/const\s+READ_ONLY\s*=\s*true/.test(code) && !/READ_ONLY\s*[:=]\s*true/.test(code)) {
    fail(where, 'This Encompass client is not authorized to write, and is missing the READ_ONLY sentinel.', 'A read-only Encompass client must declare `const READ_ONLY = true` (and export it).');
  }
  for (const h of WRITE_HELPERS) {
    if (new RegExp(`(?:function\\s+${h}\\b|const\\s+${h}\\b|\\b${h}\\s*:\\s*(?:async\\s*)?\\()`).test(code)) {
      fail(where, `This read-only Encompass client declares a write helper "${h}".`, 'Remove it. A write requires an entry in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md.');
    }
  }
  const allow = code.match(/POST_ALLOWLIST\s*=\s*new\s+Set\(\[([^\]]*)\]\)/);
  if (allow) {
    const entries = allow[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length > 2) fail(where, `This read-only client's POST_ALLOWLIST has ${entries.length} entries (max 2 read-shaped: token + pipeline).`, 'A third POST endpoint needs the owner\'s sign-off; fieldReader is matched by its own narrow predicate, not the allowlist.');
  }
}

function main() {
  const writers = readPad();
  const files = [];
  const seen = new Set();
  for (const r of CODE_ROOTS) for (const f of walk(r)) if (!seen.has(f)) { seen.add(f); files.push(f); }

  const discoveredClients = [];
  const usedWriters = new Set();

  for (const f of files) {
    const where = rel(f);
    if (SCAN_EXEMPT.has(where)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    const code = stripComments(raw);
    const hasFetch = /fetch\s*\(/.test(code);
    const isWriter = writers.has(where);
    if (isWriter) usedWriters.add(where);

    // A discovered Encompass HTTP client = builds its own fetch guard AND names an
    // Encompass path. (Read consumers that go through the client are NOT clients.)
    const isClient = /_fetchGuarded/.test(code) && /oauth2\/v1\/token|\/encompass\/v3/.test(code);
    if (isClient) {
      discoveredClients.push(where);
      if (!isWriter) checkReadOnlyClient(where, code);   // must be structurally read-only
    }

    // 3. No raw Encompass fetch may bypass a guarded client. A literal Encompass URL
    //    passed straight to fetch(...) is only OK inside a recognized client / writer.
    let m;
    const FETCH = /fetch\s*\(\s*([^,)]+)/g;
    while ((m = FETCH.exec(code))) {
      if (ENCOMPASS_URL.test(m[1])) {
        if (!isClient && !isWriter) {
          fail(where, 'A raw fetch() targets an Encompass URL outside a guarded client.', 'All Encompass HTTP must go through the read-only client (src/lib/integrations/encompass.js or src/longterm/encompass/client.js). A write needs a pad entry.');
          break;
        }
      }
    }

    // 4. Write verbs aimed at Encompass — only in files that actually make HTTP calls
    //    (`fetch(`), so a documentation/data catalog that merely lists {method:'POST'}
    //    as reference data is never mistaken for a call. In any Encompass-concerning
    //    file that is NOT an authorized writer: PUT/PATCH/DELETE are always forbidden;
    //    POST is allowed only inside a recognized read-only client and only read-shaped.
    if (!isWriter && hasFetch && CONCERNS_ENCOMPASS.test(code)) {
      const VERB = /method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/g;
      while ((m = VERB.exec(code))) {
        const verb = m[1];
        if (verb !== 'POST') {
          fail(where, `A ${verb} request appears in Encompass-related code that is not an authorized writer.`, `Encompass is read-only. If this ${verb} genuinely targets Encompass, it needs a written authorization in the pad; otherwise move it out of Encompass-concerning code.`);
          continue;
        }
        // POST: allowed only inside a recognized read-only client, and the file's POSTs
        // must be read-shaped (token / pipeline / fieldReader).
        if (!isClient) {
          fail(where, 'A POST appears in Encompass-related code that is neither a read-only client nor an authorized writer.', 'Route Encompass reads through the read-only client; a POST that writes needs a pad entry.');
        } else if (!READ_SHAPED.test(code)) {
          fail(where, 'A read-only Encompass client POSTs to a non-read-shaped endpoint.', 'Only the token exchange, pipeline search, and fieldReader (read-shaped) POSTs are allowed.');
        }
      }
    }
  }

  // Every authorized writer must exist and actually be a guarded Encompass client.
  for (const w of writers) {
    if (!fs.existsSync(path.join(ROOT, w))) {
      fail('docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md', `Authorized writer "${w}" does not exist as a file.`, 'Remove the stale pad entry, or restore the module.');
    } else if (!discoveredClients.includes(w)) {
      fail(w, 'This module is authorized to write to Encompass but is not a guarded Encompass client.', 'An authorized writer must funnel its writes through its own guard (its own endpoint allowlist), like src/encompass/flood-order.js.');
    }
  }

  notes.push(`Encompass HTTP clients discovered: ${discoveredClients.length} (${discoveredClients.map((c) => (writers.has(c) ? c + ' [writer]' : c)).join(', ') || 'none'})`);

  // 5. The rule and this gate's wiring must stay in place.
  const required = [
    [PAD, /```encompass-writes/, 'The write-authorization pad must keep its encompass-writes block.'],
    [path.join(ROOT, 'package.json'), /node scripts\/check-encompass-readonly\.js/, 'package.json must keep running scripts/check-encompass-readonly.js in the test chain.'],
    [path.join(ROOT, 'CLAUDE.md'), /ENCOMPASS IS READ-ONLY|Encompass is READ-ONLY/i, 'CLAUDE.md must keep the Encompass read-only hard rule.'],
    [path.join(GIT_ROOT, 'AGENTS.md'), /Encompass.*read-only/i, 'AGENTS.md must keep the Encompass read-only rule for every agent.'],
  ];
  for (const [file, re, why] of required) {
    if (!fs.existsSync(file)) { fail(path.relative(GIT_ROOT, file), 'Rule/wiring file is missing.', why); continue; }
    if (!re.test(fs.readFileSync(file, 'utf8'))) fail(path.relative(GIT_ROOT, file), 'Rule/wiring no longer present.', why);
  }

  console.log('Encompass read-only gate (one-way: read massively, never write)');
  for (const n of notes) console.log('  · ' + n);
  if (errors.length) {
    console.error(`\n  ✗ ${errors.length} Encompass write-safety violation(s):\n`);
    for (const e of errors) console.error(`  ✗ ${e.where}\n      ${e.msg}\n      → ${e.how}\n`);
    console.error('  The rule (owner-directed 2026-08-14): Encompass is READ-ONLY. No write may exist unless the owner');
    console.error('  authorized it IN WRITING for the specific thing, recorded in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md.');
    console.error('  Never guess a write. Fix the crossing or get it authorized — never edit this gate.');
    process.exit(1);
  }
  console.log('  ✓ clean — Encompass stays one-way (read-only) across all products.');
}

main();
