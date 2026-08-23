'use strict';
/**
 * LONG-TERM — Phase 2, half two: bringing the loans in.
 *
 * Discovery says which loans exist and which have moved (discover.js, from the
 * pipeline). This mirrors them into `lt_loans`, records the stage they are at, and
 * pulls each one's team through the contact map. **Nothing is written to Encompass.**
 *
 * WHAT IS AND IS NOT TAKEN FROM THE PIPELINE — the plan's rule, made concrete.
 *
 *   The pipeline reads the Reporting Database, which lags a loan save and returns
 *   several computed fields as null. So it supplies IDENTITY and FRESHNESS only —
 *   the guid, the loan number, the folder, the milestone NAME, and when the loan
 *   last changed. Money, rate, term, DSCR and every other decision-bearing figure
 *   are deliberately left for the per-loan read, and this module writes none of
 *   them. `loan_amount` is the one borderline case and it is written from the
 *   pipeline ONLY to fill a blank, never to correct a value a real read established.
 *
 * FRESHNESS IS THE WHOLE ENGINE. `encompass_last_modified` is Encompass's own stamp;
 * `encompass_synced_at` is ours. A loan is re-read when Encompass's stamp is newer
 * than the one we stored — so an ordinary pass over 700 loans does almost no work,
 * and a loan somebody saved five minutes ago is picked up on the next tick.
 *
 * A FAILURE IS RECORDED ON THE LOAN, NOT SWALLOWED. `encompass_sync_error` holds the
 * reason one loan could not be read, and the pass continues. One unreadable file
 * must never stop the other 699, and a sync that fails silently is worse than one
 * that fails loudly — the column is what makes "why is this file stale?" answerable.
 *
 * SEPARATION: writes only `lt_*`.
 */

const stages = require('../stages');
// The master on/off switch. Asked DIRECTLY rather than through the Encompass client,
// because the tests replace that module wholesale in require.cache and a stub carries
// only the handful of methods the test needs — this one is pure and is never stubbed.
const killSwitch = require('../encompass/enabled');
const discover = require('./discover');
const contacts = require('../people/contacts');
const locks = require('../locks');
const milestones = require('../milestones');
const purchased = require('../milestone-purchased');
const productTerm = require('../product-term');
const borrowerMatch = require('../borrower-match');
const application = require('../application/sync');

const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
  get settings() { return require('../settings/store'); },
};

/** How many loans one pass will fully READ. Discovery is cheap; a loan read is not. */
const DEFAULT_READ_BUDGET = 25;

/**
 * Where a loan sits, in all three layers at once.
 *
 * The milestone name is stored VERBATIM — it is Encompass's word and the borrower's
 * label is derived from it, not from ours — and our own stage key is stored beside
 * it so the pipeline can group without re-deriving on every row. Both are written,
 * because an unmapped milestone must still land somewhere visible.
 */
function stageFor(milestoneName, settings) {
  const cfg = stages.configFrom(settings || {});
  const stage = stages.stageForMilestone(milestoneName, cfg);
  return { milestoneName: milestoneName || null, stageKey: stage.key, mapped: stage.mapped };
}

/**
 * Mirror what DISCOVERY knows. Identity and freshness only.
 *
 * `loan_number` and `loan_amount` use COALESCE on the EXISTING value so a pipeline
 * row that is momentarily missing a field cannot blank one we already hold — the
 * Reporting Database omits an unpopulated field entirely, and reading that omission
 * as "cleared" would empty the pipeline a column at a time.
 */
async function upsertDiscovered(dbc, loan, settings) {
  const { milestoneName, stageKey } = stageFor(loan.milestoneName, settings);
  const { rows } = await dbc.query(
    `INSERT INTO lt_loans
       (id, encompass_loan_guid, loan_number, loan_amount, milestone_name, stage_key,
        loan_folder, borrower_name, encompass_last_modified, updated_at,
        program_name, term_months)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $8, $7::timestamptz, now(), $9, $10)
     ON CONFLICT (encompass_loan_guid) DO UPDATE SET
       loan_number = COALESCE(EXCLUDED.loan_number, lt_loans.loan_number),
       borrower_name = COALESCE(EXCLUDED.borrower_name, lt_loans.borrower_name),
       loan_amount = COALESCE(lt_loans.loan_amount, EXCLUDED.loan_amount),
       milestone_name = COALESCE(EXCLUDED.milestone_name, lt_loans.milestone_name),
       stage_key = COALESCE(EXCLUDED.stage_key, lt_loans.stage_key),
       loan_folder = COALESCE(EXCLUDED.loan_folder, lt_loans.loan_folder),
       -- THE TWO THAT SAY WHOSE LOAN THIS IS. Discovery now reads them (fields 1401
       -- and 4), and storing them here rather than waiting for the per-loan read is
       -- what makes the pipeline's "this is the long-term pipeline" filter work on a
       -- book that has only just been discovered — otherwise every loan reads as
       -- unclassifiable until its full read lands, which on 772 files is the whole
       -- first hour. COALESCE(new, old) like every other mirrored column: a pass that
       -- could not read them must never blank what we already hold.
       program_name = COALESCE(EXCLUDED.program_name, lt_loans.program_name),
       term_months = COALESCE(EXCLUDED.term_months, lt_loans.term_months),
       encompass_last_modified = GREATEST(
         COALESCE(EXCLUDED.encompass_last_modified, lt_loans.encompass_last_modified),
         COALESCE(lt_loans.encompass_last_modified, EXCLUDED.encompass_last_modified)),
       updated_at = now()
     RETURNING id, encompass_synced_at, encompass_last_modified`,
    // Discovery has always READ `Loan.BorrowerName` and thrown it away. It is the
    // only thing an admin can recognise a loan's borrower BY while deciding a
    // link, and it costs nothing — it is already on the row we are writing.
    [loan.encompassLoanGuid, loan.loanNumber, loan.loanAmount, milestoneName, stageKey,
      loan.loanFolder, loan.lastModified, loan.borrowerName || null,
      loan.programName == null ? null : loan.programName,
      loan.termMonths == null ? null : loan.termMonths],
  );
  return rows[0];
}

/**
 * Does this loan need a full read?
 *
 * Never read → yes. Encompass's stamp newer than our sync → yes. Otherwise no. A
 * loan with NO Encompass stamp is read once and then left alone, rather than re-read
 * on every tick forever, because an absent stamp tells us nothing about change.
 */
function needsRead(row) {
  if (!row) return false;
  if (!row.encompass_synced_at) return true;
  if (!row.encompass_last_modified) return false;
  return new Date(row.encompass_last_modified).getTime() > new Date(row.encompass_synced_at).getTime();
}

/**
 * Read ONE loan properly and write what it says. READ-ONLY against Encompass.
 *
 * The milestone comes from the loan itself here rather than from the pipeline,
 * because the pipeline lags a save and the stage is what every screen groups by.
 */
async function readLoan(loanId, guid, settings) {
  let loan;
  try {
    loan = await lazy.client.getLoan(guid);
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 500);
    await lazy.db.query(
      `UPDATE lt_loans SET encompass_sync_error = $2, updated_at = now() WHERE id = $1::uuid`,
      [loanId, reason],
    );
    return { ok: false, reason };
  }

  const milestone = loan && (loan.currentMilestone || loan.currentMilestoneName
    || (loan.loanProductData && loan.loanProductData.currentMilestone));
  const { milestoneName, stageKey } = stageFor(milestone, settings);

  // WHICH PRODUCT IS THIS LOAN? The pipeline discovers with `Loan.LoanAmount > 0`
  // — the WHOLE Encompass book — because no folder separates the two products at
  // the source, so the long-term side mirrors RTL loans too and nothing told them
  // apart. `product-term.js` is that rule (owner-directed 2026-08-16: a program
  // naming FLIP is short-term; under 36 months is short-term; over 36 is the
  // long-term list). It needs two facts, and BOTH ride on the loan we already
  // hold — no second call and no fieldReader batch:
  //   · term  — field 4,    $.loanAmortizationTermMonths (int, filled on 760/772)
  //   · program — field 1401, $.loanProgramName          (str, filled on 754/772)
  // Read off the JSON deliberately rather than added to the fieldReader ids: the
  // LT client does NOT split a failed batch, so one unpermitted id would blank the
  // team AND the lock read for every loan. `_fieldValues`, when a caller has
  // already read them, still WINS — a value read by NUMBER is authoritative, and
  // the same field number sits at a different path from loan to loan.
  const fv = (loan && loan._fieldValues) || null;
  const termMonths = productTerm.termMonthsOf(
    (fv && (fv['4'] != null ? fv['4'] : fv[4])) ?? (loan && loan.loanAmortizationTermMonths),
  );
  const programName = String(
    (fv && (fv['1401'] != null ? fv['1401'] : fv[1401])) ?? (loan && loan.loanProgramName) ?? '',
  ).trim() || null;

  // WHO IS THE BORROWER? `lt_loans.borrower_id` has existed since db/549 and
  // nothing has ever written it, so a borrower signing in sees none of their
  // long-term files (owner-directed 2026-08-16). The link is proposed by matching
  // the borrower's EMAIL against their PILOT profile, and the address is right
  // here on the loan we already hold — field 1240,
  // `$.applications[0].borrower.emailAddressText`, filled on 92.4% of the DSCR
  // cohort (dictionary/field-dictionary.json, 772 loans, 2026-08-14). Read off the
  // JSON for the same reason the term and the program are: the LT client does not
  // split a failed fieldReader batch, so one unpermitted id would blank the team
  // and the lock for every loan. A value read BY NUMBER still wins where a caller
  // already has one — the same field sits at a different path from loan to loan.
  const app0 = (loan && Array.isArray(loan.applications) && loan.applications[0]) || null;
  const b0 = (app0 && app0.borrower) || null;
  const byNum = (id) => (fv && (fv[String(id)] != null ? fv[String(id)] : fv[id])) ?? undefined;
  const text = (v) => String(v == null ? '' : v).trim() || null;
  const borrowerFirst = text(byNum(4000) ?? (b0 && b0.firstName));
  const borrowerLast = text(byNum(4002) ?? (b0 && b0.lastName));
  // Stored normalised, because the matcher compares lowercased on both sides and
  // an index on a column half of whose rows carry stray casing is a lookup miss
  // dressed up as "no such borrower".
  const borrowerEmail = borrowerMatch.normalizeEmail(
    byNum(1240) ?? (b0 && b0.emailAddressText),
  ) || null;

  // HAS THE INVESTOR BOUGHT THIS LOAN? The owner's own workflow carries a PURCHASED
  // step that Encompass's nineteen milestones do not (owner-directed 2026-08-23), and
  // the fact behind it has been sitting on the loan payload unread all along: field
  // 2031, `$.rateLock.sellSideInvestorStatus` — a read-only Encompass dropdown filled
  // on 100% of loans at Investor Delivery, Purchasing Conditions and Final Docs — with
  // field 2370, `$.rateLock.date`, carrying the purchase advice DATE beside it.
  //
  // Read off the JSON for exactly the reason the term and the borrower's email are:
  // the long-term client does NOT split a failed fieldReader batch, so adding two ids
  // to it would risk blanking the team AND the lock read for every loan in the book to
  // learn one fact that is already in hand. A value read BY NUMBER still wins where a
  // caller has one.
  //
  // THREE ANSWERS, NOT TWO. A status Encompass did not give is `null` — not "no" —
  // and it leaves both columns exactly as they are, because an absent reading is not
  // evidence of anything. A status that is present but is NOT a purchased value
  // CLEARS the stamp: a sale corrected away in Encompass must not leave "Purchased"
  // standing here. That is why these two columns are written PLAINLY and are the only
  // two on this statement not wrapped in COALESCE.
  const sale = purchased.readPurchase(loan, purchased.configFrom(settings || {}));

  // What we held BEFORE the write, because the write is what destroys the evidence.
  // Encompass's own milestone log is 403 on this tenant, so noticing that the
  // milestone is not what it was is the only history available — and it can only be
  // noticed from here, one statement earlier than the UPDATE.
  const priorMilestone = await milestones.loadPrior(loanId);

  await lazy.db.query(
    `UPDATE lt_loans
        SET milestone_name = COALESCE($2, milestone_name),
            stage_key = COALESCE($3, stage_key),
            term_months = COALESCE($4, term_months),
            program_name = COALESCE($5, program_name),
            borrower_first_name = COALESCE($6, borrower_first_name),
            borrower_last_name = COALESCE($7, borrower_last_name),
            borrower_email = COALESCE($8, borrower_email),
            purchased_status = CASE WHEN $9::boolean THEN $10 ELSE purchased_status END,
            purchased_at = CASE WHEN $9::boolean THEN $11::date ELSE purchased_at END,
            encompass_synced_at = now(),
            encompass_sync_error = NULL,
            updated_at = now()
      WHERE id = $1::uuid`,
    // COALESCE(new, old) — the milestone's own rule. A read that could not see the
    // term (an older payload, a partial read) must never BLANK one we already hold;
    // a real change still lands, because Encompass is the authority on both.
    // The borrower's identity rides the same COALESCE rule, and it matters more
    // here than anywhere else on the row: blanking an email would silently drop
    // every loan on that address out of its confirmed link, and the borrower would
    // watch their own files disappear from their login with nothing having changed.
    // $9 is "Encompass answered about the sale at all". Only then are $10/$11 written,
    // so a read that could not see the field leaves a recorded purchase alone while a
    // read that saw "Shipped" genuinely clears one.
    [loanId, milestoneName, stageKey, termMonths, programName,
      borrowerFirst, borrowerLast, borrowerEmail,
      sale.purchased !== null, sale.status, sale.at],
  );

  // A first sighting is recorded as a BASELINE, never as an arrival — we cannot know
  // how long the loan had already been sitting there, and dating it from today would
  // make the whole back book look freshly moved. Best-effort: never undoes the
  // mirror above.
  const milestoneWrite = await milestones.writeMilestone(
    loanId, priorMilestone, { milestoneName, stageKey },
  );

  // ONE fieldReader for everything read by number — the team's ids and the lock's
  // together. The pacing rule on this tenant is a self-imposed gap between calls, so
  // two calls per loan is twice as long holding a connection the whole company
  // shares. A failure here is its own: a loan whose team or lock could not be read
  // is still a loan we successfully mirrored, and the failure must not undo that.
  let values = null;
  try {
    const ids = [...new Set([...contacts.fieldIdsFor(settings), ...locks.fieldIdsFor(settings)])];
    if (ids.length) values = await lazy.client.fieldReader(guid, ids);
  } catch (_) { /* each consumer below reports its own miss */ }

  const team = await contacts.syncLoanContacts(loanId, guid, { values });

  // THE SUBJECT PROPERTY RIDES THE PAYLOAD WE ALREADY HAVE. db/549 shipped
  // `lt_properties` and the file's Property section, the summary rail and the
  // pipeline's own address and LTV columns all READ it — while nothing wrote it,
  // so all three answered blank on every loan from the day they shipped. It costs
  // no call: the figures are on the loan JSON in hand, and any value this caller
  // already read BY NUMBER wins over the path. Best-effort — a property we could
  // not read must never undo the loan we just mirrored.
  let property = null;
  try {
    property = await application.syncSubjectProperty(loanId, loan, { values });
  } catch (e) {
    property = { ok: false, reason: (e && e.message) || String(e) };
  }

  // The people on the file ride the same payload, for the same reason and at the
  // same cost. `lt_borrower_pairs` and `lt_parties` are what the file's Borrowers
  // section reads and what its residences, employments, incomes, assets,
  // liabilities and declarations all hang off — so nothing else in the 1003 can
  // fill until these do. The SSN itself is never written; see application/sync.js.
  // The loan's OWN terms — its amortization, its interest-only period, its
  // prepayment penalty, the whole PITIA block and the DSCR. Twenty-seven columns
  // db/549 carries, all of them read by the file's Terms section and the summary
  // rail, none of them ever written. Same payload, same pass, no extra call.
  let terms = null;
  try {
    terms = await application.syncLoanTerms(loanId, loan, { values });
  } catch (e) {
    terms = { ok: false, reason: (e && e.message) || String(e) };
  }

  let pairs = null;
  try {
    pairs = await application.syncBorrowerPairs(loanId, loan);
  } catch (e) {
    pairs = { ok: false, reason: (e && e.message) || String(e) };
  }

  // WHO BOUGHT IT. db/549 built the investor identity chain the owner said must
  // "survive like crazy" — the shorthand name, the accurate name, their OWN loan
  // number, their email domain and the funding channel — and nothing has ever
  // written a row into it. Every condition in this tenant sits on a loan that is
  // already sold, so "who is this with?" is a question staff ask on almost every
  // file. Same payload, same pass, no extra call. STAFF-ONLY: nothing here goes
  // near a client surface.
  let investor = null;
  try {
    investor = await application.syncLoanInvestor(loanId, loan, { values });
  } catch (e) {
    investor = { ok: false, reason: (e && e.message) || String(e) };
  }

  // The lock posture rides the loan we already have — no lock endpoint is called,
  // and none would answer: every lock-specific endpoint on this tenant is 403.
  const lock = locks.lockFromLoan(loan, values, settings);
  const lockWrite = await locks.writeLock(loanId, lock);

  return { ok: true, milestoneName, stageKey, team, milestone: milestoneWrite, sale,
    lock: { ...lockWrite, posture: lock.posture }, property, terms, pairs, investor };
}

/**
 * One pass: discover everything, mirror it, then fully read the loans that moved —
 * up to a budget, so a pass is bounded no matter how much changed.
 *
 * Never throws for an ordinary failure; returns `{ok:false, reason}` so a screen can
 * say what happened.
 */
async function syncOnce({ readBudget = DEFAULT_READ_BUDGET, loanFolder = null } = {}) {
  // Say WHICH of the two states this is: "the credentials are missing" is useless
  // advice on a tenant whose credentials are sitting right there and were switched
  // off on purpose.
  if (!killSwitch.encompassEnabled()) return { ok: false, reason: killSwitch.OFF_REASON };
  if (!lazy.client.configured()) {
    return { ok: false, reason: 'Encompass is not connected yet — add the long-term Encompass credentials first.' };
  }

  const { settings } = await lazy.settings.load();

  let found;
  try {
    found = await discover.discoverLoans({ loanFolder });
  } catch (e) {
    return { ok: false, reason: `Could not read the Encompass pipeline: ${(e && e.message) || e}` };
  }
  if (!found.loans.length) {
    // Nothing is deleted or deactivated on an empty read — an empty pipeline is far
    // more likely an outage or a filter change than seven hundred loans vanishing.
    return { ok: true, discovered: 0, read: 0, failed: 0, truncated: found.truncated, note: 'The pipeline returned no loans, so nothing was changed.' };
  }

  const dbc = await lazy.db.getClient();
  // ONLY OUR OWN LOANS COME IN (owner-directed 2026-08-23: *"make sure it's only
  // gonna pull according to our rule: only long-term files"*).
  //
  // Discovery reads the WHOLE Encompass book because no folder separates the two
  // products at the source — 772 loans, 251 of them fix-and-flip. Every one of those
  // used to be written into `lt_loans` and then READ, one Encompass call each, to
  // establish something the discovery row could already have told us.
  //
  // THE RULE IS `product-term.js`, AND IT IS NOT RE-STATED HERE. It is the same one
  // definition the census, the pipeline stamp and the SQL twin all use, so "is this
  // ours?" has exactly one answer in this codebase.
  //
  // ONLY A PROVABLE SHORT-TERM LOAN IS SKIPPED. `boundary` (exactly 36 months) and
  // `unknown` (no program and no term) are MIRRORED: refusing to bring in a loan we
  // cannot place would make files disappear with nothing anywhere saying so, which is
  // the confident-wrong-answer this side keeps finding. They are counted and reported
  // instead, and the census lists them for a human to settle.
  //
  // AND WHEN WE COULD NOT ASK, WE DO NOT JUDGE. If Encompass refused the two
  // classifying fields, every loan reads as unclassifiable and NOTHING is skipped —
  // the pass behaves exactly as it did before this rule existed, and says so.
  const mirrorShortTerm = settings['sync.mirrorShortTerm'] === true;
  const canClassify = found.classifyFields !== 'refused';
  let skippedShortTerm = 0;

  const due = [];
  // ONE LOAN THAT WILL NOT SAVE MUST NOT DISCARD THE BOOK (owner-reported
  // 2026-08-23, and the run log is what finally named it: *"The last pull did not
  // work — Could not save the discovered loans: duplicate key value violates unique
  // constraint lt_loans_loan_number_key"*).
  //
  // The whole discovered book was mirrored inside ONE transaction with the loop
  // BARE inside it, so the first row Postgres refused aborted the transaction and
  // the catch rolled back every loan in the pass. Two Encompass loans sharing one
  // human loan number — an ordinary state of that system, see db/617 — therefore
  // emptied the entire pipeline, on every pass, with the count of loans actually at
  // fault being ONE. THE CLASS: a per-row failure inside a batch transaction is a
  // total failure unless something scopes it to its own row.
  //
  // A SAVEPOINT per loan is what scopes it — the same shape `finding-decisions.js`
  // uses. Postgres puts a transaction into a failed state on ANY error and refuses
  // every later statement until it is rewound, so releasing the savepoint on success
  // and rolling back TO it on failure is not decoration: without it the next loan's
  // insert fails with `current transaction is aborted` and the whole book still goes.
  //
  // The batch stays ONE transaction on purpose. Discovery is a mirror of a moment,
  // and committing per row would let a pass that dies half way leave a book that is
  // part yesterday and part today, with nothing saying which rows are which.
  //
  // NOTHING IS SILENTLY DROPPED. A refused loan is counted, its loan number and
  // Encompass id are kept, and the pass REPORTS them — a mirror that quietly skips
  // a real loan is the confident wrong answer this side keeps finding.
  const refused = [];
  try {
    await dbc.query('BEGIN');
    for (const loan of found.loans) {
      if (!mirrorShortTerm && canClassify) {
        const verdict = productTerm.classifyProduct({
          programName: loan.programName,
          termMonths: loan.termMonths,
        });
        if (verdict.product === productTerm.PRODUCT.SHORT) { skippedShortTerm += 1; continue; }
      }
      await dbc.query('SAVEPOINT lt_loan_row');
      try {
        const row = await upsertDiscovered(dbc, loan, settings);
        await dbc.query('RELEASE SAVEPOINT lt_loan_row');
        if (needsRead(row)) due.push({ id: row.id, guid: loan.encompassLoanGuid });
      } catch (rowErr) {
        // Rewind only this row. If the rewind ITSELF fails the transaction is
        // unusable, so rethrow and let the outer catch report honestly rather than
        // loop on a connection that will refuse everything from here on.
        await dbc.query('ROLLBACK TO SAVEPOINT lt_loan_row');
        await dbc.query('RELEASE SAVEPOINT lt_loan_row');
        refused.push({
          loanNumber: loan.loanNumber || null,
          encompassLoanGuid: loan.encompassLoanGuid || null,
          reason: (rowErr && rowErr.message) || String(rowErr),
        });
      }
    }
    await dbc.query('COMMIT');
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    return { ok: false, reason: `Could not save the discovered loans: ${(e && e.message) || e}` };
  } finally {
    dbc.release();
  }

  // The full reads run OUTSIDE the transaction, one at a time: each is a network
  // call, and holding a transaction open across dozens of them would pin a
  // connection for minutes and roll back every loan because one failed.
  let read = 0;
  let failed = 0;
  for (const item of due.slice(0, readBudget)) {
    const out = await readLoan(item.id, item.guid, settings);
    if (out.ok) read += 1; else failed += 1;
  }

  // A borrower link a human confirmed YESTERDAY has to reach a loan that arrived
  // TODAY. The decision is recorded against the email address, and a freshly
  // mirrored loan carries that address with no `borrower_id` — so without this the
  // borrower would have to be re-confirmed for every new loan, forever, and nobody
  // would. Best-effort by construction: it never throws and it can never undo the
  // mirror above, so a failure costs one pass, not the sync.
  const links = await require('../borrower-links').applyConfirmedLinks();

  // THE OFFICER MAP REFRESHES WITH THE LOANS (owner-directed 2026-08-17: "make sure
  // officer mapping is on"). The loans that just arrived name Encompass logins, and
  // a login nobody has proposed a match for is an officer with no PILOT profile —
  // so their file shows a name we cannot connect to a person, and, because officer
  // scope is `own`, it reaches nobody's pipeline. Refreshing the roster on the same
  // pass is what stops the two drifting: the proposals are always about the logins
  // the book actually carries, rather than whenever somebody last pressed a button
  // on the people screen.
  //
  // IT PROPOSES AND NEVER DECIDES — unchanged. `syncRoster` writes `suggested` rows
  // only; a `confirmed` or `rejected` row is never re-litigated (people/links.js).
  // Automating the CONFIRM is the one thing that must not happen here: a wrong link
  // hands somebody another officer's book with nothing on screen to say so.
  //
  // Best-effort, exactly like the borrower links above: the loan mirror is the job,
  // and a people failure may not cost it.
  // `syncRoster` reports an ordinary failure by RETURNING `{ok:false, reason}` rather
  // than throwing (no credentials, an empty roster it refuses to write), so both
  // shapes are read — treating an `ok:false` as a caught error would report a
  // confident "0 officers proposed" on a pass that never ran.
  let officers = { proposed: 0, waiting: 0, reason: null };
  try {
    const r = await require('../people/roster').syncRoster();
    if (r && r.ok) officers = { proposed: r.proposedNow || 0, waiting: r.unmatched || 0, reason: null };
    else officers = { proposed: 0, waiting: 0, reason: (r && r.reason) || 'the people map did not run' };
  } catch (e) {
    officers = { proposed: 0, waiting: 0, reason: (e && e.message) || String(e) };
  }
  if (officers.reason) console.error('[lt] officer roster refresh:', officers.reason);

  return {
    ok: true,
    discovered: found.loans.length,
    due: due.length,
    read,
    failed,
    borrowersLinked: links.linked || 0,
    // What a human still has to do: `officersProposed` are new matches waiting for a
    // confirm, `officersUnmatched` are logins the machine could not match at all.
    officersProposed: officers.proposed,
    officersUnmatched: officers.waiting,
    officerSyncReason: officers.reason,
    remaining: Math.max(0, due.length - readBudget),
    truncated: found.truncated,
    // NO SILENT FILTERING. How many of Encompass's loans were left where they belong,
    // and — when the classifying fields were refused — that none could be.
    skippedShortTerm,
    classifyFields: found.classifyFields || 'answered',
    // NO SILENT CAPS. Loans Postgres refused, named so a human can go and look at
    // them in Encompass; `refusedLoans` carries the first few with their reason.
    refused: refused.length,
    refusedLoans: refused.slice(0, 10),
  };
}

module.exports = {
  DEFAULT_READ_BUDGET,
  stageFor,
  needsRead,
  upsertDiscovered,
  readLoan,
  syncOnce,
};
