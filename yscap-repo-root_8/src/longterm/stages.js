'use strict';
/**
 * LONG-TERM — the three stage layers.
 *
 * Owner-directed 2026-08-14: "we're going to use the Encompass stages, but we're
 * going to map those Encompass stages to our own stages. We're not going to have,
 * on the consumer side, all stages from Encompass. You can use the Encompass
 * consumer-visible stages for the consumer side."
 *
 * So a loan carries ONE milestone and TWO stage labels, and they are never
 * conflated:
 *
 *   Encompass milestone      ->   our stage        ->   what the borrower sees
 *   (19, mirrored verbatim)       (ours, 9)             (Encompass's own wording)
 *   "Waiting for Docs"            "Conditions Out"      "Conditionally Approved
 *                                                        - Waiting for Docs"
 *
 * WHY THE BORROWER'S LABEL IS NOT DERIVED FROM OURS. It comes from the milestone's
 * own `consumer_status`, seeded for all 19 rows in db/547. Two hops would let an
 * internal rename leak into what a borrower reads — rename "Conditions Out" to
 * something blunt for staff and a borrower would see it. One hop, from the
 * milestone, cannot.
 *
 * WHY AN UNMAPPED MILESTONE IS SHOWN, NOT HIDDEN. If Encompass gains a milestone
 * tomorrow, a loan sitting at it must still appear in the pipeline — under its raw
 * Encompass name, in an "Other" bucket. Failing closed here would mean a loan
 * silently dropping off every screen, which is far worse than an ugly label.
 *
 * SELLABLE-LOS RULE. The mapping below is OUR default, pre-filled. It is a SETTING
 * (`stages.map`, `stages.order`), so a buyer with different milestones changes it
 * without a migration. Nothing here is hard-coded into a screen.
 *
 * PURE. No database, no network, no RTL import — every function takes what it needs.
 */

/**
 * OUR stages, in pipeline order. Deliberately nine: nineteen milestones is too many
 * to read at a glance, and several of them mean the same thing to us.
 */
const DEFAULT_STAGES = [
  { key: 'new',              label: 'New',              order: 10 },
  { key: 'setup',            label: 'Setup',            order: 20 },
  { key: 'submitted',        label: 'Submitted',        order: 30 },
  { key: 'underwriting',     label: 'In Underwriting',  order: 40 },
  { key: 'conditions_out',   label: 'Conditions Out',   order: 50 },
  { key: 'clear_to_close',   label: 'Clear to Close',   order: 60 },
  { key: 'closing',          label: 'Closing',          order: 70 },
  { key: 'funded',           label: 'Funded',           order: 80 },
  { key: 'post_closing',     label: 'Post-Closing',     order: 90 },
];

/**
 * Encompass milestone name -> our stage key.
 *
 * The 19 names are this tenant's, verified against the live instance on
 * 2026-08-14 (all 19 rows in db/547 matched exactly, zero diffs).
 */
const DEFAULT_MAP = {
  'Started':               'new',
  'LO Prep':               'setup',
  'Loan Setup':            'setup',
  'Submittal':             'submitted',
  'Cond. Approval':        'underwriting',
  'Processing':            'underwriting',
  'Resubmittal':           'underwriting',
  'Waiting for Docs':      'conditions_out',
  'Clear To Close':        'clear_to_close',
  'Schedule Closing':      'closing',
  'Ready for Docs':        'closing',
  'Docs Out':              'closing',
  'Wire Order':            'closing',
  'Funding':               'funded',
  'Investor Delivery':     'post_closing',
  'Purchasing Conditions': 'post_closing',
  'Final Docs':            'post_closing',
  'Closed':                'post_closing',
  'Completion':            'post_closing',
};

/** The bucket an unmapped milestone falls into. Shown, never hidden. */
const UNMAPPED_STAGE = { key: 'other', label: 'Other', order: 999 };

/**
 * Normalise a milestone name for lookup. Encompass names carry stray whitespace
 * and inconsistent casing between the settings catalog and the loan field, and a
 * lookup that misses silently drops a loan into "Other" forever.
 */
function normalizeMilestone(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The PUNCTUATION-BLIND join key for milestone names (pre-merge audit round 2,
 * obs 4). `normalizeMilestone` keeps punctuation, so a ladder spelled
 * "Cond Approval" against a catalog "Cond. Approval" missed every join — the
 * board read `inLadder:false` and dropped the witnessed date. All three sources
 * (ladder, catalog, event log) are one tenant vocabulary that differs only in
 * dots and spacing, so joins key on letters and digits alone.
 */
function milestoneKey(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO WORDINGS OF A MILESTONE (owner-directed 2026-08-24).
 *
 * "Every milestone has two different kinds of wording: before it's completed
 *  and after it's completed. The name of the status in our system should
 *  ALWAYS be the last milestone that is completed [in its completed wording].
 *  When funding is completed, the name of the milestone in our system is
 *  FUNDED. When LO Prep is completed, it's ASSIGNED TO PROCESSOR."
 *
 * So a loan whose ladder shows Funding done and Investor Delivery not yet done
 * is displayed as "Funded" — never "Funding" (the active form, which reads as
 * not-yet-funded) and never "Investor Delivery" (a step that has not happened).
 *
 * WHERE EACH WORDING COMES FROM. Only three kinds of evidence count here, and
 * the weakest of them was REMOVED in audit round 3 (D6) — see the warning below:
 *   · OWNER — stated in the owner's own words (LO Prep, Submittal, Funding,
 *     and the Cond. Approval / Clear to Close stop vocabulary). The strongest.
 *   · CENSUS — a value this tenant's MS.STATUS was actually OBSERVED returning
 *     across the 490-loan live sweep recorded in `encompass/dropdowns.js`
 *     ("File started", "Completed").
 *   · SETTINGS — the tenant's own milestone settings (db/547): Schedule
 *     Closing's external wording is "Closing Scheduled", Resubmittal's is
 *     "In Underwriting". Both re-verified against the seeded catalog.
 *
 * ⚠ DO NOT ADD A WORDING FROM A PER-MILESTONE `MS.STATUS` SAMPLE. That is how
 * "Loan Setup → Sent to Processing" got in, and it was wrong twice over:
 * (1) "Sent to processing" appears ONLY in Encompass's STOCK declared list and
 * was never once observed on this tenant, whose MS.STATUS returns its own
 * milestone names; and (2) MS.STATUS LAGS on older loans, so a per-milestone
 * sample attributes each wording to the milestone one step off wherever the lag
 * is present. A sample of a lagging field against a contradicted vocabulary is
 * not evidence. Use the owner's words, the observed census, or db/547.
 *
 * A milestone with no proven completed wording falls back to ITS OWN NAME —
 * honest, and listed as an open wording question for the owner rather than
 * invented. db/547 seeds NINETEEN milestones and this table covers nine, so ten
 * are open: Loan Setup, Processing, Waiting for Docs, Ready for Docs, Docs Out,
 * Wire Order, Investor Delivery, Purchasing Conditions, Final Docs, Closed.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const COMPLETED_FORM = {
  'started': 'File started',                 // CENSUS (observed on this tenant)
  'lo prep': 'Assigned to Processor',        // OWNER
  'submittal': 'Submitted',                  // OWNER
  'cond approval': 'Conditionally Approved', // OWNER (stop vocabulary)
  'resubmittal': 'In Underwriting',          // SETTINGS (db/547, re-verified)
  'clear to close': 'Clear to Close',        // OWNER (stop vocabulary)
  'schedule closing': 'Closing Scheduled',   // SETTINGS (db/547, re-verified)
  'funding': 'Funded',                       // OWNER
  'completion': 'Completed',                 // CENSUS (observed on this tenant)
};

/**
 * The label a loan wears once a milestone is its LAST COMPLETED one. Falls
 * back to the milestone's own name — never blank, never invented.
 */
function completedFormLabel(milestoneName) {
  const raw = String(milestoneName == null ? '' : milestoneName).trim();
  if (!raw) return null;
  return COMPLETED_FORM[milestoneKey(raw)] || raw;
}

function buildIndex(map) {
  const idx = new Map();
  for (const [milestone, stageKey] of Object.entries(map || {})) {
    idx.set(normalizeMilestone(milestone), stageKey);
  }
  return idx;
}

const DEFAULT_INDEX = buildIndex(DEFAULT_MAP);

/**
 * Which of OUR stages a milestone belongs to.
 *
 * Returns `{key, label, order, mapped}`. `mapped` is false when the milestone is
 * unknown — the caller gets a usable bucket AND can tell it is a fallback, which
 * is what lets a screen show the raw Encompass name beside it.
 */
function stageForMilestone(milestoneName, opts = {}) {
  const stages = opts.stages || DEFAULT_STAGES;
  const index = opts.index || (opts.map ? buildIndex(opts.map) : DEFAULT_INDEX);

  const key = index.get(normalizeMilestone(milestoneName));
  if (!key) return { ...UNMAPPED_STAGE, mapped: false };

  const stage = stages.find((s) => s.key === key);
  // A map naming a stage the stage list does not carry is a misconfiguration, not
  // a reason to lose the loan.
  if (!stage) return { ...UNMAPPED_STAGE, mapped: false };
  return { ...stage, mapped: true };
}

/**
 * What the BORROWER sees. Straight from the milestone's own consumer wording —
 * never from our stage.
 *
 * `milestoneRow` is a row of lt_encompass_milestones (or anything carrying
 * `consumer_status` / `consumerStatus`). With nothing to read it returns null, and
 * a screen shows nothing rather than inventing a status for a borrower.
 */
function consumerStatusOf(milestoneRow) {
  if (!milestoneRow) return null;
  const v = milestoneRow.consumer_status != null ? milestoneRow.consumer_status : milestoneRow.consumerStatus;
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
}

/**
 * What a TPO/broker would see. Not used today — the owner confirmed on 2026-08-14
 * that the long-term client is the borrower, on the login they already have, and
 * there is no broker portal for now. Kept because the tenant publishes the wording
 * per milestone and re-deriving it later from nothing would be guesswork.
 */
function tpoStatusOf(milestoneRow) {
  if (!milestoneRow) return null;
  const v = milestoneRow.tpo_status != null ? milestoneRow.tpo_status : milestoneRow.tpoStatus;
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
}

/**
 * The full stage list for a pipeline's group tabs, in order, with "Other" appended
 * only when something is actually sitting in it — an empty bucket on every screen
 * forever is noise.
 */
function stageList(opts = {}) {
  const stages = (opts.stages || DEFAULT_STAGES).slice().sort((a, b) => a.order - b.order);
  if (opts.includeUnmapped) stages.push({ ...UNMAPPED_STAGE });
  return stages;
}

/**
 * Resolve the settings-driven configuration out of an effective settings object,
 * falling back to ours. Kept here so every caller reads the mapping the same way.
 */
function configFrom(settings = {}) {
  const stages = Array.isArray(settings['stages.order']) && settings['stages.order'].length
    ? settings['stages.order']
    : DEFAULT_STAGES;
  const map = settings['stages.map'] && typeof settings['stages.map'] === 'object'
    ? settings['stages.map']
    : DEFAULT_MAP;
  return { stages, map, index: buildIndex(map) };
}

module.exports = {
  DEFAULT_STAGES,
  DEFAULT_MAP,
  UNMAPPED_STAGE,
  COMPLETED_FORM,
  normalizeMilestone,
  milestoneKey,
  completedFormLabel,
  stageForMilestone,
  consumerStatusOf,
  tpoStatusOf,
  stageList,
  configFrom,
  _internals: { buildIndex },
};
