'use strict';
/**
 * src/lib/elementix/crm.js — a skip trace becomes a lead in the officer's CRM.
 *
 * ── THE OWNER'S RULE (2026-08-18) ──────────────────────────────────────────
 * "Every contact that a user unlocks should be added to this user as a lead in
 * his CRM system, assigned to his login. He should get the name, and he should
 * get all the contact information available."
 *
 * ── WHY THE UNLOCK HAS TO HAPPEN HERE ──────────────────────────────────────
 * Elementix's 40-tool surface cannot tell us who unlocked whom: it has no user
 * list and no unlock history, only "is THIS person unlocked?" one at a time. So
 * an unlock performed on Elementix's own website is invisible to PILOT forever.
 * The unlock therefore happens THROUGH PILOT — the officer presses Skip trace
 * here — and that is what makes the attribution real: the credit is spent under
 * that officer's own Elementix login (db/489's per-officer scope, switched on
 * 2026-08-18) and recorded against their PILOT id in the same breath.
 *
 * ── THE MONEY ──────────────────────────────────────────────────────────────
 * `submit_contact_enrichment` is the ONLY paid tool in PILOT and the owner's cap
 * is 1,000 a month. Nothing here decides whether it may be spent: that is
 * `elementix/client.js`, which demands a `paidActor` naming who asked, about
 * whom, and why, counts the month in the database, and FAILS CLOSED when it
 * cannot count. This module's job is to never ask unless a human clicked, and to
 * check the FREE `get_contact_status` first so an already-unlocked person costs
 * nothing at all.
 */

const db = require('../../db');
const crmTools = require('./crm-tools');
const lookups = require('./lookups');

const str = (v) => String(v == null ? '' : v).trim();
const clip = (v, n) => str(v).slice(0, n);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));

// ---------------------------------------------------------------------------
// Reading the vendor's contact payload
// ---------------------------------------------------------------------------

/** Digits only, for comparing two spellings of one telephone number. */
const phoneKey = (v) => str(v).replace(/\D+/g, '').replace(/^1(?=\d{10}$)/, '');

/**
 * Pull every phone, email and address out of a `get_contact_info` payload.
 *
 * PURE, and deliberately generous about SHAPE while strict about VALUE.
 * `get_contact_info` is one of the tools whose response was never transcribed,
 * and the owner's requirement is explicitly "all the phone numbers available and
 * their names" — so this reads a spread of spellings and KEEPS the vendor's own
 * labels rather than inventing its own vocabulary. What it will not do is invent
 * a contact: a value that is not a plausible telephone number or email address
 * is dropped, because a CRM that lists a junk number gets it dialled.
 *
 * Order is preserved (the vendor puts its best guess first, which is what the
 * screenshot's "Top Phone Numbers" reflects) and duplicates are collapsed on the
 * digits, keeping the richest labelled copy.
 */
function normalizeContact(raw) {
  const out = { phones: [], emails: [], addresses: [] };
  if (!raw || typeof raw !== 'object') return out;

  /* THE ENVELOPE IS TWO DEEP, AND MISSING THAT FOUND NOTHING AT ALL.
     `get_contact_info` answers with the enrichment JOB, not with a contact:
     {job:{id, status:'COMPLETED', createdAt, completedAt, result:{phone:[…],
     email:[…], summary, company_name, company_domain, linkedin_url}, logs:[…]}}
     — captured live 2026-08-18. A reader that looked only one level down read a
     person with three phone numbers and three email addresses as having none,
     silently, and the lead would have been created empty. Hence `job` and
     `job.result` are walked explicitly, and the walk is BREADTH-FIRST over a
     fixed key list rather than a blind recursion, so `logs` can never be
     mistaken for data. */
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const NEST = ['data', 'result', 'job', 'contact', 'contactInfo', 'contact_info', 'person'];
  const roots = [raw];
  for (let i = 0; i < roots.length && roots.length < 12; i += 1) {
    for (const k of NEST) {
      const v = obj(roots[i][k]);
      if (v && !roots.includes(v)) roots.push(v);
    }
  }

  const listAt = (keys) => {
    for (const src of roots) {
      for (const k of keys) {
        if (Array.isArray(src[k])) return src[k];
        // A single value where a list was expected is still one value.
        if (typeof src[k] === 'string' && src[k].trim()) return [src[k]];
      }
    }
    return [];
  };

  const seenPhone = new Set();
  for (const row of listAt(['phones', 'phoneNumbers', 'phone_numbers', 'phone', 'telephones'])) {
    const value = typeof row === 'string' ? row
      : str(row && (row.number || row.phone || row.value || row.phoneNumber || row.phone_number));
    const key = phoneKey(value);
    // 10 digits (US) or 11 starting with a country code; anything shorter is not
    // a number somebody can ring.
    if (key.length < 10 || key.length > 15 || seenPhone.has(key)) continue;
    seenPhone.add(key);
    const meta = typeof row === 'object' && row ? row : {};
    out.phones.push({
      value,
      key,
      // The vendor's own words — "Mobile", "Fixed", a carrier, a status like
      // "Deliverable". The screen prints these; it does not translate them.
      label: str(meta.label || meta.name || meta.type || meta.phoneType || meta.line_type || meta.lineType) || null,
      carrier: str(meta.carrier || meta.provider) || null,
      status: str(meta.status || meta.deliverability || meta.result) || null,
      location: str(meta.location || meta.city || meta.region) || null,
      // The vendor scores how sure it is (0.7, 0.85). Worth showing: an officer
      // ringing three numbers should start with the one most likely to be theirs.
      confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : null,
      lastSeen: str(meta.lastSeen || meta.last_seen || meta.lastSeenAt || meta.updatedAt) || null,
    });
  }

  const seenEmail = new Set();
  for (const row of listAt(['emails', 'emailAddresses', 'email_addresses', 'email'])) {
    const value = typeof row === 'string' ? row
      : str(row && (row.address || row.email || row.value || row.emailAddress));
    const key = value.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) || seenEmail.has(key)) continue;
    seenEmail.add(key);
    const meta = typeof row === 'object' && row ? row : {};
    out.emails.push({
      value,
      key,
      label: str(meta.label || meta.name || meta.type) || null,
      /* `result` is the vendor's own verdict — "deliverable" or "risky" — and it
         is the field that matters most on an email address. It is NOT called
         status or deliverability, which is what this used to look for, so every
         address came through unmarked and a risky one looked as good as a live
         one. */
      status: str(meta.result || meta.status || meta.deliverability) || null,
      reason: str(meta.reason) || null,
      provider: str(meta.provider) || null,
      confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : null,
      lastSeen: str(meta.lastSeen || meta.last_seen || meta.updatedAt) || null,
    });
  }

  /* `mailingAddress` — SINGULAR, a plain string — is what the person tools
     actually carry, and it was the one spelling this list did not have. It is
     the only genuine CONTACT address the vendor gives (everything else is a
     property they own), so missing it left the CRM with nowhere to post to. */
  for (const row of listAt(['addresses', 'mailingAddresses', 'mailing_addresses', 'address', 'mailingAddress', 'mailing_address'])) {
    const value = typeof row === 'string' ? row
      : str(row && (row.formatted || row.oneLine || row.line || row.address || row.fullAddress));
    if (!value) continue;
    const meta = typeof row === 'object' && row ? row : {};
    out.addresses.push({ value, label: str(meta.label || meta.type) || null });
  }

  /* WHAT THE ENRICHMENT ALSO LEARNED. The job carries a written summary of who
     the person is, their company and its domain — the owner asked for "all the
     details", and this is the part a loan officer actually reads before they
     dial. Nulls when absent; nothing here is inferred. */
  const pick = (keys) => {
    for (const src of roots) for (const k of keys) { const v = str(src[k]); if (v) return v; }
    return null;
  };
  out.profile = {
    summary: pick(['summary', 'description', 'bio']),
    company: pick(['company_name', 'companyName', 'company']),
    companyDomain: pick(['company_domain', 'companyDomain', 'domain']),
    linkedin: pick(['linkedin_url', 'linkedinUrl', 'linkedin']),
  };
  return out;
}

/** The best telephone number and email to seed a CRM lead with. */
function primaryContact(c) {
  return {
    phone: (c.phones[0] && c.phones[0].value) || null,
    phoneAlt: (c.phones[1] && c.phones[1].value) || null,
    email: (c.emails[0] && c.emails[0].value) || null,
  };
}

// ---------------------------------------------------------------------------
// Reading the person's unlock state — FREE
// ---------------------------------------------------------------------------

/**
 * Is this person already unlocked on the account? Costs nothing.
 *
 * Reuses `lookups.isUnlocked`, which already carries the several spellings the
 * vendor's unpinned status shape can take and FAILS CLOSED. A second reader of
 * the same undocumented shape is how two parts of PILOT come to disagree about
 * whether we have paid for somebody.
 */
async function contactState(personId, opts = {}) {
  if (!isUuid(personId)) return { ok: false, reason: 'bad_args', detail: 'That is not an Elementix person id.' };
  const st = await crmTools.call('get_contact_status', { personId }, opts);
  if (!st.ok) return st;
  return { ok: true, unlocked: lookups.isUnlocked(st.data), raw: st.data };
}

// ---------------------------------------------------------------------------
// The lead
// ---------------------------------------------------------------------------

/**
 * Find or create the CRM lead for a person, owned by the officer who traced them.
 *
 * ONE LEAD PER (person, officer). Two officers may legitimately both work the
 * same person — that is a real thing in a brokerage — so the uniqueness is on
 * the pair, not on the person. Re-tracing somebody you already have updates the
 * lead you already have instead of littering the board with copies.
 *
 * FILL-ONLY on every field a human can edit. An officer who has renamed the lead,
 * moved it down the pipeline or corrected the phone number must not have that
 * overwritten by a later refresh of the same vendor data.
 */
async function ensureLead({ personId, staffId, name, state, contact, client = db }) {
  const found = await client.query(
    `SELECT id FROM leads WHERE elementix_person_id = $1 AND officer_id = $2::uuid LIMIT 1`,
    [personId, staffId]);
  const p = primaryContact(contact || { phones: [], emails: [] });

  if (found.rows[0]) {
    const id = found.rows[0].id;
    // COALESCE on the lead's side: only ever fills a blank.
    await client.query(
      `UPDATE leads
          SET phone     = COALESCE(phone, $2),
              phone_alt = COALESCE(phone_alt, $3),
              email     = COALESCE(email, $4::citext),
              updated_at = now()
        WHERE id = $1`,
      [id, p.phone, p.phoneAlt, p.email]);
    return { id, created: false };
  }

  const parts = str(name).split(/\s+/).filter(Boolean);
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || null);
  const last = parts.length > 1 ? parts[parts.length - 1] : null;

  const ins = await client.query(
    `INSERT INTO leads (tool, name, first_name, last_name, email, phone, phone_alt,
                        officer_id, source, lead_source, status,
                        elementix_person_id, created_by_staff_id, last_activity_at)
     VALUES ('elementix', $1, $2, $3, $4::citext, $5, $6, $7::uuid,
             'elementix', 'elementix_skip_trace', 'new', $8, $7::uuid, now())
     RETURNING id`,
    [clip(name, 200) || 'Unnamed contact', first, last, p.email, p.phone, p.phoneAlt, staffId, personId]);

  const id = ins.rows[0].id;
  // The timeline entry is what makes the lead explicable a month later: where it
  // came from, and that a credit was spent to get it.
  await client.query(
    `INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body)
     VALUES ($1, $2::uuid, 'system', 'Added from Elementix',
             $3)`,
    [id, staffId,
      `Skip traced in Elementix${state ? ` (${state})` : ''} and added to this CRM automatically.`]);
  return { id, created: true };
}

/** Store what the skip trace bought. Upsert — a refresh replaces the details. */
async function storeContact({ personId, contact, raw, staffId, source, client = db }) {
  await client.query(
    `INSERT INTO elementix_contacts (person_id, phones, emails, addresses, raw, unlocked_by, unlocked_at, source, refreshed_at)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::uuid,now(),$7,now())
     ON CONFLICT (person_id) DO UPDATE
        SET phones = EXCLUDED.phones, emails = EXCLUDED.emails, addresses = EXCLUDED.addresses,
            raw = EXCLUDED.raw, refreshed_at = now(), updated_at = now(),
            -- WHO bought it is written once and never rewritten: a later refresh
            -- by somebody else did not pay for this, and overwriting would
            -- silently reassign a credit in the record.
            unlocked_by = COALESCE(elementix_contacts.unlocked_by, EXCLUDED.unlocked_by),
            unlocked_at = COALESCE(elementix_contacts.unlocked_at, EXCLUDED.unlocked_at),
            source      = COALESCE(elementix_contacts.source, EXCLUDED.source)`,
    [personId, crmTools.vendorJsonb(contact.phones), crmTools.vendorJsonb(contact.emails),
      crmTools.vendorJsonb(contact.addresses), crmTools.vendorJsonb(raw, 200000),
      staffId || null, source || 'pilot_skip_trace']);
}

/**
 * THE PERSON HEADER ROW — the ONE writer of `elementix_persons`, so a lead has a
 * profile to link to.
 *
 * Every module in this plane calls THIS. There used to be a second copy in
 * profile.js and the two disagreed about exactly one thing — whose name wins —
 * so which spelling a person ended up with depended on whether a lead or a
 * profile build touched them last. That is the shape a bug hides in.
 *
 * The rule, stated once: a name we already hold STAYS, because it is usually the
 * one an officer picked off a search result and saw on their lead. The single
 * exception is `authoritative: true`, which the profile build passes because it
 * is holding the vendor's OWN canonical record of the person rather than a row
 * off a search hit — and that genuinely is a better name than a fuzzy match.
 * A blank name never overwrites anything, either way.
 */
async function ensurePerson({ personId, name, state, authoritative = false, client = db }) {
  await client.query(
    `INSERT INTO elementix_persons (person_id, display_name, primary_state, states)
     VALUES ($1,$2,$3,CASE WHEN $3::text IS NULL OR $3 = '' THEN '{}'::text[] ELSE ARRAY[$3::text] END)
     ON CONFLICT (person_id) DO UPDATE
        SET display_name  = CASE WHEN $4::boolean
                                 THEN COALESCE(EXCLUDED.display_name, elementix_persons.display_name)
                                 ELSE COALESCE(elementix_persons.display_name, EXCLUDED.display_name) END,
            primary_state = COALESCE(elementix_persons.primary_state, EXCLUDED.primary_state),
            states = CASE WHEN $3::text IS NULL OR $3 = '' OR $3 = ANY(elementix_persons.states)
                          THEN elementix_persons.states
                          ELSE elementix_persons.states || $3::text END,
            updated_at = now()`,
    [personId, clip(name, 300) || null, state || null, authoritative === true]);
}

// ---------------------------------------------------------------------------
// THE SKIP TRACE
// ---------------------------------------------------------------------------

/** How long the click itself waits for an enrichment job before handing off to
 *  the sweep. Short on purpose — a person staring at a button is not a good
 *  place to wait on a third party. */
const POLL_ATTEMPTS = 4;
const POLL_DELAY_MS = 1500;

/* How long a paid enrichment job is presumed to still be running. Past this a
   pending trace is stale and a fresh attempt is allowed, so a job that died at
   the vendor cannot make a person permanently un-traceable. Matches the sweep's
   own give-up window. */
const PENDING_HOLD_HOURS = 48;

/**
 * Skip trace a person and land them in the officer's CRM.
 *
 * Order matters and is the whole cost control:
 *   1. FREE status check. Already unlocked → read the details, spend nothing.
 *   2. Otherwise the PAID enrichment, which client.js gates on the actor and the
 *      monthly cap.
 *   3. The vendor calls it a JOB, so poll the free status a few times; if it has
 *      not landed, record it pending and let the sweep finish it. The credit is
 *      already spent by then, so giving up entirely would waste it.
 *
 * NEVER THROWS, AND THAT IS ENFORCED HERE RATHER THAN ASSUMED. The vendor calls
 * are shaped; the DATABASE work is not, and by the time it runs the credit may
 * already be spent — a raise there escaped as a bare 500 with no skip-trace row
 * written at all, so the sweep that exists to finish the lookup had nothing to
 * find. A refusal that names what happened is recoverable; a 500 is not.
 */
async function skipTrace(args) {
  try {
    return await skipTraceInner(args);
  } catch (e) {
    return { ok: false, reason: 'error',
      detail: `PILOT could not file this lookup: ${e && e.message ? e.message : 'unknown error'}` };
  }
}

async function skipTraceInner({ personId, staffId, reason, name, state }) {
  if (!isUuid(personId)) return { ok: false, reason: 'bad_args', detail: 'That is not an Elementix person id.' };
  if (!staffId) return { ok: false, reason: 'no_actor', detail: 'A skip trace has to be made by a signed-in officer.' };
  if (!str(reason)) {
    return { ok: false, reason: 'no_reason',
      detail: 'Say why you are looking this person up — it is a paid lookup and the reason is kept with it.' };
  }

  const opts = { staffId };

  /* WE ALREADY OWN THIS PERSON'S DETAILS — DO NOT BUY THEM AGAIN.
     Asked first, and from OUR OWN database, because the vendor's status call is
     a network round trip that can fail, and `lookups.isUnlocked` fails CLOSED
     (an unreadable answer reads as "not unlocked"). Failing closed is right for
     showing a phone number and exactly backwards for spending money: a hiccup in
     the status call would re-buy a contact sitting in our own table. */
  const held = await db.query(
    `SELECT person_id FROM elementix_contacts
      WHERE person_id = $1
          /* COUNTED BY SHAPE. jsonb_array_length RAISES 22023 on a value that is
             not an array, and vendorJsonb legitimately stores a marker OBJECT when
             the vendor's payload was too large — so the unguarded form throws on the
             one query that decides whether to spend a credit, out of a function that
             promises never to throw. The two free routes already guard it; this is
             the same predicate. (No backticks in here: this comment lives inside a
             JS template literal, and one would end the string.) */
          AND ((CASE WHEN jsonb_typeof(phones) = 'array' THEN jsonb_array_length(phones) ELSE 0 END)
             + (CASE WHEN jsonb_typeof(emails) = 'array' THEN jsonb_array_length(emails) ELSE 0 END)) > 0`,
    [personId]);
  if (held.rows.length) {
    return finishSkipTrace({ personId, staffId, reason, name, state, charged: false, source: 'already_unlocked' });
  }

  /* SOMEBODY'S ENRICHMENT IS STILL RUNNING — DO NOT START A SECOND ONE.
     The vendor calls this a JOB: the click waits a few seconds, then hands off
     to the sweep, and the person is still locked when the officer looks. Without
     this, the same officer clicking again at thirty seconds spends a second
     credit, and a SECOND officer tracing the same person spends a third — which
     the (person, staff) unique index cannot prevent, because it dedupes the ROW
     and not the SPEND, and the two-officer case is not even the same row.
     A pending trace is only honoured while it could still be running: past
     `giveUpHours` it is stale, and refusing forever on a job that died would
     make the person permanently un-traceable. */
  const pending = await db.query(
    `SELECT staff_id FROM elementix_skip_traces
      WHERE person_id = $1 AND status = 'pending' AND charged = true
        AND occurred_at > now() - ($2 || ' hours')::interval
      LIMIT 1`, [personId, String(PENDING_HOLD_HOURS)]);
  if (pending.rows.length) {
    // Their own lead is still made — they asked for this person, and the
    // details will land on it when the job settles.
    // `charged: false` because THIS officer is not the one who paid — the trace
    // that is running already carries the spend. finishSkipTrace records their
    // own row as pending on its own when the details are not back yet.
    const out = await finishSkipTrace({ personId, staffId, reason, name, state, charged: false, source: 'pilot_skip_trace' });
    return { ...out, ok: true, pending: true, alreadyRunning: true,
      detail: pending.rows[0].staff_id === staffId
        ? 'You already asked for this person — Elementix is still looking. Nothing extra was charged.'
        : 'Somebody here is already looking this person up, so nothing extra was charged. The details will appear on your lead when they arrive.' };
  }

  const state0 = await contactState(personId, opts);
  if (!state0.ok) return state0;

  let charged = false;
  let source = 'already_unlocked';

  if (!state0.unlocked) {
    const paid = await crmTools.call('submit_contact_enrichment', { personId }, {
      staffId,
      paidActor: { staffId, personId, reason: str(reason) },
    });
    if (!paid.ok) return paid;
    charged = true;
    source = 'pilot_skip_trace';

    // Wait briefly for the job. `get_contact_status` is free, so polling costs
    // nothing but a slot of the shared hourly allowance.
    let landed = false;
    for (let i = 0; i < POLL_ATTEMPTS && !landed; i += 1) {
      await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
      const st = await contactState(personId, opts);
      if (st.ok && st.unlocked) landed = true;
    }
    if (!landed) {
      await ensurePerson({ personId, name, state });
      await recordSkipTrace({ personId, staffId, name, state, reason, charged, source, status: 'pending' });
      return { ok: true, pending: true, charged,
        detail: 'Elementix is still looking this person up. Their details will appear here shortly.' };
    }
  }

  return finishSkipTrace({ personId, staffId, reason, name, state, charged, source });
}

/** Read the (now unlocked) details, store them, and make the lead. */
async function finishSkipTrace({ personId, staffId, reason, name, state, charged, source }) {
  const info = await crmTools.call('get_contact_info', { personId }, { staffId });
  if (!info.ok) {
    await recordSkipTrace({ personId, staffId, name, state, reason, charged, source,
      status: 'pending', detail: info.detail });
    /* SAY WHAT ACTUALLY HAPPENED, WHICH IS NOT THE SAME SENTENCE BOTH WAYS.
       This function is reached from the PAID path and from the FREE one (a
       person Elementix already had unlocked, where `charged` is false), and
       telling an officer "the lookup is paid for" about a lookup that cost
       nothing is a plain untruth on the screen where they decide whether to
       spend again. The promise to keep checking is kept by
       `drainPendingSkipTraces`, which the sync runs on a timer. */
    return { ok: true, pending: true, charged,
      detail: charged
        ? 'The lookup is paid for, but Elementix has not sent the details back yet. PILOT will keep checking and the lead will appear on its own.'
        : 'Elementix has this person unlocked but did not send their details back just now. Nothing was charged. PILOT will keep checking and the lead will appear on its own.' };
  }

  const contact = normalizeContact(info.data);
  const personName = clip(name, 300) || nameFrom(info.data) || 'Unnamed contact';

  await ensurePerson({ personId, name: personName, state });
  await storeContact({ personId, contact, raw: info.data, staffId, source });
  const lead = await ensureLead({ personId, staffId, name: personName, state, contact });
  await recordSkipTrace({ personId, staffId, name: personName, state, reason, charged, source,
    status: 'complete', leadId: lead.id });

  if (lead.created) notifyOfficer({ staffId, leadId: lead.id, name: personName, contact }).catch(() => {});

  return { ok: true, charged, leadId: lead.id, leadCreated: lead.created, contact,
    counts: { phones: contact.phones.length, emails: contact.emails.length } };
}

/** A name out of the contact payload, when the caller did not supply one. */
function nameFrom(d) {
  if (!d || typeof d !== 'object') return null;
  for (const src of [d, d.data, d.person, d.contact]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of ['name', 'fullName', 'full_name', 'displayName', 'personName']) {
      if (typeof src[k] === 'string' && src[k].trim()) return src[k].trim().slice(0, 300);
    }
  }
  return null;
}

/**
 * The outcome row. UPSERT on (person, officer) so re-tracing settles the row
 * that already exists rather than adding a second — the unique index says the
 * same thing, and doing it here means a re-trace after a pending one records the
 * completion instead of raising.
 */
async function recordSkipTrace({ personId, staffId, name, state, reason, charged, source,
  status = 'complete', leadId = null, detail = null, client = db }) {
  await client.query(
    `INSERT INTO elementix_skip_traces
       (person_id, staff_id, lead_id, person_name, state, source, reason, charged, status, detail, completed_at)
     VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $9 = 'complete' THEN now() END)
     ON CONFLICT (person_id, staff_id) WHERE staff_id IS NOT NULL
     DO UPDATE SET lead_id      = COALESCE(EXCLUDED.lead_id, elementix_skip_traces.lead_id),
                   status       = EXCLUDED.status,
                   detail       = EXCLUDED.detail,
                   person_name  = COALESCE(EXCLUDED.person_name, elementix_skip_traces.person_name),
                   completed_at = COALESCE(elementix_skip_traces.completed_at, EXCLUDED.completed_at),
                   -- charged only ever goes FALSE->TRUE: a later free re-read
                   -- must not erase that a credit was spent on this person.
                   charged      = elementix_skip_traces.charged OR EXCLUDED.charged`,
    [personId, staffId, leadId, clip(name, 300) || null, clip(state, 2) || null,
      source, clip(reason, 300) || null, !!charged, status, clip(detail, 300) || null]);
}

/** Tell the officer it landed. In-app only — see STAFF_INAPP_TYPES in notify.js. */
async function notifyOfficer({ staffId, leadId, name, contact }) {
  const notify = require('../notify');
  const n = contact ? contact.phones.length : 0;
  await notify.notifyStaff(staffId, {
    type: 'elementix_lead',
    title: `${name} was added to your CRM`,
    /* WORDED FOR BOTH DOORS. This fires from a skip trace made here AND from the
       automatic import of a contact somebody unlocked in Elementix's own
       screens, so it says "you looked them up in Elementix" — true either way —
       rather than naming a button they may never have pressed. */
    body: n
      ? `You looked ${name} up in Elementix. They are now a lead in your CRM with ${n} phone number${n === 1 ? '' : 's'}.`
      : `You looked ${name} up in Elementix. They are now a lead in your CRM.`,
    link: `/internal/leads/${leadId}`,
    ctaLabel: 'Open the lead',
  });
}

/**
 * Settle skip traces whose enrichment job had not finished when the officer
 * clicked. Bounded, oldest first, and it never throws — it is called from a
 * scheduled sweep.
 *
 * A row that has been pending for longer than `giveUpHours` is marked failed so
 * it stops being retried forever; the credit is spent either way, and a row that
 * retries for eternity hides a real vendor problem behind steady noise.
 */
async function drainPendingSkipTraces({ limit = 25, giveUpHours = 48 } = {}) {
  const out = { checked: 0, completed: 0, failed: 0, stillPending: 0 };
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT person_id, staff_id, person_name, state, reason, charged, source, occurred_at
         FROM elementix_skip_traces
        WHERE status = 'pending'
        ORDER BY occurred_at
        LIMIT $1`, [Math.max(1, Math.min(200, limit))]));
  } catch (_) { return out; }

  /* THE AGE-OUT IS COMPUTED OUTSIDE THE TRY, and it is checked in the failure
     path too. A row whose settle THROWS — a deactivated officer the lead's
     foreign key refuses, a name the column will not take, any constraint at all —
     took the `continue` branch before it could ever be aged out, so it stayed
     pending, stayed the oldest, was in every following batch, and re-issued a
     real vendor call every two minutes for ever: thirty calls an hour, per bad
     row, out of the allowance the whole company shares. One unworkable row must
     never stall the queue, exactly as in the import. */
  const retire = async (r, detail) => {
    try {
      await db.query(
        `UPDATE elementix_skip_traces SET status='failed', detail=$3
          WHERE person_id=$1 AND staff_id=$2::uuid`, [r.person_id, r.staff_id, clip(detail, 500)]);
    } catch (_) { /* best effort: a failed stamp must not itself poison the sweep */ }
  };

  for (const r of rows) {
    out.checked += 1;
    const ageH = (Date.now() - new Date(r.occurred_at).getTime()) / 3600000;
    const tooOld = !Number.isFinite(ageH) || ageH > giveUpHours;
    try {
      const st = await contactState(r.person_id, { staffId: r.staff_id });
      if (st.ok && st.unlocked) {
        await finishSkipTrace({
          personId: r.person_id, staffId: r.staff_id, reason: r.reason,
          name: r.person_name, state: r.state, charged: r.charged, source: r.source });
        out.completed += 1;
        continue;
      }
      if (tooOld) {
        await retire(r, 'Elementix never returned the contact details for this lookup.');
        out.failed += 1;
      } else {
        out.stillPending += 1;
      }
    } catch (e) {
      /* SAY WHY ON THE ROW. Without this the only record is a counter, and the
         row that is quietly burning the rate limit is invisible. */
      if (tooOld) {
        await retire(r, `PILOT could not file this lookup: ${e && e.message ? e.message : 'unknown error'}`);
        out.failed += 1;
      } else {
        try {
          await db.query(
            `UPDATE elementix_skip_traces SET detail=$3
              WHERE person_id=$1 AND staff_id=$2::uuid`,
            [r.person_id, r.staff_id, clip(`PILOT could not file this lookup: ${e && e.message ? e.message : 'unknown error'}`, 500)]);
        } catch (_) { /* best effort */ }
        out.stillPending += 1;
      }
    }
  }
  return out;
}

module.exports = {
  normalizeContact, primaryContact, phoneKey,
  contactState, skipTrace, finishSkipTrace, drainPendingSkipTraces,
  ensureLead, ensurePerson, storeContact, recordSkipTrace, notifyOfficer,
  _internals: { nameFrom, POLL_ATTEMPTS, POLL_DELAY_MS, PENDING_HOLD_HOURS },
};
