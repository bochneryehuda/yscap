# Remaining Findings — your review list

_This is the follow-up you asked for: "send me again the 45 outstanding remaining
items and then I'll review it and let you know." These are the audit findings from
Sections 1–5 that you **haven't decided on yet** — the approved batch is already
built (see the list at the bottom)._

**How to use this:** skim the list, reply with the IDs you want built — one at a
time, by bundle ("all the borrower-leak ones", "all of Section 4"), or "all of
them." Nothing gets built until you say so, and I re-check each one against the
current code before building (some may already be fixed)._

**Plain-language key:** 🟠 High = worth doing soon · 🟡 Medium = should do ·
⚪ Low = nice to have / low risk.

---

## Already handled by the batch I just built (no action needed)

These were on the remaining list but the approved work covered them:

- **S1-06** (staff login timing leak) — ✅ done inside the S1-02 login upgrade.
- **S2-05** (borrower silently rewriting the deal numbers) — ✅ done by the S5-03
  change-request sandbox (the lock + approval + audit trail closes this).
- **S5-01** (partner-name in borrower wording) — ✅ done (auto-scrub on every
  borrower-facing surface).
- **S5-02** (borrower-visible condition saved with no borrower wording) — ✅ largely
  handled (main #060 + the S5-01 scrub); flag me if you want the hard "author must
  type borrower wording" requirement on top.

---

## Section 1 — Accounts & Access

- ⚪ **S1-07** — Sign-up reveals whether an email is already a customer (three
  different answers). Fix: one neutral "check your email" response.
- 🟡 **S1-08** — Someone can register on a prospect's email and be logged in before
  proving it's theirs. Fix: require email confirmation before a self-made account
  gets a real session (or before a staff file attaches to it).
- 🟡 **S1-09** — No "too many wrong tries" limit on the 2FA / email codes (the
  email-confirm code stays valid a full day). Fix: lock after a few wrong codes.
- 🟡 **S1-10** — Any staffer on a file can reveal the full card number + code. Fix:
  put full-card reveal behind its own "places appraisal orders" permission.
- 🟡 **S1-11** — The login pass sits where page scripts can read it, with no content
  lockdown. Fix: add a content-security lockdown; move toward a script-proof cookie.
- ⚪ **S1-12** — The live-updates channel puts the login pass in the web address
  (can land in logs). Fix: hand it a short one-job ticket instead of the real pass.
- ⚪ **S1-13** — Sessions never truly expire (renew forever). Fix: force a real
  re-login after a set number of days.
- ⚪ **S1-14** — Small "does this email exist" leaks (locked message + forgot/resend
  timing). Fix: neutral responses + background work.
- ⚪ **S1-15** — A refreshed staff pass carries the old role; non-production servers
  use a public signing secret. Fix: stamp the fresh role from the DB; confirm every
  deployed server is marked production.
- ⚪ **S1-16** — Admin screens are guarded one-by-one, not by one "staff only" wall.
  Fix: add a single blanket "must be staff" gate at the admin entrance.

## Section 2 — The Borrower's File

- 🟡 **S2-03** — "Request more documents" permanently copies the internal hint into
  the borrower-visible hint. Fix: build the note from the borrower hint only.
- 🟡 **S2-06** — The track-record screen shows the borrower our internal
  loan-officer notes + who verified them. Fix: send only borrower-safe facts.
- 🟡 **S2-07** — A borrower can overwrite an underwriter's private note by submitting
  a tool task. Fix: don't let the borrower write the internal note field.
- 🟡 **S2-08** — Our margin block rides along in three borrower pricing responses
  (one sibling screen strips it correctly). Fix: strip it from all of them.
- 🟡 **S2-09** — A borrower can mark a staff-only condition "received." Fix: add the
  "borrower-facing only" check to both actions.
- ⚪ **S2-10** — On a joint file, a co-borrower can switch the vesting entity to
  their own LLC. Fix: limit it to the primary borrower's entity.
- ⚪ **S2-11** — Borrower screens reveal which staff verified/reviewed the file.
  Fix: drop the staff identity from borrower-facing screens.
- ⚪ **S2-12** — A staff upload with no condition attached is borrower-visible by
  default. Fix: default to staff-only unless made borrower-visible.
- ⚪ **S2-13** — The pricing engine in the browser contains our 0.5% markup (already
  public on the marketing tools). Fix: a business decision, not a quick change.

## Section 3 — The Loan Officer's Desk

- 🟡 **S3-05** — A loan officer can move a file to approved / clear-to-close /
  funded / declined. Fix: restrict decision-grade statuses to underwriters/admins.
- 🟡 **S3-06** — A loan officer can raise the as-is/ARV value inputs and re-register
  at higher leverage. Fix: treat those values as underwriter-controlled, or flag
  pricing for re-review when they change. _(Related to what the S5-03 sandbox does
  on the borrower side — worth deciding together.)_
- 🟡 **S3-07** — Accepting one document completes a two-document condition
  (binder+invoice). Fix: run the all-documents check on accept too.
- 🟡 **S3-08** — The same person can create and sign off the same condition. Fix:
  decide the separation-of-duty policy (partly covered by S3-01/03 already built).
- 🟡 **S3-09** — The archived-files list isn't limited per officer (safe today —
  only admins have the permission). Fix: apply the same per-officer limit.
- 🟡 **S3-10** — "Shared view" of another officer's files can over-share (read-all).
  Fix: keep shares read-only, limit who can set them, log changes.
- ⚪ **S3-11** — The @mention picker reveals a borrower's other files to an officer
  not on them. Fix: scope the picker to the current file / this officer's files.
- ⚪ **S3-12** — The public "select your loan officer" roster exposes staff cell
  numbers + emails to the open internet. Fix: drop cell if unwanted; add a light
  rate-limit.

## Section 4 — Documents & Uploads

- 🟡 **S4-03** — The clean-file package sent to the note buyer can include staff-only
  documents. Fix: leave staff-only docs out by default; opt-in per document.
- 🟡 **S4-04** — That same export package carries our internal margin. Fix: send only
  a short list of safe quote fields.
- 🟡 **S4-05** — If the storage disk fails, uploads go to a scratch folder wiped on
  restart while the portal still shows them received. Fix: make the fallback a loud
  alarm; record where each file was saved.
- 🟡 **S4-06** — The chat "no SSN/card number" guard doesn't check the attachment's
  file name. Fix: run the same number check on file names.
- 🟡 **S4-07** — Uploads accept any file type, trusting the sender's claimed type.
  Fix: allow only needed types, verify real type from contents, add a content
  lockdown.
- 🟡 **S4-08** — No upload speed-limits for logged-in users; card-scan has no size
  cap. Fix: add rate-limits + a size cap + a per-borrower storage limit.
- ⚪ **S4-09** — Stored files use default permissions any local account could read
  (low risk on Render). Fix: owner-only permissions.
- ⚪ **S4-10** — Upload file names aren't length-limited on the main route and land
  in emails. Fix: trim + length-limit; ensure email templates escape them.
- ⚪ **S4-11** — A few upload/card errors return the raw database error to the user.
  Fix: friendly generic error; keep detail in server logs.

_(S4-01 CVC storage and S4-02 card-scan OCR were both parked by you earlier.)_

## Section 5 — Conditions & Checklist Engine

- 🟡 **S5-04** — The "two documents required" check can be fooled by one mislabeled
  file (e.g. "binder invoice"). Fix: match uploads to the condition's slots and
  require a separate file in each.
- 🟡 **S5-05** — One Studio edit can re-run rules across the whole pipeline and email
  every affected borrower at once. Fix: show the affected count + confirm; run it in
  the background; don't fire borrower alerts for bulk re-runs.
- 🟡 **S5-06** — The per-file "add condition" button has the same no-screening gap
  and isn't limited to senior staff. Fix: apply the partner-name screen (now built
  for the scrub) here; decide whether it needs a permission.
- 🟡 **S5-07** — A file can reach "clear to fund" without verified experience (it's a
  task, and auto-satisfies when none is claimed). Fix: decide if experience must
  gate funding; if so, make it a real blocker backed by verified track records.
- 🟡 **S5-08** — Verifying an LLC auto-signs-off the entity condition on every file
  using it — including new ones — credited to a staffer who never saw the file.
  Fix: credit reuse to "system," make good-standing a real per-file check.
- ⚪ **S5-09** — A borrower can be told about an item that later silently disappears;
  deleting a condition can orphan its uploaded files. Fix: mark withdrawn instead of
  deleting borrower-notified items; re-home documents before delete. _(main #060
  fixed the phantom-creation part.)_
- ⚪ **S5-10** — The starter data still literally contains "BlueLake" (scrubbed at
  every startup, so the DB is clean, but the scrub is load-bearing). Fix: write
  clean "Gold Standard" wording into the starter data directly.

---

## The count (what's left)

| Section | 🟠 High | 🟡 Med | ⚪ Low | Left |
|---|:-:|:-:|:-:|:-:|
| 1 — Accounts & Access | 0 | 4 | 6 | 10 |
| 2 — Borrower's File | 0 | 5 | 4 | 9 |
| 3 — Loan Officer's Desk | 0 | 6 | 2 | 8 |
| 4 — Documents & Uploads | 0 | 6 | 3 | 9 |
| 5 — Conditions Engine | 0 | 5 | 2 | 7 |
| **Total** | **0** | **26** | **17** | **43** |

_(The Highs and Criticals were all in the batch you already approved and I built.
What's left is Mediums and Lows.)_

---

## My recommended next bundles

- **"Stop internal data leaking to the borrower / outside"** → S2-06, S2-07, S2-08,
  S2-11, S4-03, S4-04. (Same spirit as the margin/partner-name work you already
  approved — finishes the job.)
- **"Tighten who can do what"** (staff-side control gaps) → S3-05, S3-06, S3-07,
  S3-09, S3-10, S2-09, S2-10.
- **"Upload safety"** → S4-05, S4-06, S4-07, S4-08.
- **"Login hardening, round 2"** → S1-08, S1-09, S1-10, S1-11, S1-16.

Reply with whatever you want next and I'll re-verify + build it the same way.

---

## Already built & approved (for your reference)

S1-01, S1-02 (+S1-06), S1-03, S1-04, S1-05, S2-01, S2-02, S3-01, S3-02, S5-01,
S5-03 (+S2-05). S2-04, S4-01, S4-02 were parked/declined by you.
