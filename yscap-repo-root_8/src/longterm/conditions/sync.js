'use strict';
/**
 * LONG-TERM — the Condition Center's READ-ONLY sync.
 *
 * Fills the db/574 mirror from Encompass: the conditions on a loan, the eFolder
 * documents, their attachments (METADATA ONLY — the paper stays in Encompass),
 * and the inverted document->condition link.
 *
 * ENCOMPASS IS NEVER WRITTEN. Every call here goes through the read-only client,
 * which refuses any method other than GET on the paths it allows; the eFolder
 * UPLOAD is a separate, still-BLOCKED write governed by
 * docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md. Nothing in this module could perform it.
 *
 * IT DOES NOTHING UNTIL THE SETTING IS ON. `conditions.enabled` defaults to
 * false, so on every deployment as it stands this module reads nothing, writes
 * nothing and costs nothing — turning it on is what starts the mirror, exactly as
 * the deferral recorded (plan §5). The gate is checked HERE rather than only on
 * the screen: a screen-only gate would still let a boot sweep hammer a tenant
 * whose owner has switched the feature off.
 *
 * A FAILURE IS RECORDED ON THE LOAN, NEVER SWALLOWED. `conditions_sync_error` /
 * `documents_sync_error` hold the reason one loan could not be read and the pass
 * continues — one unreadable file must never stop the other six hundred, and a
 * sync that fails silently is worse than one that fails loudly.
 *
 * NOTHING IS EVER DELETED. A condition or document that has disappeared from
 * Encompass is marked `is_removed` and filtered on READ. Deleting it would
 * destroy the record of what was once asked for, which is exactly the history a
 * post-purchase condition list exists to keep.
 *
 * SEPARATION: reads and writes `lt_*` only.
 */

const mapper = require('./mapper');

const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
  get settings() { return require('../settings/store'); },
};

/** How many loans one pass will read. A loan is two HTTP calls, so this is the
 *  knob that decides what the sweep costs; discovery is not involved. */
const DEFAULT_READ_BUDGET = 20;

/** How long a mirrored loan stays fresh before the sweep asks again. */
const DEFAULT_REFRESH_HOURS = 12;

/**
 * How many condition THREADS one loan will read.
 *
 * The comments resource is one HTTP call PER CONDITION, and a delegated file here
 * carries up to 67 conditions — so this is the only part of the mirror whose cost
 * grows with the file rather than with the book. The cap is REPORTED, never
 * silent: "we read 40 threads and there are more" is the difference between a
 * sweep that is keeping up and one that never will.
 */
const DEFAULT_COMMENT_CAP = 40;

/**
 * Is the Condition Center switched on?
 *
 * FAILS CLOSED. An unreadable settings table answers "off" — with the feature
 * deferred, doing nothing is the correct behaviour under uncertainty, and the
 * opposite default would start reading a tenant because a query timed out.
 */
async function enabled() {
  try {
    const { settings } = await lazy.settings.load();
    return settings['conditions.enabled'] === true;
  } catch {
    return false;
  }
}

// ── Writing one loan's conditions ───────────────────────────────────────────

/**
 * Upsert one condition. Keyed on (loan, Encompass's own id) — never on the title,
 * which two conditions on one loan routinely share.
 */
async function upsertCondition(dbc, loanId, row, syncedAt) {
  const { rows } = await dbc.query(
    `INSERT INTO lt_conditions
       (id, loan_id, encompass_condition_id, condition_type, title,
        internal_description, external_description, category, prior_to,
        status, status_open, status_date, source, source_of_condition,
        print_definitions, application_ref, owner_role, assigned_to, recipient,
        days_to_receive, comments_count, internal_id, is_removed,
        encompass_created_by, encompass_created_at, encompass_modified_by,
        encompass_modified_at, raw, encompass_synced_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22,
             $23, $24, $25, $26, $27::jsonb, $28, now())
     ON CONFLICT (loan_id, encompass_condition_id) DO UPDATE SET
       condition_type       = EXCLUDED.condition_type,
       title                = EXCLUDED.title,
       internal_description = EXCLUDED.internal_description,
       external_description = EXCLUDED.external_description,
       category             = EXCLUDED.category,
       prior_to             = EXCLUDED.prior_to,
       status               = EXCLUDED.status,
       status_open          = EXCLUDED.status_open,
       status_date          = EXCLUDED.status_date,
       source               = EXCLUDED.source,
       source_of_condition  = EXCLUDED.source_of_condition,
       print_definitions    = EXCLUDED.print_definitions,
       application_ref      = EXCLUDED.application_ref,
       owner_role           = EXCLUDED.owner_role,
       assigned_to          = EXCLUDED.assigned_to,
       recipient            = EXCLUDED.recipient,
       days_to_receive      = EXCLUDED.days_to_receive,
       comments_count       = EXCLUDED.comments_count,
       internal_id          = EXCLUDED.internal_id,
       is_removed           = EXCLUDED.is_removed,
       encompass_created_by = EXCLUDED.encompass_created_by,
       encompass_created_at = EXCLUDED.encompass_created_at,
       encompass_modified_by = EXCLUDED.encompass_modified_by,
       encompass_modified_at = EXCLUDED.encompass_modified_at,
       raw                  = EXCLUDED.raw,
       encompass_synced_at  = EXCLUDED.encompass_synced_at,
       updated_at           = now()
     RETURNING id`,
    [loanId, row.encompassConditionId, row.conditionType, row.title,
      row.internalDescription, row.externalDescription, row.category, row.priorTo,
      row.status, row.statusOpen, row.statusDate, row.source, row.sourceOfCondition,
      row.printDefinitions === null ? null : JSON.stringify(row.printDefinitions),
      row.applicationRef, row.ownerRole, row.assignedTo, row.recipient,
      row.daysToReceive, row.commentsCount, row.internalId, row.isRemoved,
      row.encompassCreatedBy, row.encompassCreatedAt, row.encompassModifiedBy,
      row.encompassModifiedAt, row.raw === undefined ? null : JSON.stringify(row.raw),
      syncedAt],
  );
  return rows[0] ? rows[0].id : null;
}

/**
 * Mark every condition on this loan that Encompass no longer lists as removed.
 *
 * NOT a delete — see the module header. It is also skipped entirely when the read
 * returned NOTHING: an empty answer is far more likely a filter change or an
 * outage than every condition on the loan being withdrawn at once, and marking a
 * whole loan removed on a bad read is the kind of quiet damage nobody notices for
 * weeks. (The same reasoning `sync/loans.js` applies to an empty pipeline.)
 */
async function retireMissingConditions(dbc, loanId, keptIds, syncedAt) {
  if (!keptIds.length) return 0;
  const { rowCount } = await dbc.query(
    `UPDATE lt_conditions
        SET is_removed = true, encompass_synced_at = $3, updated_at = now()
      WHERE loan_id = $1
        AND NOT (encompass_condition_id = ANY($2::text[]))
        AND is_removed = false`,
    [loanId, keptIds, syncedAt],
  );
  return rowCount;
}

/**
 * Read + mirror one loan's conditions.
 *
 * Returns a plain report rather than throwing: the caller is a sweep over many
 * loans, and one loan's failure is data, not an exception.
 */
async function syncConditionsForLoan(loanId, loanGuid, opts = {}) {
  const client = opts.client || lazy.client;
  const syncedAt = opts.now || new Date();

  let payload;
  try {
    payload = await client.apiGet(`/encompass/v3/loans/${encodeURIComponent(loanGuid)}/conditions`);
  } catch (e) {
    await recordError(loanId, 'conditions', (e && e.message) || String(e));
    return { ok: false, reason: (e && e.message) || String(e) };
  }

  const read = mapper.readConditions(payload);
  const dbc = await lazy.db.getClient();
  try {
    await dbc.query('BEGIN');
    const kept = [];
    for (const row of read.rows) {
      await upsertCondition(dbc, loanId, row, syncedAt);
      kept.push(row.encompassConditionId);
    }
    const retired = await retireMissingConditions(dbc, loanId, kept, syncedAt);

    // A condition arriving AFTER the documents that answer it: point their links
    // at it now, rather than leaving them dangling until the next eFolder read.
    const resolved = await resolveLinks(dbc, loanId);

    await dbc.query(
      `UPDATE lt_loans SET conditions_synced_at = $2, conditions_sync_error = NULL WHERE id = $1`,
      [loanId, syncedAt],
    );
    await dbc.query('COMMIT');

    // THE THREADS COME AFTER THE COMMIT, and outside this connection. They are
    // one HTTP call per condition, so holding the transaction open across them
    // would pin a pooled connection for the length of a network round trip per
    // condition — and a comments outage would then roll back conditions that
    // read perfectly. Its failures are REPORTED beside the conditions instead.
    const comments = await syncCommentsForLoan(loanId, loanGuid, opts);

    return {
      ok: true, stored: read.rows.length, seen: read.seen, unreadable: read.unreadable,
      retired, resolved, comments,
    };
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch { /* the connection is going back either way */ }
    await recordError(loanId, 'conditions', (e && e.message) || String(e));
    return { ok: false, reason: (e && e.message) || String(e) };
  } finally {
    dbc.release();
  }
}

// ── Writing one condition's thread ──────────────────────────────────────────

/**
 * Upsert one comment on one condition.
 *
 * The unique index is PARTIAL (`WHERE encompass_comment_id IS NOT NULL`), and a
 * partial index cannot be inferred without repeating its predicate — so the
 * `ON CONFLICT` carries the same `WHERE`. Leaving it off is a 42P10 at runtime,
 * inside a catch, which reads as "the thread would not store" forever.
 */
async function upsertComment(dbc, conditionId, c, syncedAt) {
  await dbc.query(
    `INSERT INTO lt_condition_comments
       (id, condition_id, encompass_comment_id, body, author_name, author_id,
        commented_at, raw, encompass_synced_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (condition_id, encompass_comment_id) WHERE encompass_comment_id IS NOT NULL
     DO UPDATE SET
       body                = EXCLUDED.body,
       author_name         = EXCLUDED.author_name,
       author_id           = EXCLUDED.author_id,
       commented_at        = EXCLUDED.commented_at,
       raw                 = EXCLUDED.raw,
       encompass_synced_at = EXCLUDED.encompass_synced_at`,
    [conditionId, c.encompassCommentId, c.body, c.authorName, c.authorId,
      c.commentedAt, c.raw === undefined ? null : JSON.stringify(c.raw), syncedAt],
  );
}

/**
 * Read + mirror the THREADS on one loan's conditions.
 *
 * ONLY where Encompass's own `commentsCount` says there is something to read, so
 * a loan whose conditions have no comments costs ZERO extra calls — the count
 * rides on the condition itself, which we have already stored.
 *
 * IT NEVER FAILS THE LOAN. The conditions are committed before this runs; a
 * thread we could not read is COUNTED and reported beside them, because losing
 * the conditions over a comments outage would be the expensive direction.
 *
 * A COMMENT WITH NO ID IS COUNTED, NOT STORED — and that is deliberate. The
 * comment payload's exact shape is UNVERIFIED against the live tenant (the
 * endpoint is verified; its fields are not). The unique index only covers a
 * non-null id, so an id-less comment could not be de-duplicated and would insert
 * a fresh copy of the same sentence on every pass. The alternatives are worse:
 * synthesising an identity puts a value we invented in a column that says it came
 * from Encompass, and delete-then-reinsert breaks this module's own rule that
 * nothing is ever deleted. So it is reported as `unreadable`, and if the live
 * payload turns out to carry no ids that number climbs immediately and loudly —
 * which is what a verified shape then fixes.
 *
 * NOTHING IS RETIRED. A comment withdrawn in Encompass stays mirrored: the table
 * has no removal flag, and inventing one from an absence (a capped read, a failed
 * call) would mark a live thread deleted. The condition carries Encompass's OWN
 * count beside our thread, so a disagreement is visible rather than hidden.
 */
async function syncCommentsForLoan(loanId, loanGuid, opts = {}) {
  const client = opts.client || lazy.client;
  const syncedAt = opts.now || new Date();
  const asked = Number(opts.commentCap);
  const cap = Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : DEFAULT_COMMENT_CAP;

  let targets = [];
  const pick = await lazy.db.getClient();
  try {
    // cap + 1, so "there are more" is MEASURED rather than assumed from a full page.
    const { rows } = await pick.query(
      `SELECT id, encompass_condition_id
         FROM lt_conditions
        WHERE loan_id = $1::uuid
          AND is_removed = false
          AND comments_count > 0
        ORDER BY encompass_modified_at DESC NULLS LAST, encompass_created_at DESC NULLS LAST
        LIMIT $2`,
      [loanId, cap + 1],
    );
    targets = rows;
  } finally {
    pick.release();
  }

  const more = targets.length > cap;
  if (more) targets = targets.slice(0, cap);

  let read = 0;
  let stored = 0;
  let failed = 0;
  let unreadable = 0;

  for (const t of targets) {
    let payload;
    try {
      payload = await client.apiGet(
        `/encompass/v3/loans/${encodeURIComponent(loanGuid)}/conditions/${encodeURIComponent(t.encompass_condition_id)}/comments`,
      );
    } catch {
      failed += 1;
      continue;
    }

    const list = Array.isArray(payload)
      ? payload
      : (payload && Array.isArray(payload.comments) ? payload.comments : []);

    const dbc = await lazy.db.getClient();
    try {
      await dbc.query('BEGIN');
      for (const raw of list) {
        const c = mapper.readComment(raw);
        if (!c || !c.encompassCommentId) { unreadable += 1; continue; }
        await upsertComment(dbc, t.id, c, syncedAt);
        stored += 1;
      }
      await dbc.query('COMMIT');
      read += 1;
    } catch {
      try { await dbc.query('ROLLBACK'); } catch { /* the connection is going back either way */ }
      failed += 1;
    } finally {
      dbc.release();
    }
  }

  return { threads: targets.length, read, stored, failed, unreadable, more, cap };
}

// ── Writing one loan's eFolder ──────────────────────────────────────────────

async function upsertDocument(dbc, loanId, d, syncedAt) {
  const { rows } = await dbc.query(
    `INSERT INTO lt_documents
       (id, loan_id, encompass_document_id, title, title_with_index,
        application_ref, application_name, milestone_id, milestone_name, status,
        roles, web_center_allowed, tpo_allowed, third_party_allowed, is_protected,
        days_due, days_till_expire, attachment_count, is_removed,
        encompass_created_by, encompass_created_at, raw, encompass_synced_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, now())
     ON CONFLICT (loan_id, encompass_document_id) DO UPDATE SET
       title               = EXCLUDED.title,
       title_with_index    = EXCLUDED.title_with_index,
       application_ref     = EXCLUDED.application_ref,
       application_name    = EXCLUDED.application_name,
       milestone_id        = EXCLUDED.milestone_id,
       milestone_name      = EXCLUDED.milestone_name,
       status              = EXCLUDED.status,
       roles               = EXCLUDED.roles,
       web_center_allowed  = EXCLUDED.web_center_allowed,
       tpo_allowed         = EXCLUDED.tpo_allowed,
       third_party_allowed = EXCLUDED.third_party_allowed,
       is_protected        = EXCLUDED.is_protected,
       days_due            = EXCLUDED.days_due,
       days_till_expire    = EXCLUDED.days_till_expire,
       attachment_count    = EXCLUDED.attachment_count,
       is_removed          = EXCLUDED.is_removed,
       encompass_created_by = EXCLUDED.encompass_created_by,
       encompass_created_at = EXCLUDED.encompass_created_at,
       raw                 = EXCLUDED.raw,
       encompass_synced_at = EXCLUDED.encompass_synced_at,
       updated_at          = now()
     RETURNING id`,
    [loanId, d.encompassDocumentId, d.title, d.titleWithIndex, d.applicationRef,
      d.applicationName, d.milestoneId, d.milestoneName, d.status,
      d.roles === null || d.roles === undefined ? null : JSON.stringify(d.roles),
      d.webCenterAllowed, d.tpoAllowed, d.thirdPartyAllowed, d.isProtected,
      d.daysDue, d.daysTillExpire, d.attachmentCount, d.isRemoved,
      d.encompassCreatedBy, d.encompassCreatedAt,
      d.raw === undefined ? null : JSON.stringify(d.raw), syncedAt],
  );
  return rows[0] ? rows[0].id : null;
}

async function upsertAttachment(dbc, documentId, a, syncedAt) {
  await dbc.query(
    `INSERT INTO lt_document_attachments
       (id, document_id, encompass_attachment_id, title, file_name, content_type,
        file_size, page_count, encompass_uri, is_removed, encompass_created_by,
        encompass_created_at, raw, encompass_synced_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::jsonb, $13, now())
     ON CONFLICT (document_id, encompass_attachment_id) DO UPDATE SET
       title                = EXCLUDED.title,
       file_name            = EXCLUDED.file_name,
       content_type         = EXCLUDED.content_type,
       file_size            = EXCLUDED.file_size,
       page_count           = EXCLUDED.page_count,
       encompass_uri        = EXCLUDED.encompass_uri,
       is_removed           = EXCLUDED.is_removed,
       encompass_created_by = EXCLUDED.encompass_created_by,
       encompass_created_at = EXCLUDED.encompass_created_at,
       raw                  = EXCLUDED.raw,
       encompass_synced_at  = EXCLUDED.encompass_synced_at,
       updated_at           = now()`,
    [documentId, a.encompassAttachmentId, a.title, a.fileName, a.contentType,
      a.fileSize, a.pageCount, a.encompassUri, a.isRemoved, a.encompassCreatedBy,
      a.encompassCreatedAt, a.raw === undefined ? null : JSON.stringify(a.raw), syncedAt],
  );
}

/**
 * Record the document -> condition link.
 *
 * THE LINK IS WRITTEN, THE RESOLUTION IS NOT. `encompass_condition_id` is the
 * link — Encompass's own id, always present — and `condition_id` is only its
 * resolution to a row of ours, which `resolveLinks` (below) is the ONE place
 * that decides. An earlier cut resolved it a second way, in a sub-select right
 * here; the two never disagreed, but two copies of a rule is how they start to,
 * and while both stood NEITHER could be proven to bite (breaking one left the
 * other quietly covering for it, so the tests stayed green either way).
 *
 * A link to a condition we have not mirrored is still STORED, with `condition_id`
 * left null. A foreign key alone would have dropped exactly the links most worth
 * having — a removed condition is still referenced by the documents that
 * answered it.
 *
 * On conflict the existing `condition_id` is LEFT ALONE rather than overwritten
 * with this statement's null, or every re-read would un-resolve every link.
 */
async function upsertLink(dbc, documentId, link, syncedAt) {
  await dbc.query(
    `INSERT INTO lt_document_conditions
       (id, document_id, encompass_condition_id, condition_id, entity_type,
        entity_name, entity_uri, encompass_synced_at)
     VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4, $5, $6)
     ON CONFLICT (document_id, encompass_condition_id) DO UPDATE SET
       entity_type         = EXCLUDED.entity_type,
       entity_name         = EXCLUDED.entity_name,
       entity_uri          = EXCLUDED.entity_uri,
       encompass_synced_at = EXCLUDED.encompass_synced_at`,
    [documentId, link.encompassConditionId, link.entityType,
      link.entityName, link.entityUri, syncedAt],
  );
}

/**
 * Point every link at the condition row it names, wherever one now exists.
 *
 * THE ONE DEFINITION of how a link resolves, and it runs at the end of BOTH
 * reads — because the two reads land in either order and each order leaves a
 * different half dangling: documents first leaves links naming conditions we do
 * not hold yet, conditions first leaves nothing to point at until the documents
 * arrive. Running it on both sides is what makes the order not matter, and it
 * means a condition arriving second fixes its documents immediately instead of
 * waiting hours for the next document read.
 *
 * It only ever fills a NULL, so a resolution already made is never rewritten.
 */
async function resolveLinks(dbc, loanId) {
  const { rowCount } = await dbc.query(
    `UPDATE lt_document_conditions l
        SET condition_id = c.id
       FROM lt_conditions c, lt_documents d
      WHERE l.document_id = d.id
        AND d.loan_id = $1
        AND c.loan_id = $1
        AND c.encompass_condition_id = l.encompass_condition_id
        AND l.condition_id IS NULL`,
    [loanId],
  );
  return rowCount;
}

async function retireMissingDocuments(dbc, loanId, keptIds, syncedAt) {
  if (!keptIds.length) return 0;
  const { rowCount } = await dbc.query(
    `UPDATE lt_documents
        SET is_removed = true, encompass_synced_at = $3, updated_at = now()
      WHERE loan_id = $1
        AND NOT (encompass_document_id = ANY($2::text[]))
        AND is_removed = false`,
    [loanId, keptIds, syncedAt],
  );
  return rowCount;
}

/**
 * Take off a document the files that are no longer on it.
 *
 * WITHOUT THIS THE MIRROR NEVER FORGETS A FILE. Conditions retire and documents
 * retire; attachments did not, so paper deleted in Encompass stayed listed here
 * for ever — harmless while the screen only showed a COUNT, and a plain lie the
 * moment it shows the names, because somebody goes looking for a file that is
 * not there any more.
 *
 * ONLY EVER CALLED WHERE THE PAYLOAD STATED THE LIST (`attachmentsStated`), which
 * is what makes an EMPTY list safe to act on here — unlike the loan-level
 * document sweep, which refuses an empty read outright. A document that came back
 * saying it holds no files is Encompass answering the question; a document whose
 * payload never mentioned files answered nothing, and this is not called at all.
 *
 * Soft-deleted like everything else in the eFolder: the record that a file was
 * once here survives, and the read side is the one place it stops being shown.
 */
async function retireMissingAttachments(dbc, documentId, keptIds, syncedAt) {
  const { rowCount } = await dbc.query(
    `UPDATE lt_document_attachments
        SET is_removed = true, encompass_synced_at = $3, updated_at = now()
      WHERE document_id = $1::uuid
        AND NOT (encompass_attachment_id = ANY($2::text[]))
        AND is_removed = false`,
    [documentId, keptIds, syncedAt],
  );
  return rowCount;
}

/** Read + mirror one loan's eFolder. Same failure posture as the conditions half. */
async function syncDocumentsForLoan(loanId, loanGuid, opts = {}) {
  const client = opts.client || lazy.client;
  const syncedAt = opts.now || new Date();

  let payload;
  try {
    payload = await client.apiGet(`/encompass/v3/loans/${encodeURIComponent(loanGuid)}/documents`);
  } catch (e) {
    await recordError(loanId, 'documents', (e && e.message) || String(e));
    return { ok: false, reason: (e && e.message) || String(e) };
  }

  const read = mapper.readDocuments(payload);
  const dbc = await lazy.db.getClient();
  try {
    await dbc.query('BEGIN');
    const kept = [];
    let attachments = 0;
    let attachmentsRetired = 0;
    let links = 0;
    for (const one of read.rows) {
      const docId = await upsertDocument(dbc, loanId, one.document, syncedAt);
      kept.push(one.document.encompassDocumentId);
      if (!docId) continue;
      const keptFiles = [];
      for (const a of one.attachments) {
        await upsertAttachment(dbc, docId, a, syncedAt);
        keptFiles.push(a.encompassAttachmentId);
        attachments += 1;
      }
      // Silence is not an answer: a payload that never listed this document's
      // files retires none of them.
      if (one.attachmentsStated) {
        attachmentsRetired += await retireMissingAttachments(dbc, docId, keptFiles, syncedAt);
      }
      for (const l of one.conditionLinks) { await upsertLink(dbc, docId, l, syncedAt); links += 1; }
    }
    const retired = await retireMissingDocuments(dbc, loanId, kept, syncedAt);
    const resolved = await resolveLinks(dbc, loanId);
    await dbc.query(
      `UPDATE lt_loans SET documents_synced_at = $2, documents_sync_error = NULL WHERE id = $1`,
      [loanId, syncedAt],
    );
    await dbc.query('COMMIT');
    return {
      ok: true, stored: read.rows.length, seen: read.seen, unreadable: read.unreadable,
      attachments, attachmentsRetired, links, resolved, retired,
    };
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch { /* the connection is going back either way */ }
    await recordError(loanId, 'documents', (e && e.message) || String(e));
    return { ok: false, reason: (e && e.message) || String(e) };
  } finally {
    dbc.release();
  }
}

/**
 * Record why a loan could not be read.
 *
 * Best-effort on its own connection: this runs on the failure path, and a failure
 * to record a failure must not replace the original one in the caller's hands.
 */
async function recordError(loanId, which, reason) {
  const col = which === 'documents' ? 'documents_sync_error' : 'conditions_sync_error';
  try {
    await lazy.db.query(
      `UPDATE lt_loans SET ${col} = $2 WHERE id = $1`,
      [loanId, String(reason || '').slice(0, 500)],
    );
  } catch { /* the reason is already being returned to the caller */ }
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * One pass: read the least-recently-checked loans.
 *
 * Oldest-first with NULLS FIRST, so a loan nobody has ever read goes to the front
 * and the sweep drains a fresh tenant instead of re-reading the same few files.
 */
async function dueLoans(dbc, budget, refreshHours) {
  const { rows } = await dbc.query(
    `SELECT id, encompass_loan_guid AS guid
       FROM lt_loans
      WHERE encompass_loan_guid IS NOT NULL
        AND (conditions_synced_at IS NULL
             OR conditions_synced_at < now() - ($2 || ' hours')::interval)
      ORDER BY conditions_synced_at ASC NULLS FIRST
      LIMIT $1`,
    [budget, String(refreshHours)],
  );
  return rows;
}

/**
 * How stale a mirrored loan may be before this pass reads it again.
 *
 * ZERO IS A REAL ANSWER — "re-read every loan now", which is what a human asking
 * for a pass by hand means. Only an ABSENT or unreadable value falls back to the
 * ordinary refresh age; `> 0` would have silently turned the deliberate re-read
 * into the default and re-read almost nothing.
 *
 * A NEGATIVE age is not an instruction, it is junk — `now() - '-3 hours'` puts the
 * cutoff in the FUTURE, which would sweep the whole book on a typo. It falls back.
 *
 * This is the ONE definition: the HTTP door hands its raw body value straight
 * through rather than deciding again, so the button and the sweep can never
 * disagree about what "0" means.
 */
function refreshHoursFor(opts = {}) {
  const raw = opts && opts.refreshHours;
  // `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are all ZERO —
  // finite, non-negative, and therefore indistinguishable from a deliberate "now"
  // if this were left to `Number()` alone. A caller that sent nothing must not be
  // read as having asked for the whole book, so only a real number or a number
  // somebody typed is considered at all.
  if (typeof raw !== 'number' && typeof raw !== 'string') return DEFAULT_REFRESH_HOURS;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_REFRESH_HOURS;
  const asked = Number(raw);
  return Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_REFRESH_HOURS;
}

/**
 * Read a bounded slice of the book.
 *
 * Refuses politely rather than throwing when the feature is off or Encompass is
 * not connected — a caller wired at boot must be able to call this unconditionally
 * and get a plain answer.
 */
async function syncOnce(opts = {}) {
  if (!(await enabled())) {
    return { ok: false, reason: 'The Condition Center is switched off (conditions.enabled).' };
  }
  const client = opts.client || lazy.client;
  if (!client.configured()) {
    return { ok: false, reason: 'Encompass is not connected yet — add the long-term Encompass credentials first.' };
  }

  const budget = Number(opts.readBudget) > 0 ? Math.trunc(opts.readBudget) : DEFAULT_READ_BUDGET;
  const refreshHours = refreshHoursFor(opts);

  const dbc = await lazy.db.getClient();
  let due;
  try {
    due = await dueLoans(dbc, budget, refreshHours);
  } finally {
    dbc.release();
  }

  let read = 0;
  let failed = 0;
  const failures = [];
  // The threads are counted ACROSS the pass, or the per-loan cap and every thread
  // that would not read would be dropped on the floor here — the sweep's own
  // report is the only place anybody would ever see them.
  const comments = { threads: 0, read: 0, stored: 0, failed: 0, unreadable: 0, more: false };

  for (const loan of due) {
    const c = await syncConditionsForLoan(loan.id, loan.guid, { client, now: opts.now });
    const d = await syncDocumentsForLoan(loan.id, loan.guid, { client, now: opts.now });
    if (c.comments) {
      for (const k of ['threads', 'read', 'stored', 'failed', 'unreadable']) {
        comments[k] += Number(c.comments[k]) || 0;
      }
      comments.more = comments.more || c.comments.more === true;
    }
    if (c.ok && d.ok) read += 1;
    else {
      failed += 1;
      failures.push({ loanId: loan.id, conditions: c.ok ? null : c.reason, documents: d.ok ? null : d.reason });
    }
  }

  // The cap is REPORTED, never silent: "we read 20 and there are more" is the
  // difference between a sweep that is keeping up and one that never will.
  return { ok: true, due: due.length, read, failed, failures, budget, more: due.length === budget, comments };
}

module.exports = {
  DEFAULT_READ_BUDGET,
  DEFAULT_REFRESH_HOURS,
  DEFAULT_COMMENT_CAP,
  enabled,
  refreshHoursFor,
  syncCommentsForLoan,
  syncConditionsForLoan,
  syncDocumentsForLoan,
  syncOnce,
  _internals: { upsertCondition, upsertComment, upsertDocument, upsertAttachment, upsertLink, resolveLinks, retireMissingConditions, retireMissingDocuments, retireMissingAttachments, dueLoans },
};
