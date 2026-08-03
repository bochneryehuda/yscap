/* THE STREET-LEVEL FALLBACK, ACTUALLY RENDERED.
 *
 * Most warehouse properties carry a photograph an appraiser took; a good share
 * carry none, and a grey box tells an officer nothing about a house. Street View
 * fills that gap — but only ever as a FALLBACK, and only ever LABELLED, because an
 * appraiser's photo is evidence of the property on the day of the report and is
 * what the condition grade was written from, while a street image is a car that
 * drove past at some point, from the road, possibly years out. Presenting the two
 * alike invites somebody to read a tidy front garden as evidence of condition.
 *
 * Four things checked in a real browser, because a green build proves none of them:
 *   1. A property WITH an appraisal photo shows that photo and no street label.
 *   2. A property WITHOUT one shows the street, carrying the label.
 *   3. With no Google key the proxy 404s and the layout is unchanged — no broken
 *      image icon, no empty gap claiming to be a picture.
 *   4. The street image is LAZY, so a 25-row list does not fire 25 billable
 *      requests for rows nobody scrolls to.
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/user/yscap/yscap-repo-root_8/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_t3';
process.env.JWT_SECRET = 'render-check-secret';
const db = require('/home/user/yscap/yscap-repo-root_8/src/db');
const C = require('/home/user/yscap/yscap-repo-root_8/src/lib/crypto');
const app = require('/home/user/yscap/yscap-repo-root_8/src/server');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
const CITY = `Streetville${sfx}`;
let server, staffId, withPhoto, noPhoto, docId;
const errors = [];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// A 1x1 PNG, so the "we have an appraisal photo" path has real bytes to serve.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

(async () => {
  let browser;
  try {
    await require('/home/user/yscap/yscap-repo-root_8/src/migrate-boot').ensureSchema();
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Street Check','super_admin',true,false,'x',0) RETURNING id`,
      [`st${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    const mk = async (name) => (await db.query(
      `INSERT INTO properties (address_key, display_address, street, city, state, zip,
         property_type, units, gla, beds, baths_full, year_built, condition_uad,
         last_sale_price, last_sale_date, observation_count, geo_latitude, geo_longitude)
       VALUES ($1,$2,$3,$4,'NJ','07001','Single Family',1,1500,3,2,1975,'C3',
               400000, current_date - interval '2 months', 2, 40.1, -74.1)
       RETURNING id`,
      [`nj|${CITY.toLowerCase()}|${name}|${sfx}`, `${name} ${sfx}`, name, CITY])).rows[0].id;
    withPhoto = await mk('1 Photo St');
    noPhoto = await mk('2 Bare St');

    // A real document + photo link, so `primary_photo_document_id` is populated
    // exactly as the ingest would populate it.
    const storage = require('/home/user/yscap/yscap-repo-root_8/src/lib/storage');
    // storage.save takes the BUFFER first, then the options — not one object.
    const ref = await storage.save(PNG, { filename: 'shot.png' });
    docId = (await db.query(
      `INSERT INTO documents (filename, content_type, size_bytes, storage_ref, storage_provider,
         doc_kind, source_type, review_status, is_current, visibility)
       VALUES ('shot.png','image/png',$1,$2,'local','appraisal_photo','system','accepted',true,'staff_only')
       RETURNING id`, [PNG.length, ref.ref || ref.storageRef || ref])).rows[0].id;
    await db.query(
      `INSERT INTO property_photos (property_id, document_id, sequence, category, is_primary)
       VALUES ($1,$2,1,'photo',true)`, [withPhoto, docId]);
    // `primary_photo_document_id` is a scalar SUBQUERY in the search select, not a
    // column — the photo link above is what makes it non-null. Only the count is
    // denormalized.
    await db.query('UPDATE properties SET photo_count=1 WHERE id=$1', [withPhoto]);

    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('ys_portal_token', t); }, token);

    /* TWO STATES, AND BOTH MATTER. With a key configured the proxy returns an
       image; with none it 404s, which is the shipped state today and the one that
       must leave the layout unchanged rather than showing a broken picture. The
       404 arrives instantly, so the labelled state is only observable while the
       proxy is answering — hence the switch rather than one fixed reply. */
    let photoCalls = 0;
    let streetHasImagery = true;
    await ctx.route('**/api/address/photo*', (route) => {
      photoCalls++;
      return streetHasImagery
        ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
        : route.fulfill({ status: 404, contentType: 'application/json',
          body: JSON.stringify({ error: 'property photos not enabled' }) });
    });

    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });

    // ---- the property WITHOUT an appraisal photo --------------------------
    await page.goto(`${base}/portal/#/internal/research/property/${noPhoto}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);
    ok(await page.locator('text=Something went wrong').count() === 0, 'the property page renders with no photo');
    ok(await page.locator('text=/STREET VIEW · not an appraisal photo/').count() === 1,
      'a property with no appraisal photo offers the street, LABELLED as the street');
    ok(photoCalls >= 1, `and asks our own proxy for it (${photoCalls} call${photoCalls === 1 ? '' : 's'}) — the key never reaches the browser`);
    const lazy = await page.locator('img[alt^="Street view of"]').getAttribute('loading');
    ok(lazy === 'lazy',
      `the street image is lazy (${lazy}) — Street View Static is billed per request, and a 25-row list would `
      + 'otherwise fire 25 of them for rows nobody scrolls to');

    // NO KEY (or no coverage): the proxy 404s and NOTHING broken is left behind.
    streetHasImagery = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);
    ok(await page.locator('text=/STREET VIEW · not an appraisal photo/').count() === 0,
      'with no key the proxy says there is no imagery and the whole thing disappears — no broken picture, no empty claim');
    ok(await page.locator('text=Something went wrong').count() === 0, 'and the page is otherwise unchanged');
    streetHasImagery = true;

    // ---- the property WITH an appraisal photo ----------------------------
    await page.goto(`${base}/portal/#/internal/research/property/${withPhoto}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);
    ok(await page.locator('text=Something went wrong').count() === 0, 'the property page renders with a photo');
    ok(await page.locator('text=/STREET VIEW · not an appraisal photo/').count() === 0,
      "an appraiser's own photograph is NEVER replaced by a street image");
    ok(await page.locator('img[alt*="Photo St"]').count() >= 1, 'and the appraisal photo itself is shown');

    ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
    for (const id of [withPhoto, noPhoto]) if (id) await db.query('DELETE FROM properties WHERE id=$1', [id]).catch(() => {});
    if (docId) await db.query('DELETE FROM documents WHERE id=$1', [docId]).catch(() => {});
    if (staffId) await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});
    await db.pool.end().catch(() => {});
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
})();
