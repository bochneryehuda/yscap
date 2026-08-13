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
const { stripLocationExif } = require('../lib/image-exif');
const heic = require('../lib/heic');

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
// Extract the embedded IPv4 from an IPv4-mapped IPv6 literal, in either the dotted
// (::ffff:192.168.0.1) or hex (::ffff:c0a8:0001) form; null if not mapped.
function mappedIpv4(l) {
  // ::ffff:a.b.c.d (mapped) OR ::a.b.c.d (deprecated IPv4-COMPATIBLE) dotted forms —
  // both embed an unambiguous IPv4; extract it. The hex-compatible form (::hhhh:hhhh
  // with no ffff) is deliberately NOT treated as mapped: it collides with legitimate
  // public IPv6 low bits, and such literals are not returned by dns.lookup / not routed.
  let m = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(l);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}
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
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d dotted OR ::ffff:hhhh:hhhh hex) — extract the
    // embedded IPv4 and re-run the IPv4 rules so 192.168/172.16-31/100.64/etc. and the
    // hex form (::ffff:c0a8:0101 = 192.168.1.1) can't bypass the string-prefix checks
    // (SSRF hardening — the guard must hold on every hop).
    const v4 = mappedIpv4(l);
    if (v4) return isPrivateIp(v4);
    return false; // a genuine public IPv6
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

// Hash a Buffer by its RAW bytes and a string by its text. The old `String(s)`
// form UTF-8-decoded a Buffer (replacing every invalid byte with U+FFFD), so the
// stored content hash was not the file's hash — pass the Buffer straight through.
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : String(s)).digest('hex');

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
      // Audit finding C-6 (2026-07-21): the old classifier was `m.type==='video' ? 'video' : 'image'`,
      // which stamped kind='image' on ANYTHING that wasn't 'video' — including Sitewire PDF/audio/
      // document media entries. Downstream (draw-report / borrower gallery) tried addImage on a PDF
      // buffer or served an "image" that couldn't render. Now the classifier is strict: exactly the
      // known media_type values Sitewire emits map to our kinds; anything else is SKIPPED (rather
      // than mis-labeled). New kinds arriving from Sitewire will just not archive until we add them,
      // which is safer than silently coercing a mystery format to 'image'.
      let kind = null;
      const t = String(m.type || '').toLowerCase();
      if (t === 'image') kind = 'image';
      else if (t === 'video') kind = 'video';
      else if (t === 'pdf' || t === 'document') kind = 'document';
      if (!kind) continue; // unknown media_type — never guess
      add({
        source_url: m.src, kind,
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
// Read a response body into a Buffer, aborting as soon as the accumulated size
// exceeds `cap` — so a body with no/lying Content-Length can't be fully buffered.
async function readCapped(r, cap) {
  if (!r.body || typeof r.body.getReader !== 'function') {
    const buf = Buffer.from(await r.arrayBuffer());   // no stream reader available
    if (buf.length > cap) throw new Error('too large');
    return buf;
  }
  const reader = r.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch (_) { /* ignore */ } throw new Error('too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
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
      // Stream the body with a running cap so a missing/lying Content-Length can't
      // OOM the worker by buffering a multi-GB body before the size check.
      const buf = await readCapped(r, PER_FILE_CAP);
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
  // Already-archived rows for this draw: both the URL key (planArchive dedup) AND the CONTENT hash — so a
  // RE-DELIVERY under a rotated (freshly signed) Sitewire URL, whose source_key differs but whose bytes are
  // identical, can't store the same photo twice (audit follow-up: dedup by content, not just URL).
  const existing = (await db.query(
    `SELECT source_key, sha256 FROM draw_media WHERE sitewire_draw_id = $1`, [drawId])).rows;
  const archivedKeys = new Set(existing.map((r) => r.source_key));
  const seenHashes = new Set(existing.map((r) => r.sha256).filter(Boolean));

  const plan = planArchive({ lines, pdfSrc: pdfSrc && pdfSrc.pdf_src, archivedKeys });
  let archived = 0, failed = 0, deduped = 0, totalBytes = 0;
  const items = [];
  for (const it of plan) {
    if (totalBytes >= RUN_TOTAL_CAP) { failed++; continue; } // disk guard — stop pulling once the run cap is hit
    try {
      const fetched = await fetchBinary(it.source_url);
      // An iPhone photo (HEIC) is converted to JPEG BEFORE hashing/storing (owner-directed
      // 2026-08-10): the durable copy is what the galleries render, the branded reports embed
      // (jsPDF reads only JPEG/PNG), and the accept page serves — and none of them can read HEIC.
      // A failed conversion keeps the original bytes; the photo is never lost to gain a preview.
      let raw = fetched.buf, contentType = fetched.contentType;
      if (it.kind === 'image' && heic.isHeic(raw)) {
        const c = await heic.maybeConvert(raw);
        if (c.converted) { raw = c.buf; contentType = 'image/jpeg'; }
      }
      // Strip GPS/location EXIF from photos BEFORE we hash + store, so the durable copy (gallery, staff +
      // borrower reports) never carries the embedded capture location, and so the content hash is taken over
      // the SAME clean bytes on every delivery (a rotated URL for the same photo hashes identically →
      // dedup catches it). Non-images / undecodable bytes come back unchanged. (audit F-3.)
      const buf = it.kind === 'image' ? stripLocationExif(raw) : raw;
      const contentHash = sha256(buf);
      if (seenHashes.has(contentHash)) { deduped++; continue; } // same bytes already archived under another URL
      seenHashes.add(contentHash);
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
         saved.provider, saved.ref, contentType, buf.length, contentHash, it.captured_at, it.lat, it.lng, it.note]);
      if (ins.rows.length) { archived++; items.push({ source_url: it.source_url, media_id: ins.rows[0].id }); }
    } catch (e) {
      failed++;
      // eslint-disable-next-line no-console
      console.warn(`[sitewire] archive media failed (draw=${drawId}): ${e.message}`);
    }
  }
  return { archived, skipped: archivedKeys.size, deduped, failed, items };
}

// The archived media for a draw, as a source_url → id map (so the gallery can prefer the durable copy).
async function archivedMediaFor(appId, sitewireDrawId) {
  const drawId = Number(sitewireDrawId);
  if (!Number.isInteger(drawId) || drawId <= 0) return [];
  return (await db.query(
    `SELECT id, source_url, kind, sitewire_request_id FROM draw_media WHERE application_id = $1 AND sitewire_draw_id = $2 ORDER BY id`,
    [appId, drawId])).rows;
}

/* ONE-SWEEP BACKFILL — convert the HEIC photos already in the archive to JPEG (owner-directed
 * 2026-08-10: the accept-page photos were iPhone HEIC files no browser can render, and the
 * branded reports can only embed JPEG/PNG — so every already-archived HEIC is a photo nobody
 * can see). New archives convert at the door (above); this walks the back book ONCE.
 *
 * Shape: a durable CURSOR in sync_runtime_state ('draw_media_heic_backfill' → {lastId}) that
 * only ever moves FORWARD, so an unreadable row can never wedge the sweep or make it re-scan
 * forever — the sweep visits every row exactly once and self-terminates at the end. Bounded per
 * call; the ORIGINAL stored bytes are never deleted (storage never deletes) — the row is simply
 * re-pointed at the JPEG copy, with content_type/bytes/sha256 updated to describe what it now
 * points at. Never throws.
 */
async function backfillHeicMediaOnce(limit = 40) {
  const out = { scanned: 0, converted: 0, done: false };
  try {
    const st = (await db.query(`SELECT value FROM sync_runtime_state WHERE key='draw_media_heic_backfill'`)).rows[0];
    if (st && st.value && st.value.finished) { out.done = true; return out; }
    const lastId = Number(st && st.value && st.value.lastId) || 0;
    const rows = (await db.query(
      `SELECT id, storage_ref, storage_provider, content_type FROM draw_media
        WHERE id > $1 AND kind='image' AND storage_ref IS NOT NULL
        ORDER BY id ASC LIMIT $2`, [lastId, Math.max(1, limit)])).rows;
    if (!rows.length) {
      await db.query(
        `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ('draw_media_heic_backfill', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value=$1::jsonb, updated_at=now()`,
        [JSON.stringify({ lastId, finished: true, finishedAt: new Date().toISOString() })]);
      out.done = true; return out;
    }
    let cursor = lastId;
    for (const r of rows) {
      cursor = Number(r.id); out.scanned++;
      try {
        // Read from the row's OWN provider — on an s3 deployment a 'local' row would otherwise
        // cost a wasted S3 GET before the dual-read fallback found it on disk.
        const buf = await storage.forRow(r).read(r.storage_ref);
        if (!buf || !heic.isHeic(buf)) continue;
        // The WASM decode is CPU-bound and blocks the event loop for ~1–2s per photo. Pace the
        // sweep so a boot-time backlog can never freeze the request path or a health probe —
        // one conversion, then a real pause, repeat.
        await new Promise((res) => setTimeout(res, 1500));
        const c = await heic.maybeConvert(buf);
        if (!c.converted) continue;
        const clean = stripLocationExif(c.buf) || c.buf;
        const saved = await storage.save(clean, { filename: `draw-media-${r.id}.jpg` });
        // Re-point ONLY if the row still points where we read from — a concurrent re-archive wins.
        await db.query(
          `UPDATE draw_media SET storage_provider=$2, storage_ref=$3, content_type='image/jpeg', bytes=$4, sha256=$5
            WHERE id=$1 AND storage_ref=$6`,
          [r.id, saved.provider, saved.ref, clean.length, sha256(clean), r.storage_ref]);
        out.converted++;
      } catch (_) { /* the cursor still advances — one bad row never wedges the sweep */ }
    }
    await db.query(
      `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ('draw_media_heic_backfill', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb, updated_at=now()`,
      [JSON.stringify({ lastId: cursor })]);
  } catch (e) {
    try { console.warn(`[sitewire] HEIC media backfill: ${(e && e.message) || e}`); } catch (_) {}
  }
  return out;
}

/* THE DISPLAY COPY — a report-sized rendering of each photo, stored BESIDE the original
 * (owner-directed 2026-08-13: "the report itself should be able to handle more pictures").
 *
 * WHY THIS IS A BACKGROUND WORKER AND NOT PART OF archiveDrawMedia. Shrinking a photo means
 * decoding it, and `jpeg-js` is pure JavaScript (the repo's no-native-dependency rule): ~3
 * SECONDS per 12-megapixel photo, all of it BLOCKING THE EVENT LOOP. An 80-photo archive run
 * would freeze the whole server for four minutes — every request, every health probe. So the
 * archive path stays exactly as fast as it was, and the fitting happens here, ONE photo at a
 * time with a real pause between them, the same discipline as backfillHeicMediaOnce.
 *
 * IT IS A CONTINUOUS QUEUE, NOT A ONE-SHOT SWEEP. `display_checked_at IS NULL` is the work list
 * and stamping it is the drain, so newly archived photos and the whole back book flow through
 * the identical path — there is no second mechanism for new photos that could drift from this one.
 *
 * A ROW WHOSE BYTES CANNOT BE READ IS RETRIED A FEW TIMES AND THEN LEFT ALONE, which is the only
 * shape that survives both failure modes. Stamping it done on the first failure would let ONE
 * storage blip permanently condemn a whole draw's photos to being embedded at full size again.
 * Never giving up would be worse: the queue is ordered by id, so a handful of permanently missing
 * blobs would sit at its head forever and starve every real photo behind them. So the attempt
 * count rides in `display_skip_reason` ('unreadable:1'…) and the row drops out of the queue at
 * MAX_DISPLAY_READ_TRIES — still UNSTAMPED, so a deliberate re-sweep is one UPDATE away.
 *
 * FAILING TO BUILD A DISPLAY COPY COSTS NOTHING BUT SIZE. The report falls back to the original
 * bytes, so the worst case of every guess here is exactly the behaviour we had before — no photo
 * is ever lost by this worker.
 *
 * NOTHING IS EVER REPLACED OR DELETED: storage_ref keeps the inspector's original bytes and every
 * existing reader is untouched. Never throws.
 */
const MAX_DISPLAY_READ_TRIES = 3;

async function buildDisplayMediaOnce(limit = 20, opts = {}) {
  // `more` lets the caller come back sooner while a backlog is draining and back off once it is
  // empty, instead of picking one fixed interval that is either too slow or pointless churn.
  const out = { scanned: 0, built: 0, skipped: 0, unreadable: 0, savedBytes: 0, more: false };
  const pauseMs = Number.isFinite(opts.pauseMs) ? opts.pauseMs : 2000;
  try {
    const imageFit = require('../lib/image-fit');
    const rows = (await db.query(
      `SELECT id, storage_ref, storage_provider, content_type, bytes, display_skip_reason FROM draw_media
        WHERE display_checked_at IS NULL AND kind = 'image' AND storage_ref IS NOT NULL
          AND COALESCE(display_skip_reason,'') <> $2
        ORDER BY id ASC LIMIT $1`,
      [Math.max(1, limit), `unreadable:${MAX_DISPLAY_READ_TRIES}`])).rows;
    let progressed = 0;
    for (const r of rows) {
      out.scanned++;
      let buf = null;
      try {
        // Read from the row's OWN provider — on an s3 deployment a 'local' row would otherwise
        // cost a wasted S3 GET before the dual-read fallback found it on disk.
        buf = await storage.forRow(r).read(r.storage_ref);
      } catch (_) { buf = null; }
      if (!buf || !buf.length) {
        // Count the attempt so a blob that is genuinely gone eventually stops holding the head of
        // the queue — but leave display_checked_at NULL, so this is never confused with "we looked
        // at this photo and decided it needs no display copy".
        out.unreadable++;
        const tries = Math.min(MAX_DISPLAY_READ_TRIES,
          (parseInt(String(r.display_skip_reason || '').split(':')[1], 10) || 0) + 1);
        try {
          await db.query(`UPDATE draw_media SET display_skip_reason=$2 WHERE id=$1`, [r.id, `unreadable:${tries}`]);
          if (tries >= MAX_DISPLAY_READ_TRIES) progressed++;   // it left the queue — that IS progress
        } catch (_) { /* the retry simply happens again next pass */ }
        continue;
      }
      try {
        // Pace BEFORE the expensive part, so a backlog can never hold the event loop for more
        // than one photo's decode at a time.
        if (pauseMs > 0) await new Promise((res) => setTimeout(res, pauseMs));
        const fit = imageFit.fitJpeg(buf);
        if (!fit.changed) {
          // A real answer — "this one is already small", "this is a PNG", "shrinking made it
          // bigger". Stamped so it drains; the reports simply keep using the original bytes.
          await db.query(
            `UPDATE draw_media SET display_checked_at = now(), display_skip_reason = $2 WHERE id = $1`,
            [r.id, String(fit.reason || 'unchanged').slice(0, 40)]);
          out.skipped++; progressed++;
          continue;
        }
        const saved = await storage.save(fit.buf, { filename: `draw-media-${r.id}-display.jpg` });
        // Pinned to the ref we actually read from: a concurrent re-archive (which re-points
        // storage_ref) must win, rather than have us attach a display copy of the OLD bytes.
        const upd = await db.query(
          `UPDATE draw_media
              SET display_ref = $2, display_bytes = $3, display_width = $4, display_height = $5,
                  display_checked_at = now(), display_skip_reason = NULL
            WHERE id = $1 AND storage_ref = $6`,
          [r.id, saved.ref, fit.buf.length, fit.to && fit.to.w, fit.to && fit.to.h, r.storage_ref]);
        if (upd.rowCount) { out.built++; progressed++; out.savedBytes += Math.max(0, fit.bytesBefore - fit.bytesAfter); }
      } catch (_) { /* one bad row never stops the pass; it stays unstamped and is retried */ }
    }
    // `more` means "come back soon, there is real work left" — a FULL batch that made NO progress
    // (every row unreadable) must back off to the idle interval instead of spinning every minute.
    out.more = rows.length >= Math.max(1, limit) && progressed > 0;
  } catch (e) {
    try { console.warn(`[sitewire] display-media pass: ${(e && e.message) || e}`); } catch (_) {}
  }
  return out;
}

module.exports = { planArchive, archiveDrawMedia, archivedMediaFor, fetchBinary, assertPublicHttps, isPrivateIp, sha256, extFor, backfillHeicMediaOnce, buildDisplayMediaOnce, PER_FILE_CAP, MAX_ITEMS };
