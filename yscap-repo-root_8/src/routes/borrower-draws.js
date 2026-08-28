'use strict';
/**
 * Borrower-facing draw management (mounted at /api/borrower). The borrower SUBMITS draws and
 * uploads photos in Sitewire's own app; here in PILOT they:
 *   · see each draw's live status + the unified per-line picture (drawn / remaining / %),
 *   · review inspection FINDINGS (photos, notes, approved / not-approved per line) and either
 *     ACCEPT (which starts our wire SLA) or DISPUTE (per-line evidence + the amount they
 *     believe is right) — the accept/dispute happens IN PILOT, never in Sitewire, and
 *   · request a Scope-of-Work change (a budget reallocation), validated by the same rules
 *     the staff desk uses.
 *
 * Every capital-partner name is scrubbed from borrower-facing text (borrower-safe). Ownership
 * is enforced on every read/write. Nothing is guessed — a dispute is queued for a human.
 */
const express = require('express');
// safe-router forwards any async-handler rejection to the global JSON error middleware
// (fast generic 500/503) instead of letting the request hang — Express 4 does not catch
// rejected promises from async handlers. Every borrower draw write must be hang-proof.
const router = require('../lib/safe-router')();
const db = require('../db');
const F = require('../lib/fields');           // jsonbText: NUL-safe jsonb binds
const { requireAuth, requireBorrower } = require('../auth');
const rollupMod = require('../sitewire/rollup');
const borrowerSafeDraws = require('../sitewire/borrower-safe-draws'); // ONE borrower-safe draw scrub (shared with the TPO surface)
const { planReallocation } = require('../sitewire/reallocation');
const M = require('../sitewire/mapper');
const notify = require('../lib/notify');
const drawLabel = require('../lib/draw-label');   // "Draw 2" — the ONE way a draw is named in a subject
const borrowerSafe = require('../lib/borrower-safe');
const drawReport = require('../sitewire/draw-report');
const { serveDocument } = require('../lib/serve-document');
// The dispute-evidence normalizer (sniff the real image type from the bytes, strip GPS, convert
// iPhone HEIC to JPEG, cap size + count, store durable copies) is the ONE shared definition
// (sitewire/dispute-media.js) — the borrower AND the TPO/broker surfaces store dispute evidence
// identically and can never drift on this security-critical sniff/strip/cap layer.
const { normalizeDisputeMedia } = require('../sitewire/dispute-media');
const drawAttachments = require('../sitewire/draw-attachments');   // photos/invoices/receipts on a draw
const drawChecklist = require('../sitewire/draw-checklist');       // expected dates + the booked visit

router.use(requireAuth, requireBorrower);
const me = (req) => req.actor.id;
// ONE definition of "which files a borrower owns" — delegated to the shared
// helper (mirrors routes/borrower.js) so the TPO borrower-login toggle (and any
// future change) applies here too. A local copy silently diverged: a
// portal-disabled TPO file would still expose its draws (audit follow-up).
const OWN_FILE_SQL = require('../lib/change-requests').OWN_FILE_SQL;
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
async function ownsApp(req, appId) {
  if (!isUuid(appId)) return false; // malformed id → no ownership (avoid a 22P02 async-rejection hang, audit F1)
  const r = await db.query(`SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND (${OWN_FILE_SQL('a', '$2')})`, [appId, me(req)]);
  return r.rowCount > 0;
}
const scrub = (s) => (s == null ? null : borrowerSafe.scrubText(String(s)));

// ---- GET /draws — every draw across the borrower's files (borrower-safe) ----
router.get('/draws', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT d.sitewire_draw_id, d.application_id, d.number, d.status, d.total_requested_cents, d.total_approved_cents,
              -- The borrower's list must show what the INSPECTOR approved, not Sitewire's
              -- final-approval field (0 until our last click). SAME precedence as
              -- approval.inspectorApproved (mirror -> delivered findings -> total) so it never
              -- reads $0 while the inspector's figure sits in the findings and the mirror lags.
              COALESCE((SELECT sum(r.approved_cents) FROM sitewire_draw_requests r WHERE r.sitewire_draw_id = d.sitewire_draw_id),
                       (SELECT sum(fl.approved_cents) FROM draw_finding_lines fl JOIN draw_findings df ON df.id = fl.finding_id WHERE df.sitewire_draw_id = d.sitewire_draw_id AND fl.retired_at IS NULL),
                       d.total_approved_cents) AS inspector_approved_cents,
              d.submitted_at, d.approved_at, a.property_address->>'oneLine' AS address,
              (SELECT status FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS findings_status,
              (SELECT id FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS finding_id
         FROM sitewire_draws d JOIN applications a ON a.id=d.application_id
        WHERE a.deleted_at IS NULL AND (${OWN_FILE_SQL('a', '$1')})
        ORDER BY d.updated_at DESC NULLS LAST LIMIT 200`, [me(req)])).rows;
    res.json({ draws: rows });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- GET /draws/:appId/rollup — the unified per-line picture (borrower-safe) ----
router.get('/draws/:appId/rollup', async (req, res) => {
  if (!(await ownsApp(req, req.params.appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    let sowState = null;
    try { const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [req.params.appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
    // Borrower-safe strip (the ONE definition, shared with the TPO surface): scrub SOW-line labels,
    // drop the per-draw `fee_kind` (our fee schedule) + the STAFF `net_explanation` — re-adding the
    // BORROWER wording so the screen and the PDF phrase the deduction the same way — drop
    // `stage_times` (the with_investor / capital-partner delivery time is never borrower/broker-facing
    // — frozen rule; #1045 added it to the timeline) — and delete `rollup.fees` (our fee income across
    // the project is never borrower/broker-facing). The per-draw money the borrower WILL be paid (net
    // release / released) stays (owner-directed 2026-08-03: "add the released amount to the borrower
    // screen too"). See src/sitewire/borrower-safe-draws.js for the single definition.
    const rollup = borrowerSafeDraws.borrowerSafeRollup(await rollupMod.loadRollup(db, req.params.appId, { sowState }));
    // WHAT HAPPENS NEXT, AND WHEN (owner-directed 2026-08-09). The borrower could see the stage and
    // the money but never a DATE — and the booked inspection visit was mirrored, turned into "Visit
    // scheduled" by draw-status, and then simply never shown to the person waiting at the property.
    //
    // BORROWER-SAFE BY CONSTRUCTION: only the three dates and the visit are taken from the
    // checklist — never its steps, which name our internal work and the capital-partner rung.
    const dates = {};
    try {
      for (const d of (rollup.draws || []).slice(0, 12)) {
        const c = await drawChecklist.checklistFor(db, req.params.appId, d.sitewire_draw_id, { stage: d.approval_stage });
        if (!c) continue;
        dates[d.sitewire_draw_id] = {
          inspection: c.dates && c.dates.inspection, decision: c.dates && c.dates.decision,
          release: c.dates && c.dates.release,
          visit_scheduled_at: (c.facts && c.facts.visitScheduledAt) || null,
        };
      }
    } catch (_) { /* dates are additive — the screen stands without them */ }
    res.json({ rollup, dates });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- GET /draws/:appId/eligibility — can the borrower request another draw right now? (borrower-safe) ----
// A guided, honest read used by the borrower draw screen: how much budget remains, whether the project is
// still open, and what (if anything) is holding up a new draw — plus where to go to submit one (Sitewire).
router.get('/draws/:appId/eligibility', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    let sowState = null;
    try { const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
    const rollup = await rollupMod.loadRollup(db, appId, { sowState });
    const proj = (rollup && rollup.project) || {};
    const budget = Number(proj.budget) || 0;
    // What the borrower may still request = budget minus RELEASED minus what is already approved and
    // waiting to be released. Reading the released-only `remaining` here would let them ask for money
    // an inspector has already committed on a draw in flight (owner-directed 2026-08-03: treat a
    // not-yet-final draw as approved — if it is amended or declined it goes back to available).
    const remaining = Number.isFinite(Number(proj.available))
      ? Number(proj.available)
      : (Number.isFinite(Number(proj.remaining)) ? Number(proj.remaining) : Math.max(0, budget - (Number(proj.drawn) || 0)));
    // project lifecycle: a finished / paid-off project accepts no new draws (Sitewire is deactivated on close).
    const link = (await db.query(
      `SELECT COALESCE(lifecycle_state,'active') AS lifecycle_state FROM sitewire_property_links WHERE application_id=$1 AND matched_by='created' LIMIT 1`, [appId])).rows[0];
    const lifecycle = (link && link.lifecycle_state) || 'active';
    // an inspection result the borrower still has to act on holds the release clock — surface it as the next step.
    const awaiting = Number((await db.query(
      `SELECT count(*)::int c FROM draw_findings WHERE application_id=$1 AND status='delivered'`, [appId])).rows[0].c) || 0;
    // a draw already moving through Sitewire (submitted, not yet approved) — informational, not a hard block.
    const inFlight = Number((await db.query(
      `SELECT count(*)::int c FROM sitewire_draws WHERE application_id=$1 AND status IN ('pending_borrower','inspecting','pending','pending_capital_partner')`, [appId])).rows[0].c) || 0;

    const blocking = [];
    if (lifecycle !== 'active') blocking.push('Your construction project is complete — no further draws can be requested.');
    if (budget > 0 && remaining <= 0) blocking.push('Your full construction budget has been drawn — there is nothing left to request.');
    const nextSteps = [];
    if (awaiting > 0) nextSteps.push(awaiting === 1 ? 'Review and accept your latest inspection result below — that starts your release.' : `Review your ${awaiting} inspection results below — accepting them starts each release.`);
    if (inFlight > 0) nextSteps.push('You already have a draw moving through inspection — you can track it below.');

    // PORTAL composer (physical-inspection program): on those files the borrower may
    // submit the draw line-by-line right here instead of in the construction portal.
    // Borrower-safe: line names + remaining only — never a platform or partner name.
    let composer = null;
    try {
      const portalDraws = require('../lib/portal-draws');
      const st = await portalDraws.composerState(appId);
      if (st.physical) {
        const open = st.open_portal_request;
        if (open) nextSteps.push('Your draw request is in — the site inspection and review are the next steps. We’ll keep you posted.');
        // THE COMPOSER IS PARKED (owner-directed 2026-08-26, compliance): new
        // draw requests are submitted in the construction portal, so the
        // borrower is pointed there instead of at a composer that will refuse.
        // st.eligible is already false while parked, so can_compose follows.
        if (st.parked && !open && blocking.length === 0) {
          // Names the button the screen actually shows (BorrowerDraws.jsx: "Open Sitewire
          // to submit a draw ↗") — pointing at a link that does not exist under that name
          // is a dead end. "construction portal" stays: the parked test pins the phrase.
          nextSteps.push('To request a draw, submit it in the Sitewire construction portal — use the “Open Sitewire to submit a draw” button on this page.');
        }
        const lines = (st.set_up && !open && !st.parked)
          ? (await portalDraws.composerLines(appId)).map((l) => ({
              sitewire_job_item_id: l.sitewire_job_item_id, name: scrub(l.name), remaining_cents: l.remaining_cents,
            }))
          : [];
        composer = {
          can_compose: !!(st.eligible && !st.open_sitewire_draw && blocking.length === 0),
          parked: !!st.parked,
          open_request: open ? {
            id: open.id, status: open.status, source: open.source,
            total_requested_cents: Number(open.total_requested_cents),
          } : null,
          lines,
        };
      }
    } catch (_) { /* the classic screen still renders without the composer */ }

    res.json({
      eligible: blocking.length === 0,
      budget_cents: budget, drawn_cents: Number(proj.drawn) || 0, remaining_cents: Math.max(0, remaining),
      pct_complete: Number(proj.pct_complete) || 0,
      lifecycle_state: lifecycle, awaiting_review: awaiting, in_flight: inFlight,
      blocking, next_steps: nextSteps, composer,
      sitewire_portal_url: require('../config').sitewireBaseUrl || 'https://app.sitewire.co',
    });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- POST /draws/:appId/request — the borrower's line-item draw composer (physical files) ----
// Creates a PORTAL draw request: the coordinator is tasked to run it through the
// administered/inspection process; the borrower gets a receipt + status updates in PILOT.
router.post('/draws/:appId/request', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    /* THE PAYOFF-DEMAND LOCK, on the BORROWER's own door (owner-directed 2026-08-21). PILOT
       refuses here as well as deactivating the Sitewire property, because the block must hold
       even with the Sitewire connection switched off and on a file that was never pushed. */
    const payoffHold = await require('../lib/payoff-demand').payoffDemandBlock(db, appId);
    if (payoffHold.blocked) return res.status(409).json({ error: payoffHold.message, code: 'payoff_demand' });
    const portalDraws = require('../lib/portal-draws');
    const st = await portalDraws.composerState(appId);
    if (!st.physical) {
      return res.status(422).json({ error: 'Draws for this loan are submitted in the construction portal — use the link on your draws page.' });
    }
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
    const row = await portalDraws.createRequest(appId, entries, {
      source: 'borrower', borrowerId: me(req),
      note: req.body && req.body.note ? String(req.body.note) : null,
    });
    // THE BORROWER CAN ATTACH TOO (owner-directed 2026-08-09) — photos, invoices and receipts WITH
    // the request, not only as dispute evidence. Best-effort: the request itself has already been
    // created, so a file that would not store must never fail the draw they just submitted. What
    // did not land comes back with a reason so they can try that file again.
    let attached = null;
    try {
      const items = Array.isArray(req.body && req.body.attachments) ? req.body.attachments : [];
      if (items.length) {
        const out = await drawAttachments.attach(appId, { portalRequestId: row.id }, items, {
          by: { kind: 'borrower', id: me(req) }, supports: 'Attached with the draw request',
        });
        attached = { attached: out.added.length, attachments_skipped: out.skipped };
      }
    } catch (_) { /* the request stands either way */ }
    res.json({ ok: true, request: { id: row.id, status: row.status, total_requested_cents: Number(row.total_requested_cents), created_at: row.created_at }, ...(attached || {}) });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: scrub(e.message) });
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

// ---- POST /draws/:appId/attachments — add a photo, invoice or receipt to a draw ----
// The borrower's own supporting documents. Scoped to THEIR file and to a draw ON that file, so a
// draw id from somebody else's loan can never be filed against. Their uploads are NOT born
// accepted — a reviewer decides — so nothing they attach travels to an investor unvetted.
router.post('/draws/:appId/attachments', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  let ref = null;
  if (b.sitewire_draw_id != null && /^\d+$/.test(String(b.sitewire_draw_id))) {
    const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [String(b.sitewire_draw_id), appId]);
    if (own.rowCount) ref = { sitewireDrawId: String(b.sitewire_draw_id) };
  } else if (b.portal_request_id != null && /^\d+$/.test(String(b.portal_request_id))) {
    const own = await db.query(`SELECT 1 FROM portal_draw_requests WHERE id=$1 AND application_id=$2`, [String(b.portal_request_id), appId]);
    if (own.rowCount) ref = { portalRequestId: String(b.portal_request_id) };
  }
  if (!ref) return res.status(404).json({ error: 'We could not find that draw on your loan.' });
  const items = Array.isArray(b.files) ? b.files : (b.dataBase64 ? [b] : []);
  if (!items.length) return res.status(400).json({ error: 'Choose at least one file to attach.' });
  const out = await drawAttachments.attach(appId, ref, items, { by: { kind: 'borrower', id: me(req) }, supports: 'Added by the borrower' });
  if (!out.added.length) return res.status(400).json({ error: out.skipped[0] ? `${out.skipped[0].what}: ${out.skipped[0].reason}` : 'Nothing could be attached.', ...out });
  res.json({ ok: true, ...out });
});

// ---- GET /draws/:appId/findings — inspection findings delivered for this file ----
router.get('/draws/:appId/findings', async (req, res) => {
  if (!(await ownsApp(req, req.params.appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    // The ONE borrower-safe findings load (shared with the TPO surface). Photos are served through
    // the borrower's OWN per-finding reply_token so an <img>/<video> tag works without an auth header
    // and never breaks when Sitewire's pre-signed link expires; the module never returns the token
    // itself. (The TPO surface passes a firm-scoped media URL instead — the reply_token, which ALSO
    // permits accept/dispute, must never reach a read-only broker.)
    const out = await borrowerSafeDraws.loadDrawFindings(db, req.params.appId, {
      photoUrl: (f, m) => (f.reply_token ? `/api/public/draw-findings/${f.reply_token}/media/${m.id}` : null),
    });
    res.json({ findings: out });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- POST /findings/:findingId/accept — borrower accepts (IN PILOT) → starts the wire SLA ----
router.post('/findings/:findingId/accept', async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await ownsApp(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  if (f.status === 'accepted') return res.json({ ok: true, already: true, wire_due_at: f.wire_due_at });
  if (f.status !== 'delivered') return res.status(409).json({ error: 'these results are not awaiting your acceptance' });
  const hours = await wireTurnaroundHours();
  const upd = (await db.query(
    `UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='portal', wire_due_at=now() + ($2 || ' hours')::interval, updated_at=now()
      WHERE id=$1 AND status='delivered' RETURNING wire_due_at`, [f.id, String(hours)])).rows[0];
  if (!upd) return res.status(409).json({ error: 'already handled' });
  // ONE definition of the "approved" notice, shared with the emailed link and the broker surface —
  // it names the draw and the money, and says WHERE they pressed the button (owner-reported
  // 2026-08-21). The draw coordinator reaches it through the 'draws' loop-in in notify.js, which is
  // what was missing: they are not an assignee, so this fan-out never reached them.
  await require('../sitewire/draw-accepted-notice')
    .notifyDrawAccepted(db, f, 'portal', { wireDueAt: upd.wire_due_at });
  res.json({ ok: true, wire_due_at: upd.wire_due_at });
});

// ---- POST /findings/:findingId/dispute — borrower disputes per line (evidence + desired amount) ----
router.post('/findings/:findingId/dispute', async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await ownsApp(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  if (f.status === 'accepted') return res.status(409).json({ error: 'you already accepted these results' });
  if (f.status === 'resolved') return res.status(409).json({ error: 'these results have already been reviewed and resolved' }); // audit F4 — resolved is terminal
  // cap the number of lines so a giant body can't fan out into hundreds of thousands of sequential
  // queries on one pooled connection (authenticated DoS). A real draw never has anywhere near 200 lines.
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).slice(0, 200);
  if (!lines.length) return res.status(400).json({ error: 'a dispute must name at least one line' });
  // Validate + store any photo evidence FIRST (into durable storage), collecting the line changes,
  // then flip the finding status with a guarded UPDATE and only write the lines if that transition
  // won (audit MEDIUM): a concurrent accept flips the finding to 'accepted', our guarded UPDATE
  // affects 0 rows → 409, and no dispute lines are orphaned on a releasing finding. (Evidence bytes
  // stored before a lost race are just unused blobs — harmless.)
  const updates = [];
  for (const ln of lines) {
    if (!/^\d{1,18}$/.test(String(ln.line_id))) continue;   // 1..18 digits stays in bigint range (a 19+-digit id would 22003 the lookup as a 500)
    const owned = (await db.query(`SELECT id, requested_cents FROM draw_finding_lines WHERE id=$1 AND finding_id=$2 AND retired_at IS NULL`, [ln.line_id, f.id])).rows[0];
    if (!owned) continue;
    let desired = ln.desired_cents == null ? null : Math.round(Number(ln.desired_cents));
    if (desired != null && (!Number.isFinite(desired) || desired < 0 || desired > Number(owned.requested_cents))) desired = null; // never guess an out-of-range amount
    const evidence = await normalizeDisputeMedia(ln.media);   // durable stored copies, GPS-stripped
    updates.push({ line_id: ln.line_id, desired, note: ln.note ? String(ln.note).slice(0, 2000) : null, evidence });
  }
  if (!updates.length) return res.status(400).json({ error: 'no valid dispute lines' });
  const flipped = (await db.query(`UPDATE draw_findings SET status='disputed', disputed_at=now(), disputed_via='portal', updated_at=now() WHERE id=$1 AND status='delivered' RETURNING id`, [f.id])).rows[0];
  if (!flipped) return res.status(409).json({ error: 'these results are no longer awaiting your response' });
  for (const u of updates) {
    await db.query(
      `UPDATE draw_finding_lines SET dispute_status='open', dispute_desired_cents=$2, dispute_note=$3, dispute_media=$4, updated_at=now() WHERE id=$1`,
      [u.line_id, u.desired, u.note, u.evidence.length ? F.jsonbText(u.evidence) : null]);
  }
  const count = updates.length;
  await notify.notifyAppStaff(f.application_id, { type: 'draw_disputed', title: 'Borrower disputed a draw', badge: { text: 'Disputed', tone: 'action' },
    drawTag: await drawLabel.drawTagForRef(db, f.application_id, { sitewireDrawId: f.sitewire_draw_id }),
    body: `The borrower disputed ${count} item(s) on their draw results and provided evidence. A draw coordinator needs to review.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, disputed_lines: count });
});

// ---- GET /draws/:appId/report — the borrower's OWN branded inspection report (PDF, always borrower-safe) ----
// mode is HARD-FORCED to 'borrower' (a borrower can never obtain the staff copy). ?drawId=N → that draw;
// omitted → the whole-project report. Idempotent + cached by the same version-hashed filename as the staff
// route; the stored copy is visibility='borrower'. own-file only + per-draw IDOR.
router.get('/draws/:appId/report', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const drawId = /^\d{1,18}$/.test(String(req.query.drawId || '')) ? req.query.drawId : null; // 1..18 digits stays in bigint range (a 19+-digit id would 22003 the ownership query as a 500, not a clean 404)
  if (drawId) {
    const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
    if (!own.rowCount) return res.status(404).json({ error: 'That draw was not found on your file.' });
  }
  try {
    /* ONE BUILDER, NOT A SECOND COPY OF IT. This route used to inline its own
       load → attach photos → render → store sequence, byte-for-byte the same work
       `buildOrGetReportDoc` does. The copy is why the borrower path did not get the
       build coalescing added for the staff path (owner-reported 2026-08-23: the
       report "takes a very long time, and sometimes it's not even opening" — two
       concurrent synchronous PDF renders holding the event loop). It also silently
       dropped the `photosOmitted` count the shared builder puts ON the report, so a
       borrower's copy could omit photos and say nothing about it.

       `mode` is still HARD-FORCED to 'borrower' here — a borrower can never obtain
       the staff copy — and the caller cannot influence it. */
    const scope = drawId ? 'draw' : 'project';
    const r = await drawReport.buildOrGetReportDoc(appId, { sitewireDrawId: drawId, scope, mode: 'borrower' });
    if (!r || !r.doc) return res.status(404).json({ error: 'Your inspection report isn’t ready yet — it appears once your draw results are in.' });
    return serveDocument(res, r.doc, { inline: true });
  } catch (e) { res.status(500).json({ error: 'Could not build your report right now — please try again shortly.' }); }
});

/* IS IT READY? — the cheap probe the borrower's screen asks on the click so it can
   show "building your report" with real progress instead of a blank browser tab
   (owner-reported 2026-08-23). Same shape and the same hard-forced borrower mode as
   the report itself; touches no photo byte and runs no renderer. */
router.get('/draws/:appId/report/status', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const drawId = /^\d{1,18}$/.test(String(req.query.drawId || '')) ? req.query.drawId : null;
  if (drawId) {
    const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
    if (!own.rowCount) return res.status(404).json({ error: 'That draw was not found on your file.' });
  }
  try {
    const st = await drawReport.reportStatus(appId, { sitewireDrawId: drawId, scope: drawId ? 'draw' : 'project', mode: 'borrower' });
    if (st && st.exists === false) st.reason = 'Your inspection report isn’t ready yet — it appears once your draw results are in.';
    return res.json(st);
  } catch (e) { return res.status(500).json({ error: 'Could not check your report right now — please try again shortly.' }); }
});

// ---- POST /draws/:appId/change-request — borrower proposes a Scope-of-Work change ----
router.post('/draws/:appId/change-request', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const proposedPayload = req.body.proposed_payload;
  if (!proposedPayload || !proposedPayload.state) return res.status(400).json({ error: 'A proposed Scope of Work is required.' });
  try {
    const a = (await db.query(`SELECT status FROM applications WHERE id=$1`, [appId])).rows[0];
    const rollup = await rollupMod.loadRollup(db, appId);
    // Reconcile the proposed explosion to the frozen budget (same target the crosswalk was reconciled
    // to at birth) so a ≤$1 rounding drift can't make a genuine net-zero move read as non-net-zero.
    const rawEx = M.explodeSow(proposedPayload.state, {});
    const budgetCents = Number(rollup && rollup.project && rollup.project.budget) || 0;
    const ex = budgetCents > 0 ? M.reconcileToBudget(rawEx, budgetCents) : rawEx;
    const cells = rollupMod.buildReallocationCells(rollup, ex.items); // per-unit on multi-unit lines (audit F3)
    const phase = String(a && a.status) === 'funded' ? 'after_ctc' : 'before_ctc';
    let vpct = 10; try { const v = (await db.query(`SELECT value FROM sitewire_settings WHERE key='variance_pct'`)).rows[0]; vpct = Number(v && v.value) || 10; } catch (_) {}
    const plan = planReallocation(cells, { phase, variancePct: vpct });
    const cr = (await db.query(
      `INSERT INTO change_requests (application_id, field, field_label, old_value, new_value, reason, status, requested_by_kind, requested_by_id)
       VALUES ($1,'sow_reallocation','Scope of Work reallocation',$2,$3,$4,'pending','borrower',$5) RETURNING id`,
      [appId, JSON.stringify(cells.map((c) => ({ key: c.key, label: c.label, cents: c.budget_cents }))), JSON.stringify(cells.map((c) => ({ key: c.key, label: c.label, cents: c.new_cents }))), req.body.reason ? String(req.body.reason).slice(0, 2000) : null, me(req)])).rows[0];
    await db.query(
      `INSERT INTO sow_change_request_details (change_request_id, application_id, proposed_payload, deltas, net_zero, after_ctc, needs_capital_partner, capital_partner_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cr.id, appId, F.jsonbText(proposedPayload), F.jsonbText(plan.cells), plan.totals.net_zero, phase === 'after_ctc', plan.needs_capital_partner, plan.needs_capital_partner ? 'pending' : null]);
    await notify.notifyAppStaff(appId, { type: 'sow_change_request', title: 'Borrower requested a budget change', badge: { text: 'Review needed', tone: 'gold' },
      body: 'The borrower proposed a Scope-of-Work change. Review it on the file before it flows to draws.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    // borrower-safe: never echo capital-partner review status detail back to the borrower
    res.json({ ok: true, submitted: true, net_zero: plan.totals.net_zero });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

async function wireTurnaroundHours() {
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='wire_turnaround_hours'`); const h = Number(r.rows[0] && r.rows[0].value); return Number.isFinite(h) && h > 0 ? h : 48; } catch (_) { return 48; }
}

module.exports = router;
