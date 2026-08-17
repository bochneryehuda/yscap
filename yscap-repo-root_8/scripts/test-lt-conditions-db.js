'use strict';
/**
 * LT test — the Condition Center's mirror, against a REAL database.
 *
 * The pure suite proves the reading. This proves what a pure suite structurally
 * cannot, and each of these has been a live bug somewhere in this repo:
 *
 *   · **Every column these statements name exists.** A phantom column inside a
 *     swallowing catch reports a confident "nothing to sync" forever. Ten of the
 *     eleven inserts/updates here go through the production code, so the schema
 *     and the code are compared rather than assumed.
 *   · **A second sync UPDATES rather than duplicating.** That is a claim about a
 *     unique index and an ON CONFLICT target — only Postgres can settle it.
 *   · **A link to a condition we have NOT mirrored is still stored, and resolves
 *     itself later.** The whole reason it is keyed on the Encompass id.
 *   · **A condition that disappears is MARKED REMOVED, never deleted**, and is
 *     then filtered on read.
 *   · **The read really does invert the document -> condition link**, which is the
 *     owner's "with all the documents in there linked".
 *
 * No network: the Encompass client is a STUB that answers with recorded shapes,
 * so this suite proves our half without touching the tenant.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise, because
 * `npm test` runs in a job that has no database at all.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-conditions-db (no DATABASE_URL)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const db = require('../src/longterm/db');
const sync = require('../src/longterm/conditions/sync');
const read = require('../src/longterm/conditions/read');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const GUID = 'test-lt-cond-guid-0001';

/** The stub tenant. `apiGet` is the ONLY method the sync may call — if it ever
 *  reaches for a write, this object does not have one and the run fails loudly. */
function stubClient(conditions, documents, comments = {}) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    async apiGet(path) {
      calls.push(path);
      // The thread path is checked FIRST — it is the specific one.
      const thread = path.match(/\/conditions\/([^/]+)\/comments$/);
      if (thread) {
        const id = decodeURIComponent(thread[1]);
        if (comments[id] === 'boom') throw new Error('Encompass said no');
        return comments[id] || [];
      }
      if (/\/conditions$/.test(path)) return conditions;
      if (/\/documents$/.test(path)) return documents;
      throw new Error(`the sync asked for a path this test did not expect: ${path}`);
    },
  };
}

const COND_A = {
  id: 'c-A', conditionType: 'Underwriting', title: 'Entity documents',
  internalDescription: 'OA + EIN', externalDescription: 'Please send the operating agreement.',
  category: 'Legal', priorTo: 'Docs', status: 'Added', statusOpen: true,
  statusDate: '2026-06-02T14:03:00Z', source: 'Borrowers', daysToReceive: 5,
  commentsCount: 1, internalId: 'UW', createdDate: '2026-06-01T09:00:00Z',
  createdBy: { entityId: '42', entityName: 'Evolve API' },
};
const COND_B = {
  id: 'c-B', title: 'Title commitment', status: 'Cleared', statusOpen: false,
  priorTo: 'Funding', createdDate: '2026-06-03T09:00:00Z',
};

const DOC_1 = {
  id: 'd-1', title: 'Appraisal', titleWithIndex: 'Appraisal', status: 'received',
  milestone: { entityId: '9', entityName: 'Submittal' }, dateCreated: '2026-05-30T12:00:00Z',
  attachments: [{ id: 'a-1', title: 'Appraisal.pdf', fileSize: 4210233, pages: 41, url: 'https://enc/att/a-1' }],
  // Links to a condition we DO hold…
  conditions: [{ entityId: 'c-A', entityType: 'EnhancedCondition', entityName: 'Entity documents',
    entityUri: '/v3/loans/L/conditions/c-A' }],
};
const DOC_2 = {
  id: 'd-2', title: 'Bank statements', status: 'needed', dateCreated: '2026-06-04T12:00:00Z',
  attachments: [],
  // …and one we do NOT (never mirrored, or already gone from Encompass).
  conditions: [{ entityUri: '/v3/loans/L/conditions/c-GHOST', entityType: 'EnhancedCondition' }],
};

async function main() {
  let loanId = null;
  try {
    // A real loan to hang the mirror off. Everything below cascades from it, so
    // the cleanup at the end is one DELETE.
    const { rows } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'TEST-COND-1', now(), now())
       ON CONFLICT (encompass_loan_guid) DO UPDATE SET updated_at = now()
       RETURNING id`, [GUID],
    );
    loanId = rows[0].id;

    // ── The first read ──────────────────────────────────────────────────────
    console.log('reading a loan for the first time');

    const client = stubClient([COND_A, COND_B], [DOC_1, DOC_2]);
    const c1 = await sync.syncConditionsForLoan(loanId, GUID, { client });
    const d1 = await sync.syncDocumentsForLoan(loanId, GUID, { client });

    check(c1.ok && c1.stored === 2, 'both conditions are mirrored');
    check(d1.ok && d1.stored === 2, 'both eFolder documents are mirrored');
    check(d1.attachments === 1, 'the one attachment is mirrored as its own row');
    check(client.calls.every((p) => /\/conditions$|\/documents$|\/conditions\/[^/]+\/comments$/.test(p)),
      'and the sync asked for nothing but the condition list, the eFolder, and the thread on a condition that HAS one');
    check(client.calls.filter((p) => /\/comments$/.test(p)).length === 1
      && client.calls.some((p) => p.endsWith('/conditions/c-A/comments')),
      'the thread is read ONLY where Encompass says there is one — c-A carries a count, c-B does not, and a condition with nothing to say costs no call at all');

    const attach = await db.query(
      `SELECT a.encompass_uri, a.file_size FROM lt_document_attachments a
         JOIN lt_documents d ON d.id = a.document_id
        WHERE d.loan_id = $1::uuid`, [loanId]);
    check(attach.rows.length === 1 && attach.rows[0].encompass_uri === 'https://enc/att/a-1',
      'the attachment keeps the URI — the pointer, never the bytes');
    check(String(attach.rows[0].file_size) === '4210233',
      'and a real file size survives the round trip through a bigint column');

    // ── status_open is stored as Encompass stated it ────────────────────────
    console.log('\nEncompass\'s own outstanding flag is what is stored');
    const flags = await db.query(
      `SELECT encompass_condition_id, status_open, status FROM lt_conditions
        WHERE loan_id = $1::uuid ORDER BY encompass_condition_id`, [loanId]);
    check(flags.rows[0].status_open === true && flags.rows[1].status_open === false,
      'their true and their false are both mirrored, never re-derived from the status word');

    // ── The link, including the one we could not resolve ────────────────────
    console.log('\nthe document -> condition link');

    const links = await db.query(
      `SELECT l.encompass_condition_id, l.condition_id
         FROM lt_document_conditions l JOIN lt_documents d ON d.id = l.document_id
        WHERE d.loan_id = $1::uuid ORDER BY l.encompass_condition_id`, [loanId]);
    check(links.rows.length === 2, 'both links are recorded');
    const ghost = links.rows.find((r) => r.encompass_condition_id === 'c-GHOST');
    const real = links.rows.find((r) => r.encompass_condition_id === 'c-A');
    check(!!real && real.condition_id !== null,
      'a link to a condition we hold is RESOLVED to our row');
    check(!!ghost && ghost.condition_id === null,
      'and a link to one we have NOT mirrored is still STORED, unresolved — a foreign key alone would have dropped exactly the links most worth having');

    // The ghost arrives later — on the CONDITIONS read alone. The eFolder is
    // deliberately NOT read again here: if the link only filled itself in on the
    // next document read, an officer would sit in front of a condition showing no
    // documents for hours while the papers that answered it were already mirrored.
    const client2 = stubClient([COND_A, COND_B, { id: 'c-GHOST', title: 'Arrived late', statusOpen: true }], [DOC_1, DOC_2]);
    const late = await sync.syncConditionsForLoan(loanId, GUID, { client: client2 });
    check(late.ok && late.resolved === 1, 'the conditions read reports the dangling link it just settled');
    const resolved = await db.query(
      `SELECT l.condition_id FROM lt_document_conditions l
         JOIN lt_documents d ON d.id = l.document_id
        WHERE d.loan_id = $1::uuid AND l.encompass_condition_id = 'c-GHOST'`, [loanId]);
    check(resolved.rows.length === 1 && resolved.rows[0].condition_id !== null,
      'and it resolves itself once that condition is mirrored — the two reads may land in either order');

    // ── A second read updates, it does not duplicate ────────────────────────
    console.log('\nreading the same loan again');
    const before = await db.query('SELECT count(*)::int AS n FROM lt_conditions WHERE loan_id = $1::uuid', [loanId]);
    const client3 = stubClient([{ ...COND_A, status: 'Cleared', statusOpen: false }, COND_B,
      { id: 'c-GHOST', title: 'Arrived late', statusOpen: true }], [DOC_1, DOC_2]);
    await sync.syncConditionsForLoan(loanId, GUID, { client: client3 });
    const after = await db.query('SELECT count(*)::int AS n FROM lt_conditions WHERE loan_id = $1::uuid', [loanId]);
    check(before.rows[0].n === after.rows[0].n, 'a second read stores no duplicate rows');
    const moved = await db.query(
      `SELECT status, status_open FROM lt_conditions WHERE loan_id = $1::uuid AND encompass_condition_id = 'c-A'`,
      [loanId]);
    check(moved.rows[0].status === 'Cleared' && moved.rows[0].status_open === false,
      'and a condition that CHANGED is updated in place');

    // ── Nothing is ever deleted ─────────────────────────────────────────────
    console.log('\na condition that disappears from Encompass');
    const client4 = stubClient([COND_B, { id: 'c-GHOST', title: 'Arrived late', statusOpen: true }], [DOC_1, DOC_2]);
    const c4 = await sync.syncConditionsForLoan(loanId, GUID, { client: client4 });
    check(c4.ok && c4.retired === 1, 'the one that is gone is retired');
    const gone = await db.query(
      `SELECT is_removed FROM lt_conditions WHERE loan_id = $1::uuid AND encompass_condition_id = 'c-A'`, [loanId]);
    check(gone.rows.length === 1, 'the ROW IS STILL THERE — nothing is deleted, because the record of what was once asked for has to survive');
    check(gone.rows[0].is_removed === true, '…marked removed instead');

    const shown = await read.conditionsForLoan(loanId, { audience: 'internal' });
    check(!shown.items.some((i) => i.encompassId === 'c-A'),
      'and it is filtered out on READ, which is the one place it stops being shown');

    // An EMPTY read must never retire the whole loan.
    console.log('\nan empty read is not a mass withdrawal');
    const emptyClient = stubClient([], []);
    const c5 = await sync.syncConditionsForLoan(loanId, GUID, { client: emptyClient });
    const survivors = await db.query(
      `SELECT count(*)::int AS n FROM lt_conditions WHERE loan_id = $1::uuid AND is_removed = false`, [loanId]);
    check(c5.ok && survivors.rows[0].n > 0,
      'an empty answer changes nothing — far more likely an outage or a filter change than every condition being withdrawn at once');

    // ── The read inverts the link ───────────────────────────────────────────
    console.log('\nwhat the screen gets');
    const client6 = stubClient([COND_A, COND_B], [DOC_1, DOC_2]);
    await sync.syncConditionsForLoan(loanId, GUID, { client: client6 });
    await sync.syncDocumentsForLoan(loanId, GUID, { client: client6 });

    const center = await read.centerForLoan(loanId, { audience: 'internal' });
    check(center.face === 'conditions', 'a loan with conditions shows the conditions face');
    const entity = center.conditions.items.find((i) => i.encompassId === 'c-A');
    check(!!entity && entity.documents.length === 1 && entity.documents[0].title === 'Appraisal',
      'and each condition carries the documents that answer it — built by INVERTING the link, since Encompass has no condition->documents endpoint');
    check(center.conditions.items[0].open === true,
      'the outstanding one is first');
    check(center.documents.total === 2 && center.documents.outstanding === 1,
      'the eFolder needs list counts what is still wanted');
    check(center.sync.conditionsSyncedAt instanceof Date,
      'and the screen can say when this was last read, so it is not asking to be believed on nothing');

    // ── The conversation on a condition ─────────────────────────────────────
    console.log('\nthe thread on a condition');

    const M1 = { id: 'm-1', comments: 'Sent the request to the borrower.', createdBy: { entityId: '17', entityName: 'Malky' }, dateCreated: '2026-06-02T10:00:00Z' };
    const M2 = { id: 'm-2', comments: 'Operating agreement received — checking the members.', createdBy: { entityId: '42', entityName: 'Evolve API' }, dateCreated: '2026-06-03T11:30:00Z' };
    const M_NO_ID = { comments: 'A comment that arrived without an id.', createdBy: { entityName: 'Nobody' }, dateCreated: '2026-06-04T09:00:00Z' };

    // Encompass says THREE; two of them can be keyed and one cannot.
    const CHATTY = { ...COND_A, commentsCount: 3 };
    const client7 = stubClient([CHATTY, COND_B], [DOC_1, DOC_2], { 'c-A': [M1, M2, M_NO_ID] });
    const c7 = await sync.syncConditionsForLoan(loanId, GUID, { client: client7 });
    check(c7.ok && c7.comments && c7.comments.stored === 2,
      'the thread is mirrored beside the condition — a table nobody fills can only ever answer "nothing"');
    check(c7.comments.unreadable === 1,
      'and a comment with NO id is COUNTED, not stored: the key is partial, so storing it would insert the same sentence again on every pass — and inventing an id would put our own value in a column that says it came from Encompass');

    const thread1 = await db.query(
      `SELECT m.encompass_comment_id, m.body, m.author_name, m.commented_at
         FROM lt_condition_comments m JOIN lt_conditions c ON c.id = m.condition_id
        WHERE c.loan_id = $1::uuid ORDER BY m.commented_at`, [loanId]);
    check(thread1.rows.length === 2 && thread1.rows[0].author_name === 'Malky',
      'each comment is its own row, with who said it and when');

    // A second read UPDATES — that is a claim about the PARTIAL unique index and
    // its ON CONFLICT predicate, which only Postgres can settle.
    const edited = { ...M2, comments: 'Operating agreement received — members confirmed.' };
    const client8 = stubClient([CHATTY, COND_B], [DOC_1, DOC_2], { 'c-A': [M1, edited] });
    await sync.syncConditionsForLoan(loanId, GUID, { client: client8 });
    const thread2 = await db.query(
      `SELECT m.encompass_comment_id, m.body FROM lt_condition_comments m
         JOIN lt_conditions c ON c.id = m.condition_id
        WHERE c.loan_id = $1::uuid ORDER BY m.commented_at`, [loanId]);
    check(thread2.rows.length === 2, 'reading it again stores no duplicate');
    check(/members confirmed/.test(thread2.rows[1].body),
      'and a comment that was EDITED is updated in place');

    // A thread we cannot read must never cost us the conditions.
    const angryThread = stubClient([CHATTY, COND_B], [DOC_1, DOC_2], { 'c-A': 'boom' });
    const c9 = await sync.syncConditionsForLoan(loanId, GUID, { client: angryThread });
    check(c9.ok === true && c9.comments.failed === 1 && c9.comments.stored === 0,
      'a thread that will not read is REPORTED, and the conditions still land — losing the conditions over a comments outage would be the expensive direction');
    const survivingThread = await db.query(
      `SELECT count(*)::int AS n FROM lt_condition_comments m
         JOIN lt_conditions c ON c.id = m.condition_id WHERE c.loan_id = $1::uuid`, [loanId]);
    check(survivingThread.rows[0].n === 2,
      '…and the comments we already hold are left alone: an absence is not a withdrawal');

    // The cap is MEASURED, not assumed from a full page.
    const bothChatty = stubClient(
      [CHATTY, { ...COND_B, commentsCount: 2 }], [DOC_1, DOC_2],
      { 'c-A': [M1], 'c-B': [M2] },
    );
    await sync.syncConditionsForLoan(loanId, GUID, { client: bothChatty });
    const capped = await sync.syncCommentsForLoan(loanId, GUID, { client: bothChatty, commentCap: 1 });
    check(capped.threads === 1 && capped.more === true,
      'a capped pass says there are more — a silent cap reads as "that is everything there was"');

    // What the screen gets, and what a client does NOT.
    const staffCenter = await read.centerForLoan(loanId, { audience: 'internal' });
    const staffCond = staffCenter.conditions.items.find((i) => i.encompassId === 'c-A');
    check(!!staffCond && staffCond.comments.length >= 1 && !!staffCond.comments[0].author,
      'the screen gets the conversation, with its author');
    check(staffCond.commentCount === 3,
      'and Encompass\'s OWN count beside it, so a thread shorter than the count can say so instead of reading as the whole story');
    const clientCenter = await read.centerForLoan(loanId, { audience: 'borrower' });
    const clientCond = clientCenter.conditions.items.find((i) => i.encompassId === 'c-A');
    check(!!clientCond && clientCond.comments.length === 0 && clientCond.commentCount === null,
      'a client is sent neither the conversation nor the count — a comment is our own reasoning about their file, and the investor scrub knows about NAMES, not about a paragraph of internal thinking');

    // ── A failure is recorded on the loan, not swallowed ────────────────────
    console.log('\na loan that cannot be read says so');
    const angry = {
      configured: () => true,
      async apiGet() { throw new Error('LT Encompass 503: upstream is having a moment'); },
    };
    const bad = await sync.syncConditionsForLoan(loanId, GUID, { client: angry });
    check(bad.ok === false && /503/.test(bad.reason), 'the failure is returned rather than thrown at the sweep');
    const stamped = await db.query('SELECT conditions_sync_error FROM lt_loans WHERE id = $1::uuid', [loanId]);
    check(/503/.test(String(stamped.rows[0].conditions_sync_error || '')),
      'and it is RECORDED ON THE LOAN — a sync that fails silently is worse than one that fails loudly');

    const okAgain = await sync.syncConditionsForLoan(loanId, GUID, { client: stubClient([COND_A], []) });
    const cleared = await db.query('SELECT conditions_sync_error FROM lt_loans WHERE id = $1::uuid', [loanId]);
    check(okAgain.ok && cleared.rows[0].conditions_sync_error === null,
      'a later good read clears it, so an old failure cannot haunt a healthy file');

    // ── The switch really is the switch ─────────────────────────────────────
    console.log('\nthe feature switch');
    const swept = await sync.syncOnce({ client: stubClient([], []) });
    check(swept.ok === false && /switched off|not connected/i.test(swept.reason || ''),
      'with conditions.enabled off (its default), a sweep reads NOTHING and says why — the placeholder on the screen is not a lie told while the data flows anyway');

    // ── SOMETHING ACTUALLY CALLS IT ─────────────────────────────────────────
    // The read side shipped able to answer only "nothing", because the sweep had
    // no caller anywhere in the repository: the mirror could never fill, and no
    // test of the sweep itself could notice. Read the SOURCE, because that is the
    // only place the wiring exists.
    console.log('\nthe sweep is actually wired to something');
    const syncRoute = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/routes/sync.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(/require\(['"]\.\.\/conditions\/sync['"]\)/.test(syncRoute),
      'the sync door knows the Condition Center exists');
    check(/conditionSync\.syncOnce\(/.test(syncRoute),
      '…and calls the sweep — a mirror nothing ever fills can only ever answer "nothing"');
    check((syncRoute.match(/conditionSync\.syncOnce\(/g) || []).length >= 2,
      'from BOTH doors: the whole-book pass carries it along, and it has its own door for reading the centre again without re-reading every loan');
    check(/router\.post\(['"]\/conditions['"],\s*requireSyncAdmin/.test(syncRoute),
      'and that door is ADMIN-gated like every other pass — a bounded but real burst of Encompass reads');

    // A hand-run pass means "read them again NOW". `> 0` would have silently
    // turned that into the ordinary refresh age and re-read almost nothing.
    const zeroDue = await sync._internals.dueLoans(db, 50, 0);
    check(zeroDue.some((r) => r.id === loanId),
      'asking for a refresh age of ZERO re-reads a loan that was just read — which is what pressing the button by hand means');
  } finally {
    if (loanId) {
      // One DELETE: every mirror row cascades from the loan.
      await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  console.error('FAIL unexpected error:', (e && e.message) || e);
  process.exit(1);
});
