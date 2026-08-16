import React, { useState } from 'react';
import { api } from '../lib/api';
import { ZipInput } from './FormattedInputs.jsx';

/**
 * THE APPRAISAL PAYMENT CARD — ONE entry form, wherever it is asked for.
 *
 * The owner's rule (2026-08-05): *"entering the card AT THE ORDER fills the
 * condition, and entering it AT THE CONDITION fills the order — one card,
 * entered once, both places."* Half of that shipped: the condition row has had
 * an "Enter card" control since #107, and the order desk only ever DISPLAYED
 * "Payment card: not on file" with no way to type one — so an officer standing
 * at the order had to leave it, find the condition, and come back.
 *
 * This is that form, lifted out of `StaffApplication.jsx` so both surfaces
 * render the SAME one rather than growing a second copy that drifts (the
 * appraisal-order architecture note asks for exactly this: "render the SAME
 * StaffCardEntry / reveal card UI in the unified panel — the card is not
 * vendor-specific").
 *
 * THE BIDIRECTIONAL LINK IS THE SERVER'S, NOT THIS COMPONENT'S. It posts to the
 * ordinary staff door, which goes through `lib/appraisal-card.saveApplicationCard`
 * — the ONE chokepoint that encrypts the card, upserts the per-file row AND flips
 * the `appraisal_card` condition to 'received'. So the card typed here fills the
 * condition for free, and a card the borrower typed on the condition shows up on
 * the order preview, because both read the same row. Never post a card to a
 * vendor-specific door instead: a second writer is how the two halves drift.
 *
 * Payment stays MANUAL (owner-directed) — nothing here charges anything.
 */
export default function AppraisalCardEntry({ appId, onSaved, align = 'flex-end', label = 'Enter card' }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true); setErr('');
    try {
      await api.staffSaveAppraisalCard(appId, f);
      setOpen(false);
      setF({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
      if (onSaved) await onSaved();
    } catch (e) { setErr((e && e.message) || 'Could not save the card.'); }
    finally { setBusy(false); }
  }

  if (!open) return <button className="btn ghost small" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="small" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: align }}>
      <input className="input" style={{ maxWidth: 170 }} inputMode="numeric" placeholder="Card number" value={f.number} onChange={set('number')} />
      <input className="input" style={{ maxWidth: 56 }} inputMode="numeric" placeholder="MM" value={f.expMonth} onChange={set('expMonth')} />
      <input className="input" style={{ maxWidth: 72 }} inputMode="numeric" placeholder="YYYY" value={f.expYear} onChange={set('expYear')} />
      <input className="input" style={{ maxWidth: 64 }} inputMode="numeric" placeholder="CVC" value={f.cvc} onChange={set('cvc')} />
      <ZipInput style={{ maxWidth: 84 }} placeholder="ZIP" value={f.zip} onChange={(v) => setF((p) => ({ ...p, zip: v }))} />
      <button className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save card'}</button>
      <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
      {err && <span style={{ color: 'var(--bad, #c0392b)', flexBasis: '100%', textAlign: align === 'flex-end' ? 'right' : 'left' }}>{err}</span>}
    </div>
  );
}
