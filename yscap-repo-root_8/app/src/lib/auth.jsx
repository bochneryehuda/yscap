import React, { createContext, useContext, useState, useCallback } from 'react';
import { getToken, setToken, clearToken } from './api.js';

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
  const signIn  = useCallback((t) => { setToken(t); setTok(t); }, []);
  const signOut = useCallback(() => { clearToken(); setTok(''); }, []);
  const actor = actorFromToken(token);
  return (
    <Ctx.Provider value={{
      token,
      actor,
      isAuthed: !!token,
      kind:     actor?.kind || null,        // 'borrower' | 'staff'
      role:     actor?.role || null,        // borrower | loan_officer | processor | underwriter | admin | super_admin
      isStaff:  actor?.kind === 'staff',
      isBorrower: actor?.kind === 'borrower',
      signIn, signOut,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
