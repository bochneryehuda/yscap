'use strict';
/**
 * PREVIOUS FILES — stamp each existing file with its USPS-correct subject address.
 *
 * The owner's rule is "previous AND future": once USPS is turned on, every file
 * already in the system should also carry its USPS-standardized address, not only
 * files opened from now on. This is that backfill.
 *
 * NON-DESTRUCTIVE by design. It writes three ADD-ON columns — applications.usps_address
 * (the USPS-correct form), usps_match (verified/corrected/unverified) and
 * usps_verified_at — and NEVER touches the working property_address. Underwriting,
 * pricing and the ClickUp sync keep reading the existing field; adopting the USPS
 * form onto property_address is a separate, deliberate step for later.
 *
 * PACED for the free USPS tier (60 lookups/hour, shared across every USPS API):
 * it does at most `backfillPerTick` lookups per pass (default 40), ~1.2s apart, and
 * runs a pass every `backfillEveryMin` minutes. A file is stamped only on a real
 * USPS answer (verified/corrected/unverified); a transient error or rate-limit
 * leaves it unstamped so the next pass retries. Idempotent + self-draining: a
 * stamped file stops matching, so a large backlog finishes over later passes.
 *
 * OFF unless USPS_BACKFILL_ENABLED=1 AND USPS keys are set. Never throws.
 */
const cfg = require('../config');
const ADDR = require('./address');
const uspsVerify = require('./usps-verify');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Any stored subject-address shape -> the five components USPS matches on.
function componentsOf(v) {
  if (!v) return null;
  if (typeof v === 'string') { const p = ADDR.parseAddress(v); return p && p.line1 ? p : null; }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const line1 = v.line1 || v.street || '';
  if (line1) return { line1, unit: v.unit || v.secondary || '', city: v.city || '', state: v.state || '', zip: v.zip || '' };
  const s = v.formatted_address || v.oneLine || v.address;   // object that only carries a one-line
  if (typeof s === 'string' && s.trim()) { const p = ADDR.parseAddress(s); return p && p.line1 ? p : null; }
  return null;
}

// A definitive USPS answer we should stamp (vs. a transient error / rate-limit / not-configured).
const STAMPABLE = new Set(['verified', 'corrected', 'unverified']);

/**
 * One bounded pass. Returns { checked, stamped, byStatus }.
 */
async function verifyPreviousFilesOnce({ limit } = {}) {
  const out = { checked: 0, stamped: 0, byStatus: {} };
  if (!uspsVerify.configured()) return out;
  const db = require('../db');
  const cap = Math.max(1, Number(limit || cfg.usps.backfillPerTick || 40));

  let rows;
  try {
    rows = (await db.query(
      `SELECT id, property_address FROM applications
        WHERE property_address IS NOT NULL AND usps_verified_at IS NULL
        ORDER BY updated_at DESC NULLS LAST
        LIMIT $1`, [cap])).rows;
  } catch (_) { return out; }   // a fresh DB mid-migration / missing column is not an error

  // On the FREE tier (a cap is set) the backfill SHARES the hourly window with live
  // traffic: it respects the cap and pauses when the window is full. On a paid tier
  // (cap = 0) it runs at full pacing.
  const respectCap = !!Number(cfg.usps.maxPerHour || 0);
  for (const r of rows) {
    const comp = componentsOf(r.property_address);
    if (!comp || !comp.line1 || !comp.state) {
      // Un-parseable address: stamp it (no API call) so the pass DRAINS instead of
      // re-reading the same rows forever. It carries no usps_address.
      try { await db.query("UPDATE applications SET usps_match='no_address', usps_verified_at=now() WHERE id=$1", [r.id]); } catch (_) {}
      out.byStatus.no_address = (out.byStatus.no_address || 0) + 1;
      continue;
    }
    out.checked++;
    let res;
    try { res = await uspsVerify.standardize(comp, { db, force: !respectCap }); }
    catch (_) { res = null; }
    if (res && res.status === 'rate_limited') break;   // window full — resume next pass, don't force past the quota
    if (!res || !STAMPABLE.has(res.status)) { await sleep(1200); continue; }   // transient — retry next pass
    out.byStatus[res.status] = (out.byStatus[res.status] || 0) + 1;
    try {
      const w = await db.query(
        `UPDATE applications SET usps_address=$2, usps_match=$3, usps_verified_at=now() WHERE id=$1`,
        [r.id, res.address ? JSON.stringify(res.address) : null, res.status]);
      out.stamped += w.rowCount || 0;
    } catch (_) { /* best effort, row by row */ }
    await sleep(1200);   // be gentle on the quota even on a paid tier
  }
  return out;
}

let timer = null;
/** Boot the paced backfill (idempotent — safe to call once from server start). */
function startUspsBackfill() {
  if (timer) return;
  if (!cfg.usps.backfillEnabled) return;
  const everyMs = Math.max(15, Number(cfg.usps.backfillEveryMin || 60)) * 60 * 1000;
  const tick = async () => { try { await verifyPreviousFilesOnce(); } catch (_) {} };
  // First pass a minute after boot (let migrations settle), then on the interval.
  setTimeout(tick, 60 * 1000);
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
}

module.exports = { verifyPreviousFilesOnce, startUspsBackfill, componentsOf };
