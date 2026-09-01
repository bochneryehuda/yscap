'use strict';
/**
 * THE FEE AUDIT ENGINE, BROWSER HALF — the fees really land on the printed page, and the printed
 * page does not run one line into another.
 *
 * OWNER-DIRECTED 2026-08-26, two halves of one instruction: *"make sure every single fee populates
 * every place where fees can populate"* and *"now that we added so many rows to the term sheet, we
 * need to make sure that the term sheet prints nicely and it's not overlapping. One line on the
 * other."*
 *
 * READING THE SOURCE CANNOT PROVE EITHER ONE. The sheet is drawn by jsPDF at run time out of a
 * long sequence of row calls whose heights are MEASURED from the text — so whether a row lands
 * on top of the one below it is a fact about the render, not about the code. This loads the real
 * studio, drives fee-bearing deals through the real inputs, wraps `jsPDF.API.text` to record every
 * string WITH ITS GEOMETRY, and then asserts three things:
 *
 *   1  NAMING — every fee the deal actually carries is printed by name, with its amount.
 *   2  NO COLLISION — no drawn string overlaps another. This is the check the owner asked for,
 *      and it found a real one: the Inputs & Loan Derivation page had no page break at all, so on
 *      a deal carrying government charges its Key-dates rows were drawn straight through the
 *      footnote and off the bottom of the paper.
 *   3  NOTHING FALLS OFF THE PAGE — no text below the bottom margin.
 *
 * WHY THE OVERLAP TEST IS TOLERANT BY 2pt AND IGNORES INVISIBLE TEXT. A glyph box is an
 * approximation (a line of digits has no descenders; a cap-height ascent is not an em), so
 * hairline contact between a 26pt headline and the label beneath it is a fact about the box model
 * rather than about the page. And the DocuSign anchors are deliberately WHITE 4pt text placed ON
 * the signature lines — invisible by design, and flagging them would train a reader to ignore this
 * report. Both exclusions are narrow and stated; a real collision is tens of points, not one.
 *
 * Run: node scripts/render-fee-audit.js
 * SKIPs (exit 0) without Playwright/Chromium — CI has no browser, which is why this is not in the
 * `npm test` chain; `scripts/test-fee-audit-pure.js` carries the guards CI can enforce.
 */
const path = require('path');
const fs = require('fs');

let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('SKIP render-fee-audit (no playwright)'); process.exit(0); }
const TOOL = path.resolve(__dirname, '../web/v2/tools/term-sheet.html');
if (!fs.existsSync(TOOL)) { console.log('SKIP render-fee-audit (studio not found)'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (m, c, extra) => { if (c) { pass++; } else { fail++; console.log('  FAIL - ' + m + (extra ? ' :: ' + extra : '')); } };

/* Every deal shape that carries a different set of fees. Each names what it MUST print, so a
   surface that stops printing one fails on the fee rather than on a count. */
const DEALS = [
  {
    name: 'New Jersey light flip — the fewest fees there are',
    f: { dealPurpose: 'Purchase', dealType: 'Fix & Flip', price: '400000', construction: '60000',
      arv: '700000', asIs: '400000', fico: '740', expFlips: '5', propState: 'NJ', rehabScope: 'light' },
    must: ['Underwriting & processing', 'Legal fee', 'Credit report (avg)', 'Title / escrow / settlement (est.)',
      'Appraisal (est., POC)', 'Origination fee', 'Estimated cash to close', 'Liquidity to show'],
    mustNot: ['feasibility review', 'project review', 'New York settlement agent fee', 'New York CEMA fee'],
  },
  {
    name: 'New Jersey ground-up — the construction feasibility review',
    f: { dealPurpose: 'Purchase', dealType: 'Ground-up Construction', price: '400000', construction: '600000',
      arv: '1400000', asIs: '400000', fico: '750', expGround: '5', propState: 'NJ' },
    must: ['Ground-up construction feasibility review', '$1,250.00', 'Legal fee', '$2,000.00'],
    mustNot: ['New York settlement agent fee', 'New York CEMA fee'],
  },
  {
    name: 'Brooklyn flip — the New York legal rung, the optional settlement fee and the city taxes',
    f: { dealPurpose: 'Purchase', dealType: 'Fix & Flip', price: '900000', construction: '150000',
      arv: '1600000', asIs: '900000', fico: '750', expFlips: '5', propState: 'NY',
      tsTaxCounty: 'Kings', tsTaxCity: 'Brooklyn', tsTaxUnits: '3', rehabScope: 'light' },
    must: ['Legal fee', '$2,500.00', 'New York settlement agent fee (optional)', '$750.00',
      'New York City mortgage recording tax'],
    mustNot: ['New York CEMA fee'],
  },
  {
    name: 'Brooklyn ground-up refinance marked a CEMA — every optional fee at once',
    cema: true,
    f: { dealPurpose: 'Rate & term refinance', dealType: 'Ground-up Construction', asIs: '1400000',
      arv: '3400000', construction: '900000', payoff: '600000', fico: '760', expGround: '5',
      propState: 'NY', tsTaxCounty: 'Kings', tsTaxCity: 'Brooklyn', tsTaxUnits: '4' },
    must: ['Legal fee', 'New York settlement agent fee (optional)', 'New York CEMA fee', '$1,000.00',
      'Ground-up construction feasibility review', 'New York City mortgage recording tax', 'Existing loan payoff'],
  },
  {
    /* THE WORST CASE FOR THE PAGE, not for the price: every government charge typed by hand so the
       cash-to-close card carries as many rows as this document can ever be asked to print. This is
       the deal that has to prove the layout, which is why the taxes are overridden rather than
       waited for. */
    name: 'The heaviest page there is — every tax line typed, on a New York ground-up',
    f: { dealPurpose: 'Purchase', dealType: 'Ground-up Construction', price: '2400000', construction: '1800000',
      arv: '6500000', asIs: '2400000', fico: '760', expGround: '5', propState: 'NY',
      tsTaxCounty: 'Kings', tsTaxCity: 'Brooklyn', tsTaxUnits: '4',
      tsTaxMortgage: '91840', tsTaxTransferState: '9600', tsTaxTransferLocal: '63000',
      tsTaxMansion: '60000', tsTaxIntangible: '4500', estClosingDate: '2026-11-02',
      borrowerName: 'Prospective Borrower', entityName: 'Example Holdings LLC', coBorrowerName: 'Second Borrower' },
    must: ['Ground-up construction feasibility review', 'New York settlement agent fee (optional)', 'Legal fee'],
  },
];

/* The footer lines the document draws BELOW the content area on purpose. Everything else must sit
   inside the margin. */
const FOOTER_RE = /^(Your YS Capital contact:|Indicative only|Initial term sheet ·|Final term sheet ·|Manually underwritten|Figures are indicative)/;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' })
    .catch(() => chromium.launch());
  const page = await browser.newPage();
  page.on('pageerror', (e) => ok('the studio raised no page error', false, e.message));
  await page.goto('file://' + TOOL, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => new Promise((res) => {
    if (window.jspdf && window.jspdf.jsPDF) return res();
    const s = document.createElement('script');
    s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  }));

  /* How many deals named a legal rung. `general` is deliberately absent from LEGAL_RUNG_WORDS —
     a plain $995 file shows "Legal fee" with nothing in brackets, because "(general)" tells the
     officer nothing. So the per-deal check is the SHAPE, and the count below is what would catch
     the rung words vanishing altogether. */
  const rungNamed = [];
  for (const deal of DEALS) {
    /* A FIXTURE THAT NAMES A FIELD THE STUDIO DOES NOT HAVE tests a different deal than it claims
       (the lesson of the `<select>` that silently ignored a value it had no option for). */
    const missing = await page.evaluate((f) => Object.keys(f).filter((k) => !document.getElementById(k)), deal.f);
    ok(`${deal.name}: every field in the fixture exists on the studio`, missing.length === 0, missing.join(', '));

    const refused = await page.evaluate((f) => {
      ['construction', 'arv', 'asIs', 'price', 'payoff', 'expFlips', 'expBrrrr', 'expGround',
        'tsTaxCounty', 'tsTaxCity', 'tsTaxUnits', 'tsTaxMortgage', 'tsTaxTransferState',
        'tsTaxTransferLocal', 'tsTaxMansion', 'tsTaxIntangible', 'estClosingDate',
        'borrowerName', 'entityName', 'coBorrowerName'].forEach((id) => {
        const e = document.getElementById(id); if (e) e.value = '';
      });
      const c = document.getElementById('tsCemaOn'); if (c) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
      for (const [k, v] of Object.entries(f)) {
        const e = document.getElementById(k); if (!e) continue;
        if (e.tagName === 'SELECT') {
          const opt = Array.from(e.options).find((o) => o.value === v || o.textContent.trim() === v);
          e.value = opt ? opt.value : v;
        } else e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      /* A <select> SILENTLY IGNORES a value it has no option for, so a fixture that names one
         tests a different deal than it claims and reports the studio's default as the code's
         answer. Read every value back. */
      const norm = (x) => String(x == null ? '' : x).replace(/,/g, '').trim();
      return Object.entries(f).filter(([k, v]) => {
        const e = document.getElementById(k); if (!e) return false;
        if (norm(e.value) === norm(v)) return false;
        if (e.tagName === 'SELECT') {
          const opt = Array.from(e.options).find((o) => o.value === e.value);
          if (opt && norm(opt.textContent) === norm(v)) return false;   // the fixture named the label
        }
        return true;
      }).map(([k, v]) => `${k}: asked "${v}", took "${(document.getElementById(k) || {}).value}"`);
    }, deal.f);
    ok(`${deal.name}: every field took the value the fixture asked for`, refused.length === 0, refused.join(' | '));
    await page.waitForTimeout(400);
    if (deal.cema) {
      const ticked = await page.evaluate(() => {
        const c = document.getElementById('tsCemaOn'); if (!c) return false;
        c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true;
      });
      ok(`${deal.name}: the CEMA question exists to be ticked`, ticked);
    }
    /* THE STRUCTURE SCREEN ONLY EXISTS ONCE A PROGRAM IS PICKED — the studio shows the program
       cards first and the breakdown after you drill in. Without this click every "the structure
       screen shows …" check reads a hidden panel and reports the product as broken. */
    /* THE CARD TOGGLES — clicking it while the breakdown is already open CLOSES it, so a blind
       click per deal opened the screen on the odd-numbered deals and shut it on the even ones,
       reporting the product as broken on half the matrix. Click only when it is shut. */
    await page.evaluate(() => {
      const d = document.getElementById('progDetail');
      if (d && d.offsetParent === null) { const c = document.getElementById('pcardStd'); if (c) c.click(); }
    });
    await page.waitForTimeout(800);
    const screen = await page.evaluate(() => {
      const txt = (id) => { const e = document.getElementById(id); return e ? (e.textContent || '').trim() : null; };
      /* offsetParent is null for anything display:none anywhere up the tree — the layout's own
         answer, rather than a walk that only sees INLINE styles and misses a CSS class. */
      const shown = (id) => { const e = document.getElementById(id); return !!(e && e.offsetParent !== null); };
      return { open: shown('progDetail'),
        feas: shown('rFeasWrap') ? txt('rFeas') : null, settle: shown('rSettleRow') ? txt('rSettle') : null,
        cema: shown('rCemaRow') ? txt('rCema') : null, cash: shown('rCash') ? txt('rCash') : null,
        liquidity: shown('rLiquidity') ? txt('rLiquidity') : null,
        /* OUR FEE'S TWO HALVES, read from the two ROWS that replaced the old combined sub-line
           (2026-08-26). `rLenderSub` no longer exists; reading it left this assertion comparing
           against null on every deal. */
        uwFee: shown('rUwRow') ? txt('rUwFee') : null, legalFee: shown('rLegalRow') ? txt('rLegalFee') : null,
        legalLbl: shown('rLegalRow') ? txt('rLegalLbl') : null,
        combined: shown('rLenderRow') ? txt('rLender') : null,
        gov: shown('rGovWrap') ? txt('rGovWrap') : null };
    });
    ok(`${deal.name}: the structure screen opened`, screen.open === true);

    const r = await page.evaluate(async () => {
      const J = window.jspdf && window.jspdf.jsPDF;
      if (!J) return { err: 'jsPDF did not load' };
      const items = []; let pageH = 0, pageW = 0;
      const oT = J.API.text, oS = J.API.save, oO = J.API.output;
      /* THE addPage HOOK IS DELIBERATELY ABSENT. Wrapping it breaks jsPDF's own page bookkeeping
         and the export dies silently at the first page break — which reads as "the sheet is only
         one page" and would have made this whole report a lie. Read the page number off the
         document instead. */
      J.API.text = function (t, x, y, o) {
        try {
          if (!pageH) { pageH = this.internal.pageSize.getHeight(); pageW = this.internal.pageSize.getWidth(); }
          const size = this.internal.getFontSize();
          let p = 1; try { p = this.internal.getCurrentPageInfo().pageNumber; } catch (_) { /* first page */ }
          let colour = ''; try { colour = String(this.getTextColor() || ''); } catch (_) { /* older jsPDF */ }
          const arr = Array.isArray(t) ? t : [t];
          arr.forEach((s, i) => {
            if (typeof s !== 'string' || !s.trim()) return;
            let w = 0; try { w = this.getTextWidth(s); } catch (_) { /* unmeasurable */ }
            items.push({ p, t: s, x: Number(x) || 0, y: (Number(y) || 0) + i * size * 1.15, size, w,
              align: (o && o.align) || 'left', colour });
          });
        } catch (_) { /* capture is best-effort and must never break the export */ }
        try { return oT.apply(this, arguments); } catch (e) { return this; }
      };
      J.API.save = function () { return this; };
      J.API.output = function () { return ''; };
      let err = null;
      try { await window.TS.exportPdf(); } catch (e) { err = String((e && e.message) || e); }
      await new Promise((z) => setTimeout(z, 1600));
      J.API.text = oT; J.API.save = oS; J.API.output = oO;
      const d = window.TS._calc(window.TS._gather());
      return { err, items, pageH, pageW,
        d: d && { status: d.status, sized: d.pricingReady && d.totalLoan > 0 && d.status !== 'INELIGIBLE',
          why: (d.reasons || []).map((x) => x.level + ': ' + x.msg).join(' | '), totalLoan: d.totalLoan,
          uwFee: d.uwFee, legalFee: d.legalFee, settleFee: d.settleFee, cemaFee: d.cemaFee,
          feasFee: d.feasFee, creditFee: d.creditFee, titleCost: d.titleCost, origFee: d.origFee,
          brokerFee: d.brokerFee, apprFee: d.apprFee, cashToClose: d.cashToClose, liquidity: d.liquidity,
          govTotal: d.gov && d.gov.borrowerTotal, govLines: (d.gov && d.gov.borrowerLines) ? d.gov.borrowerLines.length : 0 },
      };
    });

    console.log(`\n── ${deal.name}`);
    if (r.err) { ok(`${deal.name}: the term sheet rendered`, false, r.err); continue; }
    const all = r.items.map((i) => i.t).join('\n');
    const pages = [...new Set(r.items.map((i) => i.p))].sort((a, b) => a - b);
    ok(`${deal.name}: the term sheet rendered in full`, r.items.length > 200 && pages.length >= 4,
      `${r.items.length} strings over ${pages.length} pages`);
    ok(`${deal.name}: the deal actually priced`, !!(r.d && r.d.sized), r.d && `${r.d.status} loan=${r.d.totalLoan} ${r.d.why}`);

    /* 1 ── NAMING */
    for (const m of (deal.must || [])) ok(`${deal.name}: "${m}" is printed`, all.includes(m));
    for (const m of (deal.mustNot || [])) {
      ok(`${deal.name}: a fee this deal does not carry is never printed — "${m}"`,
        !new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(all));
    }
    /* EVERY fee the calc says is charged has to appear by amount — the general form of the rule,
       so a fee added later is covered without anybody adding it here. */
    const AMOUNTS = { uwFee: 'underwriting & processing', legalFee: 'legal', settleFee: 'the settlement agent fee',
      cemaFee: 'the CEMA fee', feasFee: 'the construction review fee', creditFee: 'the credit report',
      titleCost: 'title / escrow', apprFee: 'the appraisal' };
    for (const [k, label] of Object.entries(AMOUNTS)) {
      const v = Number(r.d && r.d[k]);
      if (!(v > 0)) continue;
      const money = '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      ok(`${deal.name}: ${label} is printed at its amount (${money})`, all.includes(money));
    }

    /* 1b ── THE STRUCTURE SCREEN carries the same fees the sheet prints. */
    if (Number(r.d.feasFee) > 0) ok(`${deal.name}: the structure screen shows the construction review fee`, !!screen.feas, String(screen.feas));
    if (Number(r.d.settleFee) > 0) ok(`${deal.name}: the structure screen shows the settlement agent fee`, !!screen.settle, String(screen.settle));
    if (Number(r.d.cemaFee) > 0) ok(`${deal.name}: the structure screen shows the CEMA fee`, !!screen.cema, String(screen.cema));
    if (Number(r.d.govLines) > 0) ok(`${deal.name}: the structure screen lists the government charges`, !!screen.gov);
    ok(`${deal.name}: the structure screen states the cash to close`, !!screen.cash && screen.cash !== '—', String(screen.cash));
    ok(`${deal.name}: …and the liquidity to show`, !!screen.liquidity && screen.liquidity !== '—', String(screen.liquidity));
    /* RE-POINTED, NOT RELAXED. The panel used to carry ONE combined row plus a sub-line spelling
       both figures out — a total with an explanation. It now carries a row EACH, so this asserts
       both AMOUNTS are on screen and that the legal row still names its rung, which is strictly
       stronger than matching one sentence. The combined row survives only for a file with a typed
       whole-number total, and exactly one shape may ever be visible. */
    const bothHalves = /^\$[\d,]+\.\d\d$/.test(String(screen.uwFee || '')) && /^\$[\d,]+\.\d\d$/.test(String(screen.legalFee || ''));
    ok(`${deal.name}: …and names our fee's two halves`, bothHalves,
      `uw=${screen.uwFee} legal=${screen.legalFee}`);
    ok(`${deal.name}: …and the legal row is labelled, with its rung when it has one`,
      /^Legal fee( \(.+\))?$/.test(String(screen.legalLbl || '')), String(screen.legalLbl));
    if (/^Legal fee \(.+\)$/.test(String(screen.legalLbl || ''))) rungNamed.push(deal.name);
    ok(`${deal.name}: …and the old combined row is not showing at the same time`, !screen.combined,
      String(screen.combined));

    /* 2 ── NO LINE LANDS ON ANOTHER */
    const visible = r.items.filter((i) => !/^(255,255,255|#ffffff|1 1 1|FFFFFF)$/i.test(String(i.colour).trim()));
    const box = (i) => {
      const l = i.align === 'right' ? i.x - i.w : i.align === 'center' ? i.x - i.w / 2 : i.x;
      return { l, r: l + i.w, t: i.y - i.size * 0.78, b: i.y + i.size * 0.24 };
    };
    const collisions = [];
    for (const p of pages) {
      const it = visible.filter((i) => i.p === p);
      for (let a = 0; a < it.length; a++) {
        for (let b = a + 1; b < it.length; b++) {
          const A = box(it[a]), B = box(it[b]);
          const ox = Math.min(A.r, B.r) - Math.max(A.l, B.l);
          const oy = Math.min(A.b, B.b) - Math.max(A.t, B.t);
          if (ox > 2 && oy > 2) collisions.push({ p, a: it[a], b: it[b], ox, oy });
        }
      }
    }
    ok(`${deal.name}: no printed line lands on another`, collisions.length === 0,
      collisions.slice(0, 6).map((c) => `p${c.p} ${c.ox.toFixed(0)}x${c.oy.toFixed(0)}pt "${c.a.t.slice(0, 40)}" (y${c.a.y.toFixed(0)}) over "${c.b.t.slice(0, 40)}" (y${c.b.y.toFixed(0)})`).join(' | '));

    /* 3 ── NOTHING FALLS OFF THE BOTTOM */
    const bottom = r.pageH - 12;
    const overrun = visible.filter((i) => i.y > bottom && !FOOTER_RE.test(i.t));
    ok(`${deal.name}: nothing is printed past the bottom of the paper`, overrun.length === 0,
      overrun.slice(0, 6).map((i) => `p${i.p} y=${i.y.toFixed(0)} "${i.t.slice(0, 44)}"`).join(' | '));

    /* 3b ── AND NOTHING IS DOUBLE-STRUCK. The same string drawn twice at the same spot renders as
       smeared, slightly-bold text and is invisible to every other check. */
    const seen = new Map(); const dupes = [];
    for (const i of visible) {
      const key = `${i.p}|${i.t}|${i.x.toFixed(1)}|${i.y.toFixed(1)}`;
      if (seen.has(key)) dupes.push(i); else seen.set(key, 1);
    }
    ok(`${deal.name}: nothing is drawn twice in the same place`, dupes.length === 0,
      dupes.slice(0, 4).map((i) => `p${i.p} y=${i.y.toFixed(0)} "${i.t.slice(0, 44)}"`).join(' | '));

    /* 3c ── THE BUSINESS-PURPOSE STAMP IS ON EVERY PAGE. Owner-directed 2026-09-01:
       "every single one of your exports should say at the bottom, 'This is for
       business-purpose lending only.'" ONLY A RENDER PROVES THIS: the footer is
       drawn per page after the flow, precisely so a page the renderer adds
       mid-table cannot come out bare — and that invented page is the one at risk
       and the one no source test can see. Asserted page by page rather than once
       over the document, or a stamp on page 1 alone would read as compliant.
       Punctuation is stripped as well as space: the hyphen in "business-purpose"
       survives a whitespace squash, and a renderer may draw it as any dash. */
    const bare = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
    const unstamped = pages.filter((pg) => !bare(visible.filter((i) => i.p === pg).map((i) => i.t).join(''))
      .includes('businesspurposelendingonly'));
    ok(`${deal.name}: every page says "This is for business-purpose lending only."`, unstamped.length === 0,
      `missing on page ${unstamped.join(', ') || 'none'}`);

    console.log(`   ${r.items.length} strings · ${pages.length} pages · ${r.d.govLines} government charge lines`
      + ` · cash to close ${screen.cash} · liquidity ${screen.liquidity}`);
  }

  await browser.close();
  /* Four of the five fixtures sit on a NAMED rung (a ground-up, two New York deals, a NY
     ground-up). If that ever drops, the labels stopped saying WHY a fee is what it is — which is
     the whole reason the rung is printed. */
  ok(`the legal rung is named on the deals that have one (${rungNamed.length}/${DEALS.length})`,
    rungNamed.length >= 4, rungNamed.join(', '));

  if (fail) { console.log(`\nrender-fee-audit: ${fail} FAILURE(S), ${pass} passed`); process.exit(1); }
  console.log(`\nrender-fee-audit: all ${pass} checks passed.`);
})();
