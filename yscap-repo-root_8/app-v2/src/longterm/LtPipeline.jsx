import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

const money = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));

const day = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US') : '—';
};

/**
 * A loan's lock, in one cell.
 *
 * The countdown is to the date ENCOMPASS STATED and is never calculated from a lock
 * date plus a day count — an extension moves the expiration without moving the lock
 * date, so a calculated number would show a desk an expiry that has not happened.
 * `lock_days_remaining` comes from the server for exactly that reason.
 *
 * A loan with no lock mirrored reads as a plain dash. "No lock" and "we have not
 * looked yet" are different, and this column may only claim the first when the loan
 * itself says so — the file's own lock section is where that distinction is spelled
 * out, because a pipeline cell has no room for a sentence.
 */
function LockCell({ row }) {
  if (!row.lock_status && row.lock_expiration_date == null) {
    return <span style={{ color: '#4B585C' }}>—</span>;
  }
  const left = row.lock_days_remaining == null ? null : Number(row.lock_days_remaining);
  const tone = left == null ? '#4B585C' : left < 0 ? '#8A2D2D' : left <= 7 ? '#8A6A22' : '#1F5F3F';
  return (
    <span style={{ color: tone, whiteSpace: 'nowrap' }}>
      {row.lock_status || 'Lock'}
      {left != null && (
        <span style={{ marginLeft: 6, fontSize: 12 }}>
          {left < 0 ? `expired ${Math.abs(left)}d ago` : left === 0 ? 'expires today' : `${left}d left`}
        </span>
      )}
    </span>
  );
}

/**
 * The long-term pipeline.
 *
 * Every row here is one the server's SCOPE already allowed — this screen does no
 * filtering of its own, so what you see is exactly what you may open.
 *
 * IT EXPLAINS AN EMPTY LIST. "You have no long-term files" and "nobody has linked
 * your Encompass account yet" look identical, and the second is the state every
 * officer is in until an admin confirms their link — so the server sends the reason
 * and this shows it rather than an empty table.
 *
 * Colours are explicit darks: every `--ink*` token in this palette is a LIGHT paper
 * colour and would render white-on-white.
 */
export default function LtPipeline() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const nav = useNavigate();

  const load = useCallback(() => {
    setErr(null);
    ltApi.pipeline({ search: search.trim(), stage })
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not load the long-term pipeline.'));
  }, [search, stage]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap' };
  const td = { padding: '10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7' };

  return (
    <LtLayout title="Long-term pipeline">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input className="input" placeholder="Search a loan number or borrower" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
        <select className="input" value={stage} onChange={(e) => setStage(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">Every stage</option>
          {(data && data.stages ? data.stages : []).map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        {data && <span style={{ alignSelf: 'center', fontSize: 13, color: '#4B585C' }}>
          {data.total} file{data.total === 1 ? '' : 's'}
        </span>}
      </div>

      {err && <div className="card" style={{ color: '#141B22' }}>{err}</div>}

      {data && !data.loans.length && (
        <div className="card" style={{ color: '#141B22' }}>
          {data.emptyReason
            || 'No long-term files yet. They appear here once the sync has brought them in from Encompass.'}
        </div>
      )}

      {data && data.loans.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead><tr>
              <th style={th}>Loan #</th><th style={th}>Borrower</th><th style={th}>Amount</th>
              <th style={th}>Stage</th><th style={th}>Milestone</th>
              <th style={th}>Loan officer</th><th style={th}>Lock</th><th style={th}>Updated</th>
            </tr></thead>
            <tbody>
              {data.loans.map((l) => {
                const officer = (l.contacts || []).find((c) => c.role === 'loan_officer');
                return (
                  <tr key={l.id} style={{ cursor: 'pointer' }}
                    onClick={() => nav(`/internal/lt/loan/${l.id}`)}>
                    <td style={{ ...td, fontWeight: 600 }}>{l.loan_number || '—'}</td>
                    <td style={td}>{l.borrower_name || '—'}</td>
                    <td style={td}>{money(l.loan_amount)}</td>
                    <td style={td}>{l.stage_key || '—'}</td>
                    <td style={td}>{l.milestone_name || '—'}</td>
                    <td style={td}>
                      {officer ? (officer.name || '—') : '—'}
                      {officer && officer.overridden && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: '#AE8746' }}>reassigned</span>
                      )}
                    </td>
                    <td style={td}><LockCell row={l} /></td>
                    <td style={td}>{day(l.encompass_last_modified)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </LtLayout>
  );
}
