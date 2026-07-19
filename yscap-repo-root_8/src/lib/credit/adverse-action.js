'use strict';

/**
 * Adverse-action letter scaffolding (owner-directed 2026-07-19).
 *
 * RTL loans are business-purpose, so the ECOA / Reg B business-credit
 * adverse-action path applies. The exact notice content, delivery, and timing
 * are compliance decisions — this module does NOT finalize or send anything. It
 * assembles a STRUCTURED DRAFT (decision, principal reasons, disclosed scores,
 * a boilerplate notice body) and stores it as a draft record for a human to
 * review, edit, and issue. Permission for the pull is taken verbally, so there
 * is no signed-auth capture here.
 *
 * A compliance reviewer MUST review every draft before it is issued. The
 * generated body is a starting point, not legal text — the review step exists
 * precisely so a person confirms the reasons and the notice against the loan.
 */
const db = require('../../db');
const scoring = require('./scoring');

// Boilerplate ECOA notice (the standard clause). The creditor identity + CRA
// contact block are filled from config/report at review time — kept minimal on
// purpose so nobody mistakes this for finalized legal prose.
const ECOA_NOTICE =
  'The federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants ' +
  'on the basis of race, color, religion, national origin, sex, marital status, age (provided the applicant has ' +
  'the capacity to contract); because all or part of the applicant’s income derives from any public ' +
  'assistance program; or because the applicant has in good faith exercised any right under the Consumer Credit ' +
  'Protection Act.';

/**
 * Build the structured draft data from a decision + the credit report. Pure —
 * does not write. `principalReasons` is a list of short strings the human
 * confirms; `scoresDisclosed` are the borrower's bureau scores used (FCRA
 * §615(a) disclosure when a score factored into the decision).
 */
function draftBody({ borrowerName, decision, principalReasons = [], scoresDisclosed = [] }) {
  const lines = [];
  lines.push(`RE: Your recent business-purpose loan request${borrowerName ? ` — ${borrowerName}` : ''}`);
  lines.push('');
  lines.push('DRAFT — for compliance review. Not for delivery until reviewed and approved.');
  lines.push('');
  const decisionText = decision === 'counteroffer' ? 'we are able to offer credit only on different terms'
    : decision === 'incomplete' ? 'we were unable to complete our evaluation'
    : 'we are unable to approve the request';
  lines.push(`After reviewing the application, ${decisionText}. The principal reason(s):`);
  for (const r of principalReasons) lines.push(`  • ${r}`);
  if (scoresDisclosed.length) {
    lines.push('');
    lines.push('Credit scores used in our decision:');
    for (const s of scoresDisclosed) lines.push(`  • ${s.bureau}: ${s.score}`);
    lines.push('The credit score(s) above were obtained from a consumer reporting agency and used in the decision.');
  }
  lines.push('');
  lines.push(ECOA_NOTICE);
  return lines.join('\n');
}

/**
 * Create a DRAFT adverse-action record for a file. Pulls the borrower's disclosed
 * scores from the credit report if a reportId is given. Returns the new row's id.
 * Never issues/sends — status is always 'draft'.
 */
async function draftForApplication({ applicationId, borrowerId, creditReportId, decision = 'declined', principalReasons = [], actorId }) {
  let scoresDisclosed = [];
  let name = null;
  if (borrowerId) {
    const b = (await db.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
    if (b) name = [b.first_name, b.last_name].filter(Boolean).join(' ');
  }
  if (creditReportId && borrowerId) {
    const rows = (await db.query(
      `SELECT bureau, value FROM credit_scores WHERE credit_report_id=$1 AND borrower_id=$2 AND usable ORDER BY bureau`,
      [creditReportId, borrowerId])).rows;
    scoresDisclosed = rows.map((r) => ({ bureau: r.bureau, score: r.value }));
  }
  const body = draftBody({ borrowerName: name, decision, principalReasons, scoresDisclosed });
  const ins = await db.query(
    `INSERT INTO adverse_action_letters
       (application_id, borrower_id, credit_report_id, decision, principal_reasons, scores_disclosed, notice_body, status, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,'draft',$8) RETURNING id`,
    [applicationId || null, borrowerId || null, creditReportId || null, decision,
     JSON.stringify(principalReasons), JSON.stringify(scoresDisclosed), body, actorId || null]);
  return ins.rows[0].id;
}

module.exports = { draftForApplication, draftBody, ECOA_NOTICE, SCORE_MODELS: scoring.MORTGAGE_MODELS };
