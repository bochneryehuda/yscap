'use strict';
/**
 * SITEWIRE PROPERTY DOCUMENTS → THE PILOT DRAW (owner-directed 2026-08-10).
 *
 * THE REPORT. The borrower EMAILED a PDF to Sitewire as proof for draw 1 — it landed in
 * Sitewire's Documents tab as "CCF_000016.pdf — From inbound email, Draw 1" — and PILOT never
 * saw it: it was not on the draw, not reviewable, and it never travelled to the investor.
 * The owner: "anything like this should be included and attached to the draw as invoices and
 * additional proof … everything that is attached over there should be part of the investor
 * delivery."
 *
 * HOW IT WORKS. Sitewire's `GET /properties/:id` nests read-only `documents:[…]`, each carrying
 * `draw_id`, `uploaded_by_email`, `created_at`, an optional `checklist` label, and a `src`
 * download link (ActiveStorage redirect). This module runs at the tail of every reconcile —
 * on the property payload the reconcile ALREADY fetched, so it costs no extra Sitewire call —
 * and files every draw-linked document onto the matching PILOT draw through the ordinary
 * draw-attachments door (`drawAttachments.attach`), so it inherits the byte sniff, the HEIC→JPEG
 * conversion, the EXIF strip, the duplicate guards, the SharePoint mirror and the investor
 * delivery for free.
 *
 * THE RULES, each load-bearing:
 *  - ONLY a document with a `draw_id` that maps to a mirrored draw ON THIS FILE is pulled.
 *    That one filter does two jobs: it puts the proof on the RIGHT draw, and it excludes
 *    PILOT's OWN pushed property documents (appraisal PDF, Scope of Work), which are property-
 *    level and carry no draw. A property-level document is not lost — the coordinator's
 *    "Documents & borrower invite" card already lists everything Sitewire holds, live.
 *  - BORN PENDING, like every borrower upload. Someone outside the company emailed this in;
 *    a reviewer accepts it before it ships to an investor (db/424: a document nobody accepted
 *    never leaves the building). The delivery preview names anything still waiting.
 *  - The DOWNLOAD is host-allowlisted (the orchestrator's own `safeSitewireDocUrl`) and goes
 *    through the media archive's SSRF-guarded `fetchBinary` (https + public IP every redirect
 *    hop, size-capped streaming read).
 *  - NEVER TWICE. Each Sitewire document has a durable identity — draw + upload time + the
 *    filename off its redirect URL — recorded as `draw_attachments.source_key` (unique per
 *    file, db/517). A document whose BYTES are already on the loan file under any name
 *    (sha256) is recorded as done without filing a second copy.
 *  - A REFUSAL IS REMEMBERED. A document Sitewire holds that PILOT will not file (a file type
 *    a loan file doesn't carry, bytes that never download) is written into the link's
 *    `raw.doc_ingest_skips` ledger with its reason, so the poll does not re-download it every
 *    cycle forever. A TRANSIENT failure is deliberately NOT remembered — the next pass retries.
 *  - Best-effort end to end: this can never throw out of a reconcile, and a failure here can
 *    never affect the draw mirror it rides behind.
 */

const crypto = require('crypto');
const db = require('../db');
const drawAttachments = require('./draw-attachments');

const MAX_PER_PASS = 8;            // new documents pulled per file per reconcile — the poll cycles
const MAX_SKIP_LEDGER = 300;       // remembered refusals per file (oldest dropped first)
// A refusal that will refuse IDENTICALLY next pass is remembered; anything else retries. The
// `larger than` arm matches attach()'s own oversize wording ("it is larger than 25 MB") — the
// pre-merge audit proved a 26 MB PDF was re-downloaded on EVERY poll forever without it, each
// failed attempt burning one of the per-pass slots.
const PERMANENT_REASON = /not accepted here|file type|too large|larger than|was empty|could not be read/i;

/** The durable identity of one Sitewire-side document on this file. */
function sourceKeyOf(d) {
  const draw = d && d.draw_id != null ? String(d.draw_id) : '';
  const at = d && (d.created_at || d.uploaded_at) ? String(d.created_at || d.uploaded_at) : '';
  return `sw:${draw}:${at}:${filenameOf(d)}`.slice(0, 300);
}

/** The original filename, off the ActiveStorage redirect URL's last path segment. */
function filenameOf(d) {
  const src = String((d && (d.src || d.url || d.download_url || d.file_url)) || '');
  try {
    const seg = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
    if (seg) return seg.slice(0, 160);
  } catch (_) { /* fall through */ }
  return 'sitewire-document';
}

/** One plain sentence saying where this came from — shown on the draw card and in the audit trail. */
function provenanceNote(d) {
  const bits = ['Pulled from Sitewire'];
  if (d && d.uploaded_by_email) bits.push(`uploaded by ${String(d.uploaded_by_email).slice(0, 80)}`);
  const when = d && (d.created_at || d.uploaded_at);
  if (when) { const day = String(when).slice(0, 10); if (day) bits.push(`on ${day}`); }
  const cl = d && d.checklist && (d.checklist.item_name || d.checklist.name);
  if (cl) bits.push(`(${String(cl).slice(0, 60)})`);
  return bits.join(' ');
}

/* The remembered refusals for one file. { key: { reason, at } } — read/write on the link's raw jsonb. */
async function readSkips(appId) {
  try {
    const r = (await db.query(`SELECT raw->'doc_ingest_skips' AS s FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
    return (r && r.s && typeof r.s === 'object') ? r.s : {};
  } catch (_) { return {}; }
}
async function writeSkips(appId, skips) {
  try {
    const keys = Object.keys(skips);
    if (keys.length > MAX_SKIP_LEDGER) {
      keys.sort((a, b) => String(skips[a].at || '').localeCompare(String(skips[b].at || '')));
      for (const k of keys.slice(0, keys.length - MAX_SKIP_LEDGER)) delete skips[k];
    }
    await db.query(
      `UPDATE sitewire_property_links
          SET raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('doc_ingest_skips', $2::jsonb), updated_at=now()
        WHERE application_id=$1`,
      [appId, JSON.stringify(skips)]);
  } catch (_) { /* the ledger is an optimisation — losing it re-downloads, never corrupts */ }
}

/**
 * Pull the new draw-linked documents off one property payload onto the file's draws.
 * `prop` is the `GET /properties/:id` body the reconcile already holds.
 * opts._fetch / opts._safeUrl are test seams; production uses the guarded real ones.
 * Returns { pulled, skipped, failed } and NEVER throws.
 */
async function ingestForProperty(appId, prop, opts = {}) {
  const out = { pulled: 0, skipped: 0, failed: 0, added: [] };
  try {
    const docs = (prop && (prop.documents || (prop.property && prop.property.documents))) || [];
    if (!Array.isArray(docs) || !docs.length) return out;

    // Lazy requires: the orchestrator and this module ride the same require graph as the
    // reconcile — loading them at call time keeps the module load-order cycle-proof.
    const orch = require('./orchestrator');
    const media = require('./media-archive');
    const safeUrl = opts._safeUrl || orch.safeSitewireDocUrl;
    const fetchBinary = opts._fetch || media.fetchBinary;

    // Which Sitewire draws are mirrored on THIS file — the map that puts each document on the
    // right draw and keeps another property's draw id from ever landing here. The number rides
    // along so the desk cue can say "draw #1" (what the panel shows), never the platform id.
    const drawRows = (await db.query(`SELECT sitewire_draw_id, number FROM sitewire_draws WHERE application_id=$1`, [appId])).rows;
    const ourDraws = new Set(drawRows.map((r) => String(r.sitewire_draw_id)));
    const drawNumberOf = new Map(drawRows.map((r) => [String(r.sitewire_draw_id), r.number]));
    if (!ourDraws.size) return out;

    const candidates = docs.filter((d) => d && d.draw_id != null && ourDraws.has(String(d.draw_id)));
    if (!candidates.length) return out;

    // Already pulled / already refused — decided BEFORE any download.
    const keys = candidates.map(sourceKeyOf);
    const have = new Set((await db.query(
      `SELECT source_key FROM draw_attachments WHERE application_id=$1 AND source_key = ANY($2::text[])`,
      [appId, keys])).rows.map((r) => r.source_key));
    const skips = await readSkips(appId);
    let skipsDirty = false;

    let pulledThisPass = 0;
    for (const d of candidates) {
      const key = sourceKeyOf(d);
      if (have.has(key) || skips[key]) { out.skipped++; continue; }
      if (pulledThisPass >= MAX_PER_PASS) break;                      // the poll cycles; never a big-bang pull

      const url = safeUrl(d.src || d.url || d.download_url || d.file_url);
      if (!url) {                                                     // a host outside the allowlist never gets fetched
        skips[key] = { reason: 'link not on an allowed host', at: new Date().toISOString() };
        skipsDirty = true; out.failed++; continue;
      }
      // safeSitewireDocUrl tolerates http:// (it exists to render links), but the SSRF-guarded
      // download is https-only — so an http link would read as a transient failure and be
      // re-tried every poll forever. It is a permanent property of the URL: remember it.
      if (/^http:/i.test(url)) {
        skips[key] = { reason: 'link is not https', at: new Date().toISOString() };
        skipsDirty = true; out.failed++; continue;
      }

      let bytes;
      try { bytes = await fetchBinary(url); }
      catch (e) {
        // A transient network failure retries next pass; a refusal that will repeat identically
        // is remembered — the size cap, and a 404/410 (the blob is gone from Sitewire's storage;
        // re-asking every poll forever answers 404 every poll forever).
        const msg = String(e && e.message);
        if (/too large/i.test(msg)) { skips[key] = { reason: 'too large to pull', at: new Date().toISOString() }; skipsDirty = true; }
        else if (/fetch (404|410)/.test(msg)) { skips[key] = { reason: 'the file is gone from Sitewire', at: new Date().toISOString() }; skipsDirty = true; }
        out.failed++; continue;
      }
      pulledThisPass++;
      // The download cap (30 MB) is wider than the loan-document cap (25 MB). Refuse the
      // in-between sizes HERE, durably, instead of round-tripping the bytes through attach()
      // to be refused there every pass.
      if (bytes.buf.length > drawAttachments.MAX_BYTES) {
        skips[key] = { reason: `larger than ${Math.round(drawAttachments.MAX_BYTES / 1024 / 1024)} MB`, at: new Date().toISOString() };
        skipsDirty = true; out.failed++; continue;
      }

      // Bytes already on the loan file under any name (PILOT pushed it, or somebody uploaded the
      // same file by hand)? Record the key as done — never file a second copy.
      const hash = crypto.createHash('sha256').update(bytes.buf).digest('hex');
      try {
        const dup = (await db.query(
          `SELECT id FROM documents WHERE application_id=$1 AND sha256=$2 AND is_current LIMIT 1`, [appId, hash])).rows[0];
        if (dup) {
          skips[key] = { reason: 'these bytes are already on the file', at: new Date().toISOString() };
          skipsDirty = true; out.skipped++; continue;
        }
      } catch (_) { /* the attach path has its own guards */ }

      const filename = filenameOf(d);
      const res = await drawAttachments.attach(appId, { sitewireDrawId: String(d.draw_id) }, [{
        filename, dataBase64: bytes.buf.toString('base64'),
        note: provenanceNote(d), source: 'sitewire_property_doc', sourceKey: key,
      }], { by: { kind: 'borrower', id: null } });

      if (res.added.length) {
        out.pulled++; out.added.push({ drawId: String(d.draw_id), filename: res.added[0].filename, attachmentId: res.added[0].id });
      } else {
        const reason = (res.skipped[0] && res.skipped[0].reason) || 'could not be filed';
        // Only a PERMANENT refusal is remembered — "please try again" reasons retry next pass.
        if (PERMANENT_REASON.test(reason) || /already attached/i.test(reason)) {
          skips[key] = { reason, at: new Date().toISOString() }; skipsDirty = true;
        }
        out.failed++;
      }
    }
    if (skipsDirty) await writeSkips(appId, skips);

    // Tell the desk — one in-app note per pass, not one per file pulled. It is a review cue
    // (the document ships to the investor only once somebody accepts it), so it must be seen,
    // but it is routine enough that an email would be bombardment.
    if (out.pulled > 0) {
      try {
        const notify = require('../lib/notify');
        const byDraw = new Map();
        for (const a of out.added) byDraw.set(a.drawId, (byDraw.get(a.drawId) || 0) + 1);
        // Name each draw by its NUMBER (what the panel shows), never the platform id.
        const what = [...byDraw.entries()].map(([id, n]) => {
          const num = drawNumberOf.get(String(id));
          return `${n} document${n === 1 ? '' : 's'} on draw #${num != null ? num : id}`;
        }).join(', ');
        await notify.notifyAppStaff(appId, {
          type: 'draw_docs_pulled',
          title: 'Documents pulled from Sitewire onto a draw',
          body: `PILOT pulled ${what} that arrived on Sitewire (borrower-emailed proof). Review and accept them so they travel with the investor delivery.`,
          link: `/internal/app/${appId}`, applicationId: appId, inAppOnly: true,
        });
      } catch (_) { /* a missed note never blocks the pull */ }
    }
  } catch (e) {
    try { console.warn(`[sitewire] property-doc ingest failed (app=${appId}): ${(e && e.message) || e}`); } catch (_) {}
  }
  return out;
}

/**
 * A staff REMOVE of a pulled document is a decision, and it must stick (pre-merge audit defect 2:
 * detach deletes the draw_attachments row — and with it the source_key the "already pulled" set
 * reads — so the next poll re-pulled the document; the sha256 belt misses any image whose stored
 * bytes were transformed on the way in, i.e. every HEIC conversion and every GPS-EXIF strip, so a
 * removed phone photo resurrected as a NEW documents row on every remove/poll cycle, each copy
 * mirrored to SharePoint, which never deletes). The DELETE route calls this with the removed
 * attachment's source_key BEFORE the poll can run again. Best-effort, never throws.
 */
async function rememberRemoved(appId, sourceKey) {
  try {
    if (!appId || !sourceKey) return;
    const skips = await readSkips(appId);
    skips[String(sourceKey)] = { reason: 'removed from the draw by staff', at: new Date().toISOString() };
    await writeSkips(appId, skips);
  } catch (_) { /* worst case the document is re-pulled once more and removed again */ }
}

module.exports = { ingestForProperty, rememberRemoved, _internals: { sourceKeyOf, filenameOf, provenanceNote, PERMANENT_REASON, MAX_PER_PASS } };
