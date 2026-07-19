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
const router = express.Router();
const db = require('../db');
const { requireAuth, requireBorrower } = require('../auth');
const rollupMod = require('../sitewire/rollup');
const { planReallocation } = require('../sitewire/reallocation');
const M = require('../sitewire/mapper');
const notify = require('../lib/notify');
const borrowerSafe = require('../lib/borrower-safe');

router.use(requireAuth, requireBorrower);
const me = (req) => req.actor.id;
const OWN_FILE_SQL = (alias, p) => {
  const a = alias ? alias + '.' : '';
  return `(${a}borrower_id=${p} OR ${a}co_borrower_id=${p}` +
    ` OR ${a}borrower_id IN (SELECT linked_borrower_id FROM borrower_profile_links WHERE borrower_id=${p})` +
    ` OR ${a}co_borrower_id IN (SELECT linked_borrower_id FROM borrower_profile_links WHERE borrower_id=${p}))`;
};
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
              d.submitted_at, d.approved_at, a.property_address->>'oneLine' AS address,
              (SELECT status FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS findings_status,
              (SELECT id FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS finding_id
         FROM sitewire_draws d JOIN applications a ON a.id=d.application_id
        WHERE a.deleted_at IS NULL AND (${OWN_FILE_SQL('a', '$1')})
        ORDER BY d.updated_at DESC NULLS LAST LIMIT 200`, [me(req)])).rows;
    res.json({ draws: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /draws/:appId/rollup — the unified per-line picture (borrower-safe) ----
router.get('/draws/:appId/rollup', async (req, res) => {
  if (!(await ownsApp(req, req.params.appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    let sowState = null;
    try { const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [req.params.appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
    const rollup = await rollupMod.loadRollup(db, req.params.appId, { sowState });
    for (const l of rollup.lines) l.label = scrub(l.label);
    res.json({ rollup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /draws/:appId/findings — inspection findings delivered for this file ----
router.get('/draws/:appId/findings', async (req, res) => {
  if (!(await ownsApp(req, req.params.appId))) return res.status(403).json({ error: 'forbidden' });
  try {
  const findings = (await db.query(
    `SELECT id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at, wire_due_at
       FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC`, [req.params.appId])).rows;
  const out = [];
  for (const f of findings) {
    const lines = (await db.query(
      `SELECT id, sow_line_key, unit_index, name, requested_cents, approved_cents, not_approved_cents, inspector_comments, lender_comments, photo_count, video_count, media, dispute_status, dispute_desired_cents, dispute_note
         FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows
      // scrub every free-text field a capital-partner name could hide in — including each inspection
      // media NOTE (was leaking unscrubbed to the borrower). Keep the photo/video src (inspection evidence).
      .map((l) => ({
        ...l,
        name: scrub(l.name),
        inspector_comments: scrub(l.inspector_comments),
        lender_comments: scrub(l.lender_comments),
        media: Array.isArray(l.media) ? l.media.map((m) => (m && typeof m === 'object' ? { ...m, note: scrub(m.note) } : m)) : l.media,
      }));
    out.push({ ...f, lines });
  }
  res.json({ findings: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  await notify.notifyAppStaff(f.application_id, { type: 'draw_accepted', title: 'Borrower accepted a draw',
    body: `The borrower accepted the inspection results — the release is due by ${new Date(upd.wire_due_at).toLocaleString('en-US')}.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, wire_due_at: upd.wire_due_at });
});

// ---- POST /findings/:findingId/dispute — borrower disputes per line (evidence + desired amount) ----
router.post('/findings/:findingId/dispute', async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await ownsApp(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  if (f.status === 'accepted') return res.status(409).json({ error: 'you already accepted these results' });
  if (f.status === 'resolved') return res.status(409).json({ error: 'these results have already been reviewed and resolved' }); // audit F4 — resolved is terminal
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: 'a dispute must name at least one line' });
  let count = 0;
  for (const ln of lines) {
    if (!/^\d+$/.test(String(ln.line_id))) continue;
    const owned = (await db.query(`SELECT id, requested_cents FROM draw_finding_lines WHERE id=$1 AND finding_id=$2`, [ln.line_id, f.id])).rows[0];
    if (!owned) continue;
    let desired = ln.desired_cents == null ? null : Math.round(Number(ln.desired_cents));
    if (desired != null && (!Number.isFinite(desired) || desired < 0 || desired > Number(owned.requested_cents))) desired = null; // never guess an out-of-range amount
    await db.query(
      `UPDATE draw_finding_lines SET dispute_status='open', dispute_desired_cents=$2, dispute_note=$3, dispute_media=$4, updated_at=now() WHERE id=$1`,
      [ln.line_id, desired, ln.note ? String(ln.note).slice(0, 2000) : null, ln.media ? JSON.stringify(ln.media) : null]);
    count++;
  }
  if (!count) return res.status(400).json({ error: 'no valid dispute lines' });
  await db.query(`UPDATE draw_findings SET status='disputed', disputed_at=now(), updated_at=now() WHERE id=$1`, [f.id]);
  await notify.notifyAppStaff(f.application_id, { type: 'draw_disputed', title: 'Borrower disputed a draw',
    body: `The borrower disputed ${count} item(s) on their draw results and provided evidence. A draw coordinator needs to review.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, disputed_lines: count });
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
      [cr.id, appId, JSON.stringify(proposedPayload), JSON.stringify(plan.cells), plan.totals.net_zero, phase === 'after_ctc', plan.needs_capital_partner, plan.needs_capital_partner ? 'pending' : null]);
    await notify.notifyAppStaff(appId, { type: 'sow_change_request', title: 'Borrower requested a budget change',
      body: 'The borrower proposed a Scope-of-Work change. Review it on the file before it flows to draws.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    // borrower-safe: never echo capital-partner review status detail back to the borrower
    res.json({ ok: true, submitted: true, net_zero: plan.totals.net_zero });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function wireTurnaroundHours() {
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='wire_turnaround_hours'`); const h = Number(r.rows[0] && r.rows[0].value); return Number.isFinite(h) && h > 0 ? h : 48; } catch (_) { return 48; }
}

module.exports = router;
