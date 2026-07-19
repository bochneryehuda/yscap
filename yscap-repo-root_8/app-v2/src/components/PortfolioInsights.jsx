import React from 'react';

/* Portfolio insights for the staff draws dashboard. Two honest, data-driven reads built
   entirely from the /portfolio response (no fabricated numbers):
   1) Released-vs-remaining EXPOSURE by project — a horizontal part-to-whole bar per file,
      sorted by outstanding exposure, so the desk sees where capital is committed and how
      far each project has drawn down.
   2) An ATTENTION breakdown — the early-warning monitor's flagged files grouped by reason,
      so nothing that needs a nudge is buried.
   Marks are thin, the track is recessive, values are labeled directly, and the two encodings
   (teal = released, neutral track = remaining) are distinct and legended. */

const usd = (c) => '$' + Math.round((Number(c) || 0) / 100).toLocaleString('en-US');
const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

// Friendly labels for the monitor's alert codes (unknown codes degrade to a prettified string).
const ALERT_LABELS = {
  stale: 'No update in a while',
  no_draw: 'No draw activity',
  behind_pace: 'Behind schedule',
  pacing: 'Behind schedule',
  ahead_pace: 'Drawing fast',
  overdrawn: 'Drawn past budget',
  past_maturity: 'Past maturity',
  wire_overdue: 'Release overdue',
  overdue_wire: 'Release overdue',
  high_risk: 'Flagged high-risk',
};
const alertLabel = (code) => ALERT_LABELS[code] || String(code || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export default function PortfolioInsights({ portfolio }) {
  if (!portfolio || !Array.isArray(portfolio.files) || portfolio.files.length === 0) return null;
  const files = portfolio.files.filter((f) => (Number(f.budget_cents) || 0) > 0);
  if (files.length === 0) return null;

  // rank by outstanding exposure (remaining), then draw the top slice; note any tail.
  const ranked = [...files].sort((a, b) => (Number(b.remaining_cents) || 0) - (Number(a.remaining_cents) || 0));
  const TOP = 8;
  const shown = ranked.slice(0, TOP);
  const tail = ranked.length - shown.length;

  const totals = portfolio.totals || {};
  const codes = totals.alert_codes && typeof totals.alert_codes === 'object' ? totals.alert_codes : {};
  const codeEntries = Object.entries(codes).map(([c, n]) => [c, Number(n) || 0]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></svg></span>
          <div>
            <h3>Portfolio insights</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Released vs. remaining exposure by project — where capital is committed and how far each has drawn.</div>
          </div>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <span className="dd-leg-k" style={{ fontSize: 12 }}><span className="sw" style={{ background: 'var(--teal)' }} />Released</span>
          <span className="dd-leg-k" style={{ fontSize: 12 }}><span className="sw" style={{ background: 'var(--ink-3)' }} />Remaining</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 6 }}>
        {shown.map((f) => {
          const budget = Number(f.budget_cents) || 0;
          const drawn = Number(f.drawn_cents) || 0;
          const remaining = Number(f.remaining_cents);
          const rem = Number.isFinite(remaining) ? remaining : Math.max(0, budget - drawn);
          const pct = clampPct(f.pct_complete != null ? f.pct_complete : (budget > 0 ? (drawn / budget) * 100 : 0));
          const label = f.ys_loan_number || f.address || 'File';
          return (
            <div key={f.application_id}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'baseline', marginBottom: 5 }}>
                <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }} title={f.address || label}>{label}</span>
                <span className="dd-sub" style={{ fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
                  <b style={{ color: 'var(--teal-br)' }}>{usd(drawn)}</b> drawn · {usd(rem)} left · {pct}%
                </span>
              </div>
              <div className="dd-meter" style={{ height: 10 }} role="img" aria-label={`${label}: ${pct}% released, ${usd(rem)} remaining`}>
                <i style={{ width: pct + '%' }} />
              </div>
            </div>
          );
        })}
      </div>
      {tail > 0 && <div className="dd-sub" style={{ marginTop: 10 }}>+{tail} more project{tail === 1 ? '' : 's'} with smaller exposure.</div>}

      {codeEntries.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <div className="dd-field-l" style={{ textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 11, marginBottom: 10 }}>
            {(() => { const flaggedN = Number(totals.flagged) || codeEntries.reduce((s, [, n]) => s + n, 0); return `Needs attention · ${flaggedN} file${flaggedN === 1 ? '' : 's'} flagged`; })()}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {codeEntries.map(([code, n]) => (
              <span key={code} className="row" style={{ gap: 8, alignItems: 'center', background: 'var(--warning-soft)', border: '1px solid var(--line)', borderRadius: 999, padding: '5px 12px' }}>
                <span style={{ display: 'inline-grid', placeItems: 'center', minWidth: 20, height: 20, borderRadius: 999, background: 'var(--warning)', color: '#fff', fontSize: 11, fontWeight: 800, padding: '0 5px' }}>{n}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>{alertLabel(code)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
