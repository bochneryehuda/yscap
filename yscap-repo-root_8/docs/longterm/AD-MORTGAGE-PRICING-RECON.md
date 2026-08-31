# A&D Mortgage (AIM) — what is reachable, and the one thing still needed

**Long-Term.** Reconnaissance only, 2026-08-31. **Nothing is built.** No adapter, no
endpoint, no mapping — deliberately, and the reason is the whole point of this file.

> **Owner-directed 2026-08-31:** *"This particular integration is going to be for A&D
> Mortgage auto link. It and the price should populate from here and pre-fill a 0.25
> margin hold back on top of it… Add this as an additional layer only for this investor."*

The shape of the work is settled — it is the AHL layer again, for a different investor.
`a_and_d` is already in the investor registry (`encompass/investors.js`, 38 loans, aliases
`A&D Mortgage LLC`, `A&D`, `AD`), so it needs no new identity. What is **not** settled is
the protocol, and that is what this file is about.

---

## 1. What was established, by measurement

| Thing | Finding |
|---|---|
| **A public Quick Pricer exists** | `https://pricer.admortgage.com/` → **HTTP 200**, `<title>Quick Pricer</title>`, no credentials |
| **AIM, the portal** | `https://aim.admortgage.com/login` → 200, a **login page**. The pricing inside it is credentialed |
| Linked from | `admortgage.com/partner-tools/quick-pricer-pro/` and `/partner-tools/aim/` |
| **It is a React SPA**, not a server-rendered form | 3,696 bytes of shell, **0 `<select>`s, 0 `<form>`s**. Bundle `assets/index-CbaNmsXp.js`, 1.59 MB, build `3.38.0+334.bf363de` dated 2026/08/19 |
| Its API is **same-origin** | The shell's own CSP: `connect-src 'self'` plus analytics hosts only. No API host is allow-listed, so the app calls `pricer.admortgage.com` itself |
| Endpoints visible in the main bundle | `/v1/program-groups`, `/v1/banners`, `/v1/announcements`, `/v1/dictionaries/issue-types`, `/v1/shared/issues`, `/v1/shared/bitrix-leads`, `/version`, and a websocket `/ws/pricing-upd-notification` |
| **The pricing call is NOT in the main bundle** | It lives in a lazily-loaded chunk. Only two chunk names appear in the shell bundle and both are PDF renderers |
| Every path probed returns the **SPA shell** | `/version`, `/v1/program-groups` → 200 `text/html`, 3,696 bytes, with and without `Accept: application/json` |

## 2. Why this is where it stops

**The pricing endpoint has not been observed, and it will not be guessed.**

That is not caution for its own sake. A guessed pricing endpoint fails in a way that looks
exactly like *"A&D has no products for this scenario"* — an empty row on a board, with a
plausible reason beside it, and nobody looks twice. It is the same failure the LoanNEX
adapter refuses by name (`loannex_login_unrecorded`) rather than paper over, and the same
reason AHL's every enum is checked against AHL's own form before it goes on the wire.

**The SPA could not be recorded from here.** Driving it with the pre-installed Chromium
was the obvious answer and it does not work in this container: the browser cannot reach
**any** HTTPS host through the agent proxy — `example.com`, `client.ahlend.com` and
`pricer.admortgage.com` all return `ERR_CONNECTION_RESET`, while `curl` reaches all three
without trouble. So this is an environment limit, not anything about A&D.

## 3. What is needed — one recording

**A HAR of one pricing run on `https://pricer.admortgage.com/`** — exactly what was
provided for AHL. Open the Quick Pricer, fill in a DSCR investment scenario, press the
button that prices it, and save the network log.

That single capture answers everything still open:

1. the pricing endpoint and its method;
2. the request body — the field names and their enum values;
3. the response shape: programs, the rate/price ladder, the lock terms;
4. **the LLPA itemization** — whether it rides with the price (as AHL's does) or needs a
   second call per quote (as LoanNEX's does);
5. the ineligibility reasons;
6. whether any token or cookie is required at all — the shell answers 200 without one, but
   that proves nothing about the API behind it.

**Two smaller questions the same capture would settle:** whether the pricer exposes a
channel choice the way AHL does (`Wholesale` / `Correspondent` / `CorrNonDel` price
differently there, and the owner has since named CorrNonDel as ours), and whether one
request returns every product and lock or only the combination it was asked for — which is
the fan-out that dominated AHL's design.

## 4. What is already decided, so it need not be re-asked

Everything except the protocol carries over from the AHL layer:

- **A layer, not a third source.** A&D's own pricer quotes A&D, so there is no second quote
  to elect it against. It grafts onto the merged board for `a_and_d` alone, exactly as
  `pricing/ahl-layer.js` does for `american_heritage`, and `merge.js` stays untouched.
- **0.25 margin holdback**, pre-filled, taken once in `pricing/vendor-margin.js` — a
  settable pre-fill, not a constant, failing toward the owner's number and never toward
  zero.
- **The same layout.** Whatever A&D returns is mapped into the one `quote-shape` option and
  rendered by the one `pricing/breakdown.js`. If A&D states its adjustments in PRICE, it
  goes through `quote-shape.priceLine` like LoanNEX and AHL, so the sign convention holds.
- **The same shared scenario defaults** (`pricing/scenario-defaults.js`), so all four
  programs price the same loan.
- **Read-only.** A positive allowlist of endpoints, refusing every other URL before the
  wire, and no lock/register/book path.

Nothing above needs a decision. It needs the recording.

## 5. Reproduce this reconnaissance

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' https://pricer.admortgage.com/
curl -s https://pricer.admortgage.com/ | grep -o '<title>[^<]*</title>'
curl -s https://pricer.admortgage.com/assets/index-CbaNmsXp.js \
  | grep -oE '"/(v1|ws)[a-zA-Z0-9/_-]*"' | sort -u
```
