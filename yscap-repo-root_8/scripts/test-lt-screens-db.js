'use strict';
/**
 * PROOF that the three long-term screens the owner asked for are actually WIRED —
 * and that each one shows a name a person can read rather than a stored key.
 *
 * WHY THIS SUITE EXISTS. The census (`GET /api/lt/book`), the borrower map
 * (`GET/POST /api/lt/borrowers`) and the client's own long-term list
 * (`GET /api/lt/my/loans`) were all built and tested server-side, and NONE of them
 * had a screen. A door with nothing behind it fails silently in the worst possible
 * way: the borrower map is what puts a file on a client's login, so with no screen
 * no link could ever be confirmed and the client's long-term side stayed empty with
 * the switch ON and every test green. So half of this suite is a SOURCE GUARD that
 * the screens exist, are routed, and are reachable from the nav — the half a
 * server-side test can never cover.
 *
 * THE OTHER HALF IS THE WORDING, which is the owner's own next instruction:
 * *"rephrase this in our system with our own statuses, more user-friendly."* A
 * `stage_key` is a database value; nothing that reaches a person may be one.
 *
 * AND THE FOLDER LIST — the master plan recorded that the tenant's loan folders
 * "cannot be read" because the folder-LIST endpoint answers 403. True of the
 * endpoint, false of the fact: every mirrored loan carries its own folder. This
 * proves they are readable AND that reading them still decides nothing.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

async function main() {
  // Both CI jobs run the one chain and `test` has no database, so this must skip
  // rather than dial one. BEFORE anything that opens a connection.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-screens');

  const db = require('../src/longterm/db');
  const observed = require('../src/longterm/observed');
  const decls = require('../src/longterm/settings/encompass-settings');
  const stages = require('../src/longterm/stages');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  // ===========================================================================
  // A. THE SCREENS EXIST AND ARE REACHABLE.
  //
  // Deliberately a source scan and not a render: this is asserting the WIRING,
  // and the failure it exists to catch is a screen that was written and never
  // routed — which no amount of testing the component itself would find.
  // ===========================================================================
  const app = read('app-v2/src/App.jsx');
  const nav = read('app-v2/src/components/StaffLayout.jsx');
  const dash = read('app-v2/src/screens/Dashboard.jsx');

  for (const [file, route, label] of [
    ['app-v2/src/longterm/LtBook.jsx', '/internal/lt/book', 'the census'],
    ['app-v2/src/longterm/LtBorrowers.jsx', '/internal/lt/borrowers', 'the borrower map'],
  ]) {
    ok(fs.existsSync(path.join(REPO, file)), `${label} has a screen (${file})`);
    ok(app.includes(`path="${route}"`), `…and a route at ${route}`);
    ok(nav.includes(`to="${route}"`), `…and a way in from the nav`);
  }

  // The CLIENT's own long-term side, and the switch back to the short-term one.
  //
  // It is its own ROUTE and not a panel on the dashboard, and that is the charter
  // deciding the shape: the ledger lets `App.jsx` MOUNT long-term code and says in
  // as many words that no other RTL screen may import an LT component. So the
  // assertion below is BOTH halves — the route exists AND the borrower dashboard
  // still imports nothing from the long-term side.
  ok(fs.existsSync(path.join(REPO, 'app-v2/src/longterm/BorrowerLongTerm.jsx')),
    'the client\'s long-term side is a real screen');
  ok(app.includes('path="/long-term"'), '…mounted by the router at its own route');
  ok(!/longterm\//.test(dash),
    'the borrower dashboard imports NOTHING from the long-term side — the separation the ledger names');

  // THE SEPARATION HOLDS AT THE SEAM. The long-term components may be MOUNTED by
  // an RTL screen; they may not reach back into RTL code. A single `../lib/api`
  // here would put the two products' request layers together, which is the
  // crossing the charter names.
  for (const f of ['LtBook.jsx', 'LtBorrowers.jsx', 'BorrowerLongTerm.jsx']) {
    const src = read(`app-v2/src/longterm/${f}`);
    ok(!/from '\.\.\/lib\//.test(src), `${f} imports no RTL client — it uses Long-Term's own`);
  }

  // ===========================================================================
  // B. THE FOLDER NAMES ARE READABLE — the recorded blocker was false.
  // ===========================================================================
  const declList = Array.isArray(decls.SETTINGS) ? decls.SETTINGS : Object.values(decls.SETTINGS || {});
  const folderDecl = declList.find((d) => d && d.key === 'pipeline.inactiveFolders');
  ok(folderDecl, 'the finished-folder setting is declared');
  eq(folderDecl.suggestFrom, 'loanFolders', '…and asks the screen to offer the observed folders');
  assert.deepStrictEqual(folderDecl.default, [],
    'IT STILL DECIDES NOTHING — the default is empty, so nothing is hidden from anybody until a human picks');
  checks++;

  const tag = `ltscr-${Date.now().toString(36)}`;
  const loanIds = [];
  const borrowerIds = [];
  const seedLoan = async (n, folder, stage, milestone, term, program) => {
    const { rows } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, loan_folder,
                             stage_key, milestone_name, term_months, program_name, loan_amount)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, $4, $5, $6, 400000) RETURNING id`,
      [`${tag}-${n}`, folder, stage, milestone, term, program],
    );
    loanIds.push(rows[0].id);
    return rows[0].id;
  };

  try {
    await seedLoan('a', `${tag} Pipeline`, 'clear_to_close', 'Clear To Close', 360, 'Investor DSCR 30 YEAR FRM');
    await seedLoan('b', `${tag} Pipeline`, 'funded', 'Funding', 360, 'Investor DSCR 30 YEAR FRM');
    await seedLoan('c', `${tag} Withdrawn`, 'new', 'Started', 360, 'Investor DSCR 30 YEAR FRM');
    // No folder at all — a real state the census must still account for.
    await seedLoan('d', null, 'new', 'Started', 360, 'Investor DSCR 30 YEAR FRM');
    // Short-term, so the census must EXCLUDE it from the long-term book while
    // still counting it — the totals have to reconcile.
    await seedLoan('e', `${tag} Pipeline`, 'new', 'Started', 12, 'Fix & Flip Purchase');

    const folders = await observed.loanFolders();
    const byName = new Map(folders.map((f) => [f.value, f.count]));
    eq(byName.get(`${tag} Pipeline`), 3, 'the folders are counted straight off the mirrored book');
    eq(byName.get(`${tag} Withdrawn`), 1, '…every folder the book uses, not a guessed list');
    ok(byName.has('(no folder)'), 'a loan with NO folder is counted too — the totals must add up');

    // The resolver never throws: an unreadable list must leave the settings screen
    // exactly as usable as it was, not fail twenty other settings with it.
    const broken = await observed.loanFolders({ query: async () => { throw new Error('down'); } });
    assert.deepStrictEqual(broken, [], 'an unreadable folder list answers empty rather than throwing');
    checks++;

    // The attachment is by NAME, and only where a declaration asked.
    const described = {
      groups: [{ group: 'Pipeline', settings: [
        { key: 'pipeline.inactiveFolders', suggestFrom: 'loanFolders' },
        { key: 'pipeline.columns' },
      ] }],
    };
    await observed.attachSuggestions(described);
    ok(Array.isArray(described.groups[0].settings[0].suggestions),
      'a setting that asked gets the observed values');
    eq(described.groups[0].settings[1].suggestions, undefined,
      '…and one that did not is left exactly as it was');

    // ==========================================================================
    // C. THE CENSUS CARRIES OUR OWN STATUS NAMES, AND THE SPREADSHEET PRINTS THEM.
    // ==========================================================================
    const bookMod = require('../src/longterm/routes/book');
    const layerFor = (mod, p) => {
      const l = mod.stack.find((x) => x.route && x.route.path === p);
      return l && l.route.stack[0].handle;
    };
    const drive = async (handle, req) => {
      let body = null; let status = 200; let sent = null; const headers = {};
      const res = {
        json: (b) => { body = b; return res; },
        status: (s) => { status = s; return res; },
        setHeader: (k, v) => { headers[k] = v; return res; },
        send: (s) => { sent = s; return res; },
      };
      await handle(req, res);
      return { body, status, sent, headers };
    };
    // An admin actor: `accessFor` reads the role, and a sees-all viewer drops the
    // scope clause, so the census is the whole book rather than one person's.
    const actor = { id: null, role: 'super_admin', kind: 'staff' };

    const bookHandle = layerFor(bookMod, '/');
    ok(bookHandle, 'the census exposes GET /');
    const book = await drive(bookHandle, { actor, query: {} });
    eq(book.status, 200, 'the census answers cleanly');
    ok(Array.isArray(book.body.stages) && book.body.stages.length,
      'it carries OUR OWN status names, so a screen never prints a stored key');
    const stageNames = new Map(book.body.stages.map((s) => [s.key, s.label]));
    eq(stageNames.get('clear_to_close'), 'Clear to Close', '…the readable name for the stored key');
    ok(stageNames.has(stages.UNMAPPED_STAGE.key),
      'the unmapped bucket is in the list — a census must be able to name EVERY file');

    const mine = book.body.longTerm.filter((r) => String(r.file).startsWith(tag));
    eq(mine.length, 4, 'the four long-term files are in the book');
    ok(!mine.some((r) => String(r.file).endsWith('-e')),
      'the short-term one is NOT — a Flip program is short-term whatever its term');
    ok(book.body.shortTerm.some((r) => String(r.file).endsWith('-e')),
      '…but it is COUNTED, so the four buckets still reconcile');
    const folderRow = (book.body.byFolder || []).find((f) => f.folder === `${tag} Pipeline`);
    ok(folderRow, 'the census groups by folder — the way the owner reads it');
    eq(folderRow.count, 2, '…counting only the long-term files in it');

    const csvHandle = layerFor(bookMod, '/export.csv');
    ok(csvHandle, 'the census exposes the spreadsheet');
    const csv = await drive(csvHandle, { actor, query: {} });
    const line = String(csv.sent).split('\r\n').find((l) => l.includes(`${tag}-a`));
    ok(line, 'the spreadsheet carries the file');
    ok(line.includes('"Clear to Close"'),
      'THE SPREADSHEET PRINTS THE STATUS NAME — the screen and the download can never call one stage two things');
    ok(!line.includes('"clear_to_close"'), '…never the stored key');

    // ==========================================================================
    // D. THE BORROWER MAP TELLS THE SCREEN WHO MAY DECIDE.
    //
    // Without it the screen cannot know whether to show the buttons, and a hidden
    // button is indistinguishable from a broken one. It is a HINT: the write doors
    // apply the same gate themselves, which is where the authorization lives.
    // ==========================================================================
    const borrowersMod = require('../src/longterm/routes/borrowers');
    const bHandle = layerFor(borrowersMod, '/');
    ok(bHandle, 'the borrower map exposes GET /');
    const asAdmin = await drive(bHandle, { actor, query: {} });
    eq(asAdmin.status, 200, 'the borrower map answers cleanly');
    eq(asAdmin.body.canManage, true, 'an administrator is told they may decide');
    const asOfficer = await drive(bHandle, { actor: { id: null, role: 'loan_officer', kind: 'staff' }, query: {} });
    eq(asOfficer.body.canManage, false, 'a loan officer is told they may not — they still SEE the map');
    ok(Array.isArray(asOfficer.body.suggestions) && Array.isArray(asOfficer.body.unmatched),
      '…because reading who is matched is not a privilege');

    // ==========================================================================
    // E. THE REFUSAL NAMES A REMEDY SOMEBODY CAN ACTUALLY CARRY OUT.
    //
    // Two names on one email address is unanswerable and rightly refused. It used
    // to say "link them one at a time instead" — pointing at a door that does not
    // exist, because the decision is recorded about the ADDRESS on purpose. A
    // refusal whose own remedy is impossible is a dead end, which is the class this
    // repo keeps having to fix.
    // ==========================================================================
    const links = require('../src/longterm/borrower-links');
    const shared = `${tag}-two@example.com`;
    await db.query(`UPDATE lt_loans SET borrower_email=$2, borrower_name='Sam Fried' WHERE id=$1::uuid`, [loanIds[0], shared]);
    await db.query(`UPDATE lt_loans SET borrower_email=$2, borrower_name='Rivka Stern' WHERE id=$1::uuid`, [loanIds[1], shared]);
    // A REAL profile: the door checks the profile exists BEFORE it looks at the
    // names, so an invented id would be refused for the wrong reason and this
    // assertion would be testing nothing.
    const { rows: [profile] } = await db.query(
      `INSERT INTO borrowers (id, first_name, last_name, email)
       VALUES (gen_random_uuid(), 'Sam', 'Fried', $1) RETURNING id`, [shared],
    );
    borrowerIds.push(profile.id);
    let refusal = null;
    try {
      await links.confirmLink(shared, profile.id, null, {});
    } catch (e) { refusal = e; }
    ok(refusal, 'two different people on one address is refused');
    ok(/more than one borrower name/i.test(String(refusal.plain)), '…saying why');
    ok(/email address/i.test(String(refusal.plain)) && /Encompass/i.test(String(refusal.plain)),
      '…and naming the fix at the source, which is a thing a person can actually do');
    ok(!/one at a time/i.test(String(refusal.plain)),
      '…never the old advice, which pointed at a button that does not exist');
  } finally {
    if (loanIds.length) {
      await db.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [loanIds]).catch(() => {});
    }
    if (borrowerIds.length) {
      await db.query('DELETE FROM lt_borrower_links WHERE borrower_id = ANY($1::uuid[])', [borrowerIds]).catch(() => {});
      await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [borrowerIds]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt screens (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
