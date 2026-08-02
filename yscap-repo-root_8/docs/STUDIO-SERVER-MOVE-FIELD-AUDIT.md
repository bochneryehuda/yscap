# Which fields break, which change, and which already are broken

**Date:** 2026-08-02
**Owner's question:** *"What will break and what will be different with the interface and what will be
different with the user experience and what fields will be different? What fields wouldn't work? I'm sure
you didn't do it correctly."*

**You were right to push.** A field-by-field pass found things the earlier analysis missed, including a
number that would change on screen, and **seven problems that are broken in the system right now** and
have nothing to do with this project.

Every line below was read out of the code. Where I say "confirmed", I re-checked it myself.

---

## 0. Read this part first — SEVEN THINGS ARE BROKEN TODAY

These are live right now. They are not caused by the server move, and fixing them does not depend on it.

| # | What is wrong today | What it means for you |
|---|---|---|
| 1 | **A saved term-sheet spreadsheet loses all 27 admin settings.** The export deliberately strips "private" fields, and every admin knob is marked private. | A workbook whose own sheet is titled **"Manual Program (admin-set basis)"** re-opens as a plain Standard scenario — **different rate, different origination, different fees, different accrual**, and the minimum-interest line flipped back. Confirmed: the export calls the "public only" save, and there are exactly 27 private fields. |
| 2 | **Re-opening that spreadsheet turns "12 months of reserve" into "$X of reserve."** The file records both boxes but not which one you typed, so on re-import it guesses — and guesses the dollar box, filled with the *financed* figure. | The deal silently changes from a months request to a dollar request. On Gold ground-up the program **discards** a dollar request entirely, so the ask becomes something else again. |
| 3 | **The leverage step you picked is not saved** in the spreadsheet or the share link. | Re-opening a de-levered scenario snaps it back to maximum leverage. |
| 4 | **A borrower's registration records no term options at all** — no accrual type, no minimum-interest choice, no deferred origination fee, no closing date, no cash-out figure — even though their own term sheet printed all of them. Staff registrations do record them. | Borrower-started files are missing data staff-started files have. |
| 5 | **Blanking an admin field to fall back to the company default does not survive re-opening a draft** (it does survive a register). The draft and the register disagree about the same box. | An admin clears a markup, reopens tomorrow, and the old number is back. |
| 6 | **Four file-owned hidden values travel inside every share link and every exported workbook** — including the payoff lender's name and the liquidity-buffer waiver flag. | Internal flags leave the building in a file you hand to a borrower. |
| 7 | **The stored "what did they pick" snapshot always records a $0 reserve** — it reads a field name that does not exist on the object. | Currently harmless (nothing reads it yet), but it is wrong and will bite whoever wires it up. |

**None of these need the server move to fix.** Items 1–3 are one change to how the workbook is saved.

---

## 1. The scale of it

The studio page has **64 input boxes**. **60** of them are wired to recalculate on *both* `input` and
`change` — which is also why **picking from a dropdown costs two full recalculations, not one.**

Today that is free. After the move, each becomes a network round trip **unless the trigger is split** —
including, as written, **one request per character typed into the admin password box.**

Fields reach the numbers three different ways, and only the first is what the plan assumed:

| Route | How many | Covered by "send the deal, get the answer"? |
|---|---|---|
| Part of the deal sent to the rules | 26 | ✅ yes |
| **Read *inside* the calculation, never part of the deal** (fees, origination) | 12 | ⚠️ not in the plan |
| **Writes a setting *inside* the rule file itself** (the three markups) | 3 | ❌ not an input at all |

---

## 2. What actually changes, ranked by what you would notice

### 🔴 1. "Program maximum leverage" shows the wrong number — and this is your own bug, back again

On 2026-07-30 you reported that the Max LTC **should not move** when you change the interest reserve.

The server and the browser mean **different things** by that number. The server's version is already
narrowed by the slider and by any admin override; the browser's is the fixed ceiling for the borrower's
tier. Wiring them together shows **65% where it shows 92.5% today.**

**The earlier analysis said this affected Silver. It affects Standard and Gold too.** Needs two new
server values, not a rename.

### 🔴 2. The liquidity figure changes on any file with a waived buffer — a real number, on screen

The 1% closing-cost buffer can be waived per file. That waiver is **owned by the loan file**, and the
server **deliberately ignores any value the browser sends** — confirmed: it is not in the list of things
a client may set, and the code says so in a comment.

A public quote endpoint has no loan file, so it cannot know about the waiver. **Every waived file would
show a higher "liquidity to show" than it does today.** The fix is architectural: staff quotes must go
through a logged-in endpoint that reads the file.

### 🔴 3. Four things quietly vanish with no error at all

Because a name differs only in capitalisation, or a field simply is not published:

- The **"this deal caps at…"** line, the PDF's **"prices up to"** row, the spreadsheet's priced row and
  the funding letter's leverage line — all become blank. No error, nothing in the log.
- The **"additional manual review required"** banner on Gold.
- The engine's **own words** for why a loan was capped — replaced by a generic sentence, on every deal.
- The **Silver tier nudge** uses the wrong thresholds — **wrong wording shown to a borrower**, not an error.

### 🔴 4. Proof-of-funds letters would be issued for deals that cannot get one

The letter refuses on four tests. **Two of them read values the server does not publish** — the
profitability shortfall and the ineligible-city flag. Without them the refusal weakens silently.

### 🔴 5. The register can save a different loan than the term sheet shows

The leverage step is the **only** computed value in the register payload. If the answer has not landed,
it becomes empty — and the file registers **at maximum leverage** while the officer is looking at a
de-levered term sheet.

### 🔴 6. The screen freezes half-drawn

One line reads a piece of the engine result **without checking it exists**. If it is missing, the
recalculation throws part-way — after the numbers, before the program cards. **Tapping a program card
does nothing**, and the staff screen then insists no program is selected.

### 🟠 7. The leverage slider silently does nothing

Dragging it needs the rate ladder **immediately**. With nothing cached it hits an early exit — no
movement, no error.

### 🟠 8. Switching deal type can price the wrong deal

Choosing Bridge **clears** the rehab budget, ARV and reserve boxes; choosing Ground-up **forces** an
18-month term. Those happen in the same instant as the calculation today. Once the answer is delayed,
the request can be built from the values as they were **before** the clearing — pricing a rehab budget on
a program that has none.

### 🟠 9. "Total project cost" changes value

The browser adds up price + rehab + financed reserve. The server's nearest field is a **different
number** whenever the reserve is not counted in the basis.

### 🟡 10. The reserve box shows the previous deal's figure while typing

That box is filled **from the answer**, so it lags. A late reply can overwrite it after you have moved on.

### 🟡 11. Every keystroke anywhere becomes a request

Typing a borrower's name, a payoff amount, a closing date — none of which the rules ever see — would each
cost a round trip, because all 60 boxes share one handler.

### 🟡 12. A street address starts leaving the browser

It is a real pricing input (the ineligible-city check). Today it never leaves the page unless someone
submits a lead. After the move it goes out on every keystroke, from a public page.

---

## 3. What is genuinely fine

**19 fields never touch the rules at all** — borrower and entity names, the co-borrower, payoff details,
cash-out amount, closing date, rental count, accrual type, deferred origination, the minimum-interest
toggles. Their **values** are safe. Only their *timing* is affected, and only because they share the
recalculation trigger.

**31 fields are real pricing inputs and survive intact** — they just answer more slowly.

**Seven output fields have no readers at all** and should simply not be rebuilt on the server.

---

## 4. Two corrections to my own earlier numbers

- I said the offer cards price Gold and Silver a second time. **There is a third**: the "program maximum"
  row runs its **own** extra Gold evaluation with the overrides stripped. A Gold sheet needs **at least
  five** engine runs per keystroke plus up to ten more for the ladder — not the three the plan implied.
- The staff screen re-reads the studio **1.4 times a second** for as long as it is open. Those reads must
  come from the cached answer and must **never** trigger a request, or the studio would generate traffic
  forever with nobody typing.

---

## 5. What this means for the decision

Nothing here says the move is impossible. It says the move is **bigger than "swap where the answer comes
from"**, and that a careless version would put wrong numbers on a term sheet without any error appearing.

The honest list of prerequisites is now: two endpoints (public and logged-in), eleven-plus call sites
rewired, six new server fields, a name-mapping layer, exports that refuse mid-flight, and a browser-level
test that compares the actual screen, PDF and spreadsheet before and after.

**And separately from all of it: fix the seven things in §0 that are broken today.**
