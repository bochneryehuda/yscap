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
/**
 * ⛔ WHAT THE PROBE DECIDES, AS A FUNCTION SOMEBODY CAN CALL.
 *
 * Three outcomes and they are NOT two: a session that says "you are in a view"
 * (show whose), a session that says you are not (show nothing), and an answer we
 * could not get at all (say so). The third is the whole point — swallowing it
 * rendered nothing, which reads as the second, and on the engine shell this bar is
 * the ONLY thing that says whose session you are in.
 *
 * Retried once, because a single blip should not put a notice on anybody's screen;
 * `sleep` is injectable so a test does not wait a real second and a half.
 * NEVER throws — the caller is an effect with no catch of its own.
 */
export async function probeStaffView(ask, opts = {}) {
  const retries = Number.isFinite(opts.retries) ? opts.retries : 1;
  const delay = Number.isFinite(opts.delay) ? opts.delay : 1500;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  /* ⛔ THE LOOP IS BOUNDED BY ITS HEAD, NOT ONLY BY THE RETURN INSIDE IT. An unbounded
     `for (;;)` whose sole exit is a branch means any mutation of that branch spins forever —
     and a hung suite is not a clean red, it is a suite that never answers (this file's own
     "a CRASHING test also fails and looks like proof"). Measured: it hung the run. */
  for (let left = retries; left >= 0; left -= 1) {
    let answered = null;
    try {
      answered = { s: await ask() };
    } catch (_) {
      if (left <= 0) return { viewing: null, unknown: true };
      await sleep(delay);
    }
    if (answered) {
      const s = answered.s;
      if (s && s.active) return { viewing: s.viewing || {}, unknown: false };
      return { viewing: null, unknown: false };
    }
  }
  /* Fell out of the loop without an answer: we could not get one. Saying so is the
     honest state and is what the bar renders; the loop above can only reach here by
     exhausting its retries. */
  return { viewing: null, unknown: true };
}

export default function StaffViewBanner({ inFlow = false, hint = '' }) {
  const { exitStaffView } = useAuth();
  const [viewing, setViewing] = useState(null);
  const [unknown, setUnknown] = useState(false);

  /* Probed once per mount: the answer cannot change without the token changing,
     and a token change remounts the app. The DECIDING is `probeStaffView` below —
     a plain function a test can call — because the properties that matter here
     (it retries once; an exhausted retry reports "cannot tell"; a resolved
     "not in a view" reports nothing) live in a `useEffect`, and this project has
     no DOM in CI, so a source regex was the only thing holding them. Five
     mutations walked straight through that regex (post-merge audit of #1451):
     the retry disarmed, both `alive` guards deleted, and `setUnknown` wrapped in
     a dead branch — all green, all fail-OPEN in production. */
  useEffect(() => {
    let alive = true;
    probeStaffView(() => api.staffViewSession()).then((r) => {
      if (!alive) return;
      if (r.viewing) setViewing(r.viewing);
      else if (r.unknown) setUnknown(true);
    });
    return () => { alive = false; };
  }, []);

  if (!viewing && !unknown) return null;

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
      /* ⛔ `flexWrap` IS PART OF THE inFlow BRANCH, and that is not tidiness.
         It was written OUTSIDE the ternary, so it applied to the console too —
         and a re-audit MEASURED the console's own bar growing 65px -> 86px at
         900 and 115px -> 137px at 390, because the button dropped onto its own
         line. The extraction's whole promise, stated two lines up, is that the
         console renders exactly as before; a promise the code does not keep is
         worse than no promise. The console has never had the wrap and now does
         not; the engine keeps it.

         ⛔ AND THE REASON THE ENGINE KEEPS IT IS THE MEASURED ONE, not the one
         first written here. That said the contents "would otherwise run off the
         side" on a phone, and a re-audit MEASURED it and they do not: the flex
         items shrink and their text wraps internally, so at 390 the bar is 149px
         instead of 168 and the button's right edge lands at 376 of 390 — inside
         the screen, squeezed against the sentence. What the wrap actually buys
         is that the way OUT of somebody else's session sits on its OWN line
         (button top 42, sentence bottom 30) rather than as a sliver beside it,
         which on the one bar whose job is to let you leave is worth having.
         Pinned as E10 in `scripts/render-pilot-engine.mjs`, the only thing that
         can hold a geometry claim; a note whose reason is wrong is worse than no
         note, because the next person budgets against it. */
      /* ⛔ THE "CANNOT TELL" BAR IS ALWAYS IN FLOW, wherever it is mounted. The console
         reserves no space for a fixed bar (no paddingTop, no [data-top-banner] rule), so a
         fixed one overlays the top of its sidebar and content — pre-existing for the navy
         bar, but this grey one is a NEW trigger for it: it appears for an ordinary staff
         user whose probe fails, a state that previously rendered nothing at all. Taking
         space is right for it anyway; it is a notice, not a persistent "this is not your
         session" marker that must stay pinned. The navy bar's behaviour is unchanged. */
      ...((inFlow || !viewing)
        ? { position: 'static', flexWrap: 'wrap' }
        : { position: 'fixed', top: 'var(--cobrowse-bar, 0px)', left: 0, right: 0, zIndex: 1001 }),
      /* The unsure bar is a QUIETER colour on purpose: it reports that PILOT could
         not check, which is a different fact from "this is somebody else's screen"
         and must not read as the same alarm. */
      background: viewing ? '#1F3864' : '#4B585C', color: '#fff', padding: '8px 14px', display: 'flex',
      alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 14,
    }}>
      {/* THE HINT IS THE CALLER'S, because it is only true where the caller is.
          The console's version said "Switch Long-term / Short-term above to see
          everything they see", and extracting this component silently dropped
          it — a re-audit caught that. It is right for the console (the product
          switch is in its sidebar) and would be a lie in the engine, which has
          no such switch. So the console passes it and the engine does not. */}
      {viewing ? (
        <>
          <span>You are seeing <strong>{viewing.name || 'a team member'}</strong>’s screen — read-only.{hint ? ` ${hint}` : ''}</span>
          <button className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }}
            onClick={leave}>Back to my own screen</button>
        </>
      ) : (
        /* No way out is offered here, deliberately: we do not know that there is
           anything to leave, and calling the exit handoff when nobody is in a view
           would take a working session apart to fix a question mark. Reloading is
           the honest advice, and it re-asks. */
        <span>PILOT could not check whose screen this is — if you opened a team member’s screen, treat this as theirs. Reload to check again.</span>
      )}
    </div>
  );
}
