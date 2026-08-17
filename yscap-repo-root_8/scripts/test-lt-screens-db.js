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
    ['app-v2/src/longterm/LtStatuses.jsx', '/internal/lt/statuses', 'the status map'],
  ]) {
    ok(fs.existsSync(path.join(REPO, file)), `${label} has a screen (${file})`);
    ok(app.includes(`path="${route}"`), `…and a route at ${route}`);
    ok(nav.includes(`to="${route}"`), `…and a way in from the nav`);
  }

  // The CLIENT's own long-term side, and the switch back to the short-term one.
  //
  // The PAGE is its own route, mounted by `App.jsx` — the front-end seam the
  // ledger has always named. The SWITCH now also sits on the borrower's home
  // screen (owner-directed 2026-08-17, "put the switch on the borrower's home
  // screen"), which makes `Dashboard.jsx` the third RTL file allowed to reference
  // long-term code — and the ledger grants that per file, in writing.
  //
  // SO THE ASSERTIONS BELOW PIN THE NARROWNESS, NOT MERELY THE WIRING. The
  // permission is "to render the switch"; the failure it has to catch is that
  // permission quietly widening into a general licence for the borrower portal
  // to pull long-term components in one at a time.
  ok(fs.existsSync(path.join(REPO, 'app-v2/src/longterm/BorrowerLongTerm.jsx')),
    'the client\'s long-term side is a real screen');
  ok(app.includes('path="/long-term"'), '…mounted by the router at its own route');

  const dashLtImports = dash.match(/^\s*import[^\n]*from '\.\.\/longterm\/[^\n]*$/gm) || [];
  ok(dashLtImports.length === 1,
    'the borrower home screen holds EXACTLY ONE long-term reference — not a growing list');
  ok(/BorrowerLongTermSwitch/.test(dashLtImports[0] || ''),
    '…and it is the SWITCH, which is the only thing the ledger authorises there');
  ok(/<BorrowerLongTermSwitch\s*\/>/.test(dash),
    '…actually rendered on the home screen, not imported and forgotten');

  // The rule "does this client have a long-term side at all?" stays on the
  // long-term side of the wall. If the dashboard asked that question itself there
  // would be two definitions of it, and the copy inside RTL is the one nobody
  // maintains.
  ok(!/useLongTermSide|ltApi|myLoans/.test(dash),
    'the home screen never decides FOR ITSELF whether the client has a long-term side');
  const btl = read('app-v2/src/longterm/BorrowerLongTerm.jsx');
  ok(/export function BorrowerLongTermSwitch/.test(btl),
    'the switch component lives on the long-term side');
  ok(/if \(!ready \|\| !enabled \|\| !loans\.length\) return null/.test(btl),
    '…and shows nothing to a client with no long-term loans — never a door onto an empty room');

  // The ledger is the authority, so it must actually SAY so — a crossing that
  // only exists in code is the thing the whole gate is built to refuse.
  const ledger = read('docs/LONG-TERM-AUTHORIZED-COPIES.md');
  const authorizedBlock = (ledger.match(/```authorized\n([\s\S]*?)```/) || [])[1] || '';
  ok(authorizedBlock.includes('rtl-import app-v2/src/screens/Dashboard.jsx'),
    'the crossing is recorded in the ledger the CI gate reads');

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
  let touchedStageSettings = false;
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
    // ==========================================================================
    // F. THE STATUS MAP — the three layers, and only the middle one is ours.
    //
    // The owner asked for the report of every file's milestone and status "so I can
    // give you the exact mapping of what everything means. We need to rephrase this
    // in our system with our own statuses, more user-friendly." This is the surface
    // that rephrasing happens on, so what it must get right is: show all three
    // layers, let ours be renamed, and NEVER lose a loan doing it.
    // ==========================================================================
    const stagesMod = require('../src/longterm/routes/stages');
    const stagesHandle = layerFor(stagesMod, '/');
    ok(stagesHandle, 'the status map exposes GET /');

    // IT IS READ-ONLY. A change is a SETTINGS change and goes through the one
    // writer; a second write door here would be a second way to change one thing.
    const writeDoors = stagesMod.stack.filter((l) => l.route
      && Object.keys(l.route.methods || {}).some((m) => m !== 'get'));
    eq(writeDoors.length, 0, 'the status map has NO write door of its own — the settings door is the one writer');

    // A milestone on live files that the published ladder does not carry. It is
    // real and it needs an answer, so it must be LISTED — the one row somebody has
    // to map would otherwise be the one row this screen hides.
    const strayName = `${tag} Milestone Nobody Published`;
    // `stage_key` is set to the unmapped bucket as well, because that is what the
    // sync itself writes for a milestone the map does not carry (`stages.stageFor`
    // → `UNMAPPED_STAGE`). Changing only the name would leave the row carrying
    // whatever stage it was stored under and the assertion below would be about a
    // state the sync never produces.
    await db.query(
      `UPDATE lt_loans SET milestone_name=$2, stage_key=$3 WHERE id=$1::uuid`,
      [loanIds[3], strayName, require('../src/longterm/stages').UNMAPPED_STAGE.key],
    );

    const smap = await drive(stagesHandle, { actor, query: {} });
    eq(smap.status, 200, 'the status map answers cleanly');
    ok(smap.body.stages.length >= 9, 'it carries OUR stages');
    const ctc = smap.body.stages.find((s) => s.key === 'clear_to_close');
    ok(ctc && ctc.label === 'Clear to Close', '…by the name we call them, not the stored key');
    ok(typeof ctc.files === 'number', '…each with how many files are sitting on it');

    const ladder = new Map(smap.body.milestones.map((m) => [m.milestone, m]));
    const clearRow = ladder.get('Clear To Close');
    ok(clearRow, 'Encompass\'s own milestone is listed');
    eq(clearRow.stageKey, 'clear_to_close', '…pointed at our stage');
    eq(clearRow.borrowerWording, 'Final Approval',
      '…beside what the BORROWER is told, which is Encompass\'s wording and read-only here');
    ok(clearRow.files >= 1, '…and how many files are on it');

    const stray = ladder.get(strayName);
    ok(stray, 'a milestone on live files but NOT in the Encompass ladder is still LISTED');
    eq(stray.inCatalog, false, '…flagged as not in the ladder, so it can be answered');
    eq(stray.mapped, false, '…and honestly reported as unmapped rather than guessed at');
    ok(smap.body.unmappedStage.files >= 1, '…and it shows up in the unmapped bucket, never invisible');

    const asOfficer2 = await drive(stagesHandle, { actor: { id: null, role: 'loan_officer', kind: 'staff' }, query: {} });
    eq(asOfficer2.body.canManage, false, 'a loan officer SEES the map and is told they may not change it');

    // RENAMING IS A SETTINGS CHANGE, AND THE WHOLE SYSTEM READS THE NEW NAME.
    // Proven by asking a DIFFERENT screen: the census must print the new word, or
    // the two surfaces are reading two lists.
    const settingsStore = require('../src/longterm/settings/store');
    const stagesLib = require('../src/longterm/stages');
    touchedStageSettings = true;
    await settingsStore.save({
      'stages.order': stagesLib.DEFAULT_STAGES.map((s) => (s.key === 'clear_to_close'
        ? { ...s, label: 'Ready to Close' } : s)),
    }, { actorId: null });

    const renamed = await drive(stagesHandle, { actor, query: {} });
    eq(renamed.body.stages.find((s) => s.key === 'clear_to_close').label, 'Ready to Close',
      'a renamed stage comes back renamed');
    const bookAfter = await drive(bookHandle, { actor, query: {} });
    eq(new Map(bookAfter.body.stages.map((s) => [s.key, s.label])).get('clear_to_close'), 'Ready to Close',
      'THE CENSUS READS THE SAME LIST — one definition, so two screens can never call one stage two things');
    const csvAfter = await drive(csvHandle, { actor, query: {} });
    ok(String(csvAfter.sent).includes('"Ready to Close"'),
      '…and so does the spreadsheet');

    // THE KEY NEVER MOVES. Renaming changes the words on our screens and nothing
    // about the loans — every stored row still carries `clear_to_close`.
    const { rows: [stored] } = await db.query(
      `SELECT stage_key FROM lt_loans WHERE id=$1::uuid`, [loanIds[0]]);
    eq(stored.stage_key, 'clear_to_close',
      'the stored stage KEY is untouched by a rename — which is the whole safety property');

    // A MAP NAMING A STAGE THAT DOES NOT EXIST MUST NOT LOSE THE LOAN.
    const nonsense = stagesLib.stageForMilestone('Clear To Close', stagesLib.configFrom({
      'stages.order': stagesLib.DEFAULT_STAGES,
      'stages.map': { 'Clear To Close': 'a-stage-nobody-declared' },
    }));
    eq(nonsense.key, stagesLib.UNMAPPED_STAGE.key,
      'a misconfigured map lands the loan in the unmapped bucket');
    eq(nonsense.mapped, false, '…and says it is a fallback rather than pretending');
  } finally {
    if (touchedStageSettings) {
      // Put the shipped names back. Leaving a renamed stage behind would be this
      // suite quietly reconfiguring the tenant.
      const settingsStore = require('../src/longterm/settings/store');
      const stagesLib = require('../src/longterm/stages');
      await settingsStore.save({
        'stages.order': stagesLib.DEFAULT_STAGES, 'stages.map': stagesLib.DEFAULT_MAP,
      }, { actorId: null }).catch(() => {});
    }
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
