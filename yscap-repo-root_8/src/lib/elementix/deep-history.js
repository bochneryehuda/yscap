'use strict';
/**
 * src/lib/elementix/deep-history.js — the person's WHOLE recorded history, and
 * how it lands on the borrower's own profile.
 *
 * ── WHAT THE OWNER ASKED FOR (2026-08-19) ───────────────────────────────────
 * "The Elementix profile builder pulls in all the properties, all the
 * mortgages, everything… I tried going to his track record and searched the
 * record and only populated one file from 10-20 properties. I want to fix the
 * track record builder Elementix record search to do the same kind of deep
 * search… all the entities that he owns according to Elementix should be added
 * to his profile as entities… all the properties should be added on the track
 * record automatically. Not as verified, of course, but just import it. And
 * backdate this for the profiles we already have."
 *
 * ── WHY THE OLD TRACK-RECORD SEARCH FOUND SO LITTLE ─────────────────────────
 * Three independent reasons, all structural:
 *   1. It resolved the person BY NAME, state by state — and refused (correctly)
 *      whenever the name was ambiguous or too common. The profile builder never
 *      names anybody: it starts from the Elementix PERSON ID a human already
 *      linked to the borrower, which is why it always finds the right records.
 *   2. It read ONE PAGE per list (the vendor's page, no page loop), so a real
 *      portfolio truncated with only a small "more pages" note.
 *   3. It searched only the companies ALREADY TYPED on the borrower's profile.
 *      The profile builder reads the person's whole company roster from the
 *      records themselves.
 * This module closes all three by doing what the profile builder does — a
 * person-ID-keyed, fully paged pull across the confirmed cross-state family —
 * and then walking the results through the track-record importer's OWN
 * staging + import machinery, so every existing safety rule still applies.
 *
 * ── WHAT STILL HOLDS, DELIBERATELY ──────────────────────────────────────────
 *  · IDENTITY IS NEVER GUESSED. This runs only for a person a human LINKED to
 *    the borrower (borrowers.elementix_person_id) plus aliases a human
 *    CONFIRMED (profile.familyOf). No name matching mints anything here.
 *  · NOTHING IMPORTS AS VERIFIED. Every line lands through importer.importNew,
 *    so db/485 keeps it pending; it counts toward nothing until a human
 *    verifies it — the owner's own "not as verified, of course".
 *  · A DEAL TYPE IS NEVER GUESSED. A bought-and-sold pair imports as the flip
 *    the deeds state; anything else imports with the type LEFT BLANK and a
 *    note asking for it, and counts toward nothing until answered.
 *  · A DECLINE IS DURABLE and a NEAR-MATCH WAITS FOR A HUMAN — both enforced
 *    by stageOne / the auto-decide rule below, so this can never re-raise a
 *    property somebody said is not theirs, and never auto-merges an uncertain
 *    match (a duplicate line is what track_record_findings exists to prevent).
 *  · ENTITIES ADDED HERE ARE HELD OUT OF PROVABLE LIQUIDITY until documented or
 *    verified — the db/400 adoption stamp (`adopted_source='elementix'`), the
 *    same guard the bank-statement entity-adopt button carries, because a name
 *    alone on the profile would otherwise move a matching bank account's whole
 *    balance into the file's provable funds.
 *
 * ── THE FCRA LINE, KEPT ──────────────────────────────────────────────────────
 * This module feeds the UNDERWRITING plane, so it reads ONLY property records:
 * the deeds / mortgages / entities sections and the persons/aliases headers.
 * It NEVER reads `elementix_contacts`, never reads the overview section (which
 * carries a mailing address), and its live pull goes through `lookups.js` —
 * the plane whose allowlist structurally cannot reach the paid contact tool.
 * A test greps this file for those properties.
 */

const SHAPES = require('./shapes');

const str = (v) => String(v == null ? '' : v).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));
const envInt = (k, dflt) => {
  const n = parseInt(process.env[k] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/* THE SAME DEPTH AS THE PROFILE BUILDER — that is the whole point ("the same
   kind of deep search"). 250 a page, up to 4 pages per list per person id,
   soft call budget so a mega-portfolio cannot quietly drain the office's
   shared hourly allowance. The numbers mirror profile.js's own constants;
   reading them from there would drag the CRM module into the underwriting
   require graph for two integers, so they are stated here with this note and
   the pure test pins the two files together. */
const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const CALL_BUDGET = 40;

/* How many of the person's companies land on the profile in one pass. A real
   operator can carry hundreds; the cap exists so one import cannot write an
   unbounded number of rows, and it is REPORTED, never silent. */
const MAX_ENTITIES = () => envInt('ELEMENTIX_IMPORT_MAX_ENTITIES', 300);

// ---------------------------------------------------------------------------
// READING THE HISTORY — live (the vendor) or cached (the profile sections)
// ---------------------------------------------------------------------------

/**
 * Every person id that makes up this one human: the canonical id plus every
 * alias a human confirmed. DELEGATED to profile.familyOf — the one definition
 * of the family — via a lazy require so this module loads with no CRM code in
 * reach until a family is actually asked for.
 */
async function familyOf(personId, client) {
  try {
    return await require('./profile').familyOf(personId, client);
  } catch (_) {
    // An unreadable alias table narrows the pull to the one linked id — a
    // smaller answer, never a wrong one.
    return isUuid(personId) ? [personId] : [];
  }
}

/** One fully paged list off one person id, through the underwriting plane. */
async function pagedList(fnName, personId, { staffId, db }) {
  const lookups = require('./lookups');
  const out = { rows: [], calls: 0, truncated: false, error: null };
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const r = await lookups[fnName](personId, { staffId, db, page, perPage: PAGE_SIZE });
    out.calls += 1;
    if (!r || r.ok !== true) {
      // A first-page failure is a failed list; a later page failing still
      // leaves real rows, so it degrades to "there is more we could not reach".
      if (page === 1) { out.error = r || { reason: 'error', detail: 'Elementix did not answer.' }; return out; }
      out.truncated = true;
      break;
    }
    const pageRows = lookups.rowsOf(r.data);
    out.rows.push(...pageRows);
    /* `nextPage` means "the page came back full", never "there is more" — the
       measured vendor behavior profile.js documents. A short page is the end. */
    const more = !!(r.data && typeof r.data === 'object' && r.data.nextPage != null
      && r.data.nextPage !== false && pageRows.length >= PAGE_SIZE);
    if (!more) break;
    if (page === MAX_PAGES) out.truncated = true;
  }
  return out;
}

/**
 * THE LIVE DEEP PULL — the mega search, keyed on the person id, through the
 * underwriting plane's own guarded door. Returns the shape
 * `importer.candidatesFrom` consumes (canonical deed/mortgage rows), plus the
 * raw entity roster rows, plus the honesty fields (`errors`, `truncated`,
 * `searched`) the search summary is built from.
 */
async function liveHistory({ personId, staffId, db }) {
  const out = {
    ok: true, calls: 0, errors: [], truncated: [], searched: false,
    deeds: [], mortgages: [], entityRows: [], family: [],
    /* Tells candidatesFrom these rows came off the PERSON'S OWN id, so a deed
       whose vendor flag says "the person is not the grantee" may still be
       recognised through a company on the profile — see importer.js. */
    personKeyed: true,
  };
  if (!isUuid(personId)) { out.ok = false; out.errors.push({ step: 'person', reason: 'bad_args', detail: 'That is not an Elementix person id.' }); return out; }
  out.family = await familyOf(personId, db);

  for (const source of out.family) {
    if (out.calls >= CALL_BUDGET) {
      out.truncated.push({ list: 'family', shown: out.family.indexOf(source), why: 'call budget' });
      break;
    }
    for (const [fnName, list, normalize] of [
      ['personDeeds', 'deeds', SHAPES.deeds],
      ['personMortgages', 'mortgages', SHAPES.mortgages],
      ['personEntities', 'entities', null],
    ]) {
      if (out.calls >= CALL_BUDGET) { out.truncated.push({ list, shown: 0, why: 'call budget' }); continue; }
      const r = await pagedList(fnName, source, { staffId, db });
      out.calls += r.calls;
      if (r.error) { out.errors.push({ step: fnName, reason: r.error.reason, detail: r.error.detail }); continue; }
      out.searched = true;
      if (r.truncated) out.truncated.push({ list, shown: r.rows.length });
      if (normalize) out[list === 'deeds' ? 'deeds' : 'mortgages'].push(...normalize(r.rows));
      else out.entityRows.push(...r.rows);
    }
  }
  // The same recorded document can arrive under two family ids once a human
  // links them; the county identity collapses it exactly as shapes.dedupe does
  // within one list.
  out.deeds = SHAPES.dedupe(out.deeds);
  out.mortgages = SHAPES.dedupe(out.mortgages);
  out.entityRows = dedupeEntities(out.entityRows);
  return out;
}

/**
 * THE CACHED READ — the profile sections a build already paid for, at zero
 * vendor cost. Same output shape as liveHistory. Reads ONLY the three property
 * sections; the overview (which carries a mailing address) and the contact
 * table are never touched from here.
 */
async function cachedHistory({ personId, client }) {
  const db = client || require('../../db');
  const out = {
    ok: true, calls: 0, errors: [], truncated: [], searched: false,
    deeds: [], mortgages: [], entityRows: [], family: [], personKeyed: true, fromCache: true,
  };
  if (!isUuid(personId)) { out.ok = false; return out; }
  out.family = await familyOf(personId, db);
  const { rows } = await db.query(
    `SELECT person_id, section, payload, truncated, last_error
       FROM elementix_person_sections
      WHERE person_id = ANY($1::text[]) AND section IN ('deeds','mortgages','entities') AND state = ''`,
    [out.family]);
  for (const r of rows) {
    if (r.last_error) { out.errors.push({ step: r.section, reason: 'cached_error', detail: r.last_error }); continue; }
    const payload = r.payload || {};
    const list = Array.isArray(payload.rows) ? payload.rows : [];
    out.searched = true;
    if (r.truncated || Number(payload.rowsDropped) > 0) out.truncated.push({ list: r.section, shown: list.length });
    if (r.section === 'deeds') out.deeds.push(...SHAPES.deeds(list));
    else if (r.section === 'mortgages') out.mortgages.push(...SHAPES.mortgages(list));
    else out.entityRows.push(...list);
  }
  out.deeds = SHAPES.dedupe(out.deeds);
  out.mortgages = SHAPES.dedupe(out.mortgages);
  out.entityRows = dedupeEntities(out.entityRows);
  return out;
}

/** One row per entity id (a family merge can carry the same company twice). */
function dedupeEntities(rows) {
  const seen = new Set();
  const out = [];
  for (const r of (rows || [])) {
    if (!r || typeof r !== 'object') continue;
    const key = str(r.id) || `${str(r.name).toUpperCase()}|${str(r.state).toUpperCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE ENTITIES — onto the borrower's profile
// ---------------------------------------------------------------------------

/**
 * Does the vendor say this person actually has a ROLE in the entity? A person
 * can appear beside a company for many reasons; only a stated role — principal,
 * a Secretary-of-State officer record, or having signed its recorded documents —
 * is evidence the company is THEIRS. A row with no stated role is SKIPPED with
 * a reason, never guessed onto the profile.
 */
function statedRole(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.isPrincipal === true) return 'principal';
  if (row.sosOfficer === true) return 'sos_officer';
  if (row.elementixSigner === true) return 'signer';
  return null;
}

/**
 * Add the person's recorded companies to the borrower's profile — the owner's
 * "all the entities should be added to his personal profile".
 *
 * Every name goes through `promoteEntityName` — the repo's ONE chokepoint for a
 * name becoming an entity — so junk is refused, an existing entity is REUSED
 * (never duplicated, via the strict promotionMatch), and the borrower is linked
 * as an owner. An entity this pass CREATES additionally gets:
 *   · the db/400 adoption stamp (`adopted_source='elementix'`) so its funds are
 *     held out of provable liquidity until a document lands or it is verified;
 *   · its formation state, fill-only, from the vendor's own record — which is
 *     also what makes the next records search able to use the exact matcher.
 */
async function importEntities({ borrowerId, entityRows, client }) {
  const db = client || require('../../db');
  const entityLib = require('../track-record-entity');
  const out = { added: 0, matched: 0, skipped: [], names: [] };
  const rows = Array.isArray(entityRows) ? entityRows : [];
  const cap = MAX_ENTITIES();

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const name = str(r && r.name).slice(0, 160);
    if (i >= cap) {
      out.skipped.push({ name: name || '(unnamed)', reason: 'over_cap',
        why: `Only the first ${cap} companies were added in this pass — run the import again to add the rest.` });
      continue;
    }
    if (!name) { out.skipped.push({ name: '(unnamed)', reason: 'no_name', why: 'The record does not name the company.' }); continue; }
    /* An "entity" row can itself be a PERSON (a recorded party). Never a company. */
    if (str(r.entityTypeValue).toUpperCase() === 'PERSON' || str(r.entityType).toUpperCase() === 'PERSON') {
      out.skipped.push({ name, reason: 'is_person', why: 'The records file this as a person, not a company.' });
      continue;
    }
    const role = statedRole(r);
    if (!role) {
      out.skipped.push({ name, reason: 'no_stated_role',
        why: 'The records do not say this person is a principal, officer or signer of this company — it was not added to the profile.' });
      continue;
    }
    const p = await entityLib.promoteEntityName(borrowerId, name, { client: db, firstSeenOn: 'elementix' });
    if (!p.llcId) {
      out.skipped.push({ name, reason: p.reason || 'not_added',
        why: p.ambiguous
          ? 'More than one company with this name is already on the profile — a person has to say which.'
          : 'This name could not be added as a company.' });
      continue;
    }
    out.names.push(name);
    if (p.created) {
      out.added += 1;
      const state = /^[A-Za-z]{2}$/.test(str(r.state)) ? str(r.state).toUpperCase() : null;
      /* The stamp only ever lands on a row THIS pass created and that nothing
         has stamped before — an entity a human put on the profile is theirs
         and is never held back (the entity-adopt rule, kept). */
      await db.query(
        `UPDATE llcs
            SET adopted_at = now(), adopted_source = 'elementix',
                formation_state = COALESCE(formation_state, $2),
                updated_at = now()
          WHERE id = $1 AND adopted_at IS NULL`,
        [p.llcId, state]).catch(() => {});
    } else {
      out.matched += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE PROPERTIES — staged, then imported, through the importer's own verbs
// ---------------------------------------------------------------------------

/**
 * Decide each candidate this run staged, the way the owner asked: everything
 * lands on the record automatically — except what must wait for a human.
 *
 *   exact match  -> fill the blanks on the line already there (match_existing);
 *                   a VERIFIED line refuses the fill (409) and is LEFT STAGED —
 *                   the auto path never reopens a verification.
 *   near match   -> LEFT STAGED. Auto-merging an uncertain match is how a
 *                   duplicate line is born, and a duplicate line is the thing
 *                   the track-record findings exist to prevent.
 *   new property -> a new line (import_new), unverified. The deal type is the
 *                   one the records state (bought+sold = flip) or is left
 *                   BLANK with a note — never guessed.
 */
async function autoDecideStaged({ candidateIds, staffId, enteredByKind }) {
  const importer = require('../track-record/importer');
  const db = require('../../db');
  const out = { imported: 0, merged: 0, leftForReview: 0, skips: [] };
  if (!candidateIds.length) return out;

  const { rows } = await db.query(
    `SELECT id, match_confidence, match_track_record_id, property_address
       FROM track_record_candidates
      WHERE id = ANY($1::bigint[]) AND status = 'staged'`, [candidateIds]);

  for (const c of rows) {
    const label = importer.addressLabel(c.property_address);
    try {
      if (c.match_confidence === 'near') {
        out.leftForReview += 1;
        continue;
      }
      if (c.match_confidence === 'exact' && c.match_track_record_id) {
        await importer.decideCandidate(c.id, {
          action: 'match_existing', staffId: staffId || null,
          note: '[auto] Joined to this line from the borrower\'s Elementix history.',
        });
        out.merged += 1;
        continue;
      }
      await importer.decideCandidate(c.id, {
        action: 'import_new', staffId: staffId || null,
        allowUnstatedDealType: true,
        enteredByKind: enteredByKind || (staffId ? 'staff' : 'system'),
        note: '[auto] Imported from the borrower\'s Elementix history.',
      });
      out.imported += 1;
    } catch (e) {
      if (e && e.code === 'would_reopen_verification') {
        // The line is verified; filling it would undo a human's sign-off. It
        // stays in the review queue for that human instead.
        out.leftForReview += 1;
        continue;
      }
      if (e && e.code === 'already_decided') continue; // somebody beat us to it — their answer stands
      out.leftForReview += 1;
      out.skips.push({ address: label, reason: 'could_not_import',
        why: `This one could not be brought on automatically (${(e && e.message) || 'error'}) — it is waiting in the review queue instead.` });
    }
  }
  return out;
}

/**
 * ONE HISTORY, ONTO ONE BORROWER — the shared middle both doors call.
 * `research` is a liveHistory/cachedHistory result. Stages through
 * `importer.stageOne` (dedupe, durable declines, match banding — all kept) and
 * then auto-decides what this run staged.
 */
async function runImport({ borrowerId, personId, research, staffId, searchId, enteredByKind }) {
  const db = require('../../db');
  const importer = require('../track-record/importer');
  const out = {
    found: 0, staged: 0, imported: 0, merged: 0, leftForReview: 0,
    entitiesAdded: 0, entitiesMatched: 0, skips: [],
    calls: research.calls || 0, searched: research.searched === true,
  };

  for (const e of (research.errors || [])) {
    out.skips.push({ entity: 'Elementix profile', reason: e.reason || 'error', why: e.detail || 'The records service could not answer.' });
  }
  for (const t of (research.truncated || [])) {
    out.skips.push({ entity: 'Elementix profile', reason: 'more_pages',
      why: `The records service has MORE ${t.list} than the ${t.shown} read — this pass is not the complete history. Run it again to continue.` });
  }

  // 1. THE COMPANIES, first — so the deed staging below can recognise a deal
  //    held through one of them, and so importNew links each line to its entity.
  const ents = await importEntities({ borrowerId, entityRows: research.entityRows, client: db });
  out.entitiesAdded = ents.added;
  out.entitiesMatched = ents.matched;
  for (const s of ents.skipped) {
    if (s.reason === 'no_stated_role') continue; // ordinary, and there can be hundreds — the counts say it
    out.skips.push({ entity: s.name, reason: s.reason, why: s.why });
  }

  // 2. THE NAMES a deed can match against: the borrower, plus EVERY company now
  //    on their profile (the ones just added included).
  const b = (await db.query(
    `SELECT NULLIF(TRIM(COALESCE(full_name,'')),'') AS name FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
  if (!b) { const e = new Error('borrower not found'); e.status = 404; throw e; }
  const allEntityNames = (await db.query(
    `SELECT llc_name FROM llcs WHERE borrower_id=$1 AND llc_name IS NOT NULL`, [borrowerId]))
    .rows.map((r) => r.llc_name).filter(Boolean);
  const allNames = [b.name, ...allEntityNames].filter(Boolean);

  // 3. STAGE — the importer's own gate: dedupe key, durable declines, address
  //    twins, match banding, bounds. Nothing lands by a second path.
  const { candidates, skips: theirSkips } = importer.candidatesFrom(research, allNames);
  for (const s of theirSkips) out.skips.push({ entity: 'Elementix profile', ...s });
  out.found = candidates.length;
  const stagedIds = [];
  for (const c of candidates) {
    try {
      const s1 = await importer.stageOne(db, {
        borrowerId, searchId: searchId || null, candidate: c, proposedLlcId: null,
        basisCtx: { branch: 'person', personalName: b.name || '' },
      });
      if (s1.staged) { out.staged += 1; stagedIds.push(s1.id); }
      else out.skips.push({ address: importer.addressLabel(c.property_address), reason: s1.reason, why: s1.why });
    } catch (err) {
      out.skips.push({ address: importer.addressLabel(c.property_address), reason: 'could_not_store',
        why: `This one could not be saved (${(err && err.message) || 'storage error'}) — the rest continued.` });
    }
  }

  // 4. IMPORT what was just staged — the owner's "just import it".
  const decided = await autoDecideStaged({ candidateIds: stagedIds, staffId, enteredByKind });
  out.imported = decided.imported;
  out.merged = decided.merged;
  out.leftForReview = decided.leftForReview;
  out.skips.push(...decided.skips);
  return out;
}

/**
 * THE TRACK-RECORD SEARCH'S DEEP PATH — live pull for a borrower whose profile
 * a human linked to an Elementix person. Called by importer.runSearch, which
 * merges the counts and skips into its own summary. Never throws.
 */
async function searchViaLinkedPerson({ borrowerId, personId, staffId, searchId, db }) {
  try {
    const research = await liveHistory({ personId, staffId, db: db || require('../../db') });
    const out = await runImport({ borrowerId, personId, research, staffId, searchId, enteredByKind: 'staff' });
    out.personId = personId;
    return out;
  } catch (e) {
    return {
      found: 0, staged: 0, imported: 0, merged: 0, leftForReview: 0,
      entitiesAdded: 0, entitiesMatched: 0, calls: 0, searched: false, personId,
      skips: [{ entity: 'Elementix profile', reason: 'error',
        why: `The linked Elementix profile could not be read (${(e && e.message) || 'error'}) — the name-based search still ran.` }],
    };
  }
}

// ---------------------------------------------------------------------------
// THE CACHE DOOR — a profile build (or link) lands on the borrower right away,
// and the back book is swept once.
// ---------------------------------------------------------------------------

/**
 * Import a person's CACHED profile onto a borrower. Zero vendor calls — it
 * reads what a build already paid for. Returns `{nothing:true}` when there is
 * no cached history at all, WITHOUT writing anything (so a borrower who was
 * merely linked, with no profile built yet, never gains a phantom "we searched
 * and found nothing" entry).
 */
async function importFromCache({ borrowerId, personId, staffId }) {
  const db = require('../../db');
  if (!isUuid(str(personId)) || !str(borrowerId)) return { nothing: true };
  const research = await cachedHistory({ personId, client: db });
  const hasAnything = research.deeds.length || research.mortgages.length || research.entityRows.length;
  if (!hasAnything) return { nothing: true, errors: research.errors };

  /* The provenance row — the queue's "last search" names where these came
     from, and the counts land on it exactly as a hand-run search's do. */
  const search = (await db.query(
    `INSERT INTO track_record_searches (borrower_id, run_by, query) VALUES ($1,$2::uuid,$3::jsonb) RETURNING id`,
    [borrowerId, staffId || null,
      JSON.stringify({ source: 'elementix_profile_import', personId, family: research.family })])).rows[0];

  const out = await runImport({
    borrowerId, personId, research, staffId, searchId: search.id,
    enteredByKind: staffId ? 'staff' : 'system',
  });

  await db.query(
    `UPDATE track_record_searches
        SET found_count=$2, staged_count=$3, skipped_count=$4, skips=$5::jsonb, api_calls=0
      WHERE id=$1`,
    [search.id, out.found, out.staged, out.skips.length, JSON.stringify(out.skips)]);
  await db.query(
    `UPDATE borrowers SET elementix_history_imported_at = now() WHERE id = $1`, [borrowerId]).catch(() => {});
  return { ...out, searchId: search.id, personId };
}

/**
 * Every borrower LINKED to this person (or to anybody in its confirmed family)
 * — the fan-out the profile-build hook uses.
 */
async function borrowersLinkedTo(personId, client) {
  const db = client || require('../../db');
  const family = await familyOf(personId, db);
  if (!family.length) return [];
  const { rows } = await db.query(
    `SELECT id, elementix_person_id FROM borrowers WHERE elementix_person_id = ANY($1::text[])`, [family]);
  return rows;
}

/**
 * A profile was just built (or linked) — land it on every linked borrower.
 * Best-effort by contract: a failure here must never fail the build that
 * triggered it. Returns a per-borrower summary for the caller's response.
 */
async function importAfterBuild({ personId, staffId }) {
  const out = [];
  let linked = [];
  try { linked = await borrowersLinkedTo(personId); } catch (_) { return out; }
  for (const b of linked) {
    try {
      const r = await importFromCache({ borrowerId: b.id, personId: b.elementix_person_id, staffId });
      out.push({ borrowerId: b.id, ...summarizeImport(r) });
    } catch (e) {
      out.push({ borrowerId: b.id, error: (e && e.message) || 'the import failed' });
    }
  }
  return out;
}

/** The compact shape a route response / log line carries. */
function summarizeImport(r) {
  if (!r || r.nothing) return { nothing: true };
  return {
    found: r.found, staged: r.staged, imported: r.imported, merged: r.merged,
    leftForReview: r.leftForReview, entitiesAdded: r.entitiesAdded, entitiesMatched: r.entitiesMatched,
    skipped: (r.skips || []).length,
  };
}

/**
 * THE BACK BOOK — the owner's "backdate this: all the profiles we currently
 * have". Bounded, self-draining (the db/597 stamp), retiring a borrower after
 * three failed attempts so one unworkable row can never head-block the queue,
 * and CACHE-ONLY: this sweep never calls the vendor, so it cannot spend a
 * single slot of the shared allowance. A borrower whose profile has no cached
 * history yet is stamped done with nothing written — the moment somebody
 * builds their profile, the build hook imports it live.
 */
async function backfillOnce({ limit = 10 } = {}) {
  const db = require('../../db');
  const out = { checked: 0, imported: 0, nothing: 0, failed: 0 };
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT id, elementix_person_id FROM borrowers
        WHERE elementix_person_id IS NOT NULL
          AND elementix_history_imported_at IS NULL
          AND elementix_history_import_attempts < 3
        ORDER BY created_at
        LIMIT $1`, [Math.max(1, Math.min(100, limit))]));
  } catch (_) { return out; }

  for (const b of rows) {
    out.checked += 1;
    try {
      const r = await importFromCache({ borrowerId: b.id, personId: b.elementix_person_id, staffId: null });
      if (r.nothing) {
        out.nothing += 1;
        await db.query(`UPDATE borrowers SET elementix_history_imported_at = now() WHERE id = $1`, [b.id]);
      } else {
        out.imported += 1; // importFromCache stamps on its own
      }
    } catch (e) {
      out.failed += 1;
      try {
        /* The attempts counter alone retires the row — the sweep's own WHERE
           stops at 3 — and `imported_at` is deliberately LEFT NULL: stamping a
           failure "imported" would make the record claim something untrue, and
           a later profile build / link still imports the borrower for real. */
        await db.query(
          `UPDATE borrowers
              SET elementix_history_import_attempts = elementix_history_import_attempts + 1
            WHERE id = $1`, [b.id]);
      } catch (_) { /* best effort — the next pass simply re-reads */ }
      console.warn('[elementix-history] import failed for borrower %s: %s', b.id, (e && e.message) || e);
    }
  }
  return out;
}

module.exports = {
  liveHistory, cachedHistory,
  importEntities, runImport,
  searchViaLinkedPerson,
  importFromCache, importAfterBuild, borrowersLinkedTo, backfillOnce,
  summarizeImport,
  _internals: { statedRole, dedupeEntities, pagedList, autoDecideStaged, familyOf, PAGE_SIZE, MAX_PAGES, CALL_BUDGET, MAX_ENTITIES },
};
