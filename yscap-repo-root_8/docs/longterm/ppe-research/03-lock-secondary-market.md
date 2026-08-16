<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# LLCK — Lock & Secondary-Market Workflow Design Brief

## 1. Rate lock lifecycle

A **rate lock** is a commitment fixing the borrower's note rate and price for a defined **lock period** (commonly 15/30/45/60 days). The canonical lifecycle: **lock request** → **locked** (price frozen) → **lock confirmation** (a written artifact evidencing rate, price, terms, expiration) → optional **extension** or **relock** → **expiration** → **cancel/withdraw**. **Floating** means the borrower has not locked and bears market risk; **locked** transfers that risk to the lender, who must then hedge or forward-commit it.

Two policy questions drive the state machine. First, **lock timing**: locking **at registration** (application) versus **at approval/underwriting-clear**. Registration locks maximize borrower certainty but lengthen the lender's exposure and raise **fallout**; approval locks shorten exposure but expose borrowers to market moves. Second, the **lock desk** role — a secondary-marketing function that owns lock policy, approves exceptions/extensions/relocks, monitors the pipeline against hedge positions, and enforces cutoff times. Loan officers request; the **lock desk** governs.

## 2. Correspondent flow specifics

A correspondent originates and closes in its own name, then sells to investors/aggregators under two execution models:

- **Best-efforts (BE):** the correspondent commits to deliver *only if the loan closes*. Fallout risk sits with the **investor**, so BE pricing is worse. Almost always **loan-level commitments** taken off an investor rate sheet at lock.
- **Mandatory:** the correspondent *must* deliver the loan (or a committed dollar volume) or pay **pair-off**. Fallout and market risk sit with the **lender**, rewarded by the **Mandatory–Best-Efforts spread**, historically **~10–50 bps** better execution. Delivered as **loan-level mandatory** or **bulk/assignment-of-trade** commitments.

The pivotal metric is **pull-through** — the share of locked loans that actually close and fund. It sizes hedge coverage on mandatory and directly affects BE pricing (low pull-through = worse investor pricing). **Fallout** is the complement (rate-driven — borrower walks when rates drop — plus non-rate credit/withdrawal fallout). **Worst-case pricing** governs relocks: the borrower's price is the **worse of the original locked price or current market**, preventing borrowers from strategically expiring a lock to capture a rate drop. **Renegotiation** (discretionary, on material market *improvement*) differs from a contractual **float-down**: renegotiation policy typically triggers only on a defined improvement threshold (e.g., ~a quarter-point in rate), passes through a **renegotiation cost** = execution cost + hedge cost, and is a lock-desk-approved exception rather than an entitlement.

## 3. Pricing at lock

The engine must **snapshot and freeze** the full price build at the lock instant. A locked price is not one number; it is a **stack**: **base price** (investor/agency rate-sheet price for product+rate+term) **± loan-level price adjustments (LLPAs/SRP grid/investor adjusters)** for FICO, LTV, occupancy, property type, purpose, etc., **± margin** (corporate + branch), **± lock-period adjustment**, **± specific-rate/pricing exceptions**. This frozen composite is the **lock snapshot** and is the record of truth for **price protection** through the lock period.

**Extension cost** is a per-day debit (commonly **~1–2 bps/day**, tiered, e.g., 7/15/30-day increments) applied to price, often capped at a number of extensions (frequently two). **Weekend/holiday roll** to next business day is customarily free. **Relock/worst-case math** after expiration: `new_price = min(original_locked_price, current_market_price)` (in price terms; equivalently the *higher* rate), plus a **relock fee** (commonly ~0.25 pt), typically within a 30-day (sometimes 60–65-day for jumbo) window, and usually *one* relock with no further extension afterward. **Renegotiation math:** pass through `execution_cost + hedge_cost` and re-snapshot.

## 4. Secondary-market mechanics (concrete, model-sufficient)

- **Investor commitment:** the price/expiration the correspondent locks against — loan-level (BE or mandatory) or **bulk/mandatory**. Must be captured on the lock record as `commitment_id`, `commitment_type`, `investor`, `commitment_price`, `commitment_expiration`.
- **Delivery & purchase:** loan file delivered, purchased, and reconciled via a **purchase advice** detailing final price, **SRP**, escrow/fee nets, and pair-off/extension adjustments.
- **SRP (Service Release Premium):** premium for selling **servicing-released**; often a grid finalized *at delivery*, distinct from the note-rate price.
- **Buy-up / buy-down:** the investor grid lets the seller trade **note rate for price** (higher rate → premium buy-up; lower rate → paid buy-down), a lever the engine should expose at lock.
- **Hedging (model at concept level only):** BE loans are largely fallout-protected by the investor; mandatory pipeline is hedged with **TBA MBS** forwards or **mandatory take-out/forward commitments**, sized by **pull-through**-adjusted pipeline. The workflow must *feed* hedging (accurate locked position, expirations, pull-through inputs) but need not compute hedges.

## 5. The internal lock workflow to build (LLCK)

**States:** `REGISTERED/FLOATING` → `LOCK_REQUESTED` → `LOCKED` → {`EXTENSION_REQUESTED`→`EXTENDED`, `REPRICE_PENDING`, `RENEGOTIATION_REQUESTED`} → `EXPIRED` → `RELOCK_REQUESTED`→`RELOCKED`; terminal `CANCELLED/WITHDRAWN`, `PURCHASED`.

**State-machine sketch (transitions + guards):**
- `FLOATING → LOCKED` *(guard: within lock hours before cutoff; valid product/eligibility; margin applied)* — writes the **snapshot**.
- `LOCKED → EXTENDED` *(guard: not expired OR within grace; ≤ max extensions; extension fee applied; lock-desk role)*.
- `LOCKED → RENEGOTIATION_REQUESTED → LOCKED` *(guard: market improvement ≥ threshold; cost = execution+hedge; desk approval)*.
- `LOCKED → REPRICE_PENDING → LOCKED` *(guard: a snapshot-relevant field changed — see pitfalls; re-snapshot; **worst-case** applies if terms worsened)*.
- `LOCKED → EXPIRED` *(guard: `now > expiration` and no active extension)* — automatic.
- `EXPIRED → RELOCKED` *(guard: within relock window; **worst-case** price + relock fee; no subsequent extension)*.
- Any active → `CANCELLED/WITHDRAWN` *(guard: not yet purchased)*.

**Roles/authority:** LO requests locks/extensions; **lock desk** approves extensions, relocks, renegotiations, exceptions, and any manual price override; segregation of duties enforced. **Every** transition writes an immutable **audit trail** entry (actor, role, timestamp, before/after, reason, approval). **Expiration handling:** nightly/real-time sweep flags expiring/expired locks, notifies LO+desk, and blocks disbursement on expired locks. **Lock-vs-current comparison:** persist locked snapshot and expose a live delta so the desk sees mark-to-market and worst-case exposure. **Exceptions/overrides** are first-class, reason-coded, dual-approved records. **Notifications:** confirmation issued, expiration warnings (e.g., T-7/T-3/T-1), extension/relock/reprice outcomes.

**Data to snapshot at lock (lock record):** `lock_id`, `loan_id`, timestamps (`locked_at`, `expires_at`), `lock_period`, `channel`, `commitment_type` (BE/mandatory), `investor`/`commitment_id`, `product`, `note_rate`, **`base_price`**, itemized **`adjustments[]`** (code, description, bps), **`margin`** components, `lock_period_adj`, `exception_adj`, `net_price`, `SRP` (if applicable), eligibility fields that drove adjusters (FICO/LTV/occupancy/purpose/property), rate-sheet id + effective time, `snapshot_hash`, actor/role. Extensions/relocks append cost-bearing sub-records without mutating the original snapshot.

## 6. Compliance

Under **Regulation Z LO-comp**, originator compensation cannot vary with rate or loan terms — so lock/reprice mechanics must not let an LO's pay flex with the rate chosen, and pricing **exceptions** need reason codes and controls to avoid comp leakage. **Anti-steering** requires that borrowers not be pushed to higher-comp products; lock workflows should support the **safe-harbor** option set. Maintain **written lock policy** (windows, cutoffs, extension/relock/renegotiation fees, exception authority) and a complete **audit trail** — regulators and investors both demand demonstrable, consistently applied policy. Retain lock confirmations and every price change with justification.

## 7. How leading PPE/lock-desk systems model this

**Optimal Blue**, **ICE**, and **Polly** converge on the same shape: a configurable **rule engine** (margins/adjusters by investor, channel, branch, product, lock period, loan-level params), an automated **lock desk** covering locks, extensions, relocks, **reprices**, price exceptions, and float-downs, tight **LOS** read/write integration to detect data changes and reprice, and native **test/audit** capabilities. All persist a **locked snapshot**, enforce **worst-case** on relock, and log every action.

## Pitfalls to design against

- **Expired locks** disbursing at stale prices — hard block + sweep.
- **Reprice-on-change**: changing a snapshot-driving field (loan amount, LTV, FICO, product, occupancy) must trigger re-pricing under **worst-case**, not silently keep the old price.
- **Extension stacking**: cap count/cumulative days and prevent extend-after-relock.
- **Worst-case bypass**: relocks and renegotiations must consistently apply worst-case/cost pass-through; don't let expiration become a free float-down.
- **Snapshot drift**: never recompute historical price from current rate sheets — store the frozen stack and hash it.

**Sources:** [MCT — Correspondent Lending 101](https://mct-trading.com/blog/correspondent-lending/), [MCT — Mandatory Delivery](https://mct-trading.com/blog/introduction-to-mandatory-loan-sale-delivery/), [MCT — Rate Renegotiation Policies](https://mct-trading.com/blog/rate-renegotiation-policies/), [MCT — Pipeline Hedging 101 (MBA)](https://www.mba.org/docs/default-source/membership/white-paper/mct-whitepaper---mortgage-pipeline-hedging-101.pdf), [PennyMac — Commitment Options](https://corr.pennymac.com/tools/seller-guide/commitment-options), [PennyMac — Extension, Roll and Relock](https://corr.pennymac.com/tools/seller-guide/commitment-extension-roll-and-relock), [Polly — PPE / Lock Desk](https://polly.io/product-and-pricing-engine/), [Polly — Product Change / Lock Desk Automation](https://polly.io/media/polly-introduces-new-product-change-function-to-further/), [CFPB — LO Compensation (Reg Z)](https://www.consumerfinance.gov/rules-policy/final-rules/loan-originator-compensation-requirements-under-truth-lending-act-regulation-z/), [Wikipedia — Service Release Premium](https://en.wikipedia.org/wiki/Service_release_premium).