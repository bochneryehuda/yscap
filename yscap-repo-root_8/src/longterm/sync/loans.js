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
const discover = require('./discover');
const contacts = require('../people/contacts');

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
        loan_folder, encompass_last_modified, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::timestamptz, now())
     ON CONFLICT (encompass_loan_guid) DO UPDATE SET
       loan_number = COALESCE(EXCLUDED.loan_number, lt_loans.loan_number),
       loan_amount = COALESCE(lt_loans.loan_amount, EXCLUDED.loan_amount),
       milestone_name = COALESCE(EXCLUDED.milestone_name, lt_loans.milestone_name),
       stage_key = COALESCE(EXCLUDED.stage_key, lt_loans.stage_key),
       loan_folder = COALESCE(EXCLUDED.loan_folder, lt_loans.loan_folder),
       encompass_last_modified = GREATEST(
         COALESCE(EXCLUDED.encompass_last_modified, lt_loans.encompass_last_modified),
         COALESCE(lt_loans.encompass_last_modified, EXCLUDED.encompass_last_modified)),
       updated_at = now()
     RETURNING id, encompass_synced_at, encompass_last_modified`,
    [loan.encompassLoanGuid, loan.loanNumber, loan.loanAmount, milestoneName, stageKey,
      loan.loanFolder, loan.lastModified],
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

  await lazy.db.query(
    `UPDATE lt_loans
        SET milestone_name = COALESCE($2, milestone_name),
            stage_key = COALESCE($3, stage_key),
            encompass_synced_at = now(),
            encompass_sync_error = NULL,
            updated_at = now()
      WHERE id = $1::uuid`,
    [loanId, milestoneName, stageKey],
  );

  // The team is its own read (fieldReader), and its own failure. A loan whose team
  // cannot be read is still a loan we successfully mirrored.
  const team = await contacts.syncLoanContacts(loanId, guid);
  return { ok: true, milestoneName, stageKey, team };
}

/**
 * One pass: discover everything, mirror it, then fully read the loans that moved —
 * up to a budget, so a pass is bounded no matter how much changed.
 *
 * Never throws for an ordinary failure; returns `{ok:false, reason}` so a screen can
 * say what happened.
 */
async function syncOnce({ readBudget = DEFAULT_READ_BUDGET, loanFolder = null } = {}) {
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
  const due = [];
  try {
    await dbc.query('BEGIN');
    for (const loan of found.loans) {
      const row = await upsertDiscovered(dbc, loan, settings);
      if (needsRead(row)) due.push({ id: row.id, guid: loan.encompassLoanGuid });
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

  return {
    ok: true,
    discovered: found.loans.length,
    due: due.length,
    read,
    failed,
    remaining: Math.max(0, due.length - readBudget),
    truncated: found.truncated,
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
