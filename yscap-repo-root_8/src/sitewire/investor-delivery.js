'use strict';
/**
 * INVESTOR DELIVERY OF A DRAW (owner-directed 2026-08-03).
 *
 * The last rung of the approval ladder (./approval) that PILOT never modelled. Once the borrower
 * AGREES with the inspector's findings — in the portal, or verbally / by email with a coordinator
 * recording it — the draw goes to the INVESTOR (the note buyer), who puts up the money. Two ways,
 * and the difference decides what the email ASKS FOR:
 *
 *   reimbursement   (DEFAULT) — WE wire the net to the borrower; the investor reimburses us the
 *                   FULL approved amount. Our draw fee never moves: it simply stays with us out
 *                   of the money we already netted, so the investor sends ONE number and never
 *                   has to send the fee separately.
 *   investor_direct — the INVESTOR wires the net to the borrower and our fee to us. Two payments.
 *   manual          — the delivery is handled entirely OUTSIDE PILOT (a phone call, the investor's
 *                   own portal, an off-platform arrangement). PILOT sends NO email and needs no
 *                   saved investor contacts; it only RECORDS that the coordinator delivered the
 *                   draw, so the "deliver to the investor" reminders stop and the history shows it.
 *
 * In the two EMAILED modes the investor funds the same total (what was approved) — only who
 * receives it differs. The email always states the three figures the owner asked for by name: what
 * was approved, what reaches the borrower, and what comes to us. `manual` sends no email at all.
 *
 * PURE — no DB, no network, integer cents. The IO half (contacts, attachments, sending, the
 * delivery record) lives in ./investor-delivery-send.js so this whole file unit-tests with no
 * database, exactly like ./approval and ./draw-packet.
 */

const DRAW_LABEL = require('../lib/draw-label');   // pure: "Draw 2"

const N = (x) => Number(x || 0) || 0;

const MODES = ['reimbursement', 'investor_direct', 'manual'];
// The DEFAULT is that the INVESTOR releases the money directly to the borrower
// (owner-directed 2026-08-05: "the default should always be that the investor is
// releasing the money to the borrower"). A per-draw or per-file choice still wins;
// this is only the fallback when neither is set. (Was 'reimbursement'.)
const DEFAULT_MODE = 'investor_direct';
// The modes that actually send an email to the investor (manual does not).
const EMAILED_MODES = ['reimbursement', 'investor_direct'];

const MODE_LABEL = {
  reimbursement: 'We release — investor reimburses us',
  investor_direct: 'Investor releases the money',
  manual: 'Delivered manually (outside PILOT)',
};

// What each mode means, in one plain sentence, for the desk screen.
const MODE_HELP = {
  reimbursement:
    'We wire the borrower their net amount now and the investor reimburses us the full approved '
    + 'amount. Our draw fee stays with us — the investor never sends it separately.',
  investor_direct:
    'The investor wires the borrower their net amount directly and sends our draw fee to us.',
  manual:
    'You handle the delivery to the investor yourself — PILOT sends no email. It just records that '
    + 'this draw was delivered, so the reminders stop.',
};

// WHERE an answer can be given, most specific FIRST. Each entry is [level, argument].
// The middle two are the levels the owner asked for by name (2026-08-09): "we should have a
// setting where we should be able to set every property … whether this property, by default, is
// released by the investor or released by us. We should also have settings where we should be
// able to set that by capital provider."
const MODE_LEVELS = [
  ['draw', 'drawMode'],                 // this one draw, set on the desk
  ['project', 'fileMode'],              // this property/file
  ['capital_provider', 'ruleMode'],     // every file with this note buyer
  ['company', 'companyMode'],           // the company-wide default in Draw Settings
];

// How each level reads on a screen — "where did this answer come from?".
const LEVEL_LABEL = {
  draw: 'set on this draw',
  project: 'set on this project',
  capital_provider: 'set for this capital provider',
  company: 'the company default',
  default: 'the built-in default',
};

/**
 * Which way is THIS draw funded, AND which level decided it?
 *
 * Most specific wins: this draw → this project → this capital provider → the company default →
 * the built-in default. An unrecognised stored value can never take effect — it falls through to
 * the next level rather than being honoured — because a typo in the database must never silently
 * change who gets wired.
 *
 * Returns { mode, level } where level is a MODE_LEVELS key or 'default'.
 */
function resolveFundingModeAt(opts = {}) {
  for (const [level, key] of MODE_LEVELS) {
    const v = opts[key];
    if (MODES.includes(String(v || ''))) return { mode: String(v), level };
  }
  return { mode: DEFAULT_MODE, level: 'default' };
}

/** The mode alone — the shape every existing caller already passes and reads. */
function resolveFundingMode({ drawMode = null, fileMode = null, ruleMode = null, companyMode = null } = {}) {
  return resolveFundingModeAt({ drawMode, fileMode, ruleMode, companyMode }).mode;
}

// ---------------------------------------------------------------------------
// WHAT THE INVESTOR SAID BACK
// ---------------------------------------------------------------------------

// The three real outcomes. 'questioned' is NOT a soft decline: an investor asking for one more
// photo is the common case, and folding it into 'declined' would make the draw look dead on every
// screen and stop the coordinator chasing the one thing that would unblock it.
const ANSWERS = ['approved', 'questioned', 'declined'];

const ANSWER_LABEL = {
  approved: 'Approved — funding it',
  questioned: 'Came back with a question',
  declined: 'Declined',
};

// What each answer means for the draw, in one sentence, and what the desk should do next.
const ANSWER_NEXT = {
  approved: 'The investor is funding this draw. Record the release when the money moves — or, if they release directly, final approve to record it.',
  questioned: 'The investor needs something before they will fund it. Answer their question, attach whatever they asked for, and re-send.',
  declined: 'The investor will not fund this draw as it stands. Work out why with them, then either re-send or take it back to the borrower.',
};

/**
 * Is this a real answer, and does it need anything with it?
 * Returns { ok } or { ok:false, error } — a plain sentence the desk can show.
 *
 * A QUESTION OR A DECLINE MUST SAY WHAT THE INVESTOR ASKED. Recording "declined" with no reason
 * gives the next person nothing to act on, which is the state this whole feature exists to end.
 * An approval needs no note — the money speaks for itself.
 */
function answerProblem({ answer, note = null } = {}) {
  const a = String(answer || '');
  if (!ANSWERS.includes(a)) return { ok: false, error: 'Pick what the investor said: approved, came back with a question, or declined.' };
  const n = String(note || '').trim();
  if ((a === 'questioned' || a === 'declined') && n.length < 4) {
    return { ok: false, error: a === 'questioned'
      ? 'Write down what the investor asked for, so whoever picks this up knows what to send them.'
      : 'Write down why the investor declined, so whoever picks this up knows what happened.' };
  }
  return { ok: true };
}

/**
 * Split ONE draw's money the way the investor needs to see it.
 *
 * `m` is the per-draw money object every other surface already uses — `approval.drawMoney()`'s
 * output, which is what the rollup folds onto each draw and what the report and the Excel packet
 * are built from. Taking it whole (rather than re-deriving) is the same-figure discipline that
 * keeps the report, the packet and this email from ever quoting different numbers.
 *
 * Returns integer cents:
 *   approved_cents        what the inspector/we approved on this draw
 *   to_borrower_cents     the net that reaches the borrower
 *   to_us_cents           our draw fee plus any retainage we hold back
 *   investor_total_cents  what the investor funds in total (always the approved amount)
 */
function investorMoney(m, mode) {
  const approved = Math.max(0, Math.round(N(m && m.approved_cents)));
  const fee = Math.max(0, Math.round(N(m && m.fee_cents)));
  const retainage = Math.max(0, Math.round(N(m && m.retainage_held_cents)));
  // Prefer the recorded/derived net so this can never disagree with the report; fall back to the
  // arithmetic only when it is missing. Clamped to the approved amount — a stored net larger than
  // what was approved would make `to_us` negative and read as the investor owing the borrower more
  // than the draw.
  const rawNet = m && m.net_release_cents != null ? Math.round(N(m.net_release_cents))
    : approved - fee - retainage;
  const toBorrower = Math.min(approved, Math.max(0, rawNet));
  const toUs = Math.max(0, approved - toBorrower);
  return {
    mode: MODES.includes(String(mode || '')) ? String(mode) : DEFAULT_MODE,
    requested_cents: Math.max(0, Math.round(N(m && m.requested_cents))),
    approved_cents: approved,
    fee_cents: fee,
    retainage_held_cents: retainage,
    fee_projected: !!(m && m.fee_projected),
    to_borrower_cents: toBorrower,
    to_us_cents: toUs,
    investor_total_cents: approved,
  };
}

const usd = (c) => '$' + (Math.round(N(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * THE EMAIL, in words. Professional and plain — this goes to an outside capital partner, so it
 * reads like a person wrote it, carries no marketing, no urgency language and no link-bait (all
 * of which push a message toward a spam folder). Returns the pieces; the sender renders them.
 *
 *   d = { loanNo, address, drawNumber, borrowerName, coordinatorName, inspectionBy }
 *   money = investorMoney(...) output
 */
function deliveryEmail(d = {}, money = {}) {
  const mode = MODES.includes(String(money.mode || '')) ? String(money.mode) : DEFAULT_MODE;
  const addr = String(d.address || '').trim() || 'the subject property';
  // "Draw 2" — the owner's own wording, and the SAME label every other draw email now leads
  // with (owner-directed 2026-08-09), so an investor's inbox and our own read alike. drawLabel is
  // pure (no DB, no requires of its own), so this module stays unit-testable with no database.
  const drawNo = DRAW_LABEL.drawLabel(d.drawNumber) || 'Draw request';
  const loanBit = d.loanNo ? ` — Loan ${d.loanNo}` : '';

  const subject = `${drawNo} — ${addr}${loanBit}`;

  // The three figures the owner asked for by name, in the order they are read.
  const rows = [
    { label: 'Requested by the borrower', value: usd(money.requested_cents) },
    { label: 'Approved on inspection', value: usd(money.approved_cents) },
  ];
  if (money.to_us_cents > 0) {
    rows.push({ label: 'To be released to the borrower', value: usd(money.to_borrower_cents) });
    rows.push({ label: 'Draw processing fee to YS Capital', value: usd(money.to_us_cents) });
  } else {
    // No fee and no retainage on this draw: the borrower receives the whole approved amount, and
    // printing a "$0.00 to YS Capital" line would only invite a question.
    rows.push({ label: 'To be released to the borrower', value: usd(money.to_borrower_cents) });
  }

  let ask;
  let intro;
  if (mode === 'reimbursement') {
    intro = `The inspection for ${drawNo.toLowerCase()} at ${addr} is complete and the borrower has `
      + `approved the results. We are releasing ${usd(money.to_borrower_cents)} to the borrower.`;
    ask = `Please reimburse YS Capital ${usd(money.investor_total_cents)} — the full approved amount. `
      + (money.to_us_cents > 0
        ? `Our ${usd(money.to_us_cents)} draw processing fee is already netted out of the borrower's release, so there is nothing to send separately.`
        : 'There is no separate fee on this draw.');
  } else {
    intro = `The inspection for ${drawNo.toLowerCase()} at ${addr} is complete and the borrower has `
      + 'approved the results. This draw is released directly by the investor.';
    ask = money.to_us_cents > 0
      ? `Please release ${usd(money.to_borrower_cents)} to the borrower and ${usd(money.to_us_cents)} to YS Capital — ${usd(money.investor_total_cents)} in total.`
      : `Please release ${usd(money.investor_total_cents)} to the borrower.`;
  }

  const detail = [];
  if (d.borrowerName) detail.push({ label: 'Borrower', value: String(d.borrowerName) });
  detail.push({ label: 'Property', value: addr });
  if (d.loanNo) detail.push({ label: 'Loan number', value: String(d.loanNo) });
  if (d.inspectionBy) detail.push({ label: 'Inspection', value: String(d.inspectionBy) });

  const signOff = d.coordinatorName
    ? `${d.coordinatorName}\nDraw Coordinator, YS Capital`
    : 'Draw Desk, YS Capital';

  return { subject, intro, ask, rows, detail, signOff, mode };
}

/**
 * WHO the delivery goes to. The investor's own contacts are the recipients; our people ride as
 * CARBON COPIES so the investor can reply to the thread and reach everyone at once (a BCC would
 * hide the team from that reply, which is the opposite of "always loop them in").
 *
 * THE BORROWER IS NEVER A RECIPIENT — of any kind. This is lender-to-investor correspondence
 * about our own fee income and the capital partner's funding. `dropBorrower` is applied to every
 * list as a structural backstop, so a borrower address reaching this function by any route (a
 * contact typed into the investor settings by mistake, a borrower who is also a staff user) is
 * removed rather than trusted.
 */
function clean(list) {
  return [...new Set((list || [])
    .map((e) => String(e == null ? '' : e).trim().toLowerCase())
    .filter((e) => e && e.includes('@') && !/[\s,;<>"]/.test(e)))];
}

function composeRecipients({ investorEmails = [], coordinatorEmails = [], officerEmails = [], deskEmail = null, borrowerEmails = [] } = {}) {
  const banned = new Set(clean(borrowerEmails));
  const drop = (list) => clean(list).filter((e) => !banned.has(e));
  const to = drop(investorEmails);
  const toSet = new Set(to);
  const cc = drop([...coordinatorEmails, ...officerEmails, ...(deskEmail ? [deskEmail] : [])])
    .filter((e) => !toSet.has(e));
  return { to, cc, excludedBorrower: clean(borrowerEmails).filter((e) => clean([...investorEmails, ...coordinatorEmails, ...officerEmails, deskEmail]).includes(e)) };
}

/**
 * Is this draw ready to go to the investor? Returns the blockers in plain words — the desk shows
 * them BEFORE the button, so nobody clicks into a refusal.
 *
 * The governing rule: the borrower must have AGREED. That is `accepted` (they clicked Accept, or
 * a coordinator recorded their verbal/email authorization) or `resolved` (they pushed back, we
 * worked it out and every disputed line has been decided). `delivered` means we are still waiting
 * on them, and `disputed` means the disagreement is still open — neither may go to an investor.
 */
const AGREED_STATUSES = ['accepted', 'resolved'];

function deliveryBlockers({ finding = null, investorContacts = [], noteBuyer = null, mode = null, wireForm = null, plansPermits = null } = {}) {
  const out = [];
  // PLANS & PERMITS BEFORE THE FIRST DRAW (owner-directed 2026-08-18): on a ground-up file
  // the first-draw plans condition must be SIGNED OFF before a draw goes to the investor.
  // `plansPermits` is {applies, itemId, satisfied} from sitewire/plans-permits.status —
  // only supplied by the DB callers; null skips (back-compat / pure tests), and a file on
  // which the condition was never raised (itemId null — predates the rule) never blocks.
  if (plansPermits && plansPermits.applies && plansPermits.itemId && !plansPermits.satisfied) {
    out.push('The plans & permits have not been signed off for the draw phase yet — the "Plans & permits — confirmed before the first draw" condition on the file must be signed off by the draw coordinator before this draw goes to the investor.');
  }
  if (!finding) {
    out.push('The inspection findings have not been delivered to the borrower yet.');
    return out;
  }
  if (!AGREED_STATUSES.includes(String(finding.status || ''))) {
    out.push(String(finding.status) === 'disputed'
      ? 'The borrower pushed back on this draw — decide the disputed lines first, then it can go to the investor.'
      : 'The borrower has not agreed to the inspection findings yet. Once they accept — or you record that they agreed by phone or email — this can go to the investor.');
  }
  // THE SIGNED WIRE FORM MUST BE ACCEPTED before the borrower's money moves (owner-directed
  // 2026-08-05: "fully accept before investor delivery of the first draw"). The borrower's
  // DocuSign wire form files onto the draw wire condition; the coordinator reviews it, accepts
  // ONE correct version and rejects the rest — because on an investor_direct delivery the
  // investor wires the borrower off THIS exact form, and on a reimbursement delivery WE wired
  // them off it. A MANUAL delivery is handled entirely outside PILOT (the coordinator verifies
  // the wire themselves), so it is not gated on the in-PILOT acceptance. `wireForm` is only
  // supplied by the DB callers; when it is null the check is skipped (back-compat / pure tests).
  if (String(mode || '') !== 'manual' && wireForm && !wireForm.accepted) {
    if (!wireForm.present) {
      out.push('The borrower has not signed the wire instructions form yet, so PILOT cannot confirm where the money goes. Send the draw request for signature and accept the signed form first.');
    } else if (wireForm.rejectedOnly) {
      out.push('The signed wire form was rejected. The borrower needs to re-sign it and the correct version must be accepted before this draw can go to the investor.');
    } else {
      out.push('The signed wire form has not been accepted yet — review it and accept the correct version before delivering this draw to the investor (in case something was filled in wrong).');
    }
  }
  // Every mode records WHICH investor the draw went to, so the note buyer must be set.
  if (!String(noteBuyer || '').trim()) {
    out.push('This file has no note buyer set, so PILOT does not know which investor to send it to.');
  } else if (String(mode || '') !== 'manual' && !(investorContacts || []).length) {
    // A MANUAL delivery is handled outside PILOT — no email is sent, so it needs no saved contacts.
    out.push(`No investor contacts are saved for ${String(noteBuyer).trim()} yet — add the people who should receive draw deliveries.`);
  }
  return out;
}

module.exports = {
  MODES, DEFAULT_MODE, EMAILED_MODES, MODE_LABEL, MODE_HELP, AGREED_STATUSES,
  MODE_LEVELS, LEVEL_LABEL,
  ANSWERS, ANSWER_LABEL, ANSWER_NEXT, answerProblem,
  resolveFundingMode, resolveFundingModeAt, investorMoney, deliveryEmail, composeRecipients, deliveryBlockers,
  _internals: { clean, usd },
};
