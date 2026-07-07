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

function Stat({ label, value, tone }) {
  return (
    <div className="panel" style={{ background: 'var(--ink-2)', padding: '10px 14px', minWidth: 120 }}>
      <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone === 'ok' ? 'var(--ok,#4caf82)' : tone === 'warn' ? 'var(--warn,#e0a800)' : 'inherit' }}>{value}</div>
    </div>
  );
}

function Dot({ on, label }) {
  return (
    <span className="pill" title={label} style={{ background: on ? 'rgba(76,175,130,.15)' : 'rgba(224,102,102,.12)', color: on ? 'var(--ok,#4caf82)' : 'var(--danger,#e06666)' }}>
      {on ? '●' : '○'} {label}
    </span>
  );
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

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4000); };
  const loadHealth = () => api.clickupHealth().then(setHealth).catch(e => setErr(e.message));
  const loadActivity = () => api.clickupActivity().then(r => setActivity(r.rows || [])).catch(() => {});

  useEffect(() => {
    if (!isAdmin) return;
    loadHealth(); loadActivity();
    const t = setInterval(() => { loadHealth(); loadActivity(); }, 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

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
    if (!id) { setErr('Enter a portal file (application) ID first.'); return; }
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
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1>ClickUp Control Center</h1>
          <p className="muted small">Validate and operate the ClickUp ⇄ portal sync. Start with a dry-run — it reads only, writes nothing.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => { loadHealth(); loadActivity(); flash('Refreshed'); }}>Refresh</button>
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {/* connection + switches */}
      <div className="panel">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Dot on={health?.tokenSet} label="API token" />
          <Dot on={health?.enabled} label="Sync enabled" />
          <Dot on={health?.webhookSecretSet} label="Webhook secret" />
          <span className="pill">Team {health?.teamId || '—'}</span>
          <span className="pill">Pipeline space {health?.pipelineSpace || '—'}</span>
          <span className="pill">Poll {health?.pollSec ? `${health.pollSec}s` : '—'}</span>
        </div>
        {health?.error && <div className="notice err" style={{ marginTop: 8 }}>Health error: {health.error}</div>}
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <Stat label="Backfilled borrowers" value={health?.backfilledBorrowers ?? '—'} />
          <Stat label="Tasks indexed" value={health?.tasksIndexed ?? '—'} />
        </div>
        <CountRow title="Applications by sync state" obj={health?.counts} />
        <CountRow title="Webhook inbox" obj={health?.inbox} />
        <CountRow title="Outbound queue" obj={health?.queue} />
      </div>

      {/* backfill / dry-run */}
      <div className="panel" style={{ marginTop: 14 }}>
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
          <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 12 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
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
                <table className="table" style={{ width: '100%', minWidth: 720, fontSize: 13 }}>
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
      <div className="panel" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Re-sync a single file</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Portal file (application) ID</label>
            <input className="input" style={{ minWidth: 320 }} value={appId} onChange={e => setAppId(e.target.value)} placeholder="application UUID" />
          </div>
          <button className="btn" disabled={!!busy} onClick={() => reSync('repush')}>{busy === 'repush' ? 'Pushing…' : 'Push → ClickUp'}</button>
          <button className="btn" disabled={!!busy} onClick={() => reSync('repull')}>{busy === 'repull' ? 'Pulling…' : 'Pull ← ClickUp'}</button>
        </div>
      </div>

      {/* activity */}
      <div className="panel" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Recent sync activity</h3>
        {activity == null ? <p className="muted small">Loading…</p>
          : activity.length === 0 ? <p className="muted small">No ClickUp sync activity yet.</p>
          : <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%', minWidth: 560, fontSize: 13 }}>
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
