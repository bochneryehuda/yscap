import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* ClickUp Control Center (admin / platform_setup).
   Lets an admin validate and drive the ClickUp ⇄ portal sync without a
   developer, on top of /api/admin/clickup:
     - Health: connection, switch state, per-state file counts, queue/inbox.
     - Dry-run: read-only validation of the mapping against real ClickUp tasks
       (no writes) — the safe first step before enabling anything.
     - Backfill: build the borrower identity graph (data) or also materialize
       RTL loan files (full).
     - Activity: recent sync events (masked; never shows SSN/card).
     - Per-file re-sync: force one application both ways. */

const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street || a.line1, a.city, a.state].filter(Boolean).join(', ') || '—');

function Stat({ label, value, tone }) {
  return (
    <div className={`tile ${tone === 'ok' ? 'acc' : ''}`}>
      <span className="fig">{value}</span>
      <span className="lab">{label}</span>
    </div>
  );
}

function Dot({ on, label }) {
  return <span className={`pill ${on ? 'ok' : 'crit'}`} title={label}>{label}</span>;
}

function CountRow({ title, obj }) {
  const entries = Object.entries(obj || {});
  return (
    <div style={{ marginTop: 10 }}>
      <div className="muted small" style={{ fontWeight: 600 }}>{title}</div>
      {entries.length === 0
        ? <div className="muted small">— none —</div>
        : <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {entries.map(([k, v]) => <span key={k} className="pill">{k}: <b>{v}</b></span>)}
          </div>}
    </div>
  );
}

export default function StaffClickup() {
  const { can } = useAuth();
  const isAdmin = can('platform_setup');
  const [health, setHealth] = useState(null);
  const [activity, setActivity] = useState(null);
  const [dry, setDry] = useState(null);           // last dry-run stats
  const [busy, setBusy] = useState('');           // which action is running
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [appId, setAppId] = useState('');
  const [review, setReview] = useState(null);     // manual-review queue rows

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };
  const loadHealth = () => api.clickupHealth().then(setHealth).catch(e => setErr(e.message));
  const loadActivity = () => api.clickupActivity().then(r => setActivity(r.rows || [])).catch(() => {});
  const loadReview = () => api.clickupManualReview().then(r => setReview(r.rows || [])).catch(() => {});

  useEffect(() => {
    if (!isAdmin) return;
    loadHealth(); loadActivity(); loadReview();
    const t = setInterval(() => { loadHealth(); loadActivity(); loadReview(); }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function resolveReview(id, action) {
    setBusy(`mr:${id}:${action}`); setErr('');
    try {
      await api.clickupResolveManualReview(id, action);
      flash(action === 'link' ? 'File linked ✓' : 'File descoped ✓');
      loadReview(); loadHealth();
    } catch (e) { setErr(e.message || 'Resolve failed'); }
    finally { setBusy(''); }
  }

  async function runBackfill(mode) {
    setBusy(mode); setErr(''); setDry(null);
    try {
      const r = await api.clickupBackfill(mode);
      if (mode === 'dryrun') { setDry(r.stats || {}); flash('Dry-run complete — read-only, nothing was written.'); }
      else { flash(`Backfill started (${mode}) — running in the background. Watch Activity & Health.`); }
      loadHealth(); loadActivity();
    } catch (e) { setErr(e.message || 'Backfill failed'); }
    finally { setBusy(''); }
  }

  async function reSync(dir) {
    const id = appId.trim();
    if (!id) { setErr('Enter a PILOT file (application) ID first.'); return; }
    setBusy(dir); setErr('');
    try {
      const r = dir === 'repush' ? await api.clickupRepush(id) : await api.clickupRepull(id);
      flash(`${dir === 'repush' ? 'Pushed to' : 'Pulled from'} ClickUp ✓ ${r && r.taskId ? `(task ${r.taskId})` : ''}`);
      loadHealth(); loadActivity();
    } catch (e) { setErr(e.message || 'Re-sync failed'); }
    finally { setBusy(''); }
  }

  if (!isAdmin) return <div role="alert" className="notice err">The ClickUp Control Center is admin-only.</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ClickUp Control Center</h1>
          <div className="sub">Validate and operate the ClickUp ⇄ PILOT sync. Start with a dry-run — it reads only, writes nothing.</div>
        </div>
        <div className="page-head-actions">
          <button className="btn ghost small" onClick={() => { loadHealth(); loadActivity(); loadReview(); flash('Refreshed'); }}>Refresh</button>
        </div>
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {/* connection + switches */}
      <div className="panel pad">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Dot on={health?.tokenSet} label="API token" />
          <Dot on={health?.enabled} label="Sync enabled" />
          <Dot on={health?.webhookSecretSet} label="Webhook secret" />
          <span className="pill">Team {health?.teamId || '—'}</span>
          <span className="pill">Pipeline space {health?.pipelineSpace || '—'}</span>
          <span className="pill">Poll {health?.pollSec ? `${health.pollSec}s` : '—'}</span>
        </div>
        {health?.error && <div className="notice err" style={{ marginTop: 8 }}>Health error: {health.error}</div>}
        <div className="tiles" style={{ marginTop: 12 }}>
          <Stat label="Backfilled borrowers" value={health?.backfilledBorrowers ?? '—'} />
          <Stat label="Tasks indexed" value={health?.tasksIndexed ?? '—'} />
        </div>
        <CountRow title="Applications by sync state" obj={health?.counts} />
        <CountRow title="Webhook inbox" obj={health?.inbox} />
        <CountRow title="Outbound queue" obj={health?.queue} />
      </div>

      {/* manual review queue */}
      <div className="panel pad" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 4, alignItems: 'baseline', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Manual Review</h3>
          <span className="pill">{review == null ? '…' : review.length}</span>
        </div>
        <p className="muted small">Files the inbound sync flagged as ambiguous. <b>Link</b> keeps the file synced to its ClickUp task; <b>Descope</b> pauses sync for the file. Neither writes to ClickUp.</p>
        {review == null ? <p className="muted small">Loading…</p>
          : review.length === 0 ? <p className="muted small">Nothing awaiting review — the queue is clear.</p>
          : <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ minWidth: 720, fontSize: 13 }}>
                <thead><tr>
                  <th style={{ textAlign: 'left' }}>Borrower</th><th style={{ textAlign: 'left' }}>Property</th>
                  <th style={{ textAlign: 'left' }}>YS #</th><th style={{ textAlign: 'left' }}>Task</th>
                  <th style={{ textAlign: 'left' }}>Reason</th><th style={{ textAlign: 'right' }}>Resolve</th>
                </tr></thead>
                <tbody>
                  {review.map((r) => {
                    const reason = r.match_status
                      ? `${r.match_status}${r.match_detail ? ` · ${typeof r.match_detail === 'string' ? r.match_detail : JSON.stringify(r.match_detail)}` : ''}`
                      : '—';
                    return (
                      <tr key={r.id}>
                        <td>{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</td>
                        <td>{addrLine(r.property_address)}</td>
                        <td>{r.ys_loan_number || '—'}</td>
                        <td className="muted small">{r.clickup_pipeline_task_id || '—'}</td>
                        <td className="muted small">{reason}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn small" disabled={!!busy} onClick={() => resolveReview(r.id, 'link')}>{busy === `mr:${r.id}:link` ? '…' : 'Link'}</button>{' '}
                          <button className="btn ghost small" disabled={!!busy} onClick={() => resolveReview(r.id, 'descope')}>{busy === `mr:${r.id}:descope` ? '…' : 'Descope'}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>}
      </div>

      {/* backfill / dry-run */}
      <div className="panel pad" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Backfill &amp; validation</h3>
        <p className="muted small">
          <b>Dry-run</b> samples real ClickUp tasks and reports what the mapping would produce — no DB or ClickUp writes.
          <b> Build identity graph</b> ingests every task into shadow borrower profiles / LLCs / track records (no loan files).
          <b> Full backfill</b> also materializes RTL loan files for qualifying tasks.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={!!busy} onClick={() => runBackfill('dryrun')}>{busy === 'dryrun' ? 'Running…' : 'Dry-run (read-only)'}</button>
          <button className="btn" disabled={!!busy} onClick={() => { if (window.confirm('Build the borrower identity graph from every ClickUp task? This writes shadow profiles but no loan files.')) runBackfill('data'); }}>{busy === 'data' ? 'Starting…' : 'Build identity graph'}</button>
          <button className="btn" disabled={!!busy} onClick={() => { if (window.confirm('Full backfill: build the identity graph AND materialize RTL loan files. Proceed?')) runBackfill('full'); }}>{busy === 'full' ? 'Starting…' : 'Full backfill'}</button>
        </div>

        {dry && (
          <div className="panel pad" style={{ background: 'var(--surface-soft)', marginTop: 12 }}>
            <div className="tiles" style={{ marginBottom: 12 }}>
              <Stat label="Tasks sampled" value={dry.tasksSeen ?? 0} />
              <Stat label="RTL" value={dry.rtl ?? 0} tone="ok" />
              <Stat label="Data-only" value={dry.dataOnly ?? 0} />
              <Stat label="Materializable" value={dry.materializable ?? 0} tone="ok" />
              <Stat label="With SSN" value={dry.withSSN ?? 0} />
              <Stat label="With LLC" value={dry.withLLC ?? 0} />
              <Stat label="Folders" value={dry.folders ?? 0} />
            </div>
            <CountRow title="Programs seen" obj={dry.programs} />
            {Array.isArray(dry.samples) && dry.samples.length > 0 && (
              <div style={{ overflowX: 'auto', marginTop: 10 }}>
                <table className="tbl" style={{ minWidth: 720, fontSize: 13 }}>
                  <thead><tr>
                    <th style={{ textAlign: 'left' }}>Task</th><th style={{ textAlign: 'left' }}>Internal → Borrower</th>
                    <th style={{ textAlign: 'left' }}>Program</th><th style={{ textAlign: 'left' }}>Type</th>
                    <th style={{ textAlign: 'right' }}>Loan amt</th><th style={{ textAlign: 'left' }}>YS #</th>
                    <th style={{ textAlign: 'left' }}>Borrower</th><th>SSN?</th><th style={{ textAlign: 'left' }}>LLC</th><th>Extra</th>
                  </tr></thead>
                  <tbody>
                    {dry.samples.map((s, i) => (
                      <tr key={i}>
                        <td>{s.task}</td>
                        <td>{s.status} → <b>{s.external}</b></td>
                        <td>{s.program || '—'}</td>
                        <td>{s.loan_type || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.loan_amount != null ? Number(s.loan_amount).toLocaleString() : '—'}</td>
                        <td>{s.ys_loan || '—'}</td>
                        <td>{s.borrower || '—'}</td>
                        <td style={{ textAlign: 'center' }}>{s.hasSSN ? '✓' : ''}</td>
                        <td>{s.llc || '—'}</td>
                        <td style={{ textAlign: 'center' }}>{s.extraKeys || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* per-file re-sync */}
      <div className="panel pad" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Re-sync a single file</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>PILOT file (application) ID</label>
            <input className="input" style={{ minWidth: 320 }} value={appId} onChange={e => setAppId(e.target.value)} placeholder="application UUID" />
          </div>
          <button className="btn" disabled={!!busy} onClick={() => reSync('repush')}>{busy === 'repush' ? 'Pushing…' : 'Push → ClickUp'}</button>
          <button className="btn" disabled={!!busy} onClick={() => reSync('repull')}>{busy === 'repull' ? 'Pulling…' : 'Pull ← ClickUp'}</button>
        </div>
      </div>

      {/* activity */}
      <div className="panel pad" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Recent sync activity</h3>
        {activity == null ? <p className="muted small">Loading…</p>
          : activity.length === 0 ? <p className="muted small">No ClickUp sync activity yet.</p>
          : <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ minWidth: 560, fontSize: 13 }}>
                <thead><tr>
                  <th style={{ textAlign: 'left' }}>When</th><th style={{ textAlign: 'left' }}>Action</th>
                  <th style={{ textAlign: 'left' }}>File</th><th style={{ textAlign: 'left' }}>Detail</th>
                </tr></thead>
                <tbody>
                  {activity.map((a, i) => (
                    <tr key={i}>
                      <td>{a.created_at ? new Date(a.created_at).toLocaleString() : '—'}</td>
                      <td>{a.action}</td>
                      <td>{a.entity_id || '—'}</td>
                      <td className="muted small">{typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
      </div>
    </>
  );
}
