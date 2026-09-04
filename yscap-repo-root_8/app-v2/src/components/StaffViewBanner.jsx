import React, { useEffect, useState } from 'react';
import { useAuth, takeReturnTo } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

/**
 * STAFF VIEW banner — the third sibling of `TpoViewBanner` and the borrower one.
 *
 * While a super admin is standing inside a TEAMMATE'S console, every screen must
 * say so unmissably and must carry the way out. `StaffLayout`'s own comment has
 * always stated the rule: *"it must say so on every screen, both products,
 * unmissably."*
 *
 * ── WHY IT IS A COMPONENT NOW, AND NOT A BLOCK OF JSX IN ONE SHELL ─────────
 *
 * It lived inline in `StaffLayout`, which was fine while `StaffLayout` was the
 * only internal shell. Pilot Engine is a SECOND internal shell, and a staff-view
 * token carries `kind:'staff'` — so a super admin inside somebody's console who
 * opens `/engine` was admitted with no banner and no way back, on a surface
 * whose only exits are "Full system" and "Sign out" (and signing out is the
 * wrong action on an impersonated session). Copying the block into the new shell
 * would have been the second copy this repo's rules forbid: two banners drift,
 * and the one that drifts is the one that stops saying whose screen this is.
 *
 * It SELF-FETCHES, exactly as `TpoViewBanner` does, so a shell mounts it with no
 * state of its own and cannot get the wiring subtly wrong.
 *
 * ⛔ THE EXIT GOES THROUGH THE SHARED HANDOFF (`auth.jsx exitStaffView`) — ask
 * the server for a fresh token for the REAL viewer, fall back to the copy parked
 * in sessionStorage when the network is unavailable, and if NEITHER produces a
 * session drop the token and make them sign in rather than leave them sitting
 * inside somebody else's console. Never a fourth hand-rolled copy of that dance.
 */
export default function StaffViewBanner({ inFlow = false, hint = '' }) {
  const { exitStaffView } = useAuth();
  const [viewing, setViewing] = useState(null);

  /* Probed once per mount: the answer cannot change without the token changing,
     and a token change remounts the app. */
  useEffect(() => {
    let alive = true;
    api.staffViewSession().then((s) => {
      if (alive && s && s.active) setViewing(s.viewing || {});
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!viewing) return null;

  const leave = async () => {
    const restored = await exitStaffView();
    /* Back to where the super admin was before they opened the teammate's screen
       (owner-reported 2026-09-01), else the console home. The navigation stays
       explicit because the token has changed under the running app. */
    const back = restored ? (takeReturnTo() || '/internal') : '';
    window.location.assign(restored ? `/portal/#${back}` : '/');
    window.location.reload();
  };

  return (
    <div role="alert" data-top-banner="1" style={{
      /* IN FLOW when a shell stacks its own banners (see EngineLayout): two
         `position: fixed` bars both pinned to the same top COVER EACH OTHER —
         measured, the stale-build notice was entirely hidden behind this one —
         and together they covered the engine's only navigation. Default is
         unchanged, so the console renders exactly as before. */
      ...(inFlow ? { position: 'static' } : { position: 'fixed', top: 'var(--cobrowse-bar, 0px)', left: 0, right: 0, zIndex: 1001 }),
      background: '#1F3864', color: '#fff', padding: '8px 14px', display: 'flex',
      alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 14, flexWrap: 'wrap',
    }}>
      {/* THE HINT IS THE CALLER'S, because it is only true where the caller is.
          The console's version said "Switch Long-term / Short-term above to see
          everything they see", and extracting this component silently dropped
          it — a re-audit caught that. It is right for the console (the product
          switch is in its sidebar) and would be a lie in the engine, which has
          no such switch. So the console passes it and the engine does not. */}
      <span>You are seeing <strong>{viewing.name || 'a team member'}</strong>’s screen — read-only.{hint ? ` ${hint}` : ''}</span>
      <button className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }}
        onClick={leave}>Back to my own screen</button>
    </div>
  );
}
