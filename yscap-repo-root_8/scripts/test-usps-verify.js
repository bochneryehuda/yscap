'use strict';
/**
 * USPS address standardizer — the classify/map logic + graceful fallbacks.
 *
 *   node scripts/test-usps-verify.js      (pure — mocks the USPS API, no network/DB)
 *
 * Proves:
 *   1. classify() maps a USPS response to the canonical address shape and the right
 *      status: verified (confirmed, unchanged), corrected (confirmed, USPS fixed it),
 *      unverified (no match, or DPVConfirmation 'N' = not a deliverable point).
 *   2. Merely ADDING a ZIP+4 to an already-correct address stays 'verified'.
 *   3. standardize() NEVER throws and degrades cleanly: not_configured when USPS keys
 *      are absent, unverified when there isn't enough to match on, error on an API
 *      failure — the address form always keeps working.
 *   4. Financing output prefers an imported, confirmed USPS address and rejects
 *      any unverified, missing, or merely staged stamp.
 *   5. The backfill's componentsOf() reads every stored address shape.
 */
const R = require('path').resolve(__dirname, '..');
const V = require(R + '/src/lib/usps-verify');
const usps = require(R + '/src/lib/integrations/usps');
const backfill = require(R + '/src/lib/address-usps-verify');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// A minimal USPS response builder (the shape lib/integrations/usps.verifyAddress returns).
const R_ = (street, city, state, zip5, plus4, dpv) => ({
  standardized: { street, secondary: '', city, state, zip5, zipPlus4: plus4 || null, zip: zip5 ? `${zip5}${plus4 ? `-${plus4}` : ''}` : null },
  additionalInfo: dpv ? { DPVConfirmation: dpv } : null,
});

// ── 1. classify: verified / corrected / unverified ─────────────────────────
{
  // verified — USPS returns exactly what we sent (plus a ZIP+4 enhancement)
  const c = V.classify(V.normInput({ line1: '26 S 10th St', city: 'Brooklyn', state: 'NY', zip: '11249' }),
    R_('26 S 10th St', 'Brooklyn', 'NY', '11249', '1234', 'Y'));
  ok(c.status === 'verified', 'unchanged address (ZIP+4 added) is verified, not corrected — got ' + c.status);
  ok(c.address && c.address.city === 'Brooklyn' && c.address.state === 'NY', 'verified maps to canonical shape');
  ok(c.address && c.address.zip === '11249-1234', 'verified keeps the returned ZIP+4');
  ok(c.dpv && c.dpv.dpvConfirmation === 'Y', 'DPV confirmation is surfaced');
}
{
  // corrected — USPS re-spells the street and fills the ZIP
  const c = V.classify(V.normInput({ line1: '26 South 10th Street', city: 'Brooklyn', state: 'NY', zip: '' }),
    R_('26 S 10th St', 'Brooklyn', 'NY', '11249', null, 'Y'));
  ok(c.status === 'corrected', 'USPS filling the ZIP + fixing the suffix is corrected — got ' + c.status);
  ok(c.changed === true, 'corrected sets changed=true');
}
{
  // corrected — USPS returns a DIFFERENT 5-digit ZIP (a real correction)
  const c = V.classify(V.normInput({ line1: '5701 15th Ave', city: 'Brooklyn', state: 'NY', zip: '11218' }),
    R_('5701 15th Ave', 'Brooklyn', 'NY', '11219', null, 'Y'));
  ok(c.status === 'corrected', 'a changed 5-digit ZIP is corrected — got ' + c.status);
}
{
  // unverified — DPVConfirmation 'N' means USPS did NOT confirm a deliverable point
  const c = V.classify(V.normInput({ line1: '123 Nowhere St', city: 'Brooklyn', state: 'NY', zip: '11249' }),
    R_('123 Nowhere St', 'Brooklyn', 'NY', '11249', null, 'N'));
  ok(c.status === 'unverified', 'DPVConfirmation N is unverified — got ' + c.status);
}
{
  // unverified — no address returned at all (no match)
  const c = V.classify(V.normInput({ line1: '999 Fake Blvd', city: 'X', state: 'ZZ', zip: '' }), { standardized: {} });
  ok(c.status === 'unverified', 'no USPS match is unverified — got ' + c.status);
  ok(c.address === null, 'no match returns no address');
}
{
  // DPV 'D' (secondary missing) is still a real standardized address, not unverified
  const c = V.classify(V.normInput({ line1: '100 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' }),
    R_('100 Main St', 'Lakewood', 'NJ', '08701', null, 'D'));
  ok(c.status === 'verified' || c.status === 'corrected', 'DPV D is not treated as unverified — got ' + c.status);
}

// ── 2. standardize(): graceful fallbacks, never throws ─────────────────────
async function testStandardize() {
  const savedConf = usps.configured, savedVerify = usps.verifyAddress;
  const fakeDb = { query: async (sql) => (/^\s*SELECT/i.test(sql) ? { rows: [] } : { rowCount: 1, rows: [] }) };
  try {
    // not configured → not_configured, input echoed, no throw
    usps.configured = () => false;
    let r = await V.standardize({ line1: '26 S 10th St', city: 'Brooklyn', state: 'NY', zip: '11249' }, { db: fakeDb });
    ok(r.status === 'not_configured' && r.configured === false, 'not configured → not_configured');

    // configured but not enough to match on → unverified (no API call)
    usps.configured = () => true;
    usps.verifyAddress = async () => { throw new Error('should not be called'); };
    r = await V.standardize({ line1: '', city: 'Brooklyn', state: 'NY' }, { db: fakeDb });
    ok(r.status === 'unverified', 'missing street → unverified without calling USPS — got ' + r.status);

    // configured + a real answer → corrected, canonical address returned
    usps.verifyAddress = async () => R_('26 S 10th St', 'Brooklyn', 'NY', '11249', '1234', 'Y');
    r = await V.standardize({ line1: '26 south 10th street', city: 'Brooklyn', state: 'NY', zip: '' }, { db: fakeDb, force: true });
    ok(r.configured === true && r.address && r.address.line1 === '26 S 10th St', 'standardize returns the USPS canonical address');
    ok(r.status === 'corrected', 'standardize classifies a fixed address as corrected — got ' + r.status);

    // an API failure → error, never throws
    usps.verifyAddress = async () => { throw new Error('USPS 500'); };
    r = await V.standardize({ line1: '26 S 10th St', city: 'Brooklyn', state: 'NY', zip: '11249' }, { db: fakeDb, noCache: true, force: true });
    ok(r.status === 'error', 'a USPS failure returns status error — got ' + r.status);

    // the free-tier cap: with a cap of 1, the 2nd distinct live lookup is skipped
    const cfg = require(R + '/src/config');
    const savedCap = cfg.usps.maxPerHour;
    cfg.usps.maxPerHour = 1;
    V._resetRateWindow();
    usps.verifyAddress = async () => R_('1 A St', 'Town', 'NY', '10001', null, 'Y');
    try {
      const a1 = await V.standardize({ line1: '1 A St', city: 'Town', state: 'NY', zip: '10001' }, { db: fakeDb, noCache: true });
      const a2 = await V.standardize({ line1: '2 B Ave', city: 'Town', state: 'NY', zip: '10002' }, { db: fakeDb, noCache: true });
      ok(a1.status !== 'rate_limited', 'first live lookup under the cap proceeds — got ' + a1.status);
      ok(a2.status === 'rate_limited', 'second live lookup over the cap is rate_limited — got ' + a2.status);
    } finally { cfg.usps.maxPerHour = savedCap; V._resetRateWindow(); }
  } finally {
    usps.configured = savedConf; usps.verifyAddress = savedVerify;
  }
}

// ── 3. financing output uses only an imported, confirmed USPS stamp ─────────
{
  const working = { line1: '12 Main Street', city: 'Brooklyn', state: 'NY', zip: '11201' };
  const official = { line1: '12 MAIN ST', city: 'BROOKLYN', state: 'NY', zip: '11201-1234' };
  ok(V.preferredFinancingAddress({ property_address: working, usps_address: official, usps_match: 'verified', usps_imported_at: new Date() }) === official,
    'financing output prefers an imported USPS-verified address');
  ok(V.preferredFinancingAddress({ property_address: working, usps_address: official, usps_match: 'corrected', usps_imported_at: new Date() }) === official,
    'financing output prefers an imported USPS-corrected address');
  ok(V.preferredFinancingAddress({ property_address: working, usps_address: official, usps_match: 'verified' }) === working,
    'financing output rejects a verified but not imported USPS proposal');
  ok(V.preferredFinancingAddress({ property_address: working, usps_address: official, usps_match: 'unverified' }) === working,
    'financing output rejects an unverified USPS stamp');
  ok(V.preferredFinancingAddress({ property_address: working, usps_address: null, usps_match: 'verified' }) === working,
    'financing output falls back when the USPS address is missing');
  ok(V.preferredFinancingAddress({ property_address: working, usps_address: {}, usps_match: 'verified' }) === working,
    'financing output falls back when the USPS address is empty');
}

// ── 3b. deliverability(): plain-language DPV reading for the screen ─────────
{
  ok(V.deliverability(null) === null, 'no dpv → null (nothing to read)');
  const y = V.deliverability({ dpvConfirmation: 'Y' });
  ok(y && y.code === 'Y' && y.deliverable === true && y.unitIssue === false, 'DPV Y is deliverable, no unit issue');
  const d = V.deliverability({ dpvConfirmation: 'D' });
  ok(d && d.deliverable === true && d.unitIssue === true, 'DPV D is deliverable-to-building with a missing unit');
  const s = V.deliverability({ dpvConfirmation: 'S' });
  ok(s && s.deliverable === true && s.unitIssue === true, 'DPV S is deliverable-to-building with a bad unit');
  const n = V.deliverability({ dpvConfirmation: 'N' });
  ok(n && n.code === 'N' && n.deliverable === false, 'DPV N is not deliverable');
  const blank = V.deliverability({ vacant: 'N' });
  ok(blank && blank.code === null && blank.deliverable === false, 'a dpv with no confirmation code is not deliverable');
  // pickDpv keeps the centralized-delivery signal
  const picked = V.pickDpv({ DPVConfirmation: 'Y', centralDeliveryPoint: 'Y', vacant: 'N' });
  ok(picked && picked.centralDeliveryPoint === 'Y', 'pickDpv surfaces centralDeliveryPoint');
}

// ── 3c. toCanonical: correctly-cased address + separate back-end fields ─────
{
  // USPS returns ALL CAPS — we keep the parts but present them in mailing case,
  // and every component is its own field.
  const a = V.toCanonical({ street: '26 S 10TH ST', secondary: 'APT 4B', city: 'BROOKLYN', state: 'NY', zip5: '11249', zipPlus4: '1234', zip: '11249-1234' });
  ok(a.line1 === '26 S 10th St', 'street is mailing-cased — got ' + a.line1);
  ok(a.unit === 'Apt 4B', 'unit is mailing-cased — got ' + a.unit);
  ok(a.city === 'Brooklyn', 'city is mailing-cased, not ALL CAPS — got ' + a.city);
  ok(a.state === 'NY', 'state stays the 2-letter code');
  ok(a.zip5 === '11249', 'the 5-digit ZIP is its own field');
  ok(a.zip4 === '1234', 'the +4 is its own field');
  ok(a.zip === '11249-1234', 'the full ZIP+4 is kept too');
  ok(a.oneLine === '26 S 10th St Apt 4B, Brooklyn, NY 11249-1234', 'the one-line reads correctly — got ' + a.oneLine);
  // directionals and PO/US stay upper; a plain 5-digit ZIP has an empty +4
  const b = V.toCanonical({ street: 'PO BOX 45', city: 'LAKEWOOD', state: 'NJ', zip5: '08701', zipPlus4: null, zip: '08701' });
  ok(b.line1 === 'PO Box 45', 'PO stays upper — got ' + b.line1);
  ok(b.zip5 === '08701' && b.zip4 === '' && b.zip === '08701', 'a 5-digit-only ZIP leaves +4 empty');
}

// ── 3d. explainError: raw failure → plain language + technical detail ──────
{
  // Every branch keeps the raw detail AND says what to do in plain words.
  const timeout = V.explainError('The operation was aborted');
  ok(/in time|slow moment/i.test(timeout.reason) && timeout.retryable === true, 'a timeout reads as a slow moment, retryable — got ' + timeout.reason);
  ok(timeout.technical === 'The operation was aborted', 'the raw detail is kept for "exactly why"');

  const badAddr = V.explainError('USPS 400: {"error":"Invalid address"}');
  ok(/could not read this address/i.test(badAddr.reason) && badAddr.retryable === false, 'a 400 reads as a bad address, not retryable — got ' + badAddr.reason);

  const notFound = V.explainError('USPS 404: not found');
  ok(/no record of this exact address/i.test(notFound.reason), 'a 404 reads as address not found — got ' + notFound.reason);

  const auth = V.explainError('USPS token 401: unauthorized');
  ok(/sign-in|credentials|keys/i.test(auth.reason) && auth.retryable === false, 'a token/401 reads as a sign-in problem, not the address — got ' + auth.reason);

  // THE OWNER'S ACTUAL ERROR: a RESOURCE 403 (sign-in worked, the address lookup is
  // forbidden) must read as an authorization/license problem on USPS's side, NOT as
  // "keys expired" — that is the whole point of splitting it from the token case.
  const forbidden = V.explainError('USPS 403: { "apiVersion": "/addresses/v3/", "error": { "code": "403", "message": "The requested resource is forbidden" } }');
  ok(/not authorized|licen|Business Portal|403/i.test(forbidden.reason) && forbidden.retryable === false,
    'a resource 403 reads as a USPS authorization/license problem — got ' + forbidden.reason);
  ok(!/expired/i.test(forbidden.reason), 'a resource 403 does NOT claim the keys expired (that is the sign-in case)');
  ok(/sign in|signed us in|let us sign in|log/i.test(forbidden.reason), 'a resource 403 says the sign-in worked but the lookup was forbidden');
  ok(forbidden.technical.includes('/addresses/v3/'), 'the full USPS 403 body is kept as the technical detail');

  const rate = V.explainError('USPS 429: too many requests');
  ok(/hourly lookup limit/i.test(rate.reason) && rate.retryable === true, 'a 429 reads as the hourly limit — got ' + rate.reason);

  // A RESOURCE error whose BODY happens to contain the word "token" must NOT be
  // misread as a sign-in failure — only the "USPS token …" prefix means sign-in.
  const bodyToken = V.explainError('USPS 429: {"message":"rate limit token bucket exhausted"}');
  ok(/hourly lookup limit/i.test(bodyToken.reason), 'a 429 whose body says "token" still reads as the rate limit, not a sign-in problem — got ' + bodyToken.reason);

  const down = V.explainError('USPS 503: service unavailable');
  ok(/temporary problem on their end/i.test(down.reason) && down.retryable === true, 'a 5xx reads as a temporary USPS problem — got ' + down.reason);

  const net = V.explainError('fetch failed: ECONNREFUSED');
  ok(/could not reach USPS/i.test(net.reason), 'a network error reads as unreachable — got ' + net.reason);

  const blank = V.explainError('');
  ok(/did not say why|try again/i.test(blank.reason) && blank.technical === '', 'an empty detail still gives a plain sentence');

  const long = V.explainError('x'.repeat(600));
  ok(long.technical.length === 400, 'the technical detail is capped at 400 chars — got ' + long.technical.length);
}

// ── 4. backfill componentsOf reads every stored shape ──────────────────────
{
  const a = backfill.componentsOf({ line1: '26 S 10th St', city: 'Brooklyn', state: 'NY', zip: '11249' });
  ok(a && a.line1 === '26 S 10th St' && a.state === 'NY', 'componentsOf reads a component object');
  const b = backfill.componentsOf('26 S 10th St, Brooklyn, NY 11249');
  ok(b && b.line1 && b.state === 'NY', 'componentsOf parses a bare string');
  const c = backfill.componentsOf({ formatted_address: '26 S 10th St, Brooklyn, NY 11249' });
  ok(c && c.state === 'NY', 'componentsOf reads a one-line-only object');
  ok(backfill.componentsOf(null) === null, 'componentsOf(null) is null');
  ok(backfill.componentsOf({}) === null, 'componentsOf of an empty object is null');
}

testStandardize().then(() => {
  console.log(`\nusps-verify: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('test crashed:', e); process.exit(1); });
