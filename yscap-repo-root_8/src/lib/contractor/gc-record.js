'use strict';
/**
 * THE GENERAL CONTRACTOR'S RECORD ON A LOAN FILE (db/605, owner-directed 2026-08-21:
 * "You need to add that condition to be informational, to put in: the name / the phone
 * number / the email address / license information … Don't make all the fields
 * required. Maybe business name is optional.")
 *
 * ONE definition of what a GC record IS, so the screen that edits it, the PDF that
 * prints it and the export that ships it can never disagree about a field.
 *
 * IT IS TWO HALVES AND ONLY ONE OF THEM IS NEW. The identity — company, contact name,
 * email, phone, address — is a `service_contacts` row of type 'contractor', which this
 * system has always had and which the file-contacts screen already manages. Adding a
 * second place a contractor's phone number can live is exactly how two records of one
 * company drift, so this READS that one rather than copying it. What is new is the part
 * that is specific to a contractor and would be meaningless on a title company: the
 * license, the two insurance policies, the tax id.
 *
 * WHAT THE FIELDS ARE, AND WHY THESE. The owner asked for name / phone / email /
 * license and for research into "any other official things". What a lender's contractor
 * package actually carries, and what an investor's file review asks for by name:
 *
 *   · the LICENCE, with its STATE and expiry — the number alone does not identify a
 *     license, because it is issued per state and only the pair is checkable against a
 *     public register. Plenty of trades and a few states do not license at all, which
 *     is one reason nothing here is required.
 *   · GENERAL LIABILITY and WORKERS' COMPENSATION, each with carrier, policy number and
 *     expiry. They are kept apart deliberately: they are two different policies, more
 *     often than not from two different carriers, and a file that has one and not the
 *     other is a real state a reviewer has to be able to see.
 *   · the EIN from their W-9 — a BUSINESS identifier that is already on every W-9 in
 *     the file. A personal Social is never typed here; it has its own encrypted home.
 *   · the business address and website, which are how somebody confirms the company is
 *     real before a draw is wired to it.
 *
 * NOTHING IS REQUIRED. That is the owner's instruction and it is also right: a builder
 * hands over a phone number today and an insurance certificate next week, and a record
 * that refuses to be saved until it is complete is a record nobody starts. A blank
 * field simply does not print.
 */

/* THE DATABASE IS REQUIRED LAZILY, ON PURPOSE. Everything above the two query functions
   is a RULE — the field list, what is storable, whether there is anything worth printing
   — and rules are what the PDF builder and the tests need. A top-level `require('../../db')`
   makes reading the field list open a connection (and print a FATAL when there is no
   DATABASE_URL), which is how a pure module stops being usable in the one place it is
   most useful. Same split as urlState.js under useUrlState.js. */
const getDb = () => require('../../db');

/** The credential fields, in the order they are printed. `date` fields are calendar strings. */
const CREDENTIAL_FIELDS = Object.freeze([
  { key: 'license_number',     label: 'License number' },
  { key: 'license_state',      label: 'License state', max: 2, upper: true },
  { key: 'license_expires_on', label: 'License expires', kind: 'date' },
  { key: 'gl_carrier',         label: 'General liability carrier' },
  { key: 'gl_policy_number',   label: 'General liability policy #' },
  { key: 'gl_expires_on',      label: 'General liability expires', kind: 'date' },
  { key: 'wc_carrier',         label: "Workers' comp carrier" },
  { key: 'wc_policy_number',   label: "Workers' comp policy #" },
  { key: 'wc_expires_on',      label: "Workers' comp expires", kind: 'date' },
  { key: 'ein',                label: 'EIN (from the W-9)', max: 20 },
  { key: 'website',            label: 'Website' },
  { key: 'notes',              label: 'Notes', max: 2000 },
]);
const BY_KEY = Object.fromEntries(CREDENTIAL_FIELDS.map((f) => [f.key, f]));
const TEXT_MAX = 200;

const nn = (v) => (v == null ? '' : String(v).replace(/\r\n/g, '\n').trim());

/** A calendar date or null. Never a Date, never a timestamp — the repo's date-only rule. */
function cleanDate(v) {
  const s = nn(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (!isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;   // refuses 2026-02-31
  return s;
}

/** '' when the whole body is storable, else the plain refusal. Everything is optional. */
function credentialProblem(body = {}) {
  for (const f of CREDENTIAL_FIELDS) {
    if (!(f.key in body)) continue;
    const raw = body[f.key];
    if (raw == null || raw === '') continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') return `${f.label} is plain text.`;
    if (f.kind === 'date') {
      if (!cleanDate(raw)) return `${f.label} must be a real date (YYYY-MM-DD).`;
      continue;
    }
    const s = nn(raw);
    const max = f.max || TEXT_MAX;
    if (s.length > max) return `Keep ${f.label.toLowerCase()} under ${max} characters.`;
  }
  return '';
}

/** The storable shape of whatever the caller SENT. A key not sent is not touched. */
function cleanCredentials(body = {}) {
  const out = {};
  for (const f of CREDENTIAL_FIELDS) {
    if (!(f.key in body)) continue;
    if (f.kind === 'date') { out[f.key] = cleanDate(body[f.key]); continue; }
    let s = nn(body[f.key]).slice(0, f.max || TEXT_MAX);
    if (f.upper) s = s.toUpperCase();
    out[f.key] = s || null;
  }
  return out;
}

/**
 * The file's GC record: the linked `contractor` contact plus its credentials.
 * Returns null when the file has no contractor linked — never a fabricated shell.
 */
async function loadForApplication(appId, client = null) {
  client = client || getDb();
  if (!appId) return null;
  const row = (await client.query(
    `SELECT sc.id, sc.company_name, sc.contact_name, sc.email, sc.phone, sc.emails, sc.phones,
            sc.address, sc.notes AS contact_notes,
            c.license_number, c.license_state, c.license_expires_on,
            c.gl_carrier, c.gl_policy_number, c.gl_expires_on,
            c.wc_carrier, c.wc_policy_number, c.wc_expires_on,
            c.ein, c.website, c.notes, c.updated_at AS credentials_updated_at
       FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
       LEFT JOIN contractor_credentials c ON c.service_contact_id = sc.id
      WHERE l.application_id=$1 AND l.contact_type='contractor'
        AND sc.merged_into_id IS NULL
      ORDER BY sc.updated_at DESC NULLS LAST
      LIMIT 1`, [appId])).rows[0];
  return row || null;
}

/** Save the credentials for a contact. Fill-only in the sense that an unsent key is untouched. */
async function saveCredentials(serviceContactId, body, staffId, client = null) {
  client = client || getDb();
  const patch = cleanCredentials(body);
  const keys = Object.keys(patch);
  if (!keys.length) return { saved: false, reason: 'nothing_sent' };
  const cols = ['service_contact_id', ...keys, 'updated_by'];
  const vals = [serviceContactId, ...keys.map((k) => patch[k]), staffId || null];
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const sets = [...keys.map((k) => `${k}=EXCLUDED.${k}`), 'updated_by=EXCLUDED.updated_by', 'updated_at=now()'];
  await client.query(
    `INSERT INTO contractor_credentials (${cols.join(',')}) VALUES (${ph})
     ON CONFLICT (service_contact_id) DO UPDATE SET ${sets.join(', ')}`, vals);
  return { saved: true, fields: keys };
}

/**
 * Is there enough here to be worth printing? A PDF whose every line is a dash is worse
 * than no PDF: it looks like a document and says nothing, and it would ride into an
 * investor package claiming a contractor record exists.
 */
function hasAnything(rec) {
  if (!rec) return false;
  if (nn(rec.company_name) || nn(rec.contact_name) || nn(rec.email) || nn(rec.phone)) return true;
  return CREDENTIAL_FIELDS.some((f) => nn(rec[f.key]));
}

module.exports = { CREDENTIAL_FIELDS, BY_KEY, TEXT_MAX, cleanDate, credentialProblem, cleanCredentials,
  loadForApplication, saveCredentials, hasAnything };
