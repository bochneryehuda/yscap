/**
 * SharePoint (Microsoft Graph) client for the one-way Pipeline Drive mirror.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HARD RULES (docs/SHAREPOINT-POLICY.md, CLAUDE.md — owner-directed):        │
 * │  • NEVER delete or recycle anything in SharePoint — remove() is a throwing │
 * │    no-op — with ONE owner-sanctioned exception (2026-07-16):               │
 * │    deleteReplacedCorruptMirror(), seven-guard replacement of a DIAGNOSED-  │
 * │    corrupt mirror copy by its verified "(fixed copy)", Pilot folders only. │
 * │  • NEVER overwrite an existing file: uploads use conflictBehavior 'fail'.  │
 * │  • Moves/renames are forbidden EXCEPT the single owner-approved case:      │
 * │    relocating the portal's OWN previously-uploaded mirror copies between   │
 * │    folders the portal itself created inside a `YS portal syncing` folder   │
 * │    (the Version-N shuffle). moveOwnItem() enforces an expected-parent      │
 * │    check; callers additionally verify DB ownership of the item id.        │
 * │  • One-way: this module never downloads document bytes from SharePoint    │
 * │    into the portal (folder LISTINGS are read for matching only).          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Auth: Azure AD client credentials. Prefers a CERTIFICATE (MS_CLIENT_CERT_PEM,
 * a PEM containing both the private key and the certificate) and falls back to
 * the CLIENT SECRET (MS_CLIENT_SECRET) — owner-directed dual auth so a failure
 * of one credential doesn't stop the sync.
 *
 * Throttling: every call honors 429/503 Retry-After exactly (retrying early
 * extends Graph's cooldown) with exponential backoff when absent.
 *
 * Storage ref format for mirror copies: "sp:<driveId>:<itemId>".
 */
const crypto = require('crypto');
const cfg = require('../config');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;   // >4MB requires an upload session
const CHUNK = 5 * 1024 * 1024;
const MAX_TRIES = 6;

let _tok = { value: null, exp: 0 };
let _tokenInflight = null;   // single-flight: concurrent callers share one token fetch
let _drive = null;

function configured() {
  return !!(cfg.msTenantId && cfg.msClientId && (cfg.msClientSecret || cfg.msClientCertPem));
}

async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Build the signed client-assertion JWT for certificate auth. The PEM must
// contain a CERTIFICATE block (for the x5t thumbprint) and a PRIVATE KEY block.
function certAssertion() {
  const pem = cfg.msClientCertPem;
  const certMatch = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!certMatch) throw new Error('MS_CLIENT_CERT_PEM has no CERTIFICATE block');
  const der = Buffer.from(certMatch[1].replace(/\s+/g, ''), 'base64');
  const x5t = b64url(crypto.createHash('sha1').update(der).digest());
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', x5t }));
  const claims = b64url(JSON.stringify({
    aud: `https://login.microsoftonline.com/${cfg.msTenantId}/oauth2/v2.0/token`,
    iss: cfg.msClientId, sub: cfg.msClientId,
    jti: crypto.randomUUID(), nbf: now - 60, exp: now + 600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(pem);
  return `${header}.${claims}.${b64url(sig)}`;
}

// Token via cert first (when configured), then secret — dual auth with fallback.
// Single-flight so a burst of Graph calls never stampedes the token endpoint.
async function getToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  if (_tokenInflight) return _tokenInflight;
  _tokenInflight = fetchTokenNow().finally(() => { _tokenInflight = null; });
  return _tokenInflight;
}

async function fetchTokenNow() {
  if (!configured()) throw new Error('SharePoint not configured (MS_TENANT_ID/MS_CLIENT_ID + secret or cert)');
  const url = `https://login.microsoftonline.com/${cfg.msTenantId}/oauth2/v2.0/token`;
  const attempts = [];
  if (cfg.msClientCertPem) attempts.push('cert');
  if (cfg.msClientSecret) attempts.push('secret');
  let lastErr;
  for (const kind of attempts) {
    try {
      const body = new URLSearchParams({
        client_id: cfg.msClientId,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
        ...(kind === 'cert'
          ? { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: certAssertion() }
          : { client_secret: cfg.msClientSecret }),
      });
      const r = await fetchWithTimeout(url, { method: 'POST', body }, 30000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Graph token via ${kind}: ${j.error_description || r.status}`);
      _tok = { value: j.access_token, exp: Date.now() + (j.expires_in * 1000) };
      return _tok.value;
    } catch (e) {
      lastErr = e;
      console.warn(`[sharepoint] auth via ${kind} failed (${e.message}); ${attempts.indexOf(kind) < attempts.length - 1 ? 'falling back' : 'no fallback left'}`);
    }
  }
  throw lastErr || new Error('SharePoint auth failed');
}

/**
 * Core Graph call with throttling + retry. Honors Retry-After on 429/503/504
 * exactly; exponential backoff (with jitter) otherwise; one token refresh on 401.
 */
async function graph(path, { method = 'GET', headers = {}, body, raw = false, timeout = 60000 } = {}) {
  const url = path.startsWith('http') ? path : GRAPH + path;
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      const token = await getToken();
      r = await fetchWithTimeout(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body }, timeout);
    } catch (e) {
      if (attempt >= MAX_TRIES) throw e;
      await sleep(Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400));
      continue;
    }
    if (r.status === 401 && !refreshed) { refreshed = true; _tok = { value: null, exp: 0 }; continue; }
    if ((r.status === 429 || r.status === 503 || r.status === 504) && attempt < MAX_TRIES) {
      const ra = parseInt(r.headers.get('retry-after') || '0', 10);
      const wait = ra > 0 ? Math.min(ra * 1000, 120000) : Math.min(60000, 1000 * 2 ** attempt);
      console.warn(`[sharepoint] ${r.status} on ${method} ${path.slice(0, 80)} — honoring Retry-After ${Math.round(wait / 1000)}s`);
      await sleep(wait + Math.floor(Math.random() * 250));
      continue;
    }
    if (raw) return r;
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!r.ok) {
      // request-id is what Microsoft support needs to trace a failure on their
      // side — always carry it in the error (industry practice for Graph).
      const reqId = r.headers.get('request-id') || r.headers.get('client-request-id') || '';
      const err = new Error(`Graph ${method} ${path.slice(0, 120)} -> ${r.status} ${json?.error?.code || ''}: ${(json?.error?.message || text).slice(0, 200)}${reqId ? ` [request-id ${reqId}]` : ''}`);
      err.status = r.status;
      err.graphCode = json?.error?.code;
      err.graphRequestId = reqId || undefined;
      throw err;
    }
    return json;
  }
}

// Resolve (and cache) the target document-library drive. A pinned
// SHAREPOINT_DRIVE_ID wins; otherwise resolve via site host/path + library name.
async function resolveDrive() {
  if (_drive) return _drive;
  if (cfg.sharepointDriveId) {
    const d = await graph(`/drives/${cfg.sharepointDriveId}?$select=id,name`);
    _drive = { driveId: d.id, driveName: d.name };
    return _drive;
  }
  const sitePath = cfg.sharepointSitePath.replace(/^\/+/, '');
  const site = await graph(`/sites/${cfg.sharepointSiteHost}:/${sitePath}`);
  const drives = await graph(`/sites/${site.id}/drives`);
  const want = String(cfg.sharepointDriveName || 'Documents').toLowerCase();
  const drive = (drives.value || []).find((d) => (d.name || '').toLowerCase() === want) || (drives.value || [])[0];
  if (!drive) throw new Error(`No document library found on ${cfg.sharepointSiteHost}${cfg.sharepointSitePath}`);
  _drive = { siteId: site.id, driveId: drive.id, driveName: drive.name };
  return _drive;
}

// Sanitize one path segment: strip only characters SharePoint actually rejects
// (plus # and % which break path addressing), preserve everything else people
// use in real folder names (commas, hyphens, apostrophes, &, periods).
function seg(s) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|#%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/g, '')
    .slice(0, 180)
    .trim();
  return cleaned || '_';
}

// Paginated folder listing (names/ids only — used for matching, never for
// pulling document content into the portal).
async function listChildren(driveId, itemId) {
  let url = `/drives/${driveId}/items/${itemId}/children?$select=id,name,folder,webUrl&$top=200`;
  const out = [];
  while (url) {
    const j = await graph(url);
    for (const v of j.value || []) out.push({ id: v.id, name: v.name, isFolder: !!v.folder, webUrl: v.webUrl });
    url = j['@odata.nextLink'] ? j['@odata.nextLink'].replace(GRAPH, '') : null;
  }
  return out;
}

// Get an item by path relative to the drive root (e.g. "Pipeline Drive").
async function itemByPath(driveId, relPath) {
  const enc = relPath.split('/').map(encodeURIComponent).join('/');
  return graph(`/drives/${driveId}/root:/${enc}`);
}

const ITEM_META_SELECT = '$select=id,name,size,file,parentReference,webUrl,eTag,createdDateTime,createdBy,lastModifiedDateTime,malware';

// Office formats are REWRITTEN by SharePoint seconds after upload ("property
// promotion" stamps document properties into the file — size AND hash drift).
// Root cause of the 2026-07-16 stuck-xlsx queue: any post-upload byte
// comparison (adopt-by-size, verify-by-size/hash) is MEANINGLESS for these
// formats. Their transit integrity is proven once, at upload time, from the
// PUT response (pre-promotion); after that, identity comes from PROVENANCE
// (createdBy our app + exact name + our folder), never from bytes.
function isOfficeFormat(name) {
  return /\.(xlsx|xls|docx|doc|pptx|ppt|xlsm|docm|pptm)$/i.test(String(name || ''));
}
function createdByThisApp(item) {
  const app = item && item.createdBy && item.createdBy.application;
  return !!(app && app.id && String(app.id) === String(cfg.msClientId));
}

// Item METADATA reads (size + Graph's own content hashes) — used by the
// integrity audit. Reading metadata is a folder-listing-class operation and
// stays within the one-way policy: document BYTES are never downloaded.
async function itemMeta(driveId, itemId) {
  return graph(`/drives/${driveId}/items/${itemId}?${ITEM_META_SELECT}`);
}
async function itemMetaByName(driveId, parentId, name) {
  return graph(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}?${ITEM_META_SELECT}`);
}

/**
 * Microsoft QuickXorHash — the content hash SharePoint document libraries
 * report on every driveItem (item.file.hashes.quickXorHash). Computing it
 * locally lets the mirror VERIFY every upload (and audit old mirrors) without
 * ever downloading bytes back. 160-bit circular shift-XOR, 11 bits per byte,
 * with the length XORed into the last 8 bytes; base64 of the 20-byte state.
 * The reconciler self-calibrates against Graph's reported hash on a fresh
 * upload before trusting mismatch verdicts (belt and suspenders against any
 * implementation drift) — size comparison is always authoritative regardless.
 */
function quickXorHash(buf) {
  const cells = new Uint8Array(20);
  let bitPos = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] << (bitPos & 7);              // ≤ 15 bits
    const b0 = bitPos >> 3;
    cells[b0] ^= v & 0xFF;
    cells[(b0 + 1) % 20] ^= (v >> 8) & 0xFF;       // spill wraps 160→0
    bitPos += 11;
    if (bitPos >= 160) bitPos -= 160;
  }
  let len = buf.length;                            // 64-bit LE into bytes 12…19
  for (let i = 0; i < 8 && len > 0; i++) { cells[12 + i] ^= len & 0xFF; len = Math.floor(len / 256); }
  return Buffer.from(cells).toString('base64');
}

// Create-if-missing child folder. conflictBehavior 'fail' + 409 => fetch the
// existing one (NEVER replaces or renames anything).
async function ensureChildFolder(driveId, parentId, name) {
  const clean = seg(name);
  try {
    const created = await graph(`/drives/${driveId}/items/${parentId}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clean, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
    return { id: created.id, name: created.name, webUrl: created.webUrl, created: true };
  } catch (e) {
    if (e.status === 409 || e.graphCode === 'nameAlreadyExists') {
      const existing = await graph(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(clean)}`);
      return { id: existing.id, name: existing.name, webUrl: existing.webUrl, created: false };
    }
    throw e;
  }
}

/**
 * Upload bytes as a NEW item under parentId. Never overwrites: conflictBehavior
 * 'fail'; on a name conflict returns { conflict: true } so the caller retries
 * with a uniquified name.
 */
async function uploadNew(driveId, parentId, filename, buf, contentType) {
  const name = seg(filename);
  // A committed driveItem whose size differs from what we sent is a TRANSIT-
  // CORRUPTED mirror copy — fail loudly so the caller retries (and never
  // records the bad item as this document's mirror).
  const verifySize = (item) => {
    // STRICT: an upload result we cannot size-verify is treated as failed —
    // never record an unverifiable item as a document's mirror. (Covers the
    // 202-final-chunk + resolve-by-name fallback picking up a placeholder.)
    if (!item || item.id == null || item.size == null) {
      const err = new Error(`upload result for "${name}" is missing id/size — cannot verify integrity; treating as failed`);
      err.transitCorruption = true;
      throw err;
    }
    if (Number(item.size) !== buf.length) {
      // Office formats: SharePoint's property promotion can rewrite the file
      // between the PUT and the response materializing — a size drift there is
      // promotion, not corruption (2026-07-16 root fix). Warn-only for them.
      if (isOfficeFormat(name)) {
        console.warn(`[sharepoint] office upload "${name}" size drifted in response (${buf.length} sent, ${item.size} stored) — property promotion, accepted`);
        return item;
      }
      const err = new Error(
        `upload integrity check failed for "${name}": SharePoint stored ${item.size} bytes, ${buf.length} were sent`);
      err.transitCorruption = true;
      throw err;
    }
    return item;
  };
  try {
    if (buf.length <= SIMPLE_UPLOAD_MAX) {
      const item = await graph(
        `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        { method: 'PUT', headers: { 'Content-Type': contentType || 'application/octet-stream' }, body: buf, timeout: 120000 },
      );
      return { item: verifySize(item) };
    }
    const session = await graph(
      `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/createUploadSession`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail', name } }),
      },
    );
    let start = 0, last = null, throttled = 0;
    while (start < buf.length) {
      const end = Math.min(start + CHUNK, buf.length);
      const chunk = buf.subarray(start, end);
      const r = await fetchWithTimeout(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end - 1}/${buf.length}` },
        body: chunk,
      }, 180000);
      if (r.status === 429 || r.status === 503) {
        if (++throttled > 8) throw new Error('SharePoint upload session throttled persistently — giving up (will retry later)');
        // Retry-After may be seconds OR an HTTP-date; a date parses to NaN and
        // NaN must never reach sleep() (it becomes a zero-delay hot loop).
        const raRaw = parseInt(r.headers.get('retry-after') || '', 10);
        const ra = Number.isFinite(raRaw) && raRaw > 0 ? raRaw : 5;
        await sleep(Math.min(Math.max(ra, 1) * 1000, 120000));
        continue; // retry the same range
      }
      if (r.status === 416) {
        // "Range already received" — the server has these bytes (a retried
        // chunk that actually landed). Ask the SESSION where to resume instead
        // of failing the whole upload.
        const st = await fetchWithTimeout(session.uploadUrl, { method: 'GET' }, 30000);
        const j = await st.json().catch(() => null);
        const next = j && Array.isArray(j.nextExpectedRanges) && j.nextExpectedRanges[0];
        if (!next) { start = end; continue; }           // no ranges left — finalize below
        const resumeAt = parseInt(String(next).split('-')[0], 10);
        if (!Number.isFinite(resumeAt) || resumeAt <= start) {
          throw new Error(`SharePoint upload session out of sync (expects ${next}, at ${start})`);
        }
        start = resumeAt;
        continue;
      }
      if (![200, 201, 202].includes(r.status)) {
        const t = await r.text().catch(() => '');
        throw new Error(`SharePoint chunk upload ${r.status}: ${t.slice(0, 160)}`);
      }
      if (r.status === 200 || r.status === 201) last = await r.json().catch(() => null);
      start = end;
    }
    const item = (last && last.id) ? last : await graph(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`);
    return { item: verifySize(item) };
  } catch (e) {
    if (e.status === 409 || e.graphCode === 'nameAlreadyExists') return { conflict: true };
    throw e;
  }
}

/**
 * THE ONE LEGAL MOVE (owner-directed): relocate a mirror copy the portal itself
 * uploaded into a Version-N folder the portal itself created, inside the same
 * `YS portal syncing` condition folder. Refuses unless the item's CURRENT
 * parent matches `expectedParentId` — so a human-placed or human-moved file can
 * never be touched even if our bookkeeping is stale. The caller MUST have
 * verified the item id against documents.sharepoint_backup_ref (DB ownership).
 * The name is never changed. Nothing is ever deleted.
 */
async function moveOwnItem(driveId, itemId, newParentId, { expectedParentId }) {
  if (!expectedParentId) throw new Error('moveOwnItem: expectedParentId is required');
  const cur = await graph(`/drives/${driveId}/items/${itemId}?$select=id,name,parentReference,eTag`);
  if (!cur.parentReference || cur.parentReference.id !== expectedParentId) {
    throw new Error(`moveOwnItem refused: item is not in the expected portal-managed folder (found parent ${cur.parentReference && cur.parentReference.id})`);
  }
  // If-Match pins the item to the state we just verified: if a human moves or
  // edits it between our check and this PATCH, Graph answers 412 and we touch
  // nothing (the caller treats that as human intervention).
  return graph(`/drives/${driveId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cur.eTag ? { 'If-Match': cur.eTag } : {}) },
    body: JSON.stringify({ parentReference: { id: newParentId } }),
  });
}

/**
 * THE ONE SANCTIONED DELETE (owner-directed amendment, 2026-07-16 — narrows
 * the previous absolute no-delete rule): after the integrity audit finds a
 * CORRUPT mirror copy and a verified good "(fixed copy)" replacement has been
 * uploaded, the corrupt original may be deleted — and ONLY then. Every guard
 * below is mandatory; none may be relaxed, and no other code path may issue a
 * Graph DELETE (remove() below stays a throwing no-op for everything else).
 *
 * Layered guards — ALL must pass or nothing is deleted:
 *  G1. Kill switch: SHAREPOINT_DELETE_REPLACED_CORRUPT=0 disables outright.
 *  G2. DB ownership: the caller must pass the itemId parsed from the row's own
 *      documents.sharepoint_backup_ref (we only ever delete OUR mirror copy).
 *  G3. Replacement-first: the caller must pass the REPLACEMENT item's id; its
 *      metadata is re-read live and its size must equal the local bytes —
 *      no verified good copy in place, no delete.
 *  G4. Same bytes we diagnosed: the corrupt item's CURRENT size must equal the
 *      corrupt size recorded at diagnosis (a human replacing/fixing the file
 *      in the meantime makes it undeletable).
 *  G5. Expected parent: the corrupt item must still sit in the exact folder our
 *      bookkeeping recorded (human-moved items are never touched).
 *  G6. Pilot-tree ancestry: walking UP from the item, an ancestor folder must
 *      be a portal-created sync leaf ("Synced by Pilot"/"YS portal syncing")
 *      within 8 hops — the delete can never reach outside a Pilot sync tree.
 *  G7. If-Match: the DELETE is pinned to the eTag of the fresh metadata read —
 *      any concurrent human change makes Graph answer 412 and nothing happens.
 * A refusal at any guard throws (the caller treats deletion as best-effort and
 * must never fail the mirror over it).
 */
const SYNC_LEAF_NAMES = new Set(['synced by pilot', 'ys portal syncing']);
function deleteEnabled() {
  return process.env.SHAREPOINT_DELETE_REPLACED_CORRUPT !== '0';
}
async function deleteReplacedCorruptMirror(driveId, corruptItemId, {
  expectedParentId, corruptSize, replacementItemId, localSize,
}) {
  if (!deleteEnabled()) throw new Error('sanctioned delete disabled by SHAREPOINT_DELETE_REPLACED_CORRUPT=0');
  if (!corruptItemId || !expectedParentId || !replacementItemId) {
    throw new Error('sanctioned delete refused: missing itemId/expectedParentId/replacementItemId');
  }
  // G3 — the verified replacement must exist and hold the local bytes.
  const replacement = await itemMeta(driveId, replacementItemId);
  if (!replacement || replacement.size == null || Number(replacement.size) !== Number(localSize)) {
    throw new Error('sanctioned delete refused: replacement copy missing or size-unverified');
  }
  // G4 + G5 — the corrupt item is still the bytes we diagnosed, where we left it.
  const corrupt = await itemMeta(driveId, corruptItemId);
  if (!corrupt || !corrupt.parentReference || corrupt.parentReference.id !== expectedParentId) {
    throw new Error('sanctioned delete refused: item is not in the recorded portal-managed folder');
  }
  if (corruptSize != null && Number(corrupt.size) !== Number(corruptSize)) {
    throw new Error('sanctioned delete refused: item size changed since diagnosis (possible human fix)');
  }
  if (String(corrupt.id) === String(replacementItemId)) {
    throw new Error('sanctioned delete refused: corrupt and replacement are the same item');
  }
  // G6 — ancestry: an ancestor must be a Pilot sync leaf.
  let insidePilotTree = false;
  let cursor = corrupt.parentReference;
  for (let hop = 0; hop < 8 && cursor && cursor.id; hop++) {
    const folder = await graph(`/drives/${driveId}/items/${cursor.id}?$select=id,name,parentReference`);
    const nm = String(folder.name || '').toLowerCase();
    if (SYNC_LEAF_NAMES.has(nm) || [...SYNC_LEAF_NAMES].some((s) => nm.endsWith(`, ${s}`))) {
      insidePilotTree = true;
      break;
    }
    cursor = folder.parentReference;
  }
  if (!insidePilotTree) throw new Error('sanctioned delete refused: item is not inside a Pilot-created sync folder');
  // G7 — pinned delete.
  const r = await graph(`/drives/${driveId}/items/${corruptItemId}`, {
    method: 'DELETE',
    headers: corrupt.eTag ? { 'If-Match': corrupt.eTag } : {},
    raw: true,
  });
  if (r.status !== 204 && r.status !== 200) {
    const t = await r.text().catch(() => '');
    throw new Error(`sanctioned delete not applied (${r.status}): ${t.slice(0, 120)}`);
  }
  return { deleted: true, name: corrupt.name };
}

/**
 * Credential-lifecycle watchdog (research, 2026-07-16): an EXPIRED certificate
 * or client secret kills the whole integration silently — auth just starts
 * failing. Surface the certificate's notAfter (and days remaining) on the
 * admin health probe so expiry is a planned rotation, never an outage.
 * (Client-secret expiry lives in Azure and is not readable from here — the
 * cert is preferred auth and IS readable.)
 */
function credentialHealth() {
  const out = { auth: cfg.msClientCertPem ? 'certificate (secret fallback)' : (cfg.msClientSecret ? 'client secret' : 'none') };
  if (cfg.msClientCertPem) {
    try {
      const certMatch = cfg.msClientCertPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
      const x509 = new crypto.X509Certificate(certMatch ? certMatch[0] : cfg.msClientCertPem);
      const expires = new Date(x509.validTo);
      const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86400000);
      out.certExpires = expires.toISOString().slice(0, 10);
      out.certDaysLeft = daysLeft;
      if (daysLeft <= 30) out.warning = `certificate expires in ${daysLeft} day(s) — rotate MS_CLIENT_CERT_PEM now`;
      if (daysLeft <= 0) out.warning = 'CERTIFICATE EXPIRED — auth is running on the client-secret fallback (if configured)';
    } catch (e) {
      out.certError = `could not parse certificate: ${e.message}`;
    }
  }
  return out;
}

function makeRef(driveId, itemId) { return `sp:${driveId}:${itemId}`; }
function parseRef(ref) {
  const m = /^sp:([^:]+):(.+)$/.exec(String(ref || ''));
  if (!m) throw new Error('invalid sharepoint ref');
  return { driveId: m[1], itemId: m[2] };
}

module.exports = {
  name: 'sharepoint',
  configured,
  resolveDrive,
  listChildren,
  itemByPath,
  itemMeta,
  itemMetaByName,
  quickXorHash,
  isOfficeFormat,
  createdByThisApp,
  ensureChildFolder,
  uploadNew,
  moveOwnItem,
  makeRef,
  parseRef,
  seg,
  graph,
  deleteReplacedCorruptMirror,

  /**
   * GENERAL DELETION REMAINS FORBIDDEN — permanent throwing no-op. The ONE
   * owner-sanctioned exception (2026-07-16) is deleteReplacedCorruptMirror
   * above: a diagnosed-corrupt mirror copy whose verified "(fixed copy)"
   * replacement is already in place, inside a Pilot-created sync folder only,
   * behind seven mandatory guards. Nothing else may ever delete.
   */
  async remove() {
    throw new Error('SharePoint is no-delete by policy (docs/SHAREPOINT-POLICY.md). The single sanctioned exception is deleteReplacedCorruptMirror (corrupt mirror + verified fixed copy, Pilot folders only).');
  },

  async probe() {
    try {
      if (!configured()) return { ok: false, error: 'not configured (MS_* env unset)' };
      const d = await resolveDrive();
      return { ok: true, ...d, pipelineRoot: cfg.sharepointPipelineRoot, credential: credentialHealth() };
    } catch (e) {
      return { ok: false, error: e.message, credential: credentialHealth() };
    }
  },
};
