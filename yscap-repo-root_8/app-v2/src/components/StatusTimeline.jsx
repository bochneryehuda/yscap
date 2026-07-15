import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';

/* Borrower-facing loan timeline. Shows the milestone path and where the file
   is, with the date each milestone was reached (from the status history).
   Declined / withdrawn are shown as a terminal state off the main path. */

const PATH = [
  { s: 'new', label: 'Submitted' },
  { s: 'in_review', label: 'In review' },
  { s: 'processing', label: 'Processing' },
  { s: 'underwriting', label: 'Underwriting' },
  { s: 'approved', label: 'Approved' },
  { s: 'clear_to_close', label: 'Clear to close' },
  { s: 'funded', label: 'Funded' },
];
const IDX = Object.fromEntries(PATH.map((p, i) => [p.s, i]));
const TERMINAL = { declined: 'Declined', withdrawn: 'Withdrawn' };
const fmt = (d) => fmtDay(d, { month: 'short', day: 'numeric', year: 'numeric' });
// A full timestamp (date + time) for each status milestone (owner-directed 2026-07-14).
const fmtTs = (d) => d ? `${fmt(d)} · ${new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';

export default function StatusTimeline({ appId, status, createdAt, expectedClosing, actualClosing }) {
  const [hist, setHist] = useState(null);
  useEffect(() => { api.statusHistory(appId).then(r => setHist(r || [])).catch(() => setHist([])); }, [appId]);

  // Earliest date each status was reached; the file's creation is the
  // "Submitted" milestone when no explicit history row exists for it.
  const reachedAt = {};
  for (const h of (hist || [])) if (!reachedAt[h.to_status]) reachedAt[h.to_status] = h.created_at;
  if (!reachedAt['new'] && createdAt) reachedAt['new'] = createdAt;

  const terminal = TERMINAL[status];
  const curIdx = terminal ? -1 : (IDX[status] != null ? IDX[status] : 0);

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      <h3 style={{ marginBottom: 12 }}>Your loan progress</h3>
      <ol className="timeline">
        {PATH.map((p, i) => {
          const done = !terminal && i < curIdx;
          const current = !terminal && i === curIdx;
          const state = done ? 'done' : current ? 'current' : 'upcoming';
          return (
            <li key={p.s} className={`tl-step ${state}`}>
              <span className="tl-dot" />
              <div className="tl-body">
                <div className="tl-label">{p.label}</div>
                {reachedAt[p.s] && <div className="muted small">{fmtTs(reachedAt[p.s])}</div>}
                {current && <div className="muted small">In progress</div>}
              </div>
            </li>
          );
        })}
        {terminal && (
          <li className="tl-step terminal">
            <span className="tl-dot" />
            <div className="tl-body"><div className="tl-label">{terminal}</div>{reachedAt[status] && <div className="muted small">{fmt(reachedAt[status])}</div>}</div>
          </li>
        )}
      </ol>
      {(actualClosing || expectedClosing) && (
        <div className="tl-closing">
          {actualClosing
            ? <>Closed <strong>{fmt(actualClosing)}</strong></>
            : <>Estimated closing <strong>{fmt(expectedClosing)}</strong> — subject to change as your file progresses.</>}
        </div>
      )}
    </div>
  );
}
