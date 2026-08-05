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

/**
 * Which way is THIS draw funded? A per-draw choice wins; otherwise the file's default; otherwise
 * the system default. An unrecognised stored value can never take effect (it falls through to the
 * next source) — a typo in the database must not silently change who gets wired.
 */
function resolveFundingMode({ drawMode = null, fileMode = null } = {}) {
  for (const v of [drawMode, fileMode]) {
    if (MODES.includes(String(v || ''))) return String(v);
  }
  return DEFAULT_MODE;
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
  const drawNo = d.drawNumber != null && d.drawNumber !== '' ? `Draw #${d.drawNumber}` : 'Draw request';
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

function deliveryBlockers({ finding = null, investorContacts = [], noteBuyer = null, mode = null } = {}) {
  const out = [];
  if (!finding) {
    out.push('The inspection findings have not been delivered to the borrower yet.');
    return out;
  }
  if (!AGREED_STATUSES.includes(String(finding.status || ''))) {
    out.push(String(finding.status) === 'disputed'
      ? 'The borrower pushed back on this draw — decide the disputed lines first, then it can go to the investor.'
      : 'The borrower has not agreed to the inspection findings yet. Once they accept — or you record that they agreed by phone or email — this can go to the investor.');
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
  resolveFundingMode, investorMoney, deliveryEmail, composeRecipients, deliveryBlockers,
  _internals: { clean, usd },
};
