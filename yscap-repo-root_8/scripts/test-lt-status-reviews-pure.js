'use strict';
/**
 * LT test — THE STATUS DISAGREEMENTS HAVE A SCREEN, AND GOLD IS NOT A TEXT COLOUR.
 *
 * PART ONE. Owner-directed 2026-08-24: *"You can open up a general sync review …
 * That should have every Encompass status that does not match with ClickUp status,
 * which means that we need to go and maybe update Encompass, or we need to go
 * manually and update ClickUp."* `GET /api/lt/clickup/status-reviews` was built,
 * scoped and serving rows — and NOTHING RENDERED THEM. The answer existed and no
 * one could reach it. A back end is not a feature.
 *
 * PILOT MUST NOT SETTLE THESE. A disagreement means either Encompass is behind or
 * somebody moved the ClickUp card by hand, and nothing on our side can tell which
 * — both are decisions about the LOAN. So the screen reports and stops, and this
 * suite fails if it ever grows a button that picks a side.
 *
 * PART TWO — A MEASURED RULE, not a preference. The brand gold #AE8746 is 2.98:1
 * on this paper: under AA for body text (4.5:1) and under even the large-text bar
 * (3:1). It was being used for WORDS in four places across the long-term screens,
 * and the new work added more. GOLD_TEXT (#8A6A22, 4.55:1) still reads
 * unmistakably as gold. The brand gold stays for rules, dots, borders and fills,
 * where the text rule does not apply.
 *
 * PURE. Reads source. No database, no network, no browser.
 */

const path = require('path');
const fs = require('fs');
const { stripComments, stripToProse } = require('./lib/strip-comments.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** THE SHARED stripper, not the two-line regex this file used to carry. That idiom
 *  removes BLOCK comments FIRST, so it cannot tell that a `/*` it found is sitting
 *  inside a LINE comment — and line 3 of `app-v2/src/longterm/api.js` is prose
 *  containing `/api/lt/*`. The day a real block comment was added 282 lines below
 *  it, that stray slash-star opened a "comment" running to the new closing marker
 *  and ate 19,048 of the file's 20,012 characters, so `clickupStatusReviews` — in
 *  the file, in plain sight — read as ABSENT and this suite failed on it. The
 *  direction that is worse: a "must NOT appear" assertion PASSES over a file the
 *  stripper swallowed. See `scripts/lib/strip-comments.js`. */
const code = (p) => stripComments(read(p));
/** JSX wraps prose at whatever column it lands on, so a sentence a person reads as
 *  one line is "card by\n        hand" in the source. Every assertion about WORDING
 *  runs on this, or it tests the line width rather than the sentence. */
const prose = (p) => stripToProse(read(p));

// ── 1. The screen exists, is reachable, and asks the real route ──────────────
console.log('the disagreement list is on a screen somebody can open');

const screen = code('app-v2/src/longterm/LtStatusReviews.jsx');
const app = code('app-v2/src/App.jsx');
const shell = code('app-v2/src/components/StaffLayout.jsx');
const api = code('app-v2/src/longterm/api.js');
const route = code('src/longterm/routes/clickup.js');

check(screen.length > 500, 'the screen is there');
check(/import LtStatusReviews/.test(app) && /path="\/internal\/lt\/status-reviews"/.test(app),
  'and it is ROUTED — a screen nothing routes to is the same as no screen');
check(/to="\/internal\/lt\/status-reviews"/.test(shell),
  'and it is in the long-term nav, so it can be found without knowing the address');
check(/clickupStatusReviews: \(limit\) =>/.test(api), 'the client has a call for it');
check(/\/clickup\/status-reviews/.test(api) && /router\.get\('\/status-reviews'/.test(route),
  'pointed at the route that actually exists');
check(/ltApi\.clickupStatusReviews\(\)/.test(screen), 'and the screen calls it');

// ── 2. It reports; it never decides ─────────────────────────────────────────
console.log('PILOT reports these and never settles one itself');

check(!/ltPost|ltPut|ltDel|approve|reject/.test(screen),
  'the screen posts NOTHING — a button that quietly picked a side would be PILOT deciding a question about the loan');
const screenProse = prose('app-v2/src/longterm/LtStatusReviews.jsx');
check(/does not settle these on its own/.test(screenProse),
  'and it says so in words, so nobody waits for it to');
check(/move the ClickUp card by hand/.test(screenProse)
  && /the milestone in Encompass needs correcting/.test(screenProse),
'naming both of the two real fixes — a report with no next step is half an answer');

// ── 3. Nothing is silently dropped ──────────────────────────────────────────
console.log('a truncated list says it was truncated');
check(/data\.truncated &&/.test(screen), 'the cap is surfaced, never silent');
check(/rows\.length === 0 \?/.test(screen), 'and an EMPTY list says what empty means');
check(/what we have seen, not a fresh comparison/.test(screenProse),
  'including the honest limit — this is what PILOT has observed, not a live sweep of the whole book');

// ── 4. The measured colour rule, across every long-term screen ──────────────
console.log('the brand gold never carries a word');

const dir = path.join(__dirname, '..', 'app-v2/src/longterm');
const files = fs.readdirSync(dir).filter((f) => /\.(jsx|js)$/.test(f));
check(files.length > 10, `every long-term screen is scanned (${files.length} files)`);
for (const f of files) {
  const src = code(`app-v2/src/longterm/${f}`);
  // `color:` followed by the brand gold, or by a bare GOLD identifier.
  const bad = (src.match(/color:\s*(['"]#AE8746['"]|GOLD\b(?!_))/g) || []).length;
  check(bad === 0, `${f}: the brand gold is not used as a text colour${bad ? ` (${bad} use${bad === 1 ? '' : 's'})` : ''}`);
}
const styles = read('app-v2/src/longterm/ppeStyles.js');
check(/export const GOLD_TEXT = '#8A6A22';/.test(styles),
  'and there IS one shared darker gold to reach for instead');
check(/2\.98/.test(styles) && /4\.55/.test(styles),
  'with the measurement written beside it, so the next person does not have to re-derive it');

const css = read('app-v2/src/styles.css');
check(!/\.lt-(utter \.lt-now|fact \.v\.gold)\{[^}]*color:#AE8746/.test(css),
  'the file screen\'s big name and its loan number use the readable gold too');

console.log(failures ? `\n${failures} FAILED` : '\nlt status reviews (pure): all checks passed');
process.exit(failures ? 1 : 0);
