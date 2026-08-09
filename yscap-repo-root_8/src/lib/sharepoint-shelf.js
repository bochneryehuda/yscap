/**
 * WHICH SHELF A DOCUMENT SITS ON IN SHAREPOINT — pure, one definition.
 *
 * Owner-directed 2026-08-03, immediately after the acceptance rule
 * (lib/document-acceptance.js) stopped un-accepted documents leaving the
 * building: *"yes do the sharepoint folder too. Well, the SharePoint folder
 * should also have saved the old versions. Even though it gets rejected, we
 * should always still save copies in folders. So we should have a folder with
 * all old versions and old old versions to be placed in the old version
 * folder."*
 *
 * So the mirror still saves EVERY document — that is not negotiable, it is the
 * backup and its standing policy is that nothing is ever deleted — but the
 * category folder stops being a pile. Three shelves, each named for what is
 * actually on it:
 *
 *     Insurance/                        <- LIVE: accepted, current. Exactly what
 *         binder.pdf                       the TPR export ships, so browsing the
 *         invoice.pdf                      folder answers "what goes out?".
 *         Waiting for review/           <- somebody still has to look at these
 *             new-endorsement.pdf
 *         Old Versions/                 <- rejected, and superseded older copies
 *             Version 1/
 *                 old-carrier-binder.pdf
 *
 * WHY A DOCUMENT MOVES RATHER THAN BEING FILED ONCE. A document is mirrored
 * within seconds of upload, which is long before anybody has reviewed it — so
 * its shelf is not knowable at mirror time and cannot be. Every human upload
 * lands on "Waiting for review" and is MOVED when the verdict arrives (up to the
 * category folder on accept, into Old Versions on reject or when a newer copy
 * supersedes it). That is what `sharepoint-backup.refileOnce` does, through
 * `sp.moveOwnItem` — our own copy, out of a folder we created, into a folder we
 * created, with the same guards the Version-N shuffle has always used.
 *
 * NOTHING IS EVER DELETED, and nothing a human touched is ever moved: a copy
 * whose parent is not where our records say refuses the move and is left alone
 * forever.
 *
 * Pure on purpose — no DB, no Graph — so the decision is unit-testable and so
 * the mirror and the re-file sweep can never disagree about where a document
 * belongs.
 */
const { isAccepted, isAwaiting } = require('./document-acceptance');

/** The three shelves. `folder` is '' for the category folder itself. */
const SHELF = {
  LIVE: { key: 'live', folder: '' },
  WAITING: { key: 'waiting', folder: 'Waiting for review' },
  OLD: { key: 'old', folder: 'Old Versions' },
};

/** Where old copies are grouped, one folder per shelving event. */
const VERSION_PREFIX = 'Version ';

/** Every shelf folder name, for the guards that must recognise one. */
const SHELF_FOLDERS = [SHELF.WAITING.folder, SHELF.OLD.folder];

/**
 * Which shelf does this document belong on RIGHT NOW?
 *
 * Order matters and is deliberate: a superseded copy is an OLD version whatever
 * its review status says — an accepted binder that a newer binder replaced is
 * history, not the live document, and leaving it on the live shelf is exactly
 * how the reported file ended up showing two binders.
 *
 * @param {{review_status?: string, is_current?: boolean}} row
 * @returns {{key: string, folder: string}}
 */
function shelfFor(row) {
  const current = (row && row.is_current) !== false;   // NULL/undefined reads as current
  if (!current) return SHELF.OLD;
  if (isAccepted(row)) return SHELF.LIVE;
  if (isAwaiting(row)) return SHELF.WAITING;
  return SHELF.OLD;                                    // rejected (or any unknown state) — kept, shelved
}

/** The path segments to append inside the category folder. `version` groups a
    batch of old copies; 0 / absent means the Old Versions folder itself. */
function shelfPath(shelf, version = 0) {
  if (!shelf || !shelf.folder) return [];
  if (shelf.key === SHELF.OLD.key && Number(version) > 0) {
    return [shelf.folder, `${VERSION_PREFIX}${Number(version)}`];
  }
  return [shelf.folder];
}

/** Is this the shelf a document is recorded as living on? A legacy row (mirrored
    before shelving existed) records NULL, which matches nothing — the sweep
    treats it as "unknown, work it out and file it". */
const onShelf = (recorded, shelf) => String(recorded || '') === String(shelf && shelf.key);

module.exports = { SHELF, SHELF_FOLDERS, VERSION_PREFIX, shelfFor, shelfPath, onShelf };
