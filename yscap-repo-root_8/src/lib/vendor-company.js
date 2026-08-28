'use strict';
/**
 * VENDORS AS COMPANIES, AND THE CONTACTS BEHIND THEM (owner-directed
 * 2026-08-28): "the vendors should be set up as a company with contacts …
 * go based on the domain on the email address … you can click add people from
 * this company … fetch company contacts from the email chain … before you send
 * out the title email or insurance email, you can select add file contacts from
 * this company … The vendors that have the same email address should get merged
 * … stuff that is missing from one profile and not on the other profile should
 * get merged automatically. The only thing when it should ask … should be if
 * something is conflicting."
 *
 * THREE CAPABILITIES, one module:
 *
 *  1. THE COMPANY IS THE EMAIL DOMAIN. `emailDomain` names a contact's company
 *     key — with the free-mail guard, because everyone at gmail.com is not one
 *     company. `companyContacts(domain)` lists the PEOPLE the vendor pool holds
 *     at that company, which is what "add people from this company" offers.
 *
 *  2. HARVEST FROM THE EMAIL CHAINS. When the title company's reply CCs their
 *     own closing@ or an assistant at the same domain, those addresses are
 *     already kept ON THE THREAD (lib/email/thread-participants — every later
 *     reply and follow-up includes them automatically). `harvestThreadContacts`
 *     surfaces them AS PEOPLE: every same-domain address seen on the file's
 *     vendor chains that the vendor's own card does not carry yet, so the desk
 *     can add each one as a real file contact in one click.
 *
 *  3. AUTO-MERGE THE SAME-EMAIL DUPLICATES. Two vendor rows sharing an email
 *     ARE one vendor. `autoMergeSameEmail` merges every such pair where nothing
 *     CONFLICTS — gaps fill from the other side, emails/phones UNION (an extra
 *     phone number just adds — the owner's own example), file links re-point,
 *     the loser is soft-marked exactly like the manual merge door. A pair where
 *     both sides carry a DIFFERENT company name or contact name is a CONFLICT:
 *     it is never auto-merged, it is reported for the human merge screen, which
 *     is exactly what the owner asked ("the only thing when it should ask …
 *     should be if something is conflicting").
 */
const db = require('../db');
const dir = require('./vendor-directory');

/* Domains that are PEOPLE, not companies. A vendor on gmail is a person with a
   mailbox; folding every gmail vendor into one "company" would wire strangers
   together. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'protonmail.com', 'proton.me', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'optonline.net', 'mail.com', 'zoho.com',
]);

/** The company domain of an email — null for free-mail / unparseable. */
function emailDomain(email) {
  const m = /@([A-Za-z0-9.-]+)$/.exec(String(email || '').trim().toLowerCase());
  if (!m) return null;
  const d = m[1];
  return FREE_MAIL.has(d) ? null : d;
}

/** The company domain a CONTACT ROW belongs to — the first corporate domain any
    of its emails carries. */
function contactDomain(row) {
  for (const e of dir.allEmails(row)) {
    const d = emailDomain(e);
    if (d) return d;
  }
  return null;
}

/** Every live (unmerged) vendor-pool contact at a company domain. */
async function companyContacts(domain, client = db) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return [];
  const r = await client.query(
    `SELECT * FROM service_contacts
      WHERE merged_into_id IS NULL
        AND (lower(COALESCE(email,'')) LIKE $1
             OR EXISTS (SELECT 1 FROM unnest(COALESCE(emails, '{}'::text[])) e WHERE lower(e) LIKE $1))
      ORDER BY last_used_at DESC NULLS LAST, updated_at DESC NULLS LAST
      LIMIT 50`, [`%@${d}`]);
  // The LIKE is a coarse net (it would also catch @sub.domain) — the exact
  // domain test happens here, in one place, with the free-mail guard applied.
  return r.rows.filter((row) => dir.allEmails(row).some((e) => emailDomain(e) === d));
}

/**
 * The same-domain addresses seen on this file's vendor email chains that the
 * vendor's card does not carry yet — each a PERSON at the company worth saving
 * as a contact. `msgTypes` scopes to the order's own chain (title_message /
 * insurance_message / …), exactly like thread-participants.
 * Returns [{ email, name }] (name best-effort from the from_name of a message
 * that address SENT, else null).
 */
async function harvestThreadContacts(appId, { domain, msgTypes, exclude = [] }, client = db) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d || !Array.isArray(msgTypes) || !msgTypes.length) return [];
  const excluded = new Set((exclude || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
  const r = await client.query(
    `SELECT direction, from_email, from_name, to_emails, cc_emails
       FROM email_messages
      WHERE application_id=$1 AND msg_type = ANY($2::text[])
      ORDER BY occurred_at DESC LIMIT 200`, [appId, msgTypes]);
  const found = new Map();   // lower email -> { email, name }
  const consider = (email, name) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e || excluded.has(e) || found.has(e)) return;
    if (emailDomain(e) !== d) return;
    found.set(e, { email: e, name: (name && String(name).trim()) || null });
  };
  for (const m of r.rows) {
    if (m.direction === 'inbound') consider(m.from_email, m.from_name);
    for (const list of [m.to_emails, m.cc_emails]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item == null) continue;
        if (typeof item === 'string') consider(item, null);
        else consider(item.email, item.name);
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// AUTO-MERGE — same email means same vendor
// ---------------------------------------------------------------------------

const normText = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Do two rows CONFLICT on a scalar field? Only when BOTH carry a value and the
    values genuinely differ (normalized) — a blank against a value is a GAP, and
    gaps fill automatically. */
function fieldConflict(a, b) {
  const na = normText(a); const nb = normText(b);
  return !!(na && nb && na !== nb);
}

/** The conflict verdict for a pair. Contact TYPE differing is a conflict too —
    a title company and an insurance agent sharing an inbox is a thing a human
    should look at, never an auto-fold. */
function pairConflicts(a, b) {
  const out = [];
  if (fieldConflict(a.company_name, b.company_name)) out.push('company_name');
  if (fieldConflict(a.contact_name, b.contact_name)) out.push('contact_name');
  if (fieldConflict(a.address, b.address)) out.push('address');
  if (a.contact_type && b.contact_type && a.contact_type !== b.contact_type) out.push('contact_type');
  return out;
}

/** Merge `merged` into `survivor` (both locked rows), conservative semantics:
    gaps fill, arrays union, links re-point, loser soft-marked. */
async function mergePairTx(client, survivor, merged) {
  const emails = dir.allEmails({ email: survivor.email, emails: [...dir.allEmails(survivor), ...dir.allEmails(merged)] });
  const phones = dir.allPhones({ phone: survivor.phone, phones: [...dir.allPhones(survivor), ...dir.allPhones(merged)] });
  await client.query(
    `UPDATE service_contacts
        SET company_name = COALESCE(NULLIF(company_name,''), $2),
            contact_name = COALESCE(NULLIF(contact_name,''), $3),
            address      = COALESCE(NULLIF(address,''), $4),
            notes        = COALESCE(NULLIF(notes,''), $5),
            email        = COALESCE(NULLIF(email,''), $6),
            phone        = COALESCE(NULLIF(phone,''), $7),
            emails       = $8, phones = $9, updated_at = now()
      WHERE id = $1`,
    [survivor.id, merged.company_name, merged.contact_name, merged.address, merged.notes,
      merged.email, merged.phone,
      emails.length ? emails : null, phones.length ? phones : null]);
  await client.query(
    `UPDATE application_service_contacts SET service_contact_id=$2
      WHERE service_contact_id=$1
        AND NOT EXISTS (
          SELECT 1 FROM application_service_contacts x
           WHERE x.application_id = application_service_contacts.application_id
             AND x.service_contact_id = $2)`, [merged.id, survivor.id]);
  await client.query(`DELETE FROM application_service_contacts WHERE service_contact_id=$1`, [merged.id]);
  await client.query(
    `UPDATE service_contacts SET merged_into_id=$2, merged_at=now(), updated_at=now() WHERE id=$1`,
    [merged.id, survivor.id]);
}

/**
 * Find every pair of live vendor rows sharing an email; merge the clean pairs,
 * report the conflicted ones. `dryRun` reports both lists and writes nothing.
 * Returns { merged: [{survivorId, mergedId, email}], conflicts: [{aId, bId,
 * email, fields}] }. Never throws — a pair that fails mid-merge is reported.
 */
async function autoMergeSameEmail({ dryRun = false } = {}) {
  const rows = (await db.query(
    `SELECT * FROM service_contacts WHERE merged_into_id IS NULL`)).rows;
  const byEmail = new Map();
  for (const r of rows) {
    for (const e of dir.allEmails(r)) {
      const k = String(e).toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, []);
      byEmail.get(k).push(r);
    }
  }
  const merged = []; const conflicts = []; const consumed = new Set();
  for (const [email, group] of byEmail) {
    if (group.length < 2) continue;
    // Survivor = the most complete card (the manual merge's own tie-break).
    const sorted = [...group].sort((a, b) => dir._internals.completeness(b) - dir._internals.completeness(a));
    const survivor = sorted[0];
    for (const other of sorted.slice(1)) {
      if (consumed.has(other.id) || consumed.has(survivor.id) || other.id === survivor.id) continue;
      const fields = pairConflicts(survivor, other);
      if (fields.length) { conflicts.push({ aId: survivor.id, bId: other.id, email, fields }); continue; }
      if (dryRun) { merged.push({ survivorId: survivor.id, mergedId: other.id, email, dryRun: true }); continue; }
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        const sv = (await client.query(`SELECT * FROM service_contacts WHERE id=$1 FOR UPDATE`, [survivor.id])).rows[0];
        const md = (await client.query(`SELECT * FROM service_contacts WHERE id=$1 FOR UPDATE`, [other.id])).rows[0];
        if (!sv || !md || sv.merged_into_id || md.merged_into_id) { await client.query('ROLLBACK'); continue; }
        await mergePairTx(client, sv, md);
        await client.query('COMMIT');
        merged.push({ survivorId: survivor.id, mergedId: other.id, email });
        consumed.add(other.id);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* already down */ }
        conflicts.push({ aId: survivor.id, bId: other.id, email, fields: ['merge_failed'] });
      } finally { client.release(); }
    }
  }
  return { merged, conflicts };
}

module.exports = {
  FREE_MAIL, emailDomain, contactDomain, companyContacts,
  harvestThreadContacts, autoMergeSameEmail,
  _internals: { fieldConflict, pairConflicts, mergePairTx },
};
