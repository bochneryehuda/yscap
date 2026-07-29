'use strict';
/**
 * Government-ID findings — compare what the AI analyzer read off a government photo ID
 * against the borrower on file, and raise findings. This is the ID-review the owner
 * described: confirm the date of birth, the spelling of the name, and the primary
 * address match our file; flag anything that doesn't for underwriting review.
 *
 * Owner contract (mirrors src/lib/appraisal/findings.js exactly):
 *   - EVERY mapped field that differs becomes a finding; we NEVER overwrite the file.
 *   - A NAME or DATE-OF-BIRTH mismatch is FATAL (identity) and blocks clear-to-close.
 *   - An ADDRESS mismatch is a WARNING (IDs lag a move; we also check the prior address).
 *   - Fields we could not read with certainty (readable=false or null) are NOT compared —
 *     they route to an underwriting "verify" finding, never a false mismatch.
 *
 * Pure + dependency-free. `id` is the object extracted for the GOVERNMENT_ID schema;
 * `borrower` is the borrowers row (first_name/last_name/date_of_birth/current_address/
 * prior_address). `opts.today` ('YYYY-MM-DD') is injected — no `new Date()` in date
 * paths, matching the appraisal engine. Returns findings in the document_findings shape.
 */
const { norm, addrMatches, addrLine, daysBetween, namesMatchLoose, toISODate } = require('./compare');

// Raw-ish name strings (NOT normalized here — namesMatchLoose needs the comma/order to
// detect "LAST, FIRST"). Prefer first+last; fall back to fullName.
// THE WHOLE name on file, middle name and suffix included (db/345 + db/346) — the
// same value the display line below shows, so the comparison and what a reviewer
// reads can never disagree. `namesMatchLoose` is already middle-name and
// suffix-tolerant, so carrying the middle name here cannot manufacture a
// mismatch against an ID that only prints first + last.
function fileName(b) {
  const full = require('../person-name').displayName(b);
  return full || null;
}
function idName(id) {
  const fn = (id && id.firstName) || '', ln = (id && id.lastName) || '';
  if (norm(fn) || norm(ln)) return `${fn} ${ln}`.trim();
  const full = (id && id.fullName) || '';
  return norm(full) ? full : null;
}

function finding(f) {
  return Object.assign(
    { source: 'government_id', severity: 'fatal', status: 'open', blocksCtc: f.severity !== 'warning' && f.severity !== 'info' },
    f,
  );
}

// Exact calendar age in whole years between two YYYY-MM-DD strings (dob → asOf). Compares month/day
// rather than dividing days by 365.25 (which under-counts across leap years — a person exactly 18
// today would otherwise compute as 17). Returns null on an unparseable pair.
function calendarAge(dobISO, asOfISO) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dobISO || ''));
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asOfISO || ''));
  if (!d || !a) return null;
  const [dy, dm, dd] = [+d[1], +d[2], +d[3]];
  const [ay, am, ad] = [+a[1], +a[2], +a[3]];
  let age = ay - dy;
  if (am < dm || (am === dm && ad < dd)) age -= 1; // birthday hasn't occurred yet this year
  return age;
}

// Normalize the subject into a PEOPLE SET. Accepts EITHER a bare `borrowers` row (the old
// single-borrower subject — back-compat) OR the { people:[...borrowers rows], ownerNames:[...] }
// set the file-view now builds. `people` are the file people we hold a name/DOB/address for; a
// name in `ownerNames` (an LLC owner read off an operating agreement) is an ACCEPTABLE name only —
// a matching ID isn't a mismatch, but we have no DOB/address on record to compare against.
function toPeopleSet(subject) {
  if (!subject) return { people: [], ownerNames: [] };
  if (Array.isArray(subject.people) || Array.isArray(subject.ownerNames)) {
    return {
      people: (subject.people || []).filter(Boolean),
      ownerNames: (subject.ownerNames || []).filter(Boolean),
    };
  }
  return { people: [subject], ownerNames: [] }; // a bare borrowers row → one person
}

// The name we'd show as "the file" when an ID matches nobody. For ONE person this is byte-identical
// to the old `${first} ${last}`; for several it lists them so the reviewer sees who we expected.
function peopleLabel(people) {
  // The WHOLE name of each person on the file (db/345 + db/346) — the same string
  // `fileName` compares the ID against, so what a reviewer reads and what the check
  // decided can never disagree.
  return (people || []).map((p) => require('../person-name').displayName(p))
    .filter(Boolean).join(' / ');
}

/**
 * @param {object} id       fields extracted for the GOVERNMENT_ID schema
 * @param {object} subject  a `borrowers` row (back-compat) OR { people:[rows], ownerNames:[names] }
 * @param {{today?:string}} opts
 * @returns {Array<object>} findings
 */
function computeIdFindings(id, subject, opts = {}) {
  const out = [];
  if (!id) return out;
  const today = opts.today || null;
  const { people, ownerNames } = toPeopleSet(subject);

  // ---- 0. Unreadable → route to underwriting verify, never a false mismatch ----
  const gotName = !!idName(id);
  const gotDob = !!id.dateOfBirth;
  if (id.readable === false || (!gotName && !gotDob)) {
    out.push(finding({ code: 'id_unreadable', severity: 'warning', field: 'document',
      docValue: null, fileValue: null,
      title: 'The ID could not be read with confidence',
      howTo: 'Open the ID and confirm the name, date of birth, and address by hand — nothing is filled in automatically. If the image is poor, request a clearer copy.',
      actions: ['open_condition', 'request_revision', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    return out; // don't raise false mismatches off an unreadable ID
  }

  // ---- 1. Name spelling (identity) ----
  // Tolerant match: middle names/initials, "LAST, FIRST" order, and Jr/Sr suffixes do
  // NOT fire (audit fix); a real spelling difference still does. Resolve the ID to the file
  // person whose name it matches. An ID that matches ANY file person (or a named LLC owner) is
  // legitimate — a co-borrower's ID is no longer a fatal "name mismatch" against the primary.
  const idN = idName(id);
  const matched = idN ? (people.find((p) => namesMatchLoose(idN, fileName(p)) === true) || null) : null;
  const matchesOwner = !!idN && ownerNames.some((n) => namesMatchLoose(idN, n) === true);
  const nameMatchesSomeone = !!matched || matchesOwner;
  // DOB / address are compared against the MATCHED person. On a single-borrower file we still
  // compare against that one borrower even when the name didn't match (an ID with a name typo is
  // still their ID — the name + DOB signals compound, matching the prior behavior) — UNLESS the ID
  // clearly belongs to a named LLC owner, whom we hold no DOB/address for. On a multi-person file an
  // ID that matches nobody has no file record to compare against, so only the name mismatch is
  // raised (no meaningless DOB/address compare against an arbitrary person).
  const person = matched || (people.length === 1 && !matchesOwner ? people[0] : null);
  if (idN && people.length && !nameMatchesSomeone) {
    out.push(finding({ code: 'id_name_mismatch', severity: 'fatal', field: 'name',
      docValue: id.fullName || `${id.firstName || ''} ${id.lastName || ''}`.trim(),
      fileValue: peopleLabel(people),
      title: 'Name on the ID does not match the file',
      howTo: 'Confirm the correct legal name. A spelling difference can be a typo on the file or the wrong ID — reconcile before clear-to-close.',
      actions: ['fix_file', 'keep', 'custom', 'dismiss', 'decline'] }));
  }

  // ---- 2. Date of birth (identity) ----
  // Normalize both to YYYY-MM-DD before comparing so a format difference (05/15/1980 vs
  // 1980-05-15) is not a false fatal (audit fix). Only compare when both parse.
  const idDob = toISODate(id.dateOfBirth);
  const fileDob = person && person.date_of_birth ? toISODate(String(person.date_of_birth).slice(0, 10)) : null;
  if (idDob && fileDob && idDob !== fileDob) {
    out.push(finding({ code: 'id_dob_mismatch', severity: 'fatal', field: 'date_of_birth',
      docValue: id.dateOfBirth, fileValue: fileDob,
      title: 'Date of birth on the ID does not match the file',
      howTo: 'Confirm the correct date of birth. A mismatch here is an identity flag — reconcile before clear-to-close.',
      actions: ['fix_file', 'keep', 'custom', 'dismiss', 'decline'] }));
  }

  // ---- 2b. Age at the DOB (general identity/eligibility flag) ----
  // A borrower who is under 18 can't legally contract — almost always a misread DOB, occasionally a
  // real problem, either way it must be caught. An implausibly high age (>120) is a misread too.
  // Computed off the ID's own DOB (not the file's) so it fires even before the file DOB is entered.
  // CALENDAR age (compare Y/M/D) — NOT days/365.25, which under-counts across leap years and would
  // falsely flag someone who is EXACTLY 18 today as 17.
  if (idDob && today) {
    const years = calendarAge(idDob, today);
    if (years != null) {
      if (years < 18) {
        out.push(finding({ code: 'id_underage', severity: 'warning', field: 'date_of_birth',
          docValue: `${idDob} (age ${years})`, fileValue: '18+ to contract',
          title: 'The ID shows the borrower is under 18',
          howTo: `The ID's date of birth (${idDob}) makes the borrower ${years} — under 18 cannot legally sign the loan. This is almost always a misread date; confirm the real date of birth (or the borrower's eligibility) before clear-to-close.`,
          actions: ['fix_file', 'request_revision', 'custom', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
      } else if (years > 120) {
        out.push(finding({ code: 'id_age_implausible', severity: 'warning', field: 'date_of_birth',
          docValue: `${idDob} (age ${years})`, fileValue: null,
          title: 'The ID’s date of birth gives an impossible age',
          howTo: `The ID's date of birth (${idDob}) works out to age ${years}, which is not plausible — the date was misread. Request a clearer copy and confirm the real date of birth.`,
          actions: ['request_revision', 'fix_file', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
      }
    }
  }

  // ---- 3. Primary address (warning — IDs lag a move; check prior too) ----
  const matchesCurrent = addrMatches(id.address, person && person.current_address);
  if (matchesCurrent === false) {
    const matchesPrior = addrMatches(id.address, person && person.prior_address);
    if (matchesPrior !== true) {
      out.push(finding({ code: 'id_address_mismatch', severity: 'warning', field: 'current_address',
        docValue: addrLine(id.address),
        fileValue: addrLine(person && person.current_address),
        title: 'Address on the ID does not match the file',
        howTo: 'IDs often show a prior address after a move. Confirm the borrower’s current primary address on file; update it or acknowledge the difference.',
        actions: ['fix_file', 'acknowledge', 'custom', 'dismiss'] }));
    }
  }

  // ---- 4. Expired ID ----
  if (id.expirationDate && today) {
    // Normalize the expiry to YYYY-MM-DD first (same discipline as the insurance date checks) so a
    // differently-formatted expiry (e.g. MM/DD/YYYY) is still evaluated rather than silently skipped.
    const days = daysBetween(today, toISODate(id.expirationDate));
    if (days != null && days < 0) {
      out.push(finding({ code: 'id_expired', severity: 'warning', field: 'expiration',
        docValue: id.expirationDate, fileValue: today,
        title: 'The ID is expired',
        howTo: `The ID expired on ${id.expirationDate}. Request a current, unexpired government ID.`,
        actions: ['request_revision', 'acknowledge', 'dismiss'] }));
    }
  }

  return out;
}

// Severity roll-up for the badge + blocking condition (matches appraisal summarize()).
function summarize(findings) {
  const open = (findings || []).filter((f) => f.status === 'open');
  return {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocksCtc),
  };
}

module.exports = { computeIdFindings, summarize, _internals: { norm, addrMatches, daysBetween, idName, fileName } };
