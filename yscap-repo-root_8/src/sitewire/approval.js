'use strict';
/**
 * THE DRAW APPROVAL LADDER — what "approved" means at each step, and the money that goes with it
 * (owner-directed 2026-08-03, after the 195-197 Parrish St draw #1 report went out reading
 * "APPROVED FOR RELEASE $0" while the inspector had approved every single line).
 *
 * ROOT CAUSE of that report: the whole draw desk had ONE number called "approved" —
 * `sitewire_draws.total_approved_cents` — which Sitewire only fills in once the draw reaches its
 * FINAL (lender/capital-partner) approval. Every surface that asks "how much was approved?" read
 * that one field, so from the moment the inspector finished until the day we press Final approve,
 * the report, the packet, the findings email and the desk all answered ZERO — on a draw whose own
 * line items, three inches lower on the same page, each said "Appr $6,250".
 *
 * There is not one approval here, there are FIVE, and they happen in this order:
 *
 *   1. the borrower REQUESTS a draw and uploads his photos
 *   2. the INSPECTOR inspects and PRE-APPROVES a per-line amount   ← "inspector approved"
 *   3. we deliver those findings and the BORROWER accepts the amount
 *   4. the INVESTOR / capital partner reviews and approves
 *   5. WE press Final approve, and the money is released, NET of our draw fee ← "final approved"
 *
 * Everything we SHOW or SEND before step 5 must state what the INSPECTOR approved — that is the
 * proposal the borrower is being asked to accept. `final_approved_cents` stays 0 until step 5 and
 * is the only number that may ever be described as released.
 *
 * PURE — no DB, no network, integer cents. Every consumer (rollup, report, packet, desk, findings
 * delivery) reads its "approved" from HERE so two surfaces can never disagree about one draw again.
 */

const N = (x) => Number(x || 0) || 0;

// The Sitewire draw statuses that mean the lender's FINAL approval has landed.
const FINAL_STATUSES = new Set(['approved']);

// Where a draw sits on the ladder. Ordered — a later stage implies every earlier one.
const STAGE_ORDER = ['drafting', 'with_borrower', 'inspecting', 'inspector_approved',
  'borrower_review', 'borrower_disputed', 'borrower_accepted', 'with_investor', 'final_approved', 'released'];

// Plain-language wording for each stage. `staff` is what the desk/report says; `borrower` never
// reveals the capital-partner step (frozen borrower-safe rule) and never promises money is moving.
const STAGE_TEXT = {
  drafting:          { staff: 'Drafting',                          borrower: 'Drafting' },
  with_borrower:     { staff: 'With borrower',                     borrower: 'Awaiting your submission' },
  inspecting:        { staff: 'Inspecting',                        borrower: 'Inspection in progress' },
  inspector_approved:{ staff: 'Inspector approved — awaiting our final approval', borrower: 'Inspection complete — under review' },
  borrower_review:   { staff: 'With borrower to accept',           borrower: 'Please review and accept' },
  borrower_disputed: { staff: 'Borrower pushed back',              borrower: 'You pushed back on a line' },
  borrower_accepted: { staff: 'Borrower accepted — awaiting our final approval', borrower: 'Accepted — under review' },
  with_investor:     { staff: 'With capital partner',              borrower: 'Under review' },
  final_approved:    { staff: 'Final approved',                    borrower: 'Approved' },
  released:          { staff: 'Released',                          borrower: 'Released' },
};

/**
 * Where this draw stands.
 *   draw    { status }                      — the Sitewire mirror row
 *   finding { status }                      — the delivered-findings row, when there is one
 *             ('delivered' | 'accepted' | 'disputed' | 'resolved')
 *   released                                — a recorded release exists in OUR ledger
 *   hasInspectorAmounts                     — the inspector has put a number on at least one line
 * Returns { stage, label, borrowerLabel, isFinal, isReleased }.
 */
function approvalState({ draw = {}, finding = null, released = false, hasInspectorAmounts = false } = {}) {
  const status = String(draw.status || '');
  const fstatus = finding ? String(finding.status || '') : '';
  let stage;
  if (released) stage = 'released';
  else if (FINAL_STATUSES.has(status)) stage = 'final_approved';
  else if (fstatus === 'disputed') stage = 'borrower_disputed';
  else if (fstatus === 'accepted' || fstatus === 'resolved') stage = 'borrower_accepted';
  else if (fstatus === 'delivered') stage = 'borrower_review';
  else if (status === 'pending_capital_partner') stage = 'with_investor';
  else if (hasInspectorAmounts) stage = 'inspector_approved';
  else if (status === 'inspecting') stage = 'inspecting';
  else if (status === 'pending_borrower') stage = 'with_borrower';
  else if (status === 'drafting') stage = 'drafting';
  else stage = hasInspectorAmounts ? 'inspector_approved' : 'inspecting';
  const text = STAGE_TEXT[stage] || { staff: status || 'In progress', borrower: 'In progress' };
  return {
    stage,
    label: text.staff,
    borrowerLabel: text.borrower,
    isFinal: stage === 'final_approved' || stage === 'released',
    isReleased: stage === 'released',
  };
}

/**
 * Sum the per-line INSPECTOR-approved amount, in the order of authority:
 *   1. the live request mirror (`sitewire_draw_requests.approved_cents`) — refreshed every reconcile,
 *      and what the coordinator's own "Set approved" writes land in;
 *   2. the delivered findings snapshot (`draw_finding_lines.approved_cents`) — what the borrower was
 *      actually shown, so it is the right answer when the mirror has not caught up;
 *   3. the draw's own total, which is only non-zero once the lender's final approval lands.
 * A null approved amount means "the inspector has not answered this line yet" and is NOT a zero, so a
 * draw with nothing inspected reports `hasInspectorAmounts:false` rather than a confident $0.
 */
function inspectorApproved({ draw = {}, requests = [], findingLines = [] } = {}) {
  const fromRows = (rows, key) => {
    let sum = 0, any = false;
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const v = r ? r[key] : null;
      if (v == null) continue;
      any = true; sum += N(v);
    }
    return { sum, any };
  };
  const req = fromRows(requests, 'approved_cents');
  if (req.any) return { cents: req.sum, source: 'requests', hasAmounts: true };
  const fl = fromRows(findingLines, 'approved_cents');
  if (fl.any) return { cents: fl.sum, source: 'findings', hasAmounts: true };
  const total = N(draw.total_approved_cents);
  return { cents: total, source: 'draw_total', hasAmounts: total > 0 };
}

/**
 * The whole money answer for ONE draw — the number every surface should print, split so nobody has
 * to guess which "approved" they are looking at.
 *
 *   requested_cents          what the borrower asked for
 *   inspector_approved_cents what the inspector approved (the PROPOSAL — steps 2-4)
 *   final_approved_cents     what WE finally approved (step 5; 0 until then)
 *   not_approved_cents       requested − inspector approved (held back for a future draw)
 *   fee_cents                our draw processing fee, netted out of the release
 *   fee_projected            true while the fee is the file's standard fee rather than a recorded one
 *   net_release_cents        inspector approved − fee (− retainage) = what actually wires
 *
 * `feeCents` is the file's resolved processing fee; pass the RECORDED ledger fee once a release
 * exists (set `feeRecorded:true`) so the report stops calling it a projection.
 */
function drawMoney({ draw = {}, requests = [], findingLines = [], feeCents = 0, feeRecorded = false,
  retainageHeldCents = 0, netReleaseCents = null, released = false, finding = null } = {}) {
  const requested = draw.total_requested_cents != null
    ? N(draw.total_requested_cents)
    : (Array.isArray(requests) ? requests : []).reduce((s, r) => s + N(r && r.requested_cents), 0);
  const insp = inspectorApproved({ draw, requests, findingLines });
  const isFinal = FINAL_STATUSES.has(String(draw.status || ''));
  const fee = Math.max(0, Math.round(N(feeCents)));
  const retainage = Math.max(0, Math.round(N(retainageHeldCents)));
  // Once a release is recorded, its stored net wins (it already carries the out-of-pocket floor and
  // retainage). Until then we PROJECT: what the inspector approved, less the fee we will net out.
  const net = netReleaseCents != null ? N(netReleaseCents) : Math.max(0, insp.cents - fee - retainage);
  const state = approvalState({ draw, finding, released, hasInspectorAmounts: insp.hasAmounts });
  return {
    requested_cents: requested,
    inspector_approved_cents: insp.cents,
    inspector_approved_source: insp.source,
    has_inspector_amounts: insp.hasAmounts,
    // The single number every surface prints as "approved". Before final approval that is the
    // inspector's proposal; after it, the two are the same figure.
    approved_cents: insp.cents,
    final_approved_cents: isFinal ? (N(draw.total_approved_cents) || insp.cents) : 0,
    not_approved_cents: Math.max(0, requested - insp.cents),
    fee_cents: fee,
    fee_projected: fee > 0 && !feeRecorded,
    retainage_held_cents: retainage,
    net_release_cents: net,
    is_final_approved: isFinal,
    is_released: !!released,
    approval_stage: state.stage,
    approval_label: state.label,
    approval_borrower_label: state.borrowerLabel,
  };
}

/**
 * The one sentence that explains the netting on a report/packet — the owner's ask: say clearly WHY
 * money is being netted and exactly WHAT is netted. Returns null when nothing is deducted.
 */
function netExplanation(m, { borrower = false } = {}) {
  if (!m || (!N(m.fee_cents) && !N(m.retainage_held_cents))) return null;
  const usd = (c) => '$' + (Math.round(N(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const parts = [];
  if (N(m.fee_cents)) parts.push(`the ${usd(m.fee_cents)} draw processing fee`);
  if (N(m.retainage_held_cents)) parts.push(`${usd(m.retainage_held_cents)} held back as retainage`);
  const lead = borrower
    ? `${usd(m.approved_cents)} was approved on this draw. We deduct ${parts.join(' and ')}, so ${usd(m.net_release_cents)} is wired to you.`
    : `${usd(m.approved_cents)} approved − ${parts.join(' − ')} = ${usd(m.net_release_cents)} net release.`;
  return lead + (m.fee_projected ? (borrower ? '' : ' (fee is this file’s standard draw fee; it becomes final when the release is recorded.)') : '');
}

module.exports = {
  STAGE_ORDER, STAGE_TEXT, FINAL_STATUSES,
  approvalState, inspectorApproved, drawMoney, netExplanation,
};
