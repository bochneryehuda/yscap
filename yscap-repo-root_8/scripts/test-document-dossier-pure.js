#!/usr/bin/env node
'use strict';

/**
 * The document DOSSIER + the file AUDIT LOG wording — pure, no database.
 *
 * Owner-directed 2026-08-02: the Documents & exports list said "General upload"
 * for anything not on a condition, and the File activity tab could not answer
 * who did what. This pins the wording and shaping both surfaces now depend on.
 *
 * Everything here is a TOTAL function: it must never throw on a missing field,
 * and it must never invent a fact.
 */
const assert = require('assert');
const D = require('../src/lib/document-dossier');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('document-dossier — the document\'s own story');

// ── 1. THE TITLE — the bug the owner reported ─────────────────────────────
t('the condition is the document\'s name', () => {
  assert.strictEqual(D.documentTitle({ item_label: 'Government photo ID' }), 'Government photo ID');
});
t('a known doc_kind names itself', () => {
  assert.strictEqual(D.documentTitle({ doc_kind: 'term_sheet' }), 'Term sheet');
  assert.strictEqual(D.documentTitle({ doc_kind: 'flood_determination' }), 'Flood determination certificate');
});
t('an UNKNOWN doc_kind is humanized, never shown raw', () => {
  assert.strictEqual(D.documentTitle({ doc_kind: 'some_new_artifact' }), 'Some new artifact');
});
t('"General upload" is GONE — a loose file says what it actually is', () => {
  const title = D.documentTitle({});
  assert.ok(!/general upload/i.test(title), `still says "General upload": ${title}`);
  assert.ok(/not attached to a condition/i.test(title), title);
});
t('an entity / track-record document says so rather than falling through', () => {
  assert.strictEqual(D.documentTitle({ llc_id: 'x' }), 'Vesting-entity document');
  assert.strictEqual(D.documentTitle({ track_record_id: 'x' }), 'Track-record document');
});

// ── 2. WHERE it landed ────────────────────────────────────────────────────
t('a condition upload names the condition AND the slot', () => {
  const p = D.describePlacement({ checklist_item_id: 'c', cond_label: 'Insurance', slot_label: 'Binder' });
  assert.strictEqual(p.where, 'condition');
  assert.strictEqual(p.whereLabel, 'Condition — Insurance');
  assert.ok(p.lines.join(' ').includes('“Insurance”'));
  assert.ok(p.lines.join(' ').includes('“Binder”'));
});
t('a loose file is called a loose file, not a mystery', () => {
  const p = D.describePlacement({});
  assert.strictEqual(p.where, 'file');
  assert.strictEqual(p.unattached, true);
  assert.ok(/nothing is waiting on it/i.test(p.lines.join(' ')));
});
t('a page range split out of a packet is explained', () => {
  const p = D.describePlacement({ page_range: [3, 9], source_document_id: 'parent' });
  assert.ok(/pages 3–9/.test(p.lines.join(' ')), p.lines.join(' '));
  assert.ok(/larger upload/i.test(p.lines.join(' ')));
});
t('a single-page range reads "page 4", not "pages 4–4"', () => {
  assert.strictEqual(D._internals.pageRangeLabel([4, 4]), 'page 4');
});

// ── 3. WHY it exists ──────────────────────────────────────────────────────
t('a GATE says the file cannot move on', () => {
  const p = D.describePurpose({ checklist_item_id: 'c', cond_label: 'Title commitment', cond_is_gate: true });
  assert.ok(/cannot move on/i.test(p.headline), p.headline);
});
t('the words the borrower was actually shown are quoted back', () => {
  const p = D.describePurpose({ checklist_item_id: 'c', cond_label: 'Bank statements', cond_borrower_hint: 'Two months, all pages.' });
  assert.strictEqual(p.asked, 'Two months, all pages.');
  assert.ok(p.why.some((w) => w.includes('Two months, all pages.')));
});
t('an entity document warns that rejecting it un-verifies the entity', () => {
  const p = D.describePurpose({ llc_id: 'x' });
  assert.ok(p.why.some((w) => /un-verifies the vesting entity/i.test(w)));
});

// ── 4. THE HISTORY ────────────────────────────────────────────────────────
t('the timeline is CHRONOLOGICAL — a document reads as a story', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-03T00:00:00Z', filename: 'a.pdf' },
    audits: [{ action: 'download_document', created_at: '2026-01-05T00:00:00Z', actor_kind: 'staff', actor_name: 'Ann' }],
    extractions: [{ created_at: '2026-01-04T00:00:00Z', doc_type: 'bank_statement', confidence: 'definite' }],
  });
  const times = tl.map((e) => e.at);
  assert.deepStrictEqual(times, [...times].sort());
});
t('an accept is NOT allowed to erase the upload from the history', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-01T00:00:00Z', filename: 'a.pdf', review_status: 'accepted', reviewed_at: '2026-01-02T00:00:00Z' },
  });
  assert.ok(tl.some((e) => e.code === 'uploaded'), 'the upload event vanished');
  assert.ok(tl.some((e) => e.code === 'accept_document'));
});
t('the audit row WINS over the derived verdict — no double-counting', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-01T00:00:00Z', review_status: 'rejected', reviewed_at: '2026-01-02T00:00:00Z', rejection_reason: 'blurry' },
    audits: [{ action: 'reject_document', created_at: '2026-01-02T00:00:00Z', actor_kind: 'staff', actor_name: 'Ann', detail: { reason: 'blurry' } }],
  });
  assert.strictEqual(tl.filter((e) => e.code === 'reject_document').length, 1);
  assert.strictEqual(tl.find((e) => e.code === 'reject_document').actor, 'Ann');
});
t('a rejection always carries its reason', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-01T00:00:00Z', review_status: 'rejected', reviewed_at: '2026-01-02T00:00:00Z', rejection_reason: 'page 2 missing' },
  });
  assert.ok(tl.some((e) => /page 2 missing/.test(e.detail || '')));
});
t('a SharePoint failure is reported, not swallowed', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-01T00:00:00Z', sharepoint_backup_error: 'graph 503', sharepoint_backup_attempted_at: '2026-01-02T00:00:00Z', sharepoint_backup_attempts: 3 },
  });
  const e = tl.find((x) => x.code === 'sp_failed');
  assert.ok(e && /graph 503/.test(e.detail) && /3 attempts/.test(e.detail), JSON.stringify(e));
});
t('"did it answer the condition" is a first-class event with what is still missing', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-01T00:00:00Z' },
    proofs: [{ created_at: '2026-01-02T00:00:00Z', result: 'partially_satisfied',
      requirements_json: [{ label: 'Back of the ID', status: 'not_satisfied' }, { label: 'Front', status: 'satisfied' }] }],
  });
  const e = tl.find((x) => x.code === 'clearance_proof');
  assert.ok(/PARTLY/.test(e.title), e.title);
  assert.ok(/Still missing: Back of the ID/.test(e.detail), e.detail);
  assert.ok(!/Front/.test(e.detail), 'a satisfied requirement must not be listed as missing');
});
t('an event with no timestamp SINKS — it never pretends to be the oldest thing', () => {
  const tl = D.buildTimeline({
    doc: { created_at: '2026-01-05T00:00:00Z' },
    audits: [{ action: 'ocr_document', created_at: null }],
  });
  assert.strictEqual(tl[tl.length - 1].at, null);
});
t('every side table is optional — an empty dossier never throws', () => {
  assert.doesNotThrow(() => D.buildTimeline({}));
  assert.doesNotThrow(() => D.buildTimeline({ doc: null, audits: null, versions: 'nonsense' }));
  assert.doesNotThrow(() => D.buildDossier({}));
  assert.doesNotThrow(() => D.buildDossier(null));
});

// ── 5. THE ACCESS LEDGER ──────────────────────────────────────────────────
t('a REFUSED attempt is kept — that is exactly what an audit looks for', () => {
  const a = D.buildAccess([{ at: '2026-01-01T00:00:00Z', actor_email: 'bob@x.com', method: 'GET', path: '/api/staff/documents/d/download', status: 403 }], []);
  assert.strictEqual(a[0].denied, true);
  assert.ok(/REFUSED/.test(a[0].what), a[0].what);
});
t('a preview is told apart from a download', () => {
  assert.strictEqual(D._internals.accessVerb('GET', '/api/staff/documents/d/download?inline=1', 200), 'Previewed the document');
  assert.strictEqual(D._internals.accessVerb('GET', '/api/staff/documents/d/download', 200), 'Downloaded the document');
});
t('the ledger is newest-first and de-duplicates the audit copy of a download', () => {
  const a = D.buildAccess(
    [{ at: '2026-01-02T00:00:00Z', actor_email: 'ann@x.com', method: 'GET', path: '/download', status: 200 }],
    [{ action: 'download_document', created_at: '2026-01-02T00:00:00Z', actor_name: 'Ann' },
      { action: 'download_document', created_at: '2026-01-01T00:00:00Z', actor_name: 'Ann' }]);
  assert.strictEqual(a.length, 2, 'the same download was counted twice');
  assert.ok(new Date(a[0].at) > new Date(a[1].at));
});

// ── 6. STATE WORDING ──────────────────────────────────────────────────────
t('the mirror state falls back to the old columns when the FSM has not run', () => {
  assert.strictEqual(D.mirrorStatus({ sharepoint_backed_up_at: '2026-01-01' }).code, 'DONE');
  assert.strictEqual(D.mirrorStatus({ sharepoint_skipped_reason: 'never mirror' }).code, 'SKIPPED');
  assert.strictEqual(D.mirrorStatus({ sharepoint_backup_attempts: 2 }).code, 'FAILED');
  assert.strictEqual(D.mirrorStatus({}).code, 'PENDING');
});
t('an explicit FSM status always wins over the fallback', () => {
  assert.strictEqual(D.mirrorStatus({ sharepoint_mirror_status: 'DEAD', sharepoint_backed_up_at: '2026-01-01' }).code, 'DEAD');
});
t('integrity is read by PREFIX — a mismatch is never mistaken for "ok"', () => {
  assert.strictEqual(D.integrityLabel('ok 2026-01-01').tone, 'ok');
  assert.strictEqual(D.integrityLabel('mismatch size 100 vs 200').tone, 'bad');
  assert.strictEqual(D.integrityLabel('item-missing').tone, 'bad');
  assert.strictEqual(D.integrityLabel(''), null);
});
t('a whole dossier keeps its counts honest', () => {
  const out = D.buildDossier({
    doc: { id: 'd', filename: 'a.pdf', created_at: '2026-01-01T00:00:00Z', size_bytes: 2048 },
    findings: [{ created_at: '2026-01-02T00:00:00Z', severity: 'warning', code: 'x', status: 'open' },
      { created_at: '2026-01-02T00:00:00Z', severity: 'info', code: 'y', status: 'resolved' }],
  });
  assert.strictEqual(out.counts.findings, 2);
  assert.strictEqual(out.counts.openFindings, 1);
  assert.strictEqual(out.identity.size, '2 KB');
  assert.strictEqual(out.counts.events, out.timeline.length);
});

// ── 7. THE ACTIVITY FEED'S SHAPING ────────────────────────────────────────
const A = require('../src/lib/activity');
console.log('activity — the file audit log');
t('a field-level change renders as a before → after line', () => {
  const s = A._internals.summarizeDetail({ changes: { purchase_price: { from: 100000, to: 120000 } } });
  assert.ok(/Purchase price/.test(s) && /→/.test(s), s);
});
t('the file id is never printed back as a "change"', () => {
  const s = A._internals.summarizeDetail({ applicationId: 'abc', reason: 'why' });
  assert.ok(!/abc/.test(s), s);
  assert.ok(/why/.test(s));
});
t('a row always has the audit fields, even from a sparse caller', () => {
  const r = A._internals.row({ verb: 'did a thing' });
  for (const k of ['at', 'kind', 'cat', 'source', 'actor', 'actor_name', 'actor_role',
    'impersonator', 'verb', 'label', 'entity_type', 'entity_id', 'detail', 'ip', 'user_agent']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.strictEqual(r.borrower_safe, false);
});
t('summarizing a detail blob never throws and never dumps a nested object', () => {
  assert.doesNotThrow(() => A._internals.summarizeDetail(null));
  const s = A._internals.summarizeDetail({ list: [1, 2, 3], nested: { a: 1 } });
  assert.ok(/3 items/.test(s), s);
  assert.ok(!/\{/.test(s), s);
});

// ── THE ON-BEHALF-OF HOLE, CLOSED ────────────────────────────────────────────
// An action taken inside a borrower-view session is recorded under the
// BORROWER's identity — that is who the session ran as. The file audit log
// already names the real human; the dossier did not, so a staffer's upload or
// download read as the borrower's own act. These pin both halves.
t('the timeline names the real human behind a borrower-view session', () => {
  const tl = D.buildTimeline({
    doc: { id: 'd1', created_at: '2026-01-01T00:00:00Z' },
    audits: [{
      created_at: '2026-01-02T00:00:00Z', action: 'accept_document',
      actor_kind: 'borrower', actor_name: 'Sam Borrower',
      impersonator_name: 'Dov Klein', detail: {},
    }],
  });
  const ev = tl.find((e) => e.code === 'accept_document');
  assert.ok(ev, 'the accept event is in the timeline');
  assert.strictEqual(ev.impersonator, 'Dov Klein');
  assert.ok(/Dov Klein/.test(ev.detail), 'the real human is named in the detail');
  assert.ok(/signed in as this borrower/i.test(ev.detail), ev.detail);
  assert.strictEqual(ev.tone, 'warn', 'an on-behalf-of action is never rendered as routine');
});
t('an ordinary action carries no impersonator and keeps its own tone', () => {
  const tl = D.buildTimeline({
    doc: { id: 'd1', created_at: '2026-01-01T00:00:00Z' },
    audits: [{ created_at: '2026-01-02T00:00:00Z', action: 'accept_document',
      actor_kind: 'staff', actor_name: 'Dov Klein', detail: {} }],
  });
  const ev = tl.find((e) => e.code === 'accept_document');
  assert.strictEqual(ev.impersonator, null);
  assert.notStrictEqual(ev.tone, 'warn');
});
t('the access ledger names the real human on a preview or download', () => {
  const acc = D.buildAccess([
    { at: '2026-01-03T00:00:00Z', method: 'GET', path: '/documents/d1/download',
      status: 200, actor_kind: 'borrower', actor_email: 'sam@example.com',
      impersonator_name: 'Dov Klein' },
    { at: '2026-01-04T00:00:00Z', method: 'GET', path: '/documents/d1/download',
      status: 200, actor_kind: 'staff', actor_email: 'lisa@example.com' },
  ], []);
  const imp = acc.find((a) => a.who === 'sam@example.com');
  assert.strictEqual(imp.impersonator, 'Dov Klein');
  const plain = acc.find((a) => a.who === 'lisa@example.com');
  assert.strictEqual(plain.impersonator, null, 'an ordinary read is never mislabelled');
});

console.log(`\n${n} assertions passed.`);
