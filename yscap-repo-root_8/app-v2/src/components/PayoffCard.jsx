import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';
import { askConfirm } from '../lib/dialog.js';

/* THE PAYOFF SECTION on a refinance file (owner-directed 2026-07-31: "we should
   set up a full section for the system to understand how the payoff works and
   how it should be entered").

   Before this, a refinance payoff was one lonely money box near the bottom of a
   long form. Nothing said what the number was for, nothing asked WHO holds the
   loan or WHICH loan it is — so the closing attorney could not order a payoff
   letter without a phone call — and a "cash-out" refinance quoted a cash figure
   the loan file never actually carried.

   So this section does four things that box could not:
     1. it says which kind of refinance this is, in words;
     2. it collects the three things a payoff needs — how much, to whom, on which
        loan — and says out loud what is still missing and why it matters;
     3. on a cash-out it shows what the borrower actually walks away with, worked
        out from the registered structure, and lets a human override it;
     4. it explains how a payoff works, so the file itself teaches the step.

   Everything shown is computed server-side (GET .../payoff → src/lib/payoff.js)
   from the file and the registered quote, so it can never drift from what the
   term sheet prints. Saving goes through the SAME write path everything else on
   this file uses (PATCH .../details) — freeze-aware and audited, one door.

   STAFF-ONLY. Text colors are explicit dark hex per the white-first rule (never
   an --ink* token, which resolves LIGHT). */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';

const usd = (n) => (n == null || !isFinite(Number(n))) ? '—'
  : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// The card's own three entry keys → what PATCH /details calls them.
const SAVE_KEY = {
  payoffAmount: 'payoffAmount',
  payoffLender: 'payoffLender',
  payoffLoanNumber: 'payoffLoanNumber',
  payoffGoodThrough: 'payoffGoodThrough',
  estimatedCashOut: 'estimatedCashOut',
};

function Row({ label, value, missing, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid #EDE9E0' }}>
      <div style={{ minWidth: 190, fontSize: 13, color: MUTED }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: missing ? '#9A6B00' : INK, wordBreak: 'break-word' }}>
        {children != null ? children : (value || (missing ? 'Still needed' : '—'))}
      </div>
    </div>
  );
}

export default function PayoffCard({ appId, app, onSaved }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ payoffAmount: '', payoffLender: '', payoffLoanNumber: '', payoffGoodThrough: '', estimatedCashOut: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  const load = useCallback(() => api.get(`/api/staff/applications/${appId}/payoff`)
    .then((r) => { setState(r || null); return r; })
    .catch(() => null)
    .finally(() => setLoading(false)), [appId]);

  // Re-read whenever the file's own numbers move — a re-register changes the
  // structure, which changes what the borrower walks away with.
  useEffect(() => { load(); }, [load, app && app.loan_type, app && app.payoff_amount,
    app && app.payoff_lender, app && app.payoff_loan_number, app && app.estimated_cash_out]);

  if (loading || !state) return null;
  /* A purchase has nothing to pay off. This says so in one line rather than
     rendering nothing: the section around it is shown whenever the loan purpose
     LOOKS like a refinance, and a blank section reads as broken. It also covers
     the one case where the two disagree — a purpose such as "Delayed Purchase
     Financing", which the server reads as a purchase however it is spelled. */
  if (!state.applies) {
    return (
      <div className="panel" style={{ borderLeft: `3px solid ${GOLD}` }}>
        <b style={{ color: INK }}>Payoff</b>
        <div style={{ marginTop: 6, fontSize: 13.5, color: MUTED, lineHeight: 1.5 }}>
          This file’s loan purpose is <b style={{ color: INK }}>{state.kindLabel}</b>, so there is no existing
          loan to pay off. Change the loan purpose on the application details if that is wrong.
        </div>
      </div>
    );
  }

  const e = state.entered || {};
  const d = state.derived || {};
  const missingKeys = new Set((state.missing || []).map((m) => m.key));

  function startEdit() {
    setForm({
      payoffAmount: e.payoffAmount == null ? '' : String(e.payoffAmount),
      payoffLender: e.payoffLender || '',
      payoffLoanNumber: e.payoffLoanNumber || '',
      payoffGoodThrough: e.payoffGoodThrough || '',
      estimatedCashOut: e.estimatedCashOut == null ? '' : String(e.estimatedCashOut),
    });
    setEditing(true); setErr(''); setSaved(false);
  }

  async function setFreeAndClear(on) {
    const sure = await askConfirm(on
      ? 'Yes — this property is owned FREE AND CLEAR: there is NO existing loan to pay off. Both payoff conditions will be waived and the payoff of record becomes $0. Confirm?'
      : 'Turn OFF free and clear? The payoff conditions reopen and the payoff details will be needed again.');
    if (!sure) return;
    setBusy(true); setErr(''); setSaved(false);
    try {
      await api.payoffFreeAndClear(appId, on);
      await load();
      if (onSaved) await onSaved();
    } catch (ex) {
      setErr((ex && ex.message) || 'Could not update the free-and-clear flag.');
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(''); setSaved(false);
    try {
      /* ONLY WHAT ACTUALLY CHANGED. Two reasons, both real:
         · a field this form did not touch must never be re-sent — that is how a
           form opened five minutes ago saves its own stale copy over somebody
           else's fix;
         · the freeze carve-out on the server is keyed on the request containing
           NOTHING but the lender and their loan number. Sending an unchanged
           payoff amount alongside them would drag a term-sheet-sent file back
           into the freeze for an edit that changes no money at all. */
      const body = {};
      const was = { payoffAmount: e.payoffAmount == null ? '' : String(e.payoffAmount),
        payoffLender: e.payoffLender || '',
        payoffLoanNumber: e.payoffLoanNumber || '',
        estimatedCashOut: e.estimatedCashOut == null ? '' : String(e.estimatedCashOut) };
      const now = { ...form, payoffLender: form.payoffLender.trim(), payoffLoanNumber: form.payoffLoanNumber.trim() };
      was.payoffGoodThrough = e.payoffGoodThrough || '';
      for (const k of ['payoffAmount', 'payoffLender', 'payoffLoanNumber', 'payoffGoodThrough']) {
        if (now[k] !== was[k]) body[SAVE_KEY[k]] = now[k] === '' ? null : now[k];
      }
      // The cash-out figure only exists on a cash-out refinance. Never send it on
      // a rate-&-term — storing one there would contradict what the term sheet
      // says the deal is.
      if (state.isCashOut && now.estimatedCashOut !== was.estimatedCashOut) {
        body[SAVE_KEY.estimatedCashOut] = now.estimatedCashOut === '' ? null : now.estimatedCashOut;
      }
      if (!Object.keys(body).length) { setEditing(false); setBusy(false); return; }
      await api.staffEditApplication(appId, body);
      setEditing(false); setSaved(true);
      await load();
      if (onSaved) await onSaved();
    } catch (ex) {
      setErr((ex && ex.message) || 'Could not save the payoff details.');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ borderLeft: `3px solid ${GOLD}` }}>
      <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ color: INK }}>Payoff</b>
        <span className="pill muted">{state.kindLabel}</span>
        {state.ready
          ? <span className="pill ok" style={{ background: '#E7F3EC', color: '#0F6A4C' }}>Ready</span>
          : <span className="pill" style={{ background: '#FBF1DC', color: '#8A5A00' }}>
              {state.missing.length === 1 ? '1 thing still needed' : `${state.missing.length} things still needed`}
            </span>}
      </div>

      <div style={{ marginTop: 6, fontSize: 13.5, color: MUTED, lineHeight: 1.5 }}>
        This refinance pays off the loan already on the property. The closing attorney needs
        to know how much to pay, who to pay and which of their loans it is.
      </div>

      {err && <div role="alert" className="notice err" style={{ marginTop: 12, marginBottom: 0 }}>{err}</div>}
      {saved && !editing && <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>Payoff details saved.</div>}

      {/* PROPERTY OWNED FREE AND CLEAR (db/575) — the whole payoff step goes
          away: the payoff of record is $0 and both payoff conditions are
          waived. Reversible; every flip is confirmed and audited. */}
      {state.freeAndClear && !editing && (
        <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>
          <b>Property is free and clear.</b> There is no existing loan to pay off — the payoff of
          record is $0 and both payoff conditions are waived.
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setFreeAndClear(false)}>
              Turn off — there IS a loan to pay off
            </button>
          </div>
        </div>
      )}

      {!editing && !state.freeAndClear && (
        <>
          <div style={{ marginTop: 12 }}>
            <Row label="Payoff amount" value={e.payoffAmount != null ? usd(e.payoffAmount) : ''} missing={missingKeys.has('payoffAmount')} />
            <Row label="Lender being paid off" value={e.payoffLender} missing={missingKeys.has('payoffLender')} />
            <Row label="Their loan number" value={e.payoffLoanNumber} missing={missingKeys.has('payoffLoanNumber')} />
            <Row label="Payoff good through" value={e.payoffGoodThrough || ''} />
            {state.isCashOut && (
              <Row label="Cash out to the borrower">
                {d.cashOut != null
                  ? <>
                      {usd(d.cashOut)}{' '}
                      <span style={{ fontWeight: 400, fontSize: 13, color: MUTED }}>
                        {d.cashOutSource === 'typed' ? '(entered by hand)' : '(from the structure)'}
                      </span>
                    </>
                  : <span style={{ fontWeight: 400, fontSize: 14, color: MUTED }}>
                      Register the structure and enter the payoff, and this fills in.
                    </span>}
              </Row>
            )}
          </div>

          {/* THE WORKING, SHOWN. A cash figure nobody can check is a figure nobody
              trusts — and it is the number the borrower asks about first. */}
          {state.isCashOut && d.canDerive && (
            <div style={{ marginTop: 10, fontSize: 13, color: MUTED, lineHeight: 1.6 }}>
              From the structure: advance at closing {usd(d.initialAdvance != null ? d.initialAdvance : d.totalLoan)}
              {' '}− payoff {usd(e.payoffAmount || 0)} − closing costs {usd(d.closingCosts || 0)} = <b style={{ color: INK }}>{usd(d.structuralCashOut)}</b>.
              {d.initialAdvance != null && d.totalLoan != null && d.totalLoan > d.initialAdvance
                ? ' The rest of the loan is construction money, released later in draws — it is not cash at closing.'
                : ''}
            </div>
          )}

          {/* Advisory only — it changes nothing, it just says what it sees. */}
          {state.purposeNote && (
            <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
              {state.purposeNote.text} The structure leaves about {usd(state.purposeNote.amount)}.
            </div>
          )}

          {state.missing.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: '#8A5A00', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Still needed
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: INK, fontSize: 13.5, lineHeight: 1.55 }}>
                {state.missing.map((m) => <li key={m.key}><b>{m.label}</b> — {m.why}</li>)}
              </ul>
            </div>
          )}

          <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={startEdit}>
              {state.missing.length ? 'Enter the payoff details' : 'Edit the payoff details'}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setFreeAndClear(true)}>
              Property is free and clear…
            </button>
            <button type="button" className="btn ghost small" onClick={() => setHowOpen((v) => !v)} aria-expanded={howOpen}>
              {howOpen ? 'Hide how this works' : 'How does a payoff work?'}
            </button>
          </div>
        </>
      )}

      {editing && (
        <div style={{ marginTop: 12 }}>
          <div className="grid2" style={{ gap: 12 }}>
            <label className="field">
              <span>Payoff amount</span>
              <MoneyInput value={form.payoffAmount} onChange={(v) => setForm((f) => ({ ...f, payoffAmount: v }))} />
              <small style={{ color: MUTED }}>The balance to clear the existing loan, from their payoff letter.</small>
            </label>
            {state.isCashOut && (
              <label className="field">
                <span>Cash out to the borrower <em style={{ color: MUTED, fontWeight: 400 }}>(optional)</em></span>
                <MoneyInput value={form.estimatedCashOut}
                  onChange={(v) => setForm((f) => ({ ...f, estimatedCashOut: v }))}
                  placeholder={d.structuralCashOut != null ? String(Math.round(d.structuralCashOut)) : '0'} />
                <small style={{ color: MUTED }}>
                  {d.canDerive
                    ? <>Leave it blank and the structure fills it in ({usd(d.structuralCashOut)}). Type a number only to override it.</>
                    : <>Fills in from the structure once the file is registered.</>}
                </small>
              </label>
            )}
            <label className="field">
              <span>Lender being paid off</span>
              <input className="input" value={form.payoffLender} maxLength={200}
                onChange={(ev) => setForm((f) => ({ ...f, payoffLender: ev.target.value }))}
                placeholder="e.g. Chase, Kiavi, a private lender" />
              <small style={{ color: MUTED }}>Who holds the loan today — the payoff request goes to them.</small>
            </label>
            <label className="field">
              <span>Their loan number <em style={{ color: MUTED, fontWeight: 400 }}>(optional)</em></span>
              <input className="input" value={form.payoffLoanNumber} maxLength={200}
                onChange={(ev) => setForm((f) => ({ ...f, payoffLoanNumber: ev.target.value }))}
                placeholder="the number on their statement" />
              <small style={{ color: MUTED }}>A payoff wired without it sits unapplied.</small>
            </label>
            <label className="field">
              <span>Payoff good through <em style={{ color: MUTED, fontWeight: 400 }}>(optional)</em></span>
              <input className="input" type="date" value={form.payoffGoodThrough}
                onChange={(ev) => setForm((f) => ({ ...f, payoffGoodThrough: ev.target.value }))} />
              <small style={{ color: MUTED }}>The date the payoff quote is valid through, off the payoff letter.</small>
            </label>
          </div>
          <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save payoff details'}
            </button>
            <button type="button" className="btn ghost" onClick={() => { setEditing(false); setErr(''); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {howOpen && (
        <div style={{ marginTop: 12, padding: 12, background: '#FAF8F3', borderRadius: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            How a payoff works
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: INK, fontSize: 13.5, lineHeight: 1.6 }}>
            {(state.howItWorks || []).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
