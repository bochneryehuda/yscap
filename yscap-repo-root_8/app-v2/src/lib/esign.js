/* Shared presenter helpers for the e-signature surfaces (the cross-file cockpit
 * EsignDashboard + the per-file EsignFileSection). One source of truth for the
 * phase/purpose/role vocabulary, the relative-time formatter, and the
 * per-recipient step derivation, so the two screens never drift. */

export const PHASE = {
  draft:                { label: 'Draft',                     cls: 'muted',    dot: '#4B585C' },
  awaiting_borrower:    { label: 'Awaiting borrower',         cls: 'new',      dot: '#2F7F86' },
  awaiting_countersign: { label: 'Awaiting counter-signature', cls: 'gold',    dot: '#AE8746' },
  completed:            { label: 'Completed',                 cls: 'ok',       dot: '#2E7A5E' },
  declined:             { label: 'Declined',                  cls: 'declined', dot: '#A32A2A' },
  voided:               { label: 'Voided',                    cls: 'muted',    dot: '#4B585C' },
  error:                { label: 'Send failed',               cls: 'declined', dot: '#A32A2A' },
};
export const PURPOSE = {
  term_sheet_package: 'Term-Sheet Package',
  heter_iska: 'Heter Iska',
  draw_request: 'Draw request',
  test: 'Test',
};

// Friendly confirmation shown when a signer bounces back from DocuSign's embedded
// signing view (…/api/esign/return sets ?esign=<state>). Keyed by landing state.
export const ESIGN_RETURN_MSG = {
  signed:    { tone: 'ok',   text: 'Thanks — we’ve received your signature. It can take a moment to show as completed.' },
  viewed:    { tone: 'info', text: 'You’ve reviewed the documents. You can sign anytime from your email link.' },
  declined:  { tone: 'info', text: 'You declined to sign. Reach out to your loan officer with any questions.' },
  expired:   { tone: 'info', text: 'That signing link expired — please use your latest email link or request a new one.' },
  cancelled: { tone: 'info', text: 'No problem — you can come back and sign anytime from your email link.' },
  timeout:   { tone: 'info', text: 'Your signing session timed out — please reopen the link from your email to continue.' },
  done:      { tone: 'ok',   text: 'Thanks — you’re all set.' },
};
export const ROLE = {
  borrower: 'Borrower',
  co_borrower: 'Co-borrower',
  admin: 'Counter-signature',
};

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
export const absTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

/** A recipient's own progress: sent -> viewed -> signed, or a terminal decline. */
export function recipientSteps(r) {
  const signed = r.signedAt || r.status === 'completed' || r.status === 'signed';
  const declined = r.declinedAt || r.status === 'declined';
  const viewed = r.deliveredAt || r.status === 'delivered' || signed;
  const sent = r.sentAt || r.status === 'sent' || viewed || signed;
  return [
    { key: 'sent', label: 'Sent', at: r.sentAt, done: !!sent },
    { key: 'viewed', label: 'Viewed', at: r.deliveredAt, done: !!viewed },
    declined
      ? { key: 'declined', label: 'Declined', at: r.declinedAt, done: true, bad: true }
      : { key: 'signed', label: 'Signed', at: r.signedAt, done: !!signed },
  ];
}

export const recipientState = (r) =>
  (r.declinedAt || r.status === 'declined') ? 'bad'
  : (r.signedAt || r.status === 'completed' || r.status === 'signed') ? 'done'
  : 'pending';

export const TERMINAL = ['completed', 'declined', 'voided', 'draft', 'error'];

/** Hours since the envelope last made progress (an SLA/aging clock for in-flight
 * envelopes). Best-in-class ops signal: a package sitting unsigned is deal risk.
 * Returns null for terminal envelopes. */
export function agingHours(envelope) {
  if (!envelope || TERMINAL.includes(envelope.phase)) return null;
  let latest = envelope.sentAt ? new Date(envelope.sentAt).getTime() : null;
  for (const r of (envelope.recipients || [])) {
    for (const t of [r.sentAt, r.deliveredAt, r.signedAt]) {
      if (t) { const ms = new Date(t).getTime(); if (Number.isFinite(ms) && (!latest || ms > latest)) latest = ms; }
    }
  }
  if (!latest) return null;
  return Math.max(0, (Date.now() - latest) / 3600000);
}
/** ok (< 1 day) | warn (1–3 days) | late (> 3 days). */
export function agingLevel(h) { return h == null ? null : h >= 72 ? 'late' : h >= 24 ? 'warn' : 'ok'; }
export function agingLabel(h) {
  if (h == null) return '';
  if (h < 1) return 'under 1h';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
