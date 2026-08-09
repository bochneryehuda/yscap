import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StaticToolFrame from '../components/StaticToolFrame.jsx';
import ToolScenarioBar from '../components/ToolScenarioBar.jsx';
import { api } from '../lib/api.js';
import { rememberScroll, restoreRemembered } from '../lib/keep-scroll.js';
import { scenarioToDraft } from '../lib/scenario.js';
// The studio's OWN reader + the SAME override/term-option builders the Products
// & Pricing panel registers with — so a file created from a term sheet registers
// through the identical guarded path (owner-directed 2026-08-06).
import { readSnapshot, capturePdfFromWindow, blobToBase64 } from '../components/TermSheetStudio.jsx';
// WHO IS DRIVING THIS TOOL — the one place the portal tells an embedded static tool
// which staff member it is working for (lib/toolOfficer.js). Without it the tool is
// anonymous, its leads post with no officer, and the round-robin gives a staffer's
// own work to somebody else (owner-reported 2026-08-07).
import { stampToolOfficer } from '../lib/toolOfficer.js';
import { overridesFromSnapshot, overridesAreManual, termOptionsFromSnapshot } from '../components/ProductStudioPanel.jsx';

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
      { slug: 'term-sheet', name: 'Term Sheet Studio', desc: 'Price a loan and generate a full term sheet — Standard, Gold, Silver or a manual product.', icon: '📄' },
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

/* Flat lookup so a route can name a tool without knowing which group it sits in. */
const ALL_TOOLS = GROUPS.flatMap((g) => g.tools);
const TOOL_BY_SLUG = Object.fromEntries(ALL_TOOLS.map((t) => [t.slug, t]));

export default function StaffInvestorSuite({ initialTool = null }) {
  const nav = useNavigate();
  /* `initialTool` is the direct left-nav entry (/internal/term-sheet) opening straight
     onto one tool. An unknown slug falls back to the grid rather than a blank screen. */
  const [open, setOpen] = useState(() => (initialTool && TOOL_BY_SLUG[initialTool]) || null);
  const [counts, setCounts] = useState({}); // slug -> how many scenarios this staffer saved
  const [note, setNote] = useState('');     // main's "Create loan file" error line
  /* The frame's own window, captured through StaticToolFrame's onReady. Same-origin,
     so the scenario bar can ask the tool for its state and hand it back. Held in a
     REF rather than state: it is an imperative handle, and re-rendering on it would
     remount the frame and throw away the very numbers we are trying to save.
     THE SLUG IS STORED WITH IT (pre-merge audit, 2026-07-30): the ref was never
     cleared, so between opening a second tool and its frame booting it still pointed
     at the PREVIOUS, torn-down window. Pinning the handle to the tool it came from
     makes the stale window unreachable without depending on effect ordering — an
     effect that nulls the ref would race a frame that loads straight from cache.

     A SLUG IS NOT ENOUGH — IT REPEATS (re-audit 2026-07-30). Close Rehab Budget,
     open Rehab Budget again, press Save before the new frame boots: the slug still
     matches, so the pin handed back the PREVIOUS, torn-down window and the save
     stored the OLD session's line items under the new name, with the screen saying
     "Saved". Measured in a real browser — the row that landed in Postgres carried
     the first frame's marker. So the handle is pinned to a GENERATION as well: every
     change of which tool is on screen bumps it SYNCHRONOUSLY, inside the click
     handler, strictly before React re-renders and long before any frame can call
     onReady. No effect ordering is involved, so a frame served from cache cannot
     race it, and a late onReady from the torn-down frame carries the old generation
     and is ignored. */
  const winRef = useRef(null);
  const genRef = useRef(0);
  /* The ONLY way `open` changes. Invalidating the handle here — not in an effect —
     is what makes the reopen safe. */
  const showTool = useCallback((t) => { winRef.current = null; genRef.current += 1; setOpen(t); }, []);
  const winFor = useCallback((slug) => {
    const held = winRef.current;
    return held && held.slug === slug && held.gen === genRef.current ? held.win : null;
  }, []);

  // Saved counts for the grid badges — one call, every tool.
  useEffect(() => {
    let dead = false;
    api.toolScenarios().then((r) => { if (!dead) setCounts((r && r.counts) || {}); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  const noteCount = useCallback((slug, n) => setCounts((c) => (c[slug] === n ? c : { ...c, [slug]: n })), []);

  /* "Email to borrower →" (owner-directed 2026-08-07). The SAME payload
     "Create loan file →" builds — the deal AND the pricing election — but the
     destination is the borrower's inbox instead of the new-file form, and the file
     is born on the other side when they accept. `send` holds the confirm sheet's
     state; null means it is closed. */
  const [send, setSend] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  // "Create loan file →" (owner-directed, from main): turn the term sheet you just
  // built into a NEW loan file, pre-filled with everything you entered. Maps the
  // studio's own input state with the SAME scenario→file translation the borrower
  // "Start this loan" uses, stashes it, and opens the New file form pre-filled —
  // you just add the borrower + submit.
  function createFileFromStudio() {
    setNote('');
    try {
      /* Reads the frame through the SAME pinned handle the scenario bar uses, rather
         than `document.querySelector('.isuite-full-body iframe')`. Both find the live
         frame in the ordinary case, but the DOM query cannot tell a booted frame from
         one that is mid-remount — which is exactly the stale-window class the
         generation pin was added to close. A loan FILE built from the previous tool
         session's numbers is a worse version of that bug than a saved scenario. */
      const win = winFor(open && open.slug);
      if (!win || !win.YS || typeof win.YS.collectState !== 'function') {
        setNote('Give the term sheet a moment to finish loading, then try again.');
        return;
      }
      const state = win.YS.collectState();          // { v, c, rad }
      const draft = scenarioToDraft({ v: state.v, c: state.c });
      const name = String((state.v || {}).borrowerName || '').trim();
      /* NOTHING THE TERM SHEET SAID IS FORGOTTEN (owner-directed 2026-08-06:
         "if you start an application from a scenario that you selected,
         everything should be remembered, including the manuals, the changes of
         pricing, this out of pocket, the loan amount, the program"). `draft`
         above carries the DEAL (price, values, budget, experience, payoff) — it
         does not, and should not, carry the pricing ELECTION: which program was
         chosen, the manual LTV/LTC/ARV basis, the markup and origination
         changes, the fee overrides, the out-of-pocket exception. Those are what
         make the new file register as the sheet the officer just built.

         Read through the studio's OWN reader (`readSnapshot`) rather than
         `collectState()`, which cannot see either half of what is needed: it
         strips every `data-noshare` admin field (the markup) and has no idea
         which program card is active. `overridesFromSnapshot(..., 'staff')` is
         then the SAME payload the Products & Pricing panel sends when a human
         presses Register, so the new file registers through the identical
         guarded path — approvals, escalations and all.

         The LOAN AMOUNT is deliberately NOT carried. It is not an input; the
         frozen engine recomputes it on the file from exactly these numbers, so
         carrying it could only ever let a stale figure disagree with the engine. */
      let reg = null;
      try {
        const snap = readSnapshot(win);
        if (snap && snap.program) {
          reg = {
            program: snap.program,
            overrides: overridesFromSnapshot(snap, 'staff'),
            termOptions: termOptionsFromSnapshot(snap),
            // A manual basis needs the liquidity months before it can register;
            // the officer is asked for them on the new-file screen rather than
            // being handed an opaque refusal after the file already exists.
            manual: overridesAreManual(overridesFromSnapshot(snap, 'staff')),
          };
        }
      } catch (_) { reg = null; }   // never block creating the file
      const prefill = {
        ...draft,
        firstName: name ? name.split(/\s+/)[0] : '',
        lastName: name ? name.split(/\s+/).slice(1).join(' ') : '',
        __register: reg,
      };
      sessionStorage.setItem('ys-staff-newfile-prefill', JSON.stringify(prefill));
      nav('/internal/new');
    } catch (_) {
      setNote('Could not read the term sheet — try again.');
    }
  }

  /* READ THE TERM SHEET ONCE — the deal, the pricing election, and who it is for.
     Shared by "Create loan file →" and "Email to borrower →" so the two can never
     carry different terms out of the same sheet. Returns null (and sets the note)
     when the frame is not ready, exactly as createFileFromStudio does. */
  function readStudioOffer() {
    const win = winFor(open && open.slug);
    if (!win || !win.YS || typeof win.YS.collectState !== 'function') {
      setNote('Give the term sheet a moment to finish loading, then try again.');
      return null;
    }
    const state = win.YS.collectState();
    const draft = scenarioToDraft({ v: state.v, c: state.c });
    const name = String((state.v || {}).borrowerName || '').trim();
    const email = String((state.v || {}).borrowerEmail || (state.v || {}).email || '').trim();
    const phone = String((state.v || {}).borrowerPhone || (state.v || {}).phone || '').trim();
    let snap = null;
    try { snap = readSnapshot(win); } catch (_) { snap = null; }
    if (!snap || !snap.program) {
      setNote('Pick a program on the term sheet before sending it.');
      return null;
    }
    return {
      win, draft, name, email, phone,
      program: snap.program,
      overrides: overridesFromSnapshot(snap, 'staff'),
      termOptions: termOptionsFromSnapshot(snap),
      isManual: overridesAreManual(overridesFromSnapshot(snap, 'staff')),
      // What the officer is looking at — carried so the email and the accept page
      // quote the sheet they built. Display/record only on the server.
      quote: (snap && snap.quote) || null,
    };
  }

  function openSendSheet() {
    setNote(''); setSent(null);
    const o = readStudioOffer();
    if (!o) return;
    setSend({ ...o, email: o.email, name: o.name, phone: o.phone });
  }

  /* SEND. The PDF is captured the SAME way the studio component captures it (one
     shared helper), and a capture failure is NOT fatal: the email still carries every
     figure in its body, so a missing attachment is a worse email rather than a lost
     offer — the server records how many attachments actually rode along. */
  async function sendOffer() {
    if (!send || sending) return;
    setSending(true); setNote('');
    let pdfBase64 = null; let pdfFilename = null;
    try {
      const cap = await capturePdfFromWindow(send.win);
      if (cap && cap.blob) { pdfBase64 = await blobToBase64(cap.blob); pdfFilename = cap.filename; }
    } catch (_) { pdfBase64 = null; }
    try {
      const r = await api.sendTermSheetOffer({
        borrowerEmail: send.email, borrowerName: send.name, borrowerPhone: send.phone,
        draft: send.draft, program: send.program, overrides: send.overrides,
        termOptions: send.termOptions, isManual: send.isManual, quote: send.quote,
        pdfBase64: pdfBase64 || undefined, pdfFilename: pdfFilename || undefined,
      });
      setSend(null);
      setSent({ to: r.to, attached: r.attached, skipped: !!r.skipped });
    } catch (e) {
      setNote(e.message || 'Could not send the terms.');
    } finally { setSending(false); }
  }

  // Lock the page scroll while the full-screen tool is open — and give the
  // reader their place back when it closes. Locking the body drops the document
  // to the viewport height, so the browser clamps them to 0 on open and never
  // restores the offset on unlock; without the second half, closing a tool
  // dumped them at the top of the suite (the #108 class, same as ToolModal and
  // CreditReport, found alongside the loan-file report of 2026-08-02).
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    const y = rememberScroll();
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') showTool(null); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      restoreRemembered(y);
    };
  }, [open, showTool]);

  if (open) {
    const url = `${TOOL_BASE}${open.slug}.html?embed=1`;
    /* Read at RENDER time, so the onReady below closes over the generation this
       frame was mounted under — a handle from the previous mount can never pass. */
    const gen = genRef.current;
    return (
      <div className="isuite-full">
        <div className="isuite-full-head">
          <button className="btn ghost small" onClick={() => { showTool(null); setNote(''); }} aria-label="Back to the Investor Suite">← Back to the suite</button>
          <strong style={{ fontSize: 15 }}>{open.name}</strong>
          <div style={{ flex: 1 }} />
          <ToolScenarioBar slug={open.slug} toolName={open.name}
            getWin={() => winFor(open.slug)} onCountChange={noteCount} />
          {open.slug === 'term-sheet' && (
            <button className="btn btn-gold small" onClick={createFileFromStudio}
              title="Open a new loan file pre-filled with these numbers">Create loan file →</button>
          )}
          {/* EMAIL THE TERMS (owner-directed 2026-08-07). Sits beside "Create loan
              file" because they are the same sheet going to two places: one starts the
              file here, the other lets the borrower start it themselves — and the file
              they start is born with these exact terms already registered. */}
          {open.slug === 'term-sheet' && (
            <button className="btn primary small" onClick={openSendSheet}
              title="Email these terms to the borrower, with the term sheet attached">Email to borrower →</button>
          )}
          <a className="btn ghost small" href={url} target="_blank" rel="noopener noreferrer" title="Open this tool in a new browser tab">Open in a new tab ↗</a>
        </div>
        {note && <div className="notice err" role="alert" style={{ margin: '0 12px' }}>{note}</div>}
        {sent && (
          <div className="notice ok" role="status" style={{ margin: '0 12px' }}>
            Sent to <strong>{sent.to}</strong>
            {sent.attached ? ' with the term sheet attached.' : ' — the terms are in the email; the PDF could not be attached.'}
            {sent.skipped ? ' (No email provider is configured on this environment, so nothing actually left the building.)' : ''}
            {' '}They can accept and start their application straight from it.
          </div>
        )}
        {send && (
          <SendOfferSheet offer={send} sending={sending}
            onChange={(patch) => setSend((s0) => ({ ...s0, ...patch }))}
            onCancel={() => setSend(null)} onSend={sendOffer} />
        )}
        <div className="isuite-full-body">
          <StaticToolFrame key={open.slug} src={url} title={open.name} fill
            onReady={(win) => { winRef.current = { gen, slug: open.slug, win };
              // Provenance stamp (owner-directed 2026-07-31): a term sheet built
              // on a staffer's own login — outside any file — is OFFICER
              // GENERATED (still an initial, never final).
              if (open.slug === 'term-sheet') { try { win.TS_PROVENANCE = { kind: 'officer' }; } catch (_) { /* cosmetic */ } }
              // EVERY tool here, not just the term sheet: the rehab budget, the track
              // record and the loan application all post leads through the same door
              // and were all anonymous inside the portal. Fire-and-forget — the tool
              // reads the stamp at click time, and a failure must never block loading.
              stampToolOfficer(win);
            }} />
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
              <button key={t.slug} type="button" className="isuite-card" onClick={() => showTool(t)}
                title={`Open ${t.name}`}>
                <span className="isuite-card-icon" aria-hidden="true">{t.icon}</span>
                <span className="isuite-card-name">{t.name}</span>
                <span className="isuite-card-desc">{t.desc}</span>
                {counts[t.slug] > 0 && (
                  <span className="isuite-card-saved" style={{
                    fontSize: 11.5, fontWeight: 700, color: '#256168',
                    background: 'rgba(47,127,134,.10)', border: '1px solid rgba(47,127,134,.30)',
                    borderRadius: 100, padding: '1px 8px', marginTop: 6, alignSelf: 'flex-start',
                  }}>{counts[t.slug]} saved</span>
                )}
                <span className="isuite-card-cta">Open →</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* THE CONFIRM SHEET FOR "Email to borrower →" (owner-directed 2026-08-07).
   It exists because the term sheet's own borrower fields are often blank — an officer
   builds the numbers first and the name second — and because an email that leaves on a
   typo cannot be recalled. So the address is shown, editable, and required before the
   button is live. It also SAYS what the borrower will be able to do, since accepting
   creates a real file: a send is not a preview. */
function SendOfferSheet({ offer, sending, onChange, onCancel, onSend }) {
  const emailOk = /^[^@\s]+@[^@.\s]+(\.[^@.\s]+)+$/.test(String(offer.email || '').trim());
  return (
    <div className="cv-modal-back" role="dialog" aria-modal="true" aria-label="Email these terms to the borrower">
      <div className="cv-modal" style={{ maxWidth: 460 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17, color: '#141B22' }}>Email these terms</h3>
        <p className="small" style={{ margin: '0 0 14px', color: '#4B585C' }}>
          They get your branding, every figure from this sheet, the term sheet attached, and one button that
          starts their loan application already carrying these exact terms.
        </p>
        <label>Borrower’s email
          <input type="email" value={offer.email || ''} autoFocus
            onChange={(e) => onChange({ email: e.target.value })}
            placeholder="borrower@example.com" />
        </label>
        <label>Borrower’s name
          <input value={offer.name || ''} onChange={(e) => onChange({ name: e.target.value })}
            placeholder="So the email can greet them by name" />
        </label>
        <label>Mobile number (optional)
          <input value={offer.phone || ''} onChange={(e) => onChange({ phone: e.target.value })} />
        </label>
        {/* A MANUAL or off-default scenario still needs an admin's approval, and the
            officer should know that BEFORE sending — not discover it when the file
            lands held. This is the same rule the studio warns about on Register. */}
        {offer.isManual && (
          <p className="small" style={{ margin: '4px 0 0', color: '#8a6d3b' }}>
            These terms use a manual basis, so the file this creates will go to an admin for approval — exactly as it would if you registered it yourself.
          </p>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn ghost" type="button" disabled={sending} onClick={onCancel}>Cancel</button>
          <button className="btn primary" type="button" disabled={sending || !emailOk} onClick={onSend}>
            {sending ? 'Sending…' : 'Send the terms'}
          </button>
        </div>
      </div>
    </div>
  );
}
