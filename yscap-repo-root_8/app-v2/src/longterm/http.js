/**
 * Long-Term's OWN fetch helper.
 *
 * WHY THIS IS NOT `../lib/api.js`. Long-Term may not import RTL code — the
 * separation gate catches it, and it is right to: Long-Term "starts at zero", and
 * the only authorized front-end component crossing is BorrowerProfilePanel.jsx.
 * Re-using RTL's client would be convenient and would tie the two products' request
 * layers together, which is exactly what the charter forbids.
 *
 * WHAT IT DOES SHARE — and why that is not a crossing — is the LOGIN. The owner's
 * rule is one login for both sides ("same login same borrower record"), so both
 * products necessarily read the SAME browser token. That is the identity zone, not
 * an import: this file names the storage key and never reaches into RTL's module.
 * If that key ever changes, this line changes with it — a cost the separation is
 * worth, and cheaper than the products sharing a request layer.
 *
 * Deliberately small. No retry ladder, no global session-expiry handling: those
 * belong to the product that owns the screen a user is actually working in, and a
 * side build that is not live must not be able to sign anybody out of the live one.
 * A 401 here surfaces as an ordinary error on a Long-Term screen.
 */

const TOKEN_KEY = 'ys_portal_token';

const token = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

/** A message a person can read, from whatever the server actually sent. */
function messageFor(status, data) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return 'You do not have access to that.';
  if (status === 404) return 'That is not here.';
  if (status >= 500) return 'Something went wrong at our end. Try again in a moment.';
  return 'That did not work.';
}

export async function ltFetch(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON body is fine */ }

  if (!res.ok) {
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const ltGet = (p) => ltFetch('GET', p);
export const ltPost = (p, b) => ltFetch('POST', p, b);
export const ltPut = (p, b) => ltFetch('PUT', p, b);
export const ltPatch = (p, b) => ltFetch('PATCH', p, b);
export const ltDel = (p) => ltFetch('DELETE', p);
