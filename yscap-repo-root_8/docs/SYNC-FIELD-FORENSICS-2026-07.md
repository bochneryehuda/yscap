# Why Each Field Broke — And What's Still Hiding

**Plain-language forensic report.** This answers, field by field, the owner's questions: *why* was the birthday wrong, the closing date wrong, the SSN, the phone, the email, why "Unknown Unknown," and what problems are hiding that nobody has hit yet. Every section is written in plain words first, with the technical evidence in a table underneath.

Produced by ~31 investigator agents (7 field-forensics chains each double-checked, 6 latent-bug hunters, 3 review-queue analysts, 2 history-statisticians, an AI-rulebook designer + adversarial reviewer). Companion to `AUDIT-2026-07-15-SYNC-ANNUAL.md`, `SYNC-ACTION-PLAN-2026-07.md`, `SYNC-FINAL-CONCLUSIONS-2026-07.md`, `SYNC-GUARD-MATRIX.md`.

---

## The one sentence that explains almost everything

Nearly every field problem has the **same root shape**: a value gets *trusted* somewhere it shouldn't — a placeholder is treated as a real name, a mid-typed date is treated as a real date, one system's copy is treated as the truth when it was really just an echo, or two people are treated as one because they share a phone. The fixes so far each patched *one field*. The same mistake is still sitting on *other* fields that just haven't been triggered yet. That's why it keeps feeling like whack-a-mole.

---

## 1. DATE OF BIRTH — why birthdays went wrong

**Plain version:** A birthday is a *calendar day* ("March 14"), but ClickUp stored it as an *exact moment in time* ("March 14 at midnight, London time"). When that moment got read back in New York, midnight London is still the *previous evening* in New York — so "March 14" quietly became "March 13." Ten real borrowers' birthdays shifted a day. On top of that, the birthday box saved *every keystroke* while someone typed, so typing "1990" briefly saved the year "0002," then "0019," then "0026" — and one of those half-typed years got stuck. Then the tool built to *repair* the damage made its own mistake and rewrote a birthday nobody asked it to touch.

**What's fixed:** the day-shift is dead (birthdays are now stored as plain text "March 14," with a self-check that refuses to save if the round-trip would change the day). Half-typed years are blocked. Birthdays are now "humans decide" — the system won't silently change one.

**What's STILL open (real, today):**
- **The auto-adopt rule is permanent, not one-time.** If a birthday came *from* the sync originally, and someone (or the mystery second automation) fat-fingers it in ClickUp to another believable adult date, the system will *silently copy that wrong birthday into both places* on the next restart. This is the single most dangerous birthday issue left.
- **A birthday fix typed on one screen "wins," but the same fix typed on a different screen gets parked or reversed** — the screens don't all mark the edit as "a human did this."
- The old approval button can still write a *10-year-old's* birthday through without the sanity check.
- Some birthday warning cards are created in a way that means they can **never close by themselves** — they linger forever even after the problem is solved.

**Hidden siblings (same bug, other fields, not hit yet):** Closing dates have **none** of the birthday protections — no "humans decide," no shift-detector. A closing date silently overwritten by a wrong ClickUp value is merely logged, never reviewed. And the day someone adds a *co-borrower's* birthday field to ClickUp, none of the birthday guards will cover it, because every guard is hard-wired to the one main-borrower birthday field.

| Evidence | Location |
|---|---|
| Standing backdating auto-adopt (F-H3, confirmed) | `sync-autoresolve.js:81` |
| Human-edit-wins on one-sided evidence (F-M4) | `ingest.js:135-158` |
| Outbound gate omits human-provenance (F-M2) | `orchestrator.js:295` |
| Legacy approve writes DOB without sanitizeDob (F-M12) | `staff.js:5551` |
| Outbound DOB cards never auto-close (F-M20) | `orchestrator.js:283,310` |
| Shared ClickUp token can feed the auto-adopt | audit line 67 |

---

## 2. CLOSING & OTHER DATES — why the closing date went wrong

**Plain version:** Same root as birthdays — the year-0026 "walker" (half-typed years getting saved) hit Yuda Elbaum's expected closing date. **His closing date was never actually repaired** — the code was fixed so it won't happen *again*, but the bad data is still sitting there because there was no good value to restore it from. Fixing the code is not the same as fixing the data.

**What's STILL open:**
- The protection that catches bad years only watches **two specific date fields** by a hand-written list. Any new date field added later ships **unprotected** — the safety depends on a future developer reading a comment, not on the structure itself.
- **LLC formation dates and checklist due-dates still have no protection at all** — a mid-typed "0026" saves cleanly, and then the system calculates the company is ~2000 years old (feeding loan logic), or silently jams that checklist item to the top of the work queue forever.
- Reminder dates accept *any* year with no range check — a mistyped reminder never fires, or fires immediately.
- A comment in the code **lies about its own protection** — it claims a function guards the year range, but that function has no year check. Any future code trusting that comment re-inherits the whole garbage-year problem.

**Hidden siblings:** the "add time" toggle in ClickUp, timezone drift on the one date that's derived from a timestamp, and the entire old `/v1` screen still using the browser date-shift pattern that caused the original birthday bug.

| Evidence | Location |
|---|---|
| Yuda Elbaum closing date — data never restored | `CLICKUP-DATE-INCIDENT.md` open items |
| LLC/checklist dates skip normalization (F-M11) | `borrower.js:1104`, `staff.js:3327`, `llc.js:518` |
| Year guard is a hardcoded 2-field list (F-M13) | `ingest.js:1229` |
| `fromEpochMs` comment claims a guard it lacks | `transforms.js:48` vs `:56-69` |
| Reminder dates: no year window | `reminders.js:197-198` |

---

## 3. SOCIAL SECURITY NUMBERS — why SSNs got messed up

**Plain version:** Two separate stories. First, some borrowers' SSNs went *missing* because a new field was only wired into the "create a new borrower" path, not the "update an existing borrower" path — so existing people never got it filled. Second, and bigger: **full 9-digit SSNs are sitting in plaintext in ClickUp right now**, visible to every member, guest, and automation in the workspace, and every sync keeps writing them there. That's the largest live exposure in the whole system.

**What's STILL open:**
- The plaintext-SSN-in-ClickUp exposure (the recommended fix — last-4 in ClickUp, full number only in your portal — was proposed but never done).
- The SSN "mismatch" check only compares the **last 4 digits**. Two different people whose SSNs happen to end in the same 4 digits read as "matching" — a real conflict in the *first five* digits is permanently invisible.
- Dismissing one SSN warning card silently suppresses **every future, genuinely different** SSN conflict on that same person forever.
- The old approval button still writes SSN values through with weak validation.

**Hidden siblings:** the "only filled on create, never on update" bug already bit names *and* SSNs — it will bite the **next** borrower field added the same way (a future ITIN, second phone, citizenship doc). And the **appraisal card field carries a full credit card number + expiration + CVV in plaintext in ClickUp** — same exposure shape as SSN, arguably worse (this is a PCI problem). Every identity check shares the "compare only part of the value" blind spot: phones by last-4, names by first word only, addresses by house-number-plus-two-words.

| Evidence | Location |
|---|---|
| Full SSN pushed to ClickUp every time | `orchestrator.js:112`, `mapper.js:213` |
| SSN mismatch compares last-4 only | `clickup-sync.js:310,351` |
| Value-agnostic dismiss over-suppresses (F-M9) | `sync-review.js:49-55` |
| Card field carries full card+CVV plaintext | `F.EXTRA.card` |
| Create-path-only population class | `ingest.js` resolveBorrower vs healBorrowerFields |

---

## 4. PHONE NUMBERS — why phones got messed up

**Plain version:** The dangerous one: the system will **merge two different people into one** if they share a phone number and an email — which is *exactly* what spouses and families do. It doesn't check whether the names conflict before merging on a shared phone. That's the same mistake that leaked one borrower's file to the wrong loan officer (the Mendelovits case), just on a different field. Also, a wrong person's phone number can get silently absorbed as a "contact" with no warning card at all, as long as the two people happen to share the same officer.

**What's STILL open:**
- The wrong-merge-on-shared-phone hole (the planned fix "two differently-named people can never merge, ever" is **not built**).
- Silent absorption of a wrong person's phone when they share an officer.
- The Mendelovits repair itself still needs the deploy + a human "Split" click + verification that the wrong officer lost access.
- No standard phone format anywhere — main-borrower phones are stored raw, co-borrower phones get reformatted, so an exact match between the two **never matches**. Co-borrower phones are also compared by last-4 only (a 1-in-10,000 collision reads two people as the same).

**Hidden siblings:** the same "compare only part" blind spot on names and SSNs; the same "card can never close" bug on birthdays; and the same wrong-merge-on-shared-attribute risk on birthdays (twins, or family members entered with the same typo'd birthday).

| Evidence | Location |
|---|---|
| Phone corroborator merges different-named people (F-M5) | `identity.js:136` |
| Silent wrong-phone absorption (F-M18) | `clickup-sync.js:374,386` |
| Co-phone compared last-4 only | `ingest.js:70`, `clickup-sync.js:456` |
| No phone canonicalization; raw vs E.164 asymmetry | `mapper.js:293` vs `:364` |

---

## 5. EMAIL ADDRESSES — why emails got messed up, and the "@clickup.local" mystery

**Plain version:** When a ClickUp task had no email, the system invented a fake one like `noemail+<taskid>@clickup.local` so it had *something* to put in the box. That fake-email factory caused three problems: on July 7 it **overwrote real ClickUp contact emails** with the fakes; it generated Kopel's "hundreds of noise cards" (the system comparing its own fakes against real emails); and because email is used to *identify* people, family-shared emails fed wrong merges.

**What's STILL open:**
- The wrong-merge-on-shared-email hole (same as phones — spouses share email).
- The "Allow — same email for both" button **permanently links two people's logins, files, and SSN visibility with no undo** and no confirmation naming who's being linked.
- A borrower notification meant for a still-placeholder profile gets **emailed to the undeliverable `@clickup.local` fake address** — silent lost notifications.
- The fake-email upgrade step swallows *all* errors, so a temporary database glitch during the upgrade looks identical to success — and nothing retries.

**Hidden siblings — the scary one:** the **co-borrower email push is completely unguarded**. The July-7 clobber fix only sanitizes the *main* borrower's email. The moment anyone wires co-borrowers into the outbound push (the obvious next step), fake `@clickup.local` addresses and "Co-Borrower" placeholder names will flow **straight into ClickUp's second-borrower fields** — the exact July 7 disaster, one field over, sitting armed. Also: there are **three different definitions of "is this a fake email"** scattered in the code, and **four different definitions of "is this a real name"** — any new placeholder that matches one but not the others splits the behavior and re-creates the noise.

| Evidence | Location |
|---|---|
| Co-borrower email push unguarded (armed, unwired) | `mapper.js:246` vs strip at `:196-201` |
| Three divergent shadow-email detectors | `ingest.js:269`, `clickup-sync.js:249`, `mapper.js:197` |
| Notifications sent to `@clickup.local` | `notify.js:211` |
| Irreversible allow_shared_email (F-M17) | `sync-file-review.js:349` |

---

## 6. "UNKNOWN UNKNOWN" — why it kept appearing as a co-borrower

**Plain version:** Two causes, both now fixed *in code* but not yet *deployed*. First, the system read the borrower's name **only from a specific ClickUp field** and ignored the task's title — so a task literally titled "Boruch Stauber - 530 St Joes" with an empty name field produced a nameless person, and the system labeled them "Unknown Unknown." Second, the system would **create a person profile for someone with no name, no SSN, no birthday** — literally nobody — and those empty shells fed the duplicate and merge noise.

**What's fixed at HEAD (but NOT yet live):** the read now falls back to the task title (carefully — a bare surname or phone number won't become a person), and it refuses to create a profile for someone with no identifying information. **These fixes are inert until you deploy** — until then, production keeps minting "Unknown Unknown."

**What's STILL open:**
- Existing "Unknown Unknown" husks whose task never re-syncs stay broken until a human types the name.
- A name-only co-borrower who *isn't* already on the file still creates a fresh shadow profile per task.
- **The audit working branch does not contain the fix** — if a future deploy is taken from the wrong branch, the factory silently comes back.

**Hidden siblings:** four different definitions of "not a real name" scattered across the code (a husk named "TBD" or "Test" heals on some paths, is treated as real on others); the outbound task-name fallback is "New Borrower" which is in *no* placeholder list (a round-trip could mint a person named "New Borrower"); and LLCs named "TBD"/"N/A" become real company records because LLC names never got the placeholder guard that loan numbers did.

| Evidence | Location |
|---|---|
| Title fallback + no-identity floor (the fix) | `8f3e23a` (HEAD, undeployed) |
| Four divergent placeholder-name definitions | `transforms.js`, `identity.js`, `ingest.js`, `mapper.js` |
| Co-borrower push leak (armed) | `mapper.js:243-248` |
| LLC names have no placeholder floor | `ingest.js` upsertLlc |

---

## 7. LOAN NUMBERS & ADDRESSES

**Plain version:** When you duplicate a ClickUp task, it copies the loan number too — and the system treated that copied number as if it uniquely identified the file, so the copy got permanently stuck as "ambiguous" (Salamon), or the copy stole the original's identity (Gruber). Addresses caused noise because "Ave" vs "Avenue" read as different places.

**What's STILL open:**
- The loan-number ownership decision depends on a **live ClickUp read with no rate-limit handling** — during a restart storm that read fails, and files get wrongly flagged at scale.
- The uniqueness index is on the **raw** number while every matcher uses a cleaned-up version — so "YS-123" and "ys-123 " can both exist as live rows.
- The address sameness check truncates to the **first two street words** and ignores city when there's no ZIP — so it can silently hide a genuine address disagreement.
- A same-building unit correction ("Apt 4" → "Apt 5") is treated as "no change" and never reaches ClickUp.
- Google address lookups are cached **forever** with no expiry — one bad lookup poisons every future comparison for that text.

**Hidden siblings:** the **investor loan number** is the exact Salamon/Gruber bug completely untreated — copied by duplication, no guard, no adjudication, blank-never-clears. Track-record addresses ("Ave" vs "Avenue" produce different keys) silently create duplicate experience entries that **inflate the borrower's experience tier and size their loans**.

| Evidence | Location |
|---|---|
| Adjudication depends on unguarded ClickUp read | `ingest.js:1306` + F-H1 |
| Unique index on raw, matchers on cleaned | `ys_loan_number` index |
| investor_loan_number — untreated Salamon class | `mapper.js:126` |
| Address sameness truncates to 2 tokens | `clickup-sync.js:268` |
| Google cache never expires | `address_canon_cache` |

---

## 8. Hidden problems nobody has hit yet (the latent-bug hunt)

The six hunters found dozens; these are the sharpest, ranked:

1. **Zero in ClickUp wipes a real dollar amount.** The wipe-proofing guards *empty* but not *zero* — a processor typing "0 until we know" into Loan Amount or Purchase Price imports a real $0. (`mapper.js:290`)
2. **"N/A"/"TBD" in a money field becomes $0.** The money parser turns any non-numeric text into 0 — a real dollar figure, not a blank. (`transforms.js:174`)
3. **Officer reassignment silently reverts, and never removes the old officer.** A portal reassignment gets undone on the next sync, and ClickUp *accumulates* every officer ever assigned (the user field is add-only, there's no remove anywhere). (`ingest.js:1209`, `mapper.js:240`)
4. **A staffer leaving the workspace can break their files' pushes** — the failed write is currently swallowed (fixed by the reliability work, but the trigger is real). (`orchestrator.js:346`)
5. **Reminders and "due soon" flags compute the day in UTC, not New York** — every evening after 8 PM, everything reads as due "tomorrow." (`reminders.js` niceWhen, lead-CRM `todayStr`)
6. **Yiddish/Hebrew names carry invisible characters** (copied from WhatsApp/Excel) that silently break name matching. (`identity.js:31`)
7. **Two-word surnames** ("Ben David," "Ha Levi") round-trip wrong — stored as first="Rivka" last="Ben David," pushed back joined, re-split wrong. (`transforms.js:12`)
8. **A re-ingest reverts a human-corrected track-record deal type** — and the borrower's loan sizing with it. (`ingest.js:481`)

---

## 9. The manual-review truth table — which cards are nonsense

**Plain version:** You were right that a lot of the review cards were nonsense — but the good news is that **most of the worst noise generators are already dead at HEAD.** Here's the honest scorecard:

**The nonsense engine was ONE card type:** `identity_mismatch_audit` — historically **~90-95% noise**, and it re-ran 13 times a day. It generated the Kopel "hundreds of cards" (the system comparing its *own* fake emails against real ones), the "Ave vs Avenue" cards, and the Mendelovits immortal co-cell card. **All of those specific noise sources are now dead** — fake emails treated as blank, address canonicalizer, contacts made additive, merge-detector diverting to one card.

**Still generating noise today (the fixable list):**
- Birthday/date/SSN cards **don't stick when dismissed** — they respawn with a fresh email on every restart while the two systems still disagree.
- Outbound birthday cards **can never auto-close** (the borrower-id bug).
- **No email rate cap** × 13 deploys/day = the flood.
- Informational cards ("nothing was written anywhere") email you **identically** to real work-blocking cards.

**The high-signal cards (keep, these are doing their job):** dropped-edit dead-letters, stuck-file cards, copied-loan-number, wrong-person-merge (the Split card), and the birthday-restore cards (100% real by construction).

**What people actually did with cards** (the response analysis): the traps are the irreversible "Allow same email" button and "adopt" buttons that show a blank portal side — people clicked resolves that silently reversed later because dismissals didn't stick.

---

## 10. The smart-queue design — how review stays legit forever

**Plain version:** The fix isn't just "fewer cards" — it's making each card *do the thinking for you*. Every card gets: (1) a **confidence score** the system computes from clues it already has (whose copy is an echo, which side a human edited last, whether everything else about the person matches); (2) the system's **own recommendation in plain words with reasons** — "PILOT suggests: keep ClickUp's date, because someone edited it Tuesday and PILOT's copy came from the sync, not a person" — so you **confirm with one click** instead of investigating; (3) **grouping** — one borrower's 5 cards become "5 things about Chaim Stern, probably one problem, start here"; (4) **self-tuning** — any card type that gets dismissed >80% of the time automatically demotes itself to the digest; and (5) an **escape valve** — if the queue ever floods, it protects the real decisions and parks the noise with a banner ("PILOT froze the non-critical ones and kept the 12 that block real work — nothing was changed in your data"), never by hiding or auto-applying anything.

Hard rule kept throughout: birthdays, SSNs, names, and person-merges are **never** one-click-bulk-confirmable — one deliberate click per person, always. The recommendation is only an opinion; confirming it runs the *exact same* safe resolve that exists today.

Full technical design (schema, scoring signals, per-reason recommenders, tuning thresholds, escape-valve ladder, UI copy rules) is in the workflow record and folds into work orders WO-16 through WO-20.

---

## 11. The deploy-history verdict — testing your claim honestly

**Your claim:** "basically every recent deploy and merge was due to a ClickUp error."

**The honest answer: FALSE as stated overall, but TRUE for the last day** — and here's why your impression is understandable. Across the whole project, ClickUp error-fixes were only **8% of commits**; portal *features* were **71%**. But look at the timing:

| Day | ClickUp error-fixes |
|---|---|
| Jul 12 | 4% |
| Jul 13 | 0% |
| Jul 14 | 3% |
| **Jul 15** | **40%** (49% counting all ClickUp) |
| **Last 30 commits** | **50%** |

So your *last impression* — an unbroken run of ClickUp-incident deploys — is completely real; it just describes roughly **one intense day**, not the whole recent period. The birthday/date disaster on July 14-15 triggered a 40-hour firefight, and that's what's freshest in memory.

**The firefighting metric is real, though:** **88% of all commits touched a file changed in the previous 24 hours** — and **100% of ClickUp error-fixes did.** Every single sync fix revisited code less than a day old. That's the patch-on-patch pattern the whole redesign is meant to end. (Notably, the portal work shows nearly the same 95% churn — this fast-rework style is the *project's* habit, driven by 491 commits in 9 days with no automated testing, not something unique to the sync.)

**Leftover branches:** only 3 of 52 branches carry genuinely unmerged work. One is a **101-commit abandoned parallel version of the entire ClickUp sync** — the largest piece of dead work in the repo. None of the leftover branches threatens today's guards.

---

## 12. The AI rulebook — so a future AI session can't mess it up

**Plain version:** Four things have *actually happened* here: an AI session weakened a guard while "fixing" a bug, skipped a required rebuild, reused a migration number, and shipped an unverified fix that caused the next incident. Today's rules are advice ("please don't"). The rulebook turns them into **hard gates a rushed AI cannot skip** — automatic checks that *block* a change if it weakens a protection, reuses a number, or skips the double-check; a list of "protected files" that demand the full two-reviewer gate; a mandatory checklist the AI must fill in before merging; and a required reading list every new AI session must consume first so it doesn't repeat this history. The adversarial reviewer's caution: rules only matter if a machine enforces them — anything left to good intentions gets skipped under pressure, so every rule must be a CI check that fails the build, not a sentence in a document.

---

## The bottom line

The team has been fixing **symptoms one field at a time**, and the same root mistakes are still sitting on the fields that haven't been triggered yet — especially the **co-borrower push (armed July-7 clobber), the permanent birthday auto-adopt, the plaintext SSNs and card+CVV in ClickUp, and the wrong-merge-on-shared-phone/email hole.** The redesign already decided on (`SYNC-FINAL-CONCLUSIONS`) fixes these at the *structure* level — one typed field registry so every guard covers every field automatically, one identity rule that can never merge two different-named people, one place where "is this a real value" is decided — instead of one patch per field. This report is the evidence base for *why* that structural approach is the only one that ends the whack-a-mole.
