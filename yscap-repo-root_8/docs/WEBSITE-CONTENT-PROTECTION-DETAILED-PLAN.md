# Website Content Protection — Detailed Plan & Research

**Companion to** `docs/WEBSITE-CONTENT-PROTECTION-PLAN.md` (the high-level version).
**Status:** RESEARCH + PLANNING ONLY. Nothing in here has been built. No site, engine, or config changed.
**Scope:** protecting our HTML/CSS, our marketing/guideline content, and our pricing model from copying.

---

## 0. Executive summary (plain language)

You asked whether we can hide our HTML so developers can't take our website and our program
guidelines. **We cannot hide HTML or CSS — nobody can, and that is not where the real risk is.** But
the research turned up something more important, and it is genuinely worth acting on.

**The single most urgent finding:** the file `silver-program.js` — which contains a **capital partner's
confidential pricing and eligibility workbook**, transcribed cell by cell — is loaded by our **public**
term-sheet page (`/tools/term-sheet.html`), which is **linked straight from our homepage** and needs
**no login**. Anyone can download it and read that partner's entire private rate grid, tier caps,
excluded states and ZIP codes. The file's own comment even says *"This file ships to the browser."* We
correctly hide the partner's **name**, but not their **numbers**.

That is not "someone copies our marketing copy." That is a third party's confidential data sitting in
the open, under our name. It is a **relationship and trust risk**, and it should be fixed first.

**The good news — this is far more fixable than it first looked.** Three things we verified in the code:

1. **The server is already the authority.** `src/lib/pricing.js` says it plainly: *"Registering a product
   recomputes here on the server so a tampered client can never inject fabricated terms; the browser
   copy of the engines is used only for instant what-if display."* So the browser's copy is a
   convenience, not a necessity.
2. **The server already has the endpoints.** Logged-in quote endpoints already exist and already run the
   same frozen math (`POST /api/staff/applications/:id/pricing/quote`, and the borrower equivalent).
3. **Only six pages load the engines at all** — two public tools and the portal shell, in v1 and v2. It is
   a small, well-defined surface, not a rewrite.

**We also confirmed several things are already correct** and need no work: no source maps ship, no
folder listing, borrower data is properly protected, and the security headers are sane.

---

## 1. What we verified in the code (evidence)

Everything below was checked directly in this repo, not assumed.

| # | Finding | Evidence | Verdict |
|---|---|---|---|
| 1 | Partner's confidential workbook is on a **public** page | `web/v2/tools/term-sheet.html` loads `silver-program.js?v=silver2`; that page is linked from `web/v2/index.html` as `href="tools/term-sheet.html"`; no auth in front | 🔴 **Urgent** |
| 2 | Pricing engines are downloadable | `/tools/standard-program.js`, `gold-standard.js`, `silver-program.js`, `termsheet.js`, `title-cost.js` — served flat | 🔴 High |
| 3 | Internal staff mockups are public | `express.static(webDir)` at `src/server.js:434-436` publishes `web/preview/pilot-staff-*.html` etc. with no gate | 🟠 Medium |
| 4 | Server is already authoritative | `src/lib/pricing.js` header comment | ✅ Enabler |
| 5 | Auth-gated quote endpoints already exist | `src/routes/staff.js:1876`, `src/routes/borrower.js:859` | ✅ Enabler |
| 6 | A public API pattern already exists | `GET /api/pricing-defaults`, `src/server.js:224-229` (cached, never 500s) | ✅ Enabler |
| 7 | Engine surface is small | Only 6 host pages load engines (verified per-file) | ✅ Enabler |
| 8 | No source maps ship | `find web/portal web/v2/portal -name "*.map"` → 0 results | ✅ Already clean |
| 9 | No directory listing | No `serve-index` dependency; `express.static` does not list by default | ✅ Already clean |
| 10 | Borrower data is protected | `requireAuth`/`requireStaff`/`requirePermission` across `/api/*` | ✅ Already clean |
| 11 | No CSP header | `src/lib/security.js` — deliberate; inline scripts on the static site | 🟡 Improvement |
| 12 | No rate limiting on static files | Limits only on `/auth` + `/api/*` (`src/server.js:63-69`) | 🟠 Medium |
| 13 | No `robots.txt` | Absent from `web/` and `web/v2/` | 🟡 Improvement |

**Important nuance on #1/#2:** the engines are **UMD modules** — the same file is `require()`d by the
Node server *and* `<script src>`'d by the browser. `src/lib/pricing.js` loads them via
`require('../../web/tools/standard-program.js')`. So they cannot simply be deleted; they must be
**relocated** with the server's require path updated. There are also **six copies of each engine**
(`web/tools`, `web/v2/tools`, `web/portal/engines`, `web/v2/portal/engines`, `app/public/engines`,
`app-v2/public/engines`) — any move must handle all of them.

**The frozen-engine rule applies.** Per this repo's hard rule, no guideline number or formula may change
without your explicit written sign-off. Everything proposed here is **relocation and access control
only** — where the code runs, not what it computes — and must be proven identical by runtime
equivalence testing before it ships.

---

## 2. DECIDED: the site stays fully public — no login (owner-directed 2026-07-30)

**Owner decision: "I want us to stay public facing."** No login gate, no email wall on the tools. This
section records how we protect the model *within* that constraint. **This is achievable** — the urgent
item (the partner's workbook) is fully fixable with the site 100% public.

### 2.1 The owner's question: "can we put the static behind a React so only the shell is in front?"

**The instinct is right; React is the wrong mechanism.** Splitting into "a thin thing in front, the real
thing behind" is exactly the correct architecture. But the "behind" must be **the server**, not React.

React does **not** hide anything:
- A React app ships a **JavaScript bundle** to the browser. Whatever is in that bundle — text, numbers,
  rules — is downloadable and readable, exactly like the HTML is today. Often it is *easier* to harvest,
  because it arrives as one predictable file.
- Our own portal already proves it: it is React, and its engines (`/portal/engines/*.js`) are just as
  downloadable as the static ones.
- Anything React fetches at runtime comes from an API that is **also public**, so the fetch adds no
  protection by itself.

So "static behind React" would cost real money and protect nothing.

**What actually works is the same shape, with the server as the back:**

```
  TODAY                                  PROPOSED
  Browser downloads the whole recipe     Browser sends inputs → server runs the frozen
  and cooks locally.                     recipe → returns only the finished numbers.
  (the grid is readable)                 (the grid never leaves our building)
```

The page stays public. Anyone can open it, use it, get an instant term sheet, no login. What changes is
that **the recipe stops being handed out** — only answers are. This is the standard industry answer:
move business logic server-side and expose only the necessary data through an API; client-side
obfuscation is a deterrent, never a control.

### 2.2 The two different problems (they need opposite treatment)

Lumping these together is what makes the question feel unanswerable. They are not the same:

| | **Guideline TEXT on marketing pages** | **The pricing MODEL (engines)** |
|---|---|---|
| Examples | "up to 90% of purchase, 100% of rehab, 75% ARV" in prose on the program pages | `silver-program.js` grid, `standard-program.js` MATRIX, rate build-up, FICO bands |
| Can it be hidden? | **No — and it must not be** | **Yes — completely** |
| Why | It is *sales copy*. It exists to be read and to be **found on Google**. The site has real SEO investment (title, meta description, Open Graph) and the figures are indexable today. Hiding it behind React makes it invisible to search engines and still doesn't hide it from a determined person. | It never needs to be in the browser at all. The server already computes it. |
| Correct treatment | Copyright + Terms + monitoring + bot blocking (Phases 2/4/5) | **Move server-side (Phase 3)** |

**In short:** the guideline *wording* competitors could read anyway — they can also just call us and
ask, or read our brochure. The guideline *machine* (exact caps by state, FICO band, tier, the partner's
whole grid) is the actual trade secret, and that one we can fully protect while staying public.

### 2.3 The residual risk, stated honestly

With the tool public and the math server-side, the endpoint becomes an **oracle**: someone can submit
many different inputs and infer the matrix from the answers. This cannot be reduced to zero without a
login, which we are not doing. It *can* be made slow, expensive and obvious:

1. **Rate limiting** per IP/session, tuned so a real user never notices and a scripted prober trips it.
2. **Bot management** (Cloudflare bot score) — scripted probing is classified as automated and
   challenged.
3. **A page-issued short-lived token** — the tool page hands the browser a signed, expiring token used
   for quote calls. **This is not a login and is invisible to the visitor**; it simply means you must
   actually load the page to ask, which defeats trivial scripted enumeration.
4. **Return only the answer** — never the caps, bands, tier or matrix row that produced it, and no
   "why" breakdown beyond what a borrower needs.
5. **Alerting** on abnormal quote volume from one source.

**Net effect:** instead of downloading our complete model in one click, an attacker must run thousands
of detectable, rate-limited, bot-scored requests to approximate part of it. That is a genuine and large
improvement, and it keeps the site fully public.

### 2.4 The partner's workbook — a special case, and the easiest win

`silver-program.js` deserves separate treatment from our own engines: it is **not our data**. The
cleanest fix does not even require Phase 3 to be finished:

- **Do not load it on the public page at all.** Anonymous visitors get Standard/Gold quotes; a Silver
  quote comes from the server. The Silver *card* can still display publicly — it just gets its numbers
  from us instead of computing them in the visitor's browser.
- The same page is embedded in the logged-in portal
  (`app-v2/src/components/TermSheetStudio.jsx` → `STUDIO_URL = '/tools/term-sheet.html'`), so a
  context-aware load is a natural seam that already exists.

This can ship in days, ahead of the larger migration, and removes the third-party exposure immediately.

---

## 3. Content tiers (the industry-standard framing)

Classify first, then protect each tier the right way. How much you can hide *decreases* as content gets
more public — trying to apply tier-1 thinking to tier-4 content is the classic wasted effort.

| Tier | Examples here | Can it be hidden? | Correct control |
|---|---|---|---|
| **1 — Private data** | Borrower files, SSNs, documents | Yes — never send to an unauthenticated browser | Server-enforced auth + encryption ✅ *already done* |
| **2 — Secret logic** | Pricing/guideline model, partner workbook | Yes — keep on the server, return only answers | Server-side compute behind auth/limits ⬅ *Phase 3* |
| **3 — Internal pages** | Staff screens, `web/preview/*` mockups | Partly — gate them, don't publish mockups | Auth gate + remove from build ⬅ *Phase 1* |
| **4 — Public marketing** | Program pages, guideline prose, homepage | **No** — it exists to be seen | Copyright, Terms, deterrence, monitoring ⬅ *Phases 2, 4, 5* |

---

## 4. The detailed plan

### Phase 0 — Decisions

- **D1. ✅ DECIDED (2026-07-30): the site and tools stay FULLY PUBLIC — no login, no email wall.**
  Protection comes from moving the model server-side plus the §2.3 controls. Not revisited.
- **D2.** The **Silver** program: keep the card visible publicly but serve its numbers from the server
  (recommended), or drop the card from the public tool entirely? *Either way the partner's workbook
  stops being downloadable — this is only about what the public page displays.*
- **D3.** Are any `web/preview/*` pages real, or all throwaway mockups? *(Recommend treating all as
  internal.)*
- **D4.** Budget approval for Cloudflare (~$20–250/mo depending on tier) and copyright registration
  (~$45–65 per registration).
- **D5.** Do we want AI crawlers (GPTBot, ClaudeBot, CCBot, Bytespider…) blocked from our content?
  *Note: this trades against being cited by AI search, which for a lender may be worth having.*

---

### Phase 1 — Immediate, low-risk cleanups (est. 1–2 days, LOW risk)

**1.1 — Remove the note-buyer workbook from the public page** ⬅ *do this first*
- Stop `web/v2/tools/term-sheet.html` from loading `silver-program.js` for anonymous visitors.
- Depending on D1/D2, either drop the Silver card from the public tool entirely, or load the Silver
  engine only in the authenticated portal context.
- **Verify:** an anonymous `curl` of the page and of `/tools/silver-program.js` returns nothing useful.
- *Risk:* low — but must be checked against the portal's embedded studio so the logged-in Term Sheet
  Studio keeps working (the same HTML serves both).

**1.2 — Take internal mockups off the public site**
- Exclude `web/preview/**` from what is deployed (or move behind auth).
- Confirm both `/preview/...` and `/v1/preview/...` 404 afterwards (the fallthrough mount at
  `src/server.js:436` means both paths currently resolve).

**1.3 — Add `robots.txt`**
- Disallow `/preview/`, `/tools/`, `/portal/`; allow the marketing pages.
- Optionally block AI crawlers per D5.
- ⚠️ `robots.txt` is **advisory only** — it stops honest crawlers, not thieves. It is *not* a control;
  it is housekeeping. Do not treat it as protection.

**1.4 — Confirm the already-clean items stay clean**
- Add a build check asserting **no `.map` files** ship (currently 0 — keep it that way).
- Keep directory listing off (do not add `serve-index`).

---

### Phase 2 — Edge protection / WAF (est. 1–3 days, LOW risk, highest leverage vs. bulk copying)

Put **Cloudflare** (or equivalent) in front of `www.yscapgroup.com`. This is the single most effective
step against "someone copies the entire site."

**2.1 — Onboard the domain**, proxy enabled, origin locked to the CDN.

**2.2 — Bot management.** Cloudflare classifies traffic with a **bot score** and lets you act on it via
custom rules. Site-copiers (HTTrack, wget, curl-based scrapers) score as automated and can be
challenged or blocked. Bot Analytics shows which requests are automated so you can spot spikes.

**2.3 — Rate limiting**, tuned per surface:
- Static HTML/CSS: generous limit — enough that a normal reader never notices, but a whole-site
  download trips it.
- `/tools/*.js` (while the engines are still there): tight.
- Any future **public quote endpoint**: tightest, plus bot score — this is the oracle from §2, and rate
  limiting is its primary defense.

**2.4 — AI crawler controls** (per D5). Cloudflare can block the major AI crawlers, and its "AI
Labyrinth" traps crawlers that ignore `robots.txt`.

**2.5 — Managed challenges** on suspicious traffic rather than hard blocks, so real users are never
locked out.

---

### Phase 3 — Move the secret logic server-side (est. 2–4 weeks, MEDIUM risk — the real project)

This is the substantive protection. **The frozen-engine rule governs the whole phase: no number and no
formula may change.**

**3.1 — Relocate the engines out of the public tree.**
Move the canonical copies to a server-only directory (e.g. `src/lib/engines/`), update
`src/lib/pricing.js`'s `require()` path, and remove the public `/tools/*.js` and `/portal/engines/*.js`
copies. Handle **all six copies** so none is left behind serving the old file.

**3.2 — Add a PUBLIC quote endpoint** (D1 is decided: the tools stay public).
Model it on `GET /api/pricing-defaults` (`src/server.js:224`) — cached, and it must never 500 the
marketing site. Apply the §2.3 controls: rate limit, bot score, page-issued short-lived token,
answer-only response, volume alerting. Authenticated surfaces keep using the existing quote endpoints.

**3.3 — Repoint the tools.**
`term-sheet.html` and `loan-application.html` call the endpoint instead of computing locally. Add a
small debounce so typing doesn't fire a request per keystroke, and keep a graceful message if the
endpoint is briefly unreachable — the public tool must never appear broken.

**3.4 — Return answers, never the model.**
The response carries the resulting numbers only — never the matrix, bands, caps, or rate build-up. Keep
the existing borrower-safe scrubbing (note-buyer names must still never appear).

**3.5 — Prove nothing changed (mandatory).**
Run the full scenario battery through old-vs-new and assert **every** numeric field is identical (loan
amount, initial, rehab, rate, caps, LTC/LTV/ARV, reserve, cost basis). This repo has done exactly this
before — the 2026-07-21 re-freeze verified 28,800 evaluations. Same bar here. Any difference is a
release blocker.

**3.6 — Optional hardening (a speed bump, not a wall).**
Obfuscate whatever client-side logic must remain. Industry consensus is explicit that obfuscation is a
*deterrent and a hardening technique, not a security control* — it complements server-side enforcement
and never replaces it. Do not obfuscate the public marketing pages (SEO + performance cost, no benefit).

---

### Phase 4 — Legal layer (est. 1 week + registration lead time, LOW risk, high value)

**4.1 — Copyright notices** on every page footer.

**4.2 — Register the key pages with the U.S. Copyright Office.** This matters more than people expect:

- Registration is a **prerequisite to filing an infringement suit** at all.
- To claim **statutory damages and attorney's fees**, the work must be registered **before the
  infringement began**, or within **three months of first publication**. Miss that window and you are
  limited to proving actual damages — which is usually small relative to litigation cost, i.e.
  practically unenforceable.
- Statutory damages run **$750–$30,000 per work**, up to **$150,000 for willful** infringement.

**Registering early is what converts "they copied us" from an annoyance into an enforceable claim.**
Register the homepage, the program pages, and the guideline content.

**4.3 — Terms of Use page** prohibiting scraping, bulk copying, and automated access — this gives a
contractual basis alongside copyright.

**4.4 — DMCA process.** Designate an agent and keep a ready-to-send template. A valid notice obliges
U.S. platforms/hosts to remove infringing content, often within days, **without a lawsuit** — and works
even if the work is unregistered (registration is what unlocks damages, not takedowns). A notice needs:
the infringing URL, our source URL, and a statement of ownership. Expect the possibility of a counter
notice.

---

### Phase 5 — Monitoring & detection (est. 2–3 days setup, LOW risk, ongoing cost)

You cannot enforce what you never notice.

**5.1 — Content-copy monitoring.** Copyscape's **Copysentry** monitors the web for copies of your pages
and emails alerts when a new one appears.

**5.2 — Clone / spoof detection.** For a lender this matters beyond IP: cloned lender sites are used for
phishing borrowers. Specialist services (Clone Detector, BrandShield, Attic, Red Points) watch for
typosquats, homoglyph domains, TLD swaps and lookalike sites. Proactive clone monitoring is now treated
as a **financial-services best practice**, not a luxury.

**5.3 — Watermarking / fingerprinting.** Seed distinctive, harmless markers in the content (unusual
phrasings, a specific example figure) so a copy is provable and traceable.

**5.4 — Cloudflare Bot Analytics review** — a monthly look for scraping spikes.

---

### Phase 6 — Security headers / CSP (est. 1–2 weeks mostly waiting, LOW risk)

Not anti-theft, but it belongs in the same hardening pass. `src/lib/security.js` already sets
`X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy` and
HSTS. The gap is **CSP**, deliberately skipped because the static site uses inline scripts.

The standard migration path:
1. Deploy **`Content-Security-Policy-Report-Only`** first — nothing breaks, but violations are reported.
2. Collect reports for **1–2 weeks**; catalogue inline scripts and third-party origins.
3. Move inline scripts to **hashes** (right for statically-served pages) or **nonces** (right for
   server-rendered pages). Our marketing pages are static → prefer hashes; note that a hash breaks if so
   much as whitespace in the script changes.
4. Only then switch to enforcing mode.

Keep `X-Frame-Options: SAMEORIGIN` — the portal embeds our own tools in iframes and `DENY` would break
them.

---

## 5. Sequenced roadmap

*(All of this keeps the site fully public — D1 decided.)*

| # | Item | Phase | Effort | Risk | Why this order |
|---|---|---|---|---|---|
| 1 | Remove partner workbook from public page | 1.1 / 2.4 | ~0.5 day | Low | **Third party's confidential data, publicly downloadable now** |
| 2 | Remove `web/preview/*` mockups | 1.2 | ~0.5 day | Low | Free win; removes internal-design leak |
| 3 | `robots.txt` + keep-clean build checks | 1.3–1.4 | ~0.5 day | Low | Cheap housekeeping |
| 4 | Cloudflare onboarding + bot + rate limits | 2 | 1–3 days | Low | Biggest single lever vs. whole-site copying |
| 5 | Copyright registration + Terms + DMCA | 4 | 1 wk + lead time | Low | **Time-sensitive** — the 3-month window governs damages |
| 6 | Clone + content monitoring | 5 | 2–3 days | Low | Makes theft visible; phishing protection too |
| 7 | Engines server-side + equivalence proof | 3 | 2–4 wks | **Medium** | The real fix; needs care under the frozen rule |
| 8 | CSP report-only → enforce | 6 | 1–2 wks | Low | Independent hardening; can run in parallel |

*Effort figures are rough planning estimates, not commitments.*

---

## 6. What NOT to do

Common requests that feel protective, are trivially bypassed, and cost real money or ranking:

- ❌ **Disable right-click / block view-source / block DevTools.** Bypassed in seconds (disable
  JavaScript, or just use `curl`). Annoys real users, hurts SEO and accessibility.
- ❌ **"Encrypt the HTML" / DRM-for-webpages products.** The browser must decrypt it to render it, so the
  key is necessarily present. Snake oil.
- ❌ **Obfuscating the whole public site.** Slows the site, harms Google ranking, and is still readable
  to anyone motivated. Obfuscation is a *hardening technique, not a standalone defense* — fine as a
  speed bump on Phase-3 leftovers, never as the plan.
- ❌ **Relying on `robots.txt` as protection.** It is a request, not a control. Scrapers ignore it.
- ❌ **Serving marketing content only after login.** Kills SEO and lead generation for content whose
  purpose is to be found. *(Also ruled out by the owner — see D1.)*
- ❌ **Converting the static marketing pages to React to "hide" them.** See §2.1. React ships its content
  to the browser in a JS bundle, so nothing becomes hidden — our own React portal's engines are just as
  downloadable as the static ones. It would also cost real money and **damage Google ranking** on pages
  that exist to be found. The valuable half of that instinct — thin page in front, real work behind — is
  delivered by Phase 3, where the **server** is the "behind."

---

## 7. Reality check

Open DevTools on any bank, Stripe, or a large competitor: their HTML and CSS are fully visible. They are
not insecure. Their protection has the same shape as this plan — private data on the server, secret
logic on the server, public marketing protected by brand, execution, copyright and monitoring.

Your moat is your capital relationships, your execution, and your brand — not the wording on a program
page. **The marketing copy being visible is normal. The pricing model being visible is the thing worth
fixing — and a partner's confidential workbook being visible is the thing worth fixing first.**

---

## 8. Sources

Industry research consulted for this plan:

- [Cloudflare — Rate limiting best practices](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/)
- [Cloudflare Bot Management beyond defaults: Bot Score, custom rules, JA4 (Brixio)](https://brixio.io/blog/cloudflare-bot-management-production-guide/)
- [How To Block Bad Bots With Cloudflare in 2026 (ROIhacks)](https://roihacks.com/how-to-block-bad-bots-with-cloudflare/)
- [Cloudflare WAF vs. The AI Flood: A 2026 Guide (Digital Void)](https://digitalvoid.blog/cybersecurity/cloudflare-waf-ai-bot-protection/)
- [DMCA Notice & Takedown Process (Copyright Alliance)](https://copyrightalliance.org/education/copyright-law-explained/the-digital-millennium-copyright-act-dmca/dmca-notice-takedown-process/)
- [DMCA Takedown Notices: How to Remove Infringing Online Content (Clark Hill)](https://www.clarkhill.com/news-events/news/using-dmca-takedown-notices-to-enforce-copyright-online/)
- [Register Your Copyrights Early or Say Goodbye to Statutory Damages and Attorney's Fees (Jaburg Wilk)](https://www.jaburgwilk.com/news-publications/one-of-the-important-benefits-that-come-from-registering-copyrighted-works-early-is-the-ability-to-seek-statutory-damages-and-attorneys-fees-from-a-copyright-infringer-in-a-lawsuit-it-is-only)
- [Supreme Court Confirms Registration is Prerequisite to Claim for Infringement (Katten)](https://katten.com/Supreme-Court-Confirms-Registration-is-Prerequisite-to-Claim-for-Infringement)
- [Statutory Damages in Copyright Infringement (Stimmel Law)](https://www.stimmel-law.com/en/articles/statutory-damages-copyright-infringement)
- [Copyscape Plagiarism Checker / Copysentry](https://www.copyscape.com/)
- [Website Spoofing in 2026: How to Detect and Take Down Fake Sites (BrandShield)](https://www.brandshield.com/blog/website-spoofing-detection-take-down/)
- [Financial Services Brand Protection — Clone Detection for Banks & Fintechs (Clone Detector)](https://clonedetector.com/financial-services/)
- [Website cloning: How to detect it, prevent it, and respond (Red Points)](https://www.redpoints.com/blog/website-cloning/)
- [Mitigate XSS with a strict Content Security Policy (web.dev)](https://web.dev/articles/strict-csp)
- [Content Security Policy Cheat Sheet (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [Why JavaScript Obfuscation Matters (PreEmptive)](https://www.preemptive.com/blog/why-javascript-obfuscation-matters-how-to-protect-client-side-code-from-attacks/)
- [The Most Effective Way to Protect Client-Side JavaScript Applications (Jscrambler)](https://jscrambler.com/blog/the-most-effective-way-to-protect-client-side-javascript-apps)

_Nothing in this document has been implemented. Awaiting the Phase 0 decisions._
