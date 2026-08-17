'use strict';
/**
 * LONG-TERM — the Condition Center's READER: Encompass's shapes -> our rows.
 *
 * PURE. No database, no network, no config, no requires. Everything here is
 * "given this JSON, what row does it describe", which is what makes the whole
 * reading testable against real recorded payloads instead of against a mock that
 * agrees with us.
 *
 * READ-ONLY, STRUCTURALLY. This module cannot write to Encompass because it does
 * not know how to talk to anything; the sync that calls it uses the read-only
 * client, and the eFolder UPLOAD stays blocked on the write pad.
 *
 * THE FOUR RULES IT ENFORCES (plan §5.2), because a mapper is where they are
 * either kept or quietly lost:
 *
 *   1. ENCOMPASS'S ID IS THE IDENTITY. A payload with no id is REFUSED (null)
 *      rather than stored under a generated one — a row we cannot match on the
 *      next read is not a mirror, it is a duplicate factory.
 *   2. A DOCUMENT IS NOT A FILE. `readDocument` returns the slot and its
 *      attachments SEPARATELY; nothing here flattens one into the other.
 *   3. THE LINK RUNS DOCUMENT -> CONDITION. `readDocument().conditionLinks` is
 *      read off the document and carries Encompass's own condition id, so the
 *      inverted view can be built even for a condition we have not mirrored.
 *   4. `status_open` IS MIRRORED, NEVER DERIVED. `readCondition` reads their
 *      boolean and, when the payload does not carry one, stores NULL — the
 *      honest "they did not say" — instead of guessing from the status word.
 *      Deriving it is how our screen ends up disagreeing with theirs.
 *
 * NOTHING IS EVER INVENTED. Every helper answers null on anything it cannot read
 * confidently, because a mirror that fills in blanks stops being a mirror.
 */

/** A trimmed string, or null. Never `''` — a blank cell and "they said nothing"
 *  are the same fact here, and storing both spellings makes every query ask twice. */
function str(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** A whole number, or null. A float, a NaN and a numeric string of junk all read
 *  as "not stated" rather than as 0 — a count of zero is a claim. */
function int(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** A big whole number (a file size), or null. Same discipline as `int`. */
function big(v) {
  const n = int(v);
  return n === null ? null : n;
}

/**
 * A boolean EXACTLY as stated, or null.
 *
 * `null` is a real answer here and must not collapse to false: on `status_open`
 * it means "Encompass did not tell us whether this is outstanding", which a
 * screen should say rather than quietly render as closed.
 */
function bool(v) {
  if (v === true || v === false) return v;
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  return null;
}

/** A Date, or null. An unparseable or absurd stamp is not stored. */
function ts(v) {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2200) return null;
  return d;
}

/** An entity reference Encompass writes as `{entityId, entityName}` or a bare id. */
function entityName(v) {
  if (!v) return null;
  if (typeof v === 'string') return str(v);
  if (typeof v === 'object') return str(v.entityName) || str(v.name) || str(v.entityId) || str(v.id);
  return null;
}

function entityId(v) {
  if (!v) return null;
  if (typeof v === 'string') return str(v);
  if (typeof v === 'object') return str(v.entityId) || str(v.id);
  return null;
}

/**
 * The condition id out of a document's `conditions[]` entry.
 *
 * Encompass gives it three ways and the entityUri is the one that is always
 * there, so the id is taken from the explicit field first and PARSED OUT OF THE
 * URI as the fallback — `/v3/loans/{loanId}/conditions/{conditionId}`. Reading
 * only `entityId` would silently drop links on any payload that omits it, and a
 * dropped link is invisible: the condition simply appears to have no documents.
 */
function conditionIdFromLink(link) {
  if (!link) return null;
  const direct = str(link.entityId) || str(link.id) || str(link.conditionId);
  if (direct) return direct;
  const uri = str(link.entityUri) || str(link.uri);
  if (!uri) return null;
  const m = /\/conditions\/([^/?#]+)/i.exec(uri);
  return m ? str(decodeURIComponent(m[1])) : null;
}

/** Encompass's print definitions, kept as given. Its shape varies by tenant and
 *  nothing here reads it yet, so it is stored rather than interpreted. */
function printDefs(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) || typeof v === 'object') return v;
  const s = str(v);
  return s ? [s] : null;
}

/**
 * ONE Encompass condition -> the `lt_conditions` row it describes.
 *
 * Returns null when the payload carries no id (rule 1). The caller reports a
 * refusal rather than swallowing it — a condition we cannot key is a condition
 * somebody would otherwise never see again.
 */
function readCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id) || str(raw.conditionId) || str(raw.guid);
  if (!id) return null;

  return {
    encompassConditionId: id,
    conditionType: str(raw.conditionType) || str(raw.type),
    title: str(raw.title) || str(raw.name),
    internalDescription: str(raw.internalDescription),
    externalDescription: str(raw.externalDescription),
    category: str(raw.category),
    priorTo: str(raw.priorTo),
    status: str(raw.status),

    // Rule 4: THEIR boolean, or null. Never inferred from `status`.
    statusOpen: bool(raw.statusOpen),
    statusDate: ts(raw.statusDate),

    source: str(raw.source),
    sourceOfCondition: str(raw.sourceOfCondition),
    printDefinitions: printDefs(raw.printDefinitions),
    applicationRef: str(raw.application) || entityId(raw.applicationId),
    ownerRole: entityName(raw.owner),
    assignedTo: entityName(raw.assignedTo),
    recipient: entityName(raw.recipient),
    daysToReceive: int(raw.daysToReceive),
    commentsCount: int(raw.commentsCount),
    internalId: str(raw.internalId),

    // Soft-deleted upstream; mirrored, then filtered on read. An absent flag is
    // NOT removed — the common case is a payload that simply does not carry it.
    isRemoved: bool(raw.isRemoved) === true,

    encompassCreatedBy: entityName(raw.createdBy),
    encompassCreatedAt: ts(raw.createdDate) || ts(raw.dateCreated),
    encompassModifiedBy: entityName(raw.lastModifiedBy),
    encompassModifiedAt: ts(raw.lastModifiedDate),

    raw,
  };
}

/** ONE comment on a condition. A comment with no body AND no author is dropped —
 *  it carries nothing a person could read. */
function readComment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = str(raw.comments) || str(raw.comment) || str(raw.body) || str(raw.text);
  const author = entityName(raw.createdBy) || entityName(raw.author) || str(raw.userName);
  if (!body && !author) return null;
  return {
    encompassCommentId: str(raw.id) || str(raw.commentId),
    body,
    authorName: author,
    authorId: entityId(raw.createdBy) || entityId(raw.author),
    commentedAt: ts(raw.dateCreated) || ts(raw.createdDate) || ts(raw.commentDate),
    raw,
  };
}

/**
 * ONE eFolder document -> the slot, its attachments, and its condition links.
 *
 * Rule 2 and rule 3 both live in this return shape: the caller receives THREE
 * lists it must store in three places, and never a flattened row that pretends a
 * document is a file or that a link belongs to the condition.
 */
function readDocument(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id) || str(raw.documentId) || str(raw.guid);
  if (!id) return null;

  // "THIS DOCUMENT HAS NO FILES" AND "THE PAYLOAD DID NOT LIST ITS FILES" ARE
  // DIFFERENT ANSWERS, and collapsing them is how a mirror wipes itself. The
  // retire sweep takes an attachment off a document when the read comes back
  // without it — correct when Encompass STATED the list and it was empty (an
  // empty needs-list slot is an ordinary, meaningful state), and catastrophic
  // when the key was simply absent, which would retire every file on every
  // document at once. Whether this endpoint ever omits the key is UNVERIFIED, so
  // the reader reports what it saw and lets the caller refuse to act on silence.
  const attachmentsStated = Array.isArray(raw.attachments);
  const attachmentsRaw = attachmentsStated ? raw.attachments : [];
  const linksRaw = Array.isArray(raw.conditions) ? raw.conditions : [];

  const attachments = [];
  for (const a of attachmentsRaw) {
    const one = readAttachment(a);
    if (one) attachments.push(one);
  }

  const conditionLinks = [];
  const seen = new Set();
  for (const l of linksRaw) {
    const condId = conditionIdFromLink(l);
    if (!condId || seen.has(condId)) continue;   // one link per condition per document
    seen.add(condId);
    conditionLinks.push({
      encompassConditionId: condId,
      entityType: str(l && l.entityType),
      entityName: str(l && l.entityName),
      entityUri: str(l && (l.entityUri || l.uri)),
    });
  }

  return {
    document: {
      encompassDocumentId: id,
      title: str(raw.title),
      titleWithIndex: str(raw.titleWithIndex),
      applicationRef: str(raw.applicationId) || entityId(raw.application),
      applicationName: str(raw.applicationName) || entityName(raw.application),
      milestoneId: entityId(raw.milestone) || str(raw.milestoneId),
      milestoneName: entityName(raw.milestone) || str(raw.milestoneName),
      status: str(raw.status),
      roles: Array.isArray(raw.roles) ? raw.roles : (raw.roles && typeof raw.roles === 'object' ? raw.roles : null),
      webCenterAllowed: bool(raw.webCenterAllowed),
      tpoAllowed: bool(raw.tpoAllowed),
      thirdPartyAllowed: bool(raw.thirdPartyAllowed),
      isProtected: bool(raw.isProtected),
      daysDue: int(raw.daysDue),
      daysTillExpire: int(raw.daysTillExpire),

      // What Encompass SHOWED us on this read, so a screen can say "3 files" without
      // a second query. The attachment ROWS remain the source of truth — this
      // counts what the payload LISTED, removed files included, which is why the
      // read side counts the live rows instead of trusting it. NULL where the
      // payload never stated a list: a confident 0 there would be a claim we
      // cannot make.
      attachmentCount: attachmentsStated ? attachments.length : null,

      isRemoved: bool(raw.isRemoved) === true,
      encompassCreatedBy: entityName(raw.createdBy),
      encompassCreatedAt: ts(raw.dateCreated) || ts(raw.createdDate),
      raw,
    },
    attachments,
    attachmentsStated,
    conditionLinks,
  };
}

/**
 * ONE attachment — METADATA ONLY.
 *
 * There is deliberately no field here for the bytes and no helper that could
 * fetch them: we keep the URI and read it live when somebody asks. A copy would
 * start drifting the moment the original is replaced in Encompass, and it would
 * move borrower paper into a second store nobody decided on.
 */
function readAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id) || str(raw.attachmentId) || str(raw.guid);
  if (!id) return null;
  return {
    encompassAttachmentId: id,
    title: str(raw.title),
    fileName: str(raw.fileName) || str(raw.name),
    contentType: str(raw.contentType) || str(raw.mimeType),
    fileSize: big(raw.fileSize) || big(raw.size),
    pageCount: int(raw.pages) || int(raw.pageCount),
    encompassUri: str(raw.url) || str(raw.uri) || str(raw.href),
    isRemoved: bool(raw.isRemoved) === true,
    encompassCreatedBy: entityName(raw.createdBy),
    encompassCreatedAt: ts(raw.dateCreated) || ts(raw.createdDate),
    raw,
  };
}

/**
 * A whole conditions payload -> rows + a count of what could not be read.
 *
 * The refusals are COUNTED AND NAMED, never dropped quietly: "we read 12 of 14"
 * is a fact somebody needs, and a mirror that silently loses two conditions looks
 * exactly like a loan that only has twelve.
 */
function readConditions(payload) {
  const list = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.conditions) ? payload.conditions : []);
  const rows = [];
  let unreadable = 0;
  for (const raw of list) {
    const row = readCondition(raw);
    if (row) rows.push(row); else unreadable += 1;
  }
  return { rows, seen: list.length, unreadable };
}

/** A whole documents payload -> documents, attachments and links, plus refusals. */
function readDocuments(payload) {
  const list = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.documents) ? payload.documents : []);
  const rows = [];
  let unreadable = 0;
  for (const raw of list) {
    const one = readDocument(raw);
    if (one) rows.push(one); else unreadable += 1;
  }
  return { rows, seen: list.length, unreadable };
}

module.exports = {
  readCondition, readConditions,
  readComment,
  readDocument, readDocuments, readAttachment,
  conditionIdFromLink,
  _internals: { str, int, big, bool, ts, entityName, entityId, printDefs },
};
