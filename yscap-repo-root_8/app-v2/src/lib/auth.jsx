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
    return { id: p.sub, kind: p.kind, role: p.role };
  } catch { return null; }
}

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTok] = useState(getToken());
  // Effective capabilities for the signed-in staffer (from /auth/me). The JWT
  // only carries the role; permissions are resolved server-side, so we fetch
  // them and expose can(cap) for nav/screen gating that mirrors the API gates.
  const [perms, setPerms] = useState([]);
  const signIn  = useCallback((t) => { setToken(t); setTok(t); }, []);
  const signOut = useCallback(() => {
    // Revoke server-side first (bumps token_version, killing every copy of the
    // token in other tabs/devices), then clear locally. Best-effort: local
    // sign-out must work even if the server is unreachable.
    try { api.post('/auth/logout').catch(() => {}); } catch { /* ignore */ }
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
  useEffect(() => {
    let live = true;
    if (isStaff) {
      api.me().then((r) => { if (live) setPerms(Array.isArray(r?.permissions) ? r.permissions : []); }).catch(() => {});
    } else {
      setPerms([]);
    }
    return () => { live = false; };
  }, [token, isStaff]);
  const can = useCallback((cap) => perms.includes(cap), [perms]);
  return (
    <Ctx.Provider value={{
      token,
      actor,
      isAuthed: !!token,
      kind:     actor?.kind || null,        // 'borrower' | 'staff'
      role:     actor?.role || null,        // borrower | loan_officer | processor | underwriter | admin | super_admin | loan_coordinator | software_setup
      isStaff,
      isBorrower: actor?.kind === 'borrower',
      permissions: perms,
      can,
      signIn, signOut,
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
