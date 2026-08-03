/**
 * WHICH SHELF A DOCUMENT SITS ON IN SHAREPOINT — pure.
 *
 * Owner-directed 2026-08-03, right after the acceptance rule stopped unreviewed
 * documents leaving the building: *"yes do the SharePoint folder too. Well, the
 * SharePoint folder should also have saved the old versions. Even though it gets
 * rejected, we should always still save copies in folders. So we should have a
 * folder with all old versions and old old versions to be placed in the old
 * version folder."*
 *
 * So the mirror still saves EVERYTHING — that is the point of a backup, and its
 * standing policy is that nothing is ever deleted — but the category folder stops
 * being a pile:
 *
 *     Insurance/                        accepted + current (what the export ships)
 *     Insurance/Waiting for review/     nobody has decided on it yet
 *     Insurance/Old Versions/Version N/ rejected + superseded, grouped per batch
 *
 * This pins the decision itself, plus the source guards that keep the mirror and
 * the sweep from ever disagreeing about it.
 */
const fs = require('fs');
const path = require('path');
const S = require('../src/lib/sharepoint-shelf');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const shelf = (row) => S.shelfFor(row).key;

/* ── the decision ─────────────────────────────────────────────────────────── */

assert(shelf({ review_status: 'accepted', is_current: true }) === 'live',
  'an accepted, current document sits in the category folder — exactly what the export ships');
assert(shelf({ review_status: 'pending', is_current: true }) === 'waiting',
  'a document nobody has decided on waits in "Waiting for review"');
assert(shelf({ is_current: true }) === 'waiting',
  'no review_status reads as pending (the db/013 default), so it waits');
assert(shelf({ review_status: 'rejected', is_current: true }) === 'old',
  'a REJECTED document is still SAVED — it just moves to "Old Versions"');
assert(shelf({ review_status: 'superseded', is_current: false }) === 'old',
  'a superseded copy is an old version');

// THE ORDER MATTERS: a superseded copy is history whatever its review said.
assert(shelf({ review_status: 'accepted', is_current: false }) === 'old',
  'an ACCEPTED document a newer one replaced is an OLD VERSION, not the live one');
assert(shelf({ review_status: 'pending', is_current: false }) === 'old',
  'and so is a pending one that was replaced');

// A missing is_current must never demote a live document.
assert(shelf({ review_status: 'accepted' }) === 'live',
  'an absent is_current reads as current — a NULL must not bury a live document');
assert(shelf(null) === 'waiting', 'a missing row is safe (and never claims to be live)');
assert(shelf({ review_status: 'nonsense', is_current: true }) === 'old',
  'an unrecognised state is SHELVED, never left on the live shelf — fail closed');

/* ── the shelf FOLDER PATHS ───────────────────────────────────────────────── */

assert(S.shelfPath(S.SHELF.LIVE).length === 0,
  'the live shelf IS the category folder — no extra segment');
assert(S.shelfPath(S.SHELF.WAITING).join('/') === 'Waiting for review',
  'waiting has one folder');
assert(S.shelfPath(S.SHELF.OLD).join('/') === 'Old Versions',
  'an old copy with no batch lands in Old Versions itself');
assert(S.shelfPath(S.SHELF.OLD, 3).join('/') === 'Old Versions/Version 3',
  'a shelved BATCH gets its own Version folder INSIDE Old Versions — the owner’s "old versions and old old versions"');
assert(S.shelfPath(S.SHELF.WAITING, 3).join('/') === 'Waiting for review',
  'a version number never applies to the waiting shelf');
assert(S.shelfPath(S.SHELF.LIVE, 3).length === 0,
  'nor to the live one — the live document is never buried in a Version folder');

// The names are short on purpose: SharePoint has a ~400-char path ceiling and
// Windows/OneDrive refuse to OPEN a file past 259.
for (const f of S.SHELF_FOLDERS) {
  assert(f.length <= 20, `"${f}" is short enough not to eat the path budget`);
}

/* ── the recorded-shelf comparison ────────────────────────────────────────── */

assert(S.onShelf('live', S.SHELF.LIVE) === true, 'a matching record is recognised');
assert(S.onShelf('waiting', S.SHELF.LIVE) === false, 'a mismatch is caught');
assert(S.onShelf(null, S.SHELF.LIVE) === false,
  'a legacy row (mirrored before shelving existed) never counts as already-filed — the sweep works it out and files it');

/* ── source guards ────────────────────────────────────────────────────────── */

const backup = read('src/lib/sharepoint-backup.js');

assert(/const shelf = shelves\.shelfFor\(row\)/.test(backup),
  'the mirror asks the shared rule where a document goes — it never re-derives it');
assert(/shelves\.shelfPath\(shelf, version\)/.test(backup),
  'and builds the folder path from that same rule');
assert(/async function refileRow/.test(backup) && /async function refileOnce/.test(backup),
  'the sweep that MOVES a copy when its verdict lands exists');

// The sweep has to land on the SAME folder the mirror recorded, and the key it
// looks that folder up by runs through the categoriser — which reads the
// condition label, the template code, the LLC name and the track-record address.
// A hand-written SELECT that drops any of them files the document under a
// different key, the lookup misses, and the row is skipped forever.
assert(/async function refileBatch\(limit\) \{[\s\S]{0,200}\$\{ENRICH_SELECT\}/.test(backup),
  'the sweep selects through the SHARED enrichment, so it can never categorise a document differently than the mirror did');
assert(/sp\.moveOwnItem\(driveId, itemId, parentId, \{ expectedParentId: row\.sharepoint_parent_id \}\)/.test(backup),
  'and it moves through moveOwnItem pinned to where OUR OWN records say the copy is');

// NOTHING IS EVER DELETED. This is the rule the whole SharePoint policy rests
// on, and the shelving work is the first thing in a year to move items around
// in bulk — so it gets its own guard.
assert(!/sp\.remove\(|deleteReplacedCorruptMirror/.test(
  backup.slice(backup.indexOf('async function refileBatch'), backup.indexOf('async function verifyOnce'))),
  'the entire re-filing path contains no delete of any kind');

// A human's arrangement wins, permanently.
assert(/humanIntervened[\s\S]{0,400}left where a human put it/.test(backup),
  'a copy a human moved or renamed is left alone and recorded, never forced');

// The retired machinery must not creep back: it MIGRATED the live set into an
// ever-deeper Version-N folder and left the category folder empty.
assert(!/function isSupersedeEvent|function shuffleRootIntoVersion1/.test(backup),
  'the old supersede/Version-N shuffle is retired, not left as dead code beside its replacement');

const spClient = read('src/lib/sharepoint.js');
assert(/sanctioned caller is `sharepoint-backup\.refileRow`/i.test(spClient),
  'moveOwnItem names its one sanctioned caller, so the next reader knows what may use it');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nsharepoint-shelf: all assertions passed');
process.exit(failures ? 1 : 0);
