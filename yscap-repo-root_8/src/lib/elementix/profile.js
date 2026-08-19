'use strict';
/**
 * src/lib/elementix/profile.js — one person, every state, cached.
 *
 * ── WHAT THE OWNER ASKED FOR ────────────────────────────────────────────────
 * "A mega Elementix profile section on every CRM contact and every borrower
 * profile — the overview, the entities, the properties, the mortgages, the
 * deeds, the foreclosures, and ALL STATES TOGETHER. You can search, you can set
 * filters. Even better than Elementix."
 *
 * ── WHY "ALL STATES" IS A MERGE OF PERSON IDS, NOT A STATE FILTER ────────────
 * This was designed the wrong way round first, and the live schemas corrected
 * it. Elementix keys a person by (name, state), so one human is SEVERAL person
 * records: MOTY BRISK is a different id in NJ, in FL and in PA — proven, not
 * assumed (get_person_cross_state, 2026-08-18). And `get_person_properties` has
 * NO state parameter at all, so "narrow one person to one state" is not a thing
 * the vendor offers.
 *
 * So the merge happens over IDS: the canonical person plus every alias a HUMAN
 * has confirmed is the same human. Each id is fetched on its own and the reader
 * stitches them together. That is also why nothing here confirms an alias by
 * itself — see `syncCrossStateCandidates`.
 *
 * ── WHY BUILDING IS ALWAYS A DELIBERATE CLICK ───────────────────────────────
 * Elementix allows 1,000 requests an hour ACROSS THE WHOLE ORGANISATION — every
 * officer, every tool, one shared bucket. A full profile is roughly eight calls
 * per person id, so three linked states is ~24. Sweeping that automatically
 * over a CRM would spend the office's entire allowance on screens nobody asked
 * for. Every build therefore requires a `staffId` and comes from a person
 * pressing Run a search or Refresh data; `readProfile` serves the cache and
 * never calls the vendor.
 *
 * ── HONESTY RULES THIS MODULE KEEPS ─────────────────────────────────────────
 *  · A section that FAILED writes a row saying so. A screen re-reading the
 *    cache must never turn "the vendor refused" into "0 mortgages".
 *  · A section we could not vouch for carries `unverified` from crm-tools.
 *  · Nothing is capped silently: a page limit or an exhausted call budget comes
 *    back as `truncated` with the reason, so the screen says "showing the first
 *    N" instead of implying it has everything.
 *  · A count is null when unknown, never 0. "(not read)" and "none" are
 *    different answers and only one of them is safe to print.
 */

const db = require('../../db');
const crmTools = require('./crm-tools');
const crm = require('./crm');
const CONTRACTS = require('./request-contracts.json');

const str = (v) => String(v == null ? '' : v).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));

/** A number, or null. NEVER 0 for a missing value — see the header. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// THE SECTIONS — one table, and the only place a profile tab is defined.
//
// Every `rowsKey` here was READ OFF A LIVE RESPONSE on 2026-08-18, not inferred.
// That matters: `get_person_lender_network` puts its rows under
// `lenderConnections`, which the shared `rowsOf` does not recognise, so guessing
// would have rendered a person with seventy lenders as having none — silently,
// with no error anywhere. Adding a tab means calling the tool once, recording
// its response in scripts/fixtures/elementix-shapes.json, and adding a row here.
// ---------------------------------------------------------------------------
const SECTIONS = [
  {
    key: 'overview', label: 'Overview', tool: 'get_person',
    single: true, rowsKey: null, objectKey: 'person',
    note: 'The header. One call, and it carries the counts and the exposure the person page leads with.',
  },
  {
    key: 'entities', label: 'Entities', tool: 'get_person_entities',
    rowsKey: 'data', paged: true,
    // The ONLY section that needs its own count call: get_person reports
    // mortgage/deed/property/foreclosure counts but NOT an entity count, and the
    // data call carries no total. One extra call buys the "295 entities" tile.
    countCall: true,
  },
  { key: 'properties',   label: 'Properties',   tool: 'get_person_properties', rowsKey: 'data', paged: true },
  { key: 'mortgages',    label: 'Mortgages',    tool: 'get_person_mortgages',  rowsKey: 'data', paged: true },
  { key: 'deeds',        label: 'Deeds',        tool: 'get_person_deeds',      rowsKey: 'data', paged: true },
  {
    key: 'foreclosures', label: 'Foreclosures', tool: 'get_person_mortgages',
    rowsKey: 'data', paged: true, args: { hasForeclosure: true },
    // NOT list_transactions. That tool reaches preforeclosures but has no person
    // parameter — it narrows to a person only by a PARTIAL NAME match, which is
    // the guess this whole module refuses to make. hasForeclosure on the
    // person's own mortgages is keyed on the id and cannot pick up a stranger.
  },
  { key: 'associated_people', label: 'Associated people', tool: 'get_person_associated_people', rowsKey: 'data', paged: true },
  { key: 'lender_network',    label: 'Lenders',           tool: 'get_person_lender_network',    rowsKey: 'lenderConnections', single: true },
  { key: 'cross_state',       label: 'Other states',      tool: 'get_person_cross_state',       rowsKey: 'data', paged: true },
  {
    key: 'transactions', label: 'All transactions', tool: 'list_transactions',
    available: false,
    unavailableReason: 'The vendor’s transaction feed cannot be narrowed to a person — it matches a name as free text, which would pull in strangers who share the name. Everything it would show for this person is already on the deeds, mortgages and foreclosures tabs, keyed on their own id.',
  },
];

const BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));
const DEFAULT_SECTIONS = SECTIONS.filter((s) => s.available !== false).map((s) => s.key);

/* Page size. Deliberately NOT lookups.pageArgs, whose 100 is the underwriting
   plane's own choice: there a run is one property and small pages keep a
   research pass cheap. Here a tab is 829 properties and every extra page is
   another slot out of the office's shared hourly allowance, so a bigger page is
   the cheaper answer. The ceiling is read from the tool's OWN transcribed
   contract rather than typed here, so it cannot drift from what the vendor
   accepts. */
const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const CALL_BUDGET = 40;
const FRESH_HOURS = 24;

function perPageFor(tool, want = PAGE_SIZE) {
  const p = CONTRACTS.tools[tool] && CONTRACTS.tools[tool].params && CONTRACTS.tools[tool].params.perPage;
  const max = (p && Number(p.max)) || 100;
  const min = (p && Number(p.min)) || 1;
  return Math.min(Math.max(want, min), max);
}

/**
 * The rows out of a response, using the envelope key this section was OBSERVED
 * to use. Falls back to the shared reader only when a section declares none, so
 * a tab added without capturing its response still stands a chance instead of
 * failing outright.
 */
function rowsFrom(section, data) {
  if (section.rowsKey && data && typeof data === 'object' && Array.isArray(data[section.rowsKey])) {
    return data[section.rowsKey];
  }
  return crmTools.rowsOf(data);
}

/**
 * Drop the vendor's inline lender logos before anything is stored.
 *
 * `_logoDataUri` is a base64 JPEG — 8 to 12 KB EACH — carried on every lender
 * row and on the `topLenders[]` nested inside person rows. A person's lender
 * tab is seventy lenders, so keeping them would put the better part of a
 * megabyte of pictures inside one jsonb row, and the profile would be paying to
 * store and re-read them on every page load. Nothing on the screen uses them.
 *
 * Recursive because they are nested; bounded in depth so a self-referencing
 * payload cannot spin.
 */
const HEAVY_KEYS = new Set(['_logoDataUri', '_logoDataURI', 'logoDataUri']);
function stripHeavy(v, depth = 0) {
  if (depth > 6 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => stripHeavy(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (HEAVY_KEYS.has(k)) continue;
    out[k] = (val && typeof val === 'object') ? stripHeavy(val, depth + 1) : val;
  }
  return out;
}

/** The singular object a header-style tool answers with (`{person:{...}}`). */
function objectFrom(section, data) {
  if (!data || typeof data !== 'object') return null;
  const k = section.objectKey;
  if (k && data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) return data[k];
  return null;
}

/* `nextPage` IS NOT A "THERE IS MORE" SIGNAL, and reading it as one was wrong.
   Measured 2026-08-18: the vendor emits it whenever the page came back FULL —
   `list_entities` with exactly one matching row and perPage:1 returns
   `nextPage:2` while `scope:'count'` says the total is 1. So it means "ask
   again", not "there is more", and trusting it marks a complete section as
   truncated.
   A full page is therefore only a SUSPICION, and the suspicion is settled by
   one `scope:'count'` call — which also turns "showing the first 250" into
   "showing the first 250 of 829". A data call carries no total of its own. */
const looksFull = (d, rows, perPage) => !!(d && typeof d === 'object'
  && d.nextPage != null && d.nextPage !== false && rows.length >= perPage);

/**
 * The person's own roll-up, read from `get_person`'s object.
 *
 * Every field name here came off a live response (MOTY BRISK / NJ) and every one
 * of them matched the owner's screenshot: 349 mortgages, 602 deeds, 829
 * properties, 3 foreclosures, $197,839,792.86 of exposure. `currentExposure`
 * arrives as a DECIMAL STRING, not a number.
 *
 * Anything absent stays null. A profile that says "we have not read this" is
 * useful; one that says "0" about a number it never saw is a lie a person acts
 * on.
 */
function overviewFacts(person, stats) {
  if (!person || typeof person !== 'object') return null;
  const st = stats && typeof stats === 'object' ? stats : {};
  return {
    /* From `list_people` — absent when that second call did not land, and null
       rather than zero so a screen never prints a figure nobody read. */
    mailingAddress: str(st.mailingAddress) || null,
    previousExits3y: num(st.previousExits3y),
    yearsActive: num(st.yearsActive),
    firstLoanDate: st.firstLoanDate || null,
    loanCount: num(st.loanCount),
    totalVolume: num(st.totalVolume),
    averageLoanSize: num(st.averageLoanSize),
    shortTermLoanPct: num(st.shortTermLoanPct),
    longTermLoanPct: num(st.longTermLoanPct),
    mostFrequentCity: str(st.mostFrequentMortgageCity) || null,
    mostFrequentCounty: str(st.mostFrequentMortgageCounty) || null,
    // The vendor's own warning that this "person" may be a closing attorney or a
    // title clerk who appears on hundreds of files. Worth showing before an
    // officer telephones them about a loan.
    likelyAttorneyOrTitle: st.isAttorneyOrTitleAgent === true,
    likelySupportStaff: st.isLikelySupportStaff === true,
    unlockedBy: str(st.unlockedBy) || null,
    unlockedAt: st.unlockedAt || null,
    entityRoster: Array.isArray(st.entities) ? st.entities.length : null,
    id: str(person.id) || null,
    name: str(person.name) || null,
    state: str(person.state).toUpperCase() || null,
    mortgages: num(person.mortgageCount),
    deeds: num(person.deedCount),
    satisfactions: num(person.satisfactionCount),
    // ownershipRecordCount is the 829 on the screenshot (every ownership record);
    // ownershipCount is the 222 they hold TODAY. Two different questions.
    properties: num(person.ownershipRecordCount),
    propertiesCurrent: num(person.ownershipCount),
    foreclosures: num(person.preforeclosureCount),
    aliases: num(person.aliasCount),
    exposure: num(person.currentExposure),
    recentMortgages: { m3: num(person.linkedMortgageCount3Mo), m6: num(person.linkedMortgageCount6Mo), m12: num(person.linkedMortgageCount12Mo) },
    firstLenderDates: {
      any: person.firstAnyLenderDate || null,
      bank: person.firstBankDate || null,
      creditUnion: person.firstCreditUnionDate || null,
      mortgageBanker: person.firstMortgageBankerDate || null,
      privateMoney: person.firstPrivateMoneyDate || null,
      agency: person.firstAgencyDate || null,
      insuranceCompany: person.firstInsuranceCompanyDate || null,
      debtFund: person.firstDebtFundDate || null,
      servicer: person.firstServicerDate || null,
      government: person.firstGovernmentLenderDate || null,
    },
    // 0 = a rare name, so a cross-state namesake is probably the same human;
    // a high score is the vendor telling us NOT to trust a name match.
    nameCommonness: num(person.nameCommonnessScore),
  };
}

// ---------------------------------------------------------------------------
// THE FAMILY — which person ids make up this one human
// ---------------------------------------------------------------------------

/**
 * The canonical id plus every alias a HUMAN confirmed. Nothing else.
 *
 * `get_person_cross_state` matches on the EXACT NAME and nothing else — the
 * vendor's own schema says so — so a row it returns is evidence of a shared
 * name and of literally nothing else. Adopting one automatically would merge a
 * stranger's 829 properties into a borrower's profile, which is the single most
 * expensive mistake this feature could make. A candidate therefore waits in
 * `elementix_person_aliases` until somebody says yes.
 */
async function familyOf(personId, client = db) {
  const id = str(personId);
  if (!isUuid(id)) return [];
  const canonical = await canonicalOf(id, client);
  const { rows } = await client.query(
    `SELECT alias_person_id FROM elementix_person_aliases
      WHERE person_id = $1 AND confirmed_at IS NOT NULL AND rejected_at IS NULL
      ORDER BY alias_person_id`, [canonical]);
  const out = [canonical];
  for (const r of rows) if (isUuid(r.alias_person_id) && !out.includes(r.alias_person_id)) out.push(r.alias_person_id);
  if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Which id is the HEAD of this person's family.
 *
 * A confirmed link also stamps `elementix_persons.primary_person_id` on the
 * alias, so landing on the FL record shows the same merged profile as landing
 * on the NJ one — the owner asked for ONE profile, and which record a lead
 * happens to be linked to is an accident of who searched first.
 *
 * ONE HOP ONLY, deliberately. Following a chain would let two confirmations
 * made in opposite directions point at each other and loop forever; refusing to
 * chain means the worst case is a profile that is merely incomplete, which a
 * person can see and fix.
 */
async function canonicalOf(personId, client = db) {
  const id = str(personId);
  if (!isUuid(id)) return id;
  const { rows } = await client.query(
    `SELECT primary_person_id FROM elementix_persons WHERE person_id = $1`, [id]);
  const head = rows[0] && str(rows[0].primary_person_id);
  return head && isUuid(head) && head !== id ? head : id;
}

/** Record cross-state rows as CANDIDATES. Never confirmed, never rejected. */
async function syncCrossStateCandidates(personId, rows, client = db) {
  let added = 0;
  for (const r of (rows || [])) {
    const aliasId = str(r && r.id);
    if (!isUuid(aliasId) || aliasId === personId) continue;
    const res = await client.query(
      `INSERT INTO elementix_person_aliases (person_id, alias_person_id, alias_state, alias_name, origin)
       VALUES ($1,$2,$3,$4,'vendor_cross_state')
       ON CONFLICT (person_id, alias_person_id) DO NOTHING`,
      [personId, aliasId, str(r.state).toUpperCase().slice(0, 2) || null, str(r.name).slice(0, 300) || null]);
    added += res.rowCount || 0;
  }
  return added;
}

/**
 * A human says yes (or no) to a cross-state candidate.
 *
 * This is the one act that merges two people's records into one profile, so it
 * is a signed-in decision and nothing else in this module ever performs it.
 */
async function decideAlias({ personId, aliasPersonId, staffId, confirm }, client = db) {
  if (!isUuid(personId) || !isUuid(aliasPersonId)) {
    return { ok: false, reason: 'bad_args', detail: 'That is not a person from a search result.' };
  }
  if (!staffId) return { ok: false, reason: 'no_actor', detail: 'Linking two records is a decision, so it has to be made by a signed-in member of staff.' };
  // Link onto the HEAD of the family, never onto an alias — otherwise a second
  // confirmation builds a chain the one-hop resolver cannot follow.
  const head = await canonicalOf(personId, client);
  if (head === aliasPersonId) {
    return { ok: false, reason: 'bad_args', detail: 'That is the same record — there is nothing to link it to.' };
  }
  /* THE OTHER RECORD HAS TO BE ONE WE HAVE ACTUALLY SEEN.
     A well-formed UUID was enough to get this far, and everything below then
     WROTE: an alias row, and — through ensurePersonRow — a brand-new header row
     for a person who may not exist in Elementix at all. One mistyped id left a
     nameless phantom person permanently attached to a real one, offered on the
     screen forever, with no way to tell it from a real record.
     Two things count as "seen": a candidate PILOT itself put in front of
     somebody (the cross-state rows the profile build writes), or a person we
     already hold a header for. A confirmation is a judgement about two records
     that exist, never a way to invent the second one. */
  const known = await client.query(
    `SELECT EXISTS (SELECT 1 FROM elementix_person_aliases
                     WHERE person_id = $1 AND alias_person_id = $2) AS offered,
            EXISTS (SELECT 1 FROM elementix_persons WHERE person_id = $2) AS held`,
    [head, aliasPersonId]);
  const k = known.rows[0] || {};
  if (!k.offered && !k.held) {
    return { ok: false, reason: 'not_found',
      detail: 'PILOT has no record of that Elementix person, so there is nothing to join. Refresh the profile and pick one of the records it offers.' };
  }
  // The columns are chosen from a boolean, never from anything a caller typed.
  const col = confirm ? 'confirmed' : 'rejected';
  const other = confirm ? 'rejected' : 'confirmed';
  const { rowCount } = await client.query(
    `INSERT INTO elementix_person_aliases (person_id, alias_person_id, origin, ${col}_by, ${col}_at)
     VALUES ($1,$2,'manual',$3,now())
     ON CONFLICT (person_id, alias_person_id) DO UPDATE
        SET ${col}_by = $3, ${col}_at = now(), ${other}_by = NULL, ${other}_at = NULL`,
    [head, aliasPersonId, staffId]);

  await ensurePersonRow(aliasPersonId, {}, client);
  if (confirm) {
    // Only ever point an alias at a record that is itself a head, so the graph
    // stays one level deep and `canonicalOf` never has to chase a chain.
    await client.query(
      `UPDATE elementix_persons SET primary_person_id = $2, updated_at = now()
        WHERE person_id = $1
          AND person_id <> $2
          AND primary_person_id IS DISTINCT FROM $2
          AND EXISTS (SELECT 1 FROM elementix_persons h WHERE h.person_id = $2 AND h.primary_person_id IS NULL)`,
      [aliasPersonId, head]);
  } else {
    await client.query(
      `UPDATE elementix_persons SET primary_person_id = NULL, updated_at = now()
        WHERE person_id = $1 AND primary_person_id = $2`, [aliasPersonId, head]);
  }
  return { ok: true, changed: rowCount || 0, confirmed: !!confirm, head };
}

// ---------------------------------------------------------------------------
// BUILDING
// ---------------------------------------------------------------------------

/**
 * Make sure the person row exists so a section can hang off it (FK).
 *
 * DELEGATES to `crm.ensurePerson` — the one writer of that table. This used to
 * be a second copy of the same upsert whose only difference was that a fresh
 * name overwrote a stored one, so a person's displayed name depended on which
 * module wrote last. `authoritative: true` keeps that behaviour where it is
 * actually earned: the profile build holds the vendor's own record of the
 * person, not a row off a search hit.
 */
async function ensurePersonRow(personId, { name, state } = {}, client = db) {
  await crm.ensurePerson({
    personId,
    name: name ? str(name).slice(0, 300) : null,
    state: state ? str(state).toUpperCase().slice(0, 2) : null,
    authoritative: true,
    client,
  });
}

/* The section row's `state` is deliberately ALWAYS ''. The person id already IS
   the state-scoped record (Elementix keys a person by name+state), so the state
   belongs on elementix_persons — and putting it in the section key would let one
   source grow a SECOND row for the same section the day its state became known,
   leaving a stale copy behind to be merged in twice. The column stays for a
   future section that genuinely is filtered by state. */
const SECTION_STATE = '';

async function writeSection(personId, section, out, client = db) {
  await client.query(
    `INSERT INTO elementix_person_sections
       (person_id, section, state, payload, row_count, truncated, fetched_at, calls_spent, last_error, unverified)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,now(),$7,$8,$9)
     ON CONFLICT (person_id, section, state) DO UPDATE
        SET payload = EXCLUDED.payload, row_count = EXCLUDED.row_count,
            truncated = EXCLUDED.truncated, fetched_at = EXCLUDED.fetched_at,
            calls_spent = EXCLUDED.calls_spent, last_error = EXCLUDED.last_error,
            unverified = EXCLUDED.unverified`,
    [personId, section.key, SECTION_STATE,
      out.payload === undefined || out.payload === null ? null : crmTools.vendorJsonb(out.payload),
      out.rowCount == null ? null : out.rowCount,
      !!out.truncated, out.calls || 0, out.error || null, !!out.unverified]);
}

/**
 * THE SECOND HALF OF THE HEADER — `list_people` narrowed to this one person.
 *
 * Probing the whole catalogue turned this up as the single richest call for a
 * person profile, and it is one request: it adds their MAILING ADDRESS (a real
 * contact address, not a property), `previousExits3y` — completed projects in
 * the last three years, which is a track record in one number — `yearsActive`,
 * `firstLoanDate`, `averageLoanSize`, `totalVolume`, the short/long-term split,
 * where they most often borrow, the vendor's own "this is probably an attorney
 * or support staff" flags, AND the whole entities roster inline.
 *
 * It also carries `unlockedBy`/`unlockedAt`, so the profile can say who on the
 * team looked this person up without a separate call.
 *
 * THE RESULT IS SLICED TO THE ID WE ASKED FOR. `list_people`'s own personIds
 * filter behaved correctly when measured, but its sibling `list_entities` PADS
 * a filtered page with unrelated rows to fill it — so trusting a filtered list
 * to contain only what was asked for is a habit worth not having.
 */
async function enrichOverview({ personId, staffId, budget }) {
  if (budget.left <= 0) return null;
  budget.left -= 1; budget.spent += 1;
  const res = await crmTools.call('list_people', { personIds: [personId], perPage: 5 }, { staffId });
  if (!res || res.ok !== true) return null;
  const row = crmTools.rowsOf(res.data).find((r) => r && str(r.id) === personId);
  return row ? stripHeavy(row) : null;
}

/**
 * Fetch ONE section for ONE person id. Never throws — the transport already
 * guarantees that, and every refusal added here is a shaped object too.
 *
 * `budget` is a live counter object shared across the whole build so a person
 * with an enormous portfolio cannot quietly drain the office's hourly
 * allowance; running out is reported, never hidden.
 */
async function fetchSection({ personId, section, staffId, budget, maxPages }) {
  const spend = () => { budget.left -= 1; budget.spent += 1; };
  const base = { id: personId, ...(section.args || {}) };
  let calls = 0;
  let unverified = false;

  if (section.single) {
    if (budget.left <= 0) return { skipped: 'budget' };
    spend(); calls += 1;
    const res = await crmTools.call(section.tool, base, { staffId });
    unverified = !!(res && res.unverified);
    if (!res || res.ok !== true) {
      return { calls, unverified, error: (res && res.detail) || 'Elementix did not answer.', reason: (res && res.reason) || 'failed' };
    }
    const obj = stripHeavy(objectFrom(section, res.data));
    const rows = stripHeavy(section.rowsKey ? rowsFrom(section, res.data) : []);
    // `raw` is kept ONLY when neither reader recognised anything — the one case
    // where a screen has nothing to show and somebody has to see what the vendor
    // actually sent. Keeping it otherwise would store the whole response twice.
    const parsed = !!obj || rows.length > 0;
    // The header is worth a second call: see enrichOverview.
    let stats = null;
    if (section.key === 'overview' && obj) {
      stats = await enrichOverview({ personId, staffId, budget });
      if (stats) calls += 1;
    }
    return {
      calls, unverified,
      payload: {
        object: obj, rows, stats,
        total: section.rowsKey ? rows.length : null,
        ...(parsed ? {} : { raw: res.data }),
      },
      rowCount: section.rowsKey ? rows.length : (obj ? 1 : 0),
      truncated: false,
    };
  }

  const perPage = perPageFor(section.tool);
  const rows = [];
  let more = false;
  let firstError = null;
  const pages = Math.max(1, maxPages || MAX_PAGES);

  for (let page = 1; page <= pages; page++) {
    if (budget.left <= 0) { more = true; break; }
    spend(); calls += 1;
    const res = await crmTools.call(section.tool, { ...base, page, perPage }, { staffId });
    if (res && res.unverified) unverified = true;
    if (!res || res.ok !== true) {
      // A first-page failure is a failed section. A LATER page failing still
      // leaves real rows on the screen, so it degrades to "there is more we
      // could not reach" rather than throwing the good pages away.
      if (page === 1) return { calls, unverified, error: (res && res.detail) || 'Elementix did not answer.', reason: (res && res.reason) || 'failed' };
      firstError = (res && res.detail) || 'Elementix stopped answering part way through.';
      more = true;
      break;
    }
    const pageRows = rowsFrom(section, res.data);
    rows.push(...stripHeavy(pageRows));
    more = looksFull(res.data, pageRows, perPage);
    if (!more) break;
    if (page === pages) break; // a full last page → ask the count below
  }

  /* Size it for real when the pages ran out on a full page, or when the section
     always wants a headline count. One call, and it is the difference between
     "showing the first 250" and "showing the first 250 of 829" — and between
     claiming truncation and knowing it. */
  let total = null;
  if ((section.countCall || more) && budget.left > 0) {
    spend(); calls += 1;
    const c = await crmTools.call(section.tool, { ...base, scope: 'count' }, { staffId });
    if (c && c.ok === true) total = crmTools.totalOf(c.data);
  }

  return {
    calls, unverified,
    payload: { rows, total, partialError: firstError || undefined },
    rowCount: rows.length,
    // A KNOWN total settles it outright; without one, a full final page is only
    // a suspicion and is reported as such rather than as a fact.
    truncated: total != null ? total > rows.length : more,
  };
}

/**
 * Build (or refresh) a person's profile.
 *
 * ALWAYS A DELIBERATE CLICK — `staffId` is required, and there is no sweep
 * anywhere that calls this. See the header for why.
 */
async function buildProfile(personId, opts = {}) {
  const client = opts.client || db;
  const id = str(personId);
  if (!isUuid(id)) return { ok: false, reason: 'bad_args', detail: 'That is not a person from an Elementix search result.' };
  if (!opts.staffId) return { ok: false, reason: 'no_actor', detail: 'Reading a full Elementix profile has to be done by a signed-in member of staff.' };

  const wanted = (Array.isArray(opts.sections) && opts.sections.length ? opts.sections : DEFAULT_SECTIONS)
    .map((k) => BY_KEY.get(k)).filter((s) => s && s.available !== false);
  if (!wanted.length) return { ok: false, reason: 'bad_args', detail: 'No profile section was asked for.' };

  const family = opts.family || await familyOf(id, client);
  const budget = { left: Number(opts.callBudget) > 0 ? Number(opts.callBudget) : CALL_BUDGET, spent: 0 };
  const freshMs = (Number(opts.freshHours) >= 0 ? Number(opts.freshHours) : FRESH_HOURS) * 3600 * 1000;
  const force = !!opts.force;

  // What is already cached and still fresh, so a re-open of a screen costs
  // nothing. A section that FAILED is always retried: a stale error is not
  // information worth preserving, and the person clicked.
  const { rows: cached } = await client.query(
    `SELECT person_id, section, fetched_at, last_error
       FROM elementix_person_sections
      WHERE person_id = ANY($1::text[]) AND state = $2`, [family, SECTION_STATE]);
  const freshAt = new Map();
  for (const r of cached) if (!r.last_error) freshAt.set(`${r.person_id}:${r.section}`, r.fetched_at);

  const results = [];
  let lastError = null;

  for (const source of family) {
    await ensurePersonRow(source, {}, client);
    for (const section of wanted) {
      const key = `${source}:${section.key}`;
      const at = freshAt.get(key);
      if (!force && at && (Date.now() - new Date(at).getTime()) < freshMs) {
        results.push({ personId: source, section: section.key, status: 'cached', fetchedAt: at });
        continue;
      }
      if (budget.left <= 0) {
        results.push({ personId: source, section: section.key, status: 'skipped', reason: 'budget',
          detail: 'The hourly allowance this profile was given ran out before this section. Press Refresh again to carry on.' });
        continue;
      }
      const out = await fetchSection({ personId: source, section, staffId: opts.staffId, budget, maxPages: opts.maxPages });
      if (out.skipped) {
        results.push({ personId: source, section: section.key, status: 'skipped', reason: out.skipped });
        continue;
      }
      await writeSection(source, section, out, client);
      if (out.error) {
        lastError = out.error;
        results.push({ personId: source, section: section.key, status: 'error', detail: out.error, unverified: !!out.unverified, calls: out.calls });
        continue;
      }
      results.push({ personId: source, section: section.key, status: 'ok', rows: out.rowCount, truncated: !!out.truncated, unverified: !!out.unverified, calls: out.calls });

      // Side effects of two particular sections, done here so the reader stays
      // a pure read.
      if (section.key === 'overview') {
        const facts = overviewFacts(out.payload && out.payload.object, out.payload && out.payload.stats);
        if (facts) await ensurePersonRow(source, { name: facts.name, state: facts.state }, client);
      }
      if (section.key === 'cross_state' && out.payload && Array.isArray(out.payload.rows)) {
        await syncCrossStateCandidates(source, out.payload.rows, client);
      }
    }
  }

  await client.query(
    `UPDATE elementix_persons
        SET refreshed_at = now(), refreshed_by = $2,
            last_error = $3, last_error_at = CASE WHEN $3::text IS NULL THEN last_error_at ELSE now() END,
            updated_at = now()
      WHERE person_id = $1`, [id, opts.staffId, lastError]);

  return { ok: true, personId: id, family, callsSpent: budget.spent, budgetLeft: budget.left, sections: results };
}

// ---------------------------------------------------------------------------
// READING — the cache only. Never calls Elementix.
// ---------------------------------------------------------------------------

/* Deduping across sources. The same recorded deed can legitimately appear under
   two person ids once a human links them, so a row is folded away only when the
   vendor gave it an id we can compare. A row with NO id is KEPT: showing a
   duplicate is a blemish, dropping a real property is a lie. */
function rowKey(row) {
  if (!row || typeof row !== 'object') return null;
  for (const k of ['id', 'transactionId', 'mortgageId', 'deedId', 'addressId', 'entityId', 'personId']) {
    const v = str(row[k]);
    if (v) return `${k}:${v}`;
  }
  return null;
}

/**
 * The whole profile, merged across the family, out of the cache.
 *
 * Every section reports its own STATUS, because "we have not read this yet",
 * "the vendor refused" and "there is genuinely nothing" are three different
 * answers and a screen that prints the same empty tab for all three is the bug
 * this module exists to avoid.
 */
async function readProfile(personId, opts = {}) {
  const client = opts.client || db;
  const id = str(personId);
  if (!isUuid(id)) return { ok: false, reason: 'bad_args', detail: 'That is not a person from an Elementix search result.' };

  const family = await familyOf(id, client);
  const { rows: people } = await client.query(
    `SELECT person_id, display_name, primary_state, states, refreshed_at, refreshed_by, last_error, last_error_at, first_seen_at
       FROM elementix_persons WHERE person_id = ANY($1::text[])`, [family]);
  const byId = new Map(people.map((p) => [p.person_id, p]));
  const self = byId.get(id) || null;

  const { rows: secRows } = await client.query(
    `SELECT person_id, section, payload, row_count, truncated, fetched_at, calls_spent, last_error, unverified
       FROM elementix_person_sections
      WHERE person_id = ANY($1::text[]) AND state = $2`, [family, SECTION_STATE]);

  const sections = {};
  for (const def of SECTIONS) {
    if (def.available === false) {
      sections[def.key] = { key: def.key, label: def.label, status: 'unavailable', detail: def.unavailableReason, rows: [], sources: [] };
      continue;
    }
    const mine = secRows.filter((r) => r.section === def.key);
    const sources = [];
    const rows = [];
    const seen = new Set();
    let truncated = false; let unverified = false; let total = null; let anyOk = false; let anyErr = false;

    for (const r of mine) {
      const p = byId.get(r.person_id) || {};
      const payload = r.payload || {};
      const src = {
        personId: r.person_id,
        state: p.primary_state || (payload.object && str(payload.object.state).toUpperCase()) || null,
        name: p.display_name || (payload.object && payload.object.name) || null,
        fetchedAt: r.fetched_at,
        rowCount: r.row_count,
        total: num(payload.total),
        truncated: !!r.truncated,
        unverified: !!r.unverified,
        error: r.last_error || null,
        partialError: payload.partialError || null,
        object: payload.object || null,
        stats: payload.stats || null,
        callsSpent: r.calls_spent,
      };
      sources.push(src);
      if (r.last_error) { anyErr = true; continue; }
      anyOk = true;
      if (r.truncated) truncated = true;
      if (r.unverified) unverified = true;
      if (src.total != null) total = (total || 0) + src.total;
      for (const row of (Array.isArray(payload.rows) ? payload.rows : [])) {
        const k = rowKey(row);
        if (k) { if (seen.has(k)) continue; seen.add(k); }
        rows.push({ ...row, _source: { personId: r.person_id, state: src.state } });
      }
    }

    let status = 'not_loaded';
    if (anyOk && anyErr) status = 'partial';
    else if (anyOk) status = 'ok';
    else if (anyErr) status = 'error';

    sections[def.key] = {
      key: def.key, label: def.label, status, rows, rowCount: rows.length,
      total, truncated, unverified, sources,
      detail: status === 'error' ? (sources.find((s) => s.error) || {}).error || null : null,
    };
  }

  // The headline numbers come from the vendor's OWN roll-up (get_person), summed
  // across the confirmed family — not from counting the rows we happened to
  // fetch, which is a page of them.
  const byState = [];
  /* NULL UNTIL A SOURCE ACTUALLY SAYS A NUMBER. Starting at 0 makes a figure the
     vendor never sent render as a confident "Mortgages 0 · Owed today $0" at the
     very top of the screen — about a real investor, above the per-state cards
     that correctly say "—". That is the confident zero this whole plane is
     written to refuse, and it is the same failure as the seventy lenders that
     read as none until the row key was measured. `count()` and `money()` on the
     screen already render null as a dash. */
  const counts = { mortgages: null, deeds: null, satisfactions: null, properties: null, propertiesCurrent: null, foreclosures: null };
  let exposure = null;
  let complete = true;
  for (const src of sections.overview.sources) {
    const facts = overviewFacts(src.object, src.stats);
    if (!facts) { complete = false; byState.push({ personId: src.personId, state: src.state, name: src.name, facts: null }); continue; }
    byState.push({ personId: src.personId, state: facts.state || src.state, name: facts.name || src.name, facts });
    for (const k of Object.keys(counts)) {
      if (facts[k] == null) complete = false; else counts[k] = (counts[k] || 0) + facts[k];
    }
    if (facts.exposure == null) complete = false; else exposure = (exposure || 0) + facts.exposure;
  }
  const overviewRead = sections.overview.sources.some((s) => !s.error);
  const entityTotal = sections.entities.total != null ? sections.entities.total
    : (sections.entities.status === 'ok' && !sections.entities.truncated ? sections.entities.rowCount : null);

  return {
    ok: true,
    personId: id,
    family,
    person: self ? {
      personId: self.person_id, name: self.display_name, state: self.primary_state,
      states: self.states || [], refreshedAt: self.refreshed_at, refreshedBy: self.refreshed_by,
      lastError: self.last_error, lastErrorAt: self.last_error_at, firstSeenAt: self.first_seen_at,
    } : null,
    // `null` where nothing has been read, so a tile prints "—" rather than 0.
    summary: {
      counts: overviewRead ? { ...counts, entities: entityTotal } : { mortgages: null, deeds: null, satisfactions: null, properties: null, propertiesCurrent: null, foreclosures: null, entities: entityTotal },
      exposure: overviewRead ? exposure : null,
      complete: overviewRead && complete,
      states: byState.map((b) => b.state).filter(Boolean),
      byState,
    },
    sections,
    loaded: Object.values(sections).some((s) => s.status === 'ok' || s.status === 'partial'),
  };
}

/** Cross-state candidates a human has not decided on yet. */
async function openAliasCandidates(personId, client = db) {
  const id = str(personId);
  if (!isUuid(id)) return [];
  const { rows } = await client.query(
    `SELECT a.alias_person_id, a.alias_state, a.alias_name, a.origin, a.created_at,
            p.display_name, p.primary_state
       FROM elementix_person_aliases a
       LEFT JOIN elementix_persons p ON p.person_id = a.alias_person_id
      WHERE a.person_id = $1 AND a.confirmed_at IS NULL AND a.rejected_at IS NULL
      ORDER BY a.created_at`, [id]);
  return rows.map((r) => ({
    personId: r.alias_person_id,
    state: r.alias_state || r.primary_state || null,
    name: r.alias_name || r.display_name || null,
    origin: r.origin,
    suggestedAt: r.created_at,
  }));
}

module.exports = {
  SECTIONS, DEFAULT_SECTIONS,
  buildProfile, readProfile,
  familyOf, canonicalOf, openAliasCandidates, decideAlias, syncCrossStateCandidates,
  overviewFacts,
  _internals: { rowsFrom, objectFrom, looksFull, stripHeavy, rowKey, perPageFor, num, ensurePersonRow, PAGE_SIZE, MAX_PAGES, CALL_BUDGET, FRESH_HOURS, SECTION_STATE },
};
