#!/usr/bin/env node
/**
 * LT PPE — THE SUGGESTED-RULE REVIEW SCREEN (Part 3 P8), and the two traps it is built around.
 *
 * WHAT WAS MISSING. The per-investor rule loop was fully built on the server — Lender Price's own
 * declines are mined into PROPOSALS (`suggestion-miner` → `rule-store.saveSuggestions`), a human accepts
 * one, and `rule-store.acceptSuggestion` writes a real `lt_ppe_rule` our engine then enforces. Every
 * piece existed and was tested EXCEPT the human end: the only way to accept a suggestion was to call the
 * endpoint by hand. A loop whose one deliberate human step has no surface is not a loop.
 *
 * TRAP 1 — THE INVESTOR FILTER THAT WOULD SILENTLY SHOW NOTHING. The screen's investor picker carries
 * OUR investor CODE (`/ppe/investors` → `code`, e.g. `DHVN`), while a suggestion carries Lender Price's
 * VERBATIM name for the same investor (`investor_label`, e.g. `Deephaven Mortgage`). Passing the code to
 * `?investor=` filters on `investor_label` and matches nothing — and an empty list is indistinguishable
 * from "nothing to do". So the list is deliberately UNFILTERED and every row names its own investor.
 *
 * TRAP 2 — A READ FAILURE THAT READS AS "ALL CLEAR". Catching the fetch into an empty array would render
 * the same "Nothing is waiting" as a genuinely empty queue. The failure is stated instead.
 *
 * Also pinned: an unmappable suggestion (`needs_human`) is LABELLED as such and its buttons are still
 * shown — the server refuses it, and a hidden button is indistinguishable from a broken one (the
 * screen's own stated rule, applied to the new section); Lender Price's decline text is rendered
 * VERBATIM, because that sentence becomes the rule's decline reason; and accepting re-reads the
 * differences queue, since a new rule can change what disagrees.
 *
 * PURE + OFFLINE: reads the source. No DB, no network, no browser. The server side of this loop is
 * covered by the rule-store suites; this covers the surface that was missing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass += 1; } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Strip comments before every "must not appear" test: the code that avoids a trap necessarily NAMES it
// while explaining why, and a guard that read comments would fail on its own explanation.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const screen = read('app-v2/src/longterm/LtPpe.jsx');
const screenCode = codeOf(screen);
const api = read('app-v2/src/longterm/api.js');
const apiCode = codeOf(api);
const routes = read('src/longterm/routes/ppe.js');

console.log('LT PPE — the suggested-rule review screen (P8)\n');

// ── the API surface exists and points at the real routes ──────────────────────────────────────────
for (const [fn, route] of [
  ['ppeSuggestions', '/ppe/suggestions'],
  ['ppeAcceptSuggestion', '/accept'],
  ['ppeDismissSuggestion', '/dismiss'],
]) {
  ok(apiCode.includes(fn), `api exposes ${fn}`);
  ok(apiCode.includes(route), `…pointing at ${route}`);
}
// The routes it calls must actually be mounted — an api method aimed at a path nobody serves fails at
// runtime with a 404 that reads like a permissions problem.
ok(/router\.get\('\/suggestions'/.test(routes), 'the server mounts GET /suggestions');
ok(/router\.post\('\/suggestions\/:id\/accept'/.test(routes), '…POST /suggestions/:id/accept');
ok(/router\.post\('\/suggestions\/:id\/dismiss'/.test(routes), '…POST /suggestions/:id/dismiss');
ok(/requirePpeAdmin, wrap\(acceptSuggestionRoute/.test(routes),
  'accept is admin-gated on the SERVER — the screen never decides who may write a rule');

// ── TRAP 1: the list is never filtered by the investor picker's code ──────────────────────────────
ok(/ppeSuggestions\(\{\s*status:\s*'open'\s*\}\)/.test(screenCode),
  'the screen asks for OPEN suggestions and passes no investor filter');
ok(!/ppeSuggestions\(\s*\{[^}]*investor/.test(screenCode),
  'TRAP 1: it never passes the picker\'s investor code — that filters on Lender Price\'s label and would silently show nothing');
ok(/investor_label/.test(screenCode),
  '…and every row names its own investor instead, so nothing is hidden by a filter');

// ── TRAP 2: a read failure is stated, never rendered as an empty queue ────────────────────────────
ok(/setSugError\(/.test(screenCode), 'a failed read sets an error to show');
ok(!/ppeSuggestions[\s\S]{0,400}?catch\(\(\)\s*=>\s*set\w*\(\[\]\)\)/.test(screenCode),
  'TRAP 2: the fetch never falls back to an empty list, which would read as "nothing is waiting"');
ok(/sugError && /.test(screenCode), '…and the error is rendered');
ok(/!sugError/.test(screenCode),
  '…and the "nothing is waiting" line is suppressed while an error stands, so the two can never both show');

// ── the unmappable case is labelled, and its buttons are still shown ──────────────────────────────
ok(/needs_human/.test(screenCode), 'an unmappable suggestion is recognised');
ok(/needs a person to map it/.test(screen), '…and labelled in plain words');
ok(!/needs_human\s*&&\s*null/.test(screenCode) && !/disabled=\{[^}]*needs_human/.test(screenCode),
  'its Accept button is NOT hidden or disabled — the server refuses it and says why, and a hidden button is indistinguishable from a broken one');

// ── Lender Price's own words, and the loop closing ────────────────────────────────────────────────
ok(/decline_reason/.test(screenCode),
  'the decline reason is rendered VERBATIM — that sentence becomes the rule\'s own reason');
ok(/decideSuggestion[\s\S]{0,900}loadQueue\(\)/.test(screenCode),
  'accepting re-reads the differences queue — a new rule can change what disagrees, so the picture beside it must not go stale');
ok(/loadSuggestions\(\)/.test(screenCode), '…and re-reads the suggestions themselves');

// ── the house colour rule (a `--ink*` token is a LIGHT paper colour here) ─────────────────────────
ok(!/color:\s*['"]?var\(--ink/.test(screen),
  'no text colour reads a --ink* token — every one of them is a LIGHT paper colour in this palette');

// ── separation: Long-Term may not import RTL code ─────────────────────────────────────────────────
ok(!/from ['"]\.\.\/lib\//.test(screenCode) && !/from ['"]\.\.\/components\//.test(screenCode),
  'the screen imports nothing from the RTL folders (the product-separation rule)');

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
