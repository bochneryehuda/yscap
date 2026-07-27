import React, { useState } from 'react';
import { goToSection } from './FileSections.jsx';
import { buildNextUp } from '../lib/next-up.js';

/* THE FRONT DOOR OF THE LOAN FILE — "What needs you next."
 *
 * Move 1 of docs/LOAN-FILE-SIMPLICITY-BLUEPRINT.md. The file is sixteen
 * sections and roughly a thousand controls deep; opening it used to mean
 * hunting for what actually wants you today. This card is the first thing on
 * the page: the few items holding the file up, worst first, each with a
 * plain-English reason and a jump straight to the control that fixes it.
 *
 * NOTHING HERE IS NEW WORK AND NOTHING IS HIDDEN.
 *  - Every row already existed. The server has long returned, for each
 *    outstanding item, its title, a plain-language reason, WHICH of the sixteen
 *    sections fixes it and WHICH conditions tab — see decorateBlocker() in
 *    src/routes/staff.js. ClearToClosePanel already draws exactly this list; it
 *    is just buried inside "File overview" and only ever showed the
 *    clear-to-close half of a payload that also carries the funding half.
 *  - The ageing chips are likewise already computed and already on the wire:
 *    every checklist row arrives with daysOpen / agingBucket / overdue /
 *    overdueBy (src/routes/staff.js, "#191 activation 2") and the front end has
 *    never once read them. This is the first surface that does.
 *  - The full list is one click away, and ClearToClosePanel is untouched below.
 *
 * ADVISORIES ARE DELIBERATELY ABSENT. Owner-directed 2026-07-27: PILOT's
 * findings are never counted as outstanding and may never gate a file. They
 * keep their own clearly-labelled home further down; putting one in a card
 * titled "what needs you next" would undo that on the most prominent surface on
 * the screen. This card reads ONLY `conditions` and `gates`.
 *
 * No new request, no new state on the server, no new AI spend.
 */

const SHOWN = 6;   // enough to act on; the rest is one click away

/* The ageing chip. Only says something when there is something to say: a fresh
   item gets no chip at all, so the ones that have gone stale are the only thing
   with colour on the row. */
function AgeChip({ row }) {
  if (row.overdue) {
    const by = Number.isFinite(row.overdueBy) ? row.overdueBy : null;
    return <span className="nx-age late" title={`Open ${row.daysOpen} days`}>
      {by ? `${by} day${by === 1 ? '' : 's'} overdue` : 'Overdue'}
    </span>;
  }
  if (Number.isFinite(row.daysOpen) && row.daysOpen >= 7) {
    return <span className="nx-age warn" title="How long this has been open">{row.daysOpen} days open</span>;
  }
  return null;
}

export default function NextUpPanel({ gating, items, conds }) {
  const [showAll, setShowAll] = useState(false);
  if (!gating) return null;

  // Grouping, ageing and ordering all live in lib/next-up.js so they can be
  // tested without a browser (scripts/test-next-up-pure.js).
  const { holding, next, all, overdue: nOverdue } = buildNextUp(gating, items, conds);

  if (all.length === 0) {
    return (
      <div className="panel nx-panel nx-clear" id="next-up">
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <span className="nx-tick" aria-hidden="true">✓</span>
          <div>
            <b style={{ color: '#141B22' }}>Nothing needs you right now.</b>
            <div className="muted small">Every condition and gate on this file is cleared — for clear-to-close and for funding.</div>
          </div>
        </div>
      </div>
    );
  }

  const rows = showAll ? all : all.slice(0, SHOWN);

  return (
    <div className="panel nx-panel" id="next-up">
      <div className="nx-head">
        <h3 className="nx-title">What needs you next</h3>
        <div className="spacer" />
        {holding.length > 0 && <span className="nx-count holding">{holding.length} holding this file</span>}
        {next.length > 0 && <span className="nx-count">{next.length} before funding</span>}
        {nOverdue > 0 && <span className="nx-count late">{nOverdue} overdue</span>}
      </div>
      <p className="nx-sub">
        Worst first. <strong>Go fix →</strong> opens the exact section that clears it.
      </p>

      <div className="nx-list">
        {rows.map((r) => (
          <div className={`nx-item${r.overdue ? ' is-late' : ''}`} key={`${r.kind}-${r.id}`}>
            <span className={`dot ${r.overdue ? 'cond-issue' : r.kind === 'gate' ? 'cond-received' : 'cond-requested'}`} aria-hidden="true" />
            <div className="nx-body">
              <div className="nx-item-title">
                {r.title}
                {r.kind === 'gate' && <span className="nx-tag" title="A sign-off that holds the file until it is done">gate</span>}
              </div>
              <div className="nx-why">{r.reason}</div>
            </div>
            <AgeChip row={r} />
            <button className="btn ghost small nx-go" onClick={() => goToSection(r.section, r.condTab)}
              title="Open the section that clears this item">Go fix →</button>
          </div>
        ))}
      </div>

      {all.length > SHOWN && (
        <button type="button" className="btn link small nx-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show everything (${all.length})`}
        </button>
      )}
    </div>
  );
}
