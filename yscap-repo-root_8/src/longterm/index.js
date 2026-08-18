'use strict';

// =============================================================================
// LONG-TERM LOANS (LT) — back-end entry point.
// =============================================================================
//
// This module builds and exports the Long-Term product's Express router. It is
// the ONE module src/server.js is permitted to import — the single back-end seam
// between RTL and LT (docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md §4). Everything
// under src/longterm/** is the brand-new LT build and shares nothing with RTL
// except the identity zone recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md.
//
// Auth is applied at the mount in src/server.js (staff-authenticated), exactly
// like the /api/admin routers, so this module imports no RTL code.

const express = require('express');

const router = express.Router();

// Liveness / identity of the LT side (no DB) — lets the front end and ops confirm
// the Long-Term module is mounted.
router.get('/health', (req, res) => res.json({ ok: true, product: 'long-term' }));

// The Encompass milestone / status catalog (the "memory of the long-term side of
// Encompass"): /api/lt/encompass/milestones
router.use('/encompass', require('./routes/encompass-milestones'));

// The Encompass "memory": the unified field catalog, the Milestone Completion
// rules, the request/authorization catalog, and the RTL reconciliation map —
// read-only reference knowledge under /api/lt/encompass/{summary,fields,
// completion-rules,requests,reconciliation-map,status}.
router.use('/encompass', require('./routes/encompass-knowledge'));

// The status map: Encompass's milestones, OUR stages and the borrower's own
// wording, in one read, so the three can be looked at together and ours renamed.
// READ-ONLY — a change goes through the settings door, which is the one writer.
// /api/lt/stages
router.use('/stages', require('./routes/stages'));

// The people map: which PILOT person each Encompass login is. Reading is open to
// any staff member (an officer with an empty pipeline has to be able to see that
// nobody has linked their account yet); changing it is admin-only.
// /api/lt/people
router.use('/people', require('./routes/people'));

// The borrower map: which PILOT borrower profile each long-term loan belongs to.
// `lt_loans.borrower_id` is what a client's own login reads, so this is what puts a
// long-term file in front of the borrower. PILOT proposes by email and NEVER adopts
// a profile on its own — reading is open to any staff member, deciding is admin-only.
// /api/lt/borrowers
router.use('/borrowers', require('./routes/borrowers'));

// The loan sync: discovery from the pipeline, then a full read of what moved.
// Reading how fresh the book is is open to any staff member ("why does this file
// look old?"); running a pass is admin-only. /api/lt/sync
router.use('/sync', require('./routes/sync'));

// The long-term pipeline itself: an officer's own book, the closer's and funder's
// whole book, the admin's everything — narrowed by the ONE access rule.
// /api/lt/pipeline
router.use('/pipeline', require('./routes/pipeline'));

// The BOOK — the owner's census of the long-term side: every long-term file with
// the folder, the status and the milestone it sits in, plus the buckets that
// account for every loan the long/short rule could not place. Same access rule as
// the pipeline, so it can never show a file the pipeline would hide.
// /api/lt/book (+ /export.csv)
router.use('/book', require('./routes/book'));

// Saved pipeline views — a named set of FILTERS, never a scope. A view is appended
// to the viewer's own access inside the query, so it can only ever narrow.
// /api/lt/views
router.use('/views', require('./routes/views'));

// The signed-in person's own long-term preferences — today, which product side
// they open on (the owner's switch), remembered per user. /api/lt/me
router.use('/me', require('./routes/me'));

// The settings — the sellable-LOS rule made usable. Two screens, one endpoint:
// COMPANY scope (admin) and the person's own (anyone, their own only).
// /api/lt/settings
router.use('/settings', require('./routes/settings'));

// DSCR pricer (Lender Price backend) — staff-gated at the mount:
//   /api/lt/dscr/{health,login-check,price,selftest}
router.use('/dscr', require('./routes/dscr-pricer').makeRouter());

// The Product & Pricing Engine, mounted at /api/lt/ppe. Lender Price stays
// AUTHORITATIVE — our engine runs beside it in shadow and every disagreement
// becomes a finding. Reads are open to any staff member; every write except the
// two pricing doors (`POST /quote`, `POST /breakdown`) is admin-gated inside the
// router, which is where that rule is stated and enforced.
// NO PATH LIST HERE, deliberately: this comment used to enumerate seven paths
// ({health,settings,investors,findings,scoreboard,quote,canary}) and the router now
// registers thirty-five, so the list was a hand-kept index that had silently gone
// two-thirds stale. `routes/ppe.js` is the one place the surface is described.
router.use('/ppe', require('./routes/ppe'));

// The PPE canary driver — the thing that ASKS the tick that fires the daily change-detection
// schedules. It is armed HERE, on the Long-Term side, rather than in src/server.js, because the one
// permitted back-end seam is server.js MOUNTING this router and nothing more; a Long-Term background
// loop belongs inside Long-Term.
//
// IT IS OFF, AND `start()` RETURNING FALSE IS THE NORMAL CASE. Without an explicit
// `LT_PPE_CANARY_DRIVER_ENABLED` — which is set nowhere in this repository, and deliberately not in
// render.yaml — this arms no timer, opens no connection and calls no vendor, so merging it changes
// nothing about the running system. HOW the tick should be driven in production (a Render CRON
// service, the existing sync worker, or this in-process scheduler) changes what happens when two
// instances run and costs a live vendor call either way, so it is an open owner question recorded in
// docs/longterm/LENDER-PRICE-PARITY-STATUS.md §2.46 — not a decision taken here.
require('./ppe/canary-driver').start();

module.exports = { router };
