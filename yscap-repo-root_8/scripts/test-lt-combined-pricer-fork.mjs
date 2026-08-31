// LONG-TERM — THE COMBINED PRICING ENGINE IS A SECOND ENGINE, NOT A CHANGE TO THE FIRST.
//
// THE OWNER'S INSTRUCTION, 2026-08-30, twice and in these words:
//
//   "Don't touch our current setup that we currently have: our General Pricing Engine. Just make
//    this totally separate, but copy everything from the General Pricing Engine and add this as it
//    is… I am going to test the system that works on both together: Lender Price and LoanNEX. If
//    it's going to be good, then I am going to merge everything into the General Pricing Engine
//    and bring in the features of this one."
//
//   "Merge this live into domain only for super admin to be able to see it and super admin to be
//    able to test it… so I can audit everything before I want to go live to the general pricing
//    engine."
//
// WHAT THIS FILE IS FOR. A copy of a 2,490-line screen is exactly the shape this repository's own
// rules forbid — "one definition, never a second copy" — and it is here anyway because the owner
// asked for a second engine beside the first while they audit it. A copy nobody is watching drifts,
// and the half that drifts is the half somebody prices a loan on. So the copy is WATCHED:
//
//   1. The general engine's screen is FINGERPRINTED at the fork. When it moves, this fails and says
//      to port the change into the copy and re-stamp — so "the general engine changed and the copy
//      did not" is caught by CI rather than found months later on a live board.
//   2. The general engine is asserted to know NOTHING about the combined one — no import, no route,
//      no mention. "Don't touch our current setup" is a property that can be checked, not a promise.
//   3. Every divergence in the copy is MARKED, and the count is pinned, so a ninth one cannot be
//      slipped in without saying so.
//   4. Both new screens are SUPER-ADMIN gated in the nav, and the server's own 404 is proven
//      separately over real HTTP in scripts/test-lt-routes-smoke-db.js.
//
// TO RE-STAMP after porting a general-engine change into the copy:
//   node -e "const f=require('fs'),c=require('crypto');const p='scripts/fixtures/lt-pricer-fork.json';\
//   const j=JSON.parse(f.readFileSync(p));const s=f.readFileSync(j.file,'utf8');\
//   j.sha256=c.createHash('sha256').update(s).digest('hex');j.bytes=Buffer.byteLength(s);\
//   j.lines=s.split('\n').length;f.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
//
// LT-only. No network, no DB, no RTL imports.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const crypto = require('node:crypto');
const stamp = require('../scripts/fixtures/lt-pricer-fork.json');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** A guard that asserts a phrase is ABSENT must not read the comment explaining its absence. */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const general = read('app-v2/src/longterm/LtPricer.jsx');
const fork = read('app-v2/src/longterm/LtCombinedPricer.jsx');
const settings = read('app-v2/src/longterm/LtCombinedSettings.jsx');
const app = read('app-v2/src/App.jsx');
const nav = read('app-v2/src/components/StaffLayout.jsx');
const api = read('app-v2/src/longterm/api.js');

console.log('\nA. the general engine has not moved since the fork');
{
  const sha = crypto.createHash('sha256').update(general).digest('hex');
  ok(sha === stamp.sha256,
    sha === stamp.sha256
      ? `A1 LtPricer.jsx is byte-for-byte what it was when the copy was taken (${stamp.lines} lines)`
      : 'A1 LtPricer.jsx HAS CHANGED since LtCombinedPricer.jsx was forked from it — port the change into the copy (or decide it does not belong there) and re-stamp scripts/fixtures/lt-pricer-fork.json with the command in this file\'s header');
}

console.log('\nB. the general engine knows nothing about the combined one');
{
  const g = codeOf(general);
  ok(!/combined/i.test(g),
    'B1 LtPricer.jsx does not mention the combined engine anywhere in its code — "don\'t touch our current setup" is a property, not a promise');
  ok(/ltApi\.dscrPrice\(/.test(g) && !/ltApi\.combined/.test(g),
    'B2 …and it still prices through its own door and only its own');
  // The api client is SHARED, which is fine — what must not happen is the general engine's four
  // `/dscr` methods being repointed to serve the new one.
  ok(/dscrPrice: \(scenario, opts\) => ltPost\(lt\('\/dscr\/price'\)/.test(api),
    'B3 the general engine\'s price door still posts to /dscr/price — the combined engine got new methods rather than a redirect of the old ones');
  ok(/combinedPrice: \(scenario, opts\) => ltPost\(lt\('\/dscr\/combined\/price'\)/.test(api),
    'B4 …and the combined engine has its own');
}

console.log('\nC. every divergence in the copy is marked, and there are exactly eight');
{
  const marks = fork.match(/FORK \d of 8/g) || [];
  const numbers = new Set(marks.map((m) => m.match(/\d/)[0]));
  ok(numbers.size === 8 && [...numbers].sort().join() === '1,2,3,4,5,6,7,8',
    `C1 the copy carries exactly eight marked divergences, numbered 1-8 (found ${[...numbers].sort().join() || 'none'})`);
  const f = codeOf(fork);
  ok(/ltApi\.combinedPrice\(/.test(f) && !/ltApi\.dscrPrice\(/.test(f),
    'C2 FORK 1 — the copy prices through the COMBINED door and never the general one');
  ok(/stalenessUnknown/.test(f),
    'C3 FORK 2 — staleness has a third state here: LoanNEX states none, and `!!expired` would render "we do not know" as "not expired"');
  ok(/ltApi\.combinedInvestors\(\)/.test(f),
    'C4 FORK 3 — the investor picker\'s roster is every investor the combined engine knows, not Lender Price\'s alone');
  ok(/CombinedPanel/.test(f) && /revealSource: reveal/.test(f),
    'C5 FORK 4 — the copy has the admin\'s "show me where each row came from", which the general engine has no concept of');
  // Match on WHITESPACE-NORMALISED source: this sentence is JSX prose and the
  // line it wraps on is a formatting accident, not a fact about the screen. A
  // guard that breaks when Prettier re-wraps a paragraph teaches people to
  // loosen guards.
  const forkFlat = fork.replace(/\s+/g, ' ');
  ok(/Under audit/.test(forkFlat) && /General Pricing Engine is unchanged/.test(forkFlat),
    'C6 FORK 5 — the screen SAYS what it is, at the top: two pricing screens that look identical is how somebody quotes a borrower off the one still under audit');
  // FORK 6 — the owner's "lay out all the details the same layout no matter which
  // software". THREE assertions, because one screen can carry the block and still
  // name a vendor on it, and naming a vendor on a combined board is the failure.
  const forkFlat6 = fork.replace(/\s+/g, ' ');
  // Scoped to the FUNCTION BODY, not to "everything after the first mention of the
  // name" — the rest of this screen legitimately names a vendor (the investor
  // picker, the admin's source reveal), so a looser scope fails for the wrong
  // reason and gets loosened again until it guards nothing.
  const bodyOf = (src, name) => {
    const m = src.match(new RegExp(`export function ${name}\\(([\\s\\S]*?)\\n(?:export |/\\* ─)`));
    return m ? m[1] : '';
  };
  const buildBody = bodyOf(codeOf(fork), 'PriceBuild');
  ok(buildBody.length > 500 && !/Lender ?Price|LoanNEX/i.test(buildBody),
    `C6b FORK 6 — the price-build panel names NO software (${buildBody.length} chars read): on a board carrying both programs those words are wrong on half the rows and break the one-system rule`);
  ok(/a\.detail/.test(f),
    'C6c FORK 6 — a row prints the grid CELL as well as the grid, which is the actual answer to "why is this price this price"');
  ok(/What the program checked/.test(forkFlat6) && /does not publish the checks behind its answer/.test(forkFlat6),
    'C6d FORK 6 — the eligibility block renders in the SAME place on both sources and SAYS SO when a sheet publishes none, so an absent section is never read as a clean bill of health');
  // FORK 7 — an ABSENCE, which is the one kind of divergence nobody notices. A
  // term sheet is a document a borrower reads, and this engine is still under
  // audit; the day the owner promotes it, this assertion comes off WITH the port
  // rather than the port arriving quietly one general-engine merge at a time.
  ok(!/QuoteTermSheetActions|ComparisonStrip|useTermSheetCart|TermSheetPanel/.test(f),
    'C6e FORK 7 — the term sheet controls are NOT in the copy: an engine under audit must not be able to issue a document a borrower reads');
  ok(/QuoteTermSheetActions/.test(codeOf(general)),
    '…and the general engine really does have them, so C6e is guarding a live difference rather than agreeing with an empty set');
  // FORK 8 — linking two spellings of one investor. The general engine prices ONE
  // program, so it has no concept of the same investor spelled two ways; if this
  // ever appears there, the fork has been merged and this assertion comes off with
  // it rather than the feature arriving quietly.
  ok(/<LtInvestorLinks\s+pairing=\{res\.investorPairing\}/.test(f),
    'C8 FORK 8 — the copy draws the live side-by-side from what the two programs ACTUALLY returned, which is the only place those names exist');
  ok(!/LtInvestorLinks/.test(codeOf(general)),
    '…and the general engine has none of it, so C8 is guarding a live difference rather than agreeing with an empty set');
  // ONE ARRANGEMENT, TWO SCREENS. The board and the settings screen must MOUNT the
  // same component, never each grow their own: two arrangements is how one screen
  // shows a link the other does not, on the one setting that decides whose name a
  // priced row is shown under.
  ok(/^import LtInvestorLinks from '\.\/LtInvestorLinks\.jsx';$/m.test(fork)
    && /^import LtInvestorLinks from '\.\/LtInvestorLinks\.jsx';$/m.test(settings),
    'C8b …and the settings screen mounts the SAME component rather than a second copy of it');
  ok(/export default function LtCombinedPricer\(/.test(f) && !/export default function LtPricer\(/.test(f),
    'C7 …and the copy is its own component, so the two can never be mounted as one by accident');
}

console.log('\nD. both new screens are the super admin\'s alone');
{
  for (const [path, what] of [['/internal/lt/combined', 'the engine'], ['/internal/lt/combined-settings', 'its settings']]) {
    // Escape the slashes by SPLITTING rather than with a regex replace — a
    // heredoc-mangled escape once made this line throw, and a test that CRASHES
    // also "fails" and looks like proof while every later assertion goes unrun.
    const esc = path.split('/').join('\\/');
    ok(new RegExp(`role === 'super_admin'[\\s\\S]{0,400}${esc}"`).test(nav),
      `D1 the nav entry for ${what} renders only for a super admin — hidden rather than shown and refused, because the server answers 404 to everybody else`);
  }
  ok(/\/internal\/lt\/combined"[\s\S]{0,120}LtCombinedPricer/.test(app)
    && /\/internal\/lt\/combined-settings"[\s\S]{0,120}LtCombinedSettings/.test(app),
    'D2 …and both routes are wired to their own screens');
  ok(/\/internal\/lt\/pricer"[\s\S]{0,80}LtPricer/.test(app),
    'D3 …with the general engine\'s own route untouched beside them');
}

console.log('\nE. the settings screen keeps no roster of its own');
{
  const s = codeOf(settings);
  ok(/ltApi\.combinedInvestors\(\)/.test(s) && /ltApi\.combinedSaveInvestors\(/.test(s),
    'E1 it reads the roster from the server and writes the whole map back');
  // A browser copy of the investor list is a second roster, and the one that drifts is the one
  // somebody prices a loan on. The server derives it from the ONE investor registry.
  ok(!/deephaven|oaktree|pennymac|acra|nqm|eresi/i.test(s),
    'E2 …and it names NO investor in its own source — the roster is derived server-side from the one registry');
  ok(/whiteLabelMissing/.test(s) && /never (be )?invented|nothing has been made up/i.test(settings),
    'E3 …and an investor with no client-safe name is shown EMPTY and said out loud, never filled with a guess');
}

console.log('\nF. a general-engine change that WAS ported stays ported');
{
  // THE FINGERPRINT CATCHES ONE DIRECTION ONLY — "the general engine moved and the
  // copy did not". It cannot catch the other: the copy quietly LOSING something it
  // was given, because re-stamping the fingerprint is a deliberate act and nothing
  // afterwards re-checks the copy. So the ported work is asserted here, and the
  // EXPECTATION IS DERIVED FROM THE GENERAL ENGINE rather than typed in — a
  // hand-written count is a second copy of the answer, and it goes stale the next
  // time somebody adds a row to either screen.
  //
  // What is being held is the 2026-08-30 phone-readability work: on a narrow screen
  // the heading row is hidden and each cell carries its own column name, so a board
  // read on a phone still says which figure is which. It carries no business rule,
  // which is exactly why it belonged in the copy: the owner is auditing this engine
  // on real scenarios, and an unreadable board is a defect whatever it is priced on.
  const fb = codeOf(fork);
  const gb = codeOf(general);
  const CLASSES = ['ltq-row', 'ltq-head', 'ltq-name', 'ltq-act', 'ltq-cell', 'ltq-price', 'ltq-gap', 'ltq-ratehead'];
  const count = (src, k) => (src.match(new RegExp(`ltq-${k.slice(4)}(?=[\"\\s])`, 'g')) || []).length;
  let same = 0;
  for (const c of CLASSES) {
    const g = count(gb, c);
    const f = count(fb, c);
    if (g > 0 && g === f) same++;
    else ok(false, `F1 the copy carries the same number of \`${c}\` hooks as the general engine (general ${g}, copy ${f})`);
  }
  ok(same === CLASSES.length,
    `F1 the copy carries every phone-readability hook the general engine does, in the same numbers (${same}/${CLASSES.length})`);
  // …and the SHARED one-line program label, so the two boards can never disagree
  // about how a programme is written.
  // COUNTED, not merely present: the helper stays imported and used elsewhere while
  // one call site is re-inlined, so a presence test passes on a screen that has gone
  // back to formatting a programme line by hand. (Proven — that mutation MISSED the
  // first cut of this assertion.)
  const calls = (src) => (src.match(/programLine\(/g) || []).length;
  ok(calls(gb) > 0 && calls(fb) === calls(gb),
    `F2 both screens draw EVERY programme line from the ONE shared helper (general ${calls(gb)}, copy ${calls(fb)})`);
  // …and neither re-inlines the old hand-built form beside it.
  ok(!/\$\{[^}]*\.product\}/.test(fb) && !/\.product \? `/.test(fb),
    'F2a …and the copy carries no hand-built programme line at all');
  // The lens label, named once on both — the heading and the phone cell must come
  // from the same value or they could disagree about which position is on screen.
  ok(/const priceKey = comp/.test(fb),
    'F3 …and the copy names the price lens once, so its heading and its phone cells cannot disagree');

  /* F4 — THE ACTION COLUMN THE HEADING RESERVES IS THE ONE THE ROWS USE.

     Owner-reported 2026-08-30 on the general engine: *"the column that we added for PITI
     is off, and it's not aligned with the dollar amounts."* The cause was not the PITI
     column at all — the rows' action cell had been widened to fit a new tick-box and the
     heading's trailing spacer had not, and because the name column is `flex: 2 1 200px`
     it simply GAVE UP the difference. Nothing overflows and nothing wraps, so every figure
     sits left of the heading that names it and it reads as one column being subtly wrong.

     ⛔ THIS HOLDS THE INVARIANT, NEVER THE NUMBER, and that is what lets it guard BOTH
     screens with one rule: the two boards legitimately differ (the general engine's cell
     carries the tick-box, the copy's deliberately does not — FORK 7), so a pinned width
     would be a third place the answer lives and would fail on the copy for being correct.
     What must be true on each screen SEPARATELY is that the set of widths its heading
     reserves is the set its rows use.

     ⛔ AND IT IS WHY MAIN'S 2026-08-30 WIDTH FIX IS *NOT* PORTED. It was not a defect in
     the copy: with no tick-box the copy's rows never widened, so its heading and its rows
     have always agreed. Porting the constant would put the same NAME on two different
     values in two files a person reads side by side — the drift hazard the fork exists to
     avoid. Recorded here rather than left silent, because re-stamping the fingerprint is a
     deliberate act and nothing afterwards re-checks the copy. If the cart is ever ported,
     the tick-box widens the rows and THIS assertion is what fails until the heading moves
     with it. */
  const actWidths = (src) => new Set((src.match(/className="ltq-act"\s+style=\{\{\s*flex:\s*(?:[A-Za-z_$][\w$]*|'[^']*')/g) || [])
    .map((m) => m.replace(/^[\s\S]*flex:\s*/, '')));
  const headWidths = (src) => new Set((src.match(/<span style=\{\{\s*flex:\s*(?:[A-Za-z_$][\w$]*|'[^']*')\s*\}\}\s*\/>/g) || [])
    .map((m) => m.replace(/^[\s\S]*flex:\s*/, '').replace(/\s*\}\}\s*\/>$/, '')));
  for (const [label, src] of [['the general engine', gb], ['the copy', fb]]) {
    const a = [...actWidths(src)].sort();
    const h = [...headWidths(src)].sort();
    ok(a.length > 0 && h.length > 0 && a.join('|') === h.join('|'),
      `F4 ${label}: every action-column width its heading reserves is one its rows use (heading ${h.join(', ') || 'none'} / rows ${a.join(', ') || 'none'})`);
  }

  /* F5 — THE INTEREST-ONLY SEARCH STILL SAYS WHAT IT COVERS.

     Owner-reported 2026-08-31 on the general engine: *"I'm selecting interest only, and I
     don't see this happening in real life. It stays 30, and it doesn't select 40 as well."*
     The search had covered 40 since §39; the SCREEN said nothing, so a working feature read
     as a broken one. Ported here because the same confusion lands on this board and it
     carries no business rule — the standard the phone-readability port was held to.

     ⛔ IT IS TRUE OF THIS BOARD FOR TWO REASONS, CHECKED RATHER THAN ASSUMED. The Lender
     Price half runs the same `buildSearch`, so §39 widens it identically. The LoanNEX half
     is asked for NO loan term at all (interest-only is a product its answer returns, not a
     question in its request — see loannex/scenario.js), so its 40-year interest-only
     products were never being excluded. Both halves surface them, which is what the
     sentence claims, so it is ported VERBATIM rather than reworded — a second wording
     would be a ninth divergence and a thing to drift.

     Counted and DERIVED from the general engine, never typed in: a presence test passes on
     a copy that has kept the comment and lost the line. */
  const ioNote = (src) => (src.match(/Interest-only also searches/g) || []).length;
  ok(ioNote(gb) > 0 && ioNote(fb) === ioNote(gb),
    `F5 both screens tell the officer an interest-only search also covers 40-year (general ${ioNote(gb)}, copy ${ioNote(fb)})`);
  // …and it is gated on the interest-only box on both, so it never claims a widening on a
  // search that was not widened.
  const ioGated = (src) => /f\.io \?[\s\S]{0,400}?Interest-only also searches/.test(src);
  ok(ioGated(gb) && ioGated(fb),
    'F5a …and on both it is shown only while interest-only is ticked');
}

console.log(bad ? `\nFAILURES: ${bad}` : '\nOFFLINE: all passed');
process.exit(bad ? 1 : 0);
