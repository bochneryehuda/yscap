'use strict';
/**
 * Loan Digital Twin — the CANONICAL fact model for an application (Sovereign
 * 1/4, owner-directed 2026-07-21).
 *
 * Every underwriting VALUE (loan amount, purchase price, borrower name, property
 * address, entity formation date, appraisal ARV, ...) is a `fact_key` with:
 *   * many OBSERVATIONS (fact_observations) — one per source (document / LOS
 *     field / user entry / API), APPEND-ONLY.
 *   * one CANONICAL fact (loan_facts) — the currently accepted value, chosen
 *     from the observations by a source-authority hierarchy + confidence.
 *   * an EVENT ledger (fact_events) — append-only, one row per state change on
 *     either table so a decision certificate can reconstruct the fact history.
 *
 * Design ideas:
 *   1. Sources rank. If the title report says the address is X and the
 *      appraisal says Y, title wins for `property.address` (higher authority).
 *      If the source hierarchy has no clear winner, the fact is `disputed` —
 *      not silently averaged.
 *   2. Human confirmations outrank everything automated. A staffer explicitly
 *      says "the address is 123 Main St" → status = 'human_confirmed'.
 *   3. Observations are NEVER deleted. When a document is superseded, its
 *      observations get `superseded_at` — the observation record stays for the
 *      audit trail; reconciliation just stops considering it.
 *   4. Old canonicals are NEVER deleted. When a canonical changes, the prior
 *      row's `effective_to` is stamped; the new row is inserted. A decision
 *      certificate issued yesterday can be re-derived against yesterday's
 *      canonicals by scanning `loan_facts` where `effective_from <= ts <
 *      effective_to (or NULL)`.
 *   5. Pure module: no HTTP, no AI. All I/O is Postgres via a `client` passed
 *      in by the caller (so callers control transactions). Zero side-effects
 *      on the extraction path when not called.
 */
// Lazy-required so the pure helpers (normalize, pickWinning) can be exercised
// without a Postgres driver on the classpath — matches the pattern used in
// draw-report.js. Read helpers that need db resolve it on first use.
let _db = null;
const db = () => (_db || (_db = require('../../db')));

// -------------------------------------------------------------------------
// FACT KEY VOCABULARY
// The full list of underwriting fact keys the twin knows about. Adding a new
// one = add a source hierarchy entry below + wire the extraction path to call
// recordObservation for it. Keeping the list here makes drift obvious.
// -------------------------------------------------------------------------
const FACT_KEYS = Object.freeze({
  LOAN_AMOUNT:            'loan.amount',
  LOAN_INITIAL_ADVANCE:   'loan.initial_advance',
  LOAN_RATE:              'loan.rate',
  LOAN_TERM_MONTHS:       'loan.term_months',
  LOAN_TYPE:              'loan.type',
  LOAN_PROGRAM:           'loan.program',
  PURCHASE_PRICE:         'transaction.purchase_price',
  REHAB_BUDGET:           'transaction.rehab_budget',
  ASSIGNMENT_FEE:         'transaction.assignment_fee',
  UNDERLYING_PRICE:       'transaction.underlying_contract_price',
  CLOSING_DATE:           'transaction.closing_date',
  BORROWER_NAME:          'borrower.name',
  BORROWER_DOB:           'borrower.date_of_birth',
  BORROWER_SSN_LAST4:     'borrower.ssn_last4',
  BORROWER_ADDRESS:       'borrower.current_address',
  BORROWER_EMAIL:         'borrower.email',
  BORROWER_PHONE:         'borrower.phone',
  BORROWER_FICO:          'borrower.fico',
  ENTITY_NAME:            'entity.name',
  ENTITY_EIN:             'entity.ein',
  ENTITY_STATE:           'entity.formation_state',
  ENTITY_FORMATION_DATE:  'entity.formation_date',
  ENTITY_GOOD_STANDING:   'entity.good_standing',
  PROPERTY_ADDRESS:       'property.address',
  PROPERTY_TYPE:          'property.type',
  PROPERTY_UNITS:         'property.units',
  PROPERTY_YEAR_BUILT:    'property.year_built',
  PROPERTY_ZONING:        'property.zoning',
  PROPERTY_FLOOD_ZONE:    'property.flood_zone',
  APPRAISAL_AS_IS:        'appraisal.as_is_value',
  APPRAISAL_ARV:          'appraisal.arv',
  APPRAISAL_RENT:         'appraisal.market_rent',
  TITLE_VESTING:          'title.vesting',
  TITLE_LIENS:            'title.liens',
  INSURANCE_INSURED:      'insurance.insured_name',
  INSURANCE_COVERAGE:     'insurance.coverage_amount',
  INSURANCE_EFFECTIVE:    'insurance.effective_date',
  OFAC_SUBJECT:           'compliance.ofac_subject_name',
  OFAC_RESULT:            'compliance.ofac_result',
  BANK_ACCOUNT_OWNER:     'assets.bank_account_owner',
  BANK_ENDING_BALANCE:    'assets.bank_ending_balance',
});

// -------------------------------------------------------------------------
// SOURCE HIERARCHY — for each fact key, an ordered list of source types +
// document types (highest authority first). A source not listed is
// treated as low-authority and only wins in the absence of anything else.
// A canonical fact is chosen by:
//   1. Filter live observations (superseded_at IS NULL).
//   2. Bucket by (source_type + document doc_type for 'document' rows).
//   3. Walk hierarchy top-down; the first bucket with any observation wins.
//   4. Within a winning bucket, ties go to the highest-confidence + newest.
//   5. If two BUCKETS at the same rank disagree, fact is 'disputed'.
// -------------------------------------------------------------------------
const SOURCE_HIERARCHY = Object.freeze({
  [FACT_KEYS.LOAN_AMOUNT]:        [
    { source_type: 'los_field',           source_id: 'applications.loan_amount' },
    { source_type: 'document',            source_id: 'signed_term_sheet' },
    { source_type: 'document',            source_id: 'signed_application' },
    { source_type: 'document',            source_id: 'purchase_contract' },
  ],
  [FACT_KEYS.PURCHASE_PRICE]:     [
    { source_type: 'document',            source_id: 'purchase_contract' },
    { source_type: 'document',            source_id: 'contract_amendment' },
    { source_type: 'los_field',           source_id: 'applications.purchase_price' },
    { source_type: 'document',            source_id: 'settlement' },
  ],
  [FACT_KEYS.BORROWER_NAME]:      [
    { source_type: 'document',            source_id: 'government_id' },
    { source_type: 'los_field',           source_id: 'borrowers.name' },
    { source_type: 'document',            source_id: 'credit_report' },
    { source_type: 'document',            source_id: 'signed_application' },
  ],
  [FACT_KEYS.BORROWER_DOB]:       [
    { source_type: 'document',            source_id: 'government_id' },
    { source_type: 'los_field',           source_id: 'borrowers.date_of_birth' },
    { source_type: 'document',            source_id: 'credit_report' },
  ],
  [FACT_KEYS.BORROWER_ADDRESS]:   [
    { source_type: 'document',            source_id: 'government_id' },
    { source_type: 'los_field',           source_id: 'borrowers.current_address' },
    { source_type: 'document',            source_id: 'credit_report' },
    { source_type: 'document',            source_id: 'bank_statement' },
  ],
  [FACT_KEYS.ENTITY_NAME]:        [
    { source_type: 'document',            source_id: 'llc_formation' },
    { source_type: 'document',            source_id: 'good_standing' },
    { source_type: 'document',            source_id: 'ein_letter' },
    { source_type: 'document',            source_id: 'operating_agreement' },
    { source_type: 'los_field',           source_id: 'llcs.llc_name' },
  ],
  [FACT_KEYS.ENTITY_EIN]:         [
    { source_type: 'document',            source_id: 'ein_letter' },
    { source_type: 'los_field',           source_id: 'llcs.ein' },
  ],
  [FACT_KEYS.ENTITY_FORMATION_DATE]: [
    { source_type: 'document',            source_id: 'llc_formation' },
    { source_type: 'document',            source_id: 'good_standing' },
  ],
  [FACT_KEYS.ENTITY_GOOD_STANDING]:  [
    { source_type: 'api_verification',    source_id: 'secretary_of_state' },
    { source_type: 'document',            source_id: 'good_standing' },
  ],
  [FACT_KEYS.PROPERTY_ADDRESS]:   [
    { source_type: 'document',            source_id: 'title' },
    { source_type: 'document',            source_id: 'appraisal' },
    { source_type: 'document',            source_id: 'purchase_contract' },
    { source_type: 'los_field',           source_id: 'applications.property_address' },
    { source_type: 'document',            source_id: 'insurance' },
  ],
  [FACT_KEYS.PROPERTY_TYPE]:      [
    { source_type: 'document',            source_id: 'appraisal' },
    { source_type: 'document',            source_id: 'title' },
    { source_type: 'los_field',           source_id: 'applications.property_type' },
  ],
  [FACT_KEYS.PROPERTY_UNITS]:     [
    { source_type: 'document',            source_id: 'appraisal' },
    { source_type: 'document',            source_id: 'title' },
    { source_type: 'los_field',           source_id: 'applications.units' },
  ],
  [FACT_KEYS.PROPERTY_FLOOD_ZONE]:[
    { source_type: 'api_verification',    source_id: 'fema' },
    { source_type: 'document',            source_id: 'flood' },
  ],
  [FACT_KEYS.APPRAISAL_AS_IS]:    [
    { source_type: 'document',            source_id: 'appraisal' },
    { source_type: 'los_field',           source_id: 'applications.as_is_value' },
  ],
  [FACT_KEYS.APPRAISAL_ARV]:      [
    { source_type: 'document',            source_id: 'appraisal' },
    { source_type: 'los_field',           source_id: 'applications.arv' },
  ],
  [FACT_KEYS.APPRAISAL_RENT]:     [
    { source_type: 'document',            source_id: 'appraisal' },
  ],
  [FACT_KEYS.TITLE_VESTING]:      [
    { source_type: 'document',            source_id: 'title' },
  ],
  [FACT_KEYS.TITLE_LIENS]:        [
    { source_type: 'document',            source_id: 'title' },
    { source_type: 'api_verification',    source_id: 'property_data' },
  ],
  [FACT_KEYS.INSURANCE_INSURED]:  [
    { source_type: 'api_verification',    source_id: 'carrier' },
    { source_type: 'document',            source_id: 'insurance' },
  ],
  [FACT_KEYS.INSURANCE_COVERAGE]: [
    { source_type: 'api_verification',    source_id: 'carrier' },
    { source_type: 'document',            source_id: 'insurance' },
  ],
  [FACT_KEYS.INSURANCE_EFFECTIVE]:[
    { source_type: 'api_verification',    source_id: 'carrier' },
    { source_type: 'document',            source_id: 'insurance' },
  ],
  [FACT_KEYS.BORROWER_FICO]:      [
    { source_type: 'document',            source_id: 'credit_report' },
    { source_type: 'los_field',           source_id: 'borrowers.fico' },
  ],
  [FACT_KEYS.OFAC_SUBJECT]:       [
    { source_type: 'document',            source_id: 'background_report' },
  ],
  [FACT_KEYS.OFAC_RESULT]:        [
    { source_type: 'document',            source_id: 'background_report' },
  ],
  [FACT_KEYS.BANK_ACCOUNT_OWNER]: [
    { source_type: 'api_verification',    source_id: 'plaid' },
    { source_type: 'document',            source_id: 'bank_statement' },
    { source_type: 'document',            source_id: 'voided_check' },
  ],
  [FACT_KEYS.BANK_ENDING_BALANCE]:[
    { source_type: 'api_verification',    source_id: 'plaid' },
    { source_type: 'document',            source_id: 'bank_statement' },
  ],
});

// -------------------------------------------------------------------------
// NORMALIZERS — canonicalize a raw value into a comparable string form. Same
// convention as classic ETL — two sources agree when their normalized forms
// match. Every fact_key SHOULD have a normalizer; missing ones fall back to a
// lowercase + trimmed string.
// -------------------------------------------------------------------------
const stripNonAlnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stripNonDigits = (s) => String(s || '').replace(/\D+/g, '');
const trimLower = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const asCents = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n)) return null;
  return String(Math.round(n * 100));   // integer cents keeps rounding safe
};
const asIsoDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY | M/D/YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let y = m[3]; if (y.length === 2) y = (Number(y) < 50 ? '20' : '19') + y;
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
};
const normalizeName = (v) => {
  // Case-insensitive, strip punctuation + suffixes, collapse whitespace.
  const s = trimLower(v).replace(/[.,]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|esq)\b/g, '').trim();
  return s.replace(/\s+/g, ' ');
};
const normalizeAddress = (v) => {
  // Accept a string or an { line1, city, state, zip } object.
  const o = v && typeof v === 'object' ? v : { line1: String(v || '') };
  const line1 = trimLower(o.line1 || o.address || '')
    .replace(/\b(street|str)\b/g, 'st').replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd').replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd').replace(/\b(place|pl)\b/g, 'pl')
    .replace(/\b(court|ct)\b/g, 'ct').replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  const city = trimLower(o.city || '');
  const state = String(o.state || '').trim().toUpperCase().slice(0, 2);
  const zip = String(o.zip || '').replace(/[^0-9]/g, '').slice(0, 5);
  return [line1, city, state, zip].filter(Boolean).join(' | ');
};
const normalizeMoney = (v) => asCents(v);
const normalizeInteger = (v) => {
  const n = parseInt(String(v).replace(/[^0-9\-]/g, ''), 10);
  return isFinite(n) ? String(n) : null;
};
const normalizeBool = (v) => {
  if (v === true || v === 'true' || v === 1 || v === '1') return '1';
  if (v === false || v === 'false' || v === 0 || v === '0') return '0';
  return null;
};

const NORMALIZERS = Object.freeze({
  [FACT_KEYS.LOAN_AMOUNT]:            normalizeMoney,
  [FACT_KEYS.LOAN_INITIAL_ADVANCE]:   normalizeMoney,
  [FACT_KEYS.LOAN_RATE]:              (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n.toFixed(5) : null; },
  [FACT_KEYS.LOAN_TERM_MONTHS]:       normalizeInteger,
  [FACT_KEYS.LOAN_TYPE]:              trimLower,
  [FACT_KEYS.LOAN_PROGRAM]:           trimLower,
  [FACT_KEYS.PURCHASE_PRICE]:         normalizeMoney,
  [FACT_KEYS.REHAB_BUDGET]:           normalizeMoney,
  [FACT_KEYS.ASSIGNMENT_FEE]:         normalizeMoney,
  [FACT_KEYS.UNDERLYING_PRICE]:       normalizeMoney,
  [FACT_KEYS.CLOSING_DATE]:           asIsoDate,
  [FACT_KEYS.BORROWER_NAME]:          normalizeName,
  [FACT_KEYS.BORROWER_DOB]:           asIsoDate,
  [FACT_KEYS.BORROWER_SSN_LAST4]:     (v) => String(v || '').replace(/\D+/g, '').slice(-4) || null,
  [FACT_KEYS.BORROWER_ADDRESS]:       normalizeAddress,
  [FACT_KEYS.BORROWER_EMAIL]:         (v) => String(v || '').trim().toLowerCase(),
  [FACT_KEYS.BORROWER_PHONE]:         (v) => stripNonDigits(v).slice(-10) || null,
  [FACT_KEYS.BORROWER_FICO]:          normalizeInteger,
  [FACT_KEYS.ENTITY_NAME]:            (v) => stripNonAlnum(v),
  [FACT_KEYS.ENTITY_EIN]:             (v) => stripNonDigits(v).slice(0, 9) || null,
  [FACT_KEYS.ENTITY_STATE]:           (v) => String(v || '').trim().toUpperCase().slice(0, 2),
  [FACT_KEYS.ENTITY_FORMATION_DATE]:  asIsoDate,
  [FACT_KEYS.ENTITY_GOOD_STANDING]:   normalizeBool,
  [FACT_KEYS.PROPERTY_ADDRESS]:       normalizeAddress,
  [FACT_KEYS.PROPERTY_TYPE]:          trimLower,
  [FACT_KEYS.PROPERTY_UNITS]:         normalizeInteger,
  [FACT_KEYS.PROPERTY_YEAR_BUILT]:    normalizeInteger,
  [FACT_KEYS.PROPERTY_ZONING]:        trimLower,
  [FACT_KEYS.PROPERTY_FLOOD_ZONE]:    trimLower,
  [FACT_KEYS.APPRAISAL_AS_IS]:        normalizeMoney,
  [FACT_KEYS.APPRAISAL_ARV]:          normalizeMoney,
  [FACT_KEYS.APPRAISAL_RENT]:         normalizeMoney,
  [FACT_KEYS.TITLE_VESTING]:          normalizeName,
  [FACT_KEYS.INSURANCE_INSURED]:      normalizeName,
  [FACT_KEYS.INSURANCE_COVERAGE]:     normalizeMoney,
  [FACT_KEYS.INSURANCE_EFFECTIVE]:    asIsoDate,
  [FACT_KEYS.OFAC_SUBJECT]:           normalizeName,
  [FACT_KEYS.OFAC_RESULT]:            trimLower,
  [FACT_KEYS.BANK_ACCOUNT_OWNER]:     normalizeName,
  [FACT_KEYS.BANK_ENDING_BALANCE]:    normalizeMoney,
});

function normalize(factKey, value) {
  const fn = NORMALIZERS[factKey] || trimLower;
  try { return fn(value); } catch (_) { return null; }
}

// -------------------------------------------------------------------------
// RECONCILE — given every LIVE observation of a fact, choose the canonical.
// Pure — takes an array of observations, returns { canonicalValueJson,
// normalizedValue, status, consensusScore, winningObservationId }.
// Exposed for unit testing (no DB).
// -------------------------------------------------------------------------
function pickWinning(observations, factKey) {
  if (!observations || !observations.length) {
    return { canonicalValueJson: null, normalizedValue: null, status: 'unable_to_determine',
      consensusScore: 0, winningObservationId: null };
  }
  const hierarchy = SOURCE_HIERARCHY[factKey] || [];
  // Bucket by (source_type + document doc_type for documents; source_id
  // otherwise). Each observation's `source_type` names its bucket; for
  // documents, `source_id` is the doc_type ('title', 'appraisal', …).
  const bucketFor = (o) => o.source_type === 'document' ? `document:${o.source_id || ''}` : `${o.source_type}:${o.source_id || ''}`;
  const buckets = new Map();
  for (const o of observations) {
    if (!o.normalized_value && o.normalized_value !== 0) continue;
    const key = bucketFor(o);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  // Walk hierarchy top-down.
  for (const rank of hierarchy) {
    const key = `${rank.source_type}:${rank.source_id || ''}`;
    const winners = buckets.get(key);
    if (!winners || !winners.length) continue;
    // Within a bucket: highest confidence, then newest.
    winners.sort((a, b) => {
      const ac = Number(a.ocr_confidence != null ? a.ocr_confidence : 0) + Number(a.extraction_confidence != null ? a.extraction_confidence : 0);
      const bc = Number(b.ocr_confidence != null ? b.ocr_confidence : 0) + Number(b.extraction_confidence != null ? b.extraction_confidence : 0);
      if (bc !== ac) return bc - ac;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
    const winner = winners[0];
    const normValue = winner.normalized_value;
    // Consensus score: fraction of ALL observations whose normalized form matches the winner's.
    const total = observations.length;
    const agreeing = observations.filter((o) => o.normalized_value === normValue).length;
    const consensusScore = total > 0 ? agreeing / total : 0;
    // Detect dispute at the SAME hierarchy rank (two different sources at the
    // same top rank saying different things). E.g. two document buckets both
    // at rank 0 (only possible in a same-rank scenario, i.e. no other bucket
    // above). Here we treat "same source_type + different source_id at same
    // rank" as separate buckets — but if the two same-rank buckets DISAGREE
    // in normalized value, that's a dispute even though we picked a winner.
    const otherBucketsSameRank = Array.from(buckets.entries()).filter(([k, list]) => {
      if (k === key) return false;
      // A bucket 'shares' the rank if the hierarchy list up to this rank contains it too — rare.
      return false;   // Simplification for now: strict-hierarchy resolution wins.
    });
    // Status resolution (matters more than the value itself when a downstream
    // reviewer decides how much to trust the canonical):
    //   api_verification wins → verified (external source of truth, e.g. Plaid /
    //     Secretary of State / carrier / FEMA — a lower-ranked doc disagreeing
    //     doesn't downgrade this).
    //   authoritative document (title, good_standing) + NO disagreement → verified.
    //   agreeing >= 2 and total agreement >= 0.99 → corroborated.
    //   ANY disagreement + consensus < 0.8 → disputed (a real red flag for the
    //     underwriter, even if a winner was chosen).
    //   otherwise → observed (single low/mid-authority source, no disagreement).
    const anyDisagree = observations.some((o) => o.normalized_value != null && o.normalized_value !== normValue);
    let status = 'observed';
    if (rank.source_type === 'api_verification') {
      status = 'verified';
    } else if (anyDisagree && consensusScore < 0.8) {
      status = 'disputed';
    } else if (rank.source_type === 'document' && (rank.source_id === 'title' || rank.source_id === 'good_standing') && agreeing >= 1) {
      status = 'verified';
    } else if (consensusScore >= 0.99 && agreeing >= 2) {
      status = 'corroborated';
    }
    return {
      canonicalValueJson: winner.value_json != null ? winner.value_json : (winner.raw_value != null ? { value: winner.raw_value } : null),
      normalizedValue: normValue,
      status,
      consensusScore,
      winningObservationId: winner.id || null,
    };
  }
  // No hierarchy bucket matched; take the newest observation as a last resort.
  const sorted = observations.slice().sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  const winner = sorted[0];
  const normValue = winner.normalized_value;
  const total = observations.length;
  const agreeing = observations.filter((o) => o.normalized_value === normValue).length;
  return {
    canonicalValueJson: winner.value_json != null ? winner.value_json : (winner.raw_value != null ? { value: winner.raw_value } : null),
    normalizedValue: normValue,
    status: agreeing === total ? 'observed' : 'disputed',
    consensusScore: total > 0 ? agreeing / total : 0,
    winningObservationId: winner.id || null,
  };
}

// -------------------------------------------------------------------------
// RECORD OBSERVATION — insert a fact_observation, then reconcile the fact's
// canonical. Runs in the caller's transaction (they pass a `client`).
//   opts.appId       — required
//   opts.factKey     — required (must be a value from FACT_KEYS)
//   opts.sourceType  — 'document' | 'los_field' | 'user_entry' | 'api_verification' | 'derivation' | 'ai_extraction'
//   opts.sourceId    — doc_type / LOS field / API name / user id
//   opts.documentId  — the source document id (if source_type='document')
//   opts.extractionId — the extraction that produced it (optional)
//   opts.pageNumber  — where on the doc it was seen
//   opts.rawValue    — verbatim
//   opts.valueJson   — structured form (optional, defaults to { value: rawValue })
//   opts.ocrEngine, opts.extractionEngine, opts.ocrConfidence, opts.extractionConfidence
// Returns { observationId, canonical }.
// -------------------------------------------------------------------------
async function recordObservation(client, opts = {}) {
  const { appId, factKey } = opts;
  if (!appId || !factKey) throw new Error('recordObservation: appId + factKey required');
  const normalizedValue = normalize(factKey, opts.valueJson != null ? opts.valueJson : opts.rawValue);
  const valueJson = opts.valueJson != null ? opts.valueJson
    : (opts.rawValue != null ? { value: opts.rawValue } : null);
  const ins = await client.query(
    `INSERT INTO fact_observations
       (application_id, fact_key, source_type, source_id, document_id, extraction_id,
        page_number, raw_value, normalized_value, value_json,
        ocr_engine, extraction_engine, ocr_confidence, extraction_confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
     RETURNING id, created_at`,
    [appId, factKey, opts.sourceType || 'ai_extraction', opts.sourceId || null,
     opts.documentId || null, opts.extractionId || null, opts.pageNumber || null,
     opts.rawValue != null ? String(opts.rawValue).slice(0, 4000) : null,
     normalizedValue,
     valueJson != null ? JSON.stringify(valueJson) : null,
     opts.ocrEngine || null, opts.extractionEngine || null,
     opts.ocrConfidence != null ? Number(opts.ocrConfidence) : null,
     opts.extractionConfidence != null ? Number(opts.extractionConfidence) : null]);
  const observationId = ins.rows[0].id;

  await client.query(
    `INSERT INTO fact_events (application_id, fact_key, event_type, new_value_json, observation_id, actor_kind, reason)
     VALUES ($1,$2,'observation_added',$3::jsonb,$4,'system',$5)`,
    [appId, factKey, valueJson != null ? JSON.stringify(valueJson) : null, observationId,
     opts.reason || `observed via ${opts.sourceType || 'ai_extraction'}${opts.sourceId ? ' ('+opts.sourceId+')' : ''}`]);

  // Reconcile the fact.
  const canonical = await reconcile(client, { appId, factKey, reason: 'observation added' });
  return { observationId, canonical };
}

// -------------------------------------------------------------------------
// RECONCILE — load every live observation for (appId, factKey), pick the
// canonical, insert/update loan_facts, and write a canonical_changed event
// if the canonical actually moved. Returns the current canonical row.
// -------------------------------------------------------------------------
async function reconcile(client, { appId, factKey, actorKind, actorId, reason } = {}) {
  const obsQ = await client.query(
    `SELECT id, source_type, source_id, document_id, page_number,
            raw_value, normalized_value, value_json,
            ocr_engine, extraction_engine, ocr_confidence, extraction_confidence, created_at
       FROM fact_observations
      WHERE application_id=$1 AND fact_key=$2 AND superseded_at IS NULL`, [appId, factKey]);
  const observations = obsQ.rows;
  const pick = pickWinning(observations, factKey);

  // The current live canonical (if any).
  const curQ = await client.query(
    `SELECT id, value_json, value_normalized, status, authoritative_observation_id
       FROM loan_facts WHERE application_id=$1 AND fact_key=$2 AND effective_to IS NULL
      ORDER BY created_at DESC LIMIT 1`, [appId, factKey]);
  const current = curQ.rows[0] || null;

  // Nothing to record? A human_confirmed fact is preserved through any reconcile.
  if (current && current.status === 'human_confirmed') {
    return current;
  }

  const changed = !current
    || (current.value_normalized || '') !== (pick.normalizedValue || '')
    || current.status !== pick.status;
  if (!changed) return current;

  // Supersede the prior canonical (if any).
  if (current) {
    await client.query(`UPDATE loan_facts SET effective_to=now(), updated_at=now() WHERE id=$1`, [current.id]);
    await client.query(
      `INSERT INTO fact_events (application_id, fact_key, event_type, prior_value_json, new_value_json,
                                prior_status, new_status, observation_id, fact_id, actor_kind, reason)
       VALUES ($1,$2,'canonical_changed',$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10)`,
      [appId, factKey,
       current.value_json != null ? JSON.stringify(current.value_json) : null,
       pick.canonicalValueJson != null ? JSON.stringify(pick.canonicalValueJson) : null,
       current.status, pick.status, pick.winningObservationId, current.id,
       actorKind || 'system', reason || 'reconciled from observations']);
  }
  const insCanon = await client.query(
    `INSERT INTO loan_facts (application_id, fact_key, value_json, value_normalized,
                             authoritative_observation_id, status, consensus_score)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING *`,
    [appId, factKey,
     pick.canonicalValueJson != null ? JSON.stringify(pick.canonicalValueJson) : null,
     pick.normalizedValue, pick.winningObservationId, pick.status, pick.consensusScore]);
  const newRow = insCanon.rows[0];
  if (!current) {
    await client.query(
      `INSERT INTO fact_events (application_id, fact_key, event_type, new_value_json, new_status,
                                observation_id, fact_id, actor_kind, reason)
       VALUES ($1,$2,'canonical_created',$3::jsonb,$4,$5,$6,$7,$8)`,
      [appId, factKey,
       pick.canonicalValueJson != null ? JSON.stringify(pick.canonicalValueJson) : null,
       pick.status, pick.winningObservationId, newRow.id, actorKind || 'system',
       reason || 'first observation']);
  }
  // Mark every observation's agrees_with_canonical (bulk update).
  await client.query(
    `UPDATE fact_observations SET agrees_with_canonical = (normalized_value = $3)
      WHERE application_id=$1 AND fact_key=$2 AND superseded_at IS NULL`,
    [appId, factKey, pick.normalizedValue]);
  return newRow;
}

// -------------------------------------------------------------------------
// HUMAN CONFIRM — a staffer explicitly signs off on a value; it outranks
// automated reconciliation until they retract.
// -------------------------------------------------------------------------
async function confirmByHuman(client, { appId, factKey, valueJson, staffId, reason } = {}) {
  if (!appId || !factKey) throw new Error('confirmByHuman: appId + factKey required');
  const normalizedValue = normalize(factKey, valueJson);
  // Supersede the current canonical + insert the human-confirmed row.
  const curQ = await client.query(
    `SELECT id, value_json, status FROM loan_facts WHERE application_id=$1 AND fact_key=$2 AND effective_to IS NULL`,
    [appId, factKey]);
  const current = curQ.rows[0] || null;
  if (current) {
    await client.query(`UPDATE loan_facts SET effective_to=now(), updated_at=now() WHERE id=$1`, [current.id]);
  }
  const ins = await client.query(
    `INSERT INTO loan_facts (application_id, fact_key, value_json, value_normalized,
                             status, human_confirmed_by, human_confirmed_at, consensus_score)
     VALUES ($1,$2,$3::jsonb,$4,'human_confirmed',$5,now(),1) RETURNING *`,
    [appId, factKey, JSON.stringify(valueJson || null), normalizedValue, staffId || null]);
  await client.query(
    `INSERT INTO fact_events (application_id, fact_key, event_type, prior_value_json, new_value_json,
                              prior_status, new_status, fact_id, actor_kind, actor_id, reason)
     VALUES ($1,$2,'human_confirmed',$3::jsonb,$4::jsonb,$5,'human_confirmed',$6,'staff',$7,$8)`,
    [appId, factKey,
     current && current.value_json != null ? JSON.stringify(current.value_json) : null,
     JSON.stringify(valueJson || null), current ? current.status : null,
     ins.rows[0].id, staffId || null, reason || 'staff confirmed']);
  return ins.rows[0];
}

// -------------------------------------------------------------------------
// READ HELPERS
// -------------------------------------------------------------------------
async function factsForFile(appId, client) {
  client = client || db();
  const r = await client.query(
    `SELECT fact_key, value_json, value_normalized, status, consensus_score,
            authoritative_observation_id, human_confirmed_by, human_confirmed_at,
            effective_from, updated_at
       FROM loan_facts WHERE application_id=$1 AND effective_to IS NULL
      ORDER BY fact_key`, [appId]);
  return r.rows;
}

async function factWithHistory(appId, factKey, client) {
  client = client || db();
  const canonicalQ = await client.query(
    `SELECT * FROM loan_facts WHERE application_id=$1 AND fact_key=$2 AND effective_to IS NULL`, [appId, factKey]);
  const obsQ = await client.query(
    `SELECT * FROM fact_observations WHERE application_id=$1 AND fact_key=$2 AND superseded_at IS NULL
      ORDER BY created_at DESC`, [appId, factKey]);
  const evQ = await client.query(
    `SELECT * FROM fact_events WHERE application_id=$1 AND fact_key=$2
      ORDER BY created_at DESC LIMIT 100`, [appId, factKey]);
  return { canonical: canonicalQ.rows[0] || null, observations: obsQ.rows, events: evQ.rows };
}

// Supersede observations from a document (called when the document is
// replaced). Kept append-only — nothing is deleted.
async function supersedeObservationsForDocument(client, documentId, reason) {
  await client.query(
    `UPDATE fact_observations SET superseded_at=now() WHERE document_id=$1 AND superseded_at IS NULL`,
    [documentId]);
  // Reconcile every affected (application, fact_key) — cheapest to query them out.
  const r = await client.query(
    `SELECT DISTINCT application_id, fact_key FROM fact_observations WHERE document_id=$1`, [documentId]);
  for (const row of r.rows) {
    await reconcile(client, { appId: row.application_id, factKey: row.fact_key, reason: reason || 'source document superseded' });
  }
}

// -------------------------------------------------------------------------
// EXTRACTED_FIELD_MAP — per (doc_type, extracted_field), the fact_key that
// observation covers. Populated across the document types PILOT extracts.
// A field not listed is IGNORED (no observation recorded) — new fact keys
// require deliberate wiring. Kept next to the reconciliation logic so it's
// obvious which extractions flow into the twin.
// -------------------------------------------------------------------------
const EXTRACTED_FIELD_MAP = Object.freeze({
  government_id: {
    name:            FACT_KEYS.BORROWER_NAME,
    dateOfBirth:     FACT_KEYS.BORROWER_DOB,
    address:         FACT_KEYS.BORROWER_ADDRESS,
  },
  purchase_contract: {
    price:           FACT_KEYS.PURCHASE_PRICE,
    propertyAddress: FACT_KEYS.PROPERTY_ADDRESS,
    closingDate:     FACT_KEYS.CLOSING_DATE,
    buyerName:       FACT_KEYS.ENTITY_NAME,
  },
  contract_amendment: {
    price:           FACT_KEYS.PURCHASE_PRICE,
    closingDate:     FACT_KEYS.CLOSING_DATE,
  },
  title: {
    propertyAddress: FACT_KEYS.PROPERTY_ADDRESS,
    vesting:         FACT_KEYS.TITLE_VESTING,
    liens:           FACT_KEYS.TITLE_LIENS,
  },
  appraisal: {
    propertyAddress: FACT_KEYS.PROPERTY_ADDRESS,
    propertyType:    FACT_KEYS.PROPERTY_TYPE,
    units:           FACT_KEYS.PROPERTY_UNITS,
    yearBuilt:       FACT_KEYS.PROPERTY_YEAR_BUILT,
    asIsValue:       FACT_KEYS.APPRAISAL_AS_IS,
    arv:             FACT_KEYS.APPRAISAL_ARV,
    marketRent:      FACT_KEYS.APPRAISAL_RENT,
  },
  insurance: {
    insuredName:     FACT_KEYS.INSURANCE_INSURED,
    coverageAmount:  FACT_KEYS.INSURANCE_COVERAGE,
    effectiveDate:   FACT_KEYS.INSURANCE_EFFECTIVE,
    propertyAddress: FACT_KEYS.PROPERTY_ADDRESS,
  },
  flood: {
    floodZone:       FACT_KEYS.PROPERTY_FLOOD_ZONE,
    propertyAddress: FACT_KEYS.PROPERTY_ADDRESS,
  },
  llc_formation: {
    entityName:      FACT_KEYS.ENTITY_NAME,
    formationDate:   FACT_KEYS.ENTITY_FORMATION_DATE,
    state:           FACT_KEYS.ENTITY_STATE,
  },
  operating_agreement: {
    entityName:      FACT_KEYS.ENTITY_NAME,
  },
  ein_letter: {
    entityName:      FACT_KEYS.ENTITY_NAME,
    ein:             FACT_KEYS.ENTITY_EIN,
  },
  good_standing: {
    entityName:      FACT_KEYS.ENTITY_NAME,
    goodStanding:    FACT_KEYS.ENTITY_GOOD_STANDING,
  },
  bank_statement: {
    accountOwner:    FACT_KEYS.BANK_ACCOUNT_OWNER,
    endingBalance:   FACT_KEYS.BANK_ENDING_BALANCE,
  },
  voided_check: {
    accountOwner:    FACT_KEYS.BANK_ACCOUNT_OWNER,
  },
  credit_report: {
    borrowerName:    FACT_KEYS.BORROWER_NAME,
    fico:            FACT_KEYS.BORROWER_FICO,
  },
  background_report: {
    subjectName:     FACT_KEYS.OFAC_SUBJECT,
    ofacResult:      FACT_KEYS.OFAC_RESULT,
  },
  signed_application: {
    loanAmount:      FACT_KEYS.LOAN_AMOUNT,
    borrowerName:    FACT_KEYS.BORROWER_NAME,
  },
  signed_term_sheet: {
    loanAmount:      FACT_KEYS.LOAN_AMOUNT,
    noteRate:        FACT_KEYS.LOAN_RATE,
    term:            FACT_KEYS.LOAN_TERM_MONTHS,
  },
  settlement: {
    purchasePrice:   FACT_KEYS.PURCHASE_PRICE,
    loanAmount:      FACT_KEYS.LOAN_AMOUNT,
    propertyAddress: FACT_KEYS.PROPERTY_ADDRESS,
    closingDate:     FACT_KEYS.CLOSING_DATE,
  },
});

/**
 * Wire an extraction into the twin: for every extracted field the map covers,
 * record a fact observation. Called from the extraction persist path.
 * Best-effort at the call site — a twin recording error never blocks an
 * extraction from persisting.
 *   opts.appId, opts.documentId, opts.docType, opts.extractionId — required
 *   opts.fields — the extraction's field map (raw values before masking)
 *   opts.ocrEngine, opts.aiModel, opts.confidence — provenance
 *   opts.pageNumberFor(field) — optional function returning the page number
 *     the field was seen on (if the extractor knows). Defaults to null.
 */
async function recordFactsFromExtraction(client, opts = {}) {
  const { appId, documentId, docType, extractionId, fields } = opts;
  if (!appId || !docType || !extractionId || !fields || typeof fields !== 'object') return { recorded: 0 };
  const map = EXTRACTED_FIELD_MAP[docType];
  if (!map) return { recorded: 0 };
  const pageNumberFor = typeof opts.pageNumberFor === 'function' ? opts.pageNumberFor : () => null;
  let recorded = 0;
  for (const [extractedField, factKey] of Object.entries(map)) {
    const value = fields[extractedField];
    if (value == null || value === '') continue;
    try {
      await recordObservation(client, {
        appId, factKey,
        sourceType: 'document', sourceId: docType,
        documentId, extractionId,
        pageNumber: pageNumberFor(extractedField),
        rawValue: typeof value === 'object' ? JSON.stringify(value) : String(value),
        valueJson: value,
        ocrEngine: opts.ocrEngine || null,
        extractionEngine: opts.aiModel || null,
        extractionConfidence: confidenceToNumber(opts.confidence),
        reason: `${docType} extraction`,
      });
      recorded += 1;
    } catch (_) { /* one bad field never blocks the rest */ }
  }
  return { recorded };
}

function confidenceToNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).toLowerCase();
  if (s === 'definite') return 0.95;
  if (s === 'partial') return 0.7;
  if (s === 'unreadable') return 0.2;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/**
 * Record a batch of LOS field observations for a file — used when the
 * application row itself is (re)written (staff or borrower edit, ClickUp
 * inbound). One observation per (fact_key, current-value). Called
 * best-effort from write endpoints.
 */
async function recordLosFieldFacts(client, appId, appRow) {
  if (!appId || !appRow || typeof appRow !== 'object') return { recorded: 0 };
  const mapping = [
    ['loan_amount',               FACT_KEYS.LOAN_AMOUNT,        'applications.loan_amount'],
    ['purchase_price',            FACT_KEYS.PURCHASE_PRICE,     'applications.purchase_price'],
    ['as_is_value',               FACT_KEYS.APPRAISAL_AS_IS,    'applications.as_is_value'],
    ['arv',                       FACT_KEYS.APPRAISAL_ARV,      'applications.arv'],
    ['rehab_budget',              FACT_KEYS.REHAB_BUDGET,       'applications.rehab_budget'],
    ['assignment_fee',            FACT_KEYS.ASSIGNMENT_FEE,     'applications.assignment_fee'],
    ['underlying_contract_price', FACT_KEYS.UNDERLYING_PRICE,   'applications.underlying_contract_price'],
    ['property_type',             FACT_KEYS.PROPERTY_TYPE,      'applications.property_type'],
    ['units',                     FACT_KEYS.PROPERTY_UNITS,     'applications.units'],
    ['property_address',          FACT_KEYS.PROPERTY_ADDRESS,   'applications.property_address'],
    ['program',                   FACT_KEYS.LOAN_PROGRAM,       'applications.program'],
    ['loan_type',                 FACT_KEYS.LOAN_TYPE,          'applications.loan_type'],
    ['fico',                      FACT_KEYS.BORROWER_FICO,      'applications.fico'],
  ];
  let recorded = 0;
  for (const [col, factKey, sourceId] of mapping) {
    const v = appRow[col];
    if (v == null || v === '') continue;
    try {
      await recordObservation(client, {
        appId, factKey,
        sourceType: 'los_field', sourceId,
        rawValue: typeof v === 'object' ? JSON.stringify(v) : String(v),
        valueJson: v,
        reason: 'LOS field write',
      });
      recorded += 1;
    } catch (_) { /* per-field failures don't stop the loop */ }
  }
  return { recorded };
}

module.exports = {
  FACT_KEYS, SOURCE_HIERARCHY, NORMALIZERS, normalize,
  EXTRACTED_FIELD_MAP,
  recordObservation, reconcile, confirmByHuman,
  recordFactsFromExtraction, recordLosFieldFacts,
  factsForFile, factWithHistory, supersedeObservationsForDocument,
  _internals: { pickWinning },
};
