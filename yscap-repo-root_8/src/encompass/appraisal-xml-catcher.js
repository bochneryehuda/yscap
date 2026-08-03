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

// A sweep walks up to 500 loans, so an error per resource could grow without
// bound and be carried around in memory for the whole pass. Keep a readable
// sample and COUNT the rest — a silent truncation would read as "only three
// things went wrong".
const MAX_ERRORS = 50;
function pushErr(out, msg) {
  if (out.errors.length < MAX_ERRORS) out.errors[out.errors.length] = msg;
  else out.errorsDropped = (out.errorsDropped || 0) + 1;
}

// ICE's own object store. An allowlist rather than a blanket fetch: the URL comes
// from an API response, and a compromised or malformed response must not be able
// to make the server fetch an arbitrary host.
//
// The invariant worth protecting is "this raw fetch never reaches the Encompass
// API HOST" — not "never reaches its domain". This is the one place in the repo
// that talks to an Encompass host outside the frozen client's `_fetchGuarded`,
// so `api.elliemae.com` (and any api* sibling) is refused outright.
//
// Everything else is deliberately GENEROUS, because the two failure directions
// are not symmetric: letting through an unexpected ICE storage host costs
// nothing (the URL still has to carry ICE's own signature), while refusing a
// legitimate one throws inside capture(), the link dies minutes later, and the
// file is unrecoverable. The hosts actually observed are all non-production
// (`-int`, `.rd.`), so pinning their exact spelling would have refused their
// production siblings — `media-pod0.elliemae.com`,
// `streaming.us-west-2.skydrive.elliemae.io` — the day this went live.
const API_HOST_RE = /(^|\.)api[\w-]*\.elliemae\.(com|io)$/i;
const STORAGE_HOST_RE = /(^|\.)(skydrive\.ellieservices\.com|elliemae\.io|(media-pod[\w-]*|[\w-]*skydrive[\w-]*|[\w-]*streaming[\w-]*)\.elliemae\.com)$/i;

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
const CATCH_SWITCH_KEY = 'ENCOMPASS_APPRAISAL_XML_CATCH_ENABLED';

function catchDisabled() {
  if (process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED === '1') return true;
  try {
    const switches = require('../lib/integrations/switches');
    // `switches.on()` answers FALSE for an unknown key — safe for a read gate,
    // but NEGATED here that reads as "disabled", so a future rename or removal of
    // the registry entry would silently stop the catcher forever: `start()` only
    // consults the env var, so it would still log "catcher on", and a sweep that
    // returns all zeros logs nothing. That is the same silent-total-failure the
    // noLink alarm exists to prevent. So the key's EXISTENCE is checked first.
    if (!switches.BY_KEY || !switches.BY_KEY[CATCH_SWITCH_KEY]) {
      console.warn(`[encompass-xml] switch ${CATCH_SWITCH_KEY} is not in the registry — ` +
        'staying ON and relying on the env kill switch');
      return false;
    }
    return !switches.on(CATCH_SWITCH_KEY);
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
  // The declared type URN (`urn:ice:epc:partner:appraisal:report:…`, matched as a
  // PREFIX so a future MISMO/UAD version needs no code change) says WHAT the
  // resource is, but not what FORMAT it is in: a UAD 3.6 delivery carries that
  // same type on a ZIP PACKAGE. Downloading that burns part of the 15-minute
  // window on something that can never parse and leaves a permanent 'failed' row
  // which every later sweep retries and which reads to an operator as a breakage
  // rather than "not applicable". So the format decides, for every resource.
  return mime.includes('xml') || /\.xml$/i.test(name);
}

/** Guard the download URL's host. Throws with a plain reason. */
function assertStorageHost(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error('resource url is not a url'); }
  if (u.protocol !== 'https:') throw new Error('resource url is not https');
  // The API host is refused BEFORE the allowlist, so no future widening of the
  // storage patterns can accidentally readmit it.
  if (API_HOST_RE.test(u.hostname)) throw new Error(`resource url is the API host, not storage: ${u.hostname}`);
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
  // `swap16()` REQUIRES an even length, so every big-endian path trims to one —
  // a truncated odd-length body would otherwise throw a RangeError and the
  // operator would see a Node internal message instead of a reason.
  const beToLe = (slice) => {
    const even = slice.length - (slice.length % 2);
    const b = Buffer.from(slice.slice(0, even));
    b.swap16();
    return b.toString('utf16le');
  };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3, 1200).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2, 2400).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return beToLe(buf.slice(2, 2400));
  }
  // Unmarked UTF-16, both byte orders. LE shows as `<\0?\0`, BE as `\0<\0?`.
  // Handling only LE meant an unmarked big-endian appraisal was refused and its
  // bytes discarded.
  if (buf.length >= 4 && buf[0] !== 0 && buf[1] === 0 && buf[3] === 0) {
    return buf.slice(0, 2400).toString('utf16le');
  }
  if (buf.length >= 4 && buf[0] === 0 && buf[1] !== 0 && buf[2] === 0) {
    return beToLe(buf.slice(0, 2400));
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
  let s = String(head || '').replace(/^﻿/, '').trimStart();
  if (!s) return false;
  // A real document may legitimately open with a comment or a processing
  // instruction before its root ("<!-- generated by … -->\n<?xml …"). Step over
  // those first, or a genuine appraisal is discarded — and its bytes are gone.
  for (let guard = 0; guard < 10; guard++) {
    const m = /^(<!--[\s\S]*?-->|<\?[^>]*\?>|<!DOCTYPE\s+[^>[]*(\[[\s\S]*?\])?\s*>)\s*/i.exec(s);
    if (!m) break;
    // A DOCTYPE naming html is decisive the other way.
    if (/^<!DOCTYPE\s+html/i.test(m[0])) return false;
    // An XML declaration is decisive FOR xml, but keep walking: the payload may
    // still be an XML-wrapped error, which the token check below catches.
    s = s.slice(m[0].length);
  }
  if (!s.startsWith('<')) return false;
  // An HTML document OR FRAGMENT is never an appraisal. The store serves both —
  // a bare `<body>Access Denied</body>` has no doctype and no <html>.
  if (/^<(html|head|body|title|h[1-6]|div|p|span|a|meta|script|table|center|pre|ul|ol|li|br|hr|form|iframe|style|link|img|font|b|i|em|strong|tbody|tr|td)[\s/>]/i.test(s)) return false;
  // An XML-wrapped error is the object store's OTHER refusal shape
  // (`<Error><Code>AccessDenied</Code>…`), and it is well-formed XML, so nothing
  // below would catch it. Case-insensitive and namespace-tolerant: `<ERROR>` and
  // `<s3:Error>` are the same refusal wearing different clothes.
  if (/^<[\w.-]*:?(error|fault|errorresponse|errordocument)[\s/>]/i.test(s)) return false;
  // Require a plausible XML root element — a name, optionally namespaced —
  // rather than merely "a < and a letter".
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

// Postgres `timestamptz` cannot hold a year outside 4713 BC .. 294276 AD, and
// `Date.prototype.toISOString()` emits the ES extended-year form ("+275760-09-13…")
// for anything past year 9999 — which Postgres refuses outright with 22009
// ("time zone displacement out of range"). Keep every bound timestamp inside a
// plainly sane window instead: no appraisal was delivered before 1970 and none
// will be delivered after 9999.
const TS_MIN_MS = Date.UTC(1970, 0, 1);
const TS_MAX_MS = Date.UTC(9999, 11, 31);

/**
 * A vendor timestamp bound into a `timestamptz`. PURE.
 *
 * An unparseable — or unrepresentable — value raises 22007/22009, which fails the
 * whole INSERT and therefore costs us the FILE. These columns are a record, not a
 * key, so an unusable value is dropped rather than allowed to be fatal.
 */
function tsOrNull(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return tsFromMs(v.getTime());
  if (typeof v === 'number') return tsFromMs(v);
  if (typeof v !== 'string') return null;
  // A padded but perfectly valid vendor stamp must not be thrown away.
  const s = v.trim();
  if (!s) return null;
  return tsFromMs(new Date(s).getTime());
}

function tsFromMs(ms) {
  if (!Number.isFinite(ms) || ms < TS_MIN_MS || ms > TS_MAX_MS) return null;
  return new Date(ms).toISOString();
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
    // EVERY timestamp goes through tsOrNull — `validity_at` included. It is
    // derived from validityOf(), which accepts any epoch-ms up to Date's own
    // ±8.64e15 limit, so a stamp in epoch MICROseconds (a plausible vendor
    // variation) yields a year-58528 date whose ISO form Postgres rejects with
    // 22009 — failing the INSERT, skipping the download, and losing the file.
    // `resource_id` is bound AS GIVEN. The caller has already normalised it, and
    // `textColumn` is NOT idempotent — it strips, then trims, then slices, so a
    // value whose 500-char cut lands on whitespace loses another character on a
    // second pass. Re-normalising here would store a key one character shorter
    // than the one capture()'s UPDATEs look for, which is precisely the
    // orphaned-bytes bug this was meant to close.
    [row.resourceId, t500(row.loanGuid), t500(row.loanNumber), t500(row.orderId),
     t500(row.transactionId), t500(row.vendor), t500(row.resourceType),
     t500(row.filename), t500(row.mimeType),
     tsOrNull(row.receivedDate), tsOrNull(row.validityAt), row.status]
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
    const upd = await db.query(
      `UPDATE encompass_appraisal_xml
          SET status='captured', storage_ref=$2, storage_provider=$3, byte_size=$4,
              sha256=$5, research_import_id=$6, captured_at=now(), error=$7,
              attempts = attempts + 1
        WHERE resource_id=$1`,
      // `error` is a VENDOR-DERIVED string — an import reason quoting the file,
      // or below, a download error quoting the response body — so it goes through
      // the same NUL-stripping guard as every other text bind. Postgres refuses a
      // NUL in text with 22021, and here that would throw a genuinely CAPTURED
      // file into the failure path.
      [meta.resourceId, saved.ref, saved.provider || null, buf.length, digest, importId,
       t500(importNote)]
    );
    // An UPDATE that matched NOTHING means the ledger and this write disagree
    // about the key — the bytes are saved but orphaned, the row never leaves
    // 'pending', and every later sweep re-attempts a dead URL. Silence here is
    // what let exactly that bug live, so it is now said out loud.
    if (upd && upd.rowCount === 0) {
      console.error(`[encompass-xml] capture recorded NOTHING for resource ${meta.resourceId} — ` +
        `the bytes are at ${saved.ref} but the ledger row was not found`);
      return `captured-unrecorded ${meta.filename} (${buf.length} bytes)`;
    }
    return importNote
      ? `captured ${meta.filename} (${buf.length} bytes) — ${importNote}`
      : `captured ${meta.filename} (${buf.length} bytes)`;
  } catch (e) {
    await db.query(
      `UPDATE encompass_appraisal_xml
          SET status = CASE WHEN status='captured' THEN 'captured' ELSE 'failed' END,
              error=$2, attempts = attempts + 1
        WHERE resource_id=$1`,
      // NUL-guarded for the same reason: this message quotes the response BODY
      // (`download 403: …`, `download is not xml: …`), so any binary payload —
      // a PNG, a ZIP, a PDF — puts a NUL in it. Unguarded, the UPDATE was
      // rejected (22021) and swallowed by the .catch below: the failure was never
      // recorded, `attempts` stayed 0, the row stayed 'pending', and the next
      // sweep promoted it to 'expired' — so a file we saw LIVE and tried to fetch
      // ended up reading "only the AMC can supply it". That is exactly the
      // distinction the status ladder exists to protect.
      [meta.resourceId, t500(String((e && e.message) || e))]
    ).then((r) => {
      if (r && r.rowCount === 0) {
        console.error(`[encompass-xml] failure recorded NOTHING for resource ${meta.resourceId} — ledger row not found`);
      }
    }).catch(() => {});
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
    skipped: 0, noLink: 0, capturedUnrecorded: 0, errorsDropped: 0, errors: [],
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
      // Read the row through reader.js's OWN helpers rather than a narrower copy.
      // A live pipeline response on 2026-07-26 came back without a `Loan.Guid`,
      // which is why `_rowGuid` accepts six spellings; a private two-spelling
      // reader here would have dropped every row, reported all zeros, and — since
      // a sweep with nothing in it logs nothing — done so in complete silence.
      // The `||` fallback covers a MISSING EXPORT; a module LOAD failure is a
      // throw, and letting it reach the outer catch would discard a search that
      // already succeeded. So the require gets its own guard.
      let reader = {};
      try { reader = require('./reader'); } catch { /* fall back to the local readers */ }
      const guidOf = reader._rowGuid || ((r) => r.loanId || (r.fields || {})['Loan.Guid']);
      const fieldOf = reader._rowField || ((r, n) => (r.fields || {})[n]);
      list = (Array.isArray(rows) ? rows : []).map((r) => ({
        loanId: guidOf(r),
        loanNumber: fieldOf(r, 'Loan.LoanNumber') || null,
      })).filter((x) => x.loanId);
      if (Array.isArray(rows) && rows.length && !list.length) {
        pushErr(out, `pipeline returned ${rows.length} row(s) but no loan id could be read from any of them`);
      }
    } catch (e) {
      pushErr(out, `pipeline: ${(e && e.message) || e}`);
      return out;
    }
  }

  for (const l of list) {
    out.loans++;
    let orders;
    try { orders = await appraisalOrders(l.loanId); }
    catch (e) { pushErr(out, `orders ${l.loanId}: ${(e && e.message) || e}`); continue; }

    for (const o of orders) {
      out.orders++;
      let full;
      try { full = await expandOrder(l.loanId, o.id); }
      catch (e) { pushErr(out, `expand ${o.id}: ${(e && e.message) || e}`); continue; }

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
        // Counted SEPARATELY from `expired`: a link we never got is a different
        // fact from a link that died, and folding them together is precisely the
        // confusion the alarm exists to break. The row is still recorded (so the
        // back book stays a complete list) but it is not double-counted.
        const missingLink = !url || !auth;
        if (missingLink) {
          out.noLink++;
          pushErr(out, `resource ${res.id} has no ${!url ? 'location' : 'authorization'} — ICE may have changed the service-order shape`);
        }

        // A resource with no id cannot be recorded (`resource_id` is NOT NULL) and
        // could not be de-duplicated even if it were. Say so rather than let the
        // INSERT fail with a bare constraint error.
        //
        // NORMALISE ONCE, HERE, and carry THIS value everywhere. `textColumn`
        // trims, strips NUL and caps at 500, so an id that differs from the raw
        // one — padded, NUL-bearing, over-long — would be STORED under the
        // normalised key while capture()'s UPDATEs looked for the raw one:
        // matching zero rows, leaving the ledger stuck at 'pending' with the
        // bytes saved and orphaned, and letting every later sweep re-attempt a
        // dead URL. Both UPDATEs are silent about `rowCount`, so it would never
        // have surfaced.
        const resourceId = textColumn(res.id, null, 500);
        if (!resourceId) {
          pushErr(out, `resource on order ${o.id} has no id — cannot record it`);
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
          resourceId,
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
          //
          // A resource with NO LINK is terminal for us whatever its stamp says: we
          // cannot fetch it, and only the AMC can supply it — the same practical
          // position as an expiry. Leaving it 'pending' (which a missing
          // `authorization` alongside a live stamp used to do) left a row that
          // never reached a settled state and whose `attempts` stayed 0 forever.
          // The noLink counter and the alarm carry the distinction.
          status: (live && !missingLink) ? 'pending' : 'expired',
        };
        let known;
        try { known = await recordSighting(db, meta); }
        catch (e) { pushErr(out, `record ${res.id}: ${(e && e.message) || e}`); continue; }

        if (known && known.status === 'captured') { out.skipped++; continue; }
        // A resource whose link never arrived is not "expired" — it is the alarm
        // case, already counted in noLink.
        if (missingLink) continue;
        if (!live) { out.expired++; continue; }

        const verdict = await capture(db, res, meta);
        if (verdict.startsWith('captured-unrecorded')) out.capturedUnrecorded = (out.capturedUnrecorded || 0) + 1;
        if (verdict.startsWith('captured')) out.captured++; else out.failed++;
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
      // `skippedTick`, not `skipped` — sweepOnce returns `skipped` as a COUNT, and
      // reusing the key with a string would give one field two types.
      return Promise.resolve({ skippedTick: true });
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
            // Both of these are the whole point of counting rather than
            // truncating: printing three errors while silently dropping ten more,
            // or capturing bytes the ledger never recorded, must not look like a
            // clean run.
            capturedUnrecorded: r.capturedUnrecorded || 0,
            errorsDropped: r.errorsDropped || 0,
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
    decodeHead, looksLikeXml, tsOrNull, recordSighting,
  },
};
