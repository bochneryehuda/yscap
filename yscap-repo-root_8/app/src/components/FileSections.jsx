import React, { useEffect, useRef, useState } from 'react';

/* The 1003-style layout for a loan file: a sticky section rail on the left
   (horizontal chip bar on mobile) and clearly named, anchored sections on the
   right. Purely presentational — every feature stays where it was, it just
   gets a named home and one-click navigation, the way a traditional lender's
   application walks you through Borrower → Property → Loan → Conditions. */

export function InfoTip({ tip }) {
  if (!tip) return null;
  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={tip}>
      <span aria-hidden="true">i</span>
      <span className="info-tip-bubble">{tip}</span>
    </span>
  );
}

/* collapsible + defaultOpen: long, low-urgency sections (Document history,
   Activity) start collapsed — the header row toggles them. */
export function Section({ id, title, info, badge, children, style, collapsible = false, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => collapsible && setOpen(o => !o);
  return (
    <section id={id} className="file-section" style={style}>
      <div
        className={`sec-head${collapsible ? ' collapsible' : ''}`}
        onClick={toggle}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        onKeyDown={collapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } : undefined}
      >
        {collapsible && <span className={`sec-chevron${open ? ' open' : ''}`} aria-hidden="true">▶</span>}
        <h2 className="sec-title">{title}{info ? <InfoTip tip={info} /> : null}</h2>
        {badge != null && <span className="sec-badge">{badge}</span>}
        {collapsible && <span className="muted small" style={{ flex: 'none', marginLeft: badge != null ? 0 : 'auto' }}>{open ? 'Hide' : 'Show'}</span>}
      </div>
      {(!collapsible || open) && children}
    </section>
  );
}

/* sections: [{id, label, badge?}] — the rail highlights the section in view. */
export default function FileSections({ sections, children, top = null }) {
  const [active, setActive] = useState(sections[0] && sections[0].id);
  const clickLock = useRef(0);

  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      if (Date.now() < clickLock.current) return;   // let the click's smooth-scroll win
      // Highest visible section wins — reads naturally while scrolling.
      const vis = entries.filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: '-90px 0px -55% 0px', threshold: 0 });
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [sections.map(s => s.id).join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  function go(e, id) {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    clickLock.current = Date.now() + 900;
    setActive(id);
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
