#!/usr/bin/env node
'use strict';
/**
 * LT test — SAVED SCENARIOS, against a real database, over real HTTP
 * (owner-directed 2026-08-31; db/658).
 *
 * The properties worth holding, in the order they can go wrong:
 *   • A SCENARIO IS INPUTS, NOT A PRICE. The one stored figure is a dated
 *     headline whose date is OUR clock, drawn from a WHITELIST — an open bag
 *     would let a whole board be written here and read back tomorrow as though
 *     it were still true, which is the one expensive mistake this feature has.
 *   • THE FORM AND THE SCENARIO ARE BOTH STORED, and that is not redundant:
 *     `toScenario` drops what was not typed, so a scenario alone cannot restore
 *     the boxes and re-opening one would silently re-price a different deal.
 *   • SAVING ALWAYS CREATES. Deliberately unlike an investor group, where the
 *     same name is an edit: two searches on one property at different leverage
 *     are two scenarios somebody wants BOTH of.
 *   • A PATCH MOVES ONLY WHAT WAS SENT — a rename must not blank the deal.
 *   • PERSONAL means personal: somebody else's is a 404 on every door.
 *   • THE DELETE IS SOFT AND BY HAND ONLY (D5) — the owner accepted that a list
 *     never ages out, so nothing anywhere may set `deleted_at` on a timer.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-pricer-scenarios-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-pricer-scenarios-test-secret';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const auth = require('../src/auth');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const made = { staff: [] };

(async () => {
  const app = require('../src/server');
  // The server kicks its migrations off asynchronously — a suite that writes
  // straight away races a brand-new table into existence (the standing lesson).
  await require('../src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltsc${Date.now()}`;

  const call = async (method, p, token, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };
  const URL_BASE = '/api/lt/dscr/scenarios';

  try {
    console.log('LT — the pricing engine\'s saved scenarios (db/658)');

    const { rows: people } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Scenario Officer', 'loan_officer', true),
                   ($2, 'Other Scenario Officer', 'loan_officer', true)
         RETURNING id, full_name`,
      [`${stamp}.one@example.test`, `${stamp}.two@example.test`],
    );
    made.staff = people.map((p) => p.id);
    const one = people.find((p) => p.full_name === 'Scenario Officer');
    const two = people.find((p) => p.full_name === 'Other Scenario Officer');
    const tokOne = await auth.mintStaffSession(one.id);
    const tokTwo = await auth.mintStaffSession(two.id);

    // ── A. the table itself, per db/658 ──────────────────────────────────────
    const { rows: cols } = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'lt_pricer_scenarios'`,
    );
    const colMap = new Map(cols.map((c) => [c.column_name, c]));
    check(['id', 'staff_id', 'name', 'borrower_name', 'entity_name', 'property_address',
      'form', 'scenario', 'calc', 'saved_board', 'saved_board_at',
      'created_at', 'updated_at', 'deleted_at'].every((c) => colMap.has(c)),
    'db/658 built the table with every declared column');
    check(colMap.get('staff_id') && colMap.get('staff_id').is_nullable === 'YES',
      'staff_id is NULLABLE — the identity FK is ON DELETE SET NULL, so losing a person never deletes their work');
    check(!colMap.has('expires_at') && !colMap.has('archived_at'),
      'there is NO ageing column for a future sweep to find (D5 — a scenario lives until its owner deletes it)');

    const { rows: idx } = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'lt_pricer_scenarios'`,
    );
    check(idx.some((r) => /lt_pricer_scenarios_mine_idx/.test(r.indexdef)
      && /staff_id/.test(r.indexdef) && /deleted_at IS NULL/.test(r.indexdef)),
    'the list index is PARTIAL on the un-deleted rows — a deleted scenario is never listed');

    const { rows: fk } = await db.query(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'lt_pricer_scenarios_staff_fkey'`,
    );
    check(fk.length === 1 && fk[0].confdeltype === 'n',
      'the staff_users FK is ON DELETE SET NULL — the authorized identity crossing, in its uniform shape');

    // ── B. the empty start, and the two refusals ─────────────────────────────
    const empty = await call('GET', URL_BASE, tokOne);
    check(empty.status === 200 && Array.isArray(empty.json.scenarios) && empty.json.scenarios.length === 0,
      'a fresh person has no scenarios');

    const nothing = await call('POST', URL_BASE, tokOne, { name: 'Nothing', form: {} });
    check(nothing.status === 400, 'a scenario with nothing typed in it is refused with a reason');

    const huge = {};
    for (let i = 0; i < 400; i += 1) huge[`f${i}`] = 'x'.repeat(180);
    const tooBig = await call('POST', URL_BASE, tokOne, { name: 'Huge', form: huge });
    check(tooBig.status === 400 && /too large/i.test(String(tooBig.json.error || '')),
      'a body too large to be a form is REFUSED, never truncated — half a scenario would re-price a different deal');

    // ── C. the save, and the auto-name ladder (D6) ───────────────────────────
    const FORM = {
      purpose: 'Purchase', propertyType: 'SFR', value: '500000', loan: '350000',
      fico: '740', dscr: '1.25', amountMode: 'loan', state: 'NJ', zip: '07001',
    };
    const SCEN = { loanPurpose: 'Purchase', loanAmount: 350000, propertyValue: 500000, fico: 740 };
    const CALC = { rent: '4200', taxes: '600', insurance: '150' };

    const saved = await call('POST', URL_BASE, tokOne, {
      propertyAddress: '12 Oak Street, Lakewood, NJ 08701',
      borrowerName: 'Sample Borrower',
      form: FORM, scenario: SCEN, calc: CALC,
    });
    check(saved.status === 200 && saved.json.ok === true && saved.json.scenario.id,
      'a real scenario saves');
    check(saved.json.scenario.name === '12 Oak Street, Lakewood, NJ 08701',
      '…auto-named from the ADDRESS when nobody typed a name — what a person recognises in a list');
    const firstId = saved.json.scenario.id;

    const byParty = await call('POST', URL_BASE, tokOne,
      { entityName: 'Oak Holdings LLC', form: FORM });
    check(byParty.json.scenario.name === 'Oak Holdings LLC',
      '…falling back to the PARTY with no address');
    const byTerms = await call('POST', URL_BASE, tokOne, { form: FORM });
    check(byTerms.json.scenario.name === 'Purchase · $350000 · SFR',
      `…then to the headline TERMS, which the form always holds (got "${byTerms.json.scenario.name}")`);
    const untitled = await call('POST', URL_BASE, tokOne, { form: { fico: '740' } });
    check(untitled.json.scenario.name === 'Untitled scenario',
      '…and only then to "Untitled scenario" — never a bare date, which says nothing about which deal it was');

    // ── D. saving ALWAYS creates (deliberately unlike an investor group) ─────
    const twinA = await call('POST', URL_BASE, tokOne, { name: 'Same Name', form: FORM });
    const twinB = await call('POST', URL_BASE, tokOne, { name: 'Same Name', form: { ...FORM, loan: '300000' } });
    check(twinA.json.scenario.id !== twinB.json.scenario.id,
      'the same NAME saved twice makes TWO scenarios — two leverage points on one property are two things somebody wants BOTH of');
    const listAfterTwins = await call('GET', URL_BASE, tokOne);
    check(listAfterTwins.json.scenarios.filter((s) => s.name === 'Same Name').length === 2,
      '…and both are in the list');

    // ── E. a scenario is INPUTS — the dated headline, and nothing else ───────
    const boarded = await call('POST', URL_BASE, tokOne, {
      name: 'With a headline',
      form: FORM,
      savedBoard: {
        bestRate: 7.125, bestPrice: 100.5, programs: 12, lenders: 4,
        // Everything below is what an open bag would have let through: a whole
        // priced board, read back tomorrow as though it were still true.
        rows: [{ lender: 'Verus', rate: 7.125, price: 100.5 }],
        quoteId: 'LP-123', lockExpiresAt: '2026-09-30', monthlyPayment: 2410.55,
        at: '1999-01-01T00:00:00.000Z',
      },
    });
    const board = boarded.json.scenario.savedBoard;
    check(board && board.bestRate === 7.125 && board.programs === 12 && board.lenders === 4,
      'the dated headline keeps the four figures it is a whitelist of');
    check(!('rows' in board) && !('quoteId' in board) && !('lockExpiresAt' in board) && !('monthlyPayment' in board),
      '…and DROPS everything else — the one place a saved price could creep in is a whitelist, not an open bag');
    check(board.at && !String(board.at).startsWith('1999'),
      `…stamped with OUR clock, never the caller's (got ${board.at})`);
    const { rows: boardRow } = await db.query(
      'SELECT saved_board, saved_board_at FROM lt_pricer_scenarios WHERE id = $1::uuid',
      [boarded.json.scenario.id],
    );
    check(boardRow[0].saved_board_at != null,
      '…and the date is stored beside it, not derived on the way out');

    // A headline with no date is not a headline, so it never travels alone.
    await db.query('UPDATE lt_pricer_scenarios SET saved_board_at = NULL WHERE id = $1::uuid',
      [boarded.json.scenario.id]);
    const dateless = await call('GET', `${URL_BASE}/${boarded.json.scenario.id}`, tokOne);
    check(dateless.json.scenario.savedBoard === null,
      'a headline that has somehow lost its date is not returned at all — a figure with no "as at" is the saved price this must not become');

    const noBoard = await call('POST', URL_BASE, tokOne, { name: 'Never priced', form: FORM });
    check(noBoard.json.scenario.savedBoard === null,
      'a scenario built and saved without pricing it carries no headline — never a zero pretending to be one');

    // ── F. the form AND the scenario, which is not redundant ────────────────
    const opened = await call('GET', `${URL_BASE}/${firstId}`, tokOne);
    check(opened.status === 200 && opened.json.scenario.form.amountMode === 'loan'
      && opened.json.scenario.form.ltv === undefined,
    'what was TYPED comes back — the boxes can be restored, so re-opening cannot silently move somebody out of LTV mode');
    check(opened.json.scenario.scenario.loanAmount === 350000,
      '…and what was SENT comes back beside it');
    check(opened.json.scenario.calc.rent === '4200',
      '…and the calculator\'s own boxes, which are inputs too');

    // ── G. a bag is a flat bag of primitives ────────────────────────────────
    const junky = await call('POST', URL_BASE, tokOne, {
      name: 'Junk bag',
      form: { fico: '740', nested: { a: 1 }, list: [1, 2], nothing: null, fn: 'ok' },
    });
    const jf = junky.json.scenario.form;
    check(jf.fico === '740' && jf.fn === 'ok' && !('nested' in jf) && !('list' in jf) && !('nothing' in jf),
      'a form stores scalars only — a nested object here is either a mistake or somebody storing something else in this table');

    // ── H. a patch moves ONLY what was sent ─────────────────────────────────
    const renamed = await call('PATCH', `${URL_BASE}/${firstId}`, tokOne, { name: 'The Oak Street deal' });
    check(renamed.status === 200 && renamed.json.scenario.name === 'The Oak Street deal',
      'a scenario renames');
    check(renamed.json.scenario.form.loan === '350000'
      && renamed.json.scenario.propertyAddress === '12 Oak Street, Lakewood, NJ 08701',
    '…and the rename left the DEAL exactly as it was — only what was sent moves');

    const resaved = await call('PATCH', `${URL_BASE}/${firstId}`, tokOne,
      { form: { ...FORM, loan: '400000' } });
    check(resaved.json.scenario.form.loan === '400000' && resaved.json.scenario.name === 'The Oak Street deal',
      'a re-save moves the deal and leaves the NAME alone');

    const cleared = await call('PATCH', `${URL_BASE}/${firstId}`, tokOne, { name: '   ' });
    check(cleared.json.scenario.name === '12 Oak Street, Lakewood, NJ 08701',
      'a name cleared by hand goes back to the derived one — an unnamed row is a row nobody can pick out of a list');

    const nothingToDo = await call('PATCH', `${URL_BASE}/${firstId}`, tokOne, {});
    check(nothingToDo.status === 400, 'a patch that says nothing is refused rather than silently touching the row');

    // ── I. personal means personal ──────────────────────────────────────────
    const listTwo = await call('GET', URL_BASE, tokTwo);
    check(listTwo.status === 200 && listTwo.json.scenarios.length === 0,
      'the second person sees NONE of the first person\'s scenarios');
    const peek = await call('GET', `${URL_BASE}/${firstId}`, tokTwo);
    check(peek.status === 404,
      'reading somebody else\'s answers 404 — whether it exists is not this person\'s business');
    const steal = await call('PATCH', `${URL_BASE}/${firstId}`, tokTwo, { name: 'Mine now' });
    check(steal.status === 404, 'patching somebody else\'s answers 404 too');
    const stealDelete = await call('DELETE', `${URL_BASE}/${firstId}`, tokTwo);
    check(stealDelete.status === 404, 'and deleting somebody else\'s is not a delete');
    const stillMine = await call('GET', `${URL_BASE}/${firstId}`, tokOne);
    check(stillMine.status === 200 && stillMine.json.scenario.name === '12 Oak Street, Lakewood, NJ 08701',
      '…none of which touched the row');

    // ── J. the delete is SOFT, and by hand only ─────────────────────────────
    const removed = await call('DELETE', `${URL_BASE}/${firstId}`, tokOne);
    check(removed.status === 200, 'the owner removes their own scenario');
    const goneRead = await call('GET', `${URL_BASE}/${firstId}`, tokOne);
    check(goneRead.status === 404, '…it is gone from the read');
    const goneList = await call('GET', URL_BASE, tokOne);
    check(!goneList.json.scenarios.some((s) => s.id === firstId), '…and gone from the list');
    const { rows: softRow } = await db.query(
      'SELECT deleted_at FROM lt_pricer_scenarios WHERE id = $1::uuid', [firstId],
    );
    check(softRow.length === 1 && softRow[0].deleted_at != null,
      '…while the ROW is still there with its deleted_at set — soft, so a removal is recoverable');
    const secondDelete = await call('DELETE', `${URL_BASE}/${firstId}`, tokOne);
    check(secondDelete.status === 404, 'deleting it again is a 404, never a second delete');
    const patchDeleted = await call('PATCH', `${URL_BASE}/${firstId}`, tokOne, { name: 'Back' });
    check(patchDeleted.status === 404, 'and a deleted scenario cannot be patched back to life through the door');

    // NOTHING may set deleted_at on a timer (D5). The owner accepted in their
    // own words that a list never ages out, so the ONE writer of that column is
    // the delete a person presses — asserted on the SOURCE, because no
    // behaviour test can see a sweep that has not been written yet.
    const libSrc = fs.readFileSync(path.join(__dirname, '../src/longterm/pricer-scenarios.js'), 'utf8');
    const writers = (libSrc.match(/SET\s+deleted_at\s*=/gi) || []).length;
    check(writers === 1, `the library sets deleted_at in exactly ONE place (found ${writers})`);
    const sweepers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.js$/.test(e.name)) continue;
        if (full.endsWith('pricer-scenarios.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/lt_pricer_scenarios/.test(src) && /deleted_at\s*=/.test(src)) sweepers.push(full);
      }
    };
    walk(path.join(__dirname, '../src'));
    check(sweepers.length === 0,
      `no other module writes lt_pricer_scenarios.deleted_at — nothing ages a list out (${sweepers.join(', ') || 'none'})`);

    // ── K. no session, and no diagnostics door ──────────────────────────────
    const anon = await call('GET', URL_BASE, null);
    check(anon.status === 401 || anon.status === 403, `no session is refused (${anon.status})`);
    const anonSave = await call('POST', URL_BASE, null, { form: FORM });
    check(anonSave.status === 401 || anonSave.status === 403, `…and cannot save either (${anonSave.status})`);

    // makeRouter is what the secret diagnostics seam mounts; a scenario belongs
    // to ONE person, so it must not be reachable where nobody is signed in.
    const dscr = require('../src/longterm/routes/dscr-pricer');
    const stack = dscr.makeRouter().stack.map((l) => (l.route && l.route.path) || '').filter(Boolean);
    check(!stack.some((p) => /scenario/i.test(p)),
      `the diagnostics-mountable router carries no scenario route (${stack.join(', ')})`);
  } catch (e) {
    failures += 1;
    console.error('  FAIL suite threw:', (e && e.stack) || e);
  } finally {
    try {
      if (made.staff.length) {
        await db.query('DELETE FROM lt_pricer_scenarios WHERE staff_id = ANY($1::uuid[])', [made.staff]);
        await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made.staff]);
      }
    } catch (e) { console.error('  cleanup failed:', (e && e.message) || e); }
    process.exit(failures ? 1 : 0);
  }
})();
