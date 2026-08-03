# Website Content Protection — Plan & Risk Assessment

**Status:** Planning only. No code or website changes are made by this document.
**Question it answers:** "Can we hide our HTML/CSS so people can't steal our website and our program guidelines — especially the static pages?"

> 📄 **The detailed, step-by-step version with full research is in
> [`WEBSITE-CONTENT-PROTECTION-DETAILED-PLAN.md`](./WEBSITE-CONTENT-PROTECTION-DETAILED-PLAN.md)** —
> code-level evidence, a sequenced roadmap with effort/risk, the decisions needed from the owner, and
> industry sources. This file is the summary; that one is the plan of record.

---

## 1. The plain-language answer (read this first)

**The honest truth: you cannot make HTML or CSS un-viewable or un-downloadable.**
Anything the browser shows a visitor, the browser first has to *receive* — and once it is on their
computer, it can be saved. This is true for our plain (static) pages **and** for our React pages.
React is not "hidden": it just ships a big bundle of code that *builds* the page, and that bundle and
the finished page can both be downloaded and read. Any tool or company that promises to "hide your
HTML" or "make it un-downloadable" is not telling the truth — it is bypassed in seconds and it hurts
Google ranking and real visitors.

So the goal is **not** "hide the HTML." The goal is: **decide what is truly meant to be public, keep the
truly secret things off the visitor's computer entirely, and make wholesale copying hard, provable, and
worth nobody's time.** That is exactly how every serious company (banks, Stripe, big lenders) does it —
their HTML/CSS is fully visible too.

### Is this a major concern?
Broken into the three things people actually mean:

| What you're worried about | Real risk today | Verdict |
|---|---|---|
| **Borrower private data** (SSNs, loan files) | Already behind login, enforced on the server. | ✅ **Safe.** Not a concern. |
| **Secret pricing / guideline math** (leverage, rates, FICO rules) | Currently **sent to the visitor's browser as readable code** — and one file exposes a **capital partner's confidential workbook**. | 🔴 **Yes — the most urgent item.** |
| **Marketing program pages** (the guideline text on the program pages) | Public by nature — that's what a website is. | 🟡 **Normal.** Protect with law + monitoring, not walls. |

**Bottom line:** Your private data is safe. Your *marketing wording* is copyable by nature (so is every
competitor's — that's normal). But we found **two real gaps** worth closing when you say go, and a
standard "make theft hard and provable" layer we don't have yet.

---

## 2. The two real gaps we found (grounded in the code)

### Gap A — the "calculator brains" are handed to every visitor
The pricing/guideline engines run **in the visitor's browser** as plain JavaScript files, downloadable
by anyone at `/tools/…`:

- `web/tools/standard-program.js`, `web/tools/gold-standard.js`, `web/tools/silver-program.js`
- `web/tools/termsheet.js`, `web/tools/title-cost.js`, `web/tools/rehab-budget.js`
- (mirrored again under `web/v2/tools/…`)

These contain the actual **secret recipe** — the leverage matrix, the rate build-up, FICO minimums,
LTV/LTC/ARV caps, the loan-sizing waterfall. Right now a competitor can open one file and read the
whole model. **This is the single biggest real IP exposure** — far more than the marketing copy.

> Note: this is the same frozen engine the server also uses (`src/lib/pricing.js`). The math itself is
> fine and must not change (that is a hard rule). The problem is only **where the browser gets its
> answers from** — today it runs the whole model locally instead of asking the server.

**Most sensitive of all — a capital partner's confidential workbook is public.** `silver-program.js`
transcribes a note buyer's private "RTL Seller Pricing & Eligibility Tool" workbook — every tier cap,
rate cell, band edge, DSCR floor, excluded state/ZIP — and ships it to **every anonymous visitor**. The
file's own comment even says *"This file ships to the browser: keep every comment name-free."* We
already hide the partner's *name*, but the whole confidential *grid* is downloadable. This is not just
our IP — it is a **third party's confidential data we are responsible for**, so a leak here risks the
capital-partner relationship, not only a competitor copying us. **Treat this as the single most urgent
item.**

**Confirmed exposure path (verified):** the live public term-sheet page `web/v2/tools/term-sheet.html`
loads `silver-program.js`, and that page is linked directly from the homepage
(`href="tools/term-sheet.html"`) with no login. The same page is also embedded in the logged-in portal
(`TermSheetStudio.jsx` → `STUDIO_URL = '/tools/term-sheet.html'`), which is why it loads every engine —
and that public/private overlap is also the natural seam for fixing it.

### Gap B — internal/staff mockup pages sit in the public folder
The site is served with `express.static(web/)` (`src/server.js:434-436`), which publishes **everything**
under `web/` with **no login in front** — including the internal design mockups in `web/preview/`:

- `web/preview/pilot-staff-*.html` (staff pipeline, audit, ClickUp, leads, team, vendors…)
- `web/preview/pilot-borrower-*.html`, `web/preview/pilot-conditions.html`, etc.

Anyone who guesses the address (e.g. `/preview/pilot-staff-pipeline.html`, `/v1/preview/…`) can open
them. These leak our internal workflow and screen designs. They should not be shipped to the public
site at all, and any genuinely internal page must be behind a server-enforced login.

### What's already good (keep it)
- The API (`/api/*`) is properly gated with `requireAuth` / `requireStaff` / `requirePermission`.
- Borrower PII, documents and SSNs are login-protected and encrypted at rest.
- Note-buyer / capital-partner names are already scrubbed from borrower-facing pages.

---

## 3. The industry-standard way to think about it: four content tiers

The professional approach is not "hide everything" — it's **classify, then protect each tier the right
way.** How much you can actually hide goes *down* as the content gets more public.

| Tier | Examples here | Can you hide the code? | Right protection |
|---|---|---|---|
| **1. Private data** | Borrower files, SSNs, real applications | Yes — never send it to a browser that isn't logged in | Server-enforced login + encryption. **(Already done.)** |
| **2. Secret logic** | Pricing / guideline math (Gap A) | Yes — keep it on the server; send only the *answer* | Move calculations server-side, behind login |
| **3. Internal pages** | Staff/portal screens & mockups (Gap B) | Partly — gate them; don't publish mockups | Login-gate; remove mockups from the public site |
| **4. Public marketing** | Program pages, guideline text, homepage | **No** — meant to be seen | Copyright + Terms of Use + deterrence + monitoring |

The mistake to avoid: trying to use Tier-1 thinking ("hide it") on Tier-4 content ("the marketing
page"). You can't, and chasing it wastes money on snake-oil tools.

---

## 4. The plan (phased — nothing here is done yet)

### Phase 0 — Decide (a business call, quick)
Agree what is genuinely public vs. secret vs. internal:
- Are the interactive tools (Term Sheet Studio, Rehab Budget) meant to be **public lead-gen tools**, or
  **login-only**? This decides how far we can protect the pricing math (see Phase 2).
- Confirm which `preview/*` pages are throwaway mockups vs. anything real.

### Phase 1 — Deterrence + legal layer (cheap, high value, low risk)
This is the standard "make wholesale theft hard and provable" layer. None of it changes the site's look.
1. **Put Cloudflare (or similar) in front of the site.** Gives us: bot/scraper blocking, rate limiting,
   and blocking of one-click whole-site downloaders (HTTrack, wget). This is the single most effective
   step against "someone copies the entire site."
2. **Add clear copyright notices + a Terms of Use page** (your text and design are automatically
   copyrighted; saying so plainly, and registering the key pages, lets you send takedowns/DMCA).
3. **Remove the internal mockups from the public site** (Gap B) — take `web/preview/*` out of what gets
   published, or move it behind login.
4. **Turn off folder listing** and confirm **no source maps** ship in production (source maps would hand
   over readable original code; the current build looks fine here — just verify).
5. **Watermark / fingerprint** key pages and **monitor the web for clones** (services exist that alert
   you when your content appears elsewhere) so theft is *detectable and provable*.

### Phase 2 — Protect the real secret (Gap A — the important one)
Keep the pricing/guideline model on the server; the browser only ever receives the **final numbers**,
never the recipe.
- The interactive tools call a server endpoint that runs the (unchanged, frozen) math and returns just
  the result.
- **The math and every number stay exactly the same** — this only changes *where* it runs. It must be
  done with the required equivalence testing so no guideline value moves (hard rule).
- Trade-off for you to decide in Phase 0: if the tools must stay 100% public with no login, some model
  detail is unavoidably exposed; gating the tools behind a simple login closes that fully. This is a
  product decision, not a technical one.

### Phase 3 — Harden internal pages (Gap B, the durable fix)
- Any genuinely internal page is served **only after a server-checked login**, not just "hard to guess."
- Mockups/design files never ship to production.

---

## 5. What NOT to spend time or money on

These are common requests that feel protective but are **counter-productive** and easily bypassed —
avoid them:
- ❌ **"Disable right-click / disable view-source."** Bypassed in seconds, annoys real users, hurts SEO.
- ❌ **"Encrypt the HTML" / DRM-for-web-pages products.** The browser has to decrypt it to show it, so the
  key is right there. Snake oil.
- ❌ **Heavy obfuscation of the whole public site.** Slows the site, breaks Google ranking, and it's still
  readable to anyone who cares.

Obfuscation/minification is fine as a *speed bump* on the Phase-2 secret logic, but it is never a wall.

---

## 6. Reality check — what "good" looks like

Open the developer tools on any bank, Stripe, or a big competitor's site: their HTML and CSS are fully
visible. They are not "insecure." Their protection is the same shape as this plan:
- **Private data** → behind login, on the server. *(We already do this.)*
- **Secret logic** → runs on the server; the browser gets answers, not the model. *(Phase 2.)*
- **Public marketing** → protected by brand, execution, copyright and monitoring — not by hiding.

Your real moat is your relationships, your capital partners, your execution and your brand — not the
wording on a program page. The marketing copy being visible is normal; the pricing model being visible
is the thing worth fixing.

---

## 7. Suggested order of work (when you say go)

1. **Phase 2, note-buyer file first** — get the capital partner's confidential workbook
   (`silver-program.js`) out of the public browser download. This is the most urgent single item because
   it is *someone else's* confidential data and a relationship risk, not just our own IP.
2. **Phase 1.3** — pull the internal mockups off the public site *(quick, removes an unnecessary leak)*.
3. **Phase 1.1** — Cloudflare in front *(biggest bang against whole-site copying)*.
4. **Phase 1.2 / 1.5** — copyright + Terms of Use + clone monitoring.
5. **Phase 2, remainder** — move the rest of the pricing/guideline math server-side *(the larger project;
   careful, equivalence-tested, no number changes)*.
6. **Phase 3** — formal login gate on anything internal.

_Nothing above is implemented. This is the plan for review._
