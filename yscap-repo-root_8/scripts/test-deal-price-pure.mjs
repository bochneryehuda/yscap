/**
 * THE PURCHASE-PRICE FIGURES OF A DEAL (owner-directed 2026-07-28). Pure — the
 * one shared derivation behind the closing desk's Deal details and the file's
 * deal snapshot, so the two can never show different numbers for one file.
 *
 * The frozen display rule (CLAUDE.md 2026-07-17) is what these assertions pin:
 * a "purchase price" is the REAL total the borrower pays (seller's contract +
 * the FULL assignment fee), and the capped basis appears ONLY as an explicitly
 * labeled "effective purchase price", ONLY when the fee is over the cap.
 */
import { dealPurchase } from '../app-v2/src/lib/dealPrice.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── a straight purchase: one number, no assignment figures ──────────────────
{
  const p = dealPurchase({ purchase_price: 496000 });
  ok(p.isAssignment === false, 'straight purchase: not an assignment');
  ok(p.total === 496000, 'straight purchase: total is the entered price');
  ok(p.original === null && p.fee === null, 'straight purchase: no original/fee figures');
  ok(p.effective === null, 'straight purchase: no effective price');
}

// pg returns numeric columns as strings — they must still be numbers here.
{
  const p = dealPurchase({ purchase_price: '496000.00' });
  ok(p.total === 496000, 'a numeric-as-string price reads as a number');
}

// ── an assignment: total = seller's contract + the FULL fee ─────────────────
{
  const p = dealPurchase({ is_assignment: true, underlying_contract_price: 496000, assignment_fee: 49600, purchase_price: 496000 });
  ok(p.isAssignment === true, 'assignment: recognized as one');
  ok(p.total === 545600, 'assignment: total is seller contract + the FULL fee (never the capped basis)');
  ok(p.original === 496000, 'assignment: original is the seller contract');
  ok(p.fee === 49600, 'assignment: the fee is reported');
  ok(p.effective === null, 'assignment within the cap: no separate effective price');
}

// A fee with no original contract on file can't be split — never pass the
// entered price off as the seller's contract.
{
  const p = dealPurchase({ is_assignment: true, assignment_fee: 49600, purchase_price: 545600 });
  ok(p.isAssignment === false, 'assignment flagged but no original contract: not derivable');
  ok(p.original === null, 'assignment with no original contract: original is not faked from the entered price');
  ok(p.total === 545600, 'assignment with no original contract: the entered price is still reported');
}

// A zero/blank original contract is the same missing-data case.
{
  ok(dealPurchase({ is_assignment: true, underlying_contract_price: 0, assignment_fee: 100, purchase_price: 200 }).isAssignment === false,
    'a zero original contract is treated as missing, not as an assignment');
}

// An assignment with no fee entered yet still totals to the contract.
{
  const p = dealPurchase({ is_assignment: true, underlying_contract_price: 400000 });
  ok(p.total === 400000 && p.fee === null, 'assignment with no fee yet: total is the contract, fee reads as missing');
}

// ── the capped basis: read from the registered quote, never recomputed ──────
{
  // Seller $100k + $20k fee: only 15% × $100k = $15k is financeable, so the
  // loan sizes on $115k and $5k is extra cash at the table.
  const app = {
    is_assignment: true, underlying_contract_price: 100000, assignment_fee: 20000,
    registered_quote: { assignment: { sellerPrice: 100000, fee: 20000, maxFee: 15000, financeableFee: 15000, excessOOP: 5000, recognizedPrice: 115000, overLimit: true } },
  };
  const p = dealPurchase(app);
  ok(p.total === 120000, 'over-cap fee: the price still shows the FULL total paid');
  ok(p.effective === 115000, 'over-cap fee: the effective (capped) price is read from the registered quote');
  ok(p.excessOutOfPocket === 5000, 'over-cap fee: the excess out of pocket comes from the quote');
}
{
  // Fee inside the cap → the quote's recognized price equals the total, so
  // there is nothing extra to show and no second number to confuse anyone.
  const p = dealPurchase({
    is_assignment: true, underlying_contract_price: 496000, assignment_fee: 49600,
    registered_quote: { assignment: { recognizedPrice: 545600, excessOOP: 0, overLimit: false } },
  });
  ok(p.effective === null && p.excessOutOfPocket === null, 'a fully financeable fee shows no separate effective price');
}
{
  // No registration yet — the effective price is never guessed at.
  const p = dealPurchase({ is_assignment: true, underlying_contract_price: 100000, assignment_fee: 20000 });
  ok(p.effective === null, 'no registered quote: the effective price is never re-derived locally');
}

// ── defensive: a missing/empty application never throws ─────────────────────
{
  ok(dealPurchase(null).total === null, 'a null application yields no figures');
  ok(dealPurchase({}).total === null, 'an empty application yields no figures');
  ok(dealPurchase({ purchase_price: '' }).total === null, 'a blank price is missing, not zero');
  ok(dealPurchase({ purchase_price: 'n/a' }).total === null, 'a non-numeric price is missing, not NaN');
}

console.log(failures ? `test-deal-price-pure FAILED (${failures})` : 'test-deal-price-pure: all checks passed');
process.exit(failures ? 1 : 0);
