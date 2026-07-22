'use strict';
/**
 * Semantic entity extraction — Sovereign (blueprint 2026-07-22). Scans a
 * document's OCR text for PARTIES / MONEY / DATES / ADDRESSES / LICENSES /
 * EMAILS / PHONES / ID NUMBERS beyond what the schema-driven field extractor
 * already captured. Purely pattern-based — no NER model. Designed so an
 * upgrade to a real NER model / specialist LLM prompt is a swap of this
 * module, no schema change (see db/233_semantic_entities.sql).
 *
 * The value: (1) a guarantor named on page 8 of an operating agreement,
 * (2) an assignment fee referenced in a purchase-contract addendum, or
 * (3) a lien amount buried in title stipulations all become searchable /
 * reasoning-visible facts even when the field-extractor's schema didn't
 * include them.
 *
 * Every extractor returns an array of { entity_type, entity_value,
 * entity_display, context, role_hint, page_number, confidence }.
 */

const MONEY_RE = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\b/g;
// Very permissive date matcher — the twin's date normalizer handles ISO-ing.
const DATE_RE = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?1[\s\-.])?\(?([2-9]\d{2})\)?[\s\-.]?([2-9]\d{2})[\s\-.]?(\d{4})\b/g;
// Entity mentions — capture strings ending in a suffix like LLC, L.L.C., Inc, Corporation, Trust, Ltd, Co.
const ENTITY_RE = /\b([A-Z][A-Za-z0-9&'.\-\s]{2,60}?)\s+(LLC|L\.L\.C\.|LTD|Ltd\.?|INC|Inc\.?|Corp\.?|Corporation|Company|Co\.|Trust|Partners?|LP|LLP|PC)\b/g;
// Role hints that anchor a name mention: "Notary Public:", "Seller:", "Buyer:", "Signed by", "Signature of"
const ROLE_ANCHORS = [
  { rx: /(?:notary\s+public|notary)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'notary' },
  { rx: /seller\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'seller' },
  { rx: /(?:buyer|purchaser)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'buyer' },
  { rx: /(?:signed\s+by|signature\s+of)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'signer' },
  { rx: /appraiser\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'appraiser' },
  { rx: /(?:guarantor|guaranty)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'guarantor' },
  { rx: /(?:managing\s+member|authorized\s+member|member)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+){1,3})/gi, role: 'member' },
];

// State license/registration numbers (loose — matches most state formats).
const LICENSE_RE = /\b(?:license|lic\.?|registration|reg\.?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9\-]{4,20})\b/gi;
// Address hints (very rough — full parsing needs a library like usaddress).
const ADDRESS_RE = /\b(\d{1,5})\s+([A-Z][A-Za-z0-9\s'.\-]{2,60})\s+(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|court|ct|lane|ln|place|pl|way|highway|hwy|circle|cir|terrace|ter|parkway|pkwy)\b/gi;

const trim = (s) => String(s || '').trim();
const toCents = (numStr) => {
  const n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!isFinite(n)) return null;
  return String(Math.round(n * 100));
};
const toIsoDate = (m, d, y) => {
  let year = String(y).padStart(4, '20').slice(-4);
  if (Number(year) < 100) year = (Number(year) < 50 ? '20' : '19') + String(year).padStart(2, '0');
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * Pure — scan a document's OCR text and produce entity mentions. `pages` is
 * optional; when supplied as [{pageNumber, text}], entities carry
 * page_number; otherwise page_number is null.
 * @param {string} text  the full document text
 * @param {object} opts  { docType, pages: [{pageNumber, text}] }
 * @returns {Array<{entity_type, entity_value, entity_display, context, role_hint, page_number, confidence}>}
 */
function extract(text, opts = {}) {
  const results = [];
  if (!text || typeof text !== 'string') return results;

  const pages = Array.isArray(opts.pages) ? opts.pages : null;
  const findPage = (offset) => {
    if (!pages) return null;
    let pos = 0;
    for (const p of pages) {
      const len = (p.text || '').length + 2;
      if (offset < pos + len) return p.pageNumber || null;
      pos += len;
    }
    return null;
  };

  // Money — including a bit of surrounding context (up to 40 chars before).
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(text)) !== null) {
    const raw = m[1];
    const cents = toCents(raw);
    if (!cents) continue;
    const ctx = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' ').trim();
    results.push({
      entity_type: 'money', entity_value: cents, entity_display: `$${raw}`,
      context: ctx || null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.9,
    });
  }

  // Dates — MM/DD/YYYY variants.
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text)) !== null) {
    const iso = toIsoDate(m[1], m[2], m[3]);
    const ctx = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' ').trim();
    results.push({
      entity_type: 'date', entity_value: iso, entity_display: m[0],
      context: ctx || null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.85,
    });
  }
  // Dates — ISO YYYY-MM-DD.
  ISO_DATE_RE.lastIndex = 0;
  while ((m = ISO_DATE_RE.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' ').trim();
    results.push({
      entity_type: 'date', entity_value: `${m[1]}-${m[2]}-${m[3]}`, entity_display: m[0],
      context: ctx || null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.95,
    });
  }

  // Emails.
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const email = m[0].toLowerCase();
    const ctx = text.slice(Math.max(0, m.index - 30), m.index).replace(/\s+/g, ' ').trim();
    results.push({
      entity_type: 'email', entity_value: email, entity_display: email,
      context: ctx || null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.99,
    });
  }
  // Phones.
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const digits = m[1] + m[2] + m[3];
    results.push({
      entity_type: 'phone', entity_value: digits, entity_display: `(${m[1]}) ${m[2]}-${m[3]}`,
      context: null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.9,
    });
  }

  // Entities (LLC/Inc/Trust/…).
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(text)) !== null) {
    const full = `${trim(m[1])} ${trim(m[2])}`;
    const norm = full.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.length < 4) continue;
    results.push({
      entity_type: 'entity', entity_value: norm, entity_display: full,
      context: null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.75,
    });
  }

  // Roles + names — anchored regexes.
  for (const anchor of ROLE_ANCHORS) {
    anchor.rx.lastIndex = 0;
    while ((m = anchor.rx.exec(text)) !== null) {
      const name = trim(m[1]);
      if (!name || name.length < 3) continue;
      results.push({
        entity_type: 'person', entity_value: name.toLowerCase(), entity_display: name,
        context: m[0], role_hint: anchor.role,
        page_number: findPage(m.index), confidence: 0.7,
      });
    }
  }

  // Licenses.
  LICENSE_RE.lastIndex = 0;
  while ((m = LICENSE_RE.exec(text)) !== null) {
    const num = trim(m[1]);
    if (!num || num.length < 4) continue;
    results.push({
      entity_type: 'license', entity_value: num.toUpperCase(), entity_display: num,
      context: m[0], role_hint: null,
      page_number: findPage(m.index), confidence: 0.85,
    });
  }

  // Addresses (rough).
  ADDRESS_RE.lastIndex = 0;
  while ((m = ADDRESS_RE.exec(text)) !== null) {
    const addr = `${m[1]} ${trim(m[2])} ${m[3]}`;
    results.push({
      entity_type: 'address', entity_value: addr.toLowerCase().replace(/\s+/g, ' '),
      entity_display: addr,
      context: null, role_hint: null,
      page_number: findPage(m.index), confidence: 0.7,
    });
  }

  // Deduplicate: same (entity_type, entity_value, page_number) shouldn't appear
  // more than once — the pattern set overlaps a bit (date_re matches inside
  // iso_date_re, etc.).
  const seen = new Set();
  const deduped = [];
  for (const e of results) {
    const key = `${e.entity_type}|${e.entity_value}|${e.page_number || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped;
}

/**
 * Persist a batch of entities from an extraction. Best-effort — per-row
 * failures don't stop the batch. Runs on the caller's transaction.
 */
async function persistFromExtraction(client, { appId, documentId, extractionId, entities } = {}) {
  if (!extractionId || !Array.isArray(entities) || !entities.length) return { inserted: 0 };
  let inserted = 0;
  for (const e of entities) {
    try {
      await client.query(
        `INSERT INTO document_entities
           (application_id, document_id, extraction_id, entity_type, entity_value,
            entity_display, context, role_hint, page_number, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [appId || null, documentId || null, extractionId,
         e.entity_type, String(e.entity_value).slice(0, 500),
         e.entity_display ? String(e.entity_display).slice(0, 500) : null,
         e.context ? String(e.context).slice(0, 500) : null,
         e.role_hint || null,
         Number.isFinite(e.page_number) ? e.page_number : null,
         e.confidence != null ? Number(e.confidence) : null]);
      inserted += 1;
    } catch (_) { /* per-row failure never stops the batch */ }
  }
  return { inserted };
}

module.exports = { extract, persistFromExtraction, _internals: { MONEY_RE, DATE_RE, ENTITY_RE, ROLE_ANCHORS } };
