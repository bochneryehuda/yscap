'use strict';
/**
 * LONG-TERM — THE VENDOR'S OWN PRICE, SEALED SO ONLY THE SERVER CAN READ IT.
 *
 * ── THE DEFECT THIS CLOSES, MEASURED ───────────────────────────────────────
 * A LoanNEX rung reaches the browser with our margin holdback already taken out
 * of its price — that is the owner's standing rule, *"it should be baked into the
 * rate any time when customers and consumers are looking at it"*. `investor-routing`
 * therefore strips every field that would give the holdback away by subtraction:
 * `vendorPrice`, `vendorPriceFloor`, `vendorPriceCeiling`, `marginHoldback`
 * (audit F5, 2026-09-02).
 *
 * `priceExact` was added AFTER that audit — the sheet matches a quote on the price
 * to the last decimal, so the explain call has to send the vendor's own figure —
 * and it walked straight through the same door. Measured on the recorded board:
 *
 *     price       100.786    ← held back, what the screen shows
 *     priceExact  101.0355   ← the vendor's own, on the same object
 *     ─────────────────────
 *     difference    0.2495   ← the 0.25 holdback, read off the wire
 *
 * On every LoanNEX row of the ordinary board, and on the explain handle the
 * browser posts back. Not a theoretical exposure: one subtraction.
 *
 * ── WHY SEAL IT RATHER THAN DROP IT ────────────────────────────────────────
 * Dropping it re-opens the bug it was added to fix. The sheet finds a quote by
 * matching the price EXACTLY, our parser rounds to three decimals for display, and
 * on one live board 269 of 4,396 rungs need a fourth — clustered hard: 90% of
 * eResi's rungs and 18–64% of Acra Platinum's. Sent rounded, the sheet answers
 * `{"status":"Success"}` with no body and the panel says the rate sheet returned no
 * breakdown, blaming the vendor for our own rounding.
 *
 * ⛔ AND IT CANNOT BE RECONSTRUCTED FROM THE HELD-BACK PRICE. Adding the holdback
 * back on is what `combined-pricer.vendorQuote` already does, and it recovers only
 * the ROUNDED figure: 104.1762 → 104.176 → 103.926 → 104.176. The fourth decimal is
 * gone the moment the price is rounded, so the exact number has to travel.
 *
 * So it travels SEALED: the server can open it, the browser cannot read it, and a
 * tampered blob does not open at all — which matters, because a forged price would
 * ask the vendor to itemise somebody else's quote.
 *
 * ── THE KEY: THREE SOURCES, AND WHY THE MIDDLE ONE EXISTS ──────────────────
 *   1. `LT_PRICE_SEAL_KEY`, when set — any string, hashed to 32 bytes.
 *   2. otherwise DERIVED from `JWT_SECRET`, one way, under its own label.
 *   3. otherwise a random key minted once per process.
 *
 * ⛔ THE SECOND SOURCE IS AN AVAILABILITY DECISION, NOT A SECURITY ONE — every
 * one of the three keeps the number off the wire equally well. A random key does
 * not survive a restart, and a seal that cannot be opened degrades to the
 * add-back path, which reproduces only the ROUNDED price — which is the
 * empty-breakdown bug this field was added to fix. So an officer holding a board
 * open across a deploy would watch the fix undo itself on exactly the rungs that
 * need it. Deriving from a secret this deployment must already have set (config
 * refuses the dev default in production) makes a seal survive a restart with
 * nothing new to configure.
 *
 * ⛔ IT IS A ONE-WAY DERIVATION UNDER A DOMAIN LABEL, so the seal key can never
 * be walked back to `JWT_SECRET`, and a rotation of either simply invalidates
 * outstanding seals — which is harmless, because a seal is only ever as
 * long-lived as the board in somebody's tab. It is NEVER used as a signing key
 * and never leaves this module.
 *
 * ⛔ NEVER LOG A SEAL OR ITS PLAINTEXT. The blob is opaque by construction; the
 * number inside it is the thing the whole module exists to keep off the wire.
 *
 * SEPARATION: LT-only, node `crypto` only, no database, no RTL import — the
 * secret is read from the environment rather than from `src/config`, which is
 * RTL's module and which this must not reach into.
 */

const crypto = require('crypto');

/** The version tag. A blob that does not start with it is not ours and is refused. */
const V = 'p1';

/** The label that keeps a key derived here from ever being the same bytes as its parent. */
const DERIVE_LABEL = 'lt-price-seal:v1';

/**
 * Which of the three sources the key WOULD come from, read from the environment.
 * `JWT_SECRET` is read raw: `config.jwtSecretGenerated` reports the dev-default
 * case, and an ephemeral secret gives an ephemeral seal, which is correct.
 */
function sourceFromEnv() {
  if (process.env.LT_PRICE_SEAL_KEY) return 'configured';
  if (process.env.JWT_SECRET) return 'derived';
  return 'ephemeral';
}

let KEY = null;
let SOURCE = null;
function key() {
  if (KEY) return KEY;
  SOURCE = sourceFromEnv();
  if (SOURCE === 'configured') {
    KEY = crypto.createHash('sha256').update(String(process.env.LT_PRICE_SEAL_KEY)).digest();
  } else if (SOURCE === 'derived') {
    KEY = crypto.createHash('sha256').update(`${DERIVE_LABEL}\u0000${process.env.JWT_SECRET}`).digest();
  } else {
    KEY = crypto.randomBytes(32);
  }
  return KEY;
}

/**
 * Which source the key IN FORCE actually came from.
 *
 * ⛔ IT REPORTS THE MINTED KEY, NOT THE ENVIRONMENT AS IT STANDS NOW. The key is
 * cached on first use, so once a seal has been made the environment is no longer
 * the answer — a report that read it live could tell an operator the seals are
 * durable while every one of them is being made under a random key. Before
 * anything has been sealed there is nothing to describe yet, so it answers what
 * the next key would be.
 */
function keySource() { return SOURCE || sourceFromEnv(); }

/** Whether a seal will survive a restart of this process. */
function keyIsConfigured() { return keySource() !== 'ephemeral'; }

/**
 * A number → an opaque blob. Anything that is not a real number seals to null, so a
 * caller can hand this a missing price without a special case; null never travels.
 *
 * ⛔ TYPE FIRST, COERCION SECOND — the trap this repo has been bitten by repeatedly.
 * `Number(null)`, `Number('')` and `Number([])` are all **0**, which is finite, so a
 * missing price would seal as a confident par-minus-100 quote the sheet cannot match
 * and the panel would report an empty breakdown. (`[]` genuinely slipped through the
 * first cut of this function and was caught by its own test — `{}` gives NaN and was
 * refused, `[]` does not.) So an object of any kind, a blank and a null are refused
 * BY TYPE before `Number` is ever asked.
 */
function seal(value) {
  if (value == null || value === '' || typeof value === 'object' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(String(n), 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return `${V}.${Buffer.concat([iv, tag, body]).toString('base64url')}`;
  } catch {
    /* A seal that cannot be made is not a reason to send the number in the clear —
       the caller gets null and the explain falls back to the add-back path. */
    return null;
  }
}

/**
 * A blob → the number, or null for anything this process cannot open: a different
 * key, a restart, a truncated value, a forged one. NEVER throws, and never returns a
 * number it did not itself authenticate — the GCM tag is what makes a tampered blob
 * fail rather than decode to something plausible.
 */
function open(blob) {
  if (typeof blob !== 'string' || !blob.startsWith(`${V}.`)) return null;
  try {
    const raw = Buffer.from(blob.slice(V.length + 1), 'base64url');
    if (raw.length < 12 + 16 + 1) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Is this string shaped like one of our seals? Used to tell a seal from a number. */
function isSealed(v) { return typeof v === 'string' && v.startsWith(`${V}.`); }

module.exports = { seal, open, isSealed, keyIsConfigured, keySource, V, _internals: { key, DERIVE_LABEL } };
