import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFileOverviewLayer } from '../lib/overlay-layers.js';

/* THE FILE-OVERVIEW SLIDE-OVER (owner-directed 2026-08-18): a RIGHT-side panel
   on every file screen — staff, borrower and broker — with the whole deal at a
   glance: who, the property and transaction, the loan structure, and the
   liquidity picture. ONE component for all three surfaces; only the fetcher
   differs (each surface passes its own API call, so the audience boundary
   lives on the server, never here).

   A vertical tab sits on the RIGHT edge (owner-directed 2026-08-18: it started
   on the left and the owner asked for the right side, "a little nicer, and
   everybody should realize what it is" — hence the ink/gold tab with a glyph
   and the full label); clicking it slides the panel out from the right over a
   backdrop. Esc or the backdrop closes it. The payload is fetched when first
   opened (and kept for the visit), so a closed tab costs nothing.

   IT STAYS REACHABLE WHILE A DOCUMENT IS OPEN (owner-directed 2026-08-20: "when
   you're previewing a document, a PDF, or anything else … the entire screen in
   the back gets black. You can't click on the overview … we need to have the
   overview available while we're previewing the PDF … so you can compare maybe
   the PDF to the file overview to see the details").

   Three things make that true, and each one was a separate reason it failed:

     1. THE TAB OUTRANKS THE PREVIEW. The preview's dim used to sit at z 200 over
        a tab at z 120 — the button was still there, behind an opaque sheet. The
        preview now owns its own layer (`.dp-back`, z 150) and this tab climbs to
        z 160 whenever a preview is open, so it is visible and clickable.
     2. NO SECOND DIM. Opening the panel over an already-dimmed preview would
        double the darkness and hide the very document you are comparing against,
        so the panel's own backdrop is not rendered while a preview is open. The
        preview's dim already separates both layers from the page.
     3. THEY SHARE THE WIDTH. The preview shrinks by the width of this panel
        (`.dp-beside-overview`) instead of sitting under it — "you should be able
        to see both together". Below 1024px there is no room for that; there the
        panel overlays, still on top and still closable.

   Z-ORDER, top to bottom: app confirm dialogs (`.cv-modal-back`, 200) → this
   panel while a preview is open (165) and its tab (160) → the document preview
   (150) → this panel on its own (135) and its tab (120). A confirm dialog must
   ALWAYS paint over and block clicks to everything here (audit 9a05513 #4), and
   still does.

   Portaled to <body>: a file screen nested inside a transformed or overflow-
   clipping ancestor would otherwise trap `position:fixed` and clip the panel.
   React portals bubble events through the REACT tree, so nothing about the
   surrounding screen's handlers changes. */
export default function FileOverviewSlideOver({ fetcher, title = 'File overview' }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  // Register this panel as an open layer while it is out, and learn whether a
  // document preview is open behind it.
  const layers = useFileOverviewLayer(open);
  /* THE TAB MUST OUTRANK ANYTHING THAT FILLS THE SCREEN. Two things do: a document
     preview (2026-08-20) and a full-screen TOOL SHEET — the Scope of Work, the track
     record, the Products & Pricing studio, the generated terms (owner-reported
     2026-08-21: "that button is not available in the full screens that are populated …
     This should always be available"). Both get the same escalation, because the
     requirement is the same one: the overview is always reachable.
     A CONFIRM DIALOG STILL WINS over both — it stays on the plain `.cv-modal-back` at
     z 200, above the escalated tab, so a question the app asks is never buried. */
  const overPreview = layers.preview;
  /* A FULL-SCREEN TOOL SHEET covers the tab too — the Scope of Work, the track record,
     the Products & Pricing studio and the terms it generates (owner-reported 2026-08-21:
     "that button is not available in the full screens that are populated … This should
     always be available"). Kept SEPARATE from the preview escalation because the number
     is different by an order of magnitude: a preview sits at z 150 and a tool sheet at
     1000, so one class cannot serve both. */
  const overTool = layers.tool;
  const over = overPreview || overTool;
  const overClass = overTool ? ' fov-over-tool' : overPreview ? ' fov-over-preview' : '';

  // Fetch directly (called on first open and by Try again) — never via an
  // effect keyed on `open` alone, whose stale closure made the retry a dead
  // button that blanked the panel (audit 9a05513 #5).
  const fetchCard = () => {
    setState('loading');
    Promise.resolve()
      .then(() => fetcher())
      .then((c) => { setCard(c); setState('ready'); })
      .catch(() => setState('error'));
  };
  useEffect(() => {
    if (open && state === 'idle') fetchCard();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes the TOP layer, and while this panel is out that is this panel —
  // the preview's own Esc handler stands down for exactly this reason, so the
  // key closes one thing per press instead of both at once.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const layer = (
    <>
      <button type="button" className={`fov-tab${overClass}`} onClick={() => setOpen(true)}
        title="Open the file overview — the whole deal at a glance" aria-expanded={open}>
        {/* aria-hidden: decorative glyph — the label is the text beside it. */}
        <span className="fov-tab-ico" aria-hidden="true">◈</span>
        <span className="fov-tab-text">{title}</span>
      </button>
      {/* No second dim over a document preview — the preview's own backdrop is
          already there, and a second one would darken the document you opened
          this panel to compare against. */}
      {open && !over && <div className="fov-back" onClick={() => setOpen(false)} />}
      <aside className={`fov-panel${open ? ' fov-open' : ''}${overClass}`}
        aria-hidden={!open} role="dialog" aria-label={title}>
        <div className="fov-head">
          <div>
            <div className="fov-eyebrow">{title}</div>
            {card && card.header && (
              <>
                <div className="fov-title">
                  {card.header.address || 'This file'}
                  {card.header.loanNumber && <span className="fov-loanno">{card.header.loanNumber}</span>}
                </div>
                {/* The loan's basics ride in the header (owner-directed
                    2026-08-26): the loan amount + purchase/refinance/cash-out,
                    WITHOUT removing them from the sections below. Server-fed,
                    omitted while unknown. */}
                {(card.header.loanAmount || card.header.purpose) && (
                  <div className="fov-basics">
                    {card.header.loanAmount && <span className="fov-basic">{card.header.loanAmount}</span>}
                    {card.header.purpose && <span className="fov-basic">{card.header.purpose}</span>}
                  </div>
                )}
              </>
            )}
          </div>
          <button type="button" className="fov-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
        </div>
        <div className="fov-body">
          {state === 'loading' && <p className="fov-muted">Loading…</p>}
          {state === 'error' && (
            <p className="fov-muted">
              Couldn’t load the overview.{' '}
              <button type="button" className="fov-retry" onClick={fetchCard}>Try again</button>
            </p>
          )}
          {state === 'ready' && card && (card.sections || []).map((sec) => (
            <section className="fov-sec" key={sec.title}>
              <div className="fov-sec-h">{sec.title}</div>
              <dl className="fov-rows">
                {sec.rows.map((r) => (
                  <div className={`fov-row${r.strong ? ' fov-strong' : ''}`} key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {state === 'ready' && card && !(card.sections || []).length && (
            <p className="fov-muted">Nothing to show yet — figures appear as the file is priced and registered.</p>
          )}
        </div>
      </aside>
    </>
  );

  return typeof document !== 'undefined' && document.body ? createPortal(layer, document.body) : layer;
}
