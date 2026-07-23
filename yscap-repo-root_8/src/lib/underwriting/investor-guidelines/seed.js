'use strict';
/**
 * Idempotent seeder for the note-buyer condition guidelines (ISG-2 + ISG-BL). Ingests the
 * checked-in per-note-buyer specs into the versioned knowledge store + the
 * note_buyer_conditions table. Runs at boot (like the other backfills) and is safe to re-run:
 *   • upserts each note buyer's investor row (ON CONFLICT label_norm);
 *   • find-or-creates the source guideline_document (provenance) + an active version;
 *   • upserts every note_buyer_conditions row (ON CONFLICT (guideline_version_id, cond_no)).
 *
 * A row's applicability is governed by its OWN scope + investor_id (an "all note buyers" row
 * inside a note buyer's sheet applies to every note buyer → investor_id NULL). Best-effort +
 * never throws out to the caller. ADVISORY layer; touches no frozen number.
 *
 * Seeds:
 *   • corrfirst-fnf-spec — CorrFirst Fix & Flip Purchase (the owner's Excel, ISG-2)
 *   • bluelake-rtl-spec  — Blue Lake Capital RTL V04.20.26 (the owner's 3 PDFs, ISG-BL).
 *     Blue Lake's detailed leverage/tier grid is delegated to the live Gold engine
 *     (meta.governed_by='gold_program'); this seeds only the document/eligibility/condition set.
 */

const corrfirstSpec = require('./corrfirst-fnf-spec');
const bluelakeSpec = require('./bluelake-rtl-spec');
const SPECS = [corrfirstSpec, bluelakeSpec];

// Same normalization as guideline-knowledge.investorKey / conditions.field-registry.normNoteBuyer.
function investorKey(raw) { return String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Seed ONE note-buyer spec into the versioned store + note_buyer_conditions. Idempotent.
async function seedSpec(db, spec) {
  // 1. upsert the note-buyer investor.
  const inv = await db.query(
    `INSERT INTO investors (name, label_norm, channel)
     VALUES ($1, $2, 'note_buyer')
     ON CONFLICT (label_norm) DO UPDATE SET
       channel = COALESCE(investors.channel, 'note_buyer'),
       updated_at = now()
     RETURNING id`,
    [spec.NOTE_BUYER_NAME, investorKey(spec.NOTE_BUYER)]);
  const investorId = inv.rows[0].id;

  // 2. find-or-create the source guideline_document (provenance) — keyed on investor+program+title.
  let docId = (await db.query(
    `SELECT id FROM guideline_documents WHERE investor_id = $1 AND program = $2 AND title = $3 LIMIT 1`,
    [investorId, spec.PRODUCT, spec.SOURCE_TITLE])).rows[0]?.id;
  if (!docId) {
    docId = (await db.query(
      `INSERT INTO guideline_documents (investor_id, program, title, meta)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [investorId, spec.PRODUCT, spec.SOURCE_TITLE,
       JSON.stringify({ kind: 'note_buyer_conditions', product: spec.PRODUCT, source: 'owner guideline documents 2026-07-23' })])).rows[0].id;
  }

  // 3. find-or-create an ACTIVE version for this ingest.
  let verId = (await db.query(
    `SELECT id FROM guideline_versions WHERE guideline_document_id = $1 AND version = $2 LIMIT 1`,
    [docId, spec.SOURCE_VERSION])).rows[0]?.id;
  if (!verId) {
    const ins = await db.query(
      `INSERT INTO guideline_versions (guideline_document_id, version, approval_status, effective_from)
       VALUES ($1, $2, 'active', CURRENT_DATE)
       ON CONFLICT (guideline_document_id, version) DO NOTHING
       RETURNING id`,
      [docId, spec.SOURCE_VERSION]);
    verId = ins.rows[0]?.id
      || (await db.query(`SELECT id FROM guideline_versions WHERE guideline_document_id = $1 AND version = $2 LIMIT 1`,
           [docId, spec.SOURCE_VERSION])).rows[0]?.id;
  }
  if (!verId) return { skipped: true, note_buyer: spec.NOTE_BUYER, reason: 'could not resolve guideline version' };

  // 4. upsert every condition row. An all-note-buyers row has NULL investor_id (applies to all).
  //    source_row carries the CorrFirst spreadsheet row OR the Blue Lake source page.
  let n = 0;
  for (const c of spec.CONDITIONS) {
    const rowInvestor = c.scope === 'all_note_buyers' ? null : investorId;
    await db.query(
      `INSERT INTO note_buyer_conditions
         (guideline_version_id, product, cond_no, name, domain, scope, investor_id, lifecycle,
          trigger, required_evidence, checks, clears_by, pilot_template_code, match_quality, source_row, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (guideline_version_id, cond_no) DO UPDATE SET
         name = EXCLUDED.name, domain = EXCLUDED.domain, scope = EXCLUDED.scope,
         investor_id = EXCLUDED.investor_id, lifecycle = EXCLUDED.lifecycle, trigger = EXCLUDED.trigger,
         required_evidence = EXCLUDED.required_evidence, checks = EXCLUDED.checks,
         clears_by = EXCLUDED.clears_by, pilot_template_code = EXCLUDED.pilot_template_code,
         match_quality = EXCLUDED.match_quality, source_row = EXCLUDED.source_row,
         meta = EXCLUDED.meta, active = true, updated_at = now()`,
      [verId, c.product || spec.PRODUCT, c.cond_no, c.name, c.domain || null, c.scope, rowInvestor,
       c.lifecycle, JSON.stringify(c.trigger || {}), c.required_evidence || null,
       JSON.stringify(Array.isArray(c.checks) ? c.checks : []), c.clears_by || null,
       c.pilot_template_code || null, c.match_quality || null, (c.source_row != null ? c.source_row : (c.source_page != null ? c.source_page : null)),
       JSON.stringify(c.meta || {})]);
    n += 1;
  }
  return { ok: true, note_buyer: spec.NOTE_BUYER, investorId, versionId: verId, conditions: n };
}

async function seedNoteBuyerConditions(client) {
  const db = client || require('../../../db');
  try {
    // The table lands in db/283; if migrations have not applied yet, skip quietly.
    const tbl = await db.query(`SELECT to_regclass('public.note_buyer_conditions') AS t`);
    if (!tbl.rows[0] || !tbl.rows[0].t) return { skipped: true, reason: 'note_buyer_conditions table not present yet' };

    const results = [];
    for (const spec of SPECS) {
      try { results.push(await seedSpec(db, spec)); }
      catch (e) { results.push({ ok: false, note_buyer: spec && spec.NOTE_BUYER, error: (e && e.message) || 'spec seed error' }); }
    }
    const total = results.reduce((a, r) => a + (r && r.conditions ? r.conditions : 0), 0);
    return { ok: results.some((r) => r && r.ok), specs: results, conditions: total };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'seed error' };
  }
}

module.exports = { seedNoteBuyerConditions, seedSpec, investorKey, SPECS };
