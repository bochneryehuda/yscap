'use strict';
/**
 * Sitewire reconcile (pull) — polls Sitewire for OUR properties only (only-ours rule)
 * and mirrors draws / requests / events into PILOT, plus keeps the capital-partner
 * directory and the staff<->Sitewire-user map fresh. Read-only against Sitewire.
 *
 * draw_events come back UNSORTED, so submitted_at/approved_at are derived by sorting
 * on occurred_at (never array order). Inbound is scoped to properties we created — a
 * property with no link row is structurally invisible.
 */
const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const T = require('./transforms');
const rollupMod = require('./rollup');
const risk = require('./risk');
const M = require('./mapper');

/**
 * Auto-adopt Sitewire-seeded MANDATORY MEDIA items that PILOT never pushed.
 * Owner-reported 2026-07-21: Sitewire seeds mandatory items like "Video Walkthrough"
 * and "External Pictures" on every draw. PILOT's crosswalk doesn't have them, so a
 * draw request against them lands in rollup.unknown → parked as
 * sitewire_unknown_draw_line ("reconcile by hand"). Root fix: bind those $0
 * name-recognized media job items into the crosswalk as sitewire-seeded media
 * anchors so the reconcile is automatic, exactly like PILOT's own media anchors.
 *
 * Only adopts an item that is BOTH structurally media (name matches
 * isMandatoryMediaName) AND carries no money (budgeted_cents === 0) — a real
 * budget line would never be silently absorbed. Uses sow_line_key
 * `__media__:sw_<jobitemid>` so it can't collide with PILOT's own media keys
 * (__media__:exterior / __media__:video / __media__:video_uN) or with a real
 * SOW cell. Best-effort per row; a failure never breaks the reconcile.
 */
async function adoptSeededMediaItems(appId, budgetId, jobItems) {
  if (!appId || !budgetId || !Array.isArray(jobItems) || !jobItems.length) return { adopted: 0, hydrated: 0 };
  // Owner-reported 2026-07-22 (file 1053 Ella T Grasso Blvd): a crosswalk row for item 1180824 was
  // bound BEFORE PR #551's `ji.name || "Sitewire item <jid>"` fallback shipped, so its `name`
  // column landed NULL. The old `ON CONFLICT DO NOTHING` never re-hydrated it, and the draw desk
  // fell back to the generic "Line 1180824" label instead of Sitewire's "Interior Video Tour".
  // Root fix: read the existing row's name too; UPSERT with `ON CONFLICT DO UPDATE SET name =
  // COALESCE(existing.name, EXCLUDED.name)` — a null name is upgraded on the very next reconcile,
  // and a legitimately-stored name is never overwritten. Also flips is_media_item true if the
  // pre-fix row had it false (a $0 item ALWAYS is media by our semantics).
  const existingRows = (await db.query(
    `SELECT sitewire_job_item_id, name, is_media_item FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_job_item_id IS NOT NULL`,
    [appId])).rows;
  const existingByJid = new Map(existingRows.map((r) => [Number(r.sitewire_job_item_id), r]));
  let adopted = 0, hydrated = 0;
  for (const ji of jobItems) {
    if (!ji || ji.id == null) continue;
    const jid = Number(ji.id);
    if (Number(ji.budgeted_cents || 0) !== 0) continue;
    const cur = existingByJid.get(jid);
    if (cur) {
      // Already bound. If Sitewire now has a real name AND our stored name is null/generic, upgrade
      // it in place (also flag as media if it wasn't). This is the backfill path that unbreaks
      // rows adopted before PR #551's name fallback shipped.
      const sitewireName = ji.name ? String(ji.name) : null;
      const stored = cur.name ? String(cur.name) : '';
      const isGeneric = !stored || /^Sitewire item \d+$/.test(stored);
      if (!sitewireName && !cur.is_media_item) continue; // nothing to upgrade
      try {
        await db.query(
          `UPDATE sitewire_job_item_links
              SET name = CASE WHEN $3::text IS NOT NULL AND $4::boolean THEN $3::text ELSE name END,
                  is_media_item = true,
                  updated_at = now()
            WHERE application_id=$1 AND sitewire_job_item_id=$2`,
          [appId, jid, sitewireName, isGeneric]);
        hydrated++;
      } catch (_) { /* best-effort */ }
      continue;
    }
    // Owner-directed 2026-07-22 (file 1053 Ella T Grasso Blvd, draw #1): Sitewire seeds a
    // WHOLE TEMPLATE of $0 items on every property (Video Walkthrough, Exterior Photos, per-line
    // photo requirements, and more) — some carry `mandatory:true`, some don't, and their names
    // vary by Sitewire template. The prior "media-name OR mandatory:true" rule left a chunk of
    // legitimately-empty items unbound, showing on the draw desk as generic "Line 1180837" and
    // triggering risk.js unknown_line high-risk warnings on every reconcile.
    //
    // Root-cause enhancement: adopt EVERY $0 item Sitewire holds, regardless of name or the
    // mandatory flag. A $0 item has NO financial risk — it can't be over-drawn, it can't shift a
    // budget, and its only role is a photo/video/inspection gate on draws. The `is_media_item`
    // flag stays true so the rollup keeps excluding it from budget math (matching PILOT's own
    // media anchors). Uses Sitewire's authoritative name so the draw desk shows the friendly
    // label ("Interior Video Tour") instead of the generic id fallback.
    try {
      await db.query(
        `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sow_line_key, section_token, unit_index, sitewire_job_item_id, name, budgeted_cents, is_media_item, state, last_pushed_at, updated_at)
         VALUES ($1,$2,$3,'media',NULL,$4,$5,0,true,'live',NULL,now())
         ON CONFLICT (application_id, sow_line_key, section_token) DO UPDATE SET
           name = CASE WHEN EXCLUDED.name IS NOT NULL AND (sitewire_job_item_links.name IS NULL OR sitewire_job_item_links.name ~ '^Sitewire item [0-9]+$') THEN EXCLUDED.name ELSE sitewire_job_item_links.name END,
           is_media_item = true, updated_at = now()`,
        [appId, budgetId, `__media__:sw_${jid}`, jid, ji.name ? String(ji.name) : null]);
      adopted++;
    } catch (_) { /* best-effort — a bad row must not stop the reconcile */ }
  }
  return { adopted, hydrated };
}

// ---- capital-partner directory cache (+ which are on our lender) ----
async function syncCapitalPartners() {
  const list = await client.listCapitalPartners();
  const onOurLender = new Set();
  try { const lender = await client.getLender(cfg.sitewireLenderId); (lender.capital_partners || []).forEach((c) => onOurLender.add(c.id)); } catch (_) {}
  for (const c of (list || [])) {
    await db.query(
      `INSERT INTO sitewire_capital_partners (sitewire_id, name, on_our_lender, synced_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (sitewire_id) DO UPDATE SET name=EXCLUDED.name, on_our_lender=EXCLUDED.on_our_lender, synced_at=now()`,
      [c.id, String(c.name || '').trim(), onOurLender.has(c.id)]);
  }
  return { count: (list || []).length };
}

// ---- match staff_users.email to the lender's Sitewire users -> sitewire_user_id ----
async function syncStaffUsers() {
  let lender;
  try { lender = await client.getLender(cfg.sitewireLenderId); } catch (_) { return { matched: 0 }; }
  let matched = 0;
  for (const u of (lender.users || [])) {
    if (!u.email) continue;
    const r = await db.query(`UPDATE staff_users SET sitewire_user_id=$1, updated_at=now() WHERE lower(email)=lower($2) AND (sitewire_user_id IS NULL OR sitewire_user_id<>$1)`, [u.id, u.email]);
    matched += r.rowCount;
  }
  return { matched };
}

function deriveTimes(events) {
  const ev = (events || []).slice().sort((a, b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')));
  let submitted = null, approved = null;
  for (const e of ev) {
    if (!submitted && (e.event === 'created' || e.event === 'submit' || e.event === 'delegate_submit')) submitted = e.occurred_at;
    if (e.event === 'lender_approve') approved = e.occurred_at;
  }
  return { submitted: submitted && T.isoDay(submitted), approved: approved && T.isoDay(approved) };
}

// ---- reconcile ONE file's draws (scoped to a property WE created) ----
// ---- Bidirectional Phase 1: react to inbound Sitewire changes ----
// Append-only audit of a value the poll saw change on the Sitewire side (the analog of ClickUp's
// clickup_pull_field_change). Best-effort — a logging failure never affects the reconcile.
async function recordInboundChange(appId, drawId, entity, entityId, field, oldV, newV, reacted) {
  try {
    await db.query(
      `INSERT INTO sitewire_pull_field_change (application_id, sitewire_draw_id, entity, entity_id, field, old_value, new_value, reacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [appId, drawId, entity, entityId, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), !!reacted]);
  } catch (_) { /* best-effort audit */ }
}

// The inbound status transitions worth telling the team about. Keyed on the NEW Sitewire status;
// intermediate/no-op statuses are intentionally omitted so the poll doesn't turn into noise.
const REACT_STATUS = {
  pending: { title: 'A draw was inspected — ready for your review', tone: 'gold',
    body: (n, addr) => `Draw #${n} for ${addr} was inspected in Sitewire and is awaiting your review. Set the approved amounts and approve it, or deliver the findings to the borrower.` },
  pending_capital_partner: { title: 'A draw is awaiting capital-partner approval', tone: 'gold',
    body: (n, addr) => `Draw #${n} for ${addr} is now awaiting capital-partner approval in Sitewire.` },
  approved: { title: 'A draw was approved in Sitewire', tone: 'positive',
    body: (n, addr) => `Draw #${n} for ${addr} was approved in Sitewire. You can deliver the inspection findings to the borrower and record the release.` },
};

// Given the prior mirror row and the freshly-pulled draw, notify the team of a genuine inbound
// transition and audit the change. GO-FORWARD: a draw seen for the first time after the watermark
// was added (or on a file's first-ever reconcile) is BASELINED silently — we only react to changes
// that happen while PILOT is watching, never to history. Staff-facing (notifyAppStaff) — the borrower
// keeps getting the designed findings/release emails from the human deliver/release flows, unchanged.
async function reactToInboundDraw(appId, draw, prev, firstReconcile, addrText) {
  const notify = require('../lib/notify');
  const drawId = draw.sitewire_draw_id;
  const newStatus = draw.status || null;
  const newAppr = Number(draw.total_approved_cents) || 0;

  // A draw with no prior mirror row. ATOMIC claim: set the watermark only if still unset, and notify
  // only if THIS pass won it — so two overlapping reconcile passes can never double-notify (audit LOW-2).
  // If Sitewire returned this draw with a NULL status (a rare drafting/transition state we can't
  // interpret), DON'T commit the watermark yet — leave status_synced NULL AND rely on the schema-
  // stamped first_seen_at to say "PILOT is watching this row" (audit finding 2026-07-21). The next
  // poll that sees a real status takes the legacy branch below, which now distinguishes
  // pre-migration legacy (first_seen_at IS NULL → silent baseline) from a first-status arrival on
  // a row PILOT already knows about (first_seen_at set → notify the coordinator).
  if (!prev) {
    if (newStatus == null) { await recordInboundChange(appId, drawId, 'draw', drawId, 'first_seen_no_status', null, null, false); return; }
    const won = (await db.query(`UPDATE sitewire_draws SET status_synced=$2 WHERE sitewire_draw_id=$1 AND status_synced IS NULL RETURNING sitewire_draw_id`, [drawId, newStatus])).rowCount === 1;
    if (firstReconcile) { await recordInboundChange(appId, drawId, 'draw', drawId, 'baseline', null, newStatus, false); return; }
    // A property PILOT created can only gain a draw AFTER we set it up, so a first-seen draw on an
    // already-reconciled file is genuinely a new borrower submission — tell the coordinator.
    if (won) {
      await recordInboundChange(appId, drawId, 'draw', drawId, 'new_draw', null, newStatus, true);
      await notify.notifyAppStaff(appId, {
        type: 'draw_inbound', title: 'A new draw request came in', badge: { text: 'New draw', tone: 'gold' },
        body: `A new draw request (Draw #${draw.number == null ? '—' : draw.number}) came in for ${addrText} through Sitewire. Review it and start the inspection.`,
        applicationId: appId, link: `/internal/app/${appId}/draws` }).catch(() => {});
    }
    return;
  }

  // status_synced is NULL — two cases distinguished by first_seen_at (db/239):
  //   (a) LEGACY row (first_seen_at IS NULL): pre-migration, we didn't know about the row when
  //       whatever transition happened. Silent baseline — never notify for history (go-forward
  //       cutover, unchanged from before).
  //   (b) FIRST-STATUS ARRIVAL (first_seen_at IS NOT NULL): PILOT has been watching the row
  //       (previously it had null status; now a real status arrived). This is the transition the
  //       null-status skip above deferred — treat it as a genuine inbound and notify per REACT_STATUS.
  //   In both cases: nothing to do while newStatus is still null.
  if (prev.status_synced == null) {
    if (newStatus == null) return;
    const isLegacy = prev.first_seen_at == null;
    const won = (await db.query(`UPDATE sitewire_draws SET status_synced=$2 WHERE sitewire_draw_id=$1 AND status_synced IS NULL RETURNING sitewire_draw_id`, [drawId, newStatus])).rowCount === 1;
    if (isLegacy || firstReconcile) {
      await recordInboundChange(appId, drawId, 'draw', drawId, 'baseline', prev.status, newStatus, false);
      return;
    }
    if (won) {
      const r = REACT_STATUS[newStatus];
      await recordInboundChange(appId, drawId, 'draw', drawId, 'first_status', null, newStatus, !!r);
      if (r) {
        await notify.notifyAppStaff(appId, {
          type: 'draw_inbound', title: r.title, badge: { text: 'Sitewire update', tone: r.tone },
          body: r.body(draw.number == null ? '—' : draw.number, addrText),
          applicationId: appId, link: `/internal/app/${appId}/draws` }).catch(() => {});
      }
    }
    return;
  }

  // A real inbound status transition PILOT has not reacted to yet. Advance the watermark ATOMICALLY and
  // only react if this pass won the advance (concurrency-safe). `reacted` reflects whether we actually
  // sent a notification (only the curated REACT_STATUS transitions notify).
  if (newStatus && newStatus !== prev.status_synced) {
    const won = (await db.query(`UPDATE sitewire_draws SET status_synced=$2 WHERE sitewire_draw_id=$1 AND status_synced IS DISTINCT FROM $2 RETURNING sitewire_draw_id`, [drawId, newStatus])).rowCount === 1;
    if (won) {
      const r = REACT_STATUS[newStatus];
      await recordInboundChange(appId, drawId, 'draw', drawId, 'status', prev.status_synced, newStatus, !!r);
      if (r) {
        await notify.notifyAppStaff(appId, {
          type: 'draw_inbound', title: r.title, badge: { text: 'Sitewire update', tone: r.tone },
          body: r.body(draw.number == null ? '—' : draw.number, addrText),
          applicationId: appId, link: `/internal/app/${appId}/draws` }).catch(() => {});
      }
    }
  }

  // An approved-amount change is always audited. G-FIND-MATCH (Phase 2): if PILOT already RELEASED
  // money for this draw, the wire went out against the OLD approved amount — a Sitewire-side change to
  // it is now a financial discrepancy. Park a TWO-SIDED alert + notify; money already moved, so PILOT
  // NEVER auto-corrects it (the coordinator reconciles the wire by hand).
  if (Number(prev.total_approved_cents || 0) !== newAppr) {
    let released = null;
    try { released = (await db.query(
      `SELECT approved_cents FROM draw_disbursements WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw' AND funded_status='released' ORDER BY created_at LIMIT 1`, [appId, drawId])).rows[0] || null; } catch (_) {}
    await recordInboundChange(appId, drawId, 'draw', drawId, released ? 'release_drift' : 'total_approved_cents', String(prev.total_approved_cents || 0), String(newAppr), !!released);
    if (released) {
      const usd0 = (c) => '$' + Math.round(Number(c || 0) / 100).toLocaleString('en-US');
      try {
        await require('./orchestrator').park({
          appId, dedupe: `reldrift:${drawId}`,
          reason: `sitewire_release_drift: Draw #${draw.number == null ? '—' : draw.number} was already released at ${usd0(released.approved_cents)}, but Sitewire now shows an approved amount of ${usd0(newAppr)}. The wire already went out — reconcile it by hand (PILOT will not change a released amount automatically).`,
          pilotValue: String(released.approved_cents), sitewireValue: String(newAppr),
        });
      } catch (_) {}
    }
  }
}

// ---- Bidirectional Phase 2: periodic budget drift re-verify ----
// Re-read the managed budget from Sitewire and compare each bound line + the total to what PILOT
// pushed (sitewire_job_item_links). A disagreement means a human edited the budget directly in
// Sitewire (the doc's specified-but-unimplemented PILOT-owned-field drift). Park a TWO-SIDED review
// so the coordinator can RESTORE PILOT's budget or ACCEPT Sitewire's. Throttled to hourly per file.
async function verifyBudgetDrift(appId, budgetId) {
  if (!budgetId) return { checked: false };
  // Match the read-after-write's canonical filter EXACTLY (orchestrator.js pushBudgetInner): only LIVE
  // bound lines for THIS budget. A deleted SOW line keeps its old nonzero budgeted_cents on the crosswalk
  // (only _destroy'd in Sitewire), so summing all links would compute expected = live + deleted while
  // Sitewire's total is live-only → a recurring FALSE drift alert (audit HIGH-1).
  const links = (await db.query(
    `SELECT sitewire_job_item_id, budgeted_cents FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_budget_id=$2 AND state='live' AND sitewire_job_item_id IS NOT NULL`, [appId, budgetId])).rows;
  if (!links.length) return { checked: false };
  const expById = new Map(links.map((l) => [Number(l.sitewire_job_item_id), Number(l.budgeted_cents) || 0]));
  const expectedTotal = links.reduce((s, l) => s + (Number(l.budgeted_cents) || 0), 0);
  let budget;
  try { budget = await client.getBudget(budgetId); } catch (_) { return { checked: false }; }
  const items = Array.isArray(budget.job_items) ? budget.job_items : [];
  // Audit finding A-6 (2026-07-21): a Sitewire getBudget that returns `job_items: []` (or omits
  // `total_budgeted_cents` and the items sum to 0) is a NO-DATA / transient shape — probably a
  // partial API response or a serialization edge case, NOT a real drift. Treating it as drift used
  // to park `sitewire_budget_drift` comparing observed=0 vs expected=full-crosswalk on every hourly
  // run, generating a spurious two-sided review the coordinator kept dismissing. Skip when the API
  // gave us nothing to compare against; the next verify hour picks it up cleanly.
  if (items.length === 0) return { checked: true, skipped: 'no_job_items' };
  const observedTotal = Number(budget.total_budgeted_cents != null ? budget.total_budgeted_cents
    : items.reduce((s, i) => s + (Number(i.budgeted_cents) || 0), 0));
  let driftLines = 0;
  for (const it of items) { const exp = expById.get(Number(it.id)); if (exp != null && Number(it.budgeted_cents) !== exp) driftLines++; }
  if (observedTotal === expectedTotal && driftLines === 0) return { checked: true, ok: true };
  const usd0 = (c) => '$' + Math.round(Number(c || 0) / 100).toLocaleString('en-US');
  await recordInboundChange(appId, null, 'budget', budgetId, 'budget_drift', String(expectedTotal), String(observedTotal), true);
  try {
    await require('./orchestrator').park({
      appId, dedupe: 'budgetdrift',
      reason: `sitewire_budget_drift: the construction budget in Sitewire (${usd0(observedTotal)}) no longer matches what PILOT set (${usd0(expectedTotal)})${driftLines ? ` — ${driftLines} line(s) differ` : ''}. Someone may have edited it directly in Sitewire. Review, then restore PILOT's budget or accept Sitewire's.`,
      pilotValue: String(expectedTotal), sitewireValue: String(observedTotal),
    });
  } catch (_) {}
  return { checked: true, ok: false, driftLines };
}

async function reconcileOne(appId) {
  const link = (await db.query(`SELECT sitewire_property_id, budget_version, last_reconciled_at, last_budget_verified_at FROM sitewire_property_links WHERE application_id=$1 AND sitewire_property_id IS NOT NULL AND matched_by='created'`, [appId])).rows[0];
  if (!link) return { skipped: 'not linked' };
  let prop;
  try { prop = await client.getProperty(link.sitewire_property_id); } catch (e) { return { error: e.message }; }
  const draws = (prop.budget && prop.budget.draws) || [];
  // Owner-directed 2026-07-22 (deep root cause investigation for file 1053 Ella T Grasso Blvd item
  // 1180824 "Interior Video Tour"): per the Sitewire API v2 swagger, GET /properties/:id returns a
  // `budget` sub-object with ONLY {id, draw_eligible, funding_ratio, funding_threshold_cents, draws}
  // — it does NOT include `job_items`. The full job-item list is exposed by GET /budgets/:id (used
  // by orchestrator.pushBudgetInner and verifyBudgetDrift below). Every prior reconcile that read
  // `prop.budget.job_items` was receiving `undefined` → empty array — so:
  //   • adoptSeededMediaItems has been silently no-op since PR #546 (never bound sw-seeded media).
  //   • the propJobNames friendly-name hydration map was always empty.
  // The 5 named items on file 1053 got their names bound at BIRTH via pushBudgetInner (which does
  // fetch getBudget correctly), so they read fine. Item 1180824 ("Interior Video Tour" without a
  // Unit prefix) is a Sitewire template item PILOT never pushed — it needed adoptSeededMediaItems
  // to bind it. That code never ran because it always saw an empty list. Fix: fetch getBudget ONCE
  // per reconcile and use its job_items in both places. One extra GET per file per poll cycle is
  // fine (verifyBudgetDrift already makes the same call hourly on the same read path).
  let budgetJobItems = [];
  if (prop.budget && prop.budget.id) {
    try { const b = await client.getBudget(prop.budget.id); if (Array.isArray(b.job_items)) budgetJobItems = b.job_items; }
    catch (_) { /* best-effort — a transient getBudget failure just skips this pass's hydrate/adopt */ }
  }
  // Bidirectional Phase 1: on the file's FIRST reconcile ever, baseline the draw watermarks silently
  // (no notification burst for draws that existed before PILOT started watching); react to changes after.
  const firstReconcile = !link.last_reconciled_at;
  const addr = (await db.query(`SELECT property_address->>'oneLine' AS a FROM applications WHERE id=$1`, [appId])).rows[0];
  const addrText = (addr && addr.a) || 'the property';
  let n = 0;
  for (const d of draws) {
   // A poison draw (null id, bad cents, a constraint violation) must skip to the NEXT draw — not throw
   // out of the whole file's reconcile, which would strand every LATER draw's mirror on that file. Park
   // it (deduped) so it's visible, never silently dropped.
   try {
    // full detail for requests + events
    let full;
    try { full = await client.getDraw(d.id); } catch (_) { full = d; }
    const times = deriveTimes(full.draw_events);
    // Read the PRIOR mirror state BEFORE the upsert overwrites it, so we can tell a real inbound
    // status TRANSITION (a partner approved/released a draw, a borrower submitted one) from a value
    // PILOT already reacted to. Best-effort — a read failure just skips the reaction, never the mirror.
    let prevDraw = null;
    try { prevDraw = (await db.query(`SELECT status, status_synced, total_approved_cents, first_seen_at FROM sitewire_draws WHERE sitewire_draw_id=$1`, [d.id])).rows[0] || null; } catch (_) {}
    await db.query(
      `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, name, status, historical, total_requested_cents, total_approved_cents, coordinator_id, quick_notify_status_id, pdf_src, submitted_at, approved_at, budget_version_at_draw, events, sitewire_updated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
       ON CONFLICT (sitewire_draw_id) DO UPDATE SET status=EXCLUDED.status, total_requested_cents=EXCLUDED.total_requested_cents, total_approved_cents=EXCLUDED.total_approved_cents,
         -- coordinator_id / quick_notify_status_id are draw-DETAIL fields (set via PATCH /draws); the /draws
         -- summary may omit them, so if the per-draw getDraw failed (full=d) EXCLUDED is NULL — COALESCE
         -- so a failed detail read never WIPES a previously-good coordinator / quick-notify value either.
         coordinator_id=COALESCE(EXCLUDED.coordinator_id, sitewire_draws.coordinator_id), quick_notify_status_id=COALESCE(EXCLUDED.quick_notify_status_id, sitewire_draws.quick_notify_status_id),
         -- detail-only columns come from the per-draw getDraw; if that call failed (rate-limit/timeout) they arrive
         -- NULL — COALESCE so a failed detail read never WIPES a good submitted/approved/events/pdf on the desk.
         pdf_src=COALESCE(EXCLUDED.pdf_src, sitewire_draws.pdf_src), submitted_at=COALESCE(EXCLUDED.submitted_at, sitewire_draws.submitted_at), approved_at=COALESCE(EXCLUDED.approved_at, sitewire_draws.approved_at), events=COALESCE(EXCLUDED.events, sitewire_draws.events), sitewire_updated_at=EXCLUDED.sitewire_updated_at, updated_at=now()`,
      [appId, d.id, link.sitewire_property_id, d.number, d.name, d.status, !!d.historical,
       d.total_requested_cents || 0, d.total_approved_cents || 0, full.coordinator_id || d.coordinator_id || null,
       full.quick_notify_status_id || d.quick_notify_status_id || null, full.pdf_src || null,
       times.submitted || null, times.approved || null, link.budget_version || null,
       full.draw_events ? JSON.stringify(full.draw_events) : null, d.updated_at || null]);
    // Owner-directed 2026-07-22 (file 1053 Ella T Grasso Blvd): Sitewire's GET /draws/:id can
    // return each request with `job_item.name === null` while the budget's authoritative job_items
    // list DOES carry the friendly name. The prior code stored the null and the draw desk fell
    // back to "Line 1180837" everywhere. Build a job_item_id → name map from the live budget
    // (fetched above via getBudget — NOT from prop.budget, which per the swagger has no job_items)
    // and hydrate the request name when the request itself omits it. On UPSERT the ON CONFLICT
    // clause refreshes job_item_name only when it lands non-null so a later reconcile that finally
    // sees the friendly name upgrades the earlier row instead of leaving the fallback in.
    const propJobNames = new Map();
    for (const ji of budgetJobItems) { if (ji && ji.id != null && ji.name) propJobNames.set(Number(ji.id), String(ji.name)); }
    // mirror requests — per-row guarded so one poison row can't strand the whole file's mirror
    for (const r of (full.requests || [])) {
      try {
        const jiId = (r.job_item && r.job_item.id) || null;
        const hydratedName = (r.job_item && r.job_item.name)
          || (jiId != null ? propJobNames.get(Number(jiId)) : null)
          || null;
        await db.query(
          `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, job_item_name, requested_cents, approved_cents, lender_comments, inspector_comments, inspection_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (sitewire_request_id) DO UPDATE SET requested_cents=EXCLUDED.requested_cents, approved_cents=EXCLUDED.approved_cents, lender_comments=EXCLUDED.lender_comments, inspector_comments=EXCLUDED.inspector_comments,
             job_item_name=COALESCE(EXCLUDED.job_item_name, sitewire_draw_requests.job_item_name), updated_at=now()`,
          [d.id, r.id, jiId, hydratedName,
           r.requested_cents || 0, r.approved_cents == null ? null : r.approved_cents, r.lender_comments || null, r.inspector_comments || null,
           Array.isArray(r.inspections) ? r.inspections.length : 0]);
      } catch (rowErr) {
        console.warn(`[sitewire] reconcile: skipped a bad request row (draw ${d.id}, request ${r && r.id}): ${db.describeError ? db.describeError(rowErr) : rowErr.message}`);
      }
    }
    // React to any inbound status transition on this draw (notify the team + audit the change).
    // Fully best-effort + self-guarded: it never throws out of the per-draw try, never blocks the mirror.
    try { await reactToInboundDraw(appId, { sitewire_draw_id: d.id, number: d.number, status: d.status, total_approved_cents: d.total_approved_cents || 0 }, prevDraw, firstReconcile, addrText); } catch (_) {}
    n++;
   } catch (drawErr) {
     const emsg = db.describeError ? db.describeError(drawErr) : (drawErr && drawErr.message) || String(drawErr);
     console.warn(`[sitewire] reconcile: skipped a bad draw row (draw ${d && d.id}): ${emsg}`);
     try { await require('./orchestrator').park({ appId, dedupe: `drawrow:${d && d.id}`, reason: `sitewire_reconcile_draw_error: could not mirror Sitewire draw ${d && d.id} — ${String(emsg).slice(0, 200)}. It won't appear on the desk until reconciled by hand.` }); } catch (_) {}
   }
  }
  // Auto-adopt Sitewire-seeded MANDATORY MEDIA items (Video Walkthrough, External Pictures,
  // …) that PILOT never pushed, so a draw against them stops parking as unknown. Runs BEFORE
  // assessAndStoreRisk so rollup.unknown sees the newly-bound ids and never flags them.
  try {
    // Uses budgetJobItems from getBudget (the only endpoint that returns them per the swagger).
    // Reading `prop.budget.job_items` here — as the prior code did — was always undefined/empty,
    // so this call was silently no-op for every file since PR #546. That is the root cause of
    // item 1180824 sitting nameless on the crosswalk: it was never bound at all.
    if (budgetJobItems.length) await adoptSeededMediaItems(appId, prop.budget && prop.budget.id, budgetJobItems);
  } catch (_) { /* best-effort */ }
  await db.query(`UPDATE sitewire_property_links SET last_reconciled_at=now() WHERE application_id=$1`, [appId]);
  // Bidirectional Phase 2: re-verify the managed budget against what PILOT pushed, at most HOURLY per
  // file (the extra getBudget read stays cheap), and never on a file's first reconcile (nothing to
  // drift from yet). Best-effort — a drift check never fails the reconcile.
  try {
    const stale = !link.last_budget_verified_at || (Date.now() - new Date(link.last_budget_verified_at).getTime()) > 3600000;
    // Skip the drift check while a push is pending for this file: the budget is about to change (a Phase 3
    // re-push, a reallocation apply, or a birth push mid-flight), so a comparison now could false-park on a
    // value that's seconds from being corrected (audit LOW-1 mid-write race).
    // Audit finding A-4 (2026-07-21): the sync_queue check only catches op='push_file' jobs, missing
    // INLINE pushes from sow-line-edit.editLine (pushFile), pushJobItemDescription (budget PATCH), and
    // the /repush route. Fix: also try to grab the same `sw-budget:${appId}` advisory lock the push
    // code uses. If we can't get it (someone's mid-push), skip drift. The transaction releases the lock
    // at commit/rollback either way. pg_try_advisory_xact_lock returns true when acquired.
    const queuedPushing = stale ? (await db.query(
      `SELECT 1 FROM sync_queue WHERE entity_type='application' AND entity_id=$1 AND target='sitewire' AND direction='push' AND op='push_file' AND status IN ('queued','processing') LIMIT 1`, [appId])).rowCount > 0 : false;
    if (!firstReconcile && stale && !queuedPushing && prop.budget && prop.budget.id) {
      const dc = await db.getClient();
      try {
        await dc.query('BEGIN');
        const lockAcquired = (await dc.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`, [`sw-budget:${appId}`])).rows[0].ok;
        if (lockAcquired) {
          await verifyBudgetDrift(appId, prop.budget.id);
          await dc.query(`UPDATE sitewire_property_links SET last_budget_verified_at=now() WHERE application_id=$1`, [appId]);
        }
        await dc.query('COMMIT');
      } catch (e) { try { await dc.query('ROLLBACK'); } catch (_) {} throw e; }
      finally { dc.release(); }
    }
  } catch (_) {}
  // refresh the advisory draw-risk snapshot (best-effort — never fail the reconcile on it)
  try { await assessAndStoreRisk(appId); } catch (_) {}
  // Owner-directed 2026-07-22: self-heal any doc slots stuck at 'pushed' — Sitewire's document
  // read can lag by minutes after an upload, so verifyPresent on the push itself may return null
  // even though the doc IS there. Without this sweep, the parked `sitewire_doc_unverified` row
  // stays open forever because dedup skips the re-upload path. Runs on every reconcile;
  // read-only for verify, best-effort throughout.
  // `escalate: true` — for any 'pushed' row stuck > 30 min without confirming, auto-force-retry
  // the upload (routes through the standard pushDocuments flow with force:true). Handles the case
  // where the ORIGINAL upload actually got lost, not just a read-lag. Reconcile is the safe caller
  // for the escalate path — pushDocuments itself uses escalate:false to avoid recursing into its
  // own retry.
  try { await require('./doc-push').verifyPushedDocsOnce(appId, link.sitewire_property_id, null, { escalate: true }); } catch (_) {}
  return { draws: n };
}

// ---- admin-tunable risk / reallocation thresholds ----
async function settingsMap() {
  const rows = (await db.query(`SELECT key, value FROM sitewire_settings`)).rows;
  const m = {}; for (const r of rows) m[r.key] = r.value; return m;
}

/**
 * Refresh the advisory red-flag snapshot for a file's active draws (research doc §15).
 * Assess each non-historical draw against the unified rollup (already-drawn EXCLUDES the
 * pending draw, since drawn counts only APPROVED draws) and store level+flags. Advisory
 * only — this never moves or blocks money.
 */
async function assessAndStoreRisk(appId) {
  const links = (await db.query(
    `SELECT sitewire_job_item_id, sow_line_key, name, budgeted_cents, is_media_item, unit_index, state
       FROM sitewire_job_item_links WHERE application_id=$1`, [appId])).rows;
  const rollup = await rollupMod.loadRollup(db, appId);
  // CLAUDE.md rule 5: an UNKNOWN inbound draw line (a Sitewire job item with no crosswalk row)
  // must PARK a review row — never just an advisory flag that vanishes when the draw is approved.
  // Belt-and-suspenders (owner-reported 2026-07-21): Sitewire seeds MANDATORY MEDIA items (Video
  // Walkthrough, External Pictures, …) on every draw. adoptSeededMediaItems in reconcileOne binds
  // them into the crosswalk BEFORE this runs, but on the very first pass — or if the property
  // read didn't include job_items — an unknown media-named line can still slip through. Filter
  // those out by NAME + $0 request/approved here so a photo/video gate is NEVER parked as
  // "reconcile by hand" (a media anchor is a structural inspection gate, not money to reconcile).
  let unknownIds = Array.isArray(rollup.unknown) ? rollup.unknown.slice() : [];
  if (unknownIds.length) {
    try {
      const meta = (await db.query(
        `SELECT r.sitewire_job_item_id AS jid, MAX(r.job_item_name) AS name,
                COALESCE(SUM(r.requested_cents),0)::bigint AS req,
                COALESCE(SUM(COALESCE(r.approved_cents,0)),0)::bigint AS appr
           FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id
          WHERE d.application_id=$1 AND r.sitewire_job_item_id = ANY($2::bigint[])
          GROUP BY r.sitewire_job_item_id`, [appId, unknownIds])).rows;
      const dropIf = new Set();
      for (const m of meta) {
        // Owner-directed 2026-07-22 (file 1053 Ella T Grasso Blvd): a $0 request/approved is a
        // Sitewire photo/video gate placeholder, not a money line — drop it from the park queue
        // regardless of name. adoptSeededMediaItems already binds these into the crosswalk on the
        // NEXT reconcile (widened to adopt every $0 item, not just media-named ones), but this
        // filter is the immediate-turn belt-and-suspenders so a first-time reconcile after deploy
        // doesn't leave a spurious "reconcile by hand" park visible to a coordinator.
        if (Number(m.req) === 0 && Number(m.appr) === 0) dropIf.add(Number(m.jid));
      }
      if (dropIf.size) unknownIds = unknownIds.filter((id) => !dropIf.has(Number(id)));
    } catch (_) { /* best-effort — fall through to the original park behavior */ }
  }
  if (unknownIds.length) {
    try {
      await require('./orchestrator').park({
        appId, dedupe: unknownIds.slice().sort((a, b) => a - b).join('-'),
        reason: `sitewire_unknown_draw_line: Sitewire draw line id(s) ${unknownIds.join(', ')} have no Scope-of-Work match — reconcile by hand, never auto-applied`,
        current: unknownIds.join(','),
      });
    } catch (_) {}
  } else {
    // Nothing unknown after the media auto-adopt / media-name filter — auto-close any lingering
    // sitewire_unknown_draw_line park rows for this file so a person no longer has to click through
    // the ones raised before the fix landed (the row stays as HISTORY, marked auto_resolved).
    try {
      await db.query(
        `UPDATE sync_review_queue
            SET status='resolved', auto_resolved=true, resolved_at=now(),
                resolution_note='auto-closed — Sitewire-seeded mandatory media items (video walkthrough / external pictures) are now auto-bound to the crosswalk; no unknown draw line remains'
          WHERE status='open' AND application_id=$1 AND field_key='sitewire'
            AND task_id LIKE 'sitewire:%:sitewire_unknown_draw_line%'`, [appId]);
    } catch (_) { /* best-effort */ }
  }
  const s = await settingsMap();
  const opts = { frontLoadPct: Number(s.front_load_pct) || 40, firstDrawMaxPct: Number(s.first_draw_max_pct) || 30 };
  const draws = (await db.query(
    `SELECT sitewire_draw_id, number, status, total_requested_cents, total_approved_cents, historical FROM sitewire_draws WHERE application_id=$1`, [appId])).rows;
  let assessed = 0;
  for (const d of draws) {
    // Only assess OPEN draws. An approved/funded draw's approved_cents is already inside
    // rollup.drawn, so assessing it against `remaining` would double-count and mislabel a
    // perfectly legitimate funded draw as high-risk (pre-merge audit #1). Approved draws get
    // their advisory snapshot CLEARED so a stale pending-era flag never lingers post-approval.
    if (d.historical || d.status === 'approved') {
      await db.query(`UPDATE sitewire_draws SET risk_level=NULL, risk_flags=NULL, risk_assessed_at=now() WHERE sitewire_draw_id=$1`, [d.sitewire_draw_id]);
      continue;
    }
    const reqs = (await db.query(
      `SELECT sitewire_job_item_id, requested_cents, approved_cents, inspection_count FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [d.sitewire_draw_id])).rows;
    const a = risk.assessDraw({ draw: d, requests: reqs, links, rollup, opts });
    await db.query(`UPDATE sitewire_draws SET risk_level=$2, risk_flags=$3, risk_assessed_at=now() WHERE sitewire_draw_id=$1`,
      [d.sitewire_draw_id, a.level, JSON.stringify(a.flags)]);
    assessed++;
  }
  return { assessed };
}

// ---- reconcile ALL linked files (the poll pass) ----
async function reconcileAll() {
  const rows = (await db.query(`SELECT application_id FROM sitewire_property_links WHERE sitewire_property_id IS NOT NULL AND matched_by='created'`)).rows;
  let total = 0;
  for (const r of rows) {
    try {
      const res = await reconcileOne(r.application_id);
      total += res.draws || 0;
      // a per-file error is surfaced, never silently swallowed (a stranded mirror must be visible)
      if (res && res.error) console.warn(`[sitewire] reconcile: file ${r.application_id} could not sync: ${res.error}`);
    } catch (err) {
      console.warn(`[sitewire] reconcile: file ${r.application_id} threw: ${db.describeError ? db.describeError(err) : err.message}`);
    }
  }
  return { files: rows.length, draws: total };
}

/**
 * Fetch the full per-line findings of a draw (for delivery to the borrower). Pulls each
 * request's detail so every inspection photo/note + approved/not-approved is included.
 * Returns { lines:[{request_id,job_item_id,name,requested_cents,approved_cents,not_approved_cents,
 *   inspector_comments,lender_comments,photo_count,video_count,media:[…]}], totals }.
 */
async function fetchDrawFindings(sitewireDrawId) {
  const draw = await client.getDraw(sitewireDrawId);
  const lines = [];
  let treq = 0, tappr = 0;
  for (const r of (draw.requests || [])) {
    let detail = r;
    try { detail = await client.getRequest(r.id); } catch (_) {}
    const ins = detail.inspections || [];
    const media = ins.map((i) => ({
      src: (i.media && i.media.src) || null, thumbnail: (i.media && i.media.thumbnail) || null,
      type: (i.media && i.media.media_type) || null, lat: i.latitude, lng: i.longitude, captured_at: i.captured_at, note: i.note,
    })).filter((m) => m.src);
    const req = r.requested_cents || 0; const appr = r.approved_cents == null ? 0 : r.approved_cents;
    treq += req; tappr += appr;
    lines.push({
      request_id: r.id, job_item_id: (r.job_item && r.job_item.id) || (detail.job_item && detail.job_item.id) || null,
      name: (r.job_item && r.job_item.name) || (detail.job_item && detail.job_item.name) || null,
      requested_cents: req, approved_cents: appr, not_approved_cents: Math.max(0, req - appr),
      inspector_comments: detail.inspector_comments || r.inspector_comments || null,
      lender_comments: detail.lender_comments || r.lender_comments || null,
      photo_count: media.filter((m) => m.type === 'image').length, video_count: media.filter((m) => m.type === 'video').length,
      media,
    });
  }
  return { draw_id: sitewireDrawId, status: draw.status, pdf_src: draw.pdf_src || null, lines, totals: { requested_cents: treq, approved_cents: tappr, not_approved_cents: Math.max(0, treq - tappr) } };
}

/**
 * Persist a draw's findings for delivery to the borrower (research doc §14, Workflow B).
 * Pulls the full per-line findings (photos/notes/approved-not-approved) and stores them,
 * mapping each line back through the crosswalk to our SOW line/unit (only-ours). Returns
 * the finding id + a reply_token for one-click email acceptance. Reads Sitewire only.
 */
async function persistDrawFindings(appId, sitewireDrawId, deliveredTo = null) {
  const crypto = require('crypto');
  const detail = await fetchDrawFindings(sitewireDrawId);
  // crosswalk map: job_item_id -> {sow_line_key, unit_index, name} — `name` used to hydrate the
  // finding line label when Sitewire's request returned it null (owner-directed 2026-07-22 so the
  // borrower + coordinator + branded report show "Interior Video Tour" instead of a blank name).
  const links = (await db.query(
    `SELECT sitewire_job_item_id, sow_line_key, unit_index, name FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_job_item_id IS NOT NULL`, [appId])).rows;
  const byJid = new Map(links.map((l) => [Number(l.sitewire_job_item_id), l]));

  // Read the PRIOR finding state so a re-deliver preserves borrower dispute evidence (audit finding
  // 2026-07-21): a force-re-deliver over an already accepted/disputed/resolved finding used to
  // wholesale DELETE draw_finding_lines and reset the parent's accepted/disputed/resolved timestamps
  // — wiping dispute_media (storage refs orphaned), dispute_status, dispute_desired_cents,
  // dispute_note, dispute_decided_by/at, and any negotiated approved_cents the coordinator had
  // recorded. Now the parent status is PROMOTED to 'delivered' only when the prior status was
  // 'delivered' (a fresh re-deliver of undecided findings); accepted/disputed/resolved statuses are
  // preserved so the borrower's decision isn't erased, and per-line dispute fields are MERGED on
  // sitewire_request_id / sitewire_job_item_id instead of DELETE+INSERT so the evidence survives.
  const prior = (await db.query(
    `SELECT id, status, reply_token, accepted_at, accepted_via, disputed_at, resolved_at
       FROM draw_findings WHERE sitewire_draw_id=$1`, [sitewireDrawId])).rows[0] || null;
  const priorStatus = prior && prior.status;
  const promotable = !priorStatus || priorStatus === 'delivered';

  const token = (prior && prior.reply_token) || crypto.randomBytes(24).toString('hex');
  // Only touch the borrower-decision timestamps when we're moving BACK to 'delivered' (a fresh
  // re-deliver). Otherwise keep the prior status + prior timestamps intact.
  const finding = (await db.query(
    `INSERT INTO draw_findings (application_id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, reply_token, delivered_to, delivered_at, updated_at)
     VALUES ($1,$2,'delivered',$3,$4,$5,$6,now(),now())
     ON CONFLICT (sitewire_draw_id) DO UPDATE SET
       total_requested_cents=EXCLUDED.total_requested_cents,
       total_approved_cents=EXCLUDED.total_approved_cents,
       reply_token=COALESCE(draw_findings.reply_token, EXCLUDED.reply_token),
       delivered_to=EXCLUDED.delivered_to,
       delivered_at=CASE WHEN $7::boolean THEN now() ELSE draw_findings.delivered_at END,
       status=CASE WHEN $7::boolean THEN 'delivered' ELSE draw_findings.status END,
       accepted_at=CASE WHEN $7::boolean THEN NULL ELSE draw_findings.accepted_at END,
       accepted_via=CASE WHEN $7::boolean THEN NULL ELSE draw_findings.accepted_via END,
       disputed_at=CASE WHEN $7::boolean THEN NULL ELSE draw_findings.disputed_at END,
       resolved_at=CASE WHEN $7::boolean THEN NULL ELSE draw_findings.resolved_at END,
       updated_at=now()
     RETURNING id, reply_token`,
    [appId, sitewireDrawId, detail.totals.requested_cents, detail.totals.approved_cents,
     token, deliveredTo ? JSON.stringify(deliveredTo) : null, promotable])).rows[0];

  // Read existing lines for this finding, keyed by (sitewire_request_id, sitewire_job_item_id) so a
  // MERGE preserves dispute state. sitewire_request_id is the primary key when present; a legacy
  // row with a null request id falls back to the job-item id.
  const existing = new Map();
  const priorLines = (await db.query(
    `SELECT id, sitewire_request_id, sitewire_job_item_id, approved_cents, dispute_status, dispute_desired_cents,
            dispute_note, dispute_media, dispute_decided_by, dispute_decided_at
       FROM draw_finding_lines WHERE finding_id=$1`, [finding.id])).rows;
  for (const r of priorLines) {
    const key = r.sitewire_request_id != null ? `r:${r.sitewire_request_id}` : `j:${r.sitewire_job_item_id}`;
    existing.set(key, r);
  }

  // Merge lines: UPDATE by key when present (keeps dispute_*), INSERT when new. A prior line that
  // is NO LONGER in the new detail (Sitewire removed the request) is SOFT-RETIRED (db/242) — kept as
  // history but hidden from live per-line reads so per-line sums match the parent total and the
  // borrower doesn't see / dispute a phantom line. Exception: a line whose dispute was already
  // decided (approved / rejected) is NEVER retired — the coordinator's decision is authoritative
  // even if Sitewire's read no longer surfaces the request. If the line reappears in a later
  // Sitewire read, the UPDATE path un-retires it (retired_at=NULL) so history is preserved.
  const seenKeys = new Set();
  for (const ln of detail.lines) {
    const key = ln.request_id != null ? `r:${ln.request_id}` : `j:${ln.job_item_id}`;
    seenKeys.add(key);
    const x = byJid.get(Number(ln.job_item_id)) || {};
    const cur = existing.get(key);
    // approved_cents is the NEGOTIATED figure once a dispute has been decided (dispute_status !== 'open').
    // Preserve the coordinator-decided amount so a fresh Sitewire read doesn't overwrite it; when the
    // dispute is still 'open' or absent, the Sitewire amount wins (source of truth).
    const disputeDecided = cur && cur.dispute_status && cur.dispute_status !== 'open';
    const approvedCents = disputeDecided ? Number(cur.approved_cents || 0) : (ln.approved_cents || 0);
    const notApprovedCents = Math.max(0, (ln.requested_cents || 0) - approvedCents);
    if (cur) {
      await db.query(
        `UPDATE draw_finding_lines
            SET sitewire_request_id=$2, sitewire_job_item_id=$3, sow_line_key=$4, unit_index=$5, name=$6,
                requested_cents=$7, approved_cents=$8, not_approved_cents=$9,
                inspector_comments=$10, lender_comments=$11, photo_count=$12, video_count=$13, media=$14,
                retired_at=NULL, updated_at=now()
          WHERE id=$1`,
        [cur.id, ln.request_id || null, ln.job_item_id || null, x.sow_line_key || null, x.unit_index || null,
         ln.name || x.name || null, ln.requested_cents || 0, approvedCents, notApprovedCents,
         ln.inspector_comments || null, ln.lender_comments || null, ln.photo_count || 0, ln.video_count || 0,
         ln.media ? JSON.stringify(ln.media) : null]);
    } else {
      await db.query(
        `INSERT INTO draw_finding_lines (finding_id, sitewire_request_id, sitewire_job_item_id, sow_line_key, unit_index, name, requested_cents, approved_cents, not_approved_cents, inspector_comments, lender_comments, photo_count, video_count, media, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())`,
        [finding.id, ln.request_id || null, ln.job_item_id || null, x.sow_line_key || null, x.unit_index || null,
         ln.name || x.name || null, ln.requested_cents || 0, approvedCents, notApprovedCents,
         ln.inspector_comments || null, ln.lender_comments || null, ln.photo_count || 0, ln.video_count || 0,
         ln.media ? JSON.stringify(ln.media) : null]);
    }
  }
  // Retire any prior lines that DIDN'T appear in this Sitewire read AND don't carry a decided
  // dispute. Uses a raw id-list rather than key strings for a simple IN () — safer than trying to
  // reconstruct r:/j: keys in SQL.
  const retireIds = [];
  for (const [key, r] of existing) {
    if (seenKeys.has(key)) continue;
    if (r.dispute_status === 'approved' || r.dispute_status === 'rejected') continue;
    if (r.retired_at != null) continue; // already retired — leave the timestamp alone
    retireIds.push(r.id);
  }
  if (retireIds.length) {
    await db.query(`UPDATE draw_finding_lines SET retired_at=now(), updated_at=now() WHERE id = ANY($1::bigint[])`, [retireIds]);
  }
  return { finding_id: finding.id, reply_token: finding.reply_token, lines: detail.lines.length,
    retired_lines: retireIds.length,
    totals: detail.totals, status: promotable ? 'delivered' : priorStatus,
    preserved_dispute_status: !promotable };
}

module.exports = { syncCapitalPartners, syncStaffUsers, reconcileOne, reconcileAll, fetchDrawFindings, deriveTimes, assessAndStoreRisk, persistDrawFindings, settingsMap, verifyBudgetDrift };
