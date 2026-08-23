# The Pricing Engine's compensation overlay (owner-directed 2026-08-23)

The owner's governing sentences, verbatim in meaning:

> *"We are building overlays on top of Lender Price. You are not going to actually take this
> switch in Lender Price. You are going to leave Lender Price always searched as borrower-paid.
> This is just overlays on top of them. … Leave Lender Price exactly how it is."*

So this feature changes **what the board displays and what the fee list says — never what is
searched**. `search-model.js` still pins `compensationType: 'BorrowerCompPlan'` on every
request; the Pricing Engine's answer is raw pricing, and the overlay is arithmetic applied on
the way to the screen.

## The switch

Three positions, raw in the middle, exactly as the owner drew it:

    Borrower-paid   |   Raw pricing   |   Lender-paid

* **Raw pricing** is the DEFAULT and is Lender Price verbatim — every figure exactly as the
  vendor quoted it. It stays available forever.
* Switching is instant: no new Lender Price search runs. The switch is a lens.

## The plan — who prices with what

Five figures, resolved **person → company → standard** through `src/longterm/comp-plan.js`,
stored as ordinary settings (`lt_settings`, declared in `settings/encompass-settings.js`,
group **Compensation**):

| Setting | Standard | Who may change it |
|---|---|---|
| `comp.lenderPaid` — lender-paid compensation (points) | 2.0 | company: **super admin**; each person: themselves |
| `comp.borrowerPaid` — borrower-paid compensation / origination (points) | 2.0 | company: **super admin**; each person: themselves |
| `comp.ysp` — YSP on borrower-paid searches (points) | 0 | company: **super admin**; each person: themselves |
| `comp.applicationFee` ($) | 1,595 | **super admin only** — company-wide |
| `comp.commitmentFee` ($) | 500 | **super admin only** — company-wide |

The company screen and the personal screen both draw these automatically (the settings store
describes itself); bounds are enforced at both doors (points 0–5, fees $0–$10,000), and a
non-super-admin admin is refused a company comp change with a message naming the keys.

The pricer fetches the signed-in person's effective plan once
(`GET /api/lt/dscr/comp-plan`). **A plan that cannot be loaded fails to raw with a notice** —
the comp positions never price off a guess, and never off a silent zero
(`normalizePlan` refuses a plan any of whose figures is missing).

## Lender-paid

Displayed price = raw price − the lender-paid comp. With the standard 2.0:

* raw **102 → 100** (par). The investor pays us the 2; the borrower pays **no origination**.
* raw **103 → 101** — the borrower **receives a 1.000 credit**.
* raw **101 → 99** — the borrower **pays a 1.000 buydown**.
  *(The dictation said "1.4" on this row; the rule as stated — subtract the comp, measure from
  100 — gives 1.000. Flagged to the owner.)*

**Waive lender fees** (lender-paid only): the $1,595 + $500 lines do not populate, and the
$2,095 comes out **in cash** — off the credit first, onto the buydown when the credit cannot
cover it. Cash, not points: on a $100k loan the waive is worth ~2.1 points, on a $1M loan
~0.21 — the owner's own scale check.

## Borrower-paid

The board keeps the raw price (less any YSP). The comp is charged as **origination** on the
fee list (standard 2.0; each person may set their own, down or up). No waive option.

**YSP** (default 0; each person may set their own): the displayed price drops by the YSP and
nothing on the fee list says why. Owner's example: raw 100.25 with a 0.25 YSP shows **100**,
the fee list shows the 2 points origination only, total comp 2.25 — *"keeping the YSP
invisible"*.

## Invisible on both sides

In either comp position, **no compensation figure appears anywhere**: the prices arrive
already adjusted, the drill-down's *base* and *final* move together by the comp (the same
mechanic the owner described investors using — "they show the base price higher"), the LLPA
lines are untouched so the on-screen arithmetic still sums, and the vendor's own comp block
is withheld (it is one click away, under Raw pricing).

## The fee list

On every quote's drill-down, in a comp position — **What this quote charges**:

* Origination (borrower-paid only)
* Buydown / discount points (when priced under par)
* Application fee $1,595 · Commitment fee $500 (unless waived)
* Credit to the borrower (when priced over par)
* A net line: what the borrower pays or receives once everything above is netted.

## Where the code lives

* `app-v2/src/longterm/compOverlay.js` — the pure engine (CI-runnable; the owner's worked
  rows are its test spec).
* `src/longterm/comp-plan.js` — the plan resolution + bounds (pure).
* `src/longterm/routes/settings.js` — the personal keys + the super-admin gate.
* `src/longterm/routes/dscr-pricer.js` — `GET /comp-plan`.
* `app-v2/src/longterm/LtPricer.jsx` — `CompSwitch`, `ChargeList`, the shift threading.
* Tests: `scripts/test-lt-comp-overlay.mjs`, `scripts/test-lt-comp-plan.mjs`, plus the
  R72–R81 render checks and PE-108–116 source guards.

## Flagged with the owner (2026-08-23)

1. **"1.4 buydown"** — built as 1.000 per the stated rule; say the word if 1.4 meant
   something else.
2. **May a loan officer set their lender-paid comp BELOW the company default?** Built
   permissive (any value 0–5, like borrower-paid, which the owner explicitly said moves both
   ways). If lender-paid should floor at the company default, that is a one-line bound.
3. The two lender fees are **settings seeded at $1,595 / $500** (super-admin editable) rather
   than hard-coded — "always" is preserved unless the super admin changes them.
