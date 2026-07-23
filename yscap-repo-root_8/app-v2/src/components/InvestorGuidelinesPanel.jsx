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
  const [showDeferred, setShowDeferred] = useState(false);

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
  const summary = (d && d.summary) || { applicable: 0, satisfied: 0, outstanding: 0, conflicts: 0, deferred: 0, toPost: 0 };
  const noteBuyer = (d && d.noteBuyer) || {};
  const conflicts = verdicts.filter((c) => c.verdict === 'conflicts');
  const outstanding = verdicts.filter((c) => c.verdict === 'outstanding');
  const satisfied = verdicts.filter((c) => c.verdict === 'satisfied');
  const deferred = verdicts.filter((c) => c.verdict === 'deferred');
  const nothing = !d || d.empty || verdicts.length === 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <p style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', margin: 0, flex: 1, minWidth: 220 }}>
          How this file measures up against <strong>{noteBuyer.name || 'the note buyer'}</strong>'s own guidelines —
          what's met, what's still needed, and anything that conflicts with their rules. This is a read-out; it decides nothing on its own.
        </p>
        <button className="btn ghost small" disabled={loading} onClick={load}>{loading ? '…' : 'Refresh'}</button>
      </div>

      {loading && !d && <div className="muted" style={{ fontSize: 12 }}>Loading…</div>}

      {!loading && nothing && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {noteBuyer.name
            ? `No investor guideline conditions apply to this file yet for ${noteBuyer.name}.`
            : 'Set the note buyer on this file to see their guideline conditions here.'}
        </div>
      )}

      {!nothing && (
        <>
          {/* headline + tallies */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{d.headline}</span>
            {d.generatedAt && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted,#4B585C)' }}>as of {fmtAgo(d.generatedAt)}</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {[
              ['conflicts', summary.conflicts, VERDICT.conflicts],
              ['still needed', summary.outstanding, VERDICT.outstanding],
              ['met', summary.satisfied, VERDICT.satisfied],
              ['to post', summary.toPost, VERDICT.outstanding],
            ].map(([label, n, st], i) => (
              <span key={i} style={{ fontSize: 11.5, fontWeight: 700, color: st.fg, background: st.bg, border: `1px solid ${st.fg}33`, borderRadius: 8, padding: '3px 10px' }}>
                {n} {label}
              </span>
            ))}
          </div>

          {/* conflicts first — the ones a human must look at */}
          {conflicts.length > 0 && (
            <div style={{ marginBottom: 14, border: '1px solid var(--crit,#B4483C)33', borderLeft: '4px solid var(--crit,#B4483C)', borderRadius: 10, padding: '4px 14px', background: 'var(--crit-bg,#F6E7E4)' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--crit,#B4483C)', margin: '8px 0 2px' }}>Conflicts with the note buyer's guideline</div>
              {conflicts.map((c, i) => <CondRow key={c.cond_no} c={c} first={i === 0} />)}
            </div>
          )}

          {/* still needed */}
          {outstanding.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#4B585C)', marginBottom: 4 }}>Still needed for this note buyer</div>
              {outstanding.map((c, i) => <CondRow key={c.cond_no} c={c} first={i === 0} />)}
            </div>
          )}

          {/* met — collapsed */}
          {satisfied.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <button onClick={() => setShowMet((v) => !v)} style={{ background: 'none', border: 'none', color: 'var(--teal,#2F7F86)', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
                {showMet ? 'Hide' : 'Show'} {satisfied.length} already met
              </button>
              {showMet && <div style={{ marginTop: 4 }}>{satisfied.map((c, i) => <CondRow key={c.cond_no} c={c} first={i === 0} />)}</div>}
            </div>
          )}

          {/* deferred — attorney/closing + post-closing, separate + muted */}
          {deferred.length > 0 && (
            <div>
              <button onClick={() => setShowDeferred((v) => !v)} style={{ background: 'none', border: 'none', color: 'var(--teal,#2F7F86)', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
                {showDeferred ? 'Hide' : 'Show'} {deferred.length} held for the closing / attorney stage
              </button>
              {showDeferred && <div style={{ marginTop: 4, opacity: 0.85 }}>{deferred.map((c, i) => <CondRow key={c.cond_no} c={c} first={i === 0} />)}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
