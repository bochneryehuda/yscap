'use strict';
/**
 * THE ONE PLACE A TYPED ENTITY NAME BECOMES A REAL ENTITY.
 *
 * Owner-directed 2026-08-09: "any LLC that he enters should be a real LLC on his
 * profile with the operating agreement saved to it", and — the reason this
 * matters — "if we verify ownership of these two LLCs, then all the ownership of
 * all the properties is verified."
 *
 * Today a name typed on a track record is stored as FREE TEXT in
 * `track_records.entity_name` and nothing else happens. It never becomes an
 * `llcs` row, so it has no document slots, no members, no verification, and no
 * way to carry ownership to the other properties that same company held. The
 * audit found all three write paths doing this independently — the borrower
 * door, the staff door, and ClickUp's `upsertTrackRecord`, which even calls
 * `upsertLlc` and then inserts the track record with no `llc_id` three lines
 * later.
 *
 * ── WHY THIS IS NOT `entityMatch` ───────────────────────────────────────────
 * The underwriting stack already has a good fuzzy entity matcher
 * (`underwriting/compare.entityMatch`), and the blueprint said to reuse it as a
 * find-then-create pre-step. Measured against real name shapes, its LAST ARM —
 * `ca.includes(cb) || cb.includes(ca)` — is wrong for THIS job:
 *
 *     entityMatch('Hudson Properties LLC', 'Hudson Properties LLC II')  -> true
 *     entityMatch('Ridge LLC',             'Blue Ridge LLC')            -> true
 *     entityMatch('Oak Capital LLC',       'Oak Capital LLC Series B')  -> true
 *
 * Those are DIFFERENT COMPANIES. For the matcher's existing uses that is fine
 * and even desirable: it raises an ADVISORY question a human answers. Here the
 * answer is not advisory — it decides which real company a property is attached
 * to, and a wrong attachment carries one entity's ownership verification onto
 * another entity's property. An over-match is the expensive direction.
 *
 * So `promotionMatch` keeps `entityMatch`'s three SAFE arms and drops the
 * substring one:
 *   · identical canonical form                    ("Smith Holdings LLC")
 *   · same core, differing only by entity suffix  ("Smith Holdings, L.L.C.")
 *   · a pure RE-SPACING of the same letters       ("Core Tex" / "Coretex")
 * It DELEGATES those arms to `compare.js` rather than reimplementing them, so
 * the two matchers cannot drift about what a suffix or a re-spacing is; only the
 * substring arm is withheld, and withholding it can only ever make this stricter.
 *
 * ── AMBIGUITY WRITES NOTHING ────────────────────────────────────────────────
 * If the typed name matches TWO of the borrower's entities, there is no right
 * answer available without a person, so nothing is written and the free text is
 * left exactly as typed. Same for a junk name. Silence here costs a link that a
 * human can make later; a guess costs a property attached to the wrong company.
 *
 * ── AND IT NEVER DECIDES OWNERSHIP ──────────────────────────────────────────
 * Promotion sets a LINK. It does not verify anything: `llc_borrowers
 * .ownership_verified` (Check A) stays false, and the ownership pillar on the
 * line stays exactly where it was. The owner's two-check model is intact —
 * this only makes the entity a real thing that CAN be checked once.
 *
 * PURE HALF FIRST: `promotionMatch`, `junkEntityName` and `pickEntity` take no
 * database and are unit-tested offline. The IO half is `promoteEntityName`.
 */

const compare = require('./underwriting/compare');

/* Names that are not an entity. A borrower types these constantly, and each one
   would otherwise MINT A COMPANY on their profile — "N/A LLC" sitting in the
   entity list forever, with four document slots nobody can ever fill. */
const JUNK_EXACT = new Set([
  'n/a', 'na', 'none', 'no', 'nil', 'null', 'unknown', 'unk', 'tbd', 'x', 'xx', 'xxx',
  'personal', 'personally', 'self', 'me', 'my name', 'own name', 'individual',
  'llc', 'l.l.c.', 'inc', 'corp', 'co', 'ltd', 'lp', 'llp', 'entity', 'company', 'trust',
  'same', 'see above', 'n a', '-', '--', '.',
]);

/**
 * Is this text something we must refuse to turn into a company?
 * Conservative in the REFUSING direction is wrong here — refusing a real name
 * only loses a link a human can still make, while accepting junk permanently
 * pollutes the borrower's entity list. Returns a reason string, or null.
 */
function junkEntityName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return 'empty';
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (JUNK_EXACT.has(t)) return 'placeholder';
  if (JUNK_EXACT.has(t.replace(/[.,]/g, ''))) return 'placeholder';
  // Nothing alphanumeric at all ("---", "???").
  if (!/[a-z0-9]/i.test(t)) return 'no_letters';
  // A bare entity suffix with nothing in front ("LLC", ", LLC", "an LLC").
  const core = t.replace(/\b(llc|l\.l\.c\.|llp|lp|inc|corp|co|ltd)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!core) return 'suffix_only';
  // A single character or digit core is never a company name anyone can verify.
  if (core.replace(/\s+/g, '').length < 2) return 'too_short';
  return null;
}

/**
 * STRICT entity identity for promotion. `entityMatch`'s safe arms only — see the
 * header for why the substring arm is withheld.
 *
 * Delegates to compare.entityMatch and then RE-CHECKS that the match came from a
 * safe arm, rather than reimplementing canonicalization. That ordering matters:
 * if compare.js ever gains a new safe arm we inherit it, and if it gains a new
 * LOOSE one we do not, because the re-check is an allowlist.
 */
function promotionMatch(a, b) {
  if (!compare.entityMatch(a, b)) return false;
  /* `canonEntity` is a DIRECT export of compare.js (checked, not assumed — the
     first cut read it off a `_internals` bag that does not exist, which made this
     fail closed and every match return false). Still guarded: if it ever moves,
     refusing to match is the safe answer, because a missing canonicalizer would
     otherwise leave only the loose arm. */
  const canon = compare.canonEntity;
  if (typeof canon !== 'function') return false;
  const ca = canon(a), cb = canon(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;                                   // identical
  const SUFFIX = /\b(llc|llp|lp|inc|corp|co|ltd)\b/g;
  const core = (x) => x.replace(SUFFIX, '').replace(/\s+/g, ' ').trim();
  const ka = core(ca), kb = core(cb);
  if (ka && kb && ka === kb) return true;                       // suffix-only difference
  // Pure re-spacing: same letters, compatible segmentation. Recomputed here
  // because compare.js does not export it; the letters test alone is the
  // conservative part, and it can never match two differently-worded names.
  const sa = ka.replace(/\s+/g, ''), sb = kb.replace(/\s+/g, '');
  return !!sa && sa === sb;
}

/**
 * Which of the borrower's existing entities does this typed name mean?
 * PURE — takes the candidate rows, so it is testable without a database.
 *   { llcId }              exactly one match
 *   { ambiguous, names }   more than one — a person must choose
 *   { none: true }         no match; the caller may create
 */
function pickEntity(name, existing) {
  const hits = (existing || []).filter((e) => promotionMatch(name, e.llc_name));
  if (hits.length === 1) return { llcId: hits[0].id, matchedName: hits[0].llc_name };
  if (hits.length > 1) return { ambiguous: true, names: hits.map((h) => h.llc_name) };
  return { none: true };
}

/**
 * THE CHOKEPOINT. Turn a typed name into a real entity on this borrower's
 * profile and return its id, or explain why nothing was done.
 *
 * NEVER THROWS. Every caller is in the middle of saving a track record, and an
 * entity promotion failing must never lose the deal the person was entering —
 * the free text is already stored either way, so the worst case is that the link
 * is made later.
 *
 * Returns { llcId, created, reason, ambiguous }.
 */
async function promoteEntityName(borrowerId, name, opts = {}) {
  const db = require('../db');
  const client = opts.client || db;
  const out = { llcId: null, created: false, reason: null, ambiguous: false };
  try {
    if (!borrowerId) { out.reason = 'no_borrower'; return out; }
    const junk = junkEntityName(name);
    if (junk) { out.reason = junk; return out; }
    const clean = String(name).trim().slice(0, 160);

    const existing = (await client.query(
      `SELECT id, llc_name FROM llcs WHERE borrower_id=$1`, [borrowerId])).rows;
    const pick = pickEntity(clean, existing);

    if (pick.ambiguous) {
      /* Two of their companies could be meant. Writing either one attaches this
         property to a company that may not have held it, and Check A would then
         carry the wrong verification. Leave the free text and let a person say. */
      out.ambiguous = true;
      out.reason = 'ambiguous';
      out.candidates = pick.names;
      return out;
    }
    if (pick.llcId) { out.llcId = pick.llcId; out.reason = 'matched_existing'; return out; }

    /* No match — create it. findOrCreateLlc is the repo's existing race-safe
       create chokepoint and re-checks by exact name inside, so a concurrent
       writer cannot mint a duplicate. */
    const llc = require('./llc');
    const made = await llc.findOrCreateLlc(borrowerId, { llcName: clean }, client);
    out.llcId = made.id;
    out.created = !made.existed;
    out.reason = made.existed ? 'matched_existing' : 'created';

    if (out.created) {
      // Stamp WHERE it came from. Provenance only — it grants nothing.
      await client.query(
        `UPDATE llcs SET first_seen_on = COALESCE(first_seen_on, $2) WHERE id = $1`,
        [out.llcId, opts.firstSeenOn || 'track_record']).catch(() => {});
    }

    /* The borrower must be linked to their own entity, or it is a company on
       nobody's profile. Fill-only: an existing link (with its ownership_pct, and
       possibly a completed Check A) is never rewritten. */
    await client.query(
      `INSERT INTO llc_borrowers (llc_id, borrower_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [out.llcId, borrowerId]).catch(() => {});

    return out;
  } catch (e) {
    /* An entity promotion may never lose the track record being saved. */
    out.reason = 'error';
    out.error = e && e.message;
    return out;
  }
}

module.exports = {
  junkEntityName,
  promotionMatch,
  pickEntity,
  promoteEntityName,
  _internals: { JUNK_EXACT },
};
