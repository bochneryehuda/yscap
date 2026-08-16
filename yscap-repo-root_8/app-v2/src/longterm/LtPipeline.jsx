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
  const [views, setViews] = useState(null);
  const [activeView, setActiveView] = useState('');
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
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

  // The saved views, and the one this person opens on. A view only ever sets the
  // filters below — the server decides what those filters may reach.
  useEffect(() => {
    let alive = true;
    ltApi.views().then((v) => {
      if (!alive) return;
      setViews(v);
      const first = (v.views || []).find((x) => x.isDefault);
      if (first) { applyView(first); setActiveView(first.id); }
    }).catch(() => { if (alive) setViews({ views: [], canShare: false }); });
    return () => { alive = false; };
    // Runs once: re-applying a default while somebody is typing would fight them.
  }, []);

  const applyView = (v) => {
    const f = (v && v.filters) || {};
    setSearch(f.search || '');
    setStage(f.stage || '');
  };

  const reloadViews = () => ltApi.views().then(setViews).catch(() => {});

  // The name is typed INLINE rather than in a dialog. Long-Term may not import RTL's
  // dialog helper (the separation gate refuses it, and rightly — this side starts at
  // zero), and a browser prompt() is banned across this app because it stamps the
  // hosting hostname on the box. An input on the row is better than either.
  const saveCurrent = async (shared) => {
    const name = (viewName || '').trim();
    if (!name) return;
    const out = await ltApi.saveView({ name, filters: { search: search.trim(), stage }, shared })
      .catch((e) => ({ error: (e && e.message) || 'Could not save that view.' }));
    if (out && out.error) { setErr(out.error); return; }
    setViewName('');
    setNaming(false);
    await reloadViews();
    if (out && out.id) setActiveView(out.id);
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap' };
  const td = { padding: '10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7' };

  return (
    <LtLayout title="Long-term pipeline">
      {/* Saved views. A shared one is marked as somebody else's, and the control to
          make one is only offered to the people the server says may. */}
      {views && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          {(views.views || []).length > 0 && (
            <select className="input" style={{ maxWidth: 260 }} value={activeView}
              onChange={(e) => {
                const v = (views.views || []).find((x) => x.id === e.target.value);
                setActiveView(e.target.value);
                setConfirmRemove(false);
                if (v) applyView(v);
              }}>
              <option value="">No saved view</option>
              {(views.views || []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.shared ? ' (shared)' : ''}</option>
              ))}
            </select>
          )}

          {naming ? (
            <>
              <input className="input" style={{ maxWidth: 220 }} autoFocus placeholder="Name this view"
                value={viewName} onChange={(e) => setViewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCurrent(false); if (e.key === 'Escape') setNaming(false); }} />
              <button type="button" className="btn primary" style={{ padding: '4px 12px', fontSize: 13 }}
                disabled={!viewName.trim()} onClick={() => saveCurrent(false)}>Save for me</button>
              {views.canShare && (
                <button type="button" className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
                  disabled={!viewName.trim()} onClick={() => saveCurrent(true)}>Save for everybody</button>
              )}
              <button type="button" className="btn ghost" style={{ padding: '4px 10px', fontSize: 13 }}
                onClick={() => { setNaming(false); setViewName(''); }}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
              onClick={() => setNaming(true)}>Save this view</button>
          )}

          {/* Removing asks once, on the button itself. Two clicks beats a dialog this
              side is not allowed to import — and beats none at all. */}
          {activeView && (views.views || []).some((v) => v.id === activeView && v.mine) && (
            <button type="button" className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 13, color: confirmRemove ? '#8A2D2D' : undefined }}
              onClick={async () => {
                if (!confirmRemove) { setConfirmRemove(true); return; }
                await ltApi.deleteView(activeView).catch(() => {});
                setActiveView('');
                setConfirmRemove(false);
                reloadViews();
              }}>{confirmRemove ? 'Really remove it?' : 'Remove'}</button>
          )}
        </div>
      )}

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
