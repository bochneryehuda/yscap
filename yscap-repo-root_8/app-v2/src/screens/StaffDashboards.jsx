import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/**
 * The Dashboards index — your dashboards, the company ones, and a button to make a new one.
 *
 * Every hook is above every early return (scripts/test-react-hook-order.js enforces this
 * repo-wide; a hook after a conditional return changes the hook COUNT between renders and
 * React tears the whole page down).
 */

const INK = '#141B22';
const MUTED = '#4B585C';

export default function StaffDashboards() {
  const [rows, setRows] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    api.dashboards()
      .then((r) => setRows((r && r.dashboards) || []))
      .catch((e) => { setRows([]); setErr(e.message || 'Could not load your dashboards'); });
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function makeNew() {
    setBusy(true);
    try {
      const r = await api.dashboardCreate({ name: 'New dashboard' });
      window.location.hash = `#/internal/dashboards/${r.dashboard.id}?edit=1`;
    } catch (e) { setErr(e.message || 'Could not create that'); } finally { setBusy(false); }
  }

  const mine = (rows || []).filter((d) => d.is_mine);
  const company = (rows || []).filter((d) => !d.is_mine);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ color: INK }}>Dashboards</h1>
          <div className="sub" style={{ color: MUTED }}>
            Your numbers, and the ones the company ships. Open any card to see exactly which files it counts.
          </div>
        </div>
        <div className="page-head-actions">
          <Link className="btn ghost" to="/internal/dashboards/home">My dashboard</Link>
          <button className="btn primary" onClick={makeNew} disabled={busy}>+ New dashboard</button>
        </div>
      </div>

      {err && <div className="notice err">{err}</div>}

      {rows == null ? <div className="panel"><p className="muted small">Loading…</p></div> : (
        <>
          <h3 style={{ color: INK, marginTop: 4 }}>Mine</h3>
          {mine.length === 0 ? (
            <div className="panel">
              <p className="muted small" style={{ margin: 0 }}>
                You haven&apos;t built one yet. Open a company dashboard below and choose
                &ldquo;Make it mine&rdquo; to start from it, or create a blank one.
              </p>
            </div>
          ) : (
            <div className="grid cols-3">{mine.map((d) => <Tile key={d.id} d={d} />)}</div>
          )}

          <h3 style={{ color: INK, marginTop: 22 }}>From the company</h3>
          <div className="grid cols-3">{company.map((d) => <Tile key={d.id} d={d} />)}</div>
        </>
      )}
    </div>
  );
}

function Tile({ d }) {
  return (
    // `.dsh-tile-h` rather than the shared `.row`: `.row` lets a long name push the
    // "Company" chip onto a second line, which made that one tile taller than the rest of
    // its row. The chip is now `flex:none` beside a name that wraps under itself.
    <Link className="panel dsh-tile" to={`/internal/dashboards/${d.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="dsh-tile-h">
        <b>{d.name}</b>
        <span className="spacer" />
        {d.is_system && <span className="pill" style={{ flex: 'none' }}
          title="Ships with PILOT — open it and make it yours to change">Company</span>}
      </div>
      {d.description && <p className="small dsh-tile-d">{d.description}</p>}
      <div className="small dsh-tile-m">
        {d.card_count} card{d.card_count === 1 ? '' : 's'}
        {d.role_default ? ` · the default for ${String(d.role_default).replace(/_/g, ' ')}` : ''}
      </div>
    </Link>
  );
}
