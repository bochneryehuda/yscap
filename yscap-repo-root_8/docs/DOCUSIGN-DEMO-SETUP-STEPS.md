# DocuSign DEMO setup — beginner step-by-step (turn it on)

_Owner-facing checklist to connect the portal to a DocuSign **demo (sandbox)** account so we can build
and test. Demo envelopes are watermarked and not legally binding — perfect for testing, never for a real
borrower. Production is a separate, later step (Go-Live)._

> **Golden rule on secrets:** the only secret here is the **RSA private key**. Never paste it into chat,
> a document, or the code — paste it **only** into the app's environment settings (Render). If a key is
> ever shared in a chat, regenerate it (it's considered exposed). The Integration Key / User ID / Account
> ID are identifiers, not secrets, but we still keep them in environment settings, not in the code.

Placeholders below (`{LIKE_THIS}`) are values you copy from your DocuSign account.

---

## Part A — In your DocuSign demo account (the clicks)

**1. Sign in to the DEMO account.** Go to **https://apps-d.docusign.com** and log in. (The `-d` /
"apps-d" host is the developer sandbox — the demo world. The real world is `apps.docusign.com`.)

**2. Open Apps and Keys.** Top-right **gear / Settings → Apps and Keys** (under *Integrations*), or go
straight to **https://apps-d.docusign.com/admin/apps-and-keys**.

**3. Confirm your app.** You should see your app (e.g. **"PILOT"**). If not: **Add App and Integration
Key**, name it `PILOT`, Save. Open the app.

**4. Copy three identifiers** (write them down — not secrets):
   - **Integration Key** (a.k.a. *Client ID*) — shown on the app: `{INTEGRATION_KEY}`.
   - **User ID** — on the Apps and Keys page under *My Account Information* → **User ID**:
     `{USER_ID}`. (This is the person the automation signs in "as".)
   - **API Account ID** — same *My Account Information* box → **API Account ID**: `{ACCOUNT_ID}`.

**5. Generate a fresh RSA keypair (this is the signing key).**
   - In the app, find the **Authentication** section → **RSA Keypairs**.
   - If a keypair already exists **and it was ever shared in chat**, delete it (it's exposed).
   - Click **+ Generate RSA** (a.k.a. *Add RSA Keypair*).
   - DocuSign shows the **PRIVATE KEY once**. Copy the **entire block**, including the
     `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines. Keep it somewhere
     safe for the next few minutes — you'll paste it into the environment settings in Part B, **not into
     chat**. (The *public* key stays with DocuSign; you don't need to copy it.)

**6. Add a Redirect URI (needed for the one-time "Allow" step).**
   - In the app: **Additional settings → Redirect URIs → Add URI**.
   - Paste exactly: `https://developers.docusign.com/platform/auth/consent`
   - Save. (This is just where DocuSign sends the browser after you click "Allow".)

**7. Grant the one-time consent ("Allow Access").** DocuSign requires a human to click this once — no
   automation can do it. In a browser where you're logged into the demo account, open this address
   (the Integration Key is already yours, filled in):

   ```
   https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id={INTEGRATION_KEY}&redirect_uri=https://developers.docusign.com/platform/auth/consent
   ```

   Sign in if asked, then click **Allow Access**. You'll land on a DocuSign developer page — that's the
   sign it worked. (You can ignore anything in the address bar after you've clicked Allow.)

---

## Part B — In your app's environment (where the values live)

The portal reads these from environment settings (on **Render**), never from the code. Add them in the
Render dashboard → your service → **Environment** → *Add Environment Variable*:

| Name | Value |
|---|---|
| `DOCUSIGN_INTEGRATION_KEY` | `{INTEGRATION_KEY}` |
| `DOCUSIGN_USER_ID` | `{USER_ID}` |
| `DOCUSIGN_ACCOUNT_ID` | `{ACCOUNT_ID}` |
| `DOCUSIGN_PRIVATE_KEY` | *(paste the whole NEW private key block from step 5)* |

That's all for demo — `DOCUSIGN_BASE_URI` and `DOCUSIGN_OAUTH_BASE` default to the demo values
automatically (`https://demo.docusign.net/restapi` and `account-d.docusign.com`), so you don't set them.
Click **Save** — Render redeploys the service.

> Pasting the multi-line private key in Render: use the value box as-is (it accepts line breaks). Keep
> the `BEGIN`/`END` lines. Don't add quotes.

---

## Part C — Confirm it's on

Once Parts A + B are done, tell the developer. A quick **"test connection"** check will (1) mint a
demo access token with the key (proves the key + consent work), and (2) send a **test document to your
own email** so you see the end-to-end signing flow on demo. If the token step fails with
`consent_required`, re-do step 7; if it fails with `invalid_grant`, the private key in Render doesn't
match the one in DocuSign (re-copy it).

---

## Part D — LATER (not needed to turn it on today)

- **Connect webhook + HMAC** — this is how the portal hears "it's signed." We set it up **after** the
  receiving endpoint is built: in the demo account **Settings → Connect → Add Configuration → Custom**,
  URL `https://www.yscapgroup.com/api/webhooks/docusign`, message format **JSON**, events at least
  `Envelope Completed`; enable **Include HMAC Signature**, generate a key, and put it in the environment
  as `DOCUSIGN_CONNECT_HMAC_KEY`.
- **Go-Live to production** — a separate promotion once demo testing passes; the RSA key + consent +
  Connect config are all re-created on the production account (only the Integration Key value carries
  over).

---

### Quick reference — what each value is
- **Integration Key / Client ID** — names the app to DocuSign (public).
- **User ID** — the person the automation acts as (public identifier).
- **API Account ID** — which DocuSign account (public identifier).
- **RSA private key** — the **secret** that proves it's really our app; lives only in the environment.
- **Consent** — the one-time human "Allow" that lets our app act as the user.
- **Connect + HMAC** — the signed "it's done" callback (set up later).
