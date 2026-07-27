'use strict';
/**
 * MERGING TWO DUPLICATE BORROWER PROFILES (owner-directed 2026-07-26).
 *
 * The sync deliberately OVER-SPLITS — an email it cannot corroborate creates a
 * distinct profile rather than risk attaching one person's loans and PII to
 * another — so real duplicates happen, and until now nothing could put them back
 * together. This is that tool.
 *
 * The rules the owner set:
 *   • the two become ONE profile;
 *   • where the two DISAGREE on a single-valued field, a human picks which value
 *     survives — nothing is auto-chosen;
 *   • emails and phones are NOT a conflict: they ADD UP, so the person ends up
 *     with all of their numbers and addresses;
 *   • track records ADD UP; entities (LLCs) ADD UP;
 *   • the result is one complete, heavy-duty profile holding the correct records.
 *
 * SAFETY, because this is the most destructive action in the app — it re-points
 * every loan file, document, condition and message from one person to another and
 * then removes a profile:
 *   • it runs in ONE transaction; any failure rolls the whole thing back;
 *   • the losing profile is SNAPSHOTTED into `borrower_merges` first (row +
 *     contacts + entities + officers), so nothing is unrecoverable;
 *   • the foreign keys it re-points are DISCOVERED from the live schema, not a
 *     hand-written list — a table added next year is carried automatically
 *     instead of silently orphaning its rows;
 *   • a table with a uniqueness rule (contacts, entities, officer links, the
 *     self-referential pair tables) gets a dedupe-aware move, never a blind
 *     UPDATE that would throw and abort the merge.
 */
const db = require('../db');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── The fields a human may have to choose between ──────────────────────────
// Single-valued identity/CRM columns on `borrowers`. Everything multi-valued
// (emails, phones, entities, track records) is UNIONED and never appears here.
const MERGE_FIELDS = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'email', label: 'Primary email' },
  { key: 'cell_phone', label: 'Primary phone' },
  { key: 'date_of_birth', label: 'Date of birth' },
  { key: 'ssn_last4', label: 'Social Security number', masked: true },
  { key: 'fico', label: 'FICO' },
  { key: 'citizenship', label: 'Citizenship' },
  { key: 'marital_status', label: 'Marital status' },
  { key: 'dependents_count', label: 'Dependents' },
  { key: 'contact_type', label: 'Contact type' },
  { key: 'current_address', label: 'Home address', json: true },
  { key: 'mailing_address', label: 'Mailing address', json: true },
  { key: 'housing_status', label: 'Owns or rents' },
  { key: 'housing_payment', label: 'Housing payment' },
  { key: 'years_at_residence', label: 'Years at address' },
  { key: 'employment_type', label: 'Employment' },
  { key: 'employer', label: 'Employer' },
  { key: 'primary_officer_id', label: 'Primary officer' },
  { key: 'tier', label: 'Tier' },
];
// The SSN is chosen as a pair: picking the last-4 moves the encrypted value and
// the match hash with it, or the survivor would show one number and match another.
const SSN_COLUMNS = ['ssn_encrypted', 'ssn_last4', 'ssn_hash'];

const norm = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
};
const same = (a, b) => norm(a) === norm(b);
const blank = (v) => v == null || norm(v) === '' || norm(v) === '{}';

/**
 * Tables that need special handling when a borrower id moves. Everything NOT
 * listed here is a plain `UPDATE ... SET col = survivor WHERE col = merged`.
 *   dedupe   — a uniqueness rule exists: move what doesn't collide, drop the rest.
 *   pair     — self-referential (borrower ↔ borrower): move, then delete self-pairs.
 *   skip     — handled explicitly in the merge body.
 */
const SPECIAL = {
  'borrower_auth.borrower_id': 'skip',              // one login per person
  'borrower_contacts.borrower_id': 'dedupe',        // UNIQUE (borrower, kind, value)
  'borrower_officers.borrower_id': 'dedupe',        // PK (borrower, staff)
  'llcs.borrower_id': 'dedupe',                     // UNIQUE (borrower, normalized name)
  'track_records.borrower_id': 'dedupe',            // UNIQUE-ish on address key
  'borrower_profile_links.borrower_id': 'pair',
  'borrower_profile_links.linked_borrower_id': 'pair',
  'borrower_dedup_candidates.borrower_id': 'pair',
  'borrower_dedup_candidates.matched_borrower_id': 'pair',
  'borrower_link_candidates.borrower_id': 'pair',
  'borrower_link_candidates.candidate_borrower_id': 'pair',
  'partners.owner_borrower_id': 'pair',
  'partners.partner_borrower_id': 'pair',
};

/** Every column in the database that points at `borrowers.id`, read LIVE. */
async function borrowerRefs(client) {
  const r = await client.query(
    `SELECT tc.table_name AS t, kcu.column_name AS c
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'borrowers'
        AND tc.table_schema = 'public'
      ORDER BY 1, 2`);
  // `borrowers` itself can appear via a self-FK — never re-point the row we delete.
  return r.rows.filter((x) => x.t !== 'borrowers' && x.t !== 'borrower_merges');
}

// ── Duplicate candidates ────────────────────────────────────────────────────
/**
 * Who might be the same person as this borrower? Strongest signal first. Every
 * candidate carries WHY, so the staffer is never asked to trust a bare score.
 */
async function findDuplicates(borrowerId) {
  const me = (await db.query(
    `SELECT id, first_name, last_name, email, cell_phone, date_of_birth, ssn_hash FROM borrowers WHERE id=$1`,
    [borrowerId])).rows[0];
  if (!me) throw httpError(404, 'not found');
  const phone = me.cell_phone ? String(me.cell_phone).replace(/\D/g, '').slice(-10) : null;
  const r = await db.query(
    `SELECT b.id, b.first_name, b.last_name, b.email, b.cell_phone, b.date_of_birth,
            b.ssn_last4, b.shares_email, b.created_at,
            (b.ssn_hash IS NOT NULL AND b.ssn_hash = $2) AS ssn_match,
            (lower(btrim(b.email)) = lower(btrim($3))) AS email_match,
            ($4::text IS NOT NULL AND right(regexp_replace(coalesce(b.cell_phone,''), '\\D', '', 'g'), 10) = $4) AS phone_match,
            (b.date_of_birth IS NOT NULL AND b.date_of_birth = $5::date) AS dob_match,
            (lower(btrim(coalesce(b.last_name,''))) = lower(btrim($6)) AND btrim(coalesce($6,'')) <> '') AS lastname_match,
            (SELECT count(*)::int FROM applications a WHERE a.borrower_id=b.id AND a.deleted_at IS NULL) AS files,
            EXISTS (SELECT 1 FROM borrower_profile_links pl
                     WHERE pl.borrower_id=$1 AND pl.linked_borrower_id=b.id) AS allowed_share
       FROM borrowers b
      WHERE b.id <> $1
        AND ((b.ssn_hash IS NOT NULL AND b.ssn_hash = $2)
             OR lower(btrim(b.email)) = lower(btrim($3))
             OR ($4::text IS NOT NULL AND right(regexp_replace(coalesce(b.cell_phone,''), '\\D', '', 'g'), 10) = $4)
             OR (lower(btrim(coalesce(b.last_name,''))) = lower(btrim($6)) AND btrim(coalesce($6,'')) <> ''
                 AND b.date_of_birth IS NOT NULL AND b.date_of_birth = $5::date))
      ORDER BY b.created_at
      LIMIT 25`,
    [borrowerId, me.ssn_hash, me.email || '', phone, me.date_of_birth, me.last_name || '']);

  return r.rows.map((c) => {
    const why = [];
    if (c.ssn_match) why.push('same Social Security number');
    if (c.email_match) why.push('same email address');
    if (c.phone_match) why.push('same phone number');
    if (c.dob_match && c.lastname_match) why.push('same last name and date of birth');
    // An SSN is one person — that is proof. Anything else is a strong hint only.
    const confidence = c.ssn_match ? 'certain' : (why.length > 1 ? 'likely' : 'possible');
    return {
      id: c.id, first_name: c.first_name, last_name: c.last_name, email: c.email,
      cell_phone: c.cell_phone, date_of_birth: c.date_of_birth, ssn_last4: c.ssn_last4,
      files: c.files, confidence, why,
      // A pair a human already said "these really are two people sharing a
      // mailbox" about is shown LAST and flagged — never presented as a duplicate.
      allowedShare: !!c.allowed_share,
    };
  }).sort((a, b) => (a.allowedShare - b.allowedShare)
    || (['certain', 'likely', 'possible'].indexOf(a.confidence) - ['certain', 'likely', 'possible'].indexOf(b.confidence)));
}

// ── Side-by-side comparison ─────────────────────────────────────────────────
/** What the two profiles hold, field by field, plus everything that will ADD UP. */
async function compare(aId, bId) {
  const r = await db.query(
    `SELECT b.*, (b.ssn_encrypted IS NOT NULL) AS has_ssn, o.full_name AS officer_name
       FROM borrowers b LEFT JOIN staff_users o ON o.id=b.primary_officer_id
      WHERE b.id = ANY($1::uuid[])`, [[aId, bId]]);
  const A = r.rows.find((x) => String(x.id) === String(aId));
  const B = r.rows.find((x) => String(x.id) === String(bId));
  if (!A || !B) throw httpError(404, 'one of those profiles no longer exists');

  const fields = MERGE_FIELDS.map((f) => {
    const a = f.key === 'primary_officer_id' ? A.officer_name : A[f.key];
    const b = f.key === 'primary_officer_id' ? B.officer_name : B[f.key];
    const av = f.key === 'ssn_last4' ? (A.ssn_last4 ? `•••-••-${A.ssn_last4}` : null) : a;
    const bv = f.key === 'ssn_last4' ? (B.ssn_last4 ? `•••-••-${B.ssn_last4}` : null) : b;
    return {
      key: f.key, label: f.label,
      survivor: av == null ? null : (f.json ? av : String(av)),
      merged: bv == null ? null : (f.json ? bv : String(bv)),
      // A CONFLICT is only when BOTH sides have a real value and they differ.
      // One side blank is not a decision — the real value simply wins.
      conflict: !blank(a) && !blank(b) && !same(a, b),
      onlyMerged: blank(a) && !blank(b),
    };
  });

  const counts = async (id) => {
    const q = async (sql) => Number((await db.query(sql, [id])).rows[0].n);
    return {
      files: await q(`SELECT count(*)::int n FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL`),
      llcs: await q(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1`),
      trackRecords: await q(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`),
      documents: await q(`SELECT count(*)::int n FROM documents WHERE borrower_id=$1`),
      contacts: await q(`SELECT count(*)::int n FROM borrower_contacts WHERE borrower_id=$1`),
      hasLogin: !!(await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [id])).rows[0],
    };
  };
  return {
    survivor: { id: A.id, name: `${A.first_name || ''} ${A.last_name || ''}`.trim(), ...(await counts(aId)) },
    merged: { id: B.id, name: `${B.first_name || ''} ${B.last_name || ''}`.trim(), ...(await counts(bId)) },
    fields,
    conflicts: fields.filter((f) => f.conflict).length,
  };
}

// ── The merge ───────────────────────────────────────────────────────────────
/**
 * Absorb `mergedId` into `survivorId`. `choices` = {field: 'survivor'|'merged'}
 * for every CONFLICTING field; a field only one side has is taken automatically.
 * One transaction — any failure leaves both profiles exactly as they were.
 */
async function mergeBorrowers({ survivorId, mergedId, choices = {}, actorId = null }) {
  if (!survivorId || !mergedId) throw httpError(400, 'two profiles are required');
  if (String(survivorId) === String(mergedId)) throw httpError(400, 'that is the same profile');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Lock both rows in a stable order so two staffers merging the same pair at
    // once can't interleave.
    const ids = [survivorId, mergedId].sort();
    const rows = (await client.query(`SELECT * FROM borrowers WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids])).rows;
    const S = rows.find((x) => String(x.id) === String(survivorId));
    const M = rows.find((x) => String(x.id) === String(mergedId));
    if (!S || !M) throw httpError(404, 'one of those profiles no longer exists');

    // 1) SNAPSHOT the losing profile before anything moves.
    const snapshot = {
      borrower: { ...M, ssn_encrypted: M.ssn_encrypted ? '(encrypted, moved or discarded by the merge)' : null },
      contacts: (await client.query(`SELECT kind, value, source, is_primary FROM borrower_contacts WHERE borrower_id=$1`, [mergedId])).rows,
      llcs: (await client.query(`SELECT id, llc_name, ein FROM llcs WHERE borrower_id=$1`, [mergedId])).rows,
      officers: (await client.query(`SELECT staff_id, source, deals FROM borrower_officers WHERE borrower_id=$1`, [mergedId])).rows,
      // Track records are the only deduped table whose dropped rows are a real
      // business record (a property the person actually owned), so they are kept
      // verbatim too — a wrongly-collapsed address can be typed back from here.
      trackRecords: (await client.query(
        `SELECT id, property_address, address_key, deal_type, purchase_price, purchase_date, sale_date, source_task_id
           FROM track_records WHERE borrower_id=$1`, [mergedId])).rows,
    };

    // 2) Apply the chosen field values to the survivor. A field only the LOSER
    //    has is always taken (that is pure gain, never a decision); a genuine
    //    conflict is applied only when the human picked the merged side.
    const sets = [], vals = [survivorId];
    const applied = {};
    for (const f of MERGE_FIELDS) {
      const a = S[f.key], b = M[f.key];
      const conflict = !blank(a) && !blank(b) && !same(a, b);
      const takeMerged = blank(a) ? !blank(b) : (conflict && choices[f.key] === 'merged');
      if (!takeMerged) { if (conflict) applied[f.key] = 'survivor'; continue; }
      applied[f.key] = blank(a) ? 'merged (survivor was empty)' : 'merged';
      if (f.key === 'ssn_last4') {
        // Move the whole SSN triple together, or the profile would DISPLAY one
        // number while MATCHING another.
        for (const c of SSN_COLUMNS) { vals.push(M[c]); sets.push(`${c}=$${vals.length}`); }
        continue;
      }
      vals.push(f.json && b != null ? JSON.stringify(b) : b);
      sets.push(`${f.key}=$${vals.length}${f.json ? '::jsonb' : ''}`);
    }
    // The loser's SSN must never linger on a deleted row's hash and block a
    // future entry; if the survivor keeps its own, clear the loser's first.
    if (applied.ssn_last4 === undefined || String(applied.ssn_last4).startsWith('survivor')) {
      await client.query(`UPDATE borrowers SET ssn_hash=NULL WHERE id=$1`, [mergedId]);
    } else {
      await client.query(`UPDATE borrowers SET ssn_encrypted=NULL, ssn_last4=NULL, ssn_hash=NULL WHERE id=$1`, [mergedId]);
    }
    if (sets.length) {
      sets.push('updated_at=now()');
      await client.query(`UPDATE borrowers SET ${sets.join(', ')} WHERE id=$1`, vals);
    }

    // 3) Emails and phones ADD UP — both primaries and every accumulated contact
    //    land on the survivor, so no way of reaching the person is ever lost.
    for (const [kind, value] of [['email', M.email], ['phone', M.cell_phone], ['email', S.email], ['phone', S.cell_phone]]) {
      if (!value || /@clickup\.local$/i.test(String(value))) continue;
      await client.query(
        `INSERT INTO borrower_contacts (borrower_id, kind, value, source)
         VALUES ($1,$2,$3,'merge') ON CONFLICT (borrower_id, kind, value) DO NOTHING`,
        [survivorId, kind, kind === 'email' ? String(value).toLowerCase() : String(value)]);
    }

    // 4) Re-point EVERY foreign key, discovered from the live schema.
    const moved = {};
    const bump = (k, n) => { if (n) moved[k] = (moved[k] || 0) + n; };
    for (const { t, c } of await borrowerRefs(client)) {
      const kind = SPECIAL[`${t}.${c}`];
      if (kind === 'skip') continue;
      if (kind === 'dedupe') {
        // Move everything that does NOT collide with something the survivor
        // already has; only a true duplicate is dropped (the survivor's own copy
        // wins). The match predicate is written out per table on purpose — an
        // earlier "clever" builder produced an unqualified `lower(btrim(llc_name))`
        // inside the subquery, which bound to the INNER row and compared it to
        // itself, so EVERY row looked like a duplicate and a real entity was
        // DELETED instead of moved. Never rebuild this generically.
        // NOTE the `d.<col> IS NOT NULL` guards: an `IS NOT DISTINCT FROM` here
        // would make NULL match NULL, so every un-keyed track record on the loser
        // would look like a duplicate of every un-keyed one on the survivor and be
        // DELETED. Unknown never equals unknown — those rows always move.
        const MATCH = {
          borrower_contacts: 'd2.kind = d.kind AND d2.value = d.value',
          borrower_officers: 'd2.staff_id = d.staff_id',
          llcs: "d.llc_name IS NOT NULL AND btrim(d.llc_name) <> '' AND lower(btrim(d2.llc_name)) = lower(btrim(d.llc_name))",
          track_records: 'd.address_key IS NOT NULL AND d2.address_key = d.address_key',
        };
        const match = MATCH[t];
        if (!match) throw httpError(500, `no dedupe rule for ${t} — refusing to merge rather than risk losing rows`);
        const r1 = await client.query(
          `UPDATE ${t} d SET ${c}=$1 WHERE d.${c}=$2
             AND NOT EXISTS (SELECT 1 FROM ${t} d2 WHERE d2.${c}=$1 AND ${match})`,
          [survivorId, mergedId]);
        bump(t, r1.rowCount);
        // Whatever is LEFT pointing at the loser collided by definition — the
        // survivor already holds an equivalent row.
        const r1b = await client.query(`DELETE FROM ${t} WHERE ${c}=$1`, [mergedId]);
        if (r1b.rowCount) moved[`${t}_duplicates_dropped`] = r1b.rowCount;
        continue;
      }
      const r2 = await client.query(`UPDATE ${t} SET ${c}=$1 WHERE ${c}=$2`, [survivorId, mergedId]);
      bump(t, r2.rowCount);
    }
    // Self-referential pair tables: a row now pointing at the survivor on BOTH
    // sides is meaningless — drop it.
    for (const [t, a, b] of [
      ['borrower_profile_links', 'borrower_id', 'linked_borrower_id'],
      ['borrower_dedup_candidates', 'borrower_id', 'matched_borrower_id'],
      ['borrower_link_candidates', 'borrower_id', 'candidate_borrower_id'],
      ['partners', 'owner_borrower_id', 'partner_borrower_id'],
    ]) { await client.query(`DELETE FROM ${t} WHERE ${a}=${'$1'} AND ${b}=$1`, [survivorId]).catch(() => {}); }
    // A file cannot have the same person as borrower AND co-borrower.
    await client.query(
      `UPDATE applications SET co_borrower_id=NULL, updated_at=now() WHERE borrower_id=$1 AND co_borrower_id=$1`,
      [survivorId]);
    // The login: the survivor keeps its own; otherwise the loser's moves across
    // (a person must not lose the ability to sign in because of a merge).
    const hasOwn = (await client.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [survivorId])).rows[0];
    if (hasOwn) await client.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [mergedId]);
    else {
      const r3 = await client.query(`UPDATE borrower_auth SET borrower_id=$1 WHERE borrower_id=$2`, [survivorId, mergedId]);
      bump('borrower_auth', r3.rowCount);
    }

    // 5) Record the merge, then remove the absorbed profile.
    await client.query(
      `INSERT INTO borrower_merges (survivor_id, merged_id, merged_name, merged_email, merged_snapshot, field_choices, moved, merged_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
      [survivorId, mergedId, `${M.first_name || ''} ${M.last_name || ''}`.trim() || null, M.email || null,
        JSON.stringify(snapshot), JSON.stringify(applied), JSON.stringify(moved), actorId]);
    await client.query(`DELETE FROM borrowers WHERE id=$1`, [mergedId]);

    await client.query('COMMIT');
    return { ok: true, survivorId, mergedId, moved, choices: applied };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

module.exports = { findDuplicates, compare, mergeBorrowers, MERGE_FIELDS, _internals: { borrowerRefs, SPECIAL, blank, same } };
