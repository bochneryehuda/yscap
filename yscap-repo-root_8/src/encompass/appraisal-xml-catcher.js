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
const STORAGE_HOST_RE = /(^|\.)(skydrive\.ellieservices\.com|elliemae\.com|elliemae\.io)$/i;

const MAX_XML_BYTES = 80 * 1024 * 1024;   // matches research/xml-import's ceiling
const DOWNLOAD_TIMEOUT_MS = 120000;       // a MISMO file embeds the whole report PDF

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Decode the `validity` query parameter — base64 of epoch milliseconds — into a
 * Date. PURE. Returns null for anything it cannot read, and the caller treats
 * null as "unknown", never as "still valid": we would rather skip a file and
 * record it than spend a download on a URL that is certainly dead.
 */
function validityOf(url) {
  const m = String(url || '').match(/[?&]validity=([^&]+)/);
  if (!m) return null;
  try {
    const ms = Number(Buffer.from(decodeURIComponent(m[1]), 'base64').toString());
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
  } catch { return null; }
}

/**
 * Is this resource an appraisal report XML? PURE.
 * The mimeType is the gate; the `type` URN is a second, weaker signal, because a
 * partner is free to set `type` to its own document-type string on MISMO 2.6 (the
 * `urn:ice:…` form is only standardised for the newer UAD packages).
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
  // The declared type URN settles it when the partner sets one (the `urn:ice:…`
  // form is only standardised for the newer UAD packages, so it is a bonus signal
  // rather than the gate).
  if (String(res.type || '').startsWith(APPRAISAL_XML_TYPE)) return true;
  return mime.includes('xml') || /\.xml$/i.test(name);
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
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) throw new Error(`download ${r.status}: ${buf.slice(0, 200).toString('latin1')}`);
    if (!buf.length) throw new Error('download returned no bytes');
    if (buf.length > MAX_XML_BYTES) throw new Error(`download too large (${buf.length} bytes)`);
    // The window can lapse mid-flight and the store answers with a JSON error at
    // HTTP 200 in some paths, so confirm this really is XML before storing it.
    const head = buf.slice(0, 400).toString('latin1');
    if (!/^\s*<(\?xml|[A-Za-z_])/.test(head)) {
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

/**
 * Record what we saw. UPSERT on `resource_id`.
 *
 * A row NEVER regresses from 'captured': once the bytes are ours, a later sweep
 * seeing the same (now expired) resource must not overwrite the capture with
 * 'expired'. That is the whole reason the status is written with a CASE rather
 * than assigned.
 */
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
       status        = CASE WHEN encompass_appraisal_xml.status = 'captured'
                            THEN 'captured' ELSE EXCLUDED.status END
     RETURNING id, status, storage_ref`,
    [row.resourceId, row.loanGuid, row.loanNumber || null, row.orderId || null,
     row.transactionId || null, row.vendor || null, row.resourceType || null,
     row.filename || null, row.mimeType || null,
     row.receivedDate || null, row.validityAt || null, row.status]
  );
  return r.rows[0];
}

/**
 * Capture one resource: download, store the bytes, feed the research warehouse.
 * Returns a short verdict string. Never throws.
 */
async function capture(db, res, meta) {
  const storage = require('../lib/storage');
  const url = res.location || res.url;
  const auth = res.authorization || res.authorizationHeader;
  try {
    const buf = await fetchResource(url, auth);
    const digest = sha256(buf);
    const saved = await storage.save(buf, { filename: meta.filename || 'appraisal.xml' });

    // Feed the research warehouse through the SAME door a hand-uploaded XML uses,
    // so a report filed by the catcher is indistinguishable from one filed by a
    // human — it is keyed on the same sha256 and stands down against a loan-file
    // copy of the same report. Best-effort: the BYTES are the thing we cannot get
    // back, so a warehouse hiccup must not lose the capture.
    let importId = null;
    try {
      const out = await require('../lib/research/xml-import')
        .importXml(db, { xml: buf.toString('utf8'), filename: meta.filename || null, uploadedBy: null });
      importId = (out && (out.importId || out.id)) || null;
    } catch (e) {
      console.error('[encompass-xml] research import failed (bytes are safe):', e && e.message);
    }

    await db.query(
      `UPDATE encompass_appraisal_xml
          SET status='captured', storage_ref=$2, storage_provider=$3, byte_size=$4,
              sha256=$5, research_import_id=$6, captured_at=now(), error=NULL,
              attempts = attempts + 1
        WHERE resource_id=$1`,
      [meta.resourceId, saved.ref, saved.provider || null, buf.length, digest, importId]
    );
    return `captured ${meta.filename} (${buf.length} bytes)`;
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
  const out = { loans: 0, orders: 0, resources: 0, captured: 0, expired: 0, failed: 0, skipped: 0, errors: [] };
  if (process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED === '1') return { ...out, disabled: true };
  if (!encompass.configured()) return { ...out, disabled: true, reason: 'encompass not configured' };

  let list = loans;
  if (!list) {
    try {
      const since = new Date(Date.now() - Math.max(1, sinceDays) * 86400000).toISOString().slice(0, 10);
      const rows = await encompass.pipelineSearch({
        filter: { canonicalName: 'Loan.LastModified', value: since, matchType: 'GreaterThan' },
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

  const now = Date.now();
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

      const resources = ((full || {}).response || {}).resources || [];
      for (const res of resources) {
        if (!isAppraisalXml(res)) continue;
        out.resources++;
        const url = res.location || res.url;
        const validity = validityOf(url);
        const live = validity ? (validity.getTime() - skewMs) > now : false;
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
          validityAt: validity ? validity.toISOString() : null,
          status: live ? 'failed' : 'expired',   // 'failed' is the pre-capture placeholder
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

/**
 * The timer. Started beside the other Encompass sync work.
 *
 * The interval must stay comfortably under the ~15-minute validity — a sweep of
 * the whole tenant measured ~20 seconds, so the default 5 minutes leaves a wide
 * margin for a slow Encompass day. Raising it past ~10 minutes starts losing
 * files, which is exactly the failure this module exists to prevent.
 */
function start(db, { intervalSec = Number(process.env.ENCOMPASS_APPRAISAL_XML_POLL_SEC || 300) } = {}) {
  if (process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED === '1') {
    console.log('[encompass-xml] catcher disabled by env');
    return null;
  }
  if (!encompass.configured()) return null;
  const every = Math.max(60, Math.min(600, Number(intervalSec) || 300));
  const tick = () => {
    sweepOnce(db, { log: true })
      .then((r) => {
        if (r.captured || r.failed || (r.errors || []).length) {
          console.log('[encompass-xml] sweep:', JSON.stringify({
            loans: r.loans, resources: r.resources, captured: r.captured,
            failed: r.failed, expired: r.expired, skipped: r.skipped,
            errors: (r.errors || []).slice(0, 3),
          }));
        }
      })
      .catch((e) => console.error('[encompass-xml] sweep threw (non-fatal):', e && e.message));
  };
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
  _internals: { validityOf, isAppraisalXml, assertStorageHost, STORAGE_HOST_RE },
};
