import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import StaffEscalations from './StaffEscalations.jsx';
import StaffExceptions from './StaffExceptions.jsx';
import StaffFindingEscalations from './StaffFindingEscalations.jsx';
import SyncReviews from './SyncReviews.jsx';
import StaffMyExceptions from './StaffMyExceptions.jsx';
import StaffTrackRecordReviews from './StaffTrackRecordReviews.jsx';

/**
 * Approvals — ONE place for everything waiting on a human decision (owner-directed
 * 2026-07-31: "a few boxes — manual escalations, exceptions, different kind of things
 * that I need to approve… batch it up into one section… switch tabs once we go into
 * that section to keep everything better cleaned up"). Mirrors the AI Command Center
 * pattern exactly: a thin tab shell that EMBEDS the existing self-contained screens
 * as-is (no rewrite), each tab with a plain-language one-liner and a live count badge.
 * Deep links still work: /internal/approvals?tab=exceptions (etc.), and the old
 * standalone routes redirect here PRESERVING their query string (StaffExceptions
 * reads ?app=<id> from location.search).
 */

const TABS = [
  { key: 'escalations', label: 'Manual / Escalations', blurb: 'Pricing outside the guidelines — manual programs, pricing overrides, counter-offers.', min: 'pricing', Comp: StaffEscalations },
  { key: 'exceptions', label: 'Exceptions', blurb: 'Every request to deviate from a loan policy — guaranty waivers, early sends, pricing exceptions, overrides.', min: 'pricing', Comp: StaffExceptions },
  { key: 'findings', label: 'Findings to review', blurb: 'Findings a teammate could not decide and sent up for a second opinion.', min: 'all', Comp: StaffFindingEscalations },
  { key: 'sync', label: 'Sync reviews', blurb: 'PILOT ⇄ ClickUp disagreements waiting for a human to pick a side.', min: 'all', Comp: SyncReviews },
  /* A deal a BORROWER typed onto their track record is self-reported until
     somebody reads the closing statement behind it (owner-directed 2026-08-03).
     It belongs here rather than in a nav link of its own: it is a queue waiting
     on a human decision, which is what this hub is. Open to every staff role —
     anyone can ask for a document or mark a line documentation-required; only a
     processor can VERIFY one, and the server enforces that, not the tab. */
  { key: 'track-record', label: 'Track record', blurb: 'Deals a borrower entered themselves, waiting for someone to verify them against the documents.', min: 'all', Comp: StaffTrackRecordReviews },
  { key: 'mine', label: 'My requests', blurb: 'Exception requests you raised — withdraw or track them here.', min: 'all', Comp: StaffMyExceptions },
];

// 'pricing' mirrors StaffLayout's escalation/exception nav gate EXACTLY
// (manage_pricing holders + super_admin); 'all' = every staff role.
function allowed(min, role, can) {
  if (min === 'pricing') return can('manage_pricing') || role === 'super_admin';
  return true;
}

export default function StaffApprovals() {
  const { role, can } = useAuth();
  const [params, setParams] = useSearchParams();
  // Live per-queue counts for the tab badges — the SAME endpoints the
  // StaffLayout nav badges poll, on the same 2-minute cadence.
  const [counts, setCounts] = useState({});
  useEffect(() => {
    // Unconditional effect (hooks order) — the manage_pricing gate lives INSIDE,
    // mirroring StaffLayout (~line 342), so an LO/processor never 403-spams the
    // admin-only escalation/exception count endpoints.
    let alive = true;
    const put = (key, n) => { if (alive) setCounts((c) => ({ ...c, [key]: n || 0 })); };
    const poll = () => {
      if (can('manage_pricing') || role === 'super_admin') {
        api.manualEscalationsCount().then((r) => put('escalations', (r && r.pendingCount) || 0)).catch(() => {});
        api.loanExceptionsCount().then((r) => put('exceptions', (r && r.pendingCount) || 0)).catch(() => {});
      }
      api.findingEscalationsCount().then((r) => put('findings', (r && r.pendingCount) || 0)).catch(() => {});
      api.get('/api/staff/sync-reviews/count').then((r) => put('sync', (r && r.open) || 0)).catch(() => {});
      api.myExceptionsCount().then((r) => put('mine', (r && r.openCount) || 0)).catch(() => {});
      api.staffTrackRecordReviewsCount().then((r) => put('track-record', (r && r.pending) || 0)).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 120000);
    return () => { alive = false; clearInterval(t); };
    // `can` is memoized on the permission list, so this re-runs once when perms
    // arrive — without it the gate would be frozen at its mount-time value.
  }, [can, role]);
  const tabs = TABS.filter((t) => allowed(t.min, role, can));
  if (!tabs.length) {
    // Unreachable in practice — tabs 3–5 are open to every staff role.
    return <div className="page"><div className="notice">Nothing here needs your approval.</div></div>;
  }
  const requested = params.get('tab');
  const active = tabs.find((t) => t.key === requested) || tabs[0];
  const Comp = active.Comp;

  return (
    <>
      <div className="page" style={{ paddingBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
          <h2 style={{ margin: 0 }}>Approvals</h2>
          <span style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>Everything waiting on a decision, in one place</span>
        </div>
        {/* Tab bar */}
        <div role="tablist" aria-label="Approvals sections"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, borderBottom: '1px solid var(--line,#E4DECF)', paddingBottom: 0 }}>
          {tabs.map((t) => {
            const on = t.key === active.key;
            const n = counts[t.key] || 0;
            return (
              <button key={t.key} role="tab" aria-selected={on}
                onClick={() => setParams((p) => { const x = new URLSearchParams(p); x.set('tab', t.key); return x; }, { replace: true })}
                title={t.blurb}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: '8px 12px', fontSize: 13, fontWeight: on ? 800 : 600,
                  color: on ? '#141B22' : 'var(--muted,#4B585C)',
                  borderBottom: on ? '2px solid var(--gold,#AE8746)' : '2px solid transparent',
                  marginBottom: -1,
                }}>
                {t.label}
                {n > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, background: 'var(--gold,#AE8746)', color: '#fff',
                    borderRadius: 8, padding: '0 6px', marginLeft: 6 }}>{n > 99 ? '99+' : n}</span>
                )}
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
