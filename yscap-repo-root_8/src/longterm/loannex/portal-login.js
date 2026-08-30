'use strict';
/**
 * LONG-TERM — LoanNEX stage 1: the PORTAL SIGN-IN.
 *
 * WHY THIS IS ITS OWN MODULE. Stages 2 and 3 (ticket → bearer) are plain JSON
 * against the pricing API. Stage 1 is a completely different animal: an ASP.NET
 * Core *form* session on the portal host, with an antiforgery token, a cookie
 * jar and an HTML scrape. Mixing the two in one file would put a cookie jar and
 * an HTML parser inside a module whose whole point is that it only ever speaks
 * read-only JSON. So the portal lives here, behind its own allowlist.
 *
 * ── DECODED FROM THE RECORDING, NOT GUESSED ────────────────────────────────
 * The 2026-08-30 login/logout capture contains the sign-in three times on the
 * aggregator portal and three more times on each investor portal. Every part of
 * the request below is read off those entries:
 *
 *   POST {portal}/Account/Login
 *     Content-Type: application/x-www-form-urlencoded; charset=UTF-8
 *     X-Requested-With: XMLHttpRequest        ← the app posts this by XHR
 *     Origin / Referer: the portal root       ← the form lives on `/`
 *     body: ReturnUrl=&Tags=&UserName=…&Password=…&__RequestVerificationToken=…
 *   → 200, a 122-byte JSON body
 *
 *   GET {portal}/iframe/loadiframe?_id=&page=nex-app[&portal={name}]
 *   → HTML whose iframe src carries `tokenKey={guid}` — stage 2's ticket.
 *
 * ── THE PORTAL PARAMETER IS REAL AND IT WAS MISSING ────────────────────────
 * On the aggregator the URLs are bare. On an INVESTOR portal both the iframe
 * loader and the app URL carry `?portal=acracorrespondent` / `?portal=nqmfcorr`.
 * Measured, not assumed: it appears on every investor-portal entry in the
 * capture and on none of the aggregator's.
 *
 * ── SUCCESS IS JUDGED BY OUTCOME, NEVER BY GUESSING THE BODY ───────────────
 * The recorder captured the login response's SIZE (122 bytes, JSON) but not its
 * TEXT, so the success contract is unknown. Rather than invent one, this module
 * asks the question that actually matters — *did a ticket appear?* — and treats
 * a ticket as the proof of sign-in. If the body happens to parse and carries a
 * message, that message is quoted in the failure so a human sees the vendor's
 * own words; but nothing DEPENDS on a shape nobody has seen.
 *
 * ── THE ANTIFORGERY PAIR ───────────────────────────────────────────────────
 * `__RequestVerificationToken` beginning `CfDJ8` is ASP.NET Core Data
 * Protection, so this is the framework's standard double-submit: a hidden form
 * input that must be posted back TOGETHER WITH the matching cookie. That is why
 * a cookie jar is not optional here — posting the token without its cookie
 * fails exactly like a wrong password, which is the confusing failure this
 * comment exists to prevent.
 *
 * ── READ-ONLY, STILL ───────────────────────────────────────────────────────
 * Signing in is the precondition for reading prices, not a write to a loan.
 * This module's allowlist contains four paths and none of them can reach a lock
 * or a registration; the pricing client keeps its own separate allowlist.
 *
 * SEPARATION: LT-only. No database, no RTL import.
 */

// ── The portal allowlist ────────────────────────────────────────────────────
// Everything stage 1 may ever request. Anything else throws before the wire.
const PORTAL_PATHS = [
  'GET /',                      // the sign-in page — carries the antiforgery pair
  'GET /Account/Login',         // the same form on its own URL (fallback source)
  'POST /Account/Login',        // the sign-in itself
  'GET /iframe/loadiframe',     // the ticket carrier
  'GET /account/Logoff',        // release the portal session (never automatic — see below)
];

function assertPortalPath(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(pathname || '/').split('?')[0] || '/';
  // Case-insensitive: the recording uses `/Account/Login` and `/account/Logoff`
  // in the same session, so the vendor plainly does not care and neither may we.
  const want = `${m} ${p}`.toLowerCase();
  if (PORTAL_PATHS.some((x) => x.toLowerCase() === want)) return true;
  const err = new Error(`loannex_portal_path_blocked: ${m} ${p} is not one of the four sign-in paths this module may request.`);
  err.code = 'loannex_portal_path_blocked';
  throw err;
}

// ── A minimal cookie jar ────────────────────────────────────────────────────
// `fetch` carries no cookies of its own, and the antiforgery cookie plus the
// auth cookie are what make the whole sequence work. Deliberately small: one
// host, no domain/path matching, no expiry — a sign-in sequence is three
// requests to one host over a few seconds, and a fuller jar would be more code
// to get wrong for no gain here.
function newJar() { return new Map(); }

/**
 * Read every Set-Cookie off a response.
 *
 * `Headers.getSetCookie` is the correct call and exists from Node 19.7. This
 * package still declares `node >= 18`, so a fallback is real rather than
 * defensive: on 18 the header comes back as ONE comma-joined string, and a
 * naive split on "," destroys `Expires=Wed, 01 Jan …`. The split below only
 * breaks where a comma is followed by something shaped like `name=`.
 */
function setCookiesOf(res) {
  const h = res && res.headers;
  if (!h) return [];
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('set-cookie');
  if (!raw) return [];
  return String(raw).split(/,\s*(?=[^;=,\s]+=)/);
}

function absorb(jar, res) {
  for (const line of setCookiesOf(res)) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    // An expiring/blanked cookie is a DELETE; keeping it would send a dead
    // session token back on the next hop.
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

function cookieHeader(jar) {
  if (!jar || jar.size === 0) return null;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Scrapers ────────────────────────────────────────────────────────────────

/**
 * The antiforgery token out of the sign-in page.
 *
 * Attribute order varies by how the form was rendered (`Html.AntiForgeryToken()`
 * emits name-then-value; a hand-written input often the reverse), so both orders
 * are matched rather than assuming one. The HTML bodies were stripped from the
 * recording, so the markup itself is unverified — which is exactly why a miss
 * FAILS with a plain diagnostic instead of posting without a token and reading
 * the refusal as bad credentials.
 */
function antiforgeryTokenFromHtml(html) {
  const s = String(html || '');
  const both = [
    /name=["']__RequestVerificationToken["'][^>]*?\bvalue=["']([^"']+)["']/i,
    /\bvalue=["']([^"']+)["'][^>]*?name=["']__RequestVerificationToken["']/i,
  ];
  for (const re of both) { const m = s.match(re); if (m) return m[1]; }
  return null;
}

/** Stage 2's ticket, out of the iframe loader's HTML. */
function tokenKeyFromIframeHtml(html) {
  const m = String(html || '').match(/nex-app\?(?:[^"']*?[?&](?:amp;)?)?tokenKey=([0-9a-fA-F-]{16,})/)
        || String(html || '').match(/tokenKey=([0-9a-fA-F-]{16,})/);
  return m ? m[1] : null;
}

/**
 * The vendor's own words about a failed sign-in, if the body happens to say any.
 * NEVER used to decide success — only to explain a failure a human must fix.
 */
function messageFromLoginBody(text) {
  if (!text) return null;
  let j = null;
  try { j = JSON.parse(text); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  for (const k of ['message', 'Message', 'error', 'Error', 'errorMessage', 'description']) {
    if (typeof j[k] === 'string' && j[k].trim()) return j[k].trim();
  }
  return null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/(Password=)[^&\s]*/gi, '$1<redacted>')
    .replace(/(__RequestVerificationToken=)[^&\s]*/gi, '$1<redacted>')
    .replace(/(tokenKey=)[0-9a-fA-F-]{8,}/g, '$1<redacted>');
}

async function portalFetch(host, method, path, { jar, form, headers, timeoutMs } = {}) {
  assertPortalPath(method, path);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 30000);
  const cookie = cookieHeader(jar);
  const h = {
    Accept: form ? 'application/json, text/javascript, */*; q=0.01'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(form ? {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: host,
      Referer: `${host}/`,
    } : {}),
    ...(headers || {}),
  };
  let res;
  try {
    res = await fetch(host + path, {
      method, headers: h,
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'manual', signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(`loannex_portal_network_error: ${scrub(e && e.message)}`);
    err.code = 'loannex_portal_network_error';
    throw err;
  }
  clearTimeout(timer);
  if (jar) absorb(jar, res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}

/**
 * Follow a same-host redirect, carrying the jar. The sign-in page may redirect
 * (`/` → `/Account/Login`), and dropping the cookies on the way would leave the
 * antiforgery pair mismatched. Bounded so a redirect loop cannot hang a request.
 */
async function getFollowing(host, path, jar, opts, hops = 3) {
  let p = path;
  for (let i = 0; i <= hops; i++) {
    const r = await portalFetch(host, 'GET', p, { jar, ...opts });
    if (r.status >= 300 && r.status < 400 && r.location) {
      const loc = String(r.location);
      // Only ever follow WITHIN the portal host: a redirect off-site would carry
      // the session cookies somewhere they do not belong.
      if (/^https?:\/\//i.test(loc) && !loc.startsWith(host)) return r;
      p = loc.startsWith('http') ? loc.slice(host.length) : loc;
      continue;
    }
    return r;
  }
  const err = new Error('loannex_portal_redirect_loop: the sign-in page kept redirecting.');
  err.code = 'loannex_portal_redirect_loop';
  throw err;
}

// ── The sign-in ─────────────────────────────────────────────────────────────

/**
 * Sign in to a portal and come back with stage 2's ticket.
 *
 * @param host      e.g. https://web.loannex.com
 * @param portal    the portal NAME; anything other than `web` also rides as the
 *                  `?portal=` query parameter the investor portals require.
 * @returns { tokenKey, portal, via:'portal_login' }
 */
async function login(host, portal, { username, password, timeoutMs } = {}) {
  if (!username || !password) {
    const err = new Error('loannex_login_not_configured: set NEX_USERNAME and NEX_PASSWORD (or supply NEX_TOKEN_KEY to skip the portal sign-in).');
    err.code = 'loannex_login_not_configured';
    throw err;
  }
  const jar = newJar();
  const opts = { timeoutMs };

  // 1 — the sign-in page: the antiforgery input AND its matching cookie.
  let page = await getFollowing(host, '/', jar, opts);
  let token = antiforgeryTokenFromHtml(page.text);
  if (!token) {
    // The form is on `/` in the recording (the POST's Referer says so). This is
    // the framework's other conventional home for it, tried by NAME rather than
    // guessed at, and a miss still fails closed below.
    page = await getFollowing(host, '/Account/Login', jar, opts);
    token = antiforgeryTokenFromHtml(page.text);
  }
  if (!token) {
    const err = new Error(
      'loannex_antiforgery_not_found: the sign-in page did not carry a __RequestVerificationToken input, so the form cannot be posted. ' +
      'Nothing was sent. (The recorded captures stripped every HTML body, so the page markup is unverified — if the portal has been redesigned this is where it shows.)');
    err.code = 'loannex_antiforgery_not_found';
    throw err;
  }

  // 2 — the sign-in itself. ReturnUrl and Tags are posted EMPTY, exactly as the
  // vendor's own app posts them; omitting a field a model binder expects is its
  // own class of confusing failure.
  const res = await portalFetch(host, 'POST', '/Account/Login', {
    jar,
    form: { ReturnUrl: '', Tags: '', UserName: username, Password: password, __RequestVerificationToken: token },
    timeoutMs,
  });
  const vendorSaid = messageFromLoginBody(res.text);
  if (res.status < 200 || res.status >= 400) {
    const err = new Error(`loannex_login_http_${res.status}: the portal refused the sign-in${vendorSaid ? ` — ${vendorSaid}` : ''}.`);
    err.code = 'loannex_login_failed';
    err.status = res.status;
    throw err;
  }

  // 3 — the ticket. THIS is the proof of sign-in: a signed-out browser gets no
  // tokenKey here, so a ticket means the session is real. We never read the
  // login body's shape to decide it.
  const q = portal && portal !== 'web' ? `&portal=${encodeURIComponent(portal)}` : '';
  const frame = await getFollowing(host, `/iframe/loadiframe?_id=&page=nex-app${q}`, jar, opts);
  const tokenKey = tokenKeyFromIframeHtml(frame.text);
  if (!tokenKey) {
    const err = new Error(
      `loannex_login_failed: signed in but no ticket came back${vendorSaid ? ` — the portal said: ${vendorSaid}` : ''}. ` +
      'That is what a wrong username or password looks like from here; it is also what a new second factor would look like. ' +
      'Check the credentials first, then whether the portal has added a step.');
    err.code = 'loannex_login_failed';
    err.vendorMessage = vendorSaid || null;
    throw err;
  }
  return { tokenKey, portal, via: 'portal_login' };
}

/**
 * Release the portal session.
 *
 * DELIBERATELY NEVER CALLED AUTOMATICALLY. The recording signs off AFTER the
 * ticket has already been exchanged for a bearer, and it does not show whether
 * that bearer keeps working afterwards. Since it might not, signing off on our
 * own initiative would be a guess whose cost is a session dying mid-board. It is
 * offered for a caller that knows it is finished.
 */
async function logoff(host, jar, opts = {}) {
  try { await portalFetch(host, 'GET', '/account/Logoff', { jar, ...opts }); return true; }
  catch (_) { return false; }
}

module.exports = {
  login, logoff,
  _internals: {
    PORTAL_PATHS, assertPortalPath, newJar, absorb, cookieHeader, setCookiesOf,
    antiforgeryTokenFromHtml, tokenKeyFromIframeHtml, messageFromLoginBody, scrub,
    portalFetch, getFollowing,
  },
};
