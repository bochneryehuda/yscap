'use strict';
/**
 * LONG-TERM — THE LANDLORD IS REMEMBERED AGAINST THE HOME, NOT AGAINST THE PERSON.
 *
 * Owner-directed 2026-08-31: *"We need to make the landlord contact information
 * also be saved directly to the borrower's profile for next time to pre-fill. As
 * long as he is still living at the same primary address — if his primary address
 * has been updated in Encompass, then you should not automatically populate his
 * landlord, because probably the landlord changed. Add this logic."*
 *
 * ── WHAT ALREADY EXISTED, AND WHAT DID NOT ──────────────────────────────────
 *
 * The CARD already lands on the borrower's profile: the create-a-contact door
 * writes `service_contacts.borrower_id`, which is what makes it "mine" in the
 * type-ahead on their next file. What did not exist is the only thing that makes
 * a landlord safe to fill in by itself — WHICH HOME they are the landlord of. A
 * person who moves keeps the profile and gets a new landlord, so a memory keyed
 * on the person alone would post a verification of rent to the last landlord
 * about an address they have never heard of.
 *
 * So the memory is keyed on **(borrower, the address they were renting)**, and a
 * moved borrower simply produces a different key and matches nothing. The owner's
 * rule is then a property of the key rather than a check somebody has to
 * remember to write: there is no "has the address changed?" test anywhere,
 * because a changed address cannot match.
 *
 * ── THE KEY REFUSES RATHER THAN GUESSES ─────────────────────────────────────
 *
 * The expensive direction is not a missed pre-fill — somebody picks the landlord
 * by hand, which is what they do today. It is filling in the WRONG landlord,
 * which sends a stranger a form asking about somebody's tenancy and comes back as
 * evidence on a loan. So an address missing its street or its state has NO key at
 * all, and an address that gains or loses a part later produces a DIFFERENT key
 * and stops matching — refusing where it cannot be certain, in both directions.
 *
 * THE RULES ABOVE THE FOLD ARE PURE — `addressKey` and `addressText` take no
 * database and no client, so the whole of what makes this safe is unit-testable
 * with nothing running. The readers below them are the thin half: they lazily
 * require the long-term pool, and every one of them is best-effort — a landlord
 * that fails to be remembered, or to be filled in, may never break the screen or
 * the order that triggered it.
 *
 * SEPARATION: reads and writes `lt_*` only, plus the SHARED `service_contacts`
 * directory and `borrowers` identity rows the long-term tables already point at.
 */

/** Street words that mean the same thing written long or short. Written out
 *  rather than stemmed: a stemmer collapses "ST" (street) and "ST" (saint), and
 *  the pair of them is a different road. */
const SUFFIX = Object.freeze({
  STREET: 'ST', ST: 'ST',
  AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
  ROAD: 'RD', RD: 'RD',
  DRIVE: 'DR', DR: 'DR',
  LANE: 'LN', LN: 'LN',
  COURT: 'CT', CT: 'CT',
  PLACE: 'PL', PL: 'PL',
  BOULEVARD: 'BLVD', BLVD: 'BLVD', BLV: 'BLVD',
  TERRACE: 'TER', TER: 'TER', TERR: 'TER',
  PARKWAY: 'PKWY', PKWY: 'PKWY',
  CIRCLE: 'CIR', CIR: 'CIR',
  HIGHWAY: 'HWY', HWY: 'HWY',
  TURNPIKE: 'TPKE', TPKE: 'TPKE',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  APARTMENT: 'U', APT: 'U', UNIT: 'U', SUITE: 'U', STE: 'U', 'FL': 'U', FLOOR: 'U',
});

const squash = (v) => String(v == null ? '' : v)
  .toUpperCase()
  // A HASH IS A WORD, NOT PUNCTUATION. "#4B" and "Unit 4B" are the same door, and
  // stripping the hash as punctuation leaves "4B" — which normalizes to something
  // "Unit 4B" never matches, so the same home would be remembered as two. It is
  // turned into the same token the unit words become, before the strip below.
  .replace(/#/g, ' U ')
  .replace(/[^A-Z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** One word, in whichever spelling this file settled on. */
const word = (w) => (Object.prototype.hasOwnProperty.call(SUFFIX, w) ? SUFFIX[w] : w);

const norm = (v) => squash(v).split(' ').filter(Boolean).map(word).join(' ');

/** A five-digit ZIP. A ZIP+4 is the same place, so the +4 is dropped rather than
 *  allowed to make one home look like two. */
function zip5(v) {
  const m = squash(v).replace(/ /g, '').match(/^(\d{5})/);
  return m ? m[1] : '';
}

/**
 * The comparison key for one home, or NULL when there is not enough of an
 * address to be sure about.
 *
 * Takes the parts as `lt_residences` holds them (snake_case) or as a screen
 * hands them over (camelCase), so no caller has to reshape a row first.
 */
function addressKey(row) {
  if (!row || typeof row !== 'object') return null;
  const street = norm(row.street != null ? row.street : row.line1);
  const state = norm(row.state);
  const city = norm(row.city);
  const zip = zip5(row.zip != null ? row.zip : row.postalCode);
  // A street and a state are the minimum; without one of them two different
  // homes can share a key, which is the one outcome that must not happen.
  if (!street || !state) return null;
  // …and something that says WHICH town. A street name repeats across a state.
  if (!city && !zip) return null;
  return [street, city, state, zip].join('|');
}

/** Plain words for a screen, so it can say WHICH home the landlord is remembered
 *  against rather than showing a key nobody can read. */
function addressText(row) {
  if (!row || typeof row !== 'object') return null;
  const street = String(row.street || row.line1 || '').trim();
  const city = String(row.city || '').trim();
  const state = String(row.state || '').trim();
  const zip = String(row.zip || row.postalCode || '').trim();
  const tail = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const line = [street, tail].filter(Boolean).join(', ');
  return line || null;
}

/* ── The readers ───────────────────────────────────────────────────────────── */

const lazyDb = () => require('./db');

/**
 * Run a write behind a SAVEPOINT when the caller handed us one of their own
 * connections, so a refusal here cannot poison the transaction they are in.
 *
 * WITHOUT THIS the never-throws promise is only half true: the module swallows
 * its own error and answers politely, while every later statement on the
 * caller's transaction fails with "current transaction is aborted" — the caller
 * loses work over a landlord that could not be remembered. On the pool, where a
 * statement is its own transaction, SAVEPOINT is refused and we simply run
 * without one.
 */
async function guarded(client, fn) {
  let held = false;
  try { await client.query('SAVEPOINT lt_landlord_memory'); held = true; } catch (_) { /* not in a transaction */ }
  try {
    const out = await fn();
    if (held) await client.query('RELEASE SAVEPOINT lt_landlord_memory');
    return out;
  } catch (e) {
    if (held) { try { await client.query('ROLLBACK TO SAVEPOINT lt_landlord_memory'); } catch (_) { /* gone with the transaction */ } }
    throw e;
  }
}

/**
 * Every borrower on this loan who RENTS, with the home they rent and the key it
 * is remembered under.
 *
 * Gated on `residency_basis = 'rent'` deliberately: a landlord recorded against a
 * home the borrower OWNS is not a landlord, and remembering one would fill a
 * stranger onto their next file.
 */
async function rentingParties(loanId, client) {
  const { rows } = await client.query(
    `SELECT pa.borrower_id, r.street, r.city, r.state, r.zip
       FROM lt_parties pa
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
       JOIN lt_residences r ON r.party_id = pa.id AND r.residency_type = 'current'
      WHERE bp.loan_id = $1::uuid
        AND pa.borrower_id IS NOT NULL
        AND r.residency_basis = 'rent'`,
    [loanId]);
  const out = [];
  for (const r of rows) {
    const key = addressKey(r);
    if (!key) continue;              // not enough address to be sure — never remembered
    out.push({ borrowerId: String(r.borrower_id), key, text: addressText(r) });
  }
  return out;
}

/** The card an order on this loan would be addressed to, or null. */
async function primaryLandlordId(loanId, client) {
  const { rows } = await client.query(
    `SELECT service_contact_id FROM lt_loan_vendors
      WHERE loan_id = $1::uuid AND kind = 'landlord'
      ORDER BY is_primary DESC, created_at DESC
      LIMIT 1`, [loanId]);
  return rows.length ? String(rows[0].service_contact_id) : null;
}

/**
 * REMEMBER the landlord this loan carries, against the home each renting
 * borrower on it rents. Best-effort; never throws.
 *
 * A LATER ANSWER REPLACES AN EARLIER ONE at the same address — a building that
 * changes managing agent has a new landlord at the same address, and the newest
 * record is the right one.
 */
async function rememberForLoan(loanId, opts) {
  const client = (opts && opts.db) || lazyDb();
  try {
    return await guarded(client, async () => {
    const contactId = await primaryLandlordId(loanId, client);
    if (!contactId) return { remembered: 0 };
    const parties = await rentingParties(loanId, client);
    let n = 0;
    for (const p of parties) {
      await client.query(
        `INSERT INTO lt_borrower_landlords
           (borrower_id, address_key, service_contact_id, address_text, last_loan_id)
         VALUES ($1::uuid,$2,$3::uuid,$4,$5::uuid)
         ON CONFLICT (borrower_id, address_key) DO UPDATE
            SET service_contact_id = EXCLUDED.service_contact_id,
                address_text       = EXCLUDED.address_text,
                last_loan_id       = EXCLUDED.last_loan_id,
                updated_at         = now()`,
        [p.borrowerId, p.key, contactId, p.text, loanId]);
      n += 1;
    }
    return { remembered: n };
    });
  } catch (e) {
    console.error('[lt-landlord] could not remember the landlord:', (e && e.message) || e);
    return { remembered: 0, error: true };
  }
}

/**
 * The landlord we already hold for THIS loan's borrowers at THIS loan's current
 * homes, or null with the reason.
 *
 * TWO DIFFERENT REMEMBERED LANDLORDS IS A REFUSAL, never a pick. On a file whose
 * two borrowers rent separately from different landlords there is no single right
 * answer, and choosing one would put the wrong company on the order.
 */
async function suggestForLoan(loanId, opts) {
  const client = (opts && opts.db) || lazyDb();
  try {
    const parties = await rentingParties(loanId, client);
    if (!parties.length) return { contactId: null, why: 'no_address' };
    const { rows } = await client.query(
      `SELECT l.borrower_id, l.address_key, l.service_contact_id, l.address_text,
              sc.company_name, sc.contact_name
         FROM lt_borrower_landlords l
         JOIN service_contacts sc ON sc.id = l.service_contact_id
        WHERE (l.borrower_id, l.address_key) IN (
                SELECT * FROM unnest($1::uuid[], $2::text[]))`,
      [parties.map((p) => p.borrowerId), parties.map((p) => p.key)]);
    if (!rows.length) return { contactId: null, why: 'nothing_remembered' };
    const distinct = [...new Set(rows.map((r) => String(r.service_contact_id)))];
    if (distinct.length > 1) return { contactId: null, why: 'more_than_one' };
    const r = rows[0];
    return {
      contactId: String(r.service_contact_id),
      why: 'remembered',
      addressText: r.address_text || null,
      name: String(r.contact_name || r.company_name || '').trim() || null,
    };
  } catch (e) {
    console.error('[lt-landlord] could not look up a remembered landlord:', (e && e.message) || e);
    return { contactId: null, why: 'unreadable' };
  }
}

/**
 * FILL IT IN — the owner's "pre-fill" — and only ever fill.
 *
 * A loan that already carries a landlord is left completely alone: whoever put
 * that card there decided, and a memory must never overrule a person. So this is
 * safe to call on every read of the screen; on all but the first it does nothing.
 */
async function applyForLoan(loanId, opts) {
  const client = (opts && opts.db) || lazyDb();
  try {
    return await guarded(client, async () => {
    if (await primaryLandlordId(loanId, client)) return { applied: false, why: 'already_on_file' };
    const s = await suggestForLoan(loanId, { db: client });
    if (!s.contactId) return { applied: false, why: s.why };
    await client.query(
      `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary)
       VALUES ($1::uuid,'landlord',$2::uuid,true)
       ON CONFLICT (loan_id, kind, service_contact_id) DO NOTHING`,
      [loanId, s.contactId]);
    return { applied: true, why: 'remembered', contactId: s.contactId, addressText: s.addressText, name: s.name };
    });
  } catch (e) {
    console.error('[lt-landlord] could not fill in the remembered landlord:', (e && e.message) || e);
    return { applied: false, why: 'unreadable' };
  }
}

/**
 * PREVIOUS AND FUTURE. Every long-term loan that already carries a landlord is
 * remembered once, so a borrower's second file picks up the landlord from their
 * first without anybody re-typing it.
 *
 * Bounded and self-draining: a loan is skipped once its every renting borrower is
 * already recorded, so the pass empties itself and a repeat boot is cheap. Never
 * throws — a boot task may not stop the server coming up.
 */
async function backfillOnce(opts) {
  const client = (opts && opts.db) || lazyDb();
  const limit = Math.max(1, Number((opts && opts.limit) || 300));
  try {
    const { rows } = await client.query(
      `SELECT DISTINCT v.loan_id
         FROM lt_loan_vendors v
        WHERE v.kind = 'landlord' AND v.remembered_at IS NULL
        LIMIT $1`, [limit]);
    let n = 0;
    for (const r of rows) {
      const out = await rememberForLoan(String(r.loan_id), { db: client });
      // STAMPED ON AN ANSWER, NOT ON A SUCCESS. "This loan has no renting
      // borrower" is an answer and drains; a failed READ is not, and is retried
      // on the next boot rather than being quietly declared done.
      if (!out.error) {
        await client.query(
          `UPDATE lt_loan_vendors SET remembered_at = now()
            WHERE loan_id = $1::uuid AND kind = 'landlord' AND remembered_at IS NULL`,
          [String(r.loan_id)]);
      }
      n += out.remembered || 0;
    }
    if (rows.length) console.log(`[lt-landlord] remembered the landlord on ${rows.length} earlier loan(s) (${n} home(s))`);
    return { loans: rows.length, remembered: n };
  } catch (e) {
    console.error('[lt-landlord] backfill failed:', (e && e.message) || e);
    return { loans: 0, remembered: 0, error: true };
  }
}

module.exports = {
  addressKey, addressText,
  rememberForLoan, suggestForLoan, applyForLoan, backfillOnce,
  _internals: { norm, zip5, squash, SUFFIX, rentingParties, primaryLandlordId },
};

