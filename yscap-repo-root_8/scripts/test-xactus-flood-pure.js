'use strict';
/**
 * Pure tests for the Xactus flood provider (no DB, no network):
 *   - the MISMO 2.4 Original request body matches the Xactus Postman collection,
 *   - the response parser reads a completed / pending / error / SFHA response,
 *   - the credential scrub + connection classifier behave,
 *   - the desk's address resolver + usability predicate behave.
 * Runs in `npm test`.
 */
const assert = require('assert');
const flood = require('../src/xactus/flood');
const addr = require('../src/xactus/flood-address');
const X = require('../src/lib/mismo/xml');
const { buildOrderBody, buildStatusBody, parseResponse, scrubCredentials, classifyConnection, buildUrlAndHeaders } = flood._seam;

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }

// ── 1. Original request body (individual) ─────────────────────────────────────
{
  const xml = buildOrderBody({
    loanNumber: 'YS-123',
    borrowers: [{ firstName: 'Alice', lastName: 'Firsttimer' }],
    property: { street: '1373 Azalea Dr', city: 'Jacksonville', state: 'FL', zip: '32205' },
    product: 'life',
  });
  const root = X.parse(xml);
  ok(root.local === 'REQUEST_GROUP', 'root is REQUEST_GROUP');
  ok(X.attr(root, 'MISMOVersionID') === '2.4', 'MISMO version 2.4');
  const fr = X.firstDeep(root, 'FLOOD_REQUEST');
  ok(fr && X.attr(fr, '_ActionType') === 'Original', 'ActionType Original');
  const name = X.firstDeep(root, '_NAME');
  ok(X.attr(name, '_Description') === 'Residential', 'Residential (has first name)');
  ok(X.attr(name, '_Identifier') === 'life', 'life-of-loan identifier');
  const bor = X.firstDeep(root, 'BORROWER');
  ok(X.attr(bor, '_FirstName') === 'Alice' && X.attr(bor, '_LastName') === 'Firsttimer', 'borrower name');
  const mt = X.firstDeep(root, 'MORTGAGE_TERMS');
  ok(X.attr(mt, 'LenderCaseIdentifier') === 'YS-123', 'loan number as LenderCaseIdentifier');
  const prop = X.firstDeep(root, 'PROPERTY');
  ok(X.attr(prop, '_StreetAddress') === '1373 Azalea Dr', 'property street');
  ok(X.attr(prop, '_City') === 'Jacksonville', 'property city');
  ok(X.attr(prop, '_State') === 'FL', 'property state');
  ok(X.attr(prop, '_PostalCode') === '32205', 'property zip');
}

// ── 2. Joint order → two BORROWER elements; basic identifier ──────────────────
{
  const xml = buildOrderBody({
    loanNumber: 'L1',
    borrowers: [{ firstName: 'Alice', lastName: 'Firsttimer' }, { firstName: 'John', lastName: 'Firsttimer' }],
    property: { street: '1 Main St', city: 'Town', state: 'NJ', zip: '07001' },
    product: 'basic',
  });
  const root = X.parse(xml);
  ok(X.allDeep(root, 'BORROWER').length === 2, 'two borrower elements for a joint order');
  ok(X.attr(X.firstDeep(root, '_NAME'), '_Identifier') === 'basic', 'basic identifier');
}

// ── 3. Entity-only borrower → Commercial ──────────────────────────────────────
{
  const xml = buildOrderBody({
    loanNumber: 'L2',
    borrowers: [{ lastName: 'Acme Holdings LLC' }],
    property: { street: '2 Oak Ave', city: 'City', state: 'PA', zip: '19000' },
  });
  const root = X.parse(xml);
  ok(X.attr(X.firstDeep(root, '_NAME'), '_Description') === 'Commercial', 'Commercial (no first name)');
  ok(X.attr(X.firstDeep(root, 'BORROWER'), '_LastName') === 'Acme Holdings LLC', 'company name in _LastName');
}

// ── 4. StatusQuery body ───────────────────────────────────────────────────────
{
  const xml = buildStatusBody('2322271');
  const root = X.parse(xml);
  const fr = X.firstDeep(root, 'FLOOD_REQUEST');
  ok(X.attr(fr, '_ActionType') === 'StatusQuery', 'StatusQuery action');
  ok(X.attr(fr, 'FloodCertificationIdentifier') === '2322271', 'status query carries the cert id');
  // A StatusQuery is how a MISSING certificate is RETRIEVED, so it must ask for the
  // embedded PDF exactly like the order does. Without this it inherits the same
  // account default that dropped the PDF in the first place and the whole recovery
  // path silently returns nothing (found by pre-merge audit, 2026-08-02).
  const pref = X.firstDeep(root, 'PREFERRED_RESPONSE');
  ok(!!pref && X.attr(pref, '_UseEmbeddedFileIndicator') === 'Y', 'the StatusQuery asks for the certificate PDF too');
  // It must NEVER carry order fields — a StatusQuery that looked like an order
  // would place (and be charged for) a second determination.
  ok(!X.firstDeep(root, '_PRODUCT'), 'no product on a status query');
  ok(!X.firstDeep(root, 'PROPERTY'), 'no property on a status query');
}

// ── 5. Parse a COMPLETED response (instant, PDF inline, zone X = not SFHA) ─────
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.4">
  <RESPONSE ResponseDateTime="2025-01-14T18:09:25">
    <RESPONSE_DATA>
      <FLOOD_RESPONSE>
        <EMBEDDED_FILE _EncodingType="Base64" _Extension="pdf" _Name="Flood.pdf">
          <DOCUMENT>JVBERi0xLjQKtestbase64content==</DOCUMENT>
        </EMBEDDED_FILE>
        <FLOOD_DETERMINATION FloodProductCertifyDate="2025-01-14" FloodCertificationIdentifier="2322271" SpecialFloodHazardAreaIndicator="No" _LifeOfLoanIndicator="Yes">
          <_COMMUNITY_INFORMATION NFIPCommunityName="Jacksonville" NFIPCommunityIdentifier="120077"/>
          <_BUILDING_INFORMATION NFIPFloodZoneIdentifier="X" NFIPMapIdentifier="12031C" NFIPMapPanelDate="2013-06-19"/>
        </FLOOD_DETERMINATION>
      </FLOOD_RESPONSE>
    </RESPONSE_DATA>
    <STATUS _Name="success" _Condition="success" _Description="Order completed"/>
  </RESPONSE>
</RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'completed', 'completed status');
  ok(p.certId === '2322271', 'cert id');
  ok(p.sfha === false, 'zone X → not SFHA');
  ok(p.floodZone === 'X', 'flood zone X');
  ok(/^JVBER/.test(p.pdfBase64 || ''), 'PDF base64 extracted');
  ok(p.determination && p.determination.communityName === 'Jacksonville', 'determination community');
}

// ── 6. Parse an SFHA determination (zone AE, no explicit indicator) ───────────
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <RESPONSE_DATA><FLOOD_RESPONSE>
    <EMBEDDED_FILE><DOCUMENT>JVBERiFLOODZONE</DOCUMENT></EMBEDDED_FILE>
    <FLOOD_DETERMINATION FloodCertificationIdentifier="999">
      <_BUILDING_INFORMATION NFIPFloodZoneIdentifier="AE"/>
    </FLOOD_DETERMINATION>
  </FLOOD_RESPONSE></RESPONSE_DATA>
  <STATUS _Condition="success" _Name="success"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'completed', 'completed');
  ok(p.sfha === true, 'zone AE → SFHA true');
  ok(p.floodZone === 'AE', 'zone AE');
}

// ── 7. Parse a PENDING ack (manual order, no PDF) → ordered ───────────────────
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <KEY _Name="VendorOrderID" _Value="2384271"/>
  <RESPONSE_DATA><FLOOD_RESPONSE>
    <FLOOD_DETERMINATION FloodProductCertifyDate="2025-01-14" FloodCertificationIdentifier="2322271"/>
  </FLOOD_RESPONSE></RESPONSE_DATA>
  <STATUS _Code="1000" _Name="external" _Condition="Status" _Description="Request created, request id: 2322271"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'ordered', 'ack with cert id but no PDF → ordered (poll later)');
  ok(p.certId === '2322271', 'ack cert id');
  ok(p.pdfBase64 === null, 'no PDF on the ack');
}

// ── 8. Parse an ERROR response ────────────────────────────────────────────────
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <STATUS _Condition="error" _Code="E036" _Description="Invalid Client Account Identifier, Incorrect password supplied"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'error', 'error status');
  ok(/Invalid Client Account/.test(p.error || ''), 'error message surfaced');
}

// ── 8b. Completed determination with a ZONE but NO PDF and no success word ────
// (reachable for the `basic` product) → must be COMPLETED, not misfiled as pending.
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <RESPONSE_DATA><FLOOD_RESPONSE>
    <FLOOD_DETERMINATION FloodCertificationIdentifier="777" SpecialFloodHazardAreaIndicator="No">
      <_BUILDING_INFORMATION NFIPFloodZoneIdentifier="X"/>
    </FLOOD_DETERMINATION>
  </FLOOD_RESPONSE></RESPONSE_DATA>
  <STATUS _Code="200" _Name="external" _Condition="Status" _Description="Determination returned"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'completed', 'zone present, no PDF, no success word → completed (payload-driven)');
  ok(p.floodZone === 'X' && p.sfha === false, 'determination captured');
}

// ── 8c. An ACK whose STATUS says "Order Completed" but has NO determination ────
// → must stay ORDERED (poll later), not be finalized empty.
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <RESPONSE_DATA><FLOOD_RESPONSE>
    <FLOOD_DETERMINATION FloodCertificationIdentifier="888"/>
  </FLOOD_RESPONSE></RESPONSE_DATA>
  <STATUS _Name="Order Completed" _Condition="Status" _Description="queued"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'ordered', 'ack with a "completed" word but no result → ordered');
  ok(p.sfha === null && p.floodZone === null, 'no determination yet');
}

// ── 8d. An error surfaced only in _Description → error ─────────────────────────
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <FLOOD_RESPONSE><FLOOD_DETERMINATION FloodCertificationIdentifier="999"/></FLOOD_RESPONSE>
  <STATUS _Name="external" _Condition="Status" _Description="Order rejected: duplicate request"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'error', 'error in _Description → error (not ordered)');
}

// ── 9. Credential scrub ───────────────────────────────────────────────────────
{
  const s = scrubCredentials('POST https://x/flood?LoginAccountIdentifier=op123&LoginAccountPassword=secretpw failed');
  ok(!/secretpw/.test(s), 'password scrubbed from URL');
  ok(!/op123/.test(s), 'login id scrubbed from URL');
}

// ── 10. Connection classifier ─────────────────────────────────────────────────
{
  ok(classifyConnection(401).live === false, '401 → login rejected');
  ok(classifyConnection(200).live === true, '200 → connected');
  ok(classifyConnection(404).live === null, '404 → reachable, uncertain');
}

// ── 11. Address resolver + usability (pure helper) ────────────────────────────
{
  const a = addr.resolveAddress({ line1: '1373 Azalea Dr', city: 'Jacksonville', state: 'FL', zip: '32205' });
  ok(a.street === '1373 Azalea Dr' && a.city === 'Jacksonville' && a.state === 'FL' && a.zip === '32205', 'object address resolved');
  ok(addr.addressUsable(a) === true, 'complete address is usable');
  ok(addr.addressUsable({ street: '1 Main', city: 'Town' }) === false, 'missing state/zip → not usable');
  // Alternate key names + a bare string must not throw.
  const b = addr.resolveAddress({ street: '5 Elm', city: 'X', state: 'NY', postalCode: '10001' });
  ok(b.zip === '10001', 'postalCode key recovered');
  const c = addr.resolveAddress('1373 Azalea Dr, Jacksonville, FL 32205');
  ok(c && typeof c === 'object', 'string address does not throw');
  ok(addr.resolveAddress(null).street === '', 'null address → empty');
}

// ── 16. The order EXPLICITLY asks for the certificate PDF ─────────────────────
// Xactus documents _UseEmbeddedFileIndicator as a toggle that can EXCLUDE the PDF.
// A determination with no certificate is useless to us, so we must never leave it
// to the account default (owner-reported 2026-08-02: zone came back, no PDF filed).
{
  const xml = buildOrderBody({
    loanNumber: 'L1',
    borrowers: [{ firstName: 'Alice', lastName: 'Firsttimer' }],
    property: { street: '1 Main St', city: 'Town', state: 'NJ', zip: '07001' },
  });
  const root = X.parse(xml);
  const pref = X.firstDeep(root, 'PREFERRED_RESPONSE');
  ok(!!pref, 'the order carries a PREFERRED_RESPONSE element');
  ok(X.attr(pref, '_UseEmbeddedFileIndicator') === 'Y', 'the certificate PDF is explicitly requested');
  // It must sit under REQUESTING_PARTY, where the vendor spec puts it.
  const rp = X.firstDeep(root, 'REQUESTING_PARTY');
  ok(!!X.kid(rp, 'PREFERRED_RESPONSE'), 'PREFERRED_RESPONSE is a child of REQUESTING_PARTY');
  // The rest of the documented order shape is untouched by that addition.
  ok(X.attr(X.firstDeep(root, 'FLOOD_REQUEST'), '_ActionType') === 'Original', 'still an Original order');
  ok(X.attr(X.firstDeep(root, 'PROPERTY'), '_City') === 'Town', 'property still carried');
}

// ── 17. A StatusQuery response carrying the PDF is readable ───────────────────
// This is the retrieval path used when a determination arrives with no certificate:
// the PDF must be extracted exactly as it is from an order response.
{
  const xml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE>
  <RESPONSE_DATA><FLOOD_RESPONSE>
    <EMBEDDED_FILE _EncodingType="Base64" _Extension="pdf" _Name="Flood.pdf">
      <DOCUMENT>JVBERi0xLjQKcmV0cmlldmVk</DOCUMENT>
    </EMBEDDED_FILE>
    <FLOOD_DETERMINATION FloodCertificationIdentifier="2322271" SpecialFloodHazardAreaIndicator="No">
      <_BUILDING_INFORMATION NFIPFloodZoneIdentifier="X"/>
    </FLOOD_DETERMINATION>
  </FLOOD_RESPONSE></RESPONSE_DATA>
  <STATUS _Name="success" _Condition="success"/>
</RESPONSE></RESPONSE_GROUP>`;
  const p = parseResponse(xml);
  ok(p.status === 'completed', 'status-query retrieval reads as completed');
  ok(/^JVBER/.test(p.pdfBase64 || ''), 'the certificate PDF is recovered from a StatusQuery');
  ok(p.floodZone === 'X' && p.sfha === false, 'the determination rides along too');
}

// ── 13. Flood auth is QUERY PARAMS by default (matches the Xactus Postman set) ─
{
  const { url, headers } = buildUrlAndHeaders({ endpoint: 'https://flood.xactus.example/order', username: 'op123', password: 'p@ss/wrd', authMode: 'query' });
  ok(/[?&]LoginAccountIdentifier=op123(&|$)/.test(url), 'login id rides in the URL query');
  ok(/LoginAccountPassword=/.test(url), 'password rides in the URL query');
  ok(/p%40ss/.test(url), 'reserved chars in the password are URL-encoded');
  ok(!headers.Authorization, 'no Basic auth header in query mode');
  ok(headers['Content-Type'] === 'text/xml', 'Content-Type is text/xml');
}

// ── 14. Basic auth ONLY when explicitly overridden ────────────────────────────
{
  const { url, headers } = buildUrlAndHeaders({ endpoint: 'https://flood.xactus.example/order', username: 'op123', password: 'secret', authMode: 'basic' });
  ok(/^Basic /.test(headers.Authorization || ''), 'Basic header present in basic mode');
  ok(!/LoginAccountIdentifier/.test(url), 'no login query param in basic mode');
}

// ── 15. Error surfacing carries the REAL Xactus reason + code ──────────────────
{
  // Code-only rejection (empty description) → the vendor code is still surfaced.
  const codeOnly = parseResponse('<?xml version="1.0"?><RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE><STATUS _Condition="error" _Code="E036"/></RESPONSE></RESPONSE_GROUP>');
  ok(codeOnly.status === 'error' && /E036/.test(codeOnly.error || ''), 'code-only rejection surfaces the code');
  // Description present → surfaced verbatim, with the code.
  const withDesc = parseResponse('<?xml version="1.0"?><RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE><STATUS _Condition="error" _Code="E036" _Description="Invalid Client Account Identifier, Incorrect password supplied"/></RESPONSE></RESPONSE_GROUP>');
  ok(/Invalid Client Account/.test(withDesc.error || '') && /E036/.test(withDesc.error || ''), 'description AND code both surfaced');
  // No reason anywhere → an actionable fallback, never a bare "failed".
  const noReason = parseResponse('<?xml version="1.0"?><RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE><STATUS _Condition="Error"/></RESPONSE></RESPONSE_GROUP>');
  ok(noReason.status === 'error' && /flood web address|activated/.test(noReason.error || ''), 'empty reason → actionable fallback');
  // A message carried only in a KEY element is recovered.
  const keyErr = parseResponse('<?xml version="1.0"?><RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE><KEY _Name="ErrorMessage" _Value="Flood product not enabled for this operator"/><STATUS _Condition="error"/></RESPONSE></RESPONSE_GROUP>');
  ok(/not enabled/.test(keyErr.error || ''), 'error recovered from a KEY element');
}

// ── 12. Test mode is REMOVED — the button always places a real order ──────────
{
  // dryrun() must be hard-false: no runtime/DB-backed switch (an override survived
  // deploys and pinned the button in test mode) and no env var (which PILOT can't
  // clear for the owner). Calling it must not require the DB (stays pure).
  ok(flood.dryrun() === false, 'test mode removed — the button is always live');
}

console.log(`test-xactus-flood-pure: ${n} assertions passed`);
