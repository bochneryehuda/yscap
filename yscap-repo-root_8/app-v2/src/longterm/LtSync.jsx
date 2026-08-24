import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';

const when = (v) => {
  if (!v) return 'never';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US') : 'never';
};

/**
 * The last pull, in one sentence a person can act on.
 *
 * THREE STATES, NEVER COLLAPSED, because each sends somebody somewhere different:
 * a pass RUNNING right now (wait), a pass that FAILED or refused (here is why), and
 * a pass that WORKED (here is what it found — including "Encompass had nothing for
 * us", which is a real and different answer from "we could not ask"). A fourth
 * state matters just as much on a fresh deployment: NO pass has been recorded yet,
 * which must never be drawn as a success.
 */
/**
 * Name the loans a pass could not save, so somebody can go and look at them.
 *
 * A COUNT ALONE IS NOT ACTIONABLE — "1 loan could not be saved" sends a person to
 * search 772 files for it. The pass keeps the loan number and the Encompass id of
 * the first few, and the loan NUMBER is what a human recognises a loan by, so that
 * leads. A loan with no number yet falls back to its Encompass id rather than
 * printing nothing.
 */
function refusedNames(detail) {
  const list = (detail && Array.isArray(detail.refusedLoans)) ? detail.refusedLoans : [];
  const names = list.map((x) => x && (x.loanNumber || x.encompassLoanGuid)).filter(Boolean);
  if (!names.length) return 'check the long-term sync log for which';
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

function LastPull({ state }) {
  const r = state.lastLoanRun;
  const running = state.running === true;

  const box = (tone, title, body) => (
    <div className="card" style={{ marginBottom: 12, color: '#141B22', borderLeft: `4px solid ${tone}` }}>
      <div style={{ fontWeight: 700, marginBottom: body ? 4 : 0 }}>{title}</div>
      {body && <div style={{ color: '#4B585C', fontSize: 13, lineHeight: 1.55 }}>{body}</div>}
    </div>
  );

  if (running) {
    return box('#2F7F86', 'A pull is running right now.',
      'It works through the whole book, so give it a minute or two and refresh this screen.');
  }
  if (!r) {
    // Deliberately not styled as a problem: on a fresh deployment this is simply
    // the truth, and dressing it in red would send somebody hunting for a fault.
    return box('#4B585C', 'No pull has been recorded yet.',
      'Press "Pull everything from Encompass" below to start one. From then on this line says what the last one did.');
  }
  if (r.ok === false) {
    return box('#B4331F', 'The last pull did not work.',
      <>
        {r.reason || 'No reason was recorded.'}
        <div style={{ marginTop: 6 }}>{when(r.started_at)}{r.trigger === 'manual' ? ' · you started this one' : ''}</div>
      </>);
  }
  // It worked. Say what it FOUND — "nothing" is an answer, and it is the answer
  // that tells somebody the connection is fine and the book is genuinely empty.
  const found = r.discovered == null ? null : Number(r.discovered);
  const read = r.read_count == null ? 0 : Number(r.read_count);
  const left = r.remaining == null ? null : Number(r.remaining);
  const skipped = r.skipped == null ? 0 : Number(r.skipped);
  // A LOAN THE DATABASE REFUSED IS NEVER SILENT. A pass that brought in 771 of 772
  // genuinely worked, so this stays the "it worked" state rather than crying wolf —
  // but the one that did not come in is real work for a person, and a pull that
  // quietly leaves a loan out is the same class of bug as a book that could not say
  // why it was empty. `detail` holds the pass's own shape, so this needs no column.
  const refused = Number((r.detail && r.detail.refused) || 0);
  return box('#2F7F86',
    found === 0
      ? 'The last pull worked — Encompass had no long-term files for us.'
      : `The last pull worked${found == null ? '' : ` — it found ${found} loan(s)`}.`,
    <>
      {`Read ${read} of them.`}
      {skipped ? ` Skipped ${skipped} short-term file(s), which belong on the other side.` : ''}
      {left ? ` ${left} still to read — the next pass picks them up.` : ''}
      {refused
        ? ` ${refused} loan(s) could not be saved and are NOT in the book — ${refusedNames(r.detail)}.`
        : ''}
      <div style={{ marginTop: 6 }}>{when(r.started_at)}{r.trigger === 'manual' ? ' · you started this one' : ''}</div>
    </>);
}

/**
 * How fresh the long-term book is, and what is failing.
 *
 * ANY staff member may read this: "why does this file look old?" has to be
 * answerable without asking somebody. Only an admin can run a pass.
 *
 * It NAMES what is failing rather than only counting it — the reason is already
 * stored on the loan, and a bare count sends somebody hunting.
 */
/** How long a loan has waited, in words. Seconds are never shown — nobody acts on
 *  "waiting 94 seconds", and rounding up to "under a minute" is honest either way. */
function waitedFor(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n) || n < 0) return 'an unknown time';
  if (n < 60) return 'under a minute';
  if (n < 3600) { const m = Math.floor(n / 60); return `${m} minute${m === 1 ? '' : 's'}`; }
  if (n < 86400) { const h = Math.floor(n / 3600); return `${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.floor(n / 86400);
  return `${d} day${d === 1 ? '' : 's'}`;
}

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

  // THE FULL PULL. `run` above refreshes what moved (25 loans); this one works
  // through the WHOLE book, which is what somebody staring at an empty pipeline
  // actually wants. It returns immediately and keeps going in the background, so the
  // screen re-reads its own state on a timer rather than pretending to wait.
  const pullAll = async () => {
    setBusy(true); setNote('');
    try {
      const out = await ltApi.pullFromEncompass();
      setNote(out.note || 'Pulling from Encompass now.');
      // First refresh soon (the first loans land within seconds), then again once
      // the drain has had a real run at it. Cleared on unmount by the effect below.
      setTimeout(load, 4000);
      setTimeout(load, 30000);
    } catch (e) { setNote(e.message || 'Could not start the pull.'); }
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

      {/* WHAT THE LAST PULL ACTUALLY DID — the first thing on the screen, because it
          is the only thing here that can explain an empty book. Every figure below is
          counted out of the loans we HAVE, so a pass that brought none back (Encompass
          refused, the switch is off, the search came back empty) used to render as an
          untouched screen with the reason written to a log nobody can read. */}
      {state && <LastPull state={state} />}

      {state && (
        <div className="card" style={{ display: 'flex', gap: 26, flexWrap: 'wrap', color: '#141B22' }}>
          {stat('Loans', state.loans)}
          {/* Encompass's deleted files, counted apart so this screen's total always
              matches the pipeline's (owner-directed 2026-08-23). Absent when zero. */}
          {Number(state.archived) > 0 ? stat('In the archive (deleted or superseded in Encompass)', state.archived) : null}
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
          {/* THE PRIMARY ACTION, and deliberately first and loudest: on a book that
              has never been pulled, "bring everything in" is the thing somebody
              wants, and the 25-loan refresh beside it reads as broken if it is all
              that is offered. */}
          <button className="btn primary" onClick={pullAll} disabled={busy}>
            {busy ? 'Starting…' : 'Pull everything from Encompass'}
          </button>
          <button className="btn ghost" onClick={run} disabled={busy}>
            {busy ? 'Reading Encompass…' : 'Refresh what changed'}
          </button>
          {/* Offered even while the switch is off: the button answers WHY rather
              than vanishing, which is the difference between a control somebody
              can act on and one they assume is broken. */}
          <button className="btn ghost" onClick={runConditions} disabled={busy}>
            Read conditions only
          </button>
        </div>
      )}

      {/* LOANS STILL WAITING FOR THEIR FIRST READ (owner-reported 2026-08-24, three
          Sherman Ave files: "All these files somehow are not updating in pilot. I
          don't know why I'm not getting the information").

          A loan reaches PILOT in two steps. Discovery finds it and stores what the
          pipeline SEARCH returns — number, officer, address, program, amount,
          borrower. The full read then opens the file and brings back everything
          else. Between the two the row is real and half empty, and until now that
          state was named on no screen: the count was implicit and the loans
          themselves were listed nowhere, so a file that arrived an hour ago and one
          that has been stuck for days looked exactly the same.

          THE WAIT IS WHAT TELLS THEM APART, so it is the thing shown. */}
      {state && state.waiting_count > 0 && (
        <div className="card" style={{ marginTop: 16, color: '#141B22' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#141B22' }}>
            Waiting for their first read ({state.waiting_count})
          </h2>
          <p style={{ margin: '0 0 8px', color: '#4B585C', fontSize: 13, lineHeight: 1.5 }}>
            PILOT has found these loans in Encompass but has not opened the files themselves yet, so
            only what the pipeline search returns is filled in. They are in the queue and fill in on
            their own &mdash; a loan that has been waiting minutes is the queue working, one that has
            been waiting days is worth looking at.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#4B585C', lineHeight: 1.6 }}>
            {(state.waiting || []).map((w) => (
              <li key={w.encompass_loan_guid}>
                <strong style={{ color: '#141B22' }}>{w.loan_number || w.encompass_loan_guid}</strong>
                {' '}&mdash; waiting {waitedFor(w.waiting_secs)}
              </li>
            ))}
          </ul>
          {state.waiting_count > (state.waiting || []).length && (
            <p style={{ margin: '8px 0 0', color: '#4B585C', fontSize: 12 }}>
              The {state.waiting_count - (state.waiting || []).length} others are not listed here &mdash;
              the oldest twenty are the ones worth looking at.
            </p>
          )}
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
