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

// Encompass requires the pipeline search body to name WHICH loans (via
// loanIds / loanFolders / filter / fieldFilters — a body with none of those
// is refused). Two viable approaches:
//   (a) Fetch every folder name and pass loanFolders — but the settings/loan/*
//       endpoints often require an admin persona (2026-07-22 live diag: a
//       normal-user token returns 403 on /settings/loan/folders).
//   (b) Pass a match-all FILTER — `Loan.LastModified > 1900-01-01` matches
//       every loan ever created. Works with any token that can read the
//       pipeline. This is what we default to; the folders approach is
//       kept as an OPTIONAL enhancement if the tenant permits it.
// `MATCH_ALL_FILTER` is the "give me everything" clause the pipeline body
// needs when no tighter scope is desired.
const MATCH_ALL_FILTER = Object.freeze({
  canonicalName: 'Loan.LastModified',
  value: '1900-01-01',
  matchType: 'GreaterThan',
  precision: 'Day',
});

// Try to list every folder name — but SWALLOW a 403 (or any other error) and
// return []. Callers decide whether to fall back to the match-all filter.
async function _fetchAllFolderNames() {
  try {
    const resp = await client.listLoanFolders();
    const arr = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.items) ? resp.items : []);
    const names = arr.map((f) => (f && (f.folderName || f.name)) || (typeof f === 'string' ? f : null)).filter(Boolean);
    return [...new Set(names)];
  } catch (_e) {
    // 403 or otherwise — settings endpoints often require an admin persona;
    // returning [] lets the caller fall back to the match-all filter.
    return [];
  }
}
_fetchAllFolderNames._exportedForTest = true;

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

// ── Super-dump (single-response snapshot for Claude / staff review) ────────

// One HTTP call that returns everything an off-platform reviewer needs to
// design PILOT-side mappings against this tenant's Encompass:
//   - The FULL cached field catalog (all customField / standardField / enum /
//     milestone / folder / loanTemplate rows we've pulled).
//   - N representative loan JSONs (default 20), sampled by a pipeline search
//     that returns the most-recently-modified loans across the whole tenant.
//     Each loan is passed through `_scrubForStorage` (SSNs out) — everything
//     else is verbatim so field shapes are visible.
//   - The count of total available loans (from the pipeline count) so the
//     reviewer knows the sample size vs. the population.
// Not for routine use — a single super-dump can be several MB. The `sampleN`
// cap keeps it in the pasteable/downloadable range (default 20 → ~2-5 MB).
async function superDump({ sampleN = 20 } = {}) {
  if (!client.configured()) throw new Error('Encompass not configured');
  const n = Math.max(1, Math.min(100, Number(sampleN) || 20));

  const catalog = (await db.query(
    `SELECT kind, key, label, data_type, options, pulled_at
       FROM encompass_field_catalog ORDER BY kind, key`,
  )).rows;
  const catalogCounts = (await db.query(
    `SELECT kind, count(*)::int AS n, max(pulled_at) AS last_pulled
       FROM encompass_field_catalog GROUP BY kind`,
  )).rows;

  // Pipeline-search the tenant for the most-recent N loans across the whole
  // tenant. Encompass requires loanFolders / loanIds / filter / fieldFilters
  // — a body with none is refused. Prefer folders (if the token permits) so
  // the request is scope-tight; fall back to a match-all filter otherwise.
  let recent = [];
  let searchError = null;
  const folders = await _fetchAllFolderNames();
  const scope = folders.length ? { loanFolders: folders } : { filter: MATCH_ALL_FILTER };
  try {
    recent = await client.pipelineSearch({
      ...scope,
      sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
      fields: ['Loan.Guid', 'Loan.LoanNumber', 'Loan.LoanFolder', 'Loan.LoanAmount', 'Loan.LoanProgram', 'Loan.LoanPurpose', 'Loan.BorrowerLastName', 'Loan.LastModified'],
    }, { limit: n });
    if (!Array.isArray(recent)) recent = [];
  } catch (e) { searchError = e.message; }

  // Full-fat loan pulls for the sample (raw JSON, PII-scrubbed).
  const loans = [];
  for (const hit of recent.slice(0, n)) {
    const guid = hit.loanGuid || hit.guid;
    if (!guid) continue;
    try {
      const raw = await client.getLoan(guid);
      loans.push({ guid, hit, loan: _scrubForStorage(raw) });
    } catch (e) {
      loans.push({ guid, hit, error: e.message });
    }
  }

  return {
    tenantConfigured: true,
    generatedAt: new Date().toISOString(),
    catalog: { counts: catalogCounts, rows: catalog },
    sample: { requested: n, returned: loans.length, totalMatchedBySearch: recent.length, searchError, loans },
  };
}

// ── Bulk pull — mirror every Encompass loan into PILOT storage ─────────────

// Kick off a full-tenant pull. Runs sequentially with a small per-request
// delay to stay under Encompass's ~200 req/min limit. Idempotent — running
// again just refreshes rows.
// Steps per loan:
//   1) pipeline-search finds the GUID + basic projection.
//   2) getLoan pulls the raw JSON (PII-scrubbed via _scrubForStorage).
//   3) upsert into encompass_loan_snapshot (source of truth for "everything
//      Encompass says").
//   4) if a PILOT application has ys_loan_number == loan_number, ALSO stash
//      the raw JSON in that application's encompass_extra + adopt the GUID.
// Records progress + a per-run summary in encompass_bulk_pull_runs so admin
// can watch a live "342 / 1147" gauge.
async function bulkPullAllLoans({ perRequestDelayMs = 350, startedByStaffId = null, pageSize = 200 } = {}) {
  if (!client.configured()) throw new Error('Encompass not configured');
  const runId = (await db.query(
    `INSERT INTO encompass_bulk_pull_runs (started_by, status) VALUES ($1, 'running') RETURNING id`,
    [startedByStaffId],
  )).rows[0].id;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const counts = { pulled: 0, matched: 0, unmatched: 0, failed: 0 };
  let lastError = null;

  try {
    // Scope the pipeline query: prefer folders (tight scope), fall back to a
    // match-all filter if the token can't read /settings/loan/folders (403 on
    // non-admin personas — 2026-07-22 live diag). The match-all works with
    // any pipeline-capable token.
    const folders = await _fetchAllFolderNames();
    const scope = folders.length ? { loanFolders: folders } : { filter: MATCH_ALL_FILTER };

    // Paginate the pipeline via ?limit=N&start=M — offset-based, so it
    // never depends on the LastModified field being filterable and never
    // skips or double-counts loans that share the same modified timestamp.
    // First call: start=0. Advance start by page.length after each page.
    let offset = 0;
    let totalReported = null;
    /* eslint-disable no-await-in-loop */
    while (true) {
      let page;
      try {
        page = await client.pipelineSearch({
          ...scope,
          sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
          fields: ['Loan.Guid', 'Loan.LoanNumber', 'Loan.LoanFolder', 'Loan.LoanAmount', 'Loan.BorrowerLastName', 'Loan.LastModified'],
        }, { limit: pageSize, start: offset });
      } catch (e) {
        lastError = `pipeline page: ${e.message}`;
        break;
      }
      if (!Array.isArray(page) || page.length === 0) break;

      if (totalReported === null) totalReported = page.length;  // running estimate

      for (const hit of page) {
        const guid = hit.loanGuid || hit.guid;
        const loanNumber = hit['Loan.LoanNumber'] || hit.loanNumber || null;
        const folder = hit['Loan.LoanFolder'] || null;
        const borrowerLast = hit['Loan.BorrowerLastName'] || null;
        const loanAmount = Number(hit['Loan.LoanAmount']) || null;
        const lastMod = hit['Loan.LastModified'] || null;
        if (!guid) continue;
        try {
          const raw = await client.getLoan(guid);
          const scrubbed = _scrubForStorage(raw);
          const jsonText = JSON.stringify(scrubbed);

          // Upsert into snapshot table.
          await db.query(
            `INSERT INTO encompass_loan_snapshot
               (encompass_loan_guid, loan_number, loan_folder, borrower_last_name, loan_amount,
                last_modified, raw, pulled_at, last_error)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now(), NULL)
             ON CONFLICT (encompass_loan_guid) DO UPDATE
               SET loan_number=EXCLUDED.loan_number,
                   loan_folder=EXCLUDED.loan_folder,
                   borrower_last_name=EXCLUDED.borrower_last_name,
                   loan_amount=EXCLUDED.loan_amount,
                   last_modified=EXCLUDED.last_modified,
                   raw=EXCLUDED.raw,
                   pulled_at=now(),
                   last_error=NULL`,
            [guid, loanNumber, folder, borrowerLast, loanAmount, lastMod, jsonText],
          );
          counts.pulled++;

          // Attach to PILOT application by loan number, if we can.
          const matched = loanNumber ? (await db.query(
            `UPDATE applications
                SET encompass_loan_guid = COALESCE(encompass_loan_guid, $1),
                    encompass_extra = $2::jsonb,
                    encompass_last_pulled_at = now(),
                    encompass_last_error = NULL,
                    updated_at = now()
              WHERE ys_loan_number = $3
              RETURNING id`,
            [guid, jsonText, loanNumber],
          )).rows[0] : null;
          if (matched) {
            counts.matched++;
            await db.query(
              `UPDATE encompass_loan_snapshot SET application_id = $1 WHERE encompass_loan_guid = $2`,
              [matched.id, guid],
            );
          } else {
            counts.unmatched++;
          }

          // Update the run's live counters every 25 loans (cheap enough).
          if ((counts.pulled % 25) === 0) {
            await db.query(
              `UPDATE encompass_bulk_pull_runs
                  SET pulled = $1, matched = $2, unmatched = $3, failed = $4
                WHERE id = $5`,
              [counts.pulled, counts.matched, counts.unmatched, counts.failed, runId],
            );
          }
        } catch (e) {
          counts.failed++;
          lastError = `guid ${guid}: ${e.message}`;
          await db.query(
            `INSERT INTO encompass_loan_snapshot (encompass_loan_guid, loan_number, pulled_at, last_error)
             VALUES ($1, $2, now(), $3)
             ON CONFLICT (encompass_loan_guid) DO UPDATE SET last_error = EXCLUDED.last_error, pulled_at = now()`,
            [guid, loanNumber, e.message.slice(0, 300)],
          );
        }

        await sleep(perRequestDelayMs);
      }

      // A short page means we've hit the end of the tenant.
      if (page.length < pageSize) break;
      offset += page.length;
    }
    /* eslint-enable no-await-in-loop */

    await db.query(
      `UPDATE encompass_bulk_pull_runs
          SET pulled=$1, matched=$2, unmatched=$3, failed=$4,
              total_loans=$5, last_error=$6,
              status = $7, finished_at = now()
        WHERE id = $8`,
      [counts.pulled, counts.matched, counts.unmatched, counts.failed,
       counts.pulled, lastError, lastError ? 'failed' : 'completed', runId],
    );
    return { runId, ...counts, lastError };
  } catch (e) {
    await db.query(
      `UPDATE encompass_bulk_pull_runs
          SET pulled=$1, matched=$2, unmatched=$3, failed=$4,
              last_error=$5, status='failed', finished_at=now()
        WHERE id=$6`,
      [counts.pulled, counts.matched, counts.unmatched, counts.failed, e.message, runId],
    ).catch(() => {});
    throw e;
  }
}

module.exports = {
  refreshFieldCatalog,
  pullLoanForApplication,
  superDump,
  bulkPullAllLoans,
  // exported for unit tests
  _scrubForStorage,
  PIPELINE_SEARCH_FIELDS,
};
