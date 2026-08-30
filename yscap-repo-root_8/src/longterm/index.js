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

// The REPORTING CENTRE (owner-directed 2026-08-30: "a full reporting center where I
// can see for every file how long it took between which and which step and who the
// processor was in that file, and then reporting per processor"). A report names
// catalog KEYS, never SQL, and the viewer's own access is appended to every run —
// so a shared report can only ever narrow, exactly like a saved view.
// /api/lt/reports
router.use('/reports', require('./routes/reports'));

// The archive — Encompass's deleted loans (its `(Trash)` folder), out of every
// pipeline view and totaled here, with the super-admin's permanent delete
// (owner-directed 2026-08-23).
router.use('/archive', require('./routes/archive'));

// The ClickUp SYNCING section of every file (owner-directed 2026-08-23:
// "Every feature that we build up that should happen automatically, we should
// have the option over there") — the synced-field plan, the card link, manual
// link / push / per-field push / Create New Task, and the writer's review
// queue. Every write still goes through the guarded writer. /api/lt/clickup
router.use('/clickup', require('./routes/clickup'));

// The ENCOMPASS SYNCING section of every file (owner-directed 2026-08-25: "the
// pull, the refresh, the last pull, last refresh, last webhooks, and stuff like
// that") — what has been read for this loan and what has not, when Encompass last
// changed it, when a webhook last asked us to look, and a button that reads the
// loan again on the spot. READ-ONLY towards Encompass; the read-only gate covers
// it like every other module. /api/lt/encompass-file
router.use('/encompass-file', require('./routes/encompass-file'));

// The Condition Center, READ side: this loan's conditions with the documents that
// answer each one, plus the eFolder needs list — which is where the work actually
// is on a live file, since every condition in this tenant sits on a loan that is
// already sold. Behind `conditions.enabled` (off by default) and the same file
// scope as the workspace. READ-ONLY: no route here writes to Encompass or to us.
// /api/lt/conditions
router.use('/conditions', require('./routes/conditions'));

// THE GENERAL CONDITION CENTER — OUR OWN conditions, not Encompass's.
//
// The router above is db/612's READ-ONLY mirror of Encompass's Enhanced
// Conditions and eFolder: what the investor's underwriter raised AFTER buying
// the loan. This one is what WE need to get a file submitted, cleared to close,
// docked, funded and sold (owner-directed 2026-08-30). Two centres, two routers,
// two sets of tables — db/643's header records why they must never become one.
// /api/lt/condition-center
router.use('/condition-center', require('./routes/condition-center'));

// The signed-in person's own long-term preferences — today, which product side
// they open on (the owner's switch), remembered per user. /api/lt/me
router.use('/me', require('./routes/me'));

// The settings — the sellable-LOS rule made usable. Two screens, one endpoint:
// COMPANY scope (admin) and the person's own (anyone, their own only).
// /api/lt/settings
router.use('/settings', require('./routes/settings'));

// The Pricing Engine's saved INVESTOR GROUPS (owner-directed 2026-08-27) — a
// person's own named sets of investors for the DISPLAY-ONLY board filter.
// Registered BEFORE the /dscr mount so it wins the match, and deliberately NOT
// inside makeRouter: that router is also mounted on the secret-gated
// diagnostics seam, where there is no signed-in person to own a group.
//   /api/lt/dscr/investor-groups
router.use('/dscr/investor-groups', require('./routes/pricer-groups'));

// DSCR pricer (Lender Price backend) — staff-gated at the mount:
//   /api/lt/dscr/{health,login-check,price,investors,selftest}
router.use('/dscr', require('./routes/dscr-pricer').makeRouter());

// The Product & Pricing Engine. Lender Price stays AUTHORITATIVE — our engine
// runs beside it in shadow and every disagreement becomes a finding. Reads are
// open to any staff member; deciding a finding and running a canary are
// admin-gated inside the router. /api/lt/ppe/{health,settings,investors,
// findings,scoreboard,quote,canary}
router.use('/ppe', require('./routes/ppe'));

// THE PASS THAT RUNS ON ITS OWN.
//
// Started HERE rather than from src/server.js on purpose: this module is the one
// seam RTL is permitted to touch, and having it schedule its own background work
// keeps the whole of Long-Term behind that one door. A second call from server.js
// would be a second seam — exactly what the separation gate refuses.
//
// OFF by default (`LT_SYNC_ENABLED`), and it says so in the log either way. With
// the switch off nothing is scheduled, so requiring this module — which a test or
// a script may do — starts no timers and reads nothing.
require('./sync/worker').start();

module.exports = { router };
