/**
 * LLC domain logic, shared by the borrower and staff routers.
 *
 * The LLC on the borrower profile is the single source of truth for entity
 * info, ownership structure, and the three entity documents (state formation
 * docs, IRS EIN letter, operating agreement). Each document lives in a fixed
 * SLOT — the llc-scoped checklist item generated from its template — so the
 * existing upload/supersede/review pipeline applies per slot.
 *
 * An application's 'rtl_p1_llc' umbrella condition is fulfilled BY the linked
 * LLC's state, never by uploads of its own: verified LLC → satisfied (with
 * sign-off), any rejected slot → issue, all three slots uploaded → received,
 * otherwise outstanding. syncLlcConditions() is the one place that state
 * machine lives; every LLC mutation (upload, review, verify, link) calls it.
 */
const db = require('../db');

// The three document slots, in display order. Slot identity is the template
// code — stable across renames.
const LLC_SLOT_CODES = ['rtl_llc_formation', 'rtl_llc_ein', 'rtl_llc_opagmt'];
// The Certificate of Good Standing is OPTIONAL — it never gates verification
// (a file must be sign-off-able without it), regardless of any is_required flag.
const OPTIONAL_SLOT_CODES = ['rtl_llc_goodstanding'];
// A Certificate of Good Standing goes stale fast. 30 days after it is uploaded
// it EXPIRES: the slot reopens (reads as empty so staff can re-upload) and it
// stops populating onto files — but the LLC stays verified (good standing was
// never required) and no OTHER document is touched. A note surfaces the expiry.
const GS_SLOT_CODE = 'rtl_llc_goodstanding';
const GS_EXPIRY_DAYS = 30;

// Application statuses on which the LLC condition is still live. Terminal
// files keep whatever state they closed with.
const OPEN_APP_STATUSES = `('new','in_review','processing','underwriting','approved','clear_to_close')`;

const EPS = 0.01;
const pct = (v) => (v == null ? null : Number(v));

// Layered entities (094): how deep an ownership chain may go. Five layers of
// holding companies is beyond anything underwriting sees in practice; the cap
// exists to bound recursion, not to constrain real structures.
const MAX_ENTITY_DEPTH = 5;

/* The members of an LLC (the borrower's own stake lives on llcs.ownership_pct).
   A member is a natural person OR another entity (member_kind='entity' with
   owner_llc_id → the owning LLC's own row); entity members carry the owning
   LLC's live name/verification so UIs and the verification gate can reason
   about the chain without extra queries. */
async function getMembers(llcId) {
  const r = await db.query(
    `SELECT m.id, m.full_name, m.ownership_pct, m.email, m.phone,
            m.member_kind, m.owner_llc_id,
            m.member_title, m.shares, m.certificate_number,
            o.llc_name AS owner_llc_name, o.is_verified AS owner_is_verified
       FROM llc_members m
       LEFT JOIN llcs o ON o.id = m.owner_llc_id
      WHERE m.llc_id=$1 ORDER BY m.created_at`, [llcId]);
  return r.rows;
}

/* Direct owning entities of an LLC (the parents one layer up). */
async function getOwnerLlcIds(llcId, client = db) {
  const r = await client.query(
    `SELECT DISTINCT owner_llc_id FROM llc_members
      WHERE llc_id=$1 AND owner_llc_id IS NOT NULL`, [llcId]);
  return r.rows.map((x) => String(x.owner_llc_id));
}

/* One BFS walker for both directions. Returns { ids, depth }: `ids` is the
   transitive SET of related entities (nearest layer first) and `depth` is the
   number of LEVELS walked (the longest ownership PATH in edges) — NOT the
   node count. A holding company owning five property LLCs is depth 1 with
   five ids; the cap must compare depth, never ids.length. */
async function walkChain(llcId, dir, { maxDepth = MAX_ENTITY_DEPTH, client = db } = {}) {
  const seen = new Set([String(llcId)]);
  const ids = [];
  let depth = 0;
  let frontier = [String(llcId)];
  for (let level = 0; level < maxDepth && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      const related = dir === 'up'
        ? await getOwnerLlcIds(id, client)
        : (await client.query(`SELECT DISTINCT llc_id FROM llc_members WHERE owner_llc_id=$1`, [id])).rows.map((x) => String(x.llc_id));
      for (const rel of related) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        ids.push(rel);
        next.push(rel);
      }
    }
    if (next.length) depth = level + 1;
    frontier = next;
  }
  return { ids, depth };
}

/* Every entity that (transitively) OWNS this LLC — nearest layer first. */
async function getAncestorEntityIds(llcId, opts) {
  return (await walkChain(llcId, 'up', opts)).ids;
}

/* Every entity this LLC (transitively) OWNS — used to re-sync child
   conditions when a parent's documents/verification change. */
async function getDescendantEntityIds(llcId, opts) {
  return (await walkChain(llcId, 'down', opts)).ids;
}

/* Would making `ownerLlcId` an owner of `llcId` create an ownership cycle
   (A owns B owns … owns A) or exceed the depth cap? Returns a human error
   string, or null when the link is fine. The cap measures the longest
   ownership PATH through the new link (layers above the owner + the link +
   layers below this LLC) — breadth (how MANY entities a layer holds) is
   never limited. */
async function ownershipLinkError(llcId, ownerLlcId, client = db) {
  if (String(ownerLlcId) === String(llcId)) return 'an entity cannot own itself';
  // Cycle: the proposed owner is (transitively) owned by this LLC already.
  const up = await walkChain(ownerLlcId, 'up', { maxDepth: MAX_ENTITY_DEPTH + 1, client });
  if (up.ids.includes(String(llcId))) {
    return 'that would create an ownership loop — this entity already (indirectly) owns the one you picked';
  }
  const down = await walkChain(llcId, 'down', { maxDepth: MAX_ENTITY_DEPTH + 1, client });
  if (up.depth + 1 + down.depth > MAX_ENTITY_DEPTH) return `ownership chains are limited to ${MAX_ENTITY_DEPTH} layers`;
  return null;
}

/* The three document slots with each slot's CURRENT document (one per slot —
   re-uploads supersede within the slot). */
async function getSlots(llcId) {
  const r = await db.query(
    `SELECT ci.id AS item_id, t.code, COALESCE(ci.borrower_label, ci.label) AS label,
            COALESCE(ci.borrower_hint, ci.hint) AS hint, ci.status AS item_status,
            COALESCE(ci.is_required, true) AS is_required, t.sort_order,
            d.id AS document_id, d.filename, d.content_type, d.size_bytes,
            d.review_status, d.rejection_reason, d.created_at AS uploaded_at,
            d.reviewed_at, s.full_name AS reviewed_by_name
       FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id AND t.scope = 'llc'
       LEFT JOIN LATERAL (
         SELECT * FROM documents d
          WHERE d.checklist_item_id = ci.id AND d.is_current = true
            AND d.review_status <> 'superseded'
            AND d.visibility = 'borrower' AND d.source_type <> 'chat_attachment'
          ORDER BY d.created_at DESC LIMIT 1
       ) d ON true
       LEFT JOIN staff_users s ON s.id = d.reviewed_by
      WHERE ci.llc_id = $1
      ORDER BY t.sort_order`, [llcId]);
  const rows = r.rows;
  // Certificate of Good Standing EXPIRY (30 days). An expired cert reopens its
  // slot: we present it as EMPTY so staff re-upload and it stops populating the
  // file — the LLC stays verified (good standing never gated), and NO other
  // document is affected. The underlying document row is left intact; this is a
  // computed view only (expired_document_id keeps a handle for the UI/note).
  for (const s of rows) {
    if (s.code === GS_SLOT_CODE && s.document_id && s.uploaded_at) {
      const ageDays = (Date.now() - new Date(s.uploaded_at).getTime()) / 86400000;
      if (ageDays > GS_EXPIRY_DAYS) {
        s.gs_expired = true;
        s.gs_expired_days = Math.round(ageDays);
        s.expired_document_id = s.document_id;
        s.expired_filename = s.filename;
        s.document_id = null; s.filename = null; s.content_type = null; s.size_bytes = null;
        s.review_status = null; s.rejection_reason = null; s.uploaded_at = null;
        s.reviewed_at = null; s.reviewed_by_name = null;
      }
    }
  }
  return rows;
}

// Loose-but-real EIN shape: 9 digits, optionally XX-XXXXXXX.
const EIN_RE = /^\d{2}-?\d{7}$/;
// A slot gates verification only when it is required AND not an explicitly
// optional slot (the Certificate of Good Standing is optional no matter what
// its is_required flag says — this guarantees you can always verify without it).
const isRequiredSlot = (s) => s.is_required !== false && !OPTIONAL_SLOT_CODES.includes(s.code);

/* What still stands between this LLC and "verified". Empty array = ready.
   Optional slots (e.g. Certificate of Good Standing) never block for being
   absent — but a REJECTED document in any slot always blocks: a verified
   entity must never carry a rejected document. */
function missingForVerification(llc, members, slots) {
  const missing = [];
  if (!llc.ein) missing.push('EIN');
  else if (!EIN_RE.test(String(llc.ein).trim())) missing.push('EIN format looks invalid (expect XX-XXXXXXX)');
  if (!llc.formation_state) missing.push('formation state');
  if (!llc.formation_date) missing.push('formation date');
  const own = pct(llc.ownership_pct);
  if (own == null) missing.push('borrower ownership %');
  else if (own > 100 + EPS) missing.push(`borrower ownership % exceeds 100 (${own})`);
  else if (own < 100 - EPS) {
    const total = own + members.reduce((s, m) => s + (pct(m.ownership_pct) || 0), 0);
    if (Math.abs(total - 100) > EPS) missing.push(`ownership must total 100% (currently ${total.toFixed(2)}%)`);
  }
  for (const s of slots) {
    // Optional slots (Certificate of Good Standing) NEVER gate — not for being
    // absent, not even for a rejected document. You can always sign off without one.
    if (OPTIONAL_SLOT_CODES.includes(s.code)) continue;
    if (s.document_id && s.review_status === 'rejected') { missing.push(`${s.label} was rejected`); continue; }
    if (!isRequiredSlot(s)) continue;
    if (!s.document_id) missing.push(`${s.label} not uploaded`);
    else if (s.review_status !== 'accepted') missing.push(`${s.label} not yet accepted`);
  }
  if (slots.filter(isRequiredSlot).length < LLC_SLOT_CODES.length) missing.push('document requirements not generated');
  // Layered entities verify BOTTOM-UP: every entity that owns a slice of this
  // one must itself be verified (its own info, ownership and three documents)
  // before this one can be. getMembers carries the owner's live state.
  for (const m of members) {
    if (m.member_kind !== 'entity') continue;
    if (!m.owner_llc_id) missing.push(`owning entity "${m.full_name}" is not linked`);
    else if (!m.owner_is_verified) missing.push(`owning entity "${m.owner_llc_name || m.full_name}" is not yet verified`);
  }
  return missing;
}

/* Underwriting advisories that do NOT gate verification — surfaced as chips
   on the staff panel (and softly to the borrower). Industry practice: a
   Certificate of Good Standing is expected once the entity is over a year
   old, and must be dated within ~90 days of closing. */
function advisories(llc, slots) {
  const out = [];
  const gs = slots.find((s) => s.code === GS_SLOT_CODE);
  const ageDays = llc.formation_date ? (Date.now() - new Date(llc.formation_date).getTime()) / 86400000 : null;
  if (gs) {
    if (gs.gs_expired) {
      // getSlots reopened the slot (>30 days). The LLC stays verified; surface
      // the expiry so staff know to re-upload a current certificate.
      out.push(`Certificate of Good Standing expired — the one on file was uploaded ${gs.gs_expired_days} days ago (certificates are only good for ${GS_EXPIRY_DAYS} days). Upload a current one.`);
    } else {
      const gsAge = gs.document_id && gs.uploaded_at ? (Date.now() - new Date(gs.uploaded_at).getTime()) / 86400000 : null;
      if (ageDays != null && ageDays > 365 && !gs.document_id)
        out.push('Entity is over a year old — most programs need a Certificate of Good Standing');
      if (gsAge != null && gsAge > 90)
        out.push(`Certificate of Good Standing is ${Math.round(gsAge)} days old — programs typically want one dated within 90 days of closing`);
    }
  }
  return out;
}

function completeness(llc, members, slots) {
  const own = pct(llc.ownership_pct);
  const memberTotal = members.reduce((s, m) => s + (pct(m.ownership_pct) || 0), 0);
  const ownershipComplete = own != null && own <= 100 + EPS
    && (own >= 100 - EPS || Math.abs(own + memberTotal - 100) <= EPS);
  const infoComplete = !!(llc.ein && llc.formation_state && llc.formation_date);
  // The x/y counters track REQUIRED slots (optional ones never gate);
  // rejections count across every slot — a rejected doc always needs action.
  const required = slots.filter(isRequiredSlot);
  const uploaded = required.filter((s) => s.document_id).length;
  const accepted = required.filter((s) => s.document_id && s.review_status === 'accepted').length;
  const rejected = slots.filter((s) => s.document_id && s.review_status === 'rejected').length;
  return {
    info_complete: infoComplete,
    ownership_complete: ownershipComplete,
    member_total_pct: memberTotal,
    docs_required: required.length || LLC_SLOT_CODES.length,
    docs_uploaded: uploaded,
    docs_accepted: accepted,
    docs_rejected: rejected,
    ready_to_verify: missingForVerification(llc, members, slots).length === 0,
    gs_expired: slots.some((s) => s.gs_expired),
    advisories: advisories(llc, slots),
  };
}

/* Everything a UI needs about one LLC in one shape. */
async function getLlcBundle(llcId) {
  const l = await db.query(`SELECT * FROM llcs WHERE id=$1`, [llcId]);
  const llc = l.rows[0];
  if (!llc) return null;
  const [members, slots] = await Promise.all([getMembers(llcId), getSlots(llcId)]);
  /* WHAT THIS ENTITY IS, in the shape a screen can render without knowing the
     rules — the owner noun, whether it holds SHARES or a PERCENTAGE, the titles
     its owners may hold. Derived here rather than in each screen so "Ownership %"
     never appears on a corporation and "Shares" never appears on an LLC. */
  const entity = require('./entity-type').describe(llc);
  return { ...llc, entity, members, slots, completeness: completeness(llc, members, slots) };
}

/**
 * Recompute the 'rtl_p1_llc' umbrella condition on every OPEN application
 * vesting in this LLC:
 *   verified LLC          → satisfied + signed off by the verifier
 *   any slot doc rejected → issue
 *   all slots uploaded    → received (in review)
 *   otherwise             → outstanding
 * A downgrade of a 'satisfied' item only happens when the LLC is (or just
 * became) unverified with opts.reopen — so a staff member's manual sign-off
 * on some unrelated basis isn't silently clobbered by an upload event.
 * opts.appId restricts the sync to one application (used when a file links
 * or switches its vesting entity).
 */
async function syncLlcConditions(llcId, opts = {}) {
  const l = await db.query(
    `SELECT id, llc_name, is_verified, verified_by FROM llcs WHERE id=$1`, [llcId]);
  const llc = l.rows[0];
  if (!llc) return;
  const appId = opts.appId || null;
  const slots = await getSlots(llcId);
  // "All in" means every REQUIRED slot holds a live document; optional slots
  // (Good Standing) never hold the condition back. A rejected doc in ANY slot
  // flips the condition to needs-attention.
  const required = slots.filter(isRequiredSlot);
  const uploaded = required.filter((s) => s.document_id && s.review_status !== 'rejected').length;
  let rejected = slots.some((s) => s.document_id && s.review_status === 'rejected');
  let allIn = required.length >= LLC_SLOT_CODES.length && uploaded >= required.length;

  // Layered entities: the umbrella condition reflects the WHOLE ownership
  // chain — "documents in review" only once every owning entity's required
  // slots are in too, and a rejected document anywhere in the chain flags the
  // condition. (Verification is already chain-gated bottom-up, so the
  // 'satisfied' arm needs no extra check.)
  for (const ancestorId of await getAncestorEntityIds(llcId)) {
    const aSlots = await getSlots(ancestorId);
    const aRequired = aSlots.filter(isRequiredSlot);
    const aUploaded = aRequired.filter((s) => s.document_id && s.review_status !== 'rejected').length;
    if (aSlots.some((s) => s.document_id && s.review_status === 'rejected')) rejected = true;
    if (!(aRequired.length >= LLC_SLOT_CODES.length && aUploaded >= aRequired.length)) allIn = false;
  }

  const target = llc.is_verified ? 'satisfied' : rejected ? 'issue' : allIn ? 'received' : 'outstanding';
  // '[auto]'-prefixed notes are ours to overwrite; a note a staffer typed by
  // hand is never clobbered by a sync.
  const note = llc.is_verified
    ? `[auto] Verified entity "${llc.llc_name}" on file — condition satisfied`
    : rejected ? `[auto] An entity document for "${llc.llc_name}" was rejected — see the borrower profile`
    : allIn ? `[auto] "${llc.llc_name}" documents uploaded — awaiting review`
    : null;
  const noteSet = `notes=CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $3 ELSE ci.notes END`;

  if (llc.is_verified) {
    await db.query(
      `UPDATE checklist_items ci
          SET status='satisfied',
              signed_off_by=COALESCE($2, ci.signed_off_by),
              signed_off_at=COALESCE(ci.signed_off_at, now()),
              ${noteSet}, updated_at=now()
         FROM checklist_templates t, applications a
        WHERE t.id=ci.template_id AND t.code='rtl_p1_llc'
          AND a.id=ci.application_id AND a.llc_id=$1
          AND ($4::uuid IS NULL OR a.id=$4)
          AND a.deleted_at IS NULL AND a.status IN ${OPEN_APP_STATUSES}
          AND (ci.status <> 'satisfied' OR ci.signed_off_at IS NULL
               OR (ci.notes LIKE '[auto]%' AND ci.notes IS DISTINCT FROM $3))`,
      [llcId, opts.verifiedBy || llc.verified_by || null, note, appId]);
    await cascadeToOwnedEntities(llcId, opts);
    return;
  }

  // Unverified: never touch items a staffer satisfied/signed off manually,
  // unless the caller explicitly reopens (verification revoked / doc rejected /
  // the file just switched to this entity).
  const guard = opts.reopen
    ? ''
    : `AND ci.status IN ('outstanding','requested','received','issue') AND ci.signed_off_at IS NULL`;
  await db.query(
    `UPDATE checklist_items ci
        SET status=$2, signed_off_by=NULL, signed_off_at=NULL,
            ${noteSet}, updated_at=now()
       FROM checklist_templates t, applications a
      WHERE t.id=ci.template_id AND t.code='rtl_p1_llc'
        AND a.id=ci.application_id AND a.llc_id=$1
        AND ($4::uuid IS NULL OR a.id=$4)
        AND a.deleted_at IS NULL AND a.status IN ${OPEN_APP_STATUSES}
        AND (ci.status IS DISTINCT FROM $2 OR ci.signed_off_at IS NOT NULL) ${guard}`,
    [llcId, target, note, appId]);
  await cascadeToOwnedEntities(llcId, opts);
}

/* A parent (owning) entity's documents/verification feed into every entity it
   owns — chain-aware allIn/rejected above — so a change on the parent re-syncs
   each owned entity's own vesting-file conditions. One level per call;
   recursion bottoms out via the _cascaded guard + the ownership depth cap. */
async function cascadeToOwnedEntities(llcId, opts) {
  if (opts._cascaded) return;
  try {
    const children = await getDescendantEntityIds(llcId);
    for (const childId of children) {
      await syncLlcConditions(childId, { reopen: !!opts.reopen, _cascaded: true });
    }
  } catch (e) {
    // Best-effort — a chain hiccup must never break the triggering action —
    // but never silently: a stale child condition is invisible otherwise.
    console.warn('[llc-cascade] condition re-sync for owned entities failed:', e.message);
  }
}

// ---------------- entity-detail validators (shared write path) ----------------
// One source of truth for the borrower AND staff LLC write endpoints, so the
// same rules (member shape, ownership ceiling, EIN normalization) apply no
// matter which portal made the edit.

// Validate a members payload:
//   [{fullName, ownershipPct, email?, phone?,                     — a person
//     memberKind?: 'person'|'entity', ownerLlcId?, ownerLlcName?}] — an entity
// Returns {members, error}. Completion to exactly 100% is a VERIFICATION
// requirement, not a save requirement — partial saves are allowed, but the
// total (borrower + members) may never exceed 100%. An ENTITY member (a
// layered entity — another LLC owning a slice of this one) names the owning
// LLC (by id from the picker, or by name to find-or-create) and may own up to
// the full 100% (a pure holding-company structure has borrower stake 0).
function parseMembers(raw, borrowerPct, opts = {}) {
  if (raw === undefined) return { members: undefined };
  if (!Array.isArray(raw)) return { error: 'members must be an array' };
  if (raw.length > 20) return { error: 'a maximum of 20 members is supported' };
  const ET = require('./entity-type');
  const entityType = ET.normalizeKey(opts.entityType) || ET.DEFAULT_TYPE;
  const members = [];
  for (const m of raw) {
    const isEntity = (m && m.memberKind) === 'entity';
    const fullName = String((m && (m.fullName || m.ownerLlcName)) || '').trim().slice(0, 160);
    const p = Number(m && m.ownershipPct);
    if (!fullName) return { error: isEntity ? 'each entity member needs the owning LLC name' : 'each member needs a full name' };
    if (isEntity) {
      if (!isFinite(p) || p <= 0 || p > 100) return { error: 'each entity member needs an ownership % between 0 and 100' };
    } else if (!isFinite(p) || p <= 0 || p >= 100) {
      return { error: 'each member needs an ownership % between 0 and 100' };
    }
    /* WHO THEY ARE ON THE SIGNATURE LINE, AND WHAT THEY HOLD (owner-directed
       2026-08-09). STAFF ONLY — `opts.allowOwnerDetails` is false for every
       borrower-facing door, so these three keys are IGNORED rather than refused
       when a borrower's payload happens to carry them (a borrower editing their
       members must never be answered with an error about a box they cannot see).
       A value that IS accepted is validated: the title is printed under a
       signature line and merged verbatim into a mortgage, so it may only ever be
       one of the titles entity-type.js records. */
    const detail = { memberTitle: undefined, shares: undefined, certificateNumber: undefined };
    if (opts.allowOwnerDetails && m) {
      if (m.memberTitle !== undefined) {
        const t = String(m.memberTitle == null ? '' : m.memberTitle).trim();
        const problem = ET.titleProblem(t, entityType);
        if (problem) return { error: problem };
        detail.memberTitle = t || null;
      }
      if (m.shares !== undefined) {
        const s = shareCount(m.shares);
        if (s && s.error) return { error: `${fullName}: ${s.error}` };
        detail.shares = s == null ? null : s;
      }
      if (m.certificateNumber !== undefined) {
        detail.certificateNumber = String(m.certificateNumber == null ? '' : m.certificateNumber).trim().slice(0, 40) || null;
      }
    }
    members.push({
      fullName, ownershipPct: Math.round(p * 100) / 100,
      email: !isEntity && m.email ? String(m.email).trim().slice(0, 160) : null,
      phone: !isEntity && m.phone ? String(m.phone).trim().slice(0, 40) : null,
      memberKind: isEntity ? 'entity' : 'person',
      ownerLlcId: isEntity && m.ownerLlcId ? String(m.ownerLlcId) : null,
      ownerLlcName: isEntity ? (String(m.ownerLlcName || m.fullName || '').trim().slice(0, 160) || null) : null,
      ...detail,
    });
  }
  const own = borrowerPct == null ? 0 : Number(borrowerPct) || 0;
  const total = own + members.reduce((s, m) => s + m.ownershipPct, 0);
  if (total > 100.01) return { error: `ownership exceeds 100% (${total.toFixed(2)}%)` };
  return { members };
}

/* A SHARE COUNT IS A WHOLE NUMBER OF SHARES, and zero is refused — an owner with
   zero shares is not an owner, and a zero would print "0 shares" onto a pledge.
   Returns the number, null for a blank (not answered — the honest state today),
   or {error}. Bounded to what int4 holds, so the value can never reach the column
   as a 22003 the route turns into "server error" (the number-bounds rule). */
const MAX_SHARES = 2147483647;
function shareCount(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n) return { error: 'the share count must be a whole number' };
  if (n <= 0) return { error: 'the share count must be more than zero' };
  if (n > MAX_SHARES) return { error: `the share count is too large (max ${MAX_SHARES.toLocaleString()})` };
  return n;
}

/* Replace an LLC's members. `opts.borrowerId` is REQUIRED when any member is
   an entity: the owning LLC is resolved within that borrower's own library —
   by id (must belong to them) or by name via findOrCreateLlc — and a
   freshly-created owner immediately gets its own three document slots, so a
   layered entity opens up as a full entity section of its own. Throws (with
   .status) on cycle / depth / foreign-entity errors. */
async function replaceMembers(llcId, members, opts = {}) {
  /* `opts.client` lets a caller already inside a transaction run this on its own
     connection, so the lookups see its uncommitted writes — the same optional
     trailing client `findOrCreateLlc` / `findLlcByName` / `generateLlcChecklist`
     already take, and the reason the entity-adoption path can do all of its work
     atomically. Defaults to the pool, so every existing caller is unchanged. */
  const client = opts.client || db;
  const resolved = [];
  for (const m of members) {
    if (m.memberKind !== 'entity') { resolved.push({ ...m, ownerLlcId: null }); continue; }
    if (!opts.borrowerId) { const e = new Error('entity members need a borrower context'); e.status = 400; throw e; }
    let ownerId = m.ownerLlcId;
    if (ownerId) {
      const own = await client.query(`SELECT id, llc_name FROM llcs WHERE id=$1 AND borrower_id=$2`, [ownerId, opts.borrowerId]);
      if (!own.rows[0]) { const e = new Error('owning entity not found'); e.status = 404; throw e; }
      m.fullName = own.rows[0].llc_name;   // display name follows the entity
    } else {
      // Resolve by name BEFORE creating anything, and validate the link first —
      // a rejected link (cycle / depth) must not leave an orphan LLC behind.
      ownerId = await findLlcByName(opts.borrowerId, m.ownerLlcName || m.fullName, client);
    }
    if (ownerId) {
      const linkErr = await ownershipLinkError(llcId, ownerId, client);
      if (linkErr) { const e = new Error(linkErr); e.status = 400; throw e; }
    } else {
      // Brand-new owning entity: no cycle is possible (nothing links to it yet);
      // only the PATH DEPTH of the chain hanging under this LLC can overflow.
      const down = await walkChain(llcId, 'down', { maxDepth: MAX_ENTITY_DEPTH + 1, client });
      if (1 + down.depth > MAX_ENTITY_DEPTH) {
        const e = new Error(`ownership chains are limited to ${MAX_ENTITY_DEPTH} layers`); e.status = 400; throw e;
      }
      const made = await findOrCreateLlc(opts.borrowerId, { llcName: m.ownerLlcName || m.fullName }, client);
      ownerId = made.id;
    }
    resolved.push({ ...m, ownerLlcId: ownerId });
  }
  /* THE TITLE THE CLOSER TYPED SURVIVES THE BORROWER'S NEXT EDIT.
     This function REPLACES the member list wholesale (delete + re-insert), and
     the title / share count / certificate number are STAFF-ONLY — a borrower
     editing their own members never sends them. Without carrying them over, a
     borrower fixing a spelling would silently wipe the closing desk's work on a
     value that prints under a signature line. Carried by normalized NAME, which
     is the only stable identity a re-inserted row has; a member whose name the
     edit CHANGED is a different person as far as this is concerned, and starts
     with a blank title — which is honest, and the closing-desk nudge will ask
     for it again. A value the caller DID supply always wins (including a
     deliberate blank). */
  const prior = new Map();
  for (const p of (await client.query(
    `SELECT full_name, member_title, shares, certificate_number FROM llc_members WHERE llc_id=$1`, [llcId])).rows) {
    if (p.member_title == null && p.shares == null && p.certificate_number == null) continue;
    prior.set(String(p.full_name || '').trim().toLowerCase(), p);
  }
  await client.query(`DELETE FROM llc_members WHERE llc_id=$1`, [llcId]);
  for (const m of resolved) {
    const was = prior.get(String(m.fullName || '').trim().toLowerCase()) || {};
    await client.query(
      `INSERT INTO llc_members (llc_id, full_name, ownership_pct, email, phone, member_kind, owner_llc_id,
                                member_title, shares, certificate_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [llcId, m.fullName, m.ownershipPct, m.email, m.phone, m.memberKind || 'person', m.ownerLlcId,
        m.memberTitle === undefined ? (was.member_title || null) : m.memberTitle,
        m.shares === undefined ? (was.shares == null ? null : was.shares) : m.shares,
        m.certificateNumber === undefined ? (was.certificate_number || null) : m.certificateNumber]);
  }
  // Every owning entity gets (or already has) its own document requirements —
  // the layered entity is a full entity: info + formation docs + EIN letter +
  // operating agreement, recursively. Lazy require avoids a module cycle.
  for (const m of resolved) {
    if (m.ownerLlcId) {
      try { await require('../routes/borrower').generateLlcChecklist(m.ownerLlcId, client); } catch (_) { /* best-effort */ }
    }
  }
}

/**
 * WRITE THE ENTITY-DOCUMENT SLOTS' WORDING FOR WHAT THIS ENTITY ACTUALLY IS.
 *
 * Owner-directed 2026-08-09: *"re-label the operating agreement slot for bylaws
 * and stock certificate, and this change needs to be everywhere else — SharePoint
 * syncing, TPR export and everywhere else."*
 *
 * THE ITEM CARRIES THE WORDING, NOT THE TEMPLATE, AND THAT IS THE MECHANISM.
 * There is ONE `rtl_llc_opagmt` template and one row per entity created from it,
 * so the template cannot say "operating agreement" and "bylaws" at the same
 * time. `checklist_items` already COPY the wording at creation (the repo's
 * long-standing pattern), so the per-entity label is written there — and because
 * SharePoint names its folders from the item's label and the TPR export
 * categorises from it, BOTH follow with no second map to keep in step. That is
 * the whole reason this is one function and not three.
 *
 * IT ONLY EVER REWRITES WORDING THIS MODULE OWNS. Every update is guarded on the
 * value it is about to replace being one of the four types' known wordings for
 * that slot (or blank), so a label a human edited by hand is left alone — the
 * same discipline the migrations use. Never throws: a wording pass must not be
 * able to fail a create.
 *
 * IT MUST BE RE-RUNNABLE, BECAUSE db/033 UNDOES IT ON EVERY BOOT. That migration
 * copies the TEMPLATE's borrower wording down onto every item made from these
 * three templates, every deploy — which is right for an LLC (the template says
 * what an LLC needs) and wrong for a corporation, whose item has been re-worded
 * here. Migrations are never edited, so the answer is the repo's usual one: this
 * function is the ONE definition and `lib/entity-slot-heal.js` re-applies it at
 * boot, after the migrations have run. That is also why the guard below fires on
 * ANY of the four fields being off rather than on the label alone — db/033
 * clobbers the borrower wording while leaving the internal label intact, and a
 * label-only test would report "nothing to do" on exactly the rows that were
 * just reverted.
 */
async function applyEntitySlotWording(llcId, client = db) {
  const ET = require('./entity-type');
  try {
    const r = await client.query(`SELECT entity_type FROM llcs WHERE id=$1`, [llcId]);
    if (!r.rows[0]) return { updated: 0 };
    const type = ET.normalizeKey(r.rows[0].entity_type) || ET.DEFAULT_TYPE;
    let updated = 0;
    for (const code of ET.TYPED_SLOT_CODES) {
      const want = ET.slotWording(code, type);
      if (!want) continue;
      // Every wording this slot could legitimately be carrying — the four types'
      // own. Anything else is a human's edit and is not ours to overwrite.
      const ours = ET.KEYS.map((k) => ET.slotWording(code, k)).filter(Boolean);
      const okLabels = Array.from(new Set(ours.map((w) => w.label)));
      const okBorrower = Array.from(new Set(ours.map((w) => w.borrowerLabel)));
      const okHints = Array.from(new Set(ours.map((w) => w.hint).filter(Boolean)));
      /* THE TEMPLATE'S OWN CURRENT WORDING COUNTS AS OURS TO REPLACE, and that
         is not a nicety: a fresh slot INHERITS the template's label, which db/494
         deliberately made type-neutral ("Governing document (operating agreement
         / bylaws)"). Without `OR ci.label = t.label` the guard would refuse to
         touch a brand-new corporation's slot — the exact row this function
         exists for. Anything that is neither a type's wording nor the template's
         is a human's edit, and stays. */
      const u = await client.query(
        `UPDATE checklist_items ci
            SET label          = $3,
                borrower_label = CASE WHEN COALESCE(ci.borrower_label,'') = ''
                                       OR ci.borrower_label = ANY($6::text[])
                                       OR ci.borrower_label = t.borrower_label
                                      THEN $4 ELSE ci.borrower_label END,
                hint           = CASE WHEN ci.hint IS NULL OR ci.hint = ANY($8::text[]) OR ci.hint = t.hint
                                      THEN $7 ELSE ci.hint END,
                borrower_hint  = CASE WHEN ci.borrower_hint IS NULL OR ci.borrower_hint = ANY($8::text[])
                                       OR ci.borrower_hint = t.borrower_hint
                                      THEN $7 ELSE ci.borrower_hint END,
                updated_at     = now()
           FROM checklist_templates t
          WHERE t.id = ci.template_id AND t.code = $2
            AND ci.llc_id = $1
            -- Only a row whose wording is one of OURS (or the template's) is touched…
            AND (ci.label = ANY($5::text[]) OR ci.label = t.label)
            -- …and only when at least one of the four is not already right, so a
            -- settled entity is a no-op rather than an updated_at churn.
            AND (ci.label IS DISTINCT FROM $3
              OR (ci.borrower_label IS DISTINCT FROM $4
                  AND (COALESCE(ci.borrower_label,'') = '' OR ci.borrower_label = ANY($6::text[]) OR ci.borrower_label = t.borrower_label))
              OR (ci.hint IS DISTINCT FROM $7
                  AND (ci.hint IS NULL OR ci.hint = ANY($8::text[]) OR ci.hint = t.hint))
              OR (ci.borrower_hint IS DISTINCT FROM $7
                  AND (ci.borrower_hint IS NULL OR ci.borrower_hint = ANY($8::text[]) OR ci.borrower_hint = t.borrower_hint)))`,
        [llcId, code, want.label, want.borrowerLabel, okLabels, okBorrower, want.hint, okHints]);
      updated += u.rowCount || 0;
    }
    return { updated };
  } catch (_) {
    // Wording is cosmetic next to the entity itself existing. Never block a create.
    return { updated: 0, failed: true };
  }
}

/**
 * RECORD WHAT KIND OF COMPANY THIS IS, WHEN A HUMAN ACTUALLY SAYS SO.
 *
 * Owner-directed 2026-08-09: *"everything created till now should automatically
 * be default LLC, only going forward this change to go in effect."* db/494 did
 * that — every entity on file is stamped `llc`, `entity_type_confirmed = false`
 * — and this is the other half: the moment a person picks a type on any door,
 * the ASSUMPTION becomes a STATEMENT.
 *
 * THREE GUARDS, each closing a way this could do harm:
 *   · it only ever writes an UNCONFIRMED entity. A type somebody already chose
 *     is never overwritten by a different door (an application form typed months
 *     later must not silently re-type the entity the closer settled).
 *   · it never touches a VERIFIED entity. Its documents have been read and
 *     accepted by a human, so its type is settled by evidence, not by a dropdown
 *     — and a mis-click on a re-used name must not relabel a finished entity's
 *     document slots.
 *   · an unrecognised value states NOTHING. A typo reads as an unanswered
 *     question, never as a confident answer.
 *
 * Re-labels the entity's document slots to match, because a corporation is asked
 * for bylaws and a stock certificate rather than an operating agreement. Never
 * throws — recording the type must not be able to fail a create.
 */
async function confirmEntityType(llcId, type, opts = {}) {
  const ET = require('./entity-type');
  const client = opts.client || db;
  try {
    if (!llcId || !ET.isRecognized(type)) return { changed: false, reason: 'not_stated' };
    const key = ET.normalizeKey(type);
    const r = await client.query(
      `UPDATE llcs
          SET entity_type = $2, entity_type_confirmed = true,
              entity_type_set_at = now(), entity_type_set_by = $3, updated_at = now()
        WHERE id = $1 AND entity_type_confirmed = false AND is_verified = false
        RETURNING entity_type`,
      [llcId, key, opts.staffId || null]);
    if (!r.rows[0]) return { changed: false, reason: 'already_confirmed_or_verified' };
    await applyEntitySlotWording(llcId, client);
    return { changed: true, entityType: key };
  } catch (_) {
    return { changed: false, reason: 'failed' };
  }
}

/**
 * WHICH OWNERS OF THIS ENTITY HAVE NO TITLE YET — the closing desk's question.
 *
 * Owner-directed 2026-08-09: *"it should only be for the staff side to fill out;
 * when the closer gets the closing desk, if it's not filled yet they should tell
 * her that she needs to fill it."* A title prints under the signature line on
 * every recorded instrument, so a closing package cannot be drafted without one.
 *
 * Reads BOTH owner tables, because PILOT splits owners in two — `llc_borrowers`
 * is the owners who are our borrowers, `llc_members` is everybody else — and a
 * loan document does not care about that distinction: it lists every owner with
 * their title. An ENTITY member is skipped: a holding company has no title, it
 * signs through its own people, who are recorded on its own row.
 *
 * Never throws; an unreadable entity reports nothing outstanding rather than
 * inventing a blocker.
 */
async function ownersMissingTitles(llcId, client = db) {
  if (!llcId) return [];
  try {
    const r = await client.query(
      `SELECT name FROM (
          SELECT NULLIF(TRIM(COALESCE(b.first_name,'') || ' ' || COALESCE(b.last_name,'')), '') AS name,
                 lb.member_title AS title
            FROM llc_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id
           WHERE lb.llc_id = $1
          UNION ALL
          SELECT m.full_name AS name, m.member_title AS title
            FROM llc_members m
           WHERE m.llc_id = $1 AND COALESCE(m.member_kind,'person') <> 'entity'
        ) o
        WHERE COALESCE(TRIM(o.title), '') = ''
        ORDER BY name`, [llcId]);
    return r.rows.map((x) => x.name).filter(Boolean);
  } catch (_) { return []; }
}

// Normalize an EIN to XX-XXXXXXX. Returns {ein} (null for blank) or {error}.
function normalizeEin(raw) {
  if (raw === undefined) return { ein: undefined };
  const s = String(raw || '').trim();
  if (!s) return { ein: null };
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length !== 9 || !/^\d{2}-?\d{7}$/.test(s.replace(/\s/g, '')))
    return { error: 'EIN must be 9 digits (XX-XXXXXXX)' };
  return { ein: `${digits.slice(0, 2)}-${digits.slice(2)}` };
}

// Find one of this borrower's entities by NORMALIZED name (case- and
// whitespace-insensitive, same key as uq_llcs_borrower_name). Returns the id or
// null. The one place this predicate lives, so every create path agrees.
// `client` is optional and defaults to the pool — a caller inside a transaction
// (the entity-adoption path) passes its own so the lookup sees its own writes.
async function findLlcByName(borrowerId, name, client = db) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const r = await client.query(
    `SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`,
    [borrowerId, nm]);
  return r.rows[0] ? r.rows[0].id : null;
}

// THE chokepoint for "creating" an entity from anywhere (borrower/staff entity
// screens, a new application, a new file, a name typed on a track record, a
// ClickUp task). A name the borrower ALREADY has is REUSED — never duplicated
// and never rejected — so whatever context triggered the create links that one
// existing entity and inherits its details, documents and verification. The
// existing entity is returned untouched (it is edited only through the entity
// screen, never silently overwritten by a re-create). Returns { id, existed }.
// Callers should skip member/checklist setup and any data overwrite when
// existed === true, and link the returned id into their file/application.
async function findOrCreateLlc(borrowerId, fields, client = db) {
  const name = String((fields && fields.llcName) || '').trim();
  if (!name) throw new Error('llcName required');
  const existingId = await findLlcByName(borrowerId, name, client);
  if (existingId) return { id: existingId, existed: true };
  /* WHAT KIND OF COMPANY IS THIS (owner-directed 2026-08-09).
     A type the caller states is RECORDED AS CHOSEN; anything else falls back to
     LLC and is recorded as NOT confirmed. That distinction is the whole point:
     "we assumed" and "a person chose" are different facts, and only one of them
     is safe to print on a mortgage. `isRecognized` is what keeps a typo out —
     an unreadable type reads as an unanswered question, never as an LLC that
     somebody vouched for. src/lib/entity-type.js owns the rules. */
  const ET = require('./entity-type');
  const stated = fields && fields.entityType;
  const confirmed = ET.isRecognized(stated);
  const entityType = confirmed ? ET.normalizeKey(stated) : ET.DEFAULT_TYPE;
  try {
    const r = await client.query(
      `INSERT INTO llcs (borrower_id,llc_name,ein,formation_state,formation_date,ownership_pct,
                         entity_type,entity_type_confirmed,entity_type_set_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 THEN now() ELSE NULL END) RETURNING id`,
      [borrowerId, name, (fields.ein || null), (fields.formationState || null),
        require('./fields').normalizeTypedDate(fields.formationDate), (fields.ownershipPct || null),
        entityType, confirmed]);  // WO-6 (F-M11): year-0026-proof formation date
    return { id: r.rows[0].id, existed: false, entityType, entityTypeConfirmed: confirmed };
  } catch (e) {
    // Only reachable where uq_llcs_borrower_name exists: a concurrent create
    // won the race for the same name — reuse the winner instead of erroring.
    if (e && e.code === '23505') {
      const again = await findLlcByName(borrowerId, name, client);
      if (again) return { id: again, existed: true };
    }
    throw e;
  }
}

module.exports = {
  LLC_SLOT_CODES,
  MAX_ENTITY_DEPTH,
  getMembers,
  getSlots,
  getLlcBundle,
  completeness,
  missingForVerification,
  syncLlcConditions,
  parseMembers,
  replaceMembers,
  normalizeEin,
  findLlcByName,
  findOrCreateLlc,
  applyEntitySlotWording,
  confirmEntityType,
  ownersMissingTitles,
  shareCount,
  getOwnerLlcIds,
  getAncestorEntityIds,
  getDescendantEntityIds,
  ownershipLinkError,
};
