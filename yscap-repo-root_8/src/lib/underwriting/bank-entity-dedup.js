'use strict';
/**
 * ONE card per unverified bank ENTITY — collapse the per-statement duplicates (owner-reported
 * 2026-07-27: "the same business account flagged 4 times").
 *
 * THE PROBLEM. `bank-statement-checks.computeBankFindings` runs PER STATEMENT, and "is this holder's
 * entity verified / does the borrower own it?" is a FILE fact, not a per-document one. So N bank
 * statements under the SAME entity each persist their own `bank_business_entity_unverified` /
 * `bank_account_other_entity` document_findings row, and the desk shows the one real issue N times.
 *
 * WHY NOT a finding-claims factKey merge. The durable finding-decisions ledger (db/333) keys a
 * decision on code+field+document, DELIBERATELY ignoring a producer's factKey. So merging the N rows
 * by a shared factKey would let a single dismiss record against only one document — the other N-1
 * rows re-surface on the next view (the exact db/333 reappear bug). Instead we keep ONE stored row
 * per holder and resolve the rest, mirroring the file-level entity-screening rollup already in the
 * route: the survivor is a real row with a stable identity, so a dismiss on it sticks.
 *
 * DETERMINISTIC SURVIVOR. The survivor is the finding with the smallest document_id (then smallest
 * finding id) for the holder. document_id is STABLE across a re-read (saveAnalysis re-creates the
 * finding under the same physical document_id), so the survivor — and therefore the ledger key a
 * dismiss records — does not drift when the un-funded re-read sweep re-analyzes the file.
 *
 * "Same holder" uses the SAME `entityMatch` the rest of the underwriting stack uses (re-spacing
 * aware after 2026-07-27), so "Core Tex Solutions" and "Coretex Solutions" collapse together while
 * two genuinely different holders stay separate. Pure: no DB, no AI, never throws.
 */
const { entityMatch } = require('./compare');

// Only the two ENTITY-OWNERSHIP WARNINGS collapse. NEVER the fatal personal-account cases
// (bank_account_not_borrower) — each of those is separately consequential and stays per-document.
const BANK_ENTITY_CODES = new Set(['bank_business_entity_unverified', 'bank_account_other_entity']);

function holderOf(f) {
  const h = f && (f.doc_value != null ? f.doc_value : f.docValue);
  return h == null || String(h).trim() === '' ? null : String(h);
}
function idOf(f) { return String((f && f.id != null ? f.id : '') || ''); }
function docIdOf(f) { return String((f && (f.document_id != null ? f.document_id : f.documentId)) || ''); }

/**
 * @param {Array<object>} findings the assembled openRaw findings for the file
 * @returns {{ resolvedIds: string[] }} the STORED ids of the folded (non-survivor) duplicate rows —
 *          the caller splices these out of the display list AND marks them resolved.
 */
function collapseBankEntityDuplicates(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const groups = []; // { holder, items: [finding,...] }
  for (const f of list) {
    if (!f || !BANK_ENTITY_CODES.has(f.code)) continue;
    const h = holderOf(f);
    if (!h) continue; // never fold a finding with no holder to key on
    let g = groups.find((gr) => entityMatch(gr.holder, h) === true);
    if (!g) { g = { holder: h, items: [] }; groups.push(g); }
    g.items.push(f);
  }
  const resolvedIds = [];
  for (const g of groups) {
    if (g.items.length <= 1) continue;
    const survivor = g.items.slice().sort((a, b) =>
      docIdOf(a).localeCompare(docIdOf(b)) || idOf(a).localeCompare(idOf(b)))[0];
    for (const f of g.items) {
      const id = idOf(f);
      if (f !== survivor && id) resolvedIds.push(id);
    }
  }
  return { resolvedIds };
}

module.exports = { collapseBankEntityDuplicates, BANK_ENTITY_CODES, _internals: { holderOf, docIdOf } };
