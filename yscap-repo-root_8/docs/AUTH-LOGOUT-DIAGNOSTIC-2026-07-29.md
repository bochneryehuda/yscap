# Repeated sign-out reports — diagnostic & resolution (2026-07-29)

Report: several staff members (Simcha Shedrowitzky and others) are pushed back
to the sign-in screen seconds after signing in, over and over, until they clear
their browser's cookies/site data — after which it works.

Two independent diagnostics were run (this session + a second agent). This doc
reconciles them against the actual code on `main` and records what was fixed.

## Where the session actually lives

The portal token is NOT a cookie. It lives in:

- `localStorage` → `ys_portal_token` (the active session; shared across tabs)
- `sessionStorage` → `ys_portal_staff_token` (a staffer's own console token,
  parked while they are inside a borrower view; per-tab, dies with the tab)
- Service-worker cache → the static app shell only (never API/auth/PII)

"Clear cookies/site data" in Chrome wipes all three — which is why it "fixes"
the problem: it throws away a stale token AND a stale cached copy of the app.

## What was ALREADY fixed (the 2026-07-26 auth update, commit 723e503)

Verified present in `app-v2/src/lib/api.js` + `src/auth/index.js`:

1. **A single 401 can no longer sign anyone out.** `handle401` re-reads the
   CURRENT token, probes `/auth/me` once (single-flight — six parallel 401s
   collapse into one probe), and only clears the token if the current token
   itself is confirmed dead. A delayed 401 from an OLD token therefore cannot
   clear a NEWER token (the second agent's proposed fix #2 — already built).
2. **A `bad_token` startup burst resolves cleanly.** A stale stored token fires
   the page's parallel API calls, they all 401, the single-flight probe confirms
   once, the token is cleared ONCE, and the sign-in screen shows the server's
   own reason. No bounce loop (proposed fix #3 — already built).
3. Sessions are long + sliding (30-day idle, 12h refresh); logout is per-device
   (`sid` + `revoked_sessions`); vendor 401s are re-written to 502 after auth.
4. `completeMfa` refuses a deactivated staff account at the door.

Render side (verified separately, no changes made): `JWT_SECRET` and
`SSN_ENCRYPTION_KEY` present and stable, `/api/health` reports
`jwtStable:true` + `ssnKeyStable:true`.

## The REMAINING bug (confirmed, fixed in this change)

`app-v2/public/sw.js` — the service-worker file's comment said "v4: purges
caches poisoned by the bad-merge window…", but the cache name was still:

```js
const CACHE = 'pilot-v2-shell-v1';
```

Two consequences:

1. **The v4 purge never ran.** Activation cleanup deletes caches whose name
   differs from `CACHE` — since the name never changed, the old/poisoned v1
   cache was exactly what got KEPT. Users carried stale shell entries until
   they manually cleared site data.
2. **No `controllerchange` handler.** When a new service worker took control,
   already-open tabs (and installed-app windows) kept running the OLD
   JavaScript — including, for anyone who hadn't reloaded since 2026-07-26,
   the old logout-prone session logic. The deployed server was fixed; their
   browser wasn't running the fix.

This is why the problem hit only SOME people (long-lived tabs / installed
app), and why clearing site data resolved it.

### The fix (this change)

- `CACHE` bumped to `pilot-v2-shell-v4` → activation now genuinely deletes the
  old v1 cache on every client.
- `app-v2/src/main.jsx`: a `controllerchange` listener reloads each open tab
  exactly ONCE when a new service worker takes control, guarded against (a)
  the first-install case (`clients.claim()` fires controllerchange on a page
  that is already fresh) and (b) reload loops.
- Rule going forward: any change to sw.js caching behavior must bump `CACHE`.

The existing stale-build watchdog (`useStaleBuild` banner in both layout
shells) stays — it covers the "server has a newer bundle" case; the
controllerchange reload covers the "service worker updated" case.

## What affected users still need to do ONCE

Their devices may hold a stale token and the old service worker until the next
visit picks up this deploy. Per affected device: close all portal tabs/app
windows, clear site data for the portal domain, reopen, sign in once. After
that, deploys self-heal (cache purge + one automatic reload).

Do NOT rotate `JWT_SECRET` or `SSN_ENCRYPTION_KEY` — both are stable; rotating
them signs everyone out and risks encrypted SSN access.

## Open lead (not yet confirmed — needs the user's answer)

A leftover borrower-view token: a staffer who closes the tab while inside
"view as client" leaves the time-boxed borrower-view token in `localStorage`;
the next portal open runs on it until it expires (≤4h), then bounces to
sign-in. This matches the symptom for people who use that feature. Deferred
pending two answers from the field: the exact wording on their sign-in screen,
and whether affected users use the view-as-client feature. If confirmed, the
candidate fix is a boot-time check that exits a leftover impersonation token
back to the staff console (careful multi-tab semantics — see
`app-v2/src/lib/auth.jsx`).

## Longer term (unchanged recommendation, owner decision)

Move the auth token from `localStorage` to a `Secure`/`HttpOnly`/`SameSite`
cookie or BFF session (OWASP guidance). Larger change; not part of this fix.
