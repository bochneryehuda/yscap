import React from 'react';
import { goToSection } from './FileSections.jsx';
import { buildNextUp } from '../lib/next-up.js';

/* WHAT'S LEFT ON THIS FILE — the ONE work list (owner-directed 2026-08-02).
 *
 * This replaces two panels that showed the same rows twice: "What needs you
 * next" (which floated ABOVE the room nav, before the file even started) and
 * "What's left to clear to close" (inside the Overview). The owner: "It's a
 * little different. I'm trying to understand the difference … those should be
 * merged together, not two separate sections. The top part … takes away of the
 * cleanness of the file. It should only be one section, under the overview."
 *
 * They were never meant to disagree — both read the SAME `gating` payload — but
 * they showed different SLICES of it, so the same file honestly reported "7
 * outstanding" in one card and "7 holding + 1 before funding + 5 overdue" in the
 * other, with one list carrying due dates and the other not. Two lists of the
 * same work is worse than either list alone: it reads as two different answers.
 *
 * The merge keeps every part that was doing real work:
 *  - the ORDERING + AGEING brain (lib/next-up.js — worst first, overdue chips),
 *    which only the top card had;
 *  - the FUNDING half of the payload, which only the top card rendered;
 *  - PILOT's advisory notes, which only the Overview card rendered;
 *  - the permanent #ctc-outstanding anchor every deep link and the header's
 *    "N to clear before CTC" badge jump to (sec-overview owns it in
 *    lib/stations.js — see the Seven Rooms audit). #next-up is kept as an alias
 *    so a bookmark to the retired card still lands.
 *
 * THE TWO GROUPS STAY LABELLED, and that is the point of the merge rather than
 * a simple concatenation: a funding item must never read as something holding
 * clear-to-close. Same discipline as the advisories below — see the note there.
 */

/* The ageing chip. Only says something when there IS something to say: a fresh
   item gets no chip, so the stale ones are the only thing with colour. */
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

function WorkRow({ row }) {
  return (
    <div className={`nx-item${row.overdue ? ' is-late' : ''}`}>
      <span className={`dot ${row.overdue ? 'cond-issue' : row.kind === 'gate' ? 'cond-received' : 'cond-requested'}`} aria-hidden="true" />
      <div className="nx-body">
        <div className="nx-item-title">
          {row.title}
          {row.kind === 'gate' && <span className="nx-tag" title="A sign-off that holds the file until it is done">gate</span>}
        </div>
        <div className="nx-why">{row.reason}</div>
      </div>
      <AgeChip row={row} />
      <button className="btn ghost small nx-go" onClick={() => goToSection(row.section, row.condTab)}
        title="Open the section that clears this item">Go fix →</button>
    </div>
  );
}

/* A labelled group. The heading only appears when there is a SECOND group to
   tell it apart from — one list needs no label, two do. */
function Group({ rows, heading, note }) {
  if (!rows.length) return null;
  return (
    <div className="nx-group">
      {heading && <div className="nx-group-h">{heading}</div>}
      {note && <p className="nx-group-note">{note}</p>}
      <div className="nx-list">{rows.map((r) => <WorkRow row={r} key={`${r.kind}-${r.id}`} />)}</div>
    </div>
  );
}

/* PILOT's notes. Deliberately LAST, with a heading that says out loud that none
   of it holds the file up — so nobody reads an AI finding as a blocker
   (owner-directed 2026-07-27). Never counted in any heading count, and never
   part of `ready`. */
function Advisories({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <div className="nx-advisories">
      <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <b style={{ color: '#141B22' }}>PILOT&apos;s notes — for your information</b>
        <span className="pill" style={{ borderColor: '#B7791F', color: '#B7791F' }}>advisory</span>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 8 }}>
        What PILOT flagged on this file. <strong>None of it holds up clear-to-close, signing off a condition, or sending a package</strong> — it is here to be read, not to block you.
      </p>
      <div className="ctc-list">
        {rows.map((it) => (
          <div className="ctc-item" key={`adv-${it.id}`} style={{ background: '#F6EEDD' }}>
            <span className="dot" style={{ marginTop: 5, flex: 'none', color: '#B7791F' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ctc-item-title" style={{ color: '#141B22' }}>{it.title}</div>
              <div className="muted small">{it.reason}</div>
            </div>
            <button className="btn ghost small" style={{ flex: 'none' }} onClick={() => goToSection(it.section, it.condTab)}
              title="Open the PILOT findings section">Review →</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function WhatsLeftPanel({ gating, items, conds }) {
  if (!gating) return null;

  const { holding, next, overdue: nOverdue } = buildNextUp(gating, items, conds);
  const advisories = (gating.clear_to_close || {}).advisories || [];
  const clear = holding.length === 0;

  /* Nothing to do at all — say so plainly and stop. */
  if (clear && !next.length && !advisories.length) {
    return (
      <div className="panel nx-panel nx-clear" id="ctc-outstanding">
        <span id="next-up" aria-hidden="true" />
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <span className="nx-tick" aria-hidden="true">✓</span>
          <div>
            <b style={{ color: '#141B22' }}>Nothing left on this file.</b>
            <div className="muted small">Every condition and gate is cleared — for clear-to-close and for funding.</div>
          </div>
        </div>
      </div>
    );
  }

  /* Two groups → label them. One → the counts in the heading already say which. */
  const twoGroups = next.length > 0;

  return (
    <div className={`panel nx-panel${clear ? ' nx-clear' : ''}`} id="ctc-outstanding">
      <span id="next-up" aria-hidden="true" />
      <div className="nx-head">
        <h3 className="nx-title">What&apos;s left on this file</h3>
        <div className="spacer" />
        {holding.length > 0 && <span className="nx-count holding">{holding.length} holding this file</span>}
        {next.length > 0 && <span className="nx-count">{next.length} before funding</span>}
        {nOverdue > 0 && <span className="nx-count late">{nOverdue} overdue</span>}
      </div>
      <p className="nx-sub">
        Worst first. <strong>Go fix →</strong> opens the exact section that clears it.
      </p>

      {clear && (
        <div className="row nx-cleared" style={{ alignItems: 'center', gap: 10 }}>
          <span className="ctc-tick" aria-hidden="true">✓</span>
          <div>
            <b style={{ color: '#141B22' }}>Clear to close — nothing outstanding.</b>
            <div className="muted small">Every prior-to-docs condition and gate is cleared. You can advance it to Clear to close.</div>
          </div>
        </div>
      )}

      <Group rows={holding} heading={twoGroups ? 'Holding clear to close' : null} />
      <Group rows={next} heading={twoGroups ? 'Before funding' : null}
        note={twoGroups ? 'These do not hold clear-to-close — they are needed before the loan funds.' : null} />
      <Advisories rows={advisories} />
    </div>
  );
}
