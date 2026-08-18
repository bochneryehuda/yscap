'use strict';
/**
 * THE DRAFTING DETAIL LAYER (owner-directed 2026-08-18: "it should write
 * everything with more thought to it. For example, for the bank statement
 * condition, it should write down and break down the liquidity requirement,
 * cash to close, and reserves … 'If you have a little bit extra, send a
 * little bit extra, so that we shouldn't be tight on cash to close.' …
 * [experience:] your file is registered with this and this amount of
 * fix-and-hold … our track record only includes this and this amount …
 * this is actually stuff that is available on the condition center").
 *
 * Renders plain-text FACT BLOCKS for the drafting model from the SAME modules
 * the Condition Center itself reads — asset-ledger.computeAssetLedger,
 * track-record-todo.trackRecordTodo, rehab-budget.checkSowBudget — ONE
 * definition each, never restated here. Alongside each block comes a GUIDANCE
 * sentence for the task, so the model knows what to do with the figures.
 *
 * NEVER-FABRICATE + NEVER-FAIL: every family runs in its own try/catch and an
 * unreadable block is OMITTED — a draft with fewer figures is fine, a draft
 * with invented ones is not, and a detail failure may never break the draft.
 * Every figure is borrower-visible by construction (the liquidity dollars are
 * on the borrower's own condition hint; the experience counts are on their
 * track-record to-do; the payoff is their own existing loan) — and the caller
 * scrubs the whole prompt output borrower-safe regardless.
 */
const db = require('../../db');

const money = (n) => (n == null || !isFinite(Number(n)) ? null
  : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const int = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0);

/* Which condition family a checklist row belongs to — the SAME identifiers the
   sign-off gate keys on (staff.js signOffGate: rtl_p3_assets; rtl_p3_reo /
   tool_key track_record; rtl_p1_budget / tool_key rehab_budget; the db/464
   payoff pair). */
const isAssets = (it) => it && it.templateCode === 'rtl_p3_assets';
const isExperience = (it) => !!it && (it.templateCode === 'rtl_p3_reo' || it.toolKey === 'track_record');
const isBudget = (it) => !!it && (it.templateCode === 'rtl_p1_budget' || it.toolKey === 'rehab_budget');
const isPayoff = (it) => !!it && (it.templateCode === 'cond_payoff_external' || it.templateCode === 'cond_payoff_internal');

/* ---- the LIQUIDITY / bank-statement breakdown (asset-ledger is the ONE
        definition of these figures — the same numbers the condition's own
        card and Max Cash to Close read). ---- */
async function liquidityBlock(appId, client) {
  const led = await require('../underwriting/asset-ledger').computeAssetLedger(appId, client);
  if (!led || !led.registered) return null;   // no registered product = no requirement to state
  const required = money(led.requiredLiquidity);
  if (!required) return null;
  const lines = [`About the bank-statement / assets item — the liquidity requirement, broken down:`];
  lines.push(`- Total liquid funds to show: ${required}`);
  const ctc = money(led.estimateCashToClose);
  if (ctc) lines.push(`- …of which the estimated cash to close: ${ctc}`);
  const res = money(led.reserveRequirement);
  if (res) lines.push(`- …reserves to show in the ending balance${led.reserveBasis ? ` (${led.reserveBasis})` : ''}: ${res}`);
  if (led.closingBufferWaived) lines.push(`- The extra closing-cost cushion is waived on this file.`);
  else {
    const buf = money(led.closingBuffer);
    if (buf) lines.push(`- …a cushion for extra closing costs (about 1% of the loan): ${buf}`);
  }
  // Only when statements have actually been read — with nothing countable yet,
  // "verified $0" would be a confident claim about documents nobody has sent.
  if (led.haveCountable) {
    const ver = money(led.verifiedTotal);
    if (ver) lines.push(`- Verified so far from the documents on file: ${ver}`);
    const gap = Number(led.requiredLiquidity) - Number(led.verifiedTotal || 0);
    if (Number.isFinite(gap) && gap > 0) lines.push(`- Still to document: ${money(gap)}`);
  }
  lines.push('- Bank statements needed: the two (2) most recent months; a recent transaction printout may be added when funds are not yet in the latest statement’s ending balance.');
  return {
    facts: lines.join('\n'),
    guidance: 'On the bank-statement / assets item, break the requirement down (cash to close, reserves, the closing-cost cushion) using the figures given, and warmly suggest sending statements showing a LITTLE MORE than the minimum so cash to close is never tight.',
  };
}

/* ---- the EXPERIENCE / track-record gap (track-record-todo is the ONE
        definition — the same registered-vs-verified counts and "N more flips"
        wording the sign-off gate and the borrower's to-do use). ---- */
const BUCKET_LABEL = { flips: 'fix-and-flip', holds: 'fix-and-hold', ground: 'ground-up build' };
function bucketList(counts) {
  const parts = [];
  for (const k of ['flips', 'holds', 'ground']) {
    const n = int(counts && counts[k]);
    if (n > 0) parts.push(`${n} ${BUCKET_LABEL[k]}${n === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}
async function experienceBlock(appId, client) {
  const todo = await require('../track-record-todo').trackRecordTodo(appId, { client });
  const exp = todo && todo.experience;
  if (!exp) return null;
  const need = bucketList(exp.need);
  if (!need) return null;
  const lines = ['About the track-record / experience item:'];
  lines.push(`- The loan is ${exp.registered ? 'registered' : 'priced'} on this experience: ${need}`);
  const ver = bucketList(exp.verified);
  lines.push(`- Verified on the track record so far: ${ver || 'none yet'}`);
  if (exp.shortfall && exp.shortfall.length) {
    lines.push(`- Still missing: ${exp.shortfall.map((s) => s.text).join(', ')} (completed deals with a sale, lease or refinance in the last 3 years)`);
  } else {
    lines.push('- The requirement is fully verified — nothing more is needed on experience.');
  }
  // Up to three borrower-actionable per-line to-dos, so the draft can name them.
  const waiting = [];
  for (const ln of (todo.lines || [])) {
    for (const t of (ln.todo || [])) {
      if (t.waitingOn === 'borrower' && waiting.length < 3) waiting.push(`- ${ln.address || 'A listed property'}: ${t.title}`);
    }
  }
  if (waiting.length) lines.push('Waiting on the borrower for listed properties:', ...waiting);
  return {
    facts: lines.join('\n'),
    guidance: 'On the experience item, state plainly what the file is registered with, what the track record verifies so far, and exactly what is still missing.',
  };
}

/* ---- the SOW / construction-budget agreement (checkSowBudget is the ONE
        cent-exact rule the sign-off gate applies). ---- */
async function budgetBlock(appId, client) {
  const chk = await require('../rehab-budget').checkSowBudget(appId, null, client);
  if (!chk || chk.ok || chk.seed) return null;
  const lines = ['About the Scope of Work / construction-budget item:'];
  if (chk.required != null) lines.push(`- The construction budget on the loan: ${money(chk.required)}`);
  if (chk.total != null) lines.push(`- The Scope of Work line items currently total: ${money(chk.total)}`);
  if (chk.message) lines.push(`- What needs to happen: ${String(chk.message).slice(0, 400)}`);
  return {
    facts: lines.join('\n'),
    guidance: 'On the Scope of Work item, state the exact figures and that the line items must add up to the loan’s construction budget to the cent.',
  };
}

/* ---- the PAYOFF being retired on a refinance — the borrower's own existing
        loan, never our capital partner. ---- */
async function payoffBlock(appId, client) {
  const r = (await (client || db).query(
    `SELECT payoff_amount, payoff_lender, payoff_loan_number FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!r) return null;
  const bits = [];
  if (r.payoff_lender) bits.push(`current lender ${String(r.payoff_lender).slice(0, 120)}`);
  if (r.payoff_loan_number) bits.push(`their loan #${String(r.payoff_loan_number).slice(0, 60)}`);
  if (r.payoff_amount != null) bits.push(`approximate payoff ${money(r.payoff_amount)}`);
  if (!bits.length) return null;
  return {
    facts: `About the payoff item (the borrower's existing loan being paid off): ${bits.join(', ')}.`,
    guidance: 'On the payoff item, confirm the existing-loan details on file and ask the borrower to flag anything that looks off.',
  };
}

/**
 * The detail blocks for a draft. `items` = the conditions in scope (with
 * templateCode/toolKey) — a family's block is included only when a matching
 * condition is in the draft, so the email never explains an item it does not
 * list. Pass items = null to include EVERY readable family (the deal-overview /
 * custom presets, which are about the whole file rather than a list).
 * Returns { facts: [block strings], guidance: [task sentences] }; never throws.
 */
async function detailFor(appId, items, client = db) {
  const all = items == null;
  const has = (test) => all || (Array.isArray(items) && items.some(test));
  const out = { facts: [], guidance: [] };
  const families = [
    [() => has(isAssets), liquidityBlock],
    [() => has(isExperience), experienceBlock],
    [() => has(isBudget), budgetBlock],
    [() => has(isPayoff), payoffBlock],
  ];
  for (const [wanted, fn] of families) {
    try {
      if (!wanted()) continue;
      const b = await fn(appId, client);
      if (b && b.facts) { out.facts.push(b.facts); out.guidance.push(b.guidance); }
    } catch (_) { /* an unreadable family is omitted, never fabricated */ }
  }
  return out;
}

module.exports = {
  detailFor,
  _internals: { isAssets, isExperience, isBudget, isPayoff, liquidityBlock, experienceBlock, budgetBlock, payoffBlock, bucketList },
};
