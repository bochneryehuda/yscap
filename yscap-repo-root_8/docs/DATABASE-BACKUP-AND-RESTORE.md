# Backup and restore — research, decision, and the runbook

**Owner-directed 2026-08-02:** *"I'm concerned what happens if the database restarts and we lose all
our data. We need a real backup that can be used to restore our database and system from the
backup… it should know exactly where everything belongs… and if anything is added to the database,
or any tables are added, that should automatically be added to the backup."*

This document is three things: what we found when we looked at how the system actually stores data,
what the standard practice is and which vendor to use, and the exact steps + keys to turn it on. The
restore runbook is at the end — **read that part before you need it, not during.**

---

## 1. What we found

### The database
PostgreSQL, hosted by **Render** (`basic-1gb`), 400+ migration files, one schema, everything the
business runs on: borrowers, loan files, conditions, documents metadata, credit, appraisals, e-sign
envelopes, audit log.

**The good news first:** the specific fear in the request — *"the database restarts and we lose all
our data"* — is not how managed Postgres behaves. A restart does not lose data; the data is on a
disk that survives the process. Render also runs continuous **point-in-time recovery (PITR)** on
every paid database, which can restore to any second inside its window.

**But PITR is not enough on its own, and this is the real gap:**

| Risk | Does Render's PITR cover it? |
|---|---|
| The service restarts / crashes | Yes — nothing is lost |
| Someone deletes rows by mistake, noticed today | Yes |
| Someone deletes rows, noticed in 3 weeks | **No** — outside the window |
| The database instance is deleted | Partly, and only briefly |
| The Render **account** is lost (billing, dispute, compromised login) | **No** |
| Render has a serious regional incident | **No** |
| We want to leave Render | **No** — it does not export anywhere we control |
| Ransomware/insider deletes the backups too | **No** |

The recovery window is **3 days on a Hobby workspace, 7 days on Pro** — and it is controlled by the
*workspace billing plan*, not by the database size. Everything Render holds lives inside the account
we are trying to protect against losing. That is the definition of a backup that is not a backup.

### It is not only the database
Three things have to come back together, or a "successful restore" still leaves a broken system:

1. **The database** — every table.
2. **The documents** — appraisals, bank statements, insurance binders, signed term sheets. Since the
   2026-07-26 cutover these live in Cloudflare R2, and the database only stores a *reference* to
   each one. Restore the database alone and you get every loan file back with every document a dead
   link.
3. **The secrets** — and this one is easy to miss. **SSNs are encrypted in the database with
   `SSN_ENCRYPTION_KEY`.** Restore the database without that exact key and every Social Security
   number in the system is permanently unreadable — the rows are there, and the contents are
   garbage. `JWT_SECRET` matters less (everyone just has to sign in again) but belongs in the same
   envelope.

All three are covered below.

---

## 2. What the standard is

The rule the whole industry works to is **3-2-1**, extended in recent years to **3-2-1-1-0**:

- **3** copies of the data
- **2** different kinds of storage
- **1** copy **off-site** — in a different provider, not just a different folder
- **1** copy **immutable** (WORM — write once, read many): once written it cannot be changed or
  deleted by anyone, including us, until its retention expires. This is what defeats ransomware and
  a malicious or mistaken insider, and it is the specific control that regulators (SEC 17a-4,
  FINRA 4511) point at for financial records.
- **0** errors on a verified restore — *the backup is tested by actually restoring it.*

That last zero is the one everyone skips, and it is the one that decides whether any of this was
real. A backup nobody has ever restored is a hypothesis. Every well-known backup disaster is the
same story: the job was green for months and the file turned out to be unusable on the day it
mattered.

For PostgreSQL specifically the standard toolset is:
- **`pg_dump` (custom format)** for a portable, restorable logical copy — restores into any
  Postgres, any host, any provider. This is the one that lets us leave Render, or rebuild from
  nothing.
- **Continuous WAL / PITR** for second-by-second granularity — which Render already gives us.

They solve different problems and the correct answer is **both**, which is what we now have.

### Why `pg_dump` is the answer to *"new tables must be backed up automatically"*
`pg_dump` does not take a list of tables. It asks the database what exists and dumps **all of it** —
every table, view, index, sequence, constraint, trigger and function, in the right order.
There is no table list anywhere in this system to keep up to date. Add a table next month and it is
in that night's backup, counted and verified, with nothing to configure. That is not a feature we
built; it is why this tool was chosen.

---

## 3. The decision — which vendor

The requirement is a bucket at a company that is **not Render**, in an account that is **not the one
holding the live documents**, that supports **Object Lock** (WORM).

| Option | Immutable (Object Lock) | Cost at our size | Notes |
|---|---|---|---|
| **AWS S3** | Yes — Governance *and* **Compliance** mode | ~$2–5/month | The auditable standard. Compliance mode cannot be overridden by anyone, including the account root. Cross-region replication, Glacier tiering. Costs ~$0.09/GB to pull data back — a full 50 GB restore is about $5, once. |
| Backblaze B2 | Yes (Object Lock) | ~$1/month | Cheapest, generous free egress. Smaller company than AWS. |
| Cloudflare R2 | Yes (bucket locks + versioning) | ~$1/month | Zero egress fees. **But we already keep the live documents here** — using it for the vault too puts both copies behind one vendor login. |
| Another Render database | No | — | Same account. Not a backup. |
| A Google Drive / Dropbox folder | No | — | No WORM, no integrity checking, no automation story. Not appropriate for borrower PII. |

### DECIDED (owner-directed 2026-08-02): **Cloudflare R2 — a dedicated backup bucket, with its own scoped API token.**

The owner chose R2 to avoid taking on another vendor. That is a reasonable call and the reasoning is
worth recording, because the trade-off is real and someone will re-open this question later.

**What it still buys us — the thing that actually mattered.** The danger this whole system exists to
answer is *losing the Render account* (billing, a compromised login, a deletion noticed three weeks
later). Cloudflare is a different company with a different login, so a backup sitting in R2 survives
that completely. That is the bulk of the value.

**What we consciously gave up.** The live documents already live in R2 (§1), so the loan documents
and the backups now sit behind **one vendor login**. Losing the Cloudflare *account* would take both.
AWS in a separate account would have put them behind two unrelated logins.

**The two mitigations below are therefore NOT optional — they are what makes this decision safe:**

1. **A separate bucket**, used only for backups. Never the documents bucket.
2. **A separate API token, scoped to that bucket alone.** This is the one that matters: the realistic
   threat is a leaked or over-broad *credential*, not Cloudflare itself failing. A documents key that
   cannot address the backup bucket cannot erase the backups. Do not reuse the `S3_*` documents
   credential here, ever.

That leaves only "the entire Cloudflare account is lost" uncovered, which is the rarer case — and the
upgrade path for it is already built (below).

### The one mechanical difference: R2 locks the BUCKET, not each object

R2 does **not** implement the S3 per-object Object Lock API (`x-amz-object-lock-*`). It has
[**bucket locks**](https://developers.cloudflare.com/r2/buckets/bucket-locks/) instead — retention
rules set once on the bucket, in Cloudflare. Same guarantee, configured somewhere else. So:

- Leave **`BACKUP_S3_OBJECT_LOCK_MODE` blank** — with no mode set, `vault.js` sends no lock headers
  at all, which is what R2 expects. (Do not set it to `COMPLIANCE` "just in case"; that sends headers
  R2 does not accept.)
- Set a **bucket lock rule of 35 days** on the backup bucket in Cloudflare.
- Keep those 35 days equal to `BACKUP_KEEP_DAILY_DAYS` (also 35). Then the nightly prune only ever
  deletes objects whose lock has already expired, and the two never fight.
- If they *do* fight, nothing breaks: `pruneVault` in `scripts/backup-run.js` records a refused
  delete as a reported failure and the backup still succeeds. A lock is never able to fail a run.

`vault.probe()` reads the bucket's lock configuration where the store exposes one; on R2 it reports
`unknown` rather than an error, because R2 answers that question through its own API and not S3's.
**"unknown" means "check it in the Cloudflare dashboard", not "unprotected".**

### If this is ever revisited

**AWS S3 in a brand-new account, Object Lock in Compliance mode**, remains the stronger answer, for
reasons that have not changed: compliance-mode lock cannot be overridden by anyone including the
account root, it is a different company *and* a different login from everything else we run, and it
is what an auditor or a note buyer's diligence questionnaire expects to hear. Backblaze B2 is the
same idea for ~$1/month. Both speak the same protocol, so switching is a change of five environment
variables and nothing else.

**The upgrade path needs no rework.** The system already writes every backup to two vaults at once
(`BACKUP_S3_SECONDARY_*`). Adding an AWS or B2 bucket later as the *second* vault restores the full
3-2-1 — Render's PITR, Cloudflare, and a third company — without touching a line of code. That is the
recommended next step whenever the appetite for a second vendor returns.

---

## 4. What to set up, and exactly which keys to hand over

Everything below is done once, in the existing Cloudflare account. Nothing here needs a developer.

### Step 1 — Create the vault (Cloudflare R2)
1. In the Cloudflare dashboard, create a **new R2 bucket** used only for backups, e.g.
   `yscap-backup-vault`. **This must not be the bucket holding the loan documents.**
2. Add a **bucket lock rule** on it with a retention of **35 days**, so a stored backup cannot be
   deleted or overwritten inside that window. (Keep this equal to `BACKUP_KEEP_DAILY_DAYS`.)
3. Leave the bucket private — an R2 bucket has no public access unless a public URL is attached, so
   simply do not attach one.
4. Create an **R2 API token scoped to this bucket only**, with Object Read & Write. Do **not** reuse
   the token the app uses for the documents bucket: keeping them separate is what stops a leaked
   documents credential from reaching the backups. Note the Access Key ID and Secret — Cloudflare
   shows the secret once.
5. Note the account's S3 endpoint, which looks like
   `https://<account-id>.r2.cloudflarestorage.com`. The region is the literal string `auto`.

*(AWS S3 instead — the stronger option if this is ever revisited, and the right shape for a second
vault: create a **new AWS account**, MFA on root, root password in the password manager. Create a
bucket in a region away from the app and **tick "Object Lock" while creating it — it cannot be turned
on afterwards**; set default retention to **Compliance, 35 days**; "Block all public access" on.
Create an IAM user limited to that one bucket with exactly `s3:PutObject`, `s3:GetObject`,
`s3:ListBucket`, `s3:DeleteObject`, `s3:AbortMultipartUpload`,
`s3:GetBucketObjectLockConfiguration` — `DeleteObject` expires old backups and Object Lock is what
makes that safe — then generate an access key. Set `BACKUP_S3_OBJECT_LOCK_MODE=COMPLIANCE` for AWS.
Backblaze B2 is the same recipe; its endpoint looks like `https://s3.us-west-004.backblazeb2.com`.)*

### Step 2 — Generate the encryption key
On any machine, run:

```
openssl rand -base64 32
```

That single line is the key that encrypts every backup **before it leaves our server**. The storage
vendor never sees anything but ciphertext.

> **Store it in the company password manager AND written down somewhere offline (a safe, a sealed
> envelope).** If it is lost, every backup ever taken is permanently unreadable — by an attacker and
> by us. It is not stored anywhere in the system, in this repository, or with the vendor, on purpose.

### Step 3 — The values to give me / put in the Render dashboard

These go on the **`ys-capital-backup`** and **`ys-capital-backup-verify`** cron services (Render →
the service → Environment). Nothing goes in the code; nothing is ever committed.

**Required — the backup will not run without these:**

| Key | What it is | Where it comes from |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY` | The encryption key | Step 2 (`openssl rand -base64 32`) |
| `BACKUP_S3_BUCKET` | The vault bucket name | Step 1 (e.g. `yscap-backup-vault`) |
| `BACKUP_S3_ENDPOINT` | The vault's address | R2: `https://<account-id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_ACCESS_KEY_ID` | The **backup-only** token's key id | Step 1.4 — not the documents token |
| `BACKUP_S3_SECRET_ACCESS_KEY` | The **backup-only** token's secret | Step 1.4 — not the documents token |
| `BACKUP_S3_REGION` | The vault's region | R2: the literal string `auto` |
| `BACKUP_ALERT_EMAIL` | Who is told when a backup fails | Your choice |

**Already in use elsewhere — copy the same values across** (so the job can read the loan documents
and send mail):
`DATABASE_URL` (wired automatically), `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_ENDPOINT`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `RESEND_API_KEY`, `NOTIFY_FROM`,
`JWT_SECRET`, `SSN_ENCRYPTION_KEY`.

**Strongly recommended:**

| Key | Value | Why |
|---|---|---|
| `BACKUP_S3_OBJECT_LOCK_MODE` | **blank on R2** (`COMPLIANCE` on AWS/B2) | R2 has no per-object lock — its 35-day *bucket lock* rule from Step 1.2 does this job. Setting a mode on R2 sends headers it does not accept. |
| `BACKUP_S3_OBJECT_LOCK_DAYS` | ignored while the mode is blank | Kept for an AWS/B2 vault |
| `BACKUP_VERIFY_DATABASE_URL` | a second, small, throwaway Render Postgres named e.g. `yscap-verify` (the name must contain `verify`, `scratch` or `drill`) | Lets the weekly test do a **real restore**. Without it the test proves the file is intact but not that it loads. |

**Optional second vault** (a different vendor again):
`BACKUP_S3_SECONDARY_BUCKET`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION`.

### Step 4 — Two more things that are not code

1. **Put `SSN_ENCRYPTION_KEY` and `JWT_SECRET` in the password manager**, alongside
   `BACKUP_ENCRYPTION_KEY`. Render generated them and only Render holds them. If the Render account
   is ever lost, a perfect database restore still leaves every SSN unreadable without that first
   value. This is free to fix and takes two minutes.
2. **Check the Render workspace plan.** PITR is 3 days on Hobby and 7 on Pro. It is the first thing
   you would reach for in a small mistake, and 7 days is meaningfully better than 3.

### Step 5 — Confirm it works

```
npm run backup:preflight     # checks every setting, writes nothing
npm run backup               # take a real backup now
npm run backup:list          # see what is in the vault
npm run backup:verify        # download it, restore it, prove it matches
```

`preflight` names each missing or wrong setting in plain language. Run it first.

---

## 5. What was built

### The nightly job — `scripts/backup-run.js` (3:10am New York)
1. **Preflight.** Every setting, the vault's reachability, and — importantly — that `pg_dump` is at
   least the same major version as the database. A mismatch is refused up front instead of producing
   a broken archive.
2. **Inventory.** Counts every table and every row *before* dumping, from the exact same database
   snapshot `pg_dump` will read. This is the **receipt**: it is what makes it possible later to
   prove a restore came back whole. It also notices a table that has *vanished* since last night, or
   one that lost most of its rows — and says so in the morning email.
3. **Dump.** `pg_dump --format=custom` of the whole database, in one consistent snapshot, taking no
   locks — the portal keeps working normally throughout.
4. **Encrypt.** AES-256-GCM with a fresh key derived per backup (HKDF-SHA256, random salt), on our
   machine, before anything is uploaded. A flipped bit, a truncated download, an edited header or
   the wrong key all fail loudly — never as partial data that looks restorable.
5. **Upload** to every configured vault, in parts for large dumps, with the upload aborted rather
   than left half-written if anything fails. Then **read back the size and confirm it** before
   anything is called a success.
6. **Manifest.** A small plaintext file beside each backup: when, how big, checksums, which key
   opens it, how many tables and rows. Deliberately readable *without* the encryption key, so during
   an incident you can see what you have before anyone goes hunting for keys. It contains no
   borrower data and no table names — the detailed inventory sits beside it, encrypted.
7. **Documents.** New and changed loan documents are copied into the same vault, encrypted the same
   way. Incremental: the first run copies everything, later runs copy only that day's uploads.
8. **Expire old backups** on a grandfather-father-son schedule (below), *after* the new one is
   safely stored — never before.
9. **Record and alert.** Every run, success or failure, is written to `backup_runs`, and a failure
   emails a person in plain language. `/api/health` reports whether we are protected right now.

### The weekly drill — `scripts/backup-verify.js` (Sundays, 4:30am New York)
Downloads a real backup, decrypts it, **restores it into a scratch database**, then counts what came
back and compares it table by table and row by row against the inventory taken when the dump was
made. Sequences, views, indexes, triggers and constraints are checked too. It emails either way —
this is the one "all good" message worth reading, because it is the only one that proves a restore
actually works.

The scratch database is wiped on every run, so two guards stand in front of it: it refuses a target
that is the live database, and it refuses one whose name does not say it is disposable (it must contain `verify`, `scratch` or `drill` — deliberately NOT `restore` or `test`, because during an incident `yscap_restore` is the freshly recovered data).

### How long backups are kept
| Age | What is kept |
|---|---|
| 0–35 days | **Every** nightly backup |
| to 6 months | One per week |
| to 3 years | One per month |
| to 10 years | One per year |

Three rules override the schedule: the newest backup is **never** deleted; if a prune would leave
fewer than 7 backups it deletes **nothing** (a half-read listing must never read as "nearly empty,
prune it"); and nothing inside its Object Lock window is even attempted.

---

## 6. RESTORE RUNBOOK

> Read this now, not during an incident. Every command is safe to try today.

### First: which tool?
- **A small mistake, noticed within the recovery window** (someone deleted the wrong rows this
  morning) → **use Render's own point-in-time recovery.** Render dashboard → the database → Recovery.
  It is faster and more precise than anything here.
- **Anything else** — data older than the window, the database is gone, Render is gone, or you need
  the data somewhere else — → the steps below.

### See what you have
```
npm run backup:list
```
Needs only the vault credentials — not the encryption key. Prints every backup with its date, table
count, row count, size, and whether it has been test-restored.

### Restore
```
# 1. Create a NEW, EMPTY database (Render, or anywhere that runs Postgres).
# 2. Restore the newest backup into it:
node scripts/backup-restore.js --latest --target "postgres://user:pass@host:5432/newdb"

# or a specific one:
node scripts/backup-restore.js --id 4f2a91bd --target "postgres://…"

# ...and put the documents back too:
node scripts/backup-restore.js --id 4f2a91bd --target "postgres://…" --documents
```
The tool checks the backup against its manifest **before** writing anything. If the checksum does
not match, it stops and tells you to try another backup.

Restoring on top of the **live** database requires typing `--overwrite-the-live-database` — the
default is a new database on purpose, so you can look before you switch.

### Just give me the file
```
node scripts/backup-restore.js --latest --to-file /tmp/yscap.pgc
pg_restore --no-owner --no-privileges -d "postgres://…" /tmp/yscap.pgc
```

### Full disaster — rebuilding the system from nothing
1. Create a Postgres database anywhere.
2. `node scripts/backup-restore.js --latest --target "<new db>" --documents`
3. Deploy the app from this repository, pointing `DATABASE_URL` at the new database.
4. **Set `SSN_ENCRYPTION_KEY` to the value it had when the backup was taken** (password manager). A
   different value leaves every SSN unreadable.
5. Set the remaining environment values (`JWT_SECRET`, storage, email, integrations) from
   `.env.example`.
6. Sign in and check a loan file: the borrower, its conditions, and one document that opens.

**What you need to have in hand:** the vault credentials, `BACKUP_ENCRYPTION_KEY`, and
`SSN_ENCRYPTION_KEY`. Everything else is recoverable or re-issuable. That is why those three live in
the password manager and not only in a dashboard.

---

## 7. What this does *not* cover — stated plainly

- **Third-party systems keep their own data.** ClickUp cards, SharePoint, DocuSign envelopes,
  Encompass loans and Sitewire draws live at those vendors. This backs up PILOT's own copy and its
  sync state, not their systems. SharePoint does hold a mirror of the documents, but it is a mirror,
  not a restore source.
- **Backups are only as fresh as the last run.** A nightly backup means up to 24 hours could be lost
  in a total-loss scenario — which is exactly why Render's PITR stays switched on as the first line
  of defence. If a smaller window is wanted, the job can run more than once a day; say the word.
- **A restore is not instant.** Expect to spend an hour or two on a full rebuild, most of it waiting.
- **The encryption key is a single point of failure by design.** That is the trade for the vendor
  never being able to read our borrowers' data. Store it in two places.
- **On R2, immutability lives on the bucket, not in these settings.** `BACKUP_S3_OBJECT_LOCK_MODE`
  stays blank and the protection is the bucket lock rule in Cloudflare — so if that rule is missing,
  the backups are deletable and nothing in this app will say so (`probe()` reports `unknown`, which
  is not the same as "protected"). Check it in the dashboard.
- **The backup token must not be the documents token.** Sharing one credential across both buckets
  quietly undoes the main reason the R2 decision is safe.
- **On AWS/B2, Object Lock cannot be turned on after a bucket is created.** If the bucket was made
  without it, make a new one.

---

## 8. Files

| File | What it is |
|---|---|
| `scripts/backup-run.js` | The nightly job |
| `scripts/backup-restore.js` | List / inspect / restore |
| `scripts/backup-verify.js` | The weekly restore drill |
| `src/lib/backup/cipher.js` | The encrypted container format |
| `src/lib/backup/vault.js` | The S3-compatible vault client |
| `src/lib/backup/inventory.js` | The receipt, and the restore comparison |
| `src/lib/backup/retention.js` | Which backups may be deleted |
| `src/lib/backup/manifest.js` | Object naming and the manifest |
| `src/lib/backup/documents.js` | The document copy |
| `src/lib/backup/targets.js` | The guards on a restore target |
| `src/lib/backup/report.js` | The ledger and the alarm |
| `db/407_backup_runs.sql` | The ledger tables |
| `Dockerfile.backup` | The cron container (pins the Postgres client version) |
| `scripts/test-backup-*.js` | Tests, in `npm test` |
