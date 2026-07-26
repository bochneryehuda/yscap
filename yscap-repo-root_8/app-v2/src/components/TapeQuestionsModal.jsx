import React, { useState } from 'react';

/* A short questionnaire shown before a tape export. It handles two things:

   1. New-Construction-only fields that aren't in the system yet (dropdowns /
      number / date). Whatever the user fills is saved on the loan and used to
      fill the tape; a later export won't ask again.

   2. A SEASONED-loan confirmation. When a loan is already funded and being sold
      later, the tape must show the CURRENT picture (current balance, interest
      reserve left, next payment due). We pre-fill what we worked out from the
      released draws + interest used and ask the staffer to confirm or correct it
      before the file goes out. These confirmed values apply to this export only.

   Both sets of answers are sent together; the server sorts out which is which. */
function money(v) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

export default function TapeQuestionsModal({ title, subtitle, questions, seasoned, busy, onCancel, onSubmit }) {
  const seasonedFields = (seasoned && seasoned.fields) || [];
  const allFields = [...(questions || []), ...seasonedFields];
  const [answers, setAnswers] = useState(() => {
    const init = {};
    for (const q of allFields) if (q.current != null && q.current !== '') init[q.key] = String(q.current);
    return init;
  });
  const set = (k, v) => setAnswers((a) => ({ ...a, [k]: v }));

  function submit(e) {
    e.preventDefault();
    // Send every field that has a value (the seasoned fields are pre-filled, so
    // confirming without changes still sends the confirmed numbers).
    const clean = {};
    for (const q of allFields) {
      const v = answers[q.key];
      if (v != null && String(v).trim() !== '') clean[q.key] = String(v).trim();
    }
    onSubmit(clean);
  }

  const field = (q) => (
    <label key={q.key} style={{ display: 'grid', gap: 4 }}>
      <span className="small" style={{ fontWeight: 600 }}>{q.label}</span>
      {q.type === 'select' && Array.isArray(q.options) ? (
        <select className="input" value={answers[q.key] || ''} onChange={(e) => set(q.key, e.target.value)}>
          <option value="">— select —</option>
          {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : q.type === 'number' ? (
        <input className="input" type="number" inputMode="decimal" value={answers[q.key] || ''} onChange={(e) => set(q.key, e.target.value)} placeholder="0" />
      ) : q.type === 'date' ? (
        <input className="input" type="date" value={answers[q.key] || ''} onChange={(e) => set(q.key, e.target.value)} />
      ) : (
        <input className="input" type="text" value={answers[q.key] || ''} onChange={(e) => set(q.key, e.target.value)} />
      )}
    </label>
  );

  const bd = (seasoned && seasoned.breakdown) || null;

  return (
    <div onClick={busy ? undefined : onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="panel" style={{ width: 'min(540px, 96vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--paper, #fff)' }}>
        <h3 style={{ marginTop: 0 }}>{title || 'A few more details'}</h3>
        {subtitle && <p className="muted small" style={{ marginTop: -4 }}>{subtitle}</p>}

        {(questions || []).length > 0 && (
          <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
            {(questions || []).map(field)}
          </div>
        )}

        {seasoned && seasonedFields.length > 0 && (
          <div style={{ marginTop: (questions || []).length ? 18 : 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Confirm this loan’s current numbers</div>
            <p className="muted small" style={{ marginTop: 0 }}>
              This loan has already been funded and is partway along, so the tape should show where it stands
              today{seasoned.asOf ? <> (as of <strong>{seasoned.asOf}</strong>)</> : null}. We worked these out from the
              draws released and the interest used — please check them and adjust anything that isn’t right before exporting.
            </p>
            {bd && (
              <div className="small muted" style={{ background: 'rgba(47,127,134,.07)', border: '1px solid rgba(47,127,134,.18)', borderRadius: 8, padding: '8px 10px', margin: '6px 0 12px', display: 'grid', gap: 2 }}>
                <div>Day-1 advance: <strong>{money(bd.day1)}</strong></div>
                <div>Rehab draws released so far: <strong>{money(bd.releasedDraws)}</strong></div>
                {Number(bd.financedReserve) > 0 && <div>Interest reserve used so far: <strong>{money(bd.reserveUsed)}</strong> of {money(bd.financedReserve)} <span style={{ opacity: .7 }}>(estimated{bd.accrual === 'dutch' ? ', Dutch' : ', as-drawn'})</span></div>}
              </div>
            )}
            <div style={{ display: 'grid', gap: 12 }}>
              {seasonedFields.map(field)}
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: 16, gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Exporting…' : (seasoned ? 'Confirm & export' : 'Save & export')}</button>
        </div>
      </form>
    </div>
  );
}
