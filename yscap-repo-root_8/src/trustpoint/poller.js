'use strict';
/**
 * TrustPoint POLLER (phase 2 — blueprint §4). Webhooks are best-effort on TrustPoint's
 * side (3 network-only retries, non-2xx dropped forever, no replay), so these polls are
 * CORRECTNESS machinery, not backup:
 *   · draw watermark poll (TRUSTPOINT_POLL_SEC, default 300s): one global
 *     GET /draw_requests/?updated_at__gt=<wall-clock watermark − overlap> — draw
 *     responses carry no updated_at, so the watermark is wall-clock with a 10-minute
 *     overlap and per-draw idempotence (status_synced claims) absorbs the re-reads.
 *   · discovery sweep (TRUSTPOINT_SWEEP_SEC, default 1800s): full project id-diff +
 *     auto-link + service-order sweep for linked projects.
 *   · webhook inbox drain (30s backstop; the receiver also drains on receipt).
 * Rate math: ~0.5 rpm total at 50 linked projects vs the 600 rpm platform cap.
 */

const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const mirror = require('./mirror');
const discovery = require('./discovery');

async function getState(key) {
  const r = await db.query(`SELECT value FROM trustpoint_state WHERE key=$1`, [key]);
  return r.rows[0] ? r.rows[0].value : null;
}
async function setState(key, value) {
  await db.query(
    `INSERT INTO trustpoint_state (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key, value]);
}

const OVERLAP_MS = 10 * 60 * 1000;

/** The 5-minute draw watermark poll over ALL linked projects in one filtered list call. */
async function pollDraws() {
  if (!client.available() || !client.enabled()) return { skipped: 'off' };
  const prev = await getState('draw_watermark');
  const started = new Date();
  const since = prev ? new Date(new Date(prev).getTime() - OVERLAP_MS) : null;
  const q = since ? { updated_at__gt: since.toISOString() } : {};
  let draws;
  try { draws = await client.listDraws(q); } catch (e) { console.warn('[trustpoint] draw poll failed:', e && e.message); return { error: e.message }; }
  let mirrored = 0;
  for (const d of draws) {
    try {
      const tpProjectId = String(d.project_id || '');
      if (!tpProjectId) continue;
      const link = await mirror.linkFor(tpProjectId);
      if (!link) { await discovery.noteUnknownProject(tpProjectId, null); continue; }
      const appId = link.application_id;
      let detail = d;
      try { detail = await client.getDraw(tpProjectId, d.id); } catch (_) {}
      const { prev: prevRow, row } = await mirror.upsertDraw(appId, tpProjectId, String(d.id), detail);
      await mirror.linkToSitewireIntake(appId, row);
      // A link whose silent history baseline hasn't completed reacts as BASELINE — a
      // failed link-time hydrate must never turn history into borrower emails (audit #9).
      await mirror.reactDraw(appId, row, prevRow, { baseline: !link.baselined_at });
      mirrored++;
    } catch (e) { console.warn(`[trustpoint] poll draw ${d && d.id} failed: ${e && e.message}`); }
  }
  await setState('draw_watermark', started.toISOString());
  return { seen: draws.length, mirrored };
}

/** Hourly-ish service-order refresh for linked projects (webhooks omit scheduled_at). */
async function pollServiceOrders() {
  if (!client.available() || !client.enabled()) return { skipped: 'off' };
  const linked = (await db.query(
    `SELECT tp_project_id, application_id FROM trustpoint_project_links WHERE application_id IS NOT NULL AND discarded=false`)).rows;
  let n = 0;
  for (const l of linked) {
    try {
      const sos = await client.listServiceOrders({ project_id: l.tp_project_id });
      for (const so of sos) { await mirror.upsertServiceOrder(l.application_id, { ...so, project_id: l.tp_project_id }); n++; }
    } catch (e) { console.warn(`[trustpoint] service-order poll ${l.tp_project_id} failed: ${e && e.message}`); }
  }
  return { orders: n, projects: linked.length };
}

let timers = [];
let soTick = 0;
function start() {
  if (timers.length) return;
  const pollSec = Math.max(60, cfg.trustpointPollSec || 300);
  const sweepSec = Math.max(300, cfg.trustpointSweepSec || 1800);
  timers.push(setInterval(() => { mirror.drainInbox().catch(() => {}); }, 30 * 1000));
  timers.push(setInterval(() => {
    pollDraws().catch(() => {});
    // service orders ride the draw cadence at 1-in-12 (≈hourly at the 300s default)
    if (++soTick % 12 === 0) pollServiceOrders().catch(() => {});
  }, pollSec * 1000));
  timers.push(setInterval(() => {
    discovery.sweep().catch(() => {});
    // approved-but-unpushed write-backs re-drive on the same cadence (audit-3 #3)
    require('./writeback').sweepPending().catch(() => {});
  }, sweepSec * 1000));
  // one prompt pass shortly after boot (never blocks startup)
  setTimeout(() => {
    mirror.drainInbox().catch(() => {});
    discovery.sweep().catch(() => {});
    pollDraws().catch(() => {});
    require('./writeback').sweepPending().catch(() => {});
  }, 15 * 1000);
  console.log(`[trustpoint] poller started (draws every ${pollSec}s, sweep every ${sweepSec}s)`);
}
function stop() { for (const t of timers) clearInterval(t); timers = []; }

module.exports = { start, stop, pollDraws, pollServiceOrders, getState, setState };
