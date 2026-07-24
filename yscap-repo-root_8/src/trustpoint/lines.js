'use strict';
/**
 * Per-line approved amounts for TrustPoint draws (phase 3 — blueprint §6).
 * Preference order:
 *   1. DERIVED — milestone-progress diff: snapshot the project's milestones around each
 *      draw transition; per-milestone numeric movement between the pre- and post-approval
 *      snapshots IS that draw's per-line approved amount. Field-name-agnostic (the spec
 *      hints at "completed and remaining work amounts" without schema backing — sandbox
 *      item), and accepted ONLY when the deltas sum to the draw's approved total to the
 *      cent. Anything less than exact is discarded — never guessed.
 *   2. MANUAL — the coordinator transcribes per-line approvals from TrustPoint's console
 *      (she has it open for the import anyway); validated to the same cent-exact total.
 */

const db = require('../db');
const client = require('./client');

const C = client.centsFromTp;

/** Store a raw milestone snapshot (best-effort; failures never block the mirror). */
async function snapshotMilestones(appId, tpProjectId, tpDrawId, phase) {
  try {
    if (!client.available()) return null;
    const ms = await client.listMilestones(tpProjectId);
    if (!Array.isArray(ms) || !ms.length) return null;
    const payload = JSON.stringify(ms);
    if (payload.length > 200000) return null;   // never a sliced (invalid) jsonb fragment
    await db.query(
      `INSERT INTO trustpoint_milestone_snapshots (application_id, tp_project_id, tp_draw_id, phase, lines)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [appId, tpProjectId, tpDrawId || null, phase, payload]);
    return true;
  } catch (e) { console.warn('[trustpoint] milestone snapshot failed:', e && e.message); return null; }
}

// Progress-ish numeric fields, direction-aware: "completed/funded/drawn/disbursed"
// grow with progress; "remaining" shrinks. Never budget/estimate fields (static),
// and never non-money shapes — booleans (`is_completed` flips are not $1 movements)
// or percent/rate/count fields (a 0→100 completed_percent is not $1.00).
const GROWS = /(complete|funded|drawn|disburse|approved_to_date|paid)/i;
const SHRINKS = /(remaining|balance)/i;
const STATIC = /(estimate|prefunding|budget|original)/i;
const NON_MONEY = /(percent|pct|_rate\b|rate_|ratio|count|number|qty|quantity|(^|_)(is|has)_)/i;

/** Per-milestone progress delta between two raw milestone objects (cents; null = none). */
function milestoneDelta(pre, post) {
  let best = null;
  for (const k of Object.keys(post || {})) {
    if (STATIC.test(k) || NON_MONEY.test(k)) continue;
    const isGrow = GROWS.test(k), isShrink = SHRINKS.test(k);
    if (!isGrow && !isShrink) continue;
    const pv = pre ? pre[k] : null, cv = post[k];
    if (typeof pv === 'boolean' || typeof cv === 'boolean') continue;
    const a = C(pv), b = C(cv);
    if (a == null || b == null) continue;
    const d = isGrow ? b - a : a - b;
    if (d > 0 && (best == null || d > best)) best = d;   // strongest positive movement wins
  }
  return best;
}

/**
 * Try to derive this draw's per-line approved amounts from the snapshots.
 * Accepts ONLY a cent-exact Σ == approved_cents. Returns {derived, lines?, reason?}.
 */
async function deriveLines(appId, tpDrawId) {
  const draw = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
  if (!draw || draw.approved_cents == null) return { derived: false, reason: 'no_approved_total' };
  const post = (await db.query(
    `SELECT * FROM trustpoint_milestone_snapshots WHERE tp_draw_id=$1 AND phase='post' ORDER BY taken_at DESC LIMIT 1`, [tpDrawId])).rows[0];
  if (!post) return { derived: false, reason: 'no_post_snapshot' };
  const pre = (await db.query(
    `SELECT * FROM trustpoint_milestone_snapshots
      WHERE tp_project_id=$1 AND taken_at < $2 ORDER BY taken_at DESC LIMIT 1`,
    [draw.tp_project_id, post.taken_at])).rows[0];
  if (!pre) return { derived: false, reason: 'no_pre_snapshot' };

  const preBy = new Map();
  for (const m of (Array.isArray(pre.lines) ? pre.lines : [])) preBy.set(String(m.id), m);
  const links = (await db.query(
    `SELECT tp_milestone_id, sitewire_job_item_id, sow_line_key, name FROM trustpoint_milestone_links WHERE application_id=$1`, [appId])).rows;
  const linkBy = new Map(links.map((l) => [String(l.tp_milestone_id), l]));

  const out = [];
  let sum = 0;
  for (const m of (Array.isArray(post.lines) ? post.lines : [])) {
    const d = milestoneDelta(preBy.get(String(m.id)), m);
    if (d == null || d === 0) continue;
    const link = linkBy.get(String(m.id));
    if (!link || link.sitewire_job_item_id == null) return { derived: false, reason: 'moved_milestone_not_crosswalked' };
    out.push({ sitewire_job_item_id: Number(link.sitewire_job_item_id), sow_line_key: link.sow_line_key, name: link.name || m.name || null, approved_cents: d });
    sum += d;
  }
  if (!out.length) return { derived: false, reason: 'no_movement' };
  if (sum !== Number(draw.approved_cents)) return { derived: false, reason: `sum_mismatch (${sum} vs ${draw.approved_cents})` };

  for (const l of out) {
    // A MANUAL entry always outranks a derivation (the human transcribed TrustPoint's
    // console) — the upsert never clobbers a manual amount or its source.
    await db.query(
      `INSERT INTO trustpoint_draw_lines (application_id, tp_draw_id, sitewire_job_item_id, sow_line_key, name, approved_cents, source)
       VALUES ($1,$2,$3,$4,$5,$6,'derived')
       ON CONFLICT (tp_draw_id, sitewire_job_item_id) DO UPDATE SET
          approved_cents=CASE WHEN trustpoint_draw_lines.source='manual' THEN trustpoint_draw_lines.approved_cents ELSE EXCLUDED.approved_cents END,
          name=COALESCE(EXCLUDED.name, trustpoint_draw_lines.name), updated_at=now()`,
      [appId, tpDrawId, l.sitewire_job_item_id, l.sow_line_key, l.name, l.approved_cents]);
  }
  return { derived: true, lines: out };
}

/**
 * The coordinator's manual per-line entry. Every entry must map to a real crosswalk
 * line; the Σ must equal the draw's approved total to the cent (else 422-shaped error).
 */
async function saveManualLines(appId, tpDrawId, entries, staffId) {
  const draw = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1 AND application_id=$2`, [tpDrawId, appId])).rows[0];
  if (!draw) { const e = new Error('draw not found'); e.status = 404; throw e; }
  if (draw.approved_cents == null) { const e = new Error('This draw has no approved total yet — wait for the approval to arrive.'); e.status = 422; throw e; }
  if (!Array.isArray(entries) || !entries.length) { const e = new Error('No line amounts given.'); e.status = 400; throw e; }
  // Same set the picker shows: real budget lines only (no media anchors, no deleted).
  const valid = (await db.query(
    `SELECT sitewire_job_item_id, sow_line_key, name FROM sitewire_job_item_links
      WHERE application_id=$1 AND sitewire_job_item_id IS NOT NULL
        AND is_media_item=false AND (state IS NULL OR state<>'deleted')`, [appId])).rows;
  const validBy = new Map(valid.map((v) => [Number(v.sitewire_job_item_id), v]));
  let sum = 0;
  const clean = [];
  const seen = new Set();
  for (const e0 of entries) {
    const jid = Number(e0.sitewire_job_item_id);
    const cents = Math.round(Number(e0.approved_cents));
    if (!Number.isFinite(jid) || !validBy.has(jid)) { const e = new Error(`Line ${e0.sitewire_job_item_id} is not one of this file's budget lines.`); e.status = 422; throw e; }
    if (seen.has(jid)) { const e = new Error('The same budget line was entered twice.'); e.status = 422; throw e; }
    seen.add(jid);
    if (!Number.isFinite(cents) || cents < 0) { const e = new Error('Every amount must be zero or more.'); e.status = 400; throw e; }
    clean.push({ jid, cents, key: validBy.get(jid).sow_line_key || null, name: validBy.get(jid).name });
    sum += cents;
  }
  if (sum !== Number(draw.approved_cents)) {
    const e = new Error(`The line amounts add up to ${(sum / 100).toFixed(2)} but TrustPoint approved ${(Number(draw.approved_cents) / 100).toFixed(2)} — they must match to the penny.`);
    e.status = 422; throw e;
  }
  // One transaction: the delete and the re-inserts land together or not at all.
  const clientDb = await db.getClient();
  try {
    await clientDb.query('BEGIN');
    await clientDb.query(`DELETE FROM trustpoint_draw_lines WHERE tp_draw_id=$1`, [tpDrawId]);
    for (const l of clean) {
      if (l.cents === 0) continue;   // zero lines add nothing to the write-back
      await clientDb.query(
        `INSERT INTO trustpoint_draw_lines (application_id, tp_draw_id, sitewire_job_item_id, sow_line_key, name, approved_cents, source, entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)`,
        [appId, tpDrawId, l.jid, l.key, l.name, l.cents, staffId || null]);
    }
    await clientDb.query('COMMIT');
  } catch (e) { try { await clientDb.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { clientDb.release(); }
  return { saved: clean.filter((l) => l.cents > 0).length, total_cents: sum };
}

async function linesFor(tpDrawId) {
  return (await db.query(
    `SELECT * FROM trustpoint_draw_lines WHERE tp_draw_id=$1 ORDER BY id`, [tpDrawId])).rows;
}

module.exports = { snapshotMilestones, deriveLines, saveManualLines, linesFor, _milestoneDelta: milestoneDelta };
