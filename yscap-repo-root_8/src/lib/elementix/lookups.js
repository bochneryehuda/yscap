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
 * ═══ THE REQUEST CONTRACT IS CHECKED BEFORE THE WIRE ═══════════════════════
 * `request-contracts.json` records how every request must look — transcribed
 * from the live MCP connector's own schemas (owner-directed 2026-08-09). The
 * vendor answers a malformed request with a raw "-32602 Invalid arguments"
 * that reached the owner's screen, and the refused call still spends a slot of
 * the shared hourly allowance — so `call()` refuses a request OUR code shaped
 * wrongly before anything is sent, with a plain sentence, at zero cost. The
 * two rules that have already bitten: `match_entity` AND `match_person`
 * require a STATE (records are keyed name+state — the same name in another
 * state is a different record, proven live: "MW TRADING LLC" is one entity in
 * NJ and another in CA), and for a no-state lookup the vendor's own guidance
 * is `search`, which takes an optional state filter.
 *
 * ═══ NEVER THROWS ══════════════════════════════════════════════════════════
 * The client's contract, kept: every function returns `{ok:true, data}` or
 * `{ok:false, reason, detail}`. A research lookup that throws becomes a 500 on
 * an officer's screen instead of a sentence they can act on.
 */

const client = require('../../elementix/client');
const SHAPES = require('./shapes');
const CONTRACTS = require('./request-contracts.json');

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
  /* The PERSON's own county records — a deal bought in a personal name has no
     entity to search under, and searching entities only was reading a whole
     class of borrowers as having no history (owner-reported 2026-08-09). Same
     row shapes as the entity twins, with the one spelling difference
     `shapes.addressesOf` documents (propertyAddresses). */
  'get_person_deeds', 'get_person_mortgages',
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
 * Does this request look the way the vendor's schema says it must? Answers a
 * plain sentence, or null when it conforms. Judged from request-contracts.json
 * so the rule lives in ONE reviewable place; a tool with no recorded contract
 * is not judged (the vendor will answer for itself).
 */
function contractProblem(tool, args) {
  const c = CONTRACTS.tools && CONTRACTS.tools[tool];
  if (!c) return null;
  const a = args || {};
  for (const req of (c.required || [])) {
    const v = a[req];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      return `the records service requires "${req}" on ${tool} and this request has none`;
    }
  }
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    const p = c.params && c.params[k];
    if (!p) return `${tool} does not take a parameter called "${k}"`;
    const t = typeProblem(p, v);
    if (t) return `${tool}'s "${k}" ${t}`;
  }
  return null;
}

function typeProblem(p, v) {
  if (p.enum) return p.enum.includes(v) ? null : `must be one of ${p.enum.join(', ')}`;
  switch (p.type) {
    case 'string': {
      if (typeof v !== 'string') return 'must be text';
      if (p.minLength && v.length < p.minLength) return `must be at least ${p.minLength} characters`;
      if (p.maxLength && v.length > p.maxLength) return `must be at most ${p.maxLength} characters`;
      return null;
    }
    case 'state': return /^[A-Z]{2}$/.test(String(v)) ? null : 'must be a 2-letter state code';
    case 'uuid': return isUuid(v) ? null : 'must be an id from a search result';
    case 'int': case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n) || (p.type === 'int' && !Number.isInteger(n))) return 'must be a number';
      if (p.min != null && n < p.min) return `must be at least ${p.min}`;
      if (p.max != null && n > p.max) return `must be at most ${p.max}`;
      return null;
    }
    case 'boolean': return typeof v === 'boolean' ? null : 'must be true or false';
    case 'string[]': return Array.isArray(v) ? null : 'must be a list';
    default: return null;
  }
}

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
  /* THE CONTRACT, BEFORE THE WIRE. A request the vendor would refuse is
     refused HERE instead — same reason code as every other unusable-input
     refusal, a sentence instead of the vendor's raw "-32602 Invalid
     arguments", and no slot of the shared hourly allowance spent on a call
     that could never succeed. */
  const malformed = contractProblem(name, args);
  if (malformed) return bad('bad_args', `Not sent: ${malformed}.`);
  let out;
  try {
    out = await client.callTool(name, args || {}, { staffId: opts.staffId || null });
  } catch (e) {
    // The client already promises not to throw; this is the belt to that
    // suspender, because a research lookup must never 500 a screen.
    out = bad('error', (e && e.message) || 'The lookup failed.');
  }
  /* A DRY RUN IS NOT AN EMPTY COUNTY. The client answers a dry run
     `{ok:true, data:null}`, which every research consumer read as "searched,
     found nothing" — so with the dry-run switch on, the screen told the owner
     "the county does not publish online" about a search that never left the
     building (owner-reported 2026-08-09). For RESEARCH purposes a dry run is
     a refusal with a reason, like disabled or rate-limited. */
  if (out && out.dryRun) {   // the transport already refuses; this keeps the door's own wording
    return bad('dry_run',
      'Dry-run mode is ON, so the lookup was logged but never sent. Turn dry-run OFF on the API Health page to really search.');
  }
  /* THE LEDGER IS WRITTEN BY THE CLIENT, not here. It is the only module that
     talks to Elementix, so it is the only one that should record — two writers
     would double-count the very number the hourly guard reads, and the guard
     would then throttle at half the real allowance. */
  return out;
}

/* ── the wrappers ─────────────────────────────────────────────────────────── */

/**
 * HOW AN ENTITY NAME IS COMPARED when the deterministic matcher cannot run:
 * case/punctuation-blind and corporate-suffix-blind ("LLC" ≡ "L.L.C." ≡
 * nothing — the same variants match_entity's own normalizer strips) but
 * ORDER-PRESERVING, because "MW TRADING" and "TRADING MW" are two different
 * companies, unlike a person's name, which counties reverse routinely
 * (`samePersonName` sorts; this must not). Under-matching is the safe
 * direction: a miss is a skip a human can act on, an over-match is somebody
 * else's deeds on this borrower's record — so jurisdictional boilerplate
 * ("A DELAWARE LLC") is deliberately NOT stripped.
 */
/* A trailing corporate form is stripped for the compare, but its FAMILY is
   remembered: "MW Trading" ≡ "MW Trading LLC" (the vendor's own with-or-
   without behavior), while "MW Trading INC" vs "MW Trading LLC" — two names
   BOTH stating a form, and different kinds of company — never match (audit
   2026-08-09: collapsing the forms entirely could stage a same-base-name
   stranger's corporation). CO/COMPANY/LTD are form-neutral in practice and
   decide nothing. '&' reads as AND so "S & G" ≡ "S AND G" — the same words,
   two spellings. */
const ENTITY_SUFFIX_FAMILY = {
  LLC: 'llc', PLLC: 'llc',
  INC: 'corp', CORP: 'corp', CORPORATION: 'corp', INCORPORATED: 'corp',
  LP: 'partnership', LLP: 'partnership',
  CO: null, COMPANY: null, LTD: null, LIMITED: null, PC: null,
};
function entityNameParts(v) {
  const words = str(v).toUpperCase().replace(/&/g, ' AND ').replace(/[.,'’`]/g, '')
    .replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  let family = null;
  while (words.length > 1 && Object.prototype.hasOwnProperty.call(ENTITY_SUFFIX_FAMILY, words[words.length - 1])) {
    family = ENTITY_SUFFIX_FAMILY[words.pop()] || family;
  }
  return { key: words.join(' '), family };
}
const entityNameKey = (v) => entityNameParts(v).key;
function sameEntityName(a, b) {
  const pa = entityNameParts(a); const pb = entityNameParts(b);
  if (!pa.key || pa.key !== pb.key) return false;
  if (pa.family && pb.family && pa.family !== pb.family) return false;
  return true;
}

/**
 * Find the ENTITY (a state-registered LLC or similar), never the rolled-up
 * parent COMPANY. The two are different object types and only an entity uuid
 * works with `get_entity_*` — see the header.
 *
 * WITH a state: `match_entity`, the deterministic one-or-nothing matcher.
 * The state is REQUIRED there — the vendor keys entities by (name, state),
 * and the same LLC name really is two different records in two states
 * (proven live 2026-08-09: "MW TRADING LLC" is one entity in NJ and another
 * in CA). Calling it without one is refused outright, which is exactly what
 * broke the owner's search on every company with no formation state on file.
 *
 * WITHOUT one: the vendor's own guidance for that case — `search` with
 * entityFilter:'entity' — kept only where the row's name IS ours (the live
 * capture returns "MW TRADING GROUP LLC" beside "MW TRADING LLC", and a near
 * name is a different company), same one-or-nothing rule. Several states
 * holding the same name come back `ambiguous` with `statesFound` naming
 * them, so the screen can ask the person to pick a state instead of
 * guessing.
 */
async function searchEntity(name, state, opts = {}) {
  const n = str(name);
  if (!n) return bad('bad_args', 'Say which company to look for.');
  const st = stateCode(state);

  if (st) {
    /* `entityFilter` BELONGS TO `search`, NOT TO `match_entity` — it is not a
       parameter of this tool. The entity-vs-company distinction the header
       warns about still matters on `search`; here the tool only ever matches
       entities. */
    const out = await call('match_entity', { name: n, state: st }, opts);
    if (!out.ok) return out;
    const rows = rowsOf(out.data);
    /* THE NAME IS `originalName`/`normalizedName`, NEVER `name`. A caller
       reading `.name` gets undefined and the promotion chokepoint then has
       nothing to match the borrower's typed company against. Normalised to
       `name` here so no consumer has to know. */
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

  const found = await call('search', { query: n, entityFilter: 'entity' }, opts);
  if (!found.ok) return found;
  const rows = rowsOf(found.data)
    /* An entity row can itself be a PERSON (a recorded party); this route is
       for companies. Dropped only on an explicit PERSON so a renamed vendor
       field can never silently empty the whole fallback. */
    .filter((r) => str(r.entityTypeValue).toUpperCase() !== 'PERSON')
    .filter((r) => sameEntityName(str(r.name) || str(r.searchText), n))
    .map((r) => ({
      ...r,
      name: str(r.name) || str(r.searchText) || null,
      _nameCommonness: nameCommonness(r),
      _tooCommon: nameTooCommon(r),
    }));
  return {
    ok: true,
    data: rows,
    matchStatus: null,
    ambiguous: rows.length > 1,
    statesFound: [...new Set(rows.map((r) => stateCode(r.state)).filter(Boolean))],
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

async function personDeeds(personId, opts = {}) {
  if (!isUuid(personId)) return bad('bad_args', 'That is not a person id from a search result.');
  return call('get_person_deeds', { id: personId, ...pageArgs(opts) }, opts);
}

async function personMortgages(personId, opts = {}) {
  if (!isUuid(personId)) return bad('bad_args', 'That is not a person id from a search result.');
  return call('get_person_mortgages', { id: personId, ...pageArgs(opts) }, opts);
}

/**
 * Find THE PERSON — with a name discipline stricter than the entity one,
 * because the failure mode is worse: an LLC name is distinctive, a person's
 * name is not, and a near-name here puts a STRANGER'S deeds on this
 * borrower's record.
 *
 * Two steps, verified live 2026-08-09: `match_person` is the vendor's exact
 * matcher and answers `none` even for names that appear on real deeds, so it
 * cannot be the only route; `search` with `entityFilter:'person'` finds
 * people but returns NEAR names too ("Frank Pereira" → "FRANKY PEREIRA" — a
 * different human). So the search fallback keeps ONLY rows whose name equals
 * ours word-for-word, order-blind ("KAMARA PATRICK" ≡ "PATRICK KAMARA" — the
 * county reverses names routinely), and a name the vendor scores too common
 * to identify anybody is refused the same way `searchEntity` refuses it.
 */
function samePersonName(a, b) {
  const words = (s) => str(s).toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(Boolean).sort();
  const wa = words(a); const wb = words(b);
  return wa.length > 0 && wa.length === wb.length && wa.every((w, i) => w === wb[i]);
}

async function searchPerson(name, state, opts = {}) {
  const n = str(name);
  if (!n) return bad('bad_args', 'Say whose name to look for.');
  const st = stateCode(state);
  let calls = 0;

  /* `match_person` REQUIRES the state — persons are keyed (name, state)
     exactly like entities. It used to be called without one anyway: the
     vendor refused it (-32602), the refusal was swallowed by the `exact.ok`
     test below, and one slot of the shared hourly allowance was spent on a
     call that could never succeed — on EVERY no-state person search. With no
     state it is simply skipped and the fuzzy route answers. */
  if (st) {
    const exact = await call('match_person', { name: n, state: st }, opts);
    calls += 1;
    if (exact.ok) {
      const hit = exact.data && exact.data.match;
      const id = hit && (hit.id || hit.personId || hit.uuid);
      if (isUuid(id)) {
        return { ok: true, calls, data: [{ ...hit, id, name: str(hit.name) || str(hit.normalizedName) || n }] };
      }
    }
  }

  const found = await call('search', {
    query: n, entityFilter: 'person', ...(st ? { state: st } : {}),
  }, opts);
  calls += 1;
  if (!found.ok) return { ...found, calls };
  const rows = rowsOf(found.data)
    .filter((r) => samePersonName(r.name || r.searchText, n))
    .map((r) => ({ ...r, _nameCommonness: nameCommonness(r), _tooCommon: nameTooCommon(r) }));
  return {
    ok: true, calls,
    data: rows,
    /* Two people with the exact same name in the same state is a human
       question — the same one-or-nothing rule as the entity route. */
    ambiguous: rows.length > 1,
  };
}

/**
 * THE PERSON-FIRST SEQUENCE — the records a borrower holds in their OWN name.
 *
 * Same contract as `researchProperty`: canonical shapes out, every failure in
 * `errors` with its reason, `searched` true only when a records list actually
 * came back, and `truncated` naming any list the vendor said has more pages —
 * a short answer must never read as a complete one.
 */
async function researchPerson({ personName, state, staffId, db }, opts = {}) {
  const o = { staffId, db, perPage: 100 };
  const out = {
    ok: true, calls: 0, errors: [], searched: false, truncated: [],
    deeds: [], mortgages: [], person: null, ambiguousPerson: false, tooCommon: false,
  };
  const note = (step, r) => { out.calls += stepCost(r); if (!r.ok) out.errors.push({ step, reason: r.reason, detail: r.detail }); return r; };

  const p = note('match_person', await searchPerson(personName, state, o));
  if (p.ok) {
    const rows = p.data || [];
    out.ambiguousPerson = !!p.ambiguous;
    out.tooCommon = rows.some((r) => r._tooCommon);
    out.person = rows.length === 1 && !out.tooCommon ? rows[0] : null;
  }
  const personId = out.person && (out.person.id || out.person.personId || out.person.uuid);
  if (isUuid(personId)) {
    const d = note('get_person_deeds', await personDeeds(personId, o));
    if (d.ok) {
      out.deeds = SHAPES.deeds(rowsOf(d.data)); out.searched = true;
      if (d.data && d.data.nextPage) out.truncated.push({ list: 'deeds', shown: out.deeds.length });
    }
    const m = note('get_person_mortgages', await personMortgages(personId, o));
    if (m.ok) {
      out.mortgages = SHAPES.mortgages(rowsOf(m.data)); out.searched = true;
      if (m.data && m.data.nextPage) out.truncated.push({ list: 'mortgages', shown: out.mortgages.length });
    }
  }
  return out;
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
 *
 * THE TYPE IS REQUIRED WITH THE ID, and the parameter is `id` — the vendor's
 * schema takes {type, id, include} and refuses anything else whole. The old
 * shape here ({documentId}) matched neither rule, so this wrapper could never
 * have completed a call. Every transaction row already states its own `type`
 * (deed / mortgage / satisfaction / …), so the caller always has it.
 */
/* Read from the contract, not restated — two lists that must move together
   is one list too many (audit 2026-08-09). */
const DOCUMENT_TYPES = (CONTRACTS.tools.get_document.params.type.enum || []).slice();
async function document(documentId, opts = {}) {
  if (!isUuid(documentId)) return bad('bad_args', 'That is not a document id from a transaction.');
  const type = str(opts.type).toLowerCase();
  if (!DOCUMENT_TYPES.includes(type)) {
    return bad('bad_args',
      'Say what kind of recorded document it is (the row\'s own `type`: deed, mortgage, satisfaction, …) — the records service requires the type with the id.');
  }
  return call('get_document', { type, id: documentId, include: opts.include || 'signers' }, opts);
}

/**
 * How complete are this county's records? Feeds the thin-coverage penalty, so
 * an absence in a badly-covered county is not read as an absence of fact.
 *
 * The vendor's coverage listing filters by STATE ONLY — `state` is an ARRAY
 * of codes and there is NO county parameter — so the county question is
 * answered by reading the state's rows (well past the biggest state's 254
 * counties) and picking the county HERE, never by sending a filter the
 * vendor would refuse.
 */
async function coverage(where, opts = {}) {
  const st = stateCode(where && where.state);
  const county = str(where && where.county);
  if (!st) return bad('bad_args', 'Say which state — the coverage listing is filtered by state.');
  const out = await call('get_coverage', { state: [st], perPage: 300 }, opts);
  if (!out.ok || !county) return out;
  const want = county.toLowerCase().replace(/\s+county$/, '').trim();
  return {
    ok: true,
    data: rowsOf(out.data).filter((r) => {
      const nm = str(r.countyName || r.county || r.countyState).toLowerCase();
      return !!want && nm.includes(want);
    }),
  };
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

/** What a research step actually SPENT. A `bad_args` refusal never reached the
 *  wire — the wrapper guards and the contract preflight both refuse before
 *  sending — so counting it would overstate `track_record_searches.api_calls`
 *  on exactly the passes the preflight exists to make free (audit 2026-08-09).
 *  A result that states its own `calls` is believed; anything else that went
 *  out is 1. */
const stepCost = (r) => (r && typeof r.calls === 'number' ? r.calls
  : (r && r.ok === false && r.reason === 'bad_args' ? 0 : 1));

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
  /* `perPage` IS LOAD-BEARING. Without it the vendor serves its DEFAULT PAGE
     OF FIVE (proven — see pageArgs), nothing here read `nextPage`, and a
     29-property portfolio read as five with no error anywhere: the exact
     "quietly returns 3 of 11" failure db/496's header promises never happens.
     100 is the vendor's page ceiling; anything past it is REPORTED in
     `truncated` so a short answer can never pass as a complete one. */
  const o = { staffId, db, perPage: 100 };
  const out = {
    ok: true, calls: 0, errors: [], searched: false, truncated: [],
    deeds: [], mortgages: [], satisfactions: [], ownerships: [], currentOwner: null, coverage: null,
    entity: null, people: [], ambiguousEntity: false, tooCommon: false,
  };
  const note = (step, r) => { out.calls += stepCost(r); if (!r.ok) out.errors.push({ step, reason: r.reason, detail: r.detail }); return r; };

  if (str(entityName)) {
    const e = note('match_entity', await searchEntity(entityName, state, o));
    if (e.ok) {
      const rows = e.data || [];
      out.ambiguousEntity = !!e.ambiguous;
      /* Which states hold this name — only ever set by the no-state fallback,
         and it is what lets the screen say "pick NJ or CA" instead of only
         "ambiguous". */
      if (Array.isArray(e.statesFound) && e.statesFound.length) out.entityStatesFound = e.statesFound;
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
    if (d.ok) {
      out.deeds = SHAPES.deeds(rowsOf(d.data)); out.searched = true;
      if (d.data && d.data.nextPage) out.truncated.push({ list: 'deeds', shown: out.deeds.length });
    }
    const m = note('get_entity_mortgages', await entityMortgages(entityId, o));
    if (m.ok) {
      out.mortgages = SHAPES.mortgages(rowsOf(m.data)); out.searched = true;
      if (m.data && m.data.nextPage) out.truncated.push({ list: 'mortgages', shown: out.mortgages.length });
    }
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
        if (t.data && t.data.nextPage) out.truncated.push({ list: 'transactions', shown: rowsOf(t.data).length });
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
  searchPerson,
  entityDeeds,
  entityMortgages,
  entityPeople,
  personDeeds,
  personMortgages,
  researchPerson,
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
  DOCUMENT_TYPES,
  _internals: { stateCode, isUuid, pageArgs, contractProblem, entityNameKey, sameEntityName },
};
