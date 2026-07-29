import React, { useEffect, useState } from 'react';
import StaticToolFrame from '../components/StaticToolFrame.jsx';

/* Investor Suite inside PILOT (owner-directed 2026-07-29): the same set of
   tools the public marketing "Investor Suite" (web/v2/suite.html) offers —
   the Term Sheet generator, Rehab Budget / Scope of Work, Track Record, the
   loan application, and every analyzer — available to STAFF from their own
   left-side nav, so they never have to leave the portal to build a term sheet
   or run a deal. Each tool is the SAME frozen static page served at
   /tools/*.html; we just host it inside the portal (StaticToolFrame) full
   screen. No engine numbers change — this is pure access. */

// Mirrors the three sections of the marketing suite, in the same order.
const GROUPS = [
  {
    title: 'Structure & apply',
    sub: 'Build the deal — a term sheet, the scope of work, the track record, or the application.',
    tools: [
      { slug: 'term-sheet', name: 'Term Sheet Studio', desc: 'Price a loan and generate a full term sheet — Standard or Gold.', icon: '📄' },
      { slug: 'rehab-budget', name: 'Rehab Budget', desc: 'Build the Scope of Work line by line, with the contingency baked in.', icon: '🔨' },
      { slug: 'track-record', name: 'Track Record', desc: "Capture the borrower's completed projects and experience.", icon: '🏘️' },
      { slug: 'loan-application', name: 'Loan Application', desc: 'The full RTL loan application form.', icon: '📝' },
    ],
  },
  {
    title: 'Analyze the deal',
    sub: 'Run the numbers before it becomes a file.',
    tools: [
      { slug: 'deal-analyzer', name: 'Deal Analyzer', desc: 'Full buy-side underwriting for a rental or a flip.', icon: '📊' },
      { slug: 'flip-analyzer', name: 'Flip Analyzer', desc: 'Fix-and-flip profit, costs and returns.', icon: '💸' },
      { slug: 'qualifier-pro', name: 'Qualifier Pro', desc: 'DSCR & mortgage qualifier.', icon: '✅' },
      { slug: 'portfolio-tracker', name: 'Portfolio Tracker', desc: 'Track a whole portfolio of properties.', icon: '📁' },
    ],
  },
  {
    title: 'Refinance & equity',
    sub: 'Compare paths on an existing property.',
    tools: [
      { slug: 'equity-compare', name: 'Equity Compare', desc: 'HELOC vs. cash-out refinance.', icon: '⚖️' },
      { slug: 'ratesaver', name: 'RateSaver', desc: 'Rate buydown break-even.', icon: '📉' },
      { slug: 'refi-breakpoint', name: 'Refi BreakPoint', desc: 'Refinance break-even point.', icon: '🔁' },
    ],
  },
];

const TOOL_BASE = '/tools/';   // same-origin static tools (frozen engines)

export default function StaffInvestorSuite() {
  const [open, setOpen] = useState(null);   // the tool being viewed full-screen, or null

  // Lock the page scroll while the full-screen tool is open.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (open) {
    const url = `${TOOL_BASE}${open.slug}.html?embed=1`;
    return (
      <div className="isuite-full">
        <div className="isuite-full-head">
          <button className="btn ghost small" onClick={() => setOpen(null)} aria-label="Back to the Investor Suite">← Back to the suite</button>
          <strong style={{ fontSize: 15 }}>{open.name}</strong>
          <div style={{ flex: 1 }} />
          <a className="btn ghost small" href={url} target="_blank" rel="noopener noreferrer" title="Open this tool in a new browser tab">Open in a new tab ↗</a>
        </div>
        <div className="isuite-full-body">
          <StaticToolFrame key={open.slug} src={url} title={open.name} fill />
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>Investor Suite</h1>
      </div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 18 }}>
        Every tool from the YS Capital Investor Suite, right here in PILOT — build a term sheet, a scope of work,
        a track record, or run a deal without leaving the portal.
      </p>
      {GROUPS.map((g) => (
        <section key={g.title} style={{ marginBottom: 26 }}>
          <div className="isuite-group-h">
            <div className="isuite-group-title">{g.title}</div>
            <div className="isuite-group-sub">{g.sub}</div>
          </div>
          <div className="isuite-grid">
            {g.tools.map((t) => (
              <button key={t.slug} type="button" className="isuite-card" onClick={() => setOpen(t)}
                title={`Open ${t.name}`}>
                <span className="isuite-card-icon" aria-hidden="true">{t.icon}</span>
                <span className="isuite-card-name">{t.name}</span>
                <span className="isuite-card-desc">{t.desc}</span>
                <span className="isuite-card-cta">Open →</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
