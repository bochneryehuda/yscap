import React, { useEffect, useRef, useState } from 'react';

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
/* One-call "take me to that section": expand it, then smooth-scroll to it.
   The expand is dispatched first so the header is already rendered open when the
   scroll lands. Reused by the rail, the outstanding-to-close list, etc. */
export function goToSection(id) {
  if (!id) return;
  requestOpenSection(id);
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
   defaultOpen={false} and start collapsed. */
export function Section({ id, title, info, badge, children, style, collapsible = true, defaultOpen = true, action = null }) {
  const [open, setOpen] = useState(defaultOpen);
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
  const toggle = (e) => {
    if (!collapsible) return;
    // hovering/clicking the little "i" — or a header action button — must never collapse the section
    if (e && e.target && e.target.closest && (e.target.closest('.info-tip') || e.target.closest('.sec-action'))) return;
    setOpen(o => !o);
  };
  return (
    <section id={id} className="file-section" style={style}>
      <div
        className={`sec-head${collapsible ? ' collapsible' : ''}`}
        onClick={toggle}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        onKeyDown={collapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } } : undefined}
      >
        {collapsible && <span className={`sec-chevron${open ? ' open' : ''}`} aria-hidden="true">▶</span>}
        <h2 className="sec-title">{title}{info ? <InfoTip tip={info} /> : null}</h2>
        {badge != null && <span className="sec-badge">{badge}</span>}
        {action && <span className="sec-action" style={{ marginLeft: badge != null ? 12 : 'auto' }} onClick={(e) => e.stopPropagation()}>{action}</span>}
        {collapsible && <span className="muted small" style={{ flex: 'none', marginLeft: (badge != null || action) ? 12 : 'auto' }}>{open ? 'Hide' : 'Show'}</span>}
      </div>
      {(!collapsible || open) && children}
    </section>
  );
}

/* sections: [{id, label, badge?}] — the rail highlights the section in view. */
export default function FileSections({ sections, children, top = null }) {
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

  return (
    <div className="file-layout">
      <nav className="file-nav" aria-label="Loan file sections">
        {top}
        <ol>
          {sections.map(s => (
            <li key={s.id}>
              <a href={`#${s.id}`} className={active === s.id ? 'active' : ''} onClick={(e) => go(e, s.id)}>
                <span className="file-nav-label">{s.label}</span>
                {s.badge != null && s.badge !== '' && <span className="file-nav-badge">{s.badge}</span>}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="file-main">{children}</div>
    </div>
  );
}
