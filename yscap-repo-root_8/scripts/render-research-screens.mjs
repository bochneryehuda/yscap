/* FOUR NEW COMPONENTS, ACTUALLY RENDERED.
 *
 * A green Vite build proves nothing: an undeclared identifier compiles fine and
 * throws ReferenceError at render, which the ErrorBoundary turns into the
 * full-screen "Something went wrong". eslint no-undef catches most of it; only a
 * real render catches the rest (a null dereference, a bad prop, a crash inside a
 * map). This seeds exactly the data each component needs to APPEAR — a component
 * that renders nothing because its data is absent has not been tested.
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/user/yscap/yscap-repo-root_8/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
process.env.DATABASE_URL = 'postgres://yscap:yscap@127.0.0.1:5432/yscap_t3';
process.env.JWT_SECRET = 'render-check-secret';
const db = require('/home/user/yscap/yscap-repo-root_8/src/db');
const C = require('/home/user/yscap/yscap-repo-root_8/src/lib/crypto');
const app = require('/home/user/yscap/yscap-repo-root_8/src/server');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
let server, staffId, valId, propA, propB, unplaced;
const errors = [];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The rates a real `deriveMarketRates` produces, in both shapes that matter: a
// PEER-sourced size rate (the whole point of the panel) and a refused rate.
const RATES = {
  sampleSize: 290, minSample: 8, distressedSetAside: 14,
  distressedNote: '14 forced sales (bank-owned, short sale, estate or relocation) were left out of these rates',
  pricePerSqft: { value: 119.4, n: 290, basis: 'median of sale price ÷ living area across 290 closed sales' },
  glaAdjustmentPerSqft: {
    value: 45, low: 38.5, high: 55, n: 290, source: 'peer',
    basis: 'what appraisers in this market actually adjusted, across 290 size adjustments on reports we paid for',
  },
  glaAdjustmentPerSqftGba: {
    value: 28, low: 20, high: 50, n: 178, source: 'peer', basis_of: 'gba',
    basis: 'what appraisers in this market actually adjusted on 2-4 unit grids, across 178 size adjustments measured on gross building area',
  },
  perBedroom: {
    valuePerSqft: 23.54, n: 61, approxDollarsOnTypicalHouse: 35250,
    basis: 'difference in median price per foot between bedroom groups (61 sales, matched for size)',
  },
  perBath: { value: null, n: 73, why: 'the sales with more bathrooms in this market are also materially BIGGER houses' },
  perConditionGrade: { value: null, n: 12, why: 'not enough sales spread across different condition grades' },
  monthlyMarketChangePct: { value: 0.42, n: 290, monthsApart: 18, basis: 'median price per foot moved 7.6% over about 18 months' },
};

(async () => {
  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Render Check','super_admin',true,false,'x',0) RETURNING id`, [`rn${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    // TWO ROWS THAT LOOK LIKE ONE HOUSE — same street + state + ZIP, one keyed on
    // the ZIP and one on the town, which is `findDuplicates` bucket A.
    propA = (await db.query(
      `INSERT INTO properties (address_key, display_address, street, city, state, zip,
         property_type, units, gla, beds, baths_full, year_built, condition_uad,
         last_sale_price, last_sale_date, observation_count, geo_latitude, geo_longitude)
       VALUES ($1,$2,'41 Render Row','Rendertown','NJ','07001','Multi 2–4',3,2400,5,2,1962,'C3',
               540000,'2026-02-10',2,40.5,-74.3) RETURNING id`,
      [`nj|rendertown|41 render row|${sfx}`, `41 Render Row ${sfx}`])).rows[0].id;
    propB = (await db.query(
      `INSERT INTO properties (address_key, display_address, street, city, state, zip,
         property_type, units, gla, beds, year_built, observation_count,
         geo_latitude, geo_longitude)
       VALUES ($1,$2,'41 Render Row',NULL,'NJ','07001','Multi 2–4',3,2400,5,1962,1,40.5,-74.3)
       RETURNING id`,
      [`nj|z07001|41 render row|${sfx}`, `41 Render Row ${sfx}`])).rows[0].id;
    // A property with NO coordinates at all, so the map-coverage line has something
    // to disclose.
    unplaced = (await db.query(
      `INSERT INTO properties (address_key, display_address, street, city, state, zip,
         property_type, units, gla, beds, year_built)
       VALUES ($1,$2,'9 Nowhere Ln','Rendertown','NJ','07001','SFR (1 unit)',1,1400,3,1990)
       RETURNING id`,
      [`nj|rendertown|9 nowhere ln|${sfx}`, `9 Nowhere Ln ${sfx}`])).rows[0].id;
    // A property with NO type and NO unit count, so the "not stated" branch renders.
    await db.query(
      `INSERT INTO properties (address_key, display_address, street, city, state, zip, gla, beds, year_built,
         last_sale_price, last_sale_date, geo_latitude, geo_longitude)
       VALUES ($1,$2,'3 Unknown Ct','Rendertown','NJ','07001',1200,2,1975,410000,'2026-01-15',40.5,-74.3)`,
      [`nj|rendertown|3 unknown ct|${sfx}`, `3 Unknown Ct ${sfx}`]);

    valId = (await db.query(
      `INSERT INTO property_valuations (property_id, title, subject_address, subject_snapshot,
         purpose, effective_date, method, market_rates, created_by)
       VALUES ($1,'Render check','41 Render Row',$2,'as_is',CURRENT_DATE,'weighted',$3,$4)
       RETURNING id`,
      [propA, JSON.stringify({ display_address: '41 Render Row', city: 'Rendertown', state: 'NJ', gla: 2400 }),
        JSON.stringify(RATES), staffId])).rows[0].id;

    // An appraisal we had to turn away, in the format that matters.
    await db.query(
      `INSERT INTO appraisal_format_refusals (kind, model, filename, reason, refused_by)
       VALUES ('uad_3_6','MISMO 3.6','render-check.xml','reads UAD 2.6 only',$1)`, [staffId]);

    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('ys_portal_token', t); } catch (e) { /* */ } }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    // Google Fonts is blocked in this environment (see CLAUDE.md) and the portal
    // falls back to system faces — an environment artifact, not a page error.
    const EXTERNAL = /fonts\.googleapis\.com|fonts\.gstatic\.com/;
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (EXTERNAL.test(m.text()) || /Failed to load resource/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    page.on('requestfailed', (r) => {
      if (EXTERNAL.test(r.url())) return;
      errors.push(`requestfailed: ${r.url()} :: ${(r.failure() || {}).errorText}`);
    });

    const visit = async (hash) => {
      await page.goto(`${base}/portal/#${hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2600);
      return page.evaluate(() => document.body.innerText);
    };
    const noCrash = (body, where) =>
      ok(!/Something went wrong/i.test(body), `${where}: the page did not crash`);

    // ---- 1. MarketRates on the valuation screen --------------------------
    let body = await visit(`/internal/research/valuation/${valId}`);
    noCrash(body, 'valuation');
    ok(/What these suggestions were worked out from/i.test(body), 'valuation: the rates panel renders');
    ok(/\$45/.test(body) && /a square foot/i.test(body), 'valuation: the size-adjustment rate shows its number');
    ok(/measured from our own reports/i.test(body),
      'valuation: and says the number came from OUR reports, not a rule of thumb');
    ok(/forced sale/i.test(body), 'valuation: the forced sales set aside are stated');
    ok(/On 2.4 unit sales/i.test(body) && /\$28/.test(body),
      'valuation: the 2-4 unit rate renders when this market has one');
    // Always in the DOM so print can reveal it, but COLLAPSED on screen until the
    // reader asks — checked here, before anything is clicked.
    ok(await page.evaluate(() => {
      const d = [...document.querySelectorAll('.mr-detail')];
      return d.length > 0 && d.every((x) => getComputedStyle(x).display === 'none');
    }), 'valuation: the rate detail is present but collapsed on screen');
    // The collapsed half — the per-bedroom row is where "$NaN" appeared.
    const shown = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Show the rest/i.test(x.textContent));
      if (b) b.click(); return !!b;
    });
    ok(shown, 'valuation: the "Show the rest" control is there');
    await page.waitForTimeout(400);
    body = await page.evaluate(() => document.body.innerText);
    ok(!/NaN/.test(body), 'valuation: NO "$NaN" anywhere — the defect the audit caught');
    ok(/\$35,250/.test(body), 'valuation: the per-bedroom figure renders as real dollars');
    ok(/\+0\.42% a month/.test(body), 'valuation: a real +0.42%/month trend is not rounded away to 0%');
    ok(/no rate/.test(body), 'valuation: a REFUSED rate reads "no rate" rather than a blank');

    // ---- 1b. THE PRINTED REPORT IS THE WHOLE REPORT ----------------------
    // Emulating print media is the only way to see what actually reaches paper:
    // the grid is a horizontal scroller, and an overflow container CLIPS when
    // printed, so the comps past the fold used to be silently absent.
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);
    const printed = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll('section')]
        .filter((s) => getComputedStyle(s).overflowX === 'auto' || getComputedStyle(s).overflowX === 'scroll');
      const t = document.querySelector('table');
      return {
        clipped: scrollers.length,
        tableClipped: t ? t.scrollWidth > t.clientWidth + 1 : false,
        colour: getComputedStyle(document.body).printColorAdjust
          || getComputedStyle(document.body).webkitPrintColorAdjust || '',
      };
    });
    ok(printed.clipped === 0, 'print: no section still clips its contents — the full grid reaches the paper');
    ok(printed.tableClipped === false, 'print: the adjustment table is not cut off at the right edge');
    ok(printed.colour === 'exact', 'print: colours are kept, so a negative adjustment still reads as negative');
    // THE SELECTS ARE CONTENT. The valuation METHOD and the subject's CONDITION
    // are <select>s, and hiding controls wholesale deleted both from the report.
    // And the rate detail must reach the paper WITHOUT our own button, because
    // Ctrl+P and "Save as PDF" never run it.
    const printBody = await page.evaluate(() => {
      const sels = [...document.querySelectorAll('select')];
      return {
        hiddenSelects: sels.filter((s) => getComputedStyle(s).display === 'none').length,
        selects: sels.length,
        detailShown: [...document.querySelectorAll('.mr-detail')]
          .every((d) => getComputedStyle(d).display !== 'none'),
        detailCount: document.querySelectorAll('.mr-detail').length,
      };
    });
    ok(printBody.selects > 0 && printBody.hiddenSelects === 0,
      'print: the method and the condition are CONTENT and still print');
    ok(printBody.detailCount > 0 && printBody.detailShown,
      'print: the rate detail reaches the paper without our own Print button being used');
    await page.emulateMedia({ media: 'screen' });

    // ---- 2. FormatWatch + MapCoverage on the research landing ------------
    body = await visit('/internal/research');
    noCrash(body, 'research landing');
    ok(/new format we cannot read yet/i.test(body), 'landing: the format deadline warning renders');
    ok(/2 November 2026/.test(body), 'landing: and states the date it starts mattering');
    ok(/placed on the map/i.test(body), 'landing: the map-coverage disclosure renders');
    ok(/cannot see the other/i.test(body), 'landing: and says what a distance search cannot see');

    // ---- 3. MaybeSameHouse on the property page --------------------------
    body = await visit(`/internal/research/property/${propA}`);
    noCrash(body, 'property detail');
    ok(/may be this same house/i.test(body), 'property: the duplicate-pair panel renders');
    ok(/Same house — keep THIS page/i.test(body) && /Not the same house/i.test(body),
      'property: and offers both a merge and a "they are different" answer');
    ok(/only gave a ZIP|same point on the map|one with a unit number/i.test(body),
      'property: it says WHY the two were paired');

    // ---- 3b. What appraisers here actually adjust ------------------------
    // It answers from the ADJUSTMENT corpus, not the market grid, so it must
    // render on a named market even when there is no 1004MC data at all — which
    // is the state of most towns we hold.
    body = await visit('/internal/research/market?city=Rendertown&state=NJ');
    noCrash(body, 'market');
    ok(/What appraisers here actually adjust/i.test(body),
      'market: the adjustment-corpus panel renders even with no market-grid data');
    ok(/too few here to say|a sq ft/i.test(body),
      'market: it answers with a rate or an honest refusal, never a blank');

    // ---- 4. The unit count + property type on the comp search ------------
    body = await visit('/internal/research/comps?city=Rendertown&state=NJ');
    noCrash(body, 'comp search');
    ok(/Multi 2–4/.test(body), 'comp search: the property TYPE shows on the result row');
    ok(/3 units/.test(body), 'comp search: and the UNIT COUNT — the owner\'s first requirement');
    ok(/type not stated|units not stated/.test(body),
      'comp search: an unknown says so out loud rather than being left off');

    // ---- nothing threw anywhere -----------------------------------------
    ok(errors.length === 0, `no page errors (${errors.length})`);
    if (errors.length) errors.slice(0, 6).forEach((e) => console.log('   ' + e));

    await browser.close();
  } catch (e) {
    console.log('FAIL harness threw: ' + e.message);
    console.log(e.stack);
    failures++;
  } finally {
    try {
      await db.query(`DELETE FROM property_valuations WHERE id=$1`, [valId]);
      await db.query(`DELETE FROM appraisal_format_refusals WHERE refused_by=$1`, [staffId]);
      await db.query(`DELETE FROM properties WHERE address_key LIKE $1`, [`%|${sfx}`]);
      await db.query(`DELETE FROM properties WHERE id = ANY($1::uuid[])`, [[propA, propB, unplaced].filter(Boolean)]);
      await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    } catch (_) { /* best effort */ }
    if (server) server.close();
    console.log(failures ? `\nrender-new: ${failures} FAILED` : '\nrender-new: all passed');
    process.exit(failures ? 1 : 0);
  }
})();
