'use strict';
/**
 * src/lib/elementix/address.js — ONE PROPERTY, and its whole recorded story.
 *
 * ── WHAT THE OWNER ASKED FOR ────────────────────────────────────────────────
 * "When you go into the property and open up that property, it should pull from
 * Elementix the details about that property. Everything should populate the same
 * way it's populating in Elementix... You should be able to see all the details
 * about this property: which moment it was taken on, from which lender it was
 * taken, where it was taken."
 *
 * ── WHY THIS IS A SEPARATE, DELIBERATE FETCH ────────────────────────────────
 * MOST of that answer is already free. Every mortgage row PILOT holds carries
 * the lender, the amount, the date, the county and the property's own address
 * uuid, and every deed carries what was paid — so `recordDetail` in
 * app-v2/src/lib/elementixRows.js joins them locally and a click costs nothing.
 * That is where the owner's three questions are answered.
 *
 * What is NOT in those rows is the PROPERTY'S OWN record, and it is a genuinely
 * different question: who owns it TODAY, everyone who owned it before this
 * person did, and every instrument ever recorded against it — the assignments,
 * satisfactions, preforeclosures and mechanics liens that never appear on any
 * person's tabs, including the ones belonging to people we have never looked up.
 *
 * That costs three to five requests out of an allowance of 1,000 an hour shared
 * by the WHOLE organisation, so it happens when somebody presses a button and
 * never on a sweep, never on render, and never on opening a record. `readAddress`
 * serves the cache and cannot reach the vendor at all.
 *
 * ── THE HONESTY RULES, the same three the person profile keeps ──────────────
 *  · A section that FAILED writes a row saying so. Re-reading the cache must
 *    never turn "the vendor refused" into "nobody owns this property".
 *  · A count is null when unknown, never 0.
 *  · Nothing is capped silently: a page ceiling comes back as `truncated` with
 *    its reason, so the screen says "showing the first N".
 *
 * ── WHAT IT MAY NEVER DO ────────────────────────────────────────────────────
 * Nothing here can reach `submit_contact_enrichment`: the three tools it calls
 * are named as literals in ONE table below and the transport refuses the paid
 * tool without an explicit `allowPaid` this module never passes. A property
 * lookup is free of charge and must stay that way — it is the cheap half of the
 * feature, and an accidental credit spent on browsing is exactly the class the
 * whole CRM plane is written to prevent.
 */

const db = require('../../db');
const crmTools = require('./crm-tools');
const CONTRACTS = require('./request-contracts.json');

const str = (v) => String(v == null ? '' : v).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// THE SECTIONS — the only place a property's parts are defined.
//
// `include: 'entities'` on get_address is deliberate and is the cheaper of two
// options: it brings back every entity ever tied to the property inside the
// SAME call, where `get_entity_related_addresses` would be one call per entity.
// ---------------------------------------------------------------------------
const SECTIONS = [
  {
    key: 'detail', label: 'The property', tool: 'get_address',
    single: true, objectKey: 'address', args: { include: 'entities' },
  },
  {
    key: 'ownership', label: 'Who has owned it', tool: 'get_address_ownership',
    rowsKey: 'data', paged: true, sortBy: 'startDate', sortOrder: 'desc',
  },
  {
    key: 'transactions', label: 'Everything recorded on it', tool: 'get_address_transactions',
    rowsKey: 'data', paged: true, sortBy: 'recordingDate', sortOrder: 'desc',
  },
];
const BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));

/* Smaller pages than the person profile on purpose. A person's mortgages tab is
   829 rows; ONE property's whole history is tens, so a 250-row page would buy
   nothing and a second page is almost never needed. */
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const CALL_BUDGET = 8;
const FRESH_HOURS = 24 * 7;   // a recorded instrument does not change

function perPageFor(tool, want = PAGE_SIZE) {
  const p = CONTRACTS.tools[tool] && CONTRACTS.tools[tool].params && CONTRACTS.tools[tool].params.perPage;
  const max = (p && Number(p.max)) || 100;
  const min = (p && Number(p.min)) || 1;
  return Math.min(Math.max(want, min), max);
}

function rowsFrom(section, data) {
  if (section.rowsKey && data && typeof data === 'object' && Array.isArray(data[section.rowsKey])) {
    return data[section.rowsKey];
  }
  return crmTools.rowsOf(data);
}

function objectFrom(section, data) {
  if (!data || typeof data !== 'object') return null;
  const k = section.objectKey;
  if (k && data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) return data[k];
  // Some header-style tools answer with the object at the top level. Accept that
  // rather than storing nothing, but never mistake a rows envelope for one.
  if (!Array.isArray(data.data) && (data.id || data.addressFull || data.address_full)) return data;
  return null;
}

/* `nextPage` means "the page came back full", never "there is more" — measured
   on this vendor. See the same note in profile.js. */
const looksFull = (d, rows, perPage) => !!(d && typeof d === 'object'
  && d.nextPage != null && d.nextPage !== false && rows.length >= perPage);

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchSection(section, addressId, ctx) {
  const out = { key: section.key, calls: 0, rows: [], object: null, truncated: false, error: null, unverified: false };
  const base = { id: addressId, ...(section.args || {}) };

  if (section.single) {
    if (ctx.spent >= CALL_BUDGET) { out.error = null; out.skipped = 'budget'; return out; }
    const r = await crmTools.call(section.tool, base, { staffId: ctx.staffId });
    ctx.spent += 1; out.calls += 1;
    if (!r.ok) { out.error = r.detail || r.reason || 'Elementix refused'; out.unverified = !!r.unverified; return out; }
    out.unverified = !!r.unverified;
    out.object = objectFrom(section, r.data);
    // An address tool can answer with nested rows too (`entities.data`), which
    // are worth keeping — they are the companies tied to this property.
    const nested = r.data && r.data.entities && Array.isArray(r.data.entities.data) ? r.data.entities.data : [];
    out.rows = nested;
    return out;
  }

  const perPage = perPageFor(section.tool);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (ctx.spent >= CALL_BUDGET) { out.truncated = true; out.truncatedReason = 'budget'; break; }
    const args = { ...base, page, perPage };
    if (section.sortBy) { args.sortBy = section.sortBy; args.sortOrder = section.sortOrder || 'desc'; }
    const r = await crmTools.call(section.tool, args, { staffId: ctx.staffId });
    ctx.spent += 1; out.calls += 1;
    if (!r.ok) {
      // A FIRST page that fails is a failure; a LATER one is a partial answer —
      // what we already read is real and must not be thrown away.
      if (page === 1) { out.error = r.detail || r.reason || 'Elementix refused'; return out; }
      out.truncated = true; out.truncatedReason = r.detail || r.reason || 'the vendor stopped answering';
      break;
    }
    out.unverified = out.unverified || !!r.unverified;
    const rows = rowsFrom(section, r.data);
    out.rows.push(...rows);
    if (!looksFull(r.data, rows, perPage)) break;
    if (page === MAX_PAGES) { out.truncated = true; out.truncatedReason = 'page_cap'; }
  }
  return out;
}

async function writeSection(addressId, key, out, client = db) {
  /* THE CEILING, AND THE PICTURES — both through the SHARED definitions in
     crm-tools, not a private copy. Over 400,000 characters `vendorJsonb`
     replaces the whole document with a marker, and `payload.rows` IS what the
     screen draws: without this a property with a long recorded history stores a
     marker, reads back with an empty `rows`, and renders as "Elementix has none
     on record" — the exact defect the person profile had fixed one commit
     earlier, reintroduced verbatim in this module. A page of transactions can
     reach it on its own if the vendor carries its inline logos, which is why
     they are stripped BEFORE the fit rather than after: pictures must never
     take a real row's place. */
  const payload = out.error ? null : crmTools.fitRowsPayload({
    rows: crmTools.stripHeavy(out.rows),
    object: crmTools.stripHeavy(out.object || null),
    total: out.rows.length,
  });
  await client.query(
    `INSERT INTO elementix_address_sections
       (address_id, section, payload, row_count, truncated, fetched_at, calls_spent, last_error, unverified)
     VALUES ($1,$2,$3::jsonb,$4,$5,now(),$6,$7,$8)
     ON CONFLICT (address_id, section) DO UPDATE
        SET payload = EXCLUDED.payload, row_count = EXCLUDED.row_count,
            truncated = EXCLUDED.truncated, fetched_at = EXCLUDED.fetched_at,
            calls_spent = EXCLUDED.calls_spent, last_error = EXCLUDED.last_error,
            unverified = EXCLUDED.unverified`,
    [addressId, key, payload == null ? null : crmTools.vendorJsonb(payload),
      out.error ? null : out.rows.length, !!out.truncated, out.calls || 0,
      out.error || (out.skipped ? 'left for the next read — this lookup had spent its allowance' : null),
      !!out.unverified]);
}

/** The header row, filled from whatever the detail call could tell us. */
async function ensureAddressRow(addressId, detail, staffId, client = db) {
  const o = detail || {};
  await client.query(
    `INSERT INTO elementix_addresses
       (address_id, address_full, city, county_name, state, zip_code, latitude, longitude, refreshed_at, refreshed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
     ON CONFLICT (address_id) DO UPDATE SET
       address_full = COALESCE(EXCLUDED.address_full, elementix_addresses.address_full),
       city         = COALESCE(EXCLUDED.city, elementix_addresses.city),
       county_name  = COALESCE(EXCLUDED.county_name, elementix_addresses.county_name),
       state        = COALESCE(EXCLUDED.state, elementix_addresses.state),
       zip_code     = COALESCE(EXCLUDED.zip_code, elementix_addresses.zip_code),
       latitude     = COALESCE(EXCLUDED.latitude, elementix_addresses.latitude),
       longitude    = COALESCE(EXCLUDED.longitude, elementix_addresses.longitude),
       refreshed_at = EXCLUDED.refreshed_at, refreshed_by = EXCLUDED.refreshed_by`,
    [addressId,
      str(o.addressFull || o.address_full) || null,
      str(o.city) || null,
      str(o.countyName || o.county_name) || null,
      str(o.state || o.countyState).toUpperCase() || null,
      str(o.zipCode || o.zip_code) || null,
      num(o.latitude), num(o.longitude),
      staffId || null]);
}

/**
 * READ THIS PROPERTY FROM ELEMENTIX. Always a deliberate click: `staffId` is
 * required, and every call is attributed to the person who asked for it.
 */
async function buildAddress(addressId, opts = {}) {
  const client = opts.client || db;
  /* LOWER-CASED ONCE, HERE. `isUuid` is case-insensitive and the route's scope
     check compares case-insensitively, but `address_id` is plain `text` — so an
     upper-case id would pass every gate and then MISS the row it already has:
     a second header row for one property, a fresh 3-5 requests out of the
     organisation's shared hourly allowance, and a cache read answering "not
     looked up yet" about a property that has been. */
  const id = str(addressId).toLowerCase();
  if (!isUuid(id)) return { ok: false, reason: 'bad_args', detail: 'That is not a property from an Elementix record.' };
  const staffId = str(opts.staffId);
  if (!staffId) return { ok: false, reason: 'no_actor', detail: 'A property lookup is always somebody’s — it is recorded against them.' };

  // Fresh enough? A recorded instrument does not change, so a week is generous
  // and still lets somebody force a re-read.
  /* FRESH ENOUGH — PER SECTION, NEVER ONE `max()` ACROSS THEM ALL. A recorded
     instrument does not change, so a week is generous; but a global max over the
     sections that SUCCEEDED means one refused section is never retried, because
     its siblings keep the watermark fresh. The officer presses "Read it again",
     nothing is spent, nothing changes, and nothing says why — for a week. So a
     section carrying an error is always due, exactly as the person profile does
     it ("a stale error is not information worth preserving, and the person
     clicked"), and the read goes ahead if ANY section is missing or due.
     Wrapped like `readAddress`'s own reads: an un-migrated instance degrades to
     a sentence rather than a 500 on one path and a sentence on the other. */
  if (!opts.force) {
    try {
      const { rows } = await client.query(
        `SELECT section, fetched_at, last_error FROM elementix_address_sections
          WHERE address_id = $1`, [id]);
      const cutoff = Date.now() - FRESH_HOURS * 3600 * 1000;
      const freshOk = (r) => !r.last_error && r.fetched_at && new Date(r.fetched_at).getTime() >= cutoff;
      const allFresh = SECTIONS.every((d) => {
        const r = rows.find((x) => x.section === d.key);
        return r && freshOk(r);
      });
      if (allFresh) return { ok: true, cached: true, ...(await readAddress(id, { client })) };
    } catch (_) { /* unreadable: fall through and read it properly */ }
  }

  const ctx = { staffId, spent: 0 };
  let detailObject = null;
  for (const section of SECTIONS) {
    const out = await fetchSection(section, id, ctx);
    if (section.key === 'detail') detailObject = out.object;
    await ensureAddressRow(id, detailObject, staffId, client);   // the FK must exist first
    await writeSection(id, section.key, out, client);
  }
  await client.query(
    `UPDATE elementix_addresses SET refreshed_at = now(), refreshed_by = $2 WHERE address_id = $1`,
    [id, staffId]);

  return { ok: true, cached: false, callsSpent: ctx.spent, ...(await readAddress(id, { client })) };
}

/** THE CACHE ONLY. This function cannot reach Elementix. */
async function readAddress(addressId, opts = {}) {
  const client = opts.client || db;
  const id = str(addressId).toLowerCase();   // see buildAddress: one property, one row
  if (!isUuid(id)) return { ok: false, reason: 'bad_args', detail: 'That is not a property from an Elementix record.' };

  /* AN UNREADABLE STORE IS NOT A PROPERTY WITH NO HISTORY, and it is not a 500
     either. The likeliest cause is an instance whose migrations have not run
     yet, exactly as the CRM desk already handles for its own two columns: the
     record around this still renders in full -- everything above it came from
     the person's own cached rows -- and only this block says it cannot answer. A
     screen that fell over here would take the whole drill-in down over a table
     that is one deploy away from existing. */
  let head = [];
  let secRows = [];
  try {
    head = (await client.query(
      `SELECT address_id, address_full, city, county_name, state, zip_code,
              latitude, longitude, refreshed_at, last_error, last_error_at
         FROM elementix_addresses WHERE address_id = $1`, [id])).rows;
    secRows = (await client.query(
      `SELECT section, payload, row_count, truncated, fetched_at, calls_spent, last_error, unverified
         FROM elementix_address_sections WHERE address_id = $1`, [id])).rows;
  } catch (e) {
    return {
      ok: true, address: null, everRead: false,
      storeUnreadable: (db.describeError ? db.describeError(e) : (e && e.message)) || 'unreadable',
      sections: Object.fromEntries(SECTIONS.map((d) => [d.key,
        { key: d.key, label: d.label, status: 'unavailable', rows: [], rowCount: null, truncated: false,
          detail: 'PILOT could not reach its own copy of this property just now.' }])),
    };
  }

  const sections = {};
  for (const def of SECTIONS) {
    const r = secRows.find((x) => x.section === def.key);
    if (!r) {
      sections[def.key] = { key: def.key, label: def.label, status: 'not_loaded', rows: [], rowCount: null, truncated: false };
      continue;
    }
    const payload = r.payload || {};
    sections[def.key] = {
      key: def.key,
      label: def.label,
      status: r.last_error ? 'error' : 'ok',
      detail: r.last_error || null,
      rows: Array.isArray(payload.rows) ? payload.rows : [],
      object: payload.object || null,
      // NULL, never 0, for a section that failed: "we could not ask" and "there
      // are none" are different answers and only one is safe to print.
      rowCount: r.last_error ? null : (r.row_count == null ? null : Number(r.row_count)),
      truncated: !!r.truncated,
      unverified: !!r.unverified,
      fetchedAt: r.fetched_at,
      callsSpent: r.calls_spent,
    };
  }

  return {
    ok: true,
    address: head[0] ? {
      addressId: head[0].address_id,
      addressFull: head[0].address_full,
      city: head[0].city,
      countyName: head[0].county_name,
      state: head[0].state,
      zipCode: head[0].zip_code,
      latitude: num(head[0].latitude),
      longitude: num(head[0].longitude),
      refreshedAt: head[0].refreshed_at,
      lastError: head[0].last_error,
    } : null,
    // `everRead` is what lets a screen offer "Read this property" instead of
    // drawing an empty page that looks like a property with no history.
    everRead: secRows.length > 0,
    sections,
  };
}

module.exports = {
  buildAddress, readAddress, SECTIONS,
  _internals: { fetchSection, objectFrom, rowsFrom, looksFull, perPageFor, PAGE_SIZE, MAX_PAGES, CALL_BUDGET, FRESH_HOURS, BY_KEY },
};
