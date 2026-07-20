/* Durable inspector media (Draw Management phase 2a, owner-directed 2026-07-20).
 *
 * Sitewire hands us inspection photos/videos + the per-draw PDF as PUBLIC, PRE-SIGNED, EXPIRING URLs. This
 * module pulls them into PILOT's OWN storage (src/lib/storage.js) and records the durable copy in
 * `draw_media`, so the staff gallery and the branded reports (phase 2b) never break when a link expires.
 * No Sitewire auth is needed to fetch the media (the 3-header token is API-only) — these are plain public
 * URLs. Best-effort + idempotent: re-archiving a draw skips what's already stored and never throws the
 * whole run on one bad download.
 */
const crypto = require('crypto');
const db = require('../db');
const storage = require('../lib/storage');

const MAX_ITEMS = 80;                 // hard cap on media pulled per archive run
const PER_FILE_CAP = 30 * 1024 * 1024; // 30 MB per photo/video/PDF
const FETCH_TIMEOUT_MS = 25000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// content-type → a safe file extension for storage.save (falls back to the URL's own extension).
function extFor(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (/jpeg|jpg/.test(ct)) return 'jpg';
  if (/png/.test(ct)) return 'png';
  if (/gif/.test(ct)) return 'gif';
  if (/webp/.test(ct)) return 'webp';
  if (/mp4/.test(ct)) return 'mp4';
  if (/quicktime|mov/.test(ct)) return 'mov';
  if (/pdf/.test(ct)) return 'pdf';
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase().slice(0, 4) : 'bin';
}

/* PURE (no DB / no network) — decide what to archive. Given a draw's finding lines (each with a `media`
 * array), the draw's pdf_src, and the set of source_keys already archived, return the de-duplicated,
 * capped list of items to fetch+store. Unit-testable in isolation. */
function planArchive({ lines = [], pdfSrc = null, archivedKeys = new Set() }) {
  const out = [];
  const seen = new Set(archivedKeys instanceof Set ? archivedKeys : []);
  const add = (item) => {
    if (!item.source_url || typeof item.source_url !== 'string') return;
    const key = sha256(item.source_url);
    if (seen.has(key)) return;                 // already archived, or a dup within this plan
    seen.add(key);
    out.push({ ...item, source_key: key });
  };
  for (const l of (Array.isArray(lines) ? lines : [])) {
    const media = Array.isArray(l && l.media) ? l.media : [];
    for (const m of media) {
      if (!m || !m.src) continue;
      add({
        source_url: m.src,
        kind: (m.type === 'video') ? 'video' : 'image',
        sitewire_request_id: l.sitewire_request_id != null ? Number(l.sitewire_request_id) : null,
        sow_line_key: l.sow_line_key || null,
        captured_at: m.captured_at || null,
        lat: (m.lat != null && isFinite(m.lat)) ? Number(m.lat) : null,
        lng: (m.lng != null && isFinite(m.lng)) ? Number(m.lng) : null,
        note: m.note || (l.inspector_comments || null),
      });
    }
  }
  if (pdfSrc && typeof pdfSrc === 'string') {
    add({ source_url: pdfSrc, kind: 'draw_pdf', sitewire_request_id: null, sow_line_key: null, captured_at: null, lat: null, lng: null, note: null });
  }
  return out.slice(0, MAX_ITEMS);
}

// Fetch a public URL into a Buffer with a timeout + size cap. Throws on any failure (caller skips per item).
async function fetchBinary(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r || !r.ok) throw new Error(`fetch ${r ? r.status : 'failed'}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > PER_FILE_CAP) throw new Error('too large');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > PER_FILE_CAP) throw new Error('too large');
    if (!buf.length) throw new Error('empty');
    return { buf, contentType: (r.headers.get('content-type') || '').split(';')[0].trim() || null };
  } finally { clearTimeout(t); }
}

/* Archive every not-yet-stored media item + PDF for one draw (owned by appId). Best-effort. */
async function archiveDrawMedia(appId, sitewireDrawId) {
  const drawId = Number(sitewireDrawId);
  if (!appId || !Number.isInteger(drawId) || drawId <= 0) return { archived: 0, skipped: 0, failed: 0, items: [] };
  // persisted finding lines (media) for this draw on this file
  const lines = (await db.query(
    `SELECT l.sitewire_request_id, l.sow_line_key, l.inspector_comments, l.media
       FROM draw_finding_lines l JOIN draw_findings f ON f.id = l.finding_id
      WHERE f.application_id = $1 AND f.sitewire_draw_id = $2`, [appId, drawId])).rows;
  const pdfSrc = (await db.query(
    `SELECT pdf_src FROM sitewire_draws WHERE application_id = $1 AND sitewire_draw_id = $2`, [appId, drawId])).rows[0];
  const archivedKeys = new Set((await db.query(
    `SELECT source_key FROM draw_media WHERE sitewire_draw_id = $1`, [drawId])).rows.map((r) => r.source_key));

  const plan = planArchive({ lines, pdfSrc: pdfSrc && pdfSrc.pdf_src, archivedKeys });
  let archived = 0, failed = 0;
  const items = [];
  for (const it of plan) {
    try {
      const { buf, contentType } = await fetchBinary(it.source_url);
      const filename = `draw${drawId}-${it.kind}-${it.source_key.slice(0, 12)}.${extFor(contentType, it.source_url)}`;
      const saved = await storage.save(buf, { filename });
      const ins = await db.query(
        `INSERT INTO draw_media (application_id, sitewire_draw_id, sitewire_request_id, sow_line_key, kind,
            source_url, source_key, storage_provider, storage_ref, content_type, bytes, sha256,
            captured_at, lat, lng, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (sitewire_draw_id, source_key) DO NOTHING
         RETURNING id`,
        [appId, drawId, it.sitewire_request_id, it.sow_line_key, it.kind, it.source_url, it.source_key,
         saved.provider, saved.ref, contentType, buf.length, sha256(buf), it.captured_at, it.lat, it.lng, it.note]);
      if (ins.rows.length) { archived++; items.push({ source_url: it.source_url, media_id: ins.rows[0].id }); }
    } catch (e) {
      failed++;
      // eslint-disable-next-line no-console
      console.warn(`[sitewire] archive media failed (draw=${drawId}): ${e.message}`);
    }
  }
  return { archived, skipped: archivedKeys.size, failed, items };
}

// The archived media for a draw, as a source_url → id map (so the gallery can prefer the durable copy).
async function archivedMediaFor(appId, sitewireDrawId) {
  const drawId = Number(sitewireDrawId);
  if (!Number.isInteger(drawId) || drawId <= 0) return [];
  return (await db.query(
    `SELECT id, source_url, kind FROM draw_media WHERE application_id = $1 AND sitewire_draw_id = $2`,
    [appId, drawId])).rows;
}

module.exports = { planArchive, archiveDrawMedia, archivedMediaFor, fetchBinary, sha256, extFor, PER_FILE_CAP, MAX_ITEMS };
