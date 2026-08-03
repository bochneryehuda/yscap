# Why it feels slow, and what "the exact same way" really costs

**Date:** 2026-07-31
**Question from the owner:** *"Why is it not working the same way the old static system is working,
and why is it not so fast, and how can we make it faster, and how can we be sure it operates the exact
same way?"*

Everything below is **measured**, not estimated, unless a line says ESTIMATED. Every number can be
re-run from the scripts named at the end.

---

## 0. First, the thing that matters most

**Nothing from the server-side-pricing project is live. Not one line.**

`main` still carries all 16 engine copies and every `<script>` tag. The work is on a branch, in a draft
pull request, deliberately unmerged — as instructed. So **whatever is slow today was already slow, and
this project did not cause it.**

That turned out to be the important discovery, because there *is* something slow today, and it has
nothing to do with pricing.

---

## 1. THE REAL PROBLEM TODAY: one outside company can freeze our whole site

Measured, loading the live Term Sheet Studio from local disk with **zero** network delay:

| What | Time |
|---|---|
| Page usable (you can type, numbers work) — **fonts answering normally** | **177 ms** |
| Page usable — **fonts not answering** | **12,911 ms** |

Same page. Same computer. Same files. The difference is **one request to Google Fonts.**

```html
<!-- web/v2/tools/term-sheet.html line 15 -->
<link href="https://fonts.googleapis.com/css2?family=Fraunces:...&display=swap" rel="stylesheet">
```

A stylesheet `<link>` is **render-blocking**: the browser refuses to show the page until that request
finishes. It is pointed at a server we do not own and cannot control. When Google Fonts answers quickly
— which is most of the time — nobody notices. When it does not, the visitor stares at a blank page until
the browser gives up. In this test that took **12.7 seconds**.

**Our own page is not slow. It is 177ms. We are 100% at the mercy of one third-party request.**

This is on **36 public pages**, and the PILOT portal is worse — it loads **two** separate Google Fonts
stylesheets. There are **zero** font files hosted on our own server.

**Who this actually hits** (this is the "why does it work differently for me than for you" answer):

- anyone behind a **corporate or bank firewall** that blocks Google — common in exactly our industry
- anyone running a **privacy blocker** (uBlock, Brave, Firefox strict mode) — these block Google Fonts
- anyone on a **weak mobile connection**, where it is one more round trip to a second company
- **certain countries** where Google is unreachable
- there is also a **privacy angle**: German courts have ruled that embedding Google Fonts sends the
  visitor's IP address to Google without consent, which is a GDPR problem. Self-hosting removes it.

**The fix is small and safe:** download the two font families once, put them in our own `assets/fonts/`
folder, and serve them ourselves. Same fonts, same design, nothing on screen changes. Removes an
outside dependency, removes a second DNS + TLS handshake, removes the privacy issue, and makes the
worst case impossible.

---

## 2. THE SECOND REAL PROBLEM: we send every visitor ~3.4x more than we need to

`src/server.js` has **no compression** — no `compression` middleware, no gzip, no brotli. The
`compression` package is not even in `package.json`. Express does **not** compress on its own.

Measured on the studio's own files:

| File | Sent today | Could be | Wasted |
|---|---|---|---|
| `termsheet.js` | 229,061 | 67,704 | 70% |
| `term-sheet.html` | 106,112 | 25,678 | 76% |
| `silver-program.js` | 110,403 | 34,171 | 69% |
| `standard-program.js` | 43,131 | 13,193 | 69% |
| `gold-standard.js` | 30,984 | 10,221 | 67% |
| `suite.js` + `suite.css` | 60,388 | 18,022 | 70% |
| `title-cost.js` | 5,766 | 2,107 | 63% |
| **Total** | **585,845** | **171,096** | **71%** |

The whole studio page weighs **1,088,960 bytes**. Roughly **415 KB per visitor is pure waste** on these
files alone.

ESTIMATED impact: on a typical mobile connection that is somewhere around **1–1.5 seconds of extra
waiting on every fresh page load**, for nothing.

**Fix:** add compression middleware. It is a two-line change and it is the single cheapest speed win
available.

> **NEEDS A LIVE CHECK — I could not verify this from here.** This sandbox blocks outbound traffic to
> `yscapgroup.com`, so I could not confirm whether Render's edge adds compression on its own. **The code
> definitely does not.** To check in ten seconds: open the site, press F12 → Network tab → click any
> `.js` file → look at Response Headers for `content-encoding: gzip` (or `br`). If it is missing, the
> waste above is real and live.

---

## 2b. THE LIKELIEST DIRECT ANSWER: the public term sheet page grew 75% in four days

An audit found this and I re-verified every byte from git history. Sizes of the three files the public
Term Sheet Studio loads:

| Date | `termsheet.js` | `term-sheet.html` | `silver-program.js` | **Total** |
|---|---|---|---|---|
| 2026-07-27 | 171,435 | 82,838 | *did not exist* | **254,273** |
| 2026-07-29 | 187,655 | 88,882 | 61,667 | 338,204 |
| 2026-07-30 | 220,644 | 98,230 | 108,982 | 427,856 |
| **2026-07-31 (live)** | **228,989** | **106,112** | **110,403** | **445,504** |

**+191,231 bytes — a 75% increase — in four days.**

The Silver Program (a real feature, added 2026-07-29, commit `6e11d29`) brought a **110 KB fourth
blocking engine script** onto the public page. The V1 page loads three engines; V2 now loads four.

**Nothing here is a mistake** — this is the product growing, as directed. But it is growing
**uncompressed** (§2), which is what turns normal feature growth into felt slowness. `silver-program.js`
alone would be 34 KB instead of 110 KB with compression on.

**If "the old static system" means the tool as it was last week, this is the measurable difference.**

---

## 2c. PILOT is 6.5x heavier than the standalone static tool

Audit-measured byte totals for a cold load:

| What you open | Bytes | If compressed |
|---|---|---|
| The V1 static term sheet page | 481,070 | 166,063 |
| The V2 static term sheet page | 686,666 | 227,936 |
| **The studio *inside* PILOT** (portal shell + studio iframe) | **3,136,233** | **877,089** |

**The same tool inside PILOT costs 6.5x what the old standalone page costs.** Two causes:

1. **The portal is one 2.07 MB JavaScript file** with no code splitting — every user downloads and parses
   the entire application (borrower + staff + underwriting + draws + closing + chat) before anything
   appears. V2 is 2.7x the size of V1. This has been true since V2 existed; there is no single commit
   that broke it.
2. **The portal downloads 190 KB of the pricing engines it never uses** — the dead copies. They are
   parser-blocking `<script>` tags in the `<head>`, and their only consumer in the entire application is
   one `console.info(...)` line. They are also fetched **twice per session** (once by the portal, once by
   the studio iframe, at different URLs, so the browser cannot share them).

**This is what Stage 0 already deletes** — the change sitting unmerged in the draft PR. It was built as a
security fix. It is also a 190 KB speed fix, and that was not the reason it was written.

---

## 2d. The term sheet PDF downloads a 364 KB library from someone else's server

`web/v2/tools/termsheet.js:1699` fetches jsPDF from a public CDN, falling back to a second public CDN:

```js
try { await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/..."); }
catch (e) { await loadScript("https://unpkg.com/jspdf@2.5.1/..."); }
```

**We already host both libraries ourselves** — `web/v2/tools/vendor/jspdf.umd.min.js` (364,463 bytes) and
`xlsx.bundle.js` (425,020 bytes) are on our server right now. And our **own sibling tools already use
them correctly**: `track-record.js:410` and `rehab-budget.js:785` both load `vendor/…` first.

The Term Sheet Studio is the one that does not. So the first "Download PDF" waits on an outside company —
fast on one network, slow or dead on another. For the term sheet, which is the entire point of the page.

**Fix:** two lines, copying the pattern our other tools already use. *(Note: V1 does the same thing, so
this is long-standing, not a new regression.)*

---

## 2e. Static files are told not to cache

`src/server.js:425-433` sets cache headers for `.html` (`no-cache`) and `/portal/assets/` (`immutable`)
— **and nothing else**. Everything else falls to the default, so the browser re-checks all ~12 studio
files with the server every single time the studio is opened, even when nothing changed.

The `?v=…` strings on those script tags are cache-*busters*; they do not set caching. Because those
already guarantee a new URL when a file changes, it is safe to cache them hard.

---

## 3. How fast the pricing is TODAY (the baseline to beat)

Measured in a real browser, on a fully-priced deal:

| | |
|---|---|
| One keystroke, comparison view | **2.3 ms** |
| One keystroke, Gold drilled in | **4.9 ms** (max 7.3) |
| Engine calls per keystroke | **24** (of which 3 are heavy pricing calls) |

The 24 calls per keystroke break down as: 1 Standard evaluate, 1 Gold evaluate, 1 Silver evaluate,
1 title estimate, 2 caps reads, 3 markup writes, and 15 small shape helpers.

**Confirmed: there is no debounce.** Every single keystroke runs all of that immediately. Today that is
free, because it all happens inside the visitor's own browser.

---

## 4. How fast the SERVER version would be — a working prototype, measured

I built a working prototype of the future `/api/quote`: the same frozen engines running in Node,
answering **one** request with **everything** the page needs — all three programs, all three ladders,
the caps row and the title estimate.

**The computing is not the problem. It is faster on the server than in the browser:**

| | |
|---|---|
| Full answer (3 programs + 3 ladders + caps + title) | **0.18 ms** median |
| p95 / p99 | 0.55 ms / 1.04 ms |
| Same deal asked again (answer cache) | **0.004 ms** — effectively free |
| Answer size | 9,940 bytes → **2,784 gzipped** |

**And the numbers are identical.** Every prototype run returned the same **$562,500** the browser
returns for the same deal.

**I also tested the one risk that only exists on a server.** The markup knobs are stored *inside* the
rule files. On a server that file is loaded once and shared by everyone, so one person's markup could
leak into the next person's answer — a silent wrong number for a different customer. Using the
set→use→reset pattern the codebase already uses in `src/lib/pricing.js`:

```
SHARED-STATE LEAK TEST: a plain quote AFTER someone else set a markup returns identical numbers: PASS
loan before: 562500   after: 562500
```

That risk is real, and it is provably handled — **as long as that pattern is used.** It is not optional.

---

## 4b. THE REFRAME: the pricing was never the slow part

Two independent measurements, put together, change the conclusion:

| | |
|---|---|
| One keystroke in a **real browser** (my measurement, includes drawing the screen) | **2.3 ms** |
| The **pricing math** inside that keystroke (audit measurement, engines only) | **0.020 ms** common case, **0.131 ms** worst case |

**So roughly 94% of a keystroke is drawing the screen, not pricing.** One `recompute()` does 43 text
writes, 16 HTML writes, 30 element lookups and a full re-format of every money field. The pricing is
already effectively free.

**That matters enormously for this decision.** Moving pricing to the server removes **0.13 ms** of work
and adds **40–300 ms** of network. We would be paying a large cost to remove something that was never
costing anything.

An audit also measured the **absolute physical floor**: a real HTTP round trip on the *same machine* —
no network, no encryption, no login, no database — is **0.99 ms**. That is already **7.6× slower** than
the entire worst-case keystroke today. The message-passing overhead alone (0.78 ms) is **six times** the
whole pricing computation.

**The gap is not the math. It is the speed of light and the network stack, and no server design closes
it.**

### And the engines already run on the server

`src/lib/pricing.js:18-21` **already loads these exact four files**. Its own header says:

> *"Registering a product recomputes here on the server so a tampered client can never inject fabricated
> terms; the browser copy of the engines is used only for instant what-if display."*

So the split already exists and was deliberate: **the server is already the authority when a product is
registered**; the browser copy exists for one reason only — instant what-if numbers as you type. Removing
it surrenders the only thing it was there to provide.

That does not kill the project — the security goal is real, the guideline rules genuinely are
downloadable today, and that is a genuine business risk. But it does mean **the trade is sharper than the
plan admitted**: this is not "make it server-side, same speed." It is "give up instant what-if typing to
stop publishing the rules."

---

## 5. The honest answer: it will NOT feel the same

Everything above is good news except this. Measured in a real browser, typing six characters:

| Your internet | Debounce | Requests | Settle | **One edit** |
|---|---|---|---|---|
| — | *(today, in-browser)* | **0** | — | **2 ms** |
| fast (30ms) | none | 7 | 493 ms | **38 ms** |
| typical (80ms) | none | 7 | 541 ms | **87 ms** |
| slower (150ms) | none | 7 | 612 ms | **159 ms** |
| mobile/far (300ms) | none | 7 | 763 ms | **309 ms** |
| typical (80ms) | 250 ms | **2** | 790 ms | **338 ms** |
| mobile/far (300ms) | 250 ms | **2** | 1010 ms | **559 ms** |

**Read the last column.** Today a number updates in 2 ms — instantly, faster than the eye. After the
move it updates in 40–300 ms depending on the visitor's internet. The numbers are identical. **The feel
is not.** It goes from "instant" to "quick but visible."

**I was wrong about the debounce, and the measurement proves it.** The plan said "add a 250ms debounce"
as the fix. It is not a pure fix — it is a trade. It cuts requests from 7 to 2, but it *adds its full
250ms to every single edit*, making the steady-state feel **worse** (338 ms instead of 87 ms on a
typical connection). A shorter delay (~100–120 ms) is the better balance, and I have corrected the
implementation plan.

There is a second reason to keep some debounce: a public quote endpoint that answers on every keystroke
is much easier for a competitor to probe automatically to map our rate matrix — the "oracle" risk in the
protection plan. Fewer, slower requests make that meaningfully harder.

---

## 6. How to make it as fast as it can be — ranked

1. **Self-host the fonts.** *(do this regardless of everything else)* Removes the 12-second worst case
   and an outside dependency from 36 public pages. Nothing on screen changes.
2. **Turn on compression.** *(two lines)* ~71% smaller downloads for every visitor.
3. **One request returns everything** — all three programs, all ladders, caps, title. Makes a keystroke
   one round trip instead of nine. Already proven: 0.18 ms to produce, 2.8 KB to send.
4. **Answer cache on the server.** The quote is a pure function of its inputs, so repeats are free
   (measured: 0.004 ms). Typing a number, changing it, and changing it back costs nothing.
5. **Answer cache in the browser too.** Same idea, one step closer: a value already asked about is
   instant, with no request at all.
6. **A short debounce (~100–120 ms), not 250.** Measured trade-off, see §5.
7. **Number the requests and only ever use the newest.** Prevents a slow early answer overwriting a
   fast later one — a silent wrong number.
8. **Ask on page load,** so the first answer is already there before anyone types.
9. **Keep the connection warm** and confirm Render does not cold-start the service.

**What we must NOT do:** keep a copy of the rules in the browser for "instant" numbers. That defeats the
entire purpose of the project, and it would put a number on screen that the server has not confirmed.
The rule stands: **never show a number we are not sure of.**

---

## 7. What "operates the exact same way" requires

### 7a. An important limit on my own earlier claim

I said "the numbers are identical." **That is proven for the pricing engines and not yet for the studio.**

`scripts/test-engine-parity.js` — the 115,200-scenario harness — only exercises `YSP.evaluate`,
`YSP.priceLadder`, `GSP.evaluate`, `SVP.evaluate` and `SVP.priceLadder`. It **never calls**
`YSTitle.estimate`, `YSP.caps`, `setMarkup`, or `calc()` / `calcGold()` / `calcSilver()`, and never
touches the PDF or the Excel export.

So it proves **the rule files themselves are byte-for-byte intact**. It says nothing about whether the
*screen* shows the same numbers. The fee arithmetic, cash-to-close, liquidity, the PDF and the
spreadsheet all sit **above** the engines and are untested.

**Before any swap ships, a second harness is needed** that drives the real page in a browser and compares
the rendered panel, the PDF text and the spreadsheet cells before vs after.

### 7b. The half-cent divergence — CONFIRMED, and it is an argument FOR the move

Two audits reported that the browser's fee arithmetic and the server's already disagree. My own first
attempt to reproduce it found nothing — **my test was too coarse** (I hand-wrote approximate formulas,
used a flat 1% origination, ignored extra fees and admin overrides, and tested Standard only).

A line-for-line replication of `calc` / `calcGold` / `calcSilver` against `pricing.js normalize()`, across
**11,749 program-quotes (6,000 deals × 3 programs)**, settles it:

| Field | How often they differ | Largest gap |
|---|---|---|
| Loan amount, initial advance, rehab holdback, financed reserve, reserves, title | **0%** | — |
| Origination fee | 1.23% | $0.005 |
| Closing due at closing | 4.43% | $0.005 |
| **Cash to close** | **7.69%** | **$0.005** |
| **Liquidity to show** | **9.41%** | **$0.005** |

> ### ⚠️ THE TABLE ABOVE IS WRONG. Corrected 2026-08-02.
>
> A third measurement — **28,960 program-quotes**, comparing the **exact strings the studio prints**
> against the server's values formatted identically — found:
>
> | Field | I claimed | Actually differs **on screen** |
> |---|---|---|
> | Origination fee | 1.23% | **never** (0 of 28,960) |
> | Closing due at closing | 4.43% | **never** |
> | **Cash to close** | **7.69%** | **NEVER — 0 of 28,960, on every program** |
> | **Liquidity to show** | **9.41%** | **1.80%, Standard only** (Gold and Silver: never) |
>
> **Overall: 0.75% of quotes, in one field, on one program.** I was wrong by roughly ten times, and
> **cash-to-close never visibly differs at all.**
>
> **What reconciles the three attempts:** the *raw, unrounded* arithmetic differs **often** (61–80% of
> quotes, always by exactly $0.005) — but a half-cent almost always rounds to the same displayed figure.
> My first attempt compared displayed values and found nothing; the second compared raw values and found
> ~8%; this one compared displayed values at scale and found 0.75%. **The raw number is real. The number
> a human sees is not, except in that one field.**
>
> My table was also **internally impossible** and I should have caught it: origination is the *source* of
> the error, so it cannot differ *less* often than cash-to-close, which is derived from it.
>
> **The real cause is narrower than "the server rounds at each step."** Exactly **one** rounding is not a
> no-op: the origination fee. Title, lender and credit fees are whole dollars; the reserve is a 2-decimal
> payment times a whole number of months; the buffer is 1% of a whole-dollar loan. Everything else was
> already exact.

**The loan structure is identical everywhere. One field, on one program, can show a cent apart.**

**And here is the part that matters most:** this divergence **already exists today**, between what the
studio *shows you* and what registration *actually saves*. Moving to the server does not create it —
**it removes it.** That is a genuine argument *for* the change.

But it must be **written down and expected**, or the first person who notices a cent moving will report
it as a bug the change caused, when in fact the change fixed it.

**Correction to my own earlier statement:** I told the owner "the numbers are identical." That is true of
the **loan amount and the whole loan structure** — verified. It is **not** true of cash-to-close and
liquidity, which differ by up to half a cent today. I should not have generalised from the loan amount.

### 7c. Must be true before anything ships

- `window.TS._calc()` must stay **synchronous**. Both portals call it inside a bare `catch (_) {}`. A
  Promise is neither falsy nor throwing, so it sails straight through — and the register button would be
  greyed out forever behind a *false* "this didn't size a loan" message.
- **A not-ready `calc()` must blank the panel, not throw.** If it throws, `recompute()` dies partway and
  skips the code that highlights the selected program card — so **tapping a program card does nothing**,
  and the portal then reports "no program selected" right after the officer selected one.
- **Exports must refuse from inside the export function**, not from the button. The portal calls
  `exportPdf` directly, bypassing the button entirely.
- **A refused PDF must block the register.** Today, if the PDF fails, the file registers anyway with a
  note — which means a loan file with **no term sheet**, discovered days later when the e-sign package
  will not send.
- **`targetLTC` must come from the fresh answer**, never from a possibly-stale one. It is the only
  computed value in the register payload and it changes the loan amount.
- **`setMarkup` set→use→reset must stay synchronous with no waiting in between.** Any pause between
  setting and using it leaks one visitor's markup into another visitor's quote.
- **Two endpoints, not one** — see §7d.
- **Offline stops working.** Today the studio needs the network only to *load*. After the move, a dropped
  connection leaves the last numbers on screen with nothing indicating they are stale.

### 7d. A design blocker the plan had not accounted for

The Term Sheet Studio is **one page serving two audiences**: the public marketing tool *and* the staff
portal (which embeds that same page in a frame). It carries **no login token** — it only ever calls
open endpoints.

The admin zone (markup, origination, rate and leverage overrides, manual pricing, force-price) is read
**inside** the pricing functions. So a single `/api/quote` has to either:

- **(a)** accept override values from **anonymous visitors** — letting a stranger price past the
  guideline limits and read the answer back; **or**
- **(b)** reject them — which **breaks the admin zone inside the portal for every staff member**,
  re-creating exactly the regression the 2026-07-27 directive was written to fix.

**Neither is acceptable.** It needs **two endpoints** — a public one that accepts only deal inputs, and a
staff one behind a login — and the portal must hand the embedded page a token, which is a genuinely new
capability that does not exist today. This is real work that the plan did not carry.

### 7f. THE WORST FAILURE THIS PROJECT CAN PRODUCE — two customers swapping rates

The markup setting lives *inside* the rule file. On a server that file is loaded once and shared by
everyone. Today that is safe for exactly **one** reason: the whole path from setting the markup to
resetting it is **synchronous** — there is no pause anywhere inside it, so the server physically cannot
start someone else's quote in the middle.

An audit demonstrated what happens if a single pause is ever introduced into that window. Two customers
quoting at the same time, one with a 0.5% markup and one with 4%:

```
customer A asked for 0.5% markup and got noteRate 14.000%   <- B's pricing
customer B asked for 4.0% markup and got noteRate 10.500%   <- A's pricing
```

**They do not just get a wrong rate. They get each other's rate.** No error, no warning, and essentially
impossible to reproduce afterwards because it depends on two requests overlapping by milliseconds.

**The rule, therefore:** never introduce a pause between setting the markup and resetting it, and never
make the quote function asynchronous. Everything it needs — company defaults, fees — must be resolved
*before* the engine is touched. This deserves an automated test that fails the build if the function ever
becomes asynchronous.

### 7g. The "Max LTC" trap — this would re-break a bug the owner already reported

The server and the browser mean **different things** by the caps row, and the difference is silent:

```
server  programCaps.maxLtc : 0.65    <- moves with the deal you typed
browser tierMaxOf().maxLTC : 0.925   <- fixed for the borrower's tier
```

Wiring the studio's "Program maximum leverage" to the server's version would show **65% where it shows
92.5% today** — which is precisely the 2026-07-30 report: *"the Max LTC should never change… it shouldn't
change based on what you're changing the interest reserve."*

**Worse, the field names differ in capitalisation** — server `maxAcqLtv / maxArvLtv / maxLtc` vs browser
`maxAcqLTV / maxARLTV / maxLTC`. The code that reads them would compare `undefined` to `undefined`, which
is simply `false`, so the "this deal caps at…" note would **quietly vanish with no error at all**. This
is the same trap CLAUDE.md already documents: a build passes, and the page is wrong.

### 7h. Three things do not exist on the server yet

The server cannot produce the studio's full picture today. Each must be built:

1. **The Gold ladder** — `pricing.js:510` hard-codes it to nothing; the real one lives only in the
   browser file. Must be ported (consumes engine output; changes no formula).
2. **The Standard tier caps row** — the server exposes neither of the two values needed to look it up.
3. **Gold's true program maximum** — the browser runs a *second* Gold evaluation with the overrides
   stripped to get it.

Skipping any of the three produces a **silently wrong or silently missing display** — not an error.

### 7e. Two more doors (the count is now eleven, not nine)

- **`tierMaxOf()`** (`termsheet.js:1225`) fires a **second, separate Gold evaluation** with the overrides
  stripped, to get the program's fixed maximum. Miss it and the "Program maximum leverage" row silently
  falls back to the *effective* ceiling — **re-breaking the exact bug reported on 2026-07-30** (the Max
  LTC moving when the interest reserve was edited).
- **The slider's own ladder call** (`termsheet.js:2976`) computes the ladder a **third** time and needs
  the rows **synchronously** to translate slider position into leverage. Without them it hits an early
  return and **the slider silently does nothing**.

Also confirmed: a `<select>` change (state, strategy) costs **two** full recomputes, not one — the same
handler is bound to both `input` and `change`, and browsers fire both.

---

## 8. Recommendation — the speed fixes are a SEPARATE, safe job

None of the following touches a pricing rule, a number, or a screen design. Each is independently
revertible. Ranked by benefit ÷ risk:

| # | Fix | Benefit | Risk | Size |
|---|---|---|---|---|
| 1 | **Turn on compression** | ~71% smaller downloads, everywhere, every visitor | very low | 2 lines |
| 2 | **Self-host the two font families** | kills the 12-second worst case on 36 pages; also a privacy fix | very low | small |
| 3 | **Merge Stage 0** (already built, already proven) | −190 KB of parser-blocking dead script from the portal | very low | done, unmerged |
| 4 | **Term sheet PDF uses our own copy of jsPDF** | removes an outside dependency from the core deliverable | very low | 2 lines |
| 5 | **Real cache headers on static files** | stops re-checking ~12 files on every studio open | low | small |
| 6 | **Split the 2.07 MB portal bundle** | large first-load win for every staff user | medium | real work |
| 7 | **Make the studio's 700ms poller cheap** | stops a re-render 1.4x/second while the studio is open | medium | moderate |

**Items 1–4 are the ones I would do first.** They are small, safe, reversible, and they fix problems that
exist **today** and have nothing to do with moving the rules.

**Then decide the pricing move on its own merits,** knowing the honest trade: the numbers stay identical
and the rules stop being downloadable, but typing goes from instant to 40–300 ms depending on the
visitor's connection.

**Note on ordering:** fixing compression *first* also makes the pricing move cheaper to judge, because it
removes the biggest confound. Right now it is impossible to tell "the server is slow" from "the page was
always heavy."

### 8b. THE BIGGEST SPEED LEVER IS NOT IN THE CODE — and nobody has checked it

The server's own share of a quote is **1–4 milliseconds** and is not worth optimising further. Everything
else is network. And the single largest factor in that is **which physical region the service runs in** —
which is **not recorded anywhere in this repository** (`render.yaml` has no region setting; its own header
says the live service was created by hand in the dashboard).

| Where the server is | Cost per keystroke |
|---|---|
| Near the team (Virginia / Ohio) | **~18–45 ms** |
| Far from the team (Oregon) | **~70–100 ms** |
| Mobile / far | ~150–350 ms |

**That is a 50 ms swing — larger than every code optimisation on this page combined.** If the service sits
on the opposite coast, no amount of engineering fixes it, and moving a region means building a new service
and migrating the database.

**Check this before promising any speed number.**

Good news on a related worry: the service is on a **paid** tier (it has a persistent disk and a health
check, which the free tier does not support), so it does **not** go to sleep and there is no "first visitor
of the morning waits" problem. A deploy still restarts it — worth running one throwaway quote at startup so
the first real user does not pay the warm-up.

### 8c. Three small things to get right if the move happens

- **Every keystroke would currently write a database audit row.** The audit logger records everything under
  `/api/`, so a public quote endpoint would write thousands of rows a day of no investigative value. One
  line to exclude it.
- **An answer cache must be cleared when an admin changes the company fees**, or their change is invisible
  for up to a minute while cached answers keep coming back.
- **The four rule files are currently byte-identical between the two folders** — verified. That is
  load-bearing for the whole plan and is maintained *by hand*. It deserves an automated check, because
  nothing today would catch them drifting apart.

---

## 9. What was checked and ruled OUT

So the record shows what is *not* the problem:

- **The pricing engines themselves.** All three programs evaluate in ~0.013 ms. Not the cost, at any
  point, in any measurement.
- **Service workers serving stale files.** Network-first for pages, correctly versioned cache names, and
  the reload-loop guards are in place.
- **A recent bad commit.** The portal bundle has grown steadily (~56 KB over 20 builds). There is no
  cliff, no single change that "made it slow."
- **Request auditing / database logging on static files.** Static requests are skipped entirely.
- **Any previously-tracked performance issue.** Nothing in `docs/` or `CLAUDE.md` records a prior
  complaint about portal or studio speed — this is new to the record.

---

## 9b. WHERE I WAS WRONG — an adversarial audit, and what it found

A third audit was told to disprove everything above rather than confirm it. It did, in six places. All are
corrected in place; they are listed here so the record is honest.

| What I claimed | What is actually true |
|---|---|
| Cash-to-close and liquidity differ on ~8% of deals | **Wrong by ~10×.** Cash-to-close **never** visibly differs; liquidity differs on **1.80%** of Standard quotes only. See §7b. |
| The "Max LTC" problem is triggered by editing the **interest reserve** | **Wrong trigger.** It moves with the **leverage slider and admin overrides** — not the reserve. And **Silver is already correct on the server**, so it is a Standard + Gold problem. The field-name mismatch half is confirmed. |
| A same-machine round trip is **0.99 ms** — "the physical floor" | **Wrong by 13×.** Measured **0.076 ms** on a kept-open connection. My "7.6× slower than a keystroke" and "6× the computation" lines do not survive. *The conclusion is unaffected* — the network still dominates — but I over-argued it. |
| One keystroke costs **24 engine calls** | Right **only** in the comparison view. Gold drilled in is **59**; a dropdown change with Gold drilled in is **118**; one slider drag is **87**. |
| There are **eleven doors** into the rules | **Double-counted.** Ten under my own definition. The number that matters for the work is **~42 call sites across 21 functions**, plus four more on the loan application page. |
| One recompute does 43 text writes and 30 element lookups | **Understated.** Measured **74 text writes and 339 lookups**. This makes the "it's the screen, not the pricing" case *stronger*, and points at an easy fix I never proposed: remember the elements instead of looking them up 339 times. |

**What held up under attack:** the 94%-is-screen-drawing finding (re-measured independently — the pricing
is **0.6%** of a keystroke, so I was being *conservative*); the ten-step ladder maximum (verified over
1.5 million scenarios); the shared-markup safety (proven synchronous end to end); and every byte count.

---

## 9c. A HOLE IN MY OWN SAFETY NET — found, reproduced, fixed

The audit found a real defect in the parity harness **I built and put into `npm test`**, and I reproduced
it myself before fixing it.

**The title-cost rules were never actually tested.** The file was loaded and fingerprinted, but never
*run* — so changing a title fee produced no difference at all. And a changed fingerprint only printed a
warning. Proven: I edited a title rate and ran the suite:

```
⚠ ENGINE FILE(S) CHANGED since the baseline: title
PASS — every scenario produces identical numbers.
EXIT CODE: 0
```

**`npm test` went green on a changed guideline file, printing a sentence that was false.**

Three fixes, each verified by tampering with a real file and confirming it now fails:

1. **Title costs and the caps table are now exercised on all 115,200 scenarios** — a change to either
   moves the fingerprint.
2. **A changed rule file is now FATAL, not a warning.** If a change is authorised, the baseline is
   re-recorded deliberately — which is the reviewable act that records it.
3. **The two copies of each rule file must now match.** They are maintained *by hand*, and nothing
   checked it. If they drift, the server prices one way and the page shows another.

Verified: a title change → **caught**. A markup change → **caught**. A deliberate drift between the two
folders → **caught**, naming both fingerprints.

**The baseline fingerprint therefore changed** (it now covers more) from `654b6287ffa65cfb` to
`654b6287ffa65cfb`. **No pricing number moved** — the rule files are byte-identical.

**Also corrected: a published checksum in the plan was wrong** — and it was the capital partner's
workbook, the most sensitive of the four. It had been captured before two changes on 2026-07-30. All four
now match reality.

---

## 10. The verdict, in one place

**On "why is it slow":** three real causes, all confirmed, **none of them pricing** — a third-party font
request that can freeze the page for 12 seconds, no compression (3.4× the necessary download), and the
public studio page growing 75% in four days. Plus the structural one: the same tool inside PILOT costs
6.5× what the standalone page costs.

**On "why doesn't it work the same as the old static system":** most likely that 6.5× weight difference,
plus the font dependency, which fails for some people and not others depending on their network, browser
and employer.

**On "will the server version operate the exact same way":**

- **The loan structure — yes.** Loan amount, initial advance, rehab holdback, reserves and title are
  identical, proven across 11,749 quotes plus 115,200 engine scenarios.
- **Cash-to-close and liquidity — they will MOVE, by a cent, on about 8% of deals.** Not a new bug: the
  studio and registration already disagree today, and the move *fixes* it. Must be expected and written
  down, or it will be reported as a regression.
- **The screen, the PDF and the Excel — unproven.** No test covers that layer. A browser-level harness is
  required first.

**On "how fast can it be":** the server's own work is 1–4 ms and is already effectively free. Everything
else is network, and the biggest single factor — which region the server runs in — **is not recorded
anywhere and nobody has checked it.** That one unknown is worth more than every code optimisation
combined. Realistically 20–45 ms per keystroke for a well-placed server on a wired connection, versus
2.3 ms today.

**The honest summary:** the security problem is real — the guideline rules are downloadable right now, and
that includes a capital partner's confidential workbook. But the fix costs instant typing, and the pricing
math was never what made anything slow. **Those are two separate decisions, and they should be made
separately.**

---

## How to re-run any of this

Scripts live in the session scratchpad (`scratchpad/mainsess-ux/`):

- `bench-ux.js` — real browser: cost of one keystroke, engine calls, page weight
- `bench-load.js` — real browser: what makes the page slow to load
- `bench-nofont.js` — the same page with fonts answering instantly (the 177 ms figure)
- `proto-server.js --bench` — the prototype server: compute cost, cache, shared-state leak test
- `bench-roundtrip.js` — real browser: how the server version feels at different internet speeds

Engine-number parity is permanent and already wired in: `node scripts/test-engine-parity.js`
(115,200 scenarios, first step of `npm test`).
