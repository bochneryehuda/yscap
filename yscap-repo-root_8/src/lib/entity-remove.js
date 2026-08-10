'use strict';
/**
 * REMOVING AN ENTITY FROM A BORROWER PROFILE (owner-directed 2026-08-10:
 * "Super-admin: remove entities from any borrower profile — to clean up ones
 * added by error").
 *
 * Until now there was NO way to take an entity off a profile: an LLC / corp /
 * trust attached to the wrong borrower, or a duplicate, stayed forever. This is
 * that tool, and it is deliberately built like borrower-merge — the most
 * destructive action in the app — because deleting an `llcs` row is nearly as
 * destructive:
 *
 *   documents.llc_id  ON DELETE CASCADE  → the entity's real documents vanish
 *   checklist_items.llc_id  ON DELETE CASCADE  → its document SLOTS vanish
 *   llc_members / llc_borrowers / llc_external_links  ON DELETE CASCADE
 *   applications.llc_id  ON DELETE SET NULL  → un-vests every loan file using it
 *   track_records.llc_id / satisfied_by_llc_id  ON DELETE SET NULL
 *   llc_members.owner_llc_id  ON DELETE SET NULL  → a layered entity is unhooked
 *
 * SAFETY, the same doctrine borrower-merge follows:
 *   • it runs in ONE transaction; any failure leaves the entity exactly as it was;
 *   • the WHOLE entity is SNAPSHOTTED into `entity_removals` first (row + members
 *     + slots + the metadata of its documents + the files/track-records that
 *     referenced it), so nothing is unrecoverable;
 *   • it is gated on `super_admin` + a typed reason (the caller enforces the role;
 *     this module refuses without a reason);
 *   • the DATABASE'S own CASCADE / SET NULL rules do the referential cleanup — we
 *     never hand-delete a child table (that is how borrower-merge once deleted a
 *     real row with a "clever" generic query; here Postgres owns it).
 *
 * TWO shapes, decided by whether anyone else owns the entity:
 *   • the borrower is the entity's ONLY owner        → DELETE the entity;
 *   • the entity has OTHER owners (llc_borrowers)     → TRANSFER: move the primary
 *     pointer to a remaining owner and drop this borrower's link. The entity —
 *     and every document and vesting it carries — survives; it just leaves THIS
 *     profile. (The profile's Entities tab lists entities by llcs.borrower_id, so
 *     re-pointing that column is exactly "remove it from this profile".)
 *
 * Nothing here is borrower-facing and nothing touches a frozen pricing number.
 */
const db = require('../db');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// A loan file whose status is one of these is over; un-vesting it is far less
// consequential than un-vesting a live deal, so the preview does not shout about it.
const TERMINAL_STATUSES = new Set(['funded', 'declined', 'withdrawn', 'cancelled']);

/** Load the entity as it sits on this profile, or throw a clean 404/400. */
async function loadOnProfile(borrowerId, llcId, client = db) {
  if (!borrowerId || !llcId) throw httpError(400, 'a borrower and an entity are required');
  const row = (await client.query(
    `SELECT id, borrower_id, llc_name, entity_type, is_verified FROM llcs WHERE id=$1`, [llcId])).rows[0];
  if (!row) throw httpError(404, 'that entity no longer exists');
  // The profile only ever SHOWS entities whose primary pointer is this borrower
  // (GET /borrowers/:id/llcs filters on llcs.borrower_id), so "remove it from
  // THIS profile" is only meaningful for those. Refuse otherwise rather than
  // silently act on an entity the profile does not display.
  if (String(row.borrower_id) !== String(borrowerId)) {
    throw httpError(409, 'that entity is not on this borrower\'s profile');
  }
  return row;
}

/** The other borrowers who own this entity via llc_borrowers (never this one). */
async function otherOwners(llcId, borrowerId, client = db) {
  const r = await client.query(
    `SELECT lb.borrower_id,
            NULLIF(TRIM(COALESCE(b.first_name,'')||' '||COALESCE(b.last_name,'')),'') AS name
       FROM llc_borrowers lb
       JOIN borrowers b ON b.id = lb.borrower_id
      WHERE lb.llc_id = $1 AND lb.borrower_id <> $2
      ORDER BY lb.created_at NULLS LAST, b.last_name, b.first_name`, [llcId, borrowerId]);
  return r.rows;
}

/**
 * What removing this entity would do, so the confirm can state the consequences
 * BEFORE anyone commits. Never throws for a readable entity; the caller has
 * already proven access.
 */
async function previewRemoval(borrowerId, llcId, client = db) {
  const entity = await loadOnProfile(borrowerId, llcId, client);
  const others = await otherOwners(llcId, borrowerId, client);
  const action = others.length ? 'transferred' : 'deleted';

  // Files that vest to this entity — un-vested only on a DELETE (a transfer keeps
  // the entity, so its vesting is untouched). Live files are the loud ones.
  const vesting = (await client.query(
    `SELECT id, ys_loan_number, status, property_address FROM applications
      WHERE llc_id=$1 AND deleted_at IS NULL ORDER BY created_at`, [llcId])).rows
    .map((a) => ({
      id: a.id,
      loanNumber: a.ys_loan_number || null,
      address: (a.property_address && (a.property_address.oneLine || a.property_address.formatted_address)) || null,
      status: a.status,
      live: !TERMINAL_STATUSES.has(String(a.status || '')),
    }));

  const docCount = Number((await client.query(
    `SELECT count(*)::int n FROM documents WHERE llc_id=$1 AND COALESCE(is_current,true)=true`, [llcId])).rows[0].n);
  const trackRecords = Number((await client.query(
    `SELECT count(*)::int n FROM track_records WHERE llc_id=$1`, [llcId])).rows[0].n);

  const warnings = [];
  if (entity.is_verified) warnings.push({ code: 'verified', message: 'This entity has been verified.' });
  const liveVesting = vesting.filter((v) => v.live);
  if (action === 'deleted' && liveVesting.length) {
    warnings.push({
      code: 'vesting_live',
      message: `It is the vesting entity on ${liveVesting.length} active loan file${liveVesting.length === 1 ? '' : 's'} — removing it will take the entity off ${liveVesting.length === 1 ? 'that file' : 'those files'}.`,
      files: liveVesting,
    });
  }
  if (action === 'deleted' && docCount) {
    warnings.push({ code: 'documents', message: `${docCount} document${docCount === 1 ? '' : 's'} filed on this entity will be removed with it.` });
  }
  if (action === 'deleted' && trackRecords) {
    warnings.push({ code: 'track_records', message: `${trackRecords} track-record line${trackRecords === 1 ? '' : 's'} recorded under this entity will be unlinked from it.` });
  }

  return {
    found: true,
    action,
    entity: { id: entity.id, name: entity.llc_name, entityType: entity.entity_type, verified: !!entity.is_verified },
    transferTo: action === 'transferred' ? { id: others[0].borrower_id, name: others[0].name } : null,
    vesting,
    docCount,
    trackRecords,
    warnings,
  };
}

/** Everything about the entity we want recoverable, captured before the delete. */
async function snapshotEntity(llcId, client) {
  const entity = (await client.query(`SELECT * FROM llcs WHERE id=$1`, [llcId])).rows[0];
  const members = (await client.query(`SELECT * FROM llc_members WHERE llc_id=$1`, [llcId])).rows;
  const owners = (await client.query(`SELECT * FROM llc_borrowers WHERE llc_id=$1`, [llcId])).rows;
  const slots = (await client.query(
    `SELECT id, template_id, label, status FROM checklist_items WHERE llc_id=$1`, [llcId])).rows;
  const documents = (await client.query(
    `SELECT id, filename, doc_kind, checklist_item_id, review_status, is_current, created_at
       FROM documents WHERE llc_id=$1`, [llcId])).rows;
  const externalLinks = (await client.query(
    `SELECT * FROM llc_external_links WHERE llc_id=$1`, [llcId])).rows;
  return { entity, members, owners, slots, documents, externalLinks };
}

/**
 * Remove the entity from the profile. `reason` is required. `actorId` is the
 * super-admin (the ROLE is enforced by the route). Returns what happened.
 * One transaction; any failure rolls back and leaves the entity untouched.
 */
async function removeEntity({ borrowerId, llcId, actorId = null, reason }) {
  const why = String(reason == null ? '' : reason).trim();
  if (!why) throw httpError(400, 'a reason is required to remove an entity');

  const client = await db.pool.connect();
  const affectedAppIds = [];
  try {
    await client.query('BEGIN');
    // Lock the entity row so two removals of the same entity can't interleave.
    const entity = (await client.query(`SELECT * FROM llcs WHERE id=$1 FOR UPDATE`, [llcId])).rows[0];
    if (!entity) throw httpError(404, 'that entity no longer exists');
    if (String(entity.borrower_id) !== String(borrowerId)) {
      throw httpError(409, 'that entity is not on this borrower\'s profile');
    }

    const others = await otherOwners(llcId, borrowerId, client);
    const snapshot = await snapshotEntity(llcId, client);
    // Files that vest to it — recorded for the affected block AND (on delete) for
    // the after-commit condition re-sync.
    const vestingApps = (await client.query(
      `SELECT id, ys_loan_number, status FROM applications WHERE llc_id=$1 AND deleted_at IS NULL`, [llcId])).rows;
    const trackRecordRows = (await client.query(
      `SELECT id, property_address FROM track_records WHERE llc_id=$1`, [llcId])).rows;

    const affected = {
      vestingApplications: vestingApps.map((a) => ({ id: a.id, loanNumber: a.ys_loan_number || null, status: a.status })),
      trackRecords: trackRecordRows.map((t) => ({ id: t.id })),
      documentCount: snapshot.documents.length,
      slotCount: snapshot.slots.length,
      memberCount: snapshot.members.length,
    };

    let action;
    let transferredTo = null;
    if (others.length) {
      // TRANSFER — the entity has other owners, so it stays. Move the primary
      // pointer to a remaining owner and drop this borrower's ownership link.
      // The entity, its documents and its vesting are all preserved; it simply
      // leaves this profile.
      action = 'transferred';
      transferredTo = others[0].borrower_id;
      await client.query(`UPDATE llcs SET borrower_id=$1, updated_at=now() WHERE id=$2`, [transferredTo, llcId]);
      await client.query(`DELETE FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`, [llcId, borrowerId]);
    } else {
      // DELETE — the borrower is the only owner. The database's CASCADE / SET NULL
      // rules clean up every child (slots, members, links) and un-vest every file
      // and track record. We record which files were un-vested so their conditions
      // can be re-synced AFTER the commit.
      action = 'deleted';
      for (const a of vestingApps) affectedAppIds.push(a.id);
      await client.query(`DELETE FROM llcs WHERE id=$1`, [llcId]);
    }

    await client.query(
      `INSERT INTO entity_removals
         (llc_id, borrower_id, entity_name, action, transferred_to, reason, entity_snapshot, affected, removed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [llcId, borrowerId, entity.llc_name || null, action, transferredTo, why,
        JSON.stringify(snapshot), JSON.stringify(affected), actorId]);

    await client.query('COMMIT');
    return { ok: true, action, entityName: entity.llc_name || null, transferredTo, affected, affectedAppIds };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { previewRemoval, removeEntity, _internals: { loadOnProfile, otherOwners, snapshotEntity } };
