# Independent Review of the Server-Side Term Sheet Plan

**Status:** REVIEW ONLY. Nothing built or changed.
**What this is:** an independent check of the proposed "move the engines to the server" plan, done
**against the live repository** — which the proposal itself notes it could not see
(*"A live GitHub connector or checked-out repository was not exposed in this session"*).

**Verdict up front: the plan is sound and I agree with its core.** "Move the brain, not the body" and
"preserve the calculation contract" are the right calls. But it is working from an incomplete file list,
and it contains **one assumption that is factually wrong about this codebase** and would produce a
silent, expensive bug. Details below.

---

## 1. What the proposal gets right (confirmed against the code)

| Claim | Verified? | Evidence |
|---|---|---|
| Engines already run server-side | ✅ **Yes** | All four are UMD; `src/lib/pricing.js` already `require()`s them |
| Gold depends on Standard | ✅ **Yes** | `gold-standard.js:24` → `require("./standard-program.js")` |
| Engines are DOM-free pure logic | ⚠️ **Mostly** — see §3.1 | No DOM, but **not stateless** |
| Async is the biggest behavioural change | ✅ **Yes** | Today `calc()` returns instantly and renders |
| PDF/Excel are separate consumers that get missed | ✅ **Yes** | `sigBlock()` (PDF) and `xlsxSections()` both recompute |
| Don't rebuild in React | ✅ **Agree** | Nothing requires it |
| Preserve the result-object contract, don't remap fields | ✅ **Agree** | `calc()` returns ~40 flat fields the whole UI reads |
| A public API can still be probed | ✅ **Yes** | Unavoidable without a login |
| Data-shape drift (0 vs null, 9.75 vs 0.0975) | ✅ **Real** | Exactly the right things to worry about |

**Its correction of my earlier "only three doors" claim is right, and I was wrong.** Engine calls are
**not** confined to `calc`/`calcGold`/`calcSilver`. Verified locations:

| Function | Engine call | What it is |
|---|---|---|
| `calc` (287, 317) | `YSP.evaluate`, `YSTitle.estimate` | main calculation |
| `calcGold` (375) / `calcSilver` (434) | `YSTitle.estimate` | per-program |
| `updateConditionals` (272) | `YSP.projectCount` | form behaviour |
| `renderLeverage` (669) | `SVP.priceLadder` | **the slider** |
| `wire` (2461) | `priceLadder` | **the slider wiring** |
| `sigBlock` (1827) | `SVP.priceLadder` | **inside the PDF** |
| `item` (1713) | `YSP.normStrategy` | rendering |

So it is roughly **nine** touch points, not three. My earlier estimate was too optimistic — the
proposal's more cautious read is the correct one.

---

## 2. What the proposal MISSES (from the live repo)

### 2.1 🔴 It omits `silver-program.js` — the most sensitive file of all

The proposal's file list is `standard-program.js`, `gold-standard.js`, `title-cost.js`, `termsheet.js`.

**The live public V2 term-sheet page loads five scripts, including `silver-program.js?v=silver2`.**

That file transcribes a **capital partner's confidential pricing and eligibility workbook** — their rate
grid, tier caps, DSCR floors, excluded states and ZIPs. It is third-party confidential data, and it is
the single strongest reason to do this project at all.

**A developer following that plan literally would leave it publicly downloadable.** Any implementation
brief must name all four engines, and Silver first.

### 2.2 🔴 There are 24 public copies, not 4

| Engine | Copies | Identical? |
|---|---|---|
| `standard-program.js` | 6 | ✅ all identical (`18cf2e34`) |
| `gold-standard.js` | 6 | ✅ all identical (`da11d625`) |
| `silver-program.js` | 6 | ✅ all identical (`94c335bc`) |
| `title-cost.js` | 6 | ✅ all identical (`d165a204`) |

Under `web/tools`, `web/v2/tools`, `web/portal/engines`, `web/v2/portal/engines`, `app/public/engines`,
`app-v2/public/engines`. **Removing four files removes nothing** — the other twenty stay downloadable.

Also: **`termsheet.js` is NOT identical between v1 and v2** (different checksums), so the frontend work
is either done twice or v1 is deliberately left frozen at `/v1`.

### 2.3 🟠 A free win the plan doesn't know about

`web/portal/engines/*` and `web/v2/portal/engines/*` (8 files, including two copies of the partner's
workbook) are loaded by the portal shell and **used for nothing** — `App.jsx` only passes them to a
`console.info` debug line. They compute no value anywhere.

**They can be deleted today with zero behavioural change.** That is a real chunk of the exposure removed
in hours, with no API, no async, no parity testing.

### 2.4 🟠 `loan-application.html` is a certainty, not a "potential"

The plan lists "Potential loan-application calculations." It is definite: that page calls
`YSP.evaluate`, `YSP.normStrategy`, `YSP.setMarkup`, `YSTitle.estimate`. Pull the script tags without
handling it and the loan application breaks.

### 2.5 🟡 `termsheet.js` is on this repo's frozen list

The proposal casually says "Modified `termsheet.js` presentation layer." In this codebase that file sits
under a hard freeze requiring the owner's explicit written authorization. The change is legitimate
(rewiring where a value comes from, not changing a number) — but it needs sign-off, not a casual edit.

---

## 3. The two things most likely to actually go wrong

### 3.1 🔴 THE BIG ONE: the engines are **not stateless**, and the plan assumes they are

The proposal says the adapter simply "calls the unchanged functions: `YSP.evaluate(input)`,
`YSP.priceLadder(input)`, `GSP.evaluate(input)`," describing them as pure logic.

**They are not pure.** `setMarkup()` writes to a **module-level variable**:

```js
standard-program.js:26   function setMarkup(f) { MARKUP_OVR = (…) ? f : null; }
```

Node caches `require()`d modules, so there is **exactly one shared instance for the entire server
process**. Every visitor's request shares that variable. `termsheet.js` calls `setMarkup` on all three
programs, and the admin zone can override the markup — so this value genuinely varies per request.

**The existing `src/lib/pricing.js` already handles this correctly**, and the way it does so is
load-bearing and easy to destroy:

```js
if (m != null) setEngineMarkup(program, m);      // set
try   { const ev = SVP.evaluate(input); … }      // use
finally { if (m != null) setEngineMarkup(program, null); }   // always reset
```

The safety comes from the fact that **the whole set → use → reset window is synchronous** — I checked,
there is no `await` anywhere inside `quoteProgram`/`quoteAll`. Node is single-threaded, so nothing can
interleave.

**The failure mode:** a new adapter, written from the proposal's description, naturally wants to do
something like `const settings = await pricingSettings.load()` near the calculation. The instant an
`await` lands between set and use, two visitors quoting simultaneously **silently swap markups** — one
borrower is priced with another's rate. It would not throw, would not appear in tests that run one
scenario at a time, and would be very hard to reproduce.

**Mitigation (must be an explicit instruction):** the public endpoint does all its `await`ing *before*
touching the engines; the set→use→reset window stays strictly synchronous; and a concurrency test fires
overlapping requests with different markups and asserts each gets its own answer.

### 3.2 🔴 Building a SECOND adapter is the top architectural risk

The plan's Phase 2 says "build the private server runner" as though none exists.

**One already exists and is in production.** `src/lib/pricing.js` loads these exact engines, applies the
company/per-file markup and origination defaults, and implements the frozen floor-and-reconcile rounding
(`normalize`). It is what the staff portal, the borrower portal, and — critically — **product
registration** use. The registered loan is the number on the term sheet the borrower signs.

If the public endpoint gets its own fresh implementation, we end up with **two server-side pricing paths
that can drift**, and the drift shows up as the public quote disagreeing with the registered loan. That
is precisely the class of failure the whole exercise is meant to prevent.

**Mitigation:** the public endpoint must be a thin wrapper over the existing `pricing.quoteAll(...)` —
construct an in-memory deal object from the posted inputs, call it, map to the response. **No second
implementation of the math, the rounding, or the fee defaults.**

---

## 4. Everything else that can bite, ranked

| # | Risk | Likelihood | Impact | Notes |
|---|---|---|---|---|
| 1 | Concurrent markup cross-contamination (§3.1) | **Medium** | **Severe** — wrong rate, silent | Only if an `await` enters the window |
| 2 | Public quote drifts from registered loan (§3.2) | **Medium** | **Severe** | Prevented by reusing `quoteAll` |
| 3 | Silver left exposed because it's off the list (§2.1) | **High** | **High** | Project's main purpose missed |
| 4 | Some of the 24 copies left behind (§2.2) | **High** | **High** | Removing 4 achieves nothing |
| 5 | PDF/Excel/slider missed (they recompute) | Medium | Medium | Screen right, documents wrong |
| 6 | Shape drift (0 vs null, rate scale, missing `reasons`) | Medium | Medium | The proposal's table is correct |
| 7 | Stale answer exported mid-calculation | Medium | Medium | Needs input-fingerprint gating |
| 8 | Out-of-order responses | Medium | Low–Med | Sequence numbers |
| 9 | Endpoint down → tool looks broken on a public page | Medium | Medium | Must fail loudly, never fall back to a browser engine |
| 10 | Rollback re-exposes the rules | Low | **High** | A rollback is a re-disclosure — plan forward fixes |
| 11 | API probing infers the matrix | Medium | Medium | Accepted: owner has ruled out a login |
| 12 | No parity harness exists yet | **High** | Medium | Has to be built; both plans assume it |

**On #12:** there are pricing tests (`test-pricing-overrides-pure.js`, `test-termsheet-freeze.js`), but
**no old-browser-vs-new-server comparison harness exists**. Both documents treat this as a given; it is
real work and should be budgeted.

**False alarm worth recording:** `src/lib/underwriting/loan-primer.js` matches a search for `window.YSP`,
but only inside an **AI prompt string** describing the engines. It is not a consumer. An inventory that
greps without reading will over-count it.

---

## 5. Is it legitimate, reasonable, and easy?

**Legitimate: yes.** The exposure is real and this is the correct fix.

**Reasonable: yes.** "Move the brain, keep the body" is right, and materially safer than a React rebuild.

**Easy: no — but it is tractable, and it splits cleanly into very different difficulty levels.**

| Piece | Difficulty | Why |
|---|---|---|
| Delete the portal's dead copies | **Trivial** | Nothing uses them. Hours. |
| Move the four engines to a private folder | **Easy** | Already UMD; keep them siblings so gold's `require("./standard-program.js")` still resolves |
| Repoint `src/lib/pricing.js` | **Easy** | Four `require` lines |
| Public endpoint wrapping `quoteAll` | **Moderate** | Straightforward *if* it reuses the existing adapter and respects §3.1 |
| Loan application page | **Moderate** | Only two real engine calls |
| Term sheet studio rewiring | **Hard-ish** | ~9 touch points incl. the slider and the PDF |
| Parity + concurrency + race testing | **Moderate, unavoidable** | This is where the safety actually comes from |

**The honest summary:** the *engine move* is the easy part, exactly as both documents say. The *frontend
rewiring* is medium. The two things most likely to produce a real, expensive, silent failure are the
shared-markup concurrency trap and a duplicate server-side implementation — **and neither of those is
mentioned in the plan you were given.**

---

## 6. What I'd change in the brief before anyone writes code

1. **Name all four engines, Silver first.** Silver is the third party's data.
2. **Inventory says 24 copies.** The acceptance test is that every one of them 404s.
3. **Do NOT build a new server adapter.** Wrap the existing `pricing.quoteAll`.
4. **Write the concurrency rule down explicitly:** no `await` between `setMarkup` and `evaluate`; always
   reset in `finally`; add an overlapping-request test.
5. **Stage 0 first** — delete the dead portal copies. Hours, zero risk, real reduction.
6. **Treat `termsheet.js` as frozen** — owner sign-off before editing, equivalence proof after.
7. **Build the parity harness before the migration**, not alongside it.
8. **Handle v1 explicitly** — either migrate both or state that `/v1` stays as-is.
9. **Accept and record the probing risk**, since a login has been ruled out.

---

## 7. Where the two plans and I agree completely

- Don't rebuild in React.
- Preserve the input and result contracts; don't remap fields into a new model.
- Don't edit the engines while moving them.
- Don't mix guideline corrections into this migration.
- Never leave a browser-side engine as a fallback.
- Exact parity, not "looks about right."
- Rate limiting, validation, generic errors, no batch endpoint, versioned endpoint.
- Never claim it's unhackable.

_Nothing in this document has been implemented._
