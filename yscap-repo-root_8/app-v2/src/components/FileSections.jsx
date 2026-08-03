import React, { useEffect, useRef, useState } from 'react';
import { rememberScroll, restoreRemembered, parkScroll, unparkScroll } from '../lib/keep-scroll.js';

/* The 1003-style layout for a loan file: a sticky section rail on the left
   (horizontal chip bar on mobile) and clearly named, anchored sections on the
   right. Purely presentational — every feature stays where it was, it just
   gets a named home and one-click navigation, the way a traditional lender's
   application walks you through Borrower → Property → Loan → Conditions. */

/* A tiny module-level bus so that ANYTHING on the page — the left rail, the
   "clear to close" outstanding list, a re-register prompt — can OPEN a specific
   collapsed section and scroll to it in one call. The file starts with most
   sections collapsed (fast top-to-bottom scan); a click anywhere that points at
   a section expands JUST that one and brings it into view. Sections listen for
   their own id and expand themselves (see Section's effect below). */
const sectionBus = typeof window !== 'undefined' ? new EventTarget() : null;
export function requestOpenSection(id) {
  if (sectionBus && id) sectionBus.dispatchEvent(new CustomEvent('pilot-open-section', { detail: id }));
}
/* The Conditions section is a tabbed hub; a caller (e.g. a "Go fix →" link) can
   ask it to switch to a specific tab as it navigates there. */
export function requestConditionsTab(tab) {
  if (sectionBus && tab) sectionBus.dispatchEvent(new CustomEvent('pilot-conditions-tab', { detail: tab }));
}
export function subscribeConditionsTab(cb) {
  if (!sectionBus) return () => {};
  const h = (e) => cb(e.detail);
  sectionBus.addEventListener('pilot-conditions-tab', h);
  return () => sectionBus.removeEventListener('pilot-conditions-tab', h);
}
/* "Application details" is a tabbed sub-hub too, and its tabs are now the ONLY
   home of things that used to be their own sections (the Encompass comparison).
   So the channel that flips them lives HERE beside the conditions one rather
   than privately inside StaffApplication: a component that is merely rendered
   on the file screen — the e-sign section's Encompass blocker, the tape export's
   "open the Encompass section" — has to be able to ask for a tab without
   importing the screen that renders it (a cycle) or navigating anywhere.
   The subscriber is the screen itself, mounted whatever room is showing, so a
   request may be made BEFORE the section is open — it flips the tab underneath
   and the open+scroll lands on the right one. */
export function requestAppDetailTab(tab) {
  if (sectionBus && tab) sectionBus.dispatchEvent(new CustomEvent('pilot-app-detail-tab', { detail: tab }));
}
export function subscribeAppDetailTab(cb) {
  if (!sectionBus) return () => {};
  const h = (e) => cb(e.detail);
  sectionBus.addEventListener('pilot-app-detail-tab', h);
  return () => sectionBus.removeEventListener('pilot-app-detail-tab', h);
}
/* THE ROOM RESOLVER (Seven Rooms, Phase 1 — docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md).
   The staff file screen renders one room at a time, so a jump's target section
   may not be MOUNTED (the bus listeners above exist only while a Section is
   mounted, and goToSection scrolls immediately). The staff screen registers a
   resolver here; goToSection/revealAnchor consult it FIRST. The resolver
   returns true when it took the jump over (it switches the room, then replays
   the open+scroll after mount) and false to fall through to the byte-identical
   default path. With no resolver registered — the borrower screen, the Draw
   Center, the staff screen's classic view — nothing changes at all.
   setSectionResolver returns an unregister function; register it in an effect
   WITH CLEANUP so an unmounted screen can never hijack another one's jumps. */
let sectionResolver = null;
export function setSectionResolver(fn) {
  sectionResolver = fn;
  return () => { if (sectionResolver === fn) sectionResolver = null; };
}

/* One-call "take me to that section": expand it, then smooth-scroll to it.
   The expand is dispatched first so the header is already rendered open when the
   scroll lands. An optional `tab` also flips the Conditions hub to the right tab.
   Reused by the rail, the outstanding-to-close list, etc. */
export function goToSection(id, tab) {
  if (!id) return;
  if (sectionResolver && sectionResolver({ kind: 'section', id, tab })) return;
  requestOpenSection(id);
  if (tab) requestConditionsTab(tab);
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* "Take me to that ANCHOR" — an element INSIDE a section (#note-buyer-slot,
   #ctc-outstanding, #ai-findings, #conversations). Returns true when the
   resolver took it over (room switch + open + scroll after mount); on false the
   caller keeps its own fallback (today's behavior), because only the caller
   knows which section must be opened first on an already-mounted room. */
export function revealAnchor(id, opts = {}) {
  const anchor = String(id || '').replace(/^#/, '');
  if (!anchor) return false;
  if (sectionResolver && sectionResolver({ kind: 'anchor', id: anchor, block: opts.block || 'start' })) return true;
  const el = typeof document !== 'undefined' ? document.getElementById(anchor) : null;
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: opts.block || 'start' }); return false; }
  return false;
}

export function InfoTip({ tip }) {
  if (!tip) return null;
  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={tip}>
      <span aria-hidden="true">i</span>
      <span className="info-tip-bubble">{tip}</span>
    </span>
  );
}

/* EVERY section is collapsible from its header row. Most start open
   (defaultOpen) — long, low-urgency ones (Document history, Activity) pass
   defaultOpen={false} and start collapsed.

   `summary` is one plain line shown ONLY while the section is shut — blueprint
   Move 3, "make every closed section worth judging". With fourteen collapsed
   headers down the page, a title alone tells you nothing about whether it is
   worth opening; a badge tells you a number without telling you what it means.
   The line says it in words ("3 need your sign-off · 1 sent back"). It comes
   from figures the page has already computed — a section with nothing truthful
   to say passes nothing and shows nothing, which is better than a guess. It
   disappears when the section opens, because the real content is then right
   there and repeating it would be noise. */
export function Section({ id, title, info, badge, children, style, collapsible = true, defaultOpen = true, action = null, summary = null, fullscreenable = false, hidden = false }) {
  const [open, setOpen] = useState(defaultOpen);
  /* FULL SCREEN — owner-directed 2026-07-27: "there should also be a button by
     the conditions section to open the conditions section on a full screen so
     you can work in a big screen on all the conditions."
     Opt-in per section (default off), so adding it here changes nothing for the
     other fifteen. It is a CSS overlay rather than the browser Fullscreen API:
     that API needs a user gesture it can still refuse, paints the page onto a
     black backdrop, and takes the browser chrome away — none of which is wanted
     for "give me more room to work". Esc closes it, and the page behind is
     stopped from scrolling so it does not drift underneath. */
  const [full, setFull] = useState(false);
  /* Set when a ROOM HOP is what closed full screen, so the exit does NOT drag the
     reader back to where they stood in the room they just left. */
  /* Is this section off-screen RIGHT NOW? Read at cleanup time, never latched.
     A latched "skip the restore" flag was set on EVERY room hop — including the
     one every section does at mount, since only the active room renders — so it
     was still set hours later when the reader finally left full screen, and the
     restore silently did nothing. Deliberately a no-dependency effect: it must be
     current before the `hidden` handler below triggers the re-render whose
     cleanup reads it. */
  const hiddenRef = useRef(hidden);
  useEffect(() => { hiddenRef.current = hidden; });
  /* Where the reader was before full screen took the page away.
     CAPTURED IN THE CLICK, NOT IN THE EFFECT — and that distinction is the whole
     fix. `.sec-full` is `position:fixed`, so the section leaves the flow in the
     very commit that sets `full`, the document collapses to the viewport, and the
     browser clamps scrollY to 0 BEFORE any effect runs. Reading the offset inside
     the effect therefore reads 0 and restores nothing; measured on the real
     bundle, that was 1931 -> 0 -> 0. */
  const fullY = useRef(0);
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    /* Locking the body also drops the document to the viewport height, and
       unlocking gives the height back but never the offset — which is why exiting
       full screen left the reader at the top of the file (owner-reported
       2026-08-02, and the half that PRE-DATES the rooms: CreditReport, ToolModal
       and ProductStudioPanel have done this step since #108; this overlay landed
       later and never got it). */
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      // A ROOM HOP closes full screen too. Restoring then would drag the reader
      // to where they stood in the room they just left.
      if (hiddenRef.current) return;
      restoreRemembered(fullY.current);
    };
  }, [full]);
  // Listen for an "open this section" request from anywhere on the page — the
  // left rail, the clear-to-close outstanding list, a re-register prompt — so a
  // click that points at this section EXPANDS it (never collapses it) and the
  // caller's scroll lands on an already-open header. A non-collapsible section
  // is always open, so it just ignores the signal.
  useEffect(() => {
    if (!collapsible || !sectionBus) return;
    const h = (e) => { if (e.detail === id) setOpen(true); };
    sectionBus.addEventListener('pilot-open-section', h);
    return () => sectionBus.removeEventListener('pilot-open-section', h);
  }, [id, collapsible]);
  /* Where the reader was before they shut this section. A room can hold a single
     section, so closing it leaves a page barely taller than the window and the
     browser clamps them to the top — there is no position left to hold. Re-opening
     is where the place has to come back, which is what this remembers. */
  const parked = useRef(null);
  const toggle = (e) => {
    if (!collapsible) return;
    // hovering/clicking the little "i" — or a header action button — must never collapse the section
    if (e && e.target && e.target.closest && (e.target.closest('.info-tip') || e.target.closest('.sec-action'))) return;
    if (open) { parked.current = parkScroll(); setOpen(false); }
    else { const p = parked.current; parked.current = null; setOpen(true); unparkScroll(p); }
  };
  // Full screen implies open — there would be nothing to fill the screen with.
  const showSummary = collapsible && !open && !full && summary;
  const fullBtn = fullscreenable ? (
    <button type="button" className="btn ghost small"
      title={full ? 'Back to the file (Esc)' : 'Open this section full screen so you can work through it on a big screen'}
      onClick={(e) => {
        e.stopPropagation();
        // Read the offset BEFORE the state change — see fullY above.
        if (!full) { fullY.current = rememberScroll(); setOpen(true); }
        setFull(f => !f);
      }}>
      {full ? 'Exit full screen' : 'Full screen'}
    </button>
  ) : null;
  const headAction = (fullBtn || action)
    ? <>{action}{fullBtn}</>
    : null;
  // A section in CSS full-screen that gets hidden by a room hop must drop out
  // of full-screen too — it renders null below, and leaving `full` set would
  // keep document.body scroll-locked with no overlay to escape from (audit
  // 2026-08-02 #2).
  useEffect(() => { if (hidden) setFull(false); }, [hidden]);
  // Seven Rooms: a section whose room isn't showing renders NOTHING — but stays
  // MOUNTED, so its open/closed state survives room switches and the section bus
  // can pre-open it while its room is off screen. Sits AFTER every hook above
  // (hooks must run unconditionally); collapsed children still unmount as
  // before, so the performance contract is unchanged.
  if (hidden) return null;
  return (
    <section id={id} className={`file-section${full ? ' sec-full' : ''}`} style={style}>
      <div
        className={`sec-head${collapsible ? ' collapsible' : ''}${showSummary ? ' has-summary' : ''}`}
        onClick={toggle}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        onKeyDown={collapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } } : undefined}
      >
        {collapsible && <span className={`sec-chevron${open ? ' open' : ''}`} aria-hidden="true">▶</span>}
        <h2 className="sec-title">{title}{info ? <InfoTip tip={info} /> : null}</h2>
        {badge != null && <span className="sec-badge">{badge}</span>}
        {headAction && <span className="sec-action" style={{ marginLeft: badge != null ? 12 : 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>{headAction}</span>}
        {/* Hide/Show is meaningless while the section IS the screen. */}
        {collapsible && !full && <span className="muted small" style={{ flex: 'none', marginLeft: (badge != null || headAction) ? 12 : 'auto' }}>{open ? 'Hide' : 'Show'}</span>}
      </div>
      {showSummary && <div className="sec-summary">{summary}</div>}
      {/* A section may take a render-prop child so its content can react to full
          screen (e.g. the Conditions hub opens every category + condition when the
          section fills the screen). A plain element child is rendered as-is. */}
      {(!collapsible || open || full) && (typeof children === 'function' ? children({ full }) : children)}
    </section>
  );
}

/* sections: [{id, label, badge?}] — the rail highlights the section in view.

   ROOMS MODE (staff file, Seven Rooms Phase 1): pass `stations`
   ([{id,label,badge?}]), `activeStation` and `onStationGo` and the rail becomes
   two-level — one row per room, with the ACTIVE room's child sections indented
   under it as spokes. `sections` must then be ONLY the active room's visible
   sections, in render order (they are the mounted ids the scroll tracker
   watches). `footer` renders at the bottom of the rail (the classic-view
   toggle + "where did everything go?"). With `stations` unset everything below
   is byte-identical to before — the borrower screen and the Draw Center pass
   nothing new. */
export default function FileSections({ sections, children, top = null, stations = null, activeStation = null, onStationGo = null, footer = null }) {
  const [active, setActive] = useState(sections[0] && sections[0].id);
  const clickLock = useRef(0);

  // Active-section tracking driven by LIVE section positions (not just the
  // sections whose intersection toggled in a given callback). The old
  // IntersectionObserver only inspected the changed entries, so a section that
  // stayed continuously visible after a collapse/expand could never be
  // re-selected (the rail "stuck" on the next section), and scroll-up lagged
  // because the section you were reading hadn't re-toggled. Reading each
  // section's real getBoundingClientRect on every (rAF-throttled) scroll makes
  // both directions accurate, and a ResizeObserver re-syncs the rail the moment
  // a section collapses/expands — even without any scrolling.
  useEffect(() => {
    const ids = sections.map(s => s.id);
    let raf = 0;

    const compute = () => {
      raf = 0;
      if (Date.now() < clickLock.current) return;   // let a nav click's smooth-scroll win
      const line = 160;                              // trigger line below the sticky header + identity bar
      let current = null, firstBelow = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= line) current = id;               // last section whose head has crossed the line
        else if (firstBelow == null) firstBelow = id;
      }
      const next = current || firstBelow || ids[0];
      if (next) setActive(prev => (prev === next ? prev : next));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(compute); };

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    const main = document.querySelector('.file-main');
    if (main) ro.observe(main);
    for (const id of ids) { const el = document.getElementById(id); if (el) ro.observe(el); }

    compute();   // initial sync
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sections.map(s => s.id).join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  function go(e, id) {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    clickLock.current = Date.now() + 900;
    setActive(id);
    // Clicking a section in the rail EXPANDS it (owner-directed: "when you click
    // a section it should open up that section for you") — the whole file starts
    // collapsed for a fast scan, and navigation is what opens a section.
    requestOpenSection(id);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // A section spoke row — shared by both rail modes so the label/badge/active
  // treatment can never drift between them.
  const spoke = (s) => (
    <li key={s.id}>
      <a href={`#${s.id}`} className={active === s.id ? 'active' : ''} onClick={(e) => go(e, s.id)}>
        <span className="file-nav-label">{s.label}</span>
        {s.badge != null && s.badge !== '' && <span className="file-nav-badge">{s.badge}</span>}
      </a>
    </li>
  );

  if (stations) {
    return (
      <div className="file-layout">
        <nav className="file-nav" aria-label="Loan file rooms">
          {top}
          <ol>
            {stations.map((st) => (
              <li key={st.id} className="file-nav-station-row">
                {/* An <a> so the phone chip-bar styling applies unchanged; the
                    href is decorative — the click switches the room. */}
                <a href={`#${st.id}`} className={`file-nav-station${st.id === activeStation ? ' active' : ''}`}
                  aria-current={st.id === activeStation ? 'true' : undefined}
                  onClick={(e) => { e.preventDefault(); onStationGo && onStationGo(st.id); }}>
                  <span className="file-nav-label">{st.label}</span>
                  {st.badge != null && st.badge !== '' && <span className="file-nav-badge">{st.badge}</span>}
                </a>
                {st.id === activeStation && sections.length > 1 && (
                  <ol className="file-nav-spokes">{sections.map(spoke)}</ol>
                )}
              </li>
            ))}
          </ol>
          {footer}
        </nav>
        <div className="file-main">{children}</div>
      </div>
    );
  }

  return (
    <div className="file-layout">
      <nav className="file-nav" aria-label="Loan file sections">
        {top}
        <ol>
          {sections.map((s, i) => {
            // Print a quiet group header the first time a new group appears. The
            // sections are already in page order, so these headers never reorder
            // anything — they just label the runs.
            const header = s.group && (i === 0 || sections[i - 1].group !== s.group)
              ? <li key={`grp-${s.group}`} className="file-nav-group" aria-hidden="true">{s.group}</li>
              : null;
            return (
              <React.Fragment key={s.id}>
                {header}
                {spoke(s)}
              </React.Fragment>
            );
          })}
        </ol>
        {footer}
      </nav>
      <div className="file-main">{children}</div>
    </div>
  );
}
