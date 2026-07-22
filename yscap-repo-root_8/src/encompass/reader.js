'use strict';
/**
 * src/encompass/reader.js — The PILOT-side ingestion for the READ-ONLY
 * Encompass connection (owner-directed freeze — see CLAUDE.md).
 *
 * Two entry points:
 *   refreshFieldCatalog() — pulls the tenant's field metadata (custom fields,
 *     picklists, milestones, folders, loan templates) and upserts each row
 *     into `encompass_field_catalog`. Idempotent — safe to run every night
 *     (or on-demand from the admin panel). Small; a full catalog is a few
 *     hundred rows at most.
 *   pullLoanForApplication(appId) — finds the loan by ys_loan_number, GETs
 *     the full raw loan JSON, and stashes it on the application row in
 *     `applications.encompass_extra` (jsonb) + stamps `encompass_last_pulled_at`.
 *     If we don't have a GUID yet, pipeline-search to find it, save the GUID.
 *     Once we have a GUID, subsequent pulls go GET-by-guid.
 *
 * PILOT NEVER WRITES to Encompass — every call in this module goes through
 * `client.js` → `encompass.apiGet` / `encompass.pipelineSearch`, which are
 * enforced READ-ONLY at the fetch layer. Absolutely nothing PILOT stores into
 * `encompass_extra` gets silently propagated INTO an authoritative PILOT column
 * — the raw payload is for staff cross-check only. Any future logic that maps
 * a specific Encompass field INTO a PILOT column is a separate, deliberate
 * step (per-row sign-off on `docs/ENCOMPASS-DATA-MAPPING.md`).
 */

const client = require('./client');
const db = require('../db');

// Fields the pipeline-search response should return alongside the loan GUID.
// Keeping this modest keeps the response small and gives us the natural key +
// enough context to log if the search returns multiple matches.
const PIPELINE_SEARCH_FIELDS = [
  'Loan.LoanNumber',
  'Loan.LoanAmount',
  'Loan.LoanFolder',
  'Loan.BorrowerLastName',
  'Loan.LastModified',
];

// Sensitive top-level sections we don't want lingering as duplicates inside
// `applications.encompass_extra`. Borrower PII already lives in the `borrowers`
// table (source of record) — we don't need another copy of the SSN sitting in
// jsonb where every future feature could stumble into it. Everything ELSE
// stays verbatim for staff review.
const PII_SCRUB_PATHS = [
  ['applications', '*', 'borrower', 'taxIdentificationIdentifier'],
  ['applications', '*', 'coBorrower', 'taxIdentificationIdentifier'],
];

function _scrubForStorage(loan) {
  if (!loan || typeof loan !== 'object') return loan;
  const out = JSON.parse(JSON.stringify(loan));
  const apps = Array.isArray(out.applications) ? out.applications : [];
  for (const app of apps) {
    if (app && app.borrower && typeof app.borrower === 'object') {
      delete app.borrower.taxIdentificationIdentifier;
    }
    if (app && app.coBorrower && typeof app.coBorrower === 'object') {
      delete app.coBorrower.taxIdentificationIdentifier;
    }
  }
  return out;
}
// Exposed for tests
_scrubForStorage._pathsScrubbed = PII_SCRUB_PATHS;

// ── Field catalog refresh ──────────────────────────────────────────────────

// Pulls the tenant's field metadata (custom fields, enums, milestones, folders,
// loan templates, standard fields) and upserts each into encompass_field_catalog.
// Returns a summary object with per-kind counts. Does not throw on a single-kind
// failure — records the error and continues to the next kind so a broken
// customFields endpoint doesn't block the enum refresh.
async function refreshFieldCatalog() {
  if (!client.configured()) throw new Error('Encompass not configured');
  const summary = { customField: 0, standardField: 0, enum: 0, milestone: 0, folder: 0, loanTemplate: 0, errors: {} };

  const kinds = [
    { kind: 'customField', fn: client.listCustomFields, keyFn: (r) => r.fieldName || r.id || r.name, labelFn: (r) => r.description || r.label || r.fieldName, typeFn: (r) => (r.format || r.type || '').toString().toLowerCase() },
    { kind: 'standardField', fn: client.listStandardFields, keyFn: (r) => r.canonicalName || r.fieldName || r.id, labelFn: (r) => r.description || r.label, typeFn: (r) => (r.format || r.type || '').toString().toLowerCase() },
    { kind: 'enum', fn: client.listFieldEnums, keyFn: (r) => r.fieldId || r.canonicalName || r.id, labelFn: (r) => r.description || r.name, typeFn: () => 'enum' },
    { kind: 'milestone', fn: client.listMilestoneCatalog, keyFn: (r) => r.name || r.id, labelFn: (r) => r.description || r.name, typeFn: () => 'milestone' },
    { kind: 'folder', fn: client.listLoanFolders, keyFn: (r) => r.folderName || r.name || r.id, labelFn: (r) => r.folderName || r.name, typeFn: () => 'folder' },
    { kind: 'loanTemplate', fn: client.listLoanTemplates, keyFn: (r) => r.path || r.name || r.id, labelFn: (r) => r.description || r.name, typeFn: () => 'loanTemplate' },
  ];

  for (const spec of kinds) {
    try {
      const rows = await spec.fn();
      const arr = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.items) ? rows.items : []);
      for (const raw of arr) {
        const key = spec.keyFn(raw);
        if (!key) continue;
        const label = spec.labelFn(raw) || null;
        const dataType = spec.typeFn(raw) || null;
        const options = raw.options || raw.enumValues || null;
        await db.query(
          `INSERT INTO encompass_field_catalog (kind, key, label, data_type, options, raw, pulled_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb, now())
           ON CONFLICT (kind, key) DO UPDATE
             SET label = EXCLUDED.label,
                 data_type = EXCLUDED.data_type,
                 options = EXCLUDED.options,
                 raw = EXCLUDED.raw,
                 pulled_at = now()`,
          [spec.kind, String(key), label, dataType, options ? JSON.stringify(options) : null, JSON.stringify(raw)],
        );
        summary[spec.kind]++;
      }
    } catch (e) {
      summary.errors[spec.kind] = e && e.message ? e.message.slice(0, 300) : String(e);
    }
  }
  return summary;
}

// ── Per-loan pull ──────────────────────────────────────────────────────────

// Given a PILOT application id, find the Encompass loan and stash the full raw
// JSON. Uses the cached GUID if we have one; otherwise pipeline-searches by
// ys_loan_number, saves the GUID, then GETs the loan.
//
// Returns:
//   { ok:true, guid, pulledAt, size } on success
//   { ok:false, reason } if we couldn't find/pull (never throws; the error is
//     stamped into applications.encompass_last_error so the staff panel shows it)
async function pullLoanForApplication(appId) {
  if (!appId) throw new Error('pullLoanForApplication: appId is required.');
  if (!client.configured()) return _stampError(appId, 'Encompass not configured (env)');

  const row = (await db.query(
    `SELECT id, ys_loan_number, encompass_loan_guid FROM applications WHERE id=$1 LIMIT 1`,
    [appId],
  )).rows[0];
  if (!row) return { ok: false, reason: 'application not found' };
  if (!row.ys_loan_number) return _stampError(appId, 'ys_loan_number not set on the file');

  let guid = row.encompass_loan_guid;
  if (!guid) {
    let hits;
    try { hits = await client.findLoanByLoanNumber(row.ys_loan_number, { extraFields: PIPELINE_SEARCH_FIELDS.filter((f) => f !== 'Loan.LoanNumber') }); }
    catch (e) { return _stampError(appId, `pipeline search: ${e.message}`); }
    if (!hits.length) return _stampError(appId, `no Encompass loan for loan# ${row.ys_loan_number}`);
    if (hits.length > 1) return _stampError(appId, `ambiguous Encompass match: ${hits.length} loans share loan# ${row.ys_loan_number}`);
    guid = hits[0].loanGuid || hits[0].guid;
    if (!guid) return _stampError(appId, 'pipeline search returned a row without a GUID');
    await db.query(
      `UPDATE applications SET encompass_loan_guid=$1, updated_at=now() WHERE id=$2 AND encompass_loan_guid IS NULL`,
      [guid, appId],
    );
  }

  let loan;
  try { loan = await client.getLoan(guid); }
  catch (e) { return _stampError(appId, `getLoan: ${e.message}`); }

  const scrubbed = _scrubForStorage(loan);
  const jsonText = JSON.stringify(scrubbed);
  await db.query(
    `UPDATE applications
        SET encompass_extra=$1::jsonb,
            encompass_last_pulled_at=now(),
            encompass_last_error=NULL,
            updated_at=now()
      WHERE id=$2`,
    [jsonText, appId],
  );
  return { ok: true, guid, pulledAt: new Date().toISOString(), size: Buffer.byteLength(jsonText, 'utf8') };
}

async function _stampError(appId, reason) {
  const short = String(reason || 'unknown').slice(0, 300);
  await db.query(
    `UPDATE applications SET encompass_last_error=$1, updated_at=now() WHERE id=$2`,
    [short, appId],
  ).catch(() => {});
  return { ok: false, reason: short };
}

module.exports = {
  refreshFieldCatalog,
  pullLoanForApplication,
  // exported for unit tests
  _scrubForStorage,
  PIPELINE_SEARCH_FIELDS,
};
