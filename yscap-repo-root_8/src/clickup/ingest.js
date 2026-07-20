/**
 * Pull / ingest — ClickUp task → portal. The identity-graph core, shared by the
 * live webhook processor and the historical backfill (docs/BORROWER-HISTORY-BACKFILL.md).
 *
 *   resolveBorrower  — find/create the borrower by SSN-hash (strong) or a >=2
 *                      identity-field match (weak → confirm queue), record contacts.
 *   upsertLlc        — the per-borrower LLC library (unverified, provenance).
 *   upsertTrackRecord— auto track-record from closed files (deal-type inference).
 *   ingestTask       — orchestrates the above + (RTL only) the loan file.
 *
 * Everything is keyed on the immutable ClickUp task_id and idempotent.
 */
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const mapper = require('./mapper');
const F = require('./fields');
const identity = require('./identity');
const statusMap = require('./status');
const crosswalk = require('./crosswalk');
const routing = require('./routing');
const transforms = require('./transforms');
const review = require('../lib/sync-review');
const checklist = require('./checklist');

const RTL_PROGRAMS = new Set(['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction']);
// Raw ClickUp *Program labels that mean "not chosen yet" (the officer will set
// it) — these must be treated like a blank program, NEVER as an unsupported
// program to descope. Matched case-insensitively against read.rawProgram.
const UNSET_PROGRAM_LABELS = new Set(['not sure yet']);
const CLOSED_STATUSES = (s) => statusMap.externalFor(s) === 'funded';
// A 'YYYY-MM-DD' day with a sane year, else null (2026-07-15 incident: raw
// mapper dates written into track_records bypassed the applications year guard).
const saneDay = (v) => {
  if (v == null || v === '') return null;
  const y = Number(String(v).slice(0, 4));
  return y >= 1900 && y <= 2100 ? v : null;
};

function identityFrom(read) {
  const b = read.borrower || {}, a = read.app || {};
  const addr = a.property_address && (a.property_address.formatted_address || a.property_address.oneLine);
  return {
    address: addr, loanNumber: a.ys_loan_number, borrowerName: [b.first_name, b.last_name].filter(Boolean).join(' '),
    dob: b.date_of_birth, email: b.email, ssn: b.ssn, phone: b.cell_phone, purchasePrice: a.purchase_price,
  };
}

/** A masked, structured snapshot of a task's mapped data for long-term
 *  preservation + auditing. SSN → last-4 only; card → boolean. `unmapped` holds
 *  every ClickUp field we did NOT map into the portal (audit: what we're missing). */
function buildMaskedSnapshot(read, extra = {}) {
  const b = read.borrower || {};
  const ssn4 = b.ssn ? String(b.ssn).replace(/\D/g, '').slice(-4) : null;
  return {
    status: read.internalStatus || null,
    rawProgram: read.rawProgram || null,   // raw ClickUp *Program label (non-RTL preserved)
    app: read.app || {},
    borrower: { ...b, ssn: ssn4 ? `***-**-${ssn4}` : undefined },
    llc: read.llc || {},
    unmapped: read.extra || {},
    // The co-borrower READ is preserved (masked) so audits can tell what
    // ClickUp actually carried — previously only the boolean flag survived,
    // which made "why is the co-borrower Unknown" undiagnosable after the fact.
    coBorrower: read.coBorrower
      ? {
          first_name: read.coBorrower.first_name || null,
          last_name: read.coBorrower.last_name || null,
          email: read.coBorrower.email ? String(read.coBorrower.email).replace(/^(..).*(@.*)$/, '$1***$2') : null,
          phone_last4: read.coBorrower.cell_phone ? String(read.coBorrower.cell_phone).replace(/\D/g, '').slice(-4) : null,
        }
      : (read.coBorrowerFlagYes || undefined),
    loanOfficerEmail: extra.loanOfficerEmail || read.loanOfficerEmail || null,
    processorEmail: extra.processorEmail || read.processorEmail || null,
    portalFileId: read.portalFileId || null,
    hasCard: !!read.cardLine,
  };
}

async function recordContacts(borrowerId, borrower, taskId) {
  for (const [kind, val] of [['email', borrower.email], ['phone', borrower.cell_phone]]) {
    if (!val) continue;
    await db.query(
      `INSERT INTO borrower_contacts (borrower_id, kind, value, source)
       VALUES ($1,$2,$3,$4) ON CONFLICT (borrower_id, kind, value) DO NOTHING`,
      [borrowerId, kind, String(val).toLowerCase().trim(), `clickup:${taskId}`]).catch(() => {});
  }
}

/**
 * Resolve the borrower for a task's read fields. Returns { borrowerId, created }.
 * Two auto-merge signals only: (1) an exact SSN-hash (unique per person), or
 * (2) an email match CORROBORATED by a second identity field (last name / phone /
 * DOB). An email ALONE is never enough — per identity.js §3.4 "one field is never
 * enough" — so a shared spouse/broker/attorney email can't collapse two different
 * borrowers. Anything weaker creates a DISTINCT profile (safe over-split; a human
 * can merge) rather than risk a wrong-merge that cross-contaminates PII/loans.
 */
/* Heal-on-match (root fix, 2026-07-14): resolveBorrower used to be a pure
   identity MATCHER — no resolution path ever wrote profile fields back, so a
   row created before ClickUp carried the name stayed "Unknown Unknown"
   FOREVER (re-syncs matched the row and discarded the now-present name).
   Every resolution now fills NULL/empty/PLACEHOLDER fields from the inbound
   read. Real values already stored (human-entered or earlier-synced) are
   NEVER overwritten — this only ever replaces nothing-or-placeholder with
   something. Best-effort: a heal hiccup never blocks ingest. */
async function healBorrowerFields(borrowerId, b, taskId) {
  if (!borrowerId || !b) return;
  const nn = (v) => { const s = String(v == null ? '' : v).trim(); return s ? s : null; };
  const name = (v) => (transforms.isPlaceholderName(v) ? null : nn(v));   // never heal WITH a placeholder
  // DOB GUARDS (2026-07-15 incident). Fill-only semantics are unchanged — these
  // only decide what may FILL and make silent disagreements visible:
  //  * out-of-range year (mid-typing / literal 2-digit year) never fills; it goes
  //    to the review queue with the auto-pivoted proposal (26 -> 1926 for a DOB).
  //  * a ClickUp DOB that DIFFERS from the portal's existing DOB was previously
  //    dropped in silence by COALESCE — now the disagreement is queued so a human
  //    sees it and decides (approve = portal takes ClickUp's value, audited).
  let dobIn = nn(b.date_of_birth);
  if (dobIn) {
    // ONE decision function for every DOB conflict (owner-directed 2026-07-15
    // evening): the auto-resolution engine settles the PROVABLE cases itself —
    // same day in different storage forms, an implausible value (the
    // "12/11/2022 toddler" class) losing to a plausible one, a typed 2-digit-
    // year ClickUp artifact beating a sync-derived profile value — applying
    // the canonical DOB to BOTH systems, journaled. Only genuine ambiguity
    // (two plausible adult DOBs with human provenance) queues a TWO-SIDED
    // review, and the file's loan officer is emailed. Resolver hiccups fall
    // back to strict fill-only semantics — a heal must never break ingest.
    const rawDob = dobIn;
    const FLD = require('../lib/fields');
    try {
      const cur = (await db.query(`SELECT date_of_birth, origin FROM borrowers WHERE id=$1`, [borrowerId])).rows[0] || {};
      const portalDay = cur.date_of_birth ? String(cur.date_of_birth) : null;
      const AR = require('../lib/sync-autoresolve');
      // HUMAN-EDIT-WINS (owner-reported 2026-07-15 night, Shalom Elbaum /
      // 163-165 County Rd: ClickUp's 1/10/91 was corrupted to 1/9/91, the
      // owner FIXED it back in ClickUp and hit resync — and the portal kept
      // the wrong day forever because two plausible differing DOBs park in
      // review). When ClickUp's DOB CHANGED since this task's last ingest —
      // the stored snapshot is the evidence — and the new value is a
      // plausible adult DOB that differs from the portal's, a human edited
      // it AT THE SOURCE deliberately. That correction WINS: adopt it to
      // both systems (journaled, audited) and the stale reviews close —
      // never park a human's explicit fix behind a review click. Our own
      // pushes can't trip this: a value we wrote equals the portal's, which
      // short-circuits as 'agree' below before any snapshot check matters.
      let handled = false;
      const vNew = FLD.sanitizeDob(rawDob);
      if (taskId && vNew && portalDay && vNew !== FLD.sanitizeDob(portalDay)) {
        const prev = (await db.query(`SELECT snapshot FROM clickup_task_index WHERE task_id=$1`, [taskId])).rows[0];
        const prevRaw = prev && prev.snapshot && prev.snapshot.borrower ? prev.snapshot.borrower.date_of_birth : null;
        const vPrev = prevRaw != null ? (FLD.sanitizeDob(String(prevRaw)) || String(prevRaw)) : null;
        if (prevRaw != null && vPrev !== vNew) {
          await AR.adoptDobEverywhere({ borrowerId, day: vNew,
            why: 'clickup_dob_edited_at_source', source: 'clickup_human_edit' });
          dobIn = null; handled = true;
        }
      }
      // BACKDATING provenance (owner-directed 2026-07-15 night: "backdate
      // everything — all other files that were messed up should read the
      // correct thing that was updated in ClickUp"): for a sync-created
      // profile (origin clickup_backfill) whose DOB differs from ClickUp's,
      // PROVE from the audit trail whether any human ever touched the DOB in
      // the portal. Never touched → the portal value is a sync artifact of
      // the incident era and ClickUp's plausible current value wins
      // (decideDob's clickup_current_beats_sync_derived_profile). Any human
      // fingerprint (profile edit, complete-fields, a review resolution) →
      // review, exactly as before. Errors → unknown → review (conservative).
      let portalHumanEdited = null;
      if (!handled && cur.origin === 'clickup_backfill' && portalDay
          && FLD.sanitizeDob(rawDob) && FLD.sanitizeDob(portalDay)
          && FLD.sanitizeDob(rawDob) !== FLD.sanitizeDob(portalDay)) {
        try {
          const he = await db.query(
            `SELECT 1 FROM audit_log al
              WHERE al.actor_kind IN ('staff','borrower')
                AND (
                     (al.entity_type='borrower' AND al.entity_id=$1)
                  OR (al.entity_type='application' AND EXISTS (
                        SELECT 1 FROM applications a2
                         WHERE a2.id = al.entity_id AND (a2.borrower_id=$1 OR a2.co_borrower_id=$1)))
                )
                AND (al.action = 'sync_dob_auto_resolve' OR al.detail::text ILIKE '%date_of_birth%')
              LIMIT 1`, [borrowerId]);
          portalHumanEdited = !!he.rows[0];
        } catch (_) { portalHumanEdited = null; }
      }
      const d = handled ? null : AR.decideDob({ clickupDay: rawDob, portalDay, portalOrigin: cur.origin || null, portalHumanEdited });
      if (handled) { /* adopted the human's source edit — nothing else to decide */ }
      else if (d.outcome === 'adopt') {
        await AR.adoptDobEverywhere({ borrowerId, day: d.value, why: d.why, source: 'auto_resolve_inbound' });
        dobIn = null;   // adoption already wrote both sides — nothing left to fill
      } else if (d.outcome === 'review') {
        // COMMON-SENSE reasons (owner-directed 2026-07-15): "they differ" only
        // when the two sides genuinely differ. The SAME impossible value on
        // both sides (a future birth date, a toddler) says so explicitly.
        const reason = d.kind === 'differs' ? 'clickup_dob_differs_from_portal'
          : d.kind === 'same_impossible' ? 'dob_same_but_impossible'
          : 'clickup_dob_implausible';
        await review.queueReview({ borrowerId, taskId, direction: 'inbound', fieldKey: 'date_of_birth',
          currentValue: portalDay, proposedValue: FLD.sanitizeDob(rawDob) || d.proposal || null, rawValue: rawDob,
          reason, clickupValue: rawDob, portalValue: portalDay });
        dobIn = null;
      } else {
        dobIn = null;   // 'agree' — the portal already holds this day
        // Both systems agree now — any open DOB review for this borrower is
        // stale (fixed at the source); close it, no clicks needed.
        if (portalDay) {
          try { await review.closeStaleReviews({ borrowerId, fieldKey: 'date_of_birth', note: 'auto-closed — both systems now agree on ' + portalDay }); } catch (_) {}
        }
      }
    } catch (e) { dobIn = FLD.sanitizeDob(rawDob); /* strict fill-only fallback */ }
  } else {
    // ClickUp's DOB is BLANK (cleared at the source). The COALESCE below already
    // guarantees a blank can never clear a real portal DOB — but a clear is also
    // how an officer VACATES a disputed value (Leifer, 2026-07-15: the bad DOB
    // was deleted in ClickUp and the review row sat open forever because this
    // whole flow only ran when a value came IN). So a blank still gets looked at:
    //  * portal DOB plausible → the conflict no longer exists; close any open
    //    review rows for this borrower (PILOT keeps its value, nothing written).
    //  * portal DOB IMPOSSIBLE (not an adult's date) → wipe-don't-guess: both
    //    systems agreed the value was wrong (ClickUp cleared it), so NULL the
    //    portal copy too rather than preserving provable garbage — audited.
    // EVIDENCE GATE (pre-merge audit): "cleared" requires this task to have
    // PREVIOUSLY carried a DOB (its stored snapshot from the last ingest) —
    // a task that never had one is absence-of-information, not a clear, and
    // must not vacate a live conflict another task is still asserting.
    try {
      const prev = taskId
        ? (await db.query(`SELECT snapshot FROM clickup_task_index WHERE task_id=$1`, [taskId])).rows[0] : null;
      const prevDob = prev && prev.snapshot && prev.snapshot.borrower ? prev.snapshot.borrower.date_of_birth : null;
      const cur = prevDob
        ? (await db.query(`SELECT date_of_birth FROM borrowers WHERE id=$1`, [borrowerId])).rows[0] || {} : {};
      const portalDay = cur.date_of_birth ? String(cur.date_of_birth) : null;
      if (prevDob && portalDay) {
        const FLD = require('../lib/fields');
        // STRICT plausibility for the stored value: it must already be a real
        // in-window calendar date. (sanitizeDob alone would PIVOT a stored
        // '0026-…' artifact to 1926 and call it plausible — audit nit.)
        if (FLD.sanitizeDateOnly(portalDay) && FLD.sanitizeDob(portalDay)) {
          await review.closeStaleReviews({ borrowerId, fieldKey: 'date_of_birth',
            note: 'auto-closed — the ClickUp DOB was cleared at the source; PILOT keeps ' + portalDay });
        } else {
          const problem = FLD.dobProblem(portalDay) || 'invalid';
          await db.query(`UPDATE borrowers SET date_of_birth=NULL, updated_at=now() WHERE id=$1`, [borrowerId]);
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system',NULL,'dob_wipe_dont_guess','borrower',$1,$2)`,
            [borrowerId, JSON.stringify({ removed: portalDay, problem, taskId: taskId || null,
              why: 'ClickUp DOB cleared and the PILOT value cannot belong to an adult borrower — cleared rather than guessed' })]).catch(() => {});
          await review.closeStaleReviews({ borrowerId, fieldKey: 'date_of_birth',
            note: `auto-closed — ClickUp cleared the DOB and PILOT's ${portalDay} is impossible (${problem}); both sides now blank, ready for the real date` });
        }
      }
    } catch (e) { console.warn('[ingest] cleared-DOB check skipped:', e.message); }
  }
  // SHADOW-EMAIL UPGRADE (owner-reported 2026-07-15 night, Avrohom Kopel —
  // "this comes up hundreds of times"): noemail+<task>@clickup.local is OUR
  // OWN placeholder, minted when a profile had to be created without a safely
  // usable real email. It is filler, not data — when ClickUp now carries a
  // real email, the placeholder upgrades to it automatically. Unique-collision
  // safe: if another borrower owns that email this throws 23505 and the
  // placeholder stays (that pair is exactly what the dedup queue tracks).
  try {
    const em = nn(b.email) ? String(b.email).trim().toLowerCase() : null;
    if (em && /@/.test(em) && !/@clickup\.local$/i.test(em)) {
      await db.query(
        `UPDATE borrowers SET email=$2, updated_at=now()
          WHERE id=$1 AND email LIKE 'noemail+%@clickup.local'`, [borrowerId, em]);
    }
  } catch (_) { /* 23505: the real email belongs to another profile — keep the placeholder */ }
  // SSN fill-only, at the ONE heal chokepoint (owner-reported 2026-07-15
  // night, Shalom Elbaum: ClickUp carried the SSN but the file never got it —
  // the encrypted fill previously ran ONLY on the borrower-CREATE path, so a
  // profile that resolved by SSN-hash or email match, or was created before
  // the SSN was typed into ClickUp, could never pick it up later). Fill-only:
  // an existing stored SSN is never overwritten here — a DIFFERING ClickUp
  // SSN surfaces through the identity-mismatch audit as a resolvable row.
  try {
    const ssnStore = require('../lib/crypto').ssnForStorage(b.ssn);
    if (ssnStore) {
      await db.query(
        `UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, ssn_hash=COALESCE(ssn_hash,$4), updated_at=now()
          WHERE id=$1 AND ssn_encrypted IS NULL`,
        [borrowerId, ssnStore.encrypted, ssnStore.last4, identity.ssnHash(b.ssn, cfg.ssnMatchKey)]);
    }
  } catch (e) { console.warn('[ingest] ssn fill skipped:', e.message); }
  try {
    await db.query(
      `UPDATE borrowers SET
          first_name      = CASE WHEN $2::text IS NOT NULL AND lower(btrim(coalesce(first_name,''))) IN ('','unknown','co-borrower') THEN $2 ELSE first_name END,
          last_name       = CASE WHEN $3::text IS NOT NULL AND lower(btrim(coalesce(last_name ,''))) IN ('','unknown','co-borrower') THEN $3 ELSE last_name  END,
          cell_phone      = COALESCE(cell_phone, $4),
          date_of_birth   = COALESCE(date_of_birth, $5::date),
          citizenship     = COALESCE(citizenship, $6),
          fico            = COALESCE(fico, $7::int),
          current_address = COALESCE(current_address, $8::jsonb),
          marital_status  = COALESCE(marital_status, $9),
          employment_type = COALESCE(employment_type, $10),
          employer        = COALESCE(employer, $11),
          updated_at      = now()
        WHERE id=$1`,
      [borrowerId, name(b.first_name), name(b.last_name), nn(b.cell_phone), dobIn,
       nn(b.citizenship), require('../lib/fields').sanitizeFico(b.fico),   // #90: never persist an out-of-range FICO from ClickUp
       b.current_address ? JSON.stringify(b.current_address) : null,
       nn(b.marital_status), nn(b.employment_type), nn(b.employer)]);
  } catch (e) { console.warn('[ingest] borrower heal skipped:', e.message); }
}

async function resolveBorrower(read, taskId) {
  const b = read.borrower || {};
  const ssnHash = identity.ssnHash(b.ssn, cfg.ssnMatchKey);
  // Set when an email match is FOUND but we decline to merge (SSN conflict, or no
  // corroborating 2nd field). The email is then unsafe to reuse on the INSERT.
  let emailUnsafe = false;
  // The existing borrower an UNCORROBORATED email match pointed at — recorded as a
  // "possible duplicate — review" candidate after the distinct profile is created.
  let possibleDupOfId = null;

  // 1) strong: exact SSN-hash
  if (ssnHash) {
    const r = await db.query(`SELECT id FROM borrowers WHERE ssn_hash=$1 LIMIT 1`, [ssnHash]);
    if (r.rows[0]) {
      await healBorrowerFields(r.rows[0].id, b, taskId);
      await recordContacts(r.rows[0].id, b, taskId);
      return { borrowerId: r.rows[0].id, created: false };
    }
  }
  // 2) email exact — a strong-ish signal, but NOT proof of the same person on its
  //    own. Require corroboration by a second identity field before merging:
  //      • DIFFERENT SSN-hash on the two sides  -> definitely two people, never merge.
  //      • SAME SSN-hash                         -> merge (strong).
  //      • no SSN either side                    -> merge ONLY if last name / phone
  //        (last 10) / DOB also agrees; else create a distinct profile.
  if (b.email) {
    const r = await db.query(
      `SELECT id, ssn_hash, first_name, last_name, cell_phone, date_of_birth FROM borrowers WHERE email=$1 LIMIT 1`,
      [String(b.email).toLowerCase().trim()]);
    const ex = r.rows[0];
    if (ex) {
      const ssnConflict = ssnHash && ex.ssn_hash && ssnHash !== ex.ssn_hash;
      const ssnAgree    = ssnHash && ex.ssn_hash && ssnHash === ex.ssn_hash;
      // Corroboration requires phone / DOB / the FULL name — never the last
      // name alone (a family-shared email + the family surname merged a loan
      // officer's LEAD with a different real borrower, owner incident
      // 2026-07-15 night — two people, one profile, wrong officer on the file).
      const corroborated = identity.emailMatchCorroborated(
        { firstName: b.first_name, lastName: b.last_name, phone: b.cell_phone, dob: b.date_of_birth },
        { firstName: ex.first_name, lastName: ex.last_name, phone: ex.cell_phone, dob: ex.date_of_birth });
      if (!ssnConflict && (ssnAgree || corroborated)) {
        if (ssnHash) await db.query(`UPDATE borrowers SET ssn_hash=COALESCE(ssn_hash,$1) WHERE id=$2`, [ssnHash, ex.id]);
        await healBorrowerFields(ex.id, b, taskId);
        await recordContacts(ex.id, b, taskId);
        return { borrowerId: ex.id, created: false };
      }
      emailUnsafe = true;   // matched, but not the same person we can prove → don't reuse the email
      // A shared email with NO corroboration (and no SSN conflict) is a genuine
      // "might be the same person" — flag it for human review. An SSN conflict is a
      // confirmed DIFFERENT person, so it is not flagged.
      if (!ssnConflict) possibleDupOfId = ex.id;
    }
  }
  // 3) weak / none -> create a DISTINCT profile (never a blind single-field merge).
  // NO-IDENTITY GUARD (owner-reported 2026-07-15 night: "why do we have
  // Unknown Unknown?!"): NEVER mint a profile for a "person" with no name, no
  // SSN, and no DOB — a task carrying only an email/phone (a CRM stub, an
  // unfilled *Borrower Name field, an email-only co-borrower slot) produced
  // nameless husk profiles that polluted the borrowers list and spawned
  // undecidable "Unknown Unknown" shared-email cards. Matching ABOVE may
  // still find a real person by SSN/email; creating a husk helps nobody. The
  // caller treats null as "no person on this task yet" — file materialization
  // holds (with a visible review card) until ClickUp carries a name.
  if (!identity.nameToken(b.first_name) && !ssnHash && !require('../lib/fields').sanitizeDob(b.date_of_birth)) {
    return { borrowerId: null, created: false, noIdentity: true };
  }
  const first = b.first_name || 'Unknown', last = b.last_name || 'Unknown';
  // CRITICAL: if the email match was declined above (different person, or
  // uncorroborated), do NOT reuse it here — the INSERT's ON CONFLICT (email) DO
  // UPDATE would resolve to that other person's row and re-merge the two we just
  // refused to merge (wrong loan/PII attachment). Use a synthetic unique email so
  // a distinct profile is created.
  const email = (b.email && !emailUnsafe) ? String(b.email).toLowerCase().trim() : `noemail+${taskId}@clickup.local`;
  const ins = await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,citizenship,fico,current_address,
                            marital_status,employment_type,employer,ssn_hash,origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'clickup_backfill')
     ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
    [first, last, email, b.cell_phone || null,
     require('../lib/fields').sanitizeDob(b.date_of_birth),   // NEW-borrower path vets too: garbage/toddler DOBs never insert raw
     b.citizenship || null,
     require('../lib/fields').sanitizeFico(b.fico),   // #90: FICO 300–850 or null
     b.current_address ? JSON.stringify(b.current_address) : null, b.marital_status || null,
     b.employment_type || null, b.employer || null, ssnHash]);
  const borrowerId = ins.rows[0].id;
  // The ON CONFLICT path returns a PRE-EXISTING row (same real email, or the
  // same task's shadow email on a re-sync) — heal it too, or the very row this
  // sync created with 'Unknown' can never pick the name up later.
  await healBorrowerFields(borrowerId, b, taskId);
  // #91: only accept a real 9-digit SSN from ClickUp, stored canonically through
  // the single chokepoint (digits only) — matching every other write path.
  const ssnStore = C.ssnForStorage(b.ssn);
  if (ssnStore) { try { await db.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1 AND ssn_encrypted IS NULL`,
    [borrowerId, ssnStore.encrypted, ssnStore.last4]); } catch (_) {} }
  await recordContacts(borrowerId, b, taskId);
  // "Possible duplicate — please check": the email pointed at an existing borrower
  // we could not corroborate, so we created a DISTINCT profile (safe over-split).
  // Record the pair so a human is TOLD, instead of the split happening silently.
  // Idempotent (one open row per pair) and best-effort — never blocks ingest.
  // A NAMELESS husk profile spawns NO dedup pair and NO review card (owner-
  // reported: cards reading "Unknown Unknown AND Unknown Unknown" — nothing a
  // human can decide about a profile with no name; the husk fills from
  // ClickUp automatically and the pair becomes reviewable when it does).
  if (possibleDupOfId && possibleDupOfId !== borrowerId && identity.nameToken(b.first_name)) {
    // An ALLOWED shared-email pair (staff clicked "Allow — same email for
    // both") is settled forever — no dedup pair, no review card.
    const allowed = await db.query(
      `SELECT 1 FROM borrower_profile_links WHERE borrower_id=$1 AND linked_borrower_id=$2`,
      [borrowerId, possibleDupOfId]).catch(() => ({ rows: [] }));
    if (allowed.rows[0]) return { borrowerId, created: true };
    try {
      await db.query(
        `INSERT INTO borrower_dedup_candidates (borrower_id, matched_borrower_id, reason, source_task_id)
         VALUES ($1,$2,'shared_email_uncorroborated',$3)
         ON CONFLICT (borrower_id, matched_borrower_id) DO NOTHING`,
        [borrowerId, possibleDupOfId, taskId]);
    } catch (_) { /* dedup-candidate logging is best-effort */ }
    // Owner-directed 2026-07-15 night: a shared email is ITS OWN review card —
    // "two separate borrowers have the same email; give it to ONE of them."
    // Queued immediately here so the officer sees it the moment it happens
    // (the boot sweep sharedEmailReviewSweepOnce re-produces/auto-closes it).
    try {
      const key = 'dedup:' + [String(borrowerId), String(possibleDupOfId)].sort().join(':');
      const other = (await db.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [possibleDupOfId])).rows[0] || {};
      await require('../lib/sync-review').queueReview({
        borrowerId, taskId: key, direction: 'inbound',
        fieldKey: 'shared_email', reason: 'shared_email_needs_reassignment',
        suppressIfRejected: true,
        rawValue: JSON.stringify({ b1: borrowerId, b2: possibleDupOfId, sourceTask: taskId }).slice(0, 300),
        clickupValue: String(b.email || '').toLowerCase().trim().slice(0, 160),
        portalValue: `${[first, last].filter(Boolean).join(' ')} AND ${[other.first_name, other.last_name].filter(Boolean).join(' ')}`.slice(0, 160) });
    } catch (_) { /* the card is best-effort; the boot sweep re-produces it */ }
  }
  return { borrowerId, created: true };
}

/** Add an LLC to the borrower's library (unverified, deduped by name). */
async function upsertLlc(borrowerId, llcName, ein, taskId) {
  if (!llcName) return null;
  const name = String(llcName).trim();
  const found = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`, [borrowerId, name]);
  if (found.rows[0]) return found.rows[0].id;
  try {
    const r = await db.query(
      `INSERT INTO llcs (borrower_id, llc_name, ein, is_verified, origin, source_task_id)
       VALUES ($1,$2,$3,false,'clickup_backfill',$4) RETURNING id`, [borrowerId, name, ein || null, taskId]);
    return r.rows[0].id;
  } catch (e) {
    // Concurrency race: a parallel ingest (reconcile sweep vs live webhook) created
    // the SAME (borrower, name) LLC between our SELECT and INSERT and won the
    // uq_llcs_borrower_name unique index (db/082). Re-select the winner — no
    // duplicate. (Before that index exists there is no 23505, so this never runs.)
    if (e && e.code === '23505') {
      const again = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`, [borrowerId, name]);
      if (again.rows[0]) return again.rows[0].id;
    }
    throw e;
  }
}

const addrKey = (a) => {
  const s = a && (a.formatted_address || a.oneLine);
  return s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : null;
};

/** Auto track-record line from a closed file, with deal-type inference. */
async function upsertTrackRecord(borrowerId, read, taskId) {
  const a = read.app || {};
  const key = addrKey(a.property_address);
  if (!key) return null;
  const exists = await db.query(
    `SELECT id FROM track_records WHERE borrower_id=$1 AND (source_task_id=$2 OR address_key=$3) LIMIT 1`,
    [borrowerId, taskId, key]);
  // deal-type inference (§ decision 3)
  let dealType = 'fix-and-hold', inferred = true;
  const prog = crosswalk.fromClickUpLabel ? a.program : a.program;
  if (a.program === 'Fix & Flip w/ Construction') { dealType = 'flip'; inferred = true; }
  const isRefi = /refi/i.test(a.loan_type || '');
  const priorSameAddr = await db.query(
    `SELECT deal_type, loan_purpose_hint FROM (SELECT deal_type, NULL loan_purpose_hint FROM track_records WHERE borrower_id=$1 AND address_key=$2) t LIMIT 1`,
    [borrowerId, key]).catch(() => ({ rows: [] }));
  if (isRefi && (priorSameAddr.rows.length || exists.rows.length)) { dealType = 'fix-and-hold'; inferred = true; }

  if (exists.rows[0]) {
    // Also (re)fill the property address — early track records were written with
    // the raw ClickUp location shape (or none), so a re-run repopulates them with
    // the normalized address. COALESCE keeps an existing value if this read lacks one.
    await db.query(`UPDATE track_records SET deal_type=$2, inferred=$3,
                      property_address=COALESCE($4, property_address), updated_at=now() WHERE id=$1`,
      [exists.rows[0].id, dealType, inferred, a.property_address ? JSON.stringify(a.property_address) : null]).catch(() => {});
    return exists.rows[0].id;
  }
  try {
    const r = await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price, purchase_date, sale_date,
                                 is_verified, origin, source_task_id, inferred, address_key, notes)
       VALUES ($1,$2,$3,$4,$5,$6,false,'clickup_backfill',$7,$8,$9,$10) RETURNING id`,
      [borrowerId, a.property_address ? JSON.stringify(a.property_address) : null, dealType,
       a.purchase_price || null, saneDay(a.acquisition_date), saneDay(a.actual_closing),
       taskId, inferred, key, 'Auto-derived from ClickUp; unverified']);
    return r.rows[0].id;
  } catch (e) {
    // Concurrency race on uq_track_records_source_task (db/082): a parallel ingest
    // of the SAME task created the record first. Re-select by task id — no duplicate.
    if (e && e.code === '23505' && taskId) {
      const again = await db.query(`SELECT id FROM track_records WHERE source_task_id=$1 LIMIT 1`, [taskId]);
      if (again.rows[0]) return again.rows[0].id;
    }
    throw e;
  }
}

/** Resolve a ClickUp officer/processor email → an active staff_users row. */
async function resolveStaffByEmail(email) {
  if (!email) return { id: null, name: null };
  const r = await db.query(
    `SELECT id, full_name FROM staff_users WHERE lower(email)=lower($1) AND is_active=true LIMIT 1`, [email]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].full_name } : { id: null, name: null };
}

/** Resolve a ClickUp numeric user id → an active staff_users row (mirrors
 *  resolveStaffByEmail). Used for "users" custom fields — e.g. Underwriter —
 *  where the ClickUp member id is the stable key into staff_users.clickup_user_id. */
async function resolveStaffByClickupUserId(clickupUserId) {
  if (clickupUserId == null || clickupUserId === '') return { id: null, name: null };
  const r = await db.query(
    `SELECT id, full_name FROM staff_users WHERE clickup_user_id=$1 AND is_active=true LIMIT 1`, [clickupUserId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].full_name } : { id: null, name: null };
}

/** First ClickUp user id from a "users" custom field on a raw task (or null).
 *  Mirrors the mapper's officer/processor read: take the first user, prefer .id.
 *  The Underwriter field is in the mapper's KNOWN set (never surfaced in extra),
 *  so we read it straight off the task here. */
function firstUserIdFromField(task, fieldId) {
  const cf = ((task && task.custom_fields) || []).find((c) => c && c.id === fieldId);
  if (!cf || !Array.isArray(cf.value) || !cf.value.length) return null;
  const u = cf.value[0];
  return (u && (u.id != null ? u.id : u)) || null;
}

const _addrOf = (v) => (v && (v.formatted_address || v.oneLine)) || null;

/**
 * Find which EXISTING portal app a task belongs to, without creating one:
 *   1) Portal File ID stamp (authoritative — written by our own push).
 *   2) Within the resolved borrower's unlinked RTL apps, an app-level match on
 *      normalized property ADDRESS or ys_loan_number (each uniquely identifies
 *      the deal for a fixed borrower). Single strong match links; multiple ->
 *      ambiguous (Manual Review); none -> null (create).
 * Returns { id, how, detail } | { ambiguous, detail } | null.
 */
async function findExistingApp(task, read, borrowerId, opts = {}) {
  // Set when the task carries a COPIED stamp (a duplicate of an already-bound
  // task) — the definitive "this is a duplicated task" signal, used by the
  // duplicate-in-progress defer below.
  let staleStampAppId = null;
  if (read.portalFileId) {
    const s = await db.query(
      `SELECT id, clickup_pipeline_task_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [read.portalFileId]
    ).catch(() => ({ rows: [] }));
    if (s.rows[0]) {
      const linked = s.rows[0].clickup_pipeline_task_id;
      if (!linked || linked === task.id) return { id: s.rows[0].id, how: 'linked_stamp', detail: { stamp: read.portalFileId } };
      staleStampAppId = s.rows[0].id;
      // The stamp resolves to an app that is already bound to a DIFFERENT, live
      // task — so this stamp is a stale COPY, not an authoritative binding.
      // Root cause of "a second file for the same borrower re-syncs forever but
      // never lands" (owner-reported 2026-07-14, Yaniv Erez): our Portal File ID
      // is a copyable ClickUp short_text field, and "duplicate a task to start a
      // new file" is the documented workflow, so the duplicated task inherits the
      // source app's UUID. Trusting it returned {ambiguous} on every reconcile
      // pass → the file was never created. The clickup_pipeline_task_id binding —
      // NOT the copyable stamp — is authoritative, so IGNORE this stamp and fall
      // through to the identity match / create path keyed on THIS task's own id.
      // (Once the new file is created and linked, the next outbound push rewrites
      // this task's stamp to the correct UUID, so it self-heals. A genuine
      // same-loan conflict is still caught below by the ys_loan_number global
      // unique-key guard, which correctly stays → ambiguous.)
    }
    // stale stamp (app deleted, or a copied stamp bound to another task) -> fall through
  }
  // ys_loan_number is a GLOBAL unique key — same number == same loan. Match it
  // across ALL borrowers (not just the resolved one) so a re-linked/re-keyed file
  // links instead of colliding on the unique index (which would otherwise throw).
  // Set when THIS task carries a loan number that belongs to ANOTHER live task
  // of the SAME borrower — the "duplicate a task and forget to change the loan
  // number" class (root-caused 2026-07-15, Asher Salamon / 734 Dennis Pl: the
  // copied YSCAP number made the task 'ambiguous' forever, silently).
  let copiedLoanNumber = null;
  if (read.app.ys_loan_number) {
    // Case-insensitive (+ whitespace-tolerant) so "YS-123" and "ys-123" are the
    // SAME loan — matching how the identity scan below normalizes loanNumber, so a
    // mere case difference can never miss a link and split one loan into two files.
    const ln = await db.query(
      `SELECT id, borrower_id, clickup_pipeline_task_id FROM applications WHERE lower(btrim(ys_loan_number))=lower(btrim($1)) AND deleted_at IS NULL LIMIT 1`,
      [read.app.ys_loan_number]
    ).catch(() => ({ rows: [] }));
    if (ln.rows[0]) {
      const linked = ln.rows[0].clickup_pipeline_task_id;
      if (!linked || linked === task.id) return { id: ln.rows[0].id, how: 'linked_loannum', detail: { ysLoanNumber: read.app.ys_loan_number } };
      if (String(ln.rows[0].borrower_id) === String(borrowerId)) {
        // SAME borrower, different live task: exactly like the copied Portal-
        // File-ID stamp (f346033), a loan number inherited by the duplicate-a-
        // task workflow is a STALE COPY, not an identity claim — a real loan
        // number is globally unique, so two of the borrower's deals can't share
        // one. Ignore it for matching (fall through to identity/defer/create)
        // and tell the caller so the copied number is NEVER imported onto the
        // new file (it would collide on the unique index) — the officer gets a
        // review row to assign the real number in ClickUp instead.
        copiedLoanNumber = { number: read.app.ys_loan_number, ofApplication: ln.rows[0].id, boundToTask: linked };
      } else {
        // DIFFERENT borrower sharing a loan number — a genuine cross-borrower
        // key collision; a human must look (visible via the review row the
        // ingest layer queues for every non-materialized task).
        return { ambiguous: true, detail: { ysLoanNumber: read.app.ys_loan_number, boundToTask: linked } };
      }
    }
  }
  const tn = identity.normalizeIdentity({
    address: _addrOf(read.app.property_address),
    loanNumber: copiedLoanNumber ? null : read.app.ys_loan_number,   // a copied number is not an identity signal
    purchasePrice: read.app.purchase_price,
  });
  const cand = await db.query(
    `SELECT id, property_address, ys_loan_number, purchase_price FROM applications
      WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NULL
        AND program IN ('Fix & Flip w/ Construction','Bridge','Ground-Up Construction')`, [borrowerId]
  ).catch(() => ({ rows: [] }));
  // NOTE (2026-07-15 audit): the unlinked-candidate scan is gated on having
  // candidates, but the heal + duplicate-defer scans below must run REGARDLESS —
  // an early `return null` here made them unreachable in the canonical
  // duplicated-task scenario (a borrower whose files are all linked).
  if (cand.rows.length) {
    const strong = [];
    for (const c of cand.rows) {
      const cn = identity.normalizeIdentity({ address: _addrOf(c.property_address), loanNumber: c.ys_loan_number, purchasePrice: c.purchase_price });
      const addr = tn.address && tn.address === cn.address;
      const loan = tn.loanNumber && tn.loanNumber === cn.loanNumber;
      if (addr || loan) strong.push({ id: c.id, addr: !!addr, loan: !!loan });
    }
    if (strong.length === 1) return { id: strong[0].id, how: 'linked_identity', detail: strong[0], copiedLoanNumber };
    if (strong.length > 1)  return { ambiguous: true, detail: { candidates: strong.map((s) => s.id) } };
  }

  // Delete+recreate heal (prevents the #1 duplication path). A ClickUp task can be
  // deleted and a NEW task created for the same deal. The old portal file is still
  // linked to the (now-deleted) task, so the unlinked-candidate scan above skips it
  // (clickup_pipeline_task_id IS NULL) and we would CREATE a duplicate. Look for a
  // file for THIS borrower at the same normalized address that is linked to a
  // DIFFERENT task, and relink it here IFF that other task is confirmed deleted
  // (getTask -> 404). A still-live other task is a genuinely separate deal — we
  // never steal a file from a live task, and any non-404 error is treated as
  // "can't confirm dead" so we fall through rather than mis-relink.
  if (tn.address) {
    const other = await db.query(
      `SELECT id, property_address, clickup_pipeline_task_id FROM applications
        WHERE borrower_id=$1 AND deleted_at IS NULL
          AND clickup_pipeline_task_id IS NOT NULL AND clickup_pipeline_task_id <> $2
          AND program IN ('Fix & Flip w/ Construction','Bridge','Ground-Up Construction')`,
      [borrowerId, task.id]).catch(() => ({ rows: [] }));
    for (const o of other.rows) {
      const on = identity.normalizeIdentity({ address: _addrOf(o.property_address) });
      if (!on.address) continue;
      if (on.address !== tn.address) {
        // CANONICAL fallback (owner-directed): the strict token compare misses
        // formatting variants of the SAME property ("St"/"Street") — before
        // skipping this sibling, ask the cached Google place_id resolver.
        // Degradable (no key / unresolvable → skip as before) and bounded
        // (few siblings per borrower; every distinct text resolves once).
        let sameProp = null;
        try { sameProp = await require('../lib/address-canon').samePlace(_addrOf(read.app.property_address), _addrOf(o.property_address)); } catch (_) {}
        if (sameProp !== true) continue;
      }
      let dead = false, sibTerminal = false;
      try {
        const sib = await require('./client').getTask(o.clickup_pipeline_task_id);
        sibTerminal = statusMap.isTerminal(sib && sib.status && sib.status.status);
      }
      catch (e) { if (e && e.status === 404) dead = true; }
      if (dead) return { id: o.id, how: 'relinked_dead_task', detail: { fromTask: o.clickup_pipeline_task_id }, copiedLoanNumber };
      // SUCCESSOR DEAL (root-caused 2026-07-15 evening, Shulom Eisenberg / 521
      // Bayway): the same-address sibling's deal is TERMINAL — funded,
      // declined, or cancelled. Its task will never be re-addressed, so the
      // defer below would wait FOREVER; and a new task at the address of a
      // finished deal is the property's NEXT deal (a re-origination after a
      // cancellation, a refi after funding), not a mid-cleanup duplicate.
      // Fall through and let it materialize as its own file. If it later
      // turns out to be a duplicate the officer re-addresses, the linked file
      // follows the task's address edit — self-correcting either way.
      if (sibTerminal) continue;
      // Duplicate-in-progress DEFER (owner-directed 2026-07-15): this borrower
      // already has a portal file at the SAME property bound to a LIVE other
      // task — this task is almost certainly a fresh ClickUp duplicate whose
      // address hasn't been updated to the new deal yet ("duplicate a task to
      // start a new file" is the documented workflow). Creating now would
      // materialize a same-address TWIN file carrying the old deal's data.
      // Skip this pass instead; the officer's address edit re-triggers ingest
      // via the webhook (and any later edit via the reconcile poll), and the
      // file is created cleanly the moment the duplicate has its own address —
      // then the stamp switch-over re-points the task at its own new file.
      // (An unconfirmable liveness check defers too — never risk a twin. A
      // GENUINE second deal at the same address surfaces in the Manual Review
      // queue, where force-create unblocks it deliberately.) Only relevant when
      // creation is even possible: without allowCreate the caller returns
      // 'skipped' exactly as before, and forceCreate is the human override.
      if (opts.allowCreate && !opts.forceCreate) {
        return { duplicatePending: true, detail: { sameAddressAs: o.id, boundToTask: o.clickup_pipeline_task_id, alive: !dead }, copiedLoanNumber };
      }
    }
  }
  // Same defer via the OTHER duplicate signal: the task carries a COPIED stamp
  // (bound to a different live task) and still shows the SOURCE file's address —
  // or no usable address at all. Wait for the officer to give the duplicate its
  // own address before materializing the new file.
  if (opts.allowCreate && !opts.forceCreate && staleStampAppId) {
    const src = await db.query(
      `SELECT property_address, clickup_pipeline_task_id FROM applications WHERE id=$1`, [staleStampAppId]).catch(() => ({ rows: [] }));
    const srcAddr = src.rows[0]
      ? identity.normalizeIdentity({ address: _addrOf(src.rows[0].property_address) }).address : null;
    if (!tn.address || (srcAddr && tn.address === srcAddr)) {
      // Same successor-deal exception as the address defer above: a stamp
      // copied from a TERMINAL deal's file (funded/declined/cancelled, task
      // confirmed live) can never be "mid-cleanup" — nothing on that finished
      // deal will ever change — so waiting would be forever. Unreachable/
      // deleted source tasks keep deferring (conservative: never risk a twin).
      let srcTerminal = false;
      if (src.rows[0] && src.rows[0].clickup_pipeline_task_id) {
        try {
          const st = await require('./client').getTask(src.rows[0].clickup_pipeline_task_id);
          srcTerminal = statusMap.isTerminal(st && st.status && st.status.status);
        } catch (_) { /* can't confirm → keep the defer */ }
      }
      if (!srcTerminal) return { duplicatePending: true, detail: { copiedStampOf: staleStampAppId }, copiedLoanNumber };
    }
  }
  return copiedLoanNumber ? { copiedLoanNumber } : null;
}

/**
 * PULL-ONLY: mirror the ClickUp checklist status dropdowns onto the portal's
 * document conditions for a LINKED RTL file. Reads the task's dropdown fields,
 * translates each to a portal status, and applies the authority / no-downgrade
 * rule (the portal is the system of record). Writes ONLY to checklist_items and
 * touches ONLY items whose clickup_field_id was seeded (db/050) — unmapped
 * fields (title/insurance/signedTermSheet) never match a row and are skipped.
 *
 * CRITICAL LOOPBACK GUARD: this function contains NO enqueue/push of any kind.
 * The physical absence of any outbound call here is what prevents a pull→push
 * echo. It is best-effort (try/catch) so a checklist glitch never breaks ingest.
 */
async function applyChecklistStatuses(appId, task, options = {}) {
  try {
    if (!appId || !task) return;
    const cfById = {};
    for (const c of (task.custom_fields || [])) { if (c && c.id) cfById[c.id] = c; }

    for (const fieldId of Object.keys(checklist.BY_FIELD)) {
      const cf = cfById[fieldId];
      if (!cf || cf.value == null || cf.value === '') continue;

      // ClickUp reads a dropdown as the option's orderindex INTEGER; translate to
      // the option UUID via the same helper the mapper uses. Fall back to treating
      // the value as a direct UUID only if it is a REAL option for this field.
      const optList = options[fieldId] || (cf.type_config && cf.type_config.options) || [];
      let optId = transforms.dropdownIndexToId(optList, cf.value);
      if (!optId && checklist.normalizeInbound(fieldId, String(cf.value))) optId = String(cf.value);
      if (!optId) continue;

      // Cap inbound so the sync can never COMPLETE a required condition:
      // evidence from ClickUp lands at 'received' at most; the terminal
      // 'satisfied' sign-off only happens through the portal's signOffGate,
      // where fulfillment is verified (owner-directed root-cause fix — the
      // inbound sync is a second door to 'satisfied' that bypasses the gate).
      const inbound = checklist.capInbound(checklist.normalizeInbound(fieldId, optId));
      if (!inbound) continue;

      // Only mapped items are ever touched (clickup_field_id seeded by db/050).
      const row = await db.query(
        `SELECT id, status FROM checklist_items
          WHERE application_id=$1 AND clickup_field_id=$2
          ORDER BY updated_at DESC LIMIT 1`, [appId, fieldId]);
      if (!row.rows[0]) continue;

      const cur = row.rows[0].status;
      if (!checklist.shouldApplyInbound(inbound, cur)) continue;

      await db.query(
        `UPDATE checklist_items SET status=$2, clickup_option_id=$3, updated_at=now() WHERE id=$1`,
        [row.rows[0].id, inbound, optId]);
    }
  } catch (_) { /* best-effort — a checklist glitch never breaks ingest */ }
}

/**
 * A file that was materialized as an RTL loan but whose ClickUp *Program was
 * later changed to something we don't build on the portal yet (DSCR / long-term
 * — anything outside RTL_PROGRAMS): remove it from the portal so it stops showing
 * as an active loan file. This is an INTENTIONAL program change, never an
 * error/mismatch.
 *
 * Mechanism = the portal's own soft-delete (deleted_at) + sync_state='descoped':
 *   • deleted_at  → drops it from every active portal list (same as the Archived
 *                   folder), fully reversible.
 *   • descoped    → the outbound sweep already excludes it, and a re-flip back to
 *                   RTL restores it (see linkOrCreateApplication).
 * NEVER touches ClickUp — the client-layer hard stop + the orchestrator's
 * deleted_at guard guarantee no outbound push/delete. The task's data is still
 * preserved as a masked clickup_task_index snapshot (data_only).
 * Returns { id, program } when a file was descoped, else null.
 */
async function descopeFlipped(taskId) {
  try {
    // Guard `deleted_at IS NULL`: only descope a file that is currently LIVE. An
    // admin-archived file (deleted_at set, sync_state still 'linked') is left
    // exactly as-is — converting it to 'descoped' would erase the marker the
    // restore-on-reflip logic uses to keep admin archives from being resurrected.
    const r = await db.query(
      `UPDATE applications
          SET sync_state='descoped', deleted_at=now(), updated_at=now()
        WHERE clickup_pipeline_task_id=$1 AND sync_state <> 'descoped' AND deleted_at IS NULL
        RETURNING id, program`, [taskId]);
    if (!r.rows[0]) return null;
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, 'clickup_descope_flip', 'application', $1, $2)`,
      [r.rows[0].id, JSON.stringify({ taskId, from: r.rows[0].program,
        reason: 'ClickUp program changed to an unsupported (non-RTL) type; removed from portal, ClickUp left untouched' })]).catch(() => {});
    return r.rows[0];
  } catch (_) { return null; }
}

/**
 * Give a freshly linked/created RTL file its full workflow — the RTL condition
 * set (internal + external conditions) and the internal (staff) checklist —
 * exactly like a manually-created file. Only runs when the file has NO checklist
 * items yet (so a re-ingest never re-generates); generateChecklist itself is also
 * idempotent (insertFromTemplate dedups per template+owner). Lazy-require avoids
 * any load-order coupling with the borrower router. Portal-only, best-effort.
 */
async function ensureRtlChecklist(appId) {
  try {
    // ROOT FIX (2026-07-14): the old "has ANY checklist item → skip" guard was
    // the missing-conditions breach. The vesting rewrite (2026-07-09) started
    // inserting the rtl_p1_llc condition BEFORE this ran, so every ClickUp
    // file with an LLC (or co-borrower) had "an item" and silently skipped the
    // other ~39 — purchase contract, credit report, the whole internal
    // checklist. ensureFileConditions is idempotent per (owner, template), so
    // it is ALWAYS called: it only ever fills genuine gaps.
    await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'clickup_ingest' });
  } catch (e) { console.error('[ingest] ensureRtlChecklist failed', appId, e.message); }
}

/**
 * Ingest one ClickUp task. `options` = live dropdown option map.
 * Builds the identity graph for every task; materializes / links an RTL loan
 * file (with loan-officer assignment) only for in-scope programs.
 */
async function ingestTask(task, options = {}, opts = {}) {
  const read = mapper.readTaskFields(task, options);
  const program = read.app.program || null;
  const isRtl = program && RTL_PROGRAMS.has(program);
  const folderId = (task && task.folder && task.folder.id) || opts.folderId || null;

  const { borrowerId } = await resolveBorrower(read, task.id);
  // #72 — enrich the co-borrower from its ClickUp SUBTASK (the full profile:
  // DOB, SSN, address) when the parent flags a co-borrower. Guarded/best-effort:
  // any failure (no subtask, API error, unexpected shape) silently falls back to
  // the parent-field co-borrower (name/email/cell), so it can NEVER break sync.
  let coBorrowerTaskId = null;
  if (read.coBorrowerFlagYes || (read.coBorrower && (read.coBorrower.first_name || read.coBorrower.email))) {
    try {
      const client = require('./client');
      const withSubs = (task.subtasks && task.subtasks.length) ? task : await client.getTask(task.id, { includeSubtasks: true });
      const subs = (withSubs && withSubs.subtasks) || [];
      if (subs.length) {
        const coName = read.coBorrower ? `${read.coBorrower.first_name || ''} ${read.coBorrower.last_name || ''}`.trim().toLowerCase() : '';
        const byName = coName && subs.find((s) => String(s.name || '').toLowerCase().includes(coName));
        const byLabel = subs.find((s) => /co.?borrow|borrower\s*2|second\s*borrow|guarantor/i.test(String(s.name || '')));
        // A lone subtask MIGHT be the co-borrower, but its title is unreliable
        // (could be "Order appraisal") — usable for field enrichment, but NEVER
        // as a NAME source (finding #2, 2026-07-14). Only a name/label match
        // authorizes parsing the title into a co-borrower name.
        const titleTrusted = !!(byName || byLabel);
        const pick = byName || byLabel || (subs.length === 1 ? subs[0] : null);
        if (pick && pick.id) {
          const full = await client.getTask(pick.id);
          const subRead = mapper.readTaskFields(full, options);
          const sb = subRead.borrower || {};
          // Name fallback (root fix 2026-07-14): on many boards the co-borrower's
          // name lives only in the SUBTASK TITLE — the *Borrower Name custom
          // field is empty — so parse the title (minus any "Co-Borrower:" prefix)
          // ONLY when the subtask was matched as the co-borrower (name/label),
          // never for a bare single-subtask fallback.
          if (!sb.first_name && titleTrusted && pick.name) {
            const t = String(pick.name).replace(/^\s*(co.?borrower|borrower\s*2|second\s*borrower|guarantor)\b\s*[:—–-]?\s*/i, '').trim();
            if (t && !transforms.isPlaceholderName(t)) {
              const p = transforms.splitName(t);
              if (p.first) { sb.first_name = p.first; sb.last_name = sb.last_name || p.last; }
            }
          }
          if (sb.first_name || sb.email || sb.ssn) {
            read.coBorrower = { ...(read.coBorrower || {}), ...sb };  // subtask wins (richer)
            coBorrowerTaskId = pick.id;
          }
        }
      }
    } catch (_) { /* best-effort; keep the parent-field co-borrower */ }
  }
  // #65 — resolve the co-borrower (from the subtask if enriched above, else the
  // parent fields) into its OWN encrypted, identity-matched borrower record
  // (reusing resolveBorrower) so the second borrower auto-surfaces on the file.
  // Best-effort; never blocks the primary ingest.
  let coBorrowerId = null;
  if (read.coBorrower && (read.coBorrower.first_name || read.coBorrower.email)) {
    try {
      // A NAME-ONLY co-borrower must first try the FILE'S OWN PEOPLE (Boruch
      // Stauber root cause, 2026-07-15 night): a person with no email and no
      // SSN can never identity-match, so resolveBorrower minted a duplicate
      // shadow profile of someone ALREADY on the file — and because that new
      // shadow id never equaled the file's borrower id, the role re-seat
      // proof ("ClickUp's co-borrower IS the file's current borrower, so the
      // roles are reversed") could never fire. On the four Schwimmer/Stauber
      // tasks ClickUp says borrower = Shaindel, Co-Borrower Name = "Boruch
      // Stauber" — exactly the file's current borrower — and the files sat
      // flagged forever. Match by full name against the linked file's
      // borrower and co-borrower before ever creating anything.
      if (!read.coBorrower.email && !read.coBorrower.ssn && read.coBorrower.first_name) {
        const linked = (await db.query(
          `SELECT a.borrower_id, a.co_borrower_id,
                  b.first_name AS bf, b.last_name AS bl,
                  cb.first_name AS cf, cb.last_name AS cl
             FROM applications a
             JOIN borrowers b ON b.id = a.borrower_id
             LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
            WHERE a.clickup_pipeline_task_id=$1 AND a.deleted_at IS NULL LIMIT 1`,
          [task.id])).rows[0];
        if (linked) {
          const sameName = (f2, l2) =>
            identity.nameToken(read.coBorrower.first_name)
            && identity.nameToken(read.coBorrower.first_name) === identity.nameToken(f2)
            && String(read.coBorrower.last_name || '').trim().toLowerCase() === String(l2 || '').trim().toLowerCase()
            && String(read.coBorrower.last_name || '').trim() !== '';
          if (sameName(linked.bf, linked.bl)) coBorrowerId = linked.borrower_id;
          else if (linked.co_borrower_id && sameName(linked.cf, linked.cl)) coBorrowerId = linked.co_borrower_id;
        }
      }
      // Distinct synthetic-email discriminator (`<taskId>-co`) so a co-borrower
      // with NO email doesn't collide with the PRIMARY's `noemail+<taskId>` shadow
      // (which would ON CONFLICT resolve back to the primary and silently drop the
      // co-borrower). A co-borrower WITH a real email is unaffected.
      if (!coBorrowerId) {
        const co = await resolveBorrower({ borrower: read.coBorrower }, `${task.id}-co`);
        if (co.borrowerId && co.borrowerId !== borrowerId) coBorrowerId = co.borrowerId;
      }
    } catch (_) { /* co-borrower is best-effort */ }
  }
  // borrowerId may be null (no-identity guard): no LLC / track-record rows
  // can hang off a person who does not exist yet.
  const llcId = borrowerId ? await upsertLlc(borrowerId, read.llc.llc_name, read.llc.ein, task.id) : null;
  if (borrowerId && CLOSED_STATUSES(read.internalStatus)) { try { await upsertTrackRecord(borrowerId, read, task.id); } catch (_) {} }

  // Loan officer comes from the PIPELINE folder (or the Loan Officer Email field);
  // processor from the Processor Email field. Both resolve to a staff_users id.
  const loanOfficerEmail = routing.loanOfficerEmailFor(read, folderId);
  const processorEmail = routing.processorEmailFor(read);

  let applicationId = null, matchStatus = isRtl ? null : 'data_only', matchDetail = null;
  if (isRtl) {
    const res = await linkOrCreateApplication(task, read, borrowerId, llcId,
      { allowCreate: opts.createFile === true, forceCreate: opts.forceCreate === true, folderId, loanOfficerEmail, processorEmail, coBorrowerId, coBorrowerTaskId });
    applicationId = res.applicationId; matchStatus = res.matchStatus; matchDetail = res.detail || null;
    // ROLE RECONCILIATION (owner-directed 2026-07-15 night, Boruch Stauber /
    // Shaindel Schwimmer: the MAIN task is the borrower and the SUBTASK is the
    // co-borrower — but the portal file had the two people in swapped roles,
    // so every position-based comparison cross-compared two different humans:
    // name/SSN/cell "mismatches" on every file, DOB gates blocking pushes of
    // the wrong person's data). resolveBorrower matched THIS task's fields to
    // a person by hard identity (SSN hash / corroborated email) — when that
    // person is the file's CO-borrower, the roles are PROVEN swapped: align
    // them (audited, reversible, both people stay on the file). No review
    // needed — this is structure, not a data conflict.
    if (applicationId && borrowerId) {
      try {
        const roles = (await db.query(`SELECT borrower_id, co_borrower_id FROM applications WHERE id=$1`, [applicationId])).rows[0];
        const SWAP_CLOSE_KEYS = ['first_name', 'email', 'cell_phone', 'ssn', 'current_address', 'date_of_birth', 'co_first_name', 'co_cell_phone'];
        const closeSwapRows = async (why) => {
          for (const fk of SWAP_CLOSE_KEYS) {
            try { await review.closeStaleReviews({ taskId: task.id, fieldKey: fk, note: `auto-closed — ${why}; the comparison was across two different people` }); } catch (_) {}
          }
        };
        if (roles && String(roles.borrower_id) !== String(borrowerId)
            && roles.co_borrower_id && String(roles.co_borrower_id) === String(borrowerId)) {
          await db.query(
            `UPDATE applications SET borrower_id=$2, co_borrower_id=$3, updated_at=now() WHERE id=$1`,
            [applicationId, borrowerId, roles.borrower_id]);
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system',NULL,'borrower_roles_swapped','application',$1,$2)`,
            [applicationId, JSON.stringify({ taskId: task.id, primaryNow: borrowerId, coBorrowerNow: roles.borrower_id,
              why: 'ClickUp main task is the borrower; identity resolution proved the portal roles were reversed' })]).catch(() => {});
          // The cross-person "mismatch" rows for this task are artifacts of the
          // swap — close them; the next audit pass compares the right people.
          await closeSwapRows('the file’s borrower/co-borrower roles were aligned to ClickUp (main task = borrower)');
        } else if (roles && String(roles.borrower_id) !== String(borrowerId)
            && coBorrowerId && String(coBorrowerId) === String(roles.borrower_id)
            && (!roles.co_borrower_id
              || String(roles.co_borrower_id) === String(coBorrowerId)
              || String(roles.co_borrower_id) === String(roles.borrower_id)
              // ...or the co slot holds a sync-created SHADOW row (no login,
              // clickup origin, placeholder email) — a duplicate minted before
              // the name-only co-borrower learned to match the file's own
              // people; displacing it to seat the real person is safe.
              || !!(await db.query(
                    `SELECT 1 FROM borrowers hb
                      WHERE hb.id=$1 AND hb.origin='clickup_backfill'
                        AND hb.email LIKE 'noemail+%@clickup.local'
                        AND NOT EXISTS (SELECT 1 FROM borrower_auth ba WHERE ba.borrower_id=hb.id)`,
                    [roles.co_borrower_id])).rows[0])) {
          // FULL REVERSAL, second shape (Boruch Stauber follow-up, owner
          // 2026-07-15 night: "should be resolved by the correct logic, still
          // not resolved"). The main task's person is NOT on the file at all —
          // but the SUBTASK person IS the file's current borrower. Both slots
          // are therefore proven: the main-task person takes the borrower slot
          // and the current borrower moves to the co-borrower slot (the first
          // shape above only fired when the main person already sat in the CO
          // slot — a file whose co slot was empty could never self-correct and
          // re-flagged "Shaindel vs Boruch" forever). Guarded: never displaces
          // a DIFFERENT real co-borrower link (the co slot must be empty, the
          // subtask person, or a self-reference). Structure, not data — same
          // audit action, no review needed (owner ruled roles are automatic).
          await db.query(
            `UPDATE applications SET borrower_id=$2, co_borrower_id=$3, updated_at=now() WHERE id=$1`,
            [applicationId, borrowerId, roles.borrower_id]);
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system',NULL,'borrower_roles_swapped','application',$1,$2)`,
            [applicationId, JSON.stringify({ taskId: task.id, primaryNow: borrowerId, coBorrowerNow: roles.borrower_id,
              why: 'ClickUp main task is the borrower and its SUBTASK person held the borrower slot — both roles re-seated (main person → borrower, previous borrower → co-borrower)' })]).catch(() => {});
          await closeSwapRows('the file’s borrower/co-borrower roles were re-seated to match ClickUp (main task = borrower, subtask = co-borrower)');
        }
      } catch (e) { console.warn('[ingest] role reconciliation skipped:', e.message); }
    }
    // Stamp switch-over (owner-directed 2026-07-15): when a link was newly
    // ESTABLISHED this pass (created / identity / stamp / loan-number /
    // dead-task relink — anything but the steady-state 'linked_task'), the
    // ClickUp task may still carry a stale copied "YS Portal File ID/Link"
    // (a duplicated task inherits the source file's copyable stamp) or none at
    // all. Enqueue a SCOPED push of just the two stamp fields so the task
    // points at ITS OWN portal file. This is the ONE narrow pull-side enqueue
    // exception: portal-owned metadata, non-PII, idempotent (the push's no-op
    // suppression skips equal stamps), and it fires only on the
    // unlinked→linked transition — the next ingest matches byTask
    // ('linked_task') and does not re-enqueue, so it can never echo-loop.
    if (applicationId && matchStatus && matchStatus !== 'linked_task') {
      try { await require('./enqueue').enqueueClickupPush(applicationId, ['portal_stamp']); } catch (_) { /* best-effort */ }
    }
    // SILENT-GATE VISIBILITY (root fix 2026-07-15, Asher Salamon / 734 Dennis
    // Pl): a task that fails to materialize must never be invisible. Ambiguous
    // and duplicate-pending tasks queue a review row (which emails the file's
    // loan officer); the row auto-closes the moment the file lands. A loan
    // number copied by the duplicate-a-task workflow gets its own row telling
    // the officer to assign the real number in ClickUp — once assigned, the
    // number fills in via COALESCE and the row auto-closes too.
    try {
      if (!applicationId && (matchStatus === 'ambiguous' || matchStatus === 'duplicate_pending')) {
        const reason = 'file_not_materialized_' + matchStatus;
        // A task can TRANSITION between stuck states (ambiguous \u2194 duplicate_
        // pending); the open row must describe the CURRENT one, so a row with
        // a different reason is superseded rather than left stale (audit nit).
        await db.query(
          `UPDATE sync_review_queue SET status='resolved', auto_resolved=true, resolved_at=now(),
                  resolution_note='superseded \u2014 the task moved to a different stuck state'
            WHERE status='open' AND task_id=$1 AND field_key='file_link' AND reason<>$2`,
          [String(task.id), reason]).catch(() => {});
        // Enrich the forensic detail with LINKABLE candidate summaries so the
        // review screen can offer "link to this existing file" as an option.
        let rawDetail = matchDetail || null;
        if (rawDetail && Array.isArray(rawDetail.candidates) && rawDetail.candidates.length) {
          try {
            const cs = await db.query(
              `SELECT id, property_address->>'oneLine' AS address, ys_loan_number AS "loanNumber"
                 FROM applications WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL LIMIT 4`,
              [rawDetail.candidates.slice(0, 4).map(String)]);
            rawDetail = { ...rawDetail, candidates: cs.rows };
          } catch (_) { /* enrichment is optional */ }
        }
        await review.queueReview({
          borrowerId, taskId: task.id, direction: 'inbound', fieldKey: 'file_link',
          reason, suppressIfRejected: true,
          clickupValue: String(task.name || '').slice(0, 120), portalValue: null,
          rawValue: rawDetail ? JSON.stringify(rawDetail).slice(0, 1000) : null });
      } else if (applicationId) {
        // Close BOTH keyings: rows for this task, and app-keyed rows (the
        // synthetic app:<id> unlinked-file rows) \u2014 the file syncs now.
        await review.closeStaleReviews({ taskId: task.id, fieldKey: 'file_link', note: 'auto-closed \u2014 the file is now in PILOT' });
        await review.closeStaleReviews({ applicationId, fieldKey: 'file_link', note: 'auto-closed \u2014 the file is linked and syncing' });
      }
      if (applicationId && res.copiedLoanNumber) {
        await review.queueReview({
          applicationId, borrowerId, taskId: task.id, direction: 'inbound', fieldKey: 'ys_loan_number',
          reason: 'copied_loan_number_needs_assignment',
          clickupValue: res.copiedLoanNumber.number, portalValue: null,
          rawValue: JSON.stringify(res.copiedLoanNumber).slice(0, 300) });
      } else if (applicationId) {
        await review.closeStaleReviews({ taskId: task.id, fieldKey: 'ys_loan_number', note: 'auto-closed \u2014 the task now carries its own loan number' });
      }
    } catch (_) { /* visibility is best-effort \u2014 never breaks ingest */ }
    // Co-borrower government-ID condition follows the file's ACTUAL linked
    // co-borrower (a manual link is preserved by fill-only-if-null above).
    if (applicationId) {
      try {
        const cur = (await db.query(`SELECT co_borrower_id FROM applications WHERE id=$1`, [applicationId])).rows[0];
        await require('../lib/co-borrower').ensureCoBorrowerIdCondition(applicationId, cur && cur.co_borrower_id);
      } catch (_) { /* best-effort */ }
    }
  } else {
    // Unsupported program (DSCR / long-term / anything outside RTL_PROGRAMS): pull
    // the task for DATA ONLY (masked snapshot below) — never materialize a loan
    // file, never flag it as an error/mismatch. If a file was PREVIOUSLY built as
    // RTL and the program was later corrected in ClickUp (e.g. Short-Term Rehab →
    // DSCR), descope it: remove it from the portal WITHOUT touching ClickUp.
    //
    // SAFETY (2026-07-12 audit — I-A): descope ONLY on a label we POSITIVELY
    // recognize as non-RTL (DSCR / long-term / rental — see crosswalk
    // .isNonRtlProgramLabel). Previously ANY non-blank label the RTL crosswalk
    // failed to map counted as "non-RTL" — so RENAMING an RTL option in ClickUp,
    // adding a new RTL-ish label, or a stale option cache mis-resolving the label
    // would read program=null + rawProgram non-empty and SOFT-DELETE every live
    // RTL file on the next reconcile ("my files vanished"). Now an unrecognized
    // label leaves the file untouched (data_only snapshot only) — keeping a
    // possibly-stale file is far safer than mass-deleting real ones. Blank /
    // unresolved / "unset" programs still never descope (transient-read guard).
    const rawProg = (read.rawProgram || '').trim();
    const positivelyNonRtl = rawProg !== ''
      && !UNSET_PROGRAM_LABELS.has(rawProg.toLowerCase())
      && crosswalk.isNonRtlProgramLabel(rawProg);
    if (positivelyNonRtl) {
      const desc = await descopeFlipped(task.id);
      if (desc) { applicationId = desc.id; matchStatus = 'descoped'; matchDetail = { from: desc.program, to: rawProg }; }
    }
  }

  // A linked RTL file gets the full RTL workflow — the condition set (internal +
  // external conditions) AND the internal checklist — exactly like a manually-
  // created file, generated ONCE if the file has none yet. Then mirror the ClickUp
  // checklist-field statuses onto those conditions. Both are portal-only (no push).
  if (isRtl && applicationId) {
    await ensureRtlChecklist(applicationId);
    await applyChecklistStatuses(applicationId, task, options);
  }

  // Preserve a MASKED snapshot of every task's mapped data — RTL and non-RTL
  // (long-term) alike — so no ClickUp data is lost even for file types we don't
  // materialize as loan files yet. SSN/card are masked; never cleartext here.
  const snapshot = buildMaskedSnapshot(read, { loanOfficerEmail, processorEmail });
  await db.query(
    `INSERT INTO clickup_task_index (task_id, kind, program, ssn_hash, borrower_id, application_id, llc_id,
        match_status, match_detail, snapshot, snapshot_at, task_name, folder_id, internal_status, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,now())
     ON CONFLICT (task_id) DO UPDATE SET program=EXCLUDED.program, ssn_hash=EXCLUDED.ssn_hash,
        borrower_id=EXCLUDED.borrower_id, application_id=COALESCE(EXCLUDED.application_id, clickup_task_index.application_id),
        llc_id=EXCLUDED.llc_id, match_status=EXCLUDED.match_status, match_detail=EXCLUDED.match_detail,
        snapshot=EXCLUDED.snapshot, snapshot_at=now(), task_name=EXCLUDED.task_name, folder_id=EXCLUDED.folder_id,
        internal_status=EXCLUDED.internal_status, last_seen=now()`,
    [task.id, isRtl ? 'rtl_file' : 'data_only', program, identity.ssnHash(read.borrower.ssn, cfg.ssnMatchKey),
     borrowerId, applicationId, llcId, matchStatus, matchDetail ? JSON.stringify(matchDetail) : null,
     JSON.stringify(snapshot), task.name || null, folderId ? String(folderId) : null, read.internalStatus || null]).catch(() => {});

  return { borrowerId, llcId, applicationId, isRtl, matchStatus };
}

/**
 * Link a task to its portal RTL file (assigning the loan officer) or, when
 * allowed, create one. allowCreate=false still LINKS (stamp/identity) and
 * UPDATES an existing file — only new-file creation is gated.
 * Returns { applicationId, matchStatus, detail }.
 */
async function linkOrCreateApplication(task, read, borrowerId, llcId, ctx = {}) {
  const { allowCreate = false, forceCreate = false, folderId = null, loanOfficerEmail = null, processorEmail = null, coBorrowerId = null, coBorrowerTaskId = null } = ctx;
  const a = read.app || {};
  const lo = await resolveStaffByEmail(loanOfficerEmail);
  // PROCESSOR — two-field AGREEMENT gate (owner-directed 2026-07-19). ClickUp holds
  // the processor in TWO places: the "Processor" people-field (the human pick) and a
  // "Processor Email" text field an automation fills from it. Duplicating a task can
  // leave the two DISAGREEING (e.g. the people-field cleared but the stale email left
  // pointing at the old processor) — that stale email is exactly how Lisa Katz kept
  // syncing in as a processor nobody chose. Rule: adopt a processor from ClickUp ONLY
  // when BOTH fields resolve to the SAME staff person. On a conflict, adopt nobody and
  // CLEAR any stale portal processor (see the conflict-clear after the UPDATE below).
  // processorEmail was already translated to a staff email by routing.processorEmailFor.
  const prByEmail = await resolveStaffByEmail(processorEmail);
  const prByUser = await resolveStaffByClickupUserId(read.processorClickupId);
  const processorsAgree = !!(prByUser.id && prByEmail.id && prByUser.id === prByEmail.id);
  const agreedProcessorId = processorsAgree ? prByUser.id : null;
  // Conflict = at least one field names someone, but they don't agree (this INCLUDES
  // the duplicate-bug case: one field cleared, the other still populated). Both-empty
  // is NOT a conflict (no signal) — never clobber a portal value on ClickUp silence.
  const processorConflict = !!(prByUser.id || prByEmail.id) && !processorsAgree;
  // Underwriter comes from ClickUp's "Underwriter" users field (may hold several
  // users — take the first), matched to staff_users by clickup_user_id. Pull-only.
  const uw = await resolveStaffByClickupUserId(firstUserIdFromField(task, F.PIPELINE.underwriter));
  const internal = read.internalStatus;
  const external = statusMap.externalFor(internal) || 'processing';
  const cols = {
    program: a.program, loan_type: require('../lib/fields').sanitizeLoanType(a.loan_type), property_type: a.property_type, occupancy: a.occupancy,   // #95: ClickUp can't re-introduce a "Ground up" loan_type
    lender: a.lender, channel: a.channel, units: a.units, term: a.term,
    loan_amount: a.loan_amount, purchase_price: a.purchase_price, as_is_value: a.as_is_value, arv: a.arv,
    rehab_budget: a.rehab_budget, rehab_type: a.rehab_type, dscr_ratio: a.dscr_ratio,
    ys_loan_number: a.ys_loan_number, investor_loan_number: a.investor_loan_number,
    expected_closing: a.expected_closing, actual_closing: a.actual_closing,
    approx_appraised_value: a.approx_appraised_value, actual_appraised_value: a.actual_appraised_value,
    // Round 3: additional staff-workflow detail (pull-only; ClickUp is source of truth).
    actual_rate: a.actual_rate, desired_rate: a.desired_rate,
    property_taxes: a.property_taxes, property_insurance: a.property_insurance,
    property_hoa: a.property_hoa, rental_income: a.rental_income,
    prepayment_penalty: a.prepayment_penalty,
    // Assignment data was READ by the mapper but never persisted — so a
    // ClickUp assignment deal never set is_assignment and the assignment
    // condition never generated (root fix 2026-07-14).
    is_assignment: a.is_assignment, underlying_contract_price: a.underlying_contract_price,
    assignment_fee: a.assignment_fee,
    title_company: a.title_company, title_company_contact: a.title_company_contact,
    insurance_company: a.insurance_company, insurance_company_contact: a.insurance_company_contact,
    first_lien: a.first_lien, second_lien: a.second_lien,
    appraised_rental_value: a.appraised_rental_value, approx_appraised_rental_value: a.approx_appraised_rental_value,
    cda_value: a.cda_value, appraiser_name: a.appraiser_name,
    encompass_status: a.encompass_status, application_submitted: a.application_submitted,
    property_address: a.property_address ? JSON.stringify(a.property_address) : null,
    internal_status: internal, status: external,
    clickup_extra: Object.keys(read.extra).length ? JSON.stringify(read.extra) : null,
    // Officer + processor assignment (COALESCE on update: reassign when resolved,
    // keep when not). Bidirectional: a real, AGREED ClickUp processor flows in here
    // (agreedProcessorId is non-null only when BOTH ClickUp fields name the same
    // person), and an explicit portal pick flows OUT via the outbound push (which
    // now writes BOTH ClickUp processor fields so they always agree).
    loan_officer_id: lo.id, loan_officer_name: lo.name, processor_id: agreedProcessorId,
    // Underwriter assignment — same COALESCE semantics: set when resolved, keep when not.
    underwriter_id: uw.id,
    clickup_folder_id: folderId != null ? Number(folderId) : null,
    // Real ClickUp task creation date (epoch ms) so the pipeline's Newest/Oldest
    // sort reflects true file chronology, not the one-time import timestamp. Set
    // once (COALESCE on update keeps it) and backfilled on the next reconcile.
    clickup_created_at: task && task.date_created ? new Date(Number(task.date_created)) : null,
  };

  // INBOUND YEAR GUARD (2026-07-15 incident): a ClickUp date whose year is out
  // of range (a mid-typing artifact, or a literal 2-digit year — "26" typed as
  // the year lands in 0026) is NEVER persisted. It goes to the sync review
  // queue instead, with the auto-pivoted proposal (26 → 2026) for one-click
  // human approval. The rest of the pull proceeds normally.
  // NOTE: acquisition_date is mapped 'both' in FIELD_MAP but has NO inbound
  // persistence path (it is absent from `cols` below), so it needs no entry
  // here — an entry would be dead code (post-merge audit finding #1). If an
  // inbound acquisition_date pull is ever added to `cols`, add it to this loop.
  const pendingYearReviews = [];
  for (const dk of ['expected_closing', 'actual_closing']) {
    const v = cols[dk];
    if (v == null || v === '') continue;
    const y = Number(String(v).slice(0, 4));
    if (!(y >= 1900 && y <= 2100)) {
      pendingYearReviews.push({ fieldKey: dk, raw: String(v), proposed: transforms.pivotSuspectYear(String(v), 'closing') });
      cols[dk] = null;                 // COALESCE keeps the current portal value
    } else {
      // The ClickUp value is sane now — an open year-guard review for this
      // task+field is stale (fixed at the source); close it, no clicks needed
      // (owner-directed 2026-07-15). Best-effort; the pull proceeds regardless.
      try { await review.closeStaleReviews({ taskId: task.id, fieldKey: dk, note: 'auto-closed — ClickUp now carries a valid date (' + String(v) + ')' }); } catch (_) {}
    }
  }

  // Which existing app? task_id link first, then stamp/identity.
  let targetId = null, matchStatus = null, detail = null;
  const byTask = await db.query(`SELECT id FROM applications WHERE clickup_pipeline_task_id=$1 LIMIT 1`, [task.id]);
  if (byTask.rows[0]) { targetId = byTask.rows[0].id; matchStatus = 'linked_task'; }
  let copiedLoanNumber = null;
  if (!targetId) {
    const m = await findExistingApp(task, read, borrowerId, { allowCreate, forceCreate });
    if (m && m.ambiguous) return { applicationId: null, matchStatus: 'ambiguous', detail: m.detail };
    copiedLoanNumber = (m && m.copiedLoanNumber) || null;
    // NOTE: the copied number is deliberately NOT nulled out of `cols` here —
    // the universal guard below adjudicates OWNERSHIP (reassign vs flag) for
    // every path, create included. findExistingApp's copiedLoanNumber remains
    // the matching-layer signal ("don't treat the number as identity").
    // Fresh ClickUp duplicate whose address hasn't been updated yet — do NOT
    // create a same-address twin file; the officer's address edit re-triggers
    // ingest and the file materializes cleanly then. Admin force-create is the
    // deliberate override for a genuine same-address second deal.
    if (m && m.duplicatePending) return { applicationId: null, matchStatus: 'duplicate_pending', detail: m.detail };
    if (m && m.id) { targetId = m.id; matchStatus = m.how; detail = m.detail || null; }
  }
  // UNIVERSAL loan-number import guard — EVERY persistence path, not only the
  // findExistingApp one. After a file materializes without the copied number,
  // the very next ingest matches byTask ('linked_task', which never calls
  // findExistingApp) while ClickUp STILL carries the copied number — and the
  // COALESCE update would try to import it, collide on the partial unique
  // index (db/048), and break the ENTIRE inbound update for the file on every
  // pass. A number already carried by ANOTHER live application is never
  // blind-imported. WHO rightfully owns it is ADJUDICATED, not first-claim-
  // wins (owner-reported live 2026-07-15, Abraham Gruber: the NEWER duplicate
  // task got processed first and imported the number, so the ORIGINAL closed
  // deal got flagged as "the copy" forever — exactly backwards):
  //   1. Read the OTHER task's loan-number field live. If it no longer
  //      carries this number (the officer resolved the duplication by
  //      clearing/renumbering it there) or the task is deleted, the other
  //      app's stored copy is STALE → REASSIGN: clear it there (audited) and
  //      import here. That's also how the review rows self-close after the
  //      human fixes ClickUp — the pull's blank-never-clears COALESCE would
  //      otherwise preserve the stale copy forever.
  //   2. Both tasks still claim it → the OLDER task (ClickUp creation date)
  //      is the original and wins; the newer one is the duplicate to flag.
  //   3. Can't confirm (fetch error, unlinked holder, missing dates) →
  //      conservative: don't import, flag the current task (a wrong flag is
  //      recoverable; a wrong reassignment on a live deal is not).
  if (cols.ys_loan_number != null) {
    const own = await db.query(
      `SELECT id, borrower_id, clickup_pipeline_task_id FROM applications
        WHERE lower(btrim(ys_loan_number))=lower(btrim($1)) AND deleted_at IS NULL AND id IS DISTINCT FROM $2 LIMIT 1`,
      [cols.ys_loan_number, targetId]).catch(() => ({ rows: [] }));
    if (own.rows[0]) {
      const holder = own.rows[0];
      let reassign = false, holderStillClaims = null;
      // Nothing persists on this pass (no linked target and creation gated
      // off) → adjudicating would strip the holder while nobody takes the
      // number. Skip to the conservative flag path (post-merge audit nit).
      const willPersist = !!targetId || allowCreate;
      if (holder.clickup_pipeline_task_id && willPersist) {
        try {
          const ht = await require('./client').getTask(holder.clickup_pipeline_task_id);
          const hf = ((ht && ht.custom_fields) || []).find((c) => c.id === F.PIPELINE.ysLoanNumber);
          const hNum = hf && hf.value != null ? String(hf.value).trim().toLowerCase() : '';
          holderStillClaims = hNum === String(cols.ys_loan_number).trim().toLowerCase();
          if (!holderStillClaims) reassign = true;                       // fixed at the source — stale portal copy
          else if (String(holder.borrower_id) === String(borrowerId)) {
            // Date order decides ONLY within one borrower's own deals. A
            // CROSS-BORROWER contested number where both tasks still claim
            // it is a genuine key collision — policy says a human decides
            // (post-merge audit should-fix; the flag path below holds it).
            const curCreated = Number(task.date_created || 0);
            const holderCreated = Number(ht.date_created || 0);
            if (curCreated && holderCreated && curCreated < holderCreated) reassign = true;   // older task IS the original
          }
        } catch (e) { if (e && e.status === 404) reassign = true; /* holder's task deleted — claim gone; other errors: conservative */ }
      }
      if (reassign) {
        // Re-check the number in the WHERE so a concurrent ingest that just
        // gave the holder a DIFFERENT number can't be clobbered (audit nit).
        await db.query(
          `UPDATE applications SET ys_loan_number=NULL, updated_at=now()
            WHERE id=$1 AND lower(btrim(ys_loan_number))=lower(btrim($2))`,
          [holder.id, cols.ys_loan_number]).catch(() => {});
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           VALUES ('system',NULL,'loan_number_reassigned','application',$1,$2)`,
          [holder.id, JSON.stringify({ number: cols.ys_loan_number, toApplication: targetId || null,
            fromTask: holder.clickup_pipeline_task_id, toTask: task.id,
            why: holderStillClaims === false ? 'holder task no longer carries the number in ClickUp'
              : holderStillClaims === true ? 'this task is OLDER — it is the original; the holder is the duplicate'
              : 'holder task deleted' })]).catch(() => {});
        // The rightful owner keeps its number — do NOT flag the current task.
        copiedLoanNumber = null;
        // The holder (the actual duplicate) gets ITS flag when both tasks
        // still claim the number — its own next ingest would also self-flag,
        // but queue it now so the officer sees it immediately.
        if (holderStillClaims) {
          try {
            await review.queueReview({
              applicationId: holder.id, borrowerId: holder.borrower_id || null,
              taskId: holder.clickup_pipeline_task_id, direction: 'inbound',
              fieldKey: 'ys_loan_number', reason: 'copied_loan_number_needs_assignment',
              suppressIfRejected: true, clickupValue: cols.ys_loan_number, portalValue: null,
              rawValue: JSON.stringify({ copiedFrom: task.id, reassignedToApplication: targetId || null }).slice(0, 300) });
          } catch (_) { /* best-effort */ }
        }
        // cols.ys_loan_number stays SET → imports onto the rightful file.
      } else {
        copiedLoanNumber = copiedLoanNumber ||
          { number: cols.ys_loan_number, ofApplication: holder.id, boundToTask: holder.clickup_pipeline_task_id };
        cols.ys_loan_number = null;   // COALESCE keeps the portal's (blank or own) number
      }
    }
  }

  // #86 — protect a freshly-APPROVED economics change from a STALE ClickUp pull.
  // When a locked file's economics change is approved in the portal, the value is
  // written to `applications` and an outbound push is enqueued. If an inbound pull
  // lands before that push reaches ClickUp (a race, a lagging queue, or outbound
  // disabled), the raw ClickUp value would COALESCE-overwrite the just-approved one
  // — the borrower sees the old number, opens a NEW change request, and the request
  // "re-appears" forever. Fix: for each governed field, if an APPROVED change_request
  // is NEWER than the ClickUp task's last update, ClickUp is definitionally stale for
  // that field — keep the portal value (cols[field]=null → COALESCE keeps it) and
  // re-enqueue the push so ClickUp catches up. A genuinely newer ClickUp edit
  // (date_updated > the approval) still wins, so this never blocks a real ClickUp
  // change; and once our push lands, date_updated moves past the approval and the
  // guard stops firing (no loop). Best-effort — never breaks the pull.
  if (targetId && task && task.date_updated) {
    try {
      const CR = require('../lib/change-requests');
      const present = CR.GOVERNED_FIELDS.filter((k) => k in cols && cols[k] != null);
      if (present.length) {
        const protectedCrs = await db.query(
          `SELECT DISTINCT ON (field) field FROM change_requests
            WHERE application_id=$1 AND status='approved' AND field = ANY($2)
              AND decided_at > to_timestamp($3::bigint / 1000.0)
            ORDER BY field, decided_at DESC`,
          [targetId, present, String(task.date_updated)]);
        if (protectedCrs.rows.length) {
          const fields = protectedCrs.rows.map((r) => r.field);
          for (const f of fields) cols[f] = null;   // COALESCE keeps the approved portal value
          try { await require('./enqueue').enqueueClickupPush(targetId, fields); } catch (_) { /* re-sync ClickUp; no-op if already equal */ }
          // Audit the protection (part of the cross-system change history).
          try {
            await db.query(
              `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
               VALUES ('system', NULL, 'clickup_pull_cr_protected', 'application', $1, $2)`,
              [targetId, JSON.stringify({ taskId: task.id, fields })]);
          } catch (_) {}
        }
      }
    } catch (_) { /* best-effort — a guard failure must never break the inbound pull */ }
  }

  const vals = Object.values(cols);
  const set = Object.keys(cols).map((k, i) => `${k}=COALESCE($${i + 2}, ${k})`).join(', ');
  if (targetId) {
    // INBOUND CHANGE AUDIT (2026-07-15 date incident; broadened to ALL mapped
    // fields owner-directed the same day): whenever this pull is about to CHANGE
    // an existing portal value on ANY mapped scalar column, record before→after
    // in audit_log — the previously-missing half of the cross-system API history.
    // (A null pulled value keeps the current one via COALESCE — never a change.)
    try {
      const AUDIT_SKIP = new Set(['property_address', 'clickup_extra', 'clickup_created_at', 'clickup_folder_id']);
      const CRIT = Object.keys(cols).filter((k) => !AUDIT_SKIP.has(k));
      const cur = (await db.query(`SELECT ${CRIT.join(', ')} FROM applications WHERE id=$1`, [targetId])).rows[0];
      if (cur) {
        const diffs = {};
        for (const k of CRIT) {
          const nv = cols[k], ov = cur[k];
          if (nv == null || ov == null) continue;
          const same = String(ov) === String(nv) ||
            (isFinite(Number(ov)) && isFinite(Number(nv)) && Number(ov) === Number(nv));
          if (!same) diffs[k] = { from: ov, to: nv };
        }
        if (Object.keys(diffs).length) {
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system', NULL, 'clickup_pull_field_change', 'application', $1, $2)`,
            [targetId, JSON.stringify({ taskId: task.id, changes: diffs })]);
        }
      }
    } catch (_) { /* audit is best-effort — never blocks the pull */ }
    if (pendingYearReviews.length) {
      // WO-6 (F-M8): show the card what PILOT actually holds (the year-guard kept
      // it via COALESCE), so a blank "In PILOT" column can't mislead a reviewer
      // into adopting ClickUp's bad-year value over a good portal date.
      const cur = (await db.query(`SELECT expected_closing, actual_closing FROM applications WHERE id=$1`, [targetId])).rows[0] || {};
      for (const p of pendingYearReviews) {
        const portalVal = cur[p.fieldKey] ? String(cur[p.fieldKey]).slice(0, 10) : null;
        await review.queueReview({ applicationId: targetId, borrowerId, taskId: task.id, direction: 'inbound',
          fieldKey: p.fieldKey, currentValue: portalVal, proposedValue: p.proposed, rawValue: p.raw,
          reason: 'clickup_year_out_of_range', clickupValue: p.proposed, portalValue: portalVal });
      }
    }
    // Restore-on-reflip: if this file had been auto-descoped because its program
    // was previously changed to a non-RTL type, flipping it back to an RTL program
    // brings it back (clear deleted_at). We ONLY un-delete a file that WE descoped
    // (sync_state='descoped') — an admin-archived file (deleted_at set, sync_state
    // still 'linked') is left archived so the pull never resurrects it.
    await db.query(
      `UPDATE applications SET ${set}, clickup_pipeline_task_id=$${vals.length + 2}, sync_state='linked',
              deleted_at = CASE WHEN sync_state='descoped' THEN NULL ELSE deleted_at END,
              clickup_last_synced_at=now(), updated_at=now() WHERE id=$1`,
      [targetId, ...vals, task.id]);
    // Two-field PROCESSOR conflict → the ClickUp processor signal is untrustworthy
    // (the stale-duplicate case). Clear any portal processor so the file returns to
    // "no processor" per the agreement rule (owner-directed 2026-07-19). The COALESCE
    // set above can only keep or set — never clear — so this explicit clear is what
    // removes a stale processor (e.g. Lisa left in the Processor Email after a dup).
    // The db/103 trigger retires her assignee ACCESS row in lock-step. Only fires on
    // a genuine conflict (not on ClickUp silence), and only when something is set.
    if (processorConflict) {
      const clr = await db.query(
        `UPDATE applications SET processor_id=NULL, updated_at=now()
          WHERE id=$1 AND processor_id IS NOT NULL RETURNING 1`, [targetId]);
      if (clr.rowCount) {
        try {
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system', NULL, 'clickup_processor_conflict_cleared', 'application', $1, $2)`,
            [targetId, JSON.stringify({ taskId: task.id,
              processorFromPeopleField: prByUser.id || null,
              processorFromEmailField: prByEmail.id || null })]);
        } catch (_) { /* audit best-effort */ }
      }
    }
    // Co-borrower: fill when the file has none yet — never clobber a link a
    // human set to a REAL person. ONE exception (root fix 2026-07-14): when the
    // current link points at a SYNC-CREATED PLACEHOLDER profile (shadow email,
    // placeholder name, clickup origin, no login), the corrected profile the
    // hardened resolver split off was previously stranded forever in the dedup
    // queue while the file kept showing "Unknown Unknown" — that placeholder
    // link may be re-pointed. The subtask id is recorded alongside (fill-only).
    if (coBorrowerId) {
      try {
        await db.query(
          `UPDATE applications a SET co_borrower_id=$2, updated_at=now()
            WHERE a.id=$1 AND a.co_borrower_id IS DISTINCT FROM $2
              AND (a.co_borrower_id IS NULL OR EXISTS (
                    SELECT 1 FROM borrowers cb
                     WHERE cb.id=a.co_borrower_id
                       AND cb.origin='clickup_backfill'
                       AND cb.email LIKE 'noemail+%@clickup.local'
                       AND lower(btrim(coalesce(cb.first_name,''))) IN ('','unknown','co-borrower')
                       AND NOT EXISTS (SELECT 1 FROM borrower_auth ba WHERE ba.borrower_id=cb.id)))`,
          [targetId, coBorrowerId]);
      } catch (_) {}
    }
    if (coBorrowerTaskId) {
      try { await db.query(`UPDATE applications SET co_borrower_task_id=COALESCE(co_borrower_task_id,$2), updated_at=now() WHERE id=$1`, [targetId, coBorrowerTaskId]); } catch (_) {}
    }
    // Vesting LLC: link the ClickUp entity as the file's vesting entity AND run the
    // full wiring (owner links, LLC doc checklist, LLC condition, rule re-eval) via
    // the single authority in src/lib/vesting.js — the same path the HTTP link
    // routes use. ClickUp is authoritative for an UNVERIFIED, clickup-origin entity
    // (so a corrected *LLC Name flows in), but never overwrites a human-linked or
    // verified entity, and never touches a Clear-to-Close-locked file (guards live
    // in setVestingLlc). push:false — never echo a pulled value back to ClickUp.
    if (llcId) {
      try { await require('../lib/vesting').setVestingLlc(targetId, llcId, { source: 'clickup', push: false }); } catch (_) { /* best-effort */ }
    }
    return { applicationId: targetId, matchStatus, detail, copiedLoanNumber };
  }
  if (!allowCreate) return { applicationId: null, matchStatus: 'skipped' };
  // No person, no file: a task whose borrower has no name/SSN/DOB (the
  // no-identity guard returned null) cannot materialize — applications
  // .borrower_id is NOT NULL, and a file for "Unknown Unknown" is exactly the
  // pollution the guard exists to stop. Ambiguous keeps it VISIBLE: the
  // file_link review card + the boot retry re-drive it the moment ClickUp
  // carries a borrower name (usually just filling the *Borrower Name field).
  if (!borrowerId) {
    return { applicationId: null, matchStatus: 'ambiguous',
      detail: { reason: 'no_borrower_identity', hint: 'the ClickUp task carries no borrower name, SSN, or DOB — fill the *Borrower Name field (or the task title) and resync' } };
  }

  // Create (race-safe: the partial unique index on clickup_pipeline_task_id makes
  // a concurrent duplicate INSERT resolve to the existing row instead of a dup).
  // Stamp clickup_last_synced_at on CREATE (mirroring the UPDATE branch). Without
  // it a freshly-pulled file has clickup_last_synced_at=NULL, which the outbound
  // dirty-sweep reads as "dirty" and immediately echoes back to ClickUp — a pull→
  // push loopback for every inbound-created file.
  // A BRAND-NEW row carries ONLY the values ClickUp actually provided — a null
  // cols entry is omitted so the column takes its DB DEFAULT. Spreading nulls
  // explicitly bypassed defaults and violated NOT NULL DEFAULT columns
  // (owner-reported live 2026-07-15: `is_assignment boolean NOT NULL DEFAULT
  // false`, db/016 — a task without the assignment checkbox read null, the
  // INSERT wrote NULL, and EVERY inbound file-create crashed 23502 at the last
  // step: Shulom Eisenberg's "Create the file now", Asher Salamon's boot
  // retry, and any duplicate/stuck task being materialized). Omitting nulls
  // fixes the class for every present and future NOT NULL DEFAULT column; the
  // UPDATE branch is untouched (its COALESCE already treats null as "keep").
  const presentCols = Object.keys(cols).filter((k) => cols[k] != null);
  const keys = ['borrower_id', 'co_borrower_id', 'co_borrower_task_id', 'llc_id', 'clickup_pipeline_task_id', 'source', 'sync_state', 'clickup_last_synced_at', ...presentCols];
  const insVals = [borrowerId, coBorrowerId, coBorrowerTaskId, llcId, task.id, 'clickup_backfill', 'linked', new Date(), ...presentCols.map((k) => cols[k])];
  const ph = insVals.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(
    `INSERT INTO applications (${keys.join(',')}) VALUES (${ph})
     ON CONFLICT (clickup_pipeline_task_id) WHERE clickup_pipeline_task_id IS NOT NULL
     DO UPDATE SET clickup_last_synced_at=now(), updated_at=now() RETURNING id`, insVals);
  const newId = r.rows[0].id;
  // Year-guard reviews for a BRAND-NEW file land immediately too (the update
  // branch has its own insert) — a bad year must never wait for the next pass.
  for (const p of pendingYearReviews) {
    // WO-6 (F-M8): a brand-new file genuinely has no portal date yet, so "In
    // PILOT" is honestly blank here — pass it explicitly for a clear two-sided card.
    await review.queueReview({ applicationId: newId, borrowerId, taskId: task.id, direction: 'inbound',
      fieldKey: p.fieldKey, currentValue: null, proposedValue: p.proposed, rawValue: p.raw,
      reason: 'clickup_year_out_of_range', clickupValue: p.proposed, portalValue: null });
  }
  // A freshly-created file already carries llc_id (in the INSERT above), but its LLC
  // document slots + condition are not built until we run the wiring — do it now so
  // the vesting entity is fully materialized from the first sync (force:true).
  if (llcId) {
    try { await require('../lib/vesting').setVestingLlc(newId, llcId, { source: 'clickup', push: false, force: true }); } catch (_) { /* best-effort */ }
  }
  return { applicationId: newId, matchStatus: 'created', copiedLoanNumber };
}

module.exports = {
  ingestTask, resolveBorrower, upsertLlc, upsertTrackRecord, linkOrCreateApplication,
  applyChecklistStatuses, identityFrom, RTL_PROGRAMS,
};
