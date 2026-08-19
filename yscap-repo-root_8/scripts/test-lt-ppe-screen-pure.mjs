#!/usr/bin/env node
/**
 * The LT Pricing-engine screen (`app-v2/src/longterm/LtPpe.jsx`) — structural guards.
 *
 * A GREEN VITE BUILD DOES NOT MEAN THE PAGE RENDERS. esbuild treats an undeclared
 * identifier as a global and emits it verbatim, so a component reading a variable
 * nobody passed it builds cleanly and throws `ReferenceError` at render — which the
 * ErrorBoundary turns into the full-screen "Something went wrong". This file guards
 * the classes a build cannot catch:
 *
 *   • every API method the screen calls actually EXISTS on the LT client, and every
 *     path it hits starts /api/lt/ (the one rule that keeps the two products apart);
 *   • the screen is REACHABLE — routed and in the nav (an unrouted screen is the
 *     same bug as an unmounted router);
 *   • no `--ink*` token is used as a text colour. Those tokens are LIGHT paper
 *     colours in this palette, so `color: var(--ink)` renders white-on-white. This
 *     has shipped before, on a whole card;
 *   • the browser's own dialogs are never used (the repo's three guards), AND no RTL/shared
 *     module is imported — the separation gate refused the shared dialog helper, which is
 *     why a finding is settled with an inline form rather than a modal;
 *   • the screen does NOT re-sort the findings. The server's review queue owns
 *     severity and ordering; a second ordering here would be a second definition of
 *     "what to work on first", and the two would drift.
 *
 * Pure: reads source. No DOM, no build, no network.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCREEN = 'app-v2/src/longterm/LtPpe.jsx';
const src = read(SCREEN);
const api = read('app-v2/src/longterm/api.js');
const app = read('app-v2/src/App.jsx');
const layout = read('app-v2/src/components/StaffLayout.jsx');

console.log('LT pricing-engine screen — structural guards');

// ---------------------------------------------------------------------------
// 1) every ltApi.* the screen calls exists, and is an LT path
// ---------------------------------------------------------------------------
{
  const called = [...new Set([...src.matchAll(/ltApi\.([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  ok(called.length > 0, `the screen calls the LT client (${called.length} methods)`);
  for (const m of called) {
    ok(new RegExp(`^\\s*${m}[:(]`, 'm').test(api), `API-${m} exists on ltApi (a missing one builds fine and throws at render)`);
  }
  // Same class, one module over: a named import that the module does not actually EXPORT builds
  // cleanly and arrives as `undefined`, then throws "x is not a function" the first time a row is
  // drawn — which the ErrorBoundary turns into the full-screen "Something went wrong".
  {
    const fmt = read('app-v2/src/longterm/format.js');
    const imported = (/import\s*\{([^}]+)\}\s*from\s*'\.\/format\.js'/.exec(src) || [, ''])[1]
      .split(',').map((s) => s.trim()).filter(Boolean);
    ok(imported.length > 0, 'API-fmt the screen takes its formatting from the shared module');
    for (const name of imported) {
      ok(new RegExp(`export const ${name}\\b`).test(fmt), `API-fmt-${name} format.js really exports ${name}`);
    }
  }
  // and every ppe method routes through the /api/lt prefix helper
  const ppeLines = api.split('\n').filter((l) => /^\s*ppe[A-Z]/.test(l) || /ppe[A-Z][a-zA-Z]*\(/.test(l));
  ok(ppeLines.length > 0, 'the client defines the ppe methods');
  const bad = ppeLines.filter((l) => /lt\(/.test(l) === false && /ltGet|ltPost|ltPut|ltPatch|ltDel/.test(l));
  ok(bad.length === 0, `every ppe call goes through the lt() prefix — never a bare path (${bad.length} offenders)`);
  ok(!/\/api\/(?!lt)/.test(api), 'the LT client names no non-LT endpoint');
}

// ---------------------------------------------------------------------------
// 2) the screen is reachable
// ---------------------------------------------------------------------------
ok(/import\s+LtPpe\s+from\s+'\.\/longterm\/LtPpe\.jsx'/.test(app), 'ROUTE-1 App.jsx imports the screen');
ok(/path="\/internal\/lt\/ppe"[^>]*element=\{<StaffPrivate><LtPpe\s*\/><\/StaffPrivate>\}/.test(app),
  'ROUTE-2 …and routes it at /internal/lt/ppe behind StaffPrivate');
ok(/to="\/internal\/lt\/ppe"/.test(layout), 'ROUTE-3 …and the long-term nav links to it (an unlinked screen is unreachable)');
{
  // it must sit in the LONG-TERM nav block, not the RTL one
  const ltBlock = layout.slice(layout.indexOf('<div className="sb-sec">Long-term</div>'), layout.indexOf('<div className="sb-sec">Main</div>'));
  ok(ltBlock.includes('/internal/lt/ppe'), 'ROUTE-4 …inside the long-term nav block specifically');
}

// ---------------------------------------------------------------------------
// 3) THE WHITE-ON-WHITE TRAP: --ink* is a LIGHT paper colour here
// ---------------------------------------------------------------------------
{
  const inkAsText = [...src.matchAll(/color:\s*['"]?var\(--ink[^)]*\)/g)].map((m) => m[0]);
  ok(inkAsText.length === 0, `INK-1 no --ink* token is used as a text colour (${inkAsText.join(', ') || 'none'})`);
  // The dark values are PINNED — the screen never inherits a colour it cannot name. They moved out
  // of this file into ppeStyles.js when the rate-sheet console arrived, so that both PPE screens draw
  // from one definition rather than two that drift; the RULE is unchanged, so the guard follows the
  // definition rather than being deleted. Both files are checked for the --ink trap above and below.
  const tokens = read('app-v2/src/longterm/ppeStyles.js');
  ok(/export const INK = '#141B22'/.test(tokens), 'INK-2 the shared tokens pin an explicit dark ink');
  ok(/#4B585C/.test(tokens), 'INK-3 …and an explicit dark muted for secondary text');
  ok(/from '\.\/ppeStyles\.js'/.test(src), 'INK-3a …and this screen takes its colours from them, not from a second copy');
  const tokenInkAsText = [...tokens.matchAll(/color:\s*['"]?var\(--ink[^)]*\)/g)].map((m) => m[0]);
  ok(tokenInkAsText.length === 0, `INK-3b no --ink* token is used as a text colour in the shared tokens either (${tokenInkAsText.join(', ') || 'none'})`);
}

// ---------------------------------------------------------------------------
// 4) SEPARATION + dialogs: Long-Term imports no RTL code, and never the browser's
//    own dialogs either. The shared dialog helper lives in RTL's folders, so the
//    separation gate refuses it — which is why this screen settles a finding with
//    an INLINE form rather than a modal. Both halves are guarded, because the
//    tempting "fix" for the gate is to reach for window.prompt instead.
// ---------------------------------------------------------------------------
{
  const stripped = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/\balert\(/.test(stripped), 'DIALOG-1 no window.alert (it stamps the hosting hostname on our own message)');
  ok(!/window\.confirm\(/.test(stripped), 'DIALOG-2 no window.confirm');
  ok(!/window\.prompt\(/.test(stripped), 'DIALOG-3 no window.prompt');
  // no RTL import of ANY kind — the gate says so too, but a screen-level assertion
  // names the file when it regresses instead of pointing at the whole product
  const rtlImports = [...src.matchAll(/from\s+'\.\.\/(?!longterm\/)[^']+'/g)].map((m) => m[0]);
  ok(rtlImports.length === 0,
    `SEP-1 the screen imports no RTL/shared module (${rtlImports.join(', ') || 'none'})`);
  ok(/rowError/.test(src) && /<textarea/.test(src),
    'SEP-2 …and settles a finding with an inline reason form, so it needs no shared dialog');
}

// ---------------------------------------------------------------------------
// 5) the screen does not re-rank what the server ordered
// ---------------------------------------------------------------------------
{
  ok(!/\.sort\(/.test(src), 'ORDER-1 the screen never sorts — the server\'s review queue owns the order');
  ok(/queue\.items/.test(src), 'ORDER-2 …it renders the server\'s own items array');
  ok(/truncated/.test(src), 'ORDER-3 …and surfaces the truncation flag (no silent cap on screen either)');
}

// ---------------------------------------------------------------------------
// 6) honesty: the states the server distinguishes are shown as different things
// ---------------------------------------------------------------------------
{
  ok(/configured === false/.test(src) && /configured === null/.test(src),
    'HONEST-1 "nothing is set up" and "we could not read the database" render differently');
  ok(/canaryAgreementRate == null/.test(src) || /not measured yet/.test(src),
    'HONEST-2 an unmeasured agreement rate says so rather than showing 0%');
  // The modal is gone, so the cancel-vs-empty distinction it needed is gone with
  // it. What replaced it is the per-ROW concern: two findings must never share a
  // half-typed reason or a refusal, or somebody settles one row on another's note.
  ok(/rowError\[it\.key\]/.test(src) && /setRowError/.test(src),
    'HONEST-3 a refusal is held per finding key, so one row\'s refusal never appears on another');
  ok(/settling === it\.key/.test(src),
    'HONEST-3b …and only the row being settled shows the form (one reason box, never two)');
  ok(/e\.message/.test(src), 'HONEST-4 a refusal shows the SERVER\'s wording, which names the rule that was broken');
}

// ---------------------------------------------------------------------------
// 7) WHERE it disagrees (P9) — the per-band trend, and the four ways this
//    particular screen could lie about it
// ---------------------------------------------------------------------------
{
  // COMMENTS ARE STRIPPED FIRST. A guard that matches a name can be satisfied by the prose that
  // explains the rule — so deleting the behaviour and leaving the comment keeps the test green,
  // which is how a test comes to protect a paragraph instead of a screen. Two of these guards were
  // written that way and were caught by mutating the code they claimed to hold: `parity.series`
  // still matched inside `parity.seriesTruncated`, and `daysMeasured`/`windowDays` still matched
  // elsewhere on the row. Both are pinned to their composed FORM below for that reason.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok(/ltApi\.ppeParityCells\(/.test(code), 'P9-1 the screen reads the per-band series');
  ok(/ppeParityCells\(/.test(api), 'P9-2 …through a reader that exists on the LT client');

  // (a) THE EMPTY-VIEW LIE. The series is keyed EXACTLY on (investor, program) as the canary wrote
  //     it, so asking for a key nobody wrote returns an empty list — which drawn as "nothing has
  //     been measured" is indistinguishable from a clean book. The picker is built from the
  //     server's OWN series list, and an empty view names the series that do hold rows.
  ok(/Array\.isArray\(parity\.series\)\s*\?\s*parity\.series/.test(code),
    'P9-3 the series picker is fed by the server\'s own list, never a key this screen invented');
  ok(/paritySeries\.filter\(/.test(code) && /<option/.test(code),
    'P9-3a …and that list is what the picker\'s options are drawn from');
  ok(/otherSeries\.length > 0/.test(code) && /Measurements do exist elsewhere/.test(code),
    'P9-4 …and an empty view names the series that DO hold measurements');
  ok(/\{parity\.note \|\|/.test(code), 'P9-5 …with the server\'s own wording for an empty window');
  ok(/Runs recorded against no investor/.test(code),
    'P9-6 …and the default series is named for what it is, never as "everything"');

  // (b) THE GAP LIE. A cell measured on 2 of 30 days has a direction computed from two points, and
  //     showing that beside one measured on all 30 as though they weigh the same is how a dashboard
  //     talks somebody into a cutover.
  ok(/row\.daysMeasured\}\$\{row\.windowDays \? ` of \$\{row\.windowDays\}`/.test(code),
    'P9-7 days measured is shown AGAINST the window asked about, in one figure');
  ok(/row\.daysWithDisagreement\} of \$\{?row\.daysMeasured/.test(code)
    || /\{row\.daysWithDisagreement\} of \{row\.daysMeasured\}/.test(code),
    'P9-8 …and how many of those days it actually disagreed on, against the same denominator');

  // (c) THE ZERO-FILL LIE. A day with no loans in a band is an absence of evidence about that band.
  //     Only measured days may be drawn, and an unmeasured rate is a dash, never 0%.
  ok(/\(cellHist\.days \|\| \[\]\)\.map\(/.test(code),
    'P9-9 the day-by-day view renders only the days the server returned — no filled-in gaps');
  ok(/row\.latestAgreementRate == null/.test(code),
    'P9-10 …and an unmeasured rate says so rather than being drawn as zero');
  ok(/rate\(d\.agreementRate\)/.test(code),
    'P9-11 …each day through the shared rate helper, which dashes a non-finite rate');

  // (d) THE UNITS LIE. Parity gaps are canonical integer MILLI-points; printing the raw number
  //     reports a 1.25-point gap as "1250", which on a rate sheet reads as a catastrophe.
  ok(/const points = \(milli\)/.test(code), 'P9-12 a price gap is converted out of milli before it is shown');
  ok(/milli \/ 1000/.test(code), 'P9-13 …by the thousand, which is what a milli-point is');
  ok(/points\(row\.worstAbsMilli\)/.test(code), 'P9-14 …and the worst gap goes through it, never raw');
}

// ---------------------------------------------------------------------------
// 8) What each sheet is compared AGAINST (db/574) — the scope editor
// ---------------------------------------------------------------------------
{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok(/ltApi\.ppePrograms\(\)/.test(code), 'SCOPE-1 the screen lists the programs');
  ok(/ltApi\.ppeSetProgramLpScope\(/.test(code), 'SCOPE-2 …and can write a scope');

  // AN UNSCOPED PROGRAM IS THE POINT OF THE LIST. Its comparison stands down, which on the findings
  // list above is indistinguishable from two engines agreeing — so it is shown, flagged, and never
  // filtered out of the list that exists to find it.
  ok(/programs\.programs\.map\(/.test(code),
    'SCOPE-3 every program is listed — never filtered to the scoped ones, which are the ones that need nothing');
  ok(/not scoped — its comparison stands down/.test(code),
    'SCOPE-4 …and an unscoped one says what that MEANS, not just that a field is empty');
  ok(/programs\.note/.test(code), 'SCOPE-5 …with the server\'s own count of how many are unscoped');

  // CLEARING IS EXPLICIT. The server refuses a body with no `scope` key rather than reading it as
  // "clear it", because clearing turns every future comparison into an abstention.
  ok(/clear \? null :/.test(code), 'SCOPE-6 clearing sends an explicit null, never an absent key');
  ok(/Clear it — stand the comparison down/.test(code), 'SCOPE-7 …and the button says what clearing does');

  // THE SILENT FAILURE THE PREVIEW ANSWERS: a pattern one character wrong matches nothing and
  // abstains politely forever. Zero matches must be CALLED OUT, never drawn as an empty list.
  ok(/preview\.matched\.length === 0/.test(code),
    'SCOPE-8 a scope that picks nothing is called out rather than shown as an empty list');
  ok(/lpProgramNames/.test(code), 'SCOPE-9 …from names the person pasted, checked by the server that stored it');

  // The write is admin-only on the server; this screen shows the control anyway and surfaces the
  // refusal per row — a hidden button is indistinguishable from a broken one.
  ok(/scopeRowError\[p\.id\]/.test(code), 'SCOPE-10 a refusal is held per program, never shown on another row');
}

// ---------------------------------------------------------------------------
// 9) A finding says WHY, on the row — not only THAT the two disagreed
// ---------------------------------------------------------------------------
{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The façade diagnoses every disagreement at the moment it is found and stores the explanation on
  // the row (`diff.explanation`). Storing it and never drawing it is the same defect one layer up.
  ok(/it\.diff && it\.diff\.explanation && it\.diff\.explanation\.summary/.test(code),
    'WHY-1 the finding row renders the stored explanation');
  // A row recorded before this existed carries none, and must render as it always did rather than as
  // a blank line or a crash — which is what the composed guard above is pinned to.
  ok(/it\.diff\.explanation\.confidence !== 'none'/.test(code),
    'WHY-2 …and the confidence is shown only when there IS one — an unranked guess is not labelled');
  ok(/a place to look, not a verdict/.test(code),
    'WHY-3 …worded as a hypothesis, because Lender Price publishes no breakdown of its own');
}

// ---------------------------------------------------------------------------
// 10) §2.126 — a row nobody can read must SAY SO on the row
// ---------------------------------------------------------------------------
{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Every other thing on a finding row is a confident statement — the severity pill, the age, the
  // "seen 4×" count. A row filed by an engine wiring that has since been corrected earns none of them,
  // and before this it looked exactly like a measured one.
  ok(/it\.unreadable && <Pill/.test(code), 'STAMP-1 an unreadable finding is badged on the row');
  ok(/cannot be read/.test(code), 'STAMP-2 …in words, not a colour');
  ok(/it\.unreadableReason/.test(code), 'STAMP-3 …and the row says WHY it cannot be read');
  ok(/Run the comparison again/.test(code) && /decide it here/.test(code),
    'STAMP-4 …and names both remedies, so the badge is never a dead end');

  // ⛔ THE SCREEN MUST NOT DECIDE THIS ITSELF. `finding.measuredByCurrentLeg` is the one definition of
  // "measured by today's engine", and it is the same one the go-live gate and the ledger use. A version
  // comparison written in JSX would be a second definition that drifts the first time the stamp moves —
  // and the screen would then disagree with the gate about which rows count.
  ok(!/legVersion\s*[=!]==/.test(code) && !/LEG_VERSION/.test(code),
    'STAMP-5 the screen never compares engine-wiring stamps itself — the server already answered');
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
