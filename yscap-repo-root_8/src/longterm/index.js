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

/* THE PHOTO ID IS SHARED BOTH WAYS, AND THE REGISTRATION HAS TO HAPPEN HERE.
   Owner-directed 2026-08-31: *"if it's uploaded to the short term, it should
   share it to the long term."* The rule lives in ONE shared place, but RTL may
   never name `lt_loans` — so the shared module ASKS each product where its own
   ID conditions are, and Long-Term answers by registering on require.

   IT IS REQUIRED AT THE TOP OF THE ROUTER, NOT LAZILY INSIDE A HANDLER, AND
   THAT IS THE WHOLE POINT: the direction that needs it is a SHORT-TERM upload
   reopening a LONG-TERM condition, which never touches a Long-Term handler. A
   lazy require would leave the reopener unregistered until somebody happened to
   upload on this side — so the sharing would work in one direction only, and
   silently. Mounting the router is what registers it, and `src/server.js`
   mounting this router is the existing seam, so this adds no new one. */
require('./conditions-center/photo-id-share');

const router = express.Router();

/* ⛔ THE INVESTOR-NAME BLOCK MUST BE IN FORCE BEFORE THE FIRST REQUEST, and
   "before" is a claim about time and ORDER that has to be true of both.

   The block in `audience.js` is fed by the settings store's `applyOnLoad` hook,
   which fires on a company-scope READ. The surfaces that most need it never take
   one: a borrower's own conditions (`routes/my-conditions.js`,
   `conditions/read.js`), the term-sheet snapshot and the PDF all scrub without
   ever asking for a setting. Nothing told the block about the investors somebody
   added by hand, so the FIRST borrower to open their conditions after a deploy
   was read to by a block that had never heard of them.

   A single fire-and-forget read was not enough, and an audit measured why: the
   require returned and the read landed ~28ms later with `app.listen()` in
   between, so a request in that window was still served cold — and a read that
   came back DEGRADED gave up for good. So there are two mechanisms:

     · keepWarm RETRIES until a clean read lands, then re-reads on an interval,
       which also bounds how far behind this process can be after an admin adds
       an investor somewhere else (see AUDIENCE-RULES.md).
     · the guard below makes a request WAIT for a read, which closes the race
       rather than narrowing it.

   ⛔ IT IS MOUNTED FIRST, BEFORE ANY ROUTE ON THIS ROUTER — including /health.
   Express runs layers in the order they were added, so a guard added after a
   route simply does not run for that route. `test-lt-custom-investors-pure.js`
   asserts the mounted LAYER and its POSITION rather than grepping for this call,
   because the paragraph you are reading satisfies any grep on its own. */
const settingsStore = require('./settings/store');
const warmth = settingsStore.keepWarm();
router.use(settingsStore.ensureWarm());



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

/* THE ORDERS DESK — the vendor orders a long-term file needs: title, insurance,
   flood insurance, a New York settlement agent, a payoff, a condo questionnaire, a
   verification of rent, and (built and switched off) the appraisal. The LETTER and
   the recipient rule are SHARED with the short-term desk (src/lib/order-email.js,
   authorized in docs/LONG-TERM-AUTHORIZED-COPIES.md); the tables, the vendor links
   and the bookkeeping are this product's own. */
router.use('/orders', require('./routes/orders'));
router.use('/vor', require('./routes/vor'));

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

// THE COMBINED PRICING ENGINE — Lender Price + LoanNEX in one answer, with a
// per-investor setting for which program each investor is fetched from
// (owner-directed 2026-08-30). Registered BEFORE the /dscr mount so it wins the
// match, exactly like /dscr/investor-groups above.
//
// A SECOND ENGINE, BESIDE THE FIRST — NEVER ON TOP OF IT. The owner's words:
// *"Don't touch our current setup that we currently have: our General Pricing
// Engine. Just make this totally separate… I am going to test the system that
// works on both together. If it's going to be good, then I am going to merge
// everything into the General Pricing Engine."* So the general engine below
// (`/dscr/*`) is byte-for-byte what it was, and this is an additional mount.
//
// SUPER ADMIN ONLY, live on the domain. *"Merge this live into domain only for
// super admin to be able to see it and super admin to be able to test it."* The
// gate is inside the router (see combined-pricer.js) and is keyed on the REAL
// staff role, so a long-term role override cannot hand it to anybody. The
// LT_COMBINED_PRICING switch is a kill switch, default ON.
//   /api/lt/dscr/combined/{health,price,investors,loannex/price,loannex/login-check,loannex/disqualify/:id}
router.use('/dscr/combined', require('./routes/combined-pricer').makeRouter());
// THE GENERAL PRICING ENGINE'S INVESTOR SOURCES — the side-by-side list that lives in
// the general engine's SETTINGS (owner-directed 2026-09-03: *"I want the side-by-side
// list… in the settings of the regular pricing engine"*). Registered BEFORE the /dscr
// mount so it wins the match, exactly like the two above.
//
// ⛔ ITS OWN MOUNT, NOT A SECOND MOUNT OF THE COMBINED ROUTER. The doors themselves are
// ONE definition (`routes/investor-settings-routes.js`) that both engines attach, but
// the combined router carries the `LT_COMBINED_PRICING` kill switch — mounting it here
// would let switching that engine off take the GENERAL engine's settings down with it.
// Super-admin only, answering 404, exactly as the combined copy always has.
//   /api/lt/dscr/investor-sources/{investors,investor-links,custom-investors,margin-holdback}
router.use('/dscr/investor-sources', require('./routes/pricer-sources').makeRouter());
// The Pricing Engine's SAVED SCENARIOS (owner-directed 2026-08-31) — a person's
// own saved sets of pricing INPUTS, re-runnable any time. Registered BEFORE the
// /dscr mount for the same reason the investor groups are, and deliberately NOT
// inside makeRouter: a scenario belongs to ONE person, and the diagnostics seam
// has nobody signed in to own one.
//   /api/lt/dscr/scenarios
router.use('/dscr/scenarios', require('./routes/pricer-scenarios'));

// TERM SHEETS (owner-directed 2026-08-30) — issue, replay by ID, and the
// comparison cart. Registered BEFORE the /dscr mount for the same reason the
// investor groups are, and deliberately NOT inside makeRouter: that router is
// also mounted on the secret-gated diagnostics seam, where there is no signed-in
// person — and a term sheet is issued BY somebody, priced on THEIR compensation,
// and compared in THEIR cart.
//   /api/lt/dscr/term-sheet
router.use('/dscr/term-sheet', require('./routes/term-sheet'));

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

/* `warmth.ready` resolves on the first CLEAN company read. Exported so a caller
   that wants to hold traffic until the block is in force can await it — nothing
   does today, because `ensureWarm` already makes every request that could reach
   a scrub wait for it, and holding a boot on a database read would trade a
   bounded cold window for an unbounded one. */
module.exports = { router, ready: warmth.ready };
