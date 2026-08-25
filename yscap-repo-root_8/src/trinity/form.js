'use strict';

/**
 * WHICH TRINITY FORM WE ORDER — one definition, for the default, the choice, and the warning.
 *
 * Owner-directed 2026-08-24: *"I know Form 19 is only for the test environment. We need to change
 * it for the production environment … We should also have the option to change forms and order
 * different forms, but this should be the default and should give you a warning if you are trying
 * to change. By default, the system, by physical inspection, should order the real form, not the
 * 19 form, because the 19 is only on test accounts. The same idea of 19, but in the production
 * account … basically for SFR general purpose line item draw."*
 *
 * THE FACT BEHIND THE DEFAULT, captured from Trinity's own two accounts rather than remembered:
 * the SANDBOX company carries form 19 ("Blank General Purpose Line Item Draw") and the PRODUCTION
 * company does NOT — it carries 1079 ("General Purpose Line Item Draw PCR"). Trinity's own
 * documentation warns of exactly this: *"not all form types are available to all customers in
 * production."* `docs/trinity/api/forms.json` is the TEST account's list (19 present, 1079 absent);
 * the owner's screenshot of the production account is the mirror image.
 *
 * SAME PRODUCT, SAME SCHEMA TO THE FIELD, DIFFERENT ID — and that is what makes moving the default
 * safe rather than a rewrite. Read straight out of `docs/trinity/api/swagger-v1.1.json`,
 * `POST /api/v1.1/forms/{form}/new` takes the SAME request model
 * `DollarLineItemDollarLineItemTotalBudgetedOrderModelProjectModel` on 19, 139, 150, 159, 1074,
 * 1079 and 1081. So `mapper.buildOrderPayload` needs no branch, and neither does the read-back's
 * shape — only the id in the URL moves.
 *
 * PURE. No database, no network, no config — the caller passes the effective default and whatever
 * Trinity's catalogue returned. That is what lets the whole rule be unit-tested against the real
 * captured payloads, and it is why the warning wording can never drift between the screen that
 * shows it and the door that applies it.
 */

/** The production draw form — "General Purpose Line Item Draw PCR". The default we order. */
const PRODUCTION_DRAW_FORM_ID = 1079;

/** The sandbox draw form — "Blank General Purpose Line Item Draw". Test accounts only. */
const SANDBOX_DRAW_FORM_ID = 19;

/**
 * Every form whose request model is the DOLLAR line-item draw, verified from Trinity's swagger
 * (see the header). This is NOT a list of things we are happy to order — it is the list whose
 * payload our mapper can build at all. `formProblem` uses it to tell "a different draw form" from
 * "a completely different product", because those deserve different wording.
 */
const DOLLAR_LINE_ITEM_FORMS = Object.freeze([19, 139, 150, 159, 1074, 1079, 1081]);

/**
 * THE PRE-CLOSING BUDGET REVIEW, and the one form the draw door REFUSES rather than warns about.
 *
 * It shares the dollar line-item schema, so it would build and post perfectly happily — and that
 * is the danger: it is a DIFFERENT PRODUCT, billed differently, and it has its OWN door with its
 * OWN gate (the scope of work complete, the contractor on file, the appraisal back with its PDF).
 * Ordering it through the draw door would buy the wrong report, bypass every one of those checks,
 * and leave a record that reads its results back as though they were a draw's.
 */
const BUDGET_REVIEW_FORM_ID = 159;

/** A form id as an integer, or null when it is not one. Never throws. */
function normalizeFormId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** The name Trinity's own catalogue gives a form id, or null when it is not in the list. */
function nameOf(products, formId) {
  const want = normalizeFormId(formId);
  if (want == null || !Array.isArray(products)) return null;
  const hit = products.find((p) => p && Number(p.id) === want);
  return hit && hit.name ? String(hit.name) : null;
}

/**
 * Is this form orderable as a DRAW on this account, and what should the coordinator be told?
 *
 * @param formId    the form they picked
 * @param opts.products   what `catalog.flattenForms(client.forms())` returned — an EMPTY array or
 *                        null means the catalogue could NOT be read, which is a different
 *                        statement from "they sell nothing" and must never be treated as one
 * @param opts.catalogRead  whether the catalogue was genuinely read (defaults to "there are
 *                        products in the list", which is the same test `catalog.productCheck` uses)
 *
 * @returns null when there is nothing wrong, else `{ code, message }`.
 */
function formProblem(formId, { products = null, catalogRead = null } = {}) {
  const want = normalizeFormId(formId);
  if (want == null) {
    return { code: 'not_a_form', message: 'That is not a Trinity form number.' };
  }
  if (want === BUDGET_REVIEW_FORM_ID) {
    return {
      code: 'budget_review',
      message: `Form ${BUDGET_REVIEW_FORM_ID} is the pre-closing budget review, not a draw. `
        + 'Order it from the Budget review section — it has its own checks (the scope of work, the '
        + 'contractor, and the appraisal) that ordering it here would skip.',
    };
  }
  const list = Array.isArray(products) ? products : [];
  const read = catalogRead == null ? list.length > 0 : !!catalogRead;
  if (read && !list.some((p) => p && Number(p.id) === want)) {
    return {
      code: 'not_on_account',
      message: `Form ${want} is not on this Trinity account, so the order would be refused. `
        + `This account offers: ${list.map((p) => `${p.id} ${p.name}`).join(' · ')}.`,
    };
  }
  return null;
}

/**
 * The whole decision, in one answer: which form this order goes out on, whether that is the
 * default, what to warn about, and whether it may go at all.
 *
 * THE ORDER OF THE ANSWERS IS THE POINT. A refusal is decided before a warning, so a coordinator
 * is never shown "are you sure?" about something that was never going to be allowed; and the
 * warning is only ever raised on a form that IS orderable, so pressing through it can never turn
 * into a refusal from Trinity two calls later.
 *
 * @param requested   what the coordinator picked (null / blank = the default, no warning)
 * @param deflt       the configured default (`client.formId()`)
 * @param opts        passed through to `formProblem`
 */
function chooseForm(requested, deflt, opts = {}) {
  const fallback = normalizeFormId(deflt) || PRODUCTION_DRAW_FORM_ID;
  const want = normalizeFormId(requested);

  // Nothing picked, or the default picked back — the ordinary path, byte-for-byte what every
  // caller did before this module existed.
  if (want == null || want === fallback) {
    return { ok: true, formId: fallback, isDefault: true, warning: null, problem: null };
  }

  const problem = formProblem(want, opts);
  if (problem) return { ok: false, formId: null, isDefault: false, warning: null, problem };

  const name = nameOf(opts.products, want);
  const defName = nameOf(opts.products, fallback);
  return {
    ok: true,
    formId: want,
    isDefault: false,
    problem: null,
    warning: `This inspection would be ordered on form ${want}${name ? ` (${name})` : ''} instead of `
      + `the usual form ${fallback}${defName ? ` (${defName})` : ''}. A form is a PRODUCT — a `
      + 'different one is a different report, billed differently, and its results read back '
      + 'differently. Only change it if Trinity has told you to.',
  };
}

/**
 * Which form an EXISTING record's read-backs must use.
 *
 * A record that has already been placed carries the form it went out on, and that is the only
 * form its budget is readable at. A record with nothing recorded is either pre-placement (so the
 * default is what it will go out on) or predates db/628 — where 19 is the fact the backfill wrote.
 */
function formForRow(row, deflt) {
  const stamped = normalizeFormId(row && row.trinity_form_id);
  if (stamped != null) return stamped;
  return normalizeFormId(deflt) || PRODUCTION_DRAW_FORM_ID;
}

module.exports = {
  PRODUCTION_DRAW_FORM_ID, SANDBOX_DRAW_FORM_ID, BUDGET_REVIEW_FORM_ID, DOLLAR_LINE_ITEM_FORMS,
  normalizeFormId, nameOf, formProblem, chooseForm, formForRow,
};
