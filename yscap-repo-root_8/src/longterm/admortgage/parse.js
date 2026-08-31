'use strict';
/**
 * LONG-TERM — A&D MORTGAGE (AIM): the answer, turned into the common board.
 *
 * The board shape is the one `pricing/merge.js` and `pricing/vendor-margin.js`
 * already consume from the other two vendors: `{ source, programs: [{ lender,
 * program, rungs: [...] }] }`. Nothing about AIM leaks past this file.
 *
 * ── ONE COUNTERPARTY ───────────────────────────────────────────────────────
 * AIM prices A&D's own products, so every row's investor is A&D. The name
 * emitted is the canonical registry's own label, so the merge resolves it
 * through the same identity the other vendors go through rather than on a string
 * this file invented.
 *
 * ── THE PRICE ARITHMETIC, MEASURED ─────────────────────────────────────────
 * AIM states `discount` (points) and `discountAmount` (dollars). Price is the
 * complement: `price = 100 - discount`, which reconciles to AIM's own dollars —
 * 0.125 points on $500,001 is the $625.00 it reports.
 *
 * `basePoints = discount + totalAdjustments`. That is MEASURED, not assumed:
 * across five scenarios that varied prepay, FICO and LTV, every unclipped rung
 * yielded ONE identical base per rate (at 6.250: 1.5 + −1.5, 0 + 0, −0.375 +
 * 0.375 → 0 every time). Note the SIGN — AIM's adjustments run OPPOSITE to its
 * discount, so a positive adjustment IMPROVES the price. That matches Lender
 * Price's own convention exactly (`adjustedPoints = basePoints − Σ adjustments`),
 * which is why the two vendors' LLPA columns can sit side by side unaltered.
 *
 * ── WHERE THE IDENTITY BREAKS, WE SAY SO RATHER THAN REPORT A BASE ─────────
 * A&D caps the rebate. On the measured ladders the discount floors at a flat
 * −2.500 (−1.000 on one scenario) and every rung from there down repeats it, so
 * `discount + totalAdjustments` stops being the base and starts being an
 * artefact of the cap. Those rungs are marked `clipped: true` and carry
 * `basePoints: null` — a base we cannot derive is null, never a number that
 * would reconcile to nothing.
 *
 * PURE: no network, no database, no RTL import.
 */

const investors = require('../encompass/investors');

const AD_KEY = 'a_and_d';
const round3 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);

/**
 * AIM formats every number as a display string — "$3,078.59", "6.250", "-2.500".
 * Strip only currency formatting; anything that is still not a number comes back
 * null rather than a coerced 0, because a 0 payment reads as a real quote.
 */
function money(v) {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '' || !Number.isFinite(Number(s))) return null;
  return Number(s);
}

/** The rate-sheet stamp AIM only states inside its HTML `description`. */
function rateSheetStamp(html) {
  if (!html) return null;
  const m = String(html).match(/Pricing as of:\s*([^<]+)/i);
  return m ? m[1].trim() : null;
}

/** The overlay bullets AIM states in the same blob, minus the adjustments list. */
function overlayNotes(html) {
  if (!html) return [];
  const head = String(html).split(/<p>\s*Adjustments/i)[0];
  return (head.match(/<li>(.*?)<\/li>/gi) || [])
    .map((li) => li.replace(/<[^>]+>/g, '').trim())
    .filter((t) => t && !/^Pricing as of:/i.test(t));
}

/**
 * AIM's `adjustments` map -> the itemized LLPA rows Lender Price ships inline.
 *
 * Same field names, same sign, same `valueType` — so a screen reading a Lender
 * Price row reads this one without knowing it changed vendor. `adjType` is null
 * because AIM does not classify its adjustments and inventing a class would be
 * inventing a fact; `group` is AIM's own heading for the block.
 */
function adjustmentRows(map) {
  return Object.entries(map || {}).map(([reason, value]) => ({
    group: 'Adjustments',
    reason,
    adjType: null,
    type: 'LLPA',
    valueType: 'Points',
    value: round3(value),
  }));
}

/**
 * Which rungs sit on the rebate cap.
 *
 * The cap is not published, so it is detected rather than assumed: the most
 * negative discount on the ladder, when more than one rung carries it, is a cap
 * rather than a coincidence. A ladder whose minimum appears once is not clipped.
 */
function clippedSet(rows) {
  const ds = rows.map((r) => money(r.discount)).filter((d) => d != null);
  if (ds.length < 2) return { floor: null, clipped: new Set() };
  const floor = Math.min(...ds);
  const n = ds.filter((d) => d === floor).length;
  if (n < 2) return { floor: null, clipped: new Set() };
  return { floor, clipped: new Set(ds.filter((d) => d === floor)) };
}

/**
 * Parse one AIM `calculate` answer into the common board.
 *
 * `lockDays` and `dscr` come from the SCENARIO, not the answer: AIM states the
 * lock as a label on the program ("30 Days") and never restates the DSCR at all,
 * so both are carried through from what we asked rather than re-derived.
 */
function parse(raw, ctx = {}) {
  const data = raw && raw.data ? raw.data : null;
  const canonical = investors.byKey(AD_KEY);
  const lenderName = (canonical && canonical.label) || 'A&D Mortgage LLC';

  if (!Array.isArray(data)) {
    return { source: 'admortgage', programCount: 0, lenderCount: 0, rungCount: 0, programs: [], notes: ['no_data_in_answer'] };
  }
  // A 200 with an EMPTY array is AIM saying "nothing fits" WITHOUT a reason —
  // measured on FICO 620 and CLTV 85/90. It is a real outcome, not an error, and
  // the note is what lets a board say so instead of showing a blank.
  if (!data.length) {
    return { source: 'admortgage', programCount: 0, lenderCount: 0, rungCount: 0, programs: [], notes: ['no_programs_offered_no_reason_given'] };
  }

  const programs = data.map((p) => {
    const rows = Array.isArray(p.rateStackRows) ? p.rateStackRows : [];
    const totalAdj = money(p.totalAdjustments);
    const { floor, clipped } = clippedSet(rows);
    const adjustments = adjustmentRows(p.adjustments);

    const rungs = rows.map((r) => {
      const points = money(r.discount);
      const isClipped = points != null && clipped.has(points);
      const basePoints = (points != null && totalAdj != null && !isClipped) ? round3(points + totalAdj) : null;
      return {
        rate: money(r.rate),
        price: points == null ? null : round3(100 - points),
        points: round3(points),
        // AIM STATES the points and we derive the price — the opposite of
        // LoanNEX, where the vendor states the price. The flag says which, so a
        // reader never has to guess which number was the vendor's own.
        pointsDerived: false,
        priceDerived: true,
        basePoints,
        basePrice: basePoints == null ? null : round3(100 - basePoints),
        clipped: isClipped,
        discountAmount: money(r.discountAmount),
        lockDays: ctx.lockDays == null ? null : Number(ctx.lockDays),
        cushionedLockDays: null,
        payment: money(r.monthlyPayment),
        dscr: ctx.dscr == null ? null : Number(ctx.dscr),
        isException: false,
        hasSoftStopViolation: false,
        rowId: r.id == null ? null : Number(r.id),
      };
    });

    const bestId = p.bestRateStackRowId;
    return {
      source: 'admortgage',
      lender: lenderName, investor: lenderName, lenderId: null,
      investorKey: AD_KEY,
      program: p.label || null,
      programId: p.id == null ? null : Number(p.id),
      programCode: null,
      // AIM has no separate rate-sheet name — the program IS the sheet. Left
      // null rather than restating the program, so a reader cannot mistake one
      // fact for two.
      product: p.label || null, productId: null, rateSheetName: null,
      rateSheetAsOf: rateSheetStamp(p.description),
      overlays: overlayNotes(p.description),
      amortizationType: /ARM/i.test(p.label || '') ? 'ARM' : 'Fixed',
      termInMonths: ctx.termMonths == null ? null : Number(ctx.termMonths),
      isInterestOnly: ctx.io === true,
      interestOnlyTerm: null,
      lockPeriodLabel: p.lockPeriod || null,
      totalAdjustments: totalAdj,
      adjustments,
      priceCeiling: floor == null ? null : round3(100 - floor),
      bestRungRowId: bestId == null ? null : Number(bestId),
      rungs,
    };
  });

  for (const p of programs) {
    p.rungs.sort((a, b) => (a.rate - b.rate) || (a.lockDays - b.lockDays));
    p.rungCount = p.rungs.length;
    p.minRate = p.rungs.length ? p.rungs[0].rate : null;
    p.minPoints = p.rungs.reduce((m, r) => (r.points != null && (m == null || r.points < m) ? r.points : m), null);
    p.maxPrice = p.rungs.reduce((m, r) => (r.price != null && (m == null || r.price > m) ? r.price : m), null);
    p.lockDaysOffered = [...new Set(p.rungs.map((r) => r.lockDays).filter((d) => d != null))].sort((a, b) => a - b);
  }
  programs.sort((a, b) => String(a.program || '').localeCompare(String(b.program || '')));

  return {
    source: 'admortgage',
    programCount: programs.length,
    lenderCount: 1,
    rungCount: programs.reduce((n, p) => n + p.rungCount, 0),
    rateSheetAsOf: programs.length ? programs[0].rateSheetAsOf : null,
    programs,
  };
}

/**
 * AIM's 400 — the one refusal that NAMES what to change — flattened into the
 * same `{ lenders: [{ lender, items: [{ program, reasons }] }] }` shape the other
 * two vendors' disqualify parsers produce.
 *
 * It is one sentence about the whole search rather than a per-program tree, so
 * it is reported against the counterparty with no program named — saying less
 * than the other vendors, but nothing that is not AIM's own words.
 */
function parseRefusal(body) {
  const title = body && typeof body.title === 'string' ? body.title : null;
  if (!title) return null;
  const m = title.match(/change:\s*(.+?)\.?$/i);
  const canonical = investors.byKey(AD_KEY);
  return {
    lenders: [{
      lender: (canonical && canonical.label) || 'A&D Mortgage LLC',
      items: [{ program: null, reasons: [title] }],
    }],
    changeWhat: m ? m[1].split(/\s+or\s+/i).map((s) => s.trim()) : [],
    errorNumber: (body && body.errorNumber) || null,
  };
}

module.exports = {
  parse, parseRefusal, AD_KEY,
  _internals: { money, rateSheetStamp, overlayNotes, adjustmentRows, clippedSet, round3 },
};
