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
// The master on/off switch. Asked DIRECTLY rather than through the client module,
// because tests replace that module wholesale in require.cache and a stub carries only
// the handful of methods the test needs — this one is pure and is never stubbed.
const killSwitch = require('../lib/integrations/encompass-enabled');
const db = require('../db');
const cfg = require('../config');
const identity = require('../clickup/identity');

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

// A pipeline-search response row. Encompass Developer Connect v3 returns each
// row as { loanId: "<GUID>", fields: { "Loan.Guid": ..., "Loan.LoanNumber": ... } }
// — the GUID is `loanId` (NOT `loanGuid`) and the requested field values are
// NESTED under `fields`, keyed by canonical name. Earlier code (and the unit-test
// mocks) assumed { loanGuid } with the values flattened onto the row, so a real
// response came back "without a GUID" (2026-07-26 live). These accessors read
// BOTH shapes so a real row is never dropped or stored with null fields.
function _rowFields(hit) {
  return (hit && typeof hit.fields === 'object' && hit.fields) ? hit.fields : (hit || {});
}
function _rowGuid(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const f = _rowFields(hit);
  return hit.loanGuid || hit.loanId || hit.guid
    || f['Loan.Guid'] || f['Loan.LoanGuid'] || f.loanGuid || f.loanId || null;
}
function _rowField(hit, canonicalName) {
  const f = _rowFields(hit);
  return f[canonicalName] != null ? f[canonicalName] : null;
}
// Row key names only (never values) — safe to surface in an error so an
// unexpected response shape is diagnosable without leaking PII.
function _rowShape(hit) {
  const top = Object.keys(hit || {});
  const nested = (hit && typeof hit.fields === 'object' && hit.fields) ? Object.keys(hit.fields) : [];
  return `row keys: ${top.join(',') || 'none'}${nested.length ? '; fields: ' + nested.join(',') : ''}`;
}

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

// Replace a party's plaintext SSN with a PII-SAFE keyed HMAC hash + last-4 BEFORE
// it is stored, so applications.encompass_extra can support a hash-based SSN
// comparison (owner-directed 2026-07-26: compare borrower AND co-borrower SSN)
// WITHOUT ever persisting the raw number. `_ssnHash` is HMAC-SHA256 of the 9
// digits under cfg.ssnMatchKey — the SAME keyed hash our own borrowers.ssn_hash
// uses (src/clickup/identity.ssnHash), so the two are directly comparable; it is
// one-way (not reversible without the key). `_ssnLast4` is the last four for
// masked display only. The full `taxIdentificationIdentifier` is always deleted.
function _hashAndStripSsn(party) {
  if (!party || typeof party !== 'object') return;
  const raw = party.taxIdentificationIdentifier;
  if (raw != null && raw !== '') {
    const h = identity.ssnHash(raw, cfg.ssnMatchKey);
    if (h) party._ssnHash = h;
    const d = String(raw).replace(/\D/g, '');
    if (d.length >= 4) party._ssnLast4 = d.slice(-4);
  }
  delete party.taxIdentificationIdentifier; // never store the plaintext SSN
}

// The borrower/co-borrower SSN read BY FIELD NUMBER (std ids 65 / 97) comes back as
// PLAINTEXT in the fieldReader map. It must NEVER be stored in applications.encompass_extra
// — the exact guarantee _hashAndStripSsn gives the loan subtree. This is the same
// treatment for the flat `_fieldValues` map: replace the raw SSN with the PII-SAFE keyed
// HMAC hash + last-4 (the SAME hash borrowers.ssn_hash uses, so reconcile can compare it),
// under fixed private keys, and DELETE the raw digits. Mutates + returns `vals`. Idempotent
// (after the first pass the raw ids are gone, so re-running is a no-op). Called at every
// place that fetches identity fields by number (the reader pull + the reconcile self-heal)
// AND defensively inside _scrubForStorage, so no path can persist a plaintext SSN.
const _FIELDVALUE_SSN = [
  { raw: '65', hash: '_ssn_b_hash', last4: '_ssn_b_last4' },   // borrower SSN
  { raw: '97', hash: '_ssn_cb_hash', last4: '_ssn_cb_last4' }, // co-borrower SSN
];
function scrubFieldValuesSsn(vals) {
  if (!vals || typeof vals !== 'object') return vals;
  for (const m of _FIELDVALUE_SSN) {
    const raw = vals[m.raw];
    if (raw != null && String(raw).trim() !== '') {
      const h = identity.ssnHash(raw, cfg.ssnMatchKey);
      if (h) vals[m.hash] = h;
      const d = String(raw).replace(/\D/g, '');
      if (d.length >= 4) vals[m.last4] = d.slice(-4);
    }
    delete vals[m.raw]; // never store the plaintext SSN
  }
  return vals;
}

function _scrubForStorage(loan) {
  if (!loan || typeof loan !== 'object') return loan;
  const out = JSON.parse(JSON.stringify(loan));
  const apps = Array.isArray(out.applications) ? out.applications : [];
  for (const app of apps) {
    if (app && app.borrower && typeof app.borrower === 'object') _hashAndStripSsn(app.borrower);
    if (app && app.coBorrower && typeof app.coBorrower === 'object') _hashAndStripSsn(app.coBorrower);
  }
  // Defense-in-depth: a plaintext SSN read by number (65/97) must never survive into
  // storage even if a caller set `_fieldValues` without pre-scrubbing.
  if (out._fieldValues && typeof out._fieldValues === 'object') scrubFieldValuesSsn(out._fieldValues);
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
//
// ── THE SIX CATALOGS, AND HOW EACH ANSWER IS KEYED ──────────────────────────
//
// LIFTED OUT OF THE FUNCTION SO IT CAN BE TESTED WITH REAL PAYLOADS (2026-08-25).
// Every one of these key functions is a chain of guesses at what the vendor calls
// its own id, and a chain that resolves to `undefined` does not fail — it hits the
// `if (!key) continue` below and the row is dropped. Six catalogs could therefore
// report "refreshed, no errors" and store nothing at all, which is precisely the
// class of silent success this whole change is about.
//
// The key names below were MEASURED against the live tenant, not assumed:
//
//   customField    id, description, format, maxLength, type, isCalculatedField…
//   standardField  id, description, format, readOnly, fieldLock, nullable…      -> resolves on `id`
//   milestone      id, name, tpoStatus, consumerStatus, milestoneColor…         -> resolves on `name`
//   folder         name, activityRules, folderType, isExternalOrganization…     -> resolves on `name`
//   enum           normalised by `client.listFieldEnums` before it gets here —
//                  the raw payload keys rows by `fieldID` with a capital D, which
//                  matches NOTHING in this chain. See that function's header.
//
// `test-encompass-catalog-keys-pure.js` runs these very functions against fixtures
// taken from those measured answers, so a chain that stops resolving fails the build
// instead of quietly emptying a catalog.
const CATALOG_KINDS = [
  { kind: 'customField', fn: () => client.listCustomFields(), keyFn: (r) => r.fieldName || r.id || r.name, labelFn: (r) => r.description || r.label || r.fieldName, typeFn: (r) => (r.format || r.type || '').toString().toLowerCase() },
  { kind: 'standardField', fn: () => client.listStandardFields(), keyFn: (r) => r.canonicalName || r.fieldName || r.id, labelFn: (r) => r.description || r.label, typeFn: (r) => (r.format || r.type || '').toString().toLowerCase() },
  { kind: 'enum', fn: () => client.listFieldEnums(), keyFn: (r) => r.fieldId || r.canonicalName || r.id, labelFn: (r) => r.description || r.name, typeFn: () => 'enum' },
  { kind: 'milestone', fn: () => client.listMilestoneCatalog(), keyFn: (r) => r.name || r.id, labelFn: (r) => r.description || r.name, typeFn: () => 'milestone' },
  { kind: 'folder', fn: () => client.listLoanFolders(), keyFn: (r) => r.folderName || r.name || r.id, labelFn: (r) => r.folderName || r.name, typeFn: () => 'folder' },
  { kind: 'loanTemplate', fn: () => client.listLoanTemplates(), keyFn: (r) => r.path || r.name || r.id, labelFn: (r) => r.description || r.name, typeFn: () => 'loanTemplate' },
];

async function refreshFieldCatalog() {
  if (!killSwitch.encompassEnabled()) throw new Error(killSwitch.OFF_REASON);
  if (!client.configured()) throw new Error('Encompass not configured');
  const summary = { customField: 0, standardField: 0, enum: 0, milestone: 0, folder: 0, loanTemplate: 0, errors: {} };

  for (const spec of CATALOG_KINDS) {
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

// Is this getLoan error a DEFINITIVE "that loan no longer exists" (HTTP 404/410)
// — as opposed to a transient hiccup (401/403 auth, 5xx server, a timeout)? Only
// a definitive not-found may clear a cached GUID; clearing on a transient error
// would throw away a perfectly good link on every Encompass blip. The error text
// is `Encompass <status>: <body>` (see integrations/encompass.js apiGet), so a
// leading `Encompass 404`/`Encompass 410` is the reliable signal.
function _isLoanNotFound(e) {
  return /^Encompass 4(?:04|10)\b/.test(String((e && e.message) || ''));
}

// Pipeline-search for a loan by loan number and resolve the single matching GUID.
// Returns { guid } on a clean single match, or { reason } (plain language) on no
// match / an ambiguous match / a search error / a row without a GUID. Shared by
// the first-time search AND the stale-GUID self-heal so both behave identically.
async function _searchGuid(loanNumber) {
  let hits;
  try { hits = await client.findLoanByLoanNumber(loanNumber, { extraFields: PIPELINE_SEARCH_FIELDS.filter((f) => f !== 'Loan.LoanNumber') }); }
  catch (e) { return { reason: `pipeline search: ${e.message}` }; }
  if (!hits.length) return { reason: `no Encompass loan for loan# ${loanNumber}` };
  if (hits.length > 1) return { reason: `ambiguous Encompass match: ${hits.length} loans share loan# ${loanNumber}` };
  const guid = _rowGuid(hits[0]);
  if (!guid) return { reason: `pipeline search returned a row without a GUID (${_rowShape(hits[0])})` };
  return { guid };
}

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
  if (!killSwitch.encompassEnabled()) return _stampError(appId, killSwitch.OFF_REASON);
  if (!client.configured()) return _stampError(appId, 'Encompass not configured (env)');

  const row = (await db.query(
    `SELECT id, ys_loan_number, encompass_loan_guid FROM applications WHERE id=$1 LIMIT 1`,
    [appId],
  )).rows[0];
  if (!row) return { ok: false, reason: 'application not found' };
  if (!row.ys_loan_number) return _stampError(appId, 'ys_loan_number not set on the file');

  let guid = row.encompass_loan_guid;
  const hadCachedGuid = !!guid;
  if (!guid) {
    const s = await _searchGuid(row.ys_loan_number);
    if (s.reason) return _stampError(appId, s.reason);
    guid = s.guid;
    await db.query(
      `UPDATE applications SET encompass_loan_guid=$1, updated_at=now() WHERE id=$2 AND encompass_loan_guid IS NULL`,
      [guid, appId],
    );
  }

  let loan;
  try { loan = await client.getLoan(guid); }
  catch (e) {
    // STALE-GUID SELF-HEAL (owner-reported 2026-08: a file "read from Encompass
    // 9d ago" that keeps failing to refresh even after pressing Refresh). The GUID
    // we cache can go DEAD — a loan deleted / merged / renumbered in Encompass, or
    // a hand-edited row — and a dead GUID makes getLoan 404/410 on every pull, so
    // the timestamp freezes and the file never matches, forever, with no way out.
    // The fix: on a DEFINITIVE not-found (404/410) AND only when we started from a
    // CACHED guid (a guid we JUST searched for this call is not stale), clear the
    // bad link and re-search by loan number ONCE — so the very next pull self-heals
    // instead of dead-ending. A transient error (401/403 auth, 5xx, a timeout) is
    // NEVER treated as "gone" — clearing on those would throw away a good guid on
    // every Encompass hiccup. Mirrors the same-loan guard below, which already
    // clears the guid when it resolves to a DIFFERENT loan.
    if (hadCachedGuid && _isLoanNotFound(e)) {
      await db.query('UPDATE applications SET encompass_loan_guid=NULL WHERE id=$1', [appId]).catch(() => {});
      const s = await _searchGuid(row.ys_loan_number);
      if (s.reason) return _stampError(appId, `the saved Encompass link was out of date, so we searched again by loan# ${row.ys_loan_number} — ${s.reason}`);
      guid = s.guid;
      await db.query(
        `UPDATE applications SET encompass_loan_guid=$1, updated_at=now() WHERE id=$2`,
        [guid, appId],
      );
      try { loan = await client.getLoan(guid); }
      catch (e2) { return _stampError(appId, `re-read after fixing the out-of-date Encompass link failed: ${e2.message}`); }
    } else {
      return _stampError(appId, `getLoan: ${e.message}`);
    }
  }

  // Read every mapped field BY FIELD NUMBER (owner sign-off 2026-07-26). The same
  // field number lives at a DIFFERENT JSON path from loan to loan — 1859 sat in
  // closingDocument.finalVestingDescription on one loan and was absent on the next
  // (the LLC name was in borrowerUnparsedName1), and 388's real value appears at no
  // stable path at all (the path we read held a different fee). Asking Encompass for
  // the NUMBERS is the only way to be right on every loan. Best-effort: a failure
  // leaves `_fieldValues` unset and the path-based extract still works exactly as
  // before, so a fieldReader outage degrades rather than breaks the pull.
  try {
    const fm = require('../lib/integrations/encompass-field-map');
    // Economics fields AND borrower/co-borrower IDENTITY fields (name/DOB/email/phone/
    // SSN) — read BY NUMBER so identity is location-independent and self-healing, the
    // same as 1859/388. This is what lets the reconcile find a co-borrower the stored
    // applications[] subtree left out (owner-directed 2026-08-02, YSCAP258134762).
    const ids = fm.allFieldIds().concat(fm.identityFieldIds());
    const vals = await client.readFields(guid, ids);
    // Hash + strip the plaintext SSN (fields 65/97) BEFORE it is ever stored on the loan.
    scrubFieldValuesSsn(vals);
    // Stamp that identity was read by number (only on a non-empty read) so the reconcile
    // self-heal treats this snapshot as already-identity-read and never re-fires a live
    // read on every panel view (see reconcile._hasIdentityFieldValues).
    if (vals && typeof vals === 'object' && Object.keys(vals).length) { vals._idRead = 1; loan._fieldValues = vals; }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[encompass] fieldReader unavailable, falling back to loan paths:', e && e.message);
  }


  // SAME-LOAN GUARD (owner-directed 2026-07-26: "make sure it's only reading fields
  // from the loan file that matches the loan number and not going to other files").
  // The search that FINDS a loan is already exact-match on the loan number and
  // REFUSES an ambiguous multi-hit — but the resulting GUID is then CACHED on the
  // application, and every later pull skips the search and GETs by that GUID. So a
  // GUID that is ever wrong (a loan number reassigned in Encompass, a hand-edited
  // row) would silently keep reading a DIFFERENT borrower's loan forever. Verify on
  // EVERY pull that the loan we just fetched really carries OUR loan number, using
  // the authoritative field 364 (falling back to the loan JSON's own loanNumber).
  // On a mismatch: store NOTHING, clear the bad GUID so the next pull re-searches,
  // and stamp a plain-language error. Compared case/space-insensitively so a
  // harmless formatting difference is not treated as a different loan.
  {
    const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
    const ours = norm(row.ys_loan_number);
    const theirs = norm((loan._fieldValues && loan._fieldValues['364']) || loan.loanNumber);
    if (ours && theirs && ours !== theirs) {
      await db.query('UPDATE applications SET encompass_loan_guid=NULL WHERE id=$1', [appId]).catch(() => {});
      return _stampError(appId, `refused: the Encompass loan we fetched is loan# ${theirs}, but this file is loan# ${row.ys_loan_number}. Nothing was saved and the stale link was cleared — the next sync will search again by loan number.`);
    }
  }

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

  // THE SOLD SIGNAL. The Purchase Advice date rides the field-by-number read above; this lands it
  // in its own column so "has this loan been sold?" is one indexed question rather than a jsonb
  // dig on every draw screen. Read-only INTO our column — nothing is ever written to Encompass.
  // Best-effort and self-describing: with no owner-supplied field id it does nothing at all, and
  // the draw desk honestly says it cannot tell (which shows the not-sold warning).
  try {
    await require('../sitewire/release-party').syncPurchaseAdviceDate(db, appId, loan._fieldValues);
  } catch (_) { /* never break a pull over a reference field */ }

  // THE FUNDED DATE. CX.FUNDEDDATE has been READ on every pull since the field map was
  // written and never WRITTEN anywhere — so the closer retyped by hand a date PILOT was
  // already holding (owner-reported 2026-08-21). This lands it on the file and moves the
  // file to Funded. Read-only INTO our columns, exactly like the sold signal above:
  // nothing is ever written to Encompass. It reads the SCRUBBED loan — what
  // `encompass_extra` now holds — through `closing.readEncompassFundedDate`, the same
  // reader the closing desk's reconciliation gate compares against, so the two can never
  // disagree about what Encompass says. It never reconciles the file (that additionally
  // needs ClickUp to match) and it can never break a pull.
  try {
    await require('../lib/encompass-funded').syncFundedDate(db, appId, scrubbed);
  } catch (_) { /* never break a pull over a reference field */ }

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
  if (!killSwitch.encompassEnabled()) throw new Error(killSwitch.OFF_REASON);
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
    const guid = _rowGuid(hit);
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
  if (!killSwitch.encompassEnabled()) throw new Error(killSwitch.OFF_REASON);
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
        const guid = _rowGuid(hit);
        const loanNumber = _rowField(hit, 'Loan.LoanNumber') || hit.loanNumber || null;
        const folder = _rowField(hit, 'Loan.LoanFolder');
        const borrowerLast = _rowField(hit, 'Loan.BorrowerLastName');
        const loanAmount = Number(_rowField(hit, 'Loan.LoanAmount')) || null;
        const lastMod = _rowField(hit, 'Loan.LastModified');
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
  // The catalog spec list, exported so its key functions can be run against real
  // measured payloads rather than eyeballed.
  CATALOG_KINDS,
  pullLoanForApplication,
  superDump,
  bulkPullAllLoans,
  scrubFieldValuesSsn,
  // exported for unit tests
  _scrubForStorage,
  PIPELINE_SEARCH_FIELDS,
  // Pipeline-row readers. Exported so anything else reading a pipelineSearch
  // result uses THESE — a live response on 2026-07-26 came back without a
  // `Loan.Guid`, which is why _rowGuid accepts six spellings. A private,
  // narrower copy elsewhere would silently drop every row.
  _rowGuid,
  _rowField,
  // Stale-GUID self-heal internals — exported so a unit test can pin the
  // definitive-not-found classifier (only 404/410 may clear a cached guid).
  _isLoanNotFound,
  _searchGuid,
};
