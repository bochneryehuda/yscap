'use strict';
/**
 * TWO ROWS, ONE HOUSE — finding and merging the duplicates the address key cannot
 * fold on its own (db/419).
 *
 * The owner's rule is that the same comparable on two appraisals must never become
 * two properties, and that merging must ADD what one report had and the other did
 * not. Almost all of that is already true and tested: `propertyKey` folds two
 * spellings of one address into ONE row, and `properties` is a ROLL-UP recomputed
 * from every report that ever described the house, so the gap-filling and the
 * conflict resolution happen by themselves.
 *
 * This is the remainder — two rows that ARE the same house but whose key differs.
 *
 * ─── WHY THIS IS SO MUCH SMALLER THAN MERGING A PERSON (db/323) ───────────────
 * A borrower row is AUTHORED, so every field the two copies disagree on is a
 * decision, and that merge REFUSES rather than guess. A property row is DERIVED.
 * Move the observations across and re-roll, and every fact resolves itself by the
 * rule that was reviewed when it shipped: the most recent report that STATED a fact
 * wins, and a report that was silent never blanks it. There is no field choice to
 * make here, and therefore none to get wrong.
 *
 * ─── THE RULES THAT ARE LOAD-BEARING ─────────────────────────────────────────
 *
 *  1. A CANDIDATE IS NEVER MERGED AUTOMATICALLY. Every pair this finds is a
 *     SUGGESTION for a human. Folding two different houses together corrupts every
 *     price-per-foot reading in the warehouse and cannot be undone by a re-ingest,
 *     which is a far worse outcome than carrying a duplicate.
 *
 *  2. AN UNDECLARED TABLE THROWS. Three of the six foreign keys into `properties`
 *     are ON DELETE CASCADE, so a table nobody declared here would have its rows
 *     SILENTLY DELETED when the losing row goes — not orphaned. The borrower merge's
 *     own principle ("refusing to merge beats losing rows") taken to its conclusion
 *     on a schema whose default failure is deletion.
 *
 *  3. EACH DEDUPE PREDICATE MIRRORS THE INDEX THAT WILL ACTUALLY FIRE — not a
 *     generic rule. `uq_property_sale` keys on `COALESCE(sale_price,-1)`, so for
 *     THAT index two NULL prices genuinely do collide, even though "unknown never
 *     equals unknown" is the right instinct elsewhere.
 *
 *  4. THE LOSING ROW IS SNAPSHOTTED BEFORE IT GOES. A merge deletes a row; the only
 *     honest way to do that is to be able to say afterwards exactly what was there.
 */
const K = require('./property-key');

const txt = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };

/**
 * EVERY WAY A ROW CAN POINT AT A PROPERTY, and what to do with it.
 *
 * `move`   — a plain UPDATE; nothing stops two rows coexisting on the survivor.
 * `dedupe` — a unique index contains `property_id`, so a row that would collide with
 *            one the survivor already has must be folded or dropped, not moved.
 *
 * VERIFIED AGAINST THE SCHEMA, NOT ASSUMED. Adding a table that references
 * `properties` without adding it here is caught by `assertRefsComplete`, which reads
 * `information_schema` — because the alternative is finding out when somebody's data
 * is already gone.
 */
const REFS = Object.freeze({
  'property_observations.property_id': { how: 'move' },
  'property_valuations.property_id': { how: 'move' },
  'research_imports.subject_property_id': { how: 'move' },
  // db/423 — the 1004MC market read a report filed while describing this property.
  // MOVE: the two rows are the same house, so the market read belongs to the
  // survivor; nothing stops several reports pointing at one property, so there is
  // no collision to fold. (`market_periods` hangs off the observation, not off
  // `properties`, so it follows automatically and is correctly absent here.)
  'market_observations.property_id': { how: 'move' },
  // THE LEDGER'S OWN SURVIVOR POINTER, which CASCADES. Merging B into A and later
  // A into C deleted A — and with it the "B → A" row, so `survivorOf(B)` went
  // from A to NULL, a link to B stopped redirecting and started reading as data
  // loss, and `merged_snapshot` — this module's own guarantee that "the only
  // honest way to delete a row is to be able to say what was there" — was
  // destroyed. Re-pointing it at the new survivor keeps the chain walkable and
  // the snapshot alive. Its `merged_id` is deliberately NOT moved: that column
  // names the row that was absorbed, which is history and never changes.
  'property_merges.survivor_id': { how: 'move' },
  'property_sales.property_id': {
    how: 'dedupe',
    // Mirrors uq_property_sale (property_id, sale_date, COALESCE(sale_price,-1)).
    match: 'w.sale_date = l.sale_date AND COALESCE(w.sale_price,-1) = COALESCE(l.sale_price,-1)',
    // A colliding sale is the SAME transaction seen by another report — fold it the
    // way `recordSale`'s own ON CONFLICT already folds a re-observed sale, rather
    // than dropping the evidence that a second appraiser confirmed it.
    fold: `UPDATE property_sales w SET
             times_seen   = w.times_seen + l.times_seen,
             first_seen_at = LEAST(w.first_seen_at, l.first_seen_at),
             last_seen_at  = GREATEST(w.last_seen_at, l.last_seen_at),
             sale_type    = COALESCE(w.sale_type, l.sale_type),
             sale_status  = COALESCE(w.sale_status, l.sale_status)
           FROM property_sales l
          WHERE w.property_id = $1 AND l.property_id = $2
            AND w.sale_date = l.sale_date
            AND COALESCE(w.sale_price,-1) = COALESCE(l.sale_price,-1)`,
  },
  'property_photos.property_id': {
    how: 'dedupe',
    // Mirrors uq_property_photo (property_id, document_id). A collision is a second
    // link to the SAME stored image — genuinely nothing to keep.
    match: 'w.document_id = l.document_id',
  },
  'property_valuation_comps.property_id': {
    how: 'dedupe',
    // Mirrors uq_pval_comp (valuation_id, COALESCE(property_id::text, id::text)).
    match: 'w.valuation_id = l.valuation_id',
    // A saved valuation is somebody's WORK and its comps are snapshots, so a
    // colliding row is detached from the property rather than deleted — the
    // valuation still reads exactly as it did the day it was built.
    onCollision: 'detach',
  },
});

/**
 * Every table that really points at `properties`, read from the database itself.
 * A reference nobody declared above is a table whose rows this merge would either
 * silently delete (CASCADE) or silently strand — so it is an error, not a warning.
 */
async function assertRefsComplete(db) {
  const rows = (await db.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = 'properties'
        AND ccu.column_name = 'id'`)).rows;
  const unknown = rows
    .map((r) => `${r.table_name}.${r.column_name}`)
    // `property_merges.survivor_id` IS declared in REFS (it CASCADEs, so a second
    // merge would delete the first merge's record along with its snapshot).
    // `merged_id` is history — the row that was absorbed — and is never moved.
    .filter((k) => !REFS[k] && k !== 'property_merges.merged_id' && !k.startsWith('property_not_duplicates.'));
  if (unknown.length) {
    throw new Error(
      `property-merge does not know what to do with ${unknown.join(', ')} — add it to REFS. `
      + 'Refusing to merge: a table with a CASCADE reference that nobody declared would have its rows deleted.');
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// FINDING CANDIDATES
// ---------------------------------------------------------------------------
/**
 * Pairs that look like the same house filed twice. ADVISORY — nothing here is ever
 * merged without a person saying so.
 *
 * Three branches, strongest evidence first. Each is a DIFFERENT reason to believe,
 * so the reason travels with the pair and the screen can say why it is being asked.
 */
async function findDuplicates(db, { propertyId = null, limit = 100 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (r, why, confidence) => {
    const a = r.a_id < r.b_id ? r.a_id : r.b_id;
    const b = r.a_id < r.b_id ? r.b_id : r.a_id;
    const k = `${a}|${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(Object.assign({}, r, { why, confidence }));
  };

  // The pair a human has already said is NOT one house, and the one already merged.
  const EXCLUDE = `
    AND NOT EXISTS (SELECT 1 FROM property_not_duplicates nd
                     WHERE nd.property_id = LEAST(a.id, b.id)
                       AND nd.other_property_id = GREATEST(a.id, b.id))`;
  const SELECT = `
    a.id AS a_id, a.display_address AS a_address, a.city AS a_city, a.zip AS a_zip,
    a.observation_count AS a_observations, a.last_observed_on AS a_last_seen,
    b.id AS b_id, b.display_address AS b_address, b.city AS b_city, b.zip AS b_zip,
    b.observation_count AS b_observations, b.last_observed_on AS b_last_seen`;
  const scope = propertyId ? 'AND (a.id = $2 OR b.id = $2)' : '';
  const params = (n) => (propertyId ? [n, propertyId] : [n]);

  // ---- A. the same street + state, one row keyed on a ZIP and the other on a town.
  // The biggest bucket by volume, and the most confident: a house whose report named
  // no town versus the same house on a report that did.
  const a = await db.query(
    `SELECT ${SELECT}, 'zip_only_locality' AS cause
       FROM properties a JOIN properties b
         ON b.id > a.id AND b.state = a.state AND b.street = a.street
        AND COALESCE(b.unit,'') = COALESCE(a.unit,'')
        AND a.zip IS NOT NULL AND a.zip = b.zip
        AND (a.address_key LIKE '%|z' || a.zip || '|%') <> (b.address_key LIKE '%|z' || b.zip || '|%')
      WHERE true ${scope} ${EXCLUDE}
      LIMIT $1`, params(limit));
  a.rows.forEach((r) => add(r, 'one report named the town and the other only gave a ZIP — same street, same ZIP', 'high'));

  // ---- B. the same street + town, one row carries a unit and the other does not.
  // Deliberately NOT auto-merged and never will be: the unit is dropped from the key
  // on purpose, because unit 2 and unit 5 of one building sell for different prices.
  // A person has to say whether the un-unitted row is that unit or the whole building.
  const b = await db.query(
    `SELECT ${SELECT}, 'unit_absent' AS cause
       FROM properties a JOIN properties b
         ON b.id > a.id AND b.state = a.state AND b.street = a.street
        AND lower(COALESCE(b.city,'')) = lower(COALESCE(a.city,''))
        AND COALESCE(a.unit,'') <> COALESCE(b.unit,'')
        AND (COALESCE(a.unit,'') = '' OR COALESCE(b.unit,'') = '')
      WHERE true ${scope} ${EXCLUDE}
      LIMIT $1`, params(limit));
  b.rows.forEach((r) => add(r, 'the same address, one with a unit number and one without', 'needs a person'));

  // ---- C. two rows placed at the same point on the map.
  // ONLY the looked-up coordinate (`geo_*`), NEVER `eff_*`: the effective column
  // falls back to the APPRAISER's coordinates, which are frequently the centre of a
  // ZIP — and every property in a ZIP would then look identical. The unit must match
  // too, because the geocoder is asked about the building, not the apartment.
  const c = await db.query(
    `SELECT ${SELECT}, 'same_point' AS cause
       FROM properties a JOIN properties b
         ON b.id > a.id
        AND a.geo_latitude IS NOT NULL AND b.geo_latitude IS NOT NULL
        AND round(a.geo_latitude, 5) = round(b.geo_latitude, 5)
        AND round(a.geo_longitude, 5) = round(b.geo_longitude, 5)
        AND COALESCE(a.unit,'') = COALESCE(b.unit,'')
      WHERE true ${scope} ${EXCLUDE}
      LIMIT $1`, params(limit));
  c.rows.forEach((r) => add(r, 'both addresses were placed at the same point on the map', 'high'));

  return out.slice(0, limit);
}

/** Record a human's "I checked — these are two different houses". */
async function markNotDuplicate(db, aId, bId, { reason = null, by = null } = {}) {
  if (!aId || !bId || aId === bId) throw new Error('two different properties are required');
  await db.query(
    `INSERT INTO property_not_duplicates (property_id, other_property_id, reason, created_by)
     VALUES (LEAST($1,$2)::uuid, GREATEST($1,$2)::uuid, $3, $4)
     ON CONFLICT DO NOTHING`,
    [aId, bId, txt(reason), by]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// THE MERGE
// ---------------------------------------------------------------------------
/**
 * Fold `loserId` into `survivorId`. ONE transaction; the losing row is snapshotted
 * before it goes; the survivor is re-rolled from the union of both sets of
 * observations, which is what actually performs the owner's "add the missing
 * information one appraisal had and the other didn't".
 *
 * @param {{query, getClient?}} db
 * @param {string} survivorId  the row that stays — by default the one more reports describe
 * @param {string} loserId
 */
async function mergeProperties(db, survivorId, loserId, { cause = 'manual', by = null } = {}) {
  if (!survivorId || !loserId) throw new Error('survivorId and loserId are required');
  if (survivorId === loserId) throw new Error('a property cannot be merged into itself');

  const run = async (client) => {
    await assertRefsComplete(client);

    // Lock both rows in a STABLE order so two merges running at once cannot deadlock
    // on each other, and so neither can read a row the other is about to delete.
    const [lo, hi] = survivorId < loserId ? [survivorId, loserId] : [loserId, survivorId];
    const locked = (await client.query(
      `SELECT * FROM properties WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`, [lo, hi])).rows;
    const survivor = locked.find((r) => r.id === survivorId);
    const loser = locked.find((r) => r.id === loserId);
    if (!survivor) throw new Error('the surviving property no longer exists');
    if (!loser) throw new Error('the property being merged no longer exists');

    // THE SNAPSHOT COMES FIRST. Everything below this line destroys information.
    const snapshot = { property: loser, observations: [], sales: [], photos: [] };
    for (const [t, col] of [['property_observations', 'property_id'], ['property_sales', 'property_id'],
      ['property_photos', 'property_id']]) {
      snapshot[t.replace('property_', '')] = (await client.query(
        `SELECT * FROM ${t} WHERE ${col} = $1`, [loserId])).rows;
    }

    const moved = {};
    for (const [key, spec] of Object.entries(REFS)) {
      const [table, col] = key.split('.');
      if (spec.how === 'dedupe') {
        if (spec.fold) await client.query(spec.fold, [survivorId, loserId]);
        const collide = `EXISTS (SELECT 1 FROM ${table} w WHERE w.${col} = $1 AND ${spec.match})`;
        if (spec.onCollision === 'detach') {
          // Somebody's saved valuation — the comp stays in it, just no longer pointed
          // at a property row that is about to disappear.
          await client.query(`UPDATE ${table} l SET ${col} = NULL WHERE l.${col} = $2 AND ${collide}`,
            [survivorId, loserId]);
        } else {
          await client.query(`DELETE FROM ${table} l WHERE l.${col} = $2 AND ${collide}`,
            [survivorId, loserId]);
        }
      }
      const r = await client.query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [survivorId, loserId]);
      if (r.rowCount) moved[key] = r.rowCount;
    }

    // THE ADDRESS BLOCK, by the rules `upsertProperty`'s own ON CONFLICT already
    // applies — the longer display address wins, and ZIP / county / APN are fill-only.
    // The key, street, unit, city and state stay the survivor's: they ARE its identity.
    // `latitude`/`longitude` are deliberately untouched — they are roll-up columns and
    // the re-roll below rewrites them from the observations.
    await client.query(
      `UPDATE properties SET
         display_address = CASE WHEN length($2) > length(display_address) THEN $2 ELSE display_address END,
         zip    = COALESCE(zip, $3),
         county = COALESCE(county, $4),
         apn    = COALESCE(apn, $5),
         geo_latitude  = COALESCE(geo_latitude,  $6),
         geo_longitude = COALESCE(geo_longitude, $7),
         geo_source    = COALESCE(geo_source,    $8),
         geo_precision = COALESCE(geo_precision, $9),
         geo_at        = COALESCE(geo_at,        $10),
         first_seen_at = LEAST(first_seen_at, $11),
         updated_at = now()
       WHERE id = $1`,
      [survivorId, loser.display_address, loser.zip, loser.county, loser.apn,
       loser.geo_latitude, loser.geo_longitude, loser.geo_source, loser.geo_precision, loser.geo_at,
       loser.first_seen_at]);

    // A merged address is a MORE complete address than either was. If neither side
    // was ever placed on the map, let the sweep try the new one.
    await client.query(
      `UPDATE properties SET geo_attempted_at = NULL, geo_attempts = 0
        WHERE id = $1 AND geo_latitude IS NULL`, [survivorId]);

    await client.query(`DELETE FROM properties WHERE id = $1`, [loserId]);

    await client.query(
      `INSERT INTO property_merges (survivor_id, merged_id, merged_key, merged_address,
                                    merged_snapshot, cause, moved, merged_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [survivorId, loserId, loser.address_key, loser.display_address,
       JSON.stringify(snapshot), txt(cause), JSON.stringify(moved), by]);

    // THIS IS THE STEP THAT MERGES THE FACTS. Everything above only moved rows; the
    // re-roll recomputes every fact on the survivor from the UNION of both reports'
    // observations, by the rule that was already reviewed — newest report that stated
    // a fact wins, and a report that was silent never blanks it.
    await require('./ingest')._internals.rollupProperty(client, survivorId);

    return { ok: true, survivorId, mergedId: loserId, moved, snapshotRows: snapshot.observations.length };
  };

  if (db && typeof db.getClient === 'function') {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const out = await run(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
      throw e;
    } finally {
      client.release();
    }
  }
  return run(db);
}

/**
 * Which of the two should stay? The one MORE reports describe — it is the row most
 * links already point at, and keeping it means fewer redirects. A tie goes to the
 * one seen more recently, then to the older row, so the answer is deterministic and
 * two people asking get the same suggestion.
 */
function suggestSurvivor(a, b) {
  const n = (x) => Number(x || 0);
  if (n(a.observation_count ?? a.a_observations) !== n(b.observation_count ?? b.b_observations)) {
    return n(a.observation_count ?? a.a_observations) > n(b.observation_count ?? b.b_observations) ? a : b;
  }
  const da = String(a.last_observed_on || ''), dbb = String(b.last_observed_on || '');
  if (da !== dbb) return da > dbb ? a : b;
  return String(a.id) < String(b.id) ? a : b;
}

/** Where did this property go? Follows a chain, so a twice-merged link still lands. */
async function survivorOf(db, propertyId, { depth = 5 } = {}) {
  let id = propertyId;
  for (let i = 0; i < depth; i++) {
    const r = (await db.query(
      `SELECT survivor_id FROM property_merges WHERE merged_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id])).rows[0];
    if (!r) return id === propertyId ? null : id;
    id = r.survivor_id;
  }
  return id;
}

module.exports = {
  findDuplicates, mergeProperties, markNotDuplicate, survivorOf, suggestSurvivor,
  _internals: { REFS, assertRefsComplete, K },
};
