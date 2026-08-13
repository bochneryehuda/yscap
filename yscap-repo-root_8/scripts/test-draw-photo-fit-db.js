'use strict';
/**
 * EVERY PHOTO REACHES THE REPORT (owner-directed 2026-08-13) — real Postgres + real storage.
 *
 * THE REPORT: an investor draw delivery went out with the PILOT draw report missing ("too large to
 * attach to one email"), and inside that report only about fifteen of the inspection's ~100 photos
 * had ever been embedded. Two causes, both guarded here:
 *
 *   1. jsPDF copies JPEG bytes in VERBATIM, so a ~3.5 MB phone photo cost 3.5 MB of the 60 MB embed
 *      budget. Photos are now embedded from a report-sized DISPLAY COPY built once by a paced
 *      background worker, stored BESIDE the untouched original.
 *   2. When the budget ran out, attachPhotoBytes `break`-ed and the remaining photos simply
 *      vanished — the report's "N additional photo(s)" note only ever counted what the BUILDER
 *      skipped, so photos dropped by the LOADER were invisible. They are counted now.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT: the ORIGINAL bytes are never replaced, never deleted,
 * and never depended on being shrinkable. `storage_ref` must still point at the inspector's own
 * photo after every pass, and a photo with no display copy must still appear in the report exactly
 * as it does today.
 *
 * Skips cleanly (exit 0) with no DATABASE_URL, like every other -db suite.
 * Run: node scripts/test-draw-photo-fit-db.js
 */
const assert = require('assert');
const jpegLib = require('jpeg-js');

if (!process.env.DATABASE_URL) {
  console.log('test-draw-photo-fit-db: SKIPPED (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const storage = require('../src/lib/storage');
const media = require('../src/sitewire/media-archive');
const report = require('../src/sitewire/draw-report');
const imageFit = require('../src/lib/image-fit');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); checks += 1; };

function makeJpeg(w, h, quality) {
  const d = Buffer.alloc(w * h * 4);
  let s = 424242;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const base = 90 + 70 * Math.sin(x / 41) + 50 * Math.cos(y / 27);
      const edge = ((x >> 5) + (y >> 5)) % 2 ? 18 : -18;
      const n = (rnd() - 0.5) * 26;
      const v = Math.max(0, Math.min(255, base + edge + n));
      d[i] = v; d[i + 1] = v * 0.92; d[i + 2] = v * 0.8; d[i + 3] = 255;
    }
  }
  return Buffer.from(jpegLib.encode({ data: d, width: w, height: h }, quality).data);
}

(async () => {
  await require('../src/migrate-boot').ensureSchema();

  // ── fixture: a borrower + application to hang the media off ────────────────────
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email)
     VALUES ('Photo','Fit', $1) RETURNING id`, [`photofit+${Date.now()}@example.test`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, status, property_address, loan_amount)
     VALUES ($1,'funded','{"line1":"1 Test St","city":"Brooklyn","state":"NY","zip":"11211"}'::jsonb, 100000)
     RETURNING id`, [bor.id])).rows[0];
  const drawId = Math.floor(Date.now() / 1000) % 2000000000;

  async function addMedia(name, buf, opts = {}) {
    const saved = buf ? await storage.save(buf, { filename: name }) : { provider: 'local', ref: opts.badRef || 'missing/blob' };
    const r = (await db.query(
      `INSERT INTO draw_media (application_id, sitewire_draw_id, sitewire_request_id, kind,
          source_url, source_key, storage_provider, storage_ref, content_type, bytes)
       VALUES ($1,$2,$3,'image',$4,$5,$6,$7,'image/jpeg',$8) RETURNING id, storage_ref`,
      [app.id, drawId, opts.reqId != null ? opts.reqId : 1, `https://example.test/${name}`,
       `key-${name}-${Date.now()}-${Math.random()}`, saved.provider, saved.ref, buf ? buf.length : 0])).rows[0];
    return r;
  }

  // ── A. THE WORKER BUILDS A DISPLAY COPY AND LEAVES THE ORIGINAL ALONE ──────────
  const bigBuf = makeJpeg(2400, 1800, 92);
  const bigRow = await addMedia('big.jpg', bigBuf);
  const smallBuf = makeJpeg(300, 200, 85);
  const smallRow = await addMedia('small.jpg', smallBuf);
  const goneRow = await addMedia('gone.jpg', null, { badRef: 'local/definitely/not/here.jpg' });
  {
    // pauseMs 0 — the production default paces 2s per photo so a pure-JS decode can never hold the
    // event loop; the test does not need the pause and would otherwise take minutes.
    const r = await media.buildDisplayMediaOnce(50, { pauseMs: 0 });
    ok(r.scanned >= 3, 'A1 the worker scanned the seeded photos');
    ok(r.built >= 1, 'A2 …and built at least one display copy');

    const big = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0];
    ok(big.display_ref, 'A3 the oversized photo got a display copy');
    // BOTH renditions come out of the one decode — the email-sized copy is built at the same time,
    // because the decode is the whole cost and doing it twice would double the job.
    ok(big.compact_ref, 'A3a …and an email-sized copy in the same pass');
    ok(big.compact_bytes < big.display_bytes, 'A3b …which is the smaller of the two');
    eq(big.compact_width, imageFit.COMPACT_MAX_SIDE, 'A3c …sized for email');
    ok(big.compact_ref !== big.display_ref, 'A3d …and is genuinely its own blob');
    ok(big.display_bytes < big.bytes, 'A4 …which is smaller than the original');
    eq(big.display_width, imageFit.DISPLAY_MAX_SIDE, 'A5 …sized to the report target on its long side');
    ok(big.display_checked_at, 'A6 …and is stamped so the queue drains');
    eq(big.display_skip_reason, null, 'A7 …with no skip reason');

    /* THE WHOLE POINT: the inspector's own bytes are still there, unchanged. */
    eq(big.storage_ref, bigRow.storage_ref, 'A8 the ORIGINAL storage_ref is untouched');
    eq(big.bytes, bigBuf.length, 'A9 …and the original byte count is unchanged');
    const originalStill = await storage.read(big.storage_ref);
    eq(Buffer.compare(originalStill, bigBuf), 0, 'A10 …and the original bytes read back byte-for-byte');
    // The display copy is a genuinely decodable JPEG, not just a smaller blob.
    const dispBytes = await storage.read(big.display_ref);
    const dec = jpegLib.decode(dispBytes, { useTArray: true });
    eq(dec.width, imageFit.DISPLAY_MAX_SIDE, 'A11 the display copy decodes at the target width');
    ok(dispBytes.length < bigBuf.length / 2, 'A12 …and is dramatically smaller');

    // A photo already small enough is STAMPED (so it drains) but gets no second copy.
    const small = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [smallRow.id])).rows[0];
    eq(small.display_ref, null, 'A13 an already-small photo gets no display copy…');
    ok(small.display_checked_at, 'A14 …but is stamped so it never comes round again');
    eq(small.display_skip_reason, 'already_small', 'A15 …with the reason recorded');

    /* AN UNREADABLE BLOB IS LEFT UNSTAMPED ON PURPOSE. Stamping it would let one storage outage
       mark the whole archive "done" and permanently abandon real photos. A failed read never
       reaches the decode, so retrying it forever is cheap. */
    const gone = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [goneRow.id])).rows[0];
    eq(gone.display_checked_at, null, 'A16 a photo whose bytes cannot be read stays unstamped (retryable)');
    eq(gone.display_ref, null, 'A17 …and gains no display copy');
    ok(r.unreadable >= 1, 'A18 …and the pass reports it rather than hiding it');
  }

  // ── B. THE PASS IS IDEMPOTENT AND SELF-DRAINING ────────────────────────────────
  {
    const before = (await db.query(`SELECT display_ref, display_bytes FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0];
    const r2 = await media.buildDisplayMediaOnce(50, { pauseMs: 0 });
    eq(r2.built, 0, 'B1 a second pass builds nothing — the stamp is the drain');
    const after = (await db.query(`SELECT display_ref, display_bytes FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0];
    eq(after.display_ref, before.display_ref, 'B2 …and does not re-point an existing display copy');
    // `more` must be honest, or the self-rescheduling loop in server.js either spins or stalls.
    eq(r2.more, false, 'B3 the pass reports that the queue is drained');

    /* A PERMANENTLY MISSING BLOB MUST NOT STARVE THE QUEUE. Rows are taken id-ascending, so an old
       unreadable one sits at the head forever; without a retry cap it would crowd out every real
       photo behind it and the loop would re-run every minute for nothing. It is retried a few
       times (a transient outage must not condemn a draw's photos) and then drops out. */
    for (let i = 0; i < 5; i++) await media.buildDisplayMediaOnce(1, { pauseMs: 0 });
    const gone = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [goneRow.id])).rows[0];
    eq(gone.display_skip_reason, 'unreadable:3', 'B4 an unreadable photo is retried a bounded number of times');
    eq(gone.display_checked_at, null, 'B5 …and is NEVER stamped done, so a re-sweep is one UPDATE away');
    const r4 = await media.buildDisplayMediaOnce(1, { pauseMs: 0 });
    eq(r4.scanned, 0, 'B6 …after which it leaves the queue entirely and starves nothing');
    eq(r4.more, false, 'B7 …and the loop backs off instead of spinning every minute');

    /* A batch that is FULL but made no progress must still back off — otherwise a run of
       unreadable rows keeps the worker busy-looping. */
    await db.query(`UPDATE draw_media SET display_skip_reason=NULL WHERE id=$1`, [goneRow.id]);
    const r5 = await media.buildDisplayMediaOnce(1, { pauseMs: 0 });
    eq(r5.scanned, 1, 'B8 (fixture) a cleared row is picked up again — the re-sweep works');
    eq(r5.more, false, 'B9 …but a full batch that achieved nothing does not ask to come back at once');
  }

  // ── C. THE REPORT PREFERS THE DISPLAY COPY, AND FALLS BACK TO THE ORIGINAL ─────
  {
    const big = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0];
    const sections = [{
      number: 1,
      lines: [{
        name: 'Roof',
        photos: [
          { storage_ref: big.storage_ref, display_ref: big.display_ref, caption: 'with a display copy' },
          { storage_ref: (await db.query(`SELECT storage_ref FROM draw_media WHERE id=$1`, [smallRow.id])).rows[0].storage_ref,
            display_ref: null, caption: 'no display copy yet' },
        ],
      }],
      attachments: [],
    }];
    const res = await report.attachPhotoBytes(sections);
    eq(res.photoCount, 2, 'C1 both photos were loaded');
    const loaded = sections[0].lines[0].photos;
    eq(loaded.length, 2, 'C2 …and both reached the builder');
    eq(loaded[0].buf.length, big.display_bytes, 'C3 the photo WITH a display copy is embedded from it');
    ok(loaded[0].buf.length < big.bytes, 'C4 …so it costs a fraction of the embed budget');
    /* THE FALLBACK IS WHAT MAKES THIS SAFE TO SHIP MID-DRAIN: a photo the worker has not reached
       yet must still appear, exactly as it does today. */
    eq(loaded[1].buf.length, smallBuf.length, 'C5 a photo with NO display copy still embeds from the original');

    // A display_ref pointing at a blob that has gone missing must fall back, not lose the photo.
    const broken = [{ number: 1, lines: [{ name: 'Roof', photos: [
      { storage_ref: big.storage_ref, display_ref: 'local/vanished/copy.jpg', caption: 'broken display ref' },
    ] }], attachments: [] }];
    const res2 = await report.attachPhotoBytes(broken);
    eq(res2.photoCount, 1, 'C6 a MISSING display copy falls back to the original…');
    eq(broken[0].lines[0].photos[0].buf.length, bigBuf.length, 'C7 …embedding the full-size photo rather than dropping it');
  }

  // ── C2. THE EMAIL COPY USES THE SMALLEST RENDITION, AND STILL FALLS BACK ──────
  {
    const big = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0];
    const mk = () => ([{ number: 1, lines: [{ name: 'Roof', photos: [
      { storage_ref: big.storage_ref, display_ref: big.display_ref, compact_ref: big.compact_ref, caption: '' },
    ] }], attachments: [] }]);

    const forEmail = mk();
    await report.attachPhotoBytes(forEmail, { rendition: 'compact' });
    eq(forEmail[0].lines[0].photos[0].buf.length, big.compact_bytes,
      'C2.1 the delivery copy embeds the EMAIL-sized rendition');

    const forFile = mk();
    await report.attachPhotoBytes(forFile, { rendition: 'display' });
    eq(forFile[0].lines[0].photos[0].buf.length, big.display_bytes,
      'C2.2 …while the report we keep still embeds the page-sized one');
    // The default must stay 'display' — the copy on the file must never silently become the small one.
    const dflt = mk();
    await report.attachPhotoBytes(dflt);
    eq(dflt[0].lines[0].photos[0].buf.length, big.display_bytes, 'C2.3 …which is also the default');

    /* THE FALLBACK CHAIN IS WHAT MAKES THE EMAIL COPY SAFE TO SHIP AHEAD OF THE WORKER. A draw
       archived minutes ago can be ahead of the paced background pass, and sending a LARGER report
       is a far better failure than sending none. */
    const noCompact = [{ number: 1, lines: [{ name: 'Roof', photos: [
      { storage_ref: big.storage_ref, display_ref: big.display_ref, compact_ref: null, caption: '' },
    ] }], attachments: [] }];
    await report.attachPhotoBytes(noCompact, { rendition: 'compact' });
    eq(noCompact[0].lines[0].photos[0].buf.length, big.display_bytes,
      'C2.4 no email copy yet → falls back to the page-sized one, never drops the photo');

    const neither = [{ number: 1, lines: [{ name: 'Roof', photos: [
      { storage_ref: big.storage_ref, display_ref: null, compact_ref: null, caption: '' },
    ] }], attachments: [] }];
    await report.attachPhotoBytes(neither, { rendition: 'compact' });
    eq(neither[0].lines[0].photos[0].buf.length, bigBuf.length,
      'C2.5 …and with no rendition at all, straight to the untouched original');

    /* THE EMAIL COPY IS DRAMATICALLY SMALLER — the reason it exists. */
    ok(big.compact_bytes * 100 < 12 * 1024 * 1024,
      'C2.6 a 100-photo draw of these photos would be well under 12 MB at email size');
  }

  // ── D. NOTHING IS DROPPED IN SILENCE ──────────────────────────────────────────
  {
    /* Force the loader past its own ceiling and prove the overflow is COUNTED. Before this, those
       photos were removed from the array with nothing anywhere saying they existed. */
    const big = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0];
    const many = [];
    for (let i = 0; i < 405; i++) many.push({ storage_ref: big.storage_ref, display_ref: big.display_ref, caption: '' });
    const sections = [{ number: 1, lines: [{ name: 'Roof', photos: many }], attachments: [] }];
    const res = await report.attachPhotoBytes(sections);
    ok(res.omitted > 0, 'D1 photos past the ceiling are COUNTED, not silently discarded');
    eq(res.photoCount + res.omitted, 405, 'D2 …and every photo is accounted for — loaded plus omitted');

    /* The count has to reach the PAGE, or counting it changes nothing a human sees. jsPDF writes
       text uncompressed, so the note is greppable in the raw PDF bytes. */
    const pdf = report.buildDrawReport({
      app: { loanNo: 'YSCAP-TEST', address: '1 Test St' },
      rollup: { project: { budget: 100, drawn: 0, remaining: 100, pct_complete: 0 }, lines: [], draws: [] },
      sections: [{ number: 1, lines: [{ name: 'Roof', photos: [] }], attachments: [] }],
      scope: 'draw', mode: 'staff', photosOmitted: 37,
    });
    const text = pdf.toString('latin1');
    ok(/37 additional photo/.test(text), 'D3 the report states how many photos it could not carry');

    // …and says nothing when it carried everything.
    const clean = report.buildDrawReport({
      app: { loanNo: 'YSCAP-TEST', address: '1 Test St' },
      rollup: { project: { budget: 100, drawn: 0, remaining: 100, pct_complete: 0 }, lines: [], draws: [] },
      sections: [{ number: 1, lines: [{ name: 'Roof', photos: [] }], attachments: [] }],
      scope: 'draw', mode: 'staff', photosOmitted: 0,
    });
    ok(!/additional photo/.test(clean.toString('latin1')), 'D4 …and stays quiet when nothing was left out');
  }

  // ── D2. db/541's RESET MUST TERMINATE, OR IT BURNS CPU FOREVER ────────────────
  {
    /* db/540 and db/541 ship together, so in production no row can be stamped by a display-only
       worker — but a database that already ran db/540 alone would hold rows stamped done with no
       email copy, and those photos would silently never gain one. db/541 un-stamps exactly those.
       EVERY MIGRATION RE-RUNS ON EVERY BOOT, so the danger is the opposite one: a row the worker
       has answered with "no email copy needed" must NEVER be un-stamped again, or it is re-decoded
       (~3 seconds of blocked event loop) on every single deploy, forever. Run the REAL migration
       file rather than a retyped copy of its SQL. */
    const sql = require('fs').readFileSync(require.resolve('../db/541_draw_media_compact.sql'), 'utf8');

    // (a) the half-built row db/541 exists for
    const half = await addMedia('half.jpg', makeJpeg(1500, 1000, 90));
    await db.query(`UPDATE draw_media SET display_ref='x/y.jpg', display_checked_at=now(),
                      compact_ref=NULL, compact_skip_reason=NULL WHERE id=$1`, [half.id]);
    await db.query(sql);
    eq((await db.query(`SELECT display_checked_at FROM draw_media WHERE id=$1`, [half.id])).rows[0].display_checked_at, null,
      'D2.1 a row left half-built by the display-only worker is put back in the queue');

    // (b) once the worker has ANSWERED it, the migration must leave it alone — for both answers.
    for (const [label, set] of [
      ['built an email copy', `compact_ref='c/d.jpg', compact_skip_reason=NULL`],
      ['decided none was needed', `compact_ref=NULL, compact_skip_reason='already_small'`],
    ]) {
      await db.query(`UPDATE draw_media SET display_checked_at=now(), ${set} WHERE id=$1`, [half.id]);
      await db.query(sql);
      await db.query(sql);   // twice — two deploys
      ok((await db.query(`SELECT display_checked_at FROM draw_media WHERE id=$1`, [half.id])).rows[0].display_checked_at,
        `D2.2 …but a row the worker ${label} is never un-stamped again (no endless re-decode)`);
    }

    // (c) end to end: the worker's own answer survives a re-run of the migration.
    await db.query(`UPDATE draw_media SET display_ref=NULL, display_checked_at=NULL,
                      compact_ref=NULL, compact_skip_reason=NULL WHERE id=$1`, [half.id]);
    await media.buildDisplayMediaOnce(50, { pauseMs: 0 });
    const after = (await db.query(`SELECT * FROM draw_media WHERE id=$1`, [half.id])).rows[0];
    ok(after.display_checked_at, 'D2.3 the worker stamps the row…');
    ok(after.compact_ref || after.compact_skip_reason, 'D2.4 …and always answers the email-copy question');
    await db.query(sql);
    ok((await db.query(`SELECT display_checked_at FROM draw_media WHERE id=$1`, [half.id])).rows[0].display_checked_at,
      'D2.5 …so the migration converges on the very next boot');
  }

  // ── E. A CACHED REPORT CANNOT OUTLIVE THE PHOTOS IT IS MISSING ────────────────
  {
    /* The stored report is looked up by a version-hashed filename. Building a display copy changes
       neither the photo COUNT nor archived_at — so without the display state in the hash, a report
       cached while the photos were still full-size would be served forever and would never pick up
       the ones that now fit. */
    const v1 = await report.reportVersion(app.id, drawId);
    await db.query(`UPDATE draw_media SET display_ref=NULL, display_checked_at=NULL WHERE id=$1`, [bigRow.id]);
    const v2 = await report.reportVersion(app.id, drawId);
    ok(v1 !== v2, 'E1 the report version reflects whether the photos have report-sized copies');
    // restore
    await db.query(`UPDATE draw_media SET display_ref=$2, display_checked_at=now() WHERE id=$1`,
      [bigRow.id, (await db.query(`SELECT display_ref FROM draw_media WHERE id=$1`, [bigRow.id])).rows[0].display_ref]);
  }

  // ── F. THE INVESTOR EMAIL NO LONGER APOLOGISES FOR ITS OWN PLUMBING ───────────
  {
    const src = require('fs').readFileSync(require.resolve('../src/sitewire/investor-delivery-send.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/Let us know and we will send it over/.test(code),
      'F1 the email never asks a capital partner to chase us for our own document');
    ok(!/'Not attached: '/.test(code), 'F2 …and never leads with what it failed to attach');
    ok(/Enclosed: /.test(code), 'F3 …it names what it IS sending instead');
    /* NOTHING IS LOST INTERNALLY — that is what makes the quieter email honest rather than a
       cover-up. The skipped list must still be returned on the send, still written to the delivery
       record, and still readable by our own team afterwards. It is deliberately NOT known before
       the send: deliveryPreview does not gather attachments, because that would build the report
       and the packet on every page load. */
    ok(/skipped,/.test(code) || /skipped\b/.test(code), 'F4 the skipped list is still tracked');
    ok(/F\.jsonbText\(skipped\)/.test(code), 'F5 …and still recorded on the delivery row');
    ok(/sent_by, attachments, skipped/.test(code),
      'F5a …and read back into the desk history, which is where our team now sees it');

    /* THE EMAILED REPORT IS BUILT FRESH AT EMAIL SIZE AND NEVER FILED. A stored second report
       would compute the SAME version-hashed filename as the full-quality one (the hash is over the
       draw's DATA, not the photo size), so the lookup would hand back the big one and the email
       would go out oversized again — and once told apart, the compact copy would SUPERSEDE the
       good report and drop it off every screen that reads is_current. */
    ok(/buildReportBytes\(/.test(code), 'F6 the delivery builds its own copy in memory…');
    ok(/rendition: 'compact'/.test(code), 'F7 …at email size');
    ok(!/buildOrGetReportDoc\(/.test(code),
      'F8 …and NEVER through the storing path — a second stored report is the trap this avoids');

    const rsrc = require('fs').readFileSync(require.resolve('../src/sitewire/draw-report.js'), 'utf8');
    const rcode = rsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn = rcode.slice(rcode.indexOf('async function buildReportBytes'), rcode.indexOf('async function buildOrGetReportDoc'));
    ok(fn.length > 200, 'F9 (fixture) found the in-memory builder');
    ok(!/storeDrawReport|INSERT INTO documents|storage\.save/.test(fn),
      'F10 the in-memory builder stores nothing — no document row, no blob');
  }

  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor.id]);
  console.log(`test-draw-photo-fit-db: ${checks} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('test-draw-photo-fit-db FAILED:', e); process.exit(1); });
