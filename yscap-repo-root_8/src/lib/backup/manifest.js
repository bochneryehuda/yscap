'use strict';
/**
 * Backup naming + the MANIFEST — PURE.
 *
 * Every backup writes three objects, and the split matters:
 *
 *   <base>.ysbak            the encrypted pg_dump. Useless without the key. This is the backup.
 *   <base>.manifest.json    PLAINTEXT operations metadata — when, how big, which checksums, which
 *                           key fingerprint, how many tables/rows. Deliberately readable WITHOUT
 *                           the encryption key: at 2am during a real incident you must be able to
 *                           see what you have and pick the right one before anyone hunts for keys.
 *                           It carries NO table names, NO column names and NO customer data.
 *   <base>.inventory.ysbak  the ENCRYPTED full inventory (every table, every row count). Schema
 *                           detail is not secret exactly, but it is a map of the system, so it
 *                           lives behind the same key as the data.
 *
 * KEY LAYOUT — `db/YYYY/MM/YYYYMMDDTHHMMSSZ-<id>`. Sorted lexicographically that is also
 * chronological, so a listing reads like a calendar and a prefix scopes to a month.
 */
const crypto = require('crypto');

const MANIFEST_SCHEMA_VERSION = 1;

/** PURE — compact UTC stamp, "20260802T193000Z". */
function stamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

/** PURE — a short random id, so two backups started in the same second can never collide. */
function newBackupId(rand = () => crypto.randomBytes(4).toString('hex')) { return rand(); }

/** PURE — every object key for one backup. */
function keysFor(kind, at, id) {
  const y = at.toISOString().slice(0, 4);
  const m = at.toISOString().slice(5, 7);
  const base = `${kind}/${y}/${m}/${stamp(at)}-${id}`;
  return { base, dump: `${base}.ysbak`, manifest: `${base}.manifest.json`, inventory: `${base}.inventory.ysbak` };
}

/**
 * PURE — recover the timestamp and id from a key. Retention plans off THIS, not off the store's
 * LastModified: a re-uploaded or copied object gets a new LastModified, and a backup's age is a
 * property of when the data was taken, not of when the bytes last moved.
 */
function parseKey(key) {
  const m = /(^|\/)(\d{8})T(\d{6})Z-([0-9a-f]{4,})\.(ysbak|manifest\.json|inventory\.ysbak)$/.exec(String(key || ''));
  if (!m) return null;
  const [, , date, time, id, ext] = m;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T` +
              `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  const at = new Date(iso);
  if (isNaN(at)) return null;
  const kind = String(key).split('/')[0];
  return { at, id, ext, kind, base: String(key).replace(/\.(ysbak|manifest\.json|inventory\.ysbak)$/, '') };
}

/** PURE — assemble the plaintext manifest. Anything that could identify a borrower stays out. */
function buildManifest({
  id, at, kind = 'db', keys, inventory, dump, encryption, artifact, vaults, durationMs, app = {},
}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    kind,
    createdAt: at.toISOString(),
    source: {
      database: inventory.server.database,
      postgresVersion: inventory.server.version,
      postgresVersionNum: inventory.server.versionNum,
      postgresMajor: inventory.server.majorVersion,
      databaseSizeBytes: inventory.server.sizeBytes,
      appCommit: app.commit || null,
      appService: app.service || null,
      host: app.host || null,
    },
    dump: {
      tool: dump.tool, toolVersion: dump.toolVersion, format: dump.format, args: dump.args,
    },
    encryption: {
      container: 'ysbak/1',
      algorithm: encryption.algorithm,
      kdf: encryption.kdf,
      keyId: encryption.keyId,          // fingerprint only — never the key
    },
    artifact: {
      key: keys.dump,
      cipherBytes: artifact.cipherBytes,
      plainBytes: artifact.plainBytes,
      cipherSha256: artifact.cipherSha256,
      plainSha256: artifact.plainSha256,
    },
    inventoryKey: keys.inventory,
    // Totals only. The per-table detail lives in the ENCRYPTED inventory sidecar.
    totals: {
      tables: inventory.totals.tables,
      rows: inventory.totals.rows,
      estimatedTables: inventory.totals.estimatedTables,
      views: inventory.objects.views,
      indexes: inventory.objects.indexes,
      functions: inventory.objects.functions,
      triggers: inventory.objects.triggers,
      constraints: inventory.objects.constraints,
      sequences: (inventory.sequences || []).length,
    },
    schema: {
      migrationsApplied: inventory.migrations.count,
      latestMigration: inventory.migrations.latest,
    },
    storedIn: (vaults || []).map((v) => ({ label: v.label, bucket: v.bucket, objectLock: v.objectLock || null })),
    durationMs,
    // Filled in later by scripts/backup-verify.js when a real test restore has been done.
    verification: null,
  };
}

/**
 * PURE — read a manifest defensively. A manifest we cannot understand must not make the restore
 * tool crash; it makes it say which backup is unreadable and move on to the next.
 */
function parseManifest(buf) {
  try {
    const m = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
    if (!m || typeof m !== 'object' || !m.id || !m.artifact || !m.artifact.key) return null;
    return m;
  } catch (_) { return null; }
}

/**
 * PURE — the checks that decide whether a stored backup is TRUSTWORTHY, without downloading it.
 * Returns a list of problems (empty means it looks sound). Used by the nightly job right after
 * upload, and by the restore tool before it hands anyone a file.
 */
function auditManifest(manifest, head, { minPlausibleBytes = 1024 } = {}) {
  const problems = [];
  if (!manifest) { problems.push('no manifest'); return problems; }
  if (!head) { problems.push(`the backup object ${manifest.artifact.key} is not in the vault`); return problems; }
  if (head.bytes !== manifest.artifact.cipherBytes) {
    problems.push(`size mismatch: the vault holds ${head.bytes} bytes, the manifest recorded ${manifest.artifact.cipherBytes}`);
  }
  if (manifest.artifact.cipherBytes < minPlausibleBytes) {
    problems.push(`the backup is only ${manifest.artifact.cipherBytes} bytes — too small to be a real dump`);
  }
  if (!manifest.artifact.plainSha256 || !manifest.artifact.cipherSha256) {
    problems.push('the manifest is missing a checksum, so the contents cannot be proven later');
  }
  if (!manifest.totals || !manifest.totals.tables) {
    problems.push('the manifest records zero tables — the dump may have run against an empty database');
  }
  return problems;
}

/**
 * PURE — is the newest backup recent enough to still be protecting us?
 *
 * WHY THIS EXISTS, and why it lives on the DRILL rather than the nightly job: the nightly backup
 * only emails when it FAILS, and a job that never runs never fails, so it never emails. Suspend the
 * cron, break its image, get the schedule wrong, lose the billing — and the system goes completely
 * quiet, which is indistinguishable from "everything is fine".
 *
 * The weekly drill is the one thing that runs on its own and reports either way, and it always
 * restored whatever the NEWEST backup happened to be. A three-week-old backup restores perfectly —
 * it is a valid backup — so the drill would compare it to its own receipt, match to the row, and
 * send "Backup test passed". That is worse than silence: it is active reassurance about data that
 * has stopped being current.
 *
 * So freshness is judged SEPARATELY from restorability, and both are reported. A stale backup that
 * restores cleanly is a passing RESTORE and a failing SCHEDULE, and conflating the two is exactly
 * how a backup system lies to the person relying on it.
 *
 * `maxAgeHours` defaults to 48 — one missed night is a blip worth flagging, but the threshold sits
 * beyond a single late run so a job that merely started late does not cry wolf.
 */
function freshness(createdAt, now = Date.now(), maxAgeHours = 48) {
  const limit = Number(maxAgeHours);
  // An unreadable date is NOT treated as fresh: we cannot show it is recent, and the whole point of
  // this check is that "we could not tell" must never read as "we are protected".
  //
  // The ABSENT case is separated out deliberately, because `new Date(null)` is not an Invalid Date
  // — it is the epoch. So a missing timestamp would have sailed through the isNaN check as a
  // genuine 1970 reading, still stale (safe) but reported to the reader as "20,549 days old".
  // `new Date(undefined)` IS invalid, so the two behave differently for no good reason; both are
  // simply "we do not have a date".
  if (createdAt == null || createdAt === '') {
    return { stale: true, ageHours: null, maxAgeHours: limit, unreadable: true };
  }
  const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (isNaN(at.getTime())) return { stale: true, ageHours: null, maxAgeHours: limit, unreadable: true };
  if (!Number.isFinite(limit) || limit <= 0) return { stale: false, ageHours: null, maxAgeHours: limit, disabled: true };
  const ageHours = (now - at.getTime()) / 3600000;
  return {
    // A clock skew that puts the backup slightly in the future is not staleness.
    stale: ageHours > limit,
    ageHours: Math.round(ageHours * 10) / 10,
    maxAgeHours: limit,
    unreadable: false,
  };
}

/** Plain-language age, for an email read by someone who is not a developer. */
function describeAge(ageHours) {
  if (ageHours == null) return 'of an unknown age';
  if (ageHours < 48) return `${Math.round(ageHours)} hours old`;
  const days = Math.round(ageHours / 24);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

module.exports = {
  MANIFEST_SCHEMA_VERSION, newBackupId, keysFor, parseKey, buildManifest, parseManifest, auditManifest,
  freshness, describeAge,
  _internals: { stamp },
};
