import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

/**
 * ISG-4 — Investor-Specific Soft Guidelines section. Reads the note-buyer vetting desk
 * (GET /api/underwriting/:appId/investor-guidelines) and shows, for the file's NOTE BUYER,
 * every applicable condition guideline judged against the file: met / still needed /
 * CONFLICTS with the guideline (with the exact number), plus the conditions to suggest
 * posting and the ones held for closing. READ-ONLY / advisory — it posts nothing, blocks
 * nothing, and touches no frozen number. Staff-only surface (note-buyer names are fine here).
 */

function fmtAgo(iso) {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  } catch (_e) { return ''; }
}

const VERDICT = {
  conflicts:   { fg: 'var(--crit,#B4483C)', bg: 'var(--crit-bg,#F6E7E4)', label: 'Conflicts with guideline' },
  outstanding: { fg: 'var(--amber,#B7791F)', bg: 'var(--amber-bg,#F6EEDD)', label: 'Still needed' },
  satisfied:   { fg: 'var(--good,#3F7A5B)', bg: 'rgba(63,122,91,.10)', label: 'Met' },
  deferred:    { fg: 'var(--muted,#4B585C)', bg: 'var(--paper,#F6F3EC)', label: 'Held for closing' },
};

function VerdictChip({ verdict, suggestPost }) {
  const s = VERDICT[verdict] || VERDICT.outstanding;
  const label = suggestPost && verdict === 'outstanding' ? 'Suggest posting' : s.label;
  return (
    <span style={{ fontSize: 10.5, fontWeight: 800, color: s.fg, background: s.bg, border: `1px solid ${s.fg}44`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

// one condition row — verdict + name + plain reason + the note-buyer checks (to verify / conflict / ok).
function CondRow({ c, first }) {
  const checks = Array.isArray(c.checks) ? c.checks : [];
  return (
    <div style={{ padding: '8px 0', borderTop: first ? 'none' : '1px solid var(--line,#E7E1D3)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ marginTop: 1 }}><VerdictChip verdict={c.verdict} suggestPost={c.suggestPost} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</div>
          {c.reason && <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 1 }}>{c.reason}</div>}
          {c.required_evidence && (c.verdict === 'outstanding' || c.verdict === 'deferred') && (
            <div style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', marginTop: 3 }}>
              <span style={{ fontWeight: 700 }}>To clear: </span>{c.required_evidence}
            </div>
          )}
          {checks.length > 0 && (
            <ul style={{ margin: '5px 0 0', paddingLeft: 16 }}>
              {checks.map((k, i) => {
                const fg = k.status === 'conflict' ? 'var(--crit,#B4483C)'
                  : k.status === 'ok' ? 'var(--good,#3F7A5B)' : 'var(--muted,#4B585C)';
                const mark = k.status === 'conflict' ? '✕' : k.status === 'ok' ? '✓' : '•';
                return (
                  <li key={i} style={{ fontSize: 11.5, color: fg, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700 }}>{mark} </span>
                    {k.detail || k.text}
                    {k.note_buyer_specific && <span style={{ color: 'var(--muted,#4B585C)', fontWeight: 700 }}> · this buyer's limit</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function InvestorGuidelinesPanel({ appId }) {
  const [loading, setLoading] = useState(false);
  const [desk, setDesk] = useState(null);
  const [showMet, setShowMet] = useState(false);

  const load = useCallback(() => {
    if (!appId) return Promise.resolve();
    setLoading(true);
    return api.fileInvestorGuidelines(appId)
      .then((d) => setDesk((d && d.desk) || { empty: true }))
      .catch(() => setDesk({ empty: true }))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  const d = desk;
  const verdicts = (d && Array.isArray(d.verdicts)) ? d.verdicts : [];
  const summary = (d && d.summary) || { applicable: 0, satisfied: 0, outstanding: 0, conflicts: 0, deferred: 0, toPost: 0, unhappy: 0, coverageGaps: 0, fatal: 0 };
  const noteBuyer = (d && d.noteBuyer) || {};
  // OVERLAY view (owner-directed 2026-07-23): lead with whether the note buyer is happy with the
  // file AS-IS, and surface ONLY what they are not happy about (a conflict, or a required condition
  // that is missing entirely). Everything else is quiet — an open condition is fine, it will be
  // checked when its document arrives. The full checked list is available but collapsed.
  const unhappy = (d && Array.isArray(d.unhappy)) ? d.unhappy : [];
  const happy = !!(d && d.happy);
  const nothing = !d || d.empty || verdicts.length === 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <p style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: 0, flex: 1, minWidth: 220 }}>
          A backend read of the file against <strong>{noteBuyer.name || 'the note buyer'}</strong>'s own guidelines. It stays
          quiet unless the note buyer would <strong>not</strong> be happy with the file as it stands — a value that conflicts
          with their rules, or a requirement with no condition on the file at all. Advisory; it decides nothing.
        </p>
        <button className="btn ghost small" disabled={loading} onClick={load}>{loading ? '…' : 'Refresh'}</button>
      </div>

      {loading && !d && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}

      {!loading && nothing && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {noteBuyer.name
            ? `No investor guideline conditions apply to this file yet for ${noteBuyer.name}.`
            : 'Set the note buyer on this file to see their guideline read here.'}
        </div>
      )}

      {!nothing && (
        <>
          {/* the headline verdict — happy vs not happy */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12,
            border: `1px solid ${happy ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)'}44`,
            borderLeft: `4px solid ${happy ? 'var(--good,#3F7A5B)' : 'var(--crit,#B4483C)'}`,
            background: happy ? 'rgba(63,122,91,.08)' : 'var(--crit-bg,#F6E7E4)', borderRadius: 10, padding: '9px 14px' }}>
            <span style={{ fontSize: 15 }}>{happy ? '✓' : '⚠'}</span>
            <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 200 }}>{d.headline}</span>
            {d.generatedAt && <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>as of {fmtAgo(d.generatedAt)}</span>}
          </div>

          {/* the ONLY thing surfaced: what the note buyer is not happy about */}
          {unhappy.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {unhappy.map((u, i) => {
                const fatal = u.severity === 'fatal';
                const fg = fatal ? 'var(--crit,#B4483C)' : 'var(--amber,#B7791F)';
                const bg = fatal ? 'var(--crit-bg,#F6E7E4)' : 'var(--amber-bg,#F6EEDD)';
                const kind = u.flag === 'coverage_gap' ? 'No condition on the file' : 'Conflicts with the guideline';
                return (
                  <div key={`${u.cond_no}-${i}`} style={{ marginBottom: 8, border: `1px solid ${fg}44`, borderLeft: `4px solid ${fg}`, borderRadius: 10, padding: '8px 14px', background: bg }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, color: fg, textTransform: 'uppercase', letterSpacing: '.05em' }}>{fatal ? '● ' : '○ '}{kind}</span>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{u.name}</span>
                    </div>
                    {u.flag === 'coverage_gap' && (
                      <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 2 }}>
                        {noteBuyer.name || 'The note buyer'} requires this, but there is no condition on the file for it{fatal ? ' — post one now.' : '.'}
                        {u.required_evidence ? <span> <span style={{ fontWeight: 700 }}>Needs:</span> {u.required_evidence}</span> : null}
                      </div>
                    )}
                    {u.flag === 'conflict' && (
                      <>
                        {u.reason && <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', marginTop: 2 }}>{u.reason}</div>}
                        {Array.isArray(u.checks) && u.checks.filter((k) => k.status === 'conflict').map((k, j) => (
                          <div key={j} style={{ fontSize: 11.5, color: fg, marginTop: 3, fontWeight: 600 }}>✕ {k.detail || k.text}</div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* everything checked — collapsed, de-emphasized (open conditions are fine, no need to nag) */}
          <div>
            <button onClick={() => setShowMet((v) => !v)} style={{ background: 'none', border: 'none', color: 'var(--teal,#2F7F86)', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
              {showMet ? 'Hide' : 'Show'} everything checked ({summary.applicable} against {noteBuyer.name || 'the note buyer'}: {summary.satisfied} met, {summary.outstanding} still coming in{summary.deferred ? `, ${summary.deferred} held for closing` : ''})
            </button>
            {showMet && (
              <div style={{ marginTop: 6, opacity: 0.9 }}>
                {verdicts.map((c, i) => <CondRow key={c.cond_no} c={c} first={i === 0} />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
