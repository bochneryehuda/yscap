'use strict';
/**
 * The pure parts of the vault + manifest + restore path: object naming, the S3 XML we parse by
 * hand, the manifest audit, the restore-drill inventory comparison, and the two guards that stand
 * between a restore tool and somebody's production database. No vault, no DB, no network.
 * Run: node scripts/test-backup-vault-pure.js
 */
const vault = require('../src/lib/backup/vault');
const manifest = require('../src/lib/backup/manifest');
const inventory = require('../src/lib/backup/inventory');
const documents = require('../src/lib/backup/documents');
const targets = require('../src/lib/backup/targets');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const V = vault._internals;

// ---- object naming ------------------------------------------------------------------------------
{
  const at = new Date('2026-08-02T19:30:00Z');
  const k = manifest.keysFor('db', at, 'a1b2c3d4');
  ok(k.dump === 'db/2026/08/20260802T193000Z-a1b2c3d4.ysbak', 'the dump key is date-sorted and self-describing');
  ok(k.manifest.endsWith('.manifest.json') && k.inventory.endsWith('.inventory.ysbak'), 'the three objects share one base name');

  const p = manifest.parseKey(k.manifest);
  ok(p && p.id === 'a1b2c3d4', 'the id round-trips out of the key');
  ok(p.at.toISOString() === '2026-08-02T19:30:00.000Z',
    'the TIMESTAMP round-trips — retention ages a backup by when the DATA was taken, never by when the object last moved');
  ok(p.base === 'db/2026/08/20260802T193000Z-a1b2c3d4', 'the base is recoverable, so the sidecars can be deleted with it');
  ok(manifest.parseKey('db/some-random-file.txt') === null, 'a foreign object in the bucket is ignored, not misread');
  ok(manifest.parseKey('') === null && manifest.parseKey(null) === null, 'junk keys are ignored');

  // Keys sort chronologically as plain strings — a listing reads like a calendar.
  const keys = [
    manifest.keysFor('db', new Date('2026-01-05T01:00:00Z'), 'aaaa1111').dump,
    manifest.keysFor('db', new Date('2026-12-05T01:00:00Z'), 'bbbb2222').dump,
    manifest.keysFor('db', new Date('2025-06-05T01:00:00Z'), 'cccc3333').dump,
  ];
  ok(JSON.stringify([...keys].sort()) === JSON.stringify([keys[2], keys[0], keys[1]]),
    'sorting the keys as text sorts them by date');
}

// ---- the S3 XML we parse without a dependency ------------------------------------------------------
{
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;123</NextContinuationToken>
    <Contents><Key>db/2026/08/a.ysbak</Key><LastModified>2026-08-02T19:30:00.000Z</LastModified>
      <Size>1048576</Size><ETag>&quot;abc123&quot;</ETag></Contents>
    <Contents><Key>docs/x&amp;y.pdf.ysbak</Key><Size>42</Size><ETag>"def"</ETag></Contents>
  </ListBucketResult>`;
  const r = V.parseListXml(xml);
  ok(r.objects.length === 2, 'both objects are read out of a listing');
  ok(r.objects[0].size === 1048576 && r.objects[0].etag === 'abc123', 'size and quote-stripped ETag are read');
  ok(r.objects[1].key === 'docs/x&y.pdf.ysbak', 'an entity-encoded key is decoded (a key really can contain &)');
  ok(r.isTruncated === true && r.nextToken === 'tok&123', 'truncation and the continuation token are read, so a listing is never half-read');
  ok(V.parseListXml('<ListBucketResult></ListBucketResult>').objects.length === 0, 'an empty bucket parses to nothing');
  ok(V.parseListXml('').objects.length === 0, 'garbage parses to nothing rather than throwing');

  const body = V.completeMultipartXml([{ partNumber: 3, etag: '"c"' }, { partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }]);
  ok(/PartNumber>1<.*PartNumber>2<.*PartNumber>3</.test(body), 'parts are completed in ASCENDING order (S3 rejects any other)');
  ok(!body.includes('"'), 'ETag quotes are stripped in the completion body');

  ok(V.xmlErrorMessage('<Error><Code>NoSuchUpload</Code><Message>gone</Message></Error>') === 'NoSuchUpload: gone',
    'an <Error> body is recognised — S3 reports some failures with HTTP 200');
  ok(V.xmlErrorMessage('<CompleteMultipartUploadResult><ETag>x</ETag></CompleteMultipartUploadResult>') === null,
    'a real success body is not mistaken for an error');
}

// ---- vault configuration ---------------------------------------------------------------------------
{
  const c = V.vaultConfigFromEnv('BACKUP_S3', {
    BACKUP_S3_BUCKET: 'yscap-vault', BACKUP_S3_ENDPOINT: 'https://s3.us-east-2.amazonaws.com',
    BACKUP_S3_ACCESS_KEY_ID: 'AKIA…', BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
    BACKUP_S3_REGION: 'us-east-2', BACKUP_S3_PREFIX: '/prod/', BACKUP_S3_OBJECT_LOCK_MODE: 'compliance',
    BACKUP_S3_OBJECT_LOCK_DAYS: '90', BACKUP_S3_PART_MB: '32',
  });
  ok(c.prefix === 'prod', 'a prefix is normalised (no stray slashes)');
  ok(c.objectLockMode === 'COMPLIANCE' && c.objectLockDays === 90, 'object lock is read case-insensitively');
  ok(c.partBytes === 32 * 1024 * 1024, 'the multipart part size is read');
  ok(V.vaultConfigFromEnv('BACKUP_S3', { BACKUP_S3_OBJECT_LOCK_MODE: 'nonsense' }).objectLockMode === null,
    'an unrecognised lock mode is treated as OFF, never as a silent partial setting');
  ok(V.vaultConfigFromEnv('BACKUP_S3', { BACKUP_S3_PART_MB: '1' }).partBytes === V.MIN_PART_BYTES,
    'a part size below S3\'s 5 MB floor is raised to the floor (an upload would be rejected otherwise)');
  ok(vault.vaultsFromEnv({}).length === 0, 'no configuration means no vaults — nothing half-configured');
  ok(vault.vaultsFromEnv({ BACKUP_S3_BUCKET: 'b', BACKUP_S3_ENDPOINT: 'https://e' }).length === 0,
    'a bucket with no credentials is NOT treated as configured');
}

// ---- the manifest audit -----------------------------------------------------------------------------
{
  const m = {
    id: 'x', artifact: { key: 'db/x.ysbak', cipherBytes: 5000, plainSha256: 'a', cipherSha256: 'b' },
    totals: { tables: 214, rows: 100 },
  };
  ok(manifest.auditManifest(m, { bytes: 5000 }).length === 0, 'a sound backup audits clean');
  ok(/size mismatch/.test(manifest.auditManifest(m, { bytes: 4000 })[0]), 'a size mismatch is caught');
  ok(/not in the vault/.test(manifest.auditManifest(m, null)[0]), 'a missing object is caught');
  ok(manifest.auditManifest(null, { bytes: 1 }).length === 1, 'a missing manifest is caught');
  const tiny = { ...m, artifact: { ...m.artifact, cipherBytes: 12 } };
  ok(manifest.auditManifest(tiny, { bytes: 12 }).some((p) => /too small/.test(p)), 'a suspiciously tiny "backup" is caught');
  const empty = { ...m, totals: { tables: 0, rows: 0 } };
  ok(manifest.auditManifest(empty, { bytes: 5000 }).some((p) => /zero tables/.test(p)),
    'a backup recording zero tables is caught — it probably ran against the wrong database');
  ok(manifest.parseManifest('{ not json') === null && manifest.parseManifest('{}') === null,
    'an unreadable manifest returns null instead of crashing the restore tool');
}

// ---- the restore drill's comparison -------------------------------------------------------------------
{
  const orig = {
    tables: [
      { schema: 'public', name: 'applications', rows: 1200, exact: true },
      { schema: 'public', name: 'documents', rows: 88000, exact: true },
      { schema: 'public', name: 'audit_log', rows: 5000000, exact: false },
    ],
    sequences: [{ schema: 'public', name: 'backup_runs_id_seq' }],
    objects: { views: 3, indexes: 400, functions: 20, triggers: 12, constraints: 900 },
    totals: { tables: 3, rows: 5089200 },
  };
  const same = JSON.parse(JSON.stringify(orig));
  ok(inventory.compareInventories(orig, same).ok, 'an identical restore passes');

  const short = JSON.parse(JSON.stringify(orig));
  short.tables[1].rows = 87999;
  const r1 = inventory.compareInventories(orig, short);
  ok(!r1.ok && r1.rowMismatches[0].table === 'public.documents',
    'ONE missing row out of 88,000 fails the drill — exact counts are compared exactly');

  const dropped = JSON.parse(JSON.stringify(orig));
  dropped.tables.splice(0, 1);
  const r2 = inventory.compareInventories(orig, dropped);
  ok(!r2.ok && r2.missingTables[0] === 'public.applications', 'a table that did not come back fails the drill');

  const wobble = JSON.parse(JSON.stringify(orig));
  wobble.tables[2].rows = 5100000;                      // an ESTIMATE moved 2%
  ok(inventory.compareInventories(orig, wobble).ok, 'an estimated row count is compared with tolerance, not to the row');
  wobble.tables[2].rows = 2000000;                      // …but not by 60%
  ok(!inventory.compareInventories(orig, wobble).ok, '…and a big estimate swing still fails');

  const noSeq = JSON.parse(JSON.stringify(orig)); noSeq.sequences = [];
  ok(!inventory.compareInventories(orig, noSeq).ok, 'a missing sequence fails (ids would restart and collide)');

  const noTrig = JSON.parse(JSON.stringify(orig)); noTrig.objects.triggers = 11;
  ok(!inventory.compareInventories(orig, noTrig).ok, 'a missing trigger fails — data-shaping objects are part of the restore');
  const more = JSON.parse(JSON.stringify(orig)); more.objects.indexes = 402;
  ok(inventory.compareInventories(orig, more).ok, '…but MORE indexes than expected is not a failure');
}

// ---- new tables take care of themselves ------------------------------------------------------------------
{
  const before = { tables: [{ schema: 'public', name: 'a', rows: 100, exact: true }] };
  const after = {
    tables: [{ schema: 'public', name: 'a', rows: 110, exact: true }, { schema: 'public', name: 'brand_new', rows: 4, exact: true }],
  };
  const d = inventory.diffInventories(before, after);
  ok(d.newTables[0] === 'public.brand_new' && d.droppedTables.length === 0,
    'a table added since the last backup is simply reported as new — it is already in tonight\'s dump');
  const gone = inventory.diffInventories(after, before);
  ok(gone.droppedTables[0] === 'public.brand_new', 'a table that DISAPPEARED is reported — that is the one worth reading');
  const emptied = inventory.diffInventories(
    { tables: [{ schema: 'public', name: 'a', rows: 1000, exact: true }] },
    { tables: [{ schema: 'public', name: 'a', rows: 3, exact: true }] });
  ok(emptied.bigRowDrops[0].table === 'public.a', 'a table that lost most of its rows is reported');
  ok(inventory.diffInventories(null, after).firstRun === true, 'the very first backup has nothing to compare against');
}

// ---- documents: what still needs copying ---------------------------------------------------------------
{
  const src = [
    { key: 'ab/aabb.pdf', size: 100, etag: 'e1' },
    { key: 'cd/ccdd.pdf', size: 200, etag: 'e2' },
    { key: 'ef/eeff.pdf', size: 300, etag: 'e3' },
    { key: 'folder/', size: 0, etag: '' },
    { key: '_probe/x.txt', size: 5, etag: 'p' },
  ];
  const already = new Map([
    ['ab/aabb.pdf', { source_etag: 'e1', source_bytes: 100 }],
    ['cd/ccdd.pdf', { source_etag: 'CHANGED', source_bytes: 200 }],
  ]);
  const plan = documents.planCopy(src, already, 10);
  ok(plan.skipped === 1, 'an object already copied at the same size and ETag is skipped');
  ok(plan.todo.map((t) => t.key).join(',') === 'cd/ccdd.pdf,ef/eeff.pdf',
    'a changed object is re-copied and a new one is copied; folder placeholders and probes are ignored');
  const capped = documents.planCopy(src, new Map(), 2);
  ok(capped.todo.length === 2 && capped.deferred === 1, 'the per-run ceiling defers the rest instead of dropping it');
  ok(documents.sourceKeyFor(documents.vaultKeyFor('ab/aabb.pdf')) === 'ab/aabb.pdf',
    'a document key round-trips, so a restore puts every file back where the database expects it');
}

// ---- the two guards on the restore tools ------------------------------------------------------------------
{
  const live = 'postgres://user:pw@db.frankfurt.render.com:5432/yscap';
  ok(targets.isSameDatabase(live, live), 'the live database is recognised');
  ok(targets.isSameDatabase(live, 'postgres://other:other@db.frankfurt.render.com:5432/yscap'),
    '…even under a different username — a different login is the same data');
  ok(targets.isSameDatabase(live, live + '?sslmode=require'),
    '…and with a query string tacked on');
  ok(!targets.isSameDatabase(live, 'postgres://user:pw@db.frankfurt.render.com:5432/yscap_restore_test'),
    'a different database on the same host is NOT the live one');
  ok(!targets.isSameDatabase(live, 'nonsense'), 'an unparseable target is not claimed to be production');

  ok(targets.looksLikeScratch('postgres://u:p@h:5432/yscap_verify'), 'a "verify" database looks like scratch');
  ok(targets.looksLikeScratch('postgres://u:p@h:5432/backup_drill'), 'so does a "drill" one');
  ok(targets.looksLikeScratch('postgres://u:p@h:5432/scratch_db'), 'and a "scratch" one');
  ok(!targets.looksLikeScratch(live), 'the production database does NOT look like scratch — the drill would refuse to wipe it');
  ok(!targets.looksLikeScratch('postgres://u:p@h:5432/yscap_prod_replica'),
    'nor does a replica — the drill DELETES its target, so anything unclear is refused');
  // Found by an end-to-end run: the drill wiped a database named `yscap_restore_target`, which
  // during a real incident is the freshly RECOVERED data, not scratch.
  ok(!targets.looksLikeScratch('postgres://u:p@h:5432/yscap_restore_target'),
    'a "restore" database is NOT scratch — during an incident that name holds the recovered data');
  ok(!targets.looksLikeScratch('postgres://u:p@h:5432/yscap_test'),
    'nor is a "test" database — a test environment usually holds data somebody cares about');
  ok(!targets.looksLikeScratch('postgres://u:p@h:5432/yscapverify'),
    'the word must stand alone — a fuzzy substring match is how the wrong database gets wiped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
