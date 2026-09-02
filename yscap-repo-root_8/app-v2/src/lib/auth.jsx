import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { getToken, setToken, clearToken, api } from './api.js';

/* Decode the JWT payload (base64url) WITHOUT verifying — this is only used to
   route the SPA (borrower vs. staff, and which staff role). Every API call is
   still verified server-side, so a tampered token buys nothing. */
export function actorFromToken(t) {
  if (!t) return null;
  try {
    const part = t.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    const p = JSON.parse(json);
    return {
      id: p.sub, kind: p.kind, role: p.role,
      // BORROWER VIEW envelope (see src/lib/borrower-view.js). Present only on a
      // "viewing as a borrower" token. Decoding it here — rather than waiting on
      // a round-trip — means the banner renders on the FIRST paint, so a staffer
      // is never looking at a borrower's screen without knowing it.
      impersonation: p.imp ? {
        staffId: p.impBy || null,
        staffRole: p.impRole || null,
        sessionId: p.impSid || null,
        startedAt: (Number(p.impAt) || 0) * 1000,
      } : null,
      // BORROWER ASSISTANT envelope (see src/lib/borrower-assistant.js). Present
      // only on a helper token. Decoded here so the "you're a helper — personal
      // details hidden, you can't sign" banner renders on the FIRST paint and the
      // sign buttons never flash enabled.
      assistant: !!p.asst,
    };
  } catch { return null; }
}

/* Where a staffer's OWN console token is parked while they are inside a
   borrower view, so "back to my console" is instant and works offline. The
   server also mints a fresh one on exit — that is the authoritative path; this
   is the fallback for when the network is down. */
const STAFF_TOKEN_KEY = 'ys_portal_staff_token';
const stashStaffToken = (t) => { try { t ? sessionStorage.setItem(STAFF_TOKEN_KEY, t) : sessionStorage.removeItem(STAFF_TOKEN_KEY); } catch { /* private mode */ } };
const readStaffToken = () => { try { return sessionStorage.getItem(STAFF_TOKEN_KEY) || ''; } catch { return ''; } };

/* WHERE THE STAFFER WAS when they stepped into a view — parked beside their token
   (owner-reported 2026-09-01: after "Done" on a borrower view "they get back, out of
   the blue, somewhere. They need to get back exactly where they were before" — the
   file they were in, the tab they had open). The console is a HashRouter app, so the
   hash IS the location, including the file's section deep link. Written by the three
   start* handoffs below, consumed ONCE by the matching exit. Nothing else reads it. */
const RETURN_TO_KEY = 'ys_portal_return_to';
const currentConsolePath = () => {
  try {
    const h = String(window.location.hash || '');
    const path = h.startsWith('#') ? h.slice(1) : h;
    // Only a real console location is worth returning to — never the sign-in screen
    // or an empty hash, which would send somebody back to nowhere.
    return path && path.startsWith('/internal') && !path.startsWith('/internal/login') ? path : '';
  } catch { return ''; }
};
const stashReturnTo = (path) => { try { path ? sessionStorage.setItem(RETURN_TO_KEY, path) : sessionStorage.removeItem(RETURN_TO_KEY); } catch { /* private mode */ } };
/** Read AND clear the parked location, or '' when none was parked. */
export const takeReturnTo = () => {
  try { const v = sessionStorage.getItem(RETURN_TO_KEY) || ''; sessionStorage.removeItem(RETURN_TO_KEY); return v; } catch { return ''; }
};

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTok] = useState(getToken());
  // Effective capabilities for the signed-in staffer (from /auth/me). The JWT
  // only carries the role; permissions are resolved server-side, so we fetch
  // them and expose can(cap) for nav/screen gating that mirrors the API gates.
  const [perms, setPerms] = useState([]);
  // Who the borrower view is being viewed AS + who is really looking. Filled
  // from /auth/me the moment a borrower-view token is in play, so the banner can
  // name the borrower rather than just saying "a borrower".
  const [viewingAs, setViewingAs] = useState(null);
  // Named from /auth/me for a helper (assistant) session: who they're helping.
  const [assistantOf, setAssistantOf] = useState(null);
  const signIn  = useCallback((t) => { setToken(t); setTok(t); }, []);
  const signOut = useCallback(() => {
    // Revoke server-side first (bumps token_version, killing every copy of the
    // token in other tabs/devices), then clear locally. Best-effort: local
    // sign-out must work even if the server is unreachable. A HELPER session must
    // sign OUT of its OWN credential — /auth/logout would bump the BORROWER's
    // token_version (and is blocked for a helper anyway).
    try {
      if (actorFromToken(getToken())?.assistant) api.assistantLogout().catch(() => {});
      else api.post('/auth/logout').catch(() => {});
    } catch { /* ignore */ }
    clearToken(); setTok('');
    // Defense-in-depth: wipe the PWA shell cache on logout (it never holds PII,
    // but this keeps a shared device clean).
    try { navigator.serviceWorker?.controller?.postMessage('ys-clear-cache'); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    // Stay in lock-step with the token wherever it changes:
    // - ys:auth-changed: this tab's API layer stored a refreshed token or
    //   cleared an expired one (global 401 handling).
    // - storage: another tab signed in/out — without this, switching back to
    //   an old tab left it running on a stale session (the "have to clear my
    //   cookies" bug).
    const sync = () => setTok(getToken());
    window.addEventListener('ys:auth-changed', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('ys:auth-changed', sync); window.removeEventListener('storage', sync); };
  }, []);
  const actor = actorFromToken(token);
  const isStaff = actor?.kind === 'staff';
  const isTpo   = actor?.kind === 'tpo';
  const impersonation = actor?.impersonation || null;
  const isAssistant = !!actor?.assistant;
  useEffect(() => {
    let live = true;
    if (isStaff) {
      api.me().then((r) => { if (live) setPerms(Array.isArray(r?.permissions) ? r.permissions : []); }).catch(() => {});
      setViewingAs(null); setAssistantOf(null);
    } else if (isAssistant) {
      // Name the borrower being helped for the banner. /auth/me carries `name`
      // (the helper's own name) + the borrower identity.
      setPerms([]); setViewingAs(null);
      api.me().then((r) => {
        if (!live) return;
        setAssistantOf({
          borrowerName: [r?.first_name, r?.last_name].filter(Boolean).join(' ').trim() || r?.email || 'this borrower',
          helperName: r?.name || null,
        });
      }).catch(() => { if (live) setAssistantOf({ borrowerName: 'this borrower', helperName: null }); });
    } else {
      setPerms([]); setAssistantOf(null);
      // A tpo view (kind:'tpo' + impersonation) is NOT a borrower view — its
      // banner self-fetches from /api/tpo-view/session, so we do not run the
      // borrower /auth/me effect for it.
      if (impersonation && actor?.kind === 'borrower') {
        // Name the borrower + the real staffer for the banner. `me` carries the
        // impersonation block for exactly this.
        api.me().then((r) => {
          if (!live) return;
          setViewingAs({
            borrowerName: [r?.first_name, r?.last_name].filter(Boolean).join(' ').trim() || r?.email || 'this borrower',
            borrowerEmail: r?.email || null,
            staffName: r?.impersonation?.staffName || null,
            staffRole: r?.impersonation?.staffRole || impersonation.staffRole,
            expiresAt: r?.impersonation?.expiresAt || null,
          });
        }).catch(() => {});
      } else {
        setViewingAs(null);
      }
    }
    return () => { live = false; };
  }, [token, isStaff, isAssistant, impersonation?.sessionId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const can = useCallback((cap) => perms.includes(cap), [perms]);

  /* Step INTO a borrower's portal. Parks the staff token, swaps in the
     borrower-view token, and hands back where to land. */
  const startBorrowerView = useCallback(async (borrowerId, applicationId) => {
    const r = await api.borrowerViewStart(borrowerId, applicationId);
    stashStaffToken(getToken());          // park my own console session
    stashReturnTo(currentConsolePath());  // ...and where I was, so "Done" brings me back here
    setToken(r.token); setTok(r.token);
    return r;
  }, []);

  /* Step back OUT. The server mints a fresh staff token (authoritative — it
     works even if the parked one expired while we were inside); the parked copy
     is the offline fallback so a network blip can never strand someone inside
     another person's portal. */
  const exitBorrowerView = useCallback(async () => {
    let staffToken = '';
    try {
      const r = await api.borrowerViewExit();
      staffToken = r?.token || '';
    } catch { /* fall through to the parked token */ }
    if (!staffToken) staffToken = readStaffToken();
    stashStaffToken('');
    if (staffToken) { setToken(staffToken); setTok(staffToken); return true; }
    // Neither path produced a session: the staff account was deactivated or
    // revoked while they were inside. Drop the borrower token and make them
    // sign in — never leave the borrower session in place.
    clearToken(); setTok('');
    return false;
  }, []);

  /* TPO VIEW — the exact mirror of borrower view for the broker portal. Step
     INTO a broker's login: park the staff token, swap in the tpo-view token. */
  const startTpoView = useCallback(async (tpoUserId, applicationId) => {
    const r = await api.tpoViewStart(tpoUserId, applicationId);
    stashStaffToken(getToken());          // park my own console session
    stashReturnTo(currentConsolePath());  // ...and where I was, so "Done" brings me back here
    setToken(r.token); setTok(r.token);
    return r;
  }, []);

  /* Step back OUT of a broker view. Same handoff as borrower view: the server
     mints a fresh staff token (authoritative), with the parked copy as the
     offline fallback so a network blip never strands the staffer inside a
     broker's portal. */
  const exitTpoView = useCallback(async () => {
    let staffToken = '';
    try {
      const r = await api.tpoViewExit();
      staffToken = r?.token || '';
    } catch { /* fall through to the parked token */ }
    if (!staffToken) staffToken = readStaffToken();
    stashStaffToken('');
    if (staffToken) { setToken(staffToken); setTok(staffToken); return true; }
    clearToken(); setTok('');
    return false;
  }, []);

  /* STAFF VIEW — the third sibling, and the one the OWNER asked for on the RTL
     team screen (2026-08-26): *"on the RTL side of the team section … I should
     also have the button to make myself, like anyone on the team, a login to see
     what they see when they are logged in. The same way we have it for long
     term, the same way we have for TPOs and for borrowers."*

     THE SERVER ALREADY HELD EVERY RULE — super-admin only, read-only wholesale,
     an active internal target, never yourself, no nesting, recorded in the
     session register — and the console-wide banner and exit were already in
     StaffLayout. What was missing was the DOOR: the only button that started one
     lived on the LONG-TERM People screen, so a super admin could step into a
     teammate's console from one product and not the other.

     This is the RTL half of the handoff, written exactly like its two siblings so
     the three cannot drift. The LONG-TERM screen keeps its own inline copy on
     purpose: LT front-end code may not import an RTL module (the product
     separation rule), and the client half is only "park my token, take theirs" —
     every decision that matters is the server's. */
  const startStaffView = useCallback(async (staffId) => {
    const r = await api.staffViewStart(staffId);
    stashStaffToken(getToken());          // park my own console session
    stashReturnTo(currentConsolePath());  // ...and where I was, so "Done" brings me back here
    setToken(r.token); setTok(r.token);
    return r;
  }, []);

  /* Step back OUT of a teammate's console. Same handoff as the other two: the
     server mints a fresh token for the REAL viewer (authoritative — it works even
     if the parked copy expired while we were inside), with the parked copy as the
     offline fallback so a network blip can never strand somebody inside another
     person's console. Neither path producing a session means sign in again; we
     never leave the target's session in place. */
  const exitStaffView = useCallback(async () => {
    let own = '';
    try {
      const r = await api.staffViewExit();
      own = r?.token || '';
    } catch { /* fall through to the parked token */ }
    if (!own) own = readStaffToken();
    stashStaffToken('');
    if (own) { setToken(own); setTok(own); return true; }
    clearToken(); setTok('');
    return false;
  }, []);

  return (
    <Ctx.Provider value={{
      token,
      actor,
      isAuthed: !!token,
      kind:     actor?.kind || null,        // 'borrower' | 'staff'
      role:     actor?.role || null,        // borrower | loan_officer | processor | underwriter | admin | super_admin | loan_coordinator | software_setup
      isStaff,
      isTpo,
      isBorrower: actor?.kind === 'borrower',
      permissions: perms,
      can,
      signIn, signOut,
      // Borrower view: truthy whenever this session is a staffer standing
      // inside a BORROWER's portal (kind:'borrower' + an impersonation envelope).
      // A tpo view carries the same envelope on a kind:'tpo' token, so key on the
      // kind too — the two surfaces are distinct.
      impersonation,
      isBorrowerView: actor?.kind === 'borrower' && !!impersonation,
      viewingAs,
      startBorrowerView, exitBorrowerView,
      // TPO view: a staffer standing inside a BROKER's portal.
      isTpoView: isTpo && !!impersonation,
      startTpoView, exitTpoView,
      // Staff view: a super admin standing inside ANOTHER STAFFER's console. The
      // envelope is a different one (impStaff* rather than imp*) so no reader can
      // mistake one surface for another, which is why this is not derived from
      // `impersonation` here — StaffLayout probes /api/staff-view/session, the
      // server's own answer, and renders the banner from that.
      startStaffView, exitStaffView,
      // Borrower helper (assistant): truthy when this is a helper login, plus who
      // they are helping (for the banner). Drives the PII banner + sign disabling.
      isAssistant,
      assistantOf,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);

/* One-shot "why am I on the login screen" notice (e.g. "your session expired"),
   set by the API layer when it force-signs-out. Read once, then cleared, so it
   doesn't linger after the next successful sign-in. */
export function useAuthNotice() {
  const [notice] = useState(() => {
    try {
      const n = sessionStorage.getItem('ys_auth_notice') || '';
      if (n) sessionStorage.removeItem('ys_auth_notice');
      return n;
    } catch { return ''; }
  });
  return notice;
}
