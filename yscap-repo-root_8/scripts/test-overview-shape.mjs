/**
 * THE OVERVIEW ENDS CLEAN, AND THE THREE SIDE BUGS STAY FIXED
 * (owner-directed 2026-08-02, items 11 / 12 / the side-bug list).
 *
 *   #27  "Entity, team & assignment" mingled three subjects. The entity and the
 *        assignment figures move into the first block; what is left is ONLY the
 *        team, and it is made modern.
 *   #28  The overview reads: one merged block (deal + what's left) → Status &
 *        closing → the team. "It's pretty clean."
 *   #29  Three side bugs, each of which had gone unnoticed because nothing
 *        failed — the screen simply offered less than the server did.
 *
 * Pure — reads the source. No DB, no browser.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const file = read('app-v2', 'src', 'screens', 'StaffApplication.jsx');
const snap = read('app-v2', 'src', 'components', 'DealSnapshot.jsx');
const css = read('app-v2', 'src', 'styles.css');
const staffRoutes = read('src', 'routes', 'staff.js');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

// Everything below reads the OVERVIEW only — the section ends where Application
// details begins, and several of these components are legitimately mounted again
// further down the page.
const overview = file.slice(0, file.indexOf('id="sec-application"'));
const at = (needle) => overview.indexOf(needle);
const before = (a, b) => at(a) >= 0 && at(b) >= 0 && at(a) < at(b);

console.log('\nA. #28 — the overview reads in the owner\'s order');

ok(at('<div className="deal-block">') >= 0, 'the deal facts and what is left are ONE block');
ok(before('<div className="deal-block">', '{statusClosingBlock}'), 'that block comes first');
ok(before('{statusClosingBlock}', 'className="panel team-panel"'), 'then Status & closing');
ok(at('className="panel team-panel"') >= 0, 'then the team');
{
  // The team must be the LAST panel on the overview — "it's pretty clean" is an
  // ordering statement, and a stray panel after the team breaks it.
  const tail = overview.slice(at('className="panel team-panel"'));
  ok(!/className="panel(?! team-panel)/.test(tail.slice(50)),
    'nothing else is mounted after the team — it is the last thing on the overview');
}
{
  const block = overview.slice(at('<div className="deal-block">'), at('<div className="deal-block">') + 400);
  ok(/<DealSnapshot/.test(block) && /<WhatsLeftPanel/.test(block),
    'both parts really are inside the one block');
  ok(/\.deal-block\{/.test(css), 'the block has a style that joins them');
  ok(/\.deal-block > \.deal-snap\{[^}]*border:0/.test(css),
    '…and the children give up their own borders, so it reads as one card and not two');
}
{
  // WhatsLeftPanel owns the permanent deep-link anchor. Wrapping it must not have
  // moved the anchor out of the overview.
  const wl = read('app-v2', 'src', 'components', 'WhatsLeftPanel.jsx');
  ok(/id="ctc-outstanding"/.test(wl),
    'the #ctc-outstanding anchor still lives on the panel, so every deep link still lands');
}

console.log('\nB. #27 — the team panel is only the team');

ok(!/Entity, team &amp; assignment/.test(file), 'the mingled panel title is gone');
{
  const team = overview.slice(at('className="panel team-panel"'));
  ok(/Team on this file/.test(team.slice(0, 400)), 'it is named for what it is');
  ok(/<TeamAssignees/.test(team), 'it carries the assignees');
  // The three subjects that moved out must not have been left behind.
  ok(!/<span className="k">Entity<\/span>/.test(team), 'the Entity row moved out');
  ok(!/Underlying price/.test(team), 'the assignment figures moved out');
  ok(!/<span className="k">As-is<\/span>/.test(team),
    'the As-is row moved out — the snapshot already showed it, so it was printed twice');
}
{
  // …and they must have arrived where they were sent.
  ok(/Verified ✓/.test(snap) && /Unverified/.test(snap),
    'the entity arrives in the first block WITH its verification state, which is the part people act on');
  ok(/Underlying price/.test(snap) && /Assignment fee/.test(snap),
    'the assignment figures arrive in the first block');
  ok(/is_assignment && row\('Underlying price'/.test(snap),
    '…and only on an assignment, so an ordinary purchase is unchanged');
  ok(/personal_name_purchase && !app\.llc_id/.test(snap),
    'an individual-vested file says so, rather than reading as a missing entity');
}

console.log('\nC. #29 — the three side bugs');

// (1) `on_hold` is a real status the server has accepted since db/319, and the
// dropdown never listed it — so a file could be parked from ClickUp but never
// from PILOT.
{
  const serverList = (staffRoutes.match(/const APP_STATUS = \[([^\]]+)\]/) || [])[1] || '';
  const clientList = (file.match(/const APP_STATUSES = \[([^\]]+)\]/) || [])[1] || '';
  const parse = (s) => s.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const server = parse(serverList);
  const client = parse(clientList);
  ok(server.includes('on_hold'), 'the server accepts on_hold (it always did)');
  ok(client.includes('on_hold'), 'and the dropdown now OFFERS it');
  const missing = server.filter((x) => !client.includes(x));
  ok(missing.length === 0,
    `no status the server accepts is missing from the dropdown (missing: ${missing.join(', ') || 'none'})`);
  const invented = client.filter((x) => !server.includes(x));
  ok(invented.length === 0,
    `and the dropdown offers nothing the server would refuse (extra: ${invented.join(', ') || 'none'})`);
  ok(/on_hold: 'On hold'/.test(file), 'it has a human label, not a raw key');
}

// (2) GET /borrowers/:id never returned has_account, so the profile screen's
// "No account" / "Active" pill was reading a field that was never sent.
{
  const detail = staffRoutes.slice(staffRoutes.indexOf("router.get('/borrowers/:id'"));
  ok(/has_account/.test(detail.slice(0, 3000)),
    'the borrower profile door returns has_account — the pill was reading a field that was never sent');
}

// (3) The "Subject-property LLC" pill could never be satisfied on a file that
// vests in an individual, because there IS no entity — so the file could never
// read complete.
{
  const m = file.match(/\{ key: 'entity_name',[\s\S]{0,600}?\},/);
  ok(!!m, 'the vesting completeness pill is findable');
  const row = m ? m[0] : '';
  ok(/personal_name_purchase && !app\.llc_id/.test(row),
    'it is satisfied by the individual choice as well as by an entity');
  ok(/label: \(app\.personal_name_purchase/.test(row),
    '…and it renames itself, so it never asks for an LLC on a file that has none by design');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  overview-shape: one block, then status, then the team — and the three side bugs are shut');
process.exit(fail ? 1 : 0);
