/**
 * Document storage. Default 'local' persists files under STORAGE_DIR on the
 * server's own disk. On Render, point STORAGE_DIR at a mounted PERSISTENT DISK
 * (e.g. /var/data/uploads) so uploads survive deploys and restarts — the
 * default container filesystem is ephemeral and is wiped on every deploy.
 *
 * Interface (identical for future s3/sharepoint providers):
 *   save(buf, {filename})  -> { ref, provider, bytes }
 *   read(ref)              -> Buffer            (small files / whole-file)
 *   stream(ref)            -> { stream, size }  (efficient download)
 *   stat(ref)              -> { size } | null
 *   remove(ref)            -> boolean
 *
 * `ref` is an opaque, server-generated key (never derived from user input),
 * sharded into sub-directories so a single folder never holds unbounded files.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

// Absolute storage root. Relative STORAGE_DIR is resolved against the project
// root (two levels up from src/lib) so behaviour matches the old default.
const BASE = path.isAbsolute(cfg.storageDir)
  ? path.resolve(cfg.storageDir)
  : path.resolve(__dirname, '..', '..', cfg.storageDir);

// Resolve a ref to an absolute path and REFUSE anything that escapes BASE
// (path-traversal defence — even though we generate refs, downloads look them
// up from the DB and must never be trusted to stay in-bounds).
function safePath(ref) {
  if (!ref || typeof ref !== 'string') throw new Error('invalid storage ref');
  const p = path.resolve(BASE, ref);
  if (p !== BASE && !p.startsWith(BASE + path.sep)) throw new Error('invalid storage ref');
  return p;
}

function ensureBase() { fs.mkdirSync(BASE, { recursive: true }); }

const local = {
  name: 'local',
  base: BASE,
  async save(buf, { filename } = {}) {
    ensureBase();
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
};

// Stubs — implement when you wire the provider; interface is identical.
const notReady = (n) => ({
  name: n, base: null,
  async save() { throw new Error(n + ' storage not configured'); },
  async read() { throw new Error(n + ' storage not configured'); },
  async stream() { throw new Error(n + ' storage not configured'); },
  stat() { return null; },
  async remove() { return false; },
});

module.exports = ({ local, s3: notReady('s3'), sharepoint: notReady('sharepoint') }[cfg.storageProvider] || local);
