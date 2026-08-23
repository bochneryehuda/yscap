# The track-record condition — which number it demands, where that number comes from, and every route into it

**Research only. Nothing in this document has been built.** It answers the owner's 2026-08-23
questions: *"where the track record condition is that we need to sign. From where exactly does he
take his number? How many experiences does he need to verify before you can sign them off? Is he
taking it from the application, or is he taking it from the last registration? I believe there are
a few routes for this."*

Every claim is cited to `file:line` on this branch.

---

## 1. The short answer

**The condition is `rtl_p3_reo` — "REO / experience sheet completed & verified"** (db/005:90),
carried on the file as a `checklist_items` row with `tool_key='track_record'` (db/006:32).

**The number it demands is the CURRENT product registration's experience** —
`product_registrations.inputs.expFlips / expHolds / expGround` on the row where `is_current` —
**not** the application's claim. The application's claim
(`applications.requested_exp_flips/_holds/_ground`) is used only as a **fallback when the file has
no registration yet**.

**How many must be verified: exactly the registered number, bucket by bucket** — flips ≥ registered
flips, holds ≥ registered holds, ground-up ≥ registered ground-up. There is no global minimum, no
percentage, and no rounding. A "verified" deal is one that is `is_verified = true` **and** exited
inside the frozen 36-month window.

Both facts live in **one function**, `experience.registeredExperienceNeed`
(`src/lib/experience.js:241`):

```js
const cur = await client.query(
  `SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
if (!cur.rows[0]) return base;                     // ← the application's claim, the fallback
const pin = cur.rows[0].inputs || {};
return { flips: int(pin.expFlips), holds: int(pin.expHolds), ground: int(pin.expGround) };
```

**Why the registration and not the application** — deliberate, owner-directed 2026-08-09: a loan
is *sized* on the CLAIMED experience, so lowering the claim after the term sheet went out must not
silently relax the gate. The requirement only comes down when the product is **re-registered** on
the lower number. Stated in full at `src/lib/experience.js:274-281` and again at
`src/routes/staff.js:9499-9512`.

---

## 2. Where the sign-off actually happens

`signOffGate` (`src/routes/staff.js:8940`), reached from `PATCH /api/staff/checklist/:itemId`
(`:9639`, `:9668`, `:9675`). The experience branch is selected at `:8958`:

```js
const isExp = code === 'rtl_p3_reo' || item.tool_key === 'track_record';
```

**Four gates run in order, and all four must pass:**

| Order | Gate | Where | Blocks on |
|---|---|---|---|
| 1 | **No undecided documents** | `pendingDocumentsBlock`, `staff.js:8923` | any `pending` document on the condition — must be accepted, rejected or deleted |
| 2 | **No unfilled extra slots** | `conditions/extra-slots.gateProblem`, `staff.js:8947` | a document somebody requested on this condition that is not in and accepted |
| 3 | **Track record has no open findings** | `track-record-findings.experienceBlockReason`, `staff.js:9495` | any open finding with `severity !== 'info'` — merge the duplicate, remove the line, or say it is fine |
| 4 | **Verified experience meets the registered need** | `staff.js:9513-9534` | the count comparison below |

Gate 3 was **silently dead** until recently — `app.id` was `undefined` in the SELECT list, bound as
NULL, matched no borrower (documented as D1 in `docs/TRACK-RECORD-CURRENT-STATE.md:216`). It now
correctly passes `item.application_id` (`staff.js:9495`), with the reason recorded in the comment
above it.

### 2.1 The count comparison, in full

```js
// src/routes/staff.js:9512-9534
const claim = require('../lib/experience').requestedFromApp(app);
const need  = await require('../lib/experience').registeredExperienceNeed(item.application_id, db, claim);
if (need.flips + need.holds + need.ground === 0) return null;      // nothing to verify → free sign-off

const tr = await db.query(
  `SELECT lower(coalesce(deal_type,'')) dt, count(*)::int n
     FROM track_records
    WHERE borrower_id = ANY($1::uuid[]) AND is_verified=true AND (${RECENT_EXIT_SQL})
    GROUP BY 1`, [expBorrowerIds]);
…
if (v.flips  < need.flips)  short.push(`${need.flips  - v.flips } more flip(s)`);
if (v.holds  < need.holds)  short.push(`${need.holds  - v.holds } more hold(s)`);
if (v.ground < need.ground) short.push(`${need.ground - v.ground} more ground-up`);
```

Four things to note:

* **`need` is asked BEFORE the zero check.** That ordering *is* the 2026-08-09 fix. The old order
  was `if (claimed === 0) return null;` first — so lowering `requested_exp_*` to zero signed off a
  condition whose current registration still priced the loan on three flips. Proven end-to-end and
  now guarded by `scripts/test-experience-gate-need-db.js`, which drives the **real HTTP door**
  because the earlier findings defect survived precisely by being tested below the route.
* **Both borrowers count.** `expBorrowerIds = [borrower_id, co_borrower_id]` (`:9450`) — a file with
  a co-borrower sums both people's deals (#80). Each `track_records` row belongs to exactly one
  borrower, so nothing is double-counted.
* **Bucket by bucket, never a total.** 3 verified flips do not satisfy a registered need of
  2 flips + 1 hold. (The one sanctioned way to move a deal between buckets is §6.)
* **Only `is_verified = true` counts.** Owner-directed 2026-07-20: *"If it's not verified
  experience, then you should not be able to sign off that experience condition even if you entered
  everything."*

### 2.2 What counts as a verified experience

Two independent conditions, both required:

1. **`track_records.is_verified = true`.** Set only by `POST /api/staff/track-records/:id/verify`
   (`src/routes/staff.js:12456`). Since 2026-08-10 **only the status `verified` counts** —
   `limited` no longer does (`:12464`). It is processor-only (`sign_off_conditions`, `:12485`),
   because verifying a line *is* signing off experience.
2. **A completed exit inside the frozen 36-month window** — `RECENT_EXIT_SQL`
   (`src/lib/experience.js:79`), which is `EXIT_DATE_SQL` non-null, not in the future, and
   `>= CURRENT_DATE - INTERVAL '36 months'`. The exit date is the sale date for a flip, the
   rent-or-refi date for a hold, and — since the owner-authorised ground-up amendment of
   2026-08-09 — sale-or-rent-or-refi for a ground-up (`:66-71`).

The verify route refuses a line that would fail (2) *at the click*, with the same wording the
file's to-do list uses (`staff.js:12496-12511`), so a "verified but counts toward nothing" line
cannot be created.

**A material edit un-verifies the line automatically.** The database trigger
`track_record_verify_guard` (db/485 → db/493 → db/500 → db/501 → **db/516**, which is the live one)
returns a row to `pending` whenever a load-bearing figure changes: the address (compared
*semantically*, so a re-spelling or a storage-shape repair is spared), the deal type, the dates.
`pillars_met` is material **in the withdrawal direction only** (db/516:96) — confirming the last
pillar must not un-verify the line somebody just finished.

**Borrower tier is a separate number.** `borrowers.tier` is recomputed as a flat count of verified
in-window rows (`staff.js:12550`) and feeds **pricing**, not this gate. Do not confuse it with the
condition's requirement.

---

## 3. The three-value picture the condition shows

`experience.syncExperienceChecklistForApplication` (`src/lib/experience.js:250`) writes the
condition's `tool_payload`. It carries **three different numbers on purpose**, and knowing which is
which is the whole answer to "where does he take his number from":

| Payload key | Meaning | Source |
|---|---|---|
| `required` | what the **file itself claims** | `applications.requested_exp_*` |
| `gateNeed` | **what must be verified to sign off** | the current registration's `inputs.exp*`, falling back to `required` |
| `counts` | deals **entered** on the track record, in-window | `track_records` (any verification state) |
| `verifiedCounts` | deals **verified**, in-window | `track_records WHERE is_verified` |
| `needFrom` | `'registration'` or `'application'` — **which of the two answered** | `:294` |
| `claimBelowNeed` | the stuck state: the file now claims LESS than the loan was priced on | `:295` |
| `reRegisterBlockedBy` | whether the advice "re-register" can even be followed | `file-lock.structuralLockReason`, `:318` |

`met` (ready to sign) is `requirementMet(verifiedCounts, gateNeed)` — **verified against
registered** (`:412`). `enteredMet` is the same against `counts`, kept only so the desk can say
"entered enough, X still to verify".

The front end reads exactly these (`app-v2/src/screens/StaffApplication.jsx:3996`,
`const r = p.gateNeed || p.required`) and renders the shortfall against `gateNeed`, so the screen
and the gate cannot disagree.

`needFrom` / `claimBelowNeed` / `reRegisterBlockedBy` exist because of the owner's 2026-08-21
report — *"we changed the application to only three experiences, we changed the products and
prices to only three, but the condition is still requiring five and we can't sign off"* (file
YSCAP258134810 / 5705 Melvin St). The requirement rule was correct; what was missing was the
screen **saying** where the five came from and what clears it.

---

## 4. THE ROUTES — every way the number gets set

The owner is right that there are several. They split into **two ladders**: routes that set the
**application's claim**, and routes that set the **registration's number**. The gate reads the
registration; the claim only decides applicability and the pre-registration fallback.

### 4.1 Ladder A — routes that write the application's CLAIM (`applications.requested_exp_*`)

| # | Route | Where | Notes |
|---|---|---|---|
| A1 | **Public application intake** | `src/routes/intake.js:223,246` | the borrower's own answers on the apply form |
| A2 | **Borrower portal apply / draft save** | `src/routes/borrower.js:809,4420` | `intField(b.requestedExpFlips)` etc. |
| A3 | **Staff new-file create** | `src/routes/staff.js:1516,1528` | same three fields |
| A4 | **Lead → loan-file convert** | `src/routes/staff.js:17698,17724` | maps the lead's `expBrrrr` to the holds bucket |
| A5 | **Staff details door (`PATCH …/details`)** | `src/lib/details-fields.js:28-30` → `src/routes/staff.js:13860` | the ordinary edit; recomputes the condition immediately |
| A6 | **Term Sheet Studio autosave** | `src/lib/studio-experience-claim.js:122` | **staff only.** Owner-directed 2026-08-06 — typing 10 into "BRRRR / rentals stabilized" and generating a term sheet *without* registering used to leave the file claiming ZERO, and zero read downstream as a confident "no experience required" |
| A7 | **Product registration write-back** | `src/lib/product-registration.js:412-414` | `COALESCE($20, GREATEST(current, registered))` — an **explicit** studio number (including a typed 0) wins verbatim so a claim can be *lowered*; a **blank** field states nothing and keeps the conservative never-lower `GREATEST` |
| A8 | **MISMO import** | `src/lib/mismo/index.js:347`, `parse.js:262` | `RequestedExperienceFlips` etc. from the import file |
| A9 | **Condition "information request" answer** | `src/lib/conditions/engine.js:555` + `field-registry.js:552-554` | the borrower or staff answering an info condition writes straight through `WRITE_TARGETS`. **This door does not call the experience recompute** — see §7 |

A borrower **cannot** set experience through the studio: `ProductStudioPanel` locks those three
fields for them and the borrower/TPO register routes strip every experience override
(`src/routes/borrower.js:1147`, `src/routes/tpo.js:749`). A borrower asks for a change; the team
approves it.

Every write on this ladder trips the pricing-reopen trigger — the current spelling is db/486,
descended from db/072 → db/074 → db/126 → db/145 → db/190 (`db/486_reopen_reason_names_every_input.sql:114-116`), which
is why A6 is `IS DISTINCT FROM`-guarded (`studio-experience-claim.js:163`): a no-op autosave would
otherwise reopen Products & Pricing on every keystroke.

### 4.2 Ladder B — routes that write the REGISTRATION'S number (the one the gate reads)

| # | Route | Where | Notes |
|---|---|---|---|
| B1 | **Registering a product** | `src/lib/product-registration.js:487` (`inputs.expFlips/Holds/Ground`) | the normal way; the number registered is the number the gate demands |
| B2 | **Auto-register on intake** | `src/lib/intake-auto-register.js:105` | reads the claim, registers on it |
| B3 | **Experience RE-ALLOCATION** | `src/lib/details-freeze.js:263` (`syncRegistrationExperience`) | see §6 — the only way the registration's split moves without a re-register |

And what the registration's number is *built from*: `loadFileForPricing`
(`src/routes/staff.js:2721`, mirrored at `borrower.js:991` and `tpo.js:199`) resolves
**`claimed ?? verified`** — the application's claim if it has one, otherwise the verified counts
(`:2759-2764`). Owner-directed 2026-07-14: *the loan sizes on the CLAIMED experience*, and funding
stays gated by this condition.

### 4.3 The picture in one line

```
apply / details / studio / MISMO / lead-convert / info-condition
        │
        ▼
applications.requested_exp_*        ("the claim" — decides IF the condition applies)
        │  register (B1/B2)  ──────────────► product_registrations.inputs.exp*
        │                                        ("the need" — decides HOW MANY)
        │                                              ▲
        │                                              │ re-allocation only (B3)
        │                                              │
        └──────────────────────────────────────────────┘

registeredExperienceNeed(appId, db, claim)
        = registration.inputs.exp*   when a current registration exists
        = the claim                  when none exists yet
```

---

## 5. Who asks the question — and the one copy that is not shared

`registeredExperienceNeed` has **three canonical callers**:

1. `experience.syncExperienceChecklistForApplication:282` — the condition's payload and its
   met/reopen decision;
2. `routes/staff.js:9513` — the sign-off gate;
3. `lib/track-record-todo.js:306` — the file's track-record to-do list.

That is the point of the function: *"three places now ask the question … two of them disagreeing
would show an officer a list of work that does not match what the gate actually refuses on"*
(`experience.js:266-269`).

**But there are two re-inlined copies of the same query:**

* `src/lib/underwriting/experience-advisory.js:64-73` — PILOT's advisory stamp re-reads
  `product_registrations … is_current` itself. Its own header claims the threshold is *"reused
  1:1"*; it is in fact a second implementation. It happens to agree today. It is one edit away from
  not agreeing, and it is the number a processor sees on the advice line.
* `src/lib/experience.js:356` (`pricedWith`) — the registration-staleness check reads the same
  jsonb again. This one is arguably a different question (*what was it priced with*, vs *what must
  be verified*) but it reads the identical three keys.

**Recommendation:** have `experience-advisory.js` call `registeredExperienceNeed`. It is a
four-line change and it removes the only genuine drift risk in this area.

---

## 6. The one sanctioned way to move the number without re-pricing

Owner-directed 2026-08-13: a term sheet was signed on **three fix-and-flips**; verification came
back as **two flips and one hold** — the same three deals — and the condition could not be signed
off because the application could not be edited past the term-sheet freeze.

`src/lib/experience-realloc.js` is the carve-out, and it is **a property of the frozen engines,
not a tolerance** (`:34-51`): every engine counts `flips + holds` as ONE number
(`standard-program.projectCount`, `gold-standard.renoCount`, `silver` = the Standard one), so with
`ground` held equal and `flips + holds` held equal, **every priced number is byte-identical by
construction**.

* Refuses if **ground-up** changes at all — that re-tiers the deal.
* Refuses flip/hold → **REO**, and needs no rule about REO to do it: `requested_exp_reo` is the
  residual list, is not an engine input, and is not watched by the reopen trigger, so 10 flips → 5
  flips + 5 REO is a real drop in `flips + holds` and the total test refuses it. Exactly the
  owner's line.
* Pre-CTC only; the status freeze still stands.
* When it applies, `details-freeze.syncRegistrationExperience` (`:263`) moves the **registration's**
  split to match — *without* which the application would say "2 flips + 1 hold" while the condition
  went on demanding 3 verified flips, and the sign-off the whole change exists to reach would still
  be refused (`staff.js:13830-13840`).
* **Never** for the super-admin override — that change is not price-neutral, and rewriting the
  priced basis to match would falsify the record of what the borrower was quoted.

---

## 7. Gaps and inconsistencies found while mapping

**T1 — the info-condition door writes the claim without recomputing the condition.**
Route A9 (`conditions/engine.js:555`) writes `requested_exp_*` through `WRITE_TARGETS` and never
calls `syncExperienceChecklistForApplication`. Every other claim-writing door does (A5 at
`staff.js:13861`, A6 at `studio-experience-claim.js:173`, A7 at `product-registration.js:564`,
plus 22 call sites overall). So answering an information condition with an experience count leaves
the track-record condition showing the **old** requirement until some other action recomputes it.
Measured: `grep -rn "syncExperienceChecklist" src/lib/conditions/` returns nothing.

**T2 — `experience-advisory.js` re-inlines the need query (§5).**

**T3 — the fallback is invisible on an unregistered file.**
On a file with no registration, `needFrom = 'application'` and the gate demands the **claim**.
That is correct and owner-directed (2026-08-06: *"the condition should require verifying 10 — you
should not be able to sign it off till you verify 10"*), and the refusal message does switch its
wording (`basis = reg ? 'the registered product' : 'the term sheet'`, `staff.js:9528`). But the
condition's own line on the screen does not say *"this is your own claim, because nothing is
registered yet"* — only `claimBelowNeed` (the registered case) gets an explanation. A short
`needFrom === 'application'` note would close the loop.

**T4 — no test drives the desk's own re-allocation through the gate.**
`test-experience-realloc-{pure,db}.js` cover the carve-out and
`test-experience-gate-need-db.js` covers the registration-first ordering, but nothing asserts the
full chain *re-allocate → registration split moves → gate now passes*. That chain is exactly what
the owner asked for on 2026-08-13.

**T5 — investor guideline conditions map many different requirements onto one PILOT condition.**
Three Blue Lake conditions (60 SPONSOR EXPERIENCE + TIER, 61 EXPERIENCE OWNERSHIP VERIFICATION, 62
COMPARABLE-PROJECT EXPERIENCE) and CorrFirst 2002 all clear via `pilot_template_code:
'rtl_p3_reo'` (`bluelake-rtl-spec.js:200-208`, `corrfirst-fnf-spec.js:90`). Blue Lake's *"minimum
of 2 completed transactions in the previous 36 months"* is therefore **narrative, not computed** —
it does not enter `signOffGate`. A file registered on 1 flip, with 1 verified flip, passes the
PILOT gate and does not satisfy Blue Lake's own floor. Worth deciding whether the note buyer's
minimum should become a real input to `registeredExperienceNeed`.

---

## 8. The OTHER experience gate — do not confuse the two

There is a second, completely separate experience rule, and it blocks **clear-to-close**, not the
condition sign-off:

`underwriting/experience.assessExperience` (`src/lib/underwriting/experience.js:83`) — the
**anchor-deal** rule. It classifies the NEW deal's rehab intensity (light / moderate / heavy /
ground-up, `tierOf:57`) and, for HEAVY and GROUND-UP deals only, requires **at least one
comparable prior deal**: one tier below the demand, at least half the new deal's project size
(`ANCHOR_SIZE_RATIO = 0.5`), verified, exited within 36 months. Quality over quantity — the count
is irrelevant here, only the anchor.

Its fatal findings are counted into the CTC gate by
`underwriting/file-review.fileFatalCount:97-102` and named by `fileFatalDetails:127-134`.

So: **the condition asks "how many", the underwriting rule asks "have you ever done one this
big".** They are independent, and a file can pass one and fail the other.

---

## 9. Quick reference

| Question | Answer | Where |
|---|---|---|
| Which condition? | `rtl_p3_reo`, `tool_key='track_record'` | db/005:90, db/006:32 |
| Where does the number come from? | current registration's `inputs.exp*`; the application's claim only as fallback | `experience.js:241` |
| How many must be verified? | exactly the registered count, **per bucket** | `staff.js:9513-9534` |
| What counts as verified? | `is_verified=true` AND exit inside 36 months | `experience.js:79`, `staff.js:12456` |
| Co-borrower? | both borrowers' deals are summed | `staff.js:9450` |
| What else blocks the sign-off? | pending docs, unfilled extra slots, open track-record findings | `staff.js:8923/8947/9495` |
| Way past it? | super-admin override with a typed reason (db/344), audited | `staff.js` `adminOverride.evaluate` |
| Way to lower the number? | re-register on the lower claim — or a flip↔hold re-allocation | `experience-realloc.js`, `details-freeze.js:263` |
| Why is it still 5 when the file says 3? | the registration still says 5; `claimBelowNeed` is that exact state | `experience.js:295` |
