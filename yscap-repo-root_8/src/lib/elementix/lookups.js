'use strict';
/**
 * READING THE PUBLIC RECORDS — the only door PILOT's own code uses.
 *
 * Thin wrappers over `src/elementix/client.callTool`, which will invoke ANY tool
 * the vendor exposes with no allowlist of its own. This module is the allowlist,
 * plus argument validation, plus the two rules the vendor's shapes make easy to
 * get wrong, plus a cache and a ledger entry per call.
 *
 * ═══ THE OWNER'S HARD CONSTRAINT — READ THIS BEFORE ADDING A FUNCTION ═══════
 * Owner, verbatim: *"you should never skip trace contacts, which means you
 * should never display contact phone numbers because you never retrieve contact
 * phone numbers that were not yet skip traced. If it's already skip traced, then
 * you can look at it if you want to, but if you didn't, I don't want to do this
 * to cost me money because I have only 1,000 per month."*
 *
 * Three separate things make that true here, and no ONE of them is trusted:
 *
 *   1. `submit_contact_enrichment` — the tool that spends a credit — IS NOT IN
 *      THIS MODULE. Not behind a flag, not behind a permission: absent. There is
 *      no argument any caller can pass to reach it. A test greps for it.
 *   2. `contactFor()` asks `get_contact_status` FIRST and returns nothing at all
 *      unless the vendor says this person is ALREADY unlocked. That is the
 *      owner's "if it's already skip traced, then you can look at it".
 *   3. `TOOLS` is a closed set. A tool not named there is refused before any
 *      network call, so a future typo cannot reach a paid endpoint by accident.
 *
 * If a paid enrichment is ever wanted, it belongs in a route handling ONE
 * deliberate human click for ONE named person, going through the client's
 * `paidActor` path — never through this module, which is what sweeps and
 * verification runs call.
 *
 * ═══ TWO VENDOR SHAPES THAT ARE EASY TO GET WRONG ══════════════════════════
 *   · `entityFilter:'entity'` and `entityFilter:'company'` return DIFFERENT
 *     OBJECT TYPES. An entity uuid works with the `get_entity_*` tools; a
 *     company uuid does not and there are no company sub-resource tools exposed
 *     over MCP at all. Passing one for the other returns nothing, silently, and
 *     reads as "this borrower has no deeds". `searchEntity` therefore pins
 *     `entityFilter:'entity'` and refuses to be told otherwise.
 *   · `currentExposure` is a STRING, not a number. `Number('$1,240,000')` is
 *     NaN, and `NaN > threshold` is false — so a naive read makes every borrower
 *     look unexposed. `money()` parses it.
 *
 * ═══ TOKEN ECONOMICS ═══════════════════════════════════════════════════════
 * `list_people` returns 145,873 characters for 5 rows (base64 lender logos in
 * every row). It is not wrapped here and must not be — there is no argument that
 * makes it affordable. Prefer `scope:'count'` to size a result before paging,
 * and `include` aggressively: `get_document({include:'signers'})` is about a
 * tenth the size of the whole document and carries the one field we want.
 *
 * ═══ NEVER THROWS ══════════════════════════════════════════════════════════
 * The client's contract, kept: every function returns `{ok:true, data}` or
 * `{ok:false, reason, detail}`. A research lookup that throws becomes a 500 on
 * an officer's screen instead of a sentence they can act on.
 */

const client = require('../../elementix/client');
const SHAPES = require('./shapes');

/**
 * THE CLOSED SET. A tool not named here cannot be called through this module.
 * `submit_contact_enrichment` is deliberately, permanently absent — see the
 * header. Adding an entry is a reviewed act: confirm it is free first.
 */
const TOOLS = new Set([
  'search',
  'match_entity', 'match_address', 'match_person',
  'get_entity_deeds', 'get_entity_mortgages', 'get_entity_associated_people',
  'get_entity_related_addresses', 'get_entity_co_occurring_entities',
  'get_address', 'get_address_ownership', 'get_address_transactions',
  'get_person_entities', 'get_person_properties',
  'get_document',
  'get_coverage',
  // Reads a person's UNLOCK STATE. Free, and the gate in front of any contact
  // read — never an enrichment.
  'get_contact_status',
  // Returns details for a person ALREADY unlocked. Free for an unlocked person;
  // `contactFor()` is the only caller and it checks the status first.
  'get_contact_info',
]);

/** Never reachable from here, and a test asserts the name never appears. */
const FORBIDDEN = ['submit_contact_enrichment'];

const str = (v) => String(v == null ? '' : v).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));

/** A US state code, or ''. Never guesses from a full name here — the caller has
 *  `address.stateAbbr` for that and passing a guess to a vendor filter silently
 *  returns nothing. */
const stateCode = (v) => (/^[A-Za-z]{2}$/.test(str(v)) ? str(v).toUpperCase() : '');

/**
 * `currentExposure` and friends arrive as display strings: "$1,240,000", "1.2M",
 * "—". Returns a number or null — NEVER NaN, because `NaN > x` is false and a
 * silent false is how an exposed borrower reads as unexposed.
 */
function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/[$,\s]/g, '');
  if (!s) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)([kKmMbB])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1;
  return n * mult;
}

/**
 * How common is this name? The vendor scores it 0–100. Above the gate, a name
 * cannot identify a person and every downstream match built on it is a guess —
 * the scoring ladder refuses to auto-prove there, and this is the same number
 * read at the source so the two can never disagree.
 */
const NAME_COMMONNESS_REFUSE_AT = 85;
function nameCommonness(row) {
  const n = Number((row && (row.nameCommonnessScore ?? row.name_commonness_score)) ?? NaN);
  return Number.isFinite(n) ? n : null;
}
const nameTooCommon = (row) => {
  const n = nameCommonness(row);
  return n != null && n >= NAME_COMMONNESS_REFUSE_AT;
};

/* ── the guarded call ─────────────────────────────────────────────────────── */

const bad = (reason, detail) => ({ ok: false, reason, detail });

/**
 * Every call from this module goes through here: the closed set, then the
 * client, then the ledger. `opts.staffId` is required for the ledger to be worth
 * anything — Elementix sees one company account, so without it nobody can
 * answer "who used the allowance?".
 */
async function call(tool, args, opts = {}) {
  const name = str(tool);
  if (FORBIDDEN.includes(name)) {
    return bad('paid_tool_refused',
      'That tool spends credits. It is deliberately not reachable from the research module.');
  }
  if (!TOOLS.has(name)) {
    return bad('unknown_tool', `${name || 'that lookup'} is not one this module may call.`);
  }
  let out;
  try {
    out = await client.callTool(name, args || {}, { staffId: opts.staffId || null });
  } catch (e) {
    // The client already promises not to throw; this is the belt to that
    // suspender, because a research lookup must never 500 a screen.
    out = bad('error', (e && e.message) || 'The lookup failed.');
  }
  /* THE LEDGER IS WRITTEN BY THE CLIENT, not here. It is the only module that
     talks to Elementix, so it is the only one that should record — two writers
     would double-count the very number the hourly guard reads, and the guard
     would then throttle at half the real allowance. */
  return out;
}

/* ── the wrappers ─────────────────────────────────────────────────────────── */

/**
 * Find the ENTITY (a state-registered LLC or similar), never the rolled-up
 * parent COMPANY. The two are different object types and only an entity uuid
 * works with `get_entity_*` — see the header.
 */
async function searchEntity(name, state, opts = {}) {
  const n = str(name);
  if (!n) return bad('bad_args', 'Say which company to look for.');
  /* `entityFilter` BELONGS TO `search`, NOT TO `match_entity` — it is not a
     parameter of this tool and sending it is at best ignored. The entity-vs-
     company distinction the header warns about is real and still matters on
     `search`; here the tool only ever matches entities. */
  const args = { name: n };
  const st = stateCode(state);
  if (st) args.state = st;
  const out = await call('match_entity', args, opts);
  if (!out.ok) return out;
  const rows = rowsOf(out.data);
  /* THE NAME IS `originalName`/`normalizedName`, NEVER `name`. A caller reading
     `.name` gets undefined and the promotion chokepoint then has nothing to
     match the borrower's typed company against. Normalised to `name` here so no
     consumer has to know. */
  const status = str(out.data && out.data.status);
  return {
    ok: true,
    data: rows.map((r) => ({
      ...r,
      name: str(r.name) || str(r.normalizedName) || str(r.originalName) || null,
      _nameCommonness: nameCommonness(r),
      _tooCommon: nameTooCommon(r),
    })),
    /* The vendor states its own confidence. An `exact` single hit is not
       ambiguous however many rows come back; anything else with more than one
       row is a human question, and picking the first is how somebody else's
       deeds land on this borrower's record. */
    matchStatus: status || null,
    ambiguous: rows.length > 1 && status !== 'exact',
  };
}

async function entityDeeds(entityId, opts = {}) {
  if (!isUuid(entityId)) return bad('bad_args', 'That is not an entity id from a search result.');
  return call('get_entity_deeds', { id: entityId, ...pageArgs(opts) }, opts);
}

async function entityMortgages(entityId, opts = {}) {
  if (!isUuid(entityId)) return bad('bad_args', 'That is not an entity id from a search result.');
  return call('get_entity_mortgages', { id: entityId, ...pageArgs(opts) }, opts);
}

async function entityPeople(entityId, opts = {}) {
  if (!isUuid(entityId)) return bad('bad_args', 'That is not an entity id from a search result.');
  return call('get_entity_associated_people', { id: entityId }, opts);
}

async function coOccurringEntities(entityId, opts = {}) {
  if (!isUuid(entityId)) return bad('bad_args', 'That is not an entity id from a search result.');
  return call('get_entity_co_occurring_entities', { id: entityId, minSharedPrincipals: 1 }, opts);
}

async function matchAddress(address, opts = {}) {
  const a = str(address);
  if (!a) return bad('bad_args', 'Say which address to look for.');
  return call('match_address', { address: a }, opts);
}

/**
 * Ownership history for an address — who held it and between which dates.
 *
 * THE TOOL WAS IN THE ALLOWLIST WITH NO CALLER, so `researchProperty` never
 * populated `currentOwner` and `checks.js` could never fire the single most
 * valuable test there is: they say they sold it, and the record still shows
 * them holding it. It is also the ONLY place `isNonArmsLengthTransfer` lives —
 * a caller looking for it on a deed finds nothing and reads that as
 * "arm's length".
 */
async function addressOwnership(addressId, opts = {}) {
  if (!isUuid(addressId)) return bad('bad_args', 'That is not an address id from a match result.');
  return call('get_address_ownership', { id: addressId, ...pageArgs(opts) }, opts);
}

async function addressTransactions(addressId, opts = {}) {
  if (!isUuid(addressId)) return bad('bad_args', 'That is not an address id from a match result.');
  return call('get_address_transactions', { id: addressId, ...pageArgs(opts) }, opts);
}

/**
 * A recorded instrument. `include:'signers'` by default — about a tenth the
 * size of the whole document, and the signers are the one field the identity
 * gate (A1, "the borrower personally signed it") is built on.
 */
async function document(documentId, opts = {}) {
  if (!isUuid(documentId)) return bad('bad_args', 'That is not a document id from a transaction.');
  return call('get_document', { documentId, include: opts.include || 'signers' }, opts);
}

/** How complete are this county's records? Feeds the thin-coverage penalty, so
 *  an absence in a badly-covered county is not read as an absence of fact. */
async function coverage(where, opts = {}) {
  const args = {};
  if (str(where && where.county)) args.county = str(where.county);
  if (stateCode(where && where.state)) args.state = stateCode(where.state);
  if (!Object.keys(args).length) return bad('bad_args', 'Say which county or state.');
  return call('get_coverage', args, opts);
}

/**
 * CONTACT DETAILS — the owner's rule, in code.
 *
 * Asks `get_contact_status` FIRST. If the vendor does not say this person is
 * ALREADY unlocked, this returns `{ok:true, unlocked:false, contact:null}` and
 * NOTHING is fetched and nothing is shown. It never enriches, never offers to,
 * and there is no argument that changes that — the enrichment tool is not in
 * this module.
 *
 * `{ok:true, unlocked:false}` rather than an error, deliberately: not having
 * paid for somebody's phone number is the NORMAL state, not a failure, and a
 * screen showing an error there would invite somebody to go and fix it.
 */
async function contactFor(personId, opts = {}) {
  if (!isUuid(personId)) return bad('bad_args', 'That is not a person id from a search result.');
  const st = await call('get_contact_status', { personId }, opts);
  if (!st.ok) return st;
  if (!isUnlocked(st.data)) {
    return {
      ok: true, unlocked: false, contact: null,
      why: 'This person has not been skip traced, so we hold no phone number for them. Looking one up costs a credit, and PILOT never spends one on its own.',
    };
  }
  const info = await call('get_contact_info', { personId }, opts);
  if (!info.ok) return info;
  return { ok: true, unlocked: true, contact: info.data };
}

/**
 * Is this person ALREADY unlocked? Reads several spellings because the vendor's
 * status shape is not pinned by a schema — and FAILS CLOSED: anything it cannot
 * read confidently is "not unlocked", which costs a phone number nobody sees and
 * never costs a credit.
 */
function isUnlocked(d) {
  if (!d || typeof d !== 'object') return false;
  const row = Array.isArray(d) ? d[0] : (d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d);
  if (!row || typeof row !== 'object') return false;
  for (const k of ['unlocked', 'isUnlocked', 'is_unlocked', 'enriched', 'alreadyUnlocked']) {
    if (row[k] === true) return true;
    if (row[k] === false) return false;
  }
  const s = str(row.status || row.contactStatus || row.contact_status).toLowerCase();
  if (['unlocked', 'enriched', 'available', 'purchased'].includes(s)) return true;
  return false;
}

/** Rows out of whatever envelope the vendor used this time. */
function rowsOf(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of ['results', 'rows', 'items', 'data', 'entities', 'matches']) {
    if (Array.isArray(d[k])) return d[k];
  }
  /* THE `match_*` TOOLS ANSWER WITH A SINGULAR OBJECT, NOT A LIST.
     `match_entity` returns `{status, match:{id, originalName, normalizedName,
     state}, differs, normalized}` — `match`, singular, and an OBJECT. It is not
     in the list above (which carries the plural `matches`), so this returned []
     and `searchEntity` resolved nothing, every time, for every borrower. The
     entity-first path — the cheap, high-precision route the whole design rests
     on — had therefore never once run. Wrapped as a one-row list so every
     caller keeps one shape.
     `nested.data` covers `get_document({include:'signers'})` → `{signers:{data}}`
     and `get_address` → `{entities:{data}}`, which are envelopes around an
     envelope and otherwise read as empty. */
  if (d.match && typeof d.match === 'object') return [d.match];
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (v && typeof v === 'object' && Array.isArray(v.data)) return v.data;
  }
  return [];
}

/** `scope:'count'` sizes a result before paging it — the difference between one
 *  cheap call and twenty expensive ones. */
function pageArgs(opts = {}) {
  const a = {};
  if (opts.countOnly) a.scope = 'count';
  /* `perPage`, NOT `limit`. PROVEN 2026-08-09: `get_entity_deeds` called with
     {limit: 2} returned FIVE rows — the vendor ignores `limit` silently and its
     default page is 5. So a borrower with 29 properties read as 5, and nothing
     anywhere said so: not an error, not a warning, just a short answer that
     looks complete. The page size is the one parameter where being wrong is
     invisible, which is why it gets its own comment. */
  const n = Number(opts.perPage != null ? opts.perPage : opts.limit);
  if (Number.isFinite(n)) a.perPage = Math.min(Math.max(n, 1), 100);
  return a;
}

/**
 * THE ENTITY-FIRST SEQUENCE — about six to nine calls for one property.
 *
 * Entity first because it is the cheap discriminator: an LLC name plus a state
 * is far more identifying than an address, and the entity's own deed list
 * usually contains the property already, which saves the address round trip
 * entirely. Every step is optional; a step that fails degrades the answer rather
 * than failing the run, and what could not be reached comes back in `errors` so
 * the reviewer sees "we could not read the county" instead of "nothing found".
 *
 * Returns the SHAPE `track-record/checks.computeChecks` consumes, so nothing in
 * between has to translate the vendor's fields twice.
 */
async function researchProperty({ entityName, state, address, borrowerNames, staffId, db }, opts = {}) {
  const o = { staffId, db };
  const out = {
    ok: true, calls: 0, errors: [], searched: false,
    deeds: [], mortgages: [], satisfactions: [], ownerships: [], currentOwner: null, coverage: null,
    entity: null, people: [], ambiguousEntity: false, tooCommon: false,
  };
  const note = (step, r) => { out.calls += 1; if (!r.ok) out.errors.push({ step, reason: r.reason, detail: r.detail }); return r; };

  if (str(entityName)) {
    const e = note('match_entity', await searchEntity(entityName, state, o));
    if (e.ok) {
      const rows = e.data || [];
      out.ambiguousEntity = !!e.ambiguous;
      out.tooCommon = rows.some((r) => r._tooCommon);
      // ONE candidate or nothing. Several equally good candidates is a human
      // question, and picking the first is exactly how somebody else's deeds
      // end up on this borrower's record.
      out.entity = rows.length === 1 ? rows[0] : null;
    }
  }

  const entityId = out.entity && (out.entity.id || out.entity.entityId || out.entity.uuid);
  if (isUuid(entityId)) {
    /* NORMALISED HERE, AT THE ONE SEAM. Everything downstream — the pure
       pillar engine, the importer, the counterparty control — reads canonical
       rows, so no consumer has to know that a deed's price is
       `totalConsideration` while an ownership row's is a STRING of the same
       name, or that the property address is `addresses[{addressFull}]` and
       never `address`. Reading a raw row is what made the engine dark. */
    const d = note('get_entity_deeds', await entityDeeds(entityId, o));
    if (d.ok) { out.deeds = SHAPES.deeds(rowsOf(d.data)); out.searched = true; }
    const m = note('get_entity_mortgages', await entityMortgages(entityId, o));
    if (m.ok) { out.mortgages = SHAPES.mortgages(rowsOf(m.data)); out.searched = true; }
    const p = note('get_entity_associated_people', await entityPeople(entityId, o));
    if (p.ok) out.people = rowsOf(p.data);
  }

  // The address round trip is only worth making when the entity route did not
  // already produce this property.
  const haveIt = out.deeds.length > 0 || out.mortgages.length > 0;
  if (str(address) && !haveIt) {
    const a = note('match_address', await matchAddress(address, o));
    const hit = a.ok ? rowsOf(a.data)[0] : null;
    const addrId = hit && (hit.id || hit.addressId || hit.uuid);
    if (isUuid(addrId)) {
      const t = note('get_address_transactions', await addressTransactions(addrId, o));
      if (t.ok) {
        out.searched = true;
        /* The normaliser reads the row's own `type` and sets `kind`, so the
           sorting below is on a canonical field rather than on three guesses at
           what the vendor might have called it. It also renames
           `partiesGrantor`/`partiesGrantee` to grantors/grantees — without
           which every address-branch result was dropped by `candidatesFrom` as
           "not our party", recorded as a judgement about the borrower rather
           than as the field mismatch it was. */
        for (const row of SHAPES.transactions(rowsOf(t.data))) {
          if (row.kind === 'mortgage') out.mortgages.push(row);
          else if (row.kind === 'satisfaction') out.satisfactions.push(row);
          else out.deeds.push(row);
        }
      }
      /* WHO HOLDS IT NOW — the input to the most valuable check there is: they
         say they sold it and the record still shows them owning it. The tool
         was in the allowlist with no caller, so `currentOwner` was never
         populated and `checks.js` could never fire that test. */
      const own = note('get_address_ownership', await addressOwnership(addrId, o));
      if (own.ok) {
        const rows = SHAPES.ownerships(rowsOf(own.data));
        out.ownerships = rows;
        out.currentOwner = rows.find((r) => r.isCurrent) || null;
        out.searched = true;
      }
    }
  }

  out.borrowerNames = Array.isArray(borrowerNames) ? borrowerNames : [];
  return out;
}

module.exports = {
  call,
  searchEntity,
  entityDeeds,
  entityMortgages,
  entityPeople,
  coOccurringEntities,
  matchAddress,
  addressOwnership,
  addressTransactions,
  document,
  coverage,
  contactFor,
  researchProperty,
  money,
  nameCommonness,
  nameTooCommon,
  isUnlocked,
  rowsOf,
  TOOLS,
  FORBIDDEN,
  NAME_COMMONNESS_REFUSE_AT,
  _internals: { stateCode, isUuid, pageArgs },
};
