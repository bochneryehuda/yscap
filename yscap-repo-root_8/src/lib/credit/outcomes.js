'use strict';

/**
 * Credit-pull outcome catalog: turn raw vendor error codes and per-bureau
 * conditions into ONE internal vocabulary with a friendly, actionable staff
 * message. Every UI, review reason, and rule keys off this instead of raw
 * strings. Pure — no DB, no network.
 *
 * Two worlds collapse into one enum here:
 *  - REQUEST-level failures: Xactus `E0xx` codes (the whole call failed).
 *  - BUREAU-level conditions: frozen file, no-hit, no-score, deceased, fraud —
 *    these ride INSIDE a successful response, per repository.
 *
 * Message principles (from the error-handling research): name the specific
 * condition, say WHO must act, give the exact next step, never blame the borrower
 * for a system fault, and tag whether a retry costs money.
 *
 * Severity: 'block' (nothing usable / must stop) | 'review' (stored, needs a
 * human) | 'partial' (proceed on the bureaus that returned) | 'info'.
 * Owner: who resolves it — 'borrower' | 'staff' | 'ops' | 'compliance'.
 */

// Request-level Xactus error codes → friendly outcome. Grouped by prefix range
// so an unlisted code in a known family still maps sensibly.
const ERROR_CATALOG = {
  E001: { key: 'vendor_generic', severity: 'review', owner: 'ops', retriable: true, billable: false,
    message: 'The credit service returned a generic error — no charge. Retry shortly; if it persists, contact Xactus.' },
  E037: { key: 'bad_password', severity: 'block', owner: 'ops', retriable: false, billable: false,
    message: 'Your Xactus password was rejected — no borrower data was sent. Update your credit login in Settings.' },
  E046: { key: 'bad_login', severity: 'block', owner: 'ops', retriable: false, billable: false,
    message: 'Your Xactus login was rejected — no borrower data was sent. Update your credit login in Settings.' },
  E051: { key: 'account_inactive', severity: 'block', owner: 'ops', retriable: false, billable: false,
    message: 'Your Xactus account isn’t active for this product / permissible purpose. Contact your Xactus admin — do not work around it.' },
  E061: { key: 'reissue_mismatch', severity: 'block', owner: 'staff', retriable: false, billable: false,
    message: 'Reissue failed — the name/SSN/address don’t match the original report, or it’s older than 30 days. Order a brand-new report instead.' },
  E101: { key: 'malformed_request', severity: 'block', owner: 'ops', retriable: false, billable: false,
    message: 'The request was malformed (schema error) — no charge. This is a system issue; report it.' },
  E102: { key: 'malformed_request', severity: 'block', owner: 'ops', retriable: false, billable: false,
    message: 'The request failed schema validation — no charge. This is a system issue; report it.' },
  E999: { key: 'vendor_generic', severity: 'review', owner: 'ops', retriable: true, billable: false,
    message: 'The credit service returned an unspecified error — no charge. Retry shortly.' },
};

// A bad-data family (E002–E031): missing/invalid name, SSN, DOB, or address.
function dataErrorFor(code) {
  return { key: 'bad_input', severity: 'block', owner: 'staff', retriable: false, billable: false,
    message: `The bureau couldn’t use the borrower’s identity data (${code}). Check the SSN (9 digits), date of birth, legal name, and a complete current address, then resubmit — no charge for a correction.` };
}

// Bureau-level conditions detected from text/reason. Keyed by a normalized tag.
const BUREAU_CONDITIONS = {
  frozen: { severity: 'partial', owner: 'borrower',
    message: 'file is frozen — ask the borrower to lift (thaw) the freeze with that bureau, then reissue just that bureau. The other bureaus returned normally.' },
  no_hit: { severity: 'partial', owner: 'staff',
    message: 'no file found — verify the SSN/name/DOB; if correct, this is a true no-hit at that bureau.' },
  no_score: { severity: 'review', owner: 'staff',
    message: 'no score could be generated (insufficient credit) — this is NOT a numeric decline; route to manual underwriting.' },
  deceased: { severity: 'block', owner: 'compliance',
    message: 'bureau reports this SSN as deceased — STOP and verify identity; this may be a data error or identity theft.' },
  fraud: { severity: 'block', owner: 'staff',
    message: 'a fraud/security alert is on file — you must verify the borrower’s identity before extending credit.' },
  mixed_file: { severity: 'block', owner: 'staff',
    message: 'the returned file may not match this borrower (name/DOB variance) — do NOT use it until you confirm the match.' },
  ofac: { severity: 'block', owner: 'compliance',
    message: 'a possible OFAC/SDN name match was returned — escalate to BSA/AML review; do not clear it yourself.' },
};

/** Map a code to its outcome, handling the E002–E031 data family by range. */
function outcomeForCode(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (ERROR_CATALOG[c]) return { code: c, ...ERROR_CATALOG[c] };
  const m = /^E0?(\d{1,3})$/.exec(c);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2 && n <= 31) return { code: c, ...dataErrorFor(c) };
  }
  return null;
}

// Classify a per-bureau condition from free text (error text / exclusion reason).
function conditionFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/frozen|freeze|locked|security freeze/.test(t)) return 'frozen';
  if (/deceased|deati?on|death/.test(t)) return 'deceased';
  if (/fraud|active duty|security alert|victim/.test(t)) return 'fraud';
  if (/ofac|sdn|sanction/.test(t)) return 'ofac';
  if (/no (record|file|hit)|not found|no data|unable to locate/.test(t)) return 'no_hit';
  if (/insufficient|no recent|no score|thin file|too new/.test(t)) return 'no_score';
  if (/mixed|different (name|person)|does not match|identity/.test(t)) return 'mixed_file';
  return null;
}

/** Friendly description of one parsed error object {layer,code,description,texts}. */
function describeError(err) {
  if (!err) return null;
  const byCode = outcomeForCode(err.code);
  if (byCode) return byCode;
  const text = err.description || (Array.isArray(err.texts) ? err.texts.join('; ') : '');
  const cond = conditionFromText(text);
  if (cond) return { code: err.code || null, key: cond, ...BUREAU_CONDITIONS[cond] };
  return { code: err.code || null, key: 'vendor_error', severity: 'review', owner: 'staff', retriable: false, billable: true,
    message: text ? `The bureau returned: ${text}` : 'The bureau returned an error — see the report.' };
}

/**
 * Build a single staff-facing review reason from a parsed response + scored
 * result. Collapses per-bureau conditions and vendor errors into readable,
 * actionable lines. Also returns the highest severity + owners for routing.
 */
function summarizeOutcome(parsed, scored) {
  const lines = [];
  let severity = 'info';
  const owners = new Set();
  const rank = { info: 0, partial: 1, review: 2, block: 3 };
  const bump = (s) => { if (rank[s] > rank[severity]) severity = s; };

  for (const e of (parsed.errors || [])) {
    const d = describeError(e);
    if (d) { lines.push(d.message); bump(d.severity); if (d.owner) owners.add(d.owner); }
  }
  // Review is driven by a borrower having NO usable middle score (all bureaus
  // no-score / excluded), not by individual leftover score nodes: a valid file
  // with 3 usable mortgage scores often ALSO carries extra non-mortgage-model or
  // empty score nodes, and flagging those forced valid imports to review. Serious
  // per-bureau conditions (freeze / deceased / fraud / OFAC / no-hit) surface via
  // parsed.errors (CREDIT_FILE status + alert messages) above, so they still
  // route to review without this over-firing on leftovers.
  for (const pb of (scored ? scored.perBorrower : [])) {
    const who = pb.identity && pb.identity.firstName ? pb.identity.firstName : pb.reportBorrowerId;
    if (pb.middle && pb.middle.noScore) { lines.push(`${who}: ${BUREAU_CONDITIONS.no_score.message}`); bump('review'); owners.add('staff'); }
  }
  return { reason: [...new Set(lines)].join(' | ').slice(0, 1000), severity, owners: [...owners] };
}

/** Per-bureau status for the "N of 3 bureaus" partial-merge view. */
function bureauStatus(parsed, scored) {
  const out = { equifax: 'absent', experian: 'absent', transunion: 'absent' };
  const key = { Equifax: 'equifax', Experian: 'experian', TransUnion: 'transunion' };
  const rr = parsed.repositoriesReturned || {};
  for (const k of Object.keys(out)) if (rr[k]) out[k] = 'returned';
  for (const pb of (scored ? scored.perBorrower : [])) {
    for (const c of (pb.middle ? pb.middle.classified : [])) {
      const bk = key[c.bureau];
      if (!bk) continue;
      if (c.usable) out[bk] = 'scored';
      else if (out[bk] !== 'scored') out[bk] = c.reason === 'excluded' ? 'excluded' : 'no_score';
    }
  }
  const scored3 = Object.values(out).filter((v) => v === 'scored').length;
  return { perBureau: out, scoredCount: scored3, requested: 3 };
}

module.exports = {
  ERROR_CATALOG, BUREAU_CONDITIONS, outcomeForCode, conditionFromText, describeError,
  summarizeOutcome, bureauStatus,
};
