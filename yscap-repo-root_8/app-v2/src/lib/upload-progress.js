/* =====================================================================
   upload-progress.js — the ONE record of what is uploading right now.

   THE DEFECT (owner-reported 2026-08-23): *"everywhere in our system … when you
   upload a document, right now it's not doing anything while it's uploading.
   It's just blank, and it sounds like it's not uploading. For example, in the
   condition center, you upload a document. It waits till it actually uploads a
   document, and only then does it populate. … the second you upload a document,
   while the system is working to upload, it already has the document over there
   with a bar and a percentage. You should see that the system is actually doing
   work for you."*

   TWO REASONS IT SHOWED NOTHING, AND BOTH HAD TO BE FIXED:

     1. `fetch()` CANNOT REPORT UPLOAD PROGRESS. Every upload in this app went
        through `fetch`, whose promise settles when the RESPONSE arrives; there
        is no event for "42% of the request body has been sent". So even a
        surface that wanted a bar had no number to put in it. The transport is
        now XMLHttpRequest, whose `upload.onprogress` is the only browser API
        that reports bytes sent (see `uploadBinary` in lib/api.js).

     2. THE STATE WAS LOCAL TO EACH SURFACE. There are roughly twenty upload
        sites — the condition centre, entity slots, draws, appraisal orders,
        credit reports, track records, email replies, the doc lab. Threading a
        progress prop through each of them is twenty chances to get it wrong and
        twenty places for the twenty-first to be forgotten, which is exactly how
        "everywhere in our system" became true in the first place.

   So this is a tiny publish/subscribe store that the TRANSPORT writes to and any
   surface can read. A call site gets a live progress row by rendering
   <UploadRows target={…}/> where the document will land — one line — and the
   transport does the rest. No upload site has to remember to report anything.

   THE TARGET KEY is derived from the upload's own metadata (`uploadTarget`
   below), so a row appears against the condition, entity slot or draw it belongs
   to without any call site passing an extra argument. That is deliberate: a key
   somebody has to remember to pass is a key that will be missing on the next
   surface somebody adds.

   Rows are kept for a moment after they finish so the bar can reach 100% and be
   seen, and a FAILED row is kept until it is dismissed — an upload that failed
   silently is the same defect as an upload that showed nothing.
   ===================================================================== */

const listeners = new Set();
const rows = new Map();          // id -> row
let seq = 0;

// How long a finished row stays on screen. Long enough to read "done", short
// enough that it is gone by the time the real document row has rendered in its
// place. A failed row ignores this and stays until dismissed.
const DONE_LINGER_MS = 1400;

function emit() {
  const snapshot = Array.from(rows.values());
  for (const fn of listeners) { try { fn(snapshot); } catch (_) { /* a bad subscriber never breaks an upload */ } }
}

export function subscribe(fn) {
  listeners.add(fn);
  try { fn(Array.from(rows.values())); } catch (_) { /* noop */ }
  return () => listeners.delete(fn);
}

/**
 * The key a progress row files itself under, derived from the upload's own
 * metadata. Every upload path in this app already carries one of these, so the
 * row lands next to the thing being uploaded TO without a call site opting in.
 */
export function uploadTarget(meta) {
  const m = meta || {};
  if (m.progressKey) return String(m.progressKey);              // an explicit override, when a surface needs one
  if (m.checklistItemId) return `condition:${m.checklistItemId}`;
  if (m.llcId) return `entity:${m.llcId}`;
  if (m.trackRecordId) return `track:${m.trackRecordId}`;
  if (m.drawId) return `draw:${m.drawId}`;
  if (m.applicationId) return `file:${m.applicationId}`;
  return 'global';
}

/** Start tracking one file. Returns the row id. */
export function startUpload({ target, filename, size }) {
  const id = `up-${++seq}`;
  rows.set(id, {
    id, target: target || 'global',
    filename: filename || 'file', size: Number(size) || 0,
    loaded: 0, pct: 0, status: 'uploading', error: null, startedAt: Date.now(),
  });
  emit();
  return id;
}

export function updateUpload(id, { loaded, total }) {
  const r = rows.get(id);
  if (!r || r.status !== 'uploading') return;
  r.loaded = Number(loaded) || 0;
  if (total) r.size = Number(total);
  /* CAPPED AT 99 WHILE BYTES ARE STILL MOVING, AND THAT IS NOT COSMETIC.
     The browser fires its final upload event when the last byte is HANDED TO THE
     SOCKET — the server has not stored the file, and on a large document it has
     not finished writing it either. Showing 100% there is a claim we cannot
     back, and the bar would then sit at 100% doing nothing, which reads as stuck
     for exactly the reason the whole defect reads as broken. 100% means "the
     server said yes". */
  r.pct = r.size > 0 ? Math.min(99, Math.round((r.loaded / r.size) * 100)) : null;
  emit();
}

/** The request body is fully sent; we are now waiting on the server. */
export function finishSending(id) {
  const r = rows.get(id);
  if (!r || r.status !== 'uploading') return;
  r.status = 'processing';
  r.pct = r.size > 0 ? 99 : null;
  emit();
}

export function completeUpload(id) {
  const r = rows.get(id);
  if (!r) return;
  r.status = 'done'; r.pct = 100; r.loaded = r.size;
  emit();
  setTimeout(() => { rows.delete(id); emit(); }, DONE_LINGER_MS);
}

export function failUpload(id, message) {
  const r = rows.get(id);
  if (!r) return;
  // A failed row STAYS until somebody dismisses it. An upload that failed
  // silently is the same defect as an upload that showed nothing at all.
  r.status = 'error';
  r.error = String(message || 'Upload failed').slice(0, 300);
  emit();
}

export function dismissUpload(id) { rows.delete(id); emit(); }

/** Everything currently uploading to one target, oldest first. */
export function rowsFor(target, all) {
  const list = all || Array.from(rows.values());
  return list.filter((r) => r.target === target);
}

/** Test/debug seam: forget everything. */
export function _reset() { rows.clear(); seq = 0; emit(); }
