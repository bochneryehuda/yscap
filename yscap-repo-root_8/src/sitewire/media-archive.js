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
const dns = require('dns').promises;
const net = require('net');
const db = require('../db');
const storage = require('../lib/storage');

const MAX_ITEMS = 80;                 // hard cap on media pulled per archive run
const PER_FILE_CAP = 30 * 1024 * 1024; // 30 MB per photo/video/PDF
const RUN_TOTAL_CAP = 600 * 1024 * 1024; // 600 MB total per archive run (disk guard)
const FETCH_TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 4;

// ---- SSRF guard ----------------------------------------------------------
// The media URLs come from Sitewire's authenticated API (a trusted boundary), but this is the repo's
// only server-side fetch of a stored, variable-host URL — so validate every hop: https-only, and the
// resolved host must not be loopback/private/link-local/CGNAT/cloud-metadata. Redirects are followed
// MANUALLY so a public URL can't 302 to an internal one. (Residual DNS-rebinding window is accepted
// under the Sitewire trust model.)
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;                 // link-local + metadata (169.254.169.254)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase().replace(/^\[|\]$/g, '');
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:169.254.');
  }
  return true; // unresolvable / unknown family → reject
}
async function assertPublicHttps(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { throw new Error('bad media url'); }
  if (u.protocol !== 'https:') throw new Error('media url is not https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let ips;
  if (net.isIP(host)) ips = [host];
  else { ips = (await dns.lookup(host, { all: true })).map((r) => r.address); }
  if (!ips.length) throw new Error('media host did not resolve');
  for (const ip of ips) if (isPrivateIp(ip)) throw new Error('media url resolves to a private/internal address');
}

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

// Fetch a public URL into a Buffer with SSRF validation on every hop + a timeout + size cap. Throws on any
// failure (caller skips per item). Redirects are followed MANUALLY so each hop's host is re-validated.
async function fetchBinary(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHttps(current);                 // https + non-private, every hop
      const r = await fetch(current, { signal: ac.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new Error(`redirect ${r.status} with no location`);
        current = new URL(loc, current).href;           // resolve relative, re-validate next loop
        continue;
      }
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      const len = Number(r.headers.get('content-length') || 0);
      if (len && len > PER_FILE_CAP) throw new Error('too large');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > PER_FILE_CAP) throw new Error('too large');
      if (!buf.length) throw new Error('empty');
      return { buf, contentType: (r.headers.get('content-type') || '').split(';')[0].trim() || null };
    }
    throw new Error('too many redirects');
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
  let archived = 0, failed = 0, totalBytes = 0;
  const items = [];
  for (const it of plan) {
    if (totalBytes >= RUN_TOTAL_CAP) { failed++; continue; } // disk guard — stop pulling once the run cap is hit
    try {
      const { buf, contentType } = await fetchBinary(it.source_url);
      totalBytes += buf.length;
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

module.exports = { planArchive, archiveDrawMedia, archivedMediaFor, fetchBinary, assertPublicHttps, isPrivateIp, sha256, extFor, PER_FILE_CAP, MAX_ITEMS };
