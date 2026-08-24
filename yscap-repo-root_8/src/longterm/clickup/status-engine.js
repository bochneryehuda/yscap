'use strict';
/**
 * LONG-TERM — the STATUS ENGINE: which ClickUp status a loan's card should
 * hold, decided from Encompass's own milestone ladder. Owner-directed
 * 2026-08-23 (sent three times), the rules verbatim:
 *
 *   create at "starting"; LO Prep done → assigned to processor; Submittal done
 *   → non-del imported BA (non-del / brokered / table-funded) or delegate
 *   initial; Cond Approval done → workflow; CTC done → clear to close;
 *   Schedule Closing done → scheduling closing; Ready for Docs done → active
 *   closing; Funded done → closed; Investor Delivery done → in purchase
 *   review; Purchased done → PA issued post closing; Final Docs done → closed
 *   and reconciled; 1393 withdrawn/declined or the Adverse folder → cancelled;
 *   On Hold folder → on hold, back → workflow. **Encompass always wins, even
 *   after manual changes.**
 *
 * KEYED ON THE LADDER'S DONE FLAGS (lt_loan_milestones, db/623) — never on
 * MS.STATUS wording, which is frozen tenant prose that renames leave stale
 * ('File started' vs 'Started' on one book). Ladders are PER LOAN, so the map
 * below keys on normalized milestone NAMES and an unmapped milestone simply
 * inherits the last mapped one before it (Loan Setup, Waiting for Docs,
 * Processing, Resubmittal, Docs Out, Wire Order carry no status of their own).
 *
 * The ClickUp status strings are the live officer-list vocabulary (verified
 * against src/clickup/status.js EXTERNAL_FOR and the live workspace) — note
 * 'pa issued-post closing.' really does end in a period. Statuses are
 * LIST-level on this workspace, so the writer resolves the list's own exact
 * spelling before an update and SKIPS (reported) a status the destination
 * list does not carry — never an invented string.
 *
 * "Back from hold → workflow": the ladder decision IS the generalization —
 * a file leaving the On Hold folder lands wherever its milestones say it is,
 * which for a mid-underwriting file is exactly 'workflow' (Encompass wins).
 *
 * PURE — no database, no client. push.js hands it the ladder + folder + the
 * live 1393/channel values and enforces the answer.
 */

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Normalized milestone name -> the ClickUp status its COMPLETION drives.
 * `channel` rows resolve per funding channel at decision time. */
const MILESTONE_STATUS = new Map([
  ['started', 'starting'],
  ['lo prep', 'assigned to processor'],
  ['submittal', { channel: true }],
  ['submitted', { channel: true }],
  ['cond approval', 'workflow'],
  ['conditional approval', 'workflow'],
  ['clear to close', 'ctc (4-email)'],
  ['ctc', 'ctc (4-email)'],
  ['schedule closing', 'scheduling closing'],
  ['scheduling closing', 'scheduling closing'],
  ['ready for docs', 'active closing'],
  ['funding', 'closed (6-email funded)'],
  ['funded', 'closed (6-email funded)'],
  // 'Closed' is the OLD ladder's name for the funding step (3 legacy loans).
  ['closed', 'closed (6-email funded)'],
  ['investor delivery', 'in purchase review'],
  ['purchasing conditions', 'pa issued-post closing.'],
  ['purchased', 'pa issued-post closing.'],
  ['final docs', 'closed reconciled'],
]);

/** The Submittal fork (owner: "non-del imported BA or delegate initial").
 * `channelLabel` is the mapper's OWN channel answer ('Non Del Correspondent',
 * 'Table funding', 'Wholesale', 'Delegate Correspondent', 'Evolve
 * Underwriting') so the status engine and the channel field can never read
 * one loan two ways. Delegate + Evolve take the delegate road; everything
 * else — non-del, table funding, wholesale/brokered, and the unmatched
 * default — takes the imported-BA road, exactly as the owner listed them. */
function submittalStatus(channelLabel) {
  const c = norm(channelLabel);
  if (c === 'delegate correspondent' || c === 'evolve underwriting') return 'delegated initial';
  return 'non del imported ba(2-em)';
}

/** Is the file terminally withdrawn/declined? Field 1393's live vocabulary:
 * 'Loan Originated' 396 / 'Active Loan' 225 / 'Application withdrawn' 87 /
 * 'Application denied' 2. */
function cancelled1393(f1393) {
  const v = norm(f1393);
  return v.includes('withdrawn') || v.includes('denied') || v.includes('declined');
}

/** The tenant's folders (live vocabulary 2026-08-24): 'Withdrawn files',
 * 'On Hold', '(Trash)' — plus the owner's 'Adverse' wording, matched so an
 * adverse folder created later is covered. */
const folderCancelled = (folder) => { const f = norm(folder); return f.includes('withdrawn') || f.includes('adverse'); };
const folderOnHold = (folder) => norm(folder).includes('on hold');

/**
 * The decision. Input:
 *   ladder        [{milestone_name, position, done}] (db/623 rows, any order)
 *   folder        lt_loans.loan_folder
 *   f1393         the live field 1393 value (may be absent)
 *   channelLabel  mapper.channelLabel(CX.TABLEFUNDER) (may be null)
 * Returns { status, reason } — status null = claim nothing (no ladder read
 * yet, and no terminal signal: an absent reading is not evidence).
 */
function desiredStatus({ ladder, folder, f1393, channelLabel } = {}) {
  // Terminal signals outrank the ladder: a cancelled file is cancelled
  // whatever its milestones say, and a held file is held unless it is dead.
  if (cancelled1393(f1393)) return { status: 'cancelled', reason: `field 1393 says "${String(f1393).trim()}"` };
  if (folderCancelled(folder)) return { status: 'cancelled', reason: `the file sits in the "${String(folder).trim()}" folder` };
  if (folderOnHold(folder)) return { status: 'inactive / on hold', reason: 'the file sits in the On Hold folder' };

  const rows = (Array.isArray(ladder) ? ladder : [])
    .filter((r) => r && r.milestone_name)
    .slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  if (!rows.length) return { status: null, reason: 'no milestone ladder has been read for this loan yet' };

  let latest = null;
  for (const r of rows) {
    if (!r.done) continue;
    const mapped = MILESTONE_STATUS.get(norm(r.milestone_name));
    if (!mapped) continue;                       // an unmapped step inherits the last mapped one
    latest = { name: r.milestone_name, mapped };
  }
  if (!latest) return { status: 'starting', reason: 'no mapped milestone is completed yet — the file is starting' };
  const status = latest.mapped && latest.mapped.channel ? submittalStatus(channelLabel) : latest.mapped;
  return { status, reason: `"${latest.name}" is the latest completed milestone` };
}

module.exports = {
  desiredStatus, submittalStatus,
  _internals: { MILESTONE_STATUS, cancelled1393, folderCancelled, folderOnHold, norm },
};
