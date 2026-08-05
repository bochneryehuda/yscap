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
      if (impersonation) {
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
      // inside a borrower's portal.
      impersonation,
      isBorrowerView: !!impersonation,
      viewingAs,
      startBorrowerView, exitBorrowerView,
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
