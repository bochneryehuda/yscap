# PILOT — ClickUp sync / data-safety stream: handoff of what is NOT finished

_Written 2026-07-15 (late night), after PR #282 merged. This is the companion to
`docs/HANDOFF-REMAINING-WORK.md` (the other session's stream). Everything in THIS
stream's code is **done, merged to `main`, and tested** (493 automated checks across
7 suites) — but several things still need a HUMAN action, a config value, or a
decision. Each item below says exactly what to do, in plain language, so anyone
can pick it up._

---

## 1. DEPLOY — nothing below happens until the owner triggers a Render deploy

**What:** All of today's fixes are on `main` but the live server still runs the old
code. The owner deploys via the Render dashboard (service `srv-d94sqalckfvc73ahlqh0`).

**What happens by itself after the deploy (no clicks needed):** on boot the server
applies the new migrations (`db/112`, `db/113`) and runs the self-healing passes:
re-drives stuck tasks, re-audits every linked file's identity fields, upgrades
placeholder emails, reconciles borrower/co-borrower roles, closes stale review
rows, and — NEW — detects files where **two different people were merged onto one
borrower profile** and queues them in Sync review.

**How to verify the deploy took:** open `https://<app>/api/health` — it must show
`"ok": true` and a NEW `bundle` hash (different from before the deploy).

---

## 2. REPAIR the wrong-officer merged file (the Mendelovits / lead incident) — needs ONE human click after deploy

**What happened:** a loan officer's LEAD and a different real borrower (same family
last name, shared family email) were merged into ONE borrower profile. The file
leaked to the lead's officer (notifications, review rows, profile visibility).

**What is already fixed in code:** the merge can never happen again (guards on every
path), and the detector + repair tool shipped.

**What a human still has to do, step by step:**
1. Deploy (item 1). On boot, the audit finds the affected file(s) and queues a
   review card called **“Borrower identity — one profile, two people”** (or the
   co-borrower version) in **Sync review** (`/internal/sync-reviews`). Only the
   file's assigned loan officer and admins see it.
2. Open the card and click **“Split — give this file's person their own profile.”**
   The system rebuilds the file's person on a fresh profile from ClickUp,
   re-points the file, closes the noise rows, and re-syncs. The other person (the
   lead) keeps the original profile untouched.
3. Read the resolution note: it lists any fields on the ORIGINAL profile (phone,
   date of birth) that may have been copied in from the wrong person during the
   merge. If any are listed, fix them by hand on that profile.
4. **Check the file's loan officer in PILOT** equals the officer in ClickUp
   (the owner said the officer attribution itself was wrong). A resync normally
   fixes it (ClickUp is the source of truth for the officer); if the file still
   shows the wrong officer, an admin reassigns it on the file screen.
5. If the same borrower pair shows up ANYWHERE else (documents filed under the
   wrong SharePoint folder, extra contact rows), tell the developer — the audit
   trail is `audit_log` action `borrower_split`.

**Also note:** staff creating files / invites / lead conversions will now sometimes
see a message like *“The email X already belongs to NAME — a different name.”*
That is the guard working, not a bug: same person → open their existing profile;
different person → use a different email. Two people are never merged silently
any more.

---

## 3. GOOGLE MAPS key — confirm one environment variable (address matching upgrade)

**What:** The system now resolves two differently-written addresses (“124 Grandview
Ave” vs “124 Grandview Avenue, Monsey NY”) to the same real place using Google's
geocoder, before flagging them as a mismatch or blocking a duplicate file.

**What to do:** confirm the Render environment variable **`GOOGLE_PLACES_API_KEY`**
is set (the address-autocomplete proxy already used it — if address search works
on the site, it's set). If it's missing, add it with a Google Cloud key that has
the **Geocoding API** enabled.

**If it stays unset:** nothing breaks — matching falls back to the text rules
(same house number + street + ZIP), which are good but stricter.

---

## 4. WORK THE QUEUE — the Sync review screen is the to-do list now

**What:** After the deploy, every unresolved cross-system disagreement and every
stuck file sits in **Sync review** (`/internal/sync-reviews`) with buttons for
every situation (adopt a value to both systems, type the correct value, create /
link / archive a file, retry a push, retry a SharePoint document, split merged
people). Loan officers see and settle their OWN files; admins see everything;
bulk buttons exist for mass dismiss/adopt.

**What to do:** the loan officers (and an admin weekly) should go through the open
cards until the queue is near zero. Reminders are automatic: officers get
re-notified after 3 days, admins after 7; a weekly digest email summarizes the
queue. If a card looks wrong or confusing, don't force it — dismiss sticks, and
the weekly digest will re-surface the queue.

---

## 5. INTAKE dedup queue — occasionally check the “possible duplicates”

**What:** when the public loan application arrives with an email that already
belongs to a DIFFERENT person's profile, the system now creates a separate
profile (with a placeholder email), saves the real email as an additional
contact, notifies admins, and records the pair for review.

**What to do (occasionally, admin):** when that admin notification arrives, open
the new borrower profile, confirm they really are two different people, and set
the new profile's REAL primary email (the placeholder looks like
`noemail+intake-…@clickup.local`). If they're actually the same person, keep
whichever profile is real and archive the duplicate's file appropriately.

---

## 6. Open questions for the owner (answer when convenient)

1. **Borrower self-registration with a family-shared email:** today, whoever
   proves ownership of an email (via the emailed claim link) gets the profile
   with that email. Two family members sharing one email therefore share one
   login/profile by design. If you want per-person logins for shared-email
   families, that's a product decision (e.g. require unique emails, or add
   sub-profiles) — say the word and it gets scoped.
2. **How strict should the name guard be?** Right now “M” matches “Moshe” (an
   initial), middle names are ignored, and obvious placeholders never block.
   If staff hit a legitimate case the 409 wrongly blocks (e.g. a legal name
   change, a transliteration like “Yehuda/Yehudah” — those DO conflict today),
   tell the developer; the comparator is one function
   (`nameConflict` in `src/clickup/identity.js`) with tests.

---

## Done in this stream (merged + tested — so nothing looks missing)

Wipe-proof bidirectional ClickUp sync (no clears, no deletes, journaled writes,
circuit breaker); calendar-safe dates + DOB decision engine (human-edit-wins,
backdating provenance, wipe-don't-guess); duplicate-task lifecycle (stale stamps,
copied loan numbers adjudicated); two-sided LO-owned Sync review with actions for
every stuck state incl. SharePoint, aging/escalation/digest/bulk/custom values;
role reconciliation (borrower vs co-borrower); shadow-email healing;
contact-info-is-additive; units-are-additive; same-street + Google-canonical
address matching; stale-tab watchdog; SSN sync + staff DOB/SSN editing with
scoped pushes; the notification hard scope guard; and the never-merge-two-people
guards + split repair (PR #282).
