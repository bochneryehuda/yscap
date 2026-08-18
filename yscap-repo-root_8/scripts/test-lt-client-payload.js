#!/usr/bin/env node
'use strict';
/**
 * LT — THE CLIENT PAYLOAD IS BUILT *FOR* THE CLIENT, AND THE INVESTOR IS NOT IN IT.
 *
 * Owner-directed 2026-08-14, in his own words:
 *   "You also need to make sure that you put a hard rule to block the investor name.
 *    The client should not be able to see the investor name. Never ever! Not
 *    borrowers, not TPOs, only internal staff."
 *
 * WHY THIS SUITE EXISTS, MEASURED. `audience.js` states the rule and provides TWO
 * defences: (a) don't send it — `maySeeField` / `stripInternalOnly` — and (b) scrub
 * free text — `scrubInvestorNames`. On 2026-08-17 a grep of the whole repository
 * found **zero** callers of `maySeeField` and `stripInternalOnly` outside
 * `audience.js` and its own unit test, while three other long-term modules cite that
 * file as "the ONE definition". The STRONGER of the two defences was inert, and
 * nothing anywhere would have gone red about it. `test-lt-investor-block.js` proves
 * the RULE; this proves the rule is IN THE PATH of the route a client actually hits.
 *
 * IT ASSERTS AGAINST THE REGISTRY, never a hand-typed list of names: every recorded
 * spelling of every investor (150 of them, `encompass/investors.js`) is planted in
 * every free-text field a client is sent and swept back out of the real HTTP
 * response — for a BORROWER and for a TPO BROKER, the two audiences the owner named.
 *
 * AND THE CONTROL, which matters as much: an INTERNAL audience must still see
 * everything. A guard that hides the investor from our own desk is a different bug.
 *
 * Section A is pure and always runs. Section B needs a database and skips cleanly
 * without one, like every other suite in the chain.
 *
 *   node scripts/test-lt-client-payload.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'src/longterm/audience'));
const clientView = require(path.join(ROOT, 'src/longterm/client-view'));
const investors = require(path.join(ROOT, 'src/longterm/encompass/investors'));

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** Every spelling the tenant has actually used, from the registry. Never a list. */
function everySpelling() {
  const out = [];
  for (const inv of investors.INVESTORS) {
    for (const raw of [inv.label].concat(inv.aliases || [])) {
      const s = String(raw || '').trim();
      if (s) out.push({ key: inv.key, name: s });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. PURE — the guard is in the path, and it is audience.js's guard.
// ═══════════════════════════════════════════════════════════════════════════════
function pure() {
  console.log('LT — a client payload is BUILT for the client');

  // ── A1. Who is asking. Fails closed, exactly like isClient. ──────────────────
  check(A.audienceOfActor({ kind: 'staff' }) === A.AUDIENCES.INTERNAL,
    'our own staff are the INTERNAL audience');
  check(A.audienceOfActor({ kind: 'borrower' }) === A.AUDIENCES.BORROWER,
    'a borrower is the borrower audience');
  check(A.audienceOfActor({ kind: 'tpo' }) === A.AUDIENCES.TPO,
    'a TPO broker is the broker audience — an OUTSIDE company');
  for (const odd of [undefined, null, {}, { kind: '' }, { kind: 'admin' }, 'internal', 0]) {
    check(A.isClient(A.audienceOfActor(odd)),
      `an unknown, missing or invented actor (${JSON.stringify(odd)}) is treated as a CLIENT — fails closed`);
  }

  // ── A2. The production field list is honest. ─────────────────────────────────
  const fields = clientView.CLIENT_LOAN_FIELDS;
  check(fields.length > 0 && fields.every((f) => typeof f.key === 'string' && typeof f.value === 'function'),
    'every client field declares a name and how it is read');
  check(fields.every((f) => 'fieldId' in f && 'column' in f && 'text' in f),
    '…and declares its SOURCE, so the guard has something to judge it by');
  for (const aud of ['borrower', 'tpo']) {
    check(clientView.withheldFields(aud).length === 0,
      `nothing on the client list has to be withheld from a ${aud} — it was written for them`);
  }

  // ── A3. maySeeField IS IN THE PATH — proven by adding a field that comes from
  //        an investor field id. The production list is untouched; the builder
  //        takes the list, so this asks the real code the real question.
  // ─────────────────────────────────────────────────────────────────────────────
  const INVESTOR_SOURCED = [
    ['whichInvestor', 'CX.WHICHINVESTOR', 'Deephaven'],
    ['investorNameAccurate', 'VEND.X263', 'Deephaven Mortgage LLC'],
    ['investorRef', 'VEND.X276', '25098221'],
    ['investorEmailField', 'VEND.X273', 'ops@deephaven.example'],
    ['investorZip', 'VEND.X267', '28202'],
    ['tableFunder', 'CX.TABLEFUNDER', 'Correspondent'],
  ];
  const probeFields = clientView.CLIENT_LOAN_FIELDS.concat(
    INVESTOR_SOURCED.map(([key, fieldId, val]) => ({
      key, fieldId, column: null, text: false, value: () => val,
    })),
    // Sourced from one of OUR OWN internal-only columns rather than an Encompass
    // field — the other half of "don't send it".
    [{
      key: 'fundingChannelColumn',
      fieldId: null,
      column: 'lt_loan_investors.funding_channel',
      text: false,
      value: () => 'Correspondent',
    },
    // Declares NO source at all, and is internal by NAME. This is what
    // stripInternalOnly is the belt for.
    {
      key: 'investorName', fieldId: null, column: null, text: false, value: () => 'Deephaven',
    }],
  );
  const row = {
    id: 'x', loan_number: 'LT-1', program_name: 'Investor DSCR 30 YEAR FRM',
    term_months: 360, loan_amount: 500000, milestone_name: 'Submittal',
    stage_key: 'submittal', consumer_status: 'Submitted for Approval',
  };
  const extraKeys = INVESTOR_SOURCED.map(([k]) => k).concat(['fundingChannelColumn', 'investorName']);

  for (const aud of ['borrower', 'tpo']) {
    const view = clientView.buildLoanView(row, {}, aud, probeFields);
    for (const k of extraKeys) {
      check(!(k in view), `${k} never reaches a ${aud} — the payload is built without it`);
    }
    check(view.programName === 'Investor DSCR 30 YEAR FRM' && view.loanAmount === 500000,
      `…while a ${aud} still gets everything they are entitled to`);
    check(clientView.withheldFields(aud, probeFields).length === extraKeys.length - 1,
      `…and the withheld list names the ${extraKeys.length - 1} source-declared fields (the last is caught by name)`);
  }

  // ── A4. THE CONTROL. Internal staff see all of it, untouched. ────────────────
  const internal = clientView.buildLoanView(row, {}, A.AUDIENCES.INTERNAL, probeFields);
  for (const [key, , val] of INVESTOR_SOURCED) {
    check(internal[key] === val, `INTERNAL staff still see ${key} — the rule hides it from CLIENTS`);
  }
  check(internal.fundingChannelColumn === 'Correspondent',
    'INTERNAL staff still see the funding channel');
  check(internal.investorName === 'Deephaven',
    'INTERNAL staff still see the investor name — a guard that hides it from our own desk is a different bug');

  // ── A5. Free text is still scrubbed (defence (b) is kept, not replaced). ─────
  const dirty = clientView.buildLoanView({
    ...row,
    program_name: 'Deephaven DSCR 30 YEAR FRM',
    milestone_name: 'Sent to Oak Tree for review',
    consumer_status: 'Per emcep guidelines, in review',
  }, {}, 'borrower');
  check(!A.mentionsInvestor(JSON.stringify(dirty)),
    'a typed investor name in the program, the milestone and the status is scrubbed for a borrower');
  check(String(dirty.programName).includes(A.REDACTION),
    '…and replaced with the neutral wording, not blanked into a mystery');
  const dirtyTpo = clientView.buildLoanView({
    ...row, program_name: 'Deephaven DSCR 30 YEAR FRM',
  }, {}, 'tpo');
  check(dirtyTpo.programName === dirty.programName,
    'a TPO is redacted exactly as a borrower is');
  const dirtyInternal = clientView.buildLoanView({
    ...row, program_name: 'Deephaven DSCR 30 YEAR FRM',
  }, {}, 'internal');
  check(dirtyInternal.programName === 'Deephaven DSCR 30 YEAR FRM',
    'and internal text is returned completely untouched');

  // ── A6. The SELECT itself may not read an investor column. ───────────────────
  let threw = null;
  try {
    clientView.assertNoInternalColumns(
      'SELECT l.id, i.investor_email FROM lt_loans l JOIN lt_loan_investors i ON i.loan_id = l.id', 'a probe',
    );
  } catch (e) { threw = e; }
  check(threw && /investor_email/.test(threw.message),
    'a client query that reads an investor column is REFUSED, by name');
  check(clientView.assertNoInternalColumns('SELECT l.id, l.loan_number FROM lt_loans l') === true,
    '…and an ordinary client query passes');
  // Requiring the route runs that assertion over its own SQL: if the live query
  // ever read an investor column the module could not load at all.
  let loaded = true;
  try { require(path.join(ROOT, 'src/longterm/routes/my-loans')); } catch { loaded = false; }
  check(loaded, "the borrower route's own query passes that guard at load time");

  // ── A7. The route is the CLIENT door, and the mount is what keeps it one. ────
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  check(/app\.use\('\/api\/lt\/my',\s*requireAuth,\s*requireBorrower/.test(server),
    'the borrower long-term door is mounted borrower-authenticated');
  check(/app\.use\('\/api\/lt',\s*requireAuth,\s*requireStaff/.test(server),
    '…and every other long-term route is staff-only, so a broker session cannot reach one today');
}

// ═══════════════════════════════════════════════════════════════════════════════
// B. END TO END — the real route, a real database, a real HTTP response, and
//    every recorded spelling of every investor swept through it.
// ═══════════════════════════════════════════════════════════════════════════════
async function endToEnd() {
  const express = require('express');
  const http = require('http');
  const db = require(path.join(ROOT, 'src/longterm/db'));
  const settingsStore = require(path.join(ROOT, 'src/longterm/settings/store'));
  const router = require(path.join(ROOT, 'src/longterm/routes/my-loans'));

  const tag = `ltcp${Date.now().toString(36)}`;
  const MILESTONE_ID = `${tag}-ms`;
  const MILESTONE_NAME = `${tag} milestone`;

  // The actor the fake mount hands the router. The REAL mount is borrower-only
  // (asserted in A7); driving it as a broker is how we prove the payload would
  // still be safe the day a broker door is opened, and as staff is the control.
  let ACTOR = null;
  const app = express();
  app.use('/api/lt/my', (req, res, next) => { req.actor = ACTOR; next(); }, router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/lt/my/loans`;
  const get = async () => {
    const res = await fetch(base);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };

  let borrowerId = null;
  try {
    // Make sure nothing has the borrower-facing side switched off under us. Saving
    // the DECLARED default clears any override rather than writing one.
    await settingsStore.save({ 'borrower.longTermVisible': true }, { staffId: null });
    settingsStore.bust();

    const b = await db.query(
      `INSERT INTO borrowers (id, first_name, last_name, email)
       VALUES (gen_random_uuid(), 'Sweep', 'Client', $1) RETURNING id`,
      [`${tag}@example.com`],
    );
    borrowerId = b.rows[0].id;

    await db.query(
      `INSERT INTO lt_encompass_milestones
         (milestone_id, sequence, milestone_name, assignment_required, expected_days,
          tpo_status, consumer_status)
       VALUES ($1, 9999, $2, false, 1, 'In Process', 'Collecting Information')`,
      [MILESTONE_ID, MILESTONE_NAME],
    );

    // TWO loans, so one HTTP response carries FOUR planted sentence shapes:
    //   A — the program name and the milestone name (its milestone joins nothing,
    //       so its status falls back to our own stage wording);
    //   B — the program name in a FILENAME shape (no spaces around the name) and
    //       the tenant's own consumer wording, which is what the client reads.
    const mkLoan = async (n, milestoneName, milestoneId) => {
      const { rows } = await db.query(
        `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_id, term_months,
                               program_name, stage_key, milestone_name, milestone_id, loan_amount,
                               encompass_synced_at)
         VALUES (gen_random_uuid(), $1, $1, $2::uuid, 360, 'Investor DSCR 30 YEAR FRM',
                 'submittal', $3, $4, 500000, now())
         RETURNING id`,
        [`${tag}-${n}`, borrowerId, milestoneName, milestoneId],
      );
      return rows[0].id;
    };
    const loanA = await mkLoan('a', `${tag} unpublished milestone`, null);
    const loanB = await mkLoan('b', MILESTONE_NAME, MILESTONE_ID);

    // ── B1. THE BASELINE, so the sweep's verdicts mean something. ──────────────
    ACTOR = { kind: 'borrower', id: borrowerId };
    const baseline = await get();
    check(baseline.status === 200 && baseline.body.enabled === true,
      'the borrower door answers, switched on');
    check(baseline.body.loans.length === 2,
      'both of this client\'s long-term files come back — a sweep over an empty payload proves nothing');
    check(!A.mentionsInvestor(baseline.text),
      'with nothing planted, the response names no investor — the fixtures are clean');
    check(!baseline.text.includes(A.REDACTION),
      '…and nothing was redacted, so a later redaction is this sweep\'s doing');
    for (const loan of baseline.body.loans) {
      for (const k of A.INTERNAL_ONLY_KEYS) {
        if (k in loan) { check(false, `the client payload carries the internal-only key ${k}`); }
      }
    }
    check(true, `no internal-only key (${A.INTERNAL_ONLY_KEYS.length} of them) appears on a client's loan`);

    // ── B2. THE SWEEP. Every recorded spelling, four sentence shapes, both
    //        client audiences, through the real route.
    // ──────────────────────────────────────────────────────────────────────────
    const spellings = everySpelling();
    check(spellings.length >= 100,
      `${spellings.length} recorded spellings will be swept through the live route`);

    const survived = [];
    const unredacted = [];
    const shortPayload = [];
    const AUDS = [
      { label: 'borrower', actor: (id) => ({ kind: 'borrower', id }) },
      { label: 'tpo broker', actor: (id) => ({ kind: 'tpo', id }) },
    ];

    for (const { key, name } of spellings) {
      await db.query(
        `UPDATE lt_loans
            SET program_name = $2, milestone_name = $3
          WHERE id = $1::uuid`,
        [loanA, `Per ${name} guidelines, two months of statements are needed.`,
          `Approval received from ${name} on 5/2.`],
      );
      await db.query(
        'UPDATE lt_loans SET program_name = $2 WHERE id = $1::uuid',
        [loanB, `${name}_approval_signed.pdf`],
      );
      await db.query(
        'UPDATE lt_encompass_milestones SET consumer_status = $2 WHERE milestone_id = $1',
        [MILESTONE_ID, `Sent to ${name} for review`],
      );

      for (const aud of AUDS) {
        ACTOR = aud.actor(borrowerId);
        const res = await get();
        if (res.body.loans.length !== 2) shortPayload.push(`${aud.label} · ${key} "${name}"`);
        if (A.mentionsInvestor(res.text)) survived.push(`${aud.label} · ${key}: "${name}"`);
        if (!res.text.includes(A.REDACTION)) unredacted.push(`${aud.label} · ${key}: "${name}"`);
      }
    }

    check(shortPayload.length === 0,
      `every sweep answered with both files (${shortPayload.length} short)`);
    check(survived.length === 0,
      `NOT ONE recorded spelling survives to a borrower or a TPO (${survived.length} survived)`);
    if (survived.length) survived.slice(0, 8).forEach((m) => console.error(`         · ${m}`));
    check(unredacted.length === 0,
      `every sweep actually redacted something — the guard fired, it did not merely not-fail (${unredacted.length} silent)`);
    if (unredacted.length) unredacted.slice(0, 8).forEach((m) => console.error(`         · ${m}`));

    // ── B3. THE CONTROL, end to end. Internal staff see the truth. ─────────────
    // The live mount refuses a staff session (A7), so this is the router being
    // asked the same question by our own desk: the guard must be about the
    // AUDIENCE, not a blanket scrub applied to everyone.
    const control = 'Deephaven Mortgage LLC';
    await db.query(
      'UPDATE lt_loans SET program_name = $2, milestone_name = $3 WHERE id = $1::uuid',
      [loanA, `Per ${control} guidelines, two months of statements are needed.`,
        `Approval received from ${control} on 5/2.`],
    );
    await db.query(
      'UPDATE lt_encompass_milestones SET consumer_status = $2 WHERE milestone_id = $1',
      [MILESTONE_ID, `Sent to ${control} for review`],
    );

    ACTOR = { kind: 'staff', id: borrowerId };
    const staff = await get();
    check(staff.body.loans.length === 2, 'internal staff get the same two files');
    check(staff.text.includes(control),
      'INTERNAL staff see the investor name VERBATIM — in the program and the milestone');
    check(!staff.text.includes(A.REDACTION),
      '…nothing is redacted for our own desk');

    ACTOR = { kind: 'borrower', id: borrowerId };
    const client = await get();
    check(!client.text.includes(control) && !A.mentionsInvestor(client.text),
      'the very same rows, asked for by the client, name no investor');
  } finally {
    ACTOR = null;
    await new Promise((r) => server.close(r));
    try {
      await db.query('DELETE FROM lt_loans WHERE loan_number LIKE $1', [`${tag}-%`]);
      await db.query('DELETE FROM lt_encompass_milestones WHERE milestone_id = $1', [MILESTONE_ID]);
      if (borrowerId) await db.query('DELETE FROM borrowers WHERE id = $1::uuid', [borrowerId]);
    } catch (e) {
      console.error('  note  cleanup failed:', (e && e.message) || e);
    }
    try { await db.pool.end(); } catch { /* the pool may already be closed */ }
  }
}

async function main() {
  pure();
  if (failures) {
    console.error(`\nFAILED — ${failures} check(s) before the database section ran.`);
    process.exit(1);
  }
  await require(path.join(__dirname, 'lib/db-gate')).skipUnlessDb('lt-client-payload');
  console.log('\nLT — the same rule, through the live route, on a real database');
  await endToEnd();

  if (failures) {
    console.error(`\nFAILED — ${failures} check(s). The investor name could reach a client.`);
    process.exit(1);
  }
  console.log('\nOK — the client payload is built for the client, and internal staff still see everything.');
}

main().catch((e) => {
  console.error('FAILED —', (e && e.stack) || e);
  process.exit(1);
});
