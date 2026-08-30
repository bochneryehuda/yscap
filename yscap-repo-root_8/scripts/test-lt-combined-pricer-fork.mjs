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
//   3. Every divergence in the copy is MARKED, and the count is pinned, so a sixth one cannot be
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

console.log('\nC. every divergence in the copy is marked, and there are exactly five');
{
  const marks = fork.match(/FORK \d of 5/g) || [];
  const numbers = new Set(marks.map((m) => m.match(/\d/)[0]));
  ok(numbers.size === 5 && [...numbers].sort().join() === '1,2,3,4,5',
    `C1 the copy carries exactly five marked divergences, numbered 1-5 (found ${[...numbers].sort().join() || 'none'})`);
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

console.log(bad ? `\nFAILURES: ${bad}` : '\nOFFLINE: all passed');
process.exit(bad ? 1 : 0);
