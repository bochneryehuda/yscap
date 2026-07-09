# Fix Approval Worksheet — Sections 1–5

**What this is:** every problem found in Sections 1–5, in one short list, so you can
pick which fixes to approve. Each one has three lines: **Happens** (what goes
wrong), **Issue** (why), **Fix** (what I'd do). Nothing gets built until you tell
me which IDs to do.

**How to approve:** reply with the IDs you want (e.g. "do S1-04, S3-01, S4-01"),
or a bundle ("all Criticals + Highs", "everything in Section 4", "all of it").

---

## ⚠️ Heads-up: `main` moved since these were written

I pulled the latest `main` first (as you asked). It has a **redesign (#123)**, a
**register write-back (#124)**, a **reminder/experience system (#122)**, and a
**"fix phantom borrower conditions" change (#060)**. That last one already touched
the conditions/wording area, so I've flagged the affected items below with
**〔main changed this〕**. **Before I build any fix you approve, I re-check it
against the current code and tell you if it's already resolved** — so you never
pay for a fix that's already done.

---

## The count

| Section | 🔴 Crit | 🟠 High | 🟡 Med | ⚪ Low | Total |
|---|:-:|:-:|:-:|:-:|:-:|
| 1 — Accounts & Access | 1 | 4 | 6 | 5 | 16 |
| 2 — Borrower's File | 0 | 3 | 6 | 4 | 13 |
| 3 — Loan Officer's Desk | 1 | 3 | 6 | 2 | 12 |
| 4 — Documents & Uploads | 1 | 1 | 6 | 3 | 11 |
| 5 — Conditions Engine | 0 | 3 | 5 | 2 | 10 |
| **Total** | **3** | **14** | **29** | **16** | **62** |

**My recommended "do these first" shortlist:** S4-01, S1-04, S3-01, S1-03/S2-04,
S2-01, S1-05, S1-01, S1-02, S4-02. (The 3 Criticals + the worst leaks and
control gaps.)

---

# The 3 Criticals (recommend doing all three)

### 🔴 S1-04 — A borrower can rewrite the price of their own loan
- **Happens:** a borrower who sends a certain "admin key" can lower our margin/fees on their own loan and lock it in.
- **Issue:** that key is hard-coded in the source as `Yscg@12345`, so effectively everyone has it.
- **Fix:** delete the built-in key so the feature is off unless a real private key is set; better, never accept margin/fee changes from a borrower session at all.

### 🔴 S3-01 — A loan officer can "Clear" (complete) a loan's funding conditions
- **Happens:** a loan officer (who should only *review*) can mark underwriting/prior-to-funding conditions as done.
- **Issue:** the "Clear" button has no permission check — its twin "Waive" button does; the lock was forgotten.
- **Fix:** require the sign-off permission to Clear a condition, and hide the button from officers.

### 🔴 S4-01 — We store the card security code (CVC) forever (PCI violation)
- **Happens:** the card's 3–4 digit code is saved (encrypted) on the file and on the borrower's profile.
- **Issue:** card rules forbid storing the security code after the charge — encrypting it doesn't make it OK.
- **Fix:** never store the code — use it only in memory to place the charge, then discard; remove the stored copies.

---

# Section 1 — Accounts & Access

### 🟠 S1-01 — A fired staff member keeps getting live chat
- **Happens:** after we deactivate someone, they can still receive new chat messages on their old files for up to a week.
- **Issue:** the live-updates channel doesn't re-check "is this staff still active," and deactivating doesn't kill their existing pass.
- **Fix:** make the live channel check "still active," and bump the pass version on deactivation so all channels cut off at once.

### 🟠 S1-02 — Staff logins have no lockout
- **Happens:** staff passwords can be guessed over and over; borrowers get locked after 6 tries, staff never do.
- **Issue:** the staff login never counts failed attempts (the staff table has no place to record them).
- **Fix:** add the same "too many wrong tries → lock" rule to staff logins, ideally stricter + alert an admin.

### 🟠 S1-03 — The borrower's file screen shows them our internal margin (+ can show a co-borrower the other's private info)
- **Happens:** a borrower's file data includes our markup/fees and a raw copy of their application (DOB, address, FICO).
- **Issue:** the screen sends *everything* and tries to delete secrets from a hand-kept list that misses these.
- **Fix:** switch to a "send only what's needed" list. (Same fix as S2-04 — do them together.)

### 🟠 S1-05 — "Manage team" is secretly all-powerful
- **Happens:** anyone with "manage team" can switch on every permission for themselves and reset another admin's password to log in as them.
- **Issue:** the only guard blocks touching a *super-admin*; self-grants and peer-admin resets are wide open.
- **Fix:** block editing your own permissions; require a super-admin for the heavy powers and for resetting another admin's password.

### 🟡 S1-06 — Outsiders can find real staff emails by timing the login
- **Happens:** the staff login answers faster for an unknown email, revealing which emails are real staff accounts.
- **Issue:** it skips the "waste the same time" step the borrower login uses.
- **Fix:** make the staff login take the same time whether or not the email exists.

### 🟡 S1-07 — Registration reveals whether an email is already a customer
- **Happens:** sign-up gives three different answers depending on the email, so outsiders can learn who's already a customer.
- **Issue:** the responses aren't neutral like the forgot-password flow is.
- **Fix:** give one neutral "check your email" answer for any existing email; send the right email quietly.

### 🟡 S1-08 — You can register on someone else's email and get let in before proving it's yours
- **Happens:** a new sign-up is logged in immediately with no email confirmation, so an attacker could pre-claim a prospect's email and later inherit their file.
- **Issue:** email verification exists but nothing requires it.
- **Fix:** require the email to be confirmed before a self-made account gets a real session (or before a staff file attaches to it).

### 🟡 S1-09 — No "too many wrong tries" limit on the 2FA / email codes
- **Happens:** the 6-digit second-step codes can be guessed in bulk; the email-confirm code stays valid a whole day.
- **Issue:** the code checks never count wrong attempts.
- **Fix:** lock after a few wrong codes, like the password login does.

### 🟡 S1-10 — Any staffer on a file can reveal the full card number + code
- **Happens:** a loan officer who never places the order can pull up the full card + CVC.
- **Issue:** the reveal is scoped to the file and logged, but has no extra permission check.
- **Fix:** put full-card reveal behind its own "places appraisal orders" permission.

### 🟡 S1-11 — The login pass sits where page scripts can read it, with no content lockdown
- **Happens:** one bad script on any page of our site could steal a login pass and become that user.
- **Issue:** the pass is in browser storage scripts can read, and there's no content-security lockdown.
- **Fix:** add a content lockdown for the portal and move toward a cookie scripts can't read.

### ⚪ S1-12 — The live-updates channel puts the login pass in the web address
- **Happens:** the real pass rides in the URL, where it can land in logs/history.
- **Issue:** that channel can't send a hidden header, so it uses the URL.
- **Fix:** hand it a short, one-job ticket instead of the real pass.

### ⚪ S1-13 — Sessions never truly expire
- **Happens:** an in-use session keeps renewing forever; a stolen pass stays alive as long as it's used.
- **Issue:** there's an idle timeout but no hard maximum age.
- **Fix:** force a real re-login after a set number of days no matter what.

### ⚪ S1-14 — Small "does this email exist" leaks
- **Happens:** the "account locked" message and the forgot/resend timing still let someone tell real emails from fake.
- **Issue:** those paths behave differently for real vs unknown emails.
- **Fix:** make the locked response neutral and do the forgot/resend work in the background.

### ⚪ S1-15 — Refreshed staff pass carries a stale role; the dev signing secret is a public word
- **Happens:** a renewed pass stamps the old role (harmless today); any non-production server uses a public, forgeable secret.
- **Issue:** the refresh reuses the old role, and outside production the secret is `dev-only-change-me`.
- **Fix:** stamp the fresh role from the database; confirm every deployed server is marked production.

### ⚪ S1-16 — Admin screens are guarded one-by-one, not by one "staff only" wall
- **Happens:** every admin screen is covered today, but a new one added without the pattern could be borrower-reachable.
- **Issue:** the admin area only requires "logged in" at the door; borrowers are logged in too.
- **Fix:** add one blanket "must be staff" wall at the admin entrance.

---

# Section 2 — The Borrower's File  (no live partner-name leak today; the risks are internal data + borrower edits)

### 🟠 S2-01 — Borrower emails/alerts + the LLC screen fall back to our internal condition wording  〔main changed this〕
- **Happens:** when a condition has no borrower-friendly name, the borrower's email/alert shows the internal wording — the path a partner name would leak through.
- **Issue:** the alert code says "use the internal wording if the borrower one is blank," unlike the portal list which uses a generic phrase.
- **Fix:** never fall back to internal wording — use a generic phrase. **Note:** main's #060 now auto-fills a blank borrower label *with the internal label*, which changes this — I'll re-verify and fold it in with S5-01.

### 🟠 S2-02 — The "request a document" button emails whatever staff type, word-for-word
- **Happens:** the borrower gets an email with the raw staff-typed text (which could contain a partner name), while the portal shows a generic label.
- **Issue:** that button stores the text as the internal name and emails it straight out.
- **Fix:** give the button its own borrower-facing wording and never email the internal name.

### 🟠 S2-04 — The file screen leaks internal appraised value, the assigned underwriter, and a raw ClickUp copy
- **Happens:** the borrower's file data includes our internal appraisal figures, which underwriter is on it, and a raw mirror of our ClickUp fields.
- **Issue:** same "send everything then hide" trap as S1-03; these fields aren't on the hide-list.
- **Fix:** send only the fields the borrower screen needs (one fix closes S1-03 + S2-04).

### 🟡 S2-03 — "Request more documents" permanently copies internal hint into the borrower field
- **Happens:** asking for another document promotes the internal hint into the borrower-visible hint for good.
- **Issue:** it reads "borrower hint, or internal hint if blank" and writes the result back to the borrower field.
- **Fix:** build the note from the borrower hint only; never write internal text into the borrower field.

### 🟡 S2-05 — A borrower can silently rewrite the deal's numbers, even after approval
- **Happens:** a borrower can change ARV, rehab budget, purchase price on an approved file with no record it happened.
- **Issue:** the "fill missing fields" action doesn't check the field is empty, doesn't lock by stage, and writes no audit entry.
- **Fix:** lock these edits after early intake, only fill when empty, and record a before/after audit.

### 🟡 S2-06 — The track-record screen shows our internal loan-officer notes
- **Happens:** the borrower sees `lo_notes` (candid staff notes on their past deals) and who verified them.
- **Issue:** the screen sends every column of each record.
- **Fix:** send only the borrower-safe facts; drop the internal notes and verifier id.

### 🟡 S2-07 — A borrower can overwrite an underwriter's private note
- **Happens:** submitting a tool task with a `notes` value replaces the internal staff note on that condition.
- **Issue:** the save lets the borrower write the internal note field.
- **Fix:** don't let the borrower write the internal note; use a separate borrower field if needed.

### 🟡 S2-08 — Our margin block rides along in the borrower's pricing responses
- **Happens:** three pricing responses include our internal `adminPricing` block; one sibling screen correctly strips it.
- **Issue:** inconsistent redaction (the markup number is usually blank today, but the block shouldn't be there).
- **Fix:** strip the internal block from all pricing responses.

### 🟡 S2-09 — A borrower can mark a staff-only condition "received"
- **Happens:** two borrower actions can flip an internal condition to "received."
- **Issue:** they check the condition is on the borrower's file but not that it's borrower-facing (needs the item's hidden id).
- **Fix:** add the "borrower-facing only" check to both actions.

### ⚪ S2-10 — A co-borrower can switch the vesting entity to their own LLC
- **Happens:** on a joint file, the co-borrower can make the loan vest in their own entity.
- **Issue:** the "link entity" action allows either party, not just the primary.
- **Fix:** limit it to the primary borrower's entity.

### ⚪ S2-11 — Borrower screens reveal which staff verified/reviewed the file
- **Happens:** the LLC and track-record screens show the reviewer's name / verifier id.
- **Issue:** those fields are sent to the borrower with the rest of the row.
- **Fix:** drop the staff identity from the borrower-facing screens.

### ⚪ S2-12 — A staff upload with no condition attached becomes borrower-visible by default
- **Happens:** an internal document uploaded without tagging a condition can be downloaded by the borrower.
- **Issue:** the visibility default is "borrower," not "staff-only."
- **Fix:** default to staff-only unless someone makes it borrower-visible.

### ⚪ S2-13 — The pricing engine in the browser contains our 0.5% markup (already public)
- **Happens:** a technical borrower could read our markup from the shipped code.
- **Issue:** the frozen engines carry the constant; this already exists on the public marketing tools.
- **Fix:** a business decision — if it's secret, it needs a bigger coordinated change (don't touch the frozen engines piecemeal); if not, we document the decision.

---

# Section 3 — The Loan Officer's Desk  (the two-tier sign-off control has side doors)

### 🟠 S3-02 — A loan officer can take over another officer's file
- **Happens:** any officer who can open a file can reassign it — including to themselves.
- **Issue:** the reassign action has no manager/permission check and accepts any staff id; the audit only records the new owner.
- **Fix:** limit reassignment to managers; allow self-claim only on unassigned files; record who it was taken from.

### 🟠 S3-03 — A loan officer can sign off the LLC condition by "verifying" the entity
- **Happens:** clicking "Mark LLC verified" auto-signs-off the internal LLC condition, stamped with the officer's name.
- **Issue:** the verify button checks borrower access but not the sign-off permission.
- **Fix:** require the sign-off permission to verify (or separate verifying from the condition sign-off).

### 🟠 S3-04 — A loan officer can undo a processor's sign-off
- **Happens:** an officer can reopen a condition a processor already completed.
- **Issue:** the lock blocks *setting* a sign-off but not *undoing* one.
- **Fix:** require the sign-off permission to un-sign-off / downgrade too.

### 🟡 S3-05 — A loan officer can move the file to approved/declined/funded
- **Happens:** an officer can advance their own file's status through decision-grade steps.
- **Issue:** status changes have no role check (only *forcing* past blockers needs an admin).
- **Fix:** restrict approved/clear-to-close/funded/declined to underwriters/admins.

### 🟡 S3-06 — A loan officer can change the value inputs that drive pricing
- **Happens:** an officer can raise the as-is/ARV value and re-register at higher leverage.
- **Issue:** the locked pricing knobs are protected, but the value inputs feeding them aren't.
- **Fix:** treat as-is/ARV/appraised value as underwriter-controlled, or flag pricing for re-review when they change.

### 🟡 S3-07 — Accepting one document completes a two-document condition
- **Happens:** accepting a single file marks a condition needing two (binder+invoice) as complete.
- **Issue:** the "accept document" path skips the all-documents check the "sign off" button runs.
- **Fix:** run the same all-documents check on accept, or don't auto-complete multi-doc conditions on accept.

### 🟡 S3-08 — The same person can create and sign off a condition
- **Happens:** one staffer can be both requester and approver of the same item.
- **Issue:** nothing compares who created it to who completes it.
- **Fix:** decide the policy; at minimum block a loan officer from completing (covered by S3-01/03).

### 🟡 S3-09 — The archived-files list isn't limited per officer
- **Happens:** if the "delete files" permission is ever given to an officer, they'd see every officer's archived files company-wide.
- **Issue:** the archived list is missing the per-officer limit every other list has (safe today because only admins have that permission).
- **Fix:** apply the same per-officer limit to the archived list.

### 🟡 S3-10 — "Shared view" of another officer's files can over-share and become takeover
- **Happens:** the share toggle can include every officer (read-all), and via S3-02 read-access becomes takeover.
- **Issue:** no limit on the share list; controlled by "manage team" (self-grantable per S1-05).
- **Fix:** fix S3-02 (keep shares read-only), limit who can set shares, and log changes.

### ⚪ S3-11 — The @mention picker reveals a borrower's other files to an officer not on them
- **Happens:** composing a message shows the addresses of that borrower's other (other-officer) files.
- **Issue:** the picker's file list isn't scoped like documents are.
- **Fix:** scope the picker to the current file / this officer's files.

### ⚪ S3-12 — The public roster hands staff cell numbers + emails to the open internet
- **Happens:** anyone can scrape the "select your loan officer" list for staff cell/email.
- **Issue:** the public list includes cell numbers and isn't rate-limited.
- **Fix:** confirm intent; drop cell from the public list if not wanted, add a light rate-limit.

---

# Section 4 — Documents & Uploads  (downloads are solid; the card is the problem)

### 🟠 S4-02 — The "scan your card" photo goes to an outside company, with a public demo key as fallback
- **Happens:** the card photo (full number) is sent to OCR.space; if no key is set it uses the public "helloworld" demo key.
- **Issue:** card data leaves our systems to a non-card-compliant vendor; no production guard; no size cap.
- **Fix:** read the card in the browser, or use a card-compliant vendor; refuse the demo key in production; add a size cap.

### 🟡 S4-03 — The clean-file package to the note buyer can include staff-only documents
- **Happens:** an internal document can ride into the ZIP we send an outside reviewer.
- **Issue:** the export has no "borrower-visible only" filter; the only guard is a manual exclude flag.
- **Fix:** leave staff-only documents out by default; let staff opt one back in deliberately.

### 🟡 S4-04 — The export package also carries our internal margin
- **Happens:** the export summary copies the whole pricing quote, which includes our markup.
- **Issue:** the quote object is embedded as-is with no field filter.
- **Fix:** send only a short list of safe quote fields; confirm nothing internal is present.

### 🟡 S4-05 — If the storage disk fails, uploaded documents can be silently lost
- **Happens:** during a disk problem, uploads go to a scratch folder that gets wiped on restart — while the portal still shows them received.
- **Issue:** the fallback degrades quietly instead of alarming.
- **Fix:** make a fallback a loud alarm; record where each file was saved so a restart can tell them apart.

### 🟡 S4-06 — The chat "no SSN/card" guard doesn't check the file name
- **Happens:** a number typed into an attachment's file name (e.g. `SSN 123-45-6789.jpg`) slips into transcripts, staff screens, emails, and exports.
- **Issue:** the guard scans the message text but not the attachment name.
- **Fix:** run the same number check on attachment file names.

### 🟡 S4-07 — Uploads accept any file type, trusting the sender's claimed type
- **Happens:** a borrower can upload HTML/script/executables; the type is taken from the sender's word.
- **Issue:** no type limit and no real content check (protected today only by the one download defense).
- **Fix:** allow only the needed types, verify the real type from the file contents, add a site-wide content lockdown as a backstop.

### 🟡 S4-08 — No upload speed-limits for logged-in users; card-scan has no size cap
- **Happens:** a logged-in user can upload big files endlessly (fill disk, drive OCR bills).
- **Issue:** rate-limits cover only public pages; the card-scan omits the size cap other uploads have.
- **Fix:** add speed-limits to the logged-in upload/scan endpoints, cap the card-scan size, add a per-borrower storage limit.

### ⚪ S4-09 — Stored files are readable by other accounts on the machine
- **Happens:** uploaded files use default permissions any local account could read.
- **Issue:** nothing tightens the file permissions (low risk on Render's single-tenant box).
- **Fix:** create the storage folders/files with owner-only permissions.

### ⚪ S4-10 — Upload file names aren't length-limited on the main route and get dropped into emails
- **Happens:** an over-long/trick file name reaches staff notification emails.
- **Issue:** the main document route doesn't trim the name like other paths do.
- **Fix:** trim + length-limit the name and make sure email templates escape it.

### ⚪ S4-11 — Some upload/card errors return the raw database error to the user
- **Happens:** a few handlers send internal database error text back to the caller.
- **Issue:** raw error text can include internal detail.
- **Fix:** return a friendly generic error; keep the detail in server logs.

---

# Section 5 — Conditions & Checklist Engine  (engine plumbing is safe; risks are wording + inputs)

### 🟠 S5-01 — The Studio has no guardrail against a capital-partner name in borrower wording
- **Happens:** a staffer can type "BlueLake payoff" into a borrower field and it saves with no warning, then shows to the borrower.
- **Issue:** borrower fields are only trimmed/length-capped; the only "protection" is grey placeholder text.
- **Fix:** block a save when a borrower field contains a partner name (server + live UI warning). **More important now** because main auto-fills blank borrower labels from the internal label.

### 🟠 S5-03 — A borrower's typed numbers become the engine's "truth" and can delete a scrutiny condition
- **Happens:** answering an info question writes straight into the live loan record (ARV, rehab, loan amount); inflating ARV can auto-remove a "high-leverage extra review" condition.
- **Issue:** the engine treats self-reported numbers as fact and re-runs immediately, with no "claimed until verified" step.
- **Fix:** hold borrower answers as "claimed, pending staff acceptance"; never auto-remove a condition because a borrower-editable number changed.

### 🟠 S5-02 — The Studio never requires borrower wording on a borrower-visible condition  〔main changed this〕
- **Happens:** a borrower-visible condition could be saved with no borrower wording.
- **Issue:** nothing required a borrower label when the audience includes the borrower.
- **Fix:** **Largely handled by main (#060)** — it backfilled the blank starter conditions and now auto-fills a blank borrower label. **But** that auto-fill copies the *internal* label into the borrower field, so the real fix is to require the author to write borrower-safe wording (ties to S5-01). I'll re-verify and reframe.

### 🟡 S5-04 — The "two documents required" check can be fooled by one mislabeled file
- **Happens:** one file named "binder invoice" passes the insurance check that needs a binder *and* an invoice (same trick for fraud background+criminal).
- **Issue:** the check just looks for those words in any file's free-text label, not for two separate files.
- **Fix:** match uploads to the condition's defined slots and require a separate file in each; reject borrower uploads into staff-only conditions.

### 🟡 S5-05 — One Studio edit can re-run rules across the entire pipeline and email every affected borrower
- **Happens:** saving a "every file / rule-based" condition instantly changes conditions on all open files and pings their borrowers.
- **Issue:** the sweep runs synchronously inside the save with no "this affects N files, continue?" confirm.
- **Fix:** show the affected count + confirm; run the sweep as a background job; don't fire borrower alerts for bulk re-runs.

### 🟡 S5-06 — The per-file "add condition" button has the same no-screening gap and isn't limited to senior staff
- **Happens:** any staffer on a file can add a borrower-visible condition with unscreened free-text wording.
- **Issue:** no partner-name screen, and it's not limited to the Studio permission.
- **Fix:** apply the same partner-name screen here; decide whether it should need a permission.

### 🟡 S5-07 — A file can reach "clear to fund" without verified experience
- **Happens:** the experience requirement doesn't block funding, and it auto-satisfies when no experience is claimed.
- **Issue:** it's stored as a "task" (tasks never block funding) and auto-clears from claimed (not verified) data.
- **Fix:** confirm if experience must gate funding; if so make it a real blocker backed by verified track records.

### 🟡 S5-08 — Verifying an LLC auto-signs-off the entity condition on every file, including new ones
- **Happens:** a new file that links an already-verified LLC gets its entity condition auto-signed-off, credited to a staffer who never saw the file.
- **Issue:** verifying stamps a sign-off across all files using that entity.
- **Fix:** credit reuse to "system (entity previously verified)" not a named staffer; make good-standing freshness a real per-file check.

### ⚪ S5-09 — Phantom alerts + deleting a condition can orphan uploaded files  〔main partly changed this〕
- **Happens:** a borrower can be told about an item that later silently disappears; deleting a condition can leave its uploaded files unattached.
- **Issue:** auto-removal deletes items the borrower was already alerted about; definition-delete detaches documents.
- **Fix:** mark withdrawn instead of deleting borrower-notified items; re-home documents before delete. **Note:** main's #060 already fixed the phantom-*creation* part — I'll re-verify what remains.

### ⚪ S5-10 — The starter data still literally contains "BlueLake" (scrubbed at startup)
- **Happens:** the running database is clean, but a partner name still sits in the starter migration source.
- **Issue:** a later startup step overwrites it every boot, so the scrub is load-bearing.
- **Fix:** edit the starter data to write clean "Gold Standard" wording directly.

---

## Your move

Tell me which IDs to approve — individually, or by bundle. Some easy ways to slice it:

- **"All 3 Criticals"** → S1-04, S3-01, S4-01
- **"All Criticals + Highs"** → the 3 above + the 14 Highs
- **"Everything that leaks to the borrower / outside"** → S1-03, S2-01, S2-02, S2-04, S2-06, S2-08, S4-03, S4-04, S5-01
- **"All of Section X"**, or **"all 62"**, or any custom list.

Once you tell me, I'll re-verify each approved item against the current `main`, flag any already fixed, and only then start building.
