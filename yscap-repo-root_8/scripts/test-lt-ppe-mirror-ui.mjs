#!/usr/bin/env node
/**
 * LT — THE LENDER PRICE MIRROR: the wire that was missing (owner directive 2026-08-18, §2.87).
 *
 * THE OWNER'S PIVOT, in their own words:
 *   "we wanna set up our system as a mirror … our systems should mirror everything Lender Price had is
 *    populating on the scenario … we should have the eligibility the ineligibility should be able to
 *    filter by investor … only for staff users. We can search in our system. It searches on Lender
 *    Price that mirrors everything, and it comes back."
 *
 * ⛔ WHAT WAS ACTUALLY MISSING WAS NOT AN INTEGRATION. `POST /api/lt/dscr/price` and the disqualify
 * poll have been shipping, staff-gated, since the pricer was built. `LT-ROUTES-UNREACHED.md` recorded,
 * in the repo's own words, that the price route was *"used by the offline measurement scripts and by
 * hand"* — and `app-v2/src/longterm/api.js` carried exactly ONE `/dscr` method, the field manifest.
 * The scenario screen drew a full manifest-driven form and then rendered the scenario as JSON. It had
 * no submit. The mirror was a missing wire, not a missing feature.
 *
 * WHAT THIS SUITE PINS:
 *   A. the client can reach the routes, and those routes are really mounted;
 *   B. a search is a DELIBERATE act — never fired from an effect, because each one is a paid call;
 *   C. the ineligible side is POLLED by search key, never re-searched (a second search is a second
 *      bill and a different answer);
 *   D. filtering is client-side and never hides how much it filtered;
 *   E. the vendor's own confirmation of the scenario (§2.86) is shown, INCLUDING when it disagrees —
 *      a mirror that only renders agreement is a mirror that lies;
 *   F. the ledger no longer claims these routes are unreachable.
 *
 * PURE + OFFLINE: reads the source. No DB, no network, no browser.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass += 1; } else { fails.push(m); console.log(`  ✗ ${m}`); } };
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Strip comments before every "must not appear" test: the code that avoids a trap NAMES it while
// explaining why, and a guard that read comments would fail on its own explanation.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const api = read('app-v2/src/longterm/api.js');
const apiCode = codeOf(api);
const screen = read('app-v2/src/longterm/LtScenarioEntry.jsx');
const screenCode = codeOf(screen);
const routes = read('src/longterm/routes/dscr-pricer.js');
const ledger = read('docs/longterm/LT-ROUTES-UNREACHED.md');

console.log('LT — the Lender Price mirror\n');

// ── A: the client reaches routes that are really mounted ──────────────────────────────────────────
ok(apiCode.includes('dscrPrice'), 'the client exposes dscrPrice');
ok(apiCode.includes('dscrDisqualifications'), 'the client exposes dscrDisqualifications');
ok(/dscrPrice[\s\S]{0,160}\/dscr\/price/.test(apiCode), 'dscrPrice points at /dscr/price');
ok(/dscrDisqualifications[\s\S]{0,320}\/dscr\/disqualifications/.test(apiCode), 'dscrDisqualifications points at /dscr/disqualifications');
// An api method aimed at a path nobody serves fails at runtime and passes every source test, so the
// route registrations are checked too.
ok(/router\.post\('\/price'/.test(routes), 'the server really mounts POST /price');
ok(/router\.get\('\/disqualifications\/:searchKey'/.test(routes), 'the server really mounts GET /disqualifications/:searchKey');
ok(/dscrPrice/.test(screenCode), 'the screen calls dscrPrice');
ok(/dscrDisqualifications/.test(screenCode), 'the screen calls dscrDisqualifications');

// ── B: a paid call is never fired by rendering ────────────────────────────────────────────────────
// The screen fetches the manifest in an effect (free, server-side). It must NEVER fetch a PRICE that
// way: every mounted screen would bill us. So the price call may appear only inside a callback.
const effects = [...screenCode.matchAll(/useEffect\(([\s\S]*?)\n  \}, \[/g)].map((m) => m[1]);
ok(effects.length > 0, `the screen has ${effects.length} effect(s) to check`);
ok(effects.every((e) => !/dscrPrice/.test(e)), 'NO effect calls dscrPrice — a search is never fired by rendering');
ok(effects.every((e) => !/dscrDisqualifications/.test(e)), 'and no effect polls the declines either');
ok(/const runSearch = useCallback\(/.test(screenCode), 'the search lives in a callback');
ok(/onClick=\{runSearch\}/.test(screenCode), '…which is bound to a button the human presses');
ok(/disabled=\{searching/.test(screenCode), 'the button disables while a search is in flight — no double billing');
ok(/statedKeys\.length === 0/.test(screenCode), '…and refuses an empty scenario rather than paying to price nothing');

// ── C: the declines are POLLED by key, never re-searched ──────────────────────────────────────────
ok(/r\.searchKey/.test(screenCode), 'the screen keeps the searchKey the price handed back');
ok(/dscrDisqualifications\(key\)/.test(screenCode), '…and polls by THAT key');
// The decisive one: the poll loop must not call the price route again. Re-searching to get declines
// would be a second paid call AND a different search key, so the declines would belong to another
// search than the prices shown beside them.
const loop = (screenCode.match(/for \(let attempt[\s\S]*?\n      \}/) || [''])[0];
ok(loop.length > 0, 'the poll loop is present');
ok(!/dscrPrice/.test(loop), 'the poll loop NEVER re-prices — the declines belong to the same search as the prices');
ok(/409/.test(screenCode), 'an expired search key (409) is handled distinctly from "still computing"');

// ── D: filtering never hides how much it filtered ─────────────────────────────────────────────────
ok(/investorFilter/.test(screenCode), 'there is an investor/program filter');
ok(/programs\.length\}/.test(screenCode) && /result\.programs \|\| \[\]\)\.length/.test(screenCode),
  'the filtered count is shown ALONGSIDE the unfiltered total — a filter can never read as "this is all there was"');
ok(/No program matches that filter/.test(screen) && /priced nothing for this scenario/.test(screen),
  '"nothing matched your filter" and "Lender Price priced nothing" are DIFFERENT sentences');
// Filtering must not re-price. A filter that re-ran the search would bill per keystroke.
const filterMemo = (screenCode.match(/const programs = useMemo\([\s\S]*?\n  \}, \[/) || [''])[0];
ok(filterMemo.length > 0 && !/dscrPrice/.test(filterMemo), 'filtering is client-side over what came back — it never re-prices');

// ── E: the vendor's own verdict is shown, including when it disagrees ─────────────────────────────
ok(/result\.understood/.test(screenCode), 'the screen renders the vendor\'s confirmation of the scenario');
// ⛔ ASSERT THE GUARD, NOT THE NAME. A first cut of this checked only that `understood.mismatched`
// appeared somewhere — which stayed true when the whole block was disabled, because the name still
// occurred inside the (now unreachable) table body. A mutation that hid every mismatch passed. So the
// RENDER CONDITION and the row mapping are asserted separately.
ok(/understood\.mismatched && result\.understood\.mismatched\.length > 0 && \(/.test(screenCode),
  '…including the MISMATCHES — the block is rendered whenever there ARE any');
ok(/understood\.mismatched\.map\(/.test(screenCode), '…and every mismatch becomes a row, not a count');
ok(/you asked for/.test(screen) && /they ran/.test(screen), '…as a side-by-side of what was asked and what was run');
ok(/notEchoed/.test(screenCode), 'a field the vendor did not echo back is surfaced');
ok(/unconfirmed rather than agreed/.test(screen),
  '…and named as UNCONFIRMED, never folded into the agreed count — "nobody looked" must not read as "everything matched"');
ok(/did not state the search it ran/.test(screen), 'an absent echo is its own message, not silence');
// The server must actually compute it, or the screen renders undefined forever.
ok(/understood: understoodOf\(/.test(routes), 'the price route really computes the verdict');
ok((routes.match(/understood: understoodOf\(/g) || []).length === 2,
  '…on BOTH response branches (full and plain) — a caller must not get it only when it asks for `full`');
ok(/catch \(e\)[\s\S]{0,220}the echo check could not run/.test(routes),
  'and the verdict is best-effort: a diagnostic that could break a quote would be worse than the blind spot it closes');

// ── F: the ledger no longer overstates what is unreachable ────────────────────────────────────────
ok(!/\| `POST \/api\/lt\/dscr\/price`/.test(ledger), 'the ledger no longer claims POST /dscr/price is unreachable');
ok(!/\| `GET \/api\/lt\/dscr\/disqualifications\/:searchKey`/.test(ledger),
  '…nor the GET poll the screen now uses');
// The rows that REMAIN must say why they remain, not merely persist.
ok(/POST \/api\/lt\/dscr\/disqualify`[\s\S]{0,400}second kickoff/.test(ledger),
  'the blocking kickoff row states why a screen does not call it');
ok(/POST \/api\/lt\/dscr\/disqualifications`[\s\S]{0,300}GET form/.test(ledger),
  'the POST-poll row states that the screen uses the GET form instead');

// ── the house rules this screen already lived under, re-checked on the new markup ──────────────────
ok(!/--ink/.test(screenCode), 'no --ink token is used as a text colour (they are LIGHT paper colours here)');
ok(!/window\.(alert|confirm|prompt)\(/.test(screenCode), 'no window.alert/confirm/prompt');
ok((screenCode.match(/overflowX: 'auto'/g) || []).length >= 4,
  'every wide block scrolls in its own container, so the page never scrolls sideways');

console.log(`\n${fails.length ? `${fails.length} FAILED (${pass} passed)` : `OFFLINE: all passed (${pass} passed, 0 failed)`}`);
process.exit(fails.length ? 1 : 0);
