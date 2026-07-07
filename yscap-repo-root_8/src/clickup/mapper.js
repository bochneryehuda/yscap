/**
 * The mapping core — turns a portal file into a ClickUp task payload (push) and
 * a ClickUp task into a portal patch (pull). Pure-ish: no DB/HTTP, so it's
 * unit-testable with fixtures. The orchestrator geocodes addresses, resolves
 * officer/processor ids, encrypts SSN/card, and does the DB writes around it.
 *
 * Implements docs/CLICKUP-DATA-MAPPING.md Parts 3 + 6 + 7. Directions:
 *   both  — ⇄     push — portal→CU only     pull — CU→portal only
 * Dropdowns write the option UUID (resolved from the live option list) and read
 * the orderindex integer, always through crosswalk/transforms.
 */
const F = require('./fields');
const X = require('./crosswalk');
const T = require('./transforms');
const ADDR = require('../lib/address');

/**
 * Normalize a ClickUp `location` custom-field value into the portal's canonical
 * address object. ClickUp returns `{ location:{lat,lng}, formatted_address }`
 * (or occasionally a bare string) — a shape NOTHING in the portal renders: every
 * reader/display/track-record/identity path wants `oneLine`/`line1`/`city`/
 * `state`/`zip`. Storing the raw ClickUp value made addresses look "missing"
 * everywhere even though they were imported. Parse `formatted_address` into
 * discrete components (city/state/zip), keep lat/lng, and preserve the original
 * formatted string for identity matching. Returns undefined when unusable.
 */
function normalizeClickupLocation(v) {
  if (!v) return undefined;
  let formatted = null, lat = null, lng = null;
  if (typeof v === 'string') {
    formatted = v;
  } else if (typeof v === 'object') {
    formatted = v.formatted_address || v.formattedAddress || v.value || null;
    const loc = v.location || v.position || v.geolocation || null;
    if (loc) { lat = loc.lat != null ? loc.lat : loc.latitude; lng = loc.lng != null ? loc.lng : loc.longitude; }
  } else { return undefined; }
  const out = formatted ? ADDR.normalizeAddress(ADDR.parseAddress(formatted)) : ADDR.normalizeAddress({});
  if (formatted) {
    out.formatted_address = formatted;
    if (!out.oneLine) out.oneLine = String(formatted).replace(/,?\s*(USA|United States)\.?$/i, '').trim();
  }
  if (lat != null && lat !== '') out.lat = Number(lat);
  if (lng != null && lng !== '') out.lng = Number(lng);
  return (out.oneLine || out.line1 || out.formatted_address) ? out : undefined;
}

const ACTUAL_CLOSING = '0846edc7-8619-4ee6-827e-a673570d3057'; // date, pull-only

// Single field descriptor used by BOTH directions.
// t: portal table (b=borrower, a=application, l=llc)
// type: dropdown|currency|number|date|text|phone|checkbox
// enumKey: crosswalk key (dropdowns that translate values); omit for free dropdowns (lender/channel)
// dir: both|push|pull
const FIELD_MAP = [
  // --- borrower ---
  { cu: F.SHARED.borrowerEmail, t: 'b', col: 'email', type: 'text', dir: 'both' },
  { cu: F.SHARED.borrowerCell, t: 'b', col: 'cell_phone', type: 'phone', dir: 'both' },
  { cu: F.SHARED.borrowerDOB, t: 'b', col: 'date_of_birth', type: 'date', dir: 'both' },
  { cu: F.SHARED.borrowerFICO, t: 'b', col: 'fico', type: 'number', dir: 'both' },
  { cu: F.EXTRA.citizenship, t: 'b', col: 'citizenship', type: 'text', dir: 'both' },
  { cu: F.EXTRA.employment, t: 'b', col: 'employer', type: 'text', dir: 'both' },
  { cu: F.EXTRA.dependents, t: 'b', col: 'dependents_count', type: 'number', dir: 'both' },
  { cu: F.EXTRA.yearsAtResidence, t: 'b', col: 'years_at_residence', type: 'number', dir: 'both' },
  { cu: F.EXTRA.employmentType, t: 'b', col: 'employment_type', type: 'dropdown', enumKey: 'employment_type', dir: 'both' },
  { cu: F.SHARED.primaryHousingType, t: 'b', col: 'housing_status', type: 'dropdown', enumKey: 'housing_status', dir: 'both' },
  { cu: F.SHARED.primaryHousingAmt, t: 'b', col: 'housing_payment', type: 'currency', dir: 'both' },
  // --- application: product ---
  { cu: F.PIPELINE.program, t: 'a', col: 'program', type: 'dropdown', enumKey: 'program', dir: 'both' },
  { cu: F.PIPELINE.loanType, t: 'a', col: 'loan_type', type: 'dropdown', enumKey: 'loan_type', dir: 'both' },
  { cu: F.PIPELINE.propertyType, t: 'a', col: 'property_type', type: 'dropdown', enumKey: 'property_type', dir: 'both' },
  { cu: F.PIPELINE.occupancy, t: 'a', col: 'occupancy', type: 'dropdown', enumKey: 'occupancy', dir: 'pull' }, // backend-only
  { cu: F.PIPELINE.term, t: 'a', col: 'term', type: 'dropdown', enumKey: 'term', dir: 'both' },
  { cu: F.PIPELINE.units, t: 'a', col: 'units', type: 'number', dir: 'both' },
  { cu: F.PIPELINE.lender, t: 'a', col: 'lender', type: 'dropdown', dir: 'pull' },   // note buyer; free label; staff-only display
  { cu: F.PIPELINE.channel, t: 'a', col: 'channel', type: 'dropdown', dir: 'pull' }, // backend-only
  { cu: F.PIPELINE.pppType, t: 'a', col: 'ppp', type: 'text', dir: 'both' },
  // --- application: economics ---
  { cu: F.PIPELINE.ltv, t: 'a', col: 'ltv', type: 'number', dir: 'push' },     // portal owns pricing (§7.1)
  { cu: F.EXTRA.ratePct, t: 'a', col: 'rate_pct', type: 'number', dir: 'push' }, // portal owns (§7.1)
  { cu: F.PIPELINE.loanAmount, t: 'a', col: 'loan_amount', type: 'currency', dir: 'both' },
  { cu: F.PIPELINE.purchasePrice, t: 'a', col: 'purchase_price', type: 'currency', dir: 'both' },
  { cu: F.SYNC.rtlAsIsValue, t: 'a', col: 'as_is_value', type: 'currency', dir: 'both' },
  { cu: F.PIPELINE.arv, t: 'a', col: 'arv', type: 'currency', dir: 'both' },
  { cu: F.PIPELINE.constructionBudget, t: 'a', col: 'rehab_budget', type: 'currency', dir: 'both' },
  { cu: F.SYNC.rehabType, t: 'a', col: 'rehab_type', type: 'dropdown', enumKey: 'rehab_type', dir: 'both' },
  { cu: F.PIPELINE.dscrRatio, t: 'a', col: 'dscr_ratio', type: 'number', dir: 'both' },
  { cu: F.EXTRA.assignmentFee, t: 'a', col: 'assignment_fee', type: 'currency', dir: 'both' },
  { cu: F.EXTRA.underlyingPrice, t: 'a', col: 'underlying_contract_price', type: 'currency', dir: 'both' },
  { cu: F.EXTRA.originalPurchase, t: 'a', col: 'original_purchase_price', type: 'currency', dir: 'both' },
  { cu: F.EXTRA.acquisitionDate, t: 'a', col: 'acquisition_date', type: 'date', dir: 'both' },
  { cu: F.SYNC.approxAppraisedValue, t: 'a', col: 'approx_appraised_value', type: 'currency', dir: 'pull' }, // informational
  { cu: F.SYNC.actualAppraisedValue, t: 'a', col: 'actual_appraised_value', type: 'currency', dir: 'pull' }, // informational
  // --- application: additional staff-workflow detail (pull-only display; ClickUp owns) ---
  // Richer file data the team keeps in ClickUp — rates, carrying costs, valuation,
  // title/insurance, liens, pipeline status. Never pushed back (no echo/clobber).
  { cu: F.EXTRA.actualRate, t: 'a', col: 'actual_rate', type: 'text', dir: 'pull' },
  { cu: F.EXTRA.desiredRate, t: 'a', col: 'desired_rate', type: 'text', dir: 'pull' },
  { cu: F.EXTRA.propertyTaxes, t: 'a', col: 'property_taxes', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.propertyInsurance, t: 'a', col: 'property_insurance', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.propertyHoa, t: 'a', col: 'property_hoa', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.rentalIncome, t: 'a', col: 'rental_income', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.prepaymentPenalty, t: 'a', col: 'prepayment_penalty', type: 'dropdown', dir: 'pull' }, // free label ("5 Years"…"Non")
  { cu: F.EXTRA.titleCompany, t: 'a', col: 'title_company', type: 'text', dir: 'pull' },
  { cu: F.EXTRA.titleCompanyContact, t: 'a', col: 'title_company_contact', type: 'text', dir: 'pull' },
  { cu: F.EXTRA.insuranceCompany, t: 'a', col: 'insurance_company', type: 'text', dir: 'pull' },
  { cu: F.EXTRA.insuranceCompanyContact, t: 'a', col: 'insurance_company_contact', type: 'text', dir: 'pull' },
  { cu: F.EXTRA.firstLien, t: 'a', col: 'first_lien', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.secondLien, t: 'a', col: 'second_lien', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.appraisedRentalValue, t: 'a', col: 'appraised_rental_value', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.approxAppraisedRentalValue, t: 'a', col: 'approx_appraised_rental_value', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.cdaValue, t: 'a', col: 'cda_value', type: 'currency', dir: 'pull' },
  { cu: F.EXTRA.appraiserName, t: 'a', col: 'appraiser_name', type: 'text', dir: 'pull' },
  { cu: F.PIPELINE.encompassStatus, t: 'a', col: 'encompass_status', type: 'dropdown', dir: 'pull' }, // free label
  { cu: F.EXTRA.applicationSubmitted, t: 'a', col: 'application_submitted', type: 'dropdown', dir: 'pull' }, // free label (YES/NO/NOT YET)
  // --- application: numbers & dates ---
  { cu: F.PIPELINE.ysLoanNumber, t: 'a', col: 'ys_loan_number', type: 'text', dir: 'both' },
  { cu: F.PIPELINE.investorLoanNo, t: 'a', col: 'investor_loan_number', type: 'text', dir: 'pull' },
  { cu: F.PIPELINE.expectedClosing, t: 'a', col: 'expected_closing', type: 'date', dir: 'both' },
  { cu: F.PIPELINE.dateSubmitted, t: 'a', col: 'submitted_at', type: 'date', dir: 'push' },
  { cu: ACTUAL_CLOSING, t: 'a', col: 'actual_closing', type: 'date', dir: 'pull' },
  // --- llc ---
  { cu: F.PIPELINE.llcName, t: 'l', col: 'llc_name', type: 'text', dir: 'both' },
  { cu: F.PIPELINE.ein, t: 'l', col: 'ein', type: 'text', dir: 'both' },
];

// CU field ids the mapper "knows" (mapped, special, or intentionally ignored) —
// everything else on a task is captured into clickup_extra (§7.4).
const KNOWN = new Set([
  ...FIELD_MAP.map((f) => f.cu),
  F.SHARED.borrowerName, F.SHARED.borrowerAddress, F.SHARED.loanOfficer, F.SHARED.loanOfficerEmail,
  F.PIPELINE.subjectAddress, F.PIPELINE.vesting, F.PIPELINE.processor, F.PIPELINE.underwriter,
  F.PIPELINE.coBorrowerFlag, F.PIPELINE.coBorrowerName, F.PIPELINE.secondBorrowerEmail, F.PIPELINE.secondBorrowerCell,
  F.EXTRA.priorAddress, F.EXTRA.card, F.EXTRA.maritalStatus, F.EXTRA.depositReceived,
  F.EXTRA.loanOfficerPhone, F.EXTRA.processorEmail, F.EXTRA.underwriterEmail,
  F.SYNC.sendToPortal, F.SYNC.portalFileId, F.SYNC.portalFileLink, F.SYNC.syncStatus, F.SYNC.borrowerPortalStatus,
  F.CRM.contactType, F.CRM.phoneNumber, F.CRM.pipelineLink, F.PIPELINE.crmLink, F.SHARED.companyLead,
  // Checklist status dropdowns (handled by the checklist pull, not the generic
  // field map) — list them here so readTaskFields never dumps them into extra.
  ...Object.values(F.CHECKLIST).map((c) => c.fieldId),
]);

// ---- write helpers --------------------------------------------------------
function writeValue(f, val, options) {
  if (val == null || val === '') return undefined;
  switch (f.type) {
    case 'dropdown': {
      const label = f.enumKey ? X.toClickUpLabel(f.enumKey, val) : String(val);
      if (!label) return undefined;
      return T.dropdownLabelToId(options[f.cu] || [], label) || undefined;
    }
    case 'currency': case 'number': return T.numToString(T.parseMoney(val) != null ? T.parseMoney(val) : val);
    case 'date': return T.toEpochMs(val);
    case 'phone': return T.normalizePhone(val);
    case 'checkbox': return val ? 'true' : 'false';
    default: return String(val);
  }
}

function addressField(id, addr) {
  // Only emit a location field when we have coordinates (ClickUp requires lat/lng).
  if (!addr || addr.lat == null || addr.lng == null) return null;
  const formatted = addr.formatted_address || addr.oneLine ||
    [addr.line1 || addr.street, addr.city, [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { id, value: { location: { lat: addr.lat, lng: addr.lng }, formatted_address: formatted } };
}

/**
 * Build the ClickUp task payload from portal data.
 * ctx: { app, borrower, llc, coBorrower, registeredProgram, externalStatus,
 *        officerClickupId, processorClickupId, portalAppId, portalFileLink, card }
 * options: { [fieldId]: optionList }  (live dropdown options for writes)
 * ysProgramFieldId: id of the new "YS Program" field once created (else null)
 * returns { name, statusName, customFields:[{id,value}] }
 */
function buildTaskFields(ctx, options = {}, ysProgramFieldId = null) {
  const { app = {}, llc = null } = ctx;
  // SAFETY (post-incident): NEVER push synthetic / placeholder borrower values back
  // to ClickUp. Tasks with no real contact get a shadow profile (noemail+<taskid>@
  // clickup.local, first/last = "Unknown"); pushing those would clobber the real
  // ClickUp value with portal-internal junk. Blank them so `put` skips them.
  const borrower = { ...(ctx.borrower || {}) };
  if (borrower.email && /@clickup\.local$/i.test(String(borrower.email))) borrower.email = undefined;
  if (borrower.first_name === 'Unknown') borrower.first_name = undefined;
  if (borrower.last_name === 'Unknown') borrower.last_name = undefined;
  const cf = [];
  const put = (id, value) => { if (id && value !== undefined && value !== null && value !== '') cf.push({ id, value }); };
  const src = { a: app, b: borrower, l: llc || {} };

  for (const f of FIELD_MAP) {
    if (f.dir === 'pull') continue;                       // pull-only never pushed
    put(f.cu, writeValue(f, src[f.t][f.col], options));
  }

  // specials
  put(F.SHARED.borrowerName, T.joinName(borrower.first_name, borrower.last_name));
  if (borrower.ssn) put(F.SHARED.borrowerSSN, String(borrower.ssn));  // orchestrator supplies decrypted
  const bAddr = addressField(F.SHARED.borrowerAddress, borrower.current_address);
  if (bAddr) cf.push(bAddr);
  const sAddr = addressField(F.PIPELINE.subjectAddress, app.property_address);
  if (sAddr) cf.push(sAddr);
  // vesting from LLC presence (§7.6)
  put(F.PIPELINE.vesting, writeValue({ cu: F.PIPELINE.vesting, type: 'dropdown', enumKey: 'vesting' },
    llc ? 'LLC / Corp' : 'Individual', options));
  // registered product -> "RTL Loan Program" (Standard/Gold, push-only)
  {
    const fid = F.SYNC.rtlLoanProgram;
    const optId = X.resolveWriteId('registered_program', ctx.registeredProgram, options[fid] || []);
    if (optId) put(fid, optId);
  }
  // marital (AI-normalized -> YES/NO)
  if (borrower.marital_status != null && borrower.marital_status !== '') {
    const married = T.normalizeMarried(borrower.marital_status);
    if (married !== null) {
      const label = married ? 'YES' : 'NO';
      put(F.EXTRA.maritalStatus, T.dropdownLabelToId(options[F.EXTRA.maritalStatus] || [], label));
    }
  }
  // borrower-facing status mirror (push only)
  if (ctx.externalStatus) {
    put(F.SYNC.borrowerPortalStatus, T.dropdownLabelToId(options[F.SYNC.borrowerPortalStatus] || [], ctx.externalStatus));
  }
  // officer / processor users fields
  if (ctx.officerClickupId) put(F.SHARED.loanOfficer, { add: [ctx.officerClickupId] });
  if (ctx.processorClickupId) put(F.PIPELINE.processor, { add: [ctx.processorClickupId] });
  // co-borrower summary flags on the parent (full profile lives in a subtask, §7.7)
  if (ctx.coBorrower) {
    put(F.PIPELINE.coBorrowerFlag, T.dropdownLabelToId(options[F.PIPELINE.coBorrowerFlag] || [], 'YES'));
    put(F.PIPELINE.coBorrowerName, T.joinName(ctx.coBorrower.first_name, ctx.coBorrower.last_name));
    put(F.PIPELINE.secondBorrowerEmail, ctx.coBorrower.email);
    put(F.PIPELINE.secondBorrowerCell, T.normalizePhone(ctx.coBorrower.cell_phone));
  }
  // appraisal card (joined single line)
  if (ctx.card) put(F.EXTRA.card, T.joinCardLine(ctx.card));
  // binding stamps
  if (ctx.portalAppId) put(F.SYNC.portalFileId, String(ctx.portalAppId));
  if (ctx.portalFileLink) put(F.SYNC.portalFileLink, ctx.portalFileLink);

  const name = `${T.joinName(borrower.first_name, borrower.last_name) || 'New Borrower'}${
    app.property_address && (app.property_address.oneLine || app.property_address.line1)
      ? ' - ' + (app.property_address.oneLine || app.property_address.line1) : ''}`;
  return { name, statusName: app.internal_status || null, customFields: cf };
}

// ---- read (pull) ----------------------------------------------------------
function cfMap(task) {
  const m = {};
  for (const c of (task && task.custom_fields) || []) m[c.id] = c;
  return m;
}
function readValue(f, cf, options) {
  if (!cf || cf.value == null) return undefined;
  switch (f.type) {
    case 'dropdown': {
      const list = options[f.cu] || cf.type_config?.options || [];
      const label = T.dropdownIndexToLabel(list, cf.value);
      if (label == null) return undefined;
      return f.enumKey ? X.fromClickUpLabel(f.enumKey, label) : label;   // free dropdown -> raw label
    }
    case 'currency': case 'number': return T.parseMoney(cf.value);
    case 'date': return T.fromEpochMs(cf.value);
    case 'checkbox': return cf.value === true || cf.value === 'true';
    default: return typeof cf.value === 'string' ? cf.value : String(cf.value);
  }
}

/**
 * Read a ClickUp task into a portal patch. Applies only pull/both fields; push-
 * only fields (LTV/rate/YS-Program) are never taken from ClickUp. Unmapped
 * fields are captured into `extra` (backend-only, §7.4). SSN/card excluded from extra.
 * returns { app:{}, borrower:{}, llc:{}, internalStatus, extra:{}, cardLine, coBorrowerFlagYes }
 */
function readTaskFields(task, options = {}) {
  const m = cfMap(task);
  // ClickUp v2 returns status as an OBJECT { status, color, orderindex, type };
  // some endpoints/fixtures give a bare string. Normalize to the status NAME so
  // internal_status is a clean string and externalFor() resolves correctly
  // (storing the object poisoned internal_status and forced the 'processing'
  // fallback for every file).
  const rawStatus = task && task.status;
  const internalStatus = (rawStatus && typeof rawStatus === 'object')
    ? (rawStatus.status != null ? String(rawStatus.status) : null)
    : (rawStatus != null && rawStatus !== '' ? String(rawStatus) : null);
  const out = { app: {}, borrower: {}, llc: {}, extra: {}, internalStatus };
  const dst = { a: out.app, b: out.borrower, l: out.llc };

  for (const f of FIELD_MAP) {
    if (f.dir === 'push') continue;                       // portal-owned, never pulled
    const v = readValue(f, m[f.cu], options);
    if (v !== undefined) dst[f.t][f.col] = v;
  }

  // specials (read)
  const nm = m[F.SHARED.borrowerName];
  if (nm && nm.value) { const p = T.splitName(nm.value); out.borrower.first_name = p.first; out.borrower.last_name = p.last; }
  const ssn = m[F.SHARED.borrowerSSN];
  if (ssn && ssn.value) out.borrower.ssn = String(ssn.value);           // orchestrator encrypts
  const bAddr = m[F.SHARED.borrowerAddress];
  if (bAddr && bAddr.value) { const a = normalizeClickupLocation(bAddr.value); if (a) out.borrower.current_address = a; }
  const sAddr = m[F.PIPELINE.subjectAddress];
  if (sAddr && sAddr.value) { const a = normalizeClickupLocation(sAddr.value); if (a) out.app.property_address = a; }
  const mar = m[F.EXTRA.maritalStatus];
  if (mar && mar.value != null) {
    const label = T.dropdownIndexToLabel(options[F.EXTRA.maritalStatus] || mar.type_config?.options || [], mar.value);
    if (label) out.borrower.marital_status = /yes/i.test(label) ? 'Married' : undefined; // NO -> keep existing
  }
  const card = m[F.EXTRA.card];
  if (card && card.value) out.cardLine = String(card.value);            // orchestrator parses + encrypts
  const cob = m[F.PIPELINE.coBorrowerFlag];
  if (cob && cob.value != null) {
    const label = T.dropdownIndexToLabel(options[F.PIPELINE.coBorrowerFlag] || cob.type_config?.options || [], cob.value);
    out.coBorrowerFlagYes = /yes/i.test(label || '');
  }

  // Officer / processor identity for INBOUND assignment. The Loan Officer "users"
  // field is frequently empty, so the reliable signals are the Loan Officer Email
  // field + the task's pipeline FOLDER (resolved by the ingest layer). We surface
  // all three; ingest prefers email, then folder.
  const loEmail = m[F.SHARED.loanOfficerEmail];
  if (loEmail && loEmail.value) out.loanOfficerEmail = String(loEmail.value).toLowerCase().trim();
  const prEmail = m[F.EXTRA.processorEmail];
  if (prEmail && prEmail.value) out.processorEmail = String(prEmail.value).toLowerCase().trim();
  const loUsers = m[F.SHARED.loanOfficer];
  if (loUsers && Array.isArray(loUsers.value) && loUsers.value.length) {
    const u = loUsers.value[0]; out.loanOfficerClickupId = (u && (u.id != null ? u.id : u)) || null;
  }
  const prUsers = m[F.PIPELINE.processor];
  if (prUsers && Array.isArray(prUsers.value) && prUsers.value.length) {
    const u = prUsers.value[0]; out.processorClickupId = (u && (u.id != null ? u.id : u)) || null;
  }
  // Portal File ID stamp — the authoritative binding written by our own push.
  const stamp = m[F.SYNC.portalFileId];
  if (stamp && stamp.value) out.portalFileId = String(stamp.value).trim();
  // Raw *Program label (before RTL crosswalk) so non-RTL/long-term programs
  // (DSCR, Non-QM, HELOC…) are preserved in the snapshot rather than lost as null.
  const prog = m[F.PIPELINE.program];
  if (prog && prog.value != null) {
    out.rawProgram = T.dropdownIndexToLabel(options[F.PIPELINE.program] || prog.type_config?.options || [], prog.value);
  }

  // everything unmapped -> extra (backend-only). Exclude SSN + card (encrypted columns only).
  for (const c of (task && task.custom_fields) || []) {
    if (KNOWN.has(c.id)) continue;
    if (c.id === F.SHARED.borrowerSSN || c.id === F.EXTRA.card) continue;
    if (c.value == null || c.value === '') continue;
    out.extra[c.name || c.id] = c.value;
  }
  return out;
}

// ---- scoped-push resolver -------------------------------------------------
// Map a set of "changed" logical keys (application/borrower column names plus a
// few synthetic keys) to the ClickUp custom-field ids they affect, so an edit
// pushes ONLY those fields and can never rewrite the rest of the task. Unknown
// keys resolve to nothing (safe: that field simply isn't pushed).
const COL_TO_CU = {};
for (const f of FIELD_MAP) { if (f.dir !== 'pull' && f.col) COL_TO_CU[f.col] = f.cu; }

function resolveOnly(onlyKeys) {
  const cuIds = new Set();
  let status = false;
  for (const raw of onlyKeys || []) {
    const k = String(raw);
    switch (k) {
      case 'status': case 'internal_status':
        status = true; cuIds.add(F.SYNC.borrowerPortalStatus); break;
      case 'officer': case 'loan_officer_id':
        cuIds.add(F.SHARED.loanOfficer); break;
      case 'processor': case 'processor_id':
        cuIds.add(F.PIPELINE.processor); break;
      case 'property_address':
        cuIds.add(F.PIPELINE.subjectAddress); break;
      case 'email':
        cuIds.add(F.SHARED.borrowerEmail); break;
      case 'first_name': case 'last_name':
        cuIds.add(F.SHARED.borrowerName); break;
      case 'llc_id':
        cuIds.add(F.PIPELINE.vesting); cuIds.add(F.PIPELINE.llcName); cuIds.add(F.PIPELINE.ein); break;
      default:
        if (COL_TO_CU[k]) cuIds.add(COL_TO_CU[k]);
    }
  }
  return { cuIds, status };
}

module.exports = { FIELD_MAP, KNOWN, buildTaskFields, readTaskFields, writeValue, readValue, normalizeClickupLocation, resolveOnly };
