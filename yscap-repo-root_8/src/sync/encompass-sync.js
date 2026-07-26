'use strict';
/**
 * src/sync/encompass-sync.js — The READ-ONLY Encompass poll worker.
 * Owner-directed 2026-07-22.
 *
 * Every operation this worker performs is a READ from Encompass (per the
 * structural freeze — src/lib/integrations/encompass.js). It writes ONLY to
 * PILOT's own DB:
 *   - encompass_field_catalog  (from refreshFieldCatalog)
 *   - applications.encompass_extra (from pullLoanForApplication)
 *
 * Self-gates on cfg.encompassEnabled — set ENCOMPASS_ENABLED=1 on Render to
 * turn on. Without the switch it logs "disabled" once and returns (mirrors
 * the sitewire-sync bootstrap posture).
 *
 * Schedule (owner-adjustable via env; defaults are conservative for a first
 * roll-out and easy to tune once we see steady-state load):
 *   - Field-catalog refresh: at boot (best-effort) + every ENCOMPASS_CATALOG_HOURS hours (default 24)
 *   - Per-loan pulls: every ENCOMPASS_POLL_MIN minutes (default 15), one file per tick
 *     ordered by staleness — oldest-pulled first, unpulled first of all. Files past
 *     status='declined'/'withdrawn' are skipped (idx_applications_encompass_stale
 *     scopes the ordering to just the ones we care about).
 */

const db = require('../db');
const reader = require('../encompass/reader');
const client = require('../encompass/client');
const cfg = require('../config');

let started = false;

function _envSec(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const CATALOG_INTERVAL_MS = _envSec('ENCOMPASS_CATALOG_HOURS', 24) * 3600 * 1000;
const POLL_INTERVAL_MS = _envSec('ENCOMPASS_POLL_MIN', 15) * 60 * 1000;

async function refreshCatalogOnce() {
  if (!client.configured()) return null;
  try {
    const summary = await reader.refreshFieldCatalog();
    console.log('[encompass] field-catalog refreshed:', JSON.stringify(summary));
    return summary;
  } catch (e) {
    console.warn('[encompass] catalog refresh failed:', e.message);
    return null;
  }
}

// Pull the ONE oldest-pulled (or never-pulled) active file per tick. Keeps the
// pace easy on the API and lets us surface problems one at a time in the
// staff panel (encompass_last_error) instead of a burst of failures.
async function pullOldestActiveOnce() {
  if (!client.configured()) return null;
  const row = (await db.query(
    `SELECT id FROM applications
      WHERE ys_loan_number IS NOT NULL
        AND status NOT IN ('declined','withdrawn')
      ORDER BY encompass_last_pulled_at NULLS FIRST
      LIMIT 1`,
  )).rows[0];
  if (!row) return null;
  try {
    const result = await reader.pullLoanForApplication(row.id);
    if (!result.ok) console.warn('[encompass] pull failed for', row.id, ':', result.reason);
    else console.log('[encompass] pulled', row.id, '(', result.size, 'bytes)');
    return result;
  } catch (e) {
    console.warn('[encompass] pull threw for', row.id, ':', e.message);
    return null;
  }
}

function start() {
  if (started) return;
  const encEnabled = String(process.env.ENCOMPASS_ENABLED || '').trim();
  const isOn = encEnabled === '1' || encEnabled.toLowerCase() === 'true';
  if (!isOn) { console.log('[encompass] disabled (set ENCOMPASS_ENABLED=1 to turn on)'); return; }
  if (!client.configured()) { console.log('[encompass] not configured — missing ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID'); return; }
  started = true;
  console.log('[encompass] READ-ONLY worker starting — catalog=%sh poll=%sm',
    Math.round(CATALOG_INTERVAL_MS / 3600000), Math.round(POLL_INTERVAL_MS / 60000));

  // one-shot warm: catalog refresh + first pull, staggered so a slow API doesn't stack them
  setTimeout(() => { refreshCatalogOnce(); }, 5000);
  setTimeout(() => { pullOldestActiveOnce(); }, 15000);

  setInterval(refreshCatalogOnce, CATALOG_INTERVAL_MS);
  setInterval(pullOldestActiveOnce, POLL_INTERVAL_MS);
}

module.exports = { start, refreshCatalogOnce, pullOldestActiveOnce };
