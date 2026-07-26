import React, { useState } from 'react';

/* A short questionnaire shown before a tape export when the loan needs extra
   details that aren't in the system yet — chiefly the New-Construction-only
   Fidelis fields. Each question renders as a dropdown (when it has options), a
   number, or a date. Whatever the user fills is saved on the loan and used to
   fill the tape; a later export won't ask again. */
export default function TapeQuestionsModal({ title, subtitle, questions, busy, onCancel, onSubmit }) {
  const [answers, setAnswers] = useState(() => {
    const init = {};
    for (const q of questions || []) if (q.current != null && q.current !== '') init[q.key] = String(q.current);
    return init;
  });
  const set = (k, v) => setAnswers((a) => ({ ...a, [k]: v }));

  function submit(e) {
    e.preventDefault();
    // Send only the fields that were actually filled in.
    const clean = {};
    for (const q of questions || []) {
      const v = answers[q.key];
      if (v != null && String(v).trim() !== '') clean[q.key] = String(v).trim();
    }
    onSubmit(clean);
  }

  return (
    <div onClick={busy ? undefined : onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="panel" style={{ width: 'min(520px, 96vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--paper, #fff)' }}>
        <h3 style={{ marginTop: 0 }}>{title || 'A few more details'}</h3>
        {subtitle && <p className="muted small" style={{ marginTop: -4 }}>{subtitle}</p>}
        <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
          {(questions || []).map((q) => (
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
          ))}
        </div>
        <div className="row" style={{ marginTop: 16, gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Exporting…' : 'Save & export'}</button>
        </div>
      </form>
    </div>
  );
}
