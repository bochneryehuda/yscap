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

Proven so far:

- **Same numbers** — 115,200 scenarios match exactly (`npm test`, first step), and the prototype
  returned the identical `$562,500` on every run.
- **Shared-state leak** — provably handled by set→use→reset. Must not be skipped.

Still required before anything ships (these are in the implementation plan):

- `window.TS._calc()` must stay **synchronous**, or the staff register screen silently reads blank or
  stale numbers — both portals call it inside a `catch` that would swallow the failure.
- **Every export must refuse to run** while an answer is in flight. A term sheet built on the previous
  deal's numbers is a legal document with the wrong terms on it.
- **Every door must be covered**, not just the three `calc` functions — the offer cards, the Gold
  slider, the ladders, the caps row and the admin zone each reach the rules separately.
- **Offline stops working.** Today the studio keeps working with no internet once loaded. After the
  move it cannot. That is a real, permanent behaviour change and it must be a deliberate decision.

---

## 8. Recommendation

**Do §6.1 and §6.2 now, on their own, separately from the pricing project.** Self-hosting the fonts and
turning on compression are small, safe, reversible, and they fix a real problem that exists today and
has nothing to do with moving the rules. They will make the site feel faster immediately.

**Then decide the pricing move on its merits,** knowing the honest trade: the numbers stay identical and
the rules stop being downloadable, but typing goes from instant to 40–300 ms depending on the visitor's
connection.

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
