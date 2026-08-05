'use strict';
/**
 * EVERY EXCEPTION TYPE HAS A CARD — the guard for the class that showed a
 * super-admin condition_override as a "Guaranty waiver" (owner-reported
 * 2026-08-05, file YSCAP258134817).
 *
 * ROOT CAUSE: app-v2's ExceptionCard TYPE_META is a hand-maintained copy of the
 * backend EXCEPTION_TYPES registry, and its fallback was `|| TYPE_META.guaranty_waiver`
 * — so a type with no entry (condition_override, tape_encompass_override)
 * rendered the GUARANTY card: wrong chip, wrong default policy, wrong
 * "requested change" text. The reason/note were right (from the row), which made
 * it read as "you mixed up two things".
 *
 * THE CLASS: any per-type presentation table that (a) omits a real type or
 * (b) falls back to a SPECIFIC type instead of a generic render. This test pins
 * both: every registry type must have a TYPE_META entry, the guaranty fallback
 * must be gone, and the fallback must render from the server's authoritative
 * label (r.type_label) — which the backend must actually put on the row.
 *
 * Pure — a scan of two source files. No DB driver, no JSX execution, so it runs
 * anywhere and can never mask a break by failing to load.
 *   node scripts/test-exception-card-types-pure.js
 */
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const cardSrc = fs.readFileSync(R + '/app-v2/src/components/ExceptionCard.jsx', 'utf8');
const leSrc = fs.readFileSync(R + '/src/lib/loan-exceptions.js', 'utf8');

// Slice out a top-level `const NAME = ...{ ... };` block and return its keys
// (a key is a line indented exactly two spaces: `  key:`). Robust to JSX/nested
// braces because it only ever reads the FIRST line that is exactly `};`/`});`.
function blockKeys(src, opener, closerRe) {
  const start = src.indexOf(opener);
  if (start < 0) return null;
  const rest = src.slice(start + opener.length);
  const endRel = rest.search(closerRe);
  if (endRel < 0) return null;
  const block = rest.slice(0, endRel);
  const keys = new Set();
  for (const m of block.matchAll(/^ {2}(\w+):/gm)) keys.add(m[1]);
  return keys;
}

// ---- backend registry types ----
const regTypes = blockKeys(leSrc, 'const EXCEPTION_TYPES = Object.freeze({', /\n\}\);\n/);
ok(regTypes && regTypes.size >= 11, `EXCEPTION_TYPES registry parsed (${regTypes ? regTypes.size : 0} types)`);
// Every registry entry carries a label — the source of type_label.
for (const t of regTypes || []) {
  const hasLabel = new RegExp(`${t}: Object\\.freeze\\(\\{[\\s\\S]*?label:`, 'm').test(leSrc);
  ok(hasLabel, `registry type "${t}" declares a label`);
}

// ---- frontend TYPE_META keys ----
const metaKeys = blockKeys(cardSrc, 'const TYPE_META = {', /\n\};\n/);
ok(metaKeys && metaKeys.size >= (regTypes ? regTypes.size : 0), `TYPE_META parsed (${metaKeys ? metaKeys.size : 0} entries)`);

// EVERY registry type must have a TYPE_META entry — the parity that was missing.
for (const t of regTypes || []) {
  ok(metaKeys && metaKeys.has(t), `TYPE_META covers "${t}" (a registry type must have its own card)`);
}
// The two types the bug was about, explicitly.
ok(metaKeys && metaKeys.has('condition_override'), 'TYPE_META covers condition_override (the reported bug)');
ok(metaKeys && metaKeys.has('tape_encompass_override'), 'TYPE_META covers tape_encompass_override');

// ---- the fallback must be generic, never a specific type ----
ok(!/TYPE_META\.guaranty_waiver/.test(cardSrc),
   'the dangerous "|| TYPE_META.guaranty_waiver" fallback is gone (a missing type must render generically)');
ok(/r\.type_label/.test(cardSrc), 'the generic fallback renders the chip from the server-provided r.type_label');

// ---- the backend actually PUTS type_label on the rows the card reads ----
// (a card fallback keyed on r.type_label is useless if the server never sends it)
ok(/function typeLabelFor\(/.test(leSrc), 'loan-exceptions defines typeLabelFor');
ok(/\btypeLabelFor\b/.test(leSrc.split('module.exports')[1] || ''), 'typeLabelFor is exported');
const typeLabelHits = (leSrc.match(/type_label:\s*typeLabelFor/g) || []).length
  + (leSrc.match(/\.type_label\s*=\s*typeLabelFor/g) || []).length;
ok(typeLabelHits >= 4, `type_label is attached on every read surface (found ${typeLabelHits}, need the 4 list/get paths)`);

// ---- the decision toast must not hardcode guaranty wording for other types ----
const exScreen = fs.readFileSync(R + '/app-v2/src/screens/StaffExceptions.jsx', 'utf8');
ok(/function decisionMessage\(/.test(exScreen), 'StaffExceptions routes the decision toast through decisionMessage (per-type)');

// ---- the decision EMAIL must not mislabel a non-esign type as esign ----
// The team notification's catch-all `else` used to emit esign "send-before-CTC"
// wording for oop_rehab / appraisal_xml_waiver / credit_import_waiver (they fell
// through to it). The esign branch must be explicitly gated, with a generic
// registry-label branch after it.
const adminEx = fs.readFileSync(R + '/src/routes/admin-exceptions.js', 'utf8');
ok(/}\s*else if \(isEsign\)\s*{/.test(adminEx),
   'admin-exceptions gates the esign decision notice explicitly (no catch-all esign else)');
ok(/type:\s*'loan_exception_decided'/.test(adminEx),
   'admin-exceptions has a generic decision notice for any other decidable type');
ok(/typeLabelFor\(exc\.exception_type\)/.test(adminEx),
   'the generic decision notice names the type from the registry label');
// The generic notify type is registered (category + kicker), so it emails and buckets right.
const notifySrc = fs.readFileSync(R + '/src/lib/notify.js', 'utf8');
ok((notifySrc.match(/loan_exception_decided:/g) || []).length >= 2,
   'loan_exception_decided is registered in both notify maps (KICKER_OF + CATEGORY_OF)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
