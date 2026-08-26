import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

/**
 * EVERY REQUEST TO DEVIATE, IN ONE LIST — the screen the owner asked for.
 *
 * Owner-directed 2026-08-26: *"There are too many separate sections, and it is
 * very hard to keep track of it … merge everything into one place with filters
 * for exceptions … You should be able to see all exceptions and search by loan
 * number, by address, or by anything. All exceptions at that address should
 * come up, and you should be able to filter by statuses."*
 *
 * IT FINDS; IT DOES NOT DECIDE. Each queue's decide route carries rules that
 * took a long time to get right — requester≠approver with a super-admin
 * exemption, per-queue permissions, counter-offers. So a row here links to the
 * place its decision already lives. Re-implementing three approval flows behind
 * one button is how a careful rule quietly stops applying.
 */

const STATE_LABEL = {
  open: 'Waiting', approved: 'Approved', denied: 'Denied',
  withdrawn: 'Withdrawn', settled: 'Closed',
};
// Explicit darks on the white canvas — an --ink* token is a LIGHT paper colour
// in this palette and renders white-on-white.
const INK = '#141B22';
const MUTED = '#4B585C';
const STATE_TONE = {
  open: { bg: '#FDF6E7', bd: '#AE8746', fg: '#6B4E12' },
  approved: { bg: '#EDF6EF', bd: '#2E7D4F', fg: '#1E5636' },
  denied: { bg: '#FBEDED', bd: '#A33A3A', fg: '#7A2626' },
  withdrawn: { bg: '#F2F2F0', bd: '#8A8F92', fg: '#4B585C' },
  settled: { bg: '#EEF3F4', bd: '#2F7F86', fg: '#245F65' },
};

function addressOf(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.oneLine || [a.line1 || a.street, a.city, a.state].filter(Boolean).join(', ');
}
const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

function Pill({ state }) {
  const t = STATE_TONE[state] || STATE_TONE.settled;
  return (
    <span style={{ background: t.bg, border: `1px solid ${t.bd}`, color: t.fg,
      borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {STATE_LABEL[state] || state}
    </span>
  );
}

export default function StaffAllExceptions() {
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ withheld: [], failed: [], sourceLabels: {}, hasMore: false });
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [source, setSource] = useState('');
  /* An old "?tab=mine" bookmark opened a tab that was this list narrowed to the
     viewer. The tab is gone; its MEANING is not, so such a link arrives with the
     filter already on rather than landing on an unfiltered list. */
  const [mine, setMine] = useState(() => {
    try { return new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab') === 'mine'; }
    catch (_) { return false; }
  });

  // 300ms after the last keystroke, not on every one — this list joins across
  // three stores and a per-letter request would queue them behind each other.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    setBusy(true); setErr('');
    api.exceptionFeed({ q: q || undefined, state: state || undefined, source: source || undefined, mine: mine ? 1 : undefined })
      .then((d) => {
        if (!live) return;
        setRows(d.rows || []);
        setMeta({ withheld: d.withheld || [], failed: d.failed || [], sourceLabels: d.sourceLabels || {}, hasMore: !!d.hasMore });
      })
      .catch((e) => { if (live) setErr(e.message || 'Could not load the list.'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [q, state, source, mine]);

  const byState = useMemo(() => {
    const c = { open: 0, approved: 0, denied: 0, withdrawn: 0, settled: 0 };
    for (const r of rows) if (c[r.state] != null) c[r.state] += 1;
    return c;
  }, [rows]);

  const anyFilter = q || state || source || mine;

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input className="input" type="search" style={{ minWidth: 260, maxWidth: 360 }}
          placeholder="Search loan number, address or borrower…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ maxWidth: 180 }} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Any status</option>
          {Object.keys(STATE_LABEL).map((k) => <option key={k} value={k}>{STATE_LABEL[k]}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 210 }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Every kind</option>
          {Object.keys(meta.sourceLabels).map((k) => <option key={k} value={k}>{meta.sourceLabels[k]}</option>)}
        </select>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: INK, fontSize: 14 }}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Raised by me
        </label>
        {anyFilter && (
          <button className="btn small ghost" onClick={() => { setSearch(''); setQ(''); setState(''); setSource(''); setMine(false); }}>
            Clear filters
          </button>
        )}
      </div>

      {/* A queue this person may not see is NAMED, never just absent — an empty
          list would otherwise read as "there is nothing", which is exactly the
          being-missed problem this screen replaces. */}
      {meta.withheld.length > 0 && (
        <div className="muted small" style={{ color: MUTED, marginBottom: 8 }}>
          You do not have access to {meta.withheld.map((k) => meta.sourceLabels[k] || k).join(' or ')} — those are not counted here.
        </div>
      )}
      {meta.failed.length > 0 && (
        <div className="small" style={{ color: '#7A2626', marginBottom: 8 }}>
          {meta.failed.map((f) => `${meta.sourceLabels[f.source] || f.source} could not be read`).join('; ')} — this list is incomplete. Try again.
        </div>
      )}

      {!busy && !err && (
        <div className="muted small" style={{ color: MUTED, marginBottom: 8 }}>
          {rows.length === 0
            ? (anyFilter ? 'Nothing matches these filters.' : 'No requests yet.')
            : <>
                {meta.hasMore ? `The first ${rows.length}; narrow the search to see the rest` : `${rows.length} request${rows.length === 1 ? '' : 's'}`}
                {' · '}
                {Object.keys(byState).filter((k) => byState[k]).map((k) => `${byState[k]} ${STATE_LABEL[k].toLowerCase()}`).join(' · ')}
              </>}
        </div>
      )}

      {err && <div className="small" style={{ color: '#7A2626' }}>{err}</div>}
      {busy && <div className="muted small" style={{ color: MUTED }}>Loading…</div>}

      {!busy && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', color: INK }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Status</th>
                <th style={{ textAlign: 'left' }}>Kind</th>
                <th style={{ textAlign: 'left' }}>What was asked</th>
                <th style={{ textAlign: 'left' }}>File</th>
                <th style={{ textAlign: 'left' }}>Raised</th>
                <th style={{ textAlign: 'left' }}>Decided</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.source}:${r.id}`}>
                  <td><Pill state={r.state} />
                    {r.status && r.status !== r.state && (
                      <div className="small" style={{ color: MUTED }}>{String(r.status).replace(/_/g, ' ')}</div>
                    )}
                  </td>
                  <td style={{ color: INK }}>
                    {r.source_label}
                    {r.ref && <div className="small" style={{ color: MUTED }}>{r.ref}</div>}
                  </td>
                  <td style={{ color: INK }}>
                    {String(r.type_key || '').replace(/_/g, ' ')}
                    {r.reason && <div className="small" style={{ color: MUTED }}>{r.reason}</div>}
                  </td>
                  <td>
                    {r.application_id ? (
                      <button className="btn link" style={{ padding: 0, textAlign: 'left' }}
                        onClick={() => nav(`/internal/app/${r.application_id}`)}>
                        {r.ys_loan_number || 'Open the file'}
                      </button>
                    ) : <span style={{ color: MUTED }}>—</span>}
                    <div className="small" style={{ color: MUTED }}>
                      {[addressOf(r.property_address), r.borrower_name].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td style={{ color: INK }}>
                    {when(r.requested_at)}
                    <div className="small" style={{ color: MUTED }}>{r.requested_by_name || '—'}</div>
                  </td>
                  <td style={{ color: INK }}>
                    {r.decided_at ? when(r.decided_at) : <span style={{ color: MUTED }}>—</span>}
                    <div className="small" style={{ color: MUTED }}>{r.decided_by_name || ''}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
