'use strict';
/**
 * THE VENDOR DIRECTORY — one definition of "which vendors may this person see,
 * and how are two saved rows recognised as one company".
 *
 * Owner-directed 2026-08-20, three connected asks:
 *   · "Every borrower's profile should have all the contacts that he previously
 *      used for title and insurance on his second file … he should be able to
 *      pre-fill from his previous contacts."
 *   · "We already have a database from all the vendors that we're using across
 *      the board. Anywhere you start typing in the insurance contact, title
 *      contact, or any other contact, you should get [suggestions] the same way …
 *      you get a lot of options of addresses. It gives you a lot of options of
 *      the insurance companies that you can auto-populate all the information
 *      just by starting to type."
 *   · "We should be able to add additional email addresses for vendors, and all
 *      emails should be included when we send out the orders."
 *
 * ─── WHO SEES WHAT, AND WHY THE TWO AUDIENCES DIFFER ────────────────────────
 *
 * STAFF get the whole directory. A title company's name, address and business
 * email are not one borrower's private information — they are ours, they are on
 * the Vendors admin screen already, and "the database of all the vendors we use"
 * is exactly what the owner asked to type against. `notes` is DELIBERATELY never
 * returned by the suggester even to staff: it is a free-text field a human filled
 * in beside one borrower's file, so it can as easily say "borrower was difficult"
 * as "ask for Sarah". A vendor's business card travels; a remark about a deal
 * does not.
 *
 * A BORROWER gets ONLY the contacts they themselves have used. That is the first
 * ask in full, and it stops there on purpose: handing an outside party a
 * type-ahead over every title company we work with publishes our vendor roster,
 * which nobody asked for and which cannot be taken back. If the owner wants the
 * curated company list offered to borrowers too, that is one flag here — but it
 * is their call, not an inference from "anywhere you start typing".
 *
 * ─── WHY DE-DUPLICATION IS NOT COSMETIC ─────────────────────────────────────
 *
 * A staff-added file contact is written with the FILE'S borrower_id, so the same
 * title company genuinely exists as one row per deal — dozens of them. A raw
 * type-ahead would show forty identical "Madison Title" rows and be useless, so
 * rows are folded by the SAME keys the vendors screen already uses to propose a
 * merge (normalised name, any email, any phone). Folding never merges anything in
 * the database; it only decides what one list entry looks like, and it keeps the
 * most COMPLETE row as the face while carrying every email and phone the group
 * knows about — which is how "all emails should be included" gets its material.
 *
 * NOTHING HERE WRITES, and `suggest` never throws — a suggester that 500s is worse
 * than one that answers an empty list, because the form still has to be typeable
 * by hand.
 *
 * THE DATABASE IS REQUIRED LAZILY, INSIDE `suggest`, ON PURPOSE. `allEmails` and
 * `dedupBy` are pure and are called from the order builder, which several PURE
 * test suites load with no DATABASE_URL in the environment; a module-level
 * `require('../db')` would drag a database connection into all of them. Only the
 * one function that genuinely needs a database reaches for one.
 */

/* EVERY TYPE A CONTACT CAN BE — the UNION of the three route-level lists that
   already exist (`routes/staff.js` FILE_CONTACT_TYPES, `routes/borrower.js`
   FILE_CONTACT_TYPES and its narrower CONTACT_TYPES for the condition forms) plus
   the vendors screen's own VENDOR_TYPES. Those lists are hand-typed and stay
   where they are — they gate WRITES and are not this module's business — but a
   type any of them accepts must be suggestable, or a contact kind exists that
   nobody can type-ahead for and nothing says why. `test-vendor-directory-pure.js`
   reads all four out of the source and fails the build the day they drift.

   An unknown type answers nothing rather than searching every vendor we have. */
const SUGGEST_TYPES = new Set([
  'title_company', 'insurance_agent', 'flood_insurance', 'attorney', 'settlement_agent',
  'contractor', 'realtor', 'appraiser', 'lender', 'escrow', 'other',
]);

/* The dedup keys, byte-identical in behaviour to the vendors screen's own
   (routes/staff.js vendorNorm*). Kept here so the suggester and the merge
   suggester can never disagree about which two rows are one company. */
const normEmail = (v) => String(v == null ? '' : v).trim().toLowerCase();
const normPhone = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
const normName = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** De-dupe an array by a normalizer, first-seen order, trimmed. */
function dedupBy(arr, norm) {
  const seen = new Set(); const out = [];
  for (const raw of (arr || [])) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    const k = norm(s);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

/**
 * EVERY EMAIL A CONTACT ROW CARRIES, primary first, de-duplicated.
 *
 * THE COLUMN PAIR IS A TRAP AND THIS IS THE ONE PLACE THAT READS IT. db/224 added
 * `emails text[]` beside the legacy scalar `email` and backfilled it — but only
 * for the rows that existed then, and several write paths still set only the
 * scalar. So `emails` is NULL on a lot of live rows and `email` is the only value
 * there, while on others `emails` is the full set and `email` is just its first
 * entry. Reading either one alone loses addresses; reading both and folding them
 * is the only correct answer, and it is what makes "all emails should be included
 * when we send out the orders" true for old rows as well as new ones.
 */
function allEmails(row) {
  if (!row) return [];
  const arr = Array.isArray(row.emails) ? row.emails : [];
  return dedupBy([row.email, ...arr], normEmail);
}

/** The same for phones. */
function allPhones(row) {
  if (!row) return [];
  const arr = Array.isArray(row.phones) ? row.phones : [];
  return dedupBy([row.phone, ...arr], normPhone);
}

/* How much of a contact one row actually carries — the tie-breaker for which of
   a folded group becomes the face. A row with a company name, a contact name, an
   address and two emails is a better business card than one with an email. */
function completeness(r) {
  return (r.company_name ? 2 : 0) + (r.contact_name ? 1 : 0)
    + (r.address ? 1 : 0) + allEmails(r).length + allPhones(r).length;
}

/* Every dedup key a row answers to, so two rows sharing ANY of them fold. */
function keysOf(r) {
  const out = [];
  const n = normName(r.company_name || r.contact_name || '');
  if (n) out.push(`n|${n}`);
  for (const e of allEmails(r)) { const k = normEmail(e); if (k) out.push(`e|${k}`); }
  // A short phone fragment is not an identity — the vendors screen uses the same
  // 7-digit floor, and without it every row with "911" folds into one company.
  for (const p of allPhones(r)) { const k = normPhone(p); if (k.length >= 7) out.push(`p|${k}`); }
  return out;
}

/**
 * Fold rows that describe one company into one suggestion each.
 *
 * Union-find over the shared keys, exactly like the vendors screen's duplicate
 * detector — so "one company" means the same thing in the type-ahead as it does
 * when the screen offers to merge. The FACE is the most complete row (ties go to
 * the most recently used, then the most recently updated, which is what a person
 * typing expects to see first); the emails and phones are the UNION of the group,
 * because that is the material behind "all emails should be included".
 */
function foldGroups(rows) {
  const parent = new Map();
  const find = (x) => { let p = x; while (parent.get(p) && parent.get(p) !== p) p = parent.get(p); return p; };
  const union = (a, b) => { const pa = find(a); const pb = find(b); if (pa !== pb) parent.set(pa, pb); };
  for (const r of rows) parent.set(r.id, r.id);
  const byKey = new Map();
  for (const r of rows) {
    for (const k of keysOf(r)) {
      const seen = byKey.get(k);
      if (seen) union(seen, r.id); else byKey.set(k, r.id);
    }
  }
  const groups = new Map();
  for (const r of rows) {
    const g = find(r.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const time = (v) => { const t = v ? new Date(v).getTime() : 0; return Number.isFinite(t) ? t : 0; };
  const out = [];
  for (const group of groups.values()) {
    const face = group.slice().sort((a, b) => (completeness(b) - completeness(a))
      || (time(b.last_used_at) - time(a.last_used_at))
      || (time(b.updated_at) - time(a.updated_at)))[0];
    const emails = dedupBy(group.flatMap(allEmails), normEmail);
    const phones = dedupBy(group.flatMap(allPhones), normPhone);
    out.push({
      id: face.id,
      contactType: face.contact_type,
      companyName: face.company_name || null,
      contactName: face.contact_name || null,
      email: emails[0] || null,
      emails,
      phone: phones[0] || null,
      phones,
      address: face.address || null,
      // How many saved rows this one suggestion stands for. Shown as "used on N
      // files" — the fastest way for a person to pick the one they actually use.
      usedCount: group.reduce((n, r) => n + (Number(r.files_used) || 0), 0) || group.length,
      lastUsedAt: group.map((r) => r.last_used_at).filter(Boolean)
        .sort((a, b) => time(b) - time(a))[0] || null,
      // Where it came from, so a screen can say "you used this before" against
      // "one of ours". NEVER `notes` — see the header.
      mine: group.some((r) => r.mine === true),
    });
  }
  return out.sort((a, b) => (Number(b.mine) - Number(a.mine))
    || (b.usedCount - a.usedCount)
    || String(a.companyName || a.contactName || '').localeCompare(String(b.companyName || b.contactName || '')));
}

/**
 * Suggest vendors for a type-ahead.
 *
 * @param type       one of SUGGEST_TYPES; anything else answers [].
 * @param q          what has been typed so far. Matched against the company name,
 *                   the contact name and EVERY email — a person often knows the
 *                   agent's address and not the agency's name.
 * @param borrowerId whose own saved contacts count as "mine" (and, for a
 *                   borrower audience, the only ones returned at all).
 * @param audience   'staff' → the whole directory; anything else → this
 *                   borrower's own contacts only. Defaults to the SAFE side.
 * @param limit      capped hard; a type-ahead that returns 500 rows is a hang.
 * @returns Promise<Array> — never throws, answers [] on any failure.
 */
async function suggest({ type, q = '', borrowerId = null, audience = 'borrower', limit = 12 } = {}, dbc = null) {
  try {
    const database = dbc || require('../db');
    const t = String(type || '').trim();
    if (!SUGGEST_TYPES.has(t)) return [];
    const staff = audience === 'staff';
    if (!staff && !borrowerId) return [];
    const term = String(q || '').trim();
    // A blank term is a legitimate ask — it means "show me what I have used" the
    // moment the field is focused, which is the whole prefill half of the request.
    const like = term ? `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const cap = Math.min(Math.max(Number(limit) || 12, 1), 50);

    const rows = (await database.query(
      `SELECT sc.id, sc.contact_type, sc.company_name, sc.contact_name,
              sc.email, sc.emails, sc.phone, sc.phones, sc.address,
              sc.last_used_at, sc.updated_at,
              (sc.borrower_id = $2) AS mine,
              (SELECT count(*)::int FROM application_service_contacts x WHERE x.service_contact_id = sc.id) AS files_used
         FROM service_contacts sc
        WHERE sc.contact_type = $1
          AND sc.merged_into_id IS NULL
          -- AUDIENCE. Staff see the directory; a borrower sees only their own.
          AND ($3::boolean OR sc.borrower_id = $2)
          AND ($4::text IS NULL
               OR sc.company_name ILIKE $4 ESCAPE '\\'
               OR sc.contact_name ILIKE $4 ESCAPE '\\'
               OR sc.email ILIKE $4 ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM unnest(COALESCE(sc.emails,'{}'::text[])) e WHERE e ILIKE $4 ESCAPE '\\'))
          -- A row with nothing on it is not a suggestion.
          AND (COALESCE(btrim(sc.company_name),'') <> '' OR COALESCE(btrim(sc.contact_name),'') <> ''
               OR COALESCE(btrim(sc.email),'') <> '' OR COALESCE(array_length(sc.emails,1),0) > 0)
        ORDER BY (sc.borrower_id = $2) DESC NULLS LAST, sc.last_used_at DESC NULLS LAST, sc.updated_at DESC NULLS LAST
        -- Over-fetch, because folding collapses many rows into one suggestion and
        -- a LIMIT applied before the fold would return three visible options.
        LIMIT $5`,
      [t, borrowerId, staff, like, cap * 20])).rows;

    return foldGroups(rows).slice(0, cap);
  } catch (e) {
    // A type-ahead is an assist, never a gate. The form is still typeable.
    console.warn('[vendor-directory] suggest failed:', e && e.message);
    return [];
  }
}

module.exports = {
  SUGGEST_TYPES, suggest,
  allEmails, allPhones, dedupBy, foldGroups,
  _internals: { normEmail, normPhone, normName, keysOf, completeness },
};
