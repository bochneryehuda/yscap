import React, { useEffect, useState, useCallback } from 'react';
import { api, saveBlob } from '../lib/api.js';
import TapeQuestionsModal from '../components/TapeQuestionsModal.jsx';

/* Data Tapes — the provider-centric export hub. Pick a capital provider, see
   every loan currently assigned to it (the tape can only carry loans set to that
   provider — the same rule as the per-file export), then export any single loan's
   tape or a bulk tape (all selected loans on one workbook). The provider's Excel
   workbook is preserved exactly; we only fill the data row(s). */

const money = (v) => (v == null || v === '' ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
const STATUS_LABEL = {
  new: 'New', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting',
  approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded',
  on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn',
};

export default function StaffTapes() {
  const [tapes, setTapes] = useState(null);
  const [active, setActive] = useState(null);   // tapeKey
  const [loans, setLoans] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [loadingLoans, setLoadingLoans] = useState(false);
  const [busyBulk, setBusyBulk] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const [pending, setPending] = useState(null); // { loanId, tapeName, questions } — questionnaire modal
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.staffTapesList().then((d) => {
      setTapes(d.tapes || []);
      if ((d.tapes || []).length) setActive(d.tapes[0].key);
    }).catch((e) => setErr(e.message || 'Could not load tape types'));
  }, []);

  const loadLoans = useCallback((tapeKey) => {
    if (!tapeKey) return;
    setLoadingLoans(true); setLoans(null); setSel(new Set()); setErr(''); setMsg('');
    api.staffTapeLoans(tapeKey)
      .then((d) => setLoans(d.loans || []))
      .catch((e) => { setLoans([]); setErr(e.message || 'Could not load loans'); })
      .finally(() => setLoadingLoans(false));
  }, []);
  useEffect(() => { loadLoans(active); }, [active, loadLoans]);

  const activeTape = (tapes || []).find((t) => t.key === active);

  function toggle(id) {
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSel((s) => (s.size === (loans || []).length ? new Set() : new Set((loans || []).map((l) => l.id))));
  }

  async function startRow(loanId, tapeName) {
    setBusyRow(loanId); setErr(''); setMsg('');
    try {
      const q = await api.staffTapeQuestions(loanId, active);
      const questions = (q && q.questions) || [];
      const seasoned = q && q.seasoned && q.seasoned.isSeasoned ? q.seasoned : null;
      if (questions.length || seasoned) { setPending({ loanId, tapeName, questions, seasoned }); setBusyRow(null); return; }
      await exportRow(loanId, tapeName, undefined);
    } catch (e) { setErr((e.data && e.data.message) || e.message || 'Export failed'); setBusyRow(null); }
  }
  async function exportRow(loanId, tapeName, answers) {
    setBusyRow(loanId); setErr(''); setMsg('');
    try {
      const { blob, filename } = await api.staffTapeExport(loanId, active, answers);
      saveBlob(blob, filename);
      setMsg(`Exported ${tapeName} tape.`);
      setPending(null);
    } catch (e) { setErr((e.data && e.data.message) || e.message || 'Export failed'); }
    finally { setBusyRow(null); }
  }

  async function exportBulk() {
    if (!sel.size) return;
    setBusyBulk(true); setErr(''); setMsg('');
    try {
      const { blob, filename } = await api.staffTapeBulkExport(active, Array.from(sel));
      saveBlob(blob, filename);
      setMsg(`Exported a bulk ${activeTape ? activeTape.name : ''} tape with ${sel.size} loan${sel.size === 1 ? '' : 's'}.`);
    } catch (e) { setErr((e.data && e.data.message) || e.message || 'Bulk export failed'); }
    finally { setBusyBulk(false); }
  }

  return (
    <div className="wrap">
      <div className="dd-wrap">
        <div className="dd-head">
          <div>
            <h1 className="dd-title">Data tapes</h1>
            <div className="dd-sub">
              Export a capital provider's loan tape — their Excel workbook, filled with the loan's figures so their pricing
              tab recalculates. A loan appears here only under the provider it's currently assigned to; switch a loan's
              capital provider on its file to move it.
            </div>
          </div>
        </div>

        {tapes == null ? <div className="panel">Loading…</div> : tapes.length === 0 ? (
          <div className="panel">No tape types are configured yet.</div>
        ) : (
          <>
            {/* provider picker */}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {tapes.map((t) => (
                <button key={t.key} className={`btn ${active === t.key ? 'primary' : 'ghost'}`} onClick={() => setActive(t.key)}>
                  {t.name}
                </button>
              ))}
            </div>

            {err && <div className="panel" style={{ borderColor: 'var(--danger, #b3261e)', marginBottom: 10 }}>{err}</div>}
            {msg && <div className="panel" style={{ borderColor: 'var(--teal)', marginBottom: 10 }}>{msg}</div>}

            <div className="panel">
              <div className="row" style={{ alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
                <h3 style={{ margin: 0 }}>{activeTape ? activeTape.name : ''} — {loans ? loans.length : 0} loan{(loans && loans.length === 1) ? '' : 's'}</h3>
                <div className="spacer" />
                <span className="muted small">{sel.size} selected</span>
                <button className="btn primary" onClick={exportBulk} disabled={!sel.size || busyBulk}>
                  {busyBulk ? 'Building…' : `Export bulk tape (${sel.size})`}
                </button>
              </div>

              {loadingLoans || loans == null ? <p className="muted small">Loading loans…</p> : loans.length === 0 ? (
                <p className="muted small">
                  No loans are currently assigned to {activeTape ? activeTape.fullName : 'this provider'}. Set a loan's capital
                  provider to {activeTape ? activeTape.name : 'this provider'} on its file to export its tape.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line, #ddd)' }}>
                        <th style={{ padding: '6px 8px' }}>
                          <input type="checkbox"
                            ref={(el) => { if (el) el.indeterminate = sel.size > 0 && sel.size < loans.length; }}
                            checked={loans.length > 0 && sel.size === loans.length} onChange={toggleAll} aria-label="Select all" />
                        </th>
                        <th style={{ padding: '6px 8px' }}>Loan #</th>
                        <th style={{ padding: '6px 8px' }}>Property</th>
                        <th style={{ padding: '6px 8px' }}>Status</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right' }}>Loan amount</th>
                        <th style={{ padding: '6px 8px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {loans.map((l) => (
                        <tr key={l.id} style={{ borderBottom: '1px solid var(--line, #eee)' }}>
                          <td style={{ padding: '6px 8px' }}>
                            <input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.ys_loan_number || l.id}`} />
                          </td>
                          <td style={{ padding: '6px 8px' }}>{l.investor_loan_number || l.ys_loan_number || '—'}</td>
                          <td style={{ padding: '6px 8px' }}>{l.address || '—'}</td>
                          <td style={{ padding: '6px 8px' }}>{STATUS_LABEL[l.status] || l.status || '—'}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{money(l.loan_amount)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                            <button className="btn small ghost" disabled={busyRow === l.id} onClick={() => startRow(l.id, activeTape ? activeTape.name : 'tape')}>
                              {busyRow === l.id ? 'Building…' : 'Export'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {pending && (
        <TapeQuestionsModal
          title={pending.questions.length ? `${activeTape ? activeTape.name : ''} tape — a few details` : `${activeTape ? activeTape.name : ''} tape — confirm current numbers`}
          subtitle={pending.questions.length ? "This is a ground-up loan. Fill these in and they'll be saved on the file, so we won't ask again." : undefined}
          questions={pending.questions}
          seasoned={pending.seasoned}
          busy={busyRow === pending.loanId}
          onCancel={() => setPending(null)}
          onSubmit={(answers) => exportRow(pending.loanId, pending.tapeName, answers)}
        />
      )}
    </div>
  );
}
