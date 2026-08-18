import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

const when = (v) => {
  if (!v) return 'never';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US') : 'never';
};

/**
 * How fresh the long-term book is, and what is failing.
 *
 * ANY staff member may read this: "why does this file look old?" has to be
 * answerable without asking somebody. Only an admin can run a pass.
 *
 * It NAMES what is failing rather than only counting it — the reason is already
 * stored on the loan, and a bare count sends somebody hunting.
 */
export default function LtSync() {
  const [state, setState] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ltApi.syncState().then(setState).catch((e) => setNote(e.message || 'Could not read the sync state.'));
  }, []);
  useEffect(load, [load]);

  // The Condition Centre rides the same pass, so its outcome is reported in the
  // same sentence — including its REFUSAL, which is the ordinary state while the
  // feature is switched off and must never read as a failure.
  // What the threads did is only ever ADDED when there is something to say — a
  // pass that read every conversation cleanly should not make somebody read a
  // sentence about it. A cap or a thread that would not read always says so.
  const threadNote = (t) => {
    if (!t || !t.threads) return '';
    const trouble = [];
    if (t.failed) trouble.push(`${t.failed} could not be read`);
    if (t.unreadable) trouble.push(`${t.unreadable} comment${t.unreadable === 1 ? '' : 's'} came in a form we could not file`);
    if (t.more) trouble.push('more conversations still to go');
    return trouble.length ? ` Conversations: ${trouble.join('; ')}.` : '';
  };

  const conditionNote = (c) => {
    if (!c) return '';
    if (c.ok === false) return ` Conditions: ${c.reason}`;
    if (!c.due) return ' Conditions were already up to date.';
    return ` Conditions: read ${c.read} of ${c.due} loans${c.failed ? `, ${c.failed} could not be read` : ''}${c.more ? ' (more still to go)' : ''}.`
      + threadNote(c.comments);
  };

  const run = async () => {
    setBusy(true); setNote('');
    try {
      const out = await ltApi.runSync();
      setNote((out.note
        || `Found ${out.discovered} loans. ${out.read} were read in full${out.failed ? `, ${out.failed} could not be read` : ''}${out.remaining ? `, ${out.remaining} still to go` : ''}.`)
        + conditionNote(out.conditions));
      load();
    } catch (e) { setNote(e.message || 'Could not run the sync.'); }
    finally { setBusy(false); }
  };

  const runConditions = async () => {
    setBusy(true); setNote('');
    try {
      // `refreshHours: 0` — asking for this pass by hand means "read them again
      // NOW", not "read whatever is a few hours stale".
      const out = await ltApi.runConditionSync({ refreshHours: 0 });
      setNote(out.ok === false
        ? out.reason
        : `Conditions: read ${out.read} of ${out.due} loans${out.failed ? `, ${out.failed} could not be read` : ''}${out.more ? ' (more still to go — run it again)' : ''}.`
          + threadNote(out.comments));
      load();
    } catch (e) { setNote(e.message || 'Could not read the conditions.'); }
    finally { setBusy(false); }
  };

  const stat = (label, value) => (
    <div style={{ minWidth: 150 }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: '#4B585C', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 20, color: '#141B22', fontWeight: 600 }}>{value}</div>
    </div>
  );

  return (
    <LtLayout title="Sync">
      <p style={{ margin: '0 0 14px', color: '#4B585C', maxWidth: 720, lineHeight: 1.55 }}>
        Long-term files are READ from Encompass. Nothing PILOT does is ever written back.
      </p>

      {note && <div className="card" style={{ color: '#141B22', marginBottom: 12 }}>{note}</div>}

      {state && (
        <div className="card" style={{ display: 'flex', gap: 26, flexWrap: 'wrap', color: '#141B22' }}>
          {stat('Loans', state.loans)}
          {stat('Read at least once', state.read_at_least_once)}
          {stat('Failing', state.failing_count != null ? state.failing_count : state.failing?.length ?? 0)}
          {stat('Last sync', when(state.last_synced_at))}
        </div>
      )}

      {/* The Condition Centre's own freshness, on the same screen and for the
          same reason as the book's: an empty centre and a centre nobody has
          read look identical on a loan, and only this says which it is. */}
      {state && state.conditions && (
        <div className="card" style={{ marginTop: 12, color: '#141B22' }}>
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            {stat('Conditions mirrored', state.conditions.conditions)}
            {stat('eFolder documents', state.conditions.documents)}
            {stat('Loans read', state.conditions.loans_read)}
            {stat('Failing', state.conditions.failing)}
            {stat('Last read', when(state.conditions.last_synced_at))}
          </div>
          {!state.conditions.enabled && (
            <p style={{ margin: '10px 0 0', color: '#4B585C', fontSize: 13, lineHeight: 1.55 }}>
              The Condition Center is switched off, so nothing is being read. Turn on
              <code style={{ margin: '0 4px' }}>conditions.enabled</code> in Settings to start.
            </p>
          )}
        </div>
      )}

      {/* The milestone catalog. Every file screen draws its progress bar from this,
          and it marks progress POSITIONALLY — a loan at a step the catalog does not
          carry shows NO progress at all — so "has anybody ever confirmed this
          against Encompass?" is worth answering before somebody wonders why a new
          step is missing from every file that sits at it. */}
      {state && state.milestoneCatalog && state.milestoneCatalog.total != null && (
        <div className="card" style={{ marginTop: 12, color: '#141B22' }}>
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            {stat('Milestones in use', state.milestoneCatalog.live_steps)}
            {stat('Confirmed with Encompass', state.milestoneCatalog.live)}
            {stat('Last confirmed', when(state.milestoneCatalog.last_synced_at))}
          </div>
          {!state.milestoneCatalog.live && (
            <p style={{ margin: '10px 0 0', color: '#4B585C', fontSize: 13, lineHeight: 1.55 }}>
              Nobody has confirmed these steps against Encompass yet — they are the
              list PILOT shipped with. A sync pass reads the real one, and does it
              again at most once a day.
            </p>
          )}
        </div>
      )}

      {state && state.canRun && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'Reading Encompass…' : 'Sync now'}
          </button>
          {/* Offered even while the switch is off: the button answers WHY rather
              than vanishing, which is the difference between a control somebody
              can act on and one they assume is broken. */}
          <button className="btn ghost" onClick={runConditions} disabled={busy}>
            Read conditions only
          </button>
        </div>
      )}

      {state && state.failing && state.failing.length > 0 && (
        <div className="card" style={{ marginTop: 16, color: '#141B22' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 16, color: '#141B22' }}>Files we could not read</h2>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#4B585C', lineHeight: 1.6 }}>
            {state.failing.map((f) => (
              <li key={f.encompass_loan_guid}>
                <strong style={{ color: '#141B22' }}>{f.loan_number || f.encompass_loan_guid}</strong> — {f.encompass_sync_error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </LtLayout>
  );
}
