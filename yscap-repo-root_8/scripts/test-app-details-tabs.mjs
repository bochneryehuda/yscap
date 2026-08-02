/**
 * APPLICATION DETAILS IS THE FILE'S SUB-HUB, AND ITS TABS ARE IN THE OWNER'S ORDER
 * (owner-directed 2026-08-02: "Deal & property → Borrower profiles → ClickUp Sync
 * → Encompass sync").
 *
 * Three round-2 items land on this one tab strip — the borrower profiles moving
 * in (#20), "Pipeline data" becoming ClickUp Sync (#22), and Encompass sync
 * moving in beside it (#23) — so the ORDER is the thing most likely to drift as
 * each one is edited. It is pinned here rather than left to whoever touches the
 * array last.
 *
 * The two sync tabs are the point of #23: a live field-by-field comparison
 * against ClickUp and the same kind of screen against Encompass were two rooms
 * apart. They are now adjacent, in that order.
 *
 * Pure — reads the source. No DB, no browser.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = fs.readFileSync(path.join(here, '..', 'app-v2', 'src', 'screens', 'StaffApplication.jsx'), 'utf8');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

console.log('\nA. the tabs are in the order the owner asked for');

// The tab strip is the one array of `{ k: '…', label: … }` inside the
// Application-details section, read in source order.
const strip = file.slice(file.indexOf('aria-label="Application details"'));
const keys = Array.from(strip.slice(0, 900).matchAll(/\{\s*k:\s*'([a-z]+)'/g)).map((m) => m[1]);
ok(keys.length >= 5, `the strip has every tab (found ${keys.length}: ${keys.join(', ')})`);

const order = (a, b) => keys.indexOf(a) >= 0 && keys.indexOf(b) >= 0 && keys.indexOf(a) < keys.indexOf(b);
ok(keys[0] === 'deal', 'Deal & property is FIRST — the deal editor is the right first thing every time');
ok(order('deal', 'people'), 'Borrower profiles comes after Deal & property');
ok(order('people', 'pipeline'), 'ClickUp Sync comes after Borrower profiles');
ok(order('status', 'pipeline'), 'Status & closing sits before the two sync tabs');
ok(order('pipeline', 'encompass'), 'Encompass sync comes after ClickUp Sync');
ok(keys[keys.length - 1] === 'encompass', 'Encompass sync is LAST, exactly as the order given');
// Missing info is not in the owner's four, but it is real work — it must not have
// been dropped, and it must not have been slotted between two of the named four.
ok(keys.includes('missing'), 'Missing info survived the reshuffle');
ok(order('people', 'missing') && order('missing', 'pipeline'),
  'Missing info sits between the content tabs and the two sync tabs, leaving the named four in order');

console.log('\nB. each tab actually renders something');

for (const [k, needle, what] of [
  ['deal', '<EditFileDetails', 'the deal editor'],
  ['people', '<BorrowerProfilePanel', 'both borrower profiles'],
  ['missing', '<BorrowerCompleteness', 'the three completeness lists'],
  ['status', '<LoanNumberEntry', 'the loan-number entry'],
  ['pipeline', '<ClickupCompare', 'the ClickUp field-by-field comparison'],
  ['encompass', '<EncompassSyncPanel', 'the Encompass comparison'],
]) {
  const at = file.indexOf(`appDetailTab === '${k}'`);
  ok(at > 0, `the "${k}" tab has a body`);
  if (at > 0) {
    // The body runs to the next tab guard (or the section's end) — enough to see
    // what it mounts without matching something from a neighbouring tab.
    const next = file.slice(at + 10).search(/appDetailTab === '|<\/Section>/);
    const body = file.slice(at, at + 10 + (next < 0 ? 2000 : next));
    ok(body.includes(needle), `…and it renders ${what}`);
  }
}

console.log('\nB2. every detail and every edit the owner NAMED is reachable here');

{
  const at = file.indexOf("appDetailTab === 'status'");
  const body = file.slice(at, file.indexOf("appDetailTab === 'pipeline'"));
  ok(/<LoanNumberEntry/.test(body), 'the YS loan number can be ENTERED here — the owner named it');
  ok(/\{statusClosingBlock\}/.test(body),
    'both statuses and the two closing dates are here (the Status & closing block)');
  ok(/<NoteBuyerCard/.test(body), 'the note buyer is changeable here');
}
{
  // ONE definition rendered twice, never two copies of the markup — the trap the
  // borrower editor fell into. Safe only because the two sections are in
  // DIFFERENT rooms, so both are never on screen at once.
  const built = (file.match(/const statusClosingBlock = \(/g) || []).length;
  const rendered = (file.match(/\{statusClosingBlock\}/g) || []).length;
  ok(built === 1, `the Status & closing markup exists ONCE (found ${built})`);
  ok(rendered === 2, `…and is rendered in both places (found ${rendered})`);
}
{
  // The loan number had TWO near-identical controls with two save calls. One now.
  const defs = (file.match(/function LoanNumberEntry\(/g) || []).length;
  ok(defs === 1, 'there is ONE loan-number control');
  ok(/return <LoanNumberEntry appId=\{appId\} value=\{null\}/.test(file),
    '…and the condition card calls it rather than keeping its own copy');
  const posts = (file.match(/loan-number`/g) || []).length;
  ok(posts <= 1, `only one place posts the loan number (found ${posts})`);
}

console.log('\nC. the two outside systems sit together, and Encompass stays read-only');

ok(order('pipeline', 'encompass'),
  'ClickUp and Encompass are adjacent — the same kind of screen, no longer two rooms apart');
{
  // The move must not have grown a write path. Encompass is frozen read-only, so
  // the panel is mounted exactly as before, by the same component.
  const mounts = (file.match(/<EncompassSyncPanel/g) || []).length;
  ok(mounts === 1, `the Encompass panel is mounted exactly once (found ${mounts})`);
}

console.log('\nD. moving a section out never breaks a link that points at it');

{
  // sec-encompass is named by the room rail, by stations.js and by the tape
  // screen's "open the Encompass sync" button. Deleting the section would send
  // every one of those to a section that no longer exists.
  ok(/id="sec-encompass"/.test(file),
    'the sec-encompass shell is KEPT, so existing deep links still land');
  const shell = file.slice(file.indexOf('id="sec-encompass"'), file.indexOf('id="sec-encompass"') + 1400);
  ok(/setAppDetailTab\('encompass'\)/.test(shell) && /goToSection\('sec-application'\)/.test(shell),
    '…and it takes you to the tab the panel actually moved to');
  ok(!/<EncompassSyncPanel/.test(shell),
    '…without rendering a SECOND copy of the panel there');
}
{
  // Same for the overview's route into the ClickUp controls, which moved in #22.
  const overview = file.slice(0, file.indexOf('id="sec-application"'));
  ok(/setAppDetailTab\('pipeline'\)/.test(overview),
    'the overview still offers a way into the ClickUp controls after they moved');
}

console.log('\nE. the retired "Pipeline data" name is gone');

ok(!/Pipeline data \(read-only\)/.test(file),
  'no tab is still called "Pipeline data (read-only)" — the owner renamed it');
ok(!/const \[showPipeline/.test(file),
  'the dead show/hide state for the old inline panel is removed, not left dangling');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  app-details-tabs: the deal, the people, and both outside systems — in the owner\'s order');
process.exit(fail ? 1 : 0);
