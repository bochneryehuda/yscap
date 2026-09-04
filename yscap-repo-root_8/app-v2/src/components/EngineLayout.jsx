import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useStaleBuild, StaleBuildBanner } from '../lib/useStaleBuild.jsx';
import StaffViewBanner from './StaffViewBanner.jsx';

/**
 * PILOT ENGINE — the pricing engine on its own, at its own address.
 *
 * ── THE OWNER'S ASK, IN WRITING (2026-09-04) ───────────────────────────────
 * *"a straight URL that will take them directly to our pricing engine… it's
 * gonna be bigger on your screen because you're not gonna have the left menu…
 * same logins, same passwords, same usernames, same team members, same
 * everything."* And, three times over: **"don't reproduce anything."**
 *
 * ── THIS FILE IS CHROME. IT IS NOT AN ENGINE. ──────────────────────────────
 *
 * ⛔ NOT ONE PRICING SCREEN IS COPIED, RE-EXPORTED OR FORKED HERE. `/engine`
 * mounts the SAME `LtPricer`, `LtCombinedPricer`, `LtScenarios`, `LtSheetLookup`
 * and `LtPpe` components the console mounts — the identical imports in
 * `App.jsx`, one module each. So there is nothing to keep in step: a change to
 * the pricer IS a change to Pilot Engine, because there is only one pricer.
 * `scripts/test-pilot-engine-pure.mjs` fails the build if that ever stops being
 * true.
 *
 * WHAT THE SHORTCUT ACTUALLY SAVES is `StaffLayout` — the console's left menu,
 * which is the only thing that was ever wrapped around these screens. The
 * screens draw no navigation of their own (`LtLayout` renders a scope banner
 * and a title, nothing more), so "bigger on your screen" is achieved by leaving
 * the menu off rather than by building anything.
 *
 * ⛔ AND IT IS NOT A SECOND FRONT DOOR. There is no engine login, no engine
 * session, no engine permission. `EnginePrivate` in `App.jsx` runs the SAME
 * checks `StaffPrivate` runs and differs by one line — which shell it wraps the
 * screen in. A staffer signed in here is signed in there, and the same person
 * who cannot open the pricer in the console cannot open it here.
 *
 * ⛔ EVERY COLOUR IS AN EXPLICIT DARK. `--ink*` is a LIGHT paper colour in this
 * palette and renders white on white.
 *
 * ── WHY THIS FILE IS NOT IN `longterm/` ────────────────────────────────────
 * It was, and the two-product separation gate was right to refuse it. This is
 * CHROME, not Long-Term code: it renders `children` and imports not one
 * Long-Term module — what it does import is the SHARED IDENTITY zone
 * (`lib/auth.jsx`), which is the one thing the two products are allowed to
 * share and which `StaffLayout` beside it uses for exactly the same reason.
 * Filing it under `longterm/` would have made a Long-Term file reach into RTL,
 * which is the crossing the rule exists to stop. It belongs with its siblings,
 * `StaffLayout` and `TpoLayout` — the shells `App.jsx` chooses between.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const LINE = 'rgba(20,27,34,.10)';

/* THE ENGINE'S OWN SCREENS, and the list is deliberately short.
   The owner: *"In the admin settings, you can leave everything in the admin."*
   So this carries what somebody PRICES with; the rule centre, the rate-sheet
   settings and every admin screen stay in the console, where the people who
   change them already work. Adding one here is a line in this array and a route
   in App.jsx — never a new screen. */
export const ENGINE_TABS = [
  { to: '/engine', end: true, label: 'Pricer' },
  { to: '/engine/combined', label: 'Combined' },
  { to: '/engine/scenarios', label: 'Scenarios' },
  { to: '/engine/sheets', label: 'Rate sheets' },
  { to: '/engine/ppe', label: 'Brackets' },
];

const tabStyle = ({ isActive }) => ({
  display: 'inline-flex', alignItems: 'center', padding: '7px 13px', borderRadius: 999,
  fontSize: 13.5, fontWeight: isActive ? 700 : 550, textDecoration: 'none',
  color: isActive ? '#FFFFFF' : MUTED,
  background: isActive ? GOLD : 'transparent',
  border: `1px solid ${isActive ? GOLD : 'transparent'}`,
});

export default function EngineLayout({ children }) {
  const { signOut } = useAuth();
  const nav = useNavigate();
  /* ⛔ EVERY SHELL MOUNTS THE STALE-BUILD WATCHDOG (CLAUDE.md, by name), and this
     shell needs it more than the others do: the owner asked for a BOOKMARK, which
     is a long-lived tab, and a long-lived tab running yesterday's bundle is the
     exact incident the watchdog was built after. */
  const staleBuild = useStaleBuild();

  /* HOW TALL IS THE BANNER STACK RIGHT NOW. A MutationObserver as well as a
     ResizeObserver, because the staff-view bar arrives LATE — it appears only
     after `/api/staff-view/session` answers, so a height taken at mount would be
     zero and the header would be buried the moment it lands. */
  const bannersRef = useRef(null);
  const [bannerH, setBannerH] = useState(0);
  useEffect(() => {
    const el = bannersRef.current;
    if (!el) return undefined;
    const apply = () => setBannerH(Math.round(el.getBoundingClientRect().height));
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    if (ro) ro.observe(el);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(apply) : null;
    if (mo) mo.observe(el, { childList: true, subtree: true });
    window.addEventListener('resize', apply);
    window.addEventListener('load', apply);
    return () => {
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      window.removeEventListener('resize', apply);
      window.removeEventListener('load', apply);
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#F6F3EC', paddingTop: bannerH }}>
      {/* ── THE BANNER STACK, AND WHY IT IS MEASURED ────────────────────────
          A staff-view token IS a staff token, so a super admin standing inside a
          teammate's console is admitted here; without a banner they had no notice
          and no way back, since this shell's only other exits are "Full system"
          and "Sign out" and signing out of somebody else's session is wrong.

          ⛔ BUT ADDING THEM COVERED THE ENGINE'S ONLY NAVIGATION. Both banners
          are `position: fixed` at the same top, so a re-audit MEASURED them
          sitting on top of each other AND over the sticky header: 52 of its 58
          pixels hidden behind a z-1001 bar, taking the lockup, the whole tab row
          and the "Full system" way out with them — and on a phone the first tab
          row too. The console survives that because it has a sidebar; the
          engine's header IS its navigation, so here it is a dead end.

          So the two are stacked IN FLOW inside one fixed container and the
          container is MEASURED: the shell pads by its height and the sticky
          header starts below it. Measured rather than a constant because the
          bars wrap to two and three lines on a phone and grow again when the web
          fonts land — the same reason CobrowseHost measures its own. */}
      <div ref={bannersRef} style={{
        position: 'fixed', top: 'var(--cobrowse-bar, 0px)', left: 0, right: 0, zIndex: 1001,
      }}>
        <StaffViewBanner inFlow />
        <StaleBuildBanner stale={staleBuild} inFlow />
      </div>
      <header style={{
        position: 'sticky', top: `calc(var(--cobrowse-bar, 0px) + ${bannerH}px)`, zIndex: 30, background: '#FFFFFF',
        borderBottom: `1px solid ${LINE}`, padding: '10px 18px',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        {/* THE PILOT LOCKUP IS THE SITE'S OWN, not a second wordmark — the
            owner asked for "the Pilot brand with the Pilot logo" and a new NAME
            beside it, which is what the badge is. */}
        <span className="pilot-lockup" aria-hidden="true"><span className="pilot-mark" /></span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 17, fontWeight: 800, color: INK, letterSpacing: '.01em' }}>PILOT</span>
          <span style={{
            fontSize: 11.5, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase',
            color: GOLD, border: `1px solid rgba(174,135,70,.42)`, borderRadius: 999, padding: '2px 9px',
          }}>Engine</span>
        </span>

        <nav style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 8 }}>
          {ENGINE_TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} style={tabStyle}>{t.label}</NavLink>
          ))}
        </nav>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* THE WAY BACK INTO THE FULL SYSTEM. A shortcut that traps you is not
              a shortcut; this is the same session, so it is one click and no
              second sign-in. */}
          <button type="button" className="btn ghost small" onClick={() => nav('/internal/lt/pricer')}>
            Full system
          </button>
          <button type="button" className="btn ghost small" data-cobrowse-nodrive="sign-out"
            onClick={() => { signOut(); nav('/engine'); }}>Sign out</button>
        </div>
      </header>

      {/* WIDE ON PURPOSE. The console constrains these screens to the width the
          left menu leaves them; the whole point of the shortcut is the width
          back. A board is a wide table and reads badly in a column. */}
      <main style={{ padding: '18px 18px 48px', maxWidth: 2200, margin: '0 auto' }}>
        {children}
      </main>
    </div>
  );
}
