'use strict';
/**
 * WHAT'S LEFT ON THIS DRAW — one live checklist (owner-directed 2026-08-09).
 *
 * THE GAP. Everything a draw is waiting on already exists somewhere: the inspection order, the
 * findings row, the borrower's acceptance, the signed wire form, the lien waivers, the investor
 * delivery, the ledger. But none of it was ever assembled, so the blockers only appeared as a
 * REFUSAL when somebody pressed Deliver — you had to try the action to find out what was missing.
 *
 * This is the same set of facts, stated FORWARD: every step, whether it is done, who we are
 * waiting on, and the ONE action that clears it.
 *
 * THREE RULES THAT MAKE IT TRUSTWORTHY.
 *
 *   1. A STEP THAT DOES NOT APPLY IS OMITTED, NEVER SHOWN AS OUTSTANDING. Lien waivers are off on
 *      most files; an operating agreement is only needed when the wire goes to a new entity; the
 *      investor steps do not exist on a manual delivery. A checklist that lists work nobody has to
 *      do teaches people to ignore it.
 *   2. UNKNOWN IS ITS OWN STATE. A fact PILOT cannot read is 'unknown' — never quietly 'done'.
 *      That is the whole point of the owner's "an unknown platform status stops masquerading as
 *      progress": a draw whose platform status we do not recognise must not read as inspecting.
 *   3. IT DECIDES NOTHING. This is a description of the file, not a gate. The real refusals stay
 *      exactly where they are (deliveryBlockers, the lien-waiver gate, the send gate) — a
 *      checklist that could silently start refusing a draw would be a new gate nobody signed off.
 *
 * The truth table is PURE; the reader at the bottom takes its `db` as an argument.
 */

const APPROVAL = require('./approval');

const DONE = 'done', WAITING = 'waiting', UNKNOWN = 'unknown';

/**
 * The steps, in the order a draw actually walks them.
 *
 *   key      stable name
 *   label    plain words
 *   who      who we are waiting on while it is outstanding
 *   action   the ONE thing that clears it
 *   applies  (facts) => boolean — omit the step entirely when it does not apply
 *   state    (facts) => 'done' | 'waiting' | 'unknown'
 *   detail   (facts) => a short sentence, or null
 */
const STEPS = Object.freeze([
  {
    key: 'inspection_ordered', label: 'Inspection ordered', who: 'us',
    action: 'Order the inspection on the draw desk',
    state: (f) => (f.inspectionOrdered ? DONE : (f.inspectionOrdered === null ? UNKNOWN : WAITING)),
  },
  {
    key: 'visit_scheduled', label: 'Visit scheduled', who: 'the inspector',
    action: 'Chase the inspector for a date',
    // Only an ON-SITE inspection has a visit to schedule; a virtual one never does, so showing it
    // as outstanding on every virtual draw would be permanent noise.
    applies: (f) => f.physicalInspection === true,
    state: (f) => (f.visitScheduledAt ? DONE : WAITING),
    detail: (f) => (f.visitScheduledAt ? `Booked for ${day(f.visitScheduledAt)}` : null),
  },
  {
    key: 'report_received', label: 'Inspection report received', who: 'the inspector',
    action: 'Chase the inspector for the report',
    state: (f) => (f.reportReceived ? DONE : (f.reportReceived === null ? UNKNOWN : WAITING)),
  },
  {
    key: 'findings_reviewed', label: 'Findings reviewed by us', who: 'us',
    action: 'Read the inspection and mark it reviewed',
    // Only once there is something to review. Before the report lands this is not outstanding work.
    applies: (f) => !!f.hasFindings,
    state: (f) => (f.findingsReviewedAt ? DONE : WAITING),
    detail: (f) => (f.findingsReviewedAt ? `Reviewed ${day(f.findingsReviewedAt)}` : 'Nobody has confirmed they read the inspector’s report yet'),
  },
  {
    key: 'findings_delivered', label: 'Results sent to the borrower', who: 'us',
    action: 'Deliver the findings',
    applies: (f) => !!f.hasFindings,
    state: (f) => (f.findingsDeliveredAt ? DONE : WAITING),
  },
  {
    key: 'borrower_agreed', label: 'Borrower agreed', who: 'the borrower',
    action: 'Chase the borrower, or record that they agreed by phone or email',
    applies: (f) => !!f.hasFindings,
    state: (f) => (f.borrowerAgreed ? DONE : WAITING),
    detail: (f) => (f.findingStatus === 'disputed' ? 'They pushed back — decide the disputed lines' : null),
  },
  {
    key: 'wire_form_signed', label: 'Wire instructions signed', who: 'the borrower',
    action: 'Send the wire form for signature',
    state: (f) => (f.wireFormPresent ? DONE : (f.wireFormPresent === null ? UNKNOWN : WAITING)),
  },
  {
    key: 'wire_form_accepted', label: 'Wire instructions accepted by us', who: 'us',
    action: 'Review the signed form and accept the correct version',
    applies: (f) => f.wireFormPresent === true,
    state: (f) => (f.wireFormAccepted ? DONE : WAITING),
    detail: (f) => (f.wireFormRejectedOnly ? 'The signed form was rejected — the borrower needs to re-sign it' : null),
  },
  {
    key: 'operating_agreement', label: 'Operating agreement on file', who: 'the borrower',
    action: 'Collect the operating agreement for the wire recipient',
    // Only when the wire names an entity that is neither the borrower nor the subject LLC.
    applies: (f) => f.newEntityWire === true,
    state: (f) => (f.operatingAgreementAccepted ? DONE : WAITING),
  },
  {
    key: 'lien_waivers', label: 'Lien waivers in', who: 'the contractor',
    action: 'Collect or waive the outstanding waivers',
    applies: (f) => f.lienWaiversRequired === true,
    state: (f) => ((f.lienWaiversMissing || []).length === 0 ? DONE : WAITING),
    detail: (f) => ((f.lienWaiversMissing || []).length ? `Outstanding: ${f.lienWaiversMissing.join('; ')}` : null),
  },
  {
    key: 'sent_to_investor', label: 'Sent to the investor', who: 'us',
    action: 'Deliver the draw to the investor',
    // A MANUAL delivery is handled outside PILOT; there is nothing for us to send.
    applies: (f) => f.fundingMode !== 'manual',
    state: (f) => (f.investorSentAt ? DONE : WAITING),
    detail: (f) => (f.investorSentAt ? `Sent ${day(f.investorSentAt)}${f.investorDaysWaiting != null && !f.investorAnswer ? ` — ${f.investorDaysWaiting} day${f.investorDaysWaiting === 1 ? '' : 's'} ago` : ''}` : null),
  },
  {
    key: 'investor_answered', label: 'Investor answered', who: 'the investor',
    action: 'Chase the investor, then record what they said',
    applies: (f) => f.fundingMode !== 'manual' && !!f.investorSentAt,
    state: (f) => (f.investorAnswer ? DONE : WAITING),
    detail: (f) => (f.investorAnswer ? investorAnswerDetail(f) : null),
  },
  {
    key: 'final_approved', label: 'Final approval', who: 'us',
    action: 'Final approve the draw',
    state: (f) => (f.finalApproved ? DONE : WAITING),
  },
  {
    key: 'money_recorded', label: 'Money recorded', who: 'us',
    // The action genuinely differs by who released: on an investor-released draw PILOT writes the
    // row itself on final approve, so the thing to do is final approve — not type in a wire.
    action: 'Record the release on the draw desk',
    state: (f) => (f.releaseRecorded ? DONE : WAITING),
    detail: (f) => {
      if (f.releaseHeld) return 'Recorded as held — the lien waivers are still outstanding';
      if (f.releaseRecorded) return null;
      return f.fundingMode === 'investor_direct'
        ? 'The investor releases this file’s draws — final approve and PILOT records it'
        : null;
    },
  },
]);

function day(v) { try { return String(new Date(v).toISOString()).slice(0, 10); } catch (_) { return ''; } }

function investorAnswerDetail(f) {
  const a = String(f.investorAnswer || '');
  const when = f.investorAnsweredAt ? ` on ${day(f.investorAnsweredAt)}` : '';
  if (a === 'approved') return `Approved${when}${f.expectedFundingDate ? ` — funding ${day(f.expectedFundingDate)}` : ''}`;
  if (a === 'questioned') return `They asked a question${when}${f.investorAnswerNote ? `: ${String(f.investorAnswerNote).slice(0, 120)}` : ''}`;
  if (a === 'declined') return `Declined${when}${f.investorAnswerNote ? `: ${String(f.investorAnswerNote).slice(0, 120)}` : ''}`;
  return null;
}

/**
 * Build the checklist from a facts object. PURE — never throws, never reads anything.
 *
 * Returns { steps:[…], done, total, outstanding, nextUp, waitingOn, complete }.
 * `nextUp` is the FIRST step that is not done — the one thing to do next, in order.
 */
function buildChecklist(facts = {}) {
  const f = facts || {};
  const steps = [];
  for (const s of STEPS) {
    try {
      if (s.applies && !s.applies(f)) continue;
      const state = s.state(f) || UNKNOWN;
      steps.push({
        key: s.key, label: s.label, state,
        who: state === DONE ? null : s.who,
        action: state === DONE ? null : s.action,
        detail: (s.detail && s.detail(f)) || null,
      });
    } catch (_) {
      // A fact shaped unexpectedly must never break the card — the step reports UNKNOWN, which is
      // the honest answer and is exactly what it means.
      steps.push({ key: s.key, label: s.label, state: UNKNOWN, who: s.who, action: s.action, detail: null });
    }
  }
  const done = steps.filter((s) => s.state === DONE).length;
  const nextUp = steps.find((s) => s.state !== DONE) || null;
  return {
    steps, done, total: steps.length,
    outstanding: steps.filter((s) => s.state !== DONE),
    nextUp,
    waitingOn: nextUp ? nextUp.who : null,
    complete: done === steps.length && steps.length > 0,
  };
}

/**
 * A draw's platform status, in plain words — and an UNRECOGNISED one says so
 * (owner-directed: "an unknown platform status stops masquerading as progress").
 *
 * `approval.STAGE_TEXT` owns the vocabulary we understand. A status outside it used to fall
 * through to whatever the derived stage guessed, which read as "inspecting" — so a draw in a state
 * we do not model looked like ordinary progress. It now reports itself as unknown AND shows the
 * platform's own raw word, which is the only honest thing to put in front of somebody.
 */
function statusInWords(rawStatus, stage) {
  const raw = String(rawStatus || '').trim();
  const known = APPROVAL.STAGE_ORDER.includes(String(stage || ''));
  if (known) {
    // STAGE_TEXT carries BOTH voices ({staff, borrower}); this card is staff-facing.
    const t = APPROVAL.STAGE_TEXT[stage];
    return { known: true, stage, label: (t && (t.staff || t.label)) || stage, raw: raw || null };
  }
  return {
    known: false, stage: null,
    label: raw ? `Status from the platform: “${raw}”` : 'Status unknown',
    raw: raw || null,
    note: 'PILOT does not recognise this status, so it is shown exactly as the platform reports it rather than guessed at.',
  };
}

// ---------------------------------------------------------------------------
// The IO half — gather the facts for one draw. Never throws.
// ---------------------------------------------------------------------------

/**
 * Read every fact the checklist needs for ONE draw. Each read is independently guarded: a fact we
 * cannot read comes back as `null`, which the truth table renders as UNKNOWN rather than as done.
 */
async function factsFor(db, appId, drawId, { fundingMode = null } = {}) {
  const q = async (sql, params) => { try { return (await db.query(sql, params)).rows; } catch (_) { return null; } };
  const f = {};

  const draw = (await q(`SELECT status, total_approved_cents, submitted_at, approved_at FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]) || [])[0] || null;
  // The inspection clock starts when the draw was submitted for it — the same timestamp the
  // late-inspection reminder measures, so the expected date and the chase can never disagree.
  f.inspectionStartedAt = draw ? draw.submitted_at : null;
  f.rawStatus = draw ? draw.status : null;
  f.finalApproved = draw ? APPROVAL.FINAL_STATUSES.has(String(draw.status || '')) : null;

  const finding = (await q(
    `SELECT id, status, delivered_at, accepted_at, reviewed_at, funding_mode, created_at, wire_due_at
       FROM draw_findings WHERE application_id=$1 AND sitewire_draw_id=$2
      ORDER BY id DESC LIMIT 1`, [appId, drawId]) || [])[0] || null;
  f.hasFindings = !!finding;
  f.findingStatus = finding ? finding.status : null;
  f.findingsDeliveredAt = finding ? finding.delivered_at : null;
  f.findingsReviewedAt = finding ? finding.reviewed_at : null;
  f.borrowerAgreed = finding ? ['accepted', 'resolved'].includes(String(finding.status || '')) : false;
  f.findingsCreatedAt = finding ? finding.created_at : null;
  f.wireDueAt = finding ? finding.wire_due_at : null;
  // The report has arrived once the inspector's findings exist for this draw — that IS the report.
  f.reportReceived = finding ? true : (draw ? false : null);

  // The inspection order + its booked visit, when the platform mirrors one.
  //
  // THE TWO ID SPACES ARE NEVER MATCHED AGAINST EACH OTHER. A service order is keyed on the
  // TrustPoint draw id; this draw is a SITEWIRE draw id, and the numbers are unrelated. The join
  // goes through `trustpoint_draws.sitewire_draw_id` — the link the mirror itself maintains — so
  // this can never show another draw's visit date. Comparing them directly would find a row often
  // enough to look correct and be wrong about which draw it described.
  const so = (await q(
    `SELECT so.scheduled_at, so.status
       FROM trustpoint_service_orders so
       JOIN trustpoint_draws td ON td.tp_draw_id = so.tp_draw_id
      WHERE so.application_id=$1 AND td.sitewire_draw_id = $2::bigint
      ORDER BY so.ordered_at DESC NULLS LAST, so.tp_service_order_id DESC LIMIT 1`, [appId, String(drawId)]) || [])[0] || null;
  f.visitScheduledAt = so ? so.scheduled_at : null;
  // An order exists, or the draw has been submitted for inspection at all.
  f.inspectionOrdered = so ? true : (draw ? !['drafting', 'pending_borrower'].includes(String(draw.status || '')) : null);

  // Is this an on-site inspection? Only then is there a visit to schedule.
  try {
    const rp = await require('./routing').resolveFilePlatform(appId);
    f.physicalInspection = rp && rp.method ? rp.method === 'traditional' : null;
  } catch (_) { f.physicalInspection = null; }

  // The signed wire form, through the SAME reader the delivery gate uses, so the checklist and the
  // refusal can never disagree about whether the form is accepted.
  try {
    const send = require('./investor-delivery-send');
    const w = await send.wireFormStatus(appId);
    f.wireFormPresent = w ? !!w.present : null;
    f.wireFormAccepted = w ? !!w.accepted : null;
    f.wireFormRejectedOnly = !!(w && w.rejectedOnly);
  } catch (_) { f.wireFormPresent = null; f.wireFormAccepted = null; }

  // A wire to a NEW entity needs that entity's operating agreement.
  try {
    const drawOa = require('../lib/esign/draw-oa');
    // The condition's DURABLE key is `draw-oa`'s own OA_MARKER — read from that module rather than
    // retyped here, so the step can never look for a key the writer stopped using.
    const cond = (await q(`SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, drawOa.OA_MARKER(appId)]) || []);
    f.newEntityWire = cond.length > 0;
    f.operatingAgreementAccepted = f.newEntityWire ? !!(await drawOa.acceptedOaForInvestor(db, appId)) : false;
  } catch (_) { f.newEntityWire = false; f.operatingAgreementAccepted = false; }

  // Lien waivers, through the shared settings resolver and the shared gate.
  try {
    const SETTINGS = require('./draw-settings');
    f.lienWaiversRequired = await SETTINGS.lienGateEnabled(appId);
    if (f.lienWaiversRequired) {
      const rows = await q(`SELECT status, tier, party_name, kind FROM draw_lien_waivers WHERE sitewire_draw_id=$1`, [drawId]) || [];
      const gate = require('./money').waiverGate(rows, { enabled: true });
      f.lienWaiversMissing = gate.missing;
    } else f.lienWaiversMissing = [];
  } catch (_) { f.lienWaiversRequired = false; f.lienWaiversMissing = []; }

  // Which way this draw is funded, and what the investor said.
  f.fundingMode = fundingMode || (finding && finding.funding_mode) || null;
  if (!f.fundingMode) {
    try { f.fundingMode = (await require('./release-party').releaseStateFor(db, appId, { sitewireDrawId: drawId })).mode; } catch (_) {}
  }
  const del = (await q(
    `SELECT sent_at, answer, answered_at, answer_note, expected_funding_date,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - sent_at))/86400)::int AS days_waiting
       FROM draw_investor_deliveries
      WHERE application_id=$1 AND sitewire_draw_id=$2 AND status='sent'
      ORDER BY sent_at DESC LIMIT 1`, [appId, drawId]) || [])[0] || null;
  f.investorSentAt = del ? del.sent_at : null;
  f.investorAnswer = del ? del.answer : null;
  f.investorAnsweredAt = del ? del.answered_at : null;
  f.investorAnswerNote = del ? del.answer_note : null;
  f.expectedFundingDate = del ? del.expected_funding_date : null;
  f.investorDaysWaiting = del ? Number(del.days_waiting) : null;

  const disb = (await q(`SELECT funded_status, release_date, created_at FROM draw_disbursements WHERE sitewire_draw_id=$1 AND kind='draw' LIMIT 1`, [drawId]) || [])[0] || null;
  f.releaseRecorded = !!disb;
  f.releaseHeld = !!(disb && disb.funded_status === 'held');
  // A HELD release has not moved the money, so it is not the "actual" release date.
  f.releaseRecordedAt = (disb && disb.funded_status === 'released') ? (disb.release_date || disb.created_at) : null;

  return f;
}

// ---------------------------------------------------------------------------
// WHEN SHOULD EACH STEP HAPPEN — expected dates, from the settings
// ---------------------------------------------------------------------------

/** Add whole days to a calendar day, as a 'YYYY-MM-DD' string. Calendar arithmetic only. */
function addDays(from, days) {
  const t = from ? new Date(from).getTime() : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(Number(days))) return null;
  return new Date(t + Number(days) * 86400000).toISOString().slice(0, 10);
}

/**
 * The three dates a coordinator and a borrower both want: when the inspection should be in, when
 * we should have answered, and when the money should move.
 *
 * PURE. Each is derived from the step that STARTED the clock plus the matching SLA — and each is
 * `null` when that step has not happened, because "expected" with no start date is a guess. A date
 * that is already SETTLED (the report arrived, the findings went out, the money moved) reports the
 * real date instead of the estimate, marked as actual, so nobody is shown a prediction about
 * something that already happened.
 */
function expectedDates(facts = {}, sla = {}) {
  const f = facts || {};
  const d = (v) => (v ? String(new Date(v).toISOString()).slice(0, 10) : null);
  const out = {};

  out.inspection = f.reportReceived && f.findingsCreatedAt
    ? { date: d(f.findingsCreatedAt), actual: true }
    : (f.inspectionStartedAt && sla.inspection_sla_days > 0
      ? { date: addDays(f.inspectionStartedAt, sla.inspection_sla_days), actual: false }
      : null);

  out.decision = f.findingsDeliveredAt
    ? { date: d(f.findingsDeliveredAt), actual: true }
    : (f.findingsCreatedAt && sla.decision_sla_days > 0
      ? { date: addDays(f.findingsCreatedAt, sla.decision_sla_days), actual: false }
      : null);

  // The release clock starts when the money question is genuinely live: the borrower has agreed.
  // `wire_due_at` is the authority when there is one — it is what the overdue alert measures — so
  // the expected date and the alert can never disagree.
  out.release = f.releaseRecordedAt
    ? { date: d(f.releaseRecordedAt), actual: true }
    : (f.wireDueAt ? { date: d(f.wireDueAt), actual: false }
      : (f.investorSentAt && sla.investor_funding_sla_days > 0
        ? { date: addDays(f.investorSentAt, sla.investor_funding_sla_days), actual: false }
        : null));

  // Late is a plain comparison against today, and only ever on an ESTIMATE — something that has
  // already happened cannot be late.
  const today = new Date().toISOString().slice(0, 10);
  for (const k of Object.keys(out)) {
    if (out[k] && !out[k].actual && out[k].date) out[k].late = out[k].date < today;
  }
  return out;
}

/** The convenience every caller wants: the facts read and the checklist built. Never throws. */
async function checklistFor(db, appId, drawId, opts = {}) {
  try {
    const facts = await factsFor(db, appId, drawId, opts);
    const list = buildChecklist(facts);
    let dates = null;
    try {
      const DS = require('./draw-settings');
      const rows = (await db.query(`SELECT key, value FROM sitewire_settings`)).rows;
      const company = DS.companyMapFrom(rows);
      const sla = {};
      for (const k of ['inspection_sla_days', 'decision_sla_days', 'investor_funding_sla_days']) {
        sla[k] = Number(DS.resolveOne(DS.BY_KEY[k], { company }).value) || 0;
      }
      dates = expectedDates(facts, sla);
    } catch (_) { /* dates are additive — the checklist stands without them */ }
    return { ...list, status: statusInWords(facts.rawStatus, opts.stage), dates, facts };
  } catch (_) { return null; }
}

module.exports = {
  STEPS, DONE, WAITING, UNKNOWN,
  buildChecklist, statusInWords, expectedDates, factsFor, checklistFor,
  _internals: { day, investorAnswerDetail, addDays },
};
