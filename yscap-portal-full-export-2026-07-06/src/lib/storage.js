/**
 * Document storage. Default 'local' persists files under STORAGE_DIR on the
 * server's own disk. On Render, point STORAGE_DIR at a mounted PERSISTENT DISK
 * (e.g. /var/data/uploads) so uploads survive deploys and restarts — the
 * default container filesystem is ephemeral and is wiped on every deploy.
 *
 * Robustness: if the configured STORAGE_DIR is not writable (e.g. the Render
 * disk isn't mounted yet, or its mount root is root-owned while the app runs as
 * a non-root user — the classic "EACCES: mkdir '/var/data/uploads'"), we FALL
 * BACK to a writable directory so uploads never hard-fail. The fallback is not
 * persistent across deploys; `probe()` reports whether we're on the real disk so
 * /api/health can surface a misconfiguration instead of silently losing files.
 *
 * Interface (identical for future s3/sharepoint providers):
 *   save(buf, {filename})  -> { ref, provider, bytes }
 *   read(ref)              -> Buffer            (small files / whole-file)
 *   stream(ref)            -> { stream, size }  (efficient download)
 *   stat(ref)              -> { size } | null
 *   remove(ref)            -> boolean
 *   probe()               -> { ok, base, configured, persistent, error }
 *
 * `ref` is an opaque, server-generated key (never derived from user input),
 * sharded into sub-directories so a single folder never holds unbounded files.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

// Configured storage root. Relative STORAGE_DIR is resolved against the project
// root (two levels up from src/lib) so behaviour matches the old default.
const CONFIGURED = path.isAbsolute(cfg.storageDir)
  ? path.resolve(cfg.storageDir)
  : path.resolve(__dirname, '..', '..', cfg.storageDir);

// The directory we actually write to. Resolved lazily on first use so a disk
// that mounts slightly after boot is still picked up. Once a writable dir is
// found it is cached for the process lifetime.
let effectiveBase = null;

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.wprobe-' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    console.error(`[storage] "${dir}" not usable: ${e.code || e.message}`);
    return false;
  }
}

// Resolve (and cache) a writable base: the configured dir if possible, else a
// tmp fallback. The fallback keeps the product working even when the persistent
// disk is misconfigured — degraded (non-persistent), never broken.
function resolveBase() {
  if (effectiveBase) return effectiveBase;
  const fallback = path.join(os.tmpdir(), 'yscap-uploads');
  for (const dir of [CONFIGURED, fallback]) {
    if (canWrite(dir)) {
      effectiveBase = dir;
      if (dir !== CONFIGURED)
        console.warn(`[storage] STORAGE_DIR "${CONFIGURED}" is NOT writable — falling back to "${dir}". ` +
          `Uploads work but are NOT persistent across deploys. Fix the disk mount/permissions ` +
          `(the mount root must be writable by the app user).`);
      return effectiveBase;
    }
  }
  // Nothing was writable; return the configured path so the eventual write error
  // is explicit and honest rather than silently pointing elsewhere.
  effectiveBase = CONFIGURED;
  return effectiveBase;
}

// Resolve a ref to an absolute path and REFUSE anything that escapes the base
// (path-traversal defence — even though we generate refs, downloads look them
// up from the DB and must never be trusted to stay in-bounds).
function safePath(ref) {
  if (!ref || typeof ref !== 'string') throw new Error('invalid storage ref');
  const base = resolveBase();
  const p = path.resolve(base, ref);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('invalid storage ref');
  return p;
}

const local = {
  name: 'local',
  get base() { return resolveBase(); },
  async save(buf, { filename } = {}) {
    // Keep only a short, sanitized extension from the original name; the rest of
    // the ref is random. The human filename lives in the DB, not the path.
    const ext = (path.extname(filename || '').match(/\.[A-Za-z0-9]{1,12}$/) || [''])[0].toLowerCase();
    const id = crypto.randomBytes(16).toString('hex');
    const ref = path.posix.join(id.slice(0, 2), id + ext);   // e.g. "ab/abc…def.pdf"
    const full = safePath(ref);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // Write to a temp file then rename so a crash mid-write can't leave a
    // half-written document that later reads as valid.
    const tmp = full + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, full);
    return { ref, provider: 'local', bytes: buf.length };
  },
  async read(ref) {
    return fs.readFileSync(safePath(ref));
  },
  async stream(ref) {
    const full = safePath(ref);
    const st = fs.statSync(full);                 // throws ENOENT if missing
    return { stream: fs.createReadStream(full), size: st.size };
  },
  stat(ref) {
    try { return { size: fs.statSync(safePath(ref)).size }; }
    catch { return null; }
  },
  async remove(ref) {
    try { fs.unlinkSync(safePath(ref)); return true; }
    catch { return false; }
  },
  // For /api/health: is storage writable, and are we on the intended disk?
  probe() {
    try {
      const base = resolveBase();
      const ok = canWrite(base);
      return { ok, base, configured: CONFIGURED, persistent: ok && base === CONFIGURED };
    } catch (e) {
      return { ok: false, base: null, configured: CONFIGURED, persistent: false, error: e.message };
    }
  },
};

// Stubs — implement when you wire the provider; interface is identical.
const notReady = (n) => ({
  name: n, base: null,
  async save() { throw new Error(n + ' storage not configured'); },
  async read() { throw new Error(n + ' storage not configured'); },
  async stream() { throw new Error(n + ' storage not configured'); },
  stat() { return null; },
  async remove() { return false; },
  probe() { return { ok: false, base: null, configured: CONFIGURED, persistent: false, error: n + ' not configured' }; },
});

module.exports = ({ local, s3: notReady('s3'), sharepoint: notReady('sharepoint') }[cfg.storageProvider] || local);
