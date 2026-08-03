'use strict';
/**
 * CATCH THE APPRAISAL XML OUT OF ENCOMPASS, INSIDE ITS FIFTEEN-MINUTE WINDOW.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A POLLER, AND WHY THIS IS THE ONLY SHAPE THAT WORKS
 *
 * An AMC delivering an appraisal through Encompass Partner Connect attaches the
 * MISMO 2.6 XML to the service order as LOAN MEDIA (`urn:elli:media:loans`).
 * Encompass sorts delivered files BY TYPE and `.xml` is not an eFolder-supported
 * type, so it never becomes an eFolder attachment and never appears anywhere in
 * the Encompass UI. The order keeps a download URL **minted at delivery** with a
 * ~15-minute `validity`, and it is never regenerated: the one lender-side endpoint
 * that issues fresh URLs (`GET .../response/resources`) rides the eFolder export
 * pipeline, so loan media has no path through it, and the object store refuses
 * everything without that signature. Eleven other retrieval routes were tried and
 * eliminated — see docs/ENCOMPASS-APPRAISAL-XML-DISCOVERY.md.
 *
 * So the file is reachable ONLY between delivery and delivery+15min. A sweep of
 * every loan's appraisal orders takes ~20 seconds, so polling every few minutes
 * catches each one with room to spare. That is the whole design.
 *
 * A WEBHOOK WOULD ALSO WORK AND IS DELIBERATELY NOT USED. Subscribing to the
 * ServiceOrder events means `POST /webhook/v1/subscriptions` — a WRITE to
 * Encompass configuration, which the owner-directed READ-ONLY freeze forbids
 * without written sign-off. Polling needs no such permission: every call below is
 * a GET. The webhook remains the cheaper option if the freeze is ever relaxed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, STRUCTURALLY
 *
 * The Encompass side goes through `encompass.apiGet` — the frozen client, GET
 * only. Nothing here adds a POST, widens the allowlist, or touches the
 * `READ_ONLY` sentinel. The byte fetch is a plain GET to the storage host using
 * the signature Encompass itself handed us, host-allowlisted below.
 *
 * NEVER FATAL. This runs on a timer beside the other sync work. Every loan, every
 * resource and every download is independently guarded; a failure is recorded on
 * the row and retried on the next sweep. It can never throw into the worker.
 */
const { URL } = require('url');
const crypto = require('crypto');
const encompass = require('../lib/integrations/encompass');

// The resource `type` an appraisal report XML carries. Matched as a PREFIX so a
// future MISMO version (…:version:V3.6) is caught without a code change; the
// mimeType check below is the real gate, this only classifies.
const APPRAISAL_XML_TYPE = 'urn:ice:epc:partner:appraisal:report';

// ICE's own object store. An allowlist rather than a blanket fetch: the URL comes
// from an API response, and a compromised or malformed response must not be able
// to make the server fetch an arbitrary host.
//
// Deliberately NOT bare `elliemae.com` — that is the API host's own domain, and
// this is the one place in the repo that reaches an Encompass host with a raw
// `fetch` instead of the frozen client's `_fetchGuarded`. Keeping the API domain
// out of the allowlist preserves the property "every request to the Encompass
// API domain goes through the frozen client" for whoever edits this next.
const STORAGE_HOST_RE = /(^|\.)(skydrive\.ellieservices\.com|skydrive\.rd\.elliemae\.io|media-pod\d*-\w+\.elliemae\.com)$/i;

const MAX_XML_BYTES = 80 * 1024 * 1024;   // matches research/xml-import's ceiling
const DOWNLOAD_TIMEOUT_MS = 120000;       // a MISMO file embeds the whole report PDF

// The largest value `new Date(ms)` can represent. Beyond it the Date is Invalid,
// and `.toISOString()` on an Invalid Date THROWS — which used to abort a whole
// sweep from a single malformed `validity` stamp.
const MAX_TIME_MS = 8.64e15;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Is the catcher switched off? Two ways, deliberately.
 *
 * The env var is checked FIRST and wins on its own, so the catcher can always be
 * stopped even if the switches table is unreadable. The live switch is what lets
 * an operator stop a poller that talks to a vendor API without waiting for a
 * Render restart. It FAILS OPEN — an unreadable switch store leaves the catcher
 * running, because silently not catching is the failure this module exists to
 * prevent, and the env var remains as the guaranteed stop.
 */
function catchDisabled() {
  if (process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED === '1') return true;
  try {
    return !require('../lib/integrations/switches').on('ENCOMPASS_APPRAISAL_XML_CATCH_ENABLED');
  } catch { return false; }
}

/**
 * Decode the `validity` query parameter — base64 of epoch milliseconds — into a
 * Date. PURE. Returns null for anything it cannot read, and the caller treats
 * null as "unknown", never as "still valid".
 *
 * It must NEVER return an Invalid Date: the caller calls `.toISOString()` on the
 * result, which throws on one, and a single malformed stamp would take down the
 * rest of the sweep with it. `Number.isFinite` is not enough — 1e23 is finite and
 * positive and still out of Date's range.
 */
function validityOf(url) {
  const m = String(url || '').match(/[?&]validity=([^&]+)/);
  if (!m) return null;
  try {
    const ms = Number(Buffer.from(decodeURIComponent(m[1]), 'base64').toString());
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIME_MS) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

/**
 * Is this resource an appraisal report XML? PURE.
 *
 * The answer must be "an XML we can actually parse", not "something appraisal
 * shaped". Saying yes to a non-XML costs a download inside the ~15-minute window
 * and then a permanent 'failed' row that every later sweep retries.
 */
function isAppraisalXml(res) {
  if (!res) return false;
  const mime = String(res.mimeType || '').toLowerCase();
  const name = String(res.name || '');
  // An OOXML mime type ("application/vnd.openxmlformats-…") CONTAINS the substring
  // "xml" and is a Word/Excel file, not an appraisal. Refuse it before anything
  // else — this is the trap that made a naive /xml/i census report six Word
  // documents as XML.
  if (mime.includes('openxmlformats')) return false;
  // Likewise an SVG or an XHTML page: both contain "xml", both would pass a
  // "starts with <" byte sniff, and neither is an appraisal.
  if (mime.includes('svg') || mime.includes('xhtml')) return false;
  const looksXml = mime.includes('xml') || /\.xml$/i.test(name);
  // The declared type URN is a strong signal but NOT sufficient on its own: a UAD
  // 3.6 delivery carries the same `urn:ice:epc:partner:appraisal:report:…` type on
  // a ZIP PACKAGE. Downloading that burns the window and lands a permanent
  // 'failed' row that reads to an operator as a breakage rather than "not
  // applicable", so the payload still has to look like XML.
  if (String(res.type || '').startsWith(APPRAISAL_XML_TYPE)) return looksXml;
  return looksXml;
}

/** Guard the download URL's host. Throws with a plain reason. */
function assertStorageHost(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error('resource url is not a url'); }
  if (u.protocol !== 'https:') throw new Error('resource url is not https');
  if (!STORAGE_HOST_RE.test(u.hostname)) throw new Error(`resource url host not allowed: ${u.hostname}`);
  return u.toString();
}

/**
 * Decode enough of the head to sniff it, honouring a byte-order mark. PURE.
 *
 * A real MISMO file emitted by a Windows toolchain routinely carries a UTF-8 BOM,
 * and some vendors ship UTF-16. Read as latin1 those begin `ï»¿<?xml` / `<\0?\0…`
 * and fail a naive "starts with <" test — so the genuine appraisal was thrown
 * away and, because the URL dies in ~15 minutes, lost for good. That is the exact
 * outcome this module exists to prevent, so the BOM is handled before sniffing.
 */
function decodeHead(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3, 1200).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2, 2400).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    // UTF-16BE: swap to LE so Node can decode it.
    const b = Buffer.from(buf.slice(2, 2400));
    b.swap16();
    return b.toString('utf16le');
  }
  // Unmarked UTF-16LE (no BOM) still shows as `<\0?\0x\0m\0l`.
  if (buf.length >= 4 && buf[0] !== 0 && buf[1] === 0 && buf[3] === 0) {
    return buf.slice(0, 2400).toString('utf16le');
  }
  return buf.slice(0, 1200).toString('utf8');
}

/**
 * Does this really look like an appraisal XML document? PURE.
 *
 * The old test was `/^\s*<(\?xml|[A-Za-z_])/`, which is backwards on both edges:
 * it ACCEPTED `<html><head><title>Error</title>… Access Denied` — the HTML error
 * body the store serves at HTTP 200 when the window lapses mid-flight, which is
 * the precise case the sniff exists for — and REJECTED a BOM'd real appraisal.
 * Stored, that error page then failed to parse in the warehouse while the ledger
 * recorded a successful capture.
 */
function looksLikeXml(head) {
  const s = String(head || '').replace(/^﻿/, '').trimStart();
  if (!s.startsWith('<')) return false;
  // An HTML document is never an appraisal, however it is spelled.
  if (/^<!doctype\s+html/i.test(s) || /^<html[\s>]/i.test(s)) return false;
  // An XML declaration settles it.
  if (/^<\?xml[\s?]/i.test(s)) return true;
  // Otherwise require a plausible XML root element — a name, optionally
  // namespaced — rather than merely "a < and a letter".
  return /^<[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?[\s/>]/.test(s);
}

/**
 * Fetch the bytes. A GET, with the `elli-signature` Authorization value the
 * service order supplied. Redirects are NOT followed (`redirect:'manual'`) so a
 * redirect cannot walk us off the allowlisted host.
 */
async function fetchResource(url, authorization) {
  const safe = assertStorageHost(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const r = await fetch(safe, {
      method: 'GET',
      headers: authorization ? { Authorization: authorization } : {},
      redirect: 'manual',
      signal: ac.signal,
    });
    if (r.status >= 300 && r.status < 400) throw new Error(`resource url redirected (${r.status})`);
    // Refuse an oversized body BEFORE buffering it. `arrayBuffer()` materialises
    // the whole response in the worker's heap, so checking the length only
    // afterwards makes the cap decorative.
    const declared = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_XML_BYTES) {
      throw new Error(`download too large (${declared} bytes declared)`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) throw new Error(`download ${r.status}: ${buf.slice(0, 200).toString('latin1')}`);
    if (!buf.length) throw new Error('download returned no bytes');
    if (buf.length > MAX_XML_BYTES) throw new Error(`download too large (${buf.length} bytes)`);
    // The window can lapse mid-flight and the store answers with an HTML or JSON
    // error at HTTP 200 in some paths, so confirm this really is XML before
    // storing it — honouring a byte-order mark so a genuine appraisal is never
    // discarded for carrying one.
    const head = decodeHead(buf);
    if (!looksLikeXml(head)) {
      throw new Error(`download is not xml: ${head.slice(0, 120)}`);
    }
    return buf;
  } finally { clearTimeout(t); }
}

/** Every appraisal-category service order on one loan, expanded. */
async function appraisalOrders(loanGuid) {
  const list = await encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(loanGuid)}/serviceOrders`);
  const orders = Array.isArray(list) ? list : [];
  return orders.filter((o) => String((o.serviceSetup || {}).category || '').toUpperCase() === 'APPRAISAL');
}

/**
 * The expanded order. `view=complete` is what populates `response.resources[]` —
 * the default view omits it entirely.
 */
async function expandOrder(loanGuid, orderId) {
  return encompass.apiGet(
    `/encompass/v3/loans/${encodeURIComponent(loanGuid)}/serviceOrders/${encodeURIComponent(orderId)}?view=complete`
  );
}

// Every string below arrives from a VENDOR API response, not from a request body,
// so `src/lib/nul-strip.js` (which is request-body middleware) never sees it —
// exactly the "arrives some other way" case the repo's text-column rule names.
// A single NUL byte would raise 22021 and fail the INSERT; the resource would
// then never be downloaded, the ~15-minute window would close, and the file
// would be lost for a reason nobody could see.
const { textColumn } = require('../lib/fields');
const t500 = (v) => textColumn(v, null, 500);

/**
 * A vendor timestamp bound into a `timestamptz`. An unparseable one raises 22007
 * and costs us the file, and this column is a record rather than a key — so an
 * unreadable value is dropped, not fatal.
 */
function tsOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  const ms = d.getTime();
  if (Number.isNaN(ms) || Math.abs(ms) > MAX_TIME_MS) return null;
  return d.toISOString();
}

// Which status may overwrite which. A row must hold the STRONGEST outcome it has
// ever reached, because this ledger's whole job is to say what happened to each
// file: 'captured' (the bytes are ours) beats 'failed' (we tried and could not)
// beats 'expired' (we never had a chance) beats 'pending' (about to try). Without
// the ladder a resource we saw LIVE and failed to catch was silently relabelled
// 'expired' two sweeps later — which reads as "only the AMC can supply it" while
// still carrying the download error, destroying the one distinction the table
// exists to record.
const STATUS_RANK = { pending: 0, expired: 1, failed: 2, captured: 3 };

async function recordSighting(db, row) {
  const r = await db.query(
    `INSERT INTO encompass_appraisal_xml
       (resource_id, loan_guid, loan_number, order_id, transaction_id, vendor,
        resource_type, filename, mime_type, received_date, validity_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (resource_id) DO UPDATE SET
       loan_number   = COALESCE(encompass_appraisal_xml.loan_number, EXCLUDED.loan_number),
       order_id      = COALESCE(encompass_appraisal_xml.order_id, EXCLUDED.order_id),
       transaction_id= COALESCE(encompass_appraisal_xml.transaction_id, EXCLUDED.transaction_id),
       vendor        = COALESCE(encompass_appraisal_xml.vendor, EXCLUDED.vendor),
       received_date = COALESCE(encompass_appraisal_xml.received_date, EXCLUDED.received_date),
       validity_at   = COALESCE(encompass_appraisal_xml.validity_at, EXCLUDED.validity_at),
       -- keep whichever status ranks higher; never walk an outcome backwards
       status        = CASE
                         WHEN COALESCE((${statusRankSql('encompass_appraisal_xml.status')}), 0)
                            >= COALESCE((${statusRankSql('EXCLUDED.status')}), 0)
                         THEN encompass_appraisal_xml.status
                         ELSE EXCLUDED.status
                       END
     RETURNING id, status, storage_ref`,
    [t500(row.resourceId), t500(row.loanGuid), t500(row.loanNumber), t500(row.orderId),
     t500(row.transactionId), t500(row.vendor), t500(row.resourceType),
     t500(row.filename), t500(row.mimeType),
     tsOrNull(row.receivedDate), row.validityAt || null, row.status]
  );
  return r.rows[0];
}

/** The status ladder as a SQL expression, so the CASE above stays readable. */
function statusRankSql(col) {
  return Object.entries(STATUS_RANK)
    .map(([k, v]) => `WHEN ${col} = '${k}' THEN ${v}`)
    .reduce((acc, when) => `${acc} ${when}`, 'CASE') + ' ELSE 0 END';
}

/**
 * Capture one resource: download, store the bytes, feed the research warehouse.
 * Returns a short verdict string. Never throws.
 */
async function capture(db, res, meta) {
  const url = res.location || res.url;
  const auth = res.authorization || res.authorizationHeader;
  try {
    // Inside the try: a require that throws must not escape a function whose
    // documented contract is that it never does.
    const storage = require('../lib/storage');
    const buf = await fetchResource(url, auth);
    const digest = sha256(buf);
    const saved = await storage.save(buf, { filename: meta.filename || 'appraisal.xml' });

    // Feed the research warehouse through the SAME door a hand-uploaded XML uses,
    // so a report filed by the catcher is indistinguishable from one filed by a
    // human — it is keyed on the same sha256 and stands down against a loan-file
    // copy of the same report. Best-effort: the BYTES are the thing we cannot get
    // back, so a warehouse hiccup must not lose the capture.
    //
    // `importXml` NEVER THROWS — it reports every outcome in its shaped result,
    // and it writes its header row BEFORE parsing so an unreadable file is still
    // recorded. So a `catch` alone reads nothing: on a parse failure it hands
    // back a real `importId` with `ok:false`, and taking that id at face value
    // filled the ledger with rows claiming a clean capture while the warehouse
    // gained nothing and the error never surfaced anywhere.
    let importId = null;
    let importNote = null;
    try {
      const out = await require('../lib/research/xml-import')
        .importXml(db, { xml: buf.toString('utf8'), filename: meta.filename || null, uploadedBy: null });
      if (out && out.ok) {
        importId = out.importId || out.id || null;
      } else {
        importNote = `research import ${(out && out.status) || 'failed'}: ${(out && out.reason) || 'no reason given'}`;
        console.error('[encompass-xml]', importNote, '(bytes are safe)');
      }
    } catch (e) {
      importNote = `research import threw: ${(e && e.message) || e}`;
      console.error('[encompass-xml]', importNote, '(bytes are safe)');
    }

    // `status='captured'` is the truth about the BYTES, which is what could not be
    // re-fetched. A warehouse failure is recorded ALONGSIDE it in `error`, so the
    // two questions — "did we get the file?" and "is it in the warehouse?" — stay
    // separately answerable instead of one masking the other.
    await db.query(
      `UPDATE encompass_appraisal_xml
          SET status='captured', storage_ref=$2, storage_provider=$3, byte_size=$4,
              sha256=$5, research_import_id=$6, captured_at=now(), error=$7,
              attempts = attempts + 1
        WHERE resource_id=$1`,
      [meta.resourceId, saved.ref, saved.provider || null, buf.length, digest, importId,
       importNote ? String(importNote).slice(0, 500) : null]
    );
    return importNote
      ? `captured ${meta.filename} (${buf.length} bytes) — ${importNote}`
      : `captured ${meta.filename} (${buf.length} bytes)`;
  } catch (e) {
    await db.query(
      `UPDATE encompass_appraisal_xml
          SET status = CASE WHEN status='captured' THEN 'captured' ELSE 'failed' END,
              error=$2, attempts = attempts + 1
        WHERE resource_id=$1`,
      [meta.resourceId, String((e && e.message) || e).slice(0, 500)]
    ).catch(() => {});
    return `failed ${meta.filename}: ${(e && e.message) || e}`;
  }
}

/**
 * ONE SWEEP.
 *
 * `loans` is a list of { loanId/guid, loanNumber } — the caller decides the scope
 * (every loan, or only those the pipeline says changed recently). With none
 * supplied it asks the pipeline for loans touched since `sinceDays` ago, which is
 * the cheap steady-state mode.
 *
 * Returns a summary. NEVER throws.
 */
async function sweepOnce(db, { loans = null, sinceDays = 2, skewMs = 60000, log = false } = {}) {
  const out = {
    loans: 0, orders: 0, resources: 0, captured: 0, expired: 0, failed: 0,
    skipped: 0, noLink: 0, errors: [],
  };
  if (catchDisabled()) return { ...out, disabled: true };
  if (!encompass.configured()) return { ...out, disabled: true, reason: 'encompass not configured' };

  let list = loans;
  if (!list) {
    try {
      const since = new Date(Date.now() - Math.max(1, sinceDays) * 86400000).toISOString().slice(0, 10);
      const rows = await encompass.pipelineSearch({
        // `precision:'Day'` matches the proven filter in reader.js on this same
        // canonical field; without it the comparison is not the one the tenant's
        // other reads use.
        filter: {
          canonicalName: 'Loan.LastModified', value: since,
          matchType: 'GreaterThan', precision: 'Day',
        },
        // MOST RECENTLY MODIFIED FIRST. The result is capped, and only a recently
        // touched loan can hold a link that is still alive — without an explicit
        // descending sort the cap would take an arbitrary, unstable slice and the
        // live files could sit outside it.
        sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
        fields: ['Loan.Guid', 'Loan.LoanNumber'],
      }, { limit: 500 });
      list = (Array.isArray(rows) ? rows : []).map((r) => ({
        loanId: r.loanId || (r.fields || {})['Loan.Guid'],
        loanNumber: (r.fields || {})['Loan.LoanNumber'] || null,
      })).filter((x) => x.loanId);
    } catch (e) {
      out.errors.push(`pipeline: ${(e && e.message) || e}`);
      return out;
    }
  }

  for (const l of list) {
    out.loans++;
    let orders;
    try { orders = await appraisalOrders(l.loanId); }
    catch (e) { out.errors.push(`orders ${l.loanId}: ${(e && e.message) || e}`); continue; }

    for (const o of orders) {
      out.orders++;
      let full;
      try { full = await expandOrder(l.loanId, o.id); }
      catch (e) { out.errors.push(`expand ${o.id}: ${(e && e.message) || e}`); continue; }

      // Array.isArray, not `|| []`: a malformed response carrying a non-array
      // here would make `for…of` throw and abort the rest of the sweep — the same
      // malformed-response threat model the host allowlist exists for.
      const rawResources = ((full || {}).response || {}).resources;
      const resources = Array.isArray(rawResources) ? rawResources : [];
      for (const res of resources) {
        if (!isAppraisalXml(res)) continue;
        out.resources++;

        // Read the clock HERE. A sweep walks up to 500 loans sequentially, so a
        // timestamp taken once at the top is minutes stale by the end and would
        // judge liveness against the wrong clock in both directions.
        const now = Date.now();
        const url = res.location || res.url;
        const auth = res.authorization || res.authorizationHeader;

        // THE ALARM the discovery doc demanded. `location`/`authorization` are
        // UNDOCUMENTED fields; if ICE drops them, every resource silently records
        // as 'expired' — indistinguishable from the legitimately-expired back
        // book — and the feature would stop working with nobody ever knowing.
        if (!url || !auth) {
          out.noLink++;
          out.errors.push(`resource ${res.id} has no ${!url ? 'location' : 'authorization'} — ICE may have changed the service-order shape`);
        }

        // A resource with no id cannot be recorded (`resource_id` is NOT NULL) and
        // could not be de-duplicated even if it were. Say so rather than let the
        // INSERT fail with a bare constraint error.
        if (!textColumn(res.id, null, 500)) {
          out.errors.push(`resource on order ${o.id} has no id — cannot record it`);
          continue;
        }

        const validity = validityOf(url);
        // THE SKEW EXTENDS WILLINGNESS TO TRY; it does not curtail it. The cost
        // matrix is lopsided: attempting a dead link costs one request that fails
        // and is recorded, while skipping a LIVE one loses the file permanently —
        // the URL is never re-mintable, so there is no retry. So a link that is
        // marginally past its stamp is still attempted, in case our clock is
        // ahead; the old `(validity - skew) > now` wrote off a link with 45
        // seconds of life left as 'expired', which is the exact case worth
        // fighting for.
        const live = validity ? (validity.getTime() + skewMs) > now : false;
        const meta = {
          resourceId: res.id,
          loanGuid: l.loanId,
          loanNumber: l.loanNumber,
          orderId: o.id,
          transactionId: o.transactionId || null,
          vendor: ((o.serviceSetup || {}).product || {}).listingName || null,
          resourceType: res.type || null,
          filename: res.name || null,
          mimeType: res.mimeType || null,
          receivedDate: res.receivedDate || null,
          // validityOf can no longer return an Invalid Date, so this cannot throw.
          validityAt: validity ? validity.toISOString() : null,
          // 'pending' — NOT 'failed'. A crash between recording the sighting and
          // the download would otherwise leave a row indistinguishable from a real
          // download failure.
          status: live ? 'pending' : 'expired',
        };
        let known;
        try { known = await recordSighting(db, meta); }
        catch (e) { out.errors.push(`record ${res.id}: ${(e && e.message) || e}`); continue; }

        if (known && known.status === 'captured') { out.skipped++; continue; }
        if (!live) { out.expired++; continue; }

        const verdict = await capture(db, res, meta);
        if (/^captured/.test(verdict)) out.captured++; else out.failed++;
        if (log) console.log('[encompass-xml]', verdict);
      }
    }
  }
  return out;
}

// A sweep must never run twice at once. `sweepOnce` walks the pipeline result
// SEQUENTIALLY — up to 500 loans, one call for the loan's orders plus one per
// order to expand it, plus any download — so on a busy tenant or a slow
// Encompass day a single pass can comfortably outrun the 60s floor. Without a
// guard `setInterval` would fire on top of the pass already running, and each
// tick would add another concurrent walk of the SAME loans: doubled read load on
// a vendor API, two captures racing for one resource (the second `storage.save`
// orphaning the first blob), and under sustained slowness an unbounded pile-up.
// The same shape the sitewire orchestrator and the condition engine guard.
//
// Deliberately a plain in-process flag on the TIMER, not a lock inside
// `sweepOnce`: an operator or a test calling `sweepOnce` directly should still
// run, and a single process owns its own timer. It fails OPEN across restarts
// (nothing is persisted) — the cost of a rare overlap after a crash is one
// duplicated read, while refusing to sweep would silently lose files.
let sweeping = false;

/**
 * Build the guarded timer callback. Returns a function that runs one sweep and
 * resolves when that sweep has settled, so a caller (and the test) can await it;
 * `setInterval` simply ignores the promise.
 */
function makeTick(db) {
  return function tick() {
    if (sweeping) {
      // Not an error — the previous pass is simply still walking. Say so, so a
      // tenant that has outgrown its interval is visible in the log rather than
      // silently sweeping half as often as configured.
      console.log('[encompass-xml] previous sweep still running — skipping this tick');
      return Promise.resolve({ skipped: 'in-flight' });
    }
    sweeping = true;
    return sweepOnce(db, { log: true })
      .then((r) => {
        // Log every sweep that SAW anything, not only ones with captures or
        // errors. A sweep that finds 40 XMLs and writes all 40 off as 'expired'
        // used to log nothing at all — and since the whole historical back book is
        // legitimately expired, that silence is indistinguishable from normal
        // operation. The feature could stop working on day one unnoticed.
        if (r.resources || r.captured || r.failed || (r.errors || []).length) {
          console.log('[encompass-xml] sweep:', JSON.stringify({
            loans: r.loans, resources: r.resources, captured: r.captured,
            failed: r.failed, expired: r.expired, skipped: r.skipped,
            noLink: r.noLink,
            errors: (r.errors || []).slice(0, 3),
          }));
        }
        // The alarm the discovery doc asked for: `location`/`authorization` are
        // undocumented, so losing them is a silent total failure, not a blip.
        if (r.noLink) {
          console.error(`[encompass-xml] ALARM: ${r.noLink} appraisal XML resource(s) carried no download link — ` +
            'ICE may have changed the service-order response. Nothing can be caught until this is looked at.');
        }
        return r;
      })
      .catch((e) => {
        console.error('[encompass-xml] sweep threw (non-fatal):', e && e.message);
        return { threw: (e && e.message) || String(e) };
      })
      // The flag MUST be released on every path — a sweep that threw and left it
      // set would wedge the catcher for the life of the process, silently.
      .finally(() => { sweeping = false; });
  };
}

/**
 * The timer. Started beside the other Encompass sync work.
 *
 * The interval must stay comfortably under the ~15-minute validity, so the
 * default 5 minutes leaves margin for a slow Encompass day even though the walk
 * is sequential. Raising it past ~10 minutes starts losing files, which is
 * exactly the failure this module exists to prevent.
 */
function start(db, { intervalSec = Number(process.env.ENCOMPASS_APPRAISAL_XML_POLL_SEC || 300) } = {}) {
  // Only the ENV kill stops the timer being armed at all. The live switch is
  // deliberately NOT checked here: it is re-read inside every tick (via
  // `sweepOnce`'s own gate), so flipping it off stops the work and flipping it
  // back on resumes it — which is the whole point of a live switch.
  if (process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED === '1') {
    console.log('[encompass-xml] catcher disabled by env');
    return null;
  }
  if (!encompass.configured()) return null;
  const every = Math.max(60, Math.min(600, Number(intervalSec) || 300));
  const tick = makeTick(db);
  const t = setInterval(tick, every * 1000);
  if (t.unref) t.unref();
  const first = setTimeout(tick, 15000);
  if (first.unref) first.unref();
  console.log(`[encompass-xml] catcher on, sweeping every ${every}s`);
  return t;
}

module.exports = {
  start,
  sweepOnce,
  // exported for tests
  _internals: {
    validityOf, isAppraisalXml, assertStorageHost, STORAGE_HOST_RE, makeTick,
    decodeHead, looksLikeXml, tsOrNull,
  },
};
