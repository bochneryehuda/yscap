import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { INK, MUTED, GOLD } from '../lib/research.js';

/* ONE SECTION, SEVERAL PAGES (owner-directed 2026-08-03: "we now have on our left
 * side a few separate sections which all of them should technically be combined in
 * one section with different pages in that section, because the entire section
 * everything is a property research and Resource Center — so the property
 * research, define comparables, the market conditions, what we charge and quick
 * answer, all this that has to do with the property research should be combined
 * into 1 section").
 *
 * They were six sidebar entries sitting next to each other, which reads as six
 * unrelated tools rather than one desk you work at. This is the desk: one entry in
 * the sidebar, and the pages live inside it.
 *
 * WHY THE URLs ARE NOT TOUCHED, and why that is the whole design. The AI Command
 * Center collapsed its five screens behind `?tab=` and redirected the old routes.
 * That is the wrong shape here for two concrete reasons: every research screen
 * already keeps its entire search in its OWN query string (town, state, radius,
 * size, the lot) precisely so a search is a LINK you can paste to a colleague, and
 * a `?tab=` would sit in the same query string and collide with it; and these
 * pages already live at nested paths under /internal/research, so making them
 * pages of one section needs no new address at all. Every link anyone has ever
 * saved keeps working because none of them changed — not because a redirect
 * catches them.
 *
 * The tabs are ROUTES, so the browser's Back button, a middle-click and a
 * bookmark all behave the way they look like they should.
 */

export const RESEARCH_PAGES = Object.freeze([
  { to: '/internal/research', end: true, label: 'Search properties',
    blurb: 'Every property and comparable sale our appraisers have ever shown us.' },
  { to: '/internal/research/comps', label: 'Find comparables',
    blurb: 'Name the property you are valuing and the search fills itself in from it.' },
  { to: '/internal/research/market', label: 'Market conditions',
    blurb: 'What the appraisers themselves reported about a town, month by month.' },
  { to: '/internal/research/adjustments', label: 'What we charge',
    blurb: 'The adjustments our own appraisers write, and how many reports stand behind each figure.' },
  { to: '/internal/research/quick', label: 'Quick answer',
    blurb: 'A town and a couple of basics, and what properties like that have been coming in at.' },
  { to: '/internal/research/areas', label: 'Market areas',
    blurb: 'Draw the neighbourhood the way an appraiser would.' },
  { to: '/internal/research/appraisers', label: 'Appraisers',
    blurb: 'Who wrote the reports, how many we hold from each, and where they work.' },
]);

/** Is this path inside the research section? Used by the sidebar too. */
export function inResearch(pathname) {
  return String(pathname || '').startsWith('/internal/research');
}

export default function ResearchNav() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Property Research and Resource Center" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase', color: MUTED, marginBottom: 6 }}>
        Property Research &amp; Resource Center
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: '1px solid #E4DECF', paddingBottom: 8 }}>
        {RESEARCH_PAGES.map((p) => {
          // `end` on the section root only — otherwise the first tab would light up
          // on every page inside the section, which is exactly the "which page am I
          // on?" confusion this is meant to end.
          const on = p.end ? pathname === p.to : pathname.startsWith(p.to);
          return (
            <NavLink key={p.to} to={p.to} end={p.end} title={p.blurb}
              style={{
                textDecoration: 'none', fontSize: 13, padding: '6px 11px', borderRadius: 999,
                border: `1px solid ${on ? GOLD : '#E4DECF'}`,
                background: on ? '#FBF6EC' : '#FFFFFF',
                color: on ? INK : '#4B585C',
                fontWeight: on ? 600 : 500,
              }}>
              {p.label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
