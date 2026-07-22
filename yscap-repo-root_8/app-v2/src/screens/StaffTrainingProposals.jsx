import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Sovereign 4/4 admin surface — training proposals queue (owner-directed 2026-07-21).
 *
 * The learning loop aggregates underwriter corrections into candidate
 * improvements (suppress a false-positive finding code, downgrade a severity,
 * refine a normalizer, tweak a committee prompt, ...). Nothing auto-promotes
 * to production. A super-admin reviews the queue here and moves each proposal
 * along: approve, shadow-test, promote, or reject.
 *
 * Admins see the queue; only super-admins decide.
 */

const PROPOSAL_LABEL = {
  suppress_finding:        'Suppress a false-positive finding code',
  downgrade_severity:      'Downgrade a finding’s severity',
  upgrade_severity:        'Upgrade a finding’s severity',
  tune_threshold:          'Tune a rule threshold',
  normalizer_alias:        'Add a normalizer alias',
  prompt_tweak:            'Tweak an extraction prompt',
  add_specialist_lens:     'Add a committee specialist lens',
  committee_prompt_tweak:  'Tweak a committee specialist prompt',
};

const STATUS_STYLES = {
  pending:        { cls: 'warn' },
  shadow_testing: { cls: 'warn' },
  approved:       { cls: 'ok' },
  promoted:       { cls: 'ok' },
  rejected:       { cls: 'err' },
};

export default function StaffTrainingProposals() {
  const { role } = useAuth();
  const isSuper = role === 'super_admin';
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [pendingCount, setPendingCount] = useState(0);
  const [canDecide, setCanDecide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [notes, setNotes] = useState({});

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const load = () => api.trainingProposals(statusFilter)
    .then((d) => { setRows(d.proposals || []); setPendingCount(d.pendingCount || 0); setCanDecide(!!d.canDecide); })
    .catch((e) => flash(false, e.message || 'could not load the training queue'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function runAggregation() {
    setBusy(true);
    try {
      const r = await api.trainingProposalsRun();
      flash(true, `Aggregation done — ${r.proposalsFound || 0} candidate(s) found, ${r.inserted || 0} new proposal(s) queued.`);
      await load();
    } catch (e) { flash(false, e.message || 'could not run the aggregation'); }
    finally { setBusy(false); }
  }

  async function decide(row, decision) {
    setBusy(true);
    try {
      await api.trainingProposalsDecide(row.id, decision, notes[row.id] || '');
      flash(true, `Proposal ${decision}.`);
      await load();
    } catch (e) { flash(false, e.message || 'could not record the decision'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="page-head"><h1>Training proposals</h1></div>
      <p className="muted small" style={{ marginTop: -6 }}>
        Candidate improvements PILOT proposes from underwriter corrections — suppress a
        finding code, downgrade a severity, add a normalizer alias, tweak a committee prompt.
        Nothing auto-promotes; a super-admin approves each one.
      </p>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Queue {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} pending</span>}</h3>
          <div className="row" style={{ gap: 6 }}>
            {['pending', 'shadow_testing', 'approved', 'promoted', 'rejected', 'all'].map((s) => (
              <button key={s} className={`btn small ${statusFilter === s ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(s)}>
                {s === 'shadow_testing' ? 'Shadow' : s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
            {isSuper && <button className="btn primary small" disabled={busy} onClick={runAggregation}>Run aggregation</button>}
          </div>
        </div>
        {!isSuper && <p className="muted small">Only a super-admin can promote or reject a training proposal.</p>}

        {!rows.length && <p className="muted" style={{ marginTop: 12 }}>No {statusFilter === 'all' ? '' : statusFilter} proposals.</p>}
        {rows.map((r) => {
          const st = STATUS_STYLES[r.status] || {};
          const scope = r.scope || {};
          const change = r.proposed_change || {};
          return (
            <div key={r.id} className="card" style={{ border: '1px solid var(--hairline,#e5e0d5)', borderRadius: 10, padding: 12, marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{PROPOSAL_LABEL[r.proposal_type] || r.proposal_type}</div>
                  <div className="muted small" style={{ marginTop: 2 }}>
                    Scope: {Object.entries(scope).map(([k, v]) => `${k}=${v}`).join(' · ') || '—'}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 6 }}>{r.rationale}</div>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    Sample size: {r.supporting_sample_size} · Proposed change: {JSON.stringify(change)}
                  </div>
                  {r.reviewed_by_name && (
                    <div className="muted small" style={{ marginTop: 4 }}>
                      Decided by {r.reviewed_by_name}{r.review_note ? ` — ${r.review_note}` : ''}
                    </div>
                  )}
                </div>
                <span className={`ts-badge ${st.cls || ''}`}>{r.status}</span>
              </div>

              {isSuper && (r.status === 'pending' || r.status === 'shadow_testing') && (
                <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Decision note (optional)"
                    value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                  {r.status === 'pending' && (
                    <>
                      <button className="btn primary small" disabled={busy} onClick={() => decide(r, 'approved')}>Approve</button>
                      <button className="btn ghost small" disabled={busy} onClick={() => decide(r, 'shadow_testing')}>Shadow test</button>
                    </>
                  )}
                  {r.status === 'shadow_testing' && (
                    <button className="btn primary small" disabled={busy} onClick={() => decide(r, 'promoted')}>Promote to production</button>
                  )}
                  <button className="btn ghost small" disabled={busy} onClick={() => decide(r, 'rejected')}>Reject</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
