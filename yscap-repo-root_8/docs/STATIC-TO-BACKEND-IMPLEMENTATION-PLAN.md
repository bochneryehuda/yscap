# Moving the Static Rules to the Back End — Implementation Plan

**Status:** PLAN ONLY. Nothing built, nothing moved, nothing changed.
**Owner instruction (2026-07-30):** *"Our current static should be in back and you should not touch the
static — it should stay how it is because it's very sensitive. It should just be in the back, not
visible on the front page, and not shipped to everybody's browser — all the static rules. There should
be a React in the front which talks to our static from the back end. Our static should be the back end
and it should not be shipped to the browser, but it should still work the same way it's working now."*

---

## 1. What this does, in one picture

**Today** — we hand every visitor the rule book, and their browser looks up the answer:

```
   Visitor's browser
   ├── downloads standard-program.js   (the whole leverage matrix)
   ├── downloads gold-standard.js
   ├── downloads silver-program.js     (the capital partner's workbook)
   ├── downloads title-cost.js
   └── works out the answer locally
```

**After** — the rule book stays in our building; only the answer travels:

```
   Visitor's browser                       Our server
   ├── types the deal ───────────────────► the SAME rule files, untouched
   │                                       (standard / gold / silver / title-cost)
   └── ◄─────────────────────────── just the finished numbers
```

The page still looks the same, still works the same, still needs no login. The difference is that the
rule files stop being downloadable.

---

## 2. The rule that governs the whole job

> **The four rule files are MOVED, never edited. Byte-for-byte identical, verified by checksum before
> and after.**

They change **location only**. No number, no formula, no line of them is touched. This is checked
mechanically (see §7), not by eye.

---

## 3. What we found that makes this safe

All verified in the code, not assumed:

**a) All four rule files are already identical in all six places they're stored.**

| File | Copies | All identical? |
|---|---|---|
| `standard-program.js` | 6 | ✅ yes (`18cf2e34`) |
| `gold-standard.js` | 6 | ✅ yes (`da11d625`) |
| `silver-program.js` | 6 | ✅ yes (`94c335bc`) |
| `title-cost.js` | 6 | ✅ yes (`d165a204`) |

So collapsing them to **one** copy on the server loses nothing — the other five are exact duplicates.

**b) The server already runs these exact files.** `src/lib/pricing.js` already does
`require('../../web/tools/standard-program.js')` and already produces a full, authoritative quote
(`quoteAll`). Its own comment: *"the browser copy of the engines is used only for instant what-if
display."* **We are not building a new brain — we are unplugging the spare one.**

**c) The browser only really uses four rule functions.** Counted across every page:

| Function | What it is | Used by |
|---|---|---|
| `evaluate` | the real pricing decision | studio ×1, loan application ×1 |
| `priceLadder` | the rate/leverage ladder | studio ×7 |
| `projectCount` | experience tier count | studio ×2 |
| `estimate` (title) | title cost | studio ×3, loan application ×1 |
| *`normStrategy`* | *trivial text tidy-up — no secret* | studio ×19, loan app ×2 |
| *`setMarkup`* | *a setter — no secret* | both |

The secret surface is **four functions**. That is the whole job.

**d) The portal's copies do nothing at all.** `web/portal/engines/*` and `web/v2/portal/engines/*` are
loaded by the portal shell, and the only thing the React app does with them is print a debug line to
the developer console (`App.jsx`: `console.info('[YS] frozen engines:', engineReport())`). **They
compute nothing.** They can be deleted outright with zero change in behaviour — and anyone can download
them today without logging in.

---

## 4. Staged plan — the urgent part does not wait for the big part

### Stage 0 — Delete the portal's dead copies *(hours, no behaviour change)*

Deletes **8 files** that exist only to feed a console message.

- `web/portal/engines/{standard-program,gold-standard,silver-program,title-cost}.js`
- `web/v2/portal/engines/{…same 4…}.js`
- and their sources `app/public/engines/*`, `app-v2/public/engines/*`
- remove the 4 `<script>` tags from `app/index.html` + `app-v2/index.html` (and the built
  `web/portal/index.html`, `web/v2/portal/index.html`)
- `app-v2/src/lib/engines.js` `engineReport()` keeps working — with the scripts gone it simply reports
  `false`. **No crash**: it only reads `window.YSP` behind `!!`.

**Effect:** `/portal/engines/silver-program.js` — the capital partner's workbook — stops existing.
**Risk: none.** Nothing computes with these.

### Stage 1 — Build the back-end answer service *(≈1 week)*

1. **Move the four rule files** (a `git mv`, no edits):
   `web/tools/{4 files}.js` → `src/engines/{4 files}.js`
2. **Point the server at the new home** — one line each in `src/lib/pricing.js`:
   `require('../../web/tools/standard-program.js')` → `require('../engines/standard-program.js')`
3. **Delete the remaining duplicate copies** under `web/v2/tools/` (identical, verified).
4. **Add one public endpoint** — `POST /api/quote` — built exactly like the existing public
   `GET /api/pricing-defaults` (`src/server.js:224`): cached where safe, and **it must never break the
   marketing site if it fails**.
   - It takes the typed deal (price, as-is, ARV, rehab, term, program, state, FICO, experience…).
   - It builds an in-memory deal object and calls the existing `pricing.quoteAll(...)`.
   - **It creates no file and saves nothing.** It is a calculator, not a record.
   - It returns **finished numbers only** — never the matrix, bands, caps, or tier rows.
5. **Protect it** (the site stays public, so these matter): rate limit per visitor, bot scoring, a
   short-lived token issued by the page itself (**not a login — invisible to the visitor**), and an
   alert on abnormal volume.

### Stage 2 — Loan application page *(≈2–3 days)*

`loan-application.html` uses only `evaluate` + `estimate` (plus the two trivial helpers). It calls
`/api/quote` instead. Small, self-contained, easy to verify.

### Stage 3 — Term Sheet Studio: **the swap, NOT a rebuild** *(≈1–2 weeks)*

**Owner question (2026-07-30): "Is there any way to do this without rebuilding it — the front end should
be nothing and just get the data back from my server?"**

**Yes. There is, and it is much smaller than a React rewrite.** The studio page keeps working exactly as
it does today. We change **one thing**: where the answer comes from.

#### Why it works — what the code already looks like

The studio has a single funnel. Everything on screen, in the PDF and in the Excel export reads **one
object**, produced by three functions:

- `calc()` → Standard · `calcGold()` → Gold · `calcSilver()` → Silver

That object is a flat list of ~40 finished values (`totalLoan`, `initialAdvance`, `rehabHoldback`,
`rate`, `origFee`, `cashToClose`, `ltcPct`, `ltvPct`, `arvPct`, `status`, `reasons`…). Every renderer,
the PDF builder and `xlsxSections()` consume **that shape and nothing else**.

**So the rule files are only reachable through those three functions.** Nothing else in the file touches
them.

#### The change

```
TODAY                                    AFTER
calc()  ─ runs the rule files locally    calc()  ─ returns the answer the server already sent
        └─ returns the ~40-value object          └─ returns the SAME ~40-value object
```

Concretely:

1. **One new async step**, wired to the existing input-change handler: send the typed deal to
   `/api/quote`, keep the reply in a variable.
2. **`calc()` / `calcGold()` / `calcSilver()` bodies become "read that variable."** They stay
   **synchronous** and keep returning the same object.
3. **Everything else is untouched** — `recompute()`, all 34 screen references, all 13 PDF references,
   the Excel export, the program cards, the sliders, the admin zone. Not edited, not moved.

Because `calc()` keeps its signature and its return shape, **all of its call sites keep working
unchanged** — `issueDeal()`, `calcChosen()`, `recompute()` and `xlsxSections()` never learn anything
changed.

#### Why this is hard to mess up

- **The screen and PDF code is not rewritten**, so it cannot render differently — it is byte-identical
  and still receives the identical object.
- **The rule files are not edited** — they run on the server, unchanged.
- **The shape is the contract.** The server returns exactly the ~40 fields `calc()` returns today, and
  the equivalence test (§7) compares them field by field.
- **The file already speaks async** — `async`/`await` appears 17 times in it already (e.g.
  `ensureXLSX()`), so this is the file's existing idiom, not a new pattern.
- **It is reversible in one step**: put the `<script>` tags back and restore three function bodies.

#### The five real gotchas (each small, each has a standard fix)

| # | Gotcha | Fix |
|---|---|---|
| 1 | First load has no answer yet | Show "calculating…" until the first reply lands |
| 2 | Fast typing → several requests in flight | Number the requests; use only the newest |
| 3 | Someone hits **Download PDF** mid-fetch and gets the previous numbers | Hold the export button while a fetch is pending |
| 4 | Server unreachable | Say so plainly — **never show a stale or half number** |
| 5 | A round trip per keystroke | Debounce ~250ms (the page already debounces input) |

#### What this replaces

This supersedes the earlier "rebuild the studio in React" idea. **No React rewrite. No new front end.**
The front end stays the page you already have and trust; it simply stops doing the arithmetic and asks
the server instead — which is exactly what you described.

*(If a React front is ever wanted later for other reasons, this same `/api/quote` serves it too — but
nothing here depends on that.)*

---

## 5. Exact file structure — before and after

```
BEFORE                                          AFTER
─────────────────────────────────────────────   ──────────────────────────────────────────
web/tools/standard-program.js      [PUBLIC]     src/engines/standard-program.js   [server]
web/tools/gold-standard.js         [PUBLIC]     src/engines/gold-standard.js      [server]
web/tools/silver-program.js        [PUBLIC] ⚠   src/engines/silver-program.js     [server]
web/tools/title-cost.js            [PUBLIC]     src/engines/title-cost.js         [server]

web/v2/tools/{same 4}              [PUBLIC]     (deleted — identical duplicates)
web/portal/engines/{same 4}        [PUBLIC]     (deleted — Stage 0, unused)
web/v2/portal/engines/{same 4}     [PUBLIC]     (deleted — Stage 0, unused)
app/public/engines/{same 4}                     (deleted — build source)
app-v2/public/engines/{same 4}                  (deleted — build source)

src/lib/pricing.js                              src/lib/pricing.js
  require('../../web/tools/…')                    require('../engines/…')      ← 4 lines

(no public quote endpoint)                      POST /api/quote                ← new

web/tools/term-sheet.html                       same page, no engine <script>s
web/v2/tools/term-sheet.html                    same page, no engine <script>s
web/tools/loan-application.html                 same page, no engine <script>s
web/v2/tools/loan-application.html              same page, no engine <script>s
app/index.html, app-v2/index.html               engine <script>s removed
```

**Net result:** 24 public copies of the rule files → **4 private ones on the server**.

---

## 6. What we are NOT touching

- ❌ The **contents** of the four rule files — moved only, checksum-verified.
- ❌ Any **number, formula, cap, band, matrix cell or rate**.
- ❌ The **marketing pages' words** — the program pages keep their wording exactly as-is (that copy needs
  to stay readable for Google and for customers; it is not what we are hiding).
- ❌ The **logged-in portal's behaviour** — Stage 0 removes files nothing uses.
- ❌ **Borrower data, documents, logins** — untouched throughout.
- ❌ The **public-facing nature of the site** — no login is introduced anywhere.
- ❌ The **existing front end** — no React rewrite. The studio, the loan application and the marketing
  pages stay the pages they are today; only where the numbers come from changes (see Stage 3).
- ❌ The **screen, PDF and Excel code** — every renderer keeps receiving the identical object it
  receives today.

---

## 7. How we prove it did not break anything

Nothing ships until all of these pass.

**1. The rule files are provably unchanged.**
Record `md5sum` of all four before the move; re-record after. **Must match exactly.** A single differing
byte stops the release.

**2. Same inputs → same numbers (the big one).**
Run a broad battery of deal scenarios through the **old** browser path and the **new** server path, and
compare **every** number: loan amount, initial advance, rehab holdback, rate, origination, LTC, LTV,
ARV, interest reserve, cash to close, cost basis. **Any difference at all is a blocker.** This is the
same bar this codebase already used for the 2026-07-21 re-freeze, which compared 28,800 evaluations.

**3. Nothing still points at the old location.**
Automated check that no file references `web/tools/*-program.js`, `/engines/`, or the removed script
tags. A missed reference must fail the build, not surface as a broken page.

**4. Every page still loads.**
Term sheet studio, loan application, portal (staff + borrower), and the studio embedded inside the
portal — each opened and exercised, not just built. *(A green build does not mean the page renders — a
rule this codebase learned the hard way.)*

**5. The files are actually gone from the web.**
Fetch `/tools/silver-program.js`, `/portal/engines/silver-program.js`, `/v1/tools/silver-program.js`
and the v2 paths as an anonymous visitor. **All must 404.**

**6. Rollback is one step.**
Each stage is its own change. If anything looks wrong, revert that stage — the rule files return to
their old location unchanged, because they were never edited.

---

## 8. Effort and order

| Stage | What | Effort | Risk | Removes the partner's workbook? |
|---|---|---|---|---|
| **0** | Delete the portal's dead engine copies | hours | **none** | Partly — the `/portal/engines/` copies |
| **1** | Move rules to the server + `/api/quote` | ~1 week | low–medium | **Yes — completely** |
| **2** | Loan application page | 2–3 days | low | — |
| **3** | Studio: swap `calc()` to read the server's answer | 1–2 weeks | low–medium | — |

*Estimates are planning figures, not commitments.*

**Nothing is rebuilt.** Every stage is a move, a delete, or a swap of where an answer comes from. Stage 0
can start immediately and is genuinely risk-free.

---

## 9. The whole job in one sentence

Four rule files move from the browser to the server unchanged; the pages stop downloading them and ask
the server for the finished numbers instead; nothing that draws a screen, builds a PDF, or writes an
Excel file is touched.

_Nothing in this document has been implemented._
