'use strict';
/**
 * Super-admin Scope-of-Work line-item editor (owner-directed 2026-07-21).
 *
 * A super-admin — and ONLY after unlocking the file's SOW editing — may change a line item's WORDING
 * (label) and add a DESCRIPTION to better explain it to the investor. Every edit:
 *   1. updates the REAL Scope of Work (the rehab_budget checklist item's tool_payload.state), then
 *   2. regenerates the SOW EXCEL as a fresh, superseding version (documents row, SharePoint-mirrored), then
 *   3. pushes the new WORDING to Sitewire (the job-item name) via the guarded full push — a line already
 *      drawn against is never renamed there (Sitewire locks it; the push handles that safely), and
 *   4. pushes the DESCRIPTION to Sitewire's line item (owner-directed 2026-07-21 — a capture of Sitewire's
 *      own loan-edit screen confirmed the job item carries a writable `description` field, so this is no
 *      longer a guess). Guarded budget PATCH (merge-by-id) + read-after-write verify.
 *
 * Never touches money: only `label`/`desc` change, so Σ budget is unchanged and G-RECON still holds.
 */
const db = require('../db');
const storage = require('../lib/storage');
const { buildXlsx } = require('../lib/xlsx');
const M = require('./mapper');

const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAX_LABEL = 200;
const MAX_DESC = 2000;

// Load the file's Scope-of-Work checklist item (the rehab_budget tool) + its payload.
async function loadSow(appId) {
  const row = (await db.query(
    `SELECT id, borrower_id, tool_payload FROM checklist_items
       WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
  if (!row) return null;
  const payload = row.tool_payload || {};
  return { itemId: row.id, borrowerId: row.borrower_id, payload, state: payload.state || null, total: payload.total };
}

// Apply a wording/description change to the SOW state in place. Returns { found, key, oldLabel, oldDesc }.
// Handles both taxonomy lines (state.items[key]) and custom lines (state.custom[] with an "x:<id>" key).
function applyEdit(state, sowLineKey, { label, desc }) {
  if (!state || typeof state !== 'object') return { found: false };
  const key = String(sowLineKey || '');
  const hasLabel = label != null;
  const hasDesc = desc != null;
  const nextLabel = hasLabel ? String(label).slice(0, MAX_LABEL) : undefined;
  const nextDesc = hasDesc ? String(desc).slice(0, MAX_DESC) : undefined;
  if (key.indexOf('x:') === 0) {
    const custom = state.custom || [];
    const cu = custom.find((x) => 'x:' + String(x.id) === key);
    if (!cu) return { found: false };
    const oldLabel = cu.name || cu.label || '';
    const oldDesc = cu.desc || cu.description || '';
    if (hasLabel) { cu.name = nextLabel; cu.label = nextLabel; }
    if (hasDesc) cu.desc = nextDesc;
    return { found: true, key, oldLabel, oldDesc };
  }
  const items = state.items || (state.items = {});
  const it = items[key];
  if (!it) return { found: false }; // never invent a line that isn't in the SOW
  const oldLabel = it.label || '';
  const oldDesc = it.desc || '';
  if (hasLabel) it.label = nextLabel;
  if (hasDesc) it.desc = nextDesc;
  return { found: true, key, oldLabel, oldDesc };
}

// Build the updated Scope-of-Work Excel (real workbook) from the saved state. One row per ON line with its
// (possibly edited) wording + description + amount, then Contingency / GC Fee / Grand total.
function buildSowExcel(state, totalCents) {
  const lines = M.sowLineSummary(state).sort((a, b) => a.name.localeCompare(b.name));
  const sub = M.subtotalCents(M.sowCells(state));
  const cont = M.contingencyCents(state, sub);
  const gc = M.gcCents(state, sub);
  const grand = Number.isFinite(Number(totalCents)) ? Number(totalCents) : sub + cont + gc;
  const rows = [['#', 'Line item', 'Description', 'Amount']];
  lines.forEach((l, i) => rows.push([i + 1, l.name, l.desc || '', usd(l.cents)]));
  rows.push([]);
  if (cont > 0) rows.push(['', 'Contingency', '', usd(cont)]);
  if (gc > 0) rows.push(['', 'GC Fee', '', usd(gc)]);
  rows.push(['', 'Grand total', '', usd(grand)]);
  return buildXlsx(rows, 'Scope of Work');
}

// Regenerate + store the SOW Excel as the current version, superseding only the prior Excel on the item
// (the HTML/PDF exports are left alone). doc_kind ends in _export so the SharePoint anti-churn treats it as a
// regenerable artifact (no Version-N shuffle). SharePoint mirror is best-effort.
async function regenerateExcel(appId, itemId, borrowerId, state, totalCents, actorId) {
  const buf = buildSowExcel(state, totalCents);
  const filename = 'Scope of Work.xlsx';
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const { ref, provider } = await storage.save(buf, { filename });
  // supersede ONLY the previous SOW Excel (by content type / .xlsx), not the sibling HTML/PDF exports
  await db.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE checklist_item_id=$1 AND source_type='system' AND is_current=true
        AND (content_type LIKE '%spreadsheet%' OR lower(filename) LIKE '%.xlsx')`, [itemId]);
  const r = await db.query(
    `INSERT INTO documents
       (checklist_item_id,application_id,borrower_id,filename,content_type,size_bytes,
        storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,source_type,visibility,doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,'system','borrower','rehab_budget_export') RETURNING id`,
    [itemId, appId, borrowerId, filename, contentType, buf.length, provider, ref, actorId]);
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  return { docId: r.rows[0].id, filename, size: buf.length };
}

/**
 * The main entry point. Validates, applies the edit to the real SOW, persists it, regenerates the Excel, and
 * pushes the new wording to Sitewire. Returns a result object; the route maps it to HTTP. Does NOT do the
 * super-admin / unlock gating — that's the route's job (this is called only after those checks pass).
 */
async function editLine(appId, { sow_line_key, label, desc }, actorId) {
  if (!sow_line_key) return { error: 'missing_key' };
  if (label == null && desc == null) return { error: 'nothing_to_change' };
  const sow = await loadSow(appId);
  if (!sow || !sow.state) return { error: 'no_sow' };

  const applied = applyEdit(sow.state, sow_line_key, { label, desc });
  if (!applied.found) return { error: 'line_not_found' };
  const labelChanged = label != null && String(label).slice(0, MAX_LABEL) !== (applied.oldLabel || '');
  const descChanged = desc != null && String(desc).slice(0, MAX_DESC) !== (applied.oldDesc || '');

  // Audit finding C-3 (2026-07-21): a label rename on a DRAWN line used to silently succeed on the
  // PILOT side (SOW state + Excel regenerated with the new label, sitewire:'pushed' returned) — but
  // orchestrator.pushBudget suppresses the Sitewire rename on drawn lines (Sitewire locks the name
  // once a draw references it, and a rename in the same batch 422s the whole PATCH). Result: PILOT
  // UI showed "Kitchen v2", Sitewire kept "Kitchen", the two drifted forever with no park. Pre-check
  // the drawn-lock BEFORE mutating the SOW: refuse the label change (422) if the line is drawn, so
  // PILOT and Sitewire stay in lock-step. A description-only edit is still allowed (Sitewire's
  // `description` field isn't locked by a draw).
  if (labelChanged) {
    try {
      const drawnCheck = (await db.query(
        `SELECT 1 FROM sitewire_job_item_links jil
           JOIN sitewire_draw_requests r ON r.sitewire_job_item_id = jil.sitewire_job_item_id
           JOIN sitewire_draws d ON d.sitewire_draw_id = r.sitewire_draw_id
          WHERE jil.application_id=$1 AND d.application_id=$1 AND jil.sow_line_key=$2 LIMIT 1`,
        [appId, applied.key])).rowCount > 0;
      if (drawnCheck) return { error: 'line_drawn_locked', message: 'This line has already been drawn against in Sitewire — its name is locked there. Edit the description instead, or reset the draw process first.' };
    } catch (_) { /* fail open: if we can't check, proceed — the push-side rename-suppression is the safety net */ }
  }

  // persist the updated real Scope of Work (tool_payload.state + the mirrored tool_state)
  const nextPayload = { ...sow.payload, state: sow.state };
  await db.query(
    `UPDATE checklist_items SET tool_payload=$2, tool_state=$3, updated_at=now() WHERE id=$1`,
    [sow.itemId, JSON.stringify(nextPayload), JSON.stringify(sow.state)]);

  // regenerate the SOW Excel as a fresh superseding version (best-effort — never fail the edit on it)
  let excel = null;
  try { excel = await regenerateExcel(appId, sow.itemId, sow.borrowerId, sow.state, sow.total, actorId); }
  catch (e) { excel = { error: e && e.message }; }

  // push the new WORDING to Sitewire (the job-item name). Only when the label actually changed AND the file
  // is PILOT-managed. The guarded full push re-reads this SOW, renames the job item (unless the line is
  // already drawn against — Sitewire locks that name and the push skips the rename), read-after-write verified.
  let sitewire = 'not_pushed';
  if (labelChanged) {
    try {
      const orchestrator = require('./orchestrator');
      if (await orchestrator.isManaged(appId)) {
        const cfg = require('../config');
        const switches = require('../lib/integrations/switches');
        if (switches.on('SITEWIRE_ENABLED') && (switches.on('SITEWIRE_OUTBOUND_ENABLED') || cfg.sitewireDryrun)) {
          const r = await orchestrator.pushFile(appId, {});
          sitewire = r && r.parked ? 'parked' : 'pushed';
        } else { sitewire = 'writes_off'; }
      } else { sitewire = 'not_managed'; }
    } catch (e) { sitewire = 'push_error'; }
  }

  // push the DESCRIPTION to Sitewire's line item (confirmed writable `description` field). Only when it
  // changed AND the file is managed. Guarded budget PATCH (merge-by-id) + read-after-write verify.
  let descSitewire = 'not_pushed';
  if (descChanged) {
    try {
      const orchestrator = require('./orchestrator');
      const dr = await orchestrator.pushJobItemDescription(appId, applied.key, desc);
      descSitewire = dr.parked ? 'parked' : dr.ok ? (dr.sitewire || 'pushed') : dr.reason || 'not_pushed';
    } catch (e) { descSitewire = 'push_error'; }
  }

  return { ok: true, key: applied.key, label_changed: labelChanged, desc_changed: descChanged, excel, sitewire, desc_sitewire: descSitewire };
}

// List the SOW lines (for the editor UI): each line's key + current wording + description + amount, and
// whether it's already drawn against in Sitewire (so the UI can warn the wording is locked there).
async function listLines(appId) {
  const sow = await loadSow(appId);
  if (!sow || !sow.state) return { available: false };
  const lines = M.sowLineSummary(sow.state);
  // which lines are drawn against (Sitewire locks their name) — best-effort; empty for unmanaged files
  const drawnKeys = new Set();
  try {
    const rows = (await db.query(
      `SELECT DISTINCT jil.sow_line_key
         FROM sitewire_job_item_links jil
         JOIN sitewire_draw_requests r ON r.sitewire_job_item_id = jil.sitewire_job_item_id
         JOIN sitewire_draws d ON d.sitewire_draw_id = r.sitewire_draw_id
        WHERE jil.application_id=$1 AND d.application_id=$1 AND r.sitewire_job_item_id IS NOT NULL`, [appId])).rows;
    for (const r of rows) if (r.sow_line_key) drawnKeys.add(r.sow_line_key);
  } catch (_) { /* unmanaged / no draws yet — no lock info, treat as not-drawn */ }
  return {
    available: true,
    lines: lines.map((l) => ({ ...l, amount: usd(l.cents), drawn_locked: drawnKeys.has(l.sow_line_key) })),
  };
}

module.exports = { editLine, listLines, buildSowExcel, applyEdit, loadSow };
