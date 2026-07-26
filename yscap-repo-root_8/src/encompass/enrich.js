'use strict';
/**
 * src/encompass/enrich.js — Part 2. Build the borrower PROFILE from Encompass.
 *
 * READ-ONLY toward Encompass. This reads the loans PILOT already pulled into
 * `encompass_loan_snapshot` (the full-tenant read-only mirror) and ENRICHES our
 * borrower profiles: it adds prior-deal SUBJECT ADDRESSES to the borrower's track
 * record and adds the LLCs the borrower has vested in — STRICTLY ADDITIVE and
 * DEDUPED. It NEVER replaces or edits an existing track-record row or LLC (owner-
 * directed: "a lot are already there — don't replace them, don't add LLCs twice,
 * just add information"), and everything it adds is `is_verified=false` /
 * `inferred=true`, so it never inflates VERIFIED experience or changes pricing.
 * Nothing is ever written to Encompass.
 *
 * Matching is CONSERVATIVE (never guess a borrower): a snapshot loan attaches to
 * a borrower only when (a) that loan is already linked to one of our applications
 * (the borrower is known), or (b) it matches EXACTLY ONE of our borrowers by
 * normalized name + exact DOB. 0 or >1 matches → skipped.
 *
 * The dedupe mirrors the ClickUp profile builder (src/clickup/ingest.js
 * upsertTrackRecord/upsertLlc): track records dedupe on borrower_id + a canonical
 * address key; LLCs dedupe on borrower_id + normalized name (the uq_llcs_borrower_name
 * index). The difference is intent: Encompass enrichment is ADD-ONLY-IF-ABSENT.
 *
 * Pure helpers (extract/normalize/dedupe key) carry no DB and are unit-tested;
 * `../db` is lazy-required in the DB pass.
 */

// ── Pure extraction from a full Encompass loan JSON ─────────────────────────
function normName(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Date → 'YYYY-MM-DD' (or null). Tolerates a time component.
function normDob(v) {
  if (v == null || v === '') return null;
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// The canonical address dedupe key — the SAME shape ClickUp's ingest.addrKey uses
// (lowercased, non-alphanumerics stripped) so an Encompass address dedupes against
// a track record added by any other source.
function addrKey(a) {
  const s = a && (a.formatted_address || a.oneLine);
  return s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

// The parties on a loan (borrower + co-borrower across applications[]).
function extractParties(raw) {
  const apps = Array.isArray(raw && raw.applications) ? raw.applications : [];
  const out = [];
  for (const a of apps) {
    for (const p of [a && a.borrower, a && a.coBorrower]) {
      if (!p || typeof p !== 'object') continue;
      const first = String(p.firstName || '').trim();
      const last = String(p.lastName || '').trim();
      if (!first && !last) continue;
      out.push({ first, last, dob: normDob(p.birthDate), nameKey: normName(`${first} ${last}`) });
    }
  }
  return out;
}

// The subject property address (from the full loan's `property`).
function subjectAddress(raw) {
  const p = raw && raw.property;
  if (!p || typeof p !== 'object') return null;
  const street = p.streetAddress || p.street || null;
  const city = p.city || null;
  const state = p.state || null;
  const zip = p.postalCode || p.zip || null;
  if (!street && !city) return null;
  const stateZip = [state, zip].filter(Boolean).join(' '); // "NY 11230" (US convention)
  const oneLine = [street, city, stateZip].filter(Boolean).join(', ');
  return { street, city, state, zip, oneLine, formatted_address: oneLine };
}

// The vesting LLC (best-effort: owner-confirmed field 1859, then common custom
// fields, then the entity name when the loan is vested to an entity). Returns
// null when nothing usable is present (the address enrichment is the reliable
// part; the LLC is added only when clearly found).
function vestingLlc(raw) {
  const cf = Array.isArray(raw && raw.customFields) ? raw.customFields : [];
  const by = {};
  for (const c of cf) if (c && c.fieldName) by[c.fieldName] = c.value;
  const rawName = by['CX.LLCNAME'] || (raw && (raw.subjectLLCVesting || raw.vestingEntityName)) || by['1859'] || null;
  const name = rawName ? String(rawName).trim() : '';
  if (!name || name.length < 2) return null;
  const state = (by['CX.LLCSTATE'] && String(by['CX.LLCSTATE']).trim()) || null;
  return { name, state };
}

// ── DB writes (into OUR tables only — add-only-if-absent) ───────────────────

// Add the subject address to the borrower's track record IF that address is not
// already present (from any source). NEVER updates an existing row.
async function addTrackRecordIfAbsent(dbc, borrowerId, addr) {
  const key = addrKey(addr);
  if (!key) return { added: false, reason: 'no_address' };
  const exists = await dbc.query(
    `SELECT id FROM track_records WHERE borrower_id=$1 AND address_key=$2 LIMIT 1`, [borrowerId, key]);
  if (exists.rows[0]) return { added: false, id: exists.rows[0].id, reason: 'already_present' };
  const r = await dbc.query(
    `INSERT INTO track_records (borrower_id, property_address, is_verified, origin, inferred, address_key, notes)
     VALUES ($1,$2::jsonb,false,'encompass',true,$3,$4) RETURNING id`,
    [borrowerId, JSON.stringify(addr), key, 'Added from Encompass history; unverified']);
  return { added: true, id: r.rows[0].id };
}

// Add the LLC to the borrower's library IF not already there (deduped by name).
// NEVER updates an existing LLC.
async function addLlcIfAbsent(dbc, borrowerId, llcName, state) {
  const name = String(llcName || '').trim();
  if (!name) return { added: false, reason: 'no_name' };
  const found = await dbc.query(
    `SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`, [borrowerId, name]);
  if (found.rows[0]) return { added: false, id: found.rows[0].id, reason: 'already_present' };
  try {
    const r = await dbc.query(
      `INSERT INTO llcs (borrower_id, llc_name, formation_state, is_verified, origin)
       VALUES ($1,$2,$3,false,'encompass') RETURNING id`, [borrowerId, name, state || null]);
    return { added: true, id: r.rows[0].id };
  } catch (e) {
    if (e && e.code === '23505') { // uq_llcs_borrower_name race — re-select the winner
      const again = await dbc.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`, [borrowerId, name]);
      if (again.rows[0]) return { added: false, id: again.rows[0].id, reason: 'already_present' };
    }
    throw e;
  }
}

// Match a snapshot loan's party to exactly ONE of our borrowers. Conservative —
// never guesses. Returns { borrowerId, how } or null.
async function matchBorrower(dbc, party, snapshotAppId) {
  // (a) the loan is already linked to one of our applications → borrower is known.
  if (snapshotAppId) {
    const r = await dbc.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [snapshotAppId]);
    if (r.rows[0] && r.rows[0].borrower_id) return { borrowerId: r.rows[0].borrower_id, how: 'linked_application' };
  }
  // (b) EXACTLY ONE borrower matches by normalized name + exact DOB.
  if (party && party.dob && party.first && party.last) {
    const r = await dbc.query(
      `SELECT id FROM borrowers
        WHERE lower(btrim(first_name))=lower(btrim($1))
          AND lower(btrim(last_name))=lower(btrim($2))
          AND date_of_birth = $3`,
      [party.first, party.last, party.dob]);
    if (r.rows.length === 1) return { borrowerId: r.rows[0].id, how: 'name_dob' };
  }
  return null; // 0 or >1 → never guess
}

/**
 * enrichAllOnce({ dbc, limit }) — one enrichment pass over the Encompass loan
 * snapshot. For each loan, match the PRIMARY borrower conservatively and add the
 * subject address + vesting LLC to that borrower's profile (add-only-if-absent).
 * Per-loan errors are swallowed (a bad row never stops the pass). Returns a
 * summary. Writes only OUR tables; never touches Encompass.
 */
async function enrichAllOnce(opts) {
  const o = opts || {};
  const dbc = o.dbc || require('../db');
  const limit = Number.isFinite(o.limit) ? o.limit : 5000;
  const summary = { loans: 0, matched: 0, addressesAdded: 0, llcsAdded: 0, skippedNoMatch: 0, errors: 0 };
  const rows = (await dbc.query(
    `SELECT encompass_loan_guid, application_id, raw
       FROM encompass_loan_snapshot WHERE raw IS NOT NULL
      ORDER BY pulled_at DESC NULLS LAST LIMIT $1`, [limit])).rows;
  /* eslint-disable no-await-in-loop */
  for (const row of rows) {
    summary.loans += 1;
    try {
      const raw = row.raw && typeof row.raw === 'object' ? row.raw : null;
      if (!raw) { summary.errors += 1; continue; }
      const parties = extractParties(raw);
      const primary = parties[0];
      if (!primary) { summary.skippedNoMatch += 1; continue; }
      const m = await matchBorrower(dbc, primary, row.application_id);
      if (!m) { summary.skippedNoMatch += 1; continue; }
      summary.matched += 1;
      const addr = subjectAddress(raw);
      if (addr) { const t = await addTrackRecordIfAbsent(dbc, m.borrowerId, addr); if (t.added) summary.addressesAdded += 1; }
      const llc = vestingLlc(raw);
      if (llc) { const l = await addLlcIfAbsent(dbc, m.borrowerId, llc.name, llc.state); if (l.added) summary.llcsAdded += 1; }
    } catch (_e) { summary.errors += 1; }
  }
  /* eslint-enable no-await-in-loop */
  return summary;
}

module.exports = {
  enrichAllOnce,
  addTrackRecordIfAbsent,
  addLlcIfAbsent,
  matchBorrower,
  _internals: { normName, normDob, addrKey, extractParties, subjectAddress, vestingLlc },
};
