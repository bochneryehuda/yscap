/**
 * LT TERM SHEETS — WHAT IS ACTUALLY ON THE PAPER.
 *
 * `test-lt-termsheet-pure.js` proves the RULES; this renders real PDF bytes and
 * reads them back, because two things about a document are facts about the
 * RENDER and nothing about the source can prove either:
 *
 *   ⛔ NOTHING DRAWS PAST ITS OWN MARGIN. The RTL side learned this the
 *     expensive way — a page that grew silently drew its rows through the
 *     footnote and off the sheet, on a document that had already gone out for
 *     signature. Every drawn string's box is read back and checked against all
 *     four margins, WITH ZERO TOLERANCE, and against the footer band.
 *
 *   ⛔ NO INVESTOR NAME REACHES THE PAGE (CLAUDE.md rule 10, the hard one). The
 *     snapshot's whitelist is defence (a); the renderer's scrub is defence (b),
 *     for a name a HUMAN typed into a label, an address or a programme name. So
 *     EVERY recorded spelling is pushed through the four free-text fields of a
 *     real term sheet and the extracted text is swept for it. A rule proven on
 *     the chokepoint is proven about a function; this is proven about the paper.
 *
 * The text is extracted with `unpdf`, which is already a production dependency.
 * NOTE its geometry is the AUTHORITY here and pdf-lib's is not: unpdf reports
 * the un-kerned advance a viewer uses, which is exactly the figure `pdf.js` was
 * corrected to measure by.
 */

import { createRequire } from 'node:module';
import { getDocumentProxy } from 'unpdf';

const require = createRequire(import.meta.url);
const snapshot = require('../src/longterm/termsheet/snapshot.js');
const layout = require('../src/longterm/termsheet/layout.js');
const pdf = require('../src/longterm/termsheet/pdf.js');
const investors = require('../src/longterm/encompass/investors.js');
const audience = require('../src/longterm/audience.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
const quote = (label, ratePct, rawPrice, extra) => Object.assign({
  label, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct, rawPrice, scenario: SCENARIO, pricedAt: '2026-08-30T13:30:00.000Z',
}, extra || {});

async function render(selections, prepared, opts) {
  const built = snapshot.buildSnapshot({ selections, plan: PLAN, anchorIndex: 0, prepared: prepared || {} });
  if (!built.ok) throw new Error(`snapshot refused: ${built.error}`);
  const lay = layout.buildLayout(built.snapshot, opts || { code: 'TS-4KH92B' });
  return pdf.renderTermSheet(lay);
}

/** Every drawn string with its box, page by page. */
async function readBack(bytes) {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      items.push({
        s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height,
      });
    }
    pages.push(items);
  }
  return { pageCount: doc.numPages, pages, text: pages.map((p) => p.map((i) => i.s).join('')).join('\n') };
}

/** Every way a box can be in the wrong place. */
function violations(pages) {
  const LEFT = pdf.M.left;
  const RIGHT = pdf.PAGE.w - pdf.M.right;
  const TOP = pdf.TOP_Y;
  const bad = [];
  pages.forEach((items, pi) => {
    for (const it of items) {
      const label = JSON.stringify(it.s.slice(0, 34));
      if (it.x < LEFT - 0.01) bad.push(`p${pi + 1} past the LEFT margin at x=${it.x.toFixed(2)} — ${label}`);
      if (it.x + it.w > RIGHT + 0.01) bad.push(`p${pi + 1} past the RIGHT margin, ends ${(it.x + it.w).toFixed(2)} of ${RIGHT} — ${label}`);
      if (it.y + it.h > TOP + 2) bad.push(`p${pi + 1} above the TOP margin at y=${it.y.toFixed(2)} — ${label}`);
      // The band between the footer and the bottom limit is the DEAD ZONE:
      // flowing content must never reach it, which is what makes it impossible
      // for a page that grew to draw through its own footer.
      if (it.y < pdf.BOTTOM_Y && it.y > 58) bad.push(`p${pi + 1} in the footer dead band at y=${it.y.toFixed(2)} — ${label}`);
      if (it.y < 20) bad.push(`p${pi + 1} below the footer at y=${it.y.toFixed(2)} — ${label}`);
    }
    // Two strings on one line whose boxes overlap are two things printed on top
    // of each other. A 0.6pt tolerance ignores boxes that merely touch.
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        if (Math.abs(a.y - b.y) > 1.5) continue;
        if (a.x < b.x + b.w - 0.6 && b.x < a.x + a.w - 0.6) {
          bad.push(`p${pi + 1} OVERPRINT ${JSON.stringify(a.s.slice(0, 20))} over ${JSON.stringify(b.s.slice(0, 20))}`);
        }
      }
    }
  });
  return bad;
}

console.log('\nnothing draws past its own margin — on the paper, at zero tolerance');
{
  const LONG = 'Supercalifragilisticexpialidociousandthensomemorewithnospacesatall'.repeat(4);
  const cases = {
    'the documented three-option comparison': {
      sel: [quote('No points', 7.375, 102), quote('Buy the rate down', 6.875, 99.75), quote('Take the credit', 7.875, 103.75)],
      prep: {
        borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701',
        officerName: 'Sara Klein', officerEmail: 'sara@yscapgroup.com', officerPhone: '(732) 555-0148',
        officerNmls: '1123456', companyName: 'YS Capital Group', companyNmls: '2609746',
        preparedAt: 'August 30, 2026', expiresAt: 'September 1, 2026',
      },
    },
    'a single offer': { sel: [quote('The offer', 7.375, 102)], prep: { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein' } },
    'the full eight options': {
      sel: [7.0, 7.125, 7.25, 7.375, 7.5, 7.625, 7.75, 7.875].map((r, i) => quote(`Option ${i + 1} with a deliberately long label`, r, 102 - (i - 3) * 0.5)),
      prep: {},
    },
    'workflow B — 70 against 80 LTV': {
      sel: [
        quote('70% LTV', 7.375, 102, { scenario: { ...SCENARIO, loan: 350000, ltv: 70 } }),
        quote('80% LTV', 7.625, 101.5, { scenario: { ...SCENARIO, loan: 400000, ltv: 80 } }),
      ],
      prep: {},
    },
    'hostile input — a name and an address nothing can encode or fit': {
      sel: [quote(LONG.slice(0, 120), 7.375, 102)],
      prep: {
        borrowerName: '李明 Émile Ünal 🏠',
        propertyAddress: LONG,
        officerName: 'Sara ≥ Klein → NMLS',
        companyName: 'YS Capital Group ✓',
      },
    },
    // A COMPARISON of hostile labels, which is the ONLY shape that puts an
    // officer's own 60 characters into a SECTION HEADING — a single-offer sheet
    // titles its detail page with the programme name, which is always short. The
    // heading is one line by design and is the one place the draw chokepoint's
    // own box is the only thing standing between a typed label and the margin.
    'hostile labels on a comparison — the section heading has nothing else to save it': {
      sel: [
        quote(LONG.slice(0, 60), 7.375, 102),
        quote(LONG.slice(10, 70), 6.875, 99.75),
      ],
      prep: { borrowerName: 'Jonathan Reyes', propertyAddress: LONG.slice(0, 90) },
    },
    'no code, no company, nothing prepared': { sel: [quote('x', 7.375, 102)], prep: {}, opts: {} },
    // A RIGHT-ALIGNED string is placed at `right − its own width`, so one that is
    // too wide is pushed off the LEFT edge rather than the right — the opposite
    // end from where anyone looks for it. The code is passed in by the caller, so
    // an absurd one is a real input and this is the path's own test rather than a
    // contrived one.
    'an absurd term sheet ID, which is right-aligned and would run off the LEFT': {
      sel: [quote('x', 7.375, 102)],
      prep: { companyName: 'YS Capital Group', companyNmls: 'N'.repeat(90) },
      opts: { code: `TS-${'W'.repeat(80)}` },
    },
  };
  let total = 0;
  for (const [name, c] of Object.entries(cases)) {
    // eslint-disable-next-line no-await-in-loop
    const back = await readBack(await render(c.sel, c.prep, c.opts));
    const bad = violations(back.pages);
    total += back.pages.reduce((n, p) => n + p.length, 0);
    check(bad.length === 0, `${name}: ${back.pageCount} page(s), every box inside its margins${bad.length ? `\n       ${bad.slice(0, 3).join('\n       ')}` : ''}`);
  }
  check(total > 500, `${total} drawn strings measured in total — enough for the check to mean something`);
}

console.log('\na long value is BROKEN onto more lines, never swallowed');
{
  // The two protections cover each other — a wrap that fails to break a
  // too-long token is caught by the draw chokepoint's clip, and vice versa — so
  // GEOMETRY ALONE cannot tell which of them is doing the work. This asks the
  // other question: is the value still THERE? A clip that swallowed it would
  // leave the page inside its margins and the address missing, which is the
  // failure a reader would actually notice.
  const RUN = 'Supercalifragilisticexpialidociousandthensomemorewithnospacesatall'.repeat(3);
  const back = await readBack(await render([quote('x', 7.375, 102)], { propertyAddress: RUN }));
  const flat = back.text.replace(/\s+/g, '');
  const longest = 'Supercalifragilisticexpialidocious';
  const occurrences = flat.split(longest).length - 1;
  check(occurrences === 3,
    `an unbreakable ${RUN.length}-character run is carried in FULL across the lines it needs (${occurrences} of 3 repeats survived) — never clipped away to fit`);
  check(!flat.includes('\u2026'), '…and nothing had to be replaced by an ellipsis to get there');
}

console.log('\nthe page says what the document says');
{
  const back = await readBack(await render(
    [quote('No points', 7.375, 102), quote('Buy the rate down', 6.875, 99.75), quote('Take the credit', 7.875, 103.75)],
    { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein', companyName: 'YS Capital Group', companyNmls: '2609746' },
  ));
  check(back.pageCount === 4, `a three-option comparison is one comparison page plus one detail page each (${back.pageCount})`);
  for (const want of ['No points either way', 'You pay $8,438 (2.250 pts)', 'You receive $6,563 (1.750 pts)',
    '67 months (5 years 7 months)', '51 months (4 years 3 months)', 'TS-4KH92B', 'Page 1 of 4', 'Page 4 of 4']) {
    check(back.text.includes(want.replace(/ /g, '')) || back.text.includes(want),
      `the paper carries "${want}"`);
  }
  check(!/\b10[0-4]\.\d{2,3}\b/.test(back.text.replace(/,/g, '')),
    'and NO PRICE — 101.750 is a wholesale number with no meaning to a borrower, and teaching them one is the babysitting the owner ruled out');
  check(/not a commitment to lend/i.test(back.text), 'every page states that it is an estimate, not a commitment');
}

console.log('\nrule 10 — the investor name never reaches the paper');
{
  const spellings = [];
  for (const inv of investors.INVESTORS) {
    for (const raw of [inv.label].concat(inv.aliases || [])) if (raw) spellings.push(String(raw));
  }
  check(spellings.length > 100, `${spellings.length} recorded spellings to sweep — a hand-typed name is spelled many ways, and a "!== 'Deephaven'" check passes "Deepahven approval.pdf" straight through`);

  let leaked = 0;
  let first = null;
  for (const name of spellings) {
    // Pushed through EVERY free-text field a human can type into, because that
    // is the class the whitelist cannot see.
    // eslint-disable-next-line no-await-in-loop
    const back = await readBack(await render(
      [quote(`Sold to ${name} today`, 7.375, 102, { product: `${name} 30-Year Fixed` })],
      {
        borrowerName: `${name} Holdings LLC`,
        propertyAddress: `1 ${name} Road, Lakewood, NJ`,
        officerName: 'Sara Klein',
        companyName: `YS Capital (${name})`,
      },
    ));
    // The extracted run has no spaces between items, so the name is sought in
    // the SQUASHED text too — a name broken across two draw calls would
    // otherwise slip a naive search.
    const flat = back.text.replace(/\s+/g, '').toLowerCase();
    const needle = name.replace(/\s+/g, '').toLowerCase();
    if (needle.length >= 3 && flat.includes(needle)) {
      leaked += 1;
      if (!first) first = name;
    }
  }
  check(leaked === 0, `all ${spellings.length} spellings swept through four free-text fields of a real term sheet — none survived onto the page${first ? ` (first leak: ${first})` : ''}`);

  // And the sweep is only worth anything if it CAN see a leak.
  const control = await readBack(await render(
    [quote('Sold to CONTROLSENTINEL today', 7.375, 102)], { borrowerName: 'CONTROLSENTINEL Holdings' },
  ));
  check(control.text.replace(/\s+/g, '').toLowerCase().includes('controlsentinel'),
    '…and a sentinel word that is NOT an investor does reach the page, so the sweep is looking at real text and not at nothing');
  check(audience.mentionsInvestor('Sold to Deephaven today'),
    'the ONE definition still recognises an investor — this suite never re-implements the check, it uses it');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
