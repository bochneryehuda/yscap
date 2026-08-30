'use strict';
/**
 * LONG-TERM — THE WORKING DATA FOR THE THREE CONDITIONS THAT ARE NOT AN UPLOAD.
 *
 * `read.forLoan` deliberately does not carry any of this: it is the list every
 * screen and every borrower loads, and the mortgage lines, the entity profile
 * and the ways to answer are only wanted once somebody OPENS one of these three.
 * Putting them there would make the whole conditions list pay for three reads
 * nobody asked for, on every load, for every file.
 *
 * ── WHAT EACH ONE NEEDS ─────────────────────────────────────────────────────
 *
 *   · MORTGAGES ON THE CREDIT REPORT — the liabilities Encompass mirrored, with
 *     a PROPOSED mortgage-or-not against each and the answer recorded so far.
 *   · THE SUBJECT PROPERTY'S MORTGAGE — the three ways, and what is answered.
 *   · THE VESTING ENTITY — what the borrower already holds for this company on
 *     their shared profile.
 *
 * ── PILOT PROPOSES, A PERSON DECIDES ────────────────────────────────────────
 *
 * Whether a liability is a mortgage is a JUDGEMENT with a cost either way: call
 * a car loan a mortgage and a borrower is chased for a statement they do not
 * owe; miss a real one and the debt picture is short a payment nobody noticed.
 * So `proposeMortgage` reads the liability TYPE and answers `true` / `false` /
 * `null` — and `null` is a real answer meaning "you look", never quietly folded
 * into "no". Nothing here writes a classification; the person's answer is
 * recorded on the condition.
 *
 * NEVER THROWS. Each read is its own try/catch and reports what it could not
 * read, because "there are no mortgages on this credit report" and "PILOT could
 * not read the credit report" are different facts and only one of them means the
 * condition is finished.
 *
 * SEPARATION: `lt_*` tables only, plus the entity prefill, which goes through the
 * shared entity module authorized per item in the crossing ledger.
 */

const db = require('../db');
const answers = require('../../lib/conditions/answers');
const entityPrefill = require('./entity-prefill');
const vocab = require('./vocabulary');
const { ownerOf, ownerWhere } = require('../../lib/condition-owner');

/**
 * IS THIS LIABILITY A MORTGAGE? A PROPOSAL, never a decision.
 *
 * The words come from Encompass's own liability types. `null` means the type
 * says nothing either way — an "Other" line, or a blank — and a person answers.
 */
const MORTGAGE_WORDS = /mortgage|home\s*equity|heloc|deed\s*of\s*trust|real\s*estate\s*loan/i;
const NOT_MORTGAGE_WORDS = /revolving|installment|credit\s*card|auto|student|lease|open\s*30|collection|child\s*support|alimony|taxes|garnish/i;

function proposeMortgage(liability) {
  const t = `${(liability && liability.liability_type) || ''} ${(liability && liability.section) || ''}`.trim();
  if (!t) return null;
  if (MORTGAGE_WORDS.test(t)) return true;
  if (NOT_MORTGAGE_WORDS.test(t)) return false;
  return null;                                  // "you look" — never a quiet no
}

/** A stable key for one liability, used as the answer's key AND as the document
    slot a statement for that line is filed under, so the ordinary document
    plumbing carries the link with no second table. */
function lineKey(liability) {
  return `liab:${liability.id}`;
}

/** What a person reads on the row, and what a refusal names. */
function lineLabel(liability) {
  const who = String(liability.creditor_name || '').trim() || 'Unnamed creditor';
  const last4 = String(liability.account_last4 || '').trim();
  return last4 ? `${who} ····${last4}` : who;
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Every liability on the loan, with the proposal against each. */
async function liabilitiesFor(loanId, client) {
  try {
    const { rows } = await client.query(
      `SELECT l.id, l.section, l.liability_type, l.creditor_name, l.account_last4,
              l.unpaid_balance, l.monthly_payment, l.to_be_paid_off, l.reo_property_id
         FROM lt_liabilities l
         JOIN lt_parties p ON p.id = l.party_id
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid
        ORDER BY l.section, l.creditor_name`,
      [String(loanId)],
    );
    return {
      rows: rows.map((r) => ({
        key: lineKey(r),
        label: lineLabel(r),
        creditor: r.creditor_name || null,
        last4: r.account_last4 || null,
        type: r.liability_type || null,
        balance: money(r.unpaid_balance),
        payment: money(r.monthly_payment),
        proposedMortgage: proposeMortgage(r),
      })),
      unreadable: false,
    };
  } catch (e) {
    // NOT an empty list. An empty list reads as "this borrower has no debts",
    // which would let the condition sign off on a credit report nobody read.
    return { rows: [], unreadable: true, why: 'PILOT could not read the liabilities from the credit report.' };
  }
}

/** The vesting name on this loan, if it has one. */
async function vestingFor(loanId, client) {
  try {
    const { rows } = await client.query(
      `SELECT vesting_entity_name, borrower_id
         FROM lt_loans WHERE id = $1::uuid`,
      [String(loanId)],
    );
    const r = rows[0] || {};
    return { name: r.vesting_entity_name || null, borrowerId: r.borrower_id || null, unreadable: false };
  } catch (_) {
    return { name: null, borrowerId: null, unreadable: true };
  }
}

/** Which line keys already carry an accepted document. */
async function documentsByLine(conditionId, client) {
  try {
    const { rows } = await client.query(
      // The per-line key travels in `documents.slot_label` — the ordinary
      // document plumbing carries it, with no second table (db/653 moved these
      // rows into the ONE Condition Center).
      `SELECT slot_label, id, filename FROM documents
        WHERE checklist_item_id = $1::uuid AND is_current
          AND review_status = 'accepted' AND slot_label IS NOT NULL`,
      [String(conditionId)],
    );
    const out = {};
    for (const r of rows) out[String(r.slot_label)] = { id: r.id, filename: r.filename };
    return out;
  } catch (_) {
    return {};
  }
}

/**
 * THE WORKING DATA for one condition, or null when it is an ordinary one.
 *
 * @returns {Promise<null|object>} — never throws.
 */
async function forCondition(loanId, conditionId, opts = {}) {
  const client = opts.db || db;

  let condition = null;
  try {
    const where = ownerWhere(ownerOf('lt_loan', loanId), 'c', 2);
    const { rows } = await client.query(
      `SELECT c.id, t.code, c.label, c.item_kind, c.tool_key, t.config,
              c.tool_payload AS answer, c.status, c.waived_at, c.is_required
         FROM checklist_items c
         LEFT JOIN checklist_templates t ON t.id = c.template_id
        WHERE c.id = $1::uuid AND ${where.sql}`,
      [String(conditionId), ...where.params],
    );
    // Read back into the owner's own wording, once, so everything below reasons
    // about `kind` and `status` the way the rules are written.
    condition = rows[0]
      ? { ...rows[0], kind: vocab.kindFromShared(rows[0]), status: vocab.statusOf(rows[0]), config: rows[0].config || {} }
      : null;
  } catch (_) {
    return null;
  }
  if (!condition) return null;

  const code = String(condition.code || '');
  const recorded = condition.answer && typeof condition.answer === 'object' ? condition.answer : {};
  const plan = answers.plan(condition);

  // ── The vesting entity: what is already on the borrower's profile ─────────
  if (code === 'lt_vesting_entity') {
    const vesting = await vestingFor(loanId, client);
    const prefill = await entityPrefill.forEntity(vesting.borrowerId, vesting.name, client);
    const settled = entityPrefill.satisfiedByProfile(prefill);
    return {
      code,
      shape: 'entity',
      entityName: vesting.name,
      profile: prefill,
      alreadyDone: settled.ok,
      note: settled.why,
    };
  }

  if (!plan) return null;

  // ── The subject property's mortgage: one choice ───────────────────────────
  if (plan.mode === 'choice') {
    return {
      code,
      shape: 'choice',
      ways: plan.ways.map((w) => ({
        key: w.key, label: w.label, why: w.why || null,
        needsDocument: !!w.needsDocument,
        fields: (w.fields || []).concat(w.conditionalFields || []),
      })),
      answer: { way: recorded.way || null, values: recorded.values || {} },
    };
  }

  // ── Every mortgage on the credit report: one line at a time ───────────────
  const liabilities = await liabilitiesFor(loanId, client);
  const docs = await documentsByLine(condition.id, client);
  const chosen = Array.isArray(recorded.mortgages) ? recorded.mortgages : [];
  const chosenKeys = new Set(chosen.map((m) => String(typeof m === 'string' ? m : m.key)));

  return {
    code,
    shape: 'per_line',
    ways: plan.ways.map((w) => ({
      key: w.key, label: w.label, why: w.why || null,
      needsDocument: !!w.needsDocument,
      fields: (w.fields || []).concat(w.conditionalFields || []),
    })),
    lines: liabilities.rows.map((l) => ({
      ...l,
      // A person's answer always wins over the proposal — including a person
      // saying "not a mortgage" about a line PILOT proposed as one.
      isMortgage: chosenKeys.size ? chosenKeys.has(l.key) : null,
      document: docs[l.key] || null,
      answer: (recorded.lines && recorded.lines[l.key]) || null,
    })),
    classified: chosenKeys.size > 0,
    unreadable: liabilities.unreadable,
    why: liabilities.why || null,
    answer: { mortgages: chosen, lines: recorded.lines || {} },
  };
}

module.exports = {
  forCondition,
  _internals: { proposeMortgage, lineKey, lineLabel, liabilitiesFor, vestingFor, documentsByLine },
};
