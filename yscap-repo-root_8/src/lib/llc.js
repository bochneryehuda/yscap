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

/* The members of an LLC (the borrower's own stake lives on llcs.ownership_pct). */
async function getMembers(llcId) {
  const r = await db.query(
    `SELECT id, full_name, ownership_pct, email, phone
       FROM llc_members WHERE llc_id=$1 ORDER BY created_at`, [llcId]);
  return r.rows;
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
  return { ...llc, members, slots, completeness: completeness(llc, members, slots) };
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
  const rejected = slots.some((s) => s.document_id && s.review_status === 'rejected');
  const allIn = required.length >= LLC_SLOT_CODES.length && uploaded >= required.length;

  const target = llc.is_verified ? 'satisfied' : rejected ? 'issue' : allIn ? 'received' : 'outstanding';
  // '[auto]'-prefixed notes are ours to overwrite; a note a staffer typed by
  // hand is never clobbered by a sync.
  const note = llc.is_verified
    ? `[auto] Verified LLC "${llc.llc_name}" on file — condition satisfied`
    : rejected ? `[auto] An LLC document for "${llc.llc_name}" was rejected — see the borrower profile`
    : allIn ? `[auto] LLC "${llc.llc_name}" documents uploaded — awaiting review`
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
}

// ---------------- entity-detail validators (shared write path) ----------------
// One source of truth for the borrower AND staff LLC write endpoints, so the
// same rules (member shape, ownership ceiling, EIN normalization) apply no
// matter which portal made the edit.

// Validate a members payload: [{fullName, ownershipPct, email?, phone?}].
// Returns {members, error}. Completion to exactly 100% is a VERIFICATION
// requirement, not a save requirement — partial saves are allowed, but the
// total (borrower + members) may never exceed 100%.
function parseMembers(raw, borrowerPct) {
  if (raw === undefined) return { members: undefined };
  if (!Array.isArray(raw)) return { error: 'members must be an array' };
  if (raw.length > 20) return { error: 'a maximum of 20 members is supported' };
  const members = [];
  for (const m of raw) {
    const fullName = String((m && m.fullName) || '').trim().slice(0, 160);
    const p = Number(m && m.ownershipPct);
    if (!fullName) return { error: 'each member needs a full name' };
    if (!isFinite(p) || p <= 0 || p >= 100) return { error: 'each member needs an ownership % between 0 and 100' };
    members.push({
      fullName, ownershipPct: Math.round(p * 100) / 100,
      email: m.email ? String(m.email).trim().slice(0, 160) : null,
      phone: m.phone ? String(m.phone).trim().slice(0, 40) : null,
    });
  }
  const own = borrowerPct == null ? 0 : Number(borrowerPct) || 0;
  const total = own + members.reduce((s, m) => s + m.ownershipPct, 0);
  if (total > 100.01) return { error: `ownership exceeds 100% (${total.toFixed(2)}%)` };
  return { members };
}

async function replaceMembers(llcId, members) {
  await db.query(`DELETE FROM llc_members WHERE llc_id=$1`, [llcId]);
  for (const m of members) {
    await db.query(
      `INSERT INTO llc_members (llc_id, full_name, ownership_pct, email, phone) VALUES ($1,$2,$3,$4,$5)`,
      [llcId, m.fullName, m.ownershipPct, m.email, m.phone]);
  }
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

module.exports = {
  LLC_SLOT_CODES,
  getMembers,
  getSlots,
  getLlcBundle,
  completeness,
  missingForVerification,
  syncLlcConditions,
  parseMembers,
  replaceMembers,
  normalizeEin,
};
