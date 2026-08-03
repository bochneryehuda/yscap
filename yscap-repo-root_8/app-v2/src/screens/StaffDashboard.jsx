import React from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import DashboardCard from '../components/DashboardCard.jsx';
import DashboardCardEditor from '../components/DashboardCardEditor.jsx';

/**
 * One dashboard: the hero row, the cards below it, and — for a dashboard you own — the
 * editor.
 *
 * A COMPANY DASHBOARD IS NEVER EDITED IN PLACE. The button reads "Make it mine", which
 * forks it to you. That is what keeps "reset to the company default" permanently available
 * and stops one person's change altering what a colleague sees.
 *
 * Cards load in ONE call and each carries its own ok/error, so a single bad card renders
 * as "couldn't load this one" beside eleven live ones instead of blanking the page.
 *
 * Every hook sits above every early return — the repo-wide hook-order guard
 * (scripts/test-react-hook-order.js) is the only automated defence here, since there is no
 * eslint config in this project.
 */

const INK = '#141B22';
const MUTED = '#4B585C';

export default function StaffDashboard() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [dash, setDash] = React.useState(null);
  const [answers, setAnswers] = React.useState(null);
  const [canEdit, setCanEdit] = React.useState(false);
  const [meta, setMeta] = React.useState(null);
  const [editing, setEditing] = React.useState(null);   // card object | 'new' | null
  const [drill, setDrill] = React.useState(null);       // { card, files } | null
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setErr('');
    try {
      const d = id === 'home' ? await api.dashboardHome() : await api.dashboard(id);
      if (seq.current !== mine) return;
      if (!d || !d.dashboard) { setDash(false); return; }
      setDash(d.dashboard);
      setCanEdit(!!d.canEdit);
      const a = await api.dashboardAnswers(d.dashboard.id);
      if (seq.current !== mine) return;
      setAnswers((a && a.answers) || []);
    } catch (e) {
      if (seq.current === mine) { setDash(false); setErr(e.message || 'Could not open that dashboard'); }
    }
  }, [id]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { api.dashboardMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  React.useEffect(() => { if (params.get('edit') === '1' && canEdit) setEditing('new'); }, [params, canEdit]);

  async function makeMine() {
    setBusy(true);
    try {
      const r = await api.dashboardFork(dash.id, {});
      nav(`/internal/dashboards/${r.dashboard.id}`);
    } catch (e) { setErr(e.message || 'Could not copy that'); } finally { setBusy(false); }
  }

  async function saveCard(body) {
    if (editing === 'new') await api.dashboardAddCard(dash.id, body);
    else await api.dashboardSaveCard(dash.id, editing.id, body);
    setEditing(null);
    if (params.get('edit')) { params.delete('edit'); setParams(params); }
    await load();
  }

  async function dropCard() {
    if (editing === 'new' || !editing) { setEditing(null); return; }
    if (!window.confirm(`Remove "${editing.title}" from this dashboard?`)) return;
    await api.dashboardDropCard(dash.id, editing.id);
    setEditing(null);
    await load();
  }

  /**
   * `pick` is the bar the person clicked — the card hands back the same bucket it drew, and
   * we send its label straight to the server, which re-applies it to the very same query
   * that produced the number. Clicking August must list August; before this the argument was
   * dropped on the floor and every bar opened the whole period, under a subtitle promising
   * "exactly the ones this number counted" and a card subtitled "click any month".
   */
  async function openFiles(answer, pick) {
    const bucket = (pick && pick.key) || null;
    try {
      const r = await api.dashboardCardFiles(answer.id, { limit: 200, ...(bucket ? { bucket } : {}) });
      setDrill({ title: answer.title, bucket, files: (r && r.files) || [] });
    } catch (e) { setErr(e.message || 'Could not list those files'); }
  }

  // ---- early returns, all AFTER every hook ----
  if (dash === false) {
    return (
      <div>
        <div className="page-head"><h1 style={{ color: INK }}>Dashboard</h1></div>
        <div className="notice err">{err || 'That dashboard is not there.'}</div>
        <Link className="btn ghost" to="/internal/dashboards" style={{ marginTop: 10 }}>Back to dashboards</Link>
      </div>
    );
  }
  if (!dash) return <div className="panel"><p className="muted small">Loading…</p></div>;

  const list = answers || [];
  const hero = list.filter((a) => a.band === 'hero');
  const body = list.filter((a) => a.band !== 'hero');
  const cardOf = (a) => (dash.cards || []).find((c) => c.id === a.id) || null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ color: INK }}>{dash.name}</h1>
          {dash.description && <div className="sub" style={{ color: MUTED }}>{dash.description}</div>}
        </div>
        <div className="page-head-actions">
          <Link className="btn ghost small" to="/internal/dashboards">All dashboards</Link>
          {canEdit
            ? <button className="btn primary" onClick={() => setEditing('new')}>+ Add a card</button>
            : <button className="btn primary" onClick={makeMine} disabled={busy}>
              {busy ? 'Copying…' : 'Make it mine'}
            </button>}
        </div>
      </div>

      {!canEdit && dash.is_system && (
        <div className="notice info small">
          This is the company dashboard. Choose <b>Make it mine</b> to get your own copy you can
          change — the company one stays exactly as it is for everyone else.
        </div>
      )}
      {err && <div className="notice err">{err}</div>}

      {editing && meta && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ color: INK, marginTop: 0 }}>{editing === 'new' ? 'A new card' : `Change “${editing.title}”`}</h3>
          <DashboardCardEditor
            meta={meta}
            card={editing === 'new' ? null : editing}
            onSave={saveCard}
            onCancel={() => { setEditing(null); if (params.get('edit')) { params.delete('edit'); setParams(params); } }}
            onDelete={editing === 'new' ? null : dropCard}
          />
        </div>
      )}

      {answers == null ? <div className="panel"><p className="muted small">Working out your numbers…</p></div> : (
        <>
          {hero.length > 0 && (
            <div className="dsh-heroes">
              {hero.map((a) => (
                <DashboardCard key={a.id} answer={a} editable={canEdit}
                  onDrill={a.ok && !a.series ? (pick) => openFiles(a, pick) : null}
                  onEdit={() => setEditing(cardOf(a) || 'new')} />
              ))}
            </div>
          )}
          <div className="dsh-body">
            {body.map((a) => (
              <div key={a.id} className={`dsh-slot dsh-w-${a.width || 'one'}`}>
                <DashboardCard answer={a} editable={canEdit}
                  onDrill={a.ok ? (pick) => openFiles(a, pick) : null}
                  onEdit={() => setEditing(cardOf(a) || 'new')} />
              </div>
            ))}
          </div>
          {list.length === 0 && (
            <div className="panel">
              <p className="muted small" style={{ margin: 0 }}>
                No cards on this dashboard yet.{canEdit ? ' Add one above.' : ''}
              </p>
            </div>
          )}
        </>
      )}

      {drill && (
        <div className="cv-modal-back" onClick={() => setDrill(null)}>
          <div className="cv-modal" style={{ maxWidth: 900, width: '94%' }} role="dialog" aria-modal="true"
            aria-label={`Files behind ${drill.title}`} onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3 style={{ margin: 0, color: INK }}>
                {drill.title}{drill.bucket ? ` · ${drill.bucket}` : ''}
              </h3>
              <span className="spacer" />
              <button className="btn ghost small" onClick={() => setDrill(null)}>Close</button>
            </div>
            <p className="small" style={{ color: MUTED }}>
              {drill.files.length} file{drill.files.length === 1 ? '' : 's'} — exactly the files this
              number was worked out from.
            </p>
            <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
              <table className="table" style={{ minWidth: 720 }}>
                <thead><tr><th>Loan #</th><th>Property</th><th>Status</th><th>Amount</th><th>Officer</th></tr></thead>
                <tbody>
                  {drill.files.map((f) => (
                    <tr key={f.id}>
                      <td><Link to={`/internal/app/${f.id}`}>{f.ys_loan_number || 'Pending'}</Link></td>
                      <td>{(f.property_address && (f.property_address.oneLine
                        || [f.property_address.line1, f.property_address.city, f.property_address.state].filter(Boolean).join(', '))) || '—'}</td>
                      <td>{String(f.status || '').replace(/_/g, ' ')}</td>
                      <td className="num">{f.loan_amount == null ? '—' : '$' + Number(f.loan_amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                      <td>{f.loan_officer || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
