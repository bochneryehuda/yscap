/**
 * RE-KEY THE WAREHOUSE WHEN THE IDENTITY RULE CHANGES.
 *
 * `properties.address_key` IS a property's identity — `upsertProperty` matches on
 * it, so the moment `propertyKey()` starts computing a different string for the
 * same house, the next report about that house stops matching the row we already
 * hold and MINTS A DUPLICATE. A fix to the identity rule is therefore strictly
 * worse than the bug it fixes until every existing row has been re-keyed.
 *
 * That is what this does, and it is JavaScript rather than SQL for the reason
 * this codebase has been bitten by before: a PL/pgSQL twin of `propertyKey`
 * would drift from the live one (the `pilot_term_norm` / `pilot_property_type_norm`
 * class), and then the sweep and the ingest would disagree about what a property
 * IS — which is the one disagreement the warehouse cannot survive.
 *
 * ─── THE THREE OUTCOMES, AND WHY THE THIRD IS A MERGE ────────────────────────
 *
 *   unchanged   the rule did not move this row. Most rows.
 *   free        the new key is not taken → UPDATE it in place.
 *   taken       another row already holds the new key. That is not a conflict —
 *               it is the WHOLE POINT: the two rows are one property that the old
 *               rule split (a `15 Ave` and a `15th Ave`, a `St James` and a
 *               `Saint James`). They are merged through the existing
 *               `property-merge`, which moves every observation, sale, photo and
 *               valuation and records what it did.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It never SPLITS a row. Where the old rule wrongly merged two different
 * properties into one (a street literally named "Building"/"Room" whose name was
 * eaten as a unit), un-picking it needs each observation's own
 * `address_as_stated` and a decision about which sales and photos belong to
 * which — that is a separate, human-reviewable job, and doing it silently here
 * would be exactly the kind of unattended destruction the merge module refuses.
 * Those rows are COUNTED and reported so the work is visible.
 *
 * Bounded per boot, resumable, and it never throws: a re-key that fails leaves
 * the row exactly as it was for the next pass.
 */
const K = require('./property-key');
const MERGE = require('./property-merge');

/**
 * THE RE-KEY, for one stored row.
 *
 * PURE — no database — so the decision can be unit-tested against the real
 * `propertyKey` without a corpus. Returns `{ key, from, reason }` where `key` is
 * null when the row cannot be keyed at all (which must never delete anything;
 * the caller leaves such a row alone).
 *
 * A row whose `street` is a BARE HOUSE NUMBER while it carries a `unit` is the
 * signature of the old street-name-eaten-as-unit bug: "5 Building Rd" was stored
 * as street "5" + unit "Building Rd". Its stored parts are damaged, so the parts
 * are re-derived from `display_address`, which kept the whole line.
 */
function rekeyOf(row) {
  const parts = { street: row.street, unit: row.unit, city: row.city, state: row.state, zip: row.zip };
  const damaged = isBareHouseNumber(row.street) && String(row.unit || '').trim() !== '';
  if (damaged && String(row.display_address || '').trim()) {
    const fromLine = K.propertyKey({ address: row.display_address, city: row.city, state: row.state, zip: row.zip });
    if (fromLine) return { key: fromLine, from: 'display_address', reason: 'the stored street was only a house number — the street name had been read as a unit' };
  }
  return { key: K.propertyKey(parts), from: 'parts', reason: null };
}
const isBareHouseNumber = (t) => /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(String(t || '').trim());

/**
 * Sweep a bounded batch. Ordered by `updated_at` so a run that is interrupted
 * resumes near where it stopped, and stamped by `key_version` so it drains.
 */
async function rekeyOnce(db, { limit = 500, version = K.KEY_VERSION } = {}) {
  const out = { scanned: 0, unchanged: 0, rekeyed: 0, merged: 0, unkeyable: 0, wouldSplit: 0, errors: [] };
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, address_key, display_address, street, unit, city, state, zip, key_version,
              observation_count, first_observed_on
         FROM properties
        WHERE key_version IS NULL OR key_version < $2
        ORDER BY observation_count DESC, id
        LIMIT $1`, [Math.min(Math.max(1, limit), 5000), version])).rows;
  } catch (e) {
    out.errors.push(`could not list properties: ${e && e.message}`);
    return out;
  }

  for (const r of rows) {
    out.scanned++;
    let decided;
    try { decided = rekeyOf(r); } catch (e) { decided = { key: null }; }
    const next = decided && decided.key;

    // NOT KEYABLE UNDER THE NEW RULE. Leave the row completely alone — its key is
    // still what every observation on it points through — but stamp it so the
    // sweep drains, and count it so the number is visible rather than silent.
    if (!next) {
      out.unkeyable++;
      if (isBareHouseNumber(r.street) && String(r.unit || '').trim() !== '') out.wouldSplit++;
      await stamp(db, r.id, version, out);
      continue;
    }
    if (next === r.address_key) {
      out.unchanged++;
      // A row still carrying the damaged shape (street = a bare house number, the
      // street NAME sitting in `unit`) whose `display_address` could not rescue it.
      // It may be TWO properties wrongly merged into one, and un-picking that needs
      // each observation's own `address_as_stated` plus a human decision about
      // which sales and photos belong to which — so it is COUNTED and reported,
      // never taken apart unattended.
      if (isBareHouseNumber(r.street) && String(r.unit || '').trim() !== '') out.wouldSplit++;
      await stamp(db, r.id, version, out);
      continue;
    }

    try {
      const holder = (await db.query(
        `SELECT id, observation_count, first_observed_on FROM properties
          WHERE address_key = $1 AND id <> $2`, [next, r.id])).rows[0];
      if (!holder) {
        await db.query(`UPDATE properties SET address_key = $2, key_version = $3, updated_at = now() WHERE id = $1`,
          [r.id, next, version]);
        out.rekeyed++;
        continue;
      }
      // TWO ROWS, ONE PROPERTY — what the old rule split. THE RICHER HISTORY
      // SURVIVES, matching `suggestSurvivor`'s own preference: nothing is lost
      // either way (the merge moves every observation, sale, photo and valuation),
      // but the survivor's id is what every bookmark, valuation and link points at,
      // and its display address is the one people will read. Keeping the thinner
      // row would move the larger history under an address somebody saw once.
      const mine = r.observation_count || 0, theirs = holder.observation_count || 0;
      const keepMine = mine !== theirs ? mine > theirs
        // A genuine tie goes to the one we have known LONGEST, so a re-key never
        // reshuffles which row is canonical on a second pass.
        : String(r.first_observed_on || '9999') <= String(holder.first_observed_on || '9999');
      const keep = keepMine ? r.id : holder.id;
      const drop = keepMine ? holder.id : r.id;
      await MERGE.mergeProperties(db, keep, drop, { cause: 'rekey' });
      // The survivor must carry the NEW key and be stamped, or the next pass sees
      // it again and tries to merge a row that no longer exists.
      await db.query(`UPDATE properties SET address_key = $2, key_version = $3, updated_at = now() WHERE id = $1`,
        [keep, next, version]);
      out.merged++;
    } catch (e) {
      if (out.errors.length < 20) out.errors.push(`${r.id}: ${e && e.message}`);
    }
  }
  return out;
}

async function stamp(db, id, version, out) {
  try {
    await db.query(`UPDATE properties SET key_version = $2 WHERE id = $1`, [id, version]);
  } catch (e) {
    if (out.errors.length < 20) out.errors.push(`${id}: could not stamp: ${e && e.message}`);
  }
}

/** How much is left, so the boot log can say so rather than guess. */
async function rekeyStatus(db, version = K.KEY_VERSION) {
  try {
    const r = (await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE key_version IS NULL OR key_version < $1)::int AS remaining
         FROM properties`, [version])).rows[0];
    return { total: r.total, remaining: r.remaining, version };
  } catch (_) { return { total: null, remaining: null, version }; }
}

module.exports = { rekeyOnce, rekeyStatus, rekeyOf };
