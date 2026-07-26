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

// The simple key ClickUp's ingest.addrKey uses (kept for reference/compat).
function addrKey(a) {
  const s = a && (a.formatted_address || a.oneLine);
  return s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

// A STRONGER canonical key for cross-source dedupe: the Encompass one-line and an
// already-stored ClickUp/portal `formatted_address` spell the same property
// differently ("12 Churchill Lane…" vs a geocoded "12 Churchill Ln…, USA"), so a
// bare alnum strip would MISS the existing row and re-add a property the borrower
// already has. This expands street-type + directional abbreviations and drops the
// trailing country / ZIP+4 so both spellings collapse to one key — WITHOUT a
// Google key. (address-canon.samePlace adds place_id matching on top when a key
// is configured.)
const STREET_TYPES = {
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', blvd: 'boulevard', rd: 'road', ln: 'lane',
  dr: 'drive', ct: 'court', pl: 'place', ter: 'terrace', terr: 'terrace', pkwy: 'parkway', hwy: 'highway',
  cir: 'circle', sq: 'square', trl: 'trail', pt: 'point', hts: 'heights', xing: 'crossing',
};
const DIRS = { n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' };
function addrString(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.formatted_address || a.oneLine
    || [a.street || a.line1, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
function normAddr(a) {
  const raw = addrString(a);
  if (!raw) return null;
  let t = String(raw).toLowerCase();
  t = t.replace(/,?\s*(u\.?s\.?a\.?|united states)\s*$/i, ' '); // drop trailing country
  t = t.replace(/\b(\d{5})-\d{4}\b/g, '$1');                    // ZIP+4 → 5-digit
  t = t.replace(/[.,#]/g, ' ');                                 // punctuation → space
  const words = t.split(/\s+/).filter(Boolean).map((w) => (STREET_TYPES[w] != null ? STREET_TYPES[w] : (DIRS[w] || w)));
  const key = words.join('').replace(/[^a-z0-9]/g, '');
  return key || null;
}

// The RAW party objects on a loan (borrower + co-borrower across applications[]),
// in a fixed order. `extractParties` below returns the normalized identity of the
// SAME list at the SAME indexes — anything that reads both must stay aligned, or
// one person's contact details land on another's profile.
function collectParties(raw) {
  const apps = Array.isArray(raw && raw.applications) ? raw.applications : [];
  const out = [];
  for (const a of apps) {
    for (const p of [a && a.borrower, a && a.coBorrower]) {
      if (!p || typeof p !== 'object') continue;
      if (!String(p.firstName || '').trim() && !String(p.lastName || '').trim()) continue;
      out.push(p);
    }
  }
  return out;
}

// The parties on a loan (borrower + co-borrower across applications[]).
function extractParties(raw) {
  return collectParties(raw).map((p) => {
    const first = String(p.firstName || '').trim();
    const last = String(p.lastName || '').trim();
    return { first, last, dob: normDob(p.birthDate), nameKey: normName(`${first} ${last}`) };
  });
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
  const all = vestingLlcs(raw);
  return all.length ? all[0] : null;
}

// Every entity name a loan mentions, not just the first (owner-directed
// 2026-07-26: "use field 1859 from each and every file to link EXTRA LLCs").
// A file routinely names the vesting entity in one field and the borrower's
// other entities in another, and 1859 in particular is a free-text field where
// people list SEVERAL — so it is split.
//
// The separators are deliberately conservative: semicolon, newline, pipe, and a
// SPACE-DELIMITED slash or ampersand. A plain comma is NOT a separator —
// "Smith Holdings, LLC" is one entity, and splitting on it would manufacture a
// bogus "LLC" row on a large share of real files.
function splitEntityNames(v) {
  if (v == null) return [];
  return String(v)
    .split(/\s*[;|\n\r]\s*|\s+\/\s+|\s+&\s+/)
    .map((s) => s.trim().replace(/^[,\-\s]+|[,\-\s]+$/g, ''))
    // "N/A", "none", a bare "LLC" left over from a bad split: not an entity.
    .filter((s) => s.length >= 3 && !/^(n\/?a|none|tbd|unknown|llc|inc)$/i.test(s));
}
function vestingLlcs(raw) {
  const cf = Array.isArray(raw && raw.customFields) ? raw.customFields : [];
  const by = {};
  for (const c of cf) if (c && c.fieldName) by[c.fieldName] = c.value;
  const state = (by['CX.LLCSTATE'] && String(by['CX.LLCSTATE']).trim()) || null;
  // Order matters: the FIRST name is what `vestingLlc` still returns, so the
  // dedicated vesting fields stay ahead of the free-text 1859 list.
  const sources = [by['CX.LLCNAME'], raw && raw.subjectLLCVesting, raw && raw.vestingEntityName, by['1859']];
  const out = [], seen = new Set();
  for (const s of sources) {
    for (const name of splitEntityNames(s)) {
      const k = name.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name, state });
    }
  }
  return out;
}

// ── Contact details: every phone number and email address on the file ───────
// These ADD UP on the profile (borrower_contacts) exactly like the ClickUp ones
// — a person reachable at a work line and a cell should end up with both. The
// PRIMARY email/phone on `borrowers` is never touched by enrichment.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
function cleanEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  // A synthesized placeholder is not a way to reach anyone. `@clickup.local` is
  // this system's own shadow-email pattern; the example./invalid domains are
  // reserved by RFC 2606 and can never receive mail. Sub-domains count too
  // (`@mail.example.com` is just as undeliverable as `@example.com`).
  if (!EMAIL_RE.test(s) || /@([a-z0-9-]+\.)*(clickup\.local|example\.(com|org|net)|invalid)$/i.test(s)) return null;
  return s;
}
function cleanPhone(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length !== 10) return null;                 // partial / extension-only: unusable
  if (/^(\d)\1{9}$/.test(ten)) return null;           // 0000000000, 1111111111 — filler
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}
// The contact details attached to ONE Encompass party.
function partyContacts(p) {
  const emails = [], phones = [];
  if (!p || typeof p !== 'object') return { emails, phones };
  for (const v of [p.emailAddressText, p.email, p.emailAddress, p.workEmail]) {
    const e = cleanEmail(v); if (e && !emails.includes(e)) emails.push(e);
  }
  for (const v of [p.mobilePhone, p.homePhoneNumber, p.homePhone, p.workPhone, p.workPhoneNumber, p.cellPhone]) {
    const ph = cleanPhone(v); if (ph && !phones.includes(ph)) phones.push(ph);
  }
  return { emails, phones };
}

// The borrower's OWN home address (their residence) — NOT the subject property.
// Encompass models it two ways depending on the loan's schema vintage: a
// `residences[]` list with a residency type, or flat URLA fields on the party.
// Read whichever is actually populated; "Current"/"Present" wins over a prior
// residence, and a mailing address is the last resort.
function partyAddress(p) {
  if (!p || typeof p !== 'object') return null;
  const build = (street, city, state, zip) => {
    const s = String(street || '').trim();
    if (!s) return null;                              // no street = a fragment, not an address
    const stateZip = [state, zip].filter(Boolean).join(' ');
    const oneLine = [s, city, stateZip].filter(Boolean).join(', ');
    return { street: s, city: city || null, state: state || null, zip: zip || null, oneLine, formatted_address: oneLine };
  };
  const res = Array.isArray(p.residences) ? p.residences : [];
  const current = res.find((r) => r && /current|present/i.test(String(r.residencyType || r.residenceType || '')))
    || res.find((r) => r && (r.addressStreetLine1 || r.street));
  if (current) {
    const a = build(current.addressStreetLine1 || current.street, current.addressCity || current.city,
      current.addressState || current.state, current.addressPostalCode || current.postalCode || current.zip);
    if (a) return a;
  }
  const flat = build(p.urla2020StreetAddress || p.addressStreetLine1 || p.street,
    p.urla2020City || p.addressCity || p.city, p.urla2020State || p.addressState || p.state,
    p.urla2020PostalCode || p.addressPostalCode || p.zip);
  if (flat) return flat;
  return build(p.mailingAddress, p.mailingCity, p.mailingState, p.mailingZip);
}

// When this loan was last real activity, used ONLY to decide which file is "the
// last file" when verifying a primary address. Prefers the loan's own closing /
// application dates over our mirror's `last_modified` (a re-pull would otherwise
// make an ancient loan look like the newest one).
function loanDateMs(raw, fallback) {
  const cands = [
    raw && raw.closingDocument && raw.closingDocument.closingDate,
    raw && raw.closedDate, raw && raw.fundedDate, raw && raw.disclosure2015LoanEstimateIssuedDate,
    raw && raw.applicationDate, raw && raw.lastModified, fallback,
  ];
  for (const c of cands) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

// ── DB writes (into OUR tables only — add-only-if-absent) ───────────────────

// Add the subject address to the borrower's track record IF that address is not
// already present FROM ANY SOURCE. NEVER updates an existing row. Dedupe scans the
// borrower's existing records and compares by the STRONG canonical key (so an
// Encompass "12 Churchill Lane…" matches an already-stored ClickUp "12 Churchill
// Ln…, USA"), plus address-canon.samePlace as a best-effort secondary when a
// Google key is configured. The INSERT is a single atomic `WHERE NOT EXISTS` on
// the canonical key so two Encompass passes can't both insert the same address.
async function addTrackRecordIfAbsent(dbc, borrowerId, addr) {
  const encKey = normAddr(addr);
  if (!encKey) return { added: false, reason: 'no_address' };
  const encStr = addrString(addr);

  const existing = (await dbc.query(
    `SELECT id, property_address, address_key FROM track_records WHERE borrower_id=$1`, [borrowerId])).rows;
  let canon = null;
  try { const cfg = require('../config'); if (cfg && cfg.googlePlacesKey) canon = require('../lib/address-canon'); } catch (_) { /* optional */ }
  for (const row of existing) {
    if (row.address_key && row.address_key === encKey) return { added: false, id: row.id, reason: 'already_present' };
    const exStr = addrString(row.property_address || {});
    if (exStr && normAddr(exStr) === encKey) return { added: false, id: row.id, reason: 'already_present' };
    if (canon && exStr && encStr) {
      try { if ((await canon.samePlace(encStr, exStr)) === true) return { added: false, id: row.id, reason: 'already_present' }; } catch (_) { /* best-effort */ }
    }
  }

  // Single-statement WHERE-NOT-EXISTS on the canonical key — collapses the old
  // read-then-insert into one guarded write. The enrichment worker is single-pass
  // (sequential, days apart), so this is sufficient in practice; there is no
  // unique index on (borrower_id, address_key) — adding one is unsafe on live data
  // that may already carry duplicate keys (it would fail the migration), so this
  // narrows the window rather than making truly-concurrent inserts impossible.
  const r = await dbc.query(
    `INSERT INTO track_records (borrower_id, property_address, is_verified, origin, inferred, address_key, notes)
     SELECT $1,$2::jsonb,false,'encompass',true,$3,$4
      WHERE NOT EXISTS (SELECT 1 FROM track_records WHERE borrower_id=$1 AND address_key=$3)
     RETURNING id`,
    [borrowerId, JSON.stringify(addr), encKey, 'Added from Encompass history; unverified']);
  if (!r.rows[0]) return { added: false, reason: 'already_present' };
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

// Add an email / phone to the borrower's accumulated contact list IF absent.
// NEVER promotes it to `borrowers.email` / `cell_phone` — which number a person
// is CALLED on is a human decision (and the one every email, term sheet and
// ClickUp push reads). Enrichment only makes sure nothing is lost.
async function addContactIfAbsent(dbc, borrowerId, kind, value, sourceTag) {
  const v = kind === 'email' ? cleanEmail(value) : cleanPhone(value);
  if (!v) return { added: false, reason: 'unusable' };
  // Already the primary? Then it is on the profile by definition. `borrower_contacts`
  // stores phones in whatever shape the source gave, so compare on digits.
  const b = (await dbc.query(`SELECT email, cell_phone FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
  if (b) {
    if (kind === 'email' && String(b.email || '').trim().toLowerCase() === v) return { added: false, reason: 'is_primary' };
    if (kind === 'phone' && String(b.cell_phone || '').replace(/\D/g, '').slice(-10) === v.replace(/\D/g, '').slice(-10)) {
      return { added: false, reason: 'is_primary' };
    }
  }
  const dupe = (await dbc.query(
    kind === 'email'
      ? `SELECT id FROM borrower_contacts WHERE borrower_id=$1 AND kind='email' AND lower(btrim(value))=$2 LIMIT 1`
      : `SELECT id FROM borrower_contacts WHERE borrower_id=$1 AND kind='phone'
           AND right(regexp_replace(value, '\\D', '', 'g'), 10) = right(regexp_replace($2, '\\D', '', 'g'), 10) LIMIT 1`,
    [borrowerId, v])).rows[0];
  if (dupe) return { added: false, id: dupe.id, reason: 'already_present' };
  const r = await dbc.query(
    `INSERT INTO borrower_contacts (borrower_id, kind, value, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (borrower_id, kind, value) DO NOTHING RETURNING id`,
    [borrowerId, kind, v, sourceTag || 'encompass']);
  if (!r.rows[0]) return { added: false, reason: 'already_present' };
  return { added: true, id: r.rows[0].id };
}

/**
 * Verify the borrower's PRIMARY HOME ADDRESS against the most recent Encompass
 * file (owner-directed: "verify their primary address according to the last file
 * and let me know if there's any conflict in the manual review section").
 *
 * Three outcomes, and only one of them writes:
 *   • the profile has NO home address  → FILL it (pure gain, audited);
 *   • the two agree                    → nothing, silently;
 *   • the two DISAGREE                 → NEVER overwrite. A person's address on
 *     file is real data that a stale loan must not clobber, so the disagreement
 *     goes to the manual review queue with both values, and a human picks.
 */
async function verifyPrimaryAddress(dbc, borrowerId, addr, meta) {
  // Store the MAILING one-line, never a geocoder display name (main's rule, and
  // `compactFormattedAddress` is a pass-through for anything that is already in
  // that form). Encompass gives us structured fields, so `partyAddress` already
  // builds the mailing form — this is belt-and-suspenders for a loan whose
  // address arrived as one long provider string.
  const ADDR = require('../lib/address');
  const encStr = ADDR.compactFormattedAddress(addrString(addr)) || addrString(addr);
  const encKey = normAddr(addr);
  if (!encStr || !encKey) return { checked: false, reason: 'no_address' };
  const b = (await dbc.query(`SELECT current_address FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
  if (!b) return { checked: false, reason: 'no_borrower' };
  const curStr = addrString(b.current_address || {});

  if (!curStr) {
    await dbc.query(
      `UPDATE borrowers SET current_address=$2::jsonb, updated_at=now()
        WHERE id=$1 AND (current_address IS NULL OR current_address::text IN ('null','{}'))`,
      [borrowerId, JSON.stringify(addr)]);
    // The audit line is best-effort — but a failed statement POISONS an enclosing
    // transaction in Postgres, and this can run inside one. A savepoint keeps a
    // bad audit row from taking the whole pass down with it.
    try {
      await dbc.query('SAVEPOINT enrich_audit');
      await dbc.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system','encompass_address_filled','borrower',$1,$2::jsonb)`,
        [borrowerId, JSON.stringify({ address: encStr, loan: (meta && meta.loanGuid) || null })]);
      await dbc.query('RELEASE SAVEPOINT enrich_audit');
    } catch (_) {
      await dbc.query('ROLLBACK TO SAVEPOINT enrich_audit').catch(() => {});
    }
    return { checked: true, filled: true, address: encStr };
  }
  if (normAddr(curStr) === encKey) return { checked: true, agrees: true };

  const queued = await require('../lib/sync-review').queueReview({
    // Queue on the SAME connection the pass is using — inside a transaction the
    // pool would not yet see the rows this pass created.
    dbc,
    borrowerId,
    applicationId: (meta && meta.applicationId) || null,
    // Namespaced so the queue's one-open-row-per-(task, field, proposal) rule
    // dedupes per Encompass LOAN. `source` is what tells every consumer this is
    // NOT a ClickUp task id — nothing may hand this string to the ClickUp client.
    taskId: `encompass:${(meta && meta.loanGuid) || 'unknown'}`,
    source: 'encompass',
    direction: 'inbound',
    fieldKey: 'current_address',
    currentValue: curStr,
    proposedValue: encStr,
    portalValue: curStr,
    clickupValue: encStr,
    reason: 'encompass_address_differs: the most recent Encompass file has a different home address for this borrower',
  });
  return { checked: true, conflict: true, queued: !!queued, portal: curStr, encompass: encStr };
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
 * snapshot. READ-ONLY toward Encompass, ADD-ONLY toward us.
 *
 * For every loan, EVERY party on it (borrower and co-borrower, across all
 * application pairs) is matched to one of our borrowers conservatively, and what
 * the file knows is added to that person's profile:
 *   • the subject property   → their track record (unverified, inferred)
 *   • every entity named     → their entity library (incl. the free-text 1859 list)
 *   • every email and phone  → their accumulated contact list
 * and then, ONCE per borrower and only from their MOST RECENT file, their
 * primary home address is verified — filled when we have none, left alone and
 * sent to manual review when the two disagree.
 *
 * Per-loan errors are swallowed (a bad row never stops the pass). Nothing is
 * ever written to Encompass, and no loan file is ever created.
 */
async function enrichAllOnce(opts) {
  const o = opts || {};
  const dbc = o.dbc || require('../db');
  const limit = Number.isFinite(o.limit) ? o.limit : 5000;
  const summary = {
    loans: 0, matched: 0, addressesAdded: 0, llcsAdded: 0,
    emailsAdded: 0, phonesAdded: 0,
    addressesVerified: 0, addressesFilled: 0, addressConflicts: 0,
    skippedNoMatch: 0, errors: 0,
  };
  const rows = (await dbc.query(
    `SELECT encompass_loan_guid, application_id, raw, last_modified
       FROM encompass_loan_snapshot WHERE raw IS NOT NULL
      ORDER BY pulled_at DESC NULLS LAST LIMIT $1`, [limit])).rows;

  // The primary-address check must run against THE LAST FILE, so it cannot be
  // decided inside the loop — a borrower's newest loan may be read after an older
  // one. Collect the best candidate per borrower and settle it at the end.
  const latestByBorrower = new Map();

  /* eslint-disable no-await-in-loop */
  for (const row of rows) {
    summary.loans += 1;
    try {
      const raw = row.raw && typeof row.raw === 'object' ? row.raw : null;
      if (!raw) { summary.errors += 1; continue; }
      const parties = extractParties(raw);
      if (!parties.length) { summary.skippedNoMatch += 1; continue; }

      const addr = subjectAddress(raw);
      const llcs = vestingLlcs(raw);
      const when = loanDateMs(raw, row.last_modified);
      const sourceTag = `encompass:${row.encompass_loan_guid}`;

      // Raw party objects, index-aligned with `extractParties`, so a matched
      // party's contacts and residence are read off the RIGHT person. The skip
      // predicate must be IDENTICAL to that function's — a party named only by
      // whitespace that one list drops and the other keeps shifts every index
      // after it and would attach one person's phone numbers to another.
      const rawParties = collectParties(raw);
      if (rawParties.length !== parties.length) { summary.errors += 1; continue; }

      let anyMatched = false;
      for (let i = 0; i < parties.length; i += 1) {
        // Only the PRIMARY party may be identified by the loan's application
        // link — a co-borrower on our file is a different person, and handing
        // them the application's borrower_id would attach one person's history
        // to another. Everyone else must earn a name+DOB match on their own.
        const m = await matchBorrower(dbc, parties[i], i === 0 ? row.application_id : null);
        if (!m) continue;
        anyMatched = true;

        if (addr) { const t = await addTrackRecordIfAbsent(dbc, m.borrowerId, addr); if (t.added) summary.addressesAdded += 1; }
        for (const llc of llcs) {
          const l = await addLlcIfAbsent(dbc, m.borrowerId, llc.name, llc.state);
          if (l.added) summary.llcsAdded += 1;
        }
        const { emails, phones } = partyContacts(rawParties[i]);
        for (const e of emails) { const c = await addContactIfAbsent(dbc, m.borrowerId, 'email', e, sourceTag); if (c.added) summary.emailsAdded += 1; }
        for (const p of phones) { const c = await addContactIfAbsent(dbc, m.borrowerId, 'phone', p, sourceTag); if (c.added) summary.phonesAdded += 1; }

        const home = partyAddress(rawParties[i]);
        if (home) {
          const key = String(m.borrowerId);
          const prev = latestByBorrower.get(key);
          if (!prev || when > prev.when) {
            latestByBorrower.set(key, { when, address: home, loanGuid: row.encompass_loan_guid, applicationId: row.application_id || null });
          }
        }
      }
      if (anyMatched) summary.matched += 1; else summary.skippedNoMatch += 1;
    } catch (_e) { summary.errors += 1; }
  }

  // ── The primary address, from each borrower's most recent file only ────────
  for (const [borrowerId, best] of latestByBorrower) {
    try {
      const v = await verifyPrimaryAddress(dbc, borrowerId, best.address,
        { loanGuid: best.loanGuid, applicationId: best.applicationId });
      if (v.filled) summary.addressesFilled += 1;
      else if (v.conflict) summary.addressConflicts += 1;
      else if (v.agrees) summary.addressesVerified += 1;
    } catch (_e) { summary.errors += 1; }
  }
  /* eslint-enable no-await-in-loop */
  return summary;
}

module.exports = {
  enrichAllOnce,
  addTrackRecordIfAbsent,
  addLlcIfAbsent,
  addContactIfAbsent,
  verifyPrimaryAddress,
  matchBorrower,
  _internals: {
    normName, normDob, addrKey, normAddr, addrString, extractParties, collectParties, subjectAddress,
    vestingLlc, vestingLlcs, splitEntityNames, partyContacts, partyAddress,
    cleanEmail, cleanPhone, loanDateMs,
  },
};
