'use strict';
/**
 * #213 (launch blocker 2) — DOMAIN-BASED committee routing.
 *
 * The committee (committee.js) reviews a proposed finding with a panel of
 * specialist reviewers. The ORIGINAL routing picked specialists purely by a
 * finding-CODE prefix match (`applies_to` startsWith), and when NO prefix
 * matched it fell back to a fixed fraud/identity/credit panel. That is brittle
 * in a way that is dangerous under the owner's "never miss a real issue" rule:
 * every specialist prompt is biased to REFUTE-when-uncertain, so a real finding
 * routed to the WRONG lens (e.g. a title finding shown only to fraud/identity/
 * credit) gets refuted at high confidence by specialists it doesn't belong to —
 * and the adjudicator's 2/3-refute rule then DISMISSES a genuine issue that no
 * qualified specialist ever actually reviewed.
 *
 * This module fixes routing at the root: it maps a finding to its DOMAIN(S)
 * from multiple signals (explicit domain, code keywords, document source, field
 * name) — not a single code prefix — and returns the specialists that genuinely
 * cover those domains, plus whether the finding is COVERED at all. An UNCOVERED
 * finding (no qualified specialist) must never be auto-dismissed; the adjudicator
 * holds it for a human (abstain-on-uncertainty at the routing layer).
 *
 * PURE + dependency-free (does not require committee.js — the specialist set is
 * passed in, so there is no circular dependency). NEVER THROWS.
 */

// The canonical committee DOMAINS. These line up 1:1 with the specialist keys in
// committee.js SPECIALISTS, so a domain name IS the specialist that covers it.
const DOMAINS = Object.freeze(['identity', 'entity', 'credit', 'fraud', 'appraisal', 'title', 'insurance']);

// 'fraud' is a cross-cutting SAFETY lens: any sanctions / tampering / fraud
// signal always pulls in the fraud specialist regardless of the primary domain.
const FRAUD_SIGNAL = /(ofac|sdn|sanction|pep|fraud|tamper|forg|straw|identity[_-]?theft|synthetic)/i;

// The last-resort panel when nothing routes — still gives the finding SOME
// independent review, but the route is flagged uncovered so the adjudicator
// holds rather than dismisses.
const SAFETY_PANEL = Object.freeze(['fraud', 'identity', 'credit']);

function str(v) { return v == null ? '' : String(v); }
function low(v) { return str(v).trim().toLowerCase(); }

// Normalize a code/field/source string to space-separated tokens so that
// underscores, hyphens and camelCase-ish separators all become spaces. This lets
// us match padded tokens (" arv ") reliably — a \b word-boundary does NOT work
// around underscores (they are word characters), so "arv_defensibility" would
// otherwise never match \barv\b.
function normTokens(s) { return ' ' + low(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }

// Code / field keyword → domain, matched against the SPACE-NORMALIZED text (every
// separator is a space, both ends padded). Substring/token match, not prefix, so
// "undisclosed_liens" or "title_vesting_mismatch" both land on 'title'.
const KEYWORD_DOMAINS = Object.freeze([
  // fraud / sanctions (listed first so an ofac_* code is unambiguously fraud)
  [/(ofac|sdn|sanction| pep |fraud|tamper|forg|straw|synthetic|identity theft)/, 'fraud'],
  // identity
  [/(borrower name| dob |date of birth| ssn |photo| id expired| id missing| id mismatch|drivers? licen|passport|subject mismatch)/, 'identity'],
  // entity / LLC
  [/(entity| llc | ein |good standing|signing authority|beneficial owner|operating agreement|articles|member|manager)/, 'entity'],
  // credit
  [/(fico|credit|tradeline|derog|undisclosed debt|undisclosed mortgage|mortgage late|bankruptc|foreclosure|liabilit)/, 'credit'],
  // appraisal / collateral
  [/(appraisal| arv |as is value|property type| units? |comp grid|comparable|value variance|value defensib|condition)/, 'appraisal'],
  // title
  [/(title|vesting|lien|encumbrance|seller of record|legal descr|chain of title|judgment|exception)/, 'title'],
  // insurance / flood
  [/(insur| hoi |coverage|mortgagee|flood|effective date|insured)/, 'insurance'],
]);

// Document source (docType) → domain, also matched against SPACE-NORMALIZED text.
// A finding raised while reading a specific document type inherits that document's
// domain even when the code is generic.
const SOURCE_DOMAINS = Object.freeze([
  [/(appraisal|bpo|avm|valuation|comp)/, 'appraisal'],
  [/(title|commitment|prelim|vesting|deed)/, 'title'],
  [/(insur| hoi |flood|hazard|binder|policy)/, 'insurance'],
  [/(credit|tradeline)/, 'credit'],
  [/(operating agreement|articles|entity| llc |formation| ein )/, 'entity'],
  [/(passport|drivers? licen|photo id| id )/, 'identity'],
  [/(ofac|sanction|background|watchlist)/, 'fraud'],
]);

/**
 * domainsOf(finding) → string[]  (subset of DOMAINS, possibly empty). PURE, never throws.
 * Unions every domain signal: an explicit finding.domain/committee_domain, the
 * finding code, the document source, and the field name.
 */
function domainsOf(finding) {
  const set = new Set();
  try {
    const f = finding || {};
    // 1. explicit domain hint(s)
    for (const d of [f.domain, f.committee_domain]) {
      const dl = low(d);
      if (DOMAINS.includes(dl)) set.add(dl);
    }
    // 2. code + field + title keywords
    const codeField = normTokens(low(f.code) + ' ' + low(f.field) + ' ' + low(f.title));
    for (const [re, dom] of KEYWORD_DOMAINS) { if (re.test(codeField)) set.add(dom); }
    // 3. document source
    const src = normTokens(low(f.source) + ' ' + low(f.docType) + ' ' + low(f.doc_type));
    for (const [re, dom] of SOURCE_DOMAINS) { if (re.test(src)) set.add(dom); }
  } catch (_e) { /* fall through — empty set */ }
  return Array.from(set);
}

/**
 * routeFinding(finding, specialists) → { domains, specialists, covered }  (PURE, never throws)
 *   specialists: the committee's SPECIALISTS map (key → { applies_to, ... }); used
 *                for back-compat CODE-PREFIX matching AND to know which keys exist.
 *   returns:
 *     domains     — the domains the finding resolved to (may be empty)
 *     specialists — the specialist keys to consult (always ≥1 when any exist)
 *     covered     — true when at least one QUALIFIED specialist (by domain or by
 *                   the finding's own applies_to prefix) was selected. false means
 *                   only the safety panel ran → the adjudicator must HOLD, never dismiss.
 */
function routeFinding(finding, specialists) {
  const available = specialists && typeof specialists === 'object' ? Object.keys(specialists) : DOMAINS.slice();
  const has = (k) => available.includes(k);
  try {
    const f = finding || {};
    const domains = domainsOf(f);
    const selected = new Set();

    // (a) domain match — a specialist whose key is one of the resolved domains.
    for (const d of domains) { if (has(d)) selected.add(d); }

    // (b) back-compat: the specialist's own applies_to code-prefix still counts
    // as a qualified match (preserves every route the old logic produced).
    const code = low(f.code);
    if (specialists && typeof specialists === 'object') {
      for (const [key, spec] of Object.entries(specialists)) {
        const applies = spec && Array.isArray(spec.applies_to) ? spec.applies_to : [];
        if (applies.some((pfx) => code.startsWith(low(pfx)))) selected.add(key);
      }
    }

    let covered = selected.size > 0;

    // (c) fraud is a cross-cutting SAFETY lens — always add it on any fraud/
    // sanctions/tampering signal. This is itself a qualified (fraud-domain) match.
    const signalText = low(f.code) + ' ' + low(f.field) + ' ' + low(f.title) + ' ' + low(f.source);
    if (FRAUD_SIGNAL.test(signalText) && has('fraud')) { selected.add('fraud'); covered = true; }

    if (selected.size === 0) {
      // Nothing routed — run a small safety panel so the finding still gets some
      // independent eyes, but mark it UNCOVERED so the adjudicator holds it.
      const panel = SAFETY_PANEL.filter(has);
      return { domains, specialists: panel.length ? panel : available.slice(0, 3), covered: false };
    }
    return { domains, specialists: Array.from(selected), covered };
  } catch (_e) {
    // Fail safe — a tiny uncovered panel, never a throw.
    const panel = SAFETY_PANEL.filter(has);
    return { domains: [], specialists: panel.length ? panel : available.slice(0, 3), covered: false };
  }
}

module.exports = { DOMAINS, domainsOf, routeFinding, _internals: { KEYWORD_DOMAINS, SOURCE_DOMAINS, FRAUD_SIGNAL, SAFETY_PANEL } };
