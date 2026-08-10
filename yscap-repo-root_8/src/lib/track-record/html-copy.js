'use strict';

/* THE SAVED COPY IS BUILT ON THE SERVER (mega-workspace phase E, owner-directed
   2026-08-09 "continue with phases D E and F"; blueprint §8.4).

   THE GAP THIS CLOSES: the borrower's downloadable "saved static copy"
   (documents.doc_kind='track_record_html') was generated ONLY by the client
   tool's portal bridge — so a write that never opens the tool left the copy
   STALE: a staff PUT on the doors, the verify/revoke route, an importer
   decideCandidate, a merge/remove heal, a borrower confirm-found-property.
   The blueprint's own status note records that `track-record-export.js` has
   only a PDF and an xlsx builder — the HTML generator did not exist and had
   to be WRITTEN, not moved.

   HOW IT STAYS COMPLETE: generation hangs off `events.publishTrackRecordUpdate`
   — the ONE chokepoint every track-record write path already calls to drive
   the live cross-user refresh (#112). A write path that forgets the publisher
   already has a bug today (its edits don't live-refresh anyone), so the copy
   inherits the same coverage the SSE refresh has, at one call site, forever.

   TWO WRITERS, ONE DOCUMENT, ON PURPOSE: the borrower's own tool sheet (and
   frozen V1) still posts client-built copies — byte-untouched per constraint
   A13. Both writers go through track-record-snapshot.saveSnapshot, whose
   same-session COALESCE window (the "Version 47" rule) folds them onto one
   documents row, so the latest writer simply wins and SharePoint sees one
   version stream.

   THE DOCUMENT mirrors the client copy deliberately — same title, chips,
   three sections, same columns, same NMLS footer, same dark-canvas styling —
   so the copy the team has known for months does not change its face because
   the builder moved. (The dark canvas is this ARTIFACT's own established
   design; the portal white-first rule governs portal chrome, not this
   standalone download.) ONE deliberate divergence: the client copy's call to
   action deep-links a STATIC seed of the builder (`#d=<base64>`), which is a
   copy of a copy — this one links the LIVE portal record instead, which is
   always current.

   Borrower-safe by construction: the copy is `visibility='borrower'`, so it
   carries ONLY the deal facts the borrower's own tool shows — never lo_notes,
   never internal_notes, never a note-buyer name. Everything is HTML-escaped;
   an address is attacker-typed text. */

const STATUS_LABEL = {
  pending: 'Pending review',
  docs: 'Documentation required',
  verified: 'Verified',
  limited: 'Limited verification',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n ? '$' + Math.round(n).toLocaleString('en-US') : '—';
};
const day = (d) => (d ? String(d).slice(0, 10) : '');

/* The same bucket rule the tool, the ledger and experience.js all read:
   ground/construction first, then flip, else hold. */
function bucketOf(dealType) {
  const t = String(dealType || '').toLowerCase();
  if (t.indexOf('ground') >= 0 || t.indexOf('construction') >= 0) return 'ground';
  if (t.indexOf('flip') >= 0) return 'flip';
  return 'hold';
}

function addrLine(pa) {
  // A row stored as a bare one-line string (public-records import before the
  // shape fix) reads as the address, not "—".
  if (typeof pa === 'string') return pa.trim() || '—';
  const a = pa || {};
  return a.oneLine
    || [a.line1 || a.street || a.address, a.city, a.state, a.zip].filter(Boolean).join(', ')
    || '—';
}

function exitCell(r) {
  if (bucketOf(r.deal_type) === 'flip') {
    return 'Sold ' + money(r.sale_price) + (r.sale_date ? ' · ' + esc(day(r.sale_date)) : '');
  }
  const bits = [];
  if (r.rent_amount || r.rent_date) {
    bits.push('Rents ' + money(r.rent_amount) + '/mo' + (r.rent_date ? ' since ' + esc(day(r.rent_date)) : ''));
  }
  if (r.refi_amount || r.refi_date) {
    bits.push('Refi ' + money(r.refi_amount) + (r.refi_date ? ' · ' + esc(day(r.refi_date)) : ''));
  }
  // a SOLD hold/ground-up still states its sale (a ground-up exits on
  // whichever completion it has — the 2026-08-09 frozen amendment)
  if (!bits.length && (r.sale_price || r.sale_date)) {
    bits.push('Sold ' + money(r.sale_price) + (r.sale_date ? ' · ' + esc(day(r.sale_date)) : ''));
  }
  return bits.join('<br>') || '—';
}

function rowHtml(r) {
  const st = String(r.verification_status || 'pending');
  return '<tr><td>' + esc(addrLine(r.property_address)) +
    '</td><td>' + esc(r.owned_personally ? 'Personal name' : (r.entity_name || '—')) +
    '</td><td>' + esc(r.property_type || '—') +
    '</td><td>' + money(r.purchase_price) + (r.purchase_date ? '<br><small>' + esc(day(r.purchase_date)) + '</small>' : '') +
    '</td><td>' + money(r.rehab_amount) +
    '</td><td>' + exitCell(r) +
    '</td><td>' + esc(STATUS_LABEL[st] || st) + '</td></tr>';
}

function sectionHtml(title, list) {
  if (!list.length) return '';
  return '<h2>' + esc(title) + ' <small>(' + list.length + ')</small></h2>' +
    '<div class="tw"><table><thead><tr><th>Property</th><th>Entity</th><th>Type</th><th>Purchase</th><th>Rehab</th><th>Exit</th><th>Verification</th></tr></thead><tbody>' +
    list.map(rowHtml).join('') + '</tbody></table></div>';
}

/**
 * The whole standalone document, PURE — rows in, HTML out. `generatedAt` is
 * injected so the builder needs no clock (and the test can pin the output).
 */
function buildSavedCopyHtml({ borrowerName, rows, generatedAt, portalUrl }) {
  const props = Array.isArray(rows) ? rows : [];
  const flips = props.filter((r) => bucketOf(r.deal_type) === 'flip');
  const holds = props.filter((r) => bucketOf(r.deal_type) === 'hold');
  const ground = props.filter((r) => bucketOf(r.deal_type) === 'ground');
  const total = props.length;
  const when = generatedAt instanceof Date ? generatedAt : new Date(generatedAt || Date.now());
  const whenText = when.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const live = String(portalUrl || '/portal/#/track-record');
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Track Record — ' + esc(borrowerName || 'Borrower') + '</title><style>' +
    "body{font-family:'Hanken Grotesk',system-ui,Arial,sans-serif;background:#141B22;color:#F4F0E7;margin:0;padding:2rem 1rem;line-height:1.5}" +
    'main{max-width:960px;margin:0 auto}h1{font-family:Georgia,serif;font-weight:600;margin:0 0 .2rem}' +
    'h2{font-family:Georgia,serif;font-weight:600;margin:1.6rem 0 .5rem}h2 small{color:#A6B3BA;font-size:.7em}' +
    '.sum{display:flex;gap:.6rem;flex-wrap:wrap;margin:.8rem 0 1rem}' +
    '.chip{border:1px solid rgba(127,169,176,.5);border-radius:999px;padding:.25rem .8rem;font-size:.82rem;font-weight:600}' +
    '.muted{color:#A6B3BA;font-size:.85rem}.tw{overflow-x:auto;border:1px solid rgba(255,255,255,.09);border-radius:12px}' +
    'table{border-collapse:collapse;width:100%;min-width:680px;font-size:.86rem}' +
    'th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid rgba(255,255,255,.09);vertical-align:top}' +
    'th{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:#A6B3BA}tr:last-child td{border-bottom:0}' +
    'small{color:#A6B3BA}a.open{display:inline-block;margin:1.4rem 0;padding:.6rem 1.3rem;border-radius:10px;background:#7FA9B0;color:#08232b;font-weight:700;text-decoration:none}' +
    'footer{margin-top:2rem;color:#A6B3BA;font-size:.78rem}' +
    '</style></head><body><main>' +
    '<h1>YS Capital Group — Borrower Track Record</h1>' +
    '<p class="muted">' + esc(borrowerName || '') + (borrowerName ? ' · ' : '') + 'saved ' + esc(whenText) + '</p>' +
    '<div class="sum">' +
    '<span class="chip">' + total + ' deal' + (total === 1 ? '' : 's') + '</span>' +
    '<span class="chip">' + flips.length + ' fix &amp; flip</span>' +
    '<span class="chip">' + holds.length + ' fix &amp; hold</span>' +
    (ground.length ? '<span class="chip">' + ground.length + ' ground-up</span>' : '') +
    '</div>' +
    sectionHtml('Fix & Flip', flips) + sectionHtml('Fix & Hold', holds) + sectionHtml('Ground-up', ground) +
    (total === 0 ? '<p class="muted">No deals on record yet.</p>' : '') +
    '<a class="open" href="' + esc(live) + '">Open the live Track Record →</a>' +
    '<p class="muted">This is the saved static copy of the live track record. The portal keeps it in sync automatically.</p>' +
    '<footer>YS Capital Group · NMLS ID 2609746 · For verification and underwriting reference.</footer>' +
    '</main></body></html>';
}

/* ---------------- the IO half ---------------- */

function disabled() {
  return String(process.env.TRACK_RECORD_SERVER_COPY_DISABLED || '') === '1';
}

/**
 * Rebuild the borrower's saved copy from the database and store it through the
 * ONE snapshot chokepoint (coalesce + supersede + SharePoint kick all live
 * there). `uploaded_by_kind` is constrained to borrower|staff (db schema), so
 * the automated writer records 'staff' with no id — `source_type='system'`
 * (stamped inside saveSnapshot's INSERT) is what marks it machine-written.
 */
async function refreshSavedCopy(borrowerId, { client = null } = {}) {
  if (!borrowerId || disabled()) return null;
  const db = client || require('../../db');
  const b = (await db.query(
    `SELECT NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS name
       FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
  if (!b) return null;
  const rows = (await db.query(
    `SELECT property_address, deal_type, property_type, entity_name, owned_personally,
            purchase_price, purchase_date, rehab_amount, sale_price, sale_date,
            rent_amount, rent_date, refi_amount, refi_date, verification_status
       FROM track_records
      WHERE borrower_id=$1
      ORDER BY purchase_date DESC NULLS LAST, created_at DESC`, [borrowerId])).rows;
  const html = buildSavedCopyHtml({ borrowerName: b.name || 'Borrower', rows, generatedAt: new Date() });
  const who = String(b.name || 'Borrower').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'Borrower';
  const filename = 'Track_Record_' + who + '_' + new Date().toISOString().slice(0, 10) + '.html';
  const SNAP = require('../track-record-snapshot');
  return SNAP.saveSnapshot(borrowerId, { html, filename, uploadedByKind: 'staff', uploadedById: null });
}

/* A per-borrower TRAILING debounce: every write path fires the publisher, and
   an autosave burst is many publishes in a few seconds — one rebuild at the
   end is the right amount of work. Fire-and-forget and NEVER throws: a missed
   copy refresh must never fail (or even slow) the underlying write. */
const pending = new Map();   // borrowerId -> timer
const DEBOUNCE_MS = Math.max(500, parseInt(process.env.TRACK_RECORD_COPY_DEBOUNCE_MS || '4000', 10) || 4000);

function queueSavedCopyRefresh(borrowerId) {
  try {
    if (!borrowerId || disabled()) return;
    const key = String(borrowerId);
    const prior = pending.get(key);
    if (prior) clearTimeout(prior);
    const t = setTimeout(() => {
      pending.delete(key);
      refreshSavedCopy(key).catch((e) => {
        try { console.error('[track-record] saved-copy refresh failed:', e.message || e); } catch (_) { /* noop */ }
      });
    }, DEBOUNCE_MS);
    if (t.unref) t.unref();
    pending.set(key, t);
  } catch (_) { /* a copy refresh may never break a write */ }
}

/** Test hook: run whatever is queued NOW instead of waiting out the debounce. */
async function flushQueuedRefreshes() {
  const ids = [...pending.keys()];
  for (const [, t] of pending) clearTimeout(t);
  pending.clear();
  for (const id of ids) await refreshSavedCopy(id);
  return ids.length;
}

module.exports = {
  buildSavedCopyHtml,
  refreshSavedCopy,
  queueSavedCopyRefresh,
  flushQueuedRefreshes,
  _internals: { bucketOf, addrLine, exitCell, esc, STATUS_LABEL, pending, DEBOUNCE_MS },
};
