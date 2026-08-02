'use strict';
/**
 * WHO IS THIS APPRAISER? — the identity rule for the appraiser registry (db/409).
 *
 * The same person signs report after report and spells themselves differently
 * every time: "John Q. Appraiser", "JOHN Q APPRAISER, SRA", "John Appraiser" at
 * two different firms. The registry has to fold those into ONE record without
 * ever merging two DIFFERENT people, because the record carries their licence
 * and every file they appraised for us.
 *
 * TWO TIERS, strongest first:
 *
 *   1. THE LICENCE — `lic:<STATE>:<ID>`. A state certification number is issued
 *      to one human and is printed on every report they sign. When the report
 *      carries both a state and an id, that IS the identity, and the name is
 *      only a label on it. This is what makes a firm-change ("moved from Acme to
 *      Bravo Appraisal") keep one record instead of forking into two.
 *
 *   2. THE NAME + FIRM — `name:<name key>|<company key>`. The fallback for a
 *      report with no licence number. The firm is part of the key on purpose:
 *      without it, two different "J Smith"s at two different firms in two states
 *      would collapse into one person, which is a much worse error than carrying
 *      the same person twice. A later report from the same person WITH a licence
 *      does not retro-merge the name-keyed record — merging identities is a
 *      human decision, and this module deliberately does not make it.
 *
 * NAME NORMALIZATION strips only what is never part of a person: professional
 * suffixes and designations (SRA, MAI, ASA, IFA, Cert. Res., St. Cert. Gen.,
 * Jr/Sr/III), punctuation, and case. It does NOT strip middle initials — "J A
 * Smith" and "J B Smith" are two people.
 *
 * Pure. No database, no IO. Returns null when there is not enough to identify
 * anybody, and the caller then leaves the report unlinked rather than inventing
 * an appraiser.
 */

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Professional designations / credentials / generational suffixes that follow a
// name. Matched as whole tokens at the END of the name, repeatedly, so
// "John Smith, SRA, MAI" reduces to "john smith".
const SUFFIXES = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'v',
  'sra', 'mai', 'asa', 'ifa', 'ifas', 'ara', 'rm', 'sropa', 'srpa', 'gaa', 'raa',
  'cre', 'frics', 'mrics', 'ccim', 'crp',
  'certified', 'cert', 'residential', 'general', 'appraiser', 'state', 'st', 'licensed',
]);

/** A comparable key for a person's name. */
function nameKey(raw) {
  let s = collapse(raw).toLowerCase()
    .replace(/[.,'’"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  let toks = s.split(' ').filter(Boolean);
  // Peel credential tokens off the END only. A leading "Certified" is not a name
  // either, but names never start with these in practice and peeling from the
  // front risks eating a real first name.
  while (toks.length > 1 && SUFFIXES.has(toks[toks.length - 1])) toks.pop();
  // A single remaining token is a surname with no first name — too weak to be an
  // identity on its own.
  return toks.join(' ');
}

// Firm-type words that a vendor adds or drops at random on the same firm.
const FIRM_NOISE = /\b(llc|l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pc|pa|group|services|service|associates|assoc|and|&)\b/g;

/**
 * A comparable key for a company / firm name.
 *
 * ORDER MATTERS HERE. The dots come out FIRST, so "L.L.C." collapses to "llc" and
 * is recognised as the firm-type noise it is. Replacing every punctuation mark
 * with a space instead (the obvious version) turns it into "l l c", which no
 * word-boundary pattern can match — and then "Acme Appraisal LLC" and
 * "Acme Appraisal, L.L.C." are two different firms.
 */
function companyKey(raw) {
  const s = collapse(raw).toLowerCase()
    .replace(/\./g, '')              // L.L.C. -> llc, Inc. -> inc
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(FIRM_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** A licence id key — case-folded, with the punctuation vendors sprinkle in removed. */
function licenseKey(raw) {
  return collapse(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A US state as its two-letter code, or ''. Kept local so this module stays pure. */
const ADDR = require('../address');
function stateKey(raw) {
  const s = ADDR.stateAbbr(collapse(raw));
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : '';
}

/**
 * The identity of the appraiser who signed a report.
 * @returns {{key,nameKey,companyKey,tier}|null}
 *   tier is 'license' or 'name' — surfaced so the UI can say how confident the
 *   grouping is, and so a future merge tool knows which records are the soft ones.
 */
function appraiserIdentity({ name, company, licenseId, licenseState } = {}) {
  const nk = nameKey(name);
  const ck = companyKey(company);
  const lid = licenseKey(licenseId);
  const lst = stateKey(licenseState);
  if (lid && lst) {
    return { key: `lic:${lst}:${lid}`, nameKey: nk, companyKey: ck, tier: 'license' };
  }
  // No licence: a name alone must still be a real name (two tokens or more).
  if (!nk || nk.split(' ').length < 2) return null;
  return { key: ck ? `name:${nk}|${ck}` : `name:${nk}`, nameKey: nk, companyKey: ck, tier: 'name' };
}

/** A normalized key for a contact value (email/phone/company/address) — the dedupe key. */
function contactKey(kind, value) {
  const v = collapse(value);
  if (!v) return '';
  if (kind === 'email') return v.toLowerCase();
  if (kind === 'phone') { const d = v.replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; }
  if (kind === 'company') return companyKey(v);
  return v.toLowerCase().replace(/[.,'’"]/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { appraiserIdentity, nameKey, companyKey, licenseKey, stateKey, contactKey };
