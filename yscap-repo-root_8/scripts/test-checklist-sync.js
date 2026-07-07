/*
 * Unit tests for src/clickup/checklist.js — the checklist ⇄ ClickUp status
 * translation (pure, no DB). Run: node scripts/test-checklist-sync.js
 * Exits non-zero on any FAIL.
 */
const F = require('../src/clickup/fields');
const CL = require('../src/clickup/checklist');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
};
const eq = (name, got, exp) => ok(`${name} (got ${JSON.stringify(got)} exp ${JSON.stringify(exp)})`,
  JSON.stringify(got) === JSON.stringify(exp));

const PORTAL_STATUSES = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
// Fields with no "outstanding" option → outstanding is a legitimate null/skip.
const NO_OUTSTANDING = new Set(['rehabBudget', 'signedTermSheet']);

// ---- 1) resolveOutbound: every (field,status) → a REAL option UUID or a legit null ----
for (const [key, def] of Object.entries(F.CHECKLIST)) {
  const validUUIDs = new Set(Object.values(def.options));
  for (const status of PORTAL_STATUSES) {
    const r = CL.resolveOutbound(def.fieldId, status);
    if (r === null) {
      // The only legitimate nulls: outstanding on fields with no outstanding option.
      ok(`resolveOutbound legit-null ${key}/${status}`, status === 'outstanding' && NO_OUTSTANDING.has(key));
    } else {
      ok(`resolveOutbound real-uuid ${key}/${status}`, validUUIDs.has(r.optionUUID));
      ok(`resolveOutbound token-valid ${key}/${status}`, PORTAL_STATUSES.includes(r.token));
    }
  }
}

// ---- 2) normalizeInbound round-trips EVERY option ----
for (const [key, def] of Object.entries(F.CHECKLIST)) {
  for (const [optKey, uuid] of Object.entries(def.options)) {
    const expected = optKey === 'receivedUploaded' ? 'satisfied' : optKey;
    eq(`normalizeInbound ${key}/${optKey}`, CL.normalizeInbound(def.fieldId, uuid), expected);
  }
}

// ---- 3) rehabBudget satisfied → receivedUploaded → satisfied ----
{
  const fid = F.CHECKLIST.rehabBudget.fieldId;
  const r = CL.resolveOutbound(fid, 'satisfied');
  eq('rehabBudget satisfied → receivedUploaded uuid', r && r.optionUUID, F.CHECKLIST.rehabBudget.options.receivedUploaded);
  eq('rehabBudget satisfied token', r && r.token, 'satisfied');
  eq('rehabBudget receivedUploaded → satisfied (round-trip)', CL.normalizeInbound(fid, r.optionUUID), 'satisfied');
  // rehabBudget has no outstanding option → skip
  eq('rehabBudget outstanding → null', CL.resolveOutbound(fid, 'outstanding'), null);
}

// ---- 4) signedTermSheet satisfied → received ----
{
  const fid = F.CHECKLIST.signedTermSheet.fieldId;
  const r = CL.resolveOutbound(fid, 'satisfied');
  eq('signedTermSheet satisfied → received uuid', r && r.optionUUID, F.CHECKLIST.signedTermSheet.options.received);
  eq('signedTermSheet satisfied token', r && r.token, 'received');
  eq('signedTermSheet received → received (round-trip)', CL.normalizeInbound(fid, r.optionUUID), 'received');
  eq('signedTermSheet outstanding → null', CL.resolveOutbound(fid, 'outstanding'), null);
}

// ---- 5) full-5 field maps every status to its own option (token = status) ----
{
  const fid = F.CHECKLIST.contract.fieldId;
  for (const status of PORTAL_STATUSES) {
    const r = CL.resolveOutbound(fid, status);
    eq(`contract ${status} → own option`, r && r.optionUUID, F.CHECKLIST.contract.options[status]);
    eq(`contract ${status} token`, r && r.token, status);
  }
}

// ---- 6) never invent: unknown field / unknown option / unknown status ----
eq('resolveOutbound unknown field → null', CL.resolveOutbound('no-such-field', 'requested'), null);
eq('resolveOutbound unknown status → null', CL.resolveOutbound(F.CHECKLIST.contract.fieldId, 'bogus'), null);
eq('normalizeInbound unknown field → null', CL.normalizeInbound('no-such-field', 'x'), null);
eq('normalizeInbound unknown uuid → null', CL.normalizeInbound(F.CHECKLIST.contract.fieldId, 'not-a-real-uuid'), null);

// ---- 7) RANK / no-downgrade authority helper ----
eq('apply forward received>requested', CL.shouldApplyInbound('received', 'requested'), true);
eq('apply forward requested>outstanding', CL.shouldApplyInbound('requested', 'outstanding'), true);
eq('apply forward satisfied>received', CL.shouldApplyInbound('satisfied', 'received'), true);
eq('no-downgrade requested<received', CL.shouldApplyInbound('requested', 'received'), false);
eq('no-downgrade outstanding<requested', CL.shouldApplyInbound('outstanding', 'requested'), false);
eq('skip equal', CL.shouldApplyInbound('satisfied', 'satisfied'), false);
eq('issue always applies over satisfied', CL.shouldApplyInbound('issue', 'satisfied'), true);
eq('issue always applies over outstanding', CL.shouldApplyInbound('issue', 'outstanding'), true);
eq('issue is sticky (satisfied does not overwrite issue)', CL.shouldApplyInbound('satisfied', 'issue'), false);
eq('issue===issue skipped', CL.shouldApplyInbound('issue', 'issue'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
