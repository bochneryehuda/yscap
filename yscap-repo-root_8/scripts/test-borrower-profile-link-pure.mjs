/* THERE IS A WAY INTO THE PERSON, AND A WAY BACK OUT.

   Owner-reported 2026-08-21: "Right now, when you're in a file, you don't have anywhere
   to access the borrower profile. In general, there's an entire massive profile of
   entities and stuff like that. You only see the details of the file. There should be a
   link somewhere to open up the full. In the file, you should be able to access it
   directly somehow and open up the borrower's profile on a full page. Think of an idea
   for the best way to do it."

   A button DID exist — inside Application details, which is collapsed by default, and
   then inside its People tab. So the owner's report is exact: from where you actually
   stand in a file there was nowhere to go. The answer is the NAME, in the party list on
   the overview; the buried button stays and now goes through the same definition.

   Two halves, and the test proves them two different ways:

   (A) THE URL RULE, EXECUTED. Where a link lands and what it carries is real logic, so
       it is RUN — from `lib/borrowerProfileUrl.js`, which imports NOTHING. That split
       is not tidiness: CI installs the root package alone, so `app-v2/node_modules` does
       not exist there and a test that pulled React in through the component could not
       run at all (the lesson urlState.js already carries).

   (B) THE WIRING, READ FROM SOURCE. Which surfaces link, whether a missing borrower id
       still renders a link, and whether the way back is resolved safely are facts about
       JSX. Each is a real regression somebody could ship.

   Pure — no React, no DOM, no browser, no DB. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (cond) { console.log(`  ok  ${what}`); } else { failures++; console.error(`  FAIL ${what}`); } };

const url = await import('../app-v2/src/lib/borrowerProfileUrl.js');

console.log('\nA. the URL rule, executed');

ok(url.borrowerProfileHref('b-1') === '/internal/borrowers/b-1',
  'a plain link lands on the full profile page');
ok(url.borrowerProfileHref('b-1', 'app-9') === '/internal/borrowers/b-1?from=app-9',
  '…and from inside a file it carries the file, which is what makes the trip back possible');
ok(url.FROM_PARAM === 'from', 'the return key has ONE name, shared with the screen that reads it');
ok(url.borrowerProfileHref(null) === null && url.borrowerProfileHref('') === null && url.borrowerProfileHref(undefined) === null,
  'no person → no link at all, so a name can never become a link to nowhere');
ok(url.borrowerProfileHref('b-1', '') === '/internal/borrowers/b-1'
  && url.borrowerProfileHref('b-1', null) === '/internal/borrowers/b-1',
  'no file to come back to → no empty ?from= hanging off the address');
{
  const href = url.borrowerProfileHref('a/b?c#d', 'x y&z');
  ok(!/[?#]/.test(href.split('?')[0]) && /from=x%20y%26z/.test(href),
    'both halves are encoded, so an id can never break out of its own place in the address');
}
ok(/full profile/i.test(url.PROFILE_LINK_TITLE) && /back to this file/i.test(url.PROFILE_LINK_TITLE),
  'the link says where it goes AND that the way back rides with it');

// The pure half must stay pure, or it stops being runnable where React is not installed.
ok(!/^\s*import\s/m.test(read('app-v2/src/lib/borrowerProfileUrl.js')),
  'the rule imports nothing — it runs in CI, where app-v2/node_modules does not exist');

console.log('\nB. the file links the person, from where you are standing');

const snap = read('app-v2/src/components/DealSnapshot.jsx');
ok(/import BorrowerProfileLink from '\.\/BorrowerProfileLink\.jsx'/.test(snap),
  'the overview party list uses the shared link');
ok(/row\('Borrower', \(\s*\n\s*<BorrowerProfileLink borrowerId=\{app\.borrower_id\} fromAppId=\{app\.id\}>/.test(snap),
  "the BORROWER's name is the link, and it carries this file");
ok(/row\('Co-borrower', app\.co_borrower_id\s*\n\s*\? <BorrowerProfileLink borrowerId=\{app\.co_borrower_id\} fromAppId=\{app\.id\}>/.test(snap),
  "the CO-BORROWER's name too — a file with two people must not link only one of them");
ok(/\? <BorrowerProfileLink[\s\S]{0,160}\n\s*: coName\)\}/.test(snap),
  '…and with no co-borrower the row stays plain text rather than an em dash pretending to be a link');

// A hand-built URL is how two doors drift into landing differently, or into one of them
// silently dropping the way back. The borrower LIST screen legitimately builds its own
// (you came from the list; there is no file to return to) — this is about the FILE.
for (const f of ['app-v2/src/components/DealSnapshot.jsx', 'app-v2/src/components/BorrowerProfilePanel.jsx']) {
  ok(!/['"`]\/internal\/borrowers\/\$\{/.test(read(f)),
    `${f.split('/').pop()} builds no profile URL of its own`);
}

console.log('\nC. the buried button still works, and now carries the file too');

const panel = read('app-v2/src/components/BorrowerProfilePanel.jsx');
ok(/fromAppId = null \}\) \{/.test(panel), 'the profile panel accepts the file it is mounted on');
ok(/<BorrowerProfileLink borrowerId=\{b\.id\} fromAppId=\{fromAppId\} variant="button">/.test(panel),
  '…and its own "Open full profile" goes through the SAME definition');
const screen = read('app-v2/src/screens/StaffApplication.jsx');
const mounts = screen.match(/<BorrowerProfilePanel [^>]*\/>/g) || [];
ok(mounts.length === 2 && mounts.every((m) => /fromAppId=\{id\}/.test(m)),
  `both people's panels pass the file (found ${mounts.length})`);

console.log('\nD. the way back');

const detail = read('app-v2/src/screens/StaffBorrowerDetail.jsx');
ok(/<BackToFile borrowerId=\{id\} \/>/.test(detail), 'the profile screen renders a return bar');
ok(/import \{ FROM_PARAM \} from '\.\.\/lib\/borrowerProfileUrl\.js'/.test(detail),
  '…reading the SAME key the link writes, so the two can never disagree');
ok(/api\.staffBorrowerApplications\(borrowerId\)/.test(detail),
  'the file is resolved against THIS PERSON\'s own file list — already scoped server-side, so ?from= is a hint and never an authorization');
// ANCHORED TO THE START OF A LINE. `/if \(!file\)/` alone matches the commented-out
// form too, so the guard passed when the guard it guards was switched off — caught by
// running the mutation rather than by reading the regex.
ok(/^\s*if \(!file\) return null;/m.test(detail),
  'a file that is not theirs, or that this reader cannot see, produces NO bar — never a link that 404s');
ok(/\.catch\(\(\) => \{[^}]*\}\);/.test(detail),
  'and a failed lookup is silent — the profile page is not the place to report it');
ok(/to=\{`\/internal\/app\/\$\{file\.id\}`\}/.test(detail), 'the bar goes back to the loan file');
ok(/property_address/.test(detail.slice(detail.indexOf('function BackToFile'), detail.indexOf('function BackToFile') + 1600)),
  '…and names the property, so it is obvious WHICH file you are going back to');

console.log('\nE. dark on white, per the hard rule');

const css = read('app-v2/src/styles.css');
const rule = /\.bprof-namelink\{([^}]*)\}/.exec(css);
ok(!!rule, 'the name link has its own style');
ok(rule && /color:#141B22/.test(rule[1]),
  'the name stays INK — a party list whose values turned teal would read as a row of links');
ok(rule && /border-bottom:1px dotted/.test(rule[1]),
  '…so it needs a mark of its own to still read as clickable');
ok(/\.bprof-namelink:focus-visible\{[^}]*outline:/.test(css), 'and it is reachable by keyboard, visibly');
ok(/aria-hidden="true" className="bprof-namelink-mark"/.test(read('app-v2/src/components/BorrowerProfileLink.jsx')),
  'the ↗ is decoration — a screen reader gets the name and the sentence, not "arrow"');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  borrower profile: reachable from the file by the person\'s own name, and a way back');
process.exit(failures ? 1 : 0);
