// LT PPE — the disqualifier review queue (§2.58).
//
// THE OWNER ASKED FOR THIS SCREEN IN THESE WORDS: "You need to lay out the actual question for a human
// to review… look on the eligibility rule in Lender Price, go into the disqualifier, and look for the
// actual disqualifier. You then look at the rate to see if you can find where he's taking this
// disqualifier. You need a human to review these findings for every single scenario." The server does
// those three steps; this card is the laying-out.
//
// WHAT IT REFUSES TO DO:
//   1. IT NEVER SHOWS AN EMPTY QUEUE AS "NOTHING TO REVIEW" WITHOUT SAYING WHY. A read that FAILED, a
//      program nobody has run yet, and a genuinely clean sheet are three different facts, and the
//      first two must never wear the third's face. That is the whole failure this queue exists
//      inside — an empty answer that looks like a clean one.
//   2. IT NEVER CLAIMS A DECISION CHANGES A PRICE. Recording "we should refuse this" writes no rule
//      and publishes nothing; a super admin still has to put a rule in force. The card says so beside
//      every button, because a reviewer who believes the button prices the loan will use it wrongly.
//   3. IT NEVER HIDES A CONTROL THE SERVER MIGHT REFUSE — the console's standing rule. A hidden
//      button is indistinguishable from a broken one.
//
// Dark text on the white PILOT canvas throughout — never an `--ink*` token (a LIGHT paper colour in
// this palette, which renders white-on-white).

import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, DANGER, CAUTION, eyebrow, input, label } from './ppeStyles.js';

const box = {
  marginTop: 16, padding: 12, borderRadius: 8,
  background: 'rgba(20,27,34,.03)', border: '1px solid rgba(20,27,34,.10)',
};

// A CLASSIFICATION IS SHOWN AS A HEADLINE, not as a code. The server sends both; the code is what a
// report counts and the sentence is what a person reads, and neither should have to derive the other.
const TITLES = {
  priced_not_declined: 'They refuse it — we charge for it',
  covered_but_not_fired: 'They refuse it — we price this, but no rule of ours reached this loan',
  silent: 'They refuse it — our sheet says nothing about it',
  unknown_dimension: 'They refuse it for something we cannot name',
  unknown_ours: 'They refuse it — we could not work out our own answer',
  agreed_decline: 'We both refuse it',
  moot_other_decline: 'They refuse it — we refuse it for a different reason',
};

export default function DisqualifierReview({ versionId, programId }) {
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState(null);
  const [readError, setReadError] = useState('');
  const [run, setRun] = useState(null);
  const [runError, setRunError] = useState('');
  const [openId, setOpenId] = useState(null);      // which question has its answer form open
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState('');

  const load = useCallback(async () => {
    setReadError('');
    try {
      setQueue(await ltApi.ppeDisqualifierReview({ programId, status: 'open', limit: 200 }));
    } catch (e) {
      // The read FAILED — said as itself, never rendered as an empty queue.
      setQueue(null);
      setReadError(e.message || 'The review queue could not be read.');
    }
  }, [programId]);

  useEffect(() => { load(); }, [load]);

  const runReview = async () => {
    setBusy(true); setRunError(''); setRun(null);
    try {
      const r = await ltApi.ppeRunDisqualifierReview(versionId);
      setRun(r);
      await load();
    } catch (e) {
      // A 503 here is Lender Price not being configured — the upstream speaking, not this button
      // being broken.
      setRunError(e.message || 'The review could not run.');
    } finally { setBusy(false); }
  };

  const decide = async (id, decision) => {
    setBusy(true); setSaveError('');
    try {
      await ltApi.ppeDecideDisqualifierReview(id, { decision, note: note.trim() || null });
      setOpenId(null); setNote('');
      await load();
    } catch (e) {
      setSaveError(e.message || 'That answer could not be recorded.');
    } finally { setBusy(false); }
  };

  const items = (queue && Array.isArray(queue.items)) ? queue.items : [];
  const summary = queue && queue.summary;
  const decisions = (queue && Array.isArray(queue.decisions)) ? queue.decisions : [];

  return (
    <div style={box}>
      <div style={{ ...eyebrow, marginBottom: 6 }}>Where Lender Price refuses a loan</div>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: SLATE }}>
        For every scenario Lender Price turns down, this reads their own disqualifier and then looks at
        our rate sheet for the same thing — and lays out the question. Answering one <strong>records
        what you concluded</strong>: it changes no price and publishes no rule. Running it prices the
        whole battery at the vendor, so it costs a real battery every time it is pressed.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn ghost" disabled={busy} onClick={runReview}>Ask Lender Price and line it up</button>
        <button className="btn ghost" disabled={busy} onClick={load}>Refresh the queue</button>
      </div>

      {runError && <p style={{ margin: '10px 0 0', fontSize: 13, color: CAUTION }}>{runError}</p>}
      {run && (
        <div style={{ marginTop: 10, fontSize: 13, color: SLATE }}>
          <div>
            Read {run.scenarios} scenario{run.scenarios === 1 ? '' : 's'}: {run.wrote.inserted} new question
            {run.wrote.inserted === 1 ? '' : 's'}, {run.wrote.refreshed} unchanged, {run.wrote.reopened} reopened
            because the situation moved, {run.staled} retired.
          </div>
          {/* No silent gaps: a run that could not read part of the battery says so, because a smaller
              queue would otherwise read as a cleaner sheet. */}
          {(run.notReady > 0 || run.errors > 0 || run.truncated > 0) && (
            <div style={{ marginTop: 6, color: CAUTION }}>
              {run.truncated > 0 && `${run.truncated} scenario${run.truncated === 1 ? '' : 's'} were not run (over the per-run limit). `}
              {run.notReady > 0 && `Lender Price answered no refusal list on ${run.notReady} scenario${run.notReady === 1 ? '' : 's'}, so nothing was compared on those. `}
              {run.errors > 0 && `${run.errors} scenario${run.errors === 1 ? '' : 's'} could not be read at all.`}
            </div>
          )}
        </div>
      )}

      {readError && <p style={{ margin: '10px 0 0', fontSize: 13, color: DANGER }}>{readError}</p>}

      {!readError && queue && (
        <div style={{ marginTop: 12 }}>
          {summary && (
            <div style={{ fontSize: 13, color: SLATE }}>
              {summary.needsHuman} waiting for an answer, {summary.decided} already answered,{' '}
              {summary.stale} retired.
              {/* NO SILENT CAPS: a page that is not the whole queue says so. */}
              {queue.notShown > 0 && (
                <span> Showing {items.length} of them here; {queue.notShown} more are waiting behind this page.</span>
              )}
              {summary.needsHuman > 0 && Object.keys(summary.byDimension).length > 0 && (
                <span> By what it is about: {Object.entries(summary.byDimension)
                  .sort((a, b) => b[1] - a[1])
                  .map(([d, n]) => `${d} (${n})`).join(', ')}.</span>
              )}
            </div>
          )}

          {items.length === 0 && (
            <p style={{ marginTop: 8, fontSize: 13, color: MUTED }}>
              {/* An empty queue means one of two things, and they are named rather than merged. */}
              Nothing is waiting. Either every refusal Lender Price makes has been answered, or this
              sheet has not been run yet — the run above says which.
            </p>
          )}

          {items.map((it) => (
            <div key={it.id} style={{
              marginTop: 10, padding: 10, borderRadius: 8, background: '#fff',
              border: '1px solid rgba(20,27,34,.12)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>
                {TITLES[it.classification] || it.classification}
                {it.dimension ? ` · ${it.dimension}` : ''}
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: SLATE }}>{it.question}</p>
              {it.lpReason && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED }}>
                  Their words: “{it.lpReason}”{it.adjType ? ` (${it.adjType})` : ''}
                </p>
              )}
              {it.priorDecision && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: CAUTION }}>
                  This was answered before ({it.priorDecision.decision}) and reopened because the
                  situation changed. The old answer is kept.
                </p>
              )}

              {openId === it.id ? (
                <div style={{ marginTop: 8 }}>
                  <label style={label} htmlFor={`dq-note-${it.id}`}>Why (optional, but it is what a later reader has)</label>
                  <input id={`dq-note-${it.id}`} style={input} value={note}
                    onChange={(e) => setNote(e.target.value)} placeholder="e.g. we price this deliberately — the LLPA covers it" />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {decisions.map((d) => (
                      <button key={d.decision} className="btn ghost" disabled={busy}
                        title={d.means} onClick={() => decide(it.id, d.decision)}>
                        {d.means}
                      </button>
                    ))}
                    <button className="btn ghost" disabled={busy} onClick={() => { setOpenId(null); setNote(''); }}>
                      Cancel
                    </button>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED }}>
                    This records your conclusion. It changes no price and publishes no rule.
                  </p>
                </div>
              ) : (
                <button className="btn ghost" style={{ marginTop: 8 }} disabled={busy}
                  onClick={() => { setOpenId(it.id); setNote(''); setSaveError(''); }}>
                  Answer this
                </button>
              )}
            </div>
          ))}

          {saveError && <p style={{ margin: '10px 0 0', fontSize: 13, color: DANGER }}>{saveError}</p>}
        </div>
      )}
    </div>
  );
}
