# Draw Management — the next phase after funding (design proposal)

_Owner-directed 2026-07-20. Elevate construction-draw management from a section buried inside the
loan file into its own **post-funding phase**: a dedicated staff workspace + a real borrower
experience + **PILOT-branded inspection reports** built from the inspector's photos and notes, with
the full dispute / notes / request / approval lifecycle and the emails around it. Grounded in a full
read of everything that exists today (see the two current-state inventories in the research notes)._

> This is a proposal for the owner to review and steer **before** any building. It reuses the proven
> backend (reconcile, rollup, money, risk, monitor, findings, crosswalk) and takes the *surfaces* to the
> next level. Nothing here changes the go-forward-only rule: PILOT manages only draws it pushed.

---

## 1. The core idea — a draw is its own thing, after funding

Today "Construction draws" is the last **section of the loan file**, and the portfolio (`/internal/draws`)
is a read-only list that links back to the file. The owner's direction: the draw process is the **next
level after funding** and should not sit at the same level as the file. So:

- **A new top-level "Draw Management" workspace** (`/internal/draw-management`) becomes the home of the
  whole phase. From funding onward, a file's draws are managed *there*, not inside the file screen.
- The loan file keeps only a **compact hand-off card** ("This file is funded → manage its draws in Draw
  Management", with a deep link), instead of the full desk. The desk itself lives in the workspace.
- Inside the workspace you can work **cross-file** (every active draw, what's pending your approval,
  exposure) **and drill into one file's draw desk** (Draw 1, Draw 2, per-line approved/not-approved,
  inspector photos, money, findings, reallocations) — the same capabilities we already have, re-homed
  and given room to breathe, plus the new capabilities below.

Structurally it's the existing `DrawsPanel` capabilities, promoted out of the file and organized as a
phase with its own navigation, plus three genuinely new things: **staff photo/report review**, **durable
PILOT-branded reports**, and a **real borrower draw experience with a closed dispute loop**.

---

## 2. What already exists (so we build on it, not over it)

**Backend is strong and stays.** Reconcile mirrors draws/requests/events/risk (created-only); `rollup.js`
folds per-unit requests back to SOW lines; `money.js` does fee/retainage/net; `risk.js` + `monitor.js`
flag issues; findings deliver→accept/dispute→resolve is wired; the per-unit crosswalk ties it all
together. Money ledger, lien waivers, reallocations, xlsx exports, and a guarded write path all exist.

**The inspector data is already captured** — per line: `photo_count`/`video_count`, `inspector_comments`,
`approved`/`not_approved_cents`, and `media` = `[{src, thumbnail, type, lat, lng, captured_at, note}]`
(photos, videos, GPS, timestamps). It is persisted into `draw_finding_lines` **when staff deliver
findings**.

**The three real gaps** (what "next level" must add):
1. **Staff can't see the photos.** The staff desk shows only a photo *count*; the only image rendering
   anywhere is the borrower's small thumbnails. There is **no staff gallery / no report**.
2. **Photos aren't durable, and there's no branded report.** Media is stored as raw Sitewire URLs (they
   can expire); nothing downloads them. The only "reports" are spreadsheets with counts, plus Sitewire's
   own unbranded PDF. There is **no PILOT-branded inspection report** of any kind.
3. **The borrower loop isn't closed.** Dispute captures only text + a desired number (no evidence
   upload); when staff resolve a dispute the borrower is **never notified**; draw emails are generic (only
   one hand-built template); there are no reminders. And draws only appear inside the funded file screen.

---

## 3. Proposed build — three tracks

### Track A — Staff Draw-Management workspace (`/internal/draw-management`)
- **Landing / command center:** the portfolio we have (exposure, pending-your-approval, high-risk,
  attention alerts) becomes the workspace home, but now every row **drills into the draw desk in-place**
  (not back to the loan file). A clear phase header, a proper draw icon, and a "Draw N" breadcrumb.
- **Per-file draw desk (re-homed `DrawsPanel`):** everything it does today — rollup, per-draw cards,
  set-approved, approve/amend/reopen, money ledger, retainage, waivers, reallocations, activity — plus:
  - **NEW: an inspector photo/report review panel** per draw and per line — a real gallery of the
    inspector's photos/videos with the inspector's note, the requested/approved/**not-approved** amount,
    and geo/timestamp. This is what staff review *before* approving a line and *before* delivering to the
    borrower. (Data already exists; today it's invisible to staff.)
  - **NEW: reallocation create-UI** (the endpoint exists; no UI today).
- **Draw-rules / settings** stays where it is, linked from the workspace.

### Track B — PILOT-branded inspection reports (the marquee new capability)
- **Make photos durable:** on findings delivery (and on demand), **download the inspector media from
  Sitewire into PILOT storage** (or mirror to the file's SharePoint), so a report doesn't depend on a
  third-party URL that can expire. Store bytes + a stable internal URL alongside the existing `media`
  jsonb.
- **Generate a branded PDF** per draw (and a whole-project report): PILOT letterhead, property + loan,
  the Schedule of Values (budget/drawn/this draw), and — per line — the **photos, inspector note,
  approved vs not-approved, geo/timestamp**, with a clean approved/not-approved visual. Built with the
  `pdf`/`canvas-design` tooling, not a spreadsheet. Staff can view/download it; the borrower gets a
  link to their (borrower-safe) copy.
- This is the "nice PILOT-branded reports out of the inspector photos and reports" the owner asked for.

### Track C — Borrower draw experience + closed loop
- **A real borrower draw view** (still reached from their file, optionally a dedicated draw area): a
  per-draw timeline ("submitted → inspected → under review → approved → funds released, expected by X"),
  the branded report, photo galleries, and clear "what happens next / when is my money coming."
- **Close the dispute loop:** allow **evidence photo upload** on a dispute (the `dispute_media` column
  already exists; the UI just never sends it), and add a **`draw_resolved` notification** so the borrower
  is told the outcome when staff decide a disputed line (today they hear nothing).
- **Designed draw emails** (findings delivered / accepted / disputed / resolved / reminders) replacing the
  generic template, all borrower-safe (no capital-partner names). Optional **reminders** (findings
  awaiting review, wire overdue) — the monitor already computes these; today they're display-only.

---

## 4. Data / infra changes (kept minimal, additive)
- **Durable media:** a small `draw_media` table (or reuse `draw_finding_lines.media` + a stored-bytes
  pointer / SharePoint mirror) so photos survive. A fetch+store step in the findings path.
- **Report artifacts:** a `draw_reports` row (draw_id, kind, generated_at, storage ref) so a branded PDF
  is generated once and re-served.
- **`draw_resolved` notification type** + designed templates in the email catalog.
- Everything else (routes, workspace, galleries, borrower views) is UI + read paths over data we already
  store. No change to the go-forward-only or guard rules.

---

## 5. Phasing (each phase = its own reviewed, audited, merged batch)
1. **Track A** — the standalone workspace + re-homed desk + the staff photo/report **review gallery**
   (highest daily value; unblocks staff actually seeing inspections).
2. **Track B** — durable media + the **PILOT-branded report** generator.
3. **Track C** — the elevated borrower experience + closed dispute loop + designed emails + reminders.

Each phase ships behind the same staged Sitewire switches and the two-audit gate, and goes live with a
normal deploy.

---

## 6. Open decisions for the owner (so I build exactly the right thing)
1. **Home of the phase:** move the full desk into a top-level **Draw Management workspace** and leave only
   a hand-off link on the file (recommended) — vs. keep the desk on the file too.
2. **Branded report:** a **per-draw** branded PDF (photos + approved/not-approved + notes) is the core;
   also a whole-project report? Any must-have content/branding?
3. **Photo durability:** download inspector photos into **PILOT/SharePoint storage** (recommended, so
   reports never break) — confirmed?
4. **Borrower scope now:** timeline + branded report + dispute-with-photos + resolution email in the first
   borrower phase — or start smaller?
