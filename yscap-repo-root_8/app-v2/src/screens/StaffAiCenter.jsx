import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import StaffInsightsDashboard from './StaffInsightsDashboard.jsx';
import StaffFindingEscalations from './StaffFindingEscalations.jsx';
import StaffTrainingProposals from './StaffTrainingProposals.jsx';
import StaffAiAdminInbox from './StaffAiAdminInbox.jsx';
import StaffLabelingConsole from './StaffLabelingConsole.jsx';
import StaffAiSilencedCodes from './StaffAiSilencedCodes.jsx';

/**
 * AI Command Center — ONE place for everything about PILOT's AI (owner-directed 2026-07-24:
 * "so many sections to train the AI… one nice redesigned modern screen where everything talks
 * to each other"). Phase 1: a tab shell that EMBEDS the existing self-contained screens as-is
 * (no rewrite) so the admin stops hopping between 5 separate menu items. Each tab carries a
 * plain-language, one-line "what this is" so a non-developer knows what they're looking at.
 * Deep links still work: /internal/ai?tab=training (etc.), and the old routes redirect here.
 */

const TABS = [
  { key: 'overview', label: 'Overview', blurb: 'The big picture — everything PILOT flagged across every file.', min: 'admin', Comp: StaffInsightsDashboard },
  { key: 'findings', label: 'Findings to review', blurb: 'Findings a teammate could not decide and sent up for a second opinion.', min: 'admin', Comp: StaffFindingEscalations },
  { key: 'training', label: 'Teach PILOT', blurb: 'Improvements PILOT learned from your corrections — approve, quietly test, or turn on.', min: 'admin', Comp: StaffTrainingProposals },
  { key: 'inbox', label: 'PILOT’s questions', blurb: 'When PILOT is unsure it asks here — your answer teaches it.', min: 'super_admin', Comp: StaffAiAdminInbox },
  { key: 'labeling', label: 'Label documents', blurb: 'Tag past documents so PILOT reads new ones more accurately.', min: 'super_admin', Comp: StaffLabelingConsole },
  { key: 'silenced', label: 'Muted alerts', blurb: 'Alert types you told PILOT to stop showing across all files.', min: 'super_admin', Comp: StaffAiSilencedCodes },
];

function allowed(min, role) {
  if (role === 'super_admin') return true;
  if (min === 'admin') return role === 'admin';
  return false; // super_admin-only tab, non-super role
}

export default function StaffAiCenter() {
  const { role } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => allowed(t.min, role));
  if (!tabs.length) {
    return <div className="page"><div className="notice">Admin only. The AI Command Center shows what PILOT sees and how it’s trained.</div></div>;
  }
  const requested = params.get('tab');
  const active = tabs.find((t) => t.key === requested) || tabs[0];
  const Comp = active.Comp;

  return (
    <>
      <div className="page" style={{ paddingBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
          <h2 style={{ margin: 0 }}>AI Command Center</h2>
          <span style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>One place to see, review, and teach PILOT’s AI</span>
        </div>
        {/* Tab bar */}
        <div role="tablist" aria-label="AI Command Center sections"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, borderBottom: '1px solid var(--line,#E4DECF)', paddingBottom: 0 }}>
          {tabs.map((t) => {
            const on = t.key === active.key;
            return (
              <button key={t.key} role="tab" aria-selected={on}
                onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t.key); return n; }, { replace: true })}
                title={t.blurb}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: '8px 12px', fontSize: 13, fontWeight: on ? 800 : 600,
                  color: on ? 'var(--ink,#141B22)' : 'var(--muted,#4B585C)',
                  borderBottom: on ? '2px solid var(--gold,#AE8746)' : '2px solid transparent',
                  marginBottom: -1,
                }}>
                {t.label}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 8 }}>{active.blurb}</div>
      </div>
      {/* The embedded screen brings its own .page wrapper. */}
      <Comp />
    </>
  );
}
