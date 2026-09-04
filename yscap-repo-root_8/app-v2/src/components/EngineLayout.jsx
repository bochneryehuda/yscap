import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

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

  return (
    <div style={{ minHeight: '100vh', background: '#F6F3EC' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 30, background: '#FFFFFF',
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
