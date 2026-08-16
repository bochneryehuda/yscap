'use strict';
/**
 * THE INVESTOR'S CUT OF OUR DRAW FEE — the money ledger only (owner-directed 2026-08-13).
 *
 * The owner, in their own words:
 *
 *   "Out of our $299 fee, our $250 fee, or our $499 fee, certain investors charge off the fee for
 *    the release, and their fee gets netted from RV … any file that is funding with CorrFirst that
 *    is already sold to CorrFirst … the investor fee on the ledger should automatically fill out as
 *    $95 … our net fee should automatically deduct the $95 … and our final fee is only $204. If
 *    it's not sold yet, then we get all of the entire fee. The hard rules should be set: CorrFirst
 *    $95, Blue Lake $250 … by Blue Lake our net fee is 0 because they charge the entire thing …
 *    Don't change anything from the front end that a borrower sees or that a staff member sees. The
 *    only change we need to make is to the actual ledger, which is the fee: how much of the fee is
 *    actually going to be deposited in our bank account?"
 *
 * SO THIS SPLITS ONE FEE, IT NEVER CHANGES ONE. `fee_cents` — the fee that comes out of the
 * borrower's approved draw — keeps its exact meaning and its exact value everywhere: the term
 * sheet, the borrower's screen, every draw email, the investor delivery, the borrower's net. What
 * this adds is the second question about that SAME fee: how much of it the note buyer keeps for
 * handling the release, and therefore how much of it reaches our bank. Nothing here can move a
 * borrower's money, and nothing here belongs on a borrower surface.
 *
 * TWO THINGS HAVE TO BE TRUE BEFORE A CUT EXISTS AT ALL, and both are facts we already hold:
 *   1. the note buyer has a rate — the admin settings table (db/545, editable per investor), or
 *      the built-in figures below when nothing is configured;
 *   2. the loan is actually SOLD to them. Sold is `release-party` — and specifically its EFFECTIVE
 *      answer (`soldEffective`), so the draw desk's "process this file as sold" override carries
 *      here too and this can never disagree with the badge on the screen above it.
 *
 * AN UNSOLD LOAN HAS NO INVESTOR FEE — NOT $0 THAT SOMEBODY MIGHT EDIT, NONE (owner-directed
 * 2026-08-13): *"if it's not sold yet, then it should not fill out the investor fee, because the
 * investor is not charging it yet — they're not reimbursing it and they're not releasing it.
 * They're going to buy the loan with the draw released already, so it's not going to be an extra
 * charge."* Before the sale WE release the draw out of our own money and our fee simply stays out
 * of the wire; there is no remittance for anybody to deduct from. So on an unsold file the box is
 * not offered at all (`offer:false`), and the sentence says why. The moment the file is sold — or
 * a coordinator processes it as sold — the rate applies and the box appears, still editable,
 * because the human at the ledger is the one who knows.
 *
 * PURE — no database, no network, integer cents, never throws. The one require is the shared
 * note-buyer table (itself pure), so a buyer's spelling still has exactly ONE home in this
 * codebase: "Core First", "CorrFirst" and "corrfirst" are the same buyer here because they are the
 * same buyer there.
 */

// The note buyer's spelling, normalized the same way every other note-buyer rule normalizes it.
const FC = require('../lib/funding-channel');

const N = (x) => Number(x || 0) || 0;
const usd = (c) => '$' + (Math.round(N(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * THE HARD RULES — what each note buyer charges us per released draw, in cents.
 *
 * OWNER-SET NUMBERS, and the FALLBACK rather than the last word: the live rates are the admin
 * settings table (`investor_draw_fees`, db/545), which is seeded with exactly these two and is
 * where the owner changes a rate or adds a new investor's — no deploy. These stay because a
 * deployment whose table is empty or unreadable must still behave exactly as it does today, and
 * because they record what was agreed. Changing one changes what we book as income on every future
 * release for that buyer where nothing is configured, so it takes the owner saying so.
 */
const INVESTOR_DRAW_FEE_CENTS = Object.freeze({
  corrfirst: 9500,    // $95 per draw
  bluelake: 25000,    // $250 per draw — the whole Blue Lake draw fee, so we bank nothing
});

/** The three sold answers, mirrored from release-party so a caller can compare without requiring it. */
const SOLD = Object.freeze({ SOLD: 'sold', NOT_SOLD: 'not_sold', UNKNOWN: 'unknown' });

/**
 * The rule for a note buyer — { key, label, per_draw_cents, source } — or null when this buyer
 * keeps nothing out of our fee. A blank/unknown buyer is null: we do not know whose rule to apply,
 * and inventing one would take money off our own books.
 *
 * `rates` is the CONFIGURED table from the admin settings (`investor_draw_fees`, keyed by the same
 * buyer token). It wins over the built-in figures, so the owner can change what an investor keeps —
 * or add a brand-new investor's rate — without a deploy. A configured **0** is a real answer
 * ("this investor keeps nothing"), not a missing one, which is why the lookup tests for the KEY
 * rather than for a truthy amount. With no table passed the built-in rates apply exactly as before.
 */
function ruleFor(noteBuyer, rates = null) {
  const key = FC.toBuyerKey(noteBuyer);
  if (!key) return null;
  const configured = rates && Object.prototype.hasOwnProperty.call(rates, key) ? Math.max(0, Math.round(N(rates[key]))) : null;
  const cents = configured != null ? configured : INVESTOR_DRAW_FEE_CENTS[key];
  if (!(cents > 0)) return null;
  return { key, label: FC.label(key), per_draw_cents: cents, source: configured != null ? 'configured' : 'built_in' };
}

/** Every buyer with a rate, for a settings screen that wants to show them. */
function rules(rates = null) {
  const keys = new Set(Object.keys(INVESTOR_DRAW_FEE_CENTS).concat(Object.keys(rates || {})));
  return [...keys].map((key) => {
    const r = ruleFor(key, rates);
    return r || { key, label: FC.label(key), per_draw_cents: 0, source: rates && key in rates ? 'configured' : 'built_in' };
  });
}

/**
 * Split OUR fee into the investor's cut and our deposit.
 *
 *   net_fee = fee − investor_fee ;  0 ≤ investor_fee ≤ fee
 *
 * The cut is part of our fee, so it can never exceed it (a negative deposit is not a thing) and
 * can never be negative. A figure outside that range is REPORTED, never silently trimmed — the
 * route refuses it with the reason, exactly as `computeRelease` refuses a fee bigger than the draw.
 * Mirrors the database's own generated `net_fee_cents` + CHECK, so the screen, the route and the
 * table can never disagree about the deposit.
 */
function splitFee({ feeCents = 0, investorFeeCents = 0 } = {}) {
  const fee = Math.max(0, Math.round(N(feeCents)));
  const cut = Math.round(N(investorFeeCents));
  const ok = cut >= 0 && cut <= fee;
  const clamped = Math.min(fee, Math.max(0, cut));
  return {
    fee_cents: fee,
    investor_fee_cents: clamped,
    net_fee_cents: fee - clamped,
    ok,
    violation: ok ? null
      : (cut < 0
        ? 'the investor’s cut cannot be a negative amount'
        : `the investor’s cut of ${usd(cut)} is more than our ${usd(fee)} fee on this draw — they can never keep more than we charge`),
  };
}

/**
 * THE WHOLE ANSWER FOR ONE RELEASE — what a screen renders and what a route defaults to.
 *
 *   noteBuyer  the file's note buyer (`applications.lender`), any spelling
 *   sold       'sold' | 'not_sold' | 'unknown' — release-party.soldStatus for this file
 *   feeCents   OUR fee on this draw (the figure the draw already carries)
 *
 * Returns, always (an unknown buyer simply has no rule and no cut):
 *   { buyer_key, buyer_label, rule_cents, applies, offer, sold, suggested_cents,
 *     fee_cents, net_fee_cents, reason, headline, hint }
 *
 * `offer` is whether the ledger should show the investor-fee box at all — false on an unsold loan
 * (nobody is charging anything) and on a buyer with no such deal. `suggested_cents` is what it
 * fills in with: the rule, capped at our own fee. `hint` is the sentence a coordinator reads when
 * the box is not offered, and it says what IS happening rather than only what is not.
 */
function describe({ noteBuyer = null, sold = null, feeCents = 0, rates = null } = {}) {
  const fee = Math.max(0, Math.round(N(feeCents)));
  const rule = ruleFor(noteBuyer, rates);
  const isSold = String(sold || '') === SOLD.SOLD;
  const base = {
    buyer_key: rule ? rule.key : (FC.toBuyerKey(noteBuyer) || null),
    buyer_label: rule ? rule.label : null,
    rule_cents: rule ? rule.per_draw_cents : 0,
    sold: sold || null,
    fee_cents: fee,
  };
  // No rule: this buyer keeps nothing out of our fee, and neither does an unrecognised one.
  if (!rule) {
    return { ...base, applies: false, offer: false, suggested_cents: 0, net_fee_cents: fee, reason: 'no_rule', headline: null, hint: null };
  }
  const capped = Math.min(rule.per_draw_cents, fee);
  // Sold to them → the cut applies, and the box fills itself in.
  if (isSold) {
    return {
      ...base, applies: true, offer: true, suggested_cents: capped, net_fee_cents: fee - capped, reason: 'sold_to_buyer',
      headline: `${rule.label} keeps ${usd(capped)} of our ${usd(fee)} fee on this draw — ${usd(fee - capped)} comes to us.`,
      hint: null,
    };
  }
  // NOT SOLD (or we cannot tell) → there is no investor fee to record, and the box is not offered.
  // They are neither releasing this draw nor reimbursing it, so there is nothing for them to deduct
  // from: they buy the loan later with the draw already released. We wire the borrower the net out
  // of our own money and our fee never leaves it.
  const certain = String(sold || '') === SOLD.NOT_SOLD;
  return {
    ...base, applies: false, offer: false, suggested_cents: 0, net_fee_cents: fee,
    reason: certain ? 'not_sold' : 'sold_unknown',
    headline: null,
    hint: (certain
      ? `This loan has not been sold to ${rule.label} yet, so they charge nothing on this draw — `
      : `PILOT cannot tell whether ${rule.label} has bought this loan yet (no purchase advice date on file), so nothing is charged on this draw — `)
      + `we release the net ourselves and our ${usd(fee)} fee simply stays out of the wire. Once they own the loan they keep ${usd(rule.per_draw_cents)} of every draw fee. If the loan IS already sold, process the file as sold on the "Who releases the money" card and the fee will apply.`,
  };
}

/**
 * The default cut for a release nobody typed a figure for — the rule, but only on a sold loan.
 * The route's fallback and the automatic (investor-released) ledger writer use exactly this, so a
 * release recorded by hand and one recorded by PILOT itself can never book different income.
 */
function defaultInvestorFeeCents({ noteBuyer = null, sold = null, feeCents = 0, rates = null } = {}) {
  return describe({ noteBuyer, sold, feeCents, rates }).suggested_cents;
}

// ---------------------------------------------------------------------------
// The IO half — the configured rates. Takes its `db`, so everything above stays pure.
// ---------------------------------------------------------------------------

/**
 * The admin-settings rate table as a plain { buyerKey: cents } map (db/545).
 *
 * NEVER THROWS, and an unreadable table answers `{}` — which falls the whole feature back to the
 * built-in rates rather than silently booking every investor's cut as nothing. That direction
 * matters: `{}` means "CorrFirst still keeps $95", while a table read as all-zeros would quietly
 * report income we never received.
 */
async function loadConfiguredRates(db) {
  try {
    const rows = (await db.query(`SELECT buyer_key, per_draw_cents FROM investor_draw_fees`)).rows || [];
    const out = {};
    for (const r of rows) if (r && r.buyer_key) out[String(r.buyer_key)] = Math.max(0, Math.round(N(r.per_draw_cents)));
    return out;
  } catch (_) { return {}; }
}

/**
 * Every note buyer the settings screen should offer, each with the rate in force — the CONFIGURED
 * one, else the built-in, else nothing. `buyers` is the list of note buyers the system knows about
 * (`lib/note-buyers.listNoteBuyers`), so an investor added to the system appears here on their own
 * with a box ready to fill in, which is exactly what the owner asked for.
 */
function settingsRows({ buyers = [], rates = null } = {}) {
  const seen = new Map();
  const add = (label) => {
    const key = FC.toBuyerKey(label);
    if (!key || seen.has(key)) return;
    const r = ruleFor(key, rates);
    seen.set(key, {
      key,
      label: FC.label(key),
      // The spelling the system actually carries, when it differs from our canonical one.
      as_named: String(label || '').trim() || null,
      per_draw_cents: r ? r.per_draw_cents : 0,
      source: r ? r.source : (rates && key in rates ? 'configured' : 'none'),
    });
  };
  for (const b of buyers || []) add(typeof b === 'string' ? b : (b && (b.label || b.value)));
  for (const key of Object.keys(rates || {})) add(key);          // configured, even if unused today
  for (const key of Object.keys(INVESTOR_DRAW_FEE_CENTS)) add(key); // and the ones we ship with
  return [...seen.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

module.exports = {
  INVESTOR_DRAW_FEE_CENTS, SOLD,
  ruleFor, rules, splitFee, describe, defaultInvestorFeeCents,
  loadConfiguredRates, settingsRows,
};
