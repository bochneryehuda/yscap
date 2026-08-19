'use strict';
/**
 * LT — THE RAW LENDER PRICE CAPTURE SINK (owner-directed: "Save all the data that is coming back,
 * compress the data somewhere in the logs").
 *
 * WHY THIS EXISTS, in one sentence: every paid Lender Price call today returns a payload we parse and
 * then THROW AWAY, so every later question about it costs another paid call — and the questions keep
 * coming. Task #80 ("how does Lender Price pick the DSCR band program?") was answered by digging
 * through ad-hoc files somebody happened to have saved by hand; §2.107's attempt to re-measure a run
 * from its stored REPORT was lossy and had to be discarded, because a report keeps conclusions and
 * not evidence. A compressed copy of what the vendor actually sent makes both of those free and
 * repeatable, and it is the thing the mirror pivot needs: run the battery once, then ask it questions
 * offline as many times as you like.
 *
 * ⛔ IT MAY NEVER FAIL, SLOW OR CHANGE A RUN. Every entry point is wrapped and returns rather than
 * throws; a full disk, a bad path, an unwritable directory and a payload too large to serialize are
 * all recorded as a SKIP and nothing else. This module is a bystander to pricing, permanently.
 *
 * ⛔ AND THE EXPENSIVE HALF IS OFF THE EVENT LOOP, which is not a nicety at this size. A Deephaven
 * disqualify tree is 173 MB, and `zlib.gzipSync` on that blocks the whole process for SECONDS — every
 * other request on the box included. So `capture()` does only the cheap decisions inline (is this kind
 * capturable, is there a directory, scrub, serialize, hash) and hands the COMPRESSION and the DISK
 * WRITE to `zlib.gzip` + `fs.promises`, which run on the threadpool. The caller gets a handle back
 * immediately and is never awaited by pricing.
 *
 * ONE synchronous cost is unavoidable and is stated rather than hidden: `JSON.stringify` of a payload
 * that large is a single blocking step. It is the same serialization the caller's own parse already
 * paid for, it cannot be split without a streaming serializer, and it is roughly an order of magnitude
 * cheaper than the gzip it replaced.
 *
 * A SHORT-LIVED PROCESS MUST CALL `flush()`. Moving the write off the loop means a CLI that exits the
 * moment its last scenario returns can exit before the bytes land. `flush()` awaits every in-flight
 * write (bounded, and it never throws), and the paid agreement runner is exactly the caller that has
 * to use it. A long-running server never needs it.
 *
 * ⛔ IT NEVER CAPTURES A CREDENTIAL — the strongest rule here, and it is enforced twice. (1) It is
 * ALLOWLISTED BY KIND: only `price` and `disqualify` payloads are eligible, so the auth/token exchange
 * — the one call whose body carries the password and the client secret — is not merely scrubbed, it is
 * structurally ineligible. (2) A shallow scrub of known credential keys runs anyway, because a vendor
 * that starts echoing a token inside a pricing response would otherwise put it on disk forever. An
 * allowlist alone would be one vendor change away from a leak; a scrub alone would be one forgotten
 * key name away from one.
 *
 * OFF UNLESS A DIRECTORY IS NAMED (`LP_CAPTURE_DIR`), so it is inert in production and in CI and is
 * switched on deliberately — by the paid agreement runner, or by a human. Writing hundreds of
 * megabytes into a live container is not something to start doing by default.
 *
 * CONTENT-ADDRESSED AND DEDUPED. The name is the sha256 of the RAW bytes, so a retry, a re-poll and a
 * re-run of the same scenario all resolve to ONE file — which matters when a single Deephaven
 * disqualify tree is 173 MB. An index line is still written every time (the same bytes seen twice at
 * two moments is itself a fact worth keeping); only the payload is stored once.
 *
 * BUDGETED, OLDEST-FIRST. `LP_CAPTURE_MAX_MB` (default 2048) bounds the directory; over budget, the
 * oldest payloads are removed until it fits. A capture sink that can fill a disk is a capture sink
 * that takes the system down, and this environment's writable space is a fixed per-session allowance.
 *
 * PURE-ish: fs + zlib + crypto, all Node built-ins (no new dependency — the repo's no-native-deps
 * rule). LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const fsp = require('fs').promises;
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzipAsync = promisify(zlib.gzip);

// Writes still on the wire. A Set rather than an array so a completed write is removed in constant
// time and a long-running process cannot accumulate a list of everything it has ever captured.
const INFLIGHT = new Set();
let tmpSeq = 0;
function track(p) { INFLIGHT.add(p); p.then(() => INFLIGHT.delete(p), () => INFLIGHT.delete(p)); return p; }

// Only these payload kinds may ever be written. The token exchange is deliberately absent.
const CAPTURE_KINDS = Object.freeze(['price', 'disqualify']);

// Belt-and-suspenders scrub. These are the key names this integration's credentials travel under;
// a value under any of them is replaced rather than stored, at any depth.
const SECRET_KEYS = Object.freeze([
  'password', 'clientsecret', 'client_secret', 'secret', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'idtoken', 'id_token', 'authorization', 'apikey', 'api_key',
  'sessionid', 'session_id', 'cookie', 'setcookie', 'set_cookie', 'bearer',
]);
const SECRET_SET = new Set(SECRET_KEYS);
const REDACTED = '[redacted]';

function looksSecretKey(k) {
  return SECRET_SET.has(String(k == null ? '' : k).toLowerCase().replace(/[^a-z_]/g, ''));
}

/**
 * Replace every credential-shaped value, at any depth, without mutating the caller's object.
 * Bounded so a pathological structure cannot spin: depth-limited, and cycles are broken by a seen set.
 */
function scrubSecrets(value, depth = 0, seen = new WeakSet()) {
  if (depth > 40 || value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1, seen));
  const out = {};
  for (const k of Object.keys(value)) out[k] = looksSecretKey(k) ? REDACTED : scrubSecrets(value[k], depth + 1, seen);
  return out;
}

function captureDir() {
  const d = process.env.LP_CAPTURE_DIR;
  return (typeof d === 'string' && d.trim()) ? d.trim() : null;
}

function budgetBytes() {
  const mb = Number(process.env.LP_CAPTURE_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 2048 * 1024 * 1024;
}

function ensureDir(dir) {
  fs.mkdirSync(path.join(dir, 'payloads'), { recursive: true });
  return dir;
}

// Everything the index knows about one capture, so "what have we got" is answerable without
// decompressing a single byte.
function indexLine(rec) { return `${JSON.stringify(rec)}\n`; }

/**
 * Store ONE raw vendor payload.
 *   kind      'price' | 'disqualify' — anything else is refused (never a credential-bearing call).
 *   payload   the parsed vendor object (or any JSON-serializable value).
 *   meta      { scenario?, investor?, program?, requestId?, note? } — free-form context, scrubbed too.
 *   opts      { at } — the timestamp to record; the caller supplies it so this stays testable.
 * Returns { ok, skipped?, reason?, sha?, rawBytes?, gzBytes?, file? }. NEVER throws.
 */
function capture(kind, payload, meta = {}, opts = {}) {
  try {
    const dir = captureDir();
    if (!dir) return { ok: false, skipped: true, reason: 'no_capture_dir' };
    if (!CAPTURE_KINDS.includes(kind)) return { ok: false, skipped: true, reason: 'kind_not_capturable' };
    if (payload == null) return { ok: false, skipped: true, reason: 'empty_payload' };

    let json;
    try { json = JSON.stringify(scrubSecrets(payload)); } catch (e) { return { ok: false, skipped: true, reason: 'unserializable' }; }
    if (!json) return { ok: false, skipped: true, reason: 'unserializable' };

    const raw = Buffer.from(json, 'utf8');
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    ensureDir(dir);
    const file = path.join('payloads', `${sha}.json.gz`);
    const full = path.join(dir, file);
    const rec = {
      at: opts.at || new Date().toISOString(),
      kind,
      sha,
      file,
      rawBytes: raw.length,
      gzBytes: null,             // filled in by the write, which knows the compressed size
      meta: scrubSecrets(meta) || {},
    };

    const done = writeCapture(dir, full, raw, rec).catch(() => ({ ok: false, skipped: true, reason: 'write_failed' }));
    track(done);
    return { ok: true, pending: true, sha, file, rawBytes: raw.length, done };
  } catch (e) {
    return { ok: false, skipped: true, reason: `error:${String((e && e.message) || e).slice(0, 120)}` };
  }
}

// Everything after the hash: compress, land the bytes, index. OFF THE EVENT LOOP (zlib.gzip and
// fs.promises both use the threadpool). Never throws — the caller's `.catch` is a belt to this brace.
async function writeCapture(dir, full, raw, rec) {
  try {
    let gzBytes;
    let existing = null;
    try { existing = await fsp.stat(full); } catch (_) { existing = null; }
    if (existing) {
      // The SAME bytes seen again — a retry, a re-poll, a re-run. Stored once; still indexed.
      gzBytes = existing.size;
    } else {
      const gz = await gzipAsync(raw, { level: 9 });
      // Write to a temp name and rename, so a crash mid-write can never leave a truncated payload
      // sitting under a name that CLAIMS to be the sha256 of its contents. The pid AND a counter are
      // in the temp name because two captures of DIFFERENT payloads can be in flight at once in one
      // process, and a shared temp name would let one truncate the other.
      const tmp = `${full}.${process.pid}.${(tmpSeq += 1)}.tmp`;
      await fsp.writeFile(tmp, gz);
      await fsp.rename(tmp, full);
      gzBytes = gz.length;
    }
    rec.gzBytes = gzBytes;
    await fsp.appendFile(path.join(dir, 'index.jsonl'), indexLine(rec));
    enforceBudget(dir);
    return { ok: true, sha: rec.sha, file: rec.file, rawBytes: rec.rawBytes, gzBytes };
  } catch (e) {
    return { ok: false, skipped: true, reason: `error:${String((e && e.message) || e).slice(0, 120)}` };
  }
}

/**
 * Await every in-flight write. A process that exits the moment its last scenario returns — every CLI
 * here — must call this, or the bytes it just paid Lender Price for never land. Bounded by `timeoutMs`
 * so a wedged filesystem cannot hold a run open forever, and it NEVER throws.
 */
async function flush(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
  const pending = [...INFLIGHT];
  if (!pending.length) return { ok: true, waited: 0 };
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); if (timer.unref) timer.unref(); });
  try {
    const outcome = await Promise.race([Promise.allSettled(pending).then(() => 'done'), deadline]);
    return { ok: outcome === 'done', waited: pending.length, timedOut: outcome === 'timeout' };
  } catch (e) {
    return { ok: false, waited: pending.length, reason: String((e && e.message) || e).slice(0, 120) };
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Keep the directory under budget, oldest payload first. NEVER throws, and never removes the index —
 * the index is the record that a payload once existed, which stays true after the bytes are evicted.
 */
function enforceBudget(dir) {
  try {
    const pdir = path.join(dir, 'payloads');
    const names = fs.readdirSync(pdir).filter((n) => n.endsWith('.json.gz'));
    const files = [];
    let total = 0;
    for (const n of names) {
      try { const st = fs.statSync(path.join(pdir, n)); files.push({ n, size: st.size, mtime: st.mtimeMs }); total += st.size; } catch (_) { /* raced */ }
    }
    const cap = budgetBytes();
    if (total <= cap) return { ok: true, evicted: 0, totalBytes: total };
    files.sort((a, b) => a.mtime - b.mtime);
    let evicted = 0;
    for (const f of files) {
      if (total <= cap) break;
      try { fs.unlinkSync(path.join(pdir, f.n)); total -= f.size; evicted += 1; } catch (_) { /* raced */ }
    }
    return { ok: true, evicted, totalBytes: total };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}

/**
 * What is in the capture directory — answered from the INDEX, so it costs nothing to ask and never
 * decompresses a payload. Rows whose bytes have since been evicted are reported as `present:false`
 * rather than dropped: "we captured this and it has aged out" is a different fact from "we never had
 * it", and a caller hunting for evidence needs to tell them apart. NEVER throws.
 */
function readIndex(dir) {
  try {
    const d = dir || captureDir();
    if (!d) return { ok: false, reason: 'no_capture_dir', rows: [] };
    const p = path.join(d, 'index.jsonl');
    if (!fs.existsSync(p)) return { ok: true, rows: [], totalRawBytes: 0, totalGzBytes: 0 };
    const rows = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec; try { rec = JSON.parse(t); } catch (_) { continue; } // a torn last line is skipped, never fatal
      rec.present = fs.existsSync(path.join(d, rec.file || ''));
      rows.push(rec);
    }
    return {
      ok: true,
      rows,
      totalRawBytes: rows.reduce((n, r) => n + (r.rawBytes || 0), 0),
      totalGzBytes: rows.reduce((n, r) => n + (r.gzBytes || 0), 0),
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 120), rows: [] };
  }
}

// Read one captured payload back. Returns null when it is not there (evicted, never written, corrupt)
// rather than throwing — a caller mining captures must be able to skip a gap.
function readCapture(sha, dir) {
  try {
    const d = dir || captureDir();
    if (!d || !/^[0-9a-f]{64}$/.test(String(sha || ''))) return null;
    const full = path.join(d, 'payloads', `${sha}.json.gz`);
    if (!fs.existsSync(full)) return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(full)).toString('utf8'));
  } catch (_) { return null; }
}

module.exports = {
  capture, flush, readIndex, readCapture, enforceBudget,
  captureDir, budgetBytes, scrubSecrets, looksSecretKey,
  CAPTURE_KINDS, SECRET_KEYS, REDACTED,
};
