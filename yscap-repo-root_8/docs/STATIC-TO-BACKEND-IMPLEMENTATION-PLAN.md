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
| `standard-program.js` | 2 | ✅ yes (`18cf2e34`) |
| `gold-standard.js` | 2 | ✅ yes (`da11d625`) |
| `silver-program.js` | 2 | ✅ yes (`b2c59d5d`) |
| `title-cost.js` | 2 | ✅ yes (`d165a204`) |

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

### Stage 3 — Term Sheet Studio: **the swap, NOT a rebuild** *(≈2–3 weeks — revised 2026-07-31)*

**Owner question (2026-07-30): "Is there any way to do this without rebuilding it — the front end should
be nothing and just get the data back from my server?"**

**Yes. There is, and it is much smaller than a React rewrite.** The studio page keeps working exactly as
it does today. We change **one thing**: where the answer comes from.

#### Why it works — what the code already looks like

The studio has a single funnel for the **detail view**. Everything on screen, in the PDF and in the Excel
export reads **one object**, produced by three functions:

- `calc()` → Standard · `calcGold()` → Gold · `calcSilver()` → Silver

That object is a flat list of ~40 finished values (`totalLoan`, `initialAdvance`, `rehabHoldback`,
`rate`, `origFee`, `cashToClose`, `ltcPct`, `ltvPct`, `arvPct`, `status`, `reasons`…). Every renderer,
the PDF builder and `xlsxSections()` consume **that shape and nothing else**.

> **CORRECTION (audit, 2026-07-31).** An earlier draft of this section said *"the rule files are only
> reachable through those three functions — nothing else in the file touches them."* **That is wrong, and
> planning on it would have broken the page.** The three `calc*()` functions are the biggest door, not the
> only one. The real map, read out of `web/v2/tools/termsheet.js`, is below. Stage 3 must cover **all** of
> it.

#### Every door into the rule files (the real list)

| # | Door | What it calls | Where |
|---|---|---|---|
| 1 | `calc()` | `YSP.evaluate` + `YSTitle.estimate` | the Standard detail |
| 2 | `calcGold()` | `GSP.evaluate` + `YSTitle.estimate` | the Gold detail |
| 3 | `calcSilver()` | `SVP.evaluate` + `YSTitle.estimate` | the Silver detail |
| 4 | **`renderPrograms()`** | its **own** `GSP.evaluate` **and** `SVP.evaluate` | the two offer **cards** — these do **not** go through `calcGold()`/`calcSilver()` |
| 5 | **`goldLadder()`** | **up to ten** `GSP.evaluate` calls in a loop | the Gold leverage slider |
| 6 | `YSP.priceLadder` / `SVP.priceLadder` | the ladder, from **three** separate sites | `renderLeverage()`, the PDF ladder, and the slider's own `input` handler |
| 7 | `YSP.caps(...)` | reads the leverage **matrix** directly | the caps row — not routed through `evaluate` |
| 8 | `setMarkup()` × 3 | **writes** module-level state in all three engines | top of every `recompute()` |
| 9 | `YSP.normStrategy` / `YSP.projectCount` | pure shape helpers | **~21 call sites** scattered through the file |

Doors 4–9 are the ones the earlier draft missed. Three consequences:

- **Door 4** means a single keystroke prices Gold and Silver **twice** each (once for the card, once for
  the detail) — so a naive "one request per program" server call still leaves the cards computing locally.
- **Door 8** is the dangerous one. `setMarkup` mutates state **inside** the rule file and is written on
  every recompute. On the server that same module is **cached and shared across every request**, so a
  markup set for one user's request would leak into the next user's. The server already solves this
  (`src/lib/pricing.js` `quoteProgram` sets → uses → resets in a `finally`, fully synchronously). Stage 1's
  `/api/quote` **must** use that same set-use-reset discipline. This is not optional.
- **Door 9** is not pricing — it is shape (`"Fix & Flip"` → `"FF"`, and the project count). But it lives
  in the rule file, so if the file leaves the browser those 21 sites break. They need either a tiny local
  copy of those two helpers, or the answer shipped down in the `/api/quote` reply.

#### The change

```
TODAY                                    AFTER
calc()  ─ runs the rule files locally    calc()  ─ returns the answer the server already sent
        └─ returns the ~40-value object          └─ returns the SAME ~40-value object
```

Concretely:

1. **One new async step**, wired to the existing input-change handler (**behind a new debounce** — see
   gotcha 5b): send the typed deal to `/api/quote`, keep the reply in a variable. **One request returns
   everything** — all three programs, both ladders, the caps row and the title estimate — so a keystroke
   is one round trip, not nine.
2. **`calc()` / `calcGold()` / `calcSilver()` bodies become "read that variable."** They stay
   **synchronous** and keep returning the same object.
3. **The other doors read that same variable too** — `renderPrograms()` (the two offer cards),
   `goldLadder()`, the three `priceLadder` sites and the `caps()` row stop calling the engines and read
   the corresponding part of the one reply. These are small edits (delete a call, read a field), but they
   **are** edits: the earlier draft wrongly listed the cards and sliders as untouched.
4. **Everything that draws is untouched** — all 34 screen references, all 13 PDF references, the Excel
   export, the admin zone. Not edited, not moved.

Stage 3 targets the **V2** studio (`web/v2/tools/termsheet.js`), which is canonical. V1
(`web/tools/termsheet.js`, frozen at `/v1`) has the same shape and follows after, or stays as it is.

Because `calc()` keeps its signature and its return shape, **all of its call sites keep working
unchanged** — `issueDeal()`, `calcChosen()`, `recompute()` and `xlsxSections()` never learn anything
changed.

#### Why this is hard to mess up

- **The screen and PDF code is not rewritten**, so it cannot render differently — it is byte-identical
  and still receives the identical object.
- **The rule files are not edited** — they run on the server, unchanged.
- **The shape is the contract.** The server returns exactly the ~40 fields `calc()` returns today, and
  the equivalence test (§7) compares them field by field.
- **The file already speaks async** — `async`/`await` appears 19 times in it already (e.g.
  `ensureXLSX()`), so this is the file's existing idiom, not a new pattern. *(But see gotcha 6b: the async
  must sit **before** `calc()`, never inside it.)*
- **It is reversible in one step**: put the `<script>` tags back and restore the handful of function
  bodies listed in "The change" above.

#### The real gotchas

*(Revised after the 2026-07-31 audit. Items 6–8 are new, and item 5 corrects a false statement in the
earlier draft.)*

| # | Gotcha | Fix |
|---|---|---|
| 1 | First load has no answer yet | Show "calculating…" until the first reply lands |
| 2 | Fast typing → several requests in flight | Number the requests; use only the newest |
| 3 | Someone hits **Download PDF** mid-fetch and gets the previous numbers | **Block every export while a quote is in flight** — see item 3b |
| 4 | Server unreachable | Say so plainly — **never show a stale or half number** |
| 5 | A round trip per keystroke | Add a **~100–120ms** debounce. **The page has none today**, and 250ms is too long — see item 5b |
| 6 | `window.TS._calc()` must stay **synchronous** | It is a published contract — see item 6b |
| 7 | The Gold slider fires **up to ten** engine calls per drag tick | Ask the server for the **whole ladder in one reply**, not one request per rung |
| 8 | The two offer **cards** price Gold and Silver separately from the detail | One reply must carry **all three programs**, so one round trip serves cards *and* detail |

**3b. An export on stale numbers is the worst failure in this whole project.** A term sheet PDF is a
document a borrower is handed and a lender is held to. If the export runs while a newer quote is still in
flight, the file goes out with the **previous** deal's numbers and nothing on the page looks wrong. So
"hold the button" is too weak a word: `exportPdf`, `exportLetter` and `exportXlsx` must each **refuse to
run** while a request is pending, and the portal's own export path (`TermSheetStudio.jsx` calls
`win.TS.exportPdf(null)` directly) has to be covered by the same refusal — it does not go through the
page's button.

**5b. The page does not debounce anything — and 250ms is the wrong number.** The earlier draft said "the
page already debounces input." It does not. `wire()` attaches one handler to **every** input, select and
textarea in the form, and that handler calls `recompute()` **synchronously on every single keystroke**.
Measured in a real browser: **2.3ms per keystroke** in the comparison view, **4.9ms** with Gold drilled
in, across **24 engine calls**. Today that is free, because the rules are in the browser. After the swap
**every one of those becomes a network round trip unless the debounce is added first.** The debounce is
load-bearing and must be written before the swap, not after.

**But a 250ms debounce is a TRADE, not a fix — measured, 2026-07-31.** It adds its full delay to *every*
edit, so the steady-state feel gets **worse**, not better:

| Connection | Debounce | Requests for 6 keystrokes | Time for one edit to show |
|---|---|---|---|
| *(today, in-browser)* | — | 0 | **2 ms** |
| typical (80ms) | none | 7 | **87 ms** |
| typical (80ms) | 250 ms | 2 | **338 ms** |
| mobile/far (300ms) | none | 7 | **309 ms** |
| mobile/far (300ms) | 250 ms | 2 | **559 ms** |

**~100–120ms is the better balance** — it still collapses a typing burst into one or two requests, but it
does not dominate the felt delay. Full measurements and method in
`docs/STUDIO-SPEED-AND-PARITY-RESEARCH.md`.

Note the second reason to keep *some* debounce: a public endpoint answering on every keystroke is far
easier to probe automatically to reconstruct the rate matrix (the "oracle" risk in the protection plan).
Fewer requests make that materially harder.

**6b. `window.TS._calc` / `_calcGold` / `_calcSilver` are a published contract, and they must stay
synchronous.** Both portals reach into the studio's iframe and call them expecting an object back
**immediately**:

```js
// app-v2/src/components/TermSheetStudio.jsx  (and the V1 copy in app/src/)
try { std    = win.TS._calc(); }        catch (_) {}
try { gold   = win.TS._calcGold(); }    catch (_) {}
try { silver = win.TS._calcSilver && win.TS._calcSilver(); } catch (_) {}
```

Note the bare `catch (_) {}` on each line. If those functions are made `async`, they return a Promise —
which is **not** falsy and **does not throw** — so `readSnapshot` would silently capture a Promise instead
of a deal, the catch would never fire, and the staff register screen would read blank or stale numbers
**with no error anywhere**. That is a silent-wrong-number failure, the exact class this project exists to
prevent.

So the rule is: **the async step happens *before* `calc()`, never *inside* it.** The fetch fills a
variable; `calc()` stays synchronous and reads that variable. When no answer has landed yet, `calc()` must
**throw** (which the portal's existing `catch` already handles correctly as "not ready") — it must never
return a half-built or empty object.

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

**2. Same inputs → same numbers (the big one). — BUILT.**
Run a broad battery of deal scenarios through the **old** browser path and the **new** server path, and
compare **every** number: loan amount, initial advance, rehab holdback, rate, origination, LTC, LTV,
ARV, interest reserve, cash to close, cost basis. **Any difference at all is a blocker.** This is the
same bar this codebase already used for the 2026-07-21 re-freeze, which compared 28,800 evaluations.

This now exists as a permanent harness: **`scripts/test-engine-parity.js`**, wired in as the **first step
of `npm test`**, comparing **115,200 scenarios** against a stored baseline
(`scripts/fixtures/engine-parity-baseline.json`). It was proven to work by changing a markup by 0.01% —
it flagged 60,480 scenarios. Run it with `--dir <path>` to point it at a moved copy of the engines, which
is exactly the Stage 1 check.

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

**7. No export can run on stale numbers. *(added by the 2026-07-31 audit)***
Test it deliberately: start a quote, and while it is in flight fire **each** export — `exportPdf`,
`exportLetter`, `exportXlsx` — from the page's buttons **and** from the portal's own path
(`TermSheetStudio.jsx` → `win.TS.exportPdf(null)`). Every one must refuse, not produce a document. A PDF
built on the previous deal's numbers is a legal document with the wrong terms.

**8. `_calc` stays synchronous. *(added by the 2026-07-31 audit)***
Assert in a test that `win.TS._calc()` returns a plain object (not a Promise) and that with no answer
loaded it **throws** rather than returning an empty one. Both portals wrap these calls in a bare
`catch (_) {}`, so a Promise would be captured silently and the register screen would show blank or stale
numbers with no error raised anywhere.

**9. Every door is covered. *(added by the 2026-07-31 audit)***
With the engines removed from the browser, exercise the **offer cards**, the **Gold slider**, the
**Standard/Silver ladder**, the **caps row** and the **admin markup zone** — not just the detail view.
Each is a separate door into the rule files (§4, doors 4–9) and each fails independently.

---

## 8. Effort and order

| Stage | What | Effort | Risk | Removes the partner's workbook? |
|---|---|---|---|---|
| **0** | Delete the portal's dead engine copies | hours | **none** | Partly — the `/portal/engines/` copies |
| **1** | Move rules to the server + `/api/quote` | ~1 week | low–medium | **Yes — completely** |
| **2** | Loan application page | 2–3 days | low | — |
| **3** | Studio: swap every door to read the server's answer | **2–3 weeks** | **medium** | — |

*Estimates are planning figures, not commitments.*

**Stage 3 was revised up by the 2026-07-31 audit** (from 1–2 weeks / low–medium). Not because the approach
changed — it did not — but because the earlier draft counted three doors into the rule files when there
are nine, and assumed a debounce that does not exist. The extra work is the six doors it missed, writing
the debounce first, and the export-blocking. Still a swap, not a rebuild.

**Nothing is rebuilt.** Every stage is a move, a delete, or a swap of where an answer comes from. Stage 0
can start immediately and is genuinely risk-free.

---

## 9. The whole job in one sentence

Four rule files move from the browser to the server unchanged; the pages stop downloading them and ask
the server for the finished numbers instead; nothing that draws a screen, builds a PDF, or writes an
Excel file is touched.

---

## 10. Status (2026-07-31)

- **Stage 0 — built, NOT merged.** The 16 dead engine copies are deleted, the script tags are removed from
  all four page shells, the service-worker caches are bumped so returning visitors drop the cached copies,
  and the parity harness (§7.2) is wired into `npm test`. It sits on branch
  `claude/static-html-css-security-kcinm2` as **draft PR #901**, held per the owner's instruction —
  *"don't merge anything, we need to do a lot of research before."* Proven with 115,200 scenarios ×
  before/after (zero differences) and pixel-identical before/after screenshots.
- **Stages 1, 2 and 3 — not started.** Awaiting the owner's go-ahead.

**Owner action still owed:** the admin passphrase found in four public files has been redacted from the
comment that spelled it out, but redaction only stops further publication — **the passphrase is in the
git history and must be rotated.**
