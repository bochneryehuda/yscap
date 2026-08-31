'use strict';
/**
 * LONG-TERM TERM SHEETS — the database bridge (db/649).
 *
 * The ONE writer of `lt_term_sheet`, `lt_term_sheet_cart` and
 * `lt_term_sheet_scenario`. Every rule about what a term sheet IS lives in
 * `snapshot.js`; this only decides how it is stored, found again and replayed.
 *
 * ⛔ A SHEET IS WRITE-ONCE. Nothing here updates a stored snapshot, its hash,
 * its code or its comp plan, and there is no UPDATE against `lt_term_sheet` in
 * this file at all. That is the whole point of a term sheet ID: an officer pulls
 * up TS-4KH92B and sees what the borrower was actually sent, not what today's
 * rate sheet would say. A correction is a NEW sheet that names the one it
 * replaces (`supersedes`), so the record keeps both.
 *
 * ⛔ SEPARATION. Only `lt_*` tables are named here, plus the two authorised
 * identity foreign keys (`staff_users`, `borrowers`) that db/649 declares —
 * both `ON DELETE SET NULL`, so losing a person never loses a sheet.
 */

const code = require('./code');
// db/651 — the STAFF-ONLY note about who is behind each price. It is stored on
// the member row, never on the snapshot: see `internal.js`.
const internalRecord = require('./internal');

const lazy = { get db() { return require('../db'); } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));

/** Postgres' own name for "you broke a unique index". */
const UNIQUE_VIOLATION = '23505';

/** How many times a mint may collide before we stop and say so. */
const MINT_TRIES = 8;

/**
 * Mint a code and INSERT under it, retrying on a collision.
 *
 * ⛔ THE UNIQUE INDEX IS THE AUTHORITY, NOT A PRE-CHECK. "Does this code exist?"
 * followed by "insert it" is two statements with a gap, and two officers issuing
 * at the same instant both read "free" and one of them overwrites — the
 * read-then-write race db/401 documents on the conditions engine. So the code is
 * minted, the INSERT is attempted, and a 23505 on
 * `lt_term_sheet_code_uk` means somebody else took it: mint another and try
 * again. With 32^6 codes a second collision is already a curiosity; eight is a
 * bound, not an expectation, and running out RAISES rather than returning a
 * sheet with no code.
 */
async function insertWithFreshCode(client, row) {
  let lastErr = null;
  for (let i = 0; i < MINT_TRIES; i += 1) {
    const c = code.mintCode();
    try {
      const { rows } = await client.query(
        `INSERT INTO lt_term_sheet
           (id, code, borrower_id, borrower_name, created_by_staff, created_by, mode,
            waive_lender_fees, kind, comp_plan, snapshot, snapshot_hash, supersedes,
            priced_at, expires_at)
         VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8,
                 $9::jsonb, $10::jsonb, $11, $12::uuid, $13::timestamptz, $14::timestamptz)
         RETURNING id, code, created_at, expires_at, priced_at`,
        [c, row.borrowerId, row.borrowerName, row.staffId, row.createdBy, row.mode,
          row.waiveLenderFees, row.kind, JSON.stringify(row.compPlan || {}),
          JSON.stringify(row.snapshot || {}), row.snapshotHash, row.supersedes,
          row.pricedAt, row.expiresAt],
      );
      return rows[0];
    } catch (e) {
      // ONLY a code collision is retried. A foreign-key failure, a CHECK
      // violation (a mode of 'raw' reaching the table) or a dropped connection
      // are real and must surface — retrying them would spin eight times and
      // then report the wrong reason.
      const isCodeClash = e && e.code === UNIQUE_VIOLATION
        && String(e.constraint || '').includes('code');
      if (!isCodeClash) throw e;
      lastErr = e;
    }
  }
  const err = new Error('Could not mint a free term sheet code.');
  err.cause = lastErr;
  throw err;
}

/**
 * Issue a term sheet from a built snapshot. Returns `{code, id, expiresAt}`.
 *
 * ONE TRANSACTION: the sheet and every member land together or not at all. A
 * sheet whose members are missing is a document that renders as an empty
 * comparison, and it would be indistinguishable from one that was issued that
 * way.
 */
async function issueSheet({
  snapshot, snapshotHash, compPlan, staffId, borrowerId, borrowerName,
  createdBy = 'officer', supersedes = null, expiryDays = 2, expiresAt: expiresAtIn = null, cartId = null,
  internal = [],
}) {
  if (!snapshot || !Array.isArray(snapshot.members) || !snapshot.members.length) {
    throw new Error('A term sheet needs at least one option.');
  }
  const members = snapshot.members;
  const first = members[0];
  const priced = members
    .map((m) => (m.pricedAt ? Date.parse(m.pricedAt) : NaN))
    .filter((n) => Number.isFinite(n));
  const pricedAt = priced.length ? new Date(Math.min(...priced)).toISOString() : new Date().toISOString();
  // ⛔ THE COLUMN AND THE DOCUMENT MUST SAY ONE THING. The sheet PRINTS its own
  // expiry, so when the caller has already worked one out — a term sheet runs on
  // a 24-hour clock, a comparison on the longer company window — it is passed in
  // and stored verbatim rather than recomputed here a few milliseconds later
  // against a different rule. The day count remains the fallback for a caller
  // that has no opinion.
  const days = Number.isFinite(Number(expiryDays)) && Number(expiryDays) > 0 ? Number(expiryDays) : 2;
  const passed = expiresAtIn ? new Date(expiresAtIn) : null;
  const expiresAt = passed && !Number.isNaN(passed.getTime())
    ? passed.toISOString()
    : new Date(Date.now() + days * 86400000).toISOString();

  const client = await lazy.db.getClient();
  try {
    await client.query('BEGIN');
    const sheet = await insertWithFreshCode(client, {
      borrowerId: isUuid(borrowerId) ? borrowerId : null,
      borrowerName: borrowerName || (snapshot.prepared && snapshot.prepared.borrowerName) || null,
      staffId: isUuid(staffId) ? staffId : null,
      createdBy: createdBy === 'borrower' ? 'borrower' : 'officer',
      // The SHEET's mode is the FIRST option's — a descriptive summary for a
      // list, never the authority. Each member carries its own, because the
      // owner's three-offers case puts borrower-paid and lender-paid side by
      // side on ONE sheet.
      mode: first.mode,
      waiveLenderFees: !!first.waiveLenderFees,
      kind: snapshot.kind === 'comparison' ? 'comparison' : 'single',
      compPlan: compPlan || {},
      snapshot,
      snapshotHash: snapshotHash || hashOf(snapshot),
      supersedes: isUuid(supersedes) ? supersedes : null,
      pricedAt,
      expiresAt,
    });

    for (let i = 0; i < members.length; i += 1) {
      const m = members[i];
      /* db/651 — the vendor's own identity for THIS option, positionally aligned
         with the member because `buildSnapshot` builds the two lists in one pass.
         Projected again here rather than trusted: `issueSheet` is a public
         function and a caller that assembled its own list must not be able to
         widen what is recorded. An absent entry stores `{}`, which is exactly
         what every sheet issued before this column says. */
      const prov = internalRecord.projectInternal(Array.isArray(internal) ? internal[i] : null);
      await client.query(
        `INSERT INTO lt_term_sheet_scenario
           (id, cart_id, parent_kind, position, label, mode, waive_lender_fees,
            scenario, program, charges, closing, internal, priced_at)
         VALUES (gen_random_uuid(), $1::uuid, 'sheet', $2, $3, $4, $5,
                 $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::timestamptz)`,
        [sheet.id, i, m.label, m.mode, !!m.waiveLenderFees,
          JSON.stringify(m.scenario || {}),
          JSON.stringify({
            consumerLabel: m.consumerLabel, product: m.product,
            ratePct: m.ratePct, monthlyPI: m.monthlyPI, prepayLabel: m.prepayLabel,
          }),
          JSON.stringify(m.charges || {}), JSON.stringify(m.closing || {}),
          JSON.stringify(prov),
          m.pricedAt || pricedAt],
      );
    }

    // The cart the sheet was issued FROM is emptied in the same breath: its
    // members now live on the sheet, and leaving them would offer the officer a
    // comparison they have already sent.
    if (isUuid(cartId)) {
      await client.query('DELETE FROM lt_term_sheet_scenario WHERE cart_id = $1::uuid AND parent_kind = \'cart\'', [cartId]);
      await client.query('DELETE FROM lt_term_sheet_cart WHERE id = $1::uuid', [cartId]);
    }

    await client.query('COMMIT');
    return { id: sheet.id, code: sheet.code, expiresAt: sheet.expires_at, pricedAt: sheet.priced_at };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is going back to the pool either way */ }
    throw e;
  } finally {
    client.release();
  }
}

function hashOf(snapshot) {
  return require('./snapshot').hashSnapshot(snapshot);
}

/**
 * Look a sheet up by the code an officer typed.
 *
 * The typed form is FORGIVING (`normalizeCode` folds the letters a person
 * confuses and strips the prefix and any spaces); the stored form is not. The
 * lookup is `upper(code)`, matching db/649's unique index exactly, so it can use
 * it — a `lower()` or an `ILIKE` here would silently sequential-scan.
 */
async function findByCode(raw, dbc = null) {
  const c = code.normalizeCode(raw);
  if (!c) return null;
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `SELECT id, code, borrower_id, borrower_name, created_by_staff, created_by, mode,
            waive_lender_fees, kind, comp_plan, snapshot, snapshot_hash, supersedes,
            priced_at, expires_at, created_at
       FROM lt_term_sheet
      WHERE upper(code) = upper($1)`,
    [c],
  );
  return rows[0] || null;
}

/**
 * ⛔ IS THE STORED SNAPSHOT STILL THE ONE WE HASHED?
 *
 * A replay's whole value is that it shows what was SENT. The snapshot is jsonb,
 * so Postgres stores it by its own rules and hands it back with keys in its own
 * order — which is exactly why `hashSnapshot` canonicalises first. Re-hashing on
 * the way out and comparing is what turns "we believe this is the document" into
 * "this is the document", and a mismatch is REPORTED rather than hidden: the
 * sheet still replays (the officer needs to see something), flagged as altered.
 */
function verifyIntegrity(row) {
  if (!row || !row.snapshot) return { ok: false, reason: 'no_snapshot' };
  let hash = null;
  try { hash = hashOf(row.snapshot); } catch { return { ok: false, reason: 'unhashable' }; }
  if (!row.snapshot_hash) return { ok: false, reason: 'no_stored_hash', hash };
  return hash === row.snapshot_hash
    ? { ok: true, hash }
    : { ok: false, reason: 'hash_mismatch', hash, stored: row.snapshot_hash };
}

/** The sheets this officer issued, newest first. A list, never the snapshots. */
async function listForStaff(staffId, { limit = 50, offset = 0 } = {}, dbc = null) {
  if (!isUuid(staffId)) return [];
  const q = dbc || lazy.db;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const { rows } = await q.query(
    `SELECT id, code, borrower_name, kind, mode, waive_lender_fees,
            priced_at, expires_at, created_at,
            snapshot #>> '{members,0,consumerLabel}' AS first_program,
            -- WHICH of the three documents this was. It lives in the snapshot
            -- rather than in a column because the kind column is CHECK-constrained
            -- to the RENDERING shape (one option or several) and a scenario
            -- comparison and a comparison are both "several" — the finer question
            -- is the document's own, frozen with it. A sheet issued before the
            -- three documents existed answers NULL, and the screen falls back to
            -- the shape, which is what it has always shown.
            -- (No backticks in here: this is inside a JS template literal.)
            snapshot ->> 'docKind' AS doc_kind,
            jsonb_array_length(COALESCE(snapshot -> 'members', '[]'::jsonb)) AS option_count
       FROM lt_term_sheet
      WHERE created_by_staff = $1::uuid
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [staffId, lim, off],
  );
  return rows;
}

// ── the comparison cart ─────────────────────────────────────────────────────
// One open cart per officer (db/649's unique index on staff_id is the contract),
// so "start a comparison" on a second search adds to the SAME cart rather than
// opening a rival one — the owner's *"you go back into another search"*.

async function openCart(staffId, dbc = null) {
  if (!isUuid(staffId)) return null;
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `INSERT INTO lt_term_sheet_cart (id, staff_id)
          VALUES (gen_random_uuid(), $1::uuid)
     ON CONFLICT (staff_id) DO UPDATE SET updated_at = now()
       RETURNING id, staff_id, anchor_position, created_at, updated_at`,
    [staffId],
  );
  return rows[0] || null;
}

async function readCart(staffId, dbc = null) {
  if (!isUuid(staffId)) return { cart: null, members: [] };
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    'SELECT id, staff_id, anchor_position, created_at, updated_at FROM lt_term_sheet_cart WHERE staff_id = $1::uuid',
    [staffId],
  );
  const cart = rows[0] || null;
  if (!cart) return { cart: null, members: [] };
  const { rows: members } = await q.query(
    `SELECT id, position, label, mode, waive_lender_fees, scenario, program, charges, closing,
            internal, priced_at
       FROM lt_term_sheet_scenario
      WHERE cart_id = $1::uuid AND parent_kind = 'cart'
      ORDER BY position`,
    [cart.id],
  );
  return { cart, members };
}

/**
 * Put one priced quote in the cart.
 *
 * ⛔ THE POSITION IS TAKEN INSIDE THE INSERT, NOT READ FIRST. `SELECT max(pos)`
 * then `INSERT` is the same read-then-write race as the code mint, and here it
 * hits the `(cart_id, position)` unique index — two quick clicks would make the
 * second one fail with a constraint error a person cannot act on. `COALESCE(max
 * ... ) + 1` inside the statement is atomic under the row locks the index
 * already takes.
 */
async function addToCart({ staffId, member, max = 8 }) {
  if (!isUuid(staffId)) return { ok: false, reason: 'no_staff' };
  if (!member || typeof member !== 'object') return { ok: false, reason: 'no_member' };
  const cart = await openCart(staffId);
  if (!cart) return { ok: false, reason: 'no_cart' };

  const { rows: countRows } = await lazy.db.query(
    'SELECT count(*)::int AS n FROM lt_term_sheet_scenario WHERE cart_id = $1::uuid AND parent_kind = \'cart\'',
    [cart.id],
  );
  const cap = Math.min(Math.max(parseInt(max, 10) || 8, 2), 8);
  if (countRows[0].n >= cap) {
    return {
      ok: false,
      reason: 'full',
      message: `A comparison holds at most ${cap} options — past that it stops being a comparison and becomes a catalogue.`,
    };
  }

  const { rows } = await lazy.db.query(
    `INSERT INTO lt_term_sheet_scenario
       (id, cart_id, parent_kind, position, label, mode, waive_lender_fees,
        scenario, program, charges, closing, internal, priced_at)
     SELECT gen_random_uuid(), $1::uuid, 'cart',
            COALESCE(max(position), -1) + 1, $2, $3, $4,
            $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz
       FROM lt_term_sheet_scenario WHERE cart_id = $1::uuid AND parent_kind = 'cart'
     RETURNING id, position`,
    [cart.id, member.label, member.mode, !!member.waiveLenderFees,
      JSON.stringify(member.scenario || {}),
      JSON.stringify(member.program || {}),
      JSON.stringify(member.charges || {}),
      JSON.stringify(member.closing || {}),
      // db/651 — the cart is where a comparison is assembled, so the provenance
      // has to survive the round trip: an option parked here and issued an hour
      // later must record the same investor as one issued straight off the board.
      JSON.stringify(internalRecord.projectInternal(member.internal)),
      member.pricedAt || new Date().toISOString()],
  );
  await lazy.db.query('UPDATE lt_term_sheet_cart SET updated_at = now() WHERE id = $1::uuid', [cart.id]);
  return { ok: true, id: rows[0].id, position: rows[0].position, cartId: cart.id };
}

/** Take one option out. The WHERE is the whole authorisation — a cart is the
 *  officer's own, so a member of somebody else's cart is simply not found. */
async function removeFromCart(staffId, memberId) {
  if (!isUuid(staffId) || !isUuid(memberId)) return { ok: false };
  const { rowCount } = await lazy.db.query(
    `DELETE FROM lt_term_sheet_scenario s
      USING lt_term_sheet_cart c
      WHERE s.id = $1::uuid AND s.parent_kind = 'cart'
        AND s.cart_id = c.id AND c.staff_id = $2::uuid`,
    [memberId, staffId],
  );
  return { ok: rowCount > 0 };
}

/** Which option everything else is compared against. */
async function setAnchor(staffId, position) {
  if (!isUuid(staffId)) return { ok: false };
  const p = parseInt(position, 10);
  if (!Number.isFinite(p) || p < 0) return { ok: false };
  const { rowCount } = await lazy.db.query(
    `UPDATE lt_term_sheet_cart SET anchor_position = $2, updated_at = now()
      WHERE staff_id = $1::uuid
        AND EXISTS (SELECT 1 FROM lt_term_sheet_scenario s
                     WHERE s.cart_id = lt_term_sheet_cart.id AND s.parent_kind = 'cart'
                       AND s.position = $2)`,
    [staffId, p],
  );
  return { ok: rowCount > 0 };
}

/** Empty it. Deleting the cart CASCADEs its members (db/649). */
async function clearCart(staffId) {
  if (!isUuid(staffId)) return { ok: false };
  const { rowCount } = await lazy.db.query('DELETE FROM lt_term_sheet_cart WHERE staff_id = $1::uuid', [staffId]);
  return { ok: rowCount > 0 };
}

/**
 * The STAFF-ONLY provenance behind one issued sheet, in the members' own order.
 *
 * ⛔ ITS OWN QUERY, NEVER FOLDED INTO `findByCode`. That row is what the PDF and
 * the replay are built from, and the one guarantee worth keeping here is that
 * the object those two are handed cannot carry an investor's name. Fetching it
 * separately is one round trip and it makes the separation structural: a
 * projection mistake in the replay route cannot leak what the replay route never
 * loaded.
 *
 * Returns [] on a sheet issued before db/651 in the sense that every entry is
 * `{}` — `internal.isEmpty` is how a screen tells that apart from a real record.
 */
async function readInternal(sheetId, dbc = null) {
  if (!isUuid(sheetId)) return [];
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `SELECT position, internal
       FROM lt_term_sheet_scenario
      WHERE cart_id = $1::uuid AND parent_kind = 'sheet'
      ORDER BY position`,
    [sheetId],
  );
  return rows.map((r) => ({ position: r.position, internal: r.internal || {} }));
}

module.exports = {
  issueSheet, findByCode, verifyIntegrity, listForStaff, readInternal,
  openCart, readCart, addToCart, removeFromCart, setAnchor, clearCart,
  _internals: { insertWithFreshCode, isUuid, MINT_TRIES, UNIQUE_VIOLATION },
};
