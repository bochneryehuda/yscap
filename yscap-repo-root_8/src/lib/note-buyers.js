'use strict';

/**
 * Note-buyer (capital-partner) directory.
 *
 * The note buyer is `applications.lender` — a free-text ClickUp dropdown label,
 * pull-only from ClickUp and STAFF-ONLY (never shown to a borrower). Historically
 * the only way a note buyer got onto a file was the ClickUp pull; there was no
 * way to see the full set of note buyers or to pick one in the portal.
 *
 * listNoteBuyers() returns the full universe of note buyers to offer in the
 * completeness picker (owner-directed 2026-07-20 — "pull all of our note buyers
 * available in ClickUp"), from three sources, most-authoritative first:
 *   1. the live ClickUp dropdown options for the note-buyer field (every value
 *      ClickUp knows, independent of which files use them) — via the same
 *      registry.optionMap pattern the sync uses;
 *   2. the known/confirmed note buyers from the condition field registry
 *      (Blue Lake / CorrFirst / Fidelis) so the list is never empty even when
 *      ClickUp is unconfigured;
 *   3. the DISTINCT lender values already on files (anything a past pull stored).
 *
 * Deduped by the normalized key (normNoteBuyer) so "Blue Lake" / "blue lake"
 * collapse to one row; a human-friendly label is preserved for display.
 * Everything is best-effort — a ClickUp outage just yields the DB + registry set.
 */

const db = require('../db');
const { normNoteBuyer } = require('./conditions/field-registry');

// Pull the live ClickUp dropdown options for the note-buyer (lender) field.
// Uses the already-warm option cache when present, else fetches from a
// representative Pipeline list id taken off any synced file. Returns [] on any
// failure (ClickUp unconfigured / network / no synced list).
async function clickupNoteBuyerLabels() {
  try {
    const F = require('../clickup/fields');
    const registry = require('../clickup/registry');
    const fieldId = F.PIPELINE && F.PIPELINE.lender;
    if (!fieldId) return [];
    // Cheap path: options already cached by the running sync.
    let opts = (registry.peek() || {})[fieldId];
    if (!opts || !opts.length) {
      const row = (await db.query(
        `SELECT clickup_list_id FROM applications
          WHERE clickup_list_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)).rows[0];
      const listId = row && row.clickup_list_id;
      if (listId) {
        const map = await registry.optionMap(listId).catch(() => ({}));
        opts = (map || {})[fieldId];
      }
    }
    return (opts || []).map((o) => o && o.name).filter(Boolean);
  } catch (_) { return []; }
}

// The confirmed note buyers baked into the condition field registry.
function registryNoteBuyerLabels() {
  try {
    const f = require('./conditions/field-registry').BY_KEY.note_buyer;
    return (f && f.options ? f.options : []).map((o) => o.label).filter(Boolean);
  } catch (_) { return []; }
}

async function dbNoteBuyerLabels() {
  try {
    const r = await db.query(
      `SELECT DISTINCT btrim(lender) AS lender FROM applications
        WHERE lender IS NOT NULL AND btrim(lender) <> ''`);
    return r.rows.map((x) => x.lender).filter(Boolean);
  } catch (_) { return []; }
}

/** Full deduped note-buyer list: [{ value, label }] sorted by label. */
async function listNoteBuyers() {
  const [cu, reg, dbLabels] = await Promise.all([
    clickupNoteBuyerLabels(), Promise.resolve(registryNoteBuyerLabels()), dbNoteBuyerLabels(),
  ]);
  const byKey = new Map();
  // ClickUp first (its label spelling wins), then registry, then DB stragglers.
  for (const label of [...cu, ...reg, ...dbLabels]) {
    const value = normNoteBuyer(label);
    if (!value) continue;
    if (!byKey.has(value)) byKey.set(value, { value, label: String(label).trim() });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = { listNoteBuyers, clickupNoteBuyerLabels };
