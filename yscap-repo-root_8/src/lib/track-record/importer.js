'use strict';
/**
 * THE IMPORTER — search the public records, STAGE what is found, and let a
 * person bring properties onto the record one at a time.
 *
 * ═══ NOTHING FOUND EVER LANDS ON THE TRACK RECORD BY ITSELF ════════════════
 * Owner-directed, and it is the whole shape of this module: an import goes into
 * a SEPARATE TABLE (`track_record_candidates`, db/496) and a human promotes it.
 * A staged candidate is invisible to every experience count because it is in a
 * different table — not because a flag says to skip it. That is the difference
 * between a rule somebody can forget and a rule nobody can reach around.
 *
 * Promotion then hits db/485's verify guard and lands `pending`. TWO gates: a
 * person chose to add it, and it still counts toward nothing until a person
 * verifies it.
 *
 * ═══ FOUR VERBS, AND WHAT EACH ONE PROMISES ════════════════════════════════
 *   import_new     a new line at `pending`, and the entity chokepoint runs, so
 *                  the company is created on the profile and linked
 *   match_existing FILL THE BLANKS on the line already there. Never overwrites.
 *   decline        durable — the next search must not raise it again
 *   snooze         hidden until a date, then back in the queue
 *
 * ═══ `entered_by_kind` IS NOT WHERE AN IMPORTER NAMES ITSELF ═══════════════
 * The blueprint says to write `entered_by_kind='staff_import'`. That value is
 * refused by db/458's CHECK, which allows exactly
 * borrower|staff|clickup|encompass|system — and db/458's own comment says why:
 * *"The importers NAME THEMSELVES in `origin`"* (a free-text column, db/044,
 * already carrying 'clickup_backfill' and 'encompass'). So the two facts are
 * recorded where the schema already keeps them: `entered_by_kind='staff'`
 * because a staffer pressed the button, and `origin='public_records'` because
 * that is where the figures came from. Following the blueprint literally would
 * have needed a migration to widen a CHECK in order to say something the
 * schema could already say.
 *
 * ═══ A MERGE ONTO A VERIFIED LINE IS REFUSED UNLESS ASKED FOR TWICE ════════
 * Filling a blank is still a change to a material column, so db/485's guard
 * un-verifies the line — correctly, since the verification was made without
 * that figure. But a reviewer pressing "match" to tidy up a line does not
 * expect to lose a verification, so the server REFUSES and says so, and only a
 * second, explicit `confirmReopen` goes through. The guard is never weakened;
 * the surprise is removed instead.
 */

const TRK = require('../track-record-key');
const entityLib = require('../track-record-entity');
const lookups = require('../elementix/lookups');
const MATCH = require('./match');

const str = (v) => String(v == null ? '' : v).trim();
const ymd = (v) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * The columns db/485 calls MATERIAL — the ones whose change resets a
 * verification. Read from the migration's own list rather than re-derived, and
 * a test pins them together, because a column missing here would let a merge
 * silently un-verify a line without warning anybody.
 */
const MATERIAL = [
  'property_address', 'llc_id', 'owned_personally', 'entity_name', 'deal_type', 'property_type',
  'purchase_price', 'sale_price', 'rehab_amount', 'rent_amount', 'refi_amount', 'current_value',
  'purchase_date', 'sale_date', 'rent_date', 'refi_date',
];

/**
 * WHAT THE RECORDS THEMSELVES SAY THE DEAL WAS — and `null` when they do not say.
 *
 * A LINE WITH NO DEAL TYPE COUNTS TOWARD NOTHING, SILENTLY. `experience.exitDateOf`
 * sends anything that is not a flip to `COALESCE(rent_date, refi_date)`, so a
 * property that was bought and sold, imported with `deal_type = NULL`, gets a
 * NULL exit date — it is outside the 36-month window by having no date at all —
 * and `bucketOf(null)` files it under HOLDS. Measured, not assumed: exitDateOf
 * returns null and bucketOf returns 'holds' on exactly that row. So the borrower
 * (or the reviewer) does the work of confirming a deal and it credits nothing,
 * in the wrong bucket, with nothing anywhere saying so.
 *
 * A DEED PAIR IS THE ONE THING THE RECORDS DO SAY. Bought and then sold is a
 * flip — that is what the two deeds mean. Everything else is genuinely unknown:
 * a purchase with no sale might be a rental, a ground-up under way, or simply
 * still owned, and guessing there would put a figure on somebody's record that
 * nobody stated. That is the same discipline `candidatesFrom` already applies
 * when it refuses to guess a deal type at STAGING time; the difference is that
 * by IMPORT time a human is present to answer, so the honest states are
 * "derived, and stated" or "ask", never "left null".
 */
function dealTypeFromRecords(c) {
  const bought = ymd(c && c.purchase_date);
  const sold = ymd(c && c.sale_date);
  if (bought && sold) {
    return { dealType: 'flip', derived: true,
      why: 'The records show it was bought and then sold, which is a flip.' };
  }
  return { dealType: null, derived: false,
    why: sold
      ? 'The records show a sale but not a purchase, so they do not say what the plan was.'
      : 'The records show a purchase but no sale, so they do not say what the plan was.' };
}

/** Fields a candidate can carry onto a line. */
const FILLABLE = [
  'property_address', 'deal_type', 'purchase_price', 'purchase_date',
  'sale_price', 'sale_date', 'entity_name',
];

/** The property a vendor row is about. `addresses[]` is the canonical shape
 *  (see src/lib/elementix/shapes.js); the singular forms are accepted so a
 *  hand-built row still works, and a row naming nothing returns null rather
 *  than an empty string that would group with every other unreadable row. */
function firstAddress(d) {
  if (!d) return null;
  if (Array.isArray(d.addresses) && d.addresses.length) return d.addresses[0];
  if (d.addresses && !Array.isArray(d.addresses)) return d.addresses;
  return d.property_address || d.address || null;
}

function addressLabel(pa) {
  if (!pa) return '';
  if (typeof pa === 'string') return pa;
  if (typeof pa !== 'object') return '';
  if (pa.oneLine) return String(pa.oneLine);
  return [pa.line1 || pa.street || pa.address, pa.city, pa.state, pa.zip].filter(Boolean).join(', ');
}

/**
 * The re-run key. The SAME property from the SAME source is the same candidate,
 * so a second search cannot stage it twice. Built from the document id when the
 * vendor gave one (the strongest identity it has) and otherwise from the
 * address key plus the dates, which is what makes the key stable across two
 * searches that page results differently.
 */
function dedupeKeyFor(c) {
  const doc = str(c.documentId || c.document_id);
  if (doc) return `doc:${doc}`.slice(0, 200);
  const addr = TRK.trackRecordKey(c.property_address) || str(addressLabel(c.property_address)).toLowerCase();
  return `addr:${addr}|${ymd(c.purchase_date) || ''}|${ymd(c.sale_date) || ''}`.slice(0, 200);
}

/**
 * Turn the vendor's deed rows into candidate shapes.
 *
 * A property is only a candidate when a deed conveyed it TO one of the
 * borrower's entities. A deed they merely appear on is not ownership — the
 * York, PA false positive the scoring ladder's A3 exists for, applied one layer
 * earlier so it never reaches the queue at all.
 */
function candidatesFrom(research, entityNames) {
  const names = (entityNames || []).map((n) => str(n)).filter(Boolean);
  const isOurs = (partyList) => (Array.isArray(partyList) ? partyList : [partyList]).some((p) => {
    const nm = typeof p === 'string' ? p : (p && (p.name || p.partyName));
    if (!str(nm)) return false;
    return names.some((n) => { try { return entityLib.promotionMatch(nm, n); } catch (_) { return false; } });
  });

  const byKey = new Map();
  const skips = [];
  for (const d of (research.deeds || [])) {
    /* THE PROPERTY THE DEED CONVEYS. A row carries `addresses[]`, never
       `address` — and reading the missing field did not merely lose the
       address, it lost the KEY: every deed hashed to the same empty string, so
       two properties in two different towns collapsed into ONE candidate with
       no address, no price and no date. Measured against a real payload before
       this was changed.
       Only the FIRST address is taken as the subject. A multi-parcel deed is
       real but rare, and splitting one into several candidates would put
       properties on the record that nobody chose; the rest stay in `raw` for a
       reviewer. */
    const addr = firstAddress(d);
    /* The vendor computes `isGrantee`/`isGrantor` SERVER-SIDE against the entity
       that was queried, which is strictly better than re-deriving it by fuzzy
       name matching — that re-derivation is what produced the York, PA false
       positive the scoring ladder's A3 exists for. Fall back to the name test
       only when the vendor did not say; `null` must never read as `false`. */
    const bought = d.isGrantee === true || (d.isGrantee == null && isOurs(d.grantees));
    const sold = d.isGrantor === true || (d.isGrantor == null && isOurs(d.grantors));
    if (!bought && !sold) {
      skips.push({ address: addressLabel(addr), reason: 'not_our_party',
        why: 'Neither side of this deed is the borrower or one of their companies.' });
      continue;
    }
    const key = dedupeKeyFor({ documentId: d.countyDocumentId || d.documentId || d.id, property_address: addr,
      purchase_date: bought ? d.date : null, sale_date: sold ? d.date : null });
    // Two deeds on ONE property — the buy and the sell — are one candidate.
    const addrKey = TRK.trackRecordKey(addr) || addressLabel(addr).toLowerCase();
    /* AN UNREADABLE ADDRESS IS NOT A GROUPING KEY. Without this every row whose
       address could not be parsed groups with every other one — which is
       exactly the collapse above, in its general form. */
    if (!addrKey) {
      skips.push({ address: addressLabel(addr), reason: 'no_address',
        why: 'The record does not name a property address we can read, so it cannot be matched or staged.' });
      continue;
    }
    const existing = [...byKey.values()].find((c) => c._addrKey === addrKey);
    const c = existing || {
      _addrKey: addrKey, dedupe_key: key,
      property_address: addr, deal_type: null,
      purchase_price: null, purchase_date: null, sale_price: null, sale_date: null,
      entity_name: null, raw: { deeds: [] },
    };
    if (bought) {
      c.purchase_date = ymd(d.date) || c.purchase_date;
      c.purchase_price = (d.amount == null ? null : num(d.amount)) ?? c.purchase_price;
      c.entity_name = c.entity_name || firstOurName(d.grantees, names);
    }
    if (sold) {
      c.sale_date = ymd(d.date) || c.sale_date;
      c.sale_price = (d.amount == null ? null : num(d.amount)) ?? c.sale_price;
      c.entity_name = c.entity_name || firstOurName(d.grantors, names);
    }
    c.raw.deeds.push(d);
    if (!existing) byKey.set(addrKey, c);
  }

  /* A DEAL TYPE IS NEVER GUESSED. A deed says a property was bought and a deed
     says it was sold; nothing in the records says whether the plan was a flip, a
     hold or a ground-up, and writing "flip" because a sale exists would put a
     figure on the borrower's record that nobody stated. It is left NULL and the
     reviewer answers it. */
  return { candidates: [...byKey.values()], skips };
}

function firstOurName(list, names) {
  for (const p of (Array.isArray(list) ? list : [list])) {
    const nm = typeof p === 'string' ? p : (p && (p.name || p.partyName));
    if (!str(nm)) continue;
    for (const n of names) {
      try { if (entityLib.promotionMatch(nm, n)) return str(nm); } catch (_) { /* not a match */ }
    }
  }
  return null;
}

/* ── search and stage ────────────────────────────────────────────────────── */

/**
 * Search the public records for one borrower and STAGE what comes back.
 *
 * Reads only. It does not touch the loan file, create a file, open a condition
 * or email anybody — the sentence the screen shows above the button, kept true
 * here rather than only promised there.
 */
async function runSearch({ borrowerId, staffId, states }, client) {
  const db = client || require('../../db');
  const b = (await db.query(
    `SELECT id, NULLIF(TRIM(COALESCE(full_name,'')),'') AS name FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
  if (!b) { const e = new Error('borrower not found'); e.status = 404; throw e; }

  /* `formation_state`, not `state` — the state an LLC was REGISTERED in, which
     is the one the records service filters on. There is no `state` column on
     `llcs` at all, and a search sent with an undefined filter quietly returns
     nothing rather than erroring. */
  const entities = (await db.query(
    `SELECT id, llc_name, formation_state FROM llcs WHERE borrower_id=$1 AND llc_name IS NOT NULL`, [borrowerId])).rows;
  const entityNames = entities.map((e) => e.llc_name).filter(Boolean);

  const search = (await db.query(
    `INSERT INTO track_record_searches (borrower_id, run_by, query) VALUES ($1,$2::uuid,$3::jsonb) RETURNING id`,
    [borrowerId, staffId || null, JSON.stringify({ names: b.name ? [b.name] : [], entities: entityNames, states: states || [] })])).rows[0];

  let found = 0; let staged = 0; let apiCalls = 0;
  const skips = [];

  if (!entityNames.length) {
    skips.push({ reason: 'no_entities', why: 'This borrower has no companies on their profile, so there is nothing to search under.' });
  }

  for (const ent of entities) {
    const research = await lookups.researchProperty({
      entityName: ent.llc_name, state: ent.formation_state || (states && states[0]) || '',
      borrowerNames: b.name ? [b.name] : [], staffId, db,
    });
    apiCalls += research.calls || 0;
    for (const e of (research.errors || [])) {
      skips.push({ entity: ent.llc_name, reason: e.reason, why: e.detail || 'The records service could not answer.' });
    }
    const { candidates, skips: theirSkips } = candidatesFrom(research, [ent.llc_name, ...entityNames]);
    for (const s of theirSkips) skips.push({ entity: ent.llc_name, ...s });
    found += candidates.length;

    for (const c of candidates) {
      const staged1 = await stageOne(db, { borrowerId, searchId: search.id, candidate: c, proposedLlcId: ent.id });
      if (staged1.staged) staged += 1;
      else skips.push({ address: addressLabel(c.property_address), reason: staged1.reason, why: staged1.why });
    }
  }

  await db.query(
    `UPDATE track_record_searches
        SET found_count=$2, staged_count=$3, skipped_count=$4, skips=$5::jsonb, api_calls=$6
      WHERE id=$1`,
    [search.id, found, staged, skips.length, JSON.stringify(skips), apiCalls]);

  /* WHAT WAS SEARCHED, ALWAYS — because "we found nothing" and "we had nothing
     to look under" are completely different sentences, and only one of them is
     about the borrower.
     A search runs ONLY under the companies on the profile, so a borrower with
     none gets a zero and, without this, the reason sits inside `skips` where a
     screen has to go looking for it. Read as "we searched and this person has no
     history", that is a finding against them produced by a gap in OUR data — the
     same class as D3, where a coverage gap was painted as a failed verification.
     The caller can now say which companies were searched, or that there were
     none to search, without interpreting anything. */
  const nothingToSearch = entityNames.length === 0;
  return {
    ok: true,
    searchId: search.id,
    found, staged, skipped: skips.length, skips, apiCalls,
    searchedUnder: entityNames,
    nothingToSearch,
    /* One plain sentence, decided HERE so two screens cannot word it two ways. */
    summary: nothingToSearch
      ? 'We could not search: this borrower has no companies on their profile yet, and a public-records search runs under a company name. Add the company they buy under and run it again.'
      : (found === 0
        ? `We searched the public records under ${entityNames.length === 1 ? entityNames[0] : `${entityNames.length} companies`} and found nothing. That usually means the county does not publish online, not that there is nothing to find.`
        : `Found ${found} ${found === 1 ? 'property' : 'properties'} under ${entityNames.length === 1 ? entityNames[0] : `${entityNames.length} companies`}${staged === found ? '' : ` — ${staged} new`}.`),
  };
}

/**
 * Stage one candidate, or say plainly why not.
 *
 * EVERY RESULT FOUND AND NOT STAGED IS RECORDED WITH ITS REASON. A search that
 * quietly drops six of nine results reads as "we only found three", and the
 * three that were dropped for a fixable reason are never fixed.
 */
async function stageOne(db, { borrowerId, searchId, candidate, proposedLlcId }) {
  const key = candidate.dedupe_key || dedupeKeyFor(candidate);

  /* A DECISION IS DURABLE. The partial unique index only stops a second row
     while the first is still `staged`, so without this a declined property
     comes straight back on the next search — which is the one thing "not this
     borrower's" is supposed to prevent. Snoozed counts until its date passes. */
  const prior = (await db.query(
    `SELECT status, snoozed_until FROM track_record_candidates
      WHERE borrower_id=$1 AND dedupe_key=$2
      ORDER BY created_at DESC LIMIT 1`, [borrowerId, key])).rows[0];
  if (prior) {
    if (prior.status === 'declined') {
      return { staged: false, reason: 'declined_before', why: 'Somebody already said this is not their property.' };
    }
    if (prior.status === 'imported' || prior.status === 'merged') {
      return { staged: false, reason: 'already_handled', why: 'This was already brought onto the track record.' };
    }
    if (prior.status === 'snoozed' && prior.snoozed_until && new Date(prior.snoozed_until) > new Date()) {
      return { staged: false, reason: 'snoozed', why: 'Somebody chose to decide this later.' };
    }
    if (prior.status === 'staged') {
      return { staged: false, reason: 'already_staged', why: 'It is already waiting in the queue.' };
    }
  }

  /* IS IT ALREADY ON THE REAL RECORD, AND HOW SURE ARE WE?
     `match_confidence` used to be written as 'exact' or 'none' and nothing else,
     so the third value the CHECK has always allowed — 'near' — was never
     produced by anything. That made "we think this is the same property but we
     are not certain" PHYSICALLY UNRENDERABLE: every match reached a reviewer as
     either settled or absent, and the in-between, which is the case a human is
     actually needed for, had nowhere to live.
     `match.decideMatch` already computes exactly that three-way answer and had
     no caller at stage time. It needs BOTH address comparers to agree before it
     will say 'exact', and `sqlSamePlace` is an ARGUMENT so a caller that cannot
     reach the database fails CLOSED to 'near' rather than quietly auto-binding. */
  const mine = (await db.query(
    `SELECT id, property_address, address_key FROM track_records WHERE borrower_id=$1`, [borrowerId])).rows;
  const hit = TRK.matchTrackRecord(mine, candidate.property_address);

  let confidence = 'none';
  let why = {};
  if (hit) {
    let sqlSamePlace;
    try {
      const r = await db.query('SELECT pilot_address_same_place($1::jsonb, $2::jsonb) AS same',
        [JSON.stringify(hit.property_address || null), JSON.stringify(candidate.property_address || null)]);
      sqlSamePlace = r.rows[0] ? r.rows[0].same === true : undefined;
    } catch (_) { sqlSamePlace = undefined; }   // unreachable → decideMatch fails closed
    const d = MATCH.decideMatch(hit, { addresses: [addressLabel(candidate.property_address)] },
      { elxStatus: 'exact', sqlSamePlace });
    confidence = d.action === 'auto_confirm' ? 'exact' : (d.action === 'reject' ? 'none' : 'near');
    why = confidence === 'none'
      ? {}
      : {
        why: confidence === 'exact'
          ? 'The same address is already on the track record, and both address comparisons agree.'
          : 'This looks like a property already on the track record, but we are not certain it is the same one.',
        /* The REASONS a human needs, not a score. A percentage here would be
           saying something about county data and would read as something about
           the borrower. */
        blockers: (d.blockers || []).map((b) => b.why),
        matchedAddress: addressLabel(hit.property_address),
      };
  }

  const ins = await db.query(
    `INSERT INTO track_record_candidates
       (borrower_id, search_id, source, raw, property_address, deal_type,
        purchase_price, purchase_date, sale_price, sale_date, entity_name,
        proposed_llc_id, dedupe_key, match_track_record_id, match_confidence, match_why, status)
     VALUES ($1,$2,'elementix',$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::uuid,$12,$13::uuid,$14,$15::jsonb,'staged')
     RETURNING id`,
    [borrowerId, searchId, JSON.stringify(candidate.raw || {}),
      JSON.stringify(candidate.property_address || null), candidate.deal_type,
      candidate.purchase_price, candidate.purchase_date, candidate.sale_price, candidate.sale_date,
      candidate.entity_name, proposedLlcId || null, key,
      confidence === 'none' ? null : (hit ? hit.id : null), confidence,
      JSON.stringify(why)]);

  return { staged: true, id: ins.rows[0].id };
}

/* ── the queue ───────────────────────────────────────────────────────────── */

async function loadQueue(borrowerId, client) {
  const db = client || require('../../db');
  const rows = (await db.query(
    `SELECT c.*, t.property_address AS match_address
       FROM track_record_candidates c
       LEFT JOIN track_records t ON t.id = c.match_track_record_id
      WHERE c.borrower_id=$1
        AND (c.status <> 'snoozed' OR c.snoozed_until IS NULL OR c.snoozed_until <= now())
      ORDER BY c.created_at`, [borrowerId])).rows;

  const last = (await db.query(
    `SELECT s.id, s.run_at, s.found_count, s.staged_count, s.skipped_count, s.skips,
            NULLIF(TRIM(COALESCE(u.full_name,'')),'') AS run_by_name
       FROM track_record_searches s LEFT JOIN staff_users u ON u.id = s.run_by
      WHERE s.borrower_id=$1 ORDER BY s.run_at DESC LIMIT 1`, [borrowerId])).rows[0] || null;

  const shape = (r) => ({
    id: String(r.id),
    address: addressLabel(r.property_address),
    dealType: r.deal_type,
    purchasePrice: r.purchase_price, purchaseDate: r.purchase_date,
    salePrice: r.sale_price, saleDate: r.sale_date,
    entityName: r.entity_name, proposedLlcId: r.proposed_llc_id,
    status: r.status,
    matchTrackRecordId: r.match_track_record_id,
    matchAddress: addressLabel(r.match_address),
    matchConfidence: r.match_confidence,
    /* THE PRE-SELECTED ANSWER IS A SUGGESTION. Nothing applies without a click —
       the queue never acts on its own recommendation. */
    suggested: r.match_track_record_id ? 'match_existing' : 'import_new',
    internalNotes: r.internal_notes,
    /* WHO ANSWERED. db/504. A borrower's "not mine" is weaker evidence than a
       staffer's and is meant to be reviewable — the `declined` list is the one
       place a wrong answer quietly REMOVES experience rather than adding it. */
    decidedByKind: r.decided_by_kind || null,
    decidedByBorrower: r.decided_by_borrower ? true : false,
    deedCount: (r.raw && Array.isArray(r.raw.deeds)) ? r.raw.deeds.length : 0,
  });

  return {
    toReview: rows.filter((r) => r.status === 'staged').map(shape),
    alreadyHere: rows.filter((r) => r.status === 'merged' || r.status === 'imported').map(shape),
    declined: rows.filter((r) => r.status === 'declined').map(shape),
    lastSearch: last,
    /* Named, not silently dropped — a search that quietly loses six of nine
       results reads as "we only found three". */
    couldNotRead: last && Array.isArray(last.skips)
      ? last.skips.filter((s) => !['already_staged', 'already_handled'].includes(s.reason)) : [],
  };
}

/* ── the four verbs ──────────────────────────────────────────────────────── */

const ACTIONS = ['import_new', 'match_existing', 'decline', 'snooze'];

async function decideCandidate(candidateId, { action, staffId, note, snoozeDays, dealType, confirmReopen }, client) {
  const db = client || require('../../db');
  if (!ACTIONS.includes(str(action))) { const e = new Error('that is not one of the choices'); e.status = 400; throw e; }

  const c = (await db.query(`SELECT * FROM track_record_candidates WHERE id=$1`, [candidateId])).rows[0];
  if (!c) { const e = new Error('not found'); e.status = 404; throw e; }
  if (c.status !== 'staged' && c.status !== 'snoozed') {
    const e = new Error('Somebody has already decided this one.'); e.status = 409; throw e;
  }

  if (action === 'decline') {
    if (!str(note)) { const e = new Error('Say why this is not their property — the next search reads it.'); e.status = 400; throw e; }
    await settle(db, candidateId, 'declined', staffId, note);
    return { ok: true, action, status: 'declined' };
  }

  if (action === 'snooze') {
    const days = Math.min(Math.max(Number(snoozeDays) || 7, 1), 180);
    await db.query(
      `UPDATE track_record_candidates
          SET status='snoozed', snoozed_until = now() + ($2 || ' days')::interval,
              decided_by=$3::uuid, decided_at=now(),
              internal_notes = CASE WHEN $4 = '' THEN internal_notes ELSE COALESCE(internal_notes,'') || $4 END
        WHERE id=$1`,
      [candidateId, String(days), staffId || null, str(note) ? `\n${str(note)}` : '']);
    return { ok: true, action, status: 'snoozed', days };
  }

  if (action === 'match_existing') return matchExisting(db, c, { staffId, note, confirmReopen });
  return importNew(db, c, { staffId, note, dealType });
}

async function settle(db, id, status, staffId, note) {
  await db.query(
    `UPDATE track_record_candidates
        SET status=$2, decided_by=$3::uuid, decided_at=now(), resolution_note=$4
      WHERE id=$1`, [id, status, staffId || null, str(note).slice(0, 500) || null]);
}

/**
 * Bring it on as a NEW line.
 *
 * Two things happen that a plain INSERT would miss: the ENTITY CHOKEPOINT runs,
 * so the company named on the deed becomes a real entity on the borrower's
 * profile and the line is linked to it (§4.2 — "any LLC entered must become a
 * real LLC on the borrower profile"); and the row lands `pending` because
 * db/485's guard says so, not because this module remembered to ask for it.
 */
/* `enteredByKind` names WHO put the line on the record, and it is a parameter
   rather than the constant 'staff' because a borrower confirming their own
   property goes through this same function. Writing 'staff' for a borrower's
   own answer would make the audit trail say something untrue and would hide
   the line from the queue built to surface self-reported ones. It defaults to
   'staff' so every existing caller is unchanged. */
async function importNew(db, c, { staffId, note, dealType, enteredByKind = 'staff', borrowerActor = null }) {
  /* A DEAL TYPE IS REQUIRED TO IMPORT, because a line without one counts toward
     NOTHING and is filed under holds — see `dealTypeFromRecords`. The explicit
     answer wins; the candidate's own value is next; the records' reading is the
     last resort, and it only ever fires on a bought-and-sold pair. If none of
     the three produces one, this REFUSES rather than writing a line that will
     silently credit nobody — the caller is a screen with a human in front of
     it, so asking is always possible. */
  const effectiveDealType = str(dealType) || str(c.deal_type) || dealTypeFromRecords(c).dealType;
  if (!effectiveDealType) {
    const e = new Error('Say what kind of deal this was — a line with no deal type counts toward nothing.');
    e.status = 400; e.code = 'deal_type_needed';
    e.why = dealTypeFromRecords(c).why;
    throw e;
  }
  let llcId = c.proposed_llc_id || null;
  let entityCreated = false;
  if (!llcId && str(c.entity_name)) {
    const promoted = await entityLib.promoteEntityName(c.borrower_id, c.entity_name, { client: db, actorId: staffId });
    llcId = promoted.llcId || null;
    entityCreated = promoted.created === true;
  }

  const ins = await db.query(
    `INSERT INTO track_records
       (borrower_id, llc_id, property_address, address_key, deal_type,
        purchase_price, purchase_date, sale_price, sale_date, entity_name,
        origin, entered_by_kind, entered_at, notes)
     VALUES ($1,$2::uuid,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,'public_records',$12,now(),$11)
     RETURNING id, is_verified, verification_status`,
    [c.borrower_id, llcId, JSON.stringify(c.property_address || null),
      TRK.trackRecordKey(c.property_address) || '', effectiveDealType,
      c.purchase_price, c.purchase_date, c.sale_price, c.sale_date, c.entity_name,
      enteredByKind === 'borrower'
        ? 'The borrower confirmed this one from the public records.'
        : 'Brought on from the public records.',
      enteredByKind]);

  const row = ins.rows[0];
  /* EXACTLY ONE DECIDER (db/504's `trc_one_decider_check`): a staffer or a
     borrower, never both. `decided_by` is a staff_users FK, so a borrower's id
     may never go there — that constraint is the schema doing its job. */
  await db.query(
    `UPDATE track_record_candidates
        SET status='imported', imported_track_record_id=$2,
            decided_by=$3::uuid, decided_by_borrower=$5::uuid, decided_by_kind=$6,
            decided_at=now(), resolution_note=$4
      WHERE id=$1`,
    [c.id, row.id, borrowerActor ? null : (staffId || null), str(note).slice(0, 500) || null,
      borrowerActor || null, borrowerActor ? 'borrower' : 'staff']);

  return {
    ok: true, action: 'import_new', status: 'imported',
    trackRecordId: row.id, llcId, entityCreated,
    // Reported, not assumed: db/485 decides this, and saying so out loud is what
    // stops anybody thinking an import counts toward experience.
    isVerified: row.is_verified === true,
    verificationStatus: row.verification_status,
  };
}

/**
 * FILL THE BLANKS on the line already there. Never overwrites.
 *
 * The policy §9.3 states: default to the public record where OUR line is blank,
 * and to our line for anything a human typed. Implemented as the strict reading
 * — a value we already hold is never touched, whatever the records say — so a
 * disagreement stays a disagreement a person can see rather than being quietly
 * resolved in the vendor's favour.
 */
async function matchExisting(db, c, { staffId, note, confirmReopen }) {
  if (!c.match_track_record_id) {
    const e = new Error('There is no line on the track record to match this to.'); e.status = 400; throw e;
  }
  const t = (await db.query(`SELECT * FROM track_records WHERE id=$1`, [c.match_track_record_id])).rows[0];
  if (!t) { const e = new Error('that line is gone'); e.status = 404; throw e; }

  const fills = {};
  for (const f of FILLABLE) {
    const ours = t[f];
    const theirs = c[f];
    const oursBlank = ours == null || ours === '' || (f === 'property_address' && !addressLabel(ours));
    if (oursBlank && theirs != null && theirs !== '') fills[f] = theirs;
  }

  const materialFills = Object.keys(fills).filter((f) => MATERIAL.includes(f));
  /* A VERIFIED LINE LOSES ITS VERIFICATION when a material column moves —
     db/485, correctly, since the verification was made without that figure. But
     nobody presses "match" expecting to undo a verification, so this is refused
     until it is asked for a second time, in those words. The guard is never
     weakened; the surprise is. */
  if (t.is_verified === true && materialFills.length && !confirmReopen) {
    const e = new Error(
      `This project is already verified, and filling in ${materialFills.length === 1 ? 'that figure' : 'those figures'} `
      + `(${materialFills.join(', ')}) will reopen it for review. Confirm if that is what you want.`);
    e.status = 409; e.code = 'would_reopen_verification'; e.fields = materialFills; throw e;
  }

  if (Object.keys(fills).length) {
    const sets = []; const vals = [c.match_track_record_id]; let i = 1;
    for (const [f, v] of Object.entries(fills)) {
      i += 1;
      // Only ever where OURS IS STILL BLANK — re-checked inside the statement,
      // so a value typed between the read and the write is never clobbered.
      if (f === 'property_address') { sets.push(`property_address = CASE WHEN property_address IS NULL THEN $${i}::jsonb ELSE property_address END`); vals.push(JSON.stringify(v)); }
      else { sets.push(`${f} = COALESCE(${f}, $${i})`); vals.push(v); }
    }
    sets.push('updated_at = now()');
    await db.query(`UPDATE track_records SET ${sets.join(', ')} WHERE id=$1`, vals);
  }

  await db.query(
    `UPDATE track_record_candidates
        SET status='merged', imported_track_record_id=$2, decided_by=$3::uuid, decided_at=now(), resolution_note=$4
      WHERE id=$1`, [c.id, c.match_track_record_id, staffId || null, str(note).slice(0, 500) || null]);

  const after = (await db.query(
    `SELECT is_verified, verification_status FROM track_records WHERE id=$1`, [c.match_track_record_id])).rows[0];

  return {
    ok: true, action: 'match_existing', status: 'merged',
    trackRecordId: c.match_track_record_id,
    filled: Object.keys(fills),
    reopened: t.is_verified === true && after.is_verified !== true,
  };
}

/**
 * The side-by-side. Only CONFLICTING fields are a decision; a one-sided fill is
 * informational; a blank renders as an explicit empty rather than as nothing,
 * so "we hold nothing" and "they hold nothing" never look the same.
 */
async function compareCandidate(candidateId, client) {
  const db = client || require('../../db');
  const c = (await db.query(`SELECT * FROM track_record_candidates WHERE id=$1`, [candidateId])).rows[0];
  if (!c) { const e = new Error('not found'); e.status = 404; throw e; }
  if (!c.match_track_record_id) return { ok: true, rows: [], conflicts: 0, matched: false };

  const t = (await db.query(`SELECT * FROM track_records WHERE id=$1`, [c.match_track_record_id])).rows[0];
  if (!t) return { ok: true, rows: [], conflicts: 0, matched: false };

  const show = (f, v) => {
    if (v == null || v === '') return null;
    if (f === 'property_address') return addressLabel(v);
    if (f.endsWith('_date')) return ymd(v);
    return String(v);
  };

  const rows = FILLABLE.map((f) => {
    const ours = show(f, t[f]);
    const theirs = show(f, c[f]);
    const conflict = !!ours && !!theirs && ours !== theirs;
    return {
      field: f,
      ours, theirs,
      oursEmpty: !ours, theirsEmpty: !theirs,
      conflict,
      /* THE POLICY, stated per row rather than left to the reader: the public
         record fills a blank; anything a human typed wins. */
      willFill: !ours && !!theirs,
      material: MATERIAL.includes(f),
      note: conflict
        ? 'Both hold a value and they disagree — the line keeps yours. Change it by hand if the records are right.'
        : (!ours && theirs ? 'Blank here, so this fills in.' : (ours && !theirs ? 'The records hold nothing — yours is kept.' : 'Neither holds anything.')),
    };
  });

  return {
    ok: true, matched: true,
    trackRecordId: c.match_track_record_id,
    rows,
    conflicts: rows.filter((r) => r.conflict).length,
    fills: rows.filter((r) => r.willFill).map((r) => r.field),
    wouldReopen: t.is_verified === true && rows.some((r) => r.willFill && r.material),
  };
}

module.exports = {
  runSearch,
  loadQueue,
  decideCandidate,
  compareCandidate,
  candidatesFrom,
  dedupeKeyFor,
  dealTypeFromRecords,
  addressLabel,
  ACTIONS,
  MATERIAL,
  FILLABLE,
  _internals: { stageOne, importNew, matchExisting, firstOurName, num, ymd },
};
