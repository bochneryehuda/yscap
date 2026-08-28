'use strict';
/**
 * THE LEAD'S PHONE BOOK — every number the CRM holds for a lead, with the
 * officer's verdict on each (owner-directed 2026-08-19: "when I want to log a
 * call, I should choose which phone number … all the options from all the
 * phone numbers that you're importing from Elementix … I should be able to
 * mark any of the numbers that are not working, but it should NOT be removed
 * … even a non-answered call, I should be able to put in that this number is
 * working and this is going to the right person").
 *
 * WHY THIS FILE LIVES UNDER lib/elementix: the union reads the stored unlock
 * (the vendor contact row), and the machine check in
 * scripts/test-elementix-lookups-pure.js allows ONLY the CRM plane
 * (lib/elementix/** + routes/elementix-crm.js) to read the contact tables —
 * the FCRA line: contact detail never reaches a lending decision. The lead
 * CRM routes in routes/staff.js therefore DELEGATE here rather than reading
 * the table themselves.
 *
 * THE RULES, each load-bearing:
 *  - ONE PHONE IDENTITY. Every number is keyed by crm.phoneKey (digits,
 *    US country code stripped) — the same normalizer the whole Elementix
 *    plane uses — so "(555) 123-4567", "555.123.4567" and the vendor's copy
 *    of the same number are ONE row with ONE mark.
 *  - A MARK NEVER REMOVES A NUMBER. There is no delete anywhere in this
 *    file: marking a number not-working dresses it in its verdict and keeps
 *    it listed, because "this number is dead" is exactly the information the
 *    next officer needs before redialing it. Clearing a mark NULLs the
 *    verdict and keeps the row.
 *  - THE VERDICT IS INDEPENDENT OF THE CALL'S OUTCOME. `status` says whether
 *    the LINE works; `right_person` says the number reaches the person this
 *    lead is about — an unanswered call whose voicemail names them proves
 *    right_person without anybody picking up. Stored separately for that
 *    reason.
 *  - ONLY A NUMBER THE LEAD ACTUALLY HAS CAN BE MARKED OR LOGGED AGAINST
 *    (membership is checked against the union), so a typo can never mint a
 *    mark row for a number nobody holds.
 *  - PARTIAL WRITES MERGE. markLeadPhone touches only the fields the caller
 *    stated (status undefined = keep the stored status), so a call log that
 *    says only "right person" cannot blank an earlier working/not-working
 *    verdict.
 */

const db = require('../../db');
const { phoneKey } = require('./crm');

const str = (v) => String(v == null ? '' : v).trim();

/** US 10-digit pretty form; anything else shows its digits (or the raw value). */
function displayPhone(key, fallback) {
  const d = str(key);
  if (/^\d{10}$/.test(d)) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return str(fallback) || d;
}

/**
 * The union: the lead's own two numbers + every number the Elementix unlock
 * holds, deduped by phone key, each carrying the vendor's own words
 * (label/carrier/status/location/confidence) where it came from the unlock,
 * and the officer's mark where one exists. Order: the lead's primary, the
 * alt, then the unlock's extras in the vendor's order.
 */
async function leadPhonesFor(leadId, opts = {}) {
  const dbc = opts.client || db;
  const lead = (await dbc.query(
    `SELECT id, phone, phone_alt, elementix_person_id FROM leads WHERE id = $1`, [leadId])).rows[0];
  if (!lead) return { found: false, linked: false, phones: [] };

  const marks = (await dbc.query(
    `SELECT m.phone_key, m.status, m.right_person, m.marked_at, s.full_name AS marked_by_name
       FROM lead_phone_marks m LEFT JOIN staff_users s ON s.id = m.marked_by
      WHERE m.lead_id = $1`, [leadId])).rows;
  const markOf = new Map(marks.map((m) => [m.phone_key, m]));

  const phones = [];
  const byKey = new Map();
  const add = (value, source, meta) => {
    const key = phoneKey(value);
    if (key.length < 10 || key.length > 15) return;   // not a number somebody can ring
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (meta) {   // the vendor's words enrich a lead-sourced copy of the same number
        existing.label = existing.label || str(meta.label) || null;
        existing.carrier = existing.carrier || str(meta.carrier) || null;
        existing.vendorStatus = existing.vendorStatus || str(meta.status) || null;
        existing.location = existing.location || str(meta.location) || null;
        if (existing.confidence == null && Number.isFinite(Number(meta.confidence))) existing.confidence = Number(meta.confidence);
      }
      return;
    }
    const m = markOf.get(key) || null;
    const row = {
      key,
      display: displayPhone(key, value),
      sources: [source],
      label: meta ? str(meta.label) || null : null,
      carrier: meta ? str(meta.carrier) || null : null,
      vendorStatus: meta ? str(meta.status) || null : null,
      location: meta ? str(meta.location) || null : null,
      confidence: meta && Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : null,
      mark: m ? { status: m.status, rightPerson: m.right_person, markedAt: m.marked_at, markedByName: m.marked_by_name } : null,
    };
    byKey.set(key, row);
    phones.push(row);
  };

  add(lead.phone, 'lead');
  add(lead.phone_alt, 'lead_alt');

  let linked = false;
  if (lead.elementix_person_id) {
    const held = (await dbc.query(
      `SELECT phones FROM elementix_contacts WHERE person_id = $1`, [lead.elementix_person_id])).rows[0];
    if (held && Array.isArray(held.phones)) {
      linked = true;
      for (const p of held.phones) {
        if (p == null) continue;
        if (typeof p === 'string') add(p, 'elementix', null);
        else add(p.value != null ? p.value : p.key, 'elementix', p);
      }
    }
  }

  return { found: true, linked, personId: lead.elementix_person_id || null, phones };
}

/**
 * The phone books of MANY leads in three batched reads — the Excel export's
 * delegate (owner-directed 2026-08-28: the lead export must carry "all the
 * fields, if it's an Elementix file: phone numbers"). Same union, same one
 * phone identity and same no-delete rules as `leadPhonesFor`; batched because
 * an export of a whole desk calling the per-lead reader would be three queries
 * PER ROW. Lives HERE because staff.js may not read the Elementix contact
 * tables itself (the CRM-plane rule this file's header explains).
 * Returns Map<leadId, phones[]> (same row shape as leadPhonesFor().phones).
 */
async function leadPhonesForMany(leadIds, opts = {}) {
  const dbc = opts.client || db;
  const out = new Map();
  const ids = [...new Set((leadIds || []).filter(Boolean))];
  if (!ids.length) return out;
  const leads = (await dbc.query(
    `SELECT id, phone, phone_alt, elementix_person_id FROM leads WHERE id = ANY($1::uuid[])`, [ids])).rows;
  const marks = (await dbc.query(
    `SELECT lead_id, phone_key, status, right_person FROM lead_phone_marks WHERE lead_id = ANY($1::uuid[])`, [ids])).rows;
  const markOf = new Map(marks.map((m) => [`${m.lead_id}:${m.phone_key}`, m]));
  const personIds = [...new Set(leads.map((l) => l.elementix_person_id).filter(Boolean))];
  const held = personIds.length
    ? (await dbc.query(`SELECT person_id, phones FROM elementix_contacts WHERE person_id = ANY($1::text[])`,
      [personIds])).rows
    : [];
  const heldOf = new Map(held.map((h) => [h.person_id, Array.isArray(h.phones) ? h.phones : []]));

  for (const lead of leads) {
    const phones = [];
    const byKey = new Map();
    const add = (value, source, meta) => {
      const key = phoneKey(value);
      if (key.length < 10 || key.length > 15) return;
      const existing = byKey.get(key);
      if (existing) { if (!existing.sources.includes(source)) existing.sources.push(source); return; }
      const m = markOf.get(`${lead.id}:${key}`) || null;
      const row = {
        key, display: displayPhone(key, value), sources: [source],
        label: meta ? str(meta.label) || null : null,
        mark: m ? { status: m.status, rightPerson: m.right_person } : null,
      };
      byKey.set(key, row); phones.push(row);
    };
    add(lead.phone, 'lead');
    add(lead.phone_alt, 'lead_alt');
    for (const p of heldOf.get(lead.elementix_person_id) || []) {
      if (p == null) continue;
      if (typeof p === 'string') add(p, 'elementix', null);
      else add(p.value != null ? p.value : p.key, 'elementix', p);
    }
    out.set(lead.id, phones);
  }
  return out;
}

/** Is this one of the lead's numbers? → {ok, key, display} (membership check). */
async function validateLeadPhone(leadId, phone, opts = {}) {
  const key = phoneKey(phone);
  if (key.length < 10 || key.length > 15) return { ok: false, reason: 'unknown_number' };
  const book = await leadPhonesFor(leadId, opts);
  if (!book.found) return { ok: false, reason: 'not_found' };
  const row = book.phones.find((p) => p.key === key);
  if (!row) return { ok: false, reason: 'unknown_number' };
  return { ok: true, key, display: row.display, row };
}

/**
 * Record the officer's verdict on one of the lead's numbers.
 *   status: 'working' | 'not_working' | 'clear' (→ NULL) | undefined (keep)
 *   rightPerson: true | false | 'clear' (→ NULL) | undefined (keep)
 * The row is upserted, never deleted; marked_by/marked_at always restate who
 * spoke last. `recordActivity: false` is for a verdict riding a call log —
 * the call row itself is the record, and a second system row beside it would
 * say the same thing twice.
 */
async function markLeadPhone({ leadId, phone, status, rightPerson, staffId, recordActivity = true, client }) {
  const dbc = client || db;
  if (status !== undefined && status !== 'clear' && status !== null && status !== 'working' && status !== 'not_working') {
    return { ok: false, reason: 'bad_status' };
  }
  if (rightPerson !== undefined && rightPerson !== 'clear' && rightPerson !== null && rightPerson !== true && rightPerson !== false) {
    return { ok: false, reason: 'bad_right_person' };
  }
  const v = await validateLeadPhone(leadId, phone, { client: dbc });
  if (!v.ok) return v;

  const prior = v.row.mark || {};
  const nextStatus = status === undefined ? (prior.status || null) : (status === 'clear' ? null : status);
  const nextRight = rightPerson === undefined ? (prior.rightPerson == null ? null : prior.rightPerson)
    : (rightPerson === 'clear' ? null : rightPerson);

  await dbc.query(
    `INSERT INTO lead_phone_marks (lead_id, phone_key, status, right_person, marked_by, marked_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (lead_id, phone_key)
       DO UPDATE SET status = EXCLUDED.status, right_person = EXCLUDED.right_person,
                     marked_by = EXCLUDED.marked_by, marked_at = now()`,
    [leadId, v.key, nextStatus, nextRight, staffId || null]);

  if (recordActivity) {
    const subject = nextStatus === 'not_working' ? 'Phone marked not working'
      : nextStatus === 'working' ? (nextRight === true ? 'Phone marked working — right person' : 'Phone marked working')
        : nextRight === true ? 'Phone marked — right person' : 'Phone mark cleared';
    try {
      await dbc.query(
        `INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body, meta)
         VALUES ($1,$2,'system',$3,$4,$5::jsonb)`,
        [leadId, staffId || null, subject, v.display,
          JSON.stringify({ phone_key: v.key, phone_display: v.display, mark_status: nextStatus, right_person: nextRight })]);
    } catch (_) { /* the mark itself already landed — a timeline hiccup must not undo it */ }
  }

  return { ok: true, key: v.key, display: v.display, mark: { status: nextStatus, rightPerson: nextRight } };
}

module.exports = { leadPhonesFor, leadPhonesForMany, validateLeadPhone, markLeadPhone, displayPhone };
