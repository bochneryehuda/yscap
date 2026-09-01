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
 *     EVERY recorded spelling is pushed through the five free-text fields of a
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
const brand = require('../src/longterm/termsheet/brand.js');
const fs = require('fs');

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
  const lay = layout.buildLayout(built.snapshot, { code: 'TS-4KH92B', expiryHours: 24, ...(opts || {}) });
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
/**
 * ⛔ THE PAPER HAS THREE ZONES, AND A STRING MUST SIT WHOLLY INSIDE ONE OF THEM.
 *
 * The brand band and the footer are PAGE FURNITURE — drawn over every page after
 * the flow, deliberately outside the content box — so a single "inside the
 * margins" box would flag the document's own branding as a defect. What actually
 * must never happen is a string landing in NO zone: between the content floor and
 * the footer (content that grew through its own footer — the RTL failure this
 * whole renderer is built against), between the content ceiling and the band, or
 * off the paper entirely.
 *
 * The zones come from `pdf.ZONES`, not from numbers retyped here: a test carrying
 * its own copy of the layout passes the day the layout moves.
 */
function violations(pages) {
  const LEFT = pdf.M.left;
  const RIGHT = pdf.PAGE.w - pdf.M.right;
  const Z = pdf.ZONES;
  const zoneOf = (it) => {
    const bottom = it.y;
    const top = it.y + it.h;
    for (const [name, z] of Object.entries(Z)) {
      if (bottom >= z.bottom - 0.5 && top <= z.top + 2) return name;
    }
    return null;
  };
  const bad = [];
  pages.forEach((items, pi) => {
    for (const it of items) {
      const label = JSON.stringify(it.s.slice(0, 34));
      // The side margins hold in EVERY zone. Only filled rectangles bleed to the
      // paper edge, and a rectangle is not a string.
      if (it.x < LEFT - 0.01) bad.push(`p${pi + 1} past the LEFT margin at x=${it.x.toFixed(2)} — ${label}`);
      if (it.x + it.w > RIGHT + 0.01) bad.push(`p${pi + 1} past the RIGHT margin, ends ${(it.x + it.w).toFixed(2)} of ${RIGHT} — ${label}`);
      const zone = zoneOf(it);
      if (!zone) bad.push(`p${pi + 1} in NO zone — y=${it.y.toFixed(2)}..${(it.y + it.h).toFixed(2)} — ${label}`);
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
  // ⛔ ASSERTED AS THE PROPERTY, NOT AS A PAGE COUNT. "One detail page each" is
  // the owner's "it's just adding pages to it"; a hard-coded 4 would fail the day
  // a disclosure paragraph gets one line longer, and would then be "fixed" by
  // bumping the number — which is how a real regression gets waved through.
  // Squashed AND case-folded: a section band is set in tracked capitals, which
  // pdf-lib emits one character per draw call, so the extracted run carries no
  // spaces and no lower case.
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();
  const pagesWith = (needle) => back.pages
    .map((items, i) => (squash(items.map((it) => it.s).join('')).includes(squash(needle)) ? i : -1))
    .filter((i) => i >= 0);
  const LABELS = ['No points', 'Buy the rate down', 'Take the credit'];
  const where = LABELS.map(pagesWith);
  // Every label appears on the COMPARISON page, in its table column — so the
  // detail page is the OTHER one it appears on. Asserting "the first page that
  // mentions it" would have been satisfied by the table alone and proved nothing
  // about the detail pages existing at all.
  check(where.every((p) => p.includes(0)), 'every option is named in the comparison table on page one');
  /* ⛔ REVERSED 2026-08-31, ON THE OWNER'S OWN REPORT — and this is the render
     half of the same reversal `test-lt-termsheet-pure.js` carries. These three
     asserted a detail page per option, which is what the document did and what
     the owner then read: *"everything is way too big … just thrown on the sheet
     without an order."* MEASURED, those pages were three of a seven-page
     comparison, and every figure on them already sat in the table above. What
     replaces them is not "less detail" — the table grew to carry it, and
     `test-lt-sheet-nothing-lost-pure.js` fails the build on a fact that stopped
     being printed. So the property asserted here inverts: every option is named
     ON the comparison, and NO option gets a page to itself. */
  const details = where.map((p) => p.filter((i) => i > 0));
  check(details.every((p) => p.length === 0),
    'and NO option has a page of its own — the per-option repeat is what made this seven pages');
  check(back.pageCount <= 4,
    `and the whole comparison, disclosures included, fits ${back.pageCount} pages (was 7 for three options)`);
  /* Whitespace-insensitive on BOTH sides, like `squash` above. The extractor
     reports the advance a viewer uses, so a run drawn inside a table cell can
     come back as "(1.750pts)" where the same string in a figures row came back
     spaced — a fact about kerning, not about the paper. Comparing text to a
     particular extraction's spacing fails on a layout change and proves nothing
     about what a reader sees. */
  const carries = (want) => squash(back.text).includes(squash(want));
  for (const want of ['You pay $8,438 (2.250 pts)', 'You receive $6,563 (1.750 pts)',
    '67 months (5 years 7 months)', '51 months (4 years 3 months)', 'TS-4KH92B',
    `Page 1 of ${back.pageCount}`, `Page ${back.pageCount} of ${back.pageCount}`]) {
    check(carries(want), `the paper carries "${want}"`);
  }
  // ⛔ THE OWNER'S OWN BUG, ASSERTED ON THE PAPER. The sheet used to print
  //     At closing                       No points either way
  //     Origination fee (2.000 points)   $7,500
  // — two true lines and a document that contradicted itself, because the value
  // answered what the RATE costs while its label promised the whole closing
  // position. Only a rendered page can prove the pair is gone; a block-list test
  // cannot see what ended up printed next to what.
  check(carries('Cost to get this rate'),
    'the rate\'s own cost is labelled for what it is about — the rate');
  check(carries('Lender charges, net'),
    '…and the whole closing position is a separate figure with its own honest label');
  check(!/Atclosing.{0,40}Nopointseitherway/.test(back.text.replace(/\s+/g, '')),
    '…and the pair the owner read — a par phrase under a closing label — cannot occur');
  check(!/\b10[0-4]\.\d{2,3}\b/.test(back.text.replace(/,/g, '')),
    'and NO PRICE — 101.750 is a wholesale number with no meaning to a borrower, and teaching them one is the babysitting the owner ruled out');
  check(/not a commitment to lend/i.test(back.text), 'every page states that it is an estimate, not a commitment');
}


console.log('\nthe PILOT design is on every page — the band, the lockup, the footer');
{
  // ⛔ ONLY A RENDER CAN PROVE THIS. The band and the footer are page FURNITURE:
  // they are drawn over the whole page list after the flow, precisely so a page
  // the renderer adds mid-table cannot come out bare. A block-list test cannot
  // see a page the flow invented, which is the exact page at risk.
  const bytes = await render(
    [7.0, 7.125, 7.25, 7.375, 7.5].map((r, i) => quote(`Option ${i + 1}`, r, 102 - (i - 2) * 0.5)),
    {
      borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701',
      officerName: 'Sara Klein', officerEmail: 'sara@yscapgroup.com', officerPhone: '(732) 555-0148',
      companyName: 'YS Capital Group', companyNmls: '2609746', preparedAt: 'August 30, 2026 9:14 AM',
    },
  );
  const back = await readBack(bytes);
  const Z = pdf.ZONES;
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();

  let bandless = [];
  let footerless = [];
  back.pages.forEach((items, i) => {
    const inBand = items.filter((it) => it.y >= Z.band.bottom);
    const inFoot = items.filter((it) => it.y + it.h <= Z.footer.top);
    if (!squash(inBand.map((it) => it.s).join('')).includes('comparisonsheet')) bandless.push(i + 1);
    if (!squash(inFoot.map((it) => it.s).join('')).includes('notacommitmenttolend')) footerless.push(i + 1);
  });
  /* The band-and-footer sweep below needs MORE THAN ONE page to be worth
     running: what it proves is that a page produced by a BREAK cannot come out
     bare. It used to get them from the per-option repeat, which is gone, and
     then from five options at the old type size.

     ⛔ IT SAYS 2, AND IT SAID 3 UNTIL THE SHEET WAS RE-SET TO THE APPROVED
     DESIGN. That is the number moving because the DOCUMENT got shorter — the
     same five options now fit in two pages rather than three — not a guard
     loosened to let a change through: the sweep still runs over every page of a
     multi-page document, which is the whole of what it was written to do, and
     its own comment has always said "more than one page". If it ever falls to
     1, the sweep has stopped proving anything and the fixture needs more
     content, not a smaller number. */
  check(back.pageCount >= 2, `a five-option comparison runs to ${back.pageCount} pages — enough for the band-and-footer sweep to mean something`);
  check(bandless.length === 0, `the brand band names the document on EVERY page (missing on ${bandless.join(', ') || 'none'})`);
  check(footerless.length === 0, `and the footer disclaims on EVERY page (missing on ${footerless.join(', ') || 'none'})`);

  // Every page numbers itself, and the count is the real one.
  let misnumbered = [];
  back.pages.forEach((items, i) => {
    if (!squash(items.map((it) => it.s).join('')).includes(squash(`Page ${i + 1} of ${back.pageCount}`))) misnumbered.push(i + 1);
  });
  check(misnumbered.length === 0, `every page numbers itself correctly (wrong on ${misnumbered.join(', ') || 'none'})`);

  // ⛔ THE LOCKUP IS ON THE PAPER, not merely referenced. The owner asked for it
  // by name — "Make sure to include our logos and our designs" — and an image
  // that failed to embed leaves a branded band with a hole in it, which reads as
  // a broken document rather than as a missing decoration.
  const raw = Buffer.from(bytes).toString('latin1');
  const images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
  check(images >= 1, `the lockup is embedded in the document (${images} image object(s))`);
  check(brand.logoBytes() && brand.logoBytes().length > 1000,
    'and the asset it comes from is a real PNG on disk, not a placeholder');

  // ⛔ AND IT DEGRADES RATHER THAN FAILING. A term sheet that will not render is
  // a term sheet that did not go out, and the officer was already told it was
  // issued — so an unreadable asset must cost the logo and nothing else.
  const realPath = brand.LOGO_PATH;
  const saved = fs.readFileSync(realPath);
  try {
    fs.writeFileSync(realPath, Buffer.from('not a png at all'));
    delete require.cache[require.resolve('../src/longterm/termsheet/brand.js')];
    delete require.cache[require.resolve('../src/longterm/termsheet/pdf.js')];
    const brand2 = require('../src/longterm/termsheet/brand.js');
    const pdf2 = require('../src/longterm/termsheet/pdf.js');
    check(brand2.logoBytes() === null, 'a corrupt lockup file is refused before it reaches the embedder');
    const lay = layout.buildLayout(snapshot.buildSnapshot({
      selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: { borrowerName: 'Jonathan Reyes' },
    }).snapshot, { code: 'TS-4KH92B', expiryHours: 24 });
    const degraded = await pdf2.renderTermSheet(lay);
    const back2 = await readBack(degraded);
    check(back2.pageCount >= 1, 'the sheet still renders without it');
    check(squash(back2.text).includes('yscapital'),
      '…and the wordmark is SET IN TYPE instead, so the band is never a hole');
  } finally {
    fs.writeFileSync(realPath, saved);
    delete require.cache[require.resolve('../src/longterm/termsheet/brand.js')];
    delete require.cache[require.resolve('../src/longterm/termsheet/pdf.js')];
  }
}

console.log('\nthe owner\'s four items, on the paper');
{
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();
  const FULL = {
    borrowerName: 'Riverbend Holdings LLC', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701',
    officerName: 'Sara Klein', companyName: 'YS Capital Group', companyNmls: '2609746',
    preparedAt: 'August 30, 2026 9:14 AM', expiresAt: 'August 31, 2026 9:14 AM',
  };
  const ts = await readBack(await render([quote('The offer', 7.375, 102)], FULL, { expiryHours: 24 }));
  const flat = squash(ts.text);

  // (1) THE FULL PROPERTY ADDRESS AND THE PERSON'S NAME — the owner asked to be
  // able to put both on the sheet, and a term sheet is refused without them.
  check(flat.includes(squash('Riverbend Holdings LLC')), 'the borrower\'s name is on the paper');
  check(flat.includes(squash('218 Forest Avenue, Lakewood, NJ 08701')), 'and the full property address');

  // (2) PITI — "we also need to add something for principal, interest, taxes,
  // and insurance, only if the taxes and insurance were entered".
  check(flat.includes(squash('Total monthly payment (principal, interest, taxes & insurance)')),
    'the total monthly payment names all four things it is the total of');
  const bare = { ...SCENARIO, taxMonthly: null, insuranceMonthly: null };
  const noPiti = await readBack(await render(
    [quote('A', 7.375, 102, { scenario: bare }), quote('B', 6.875, 99.75, { scenario: bare })], FULL,
  ));
  check(!squash(noPiti.text).includes(squash('Total monthly payment')),
    '…and a sheet with no taxes and no insurance carries NO total — not a partial one wearing the right label');

  // (3) THE ORIGINATION FEE, BROKEN DOWN.
  check(flat.includes(squash('2.000 points of the $375,000 loan amount')),
    'the origination fee shows the multiplication that produced it');

  // (4) THE LENDER FEES, LISTED — so the waived column can be compared against
  // the charged one.
  const waived = await readBack(await render([
    quote('Pays the fees', 7.375, 102),
    quote('Fees waived', 7.875, 103.75, { mode: 'lenderPaid', waiveLenderFees: true }),
  ], FULL));
  const wflat = squash(waived.text);
  check(wflat.includes(squash('Application fee')) && wflat.includes(squash('Commitment fee')),
    'both lender fees are named on the paper');
  /* The per-fee cells price it ("Waived ($500)") and the table totals what it
     saves; this sentence is the part that says WHO is paying instead, which is
     what a borrower reads a term sheet to learn. It moved from the retired
     per-option page onto the comparison itself. */
  check(wflat.includes(squash('covered by the lender, not paid by you')),
    '…and a sentence on the sheet says the lender is covering them, not the borrower');
  check(wflat.includes(squash('Waived ($500)')) && wflat.includes(squash('Waived ($1,595)')),
    '…and each fee is named at what it would have been, beside the option that charges it');
  check(wflat.includes(squash('Lender fees you are not paying')), '…and the saving is totalled');

  // (5) THE EXPIRY, in the owner's own unit.
  check(flat.includes(squash('This term sheet expires in 24 hours')),
    'the term sheet says it expires in 24 HOURS — the unit is the message');

  // (6) SIGNABLE, AND ONLY THE TERM SHEET.
  /* RE-POINTED 2026-08-31: the approved sketch sets a signature line as
     "<name> — <role>", so the combined role reads "borrower and guarantor". The
     property — a term sheet has a line to sign and nothing else does — is
     unchanged and is what is asserted. */
  check(flat.includes(squash('borrower and guarantor')), 'a term sheet has somewhere to sign');
  check(!wflat.includes(squash('Borrower / guarantor')),
    'and a comparison has none — a signature under two columns records agreement to nothing in particular');

  // (7) THE DISCLOSURES, on both.
  check(flat.includes(squash('Business purpose only')) && wflat.includes(squash('Business purpose only')),
    'both carry the disclosures page');
}

console.log('\nrule 10 — the investor name never reaches the paper');
{
  const spellings = [];
  for (const inv of investors.INVESTORS) {
    for (const raw of [inv.label].concat(inv.aliases || [])) if (raw) spellings.push(String(raw));
  }
  check(spellings.length > 100, `${spellings.length} recorded spellings to sweep — a hand-typed name is spelled many ways, and a "!== 'Deephaven'" check passes "Deepahven approval.pdf" straight through`);

  // ⛔ A DIFFERENTIAL SWEEP, NOT A SUBSTRING SEARCH — and the difference matters
  // more the more prose the document carries. A short alias is a substring of
  // ordinary English: "Roc" lives inside "p-roc-essing", which the disclosures
  // page says in "the lender underwriting and processing fees". A naive search
  // for the squashed needle therefore reports a leak on a page where the name was
  // scrubbed perfectly and the word "processing" simply exists — a FALSE POSITIVE
  // that would be "fixed" by shortening the guard, which is exactly how a real
  // leak gets waved through.
  //
  // So the same document is rendered TWICE: once with the investor's name in
  // every free-text field, once with a neutral placeholder of the same shape.
  // The boilerplate contributes identically to both, so any INCREASE in how often
  // the needle occurs is the injected name surviving — and nothing else can be.
  const sweepText = async (name) => {
    const back = await readBack(await render(
      [quote(`Sold to ${name} today`, 7.375, 102, { product: `${name} 30-Year Fixed` })],
      {
        borrowerName: `${name} Holdings LLC`,
        // ⛔ THE VESTING ENTITY IS SWEPT TOO, and it is the field most likely to
        // carry an investor's name by accident: an officer typing who the loan
        // is going into is one keystroke from typing who is buying it. It rides
        // `preparedFor` onto the "prepared for" line AND onto its own signature
        // line, so a leak here would reach the page twice.
        entityName: `${name} Capital Partners LLC`,
        propertyAddress: `1 ${name} Road, Lakewood, NJ`,
        officerName: 'Sara Klein',
        companyName: `YS Capital (${name})`,
      },
    ));
    // The extracted run has no spaces between items, so the name is sought in
    // the SQUASHED text — a name broken across two draw calls would otherwise
    // slip a naive search.
    return back.text.replace(/\s+/g, '').toLowerCase();
  };
  const occurrences = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
  const CONTROL = 'Wexlaton';   // a word no investor is called and no prose contains
  const controlText = await sweepText(CONTROL);

  let leaked = 0;
  let first = null;
  for (const name of spellings) {
    const needle = name.replace(/\s+/g, '').toLowerCase();
    if (needle.length < 3) continue;
    // eslint-disable-next-line no-await-in-loop
    const flat = await sweepText(name);
    if (occurrences(flat, needle) > occurrences(controlText, needle)) {
      leaked += 1;
      if (!first) first = name;
    }
  }
  // ⛔ AND THE SWEEP IS PROVEN TO BITE. A differential that could never report a
  // leak would pass forever; the control name is not an investor, so it MUST
  // survive onto the page and be counted.
  check(occurrences(controlText, CONTROL.toLowerCase()) > 0,
    `the sweep can see an injected name at all — the control "${CONTROL}" reaches the page ${occurrences(controlText, CONTROL.toLowerCase())} times`);
  check(leaked === 0, `all ${spellings.length} spellings swept through five free-text fields of a real term sheet — none survived onto the page${first ? ` (first leak: ${first})` : ''}`);

  // And the sweep is only worth anything if it CAN see a leak.
  const control = await readBack(await render(
    [quote('Sold to CONTROLSENTINEL today', 7.375, 102)], { borrowerName: 'CONTROLSENTINEL Holdings' },
  ));
  check(control.text.replace(/\s+/g, '').toLowerCase().includes('controlsentinel'),
    '…and a sentinel word that is NOT an investor does reach the page, so the sweep is looking at real text and not at nothing');
  // ⛔ AND THE SAME PROOF FOR THE ENTITY, ON ITS OWN. Sweeping a field the page
  // never draws proves NOTHING — it would report "no leak" for ever while the
  // field went unscrubbed somewhere else. So the vesting entity is shown to
  // reach the paper under its own sentinel, separately from the borrower's name.
  //
  // ⛔ AND IT IS ASSERTED ON PAGE ONE SPECIFICALLY, not on "somewhere in the document". The entity
  // reaches the paper TWICE — the "prepared for" block on page 1 and its signature line on the
  // last — so a check for the word anywhere passes while the recipient block silently drops it.
  // MEASURED: unmutated it is on pages 1 and 3; with the PDF reverted to printing `borrowerName`
  // alone, page 1 loses it and the loose check still passed. Page one is the claim.
  const entityControl = await readBack(await render(
    [quote('The offer', 7.375, 102)], { entityName: 'ENTITYSENTINEL Capital LLC' },
  ));
  const entityOnPage1 = (entityControl.pages[0] || []).map((i) => i.s).join('')
    .replace(/\s+/g, '').toLowerCase().includes('entitysentinel');
  check(entityOnPage1,
    '…and the VESTING ENTITY is printed in the "prepared for" block on page one, so sweeping it sweeps a field the reader actually sees');
  check(audience.mentionsInvestor('Sold to Deephaven today'),
    'the ONE definition still recognises an investor — this suite never re-implements the check, it uses it');
}

console.log('\nthe compensation never reaches the paper — the OTHER hard invisibility rule');
{
  // ⛔ WHY THIS EXISTS. Owner-directed 2026-08-23: *"adding a charge on the fee breakdown
  // for two points origination only and keeping the YSP invisible. The lender-paid
  // compensation should always also be kept invisible on both of the sides."* That is as
  // hard a rule as rule 10 above, on the same document — and until 2026-08-30 it was
  // enforced by nothing. The behaviour was correct; a comment said so; no test held it.
  //
  // ⛔ THE ONE THING THAT IS *NOT* SECRET, and confusing the two is how this guard would be
  // written wrong: in BORROWER-PAID the comp IS the origination fee, so it MUST be printed.
  // What must never appear is the YSP, and the lender-paid comp in either position.
  //
  // The figures are deliberately odd (2.875 / 1.375 / 3.625) so a hit is unmistakable — a
  // plan of 2 / 0 / 2 would collide with ordinary prices, rates and term counts all over
  // the page and could not tell a leak from a coincidence.
  const SECRET_PLAN = { borrowerPaid: 2.875, ysp: 1.375, lenderPaid: 3.625, applicationFee: 1595, commitmentFee: 500 };
  const words = ['compensation', 'lender-paid', 'borrower-paid', 'yield spread', 'ysp', 'comp plan'];

  for (const [mode, price, waive] of [['borrowerPaid', 101.5, false], ['lenderPaid', 104, true]]) {
    const built = snapshot.buildSnapshot({
      selections: [quote('Lender A', 7.25, price, { mode, waiveLenderFees: waive })],
      plan: SECRET_PLAN, anchorIndex: 0, prepared: {},
    });
    if (!built.ok) { check(false, `a ${mode} sheet could be built (${built.error})`); continue; }
    const lay = layout.buildLayout(built.snapshot, { code: 'TS-COMP', expiryHours: 24 });
    const bytes = await pdf.renderTermSheet(lay);
    const { text } = await readBack(bytes);
    const low = text.toLowerCase();

    // The sweep is worth nothing if the page is empty or the fixture never priced.
    check(text.length > 2000 && text.includes('7.25'),
      `the ${mode} sheet really rendered (${text.length} characters, and it carries its own rate)`);
    check(!low.includes('1.375'),
      `the YSP never reaches a ${mode} page — the owner's "keeping the YSP invisible"`);
    check(!low.includes('3.625'),
      `and neither does the lender-paid compensation — "invisible on both of the sides"`);
    for (const w of words) {
      check(!low.includes(w), `and the page never says "${w}" on a ${mode} sheet`);
    }
    // THE OTHER DIRECTION, so this can never pass by rendering nothing: in borrower-paid
    // the comp IS the origination and MUST be on the page.
    if (mode === 'borrowerPaid') {
      check(low.includes('2.875') && /origination/i.test(text),
        'while the borrower-paid comp IS printed, as the origination fee it actually is — the sweep is reading a real fee list, not an empty page');
    } else {
      check(!low.includes('2.875'),
        'and on a lender-paid sheet there is no origination at all, so that figure is absent too');
    }
  }
}

// =============================================================================
console.log('\nthe paper reads like a document, not like a database');
// =============================================================================
// Owner-reported 2026-08-31: all three sheets are *"very ugly and very abrupt.
// It needs to be done a lot more cleanly, more user-friendly, and more modern."*
// Two of the things that made them read that way are facts about the RENDER, so
// they are proven here and not on the source.
{
  const PREP = {
    borrowerName: 'Jonathan Reyes', entityName: 'Maple Holdings LLC',
    propertyAddress: '128 Maple Avenue, Lakewood, NJ 08701',
    officerName: 'Chaim Stern', companyName: 'YS Capital Group', companyNmls: '2609746',
    preparedAt: '2026-08-31T14:00:00.000Z', expiresAt: '2026-09-01T14:00:00.000Z',
  };
  const docs = {
    'term sheet': [quote('The offer', 7.375, 102)],
    'comparison sheet': [quote('A', 7.375, 102), quote('B', 7.625, 101.25), quote('C', 7.875, 100.5)],
  };

  /* ⛔ NOT ONE STORED TIMESTAMP REACHES A BORROWER'S PAGE. Every sheet we have
     ever sent carried `Issued 2026-08-31T14:00:00.000Z` in the brand band AND
     again in the footer of EVERY page, and the expiry callout — the one line
     whose whole job is urgency — read *"Good through
     2026-09-01T14:00:00.000Z."* This sweeps the drawn strings rather than the
     source, so a producer added later is covered without knowing this exists.
     The date is still THERE, in words: the control below proves the sweep is
     looking at a page that really does carry one. */
  const ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  for (const [name, sels] of Object.entries(docs)) {
    const back = await readBack(await render(sels, PREP));
    const hits = back.pages.flatMap((items, i) => items.filter((it) => ISO.test(it.s)).map((it) => `p${i + 1} "${it.s}"`));
    check(hits.length === 0, `${name}: no stored timestamp is printed anywhere${hits.length ? ` — ${hits.slice(0, 3).join(', ')}` : ''}`);
    check(/August 31, 2026/.test(back.text),
      `${name}: …and the date is on the page in words, so the sweep is not passing on an empty document`);
  }

  /* ⛔ THE COMPARISON TABLE STAYS ON ONE PAGE. The whole value of a comparison is
     the options standing side by side where a reader can run an eye down them; a
     table split across a page boundary has stopped being one. It is asserted on
     the DSCR row — the LAST row of the table — landing on the same page as the
     first, because a split shows up as the tail rows moving. */
  const cmp = await readBack(await render(docs['comparison sheet'], PREP));
  const pageOf = (needle) => cmp.pages.findIndex((items) => items.map((i) => i.s).join('').replace(/\s+/g, '').toLowerCase()
    .includes(needle.replace(/\s+/g, '').toLowerCase()));
  check(pageOf('Program') === 0 && pageOf('DSCR') === 0,
    `the comparison table is whole on page one (first row p${pageOf('Program') + 1}, last row p${pageOf('DSCR') + 1})`);

  /* ⛔ A ROW LABEL FITS ITS OWN COLUMN. The column was sized to the widest label
     plus 8 while the cell gave 12 back to padding, so the longest label in every
     table this renderer has ever drawn wrapped onto a second line — beside data
     columns with room to spare. This is asserted on the DRAWN strings, because
     the arithmetic is exactly what was wrong: a source check would have agreed
     with the bug. */
  const drawn = (cmp.pages[0] || []).map((i) => i.s);
  for (const label of ['Total monthly payment', 'Estimated cash to close']) {
    check(drawn.includes(label), `"${label}" is drawn on one line, not broken across two`);
  }

  /* THE COMPARISON SAYS WHEN ITS PRICING DIES, AND NAMES ITSELF WHILE DOING IT
     (owner-directed 2026-08-31). Asserted on the PAPER, and on page ONE with the
     table intact -- the reason the clock could not be added before was that it
     pushed the table onto a second page, so "it fits" is half the requirement. */
  const p1cmp = (cmp.pages[0] || []).map((i) => i.s).join(' ').replace(/\s+/g, ' ');
  check(/This comparison sheet expires in \d+ hours\./.test(p1cmp),
    'the comparison sheet states its own expiry, on page one, beside the table');
  check(!/This term sheet expires/.test(p1cmp),
    'and never calls itself a term sheet -- the one thing a comparison must not be mistaken for');

  /* ⛔ THE HEADLINE IS ON THE PAGE, AND IT AGREES WITH THE TABLE UNDER IT. A
     summary that restates is safe; one that computes is a second opinion on a
     document somebody signs. */
  const ts = await readBack(await render(docs['term sheet'], PREP));
  const p1 = (ts.pages[0] || []).map((i) => i.s).join(' ').replace(/\s+/g, ' ');
  check(/LOAN AMOUNT/i.test(p1) && /INTEREST RATE/i.test(p1) && /MONTHLY PAYMENT/i.test(p1),
    'the term sheet opens with the loan, the rate and the payment, before the tables');
  check(/\$375,000/.test(p1) && /7\.375%/.test(p1),
    '…stating the same figures the table below states, never a second calculation');

  // ── the design, on the paper ──────────────────────────────────────────────
  console.log('\nthe sheet is set the way the approved design is set');

  /* ⛔ THE LOAN AND ITS MONTHLY PAYMENT ARE SIDE BY SIDE, AND THIS IS THE ONLY
     WAY TO PROVE IT. `layout.js` can ASK for two columns; `pdf.js` falls back to
     one whenever the pair could not be drawn safely, and both are valid
     documents — so a source check on the request proves nothing about the page.
     In one column the payment rows come strictly BELOW the loan rows; in two,
     the payment's first row sits HIGHER on the same page than the loan's last.
     That single comparison cannot be true of a fallback, so it is the assertion.
     MEASURED: this is what takes the sheet from three sheets to two on a real
     file, and it is the design's own page one. */
  const at = (page, label) => (ts.pages[page] || []).find((i) => i.s.trim() === label);
  const prepay = at(0, 'Prepayment');
  const pandi = at(0, 'Principal & interest');
  check(!!prepay && !!pandi, 'the loan and the payment are both on page one');
  if (prepay && pandi) {
    check(pandi.y > prepay.y,
      `the payment column starts ABOVE the loan column's last row (${pandi.y.toFixed(0)} vs ${prepay.y.toFixed(0)}) — two columns, not one`);
    check(pandi.x > prepay.x + 150,
      `…and to the right of it (x ${pandi.x.toFixed(0)} vs ${prepay.x.toFixed(0)})`);
  }

  /* ⛔ NOTHING IN THE CONTENT IS CLIPPED. `clip()` ends a string it could not fit
     with an ellipsis, which on a label reads as a rendering fault rather than as
     a shortened word — and it is a SILENT failure, because the page still draws.
     It went unnoticed for as long as every row had the full content column: the
     moment a column was half as wide, "Total monthly payment (principal,
     interest, taxes & insurance)" drew as "Total monthly payment (principal,
     inter…" on the one row that resolves the arithmetic. The band's own identity
     lines are excluded because a very long programme name may honestly be
     shortened there; a figure or a label may not. */
  const Zc = pdf.ZONES.content;
  const clipped = [];
  for (const doc of [ts, cmp]) {
    doc.pages.forEach((items, pi) => {
      for (const it of items) {
        if (!(it.y >= Zc.bottom - 0.5 && it.y + it.h <= Zc.top + 2)) continue;
        if (/…$/.test(it.s.trim())) clipped.push(`p${pi + 1} "${it.s.trim()}"`);
      }
    });
  }
  check(clipped.length === 0, `no label or figure is cut short with an ellipsis${clipped.length ? `: ${clipped.join(', ')}` : ''}`);
  check(ts.pages.some((items) => items.some((i) => /^Total monthly payment/.test(i.s.trim()))),
    '…and the row that used to be cut short is on the page in full, which is what makes the sweep above mean something');

  /* ⛔ THREE WEIGHTS AND NO MORE — the design's third rule, asserted as the two
     PROPORTIONS that were actually wrong rather than as a table of absolute
     sizes nobody may ever change. The headline band was 2.26× the table it
     summarised (the design's own is 1.73) and a resolving total was 1.5× the
     ordinary figure beside it, which is the "everything is way too big" the
     owner read off a real export. A ratio guard leaves the scale free to move as
     one and still refuses the change that makes one figure shout. */
  const SZ = pdf._internals.SZ;
  check(SZ.hero / SZ.tableValue <= 2,
    `the headline is at most twice the table it summarises (${(SZ.hero / SZ.tableValue).toFixed(2)}×)`);
  check(SZ.big / SZ.value <= 1.35,
    `a resolving total is MEDIUM beside its neighbours, never large (${(SZ.big / SZ.value).toFixed(2)}×)`);
  check(Math.max(SZ.label, SZ.value, SZ.tableLabel, SZ.tableValue, SZ.tableBig, SZ.colTitle,
    SZ.gridValue, SZ.para, SZ.small, SZ.section, SZ.eyebrow) <= SZ.hero,
  '…and nothing in the body is larger than the one figure that may be');

  /* ⛔ A SECTION HEADING IS A RULE AND A TICK, NEVER A FILLED BAR — and this one
     is asserted on the SOURCE, which is a real limitation stated rather than
     hidden. The property is about a FILLED RECTANGLE, and the text extractor
     this suite reads the paper with reports strings and their boxes; it cannot
     see a fill at all. So what is checked is that `compileBand` draws a rule and
     does not paint a rounded rectangle behind its label — which is exactly the
     change, and would catch it coming back. Four saturated bars the width of the
     column were the loudest thing on a page whose entire argument is the
     figures, on a document the owner read beside the design and called *"way far
     off from the sketch"*. */
  const pdfSrc = fs.readFileSync(new URL('../src/longterm/termsheet/pdf.js', import.meta.url), 'utf8');
  const bandFn = pdfSrc.slice(pdfSrc.indexOf('function compileBand('), pdfSrc.indexOf('function compileRule('));
  check(bandFn.length > 100, 'compileBand was found in the source to read');
  check(!/roundedRect\(/.test(bandFn),
    'a section heading paints no rounded bar behind its label');
  check(/line\([^)]*INK/.test(bandFn) || /line\(c, base - S\.rulePad, B\.x, B\.right, INK/.test(bandFn),
    '…it rules under it in ink instead');
  check(/tickW/.test(bandFn) && /TEAL/.test(bandFn),
    '…and spends the accent on a tick, so the heading is still marked');
  check(brand.SECTION && brand.SECTION.h === undefined && brand.SECTION.radius === undefined,
    '…and the filled bar\'s own geometry is gone from brand.js, not merely unused');
}

/* ===========================================================================
   THE COMPARISON TABLE AND ITS SHARED-FACTS BOX, AGAINST THE APPROVED SKETCH.

   ⛔ EACH OF THESE IS SOMETHING THE OWNER READ OFF A REAL EXPORT AND CALLED
   WRONG (2026-08-31: *"your new design doesn't come close … I expect the sheet
   to look exactly as the sketch"*). What shipped drew a grey header band,
   zebra-striped every other row, set every figure in the same sans as its label,
   and put what every option agrees about below the table as a fifteen-row list.

   ⛔ THE MONOSPACE IS PROVEN FROM THE PAPER, NOT FROM THE SOURCE. Courier
   advances every glyph by exactly 0.6em, so a column of figures set in it has
   the SAME width-per-character whatever the digits are; Helvetica does not. So
   the ratio is measured across several real values and required to be constant
   — which is a fact about what a viewer will draw, and cannot be satisfied by a
   comment. The label column is measured beside it as the control: if BOTH were
   constant the assertion would be about the extractor rather than the font.
   =========================================================================== */
console.log('\nthe comparison table is the sketch\'s ledger, not a spreadsheet');
{
  const cmpBytes = await render(
    [quote('Platinum 30-Year Fixed', 7.375, 102), quote('Core 30-Year Fixed', 7.625, 101.25),
      quote('Core 5/6 ARM', 7.875, 100.5)],
    {
      borrowerName: 'Jonathan Reyes', entityName: 'Maple Holdings LLC',
      propertyAddress: '128 Maple Avenue, Lakewood, NJ 08701',
      officerName: 'Chaim Stern', companyName: 'YS Capital Group', companyNmls: '2609746',
      preparedAt: '2026-08-31T14:00:00.000Z', expiresAt: '2026-09-01T14:00:00.000Z',
    },
    { expiryHours: 24 },
  );
  const cmp = await readBack(cmpBytes);
  const all = cmp.pages.flat();

  // The three data columns are the x's the option figures are drawn at; the
  // label column is the left margin. Read off the page rather than retyped.
  const squash = (t) => String(t).replace(/\s+/g, '');
  /* A GLYPH'S OWN ADVANCE, in ems — the width the viewer will use, divided by
     the string's length and by its size. Courier advances EVERY glyph by exactly
     0.6em, at any size, so this one number tells a monospaced run from a
     proportional one without the suite having to know which font id the
     extractor gave it. Dividing by the size is what lets figures set at three
     different sizes on one page be measured together. */
  const ems = (items) => items
    .filter((i) => i.s.trim().length >= 4 && i.w > 0 && i.h > 0)
    .map((i) => i.w / (i.s.trim().length * i.h));
  const colX = [...new Set(all.map((i) => Math.round(i.x)))].filter((x) => x > 150 && x < 500);
  /* THE TABLE'S OWN FIGURES, told from every other figure on the page by the two
     sizes the table sets — its ordinary value and its resolving one. Taken from
     `SZ` rather than retyped, so the selection follows the scale if it moves. */
  const TSZ = pdf._internals.SZ;
  const isTableSize = (h) => Math.abs(h - TSZ.tableValue) < 0.15 || Math.abs(h - TSZ.tableBig) < 0.15;
  const valueItems = all.filter((i) => colX.includes(Math.round(i.x))
    && isTableSize(i.h) && /[$%\d]/.test(i.s));
  const vEms = ems(valueItems);
  check(vEms.length >= 6, `the table draws ${vEms.length} figures to measure — a handful would prove nothing`);
  const off = vEms.filter((r) => Math.abs(r - 0.6) > 0.03);
  check(off.length === 0,
    `every figure in the table is MONOSPACED — 0.6em a glyph, whatever the digits (${off.length} of ${vEms.length} are not)`);
  const labelItems = all.filter((i) => Math.round(i.x) === 45 && /^[A-Z][a-z]/.test(i.s.trim()) && i.s.trim().length >= 8);
  const lEms = ems(labelItems);
  check(lEms.length >= 4 && lEms.every((r) => Math.abs(r - 0.6) > 0.03),
    '…and the labels beside them are NOT — the control, without which the measurement above is about the extractor');

  // The column heads: a tracked gold eyebrow naming each column, the anchor
  // tag on exactly one of them, and no "(compared against)" prose left over.
  const flatCmp = squash(cmp.text);
  check(flatCmp.includes(squash('OPTION A')) && flatCmp.includes(squash('OPTION B'))
    && flatCmp.includes(squash('OPTION C')),
  'every column is headed by its own eyebrow, as the sketch heads them');
  check((flatCmp.match(new RegExp(squash('THE ANCHOR'), 'g')) || []).length === 1,
    '…and exactly ONE column is tagged as the one the others are measured against');
  check(!/\(comparedagainst\)/i.test(flatCmp),
    '…so the head no longer carries the parenthetical it used to');

  /* THE SHARED FACTS ARE A BOX ABOVE THE TABLE. Proven by ORDER on the page, not
     by the block list: the box's own heading must be drawn ABOVE the table's
     first column head, on the same page. */
  const p1 = cmp.pages[0];
  /* ⛔ ANCHORED ON STRINGS THAT ARE DRAWN WHOLE. A tracked eyebrow is placed one
     CHARACTER at a time (pdf-lib has no letter-spacing), so every extracted item
     of "OPTION A" is a single letter and an anchor on it would match a stray
     "O" anywhere on the page. The box's own footnote and the table's first row
     label are both drawn as whole strings. */
  const yOf = (re) => { const it = p1.find((i) => re.test(i.s.trim())); return it ? it.y : null; };
  const gridY = yOf(/^Anything that differed/);
  const headY = yOf(/^Principal & interest$/);
  check(gridY != null && headY != null && gridY > headY,
    'what every option agrees about is stated ABOVE the table, in its own box — the sketch\'s own order');
  check(!squash(cmp.text).includes(squash('The same in all 3 — stated once')),
    '…and not below it as the list of rows it used to be');
}

/* ⛔ AND THE THINGS A TEXT EXTRACTOR CANNOT SEE — a fill, a rule and a font
   CHOICE — are pinned on the source, which is a limitation stated rather than
   hidden. Every one of them is a change the owner asked for by name. */
{
  const src = fs.readFileSync(new URL('../src/longterm/termsheet/pdf.js', import.meta.url), 'utf8');
  const tableFn = src.slice(src.indexOf('function compileTable('), src.indexOf('function compileFactGrid('));
  const gridFn = src.slice(src.indexOf('function compileFactGrid('), src.indexOf('const PAGEBREAK'));
  check(tableFn.length > 500 && gridFn.length > 500, 'both compilers were found in the source to read');
  // Strip the comments first: they necessarily NAME what was removed, and a
  // guard that read them would fail on its own explanation.
  const nc = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const tableCode = nc(tableFn);
  const gridCode = nc(gridFn);
  check(!/%\s*2/.test(tableCode) && !/ri\s*%/.test(tableCode),
    'the table zebra-stripes nothing — the sketch bands the rows that RESOLVE, and no others');
  check(/rect\([^)]*IVORY\)/.test(tableCode) && /accent/.test(tableCode),
    '…it bands an accent row in ivory instead');
  check(!/SOFT/.test(tableCode),
    '…and paints no grey ground behind its head');
  check(/F\.monoBold/.test(tableCode) && /F\.mono/.test(tableCode),
    'its figures are set in the monospace, its labels in the sans');
  check(/closing \? INK : HAIR/.test(tableCode),
    'a row closes on an INK rule when it ends the table or its group, and on a hairline otherwise');
  check(/GOLD/.test(tableCode) && /colEyebrow/.test(tableCode),
    'the column eyebrow is gold, as the sketch sets it');
  check(/rect\([^)]*SOFT\)/.test(gridCode) && /rect\([^)]*GOLD\)/.test(gridCode),
    'the shared-facts box has the sketch\'s ivory ground and its gold tick');
  check(/F\.monoBold/.test(gridCode), '…and states every agreed figure in the monospace');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
