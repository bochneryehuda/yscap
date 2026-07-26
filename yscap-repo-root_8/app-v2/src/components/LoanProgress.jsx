import React from 'react';

/* Compact horizontal "where the loan is up to" stepper for the STAFF file view.
   Until now the loan's stage progress was only visible OUTSIDE the loan (the
   pipeline) and to the borrower (StatusTimeline); this puts it inside the file
   too (owner-directed 2026-07-20). Same ordered status path as StatusTimeline /
   the pipeline. Pure — driven off the current status, no fetch. */

const PATH = [
  { s: 'file_intake', label: 'Intake' },
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

export default function LoanProgress({ status }) {
  const terminal = TERMINAL[status];
  // on_hold is a real status but a PAUSE overlaid on the stage, not a stage — the
  // underlying stage isn't in `status`, so don't guess it (that showed "Intake").
  const held = status === 'on_hold';
  const off = !!terminal || held;                     // off the linear path
  const curIdx = off ? -1 : (IDX[status] != null ? IDX[status] : 0);
  const here = terminal || (held ? 'On hold' : (PATH[curIdx] && PATH[curIdx].label) || '—');
  return (
    <div className="loan-prog" role="group" aria-label="Loan progress">
      <div className="loan-prog-head">
        <b className="small">Loan progress</b>
        <span className={`muted small${terminal ? ' lp-term-lbl' : held ? ' lp-held-lbl' : ''}`}>{off ? here : `Now: ${here}`}</span>
      </div>
      <ol className="lp-track">
        {PATH.map((p, i) => {
          const state = off ? 'upcoming' : i < curIdx ? 'done' : i === curIdx ? 'current' : 'upcoming';
          return (
            <li key={p.s} className={`lp-step ${state}`} title={p.label}>
              <span className="lp-dot" />
              <span className="lp-label">{p.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
