# ClickUp date-of-birth / date-field incident — root cause, restore, guardrails

**Date:** 2026-07-15 · **Severity:** critical (silent PII-adjacent data damage in ClickUp, the system of record)
**Status:** root causes fixed in code; restore tooling shipped (`scripts/clickup-date-restore.js`); guardrails live.

## What the owner saw

Dates of birth (and closing dates) in ClickUp changed by the portal — always off by
one day — without anyone asking for it. Separately, a DOB added after an
application was submitted never reached ClickUp.

## Root causes (three distinct legs, one class)

The class: **a pure calendar date ("date-only") represented as an instant-in-time
(JS `Date` / epoch ms) anywhere in the pipeline.** Every leg below is an instance.

### Leg 1 — outbound write convention (the dominant, user-visible one)

ClickUp stores every date as epoch ms and **renders it in each viewer's timezone**.
Its own UI pins a no-time date to **4:00 AM in the setter's timezone**
(developer.clickup.com/docs/general-time). Verified live in this workspace: every
human-entered date sits at 08:00Z (EDT) / 09:00Z (EST) — e.g. a native DOB entry
of 1967-11-12 is stored as `-67446000000` = 4 AM EST.

The portal pushed date-only values at **UTC midnight**. 00:00Z is 7–8 PM the
*previous evening* in New York — so **every date the portal ever pushed displayed
one day early to the whole team**, even when the epoch was the "technically
correct" UTC day. This also means an epoch at exactly 00:00Z is a reliable
fingerprint of a portal write (a human cannot produce it through ClickUp's UI).

**Fix:** `transforms.dateOnlyToClickUpEpoch()` writes 4 AM `America/New_York`
(`CLICKUP_DATE_TZ` to override) — byte-identical to what ClickUp itself stores
for this team; `mapper.writeValue('date')` routes through it; a built-in
round-trip assertion refuses to emit any epoch our own pull would read as a
different day.

### Leg 2 — the pg `date` → JS `Date` parse (fixed 2026-07-14, commit 53578e0)

node-postgres parsed `date` columns (OID 1082) into JS `Date`s at server-local
midnight; `res.json`/JSONB round-trips then serialized via `toISOString()`,
shifting the day on any non-UTC host, and the old outbound push read
`Date.getTime()` off that object. Fixed at one chokepoint:
`types.setTypeParser(1082, v => v)` — a date column is a `'YYYY-MM-DD'` string
everywhere. The browser leg (rendering date-only strings via `new Date()` →
`toLocaleDateString()`, which shows the previous day in EST) was fixed the same
day via `app-v2/src/lib/dates.js` (`parseDay`/`fmtDay`/`dayInputValue`).

### Leg 3 — mid-typing saves (the year-0026 artifacts)

Pre-fix closing-date inputs saved on **every `onChange`** — a native date input
fires change for each intermediate value while typing a year (0002→0020→0202→2026),
so literal **year-0026 epochs** were persisted and pushed (found live:
`Expected Closing Date = -61329625438000` on task 868k4wrtx). Fixed in UI
(draft-commit on blur/Enter, year ≥ 1900) and now **server-side**: closing-date +
DOB writes validate strict `YYYY-MM-DD` with years 1900–2100, and
`dateOnlyToClickUpEpoch` returns null (push skips) for out-of-range years, so a
garbage year can never reach ClickUp again even if a client bypasses the UI.

### Explicitly ruled out

- **Portal DB DOBs were NOT mass-corrupted.** Inbound DOB is fill-only
  (`COALESCE(date_of_birth, $n)`), every DOB input bound raw strings (no
  `new Date()` in the save path), and pre-fix pulls of native 4 AM-NY epochs
  sliced to the correct day. The portal DB is therefore the trusted restore source.
- **SSN / phone / email / address have no instance of this class** (no
  representation change on push except phone E.164 formatting, which is lossless).

## Damage inventory + restore

- `scripts/clickup-date-restore.js` — runs with prod `DATABASE_URL` +
  `CLICKUP_API_TOKEN`. Dry-run by default; classifies every date field on every
  linked task (`native-4am` / `portal-utc-midnight` / `garbage-year` /
  `other-offset`), cross-checks the portal DB + audit_log, emits a CSV, and with
  `--apply` rewrites damaged fields to the correct day at 4 AM NY — verifying
  every write by re-read and journaling it (clickup_write_log + audit_log).
  It never clears a field and never touches what it can't classify.
- Values it cannot decide (garbage year with no portal value; day disagreement
  between portal and ClickUp on a native entry) are flagged for human review, not
  guessed.

## Guardrails now in place (bidirectional sync preserved)

1. **Write journal** (`clickup_write_log`, db/106): every outbound field write —
   create, scoped push, full repush, restore — with the value ClickUp held
   immediately before. SSN/card masked. The missing "API history" now exists.
2. **No-op suppression**: before an update push the task is read once and fields
   already equivalent (calendar-day compare for dates, index↔UUID for dropdowns)
   are skipped — the sync can no longer silently sweep-rewrite whole tasks.
3. **DOB shift block**: an *automated* (scoped) push that would move an existing
   ClickUp DOB by exactly ±1 day — the corruption signature — is refused,
   journaled (`blocked=true`), and audited (`clickup_dob_shift_blocked`). An
   explicit human-initiated full repush may still apply a real correction.
4. **Garbage-year chokepoint**: out-of-range years can neither persist
   (server-side validation on closing-date/DOB/profile writes) nor be pushed
   (`dateOnlyToClickUpEpoch` → null).
5. **Round-trip invariant**: the write path throws rather than emit a date epoch
   whose own pull-back differs from the intended day — the push→pull day-walk
   class is structurally dead.
6. **Inbound change audit**: a ClickUp→portal pull that CHANGES an existing value
   on a critical field (closings, loan amount, purchase price, program, loan
   type) writes a before→after `audit_log` row (`clickup_pull_field_change`).
   DOB/SSN inbound stay **fill-only** — ClickUp can fill an empty portal value,
   never overwrite one.
7. **Wipes are structurally impossible in both directions** (pre-existing,
   now documented as an invariant): the push skips empty values, the pull writes
   through COALESCE; there is no delete path in the sync (client-layer hard stop).
8. **Before-image audits** on the portal write paths that previously logged
   counts/new-values only (`set_closing_date`, `complete_fields`,
   `update_profile`).

## The DOB slot + immediate sync (owner-reported gap)

- Borrower: DOB is editable on Profile and the application completeness panel;
  those saves now **enqueue a scoped ClickUp push immediately** (primary borrower
  only — a co-borrower's own values never overwrite the parent task's fields;
  profile edits push only to files already linked, never materializing a task).
- Staff: the file's DOB row is now **inline-editable** (was fill-once-only), with
  the same strict validation, and syncs to ClickUp on save.
- Staff closing-date saves push `expected_closing` immediately
  (`actual_closing` stays pull-only — ClickUp owns it).

## Owner's ClickUp activity-history audit (2026-07-15) — and what it corrected

The owner pulled ClickUp's own task activity history (not exposed via the API),
which surfaced a critical forensic fact: **ClickUp NORMALIZES an epoch written
to a no-time date field — a UTC-midnight epoch is re-dayed to the calendar day
it falls on in the workspace's timezone (the PREVIOUS NY day) and stored at
4 AM like a native entry.** Two consequences: (1) the damage was not merely
display — ClickUp physically stored the wrong day; (2) the midnight-UTC
fingerprint is erased by normalization, so a fingerprint scan undercounts —
the activity history is the authoritative damage source.

Confirmed damage (all restored or human-fixed, see restore log):
- 10 DOBs shifted -1 day (writes Jul 6–14), 2 human-fixed before the restore.
- Expected Closing: 1 shifted then wiped (Tzvi handler), 1 year-0026 walker
  (Yuda Elbaum — restore needs the portal value; flagged, not guessed).
- The Yaniv Erez Miami task: 8 fields cleared in one second + a literal
  "undefined" string in Subject Property Address — collateral from the
  duplicated-task bug root-fixed in f346033. Repair: admin repush from the
  portal (journaled) once this branch is deployed.
- Repeated no-op writes of identical values (noise) — eliminated by the
  no-op suppression guard.

## Restore log (2026-07-15, applied via ClickUp API, each verified by re-read)

| Task | File | Field | Before | After |
|---|---|---|---|---|
| 868k1rxwd | Tzvi handler – 33 Pear St | DOB | Jul 11, 2000 | **Jul 12, 2000** |
| 868k1rxwd | Tzvi handler – 33 Pear St | Expected Closing | (wiped) | **Jul 16, 2026** |
| 868k2zx1y | Yeshia Aaron Berger – 56 Ball Rd | DOB | Oct 26, 1988 | **Oct 27, 1988** |
| 868ka88vm | Pinches Lichtman – 24 Gordon Pl | DOB | Sep 14, 2000 | **Sep 15, 2000** |
| 868k71wq8 | Simcha Lev – 2547 S Braddock | DOB | Nov 26, 1992 | **Nov 27, 1992** |
| 868k7ckyn | Mutty Kaufman/Noach M. – 1053 Ella T Grasso | DOB | Jun 4, 2003 | **Jun 5, 2003** |
| 868jxdbvt | Malcolm Thorpe – 145 Dover Rd | DOB | Aug 9, 1991 | **Aug 10, 1991** |
| 868kbtqn8 | Noach Mendelovits – 1 May St | DOB | Oct 26, 2006 | **Oct 27, 2006** |
| 868kc90cz | Yaniv Erez – Miami | DOB | Feb 25, 1972 | **Feb 26, 1972** |
| 868kcephh | yosef c – 904 Bedford Ave | DOB | 00:00Z epoch (displayed Dec 31, 1999) | **Jan 1, 2000** (4 AM NY) |

Verified already correct (human-fixed, untouched): 868jrhhzc Rochlitz Joel DOB
= Jan 10, 1991; 868k4wrtx Yuda Elbaum DOB = Jul 21, 2006.
Open items: Yuda Elbaum Expected Closing (year-0026 walker — restore from the
portal value via the toolkit or the review queue); Yaniv Erez Miami field wipe
(admin repush after deploy).

## Operational notes

- Every date field ClickUp-side written before this fix still holds a 00:00Z
  epoch (displays -1 day in NY) until `--apply` is run — restoring is a data
  operation, deploying the code alone does not rewrite history.
- `CLICKUP_DATE_TZ` (default `America/New_York`) must match the team's ClickUp
  timezone. If the workspace ever moves timezones, update it — the tests pin the
  live-verified value.
