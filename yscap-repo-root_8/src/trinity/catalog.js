'use strict';

/**
 * WHAT TRINITY WILL ACTUALLY SELL US — read from THEIR list, never from a list we keep
 * (owner-directed 2026-08-21, item 25: *"you need to make sure that the product that you ordered is
 * the correct product. I want to make sure to get the list of products and that we're ordering the
 * correct product."*).
 *
 * PURE. It is handed whatever `GET /api/v1.1/forms` returned and says what is in it — no network, no
 * database, no requires — so the shape can be reasoned about, unit-tested against a captured payload,
 * and read by both the admin health page and the coordinator's own screen without a second copy.
 *
 * WHY IT IS READ LIVE. Trinity's own documentation warns that *"not all form types are available to
 * all customers in production"*, and that is not theoretical here: the SANDBOX company carries form
 * 19 ("Blank General Purpose Line Item Draw") and the PRODUCTION company does NOT — it carries 1079
 * ("General Purpose Line Item Draw PCR") instead. Same product, same schema to the field, different
 * id. A hard-coded catalogue would have been right in testing and wrong on the first real order.
 *
 * THE SHAPE IS NOT PROMISED. Trinity returns a nested tree (categories carrying forms) and the exact
 * nesting has changed between versions, so `flattenForms` walks whatever arrives and collects every
 * node that looks like a product — an id and a name. Anything it cannot read is REPORTED as unread,
 * never guessed at: an empty list means "we could not read their catalogue", which is a different
 * statement from "they sell nothing", and the two must never be shown as the same thing.
 */

/** Every {id, name} in whatever tree Trinity returned, deduped, in the order found. */
function flattenForms(node) {
  const out = [];
  const seen = new Set();
  (function walk(n, category) {
    if (Array.isArray(n)) return n.forEach((x) => walk(x, category));
    if (!n || typeof n !== 'object') return;
    const id = Number(n.id);
    const name = typeof n.name === 'string' ? n.name.trim() : '';
    // A product is an id AND a name together. A category node carries a name and no numeric id;
    // its own name is carried down so a product can say which family it belongs to.
    if (Number.isFinite(id) && name && !seen.has(id)) {
      seen.add(id);
      out.push({ id, name, category: category || null });
    }
    const nextCategory = (!Number.isFinite(id) && name) ? name : category;
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object') walk(v, nextCategory);
    }
  })(node, null);
  return out;
}

/** Loose word match, so "SFR Drone Inspection" is found however it is capitalised or spaced. */
function nameHas(name, words) {
  const n = String(name || '').toLowerCase();
  return words.every((w) => n.includes(String(w).toLowerCase()));
}

/**
 * Is the product we order actually on this account, and what else is?
 *
 * @param formsPayload  exactly what `client.forms()` returned (or null when it could not be read)
 * @param wantId        the form id we order (client.formId())
 */
function productCheck(formsPayload, wantId) {
  const want = Number(wantId);
  const products = flattenForms(formsPayload);
  if (!products.length) {
    return {
      formId: want, enabled: null, read: false, products: [],
      message: 'Trinity’s product list could not be read, so the product we order could not be checked. '
        + 'It is NOT a statement that the product is missing.',
    };
  }
  const ours = products.find((p) => p.id === want) || null;
  const enabled = !!ours;
  return {
    formId: want, enabled, read: true, products, ours,
    /* WHAT WE ORDER, AND WHY IT IS THAT ONE. Form 19 / 1079 is the DOLLAR-based line-item draw —
       the only shape whose lines carry the construction budget, this draw's request per line, what
       was drawn before and what the inspector approved. The percent-based draw cannot express
       dollars at all. (docs/TRINITY-INSPECTION-API-RESEARCH.md §2.) */
    message: enabled
      ? `We order “${ours.name}” (form ${want}) — the dollar-based line-item draw, which is the only `
        + 'product that can carry the construction budget line by line.'
      /* "NOT enabled on this Trinity account" is the wording the API-Health page has carried since
         2026-08-16 and that the desk test pins — the same sentence, now stated once here. */
      : `Form ${want} is NOT enabled on this Trinity account, so every order would be refused. This account `
        + `offers: ${products.map((p) => `${p.id} ${p.name}`).join(' · ')}.`,
    /* THE OWNER NAMED A PRODUCT — "for any 1:4, they call it an SFR drone inspection". This does not
       decide anything and never picks a product: it reports whether a product answering to that name
       is on OUR account, so the question can be settled by looking at Trinity's own list instead of
       by anybody's memory. A DRAW is what we order; if Trinity sells the drone inspection as a
       separate product it is a different order type and needs the owner's word before it is used. */
    droneProducts: products.filter((p) => nameHas(p.name, ['drone'])
      || nameHas(p.name, ['sfr']) || nameHas(p.name, ['single family'])),
  };
}

module.exports = { flattenForms, productCheck, nameHas };
