import React, { useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { stamp, day } from './format.js';

/**
 * HOW LONG THIS FILE TOOK — one loan, read as durations.
 *
 * The owner's words (2026-08-30): *"for every file how long it took between which
 * and which step and who the processor was in that file."*
 *
 * THREE THINGS HERE ARE THE WHOLE POINT:
 *
 *   1. AN UNMEASURABLE SPAN SAYS WHY, IN A SENTENCE. The server refuses with a
 *      named reason — the file has not got there yet, we were already past it when
 *      we started watching, the steps completed out of order — and each of those is
 *      a different piece of work for a different person. Collapsing them into one
 *      "no data", or printing a 0, is the confident wrong answer the whole
 *      reporting database was built to avoid.
 *
 *   2. ENCOMPASS'S DATE AND OUR OBSERVATION SIT SIDE BY SIDE, never merged. They
 *      answer different questions: Encompass's is the DAY it records for the step,
 *      ours is the minute PILOT saw it happen. A file we were already past shows
 *      Encompass's date and, honestly, nothing of ours.
 *
 *   3. THE PERSON NAMED IS THE ONE RECORDED AT COMPLETION, not whoever holds the
 *      step today — so a reassignment cannot silently re-attribute work already
 *      done. Where only the current holder is known the row says so.
 *
 * READ-ONLY. Nothing here writes anything, to PILOT or to Encompass.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const LINE = '#EAE4D7';

const TH = {
  textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700, padding: '8px 10px', whiteSpace: 'nowrap',
};
const TD = { padding: '9px 10px', fontSize: 14, color: INK, borderTop: `1px solid ${LINE}`, verticalAlign: 'top' };

/** Days, written the way a person says them — never a bare number with no unit. */
function days(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 1) return 'same day';
  const r = Math.round(n * 10) / 10;
  return `${r} ${r === 1 ? 'day' : 'days'}`;
}

const WHAT = {
  observed_completed: 'completed',
  observed_reopened: 'reopened',
  observed_assigned: 'assigned',
  observed_baseline: 'already done when PILOT started watching',
};

export default function LtTiming({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    ltApi.fileTimeline(loanId)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message || 'Could not read this file’s timeline.'); });
    return () => { live = false; };
  }, [loanId]);

  if (err) return <p style={{ margin: 0, color: '#8A2A2A', fontSize: 13 }}>{err}</p>;
  if (!data) return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Reading the timeline…</p>;

  // A DEGRADED READ IS NOT AN EMPTY FILE. Saying "nothing here" when the query
  // failed is the same class of wrong answer as printing a zero for an unknown.
  if (data.degraded) {
    return (
      <p style={{ margin: 0, color: '#8A2A2A', fontSize: 13, lineHeight: 1.55 }}>
        PILOT could not read this file’s ladder just now, so what is below would not be
        the answer. Try again in a moment.
      </p>
    );
  }

  const spans = data.spans || [];
  const ladder = data.ladder || [];
  const history = data.history || [];

  return (
    <>
      <p style={{ margin: '0 0 12px', color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
        A step is measured only when PILOT saw <em>both</em> ends of it. A file that was
        already past a step the first time PILOT read the loan has no duration to report,
        and says so — that stamp is when we started watching, never when it moved.
      </p>

      {/* THE SPANS. Each one either a duration or a reason, never a blank. */}
      <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {spans.map((s) => {
          const d = days(s.days);
          return (
            <div key={s.key} style={{
              border: `1px solid ${d ? GOLD : LINE}`, borderRadius: 10,
              background: d ? '#FBF6EC' : '#FFFFFF', padding: '10px 14px',
            }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div style={{ fontSize: d ? 20 : 14, fontWeight: 700, color: d ? INK : MUTED, minWidth: 96 }}>
                  {d || 'Not known'}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{s.label}</div>
                <div style={{ fontSize: 12, color: MUTED }}>
                  {s.from} → {s.to}
                </div>
              </div>
              {/* THE REASON, in the server's own words. One definition, so the file
                  screen and the reporting centre can never explain the same gap
                  two different ways. */}
              {!d && s.why && (
                <div style={{ fontSize: 13, color: MUTED, marginTop: 5, lineHeight: 1.5 }}>{s.why}</div>
              )}
              {s.owner && s.owner.name && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 5 }}>
                  {s.ownerLabel || 'Held by'}: <strong style={{ color: INK }}>{s.owner.name}</strong>
                  {s.owner.source === 'current' && (
                    <span style={{ color: '#8A6A17' }}>
                      {' '}— who holds this step today, not who completed it; PILOT was not
                      recording that yet when this step finished.
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {spans.length === 0 && (
          <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
            This loan’s workflow has none of the steps these spans are measured between.
          </p>
        )}
      </div>

      {/* THE LADDER. Encompass's own date and OUR observation, side by side. */}
      <div style={{ fontSize: 13, fontWeight: 700, color: INK, margin: '0 0 6px' }}>Every step</div>
      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table className="lt-rows" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
          <thead>
            <tr>
              <th style={TH}>Step</th>
              <th style={TH}>Encompass says</th>
              <th style={TH}>PILOT saw it</th>
              <th style={TH}>Completed by</th>
              <th style={TH}>Assigned to</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((r) => (
              <tr key={`${r.position}-${r.milestone}`}>
                <td style={{ ...TD, fontWeight: r.done ? 600 : 400, color: r.done ? INK : MUTED }}>
                  {r.milestone}
                </td>
                <td style={TD}>{r.encompassDate ? day(r.encompassDate) : '—'}</td>
                <td style={TD}>
                  {r.observedDoneAt ? stamp(r.observedDoneAt) : '—'}
                  {r.wasAlreadyDone && (
                    <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                      already done when we started watching
                    </div>
                  )}
                </td>
                <td style={TD}>{r.completedBy || '—'}</td>
                <td style={TD}>
                  {r.assignedTo || '—'}
                  {r.assignedRole && (
                    <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{r.assignedRole}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* WHAT PILOT ACTUALLY WITNESSED, newest first. This is the record behind the
          figures above — a baseline is listed as what it is and never as a
          completion. */}
      {history.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: INK, margin: '0 0 6px' }}>
            What PILOT saw happen
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="lt-rows" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead>
                <tr>
                  <th style={TH}>When PILOT saw it</th>
                  <th style={TH}>Step</th>
                  <th style={TH}>What happened</th>
                  <th style={TH}>Who</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={`${h.at}-${h.milestone}-${i}`}>
                    <td style={TD}>{stamp(h.at)}</td>
                    <td style={TD}>{h.milestone}</td>
                    <td style={{ ...TD, color: h.isBaseline ? MUTED : INK }}>
                      {WHAT[h.what] || h.what}
                      {h.encompassDate && !h.isBaseline && (
                        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                          Encompass dates it {day(h.encompassDate)}
                        </div>
                      )}
                    </td>
                    <td style={TD}>
                      {h.to || '—'}
                      {h.from && h.to && h.from !== h.to && (
                        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>was {h.from}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
