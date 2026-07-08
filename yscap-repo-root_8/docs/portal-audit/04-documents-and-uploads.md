# Section 4 — Documents & Uploads

_Part of the [Portal Look-Back Audit](./00-MASTER-PLAN.md). We only write up
problems here — no code is being changed._

---

## What this section is about

Everything about **files**: uploading them, storing them on disk, and letting the
right person download them. That includes borrower IDs and bank statements, LLC
paperwork, appraisals, chat attachments, the **appraisal payment card** (with its
"scan a photo of the card" feature), and the **clean-file export** we hand to an
outside note buyer.

Two AI agents dug in — one on *storage and who can download what*, one on *what
gets uploaded and the card/OCR handling*. I verified the biggest findings against
the code myself.

---

## The headline: the "who can open it" wall is solid — the problem is the payment card

**The good news first.** The part you'd most worry about — can someone grab a
document they shouldn't — is **well built**:

- Every download checks "are you allowed to see this?" **before** sending a single
  byte. We could not find a way to grab a file by guessing its id.
- The storage code is **safe from path tricks** — a borrower can't use a sneaky
  file name to escape the storage folder or reach other files. The name on disk is
  a random code, never the borrower's file name.
- The **booby-trapped-file defense holds**: an uploaded HTML or image-with-script
  file is forced to download, never shown as a live web page, so it can't hijack a
  logged-in session.

**The real problem is the appraisal payment card.** Two of the findings below
(S4-01 and S4-02) are **credit-card-industry (PCI) compliance** issues — the kind
that can mean a failed audit and card-brand fines, not just a technical bug.
They're the top priority in this section.

**And a second theme carries over:** the **clean-file export** that goes to an
outside note buyer can carry **staff-only documents** and **our internal margin**
along with it (S4-03, S4-04) — the same "internal stuff leaking" problem from
earlier sections, except this time it leaks *outward* to a third party.

---

## The scoreboard for this section

| 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low | Total |
|:-:|:-:|:-:|:-:|:-:|
| 1 | 1 | 6 | 3 | **11** |

Start with **S4-01** and **S4-02** (the payment-card PCI issues), then **S4-03 /
S4-04** (the export to the note buyer).

---

## The findings

Format, same as always: **🐞 The Bug → 🔎 Troubleshooting → 🔧 The Fix.**

---

### 🔴 S4-01 — We store the card's security code (CVC), forever — and the card rules forbid that
**Severity: 🔴 Critical (PCI violation)** · Where: `src/routes/borrower.js:917`, `src/lib/appraisal-card.js:68`, `src/routes/staff.js:1551`

**🐞 The Bug.** When a borrower enters a card to pay for their appraisal, we save
the little **3- or 4-digit security code (CVC/CVV)** into the database and keep it
— both on that loan file and, if they tick "reuse on my next file," on their
permanent profile. The payment-card rules (PCI DSS) say the security code must
**never** be stored after the charge is set up. Encrypting it does **not** make it
allowed.

**🔎 Troubleshooting.** Following the card from entry to storage: the code bundles
the card number **and** the CVC together and encrypts the pair into the card
record; the "save for reuse" option stores the CVC again on the borrower's
profile; and the staff "reveal card" screen reads the CVC back out. Our own code
comment even says "PAN + CVV encrypted at rest" — so this is happening on purpose,
not by accident. It's a bright line in the card industry: you may keep the card
number (encrypted) to re-charge, but you may **never** keep the security code.

**🔧 The Fix.** **Stop storing the security code entirely.** Use it only in memory
to place the appraisal charge, then throw it away — never write it to any field,
blob, or reuse-copy. Remove the CVV column from the profile and stop putting the
CVC in the per-file encrypted bundle. Best of all, let a real payment processor
handle the card and store only *their* token, so we never hold card data at all.

_(Related: **S1-10** from Section 1 — any staffer on the file can reveal the full
card number and code, with no special permission. That's the "who can look"
half; this finding is the "should it even be stored" half. Fix both.)_

---

### 🟠 S4-02 — The "scan your card" photo is sent to an outside company, and can fall back to a public demo key
**Severity: 🟠 High (PCI / data leaving our control)** · Where: `src/lib/integrations/card-ocr.js:46-63`, `src/routes/borrower.js:958-971`, `src/config.js:123`

**🐞 The Bug.** The "take a photo of your card" feature sends the **actual photo**
— which shows the full card number and expiry — to an outside company (OCR.space)
to read the text. And if nobody set up an OCR key, the code quietly uses
OCR.space's **shared public "helloworld" demo key.** So a misconfigured live
server would send real customers' card images through a shared public endpoint.

**🔎 Troubleshooting.** The card-scan code builds the request with the raw card
image and posts it to OCR.space. The key line is literally "use our OCR key, or
'helloworld' if it isn't set" — and unlike our other secrets, nothing forces a
real key in production. We don't *store* the image (good), but it **leaves our
systems** to a vendor that isn't a contracted, card-compliant processor — which
pulls that vendor into our PCI responsibility. The scan endpoint also has **no
size limit**, so it can be pushed large images.

**🔧 The Fix.** Prefer reading the card **in the browser** so the image never
leaves the customer's device. If a hosted reader must be used, use a **contracted,
card-compliant** provider, **refuse to run in production without a real key**
(the way we already do for our other secrets), never allow the public demo key
live, and add a size limit to the scan endpoint.

---

### 🟡 S4-03 — The clean-file package sent to the note buyer can include staff-only documents
**Severity: 🟡 Medium** · Where: `src/lib/tpr-export.js:44-56`

**🐞 The Bug.** The clean-file ZIP we hand to an outside reviewer / note buyer
gathers documents by a few rules — accepted, current, not a chat attachment, not
manually excluded — but it **never checks whether a document is staff-only.** So
an internal document (uploaded against a staff-only condition) rides along into
the outbound package unless a person remembered to flag it out one-by-one.

**🔎 Troubleshooting.** Every borrower-facing screen filters documents to
"borrower-visible." The export is the one place that **doesn't** filter on
visibility at all — the only thing keeping an internal document out is a manual
"exclude from export" flag. There's no automatic link between "hidden from the
borrower" and "kept out of the package sent outside the company."

**🔧 The Fix.** Decide the package's audience on purpose: by default **leave
staff-only documents out** of the export (and let staff deliberately opt a
specific one back in), instead of "included unless someone flags it out."

---

### 🟡 S4-04 — The export package also carries our internal margin
**Severity: 🟡 Medium** · Where: `src/lib/tpr-export.js:92-101`

**🐞 The Bug.** The export's summary file copies the **entire saved pricing quote**
in as-is. That quote object is the same one that carries our internal
`adminPricing` block (markup/margin). So the package we send to an outside party
can contain **our profit margin.**

**🔎 Troubleshooting.** This is the exact internal-margin block we're careful to
strip from borrower screens (Section 2) — but here it's dropped straight into the
outbound manifest with no field filtering. The manifest also stamps each
document with the **staff member's name** who accepted it, which may be more
internal detail than the note buyer needs.

**🔧 The Fix.** Send only an **explicit list** of safe quote fields into the
export (the final terms — rate, loan amount, program), never the whole object.
Confirm nothing internal (margin, a capital-partner identifier) is present.

---

### 🟡 S4-05 — If the storage disk fails, uploaded documents can be silently lost
**Severity: 🟡 Medium** · Where: `src/lib/storage.js:58-75`

**🐞 The Bug.** When the real storage disk isn't writable, the code quietly starts
saving uploads to the server's temporary scratch folder so uploads never fail.
That scratch folder gets **wiped on every restart/deploy**, so any ID or bank
statement uploaded during that window is **gone** — while the portal still shows
the file as "received."

**🔎 Troubleshooting.** The fallback is well-meant (uploads don't hard-fail), but
it degrades **silently.** A file saved to the scratch folder can't be found again
once the server is pointed back at the real disk, even though its database record
still says it exists. On a shared (non-Render) machine, that scratch folder is
also readable by other accounts. Our health page reports "storage not persistent,"
but nothing forces anyone to look.

**🔧 The Fix.** Treat a fallback to the scratch folder as a **loud alarm**, not a
quiet degrade — alert on it, and consider refusing uploads (fail loudly) rather
than writing to a folder that gets wiped. Record where each document was actually
saved so a later restart can tell "saved to scratch" from "saved to disk."

---

### 🟡 S4-06 — The chat "no Social-Security/card numbers" guard doesn't check the file name
**Severity: 🟡 Medium** · Where: `src/lib/chat.js:247-276`, `src/lib/chat-attach.js:34`

**🐞 The Bug.** In chat, if a borrower **types** their SSN or card number, we block
it. But if they put that number in the **file name** of an attachment (like
`SSN 123-45-6789.jpg`), nothing checks it. That name is then stored and shown in
the chat, in staff screens, in notification emails, and in the chat export —
exactly the places the guard exists to protect.

**🔎 Troubleshooting.** The guard only scans the message text, not the attachment
name. The name is handed to storage without a check. So a sensitive number leaks
in through the file-name side door.

**🔧 The Fix.** Run the **same number-check on the attachment file name** before
saving. For a borrower, block or auto-clean it; for staff, mask it in place — the
same as the message-text rule already does.

---

### 🟡 S4-07 — Uploads accept any file type, and trust whatever type the sender claims
**Severity: 🟡 Medium** · Where: upload routes in `src/routes/borrower.js` & `staff.js`, `src/lib/chat-attach.js`

**🐞 The Bug.** A borrower can upload **anything** — an HTML page, an image with a
script inside, even a program — and the system records whatever "type" the sender
claims **without checking the actual contents.** The only thing protecting us is
the download code, which forces those risky types to download instead of opening
as a web page.

**🔎 Troubleshooting.** Every upload stores the client's claimed type with no
verification and no "only PDFs and images" limit. Today the single download
defense keeps a booby-trapped file from running on our site — but there's **no
second backstop** (no site-wide security policy). If anyone later adds a new way
to view a document, or relaxes that one defense, uploaded HTML/script becomes a
live account-takeover attack. The portal is also a place to stash/spread malware.

**🔧 The Fix.** Only accept the file types you actually need (PDF + images for
documents), check the **real type from the file's contents** (not the sender's
claim), reject script-capable image types (SVG) for documents, and add a
site-wide security policy as a backstop behind the download defense.

---

### 🟡 S4-08 — No limit on how fast or how much a logged-in user can upload (and the card-scan has no size cap)
**Severity: 🟡 Medium** · Where: `src/server.js:36-39`, `src/routes/borrower.js:962`

**🐞 The Bug.** The speed-bumps we put on public pages are **not** applied to the
logged-in upload routes. A borrower can upload big files over and over with no
limit on how fast, how many, or how much disk they fill. The card-scan endpoint
has **no size limit at all** and forwards to a paid third party.

**🔎 Troubleshooting.** Each upload briefly holds a big chunk of memory, and
there's no ceiling per borrower on document count or total storage. On this small
server with no backstop, one logged-in user could slow or crash the service
(memory/disk) and run up OCR bills by spamming the card scan.

**🔧 The Fix.** Add speed-bumps to the logged-in upload and scan endpoints, put a
size cap on the card-scan like the other uploads have, and add a reasonable
per-borrower limit on document count / total storage.

---

### ⚪ S4-09 — Stored files are readable by other accounts on the machine
**Severity: ⚪ Low** · Where: `src/lib/storage.js:44, 98`

**🐞 The Bug.** Uploaded files and folders are created with the operating system's
default permissions, which let **any other user on the same machine** read them.

**🔎 Troubleshooting.** Nothing tightens the permissions on the stored files. On
Render's single-tenant container this is contained to our own app, so real-world
exposure is low — but it's one hosting change away from letting another local
account read borrowers' IDs and statements at rest.

**🔧 The Fix.** Create the storage folders and files with **owner-only**
permissions, so stored personal data is never readable by other accounts
regardless of where it runs.

---

### ⚪ S4-10 — Upload file names aren't length-limited on the main route and get dropped into emails
**Severity: ⚪ Low** · Where: `src/routes/borrower.js:1338, 1400, 1431`

**🐞 The Bug.** The main document-upload route keeps whatever file name the sender
provides — any length, any characters — and drops it directly into staff
notification emails. (Other upload paths trim and clean the name; this one
doesn't.)

**🔎 Troubleshooting.** Download headers are cleaned elsewhere and the app screens
escape text, so this isn't an active attack today — but an over-long or trick file
name reaching email templates is a latent robustness problem.

**🔧 The Fix.** Trim and length-limit the file name on the main document route the
same way the other upload paths already do, and make sure email templates escape
it.

---

### ⚪ S4-11 — Some upload/card errors send the raw database error back to the user
**Severity: ⚪ Low** · Where: `src/routes/borrower.js:182, 943, 980` (via `src/db.js:54`)

**🐞 The Bug.** A few upload and card handlers return the raw database error text
to the caller. That text can include internal detail (and, for some errors, bits
of row values).

**🔎 Troubleshooting.** For the card save, the only database rule involved is the
one-card-per-file uniqueness (handled cleanly), so a card number isn't exposed
here today — but sending raw database error text to users is an information-leak
smell worth tightening across the board.

**🔧 The Fix.** Return a friendly generic error to the user and keep the detailed
database text in the server logs only.

---

## Watch-items (not bugs today — worth confirming)

- **The PII scrubber only knows about Social-Security numbers, not card numbers.**
  It cleans SSNs out of saved application blobs but has no card-number pattern.
  The appraisal card uses its own encrypted fields, so no card number lands in
  those blobs today — but if a draft or tool form ever captured a card number, it
  would be stored in the clear. Add a card-number pattern to be safe.
- **A pure-LLC document can't be downloaded by a scoped staffer** (the access
  check has no path for entity-only documents). This fails *closed* (safe
  direction), but confirm scoped staff aren't unexpectedly blocked from
  legitimately shared entity documents.
- **Confirm the export manifest's program/product labels never contain a
  capital-partner name** (they appear to be Gold/Standard variants only).

## What's already solid (don't re-worry about these)

- **Every download is authorized before any bytes go out** — borrower downloads
  require "borrower-visible" plus ownership; staff downloads run the per-file
  access check; no id-guessing bypass on any path (borrower, LLC, chat, staff).
- **Storage is safe from file-name tricks** — the on-disk name is a random,
  server-made code, never the borrower's file name, and path-escape attempts are
  rejected.
- **The booby-trapped-file defense holds** — risky types (HTML/SVG) are forced to
  download with extra locks, so an uploaded file can't run as a web page on our
  site (this protects staff preview too).
- **One clean upload contract**, and a stray "data: URL" prefix is stripped.
- **A per-file size cap is enforced** on every real upload endpoint (the gap is
  the card-scan, S4-08).
- **Card number and code are encrypted at rest and never logged**; audit records
  and staff alerts show only the brand + last 4 digits. (The problem is that the
  *security code* is stored at all — S4-01.)
- **The card-scan image is not stored** by us.
- **Chat attachments respect the borrower/staff wall** — a borrower can't reach an
  internal-channel attachment.
- **Exports are permission-gated**, and both the clean-file and chat exports
  correctly leave chat attachments out.

---

## Suggested order to fix (when we get to building)

1. **S4-01** — stop storing the card security code (the PCI bright line).
2. **S4-02** — get card images off the third-party OCR / kill the demo-key
   fallback.
3. **S4-03 + S4-04** — stop the note-buyer package from carrying staff-only docs
   and our internal margin.
4. **S4-05** — make a storage-disk failure a loud alarm so documents aren't
   silently lost.
5. **S4-06 + S4-07** — check attachment file names for sensitive numbers; lock
   down accepted file types.
6. **S4-08** — add upload speed-bumps and a card-scan size cap.
7. Then the Lows (S4-09 → S4-11).

---

_Next section: **Section 5 — Conditions & Checklist Engine.** The rule engine, the
Condition Studio, borrower-vs-internal wording in depth, sign-off integrity, waive,
and the internal-conditions model._
