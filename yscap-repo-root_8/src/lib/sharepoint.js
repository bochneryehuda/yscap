/**
 * SharePoint (Microsoft Graph) client for the one-way Pipeline Drive mirror.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HARD RULES (docs/SHAREPOINT-POLICY.md, CLAUDE.md — owner-directed):        │
 * │  • NEVER delete or recycle anything, anywhere in SharePoint. remove() is a │
 * │    throwing no-op. There is deliberately NO Graph DELETE in this module.   │
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
async function getToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
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
      const err = new Error(`Graph ${method} ${path.slice(0, 120)} -> ${r.status} ${json?.error?.code || ''}: ${(json?.error?.message || text).slice(0, 200)}`);
      err.status = r.status;
      err.graphCode = json?.error?.code;
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
  try {
    if (buf.length <= SIMPLE_UPLOAD_MAX) {
      const item = await graph(
        `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        { method: 'PUT', headers: { 'Content-Type': contentType || 'application/octet-stream' }, body: buf, timeout: 120000 },
      );
      return { item };
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
        if (++throttled > 20) throw new Error('SharePoint upload session throttled persistently — giving up (will retry later)');
        const ra = parseInt(r.headers.get('retry-after') || '5', 10);
        await sleep(Math.min(ra * 1000, 120000));
        continue; // retry the same range
      }
      if (![200, 201, 202].includes(r.status)) {
        const t = await r.text().catch(() => '');
        throw new Error(`SharePoint chunk upload ${r.status}: ${t.slice(0, 160)}`);
      }
      if (r.status === 200 || r.status === 201) last = await r.json().catch(() => null);
      start = end;
    }
    const item = (last && last.id) ? last : await graph(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`);
    return { item };
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
  ensureChildFolder,
  uploadNew,
  moveOwnItem,
  makeRef,
  parseRef,
  seg,
  graph,

  /** DELETION IS FORBIDDEN — permanent throwing no-op (owner policy). */
  async remove() {
    throw new Error('SharePoint is no-delete by policy (docs/SHAREPOINT-POLICY.md). Deletion is a manual, human-only action in the SharePoint UI.');
  },

  async probe() {
    try {
      if (!configured()) return { ok: false, error: 'not configured (MS_* env unset)' };
      const d = await resolveDrive();
      return { ok: true, ...d, pipelineRoot: cfg.sharepointPipelineRoot };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
