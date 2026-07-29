import React from 'react';
import { goToSection } from './FileSections.jsx';

/* One clear view of EVERYTHING still standing between this file and clear-to-close
   (owner-directed: "we should have somewhere a clear view what is the outstanding
   to be able to clear to close the file"). It lists each blocking condition/gate
   with a plain-language WHY, and a one-click "Go fix →" that expands + scrolls to
   the exact section that resolves it. The "N to clear" counters elsewhere on the
   file scroll here. Data comes straight from GET …/gating (clear_to_close).

   TWO LISTS, ON PURPOSE (owner-directed 2026-07-27: "it should not say that it's an
   outstanding thing before CTC"). `conditions` + `gates` are real work that holds
   the file. `advisories` is everything PILOT raised — shown, never counted as
   outstanding, and never part of "ready". A file with nothing but advisories reads
   CLEAR TO CLOSE, with PILOT's notes underneath for whoever wants to look. */
export default function ClearToClosePanel({ gating }) {
  const g = (gating && gating.clear_to_close) || null;
  if (!g) return null;
  const items = [...(g.conditions || []), ...(g.gates || [])];
  const advisories = g.advisories || [];

  if (g.ready || items.length === 0) {
    return (
      <div className="panel ctc-panel ctc-ready" id="ctc-outstanding">
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <span className="ctc-tick" aria-hidden="true">✓</span>
          <div>
            <b>Clear to close — nothing outstanding.</b>
            <div className="muted small">Every prior-to-docs condition and gate on this file is cleared. You can advance it to Clear to close.</div>
          </div>
        </div>
        <Advisories rows={advisories} />
      </div>
    );
  }

  return (
    <div className="panel ctc-panel" id="ctc-outstanding">
      <div className="row" style={{ alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <h3 style={{ margin: 0, color: '#141B22' }}>What&apos;s left to clear to close</h3>
        <div className="spacer" />
        <span className="pill warn">{items.length} outstanding</span>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
        Each item below is blocking clear-to-close. Click <strong>Go fix →</strong> to jump straight to the section that clears it.
      </p>
      <div className="ctc-list">
        {items.map((it) => (
          <div className="ctc-item" key={`${it.kind}-${it.id}`}>
            <span className="dot outstanding" style={{ marginTop: 5, flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ctc-item-title" style={{ color: '#141B22' }}>
                {it.title}
                {it.kind === 'gate' && <span className="pill" style={{ marginLeft: 8, borderColor: 'var(--gold)', color: 'var(--gold)' }}>gate</span>}
              </div>
              <div className="muted small">{it.reason}</div>
            </div>
            <button className="btn ghost small" style={{ flex: 'none' }} onClick={() => goToSection(it.section, it.condTab)}
              title="Open the section that clears this item">Go fix →</button>
          </div>
        ))}
      </div>
      <Advisories rows={advisories} />
    </div>
  );
}

/* PILOT's notes. Deliberately BELOW the outstanding list, with its own heading that
   says out loud that none of it holds the file up — so nobody reads an AI finding as
   a blocker again. Nothing here is counted in "N outstanding" or in `ready`. */
function Advisories({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #EAE4D7' }}>
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
