'use strict';
/**
 * THE FILE'S VENDOR CONTACTS — one writer for "put this vendor on this file".
 *
 * Owner-reported 2026-09-01, three defects with one root:
 *
 *   1. "An officer ordered insurance from one agent, and then the client changed
 *      agents. There is a button in the order section to order from somewhere
 *      else … and it's ordering now from both agents." — the Orders desk's
 *      "Use a different one" ADDED a second contact of the same type and never
 *      retired the first; the order then addressed the most recently used one
 *      and Cc'd every other of that type (orders.getOrderData's vendorsExtra),
 *      and the thread-participants rewind kept re-adding the old agent from
 *      their earlier replies.
 *   2. "Somebody changed the insurance agent on the file, and then he changed
 *      back to the same insurance agent … Now it populates twice." — every add
 *      INSERTed a fresh service_contacts row; nothing looked for the vendor that
 *      already existed. The table has no unique key (db/017, db/078, db/224).
 *   3. "Based on the document that you accept, this system shall keep the
 *      information of the insurance agent … who sent these documents." — no
 *      document carried its sender, so nothing could decide.
 *
 * So this module is the ONE definition of:
 *   · upsertContact   — find the live directory row this vendor already has
 *                       (same type, same email — or same name when no email) and
 *                       fill its gaps, or link an existing row by id, or insert;
 *                       never a second row for the same company.
 *   · linkContact     — attach it to the file (idempotent on the link).
 *   · replaceSameType — retire every OTHER contact of that type on the file:
 *                       their addresses are recorded on the order
 *                       (file_orders.meta.retiredVendorEmails) so the reply /
 *                       follow-up doors stop re-adding them from the thread, and
 *                       their links are removed.
 *   · adoptVendorFromAcceptedDocument — when staff ACCEPT a returned order
 *                       document, the contact whose address SENT it becomes the
 *                       file's vendor of record for that order and the others
 *                       are retired.
 *   · retiredVendorEmails — read side for the `never` lists.
 *
 * Both products' routes (staff + borrower) call these rather than writing
 * service_contacts themselves. RTL only.
 */

const VD = require('./vendor-directory');

/** A file-contact type → the order it is the vendor for (null = not an order vendor). */
const ORDER_TYPE_OF_CONTACT = Object.freeze({
  title_company: 'title',
  insurance_agent: 'insurance',
  flood_insurance: 'flood_insurance',
});

/** Returned-document kinds → the contact type that sends them. */
const CONTACT_TYPE_OF_RETURN_DOC = Object.freeze({
  title_order_return: 'title_company',
  insurance_order_return: 'insurance_agent',
});

const normEmail = (e) => VD._internals.normEmail(e);
const normName = (n) => VD._internals.normName(n);
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };

function cleanEmails(list) {
  return VD.dedupBy((Array.isArray(list) ? list : []).filter(Boolean), normEmail);
}

/**
 * The live directory row this vendor already is, if any. Same contact_type, and
 * either an email in common or — when the incoming contact has no email at all —
 * the same normalized company name (or contact name when there is no company).
 * Merged rows (merged_into_id set) are never matched: the survivor is.
 */
async function findLiveMatch(q, { type, emails, companyName, contactName }) {
  const keys = (emails || []).map(normEmail).filter(Boolean);
  if (keys.length) {
    const r = await q.query(
      `SELECT * FROM service_contacts
        WHERE contact_type = $1 AND merged_into_id IS NULL
          AND (lower(btrim(coalesce(email,''))) = ANY($2::text[])
               OR EXISTS (SELECT 1 FROM unnest(coalesce(emails, '{}'::text[])) e
                           WHERE lower(btrim(e)) = ANY($2::text[])))
        ORDER BY last_used_at DESC NULLS LAST, updated_at DESC NULLS LAST
        LIMIT 1`, [type, keys]);
    return r.rows[0] || null;
  }
  const name = normName(companyName || contactName || '');
  if (!name) return null;
  const r = await q.query(
    `SELECT * FROM service_contacts
      WHERE contact_type = $1 AND merged_into_id IS NULL
        AND (email IS NULL OR btrim(email) = '')
        AND lower(regexp_replace(coalesce(company_name, contact_name, ''), '[^a-z0-9]+', '', 'gi')) = $2
      ORDER BY last_used_at DESC NULLS LAST
      LIMIT 1`, [type, name]);
  return r.rows[0] || null;
}

/**
 * Find-or-update-or-insert. Returns { id, reused, created }.
 *
 * `contactId` — link an existing directory row (the type-ahead pick); its gaps are
 * filled from what was typed, nothing it already holds is overwritten.
 * Otherwise the incoming details are matched against the live directory; a match
 * is filled (COALESCE — a blank never erases a value; emails/phones are unioned);
 * no match inserts.
 */
async function upsertContact(q, p) {
  const type = p.type || 'other';
  const emails = cleanEmails(p.emails && p.emails.length ? p.emails : (p.email ? [p.email] : []));
  const companyName = clean(p.companyName), contactName = clean(p.contactName);
  const phone = clean(p.phone), address = clean(p.address), notes = clean(p.notes), custom = clean(p.customType);

  let row = null;
  if (p.contactId) {
    const r = await q.query(`SELECT * FROM service_contacts WHERE id = $1 AND merged_into_id IS NULL`, [p.contactId]);
    row = r.rows[0] || null;
    if (!row) { const e = new Error('That vendor is no longer in the directory.'); e.status = 404; throw e; }
  } else {
    row = await findLiveMatch(q, { type, emails, companyName, contactName });
  }

  if (row) {
    const mergedEmails = VD.dedupBy([row.email, ...(Array.isArray(row.emails) ? row.emails : []), ...emails], normEmail);
    await q.query(
      `UPDATE service_contacts SET
          company_name = COALESCE(company_name, $2),
          contact_name = COALESCE(contact_name, $3),
          email        = COALESCE(email, $4),
          emails       = CASE WHEN cardinality($5::text[]) > 0 THEN $5::text[] ELSE emails END,
          phone        = COALESCE(phone, $6),
          address      = COALESCE(address, $7),
          notes        = COALESCE(notes, $8),
          custom_type  = COALESCE(custom_type, $9),
          last_used_at = now(), updated_at = now()
        WHERE id = $1`,
      [row.id, companyName, contactName, mergedEmails[0] || null, mergedEmails, phone, address, notes, custom]);
    return { id: row.id, reused: true, created: false };
  }

  const ins = await q.query(
    `INSERT INTO service_contacts
       (borrower_id, contact_type, custom_type, company_name, contact_name, email, emails, phone, address, notes,
        added_by_staff_id, added_by_borrower_id, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) RETURNING id`,
    [p.borrowerId || null, type, type === 'other' ? custom : null, companyName, contactName,
     emails[0] || null, emails.length ? emails : null, phone, address, notes,
     p.addedByStaffId || null, p.addedByBorrowerId || null]);
  return { id: ins.rows[0].id, reused: false, created: true };
}

/** Attach a directory row to a file. Idempotent on (file, contact). Returns the link id. */
async function linkContact(q, { applicationId, contactId, type, addedByKind, addedById }) {
  const r = await q.query(
    `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type, added_by_kind, added_by_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (application_id, service_contact_id) DO UPDATE SET contact_type = EXCLUDED.contact_type
     RETURNING id`, [applicationId, contactId, type, addedByKind, addedById || null]);
  // A vendor coming (back) onto the file is not retired any more.
  await unretire(q, { applicationId, contactId, type }).catch(() => {});
  return r.rows[0].id;
}

/** Every address a directory row carries, normalized. */
function emailsOfRow(row) { return VD.allEmails(row).map(normEmail).filter(Boolean); }

/** The addresses retired from an order's thread, lowercased. Reads file_orders.meta. */
function retiredVendorEmails(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const list = Array.isArray(m.retiredVendorEmails) ? m.retiredVendorEmails : [];
  return VD.dedupBy(list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean), (x) => x);
}

async function retire(q, { applicationId, orderType, emails }) {
  if (!orderType || !emails || !emails.length) return;
  await q.query(
    `UPDATE file_orders
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('retiredVendorEmails',
              (SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb) FROM (
                 SELECT jsonb_array_elements_text(COALESCE(meta->'retiredVendorEmails', '[]'::jsonb)) AS e
                 UNION SELECT unnest($3::text[])) u)),
            updated_at = now()
      WHERE application_id = $1 AND order_type = $2`, [applicationId, orderType, emails]);
}

async function unretire(q, { applicationId, contactId, type }) {
  const orderType = ORDER_TYPE_OF_CONTACT[type];
  if (!orderType) return;
  const row = (await q.query(`SELECT * FROM service_contacts WHERE id = $1`, [contactId])).rows[0];
  const mine = row ? emailsOfRow(row) : [];
  if (!mine.length) return;
  await q.query(
    `UPDATE file_orders
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('retiredVendorEmails',
              (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM
                 jsonb_array_elements_text(COALESCE(meta->'retiredVendorEmails', '[]'::jsonb)) e
                WHERE NOT (lower(e) = ANY($3::text[])))),
            updated_at = now()
      WHERE application_id = $1 AND order_type = $2`, [applicationId, orderType, mine]);
}

/**
 * Make `keepContactId` the ONLY contact of its type on the file. The others'
 * addresses are retired from the order's thread and their links removed.
 * Returns { removed: [{contactId, linkId}], retiredEmails: [] }.
 */
async function replaceSameType(q, { applicationId, keepContactId, type }) {
  const others = (await q.query(
    `SELECT l.id AS link_id, sc.*
       FROM application_service_contacts l JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id = $1 AND l.contact_type = $2 AND l.service_contact_id <> $3`,
    [applicationId, type, keepContactId])).rows;
  if (!others.length) return { removed: [], retiredEmails: [] };
  const keep = (await q.query(`SELECT * FROM service_contacts WHERE id = $1`, [keepContactId])).rows[0];
  const keepEmails = new Set(keep ? emailsOfRow(keep) : []);
  // Never retire an address the surviving vendor also uses (a shared office inbox).
  const retiredEmails = VD.dedupBy(others.flatMap(emailsOfRow).filter((e) => !keepEmails.has(e)), (x) => x);
  await retire(q, { applicationId, orderType: ORDER_TYPE_OF_CONTACT[type], emails: retiredEmails });
  await q.query(`DELETE FROM application_service_contacts WHERE id = ANY($1::uuid[])`, [others.map((o) => o.link_id)]);
  // The survivor is the order's vendor of record from now on.
  await q.query(`UPDATE service_contacts SET last_used_at = now() WHERE id = $1`, [keepContactId]);
  const orderType = ORDER_TYPE_OF_CONTACT[type];
  if (orderType && keep) {
    await q.query(
      `UPDATE file_orders SET vendor_contact_id = $3, vendor_email = COALESCE($4, vendor_email),
              vendor_name = COALESCE($5, vendor_name), updated_at = now()
        WHERE application_id = $1 AND order_type = $2`,
      [applicationId, orderType, keep.id, keep.email || null, keep.company_name || keep.contact_name || null]).catch(() => {});
  }
  return { removed: others.map((o) => ({ contactId: o.id, linkId: o.link_id })), retiredEmails };
}

/**
 * A returned order document was ACCEPTED: the vendor who SENT it is the one the
 * file keeps. Only acts when the document is an order return with a recorded
 * sender, the sender matches a contact of that type linked to the file, and there
 * is more than one such contact (one contact needs no deciding). Never throws.
 * Returns { adopted: contactId|null, reason }.
 */
async function adoptVendorFromAcceptedDocument(q, documentId) {
  try {
    const doc = (await q.query(
      `SELECT id, application_id, doc_kind, from_email FROM documents WHERE id = $1`, [documentId])).rows[0];
    if (!doc || !doc.application_id) return { adopted: null, reason: 'no_document' };
    const type = CONTACT_TYPE_OF_RETURN_DOC[doc.doc_kind];
    if (!type) return { adopted: null, reason: 'not_an_order_return' };
    const sender = normEmail(doc.from_email);
    if (!sender) return { adopted: null, reason: 'no_sender' };
    const linked = (await q.query(
      `SELECT sc.* FROM application_service_contacts l JOIN service_contacts sc ON sc.id = l.service_contact_id
        WHERE l.application_id = $1 AND l.contact_type = $2`, [doc.application_id, type])).rows;
    if (linked.length < 2) return { adopted: null, reason: 'nothing_to_decide' };
    const winner = linked.find((c) => emailsOfRow(c).includes(sender));
    if (!winner) return { adopted: null, reason: 'sender_not_a_file_contact' };
    const out = await replaceSameType(q, { applicationId: doc.application_id, keepContactId: winner.id, type });
    return { adopted: winner.id, type, removed: out.removed, retiredEmails: out.retiredEmails, reason: 'adopted' };
  } catch (e) {
    console.warn('[file-contacts] adopt-from-accepted-document failed (non-fatal):', e && e.message);
    return { adopted: null, reason: 'error' };
  }
}

module.exports = {
  ORDER_TYPE_OF_CONTACT, CONTACT_TYPE_OF_RETURN_DOC,
  upsertContact, linkContact, replaceSameType, retiredVendorEmails, adoptVendorFromAcceptedDocument,
  _internals: { findLiveMatch, cleanEmails, retire, unretire, emailsOfRow },
};
