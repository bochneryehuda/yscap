'use strict';
/**
 * THE ATTACHMENT PLANNER — one place decides what an email can carry, and NOTHING is ever dropped
 * without a reason a human can act on (owner-directed 2026-08-14).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS TO KILL, because the shape of the fix follows from it exactly.
 *
 * An investor delivery went out on 2026-08-14 carrying two of its four documents: the draw packet
 * (12 KB) and the signed wire form (127 KB) arrived, and the INSPECTION REPORT — the third party's
 * word, the single most important thing in the envelope — did not. Nobody was told. The running log
 * said nothing; the only record was a `skipped` column on one row of one table that one card reads.
 *
 * The fitting loop was a plain first-fit over a priority-ordered list:
 *
 *     for (const it of items) { if (total + it.buf.length > budget) { skip(it); continue; } … }
 *
 * Read it against a real draw. The list is ordered MOST important first. The inspection report is
 * 30 MB, so it does not fit and is skipped. Our own report is 25 MB, so it does not fit either. The
 * 12 KB spreadsheet fits. The 127 KB wire form fits. **The loop dropped both documents that mattered
 * and kept both that did not** — and because a skip only `continue`s, it looked to every later item
 * like nothing had gone wrong. A priority order that is only ever used to decide who gets dropped
 * FIRST is a priority order pointing backwards.
 *
 * So this planner is built on four rules, in this order:
 *
 *   1. COMPRESS BEFORE DROPPING. The documents are oversized because they carry photographs at
 *      camera resolution (see lib/attachments/compress.js). Shrinking those to what a page can
 *      actually render routinely turns 25 MB into 2 MB with nothing visible lost, which means the
 *      honest answer to "it did not fit" is almost always "then make it fit". The old code never
 *      tried.
 *   2. NEVER SACRIFICE A HIGHER PRIORITY FOR A LOWER ONE. If something must go, it is decided
 *      across the whole set with the ordering respected — a 12 KB spreadsheet never displaces the
 *      inspector's report.
 *   3. EVERY OMISSION CARRIES A CODE, A SENTENCE, AND A REMEDY. Not "it could not be built" — a
 *      machine-readable `code` so the audit log is queryable, prose a coordinator can read, and the
 *      specific thing that would fix it (`compress_harder`, `share_link`, `accept_the_document`,
 *      `upload_it`). A reason with no remedy is a dead end.
 *   4. THE PLAN IS PRODUCED BEFORE THE SEND, NOT DISCOVERED AFTER IT. `needsConsent` is what the
 *      caller gates on: if anything is missing, a human is shown exactly what and why and either
 *      fixes it or says "send it anyway" on the record.
 *
 * WHAT THIS MODULE DOES NOT DO: it never sends, never reads a database, and never touches storage.
 * The caller gathers candidates (which is where "the file is not on the record yet" is known) and
 * the caller sends. That keeps this pure enough to test exhaustively against real bytes.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const compress = require('./compress');

/**
 * WHY SOMETHING IS NOT ON THE EMAIL. The code is the durable, queryable half — it goes into
 * `email_messages.omitted` (db/548) and must stay stable; the sentence is what a person reads.
 *
 * `remedy` names the ONE action that would fix this item. It is what the desk turns into a button.
 */
const REASONS = {
  too_large: { remedy: 'share_link', text: 'it is too large to attach to one email' },
  too_large_after_compression: { remedy: 'share_link', text: 'it is still too large to email even after compressing it' },
  unreadable: { remedy: 'retry', text: 'the stored copy could not be read' },
  not_on_file: { remedy: 'upload_it', text: 'it is not on the file yet' },
  not_accepted: { remedy: 'accept_the_document', text: 'it has not been accepted yet — review it first' },
  build_failed: { remedy: 'retry', text: 'it could not be generated' },
  empty: { remedy: 'upload_it', text: 'the stored copy is empty' },
};

const KB = 1024;
const MB = 1024 * 1024;

/** A short, human size — "4.2 MB" / "812 KB". Used in the wording a coordinator reads. */
function humanBytes(n) {
  const b = Number(n) || 0;
  if (b >= MB) return `${(b / MB).toFixed(b >= 10 * MB ? 0 : 1)} MB`;
  if (b >= KB) return `${Math.round(b / KB)} KB`;
  return `${b} bytes`;
}

/**
 * Turn a candidate that never produced bytes into a recorded omission.
 * An unrecognised code still yields a usable row rather than an empty one — an omission we cannot
 * classify is exactly the one somebody needs to see.
 */
function omission(cand, code, detail) {
  const known = REASONS[code];
  return {
    key: cand.key || null,
    what: cand.what || cand.filename || 'document',
    filename: cand.filename || null,
    code: known ? code : 'unspecified',
    reason: detail || (known ? known.text : 'it could not be attached'),
    remedy: known ? known.remedy : null,
    bytes: Number.isFinite(Number(cand.bytes)) ? Number(cand.bytes) : (cand.buf ? cand.buf.length : null),
  };
}

/**
 * Build the plan.
 *
 * @param candidates Array, MOST IMPORTANT FIRST. Each is either
 *        { key, what, filename, contentType, buf }                 — bytes in hand, or
 *        { key, what, filename, error: { code, reason } }           — why there are none.
 *        `compressible:false` opts an item out of compression (a spreadsheet has nothing to win).
 * @param opts { budgetBytes, compress=true, maxLevel, deadlineMs, shareLinkKeys:Set<string> }
 *        `shareLinkKeys` names items the caller has ALREADY decided to send as a PILOT link — the
 *        planner keeps them out of the byte budget and reports them separately.
 *
 * @returns { attach, links, omitted, totalBytes, budget, compressedCount, savedBytes, needsConsent }
 */
async function buildAttachmentPlan(candidates, opts) {
  const o = opts || {};
  const budget = Math.max(64 * KB, Number(o.budgetBytes) || 20 * MB);
  const doCompress = o.compress !== false;
  const shareKeys = o.shareLinkKeys instanceof Set ? o.shareLinkKeys
    : new Set(Array.isArray(o.shareLinkKeys) ? o.shareLinkKeys : []);
  const deadline = Date.now() + Math.max(3000, Number(o.deadlineMs) || 45000);

  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  const attach = [];
  const links = [];
  const omitted = [];
  let compressedCount = 0;
  let savedBytes = 0;

  // Pass 1 — split the ones that never produced bytes from the ones that did. A candidate that
  // failed upstream already knows WHY, and that reason is far better than anything we could infer.
  const carrying = [];
  for (const c of list) {
    if (c.error) { omitted.push(omission(c, c.error.code, c.error.reason)); continue; }
    if (!c.buf || !c.buf.length) { omitted.push(omission(c, 'empty')); continue; }
    if (shareKeys.has(c.key)) {
      // The caller chose a link for this one; it is not competing for bytes.
      links.push({ key: c.key, what: c.what, filename: c.filename, bytes: c.buf.length, buf: c.buf, contentType: c.contentType });
      continue;
    }
    carrying.push(c);
  }

  const totalRaw = carrying.reduce((n, c) => n + c.buf.length, 0);

  // FAST PATH — everything fits as it is. No decoding, no re-encoding, nothing touched. This is the
  // overwhelmingly common case and must stay free.
  if (totalRaw <= budget) {
    for (const c of carrying) attach.push({ ...c, bytes: c.buf.length, compression: null });
    return finish();
  }

  // RULE 1 — COMPRESS BEFORE DROPPING, biggest first (that is where the budget is actually spent,
  // and each compression costs real seconds, so spending them on a 40 KB file would be wasted).
  const working = carrying.map((c) => ({ cand: c, buf: c.buf, compression: null }));
  if (doCompress) {
    const bySize = working.slice().sort((a, b) => b.buf.length - a.buf.length);
    for (const w of bySize) {
      if (Date.now() > deadline) break;
      const currentTotal = working.reduce((n, x) => n + x.buf.length, 0);
      if (currentTotal <= budget) break;                       // already there — stop early
      if (w.cand.compressible === false) continue;
      // How small does THIS item have to get for the whole set to fit? Asking for exactly that,
      // rather than for the smallest possible file, is what stops a document being crushed to 600px
      // when 1600px would have been enough.
      const need = Math.max(32 * KB, w.buf.length - (currentTotal - budget));
      const r = await compress.compressToFit(w.buf, need, {
        maxLevel: o.maxLevel, deadlineMs: o.compressDeadlineMs,
        totalDeadlineMs: Math.max(3000, deadline - Date.now()),
      });
      if (r && r.changed && r.buf.length < w.buf.length) {
        savedBytes += w.buf.length - r.buf.length;
        compressedCount++;
        w.buf = r.buf;
        w.compression = {
          level: r.level, label: (compress.levelSpec(r.level) || {}).label || null,
          before: r.before, after: r.after, note: r.note || null, partial: !!r.partial,
        };
      }
    }
  }

  // RULE 2 — place in PRIORITY order. An item that still will not fit is omitted, and the ones
  // BELOW it are still considered: sending three of four documents beats sending none. What must
  // never happen — and what the old first-fit loop did every time — is a 12 KB spreadsheet keeping
  // its place while the inspector's report is dropped, purely because the spreadsheet was smaller.
  // That cannot happen here, because the report is offered its place FIRST and only loses it to the
  // budget itself, never to a lower-priority item.
  let used = 0;
  for (const w of working) {
    if (used + w.buf.length <= budget) {
      used += w.buf.length;
      attach.push({ ...w.cand, buf: w.buf, bytes: w.buf.length, compression: w.compression });
      continue;
    }
    // RULE 3 — a code, a sentence with the real numbers in it, and the remedy.
    const wasCompressed = !!w.compression;
    const code = wasCompressed ? 'too_large_after_compression' : 'too_large';
    const detail = wasCompressed
      ? `it is ${humanBytes(w.buf.length)} even after compressing it from ${humanBytes(w.compression.before)}, and this email can carry ${humanBytes(budget)} in total`
      : `it is ${humanBytes(w.buf.length)} and this email can carry ${humanBytes(budget)} in total`;
    omitted.push(omission({ ...w.cand, bytes: w.buf.length }, code, detail));
  }

  return finish();

  function finish() {
    const totalBytes = attach.reduce((n, a) => n + a.bytes, 0);
    return {
      attach, links, omitted,
      totalBytes, budget,
      compressedCount, savedBytes,
      // RULE 4 — the ONE thing the caller gates the send on. A link is a deliberate choice the
      // human already made, so it is not something to warn about again here; an omission is.
      needsConsent: omitted.length > 0,
    };
  }
}

/**
 * One plain sentence naming what is missing — for the confirmation the coordinator reads and for
 * the log line. Returns null when nothing is missing, so a caller can use it as the test itself.
 */
function omissionSummary(plan) {
  const missing = (plan && plan.omitted) || [];
  if (!missing.length) return null;
  const names = missing.map((m) => m.what).join(', ');
  return missing.length === 1
    ? `1 document will NOT be attached: ${names}.`
    : `${missing.length} documents will NOT be attached: ${names}.`;
}

/**
 * The plan, shaped for `email_messages.omitted` + `.attach_summary` (db/548) — so every surface
 * records the same thing in the same shape and the audit log is queryable across all of them.
 */
function auditFrom(plan, extra) {
  const p = plan || {};
  return {
    omitted: (p.omitted || []).map((m) => ({
      what: m.what, filename: m.filename, reason: m.reason, code: m.code, bytes: m.bytes, remedy: m.remedy,
    })),
    attachSummary: {
      attached_n: (p.attach || []).length,
      omitted_n: (p.omitted || []).length,
      links_n: (p.links || []).length,
      bytes: p.totalBytes || 0,
      budget: p.budget || 0,
      compressed_n: p.compressedCount || 0,
      saved_bytes: p.savedBytes || 0,
      ...(extra || {}),
    },
  };
}

module.exports = { buildAttachmentPlan, omissionSummary, auditFrom, humanBytes, REASONS };
