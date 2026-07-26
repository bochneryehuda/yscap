'use strict';
/**
 * #199 — Party-COLLUSION detector + DOUBLE-PLEDGED-COLLATERAL check (advisory).
 *
 * Two independent fraud red-flags that live at the WHOLE-DEAL level, not inside any
 * single document:
 *
 *  1. PARTY COLLUSION. A clean purchase has independent, arm's-length parties: the
 *     seller, our borrower, the appraiser, the settlement/title agent. When two
 *     parties who are SUPPOSED to be independent turn out to share an identity —
 *     the same name, EIN, street address, phone, or email — that is a conflict of
 *     interest or a straw-buyer signal (an appraiser who is also the seller, a
 *     title agent who is also the borrower, …). This generalizes the assignor↔
 *     assignee non-arm's-length check (assignment-fraud.js) to EVERY independence-
 *     required pair. It deliberately does NOT re-flag assignor↔assignee — that pair
 *     is owned by assignment-fraud.js, so the two never double-flag the same deal.
 *
 *  2. DOUBLE-PLEDGED COLLATERAL. The same subject property pledged as collateral on
 *     more than one live loan is a serious red flag — the borrower may be raising
 *     two loans against one asset. We can only see our OWN book, so this compares
 *     the file's subject property to every other NON-terminal (active or funded —
 *     a funded loan is a live lien) application in the portfolio and flags an exact
 *     address match on a DIFFERENT file.
 *
 * Both are PURE at the core (no DB, no AI) and ADVISORY per the HARD RULE: they
 * emit an ai_suggestion for a human, never auto-decline / auto-condition / auto-
 * block. NEVER THROWS from the pure cores.
 */

const { namesMatchLoose, entityMatch } = require('./compare');
let aiSug = null;
try { aiSug = require('./ai-suggestions'); } catch (_e) { aiSug = null; }

// ---- shared identity helpers (same normalization as assignment-fraud) --------
const digits = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
function normAddr(a) {
  if (!a || typeof a !== 'object') return null;
  const line1 = String(a.line1 || a.address || a.street || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const city = String(a.city || '').trim().toLowerCase();
  const state = String(a.state || '').trim().toLowerCase();
  if (!line1) return null;
  return `${line1}|${city}|${state}`;
}
function normEmail(e) { return String(e || '').trim().toLowerCase() || null; }
function nameLc(n) { return String(n == null ? '' : n).trim().toLowerCase().replace(/\s+/g, ' '); }

/**
 * sharedIdentitySignals(a, b) → { signals:[{type,detail,weight}], weight }  (PURE)
 * The overlap between two parties on name / EIN / address / registered agent /
 * phone / email. Weights mirror assignment-fraud so severity is consistent.
 */
function sharedIdentitySignals(a = {}, b = {}) {
  const signals = [];
  let weight = 0;
  const add = (type, detail, w) => { signals.push({ type, detail, weight: w }); weight += w; };

  const an = nameLc(a.name), bn = nameLc(b.name);
  if (an && bn) {
    if (an === bn) add('same_name_exact', `Both are named "${a.name}"`, 0.55);
    else if (entityMatch(a.name, b.name) === true) add('same_entity_normalized', `Names normalize to the same entity (${a.name} ↔ ${b.name})`, 0.45);
    else if (namesMatchLoose(a.name, b.name) === true) add('same_person_loose', `Names match loosely (${a.name} ↔ ${b.name})`, 0.30);
  }
  const einA = digits(a.ein), einB = digits(b.ein);
  if (einA && einB && einA === einB && einA.length === 9) add('same_ein', `Shared EIN ${einA.slice(0, 2)}-${einA.slice(2)}`, 0.55);

  const adA = normAddr(a.address), adB = normAddr(b.address);
  if (adA && adB && adA === adB) add('same_address', 'Both list the same street address', 0.35);

  const raA = a.registeredAgent && String(a.registeredAgent).trim().toLowerCase();
  const raB = b.registeredAgent && String(b.registeredAgent).trim().toLowerCase();
  if (raA && raB && raA === raB) add('same_registered_agent', `Same registered agent (${a.registeredAgent})`, 0.30);

  const phA = digits(a.phone), phB = digits(b.phone);
  if (phA && phB && phA === phB && phA.length >= 7) add('same_phone', 'Shared phone number', 0.20);

  const eA = normEmail(a.email), eB = normEmail(b.email);
  if (eA && eB && eA === eB) add('same_email', 'Shared email address', 0.20);

  return { signals, weight };
}

// The role pairs that MUST be arm's-length. Ordered pairs are normalized (sorted)
// so a pair is compared once. assignor↔assignee is intentionally ABSENT — owned by
// assignment-fraud.js. Co-role parties (two borrowers, two sellers) are NOT here:
// they legitimately share a household address.
const COLLUSION_PAIRS = Object.freeze([
  ['seller', 'borrower'],       // buyer buying from himself — self-dealing
  ['seller', 'appraiser'],      // the appraiser is the seller — valuation conflict
  ['borrower', 'appraiser'],    // the borrower is the appraiser — valuation conflict
  ['seller', 'title_agent'],    // the settlement agent is a principal
  ['borrower', 'title_agent'],
  ['owner_of_record', 'appraiser'],
  ['owner_of_record', 'borrower'], // buying from the party we're vesting into
]);
const PAIR_SET = new Set(COLLUSION_PAIRS.map((p) => p.slice().sort().join('|')));

const ROLE_LABEL = {
  seller: 'seller', borrower: 'borrower', appraiser: 'appraiser',
  title_agent: 'title / settlement agent', owner_of_record: 'owner of record', broker: 'broker',
};

/**
 * analyzeParties(parties, opts?) → { pairs:[{roleA,roleB,nameA,nameB,confidence,signals}], hasCollusion } (PURE)
 *   parties: [{ role, name, address?, ein?, phone?, email?, registeredAgent? }]
 *   opts: { minConfidence? (default 0.30) }
 * Compares every present independence-required pair (COLLUSION_PAIRS) and reports a
 * hit when shared-identity confidence meets the threshold. NEVER THROWS.
 */
function analyzeParties(parties, opts = {}) {
  try {
    const min = Number.isFinite(opts && opts.minConfidence) ? opts.minConfidence : 0.30;
    const list = (Array.isArray(parties) ? parties : []).filter((p) => p && p.role && p.name);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (A.role === B.role) continue;                       // same role never collusion
        if (!PAIR_SET.has([A.role, B.role].slice().sort().join('|'))) continue;
        const { signals, weight } = sharedIdentitySignals(A, B);
        const confidence = Math.min(1, weight);
        if (signals.length && confidence >= min) {
          out.push({
            roleA: A.role, roleB: B.role,
            labelA: ROLE_LABEL[A.role] || A.role, labelB: ROLE_LABEL[B.role] || B.role,
            nameA: A.name, nameB: B.name, confidence, signals,
          });
        }
      }
    }
    return { pairs: out, hasCollusion: out.length > 0 };
  } catch (_e) {
    return { pairs: [], hasCollusion: false };
  }
}

// ---- double-pledged collateral ----------------------------------------------
// Terminal statuses whose lien is NOT live (a declined/withdrawn deal never
// pledged the property; a funded deal's lien IS live, so funded is NOT terminal).
const TERMINAL_STATUSES = new Set(['declined', 'withdrawn', 'denied', 'cancelled', 'canceled', 'dead']);
function isLiveLien(status) { return !TERMINAL_STATUSES.has(String(status == null ? '' : status).trim().toLowerCase()); }

/**
 * normPropertyKey(addr) → 'street|city|state|zip5' | null  (PURE)
 * A conservative canonical key for a subject property, tolerant of the several
 * property_address jsonb shapes in use (address/street, city, state, zip/zipcode).
 * Requires a street line; returns null when there is nothing to match on (so a
 * blank address can never "match" another blank address).
 */
function normPropertyKey(addr) {
  try {
    if (!addr || typeof addr !== 'object') return null;
    const street = String(addr.address || addr.street || addr.line1 || '')
      .trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
    if (!street) return null;
    const city = String(addr.city || '').trim().toLowerCase();
    const state = String(addr.state || '').trim().toLowerCase();
    const zip = String(addr.zip || addr.zipcode || addr.postal || '').trim().replace(/\D+/g, '').slice(0, 5);
    return `${street}|${city}|${state}|${zip}`;
  } catch (_e) { return null; }
}

/**
 * matchDoublePledge(subjectAddress, otherLoans) → { matches:[...], hasDoublePledge } (PURE)
 *   subjectAddress: this file's property_address jsonb
 *   otherLoans: [{ appId, address, status, borrowerName?, loanNumber? }]
 * A match = another loan whose normalized property key equals the subject's AND
 * whose lien is live (non-terminal). NEVER THROWS.
 */
function matchDoublePledge(subjectAddress, otherLoans) {
  try {
    const key = normPropertyKey(subjectAddress);
    if (!key) return { matches: [], hasDoublePledge: false };
    const matches = [];
    for (const o of (Array.isArray(otherLoans) ? otherLoans : [])) {
      if (!o || !o.appId) continue;
      if (!isLiveLien(o.status)) continue;
      if (normPropertyKey(o.address) !== key) continue;
      matches.push({
        appId: o.appId, status: o.status || null,
        borrowerName: o.borrowerName || null, loanNumber: o.loanNumber || null,
      });
    }
    return { matches, hasDoublePledge: matches.length > 0 };
  } catch (_e) {
    return { matches: [], hasDoublePledge: false };
  }
}

// ---- DB: gather the file's parties from its current extractions --------------
function firstFields(exts, docType) {
  const e = (exts || []).find((x) => x.doc_type === docType || x.docType === docType);
  return e ? (e.fields || {}) : null;
}
function firstName(v) {
  if (v == null) return null;
  const s = (Array.isArray(v) ? v[0] : v);
  const t = s == null ? '' : String(s).trim();
  return t || null;
}

/**
 * gatherParties({ extractions, fileCtx }) → [{ role, name, ... }]  (PURE)
 * Best-effort — reads whatever party names the current extractions + file context
 * expose. Only the NAME is reliably present across docs; address/EIN/phone/email
 * are attached when a document happens to carry them.
 */
function gatherParties(input = {}) {
  const exts = input.extractions || [];
  const ctx = input.fileCtx || {};
  const contract = firstFields(exts, 'purchase_contract') || {};
  const title = firstFields(exts, 'title') || {};
  const appraisal = firstFields(exts, 'appraisal') || {};
  const parties = [];
  const push = (role, name, extra) => { if (name) parties.push(Object.assign({ role, name }, extra || {})); };

  push('seller', firstName(contract.sellerNames || contract.sellerName));
  push('owner_of_record', firstName(title.vestedOwners || appraisal.ownerOfRecord));
  // Our borrower / vesting entity.
  push('borrower', ctx.vestingName || firstName(contract.buyerName));
  // The appraiser + settlement agent, when the document exposes them.
  push('appraiser', firstName(appraisal.appraiserName || appraisal.appraiser || appraisal.preparedBy),
    { phone: appraisal.appraiserPhone, email: appraisal.appraiserEmail });
  push('title_agent', firstName(title.titleCompany || title.closingAgent || title.settlementAgent));
  return parties;
}

/**
 * analyzeAndRecord(client, { applicationId, extractions, fileCtx, traceUrl }) → {ok, hasCollusion, recorded}
 * Records ONE ai_suggestion per colluding pair (deduped per role-pair). Silent when clean.
 */
async function analyzeAndRecord(client, { applicationId, extractions, fileCtx, traceUrl } = {}) {
  if (!aiSug || !applicationId) return { ok: false, hasCollusion: false, recorded: 0 };
  const parties = gatherParties({ extractions, fileCtx });
  const v = analyzeParties(parties);
  if (!v.hasCollusion) return { ok: true, hasCollusion: false, recorded: 0 };
  let recorded = 0;
  for (const p of v.pairs) {
    try {
      await aiSug.record(client, {
        applicationId,
        source: 'party_collusion', kind: 'finding',
        title: `Possible conflict of interest: ${p.labelA} and ${p.labelB} may be the same party`,
        body: `PILOT found ${p.signals.length} signal${p.signals.length === 1 ? '' : 's'} that the ${p.labelA} ("${p.nameA}") and the ${p.labelB} ("${p.nameB}") — who should be independent — may not be (${Math.round(p.confidence * 100)}% confident):\n${p.signals.map((s, i) => `  ${i + 1}. ${s.detail}`).join('\n')}\n\nParties on the two sides of a transaction being the same person can signal a straw-buyer arrangement, an inflated value, or a conflict of interest. Confirm the parties are independent — and if the connection is legitimate, document it on the file (or escalate to a super-admin).`,
        severity: p.confidence >= 0.5 ? 'fatal' : 'warning',
        confidence: p.confidence,
        traceUrl,
        evidence: { roleA: p.roleA, roleB: p.roleB, nameA: p.nameA, nameB: p.nameB, signals: p.signals },
        proposedAction: { type: 'escalate_super_admin', reason: 'party_collusion' },
        dedupeKey: `party_collusion:${[p.roleA, p.roleB].sort().join('_')}`,
      });
      recorded++;
    } catch (_e) { /* one pair failing never aborts the rest */ }
  }
  return { ok: true, hasCollusion: true, recorded };
}

/**
 * checkDoublePledgeAndRecord(client, { applicationId }) → {ok, hasDoublePledge, recorded}
 * Loads the file's subject address, finds other NON-terminal files sharing the exact
 * normalized address, and records ONE advisory suggestion listing the collisions.
 * Read-mostly: the only write is the ai_suggestion. Silent when clean.
 */
async function checkDoublePledgeAndRecord(client, { applicationId, traceUrl } = {}) {
  if (!aiSug || !applicationId) return { ok: false, hasDoublePledge: false, recorded: 0 };
  const me = await client.query(
    `SELECT property_address FROM applications WHERE id = $1 AND deleted_at IS NULL`, [applicationId]);
  const subject = me.rows[0] && me.rows[0].property_address;
  const key = normPropertyKey(subject);
  if (!key) return { ok: true, hasDoublePledge: false, recorded: 0 };

  // Candidate scan: bound it by the same 5-digit zip when the subject has one,
  // else the same city — then confirm the exact normalized key in JS. Excludes
  // this file, soft-deleted files, and terminal (declined/withdrawn) files.
  const zip5 = key.split('|')[3];
  const city = key.split('|')[1];
  const cand = await client.query(
    `SELECT a.id, a.status, a.property_address,
            b.first_name, b.last_name, a.ys_loan_number AS loan_number
       FROM applications a LEFT JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.id <> $1 AND a.deleted_at IS NULL
        AND a.status NOT IN ('declined','withdrawn')
        AND ($2 <> '' AND COALESCE(a.property_address->>'zip', a.property_address->>'zipcode','') LIKE $2 || '%'
             OR $2 = '' AND lower(COALESCE(a.property_address->>'city','')) = $3)
      LIMIT 200`, [applicationId, zip5, city]);
  const others = cand.rows.map((r) => ({
    appId: r.id, status: r.status, address: r.property_address,
    borrowerName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null,
    loanNumber: r.loan_number || null,
  }));
  const v = matchDoublePledge(subject, others);
  if (!v.hasDoublePledge) return { ok: true, hasDoublePledge: false, recorded: 0 };

  const lines = v.matches.map((m, i) => `  ${i + 1}. Loan ${m.loanNumber || '(no #)'}${m.borrowerName ? ` — ${m.borrowerName}` : ''} (status: ${m.status || 'unknown'})`).join('\n');
  await aiSug.record(client, {
    applicationId,
    source: 'double_pledge', kind: 'finding',
    title: 'This property is on more than one active loan',
    body: `The subject property on this file also appears on ${v.matches.length} other active loan${v.matches.length === 1 ? '' : 's'} in PILOT:\n${lines}\n\nThe same property pledged as collateral on two live loans is a serious red flag — confirm these are genuinely different properties (or that the earlier loan paid off) before closing. If it is a legitimate cross-collateralization or a re-vesting, document it on the file.`,
    severity: 'fatal',
    confidence: 0.9,
    traceUrl,
    evidence: { subjectKey: key, matches: v.matches },
    proposedAction: { type: 'escalate_super_admin', reason: 'double_pledged_collateral' },
    dedupeKey: `double_pledge:${key}`,
  });
  return { ok: true, hasDoublePledge: true, recorded: 1 };
}

module.exports = {
  analyzeParties, matchDoublePledge, gatherParties, sharedIdentitySignals, normPropertyKey,
  analyzeAndRecord, checkDoublePledgeAndRecord,
  COLLUSION_PAIRS, _internals: { isLiveLien, normAddr },
};
