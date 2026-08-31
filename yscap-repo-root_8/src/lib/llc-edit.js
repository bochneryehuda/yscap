'use strict';
/**
 * EDITING AN ENTITY — the rules, in ONE place, for both products.
 *
 * `llc.js` has always held what an entity IS: its members, its slots, its
 * completeness, what a corporation is asked for that an LLC is not. What lived
 * nowhere shared was what happens when somebody CHANGES one — the verified lock,
 * the ownership arithmetic, the authority to verify, the reason a revocation
 * needs, and the bottom-up chain revoke. All of it sat INLINE in three
 * `routes/staff.js` handlers.
 *
 * ── WHY IT MOVED (owner-directed 2026-08-31) ────────────────────────────────
 *
 * *"I think you're missing the entire entity section that we were officially
 * needing to bring in from the RTL side. The logic should work the same … the
 * exact verification workflow … Bring in the entire logic, just giving you
 * authorization to share the code. Don't reinvent."*
 *
 * The Long-Term side cannot import an RTL route, so the only two ways to give it
 * "the exact verification workflow" are to COPY those rules or to EXTRACT them.
 * A copy of "may this be verified, and by whom" is the worst possible thing to
 * have two of: the two would agree on the day they were written and the one that
 * drifted would be the one that let an unverified entity onto a loan. So they
 * are extracted, and both products call THIS.
 *
 * ── WHAT IS SHARED AND WHAT IS DELIBERATELY NOT ─────────────────────────────
 *
 * Shared: every rule about the ENTITY, which is the borrower's and belongs to
 * neither product (`llcs` hangs off `borrowers`, the identity zone — the same
 * reasoning that authorized `service_contacts`).
 *
 * NOT shared, and passed in as hooks: WHO MAY REACH this entity (each product
 * scopes its own way), the CONDITION each product syncs afterwards (`rtl_p1_llc`
 * against `applications`, `lt_vesting_entity` against `lt_loans` — two different
 * tables, two different template codes), the AUDIT row, and the borrower
 * NOTIFICATION. A hook that is not supplied simply does not run, so a caller can
 * never accidentally inherit the other product's side effects.
 *
 * ── THE SHAPE OF AN ANSWER ──────────────────────────────────────────────────
 *
 * `{ok:true, ...}` or `{ok:false, status, error}` — a REFUSAL IN WORDS with the
 * HTTP status the caller should use, never a throw. Both products' doors then
 * read the same, and a refusal a person can act on cannot be lost in a catch.
 */

const db = require('../db');
const llcLib = require('./llc');

/** Nothing here ever runs a hook that was not supplied, and a hook that throws
    never fails the edit — the entity is already written by then, and a failed
    notification must not report a successful save as an error. */
async function run(hook, ...args) {
  if (typeof hook !== 'function') return null;
  try { return await hook(...args); } catch (_) { return null; }
}

/** The entity row every operation starts from, or null. */
async function loadEntity(llcId, client) {
  const { rows } = await (client || db).query(
    `SELECT id, borrower_id, llc_name, is_verified, ownership_pct, entity_type, entity_subtype
       FROM llcs WHERE id = $1`, [llcId]);
  return rows[0] || null;
}

/**
 * CHANGE THE ENTITY'S OWN DETAILS.
 *
 * `ctx` — { actorId, client?, audit?(action, detail), afterConditions?() }
 */
async function updateDetails(llcId, body, ctx = {}) {
  const client = ctx.client || db;
  const row = await loadEntity(llcId, client);
  if (!row) return { ok: false, status: 404, error: 'not found' };
  /* THE VERIFIED LOCK. A verified entity's papers have been READ by a person and
     its condition is signed off on every file that vests in it; letting the name
     or the ownership move underneath that would leave the sign-off standing on
     something nobody checked. Revoking first is one click and is recorded. */
  if (row.is_verified) {
    return { ok: false, status: 409, error: 'this LLC is verified — revoke verification before making changes' };
  }

  const b = body && typeof body === 'object' ? { ...body } : {};
  if (b.ein !== undefined) {
    const ein = llcLib.normalizeEin(b.ein);
    if (ein.error) return { ok: false, status: 400, error: ein.error };
    b.ein = ein.ein === null ? '' : ein.ein;
  }
  if (b.llcName !== undefined && !String(b.llcName).trim()) {
    return { ok: false, status: 400, error: 'llcName cannot be empty' };
  }

  const sets = []; const vals = []; let i = 1;
  const map = {
    llcName: 'llc_name', ein: 'ein', formationState: 'formation_state',
    formationDate: 'formation_date', ownershipPct: 'ownership_pct',
  };

  /* WHAT KIND OF COMPANY THIS IS. Not in the column map: recording a type is
     three columns PLUS a re-label of the entity's document slots — a corporation
     is asked for bylaws and a stock certificate, never an operating agreement. A
     value we cannot read is REFUSED rather than silently dropped. */
  let entityTypeChanged = false;
  if (b.entityType !== undefined && String(b.entityType || '').trim()) {
    const ET = require('./entity-type');
    if (!ET.isRecognized(b.entityType)) {
      return { ok: false, status: 400, error: `Pick one of: ${ET.TYPES.map((t) => t.label).join(', ')}.` };
    }
    /* The sub-kind is normalized AGAINST the type being saved, so switching a
       trust to an LLC cannot leave "revocable" behind on a type that has no
       sub-kind — and an explicit blank CLEARS it, because "I picked the wrong
       one" has to be undoable. */
    const sub = ET.normalizeSubtype(ET.normalizeKey(b.entityType), b.entitySubtype) || null;
    await client.query(
      `UPDATE llcs SET entity_type=$2, entity_type_confirmed=true, entity_type_set_at=now(),
                       entity_type_set_by=$3, entity_subtype=$4, updated_at=now()
        WHERE id=$1 AND is_verified=false`,
      [llcId, ET.normalizeKey(b.entityType), ctx.actorId || null, sub]);
    try { await llcLib.applyEntitySlotWording(llcId); } catch (_) { /* wording is cosmetic */ }
    await run(ctx.audit, 'set_entity_type', { entityType: ET.normalizeKey(b.entityType), entitySubtype: sub });
    entityTypeChanged = true;
  }

  // A mid-typed formation date must never persist as year 0026.
  if (b.formationDate !== undefined) b.formationDate = require('./fields').normalizeTypedDate(b.formationDate);
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); }
  }
  if (!sets.length) {
    return entityTypeChanged ? { ok: true } : { ok: false, status: 400, error: 'nothing to update' };
  }

  /* OWNERSHIP CANNOT EXCEED THE WHOLE COMPANY. Checked against the members
     already recorded, so the refusal can say which side to fix. */
  if (b.ownershipPct !== undefined && b.ownershipPct !== '' && b.ownershipPct != null) {
    const p = Number(b.ownershipPct);
    if (!isFinite(p) || p < 0 || p > 100) {
      return { ok: false, status: 400, error: 'ownership % must be between 0 and 100' };
    }
    const mem = await client.query(
      `SELECT COALESCE(sum(ownership_pct),0) AS s FROM llc_members WHERE llc_id=$1`, [llcId]);
    const total = p + Number(mem.rows[0].s);
    if (total > 100.01) {
      return {
        ok: false,
        status: 400,
        error: `ownership exceeds 100% (${total.toFixed(2)}% with the other members) — adjust the members first`,
      };
    }
  }

  sets.push('updated_at=now()'); vals.push(llcId);
  await client.query(`UPDATE llcs SET ${sets.join(',')} WHERE id=$${i}`, vals);
  await run(ctx.audit, 'update_llc', null);
  return { ok: true };
}

/**
 * REPLACE THE OTHER OWNERS.
 *
 * `allowOwnerDetails` is the STAFF half — the title on the signature line, and
 * for a corporation the share count and certificate number. A borrower's own
 * editor never renders those, so its caller passes false and the keys are
 * IGNORED rather than refused: answering a borrower with an error about a box
 * they cannot see is a dead end.
 */
async function saveMembers(llcId, members, ctx = {}) {
  const client = ctx.client || db;
  const row = await loadEntity(llcId, client);
  if (!row) return { ok: false, status: 404, error: 'not found' };
  if (row.is_verified) {
    return { ok: false, status: 409, error: 'this LLC is verified — revoke verification before making changes' };
  }

  const parsed = llcLib.parseMembers(members || [], row.ownership_pct, {
    allowOwnerDetails: ctx.allowOwnerDetails !== false,
    entityType: row.entity_type,
  });
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };

  try {
    await llcLib.replaceMembers(llcId, parsed.members || [], { borrowerId: row.borrower_id });
  } catch (e) {
    return { ok: false, status: e.status || 500, error: e.status ? e.message : 'could not save the members' };
  }
  // Ownership feeds the entity condition (chain-aware) — recompute right away.
  await run(ctx.syncConditions, llcId, {});
  await run(ctx.audit, 'update_llc_members', { count: (parsed.members || []).length });
  return { ok: true, count: (parsed.members || []).length };
}

/**
 * VERIFY — OR REVOKE VERIFICATION OF — AN ENTITY.
 *
 * VERIFYING IS A SIGN-OFF, and that is why it takes an authority. It satisfies
 * the entity condition on every file that vests in this company, so it is the
 * processor's call and never a loan officer's. REVOKING is a "send it back" any
 * reviewer may do — and it reopens the borrower's condition, so it REQUIRES a
 * reason the borrower is shown.
 *
 * A REVOKE WALKS THE CHAIN DOWNWARD. Layered entities verify bottom-up, so a
 * revoked owner invalidates every verified entity it (transitively) owns. Without
 * this the invariant breaks silently: a verified child would sit on an unverified
 * owner and its file condition would stay signed off.
 */
async function setVerified(llcId, opts = {}, ctx = {}) {
  const client = ctx.client || db;
  const row = await loadEntity(llcId, client);
  if (!row) return { ok: false, status: 404, error: 'not found' };

  const verified = opts.verified !== false;          // default true (back-compatible)
  if (verified && ctx.maySignOff === false) {
    return {
      ok: false,
      status: 403,
      error: 'Only a processor can verify an LLC — verifying signs off the entity condition. Reject a document or raise an issue instead.',
    };
  }
  if (!verified && !String(opts.reason || '').trim()) {
    return { ok: false, status: 400, error: 'a reason is required to revoke verification — the borrower is told why' };
  }

  if (verified) {
    const bundle = await llcLib.getLlcBundle(llcId);
    const missing = llcLib.missingForVerification(bundle, bundle.members, bundle.slots);
    if (missing.length) return { ok: false, status: 409, error: 'this LLC is not ready to verify', missing };
    await client.query(
      `UPDATE llcs SET is_verified=true, verified_at=now(), verified_by=$2, updated_at=now() WHERE id=$1`,
      [llcId, ctx.actorId || null]);
    await run(ctx.syncConditions, llcId, { verifiedBy: ctx.actorId || null });
    await run(ctx.audit, 'verify_llc', null);
    await run(ctx.notifyBorrower, {
      kind: 'verified', borrowerId: row.borrower_id, entityName: row.llc_name, revokedChildren: [],
    });
    return { ok: true, verified: true };
  }

  const reason = String(opts.reason || '').trim().slice(0, 500);
  await client.query(
    `UPDATE llcs SET is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now() WHERE id=$1`,
    [llcId]);
  await run(ctx.syncConditions, llcId, { reopen: true });
  await run(ctx.audit, 'unverify_llc', reason ? { reason } : null);

  const revokedChildren = [];
  try {
    for (const childId of await llcLib.getDescendantEntityIds(llcId)) {
      const c = (await client.query(
        `SELECT id, llc_name, is_verified FROM llcs WHERE id=$1`, [childId])).rows[0];
      if (!c || !c.is_verified) continue;
      await client.query(
        `UPDATE llcs SET is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now() WHERE id=$1`,
        [childId]);
      await run(ctx.syncConditions, childId, { reopen: true });
      await run(ctx.audit, 'unverify_llc', { reason: `owning entity "${row.llc_name}" verification was revoked` }, childId);
      revokedChildren.push(c.llc_name);
    }
  } catch (e) {
    console.warn('[llc-revoke] chain revoke failed:', (e && e.message) || e);
  }

  await run(ctx.notifyBorrower, {
    kind: 'unverified', borrowerId: row.borrower_id, entityName: row.llc_name, reason, revokedChildren,
  });
  return { ok: true, verified: false, revokedChildren };
}

/**
 * MAY THIS ENTITY'S DOCUMENTS BE CHANGED RIGHT NOW?
 *
 * A VERIFIED entity's papers have been read and accepted, so replacing one of
 * them behind the verification would leave a company marked "checked" against
 * documents nobody checked. Revoking is the recorded way through, and it is one
 * click — `setVerified({ verified:false, reason })` above.
 *
 * IT LIVES HERE BECAUSE IT WAS WRITTEN TWICE. Both short-term upload doors (the
 * entity library's own, and the file screen's entity-slot path) carried the same
 * sentence inline, and the long-term doors had it nowhere at all — so the same
 * upload was refused on one product and accepted on the other. Every door now
 * asks this, and the answer moves for all of them at once.
 *
 * FAILS CLOSED on an unreadable entity: refusing an upload costs a retry, while
 * accepting one against an entity we could not read can quietly replace the
 * evidence a verification stands on. An entity that does not exist is a 404, so
 * a caller naming a company that is not there is told so rather than being told
 * it is verified.
 */
const VERIFIED_DOC_LOCK = 'this LLC is verified \u2014 revoke verification before replacing its documents';

/**
 * THE PURE HALF, for a door that has ALREADY read the entity row.
 *
 * Both short-term doors read the row first for their OWN reasons — one to check
 * the staffer may see that borrower, the other to check the entity belongs to
 * this file's borrower — and the ORDER of those refusals is load-bearing: a
 * caller must be told "not yours" before ever being told "that one is verified",
 * or the lock itself becomes a way to learn which companies exist. So they keep
 * their read and their order, and ask this about the row they already hold.
 */
function documentLockFor(row) {
  if (!row) return { ok: false, status: 404, error: 'entity not found' };
  if (row.is_verified) return { ok: false, status: 409, error: VERIFIED_DOC_LOCK };
  return { ok: true, entity: row };
}

/** The loading half, for a door with no row in hand. */
async function documentLock(llcId, client) {
  let row;
  try {
    row = await loadEntity(llcId, client);
  } catch (_) {
    return {
      ok: false,
      status: 503,
      error: 'PILOT could not read that company just now. Try again in a moment.',
    };
  }
  return documentLockFor(row);
}

module.exports = {
  updateDetails, saveMembers, setVerified, documentLock, documentLockFor, VERIFIED_DOC_LOCK,
  _internals: { loadEntity, run },
};
