# PILOT login subdomain — `pilot.yscapgroup.com`

Goal: typing **`pilot.yscapgroup.com`** (or **`www.pilot.yscapgroup.com`**) in a
browser lands the visitor straight on the **PILOT client login** — no marketing
homepage in between.

There are two halves: a one-time **DNS + Render** setup you do once (below), and
the **app behavior** that's already shipped (no action needed).

---

## What the app already does (shipped)

When a request arrives on `pilot.yscapgroup.com` or `www.pilot.yscapgroup.com`,
the server **302-redirects the bare root (`/`) to `/portal/`**, which boots the
portal and shows the client login for anyone not signed in. Everything else
(portal deep links, the API, static assets) passes through untouched, so the SPA
and API work normally under the subdomain.

- Configured in `src/server.js` (the redirect middleware) driven by
  `cfg.pilotLoginHosts` in `src/config.js`.
- The host list defaults to `pilot.yscapgroup.com,www.pilot.yscapgroup.com`. If
  the subdomain ever changes, override it with the **`PILOT_LOGIN_HOSTS`** env
  var (comma-separated) in Render — no code change needed.
- On the main domain (`www.yscapgroup.com`) this is a no-op: the homepage still
  serves normally.

So once DNS points the subdomain at the app, it "just works."

---

## Step 1 — Add the domains in Render

Render must know it should answer for these hostnames (and issue TLS certs).

1. Render Dashboard → the **web service** (the one that serves the site/portal)
   → **Settings** → **Custom Domains**.
2. Click **Add Custom Domain** and add **both**, one at a time:
   - `pilot.yscapgroup.com`
   - `www.pilot.yscapgroup.com`
3. For each, Render shows the **DNS target to point at** — for a subdomain this
   is a **CNAME** value that looks like `something.onrender.com` (copy the exact
   value Render shows; don't guess it). Render also shows a verification status
   that flips to **Verified** once DNS resolves.

> Keep this tab open — you'll paste the target into your DNS provider in Step 2.

---

## Step 2 — Create the CNAME records at your DNS provider

Do this where **`yscapgroup.com`** DNS is managed (e.g. GoDaddy, Cloudflare,
Namecheap, Google Domains, Route 53 — wherever the existing
`www.yscapgroup.com` record lives).

Add **two CNAME records**, each pointing at the Render target from Step 1:

| Type  | Host / Name            | Value (points to)                     | TTL      |
|-------|------------------------|---------------------------------------|----------|
| CNAME | `pilot`                | `<the-target-Render-showed>` (e.g. `yscap.onrender.com`) | 1 hour / Auto |
| CNAME | `www.pilot`            | `<the-same-Render-target>`            | 1 hour / Auto |

Notes:
- The **Host/Name** is just the label to the left of `yscapgroup.com`. Most
  providers want `pilot` and `www.pilot` (they append the base domain for you).
  A few want the fully-qualified `pilot.yscapgroup.com.` — follow your provider's
  convention.
- **Value** is exactly what Render displayed as the target — usually
  `<service>.onrender.com`. Use Render's value verbatim.
- **Cloudflare only:** set the proxy status to **DNS only (grey cloud)** for
  these two records so Render can issue the TLS certificate. You can re-enable
  the proxy afterward if desired.
- Do **not** create an `A` record for these — a subdomain uses CNAME.

---

## Step 3 — Wait, then verify

1. DNS can take anywhere from a few minutes to a couple of hours to propagate.
   Render's Custom Domains page shows **Verified** + **Certificate Issued** when
   it's ready.
2. Then visit **https://pilot.yscapgroup.com** — you should be redirected to the
   PILOT client login (`/portal/`). Same for **https://www.pilot.yscapgroup.com**.
3. Confirm the certificate is valid (the browser shows a padlock, no warning).

That's it — the subdomain now opens straight to the PILOT login.

---

## Troubleshooting

- **You see the marketing homepage instead of the login.** DNS is pointing the
  subdomain at the app, but the host isn't in the redirect list. Confirm the
  hostname is exactly `pilot.yscapgroup.com` / `www.pilot.yscapgroup.com`, or set
  `PILOT_LOGIN_HOSTS` in Render to include it, then redeploy.
- **Browser security warning / no HTTPS.** Render hasn't issued the cert yet —
  wait for **Certificate Issued** on the Custom Domains page. On Cloudflare,
  make sure the record is **DNS only (grey cloud)** during issuance.
- **"Domain not verified" in Render.** The CNAME value doesn't match Render's
  target, or DNS hasn't propagated. Re-check the record value against Render and
  give it time; use a DNS checker (e.g. `dig pilot.yscapgroup.com CNAME`) to
  confirm it resolves to the Render target.
