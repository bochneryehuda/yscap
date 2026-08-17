'use strict';
/**
 * LT test — the Condition Center's READING, with no database and no network.
 *
 * The DB suite proves the mirror. This proves the part that decides whether the
 * mirror is worth anything: given the shapes Encompass actually sends, which row
 * do we store, and what do we refuse to invent?
 *
 * Four rules from the plan (§5.2) are asserted here because a mapper is exactly
 * where each is either kept or quietly lost:
 *
 *   1. Encompass's id IS the identity — a payload without one is REFUSED.
 *   2. A document is not a file — the slot and its attachments come back apart.
 *   3. The link runs document -> condition, and survives a condition we have not
 *      mirrored.
 *   4. `status_open` is MIRRORED, never derived from the status word.
 *
 * Plus the two reading rules the screen depends on: unapproved first, and an
 * unrecognised eFolder status counts as OUTSTANDING rather than as done.
 */

const fs = require('fs');
const path = require('path');

const mapper = require('../src/longterm/conditions/mapper');
const read = require('../src/longterm/conditions/read');
// Safe to require with no database: sync.js pulls db/client/settings lazily.
const sync = require('../src/longterm/conditions/sync');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** A condition shaped as the live v3 resource sends one (src/longterm/encompass/conditions.js). */
const REAL_CONDITION = {
  id: 'c-9f21',
  conditionType: 'Underwriting',
  title: 'Entity documents',
  internalDescription: 'Operating agreement + EIN letter. E-[4240954]',
  externalDescription: 'Please provide your operating agreement and EIN letter.',
  category: 'Legal',
  priorTo: 'Docs',
  status: 'Added',
  statusOpen: true,
  statusDate: '2026-06-02T14:03:00Z',
  source: 'Borrowers',
  sourceOfCondition: 'ConditionList',
  printDefinitions: ['InternalPrint', 'ExternalPrint'],
  application: 'All',
  owner: { entityId: '17', entityName: 'Underwriter' },
  assignedTo: { entityId: '42', entityName: 'Evolve API' },
  daysToReceive: 5,
  commentsCount: 2,
  isRemoved: false,
  internalId: 'UW',
  createdBy: { entityId: '42', entityName: 'Evolve API' },
  createdDate: '2026-06-01T09:00:00Z',
  lastModifiedBy: { entityId: '42', entityName: 'Evolve API' },
  lastModifiedDate: '2026-06-02T14:03:00Z',
};

// ── Rule 1: the id is the identity ──────────────────────────────────────────
console.log("Encompass's own id is the identity");

const one = mapper.readCondition(REAL_CONDITION);
check(one && one.encompassConditionId === 'c-9f21', 'a real condition reads, keyed on its GUID');
check(mapper.readCondition({ title: 'No id here' }) === null,
  'a condition with NO id is REFUSED — a row we cannot match on the next read is a duplicate factory, not a mirror');
check(mapper.readCondition(null) === null, 'and null is refused rather than throwing');
check(mapper.readCondition('a string') === null, 'as is a payload that is not an object');

const batch = mapper.readConditions([REAL_CONDITION, { title: 'unkeyed' }, { id: 'c-2', title: 'Title' }]);
check(batch.rows.length === 2 && batch.seen === 3 && batch.unreadable === 1,
  'a batch REPORTS what it could not read — "12 of 14" is a fact somebody needs, and losing two quietly looks exactly like a loan that has twelve');

// ── Rule 4: status_open is mirrored, never derived ──────────────────────────
console.log('\nwhether it is still outstanding is ENCOMPASS\'s answer, never ours');

check(one.statusOpen === true, "their `true` is stored as true");
check(mapper.readCondition({ id: 'x', status: 'Cleared', statusOpen: false }).statusOpen === false,
  'their `false` is stored as false');

// The trap: a status word that reads closed, with no boolean beside it.
const noFlag = mapper.readCondition({ id: 'x', status: 'Cleared' });
check(noFlag.statusOpen === null,
  'a condition whose payload carries NO statusOpen stores NULL — never guessed from the word "Cleared", because our screen must not disagree with theirs');
const openWord = mapper.readCondition({ id: 'x', status: 'Added' });
check(openWord.statusOpen === null,
  '…and the same when the word reads open: we do not infer either direction');

// And the screen's side of the same rule.
const unknown = read._internals.describeCondition(
  { id: 'r1', status_open: null, status: 'Cleared' }, [], false,
);
check(unknown.open === true && unknown.statusStated === null,
  'a condition Encompass did not answer for is shown as OPEN and reports that it was never stated — burying an unknown at the bottom is how it gets missed');

// ── Rule 2: a document is not a file ────────────────────────────────────────
console.log('\na DOCUMENT is the slot; an ATTACHMENT is the paper');

const REAL_DOCUMENT = {
  id: 'd-77',
  title: 'Appraisal',
  titleWithIndex: 'Appraisal (2)',
  applicationId: '_borrower1',
  applicationName: 'Ruth Klein',
  milestone: { entityId: '9', entityName: 'Submittal' },
  status: 'received',
  roles: ['LC', 'UW'],
  webCenterAllowed: true,
  tpoAllowed: false,
  isProtected: false,
  daysDue: 3,
  dateCreated: '2026-05-30T12:00:00Z',
  createdBy: { entityId: '3', entityName: 'Chaya G' },
  attachments: [
    { id: 'a-1', title: 'Appraisal.pdf', fileSize: 4210233, pages: 41, url: 'https://enc/att/a-1' },
    { id: 'a-2', title: 'Invoice.pdf', fileSize: 22110, url: 'https://enc/att/a-2' },
  ],
  conditions: [
    { entityId: 'c-9f21', entityType: 'EnhancedCondition', entityName: 'Entity documents',
      entityUri: '/v3/loans/L1/conditions/c-9f21' },
  ],
};

const doc = mapper.readDocument(REAL_DOCUMENT);
check(!!doc && !!doc.document && Array.isArray(doc.attachments) && Array.isArray(doc.conditionLinks),
  'one document comes back as THREE things — the slot, its attachments, and its links — never flattened into one row');
check(doc.attachments.length === 2, 'both attachments are read');
check(doc.document.attachmentCount === 2, 'the slot records how many files were on it');
check(!('attachments' in doc.document) && !('conditions' in doc.document)
  && !('conditionLinks' in doc.document) && !('files' in doc.document),
  'and the SLOT ITSELF carries neither the files nor the links — a row that holds its own attachments is the flattening rule 2 exists to forbid, and it is how a re-read starts writing the same paper twice');
check(doc.attachments[0].encompassUri === 'https://enc/att/a-1',
  'an attachment keeps the URI — a POINTER, read live when somebody asks');
check(!('bytes' in doc.attachments[0]) && !('data' in doc.attachments[0]) && !('content' in doc.attachments[0]),
  'and NOTHING that could hold the bytes: the paper stays in Encompass');
check(mapper.readAttachment({ title: 'no id' }) === null, 'an attachment with no id is refused too');

// ── "no files" and "the payload did not say" are different answers ──────────
console.log('\n"this document has no files" is not the same answer as "the payload did not list any"');

const STATED_EMPTY = mapper.readDocument({ id: 'd-90', title: 'W-2', attachments: [] });
const NEVER_STATED = mapper.readDocument({ id: 'd-91', title: 'W-2' });

check(doc.attachmentsStated === true && STATED_EMPTY.attachmentsStated === true,
  'a payload that LISTED files — even an empty list — is marked as having answered the question');
check(NEVER_STATED.attachmentsStated === false,
  '…and one that never mentioned files is marked as having answered nothing: the retire sweep takes a file off a document when a read comes back without it, so reading silence as "it has none" would strip every file off every document at once');
check(STATED_EMPTY.document.attachmentCount === 0 && NEVER_STATED.document.attachmentCount === null,
  'an empty list counts ZERO and an absent one counts NOTHING — a confident 0 on a payload that never said is a claim we cannot make, and it is what a screen would print as "no files yet"');
check(NEVER_STATED.attachments.length === 0,
  '…and either way no attachment is invented');

// ── Rule 3: the link runs document -> condition ─────────────────────────────
console.log('\nthe link lives on the DOCUMENT, and is recorded even for a condition we do not hold');

check(doc.conditionLinks.length === 1 && doc.conditionLinks[0].encompassConditionId === 'c-9f21',
  "the document's own conditions[] is what carries the link");

const fromUriOnly = mapper.conditionIdFromLink({ entityUri: '/v3/loans/L1/conditions/c-abc' });
check(fromUriOnly === 'c-abc',
  'the id is PARSED OUT OF THE URI when the explicit field is missing — reading only entityId would silently drop links, and a dropped link is invisible: the condition simply appears to have no documents');
check(mapper.conditionIdFromLink({ entityUri: '/v3/loans/L1/conditions/c%20d' }) === 'c d',
  '…and it is URL-decoded');
check(mapper.conditionIdFromLink({}) === null && mapper.conditionIdFromLink(null) === null,
  'a link naming no condition at all is refused rather than stored as a link to nothing');

const dupes = mapper.readDocument({
  id: 'd-9',
  conditions: [
    { entityId: 'c-1', entityUri: '/v3/loans/L/conditions/c-1' },
    { entityUri: '/v3/loans/L/conditions/c-1' },
  ],
});
check(dupes.conditionLinks.length === 1,
  'one link per condition per document — Encompass repeating itself must not become two rows');

// ── Nothing is invented ─────────────────────────────────────────────────────
console.log('\nnothing is ever invented');

const junk = mapper.readCondition({ id: 'x', daysToReceive: 'soon', commentsCount: 'lots', statusDate: 'never' });
check(junk.daysToReceive === null && junk.commentsCount === null,
  'a count that is not a number reads as "not stated" — a zero would be a claim');
check(junk.statusDate === null, 'an unparseable date is not stored');
check(mapper.readCondition({ id: 'x', statusDate: '1673-01-01' }).statusDate === null,
  'nor an absurd one');
check(mapper.readCondition({ id: 'x', title: '   ' }).title === null,
  'a blank cell and "they said nothing" are the same fact, stored one way');

const removed = mapper.readCondition({ id: 'x' });
check(removed.isRemoved === false,
  'a payload with no isRemoved flag is NOT removed — the common case is a payload that simply does not carry it');
check(mapper.readCondition({ id: 'x', isRemoved: true }).isRemoved === true,
  'and a real removal is mirrored, so it can be filtered on read instead of deleted');

const noBody = mapper.readComment({ id: 'k' });
check(noBody === null, 'a comment with no body and no author carries nothing a person could read');
check(mapper.readComment({ id: 'k', comments: 'Received, thank you', createdBy: { entityName: 'Malky' } }).body
  === 'Received, thank you', 'a real comment reads');

// ── The screen's two reading rules ──────────────────────────────────────────
console.log('\nthe list shows you your work first');

const items = [
  read._internals.describeCondition({ id: 'a', status_open: false, encompass_created_at: '2026-01-01' }, [], false),
  read._internals.describeCondition({ id: 'b', status_open: true, encompass_created_at: '2026-02-01' }, [], false),
];
items.sort((x, y) => (x.rank - y.rank) || String(x.createdAt).localeCompare(String(y.createdAt)));
check(items[0].id === 'b',
  'unapproved first — the system is opinionated about showing you your work before showing you everything');

check(read._internals.conditionRank({ status_open: null }) === read._internals.conditionRank({ status_open: true }),
  'an unanswered condition sorts WITH the open ones, not with the finished ones');

console.log('\nan eFolder status we do not recognise still counts as outstanding');
const out = read._internals.documentOutstanding;
check(out('needed') === true && out('ordered') === true && out('expired!') === true,
  'the ones that plainly mean "still wanted"');
check(out('received') === false && out('reviewed') === false && out('Ready for UW') === false,
  'the ones that mean it arrived — case-insensitively, because the vocabulary is typed by a tenant');
check(out('some new status nobody told us about') === true,
  'and a status we have NEVER SEEN counts as outstanding: an unknown word is not evidence that a document arrived');
check(out(null) === true && out('') === true, 'as does no status at all');

// ── The investor name never reaches a client ────────────────────────────────
console.log('\nthe investor name never reaches a client');

const named = 'Deephaven approval received — see attached';
check(read._internals.safeText(named, false) === named,
  'internal staff read the text as written');
check(read._internals.safeText(named, true) !== named,
  'a client-bound string is scrubbed through the ONE shared definition');
check(read._internals.safeText(null, true) === null, 'and a missing string stays missing');

const clientView = read._internals.describeCondition(
  { id: 'r', status_open: true, internal_description: 'Deephaven wants the OA', external_description: 'Please send the operating agreement.', owner_role: 'Underwriter', assigned_to: 'Malky' },
  [], true,
);
check(clientView.body === 'Please send the operating agreement.',
  'a client sees the EXTERNAL description — never the internal one, which carries our own reasoning');
check(clientView.owner === null && clientView.assignedTo === null,
  'and never who inside the company owns it');

// The THREAD is internal in the strongest sense: not scrubbed, not summarised —
// absent. A comment is our own reasoning about their file, and the scrub knows
// about investor NAMES, not about a paragraph of internal thinking.
const THREAD = [{ id: 'm1', body: 'Deephaven asked for the OA', author: 'Malky', at: '2026-06-02T10:00:00Z' }];
const clientThread = read._internals.describeCondition(
  { id: 'r', status_open: true, comments_count: 3 }, [], true, THREAD,
);
check(Array.isArray(clientThread.comments) && clientThread.comments.length === 0,
  'a client is never sent the conversation on their condition — it is withheld, not cleaned');
check(clientThread.commentCount === null,
  '…and not told how much was said either: "3 comments you may not read" is worse than silence');

const staffThread = read._internals.describeCondition(
  { id: 'r', status_open: true, comments_count: 3 }, [], false, THREAD,
);
check(staffThread.comments.length === 1 && staffThread.comments[0].body === 'Deephaven asked for the OA',
  'staff read the conversation as written');
check(staffThread.commentCount === 3,
  'and BOTH numbers travel — Encompass counts three, we hold one, and the screen can say so');
check(read._internals.describeCondition({ id: 'r', status_open: true }, [], false).comments.length === 0,
  'a condition with no thread reports an empty one rather than nothing at all');

// ── Pressing the button by hand ─────────────────────────────────────────────
// A person asking for a pass means "read them again NOW". Reading a refresh age
// of 0 as "unset" would silently give them the ordinary 12-hour age and re-read
// almost nothing — the button would look like it worked and do nothing.
console.log('\nasking for a pass by hand means NOW');

check(sync.refreshHoursFor({ refreshHours: 0 }) === 0,
  'zero is a real answer — every mirrored loan is re-read, which is what pressing the button means');
check(sync.refreshHoursFor({}) === sync.DEFAULT_REFRESH_HOURS,
  'an ABSENT age is the ordinary refresh age — the scheduled sweep is unchanged');
check(sync.refreshHoursFor({ refreshHours: 3 }) === 3,
  'a real age is honoured as asked');
check(sync.refreshHoursFor({ refreshHours: -3 }) === sync.DEFAULT_REFRESH_HOURS,
  'a NEGATIVE age is junk, not an instruction — it would put the cutoff in the FUTURE and sweep the whole book on a typo');
check(sync.refreshHoursFor({ refreshHours: 'soon' }) === sync.DEFAULT_REFRESH_HOURS
  && sync.refreshHoursFor({ refreshHours: null }) === sync.DEFAULT_REFRESH_HOURS
  && sync.refreshHoursFor({ refreshHours: '' }) === sync.DEFAULT_REFRESH_HOURS
  && sync.refreshHoursFor({ refreshHours: false }) === sync.DEFAULT_REFRESH_HOURS
  && sync.refreshHoursFor({ refreshHours: [] }) === sync.DEFAULT_REFRESH_HOURS,
  '…and so is anything unreadable — including null, blank, false and an empty list, every one of which Number() reads as a perfectly valid ZERO');
check(sync.refreshHoursFor({ refreshHours: '0' }) === 0,
  'while a typed "0" from a form IS the deliberate re-read — a form sends strings');

// ONE definition: the HTTP door hands the raw body value through rather than
// deciding again. A second copy of this rule is how the button and the sweep
// come to disagree about what "0" means.
const syncRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/routes/sync.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(/refreshHours:\s*body\.refreshHours/.test(syncRouteSrc),
  'and the door passes the asked-for age straight through — it never re-decides what an age means');

// ── The source guards ───────────────────────────────────────────────────────
console.log('\nnothing here can write to Encompass, or to us');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** Comments are stripped before every "must not appear" test: a guard that read
 *  comments would fail on the very explanation it exists to protect, and the
 *  obvious way to "fix" that is to delete the explanation. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const routes = stripComments(src('src/longterm/routes/conditions.js'));
check(!/router\.(post|patch|put|delete)\s*\(/.test(routes),
  'the routes are GET-only — there is no write door to find');

const syncSrc = stripComments(src('src/longterm/conditions/sync.js'));
check(!/apiPost|apiPut|apiPatch|apiDelete|attachmentUploadUrl/.test(syncSrc),
  'the sync never reaches for a write endpoint — the eFolder upload stays blocked on the pad');
check(/apiGet/.test(syncSrc), '…while it does read, through the read-only client');

const readSrc = stripComments(src('src/longterm/conditions/read.js'));
check(!/\b(INSERT|UPDATE|DELETE)\b/i.test(readSrc),
  'the read side writes nothing at all');

const mapperSrc = stripComments(src('src/longterm/conditions/mapper.js'));
check(!/require\(/.test(mapperSrc),
  'the mapper requires nothing — it cannot reach a database or a network even by accident');

// The SCREEN is the other end of the same promise. The eFolder upload is a WRITE
// and stays blocked on the pad, so the Condition Center must carry no control that
// posts anything — a button that files a document would be the feature arriving
// through the front end while the gate still says no.
const centerSrc = stripComments(src('app-v2/src/longterm/LtConditionCenter.jsx'));
check(!/ltPost|ltPut|ltPatch|ltDel|method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(centerSrc),
  'the Condition Center screen has no write control — the eFolder upload arrives as a NEW control once the pad authorizes it, never as an edit to one of these rows');
check(/ltApi\.conditionCenter\(/.test(centerSrc),
  '…and it reads through the one Long-Term client, so it can only reach /api/lt');

// The fold and the count are a RULE, and it lives where it can be run
// (`conditionGroups.js`, proved by test-lt-condition-groups-pure.mjs). A copy
// inlined back into the JSX is unrunnable, so the first thing to drift would be
// the one thing a folded section still shows.
check(/from '\.\/conditionGroups\.js'/.test(centerSrc)
  && /groupDone\(/.test(centerSrc) && /groupSummary\(/.test(centerSrc),
  'the screen asks the shared rule whether a gate is finished and what its header says — it never decides either in the markup');
check(!/group\.open === 0|group\.open !== 0/.test(centerSrc),
  '…and does not re-derive "finished" beside it, which is how a section comes to sit open saying "all done"');

// ── The files themselves reach the screen ──────────────────────────────────
console.log('\nthe centre shows the FILES, not a count of them');

check(/attachmentsForDocuments\(/.test(readSrc) && /FROM lt_document_attachments/.test(readSrc),
  'the read side reads the attachment mirror at all — it was filled from the day the eFolder read shipped and NOTHING read it, so "3 files" was every word the screen could say about the paper');
check(/row_number\(\)\s*OVER/.test(readSrc) && /count\(\*\)\s*OVER/.test(readSrc),
  '…capped and counted in ONE query per page, so a loan with a hundred documents is not a hundred round trips, and the honest total survives the cap');
check(/moreFiles/.test(readSrc) && /moreFiles/.test(centerSrc),
  '…and a list that stopped short SAYS how many are left: a cut that does not announce itself reads as the whole truth');
check(!/attachment_count/.test(readSrc),
  'the count comes from the live rows and never from lt_documents.attachment_count — that column records what the payload LISTED, removed files included, so a slot whose only file was deleted in Encompass read "1 file" beside an empty list');
check(/name:\s*safeText\(/.test(readSrc) && /addedBy:\s*safeText\(/.test(readSrc),
  'a FILENAME is scrubbed for a client like any other free text — "Deephaven approval.pdf" is the reason the one definition exists, and a file list is exactly where an investor name reaches a borrower');
check(!/encompass_uri/.test(readSrc),
  '…and the pointer into Encompass is never sent: PILOT has no route that opens one, and a link that cannot be clicked is worse than none');
check(/<FileList/.test(centerSrc) && (centerSrc.match(/<FileList/g) || []).length >= 2,
  'and the screen renders the files under BOTH the condition\'s documents and the eFolder needs list — the two places a person asks "is the right paper in?"');

check(/retireMissingAttachments\(/.test(syncSrc),
  'a file that has left Encompass leaves the mirror too — conditions and documents both retired and attachments never did, which was invisible while the screen showed a number and a plain lie the moment it shows the names');
check(/attachmentsStated/.test(syncSrc),
  '…and only where the payload actually stated the list, so a shape that omits the key retires nothing rather than emptying every document at once');

// A condition is never DELETED anywhere in the mirror.
check(!/DELETE\s+FROM\s+lt_conditions|DELETE\s+FROM\s+lt_documents|DELETE\s+FROM\s+lt_document_attachments/i.test(syncSrc),
  'and nothing is ever deleted: a row Encompass no longer lists is marked removed, because the record of what was once asked for has to survive');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
