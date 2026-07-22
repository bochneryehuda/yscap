import React from 'react';
import { goToSection } from './FileSections.jsx';

/* One clear view of EVERYTHING still standing between this file and clear-to-close
   (owner-directed: "we should have somewhere a clear view what is the outstanding
   to be able to clear to close the file"). It lists each blocking condition/gate
   with a plain-language WHY, and a one-click "Go fix →" that expands + scrolls to
   the exact section that resolves it. The "N to clear" counters elsewhere on the
   file scroll here. Data comes straight from GET …/gating (clear_to_close). */
export default function ClearToClosePanel({ gating }) {
  const g = (gating && gating.clear_to_close) || null;
  if (!g) return null;
  const items = [...(g.conditions || []), ...(g.gates || [])];

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
      </div>
    );
  }

  return (
    <div className="panel ctc-panel" id="ctc-outstanding">
      <div className="row" style={{ alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>What&apos;s left to clear to close</h3>
        <div className="spacer" />
        <span className="pill warn">{items.length} outstanding</span>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
        Each item below is blocking clear-to-close. Click <strong>Go fix →</strong> to jump straight to the section that clears it.
      </p>
      <div className="ctc-list">
        {items.map((it) => {
          const isAiAdvisory = it.source === 'ai_suggestion';
          return (
            <div className="ctc-item" key={`${it.kind}-${it.id}`} style={isAiAdvisory ? { background: 'var(--amber-bg,#F6EEDD)' } : undefined}>
              <span className="dot outstanding" style={{ marginTop: 5, flex: 'none', color: isAiAdvisory ? 'var(--amber,#B7791F)' : undefined }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ctc-item-title">
                  {it.title}
                  {it.kind === 'gate' && <span className="pill" style={{ marginLeft: 8, borderColor: 'var(--gold)', color: 'var(--gold)' }}>gate</span>}
                  {isAiAdvisory && <span className="pill" style={{ marginLeft: 8, borderColor: 'var(--amber,#B7791F)', color: 'var(--amber,#B7791F)' }}>AI advisory</span>}
                </div>
                <div className="muted small">{it.reason}</div>
              </div>
              <button className="btn ghost small" style={{ flex: 'none' }} onClick={() => goToSection(it.section, it.condTab)}
                title={isAiAdvisory ? 'Open the AI Findings panel to review or dismiss' : 'Open the section that clears this item'}>
                {isAiAdvisory ? 'Review →' : 'Go fix →'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
