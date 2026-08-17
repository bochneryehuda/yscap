<!--
  Lender Price LOGIN PAD — the durable, self-healing way to authenticate to the LT DSCR pricer, with
  every login path tried live (2026-08-17) and its result recorded. LT-only. Contains NO secret VALUES —
  only the env-var NAMES. The credentials themselves live in the environment (Render prod / a gitignored
  local .env), never in source.
-->

# Lender Price login pad (durable + fresh tokens every time)

**Verified live 2026-08-17 against the tenant** (`auth.digitallending.com` /
`api.digitallending.com`, company `68e4306f…`, user `68e9a60f…`). All three login
paths work; the client already manages them into a single self-healing token pad.

## The env it reads (NAMES only — never commit the values)

| var | purpose | default |
| --- | --- | --- |
| `LP_USERNAME` | account email | — (required) |
| `LP_PASSWORD` | account password | — (required) |
| `LP_CLIENT_SECRET` | OAuth client secret (HTTP Basic) | — (required) |
| `LP_CLIENT_ID` | OAuth client id (HTTP Basic) | `acme2` |
| `LP_ORIGIN` | Origin/Referer header | `https://yscapgroup.digitallending.com` |
| `LP_AUTH_BASE` / `LP_API_BASE` | vendor hosts | `auth.` / `api.digitallending.com` |
| `LP_DIAG_TOKEN` | gates the HTTP diag route (the "X-File" header) | unset = route hidden |

`configured()` is true only when `LP_USERNAME` + `LP_PASSWORD` + `LP_CLIENT_SECRET`
are all set. Locally, a **gitignored `.env`** at the project root is auto-loaded by
`src/config.js`; in production these are Render environment variables.

## The three login paths, each tried live

1. **Password grant** — `POST {AUTH_BASE}/oauth/token`, body
   `grant_type=password&username=…&password=…&client_id=…`, header
   `Authorization: Basic base64(client_id:client_secret)`.
   **Result: OK.** access token (~3599s / 1h) **+ a refresh token** + `companyId` +
   `userId`. This is `client.login()` / `client.loginSelfTest()`.
2. **Refresh grant** — `POST {AUTH_BASE}/oauth/token`, body
   `grant_type=refresh_token&refresh_token=…&client_id=…`, same Basic header.
   **Result: OK.** A forced renewal (`getSession({force:true})`) used the refresh
   grant and returned a **fresh** access token with no password re-send
   (`renewedBy=refresh`, `fellBack=null`). This is how "fresh tokens every time" is
   achieved without repeatedly sending the password.
3. **HTTP diag route (the "X-File")** — `/api/lt/_diag/lenderprice/{health,login-check,price,selftest}`,
   gated by the `x-lp-diag-token` header matching `LP_DIAG_TOKEN`. OFF (404) unless
   `LP_DIAG_TOKEN` is set. This is not a fourth grant — it is how you verify the two
   grants above **end-to-end from the deployed app** without a shell:
   ```
   curl -s https://<app-host>/api/lt/_diag/lenderprice/login-check -H "x-lp-diag-token: $LP_DIAG_TOKEN"
   curl -s -X POST https://<app-host>/api/lt/_diag/lenderprice/selftest -H "x-lp-diag-token: $LP_DIAG_TOKEN"
   ```

## The durable pad (already built — `client.getSession`)

You do not call `login`/`refresh` directly for pricing — every priced call goes
through `getSession()`, which is the pad:

- serves a **warm cached token** while it is still fresh (>2 min to expiry);
- when stale, `renewalPlan` picks **refresh** (if a refresh token exists, isn't
  in a backoff window, and the vendor-stated refresh lifetime hasn't passed) else a
  **password login**;
- a refresh **failure fails safe** to a password login; a refresh **rejection** also
  opens an **escalating backoff** so a vendor that stops honouring the grant isn't
  asked before every renewal;
- **single-flight**: concurrent callers share one renewal (no login storm), and a
  malformed `expires_in` falls back to the vendor's hour rather than logging in on
  every request;
- on an upstream **500**, `searchRawWithRecovery` re-logs-in fresh + refetches the
  live company config + retries once.

So: **the pad never goes stale mid-use and always ends up with a fresh token**, by
refresh when possible and by password login otherwise. Nothing extra is needed to
"get fresh tokens every time" — it is the default path.

## Re-prove it any time (one command)

`scripts/test-lt-lp-login-pad.js` is the hand-run LIVE proof. It exercises all four
paths and asserts the owner's requirement — a token that is genuinely **fresh** on
each — printing only a length + sha256 tail, never a token value:

```
node scripts/test-lt-lp-login-pad.js
```

It exits 0 on PASS, 0 with a plain "not configured" message when the credentials are
absent (so it is safe to run anywhere, including CI), and non-zero on a real failure.
Verified live 2026-08-17: password grant OK (companyId + userId resolved, refresh
issued), refresh grant returned a fresh access token + a rotated refresh token, and
`getSession({force:true})` returned a token that differed from the warm one — every
path fresh, to the token. The two OFFLINE guards remain the CI safety net
(`test-lt-lp-login-contract.js` pins the wire spec; `test-lt-lp-token-renewal.js`
pins the fail-safe renewal ladder).

## Rotation (do this after the test — owner-directed)

The credentials used for this validation were shared in chat, so they must be
treated as compromised and **rotated** once the ≥200-scenario agreement work is done
(owner: "we're going to rotate login afterwards"). Rotation is a value change in the
Render environment only — no code change: set the new `LP_PASSWORD` /
`LP_CLIENT_SECRET`, and the pad above picks them up on the next login with no
redeploy needed beyond the env update. Never paste a credential into source, a
commit, a PR, or a doc.
