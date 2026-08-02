'use strict';

/**
 * registration-guard.js — the REGISTRATION MUST AGREE WITH THE APPLICATION
 * (owner-directed 2026-07-31: "the property type cannot disagree between the
 * application and the registration. If it disagrees then it should fail the
 * registration. It should come up an error … very important also look on other
 * fields — probably there's more fields that I didn't realize").
 *
 * THE REPORTED BUG: a file whose application says SFR was priced in the studio
 * as "2-4 units" and REGISTERED that way — the studio's propertyType override
 * wins in pricing.buildInputs, is never written back onto the application, and
 * nothing refused the mismatch. So the loan was priced (Gold: ±50 bps units24
 * adjustment) on a property the file says is a different kind of building, and
 * the two records disagreed forever.
 *
 * THE CLASS: every STRK/NUMK override in buildInputs that (a) has no file-wins
 * guard and (b) is never written back by persistProductRegistration. Audited
 * 2026-07-31, that set is: propertyType, units, loanType (purchase vs
 * refinance), strategy (deal program), state. (address/city are already
 * file-protected in buildInputs; arv/rehab/term/IR/assignment/experience are
 * written back so they converge; purchase price + as-is are studio-LOCKED for
 * staff.)
 *
 * THE RULE: compare by MEANING, never by spelling (the db/288 / db/322 / db/326
 * hard rule) — and when either side cannot be classified, STAY SILENT rather
 * than guess (a false refusal blocks a legitimate registration, which is the
 * expensive direction). Concretely:
 *   • property type compares by BUCKET (1-unit vs 2–4 vs 5+ vs mixed), because
 *     the studio only distinguishes "SFR (1 unit)" / "2-4 units" — a Condo file
 *     registered as "SFR (1 unit)" is the SAME bucket and must not refuse.
 *   • units compare numerically when both sides carry one.
 *   • loan type compares purchase-vs-refinance class ("Cash-out refinance" is
 *     refinance class).
 *   • strategy compares coarse deal classes (ground-up / bridge / fix&flip /
 *     rental-hold) — only when BOTH sides classify.
 *   • state compares by the shared address.stateCompareKey ("New York" ≡ "NY").
 *
 * PURE — no DB. The staff register route refuses 422 {error code
 * 'file_mismatch'} listing every conflict; the studio panel shows the same
 * list. Fixing either side (the application details, or the studio pick) and
 * re-registering clears it. Test: scripts/test-registration-file-match-pure.js.
 */

const { propertyTypeKey, LABEL_OF } = require('./property-type');

// ---- classifiers (each returns null = "cannot tell, stay silent") ----------

/** Coarse property bucket: '1' (SFR/condo/town/PUD), '2_4', '5_plus', 'mixed'. */
function propertyBucket(raw) {
  const key = propertyTypeKey(raw);
  if (!key) return null;
  if (key === 'multi_2_4') return '2_4';
  if (key === 'multi_5_plus') return '5_plus';
  if (key === 'mixed_use') return 'mixed';
  return '1'; // sfr / condo / townhouse / pud — all one-unit style
}

const BUCKET_LABEL = Object.freeze({
  1: 'a 1-unit property (SFR / condo / townhouse / PUD)',
  '2_4': 'a 2–4 unit property',
  '5_plus': 'a 5+ unit property',
  mixed: 'a mixed-use property',
});

/** 'purchase' | 'refinance' | null. */
function loanTypeClass(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (/refi|refinance|cash[\s-]*out|rate[\s-]*(and|&|\/)?[\s-]*term/.test(s)) return 'refinance';
  if (/purchase|acquisition|buy/.test(s)) return 'purchase';
  return null;
}

/** Coarse deal-strategy class: 'ground' | 'bridge' | 'fixflip' | 'hold' | null. */
function strategyClass(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (/ground|new[\s-]*construction|gup/.test(s)) return 'ground';
  if (/bridge/.test(s)) return 'bridge';
  if (/dscr|rental|hold|buy[\s-]*(and|&|n)[\s-]*hold/.test(s)) return 'hold';
  if (/fix|flip|rehab|renovat|brrr/.test(s)) return 'fixflip';
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// stateCompareKey lives in address.js; required lazily so this module stays
// loadable in the pure test even if address.js grows dependencies.
function stateKey(raw) {
  try { return require('./address').stateCompareKey(raw) || null; }
  catch (_) { return null; }
}

/**
 * Every place the studio's overrides disagree with the application record.
 * @param {object} app       the applications row (property_type, units,
 *                           loan_type, program, property_address)
 * @param {object} overrides the raw client overrides sent to register
 * @returns {Array<{key,label,fileValue,studioValue,message}>}
 */
function registrationFileConflicts(app, overrides) {
  const a = app || {};
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const out = [];

  // ---- property type (the reported bug) ----
  if (o.propertyType != null && String(o.propertyType).trim() !== '') {
    const fileB = propertyBucket(a.property_type);
    const studioB = propertyBucket(o.propertyType);
    if (fileB && studioB && fileB !== studioB) {
      out.push({
        key: 'property_type',
        label: 'Property type',
        fileValue: String(a.property_type),
        studioValue: String(o.propertyType),
        message: `The application says the property is ${BUCKET_LABEL[fileB]}, but the studio priced it as ${BUCKET_LABEL[studioB]}.`,
      });
    }
  }

  // ---- units (same class, reachable by any API caller) ----
  const oUnits = num(o.units);
  const aUnits = num(a.units);
  if (oUnits != null && aUnits != null && oUnits !== aUnits) {
    out.push({
      key: 'units',
      label: 'Units',
      fileValue: String(aUnits),
      studioValue: String(oUnits),
      message: `The application says ${aUnits} unit${aUnits === 1 ? '' : 's'}, but the registration was priced on ${oUnits}.`,
    });
  }

  // ---- loan type (purchase vs refinance) ----
  if (o.loanType != null && String(o.loanType).trim() !== '') {
    const fileL = loanTypeClass(a.loan_type);
    const studioL = loanTypeClass(o.loanType);
    if (fileL && studioL && fileL !== studioL) {
      out.push({
        key: 'loan_type',
        label: 'Loan type',
        fileValue: String(a.loan_type),
        studioValue: String(o.loanType),
        message: `The application says this is a ${fileL} loan, but the studio priced it as a ${studioL}.`,
      });
    }
  }

  // ---- strategy / deal program (ground-up vs fix&flip vs bridge) ----
  if (o.strategy != null && String(o.strategy).trim() !== '') {
    const fileS = strategyClass(a.program);
    const studioS = strategyClass(o.strategy);
    if (fileS && studioS && fileS !== studioS) {
      const NAMES = { ground: 'ground-up construction', bridge: 'a bridge deal', fixflip: 'a fix & flip', hold: 'a rental / hold' };
      out.push({
        key: 'strategy',
        label: 'Deal type',
        fileValue: String(a.program),
        studioValue: String(o.strategy),
        message: `The application says the deal is ${NAMES[fileS]}, but the studio priced it as ${NAMES[studioS]}.`,
      });
    }
  }

  // ---- subject state ----
  if (o.state != null && String(o.state).trim() !== '') {
    const addr = a.property_address && typeof a.property_address === 'object' ? a.property_address : {};
    const fileK = stateKey(addr.state);
    const studioK = stateKey(o.state);
    if (fileK && studioK && fileK !== studioK) {
      out.push({
        key: 'state',
        label: 'Property state',
        fileValue: String(addr.state),
        studioValue: String(o.state),
        message: `The application's property is in ${String(addr.state)}, but the studio priced it in ${String(o.state)}.`,
      });
    }
  }

  return out;
}

/** One plain-language refusal message for a conflict list. */
function conflictMessage(conflicts) {
  const lines = (conflicts || []).map((c) => `• ${c.label}: the application says “${c.fileValue}” but the studio says “${c.studioValue}”.`);
  return 'The registration does not match the application, so it was not saved. '
    + 'The application and the registration must agree — fix the application details (or the studio pick) and register again.\n'
    + lines.join('\n');
}

module.exports = {
  registrationFileConflicts,
  conflictMessage,
  _internals: { propertyBucket, loanTypeClass, strategyClass },
  BUCKET_LABEL,
  PROPERTY_LABELS: LABEL_OF,
};
