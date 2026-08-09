'use strict';
/**
 * "DOES THIS DRAW LINE HAVE INSPECTION PHOTOS?" — one answer, read from every place a photo can land
 * (owner-directed 2026-08-03, after the 195-197 Parrish St draw #1 flagged all four roof lines
 * "requesting $6,250.00 with no inspection photos attached — the work isn't verified" while the
 * report printed five photos under each of those very lines).
 *
 * ROOT CAUSE: the risk engine asked exactly ONE source — `sitewire_draw_requests.inspection_count`,
 * mirrored in `reconcile.reconcileOne` from `r.inspections.length` on the objects inside
 * `GET /draws/:id`. Sitewire's DRAW-level payload does not carry the inspections array (the same
 * shape problem that left `job_item.name` null and was fixed for names in 2026-07-22); only
 * `GET /requests/:id` does. So `Array.isArray(undefined)` was false, EVERY request mirrored as 0,
 * and the stored 0 then overwrote itself on every poll. Meanwhile the photos arrived perfectly
 * through `persistDrawFindings` (which DOES call getRequest) into `draw_finding_lines.photo_count`
 * and were archived into `draw_media` — the report read those and showed them.
 *
 * THE CLASS, not the instance: any "is there evidence?" test that trusts a single mirrored counter
 * will report "none" the moment that one payload omits the field. So evidence is now the UNION of
 * every durable record we hold, and a count is only ever raised by a fresher source, never lowered:
 *
 *   1. `sitewire_draw_requests.inspection_count`      — the live mirror (when Sitewire sends it)
 *   2. `draw_finding_lines.photo_count / video_count` — what the inspector actually filed, per line
 *   3. `draw_media`                                   — the photos/videos we archived into PILOT
 *
 * PURE — no DB, no network. The DB read lives with its callers.
 */

const N = (x) => Number(x || 0) || 0;
const rid = (v) => (v == null || v === '' ? null : Number(v));

/**
 * Build the per-request evidence map.
 *   requests     [{ sitewire_request_id, inspection_count }]
 *   findingLines [{ sitewire_request_id, photo_count, video_count }]
 *   media        [{ sitewire_request_id, kind }]   — rows from `draw_media`
 * Returns Map(requestId → { photos, videos, archived, count, sources:[…] }).
 * `count` is the highest evidence count any single source can prove.
 */
function buildEvidence({ requests = [], findingLines = [], media = [] } = {}) {
  const map = new Map();
  const ensure = (id) => {
    const k = rid(id);
    if (k == null || !Number.isFinite(k)) return null;
    if (!map.has(k)) map.set(k, { photos: 0, videos: 0, archived: 0, mirrored: 0, count: 0, sources: [] });
    return map.get(k);
  };
  for (const r of (Array.isArray(requests) ? requests : [])) {
    const e = ensure(r && r.sitewire_request_id); if (!e) continue;
    const n = Math.max(0, N(r.inspection_count));
    if (n > 0) { e.mirrored = n; e.sources.push('mirror'); }
  }
  for (const l of (Array.isArray(findingLines) ? findingLines : [])) {
    const e = ensure(l && l.sitewire_request_id); if (!e) continue;
    const p = Math.max(0, N(l.photo_count)), v = Math.max(0, N(l.video_count));
    if (p + v > 0) { e.photos += p; e.videos += v; e.sources.push('findings'); }
  }
  for (const m of (Array.isArray(media) ? media : [])) {
    const e = ensure(m && m.sitewire_request_id); if (!e) continue;
    const kind = String(m.kind || '');
    if (kind !== 'image' && kind !== 'video') continue;  // a draw PDF is not per-line evidence
    e.archived += 1;
    if (!e.sources.includes('archive')) e.sources.push('archive');
  }
  for (const e of map.values()) e.count = Math.max(e.mirrored, e.photos + e.videos, e.archived);
  return map;
}

/** True when ANY durable source proves this request was inspected. Unknown id → false (never guessed). */
function hasEvidence(evidence, requestId) {
  if (!evidence || typeof evidence.get !== 'function') return false;
  const e = evidence.get(rid(requestId));
  return !!(e && e.count > 0);
}

/** The count to SHOW for a request (the desk's "Photos" column) — the strongest source, never a stale 0. */
function evidenceCount(evidence, requestId, fallback = 0) {
  if (!evidence || typeof evidence.get !== 'function') return Math.max(0, N(fallback));
  const e = evidence.get(rid(requestId));
  return Math.max(0, N(fallback), e ? e.count : 0);
}

/**
 * The SQL that heals a stale `sitewire_draw_requests.inspection_count` from the durable sources.
 * GREATEST-only, so it can raise a count that Sitewire's draw payload never sent and can never lower
 * a real one. Parameters: $1 = application_id, $2 = sitewire_draw_id (NULL = every draw on the file).
 */
const HEAL_SQL = `
  UPDATE sitewire_draw_requests r
     SET inspection_count = GREATEST(COALESCE(r.inspection_count, 0), ev.n),
         updated_at = now()
    FROM (
      SELECT req_id, MAX(n) AS n FROM (
        SELECT fl.sitewire_request_id AS req_id,
               COALESCE(fl.photo_count, 0) + COALESCE(fl.video_count, 0) AS n
          FROM draw_finding_lines fl
          JOIN draw_findings f ON f.id = fl.finding_id
         WHERE f.application_id = $1 AND ($2::bigint IS NULL OR f.sitewire_draw_id = $2)
           AND fl.sitewire_request_id IS NOT NULL
        UNION ALL
        SELECT dm.sitewire_request_id AS req_id, COUNT(*)::int AS n
          FROM draw_media dm
         WHERE dm.application_id = $1 AND ($2::bigint IS NULL OR dm.sitewire_draw_id = $2)
           AND dm.sitewire_request_id IS NOT NULL AND dm.kind IN ('image', 'video')
         GROUP BY dm.sitewire_request_id
      ) s GROUP BY req_id
    ) ev
   WHERE r.sitewire_request_id = ev.req_id
     AND ev.n > COALESCE(r.inspection_count, 0)
     AND EXISTS (SELECT 1 FROM sitewire_draws d
                  WHERE d.sitewire_draw_id = r.sitewire_draw_id AND d.application_id = $1)`;

module.exports = { buildEvidence, hasEvidence, evidenceCount, HEAL_SQL };
