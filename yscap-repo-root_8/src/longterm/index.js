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

// The people map: which PILOT person each Encompass login is. Reading is open to
// any staff member (an officer with an empty pipeline has to be able to see that
// nobody has linked their account yet); changing it is admin-only.
// /api/lt/people
router.use('/people', require('./routes/people'));

// The loan sync: discovery from the pipeline, then a full read of what moved.
// Reading how fresh the book is is open to any staff member ("why does this file
// look old?"); running a pass is admin-only. /api/lt/sync
router.use('/sync', require('./routes/sync'));

// The long-term pipeline itself: an officer's own book, the closer's and funder's
// whole book, the admin's everything — narrowed by the ONE access rule.
// /api/lt/pipeline
router.use('/pipeline', require('./routes/pipeline'));

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

module.exports = { router };
