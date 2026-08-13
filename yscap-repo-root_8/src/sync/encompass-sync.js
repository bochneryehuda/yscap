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
const enrich = require('../encompass/enrich');
const cfg = require('../config');

let started = false;

function _envSec(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const CATALOG_INTERVAL_MS = _envSec('ENCOMPASS_CATALOG_HOURS', 24) * 3600 * 1000;
const POLL_INTERVAL_MS = _envSec('ENCOMPASS_POLL_MIN', 15) * 60 * 1000;
// Part 2 — the borrower-profile enrichment pass runs WEEKLY (owner-directed
// 2026-07-26: "the system should pull every week all the Encompass data … just to
// build up and enhance the profile section"). Separately opt-in
// (ENCOMPASS_ENRICH_ENABLED=1) on top of ENCOMPASS_ENABLED so the profile writes
// can be turned on independently of the read-only per-file pulls.
const ENRICH_INTERVAL_MS = _envSec('ENCOMPASS_ENRICH_DAYS', 7) * 24 * 3600 * 1000;
const _flagOn = (name) => { const v = String(process.env[name] || '').trim().toLowerCase(); return v === '1' || v === 'true'; };
const _flagOff = (name) => { const v = String(process.env[name] || '').trim().toLowerCase(); return v === '0' || v === 'false'; };
const enrichEnabled = () => _flagOn('ENCOMPASS_ENRICH_ENABLED');
// Whether the weekly pass REFRESHES the full-tenant snapshot first (a heavy
// read of every loan). ON by default now that the pass is weekly — the owner
// asked for "all the Encompass data" every week, and enriching off a stale
// snapshot would silently miss every file closed since the last refresh. Set
// ENCOMPASS_ENRICH_BULK=0 to enrich from whatever the snapshot already holds.
// Still a pure READ: bulkPullAllLoans only ever GETs.
const enrichBulkEnabled = () => !_flagOff('ENCOMPASS_ENRICH_BULK');

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
  // A PRIORITY LANE FOR FILES WHERE THE ANSWER IS ABOUT TO MOVE MONEY (owner-reported 2026-08-13:
  // a loan sold two weeks earlier still read as "not sold" on the draw desk). Pure staleness order
  // is fair but slow: one file per tick over the whole book means a given file's turn comes around
  // once every (files ÷ ~96) days. A FUNDED file with a live draw project and no purchase advice
  // yet is the one case where that delay has a cost — the draw desk reads "not sold", so PILOT
  // releases the draw as ours and books no investor fee. Those files go first; everything else
  // keeps its exact previous order behind them, so nothing is starved, only re-ordered.
  const row = (await db.query(
    `SELECT a.id FROM applications a
      WHERE a.ys_loan_number IS NOT NULL
        AND a.status NOT IN ('declined','withdrawn')
      ORDER BY (a.status = 'funded'
                AND a.purchase_advice_date IS NULL
                AND EXISTS (SELECT 1 FROM sitewire_property_links pl
                             WHERE pl.application_id = a.id AND pl.matched_by='created'
                               AND COALESCE(pl.lifecycle_state,'active') = 'active')) DESC,
               a.encompass_last_pulled_at NULLS FIRST
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

// Part 2 — one borrower-profile enrichment pass: refresh the read-only snapshot
// of ALL Encompass loans, then additively + dedupedly enrich borrower profiles
// from it — prior-deal addresses → track record, entities (including the
// free-text field 1859 list) → entity library, every email/phone on the file →
// the person's accumulated contacts — and verify their primary home address
// against their MOST RECENT file, filling it when we have none and raising a
// manual review when the two disagree. Writes only OUR tables (never Encompass),
// never creates a loan file, and never replaces an existing row.
// Best-effort — a failure is logged, never thrown.
async function enrichPassOnce() {
  if (!enrichEnabled()) return null;
  if (!client.configured()) return null;
  try {
    if (enrichBulkEnabled()) {
      console.log('[encompass] enrichment: refreshing full-tenant snapshot (read-only)…');
      try { await reader.bulkPullAllLoans({ perRequestDelayMs: 350 }); }
      catch (e) { console.warn('[encompass] enrichment bulk pull failed (continuing on existing snapshot):', e.message); }
    }
    const summary = await enrich.enrichAllOnce();
    console.log('[encompass] borrower-profile enrichment:', JSON.stringify(summary));
    return summary;
  } catch (e) {
    console.warn('[encompass] enrichment pass failed:', e.message);
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

  // Part 2 — borrower-profile enrichment (opt-in, weekly).
  if (enrichEnabled()) {
    console.log('[encompass] borrower-profile enrichment ON — every %sd%s',
      Math.round(ENRICH_INTERVAL_MS / 86400000), enrichBulkEnabled() ? ' (with full-tenant snapshot refresh)' : '');
    setTimeout(() => { enrichPassOnce(); }, 60000); // one-shot warm, well after the pulls
    setInterval(enrichPassOnce, ENRICH_INTERVAL_MS);
  }

  // Part 3 — catch the appraisal XML inside its ~15-minute download window.
  // READ-ONLY (GETs through the frozen client). It has its OWN timer rather than
  // riding the pull loop because the deadline is the AMC's delivery clock, not
  // ours: the poll interval is a correctness constraint, and coupling it to the
  // hourly file pull would miss essentially every file.
  try { require('../encompass/appraisal-xml-catcher').start(db); }
  catch (e) { console.error('[encompass-xml] failed to start (non-fatal):', e && e.message); }
}

// ── Flood-order poll worker ──────────────────────────────────────────────────
// Advances placed flood orders to completion (files the certificate PDF onto the
// flood condition + records the flood-zone determination). Runs INDEPENDENTLY of
// ENCOMPASS_ENABLED (a tenant may order flood without the read-sync on); it
// self-gates on the ENCOMPASS_FLOOD_ENABLED switch inside pollPendingOnce, so an
// idle tick is a cheap no-op. Started from server boot.
let floodStarted = false;
const FLOOD_POLL_MS = _envSec('ENCOMPASS_FLOOD_POLL_SEC', 120) * 1000;
async function pollFloodOnce() {
  try {
    const out = await require('../encompass/flood-desk').pollPendingOnce();
    if (out && (out.completed || out.failed)) console.log('[encompass-flood] poll:', JSON.stringify(out));
    return out;
  } catch (e) { console.warn('[encompass-flood] poll threw:', e.message); return null; }
}
// Xactus flood is the active provider (its manual/not-on-FEMA-maps orders poll to
// completion the same way). A tick is a no-op while the Xactus flood switch is off.
async function pollXactusFloodOnce() {
  try {
    const out = await require('../xactus/flood-desk').pollPendingOnce();
    if (out && (out.completed || out.failed)) console.log('[xactus-flood] poll:', JSON.stringify(out));
    return out;
  } catch (e) { console.warn('[xactus-flood] poll threw:', e.message); return null; }
}
function startFloodPoller() {
  if (floodStarted) return;
  floodStarted = true;
  // Warm one-shot shortly after boot, then a steady interval. Each tick is a no-op
  // while its provider's flood switch is off, so this is safe to always start.
  const tick = () => { pollFloodOnce(); pollXactusFloodOnce(); };
  setTimeout(tick, 20000);
  setInterval(tick, FLOOD_POLL_MS);
}

module.exports = { start, startFloodPoller, refreshCatalogOnce, pullOldestActiveOnce, enrichPassOnce, pollFloodOnce, pollXactusFloodOnce };
