'use strict';
/**
 * The backup VAULT — an S3-compatible object store used only for backups.
 *
 * Deliberately its OWN client, separate from src/lib/storage-s3.js (the documents bucket), because
 * the two must not share a credential, a bucket or a blast radius:
 *   · the documents bucket is written by the live app on every upload — a compromised app
 *     credential reaches it. The vault credential lives ONLY in the backup job.
 *   · the vault is where the copy of last resort lives, so its keys are arbitrary paths we choose
 *     (`db/2026/08/…`), not the opaque sharded document refs storage-s3 generates.
 *   · the vault needs LIST, MULTIPART and OBJECT LOCK; the documents client needs none of those.
 * The SigV4 signer itself IS shared (storage-s3._internals.signV4) — one implementation of the
 * signature, so the two can never drift.
 *
 * NO NEW DEPENDENCIES: Node's https/crypto only.
 *
 * WORKS WITH: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces — anything speaking
 * S3. Object Lock headers are sent only when a retention window is configured, and a store that
 * ignores them still accepts the write (the backup is stored; only the immutability is missing,
 * and `probe()` reports that so it is never a silent downgrade).
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { PassThrough } = require('stream');
const { signV4 } = require('../storage-s3')._internals;

const SERVICE = 's3';
const MIN_PART_BYTES = 5 * 1024 * 1024;          // S3's hard floor for every part but the last

function sha256hex(d) { return crypto.createHash('sha256').update(d).digest('hex'); }
function amzDates(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// ── tiny XML readers (PURE) ───────────────────────────────────────────────────────────────────
// S3 answers LIST and MULTIPART in XML. These pull out exactly the fields we use — a full XML
// parser would be a new dependency for four tags. Values are entity-decoded because a key may
// legitimately contain '&'.
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function xmlTag(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(String(xml || ''));
  return m ? decodeEntities(m[1]) : null;
}
/** PURE — every <Contents> entry of a ListObjectsV2 response. */
function parseListXml(xml) {
  const s = String(xml || '');
  const objects = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(s))) {
    const body = m[1];
    objects.push({
      key: xmlTag(body, 'Key'),
      lastModified: xmlTag(body, 'LastModified'),
      size: parseInt(xmlTag(body, 'Size') || '0', 10),
      etag: (xmlTag(body, 'ETag') || '').replace(/^"|"$/g, ''),
    });
  }
  return {
    objects,
    isTruncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(s),
    nextToken: xmlTag(s, 'NextContinuationToken'),
  };
}
/** PURE — the body that completes a multipart upload. Parts MUST be in ascending part order. */
function completeMultipartXml(parts) {
  const rows = parts
    .slice()
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag.replace(/^"|"$/g, '')}</ETag></Part>`)
    .join('');
  return `<CompleteMultipartUpload>${rows}</CompleteMultipartUpload>`;
}
/** PURE — S3 reports some failures with HTTP 200 and an <Error> in the body (notably
 *  CompleteMultipartUpload). Treating that as success is the classic way to "store" a broken
 *  object, so every 200 whose body carries an Error is failed explicitly. */
function xmlErrorMessage(body) {
  const s = String(body || '');
  if (!/<Error>/.test(s)) return null;
  return `${xmlTag(s, 'Code') || 'Error'}: ${xmlTag(s, 'Message') || 'no message'}`;
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────
/**
 * PURE — read one vault's settings out of env under a prefix (`BACKUP_S3`, `BACKUP_S3_SECONDARY`).
 * A vault is "configured" only when bucket + endpoint + both credentials are present; anything
 * less is treated as not-set-up rather than half-working.
 */
function vaultConfigFromEnv(prefix, env = process.env) {
  const g = (n) => (env[`${prefix}_${n}`] || '').trim();
  const region = g('REGION') || 'auto';
  const lockMode = (g('OBJECT_LOCK_MODE') || '').toUpperCase();
  const lockDays = parseInt(g('OBJECT_LOCK_DAYS') || '0', 10);
  return {
    label: prefix,
    bucket: g('BUCKET'),
    endpoint: g('ENDPOINT'),
    accessKeyId: g('ACCESS_KEY_ID'),
    secretAccessKey: g('SECRET_ACCESS_KEY'),
    region,
    prefix: g('PREFIX').replace(/^\/+|\/+$/g, ''),
    // Path-style (<endpoint>/<bucket>/<key>) is what R2 and most S3 clones want and AWS still
    // accepts for signed requests; virtual-hosted is opt-in.
    forcePathStyle: env[`${prefix}_FORCE_PATH_STYLE`] == null
      ? true : /^(1|true|yes)$/i.test(String(env[`${prefix}_FORCE_PATH_STYLE`]).trim()),
    objectLockMode: lockMode === 'COMPLIANCE' || lockMode === 'GOVERNANCE' ? lockMode : null,
    objectLockDays: Number.isFinite(lockDays) && lockDays > 0 ? lockDays : 0,
    storageClass: g('STORAGE_CLASS') || '',
    partBytes: Math.max(MIN_PART_BYTES, (parseInt(g('PART_MB') || '32', 10) || 32) * 1024 * 1024),
  };
}

// ── the client ────────────────────────────────────────────────────────────────────────────────
function createVault(cfg) {
  const configured = () => !!(cfg.bucket && cfg.endpoint && cfg.accessKeyId && cfg.secretAccessKey);

  /** Absolute key = configured prefix + the caller's path. */
  function fullKey(key) {
    const k = String(key || '');
    if (!k || k.startsWith('/') || k.includes('..') || k.includes('\0')) throw new Error(`invalid vault key: ${JSON.stringify(key)}`);
    return cfg.prefix ? `${cfg.prefix}/${k}` : k;
  }
  /** Strip the prefix back off, so callers only ever see their own namespace. */
  function shortKey(key) {
    if (!cfg.prefix) return key;
    return String(key).startsWith(cfg.prefix + '/') ? String(key).slice(cfg.prefix.length + 1) : key;
  }

  function locate(key) {
    const ep = new URL(cfg.endpoint);
    if (cfg.forcePathStyle) {
      return { protocol: ep.protocol, host: ep.host, hostname: ep.hostname, port: ep.port, path: `/${cfg.bucket}${key ? '/' + key : ''}` };
    }
    return {
      protocol: ep.protocol, host: `${cfg.bucket}.${ep.host}`, hostname: `${cfg.bucket}.${ep.hostname}`,
      port: ep.port, path: `/${key || ''}`,
    };
  }

  /**
   * ONE signed request. `body` is a Buffer (signed payload) or null. `stream:true` resolves with the
   * live response stream instead of buffering — used for downloads, which can be gigabytes.
   */
  function request(method, key, { query = {}, body = null, headers: extra = {}, stream = false, timeoutMs = 900000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!configured()) { reject(new Error(`${cfg.label}: vault is not configured`)); return; }
      const loc = locate(key);
      const { amzDate, dateStamp } = amzDates(new Date());
      const payload = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
      const payloadHash = sha256hex(payload);

      const headers = Object.assign({
        host: loc.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
      }, extra);
      if (method === 'PUT' || method === 'POST') headers['content-length'] = String(payload.length);

      const { authorization } = signV4({
        method, path: loc.path, query, headers, payloadHash,
        service: SERVICE, region: cfg.region || 'auto',
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
        dateStamp, amzDate,
      });
      headers.Authorization = authorization;

      // The query must be on the wire in the SAME encoding it was signed in.
      const qs = Object.keys(query).sort().map((k) => {
        const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        return `${enc(k)}=${enc(query[k] == null ? '' : String(query[k]))}`;
      }).join('&');
      const path = qs ? `${loc.path}?${qs}` : loc.path;

      const transport = loc.protocol === 'http:' ? http : https;
      const req = transport.request({ method, host: loc.hostname, port: loc.port || undefined, path, headers }, (res) => {
        if (stream) { resolve({ statusCode: res.statusCode, headers: res.headers, stream: res }); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${cfg.label}: request timed out after ${Math.round(timeoutMs / 1000)}s`)));
      if (payload.length) req.write(payload);
      req.end();
    });
  }

  /** Retry the transient failures (network resets, 5xx, 429) — never the permanent ones (403/404),
   *  which only waste the maintenance window and hide the real cause. */
  async function withRetry(label, fn, { attempts = 4 } = {}) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fn();
        if (res && res.statusCode && res.statusCode >= 500) throw new Error(`HTTP ${res.statusCode}: ${String(res.body || '').slice(0, 300)}`);
        if (res && res.statusCode === 429) throw new Error('HTTP 429 (rate limited)');
        return res;
      } catch (e) {
        lastErr = e;
        if (i === attempts) break;
        const waitMs = 1000 * Math.pow(2, i - 1);           // 1s, 2s, 4s
        console.warn(`[backup] ${cfg.label}: ${label} attempt ${i}/${attempts} failed (${e.message}); retrying in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw new Error(`${cfg.label}: ${label} failed after ${attempts} attempts — ${lastErr && lastErr.message}`);
  }

  /** Object Lock + storage-class headers for a write, when the vault is configured for them. */
  function writeHeaders(extra = {}) {
    const h = Object.assign({}, extra);
    if (cfg.objectLockMode && cfg.objectLockDays > 0) {
      h['x-amz-object-lock-mode'] = cfg.objectLockMode;
      h['x-amz-object-lock-retain-until-date'] =
        new Date(Date.now() + cfg.objectLockDays * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    if (cfg.storageClass) h['x-amz-storage-class'] = cfg.storageClass;
    return h;
  }

  const api = {
    label: cfg.label,
    config: cfg,
    configured,
    fullKey,

    /** Small object in one shot. */
    async put(key, buf, { contentType = 'application/octet-stream' } = {}) {
      const k = fullKey(key);
      const res = await withRetry(`PUT ${k}`, () => request('PUT', k, {
        body: buf, headers: writeHeaders({ 'content-type': contentType }),
      }));
      if (res.statusCode >= 300) throw new Error(`${cfg.label}: PUT ${k} → HTTP ${res.statusCode}: ${String(res.body).slice(0, 300)}`);
      return { key: k, bytes: buf.length, etag: (res.headers.etag || '').replace(/^"|"$/g, '') };
    },

    /**
     * Large object, streamed as a multipart upload. Bytes are accumulated into `partBytes` buffers
     * and each part is sent as it fills, so peak memory is one part — not the whole dump. A failure
     * anywhere ABORTS the upload, which matters: an abandoned multipart upload is invisible in a
     * listing but still billed, and worse, it looks like "no backup was written" while the storage
     * bill says otherwise.
     */
    async putStream(key, readable, { contentType = 'application/octet-stream', onProgress = null } = {}) {
      const k = fullKey(key);
      const partSize = cfg.partBytes;

      const create = await withRetry(`CreateMultipartUpload ${k}`, () => request('POST', k, {
        query: { uploads: '' }, body: Buffer.alloc(0), headers: writeHeaders({ 'content-type': contentType }),
      }));
      if (create.statusCode >= 300) throw new Error(`${cfg.label}: start upload ${k} → HTTP ${create.statusCode}: ${String(create.body).slice(0, 300)}`);
      const uploadId = xmlTag(create.body.toString('utf8'), 'UploadId');
      if (!uploadId) throw new Error(`${cfg.label}: start upload ${k} → no UploadId in the response`);

      const parts = [];
      let total = 0;
      const sendPart = async (buf, partNumber) => {
        const res = await withRetry(`UploadPart ${partNumber} of ${k}`, () => request('PUT', k, {
          query: { partNumber: String(partNumber), uploadId }, body: buf,
        }));
        if (res.statusCode >= 300) throw new Error(`${cfg.label}: part ${partNumber} → HTTP ${res.statusCode}: ${String(res.body).slice(0, 300)}`);
        const etag = (res.headers.etag || '').replace(/^"|"$/g, '');
        if (!etag) throw new Error(`${cfg.label}: part ${partNumber} came back with no ETag`);
        parts.push({ partNumber, etag });
        total += buf.length;
        if (onProgress) onProgress({ parts: parts.length, bytes: total });
      };

      try {
        let pending = [];
        let pendingLen = 0;
        let partNumber = 0;
        for await (const chunk of readable) {
          pending.push(chunk);
          pendingLen += chunk.length;
          while (pendingLen >= partSize) {
            const joined = Buffer.concat(pending, pendingLen);
            await sendPart(joined.subarray(0, partSize), ++partNumber);
            const rest = joined.subarray(partSize);
            pending = rest.length ? [Buffer.from(rest)] : [];
            pendingLen = rest.length;
          }
        }
        // The final part is the only one allowed below the 5 MB floor — including when it is the
        // ONLY part (a small dump), which is why an empty tail still gets sent for a zero-part
        // upload: a multipart upload with no parts cannot be completed.
        if (pendingLen > 0 || partNumber === 0) {
          await sendPart(Buffer.concat(pending, pendingLen), ++partNumber);
        }

        const body = Buffer.from(completeMultipartXml(parts), 'utf8');
        const done = await withRetry(`CompleteMultipartUpload ${k}`, () => request('POST', k, {
          query: { uploadId }, body, headers: { 'content-type': 'application/xml' },
        }));
        const text = done.body.toString('utf8');
        if (done.statusCode >= 300) throw new Error(`${cfg.label}: complete ${k} → HTTP ${done.statusCode}: ${text.slice(0, 300)}`);
        const errMsg = xmlErrorMessage(text);
        if (errMsg) throw new Error(`${cfg.label}: complete ${k} → ${errMsg}`);
        return { key: k, bytes: total, parts: parts.length };
      } catch (e) {
        try {
          await request('DELETE', k, { query: { uploadId } });
          console.warn(`[backup] ${cfg.label}: aborted the incomplete upload of ${k} (no half-written object is left behind)`);
        } catch (abortErr) {
          console.error(`[backup] ${cfg.label}: could NOT abort the incomplete upload of ${k} — ${abortErr.message}. ` +
            'Check the bucket for stale multipart uploads (they are billed).');
        }
        throw e;
      }
    },

    /** Buffer an object into memory. Only for small objects (manifests). */
    async get(key) {
      const k = fullKey(key);
      const res = await withRetry(`GET ${k}`, () => request('GET', k));
      if (res.statusCode === 404) return null;
      if (res.statusCode >= 300) throw new Error(`${cfg.label}: GET ${k} → HTTP ${res.statusCode}`);
      return res.body;
    },

    /** Stream an object out — the restore path, where the object may be gigabytes. */
    async getStream(key) {
      const k = fullKey(key);
      const res = await request('GET', k, { stream: true });
      if (res.statusCode >= 300) {
        res.stream.resume();
        throw new Error(`${cfg.label}: GET ${k} → HTTP ${res.statusCode}`);
      }
      return { stream: res.stream, bytes: parseInt(res.headers['content-length'] || '0', 10) };
    },

    /** Size/etag/lock state, or null when the object is not there. */
    async head(key) {
      const k = fullKey(key);
      const res = await withRetry(`HEAD ${k}`, () => request('HEAD', k));
      if (res.statusCode === 404) return null;
      if (res.statusCode >= 300) throw new Error(`${cfg.label}: HEAD ${k} → HTTP ${res.statusCode}`);
      return {
        key: k,
        bytes: parseInt(res.headers['content-length'] || '0', 10),
        etag: (res.headers.etag || '').replace(/^"|"$/g, ''),
        lockMode: res.headers['x-amz-object-lock-mode'] || null,
        lockedUntil: res.headers['x-amz-object-lock-retain-until-date'] || null,
      };
    },

    /** Every object under a prefix, following continuation tokens to the end. */
    async list(prefix = '', { maxPages = 200 } = {}) {
      const full = cfg.prefix ? `${cfg.prefix}/${prefix}` : prefix;
      const out = [];
      let token = null;
      for (let page = 0; page < maxPages; page++) {
        const query = { 'list-type': '2', prefix: full, 'max-keys': '1000' };
        if (token) query['continuation-token'] = token;
        const res = await withRetry(`LIST ${full}`, () => request('GET', '', { query }));
        if (res.statusCode >= 300) throw new Error(`${cfg.label}: LIST ${full} → HTTP ${res.statusCode}: ${String(res.body).slice(0, 300)}`);
        const parsed = parseListXml(res.body.toString('utf8'));
        for (const o of parsed.objects) out.push({ ...o, key: shortKey(o.key) });
        if (!parsed.isTruncated || !parsed.nextToken) return out;
        token = parsed.nextToken;
      }
      // Hitting the page cap means the listing is INCOMPLETE. Say so loudly — a partial listing fed
      // to the retention planner is exactly the input its minimum-keep floor exists to survive.
      throw new Error(`${cfg.label}: listing ${full} did not finish within ${maxPages} pages — refusing to act on a partial listing`);
    },

    async del(key) {
      const k = fullKey(key);
      const res = await request('DELETE', k);
      if (res.statusCode >= 300 && res.statusCode !== 404) {
        throw new Error(`${cfg.label}: DELETE ${k} → HTTP ${res.statusCode}: ${String(res.body).slice(0, 200)}`);
      }
      return true;
    },

    /**
     * Prove the vault works BEFORE the nightly job depends on it: write a probe, read it back, and
     * report whether immutability is really in force. Object Lock cannot be verified by writing a
     * probe under lock (that probe could then never be deleted), so it is read off the bucket's own
     * configuration instead.
     */
    async probe() {
      if (!configured()) return { ok: false, error: 'not configured' };
      const key = `_probe/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
      const payload = Buffer.from(`yscap backup vault probe ${new Date().toISOString()}\n`, 'utf8');
      try {
        // Written WITHOUT the lock headers so the probe can be cleaned up afterwards.
        const k = fullKey(key);
        const put = await request('PUT', k, { body: payload, headers: { 'content-type': 'text/plain' } });
        if (put.statusCode >= 300) throw new Error(`write → HTTP ${put.statusCode}: ${String(put.body).slice(0, 200)}`);
        const back = await api.get(key);
        if (!back || !back.equals(payload)) throw new Error('the probe read back different bytes than were written');
        let lock = null;
        try {
          const res = await request('GET', '', { query: { 'object-lock': '' } });
          if (res.statusCode < 300) {
            const xml = res.body.toString('utf8');
            lock = {
              enabled: /<ObjectLockEnabled>\s*Enabled\s*<\/ObjectLockEnabled>/i.test(xml),
              defaultMode: xmlTag(xml, 'Mode'),
              defaultDays: xmlTag(xml, 'Days'),
              defaultYears: xmlTag(xml, 'Years'),
            };
          }
        } catch (_) { /* a store without the object-lock API is reported as "unknown", not broken */ }
        await api.del(key).catch(() => {});
        return {
          ok: true, bucket: cfg.bucket, endpoint: cfg.endpoint, prefix: cfg.prefix || '(none)',
          objectLockRequested: cfg.objectLockMode ? `${cfg.objectLockMode} ${cfg.objectLockDays}d` : null,
          objectLockOnBucket: lock,
        };
      } catch (e) {
        await api.del(key).catch(() => {});
        return { ok: false, bucket: cfg.bucket, endpoint: cfg.endpoint, error: e.message };
      }
    },
  };

  return api;
}

/** Every configured vault, primary first. Returns [] when nothing is set up. */
function vaultsFromEnv(env = process.env) {
  const out = [];
  for (const prefix of ['BACKUP_S3', 'BACKUP_S3_SECONDARY']) {
    const cfg = vaultConfigFromEnv(prefix, env);
    const v = createVault(cfg);
    if (v.configured()) out.push(v);
  }
  return out;
}

module.exports = {
  createVault,
  vaultConfigFromEnv,
  vaultsFromEnv,
  _internals: { parseListXml, completeMultipartXml, xmlTag, xmlErrorMessage, decodeEntities, vaultConfigFromEnv, MIN_PART_BYTES },
};
