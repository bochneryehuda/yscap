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
  normalizeMilestone,
  stageForMilestone,
  consumerStatusOf,
  tpoStatusOf,
  stageList,
  configFrom,
  _internals: { buildIndex },
};
