'use strict';
/**
 * The switches an admin can flip from the API Health page — the allowlist behind the runtime flags.
 *
 * Each entry: the env var `key` (also the flag key), which `integration` card it belongs to, a
 * plain `label`, whether it is `dangerous` (a write/creation switch → the UI requires a typed
 * confirmation), and `envDefault()` which reads the CURRENT env/cfg value used when there is no
 * override. `resume` marks a switch whose OFF takes effect instantly everywhere but whose fully-off
 * background poller only resumes on the next restart (the two big sync masters) — so the UI can say so.
 *
 * The app gates call `flags.enabled(KEY, <cfg default>)`; this module is the single source of truth
 * the admin endpoint validates against and the page renders from.
 */
const cfg = require('../../config');
const flags = require('../flags');

const SWITCHES = [
  { key: 'SITEWIRE_ENABLED', integration: 'sitewire', label: 'Sitewire sync (reading)', dangerous: false, resume: true, envDefault: () => cfg.sitewireEnabled },
  { key: 'SITEWIRE_OUTBOUND_ENABLED', integration: 'sitewire', label: 'Sitewire writing (push to Sitewire)', dangerous: true, envDefault: () => cfg.sitewireOutboundEnabled },
  { key: 'TRUSTPOINT_ENABLED', integration: 'trustpoint', label: 'TrustPoint mirror (reading + webhooks)', dangerous: false, resume: true, envDefault: () => cfg.trustpointEnabled },
  // Trinity — the PHYSICAL inspection company we order from on the general physical
  // program (a physical draw whose note buyer is NOT Blue Lake). Same three-stage shape
  // as the AMC / Class / flood integrations: a master switch for reads + the poller, a
  // TEST MODE that builds the call and sends nothing, and a separate write gate for
  // actually placing orders. `resume: false` — the poller re-reads the switch on every
  // tick and the client at call time, so turning it back on needs no restart.
  { key: 'TRINITY_ENABLED', integration: 'trinity', label: 'Trinity physical inspections (reading + following orders)', dangerous: false, resume: false, envDefault: () => !!(cfg.trinity && cfg.trinity.enabled) },
  { key: 'TRINITY_DRYRUN', integration: 'trinity', label: 'Trinity orders — TEST MODE (build the order but don’t send it)', dangerous: false, envDefault: () => !!(cfg.trinity && cfg.trinity.dryrun) },
  { key: 'TRINITY_OUTBOUND_ENABLED', integration: 'trinity', label: 'Place Trinity inspection orders / send documents + messages (write)', dangerous: true, envDefault: () => !!(cfg.trinity && cfg.trinity.outboundEnabled) },
  { key: 'CLICKUP_SYNC_ENABLED', integration: 'clickup', label: 'ClickUp sync', dangerous: false, resume: true, envDefault: () => cfg.clickupSyncEnabled },
  { key: 'CLICKUP_OUTBOUND_ENABLED', integration: 'clickup', label: 'ClickUp writing (push to ClickUp)', dangerous: true, envDefault: () => cfg.clickupOutboundEnabled },
  { key: 'CLICKUP_INBOUND_CREATE_FILES', integration: 'clickup', label: 'Create loan files from ClickUp tasks', dangerous: true, envDefault: () => cfg.clickupInboundCreateFiles },
  { key: 'SHAREPOINT_BACKUP_ENABLED', integration: 'sharepoint', label: 'Document mirroring to SharePoint', dangerous: false, envDefault: () => cfg.sharepointBackupEnabled },
  // Staged cutover to the explicit state-machine mirror engine (instant, no redeploy).
  // Turn WATCH-ONLY on first and confirm parity in the admin dashboard, THEN turn
  // LIVE on. Rollback = turn LIVE (or both) off — takes effect within seconds.
  { key: 'SHAREPOINT_MIRROR_FSM_SHADOW', integration: 'sharepoint', label: 'SharePoint mirror — new engine WATCH-ONLY (shadow)', dangerous: false, resume: true, envDefault: () => String(process.env.SHAREPOINT_MIRROR_FSM || '').toLowerCase().trim() === 'shadow' },
  { key: 'SHAREPOINT_MIRROR_FSM_ON', integration: 'sharepoint', label: 'SharePoint mirror — new engine LIVE (cutover)', dangerous: true, resume: true, envDefault: () => String(process.env.SHAREPOINT_MIRROR_FSM || '').toLowerCase().trim() === 'on' },
  { key: 'DOCUSIGN_SEND_ENABLED', integration: 'docusign', label: 'E-signature sending', dangerous: true, envDefault: () => !!(cfg.docusign && cfg.docusign.sendEnabled) },
  { key: 'APPRAISAL_FLOOD_CHECK_ENABLED', integration: 'fema_flood', label: 'Flood-zone check', dangerous: false, envDefault: () => cfg.appraisalFloodCheckEnabled },
  // Encompass FLOOD ordering — the one owner-authorized WRITE into Encompass.
  // Master turns on reads + the poll worker; OUTBOUND actually places an order.
  { key: 'ENCOMPASS_FLOOD_ENABLED', integration: 'encompass', label: 'Order flood certificates from Encompass (reading + polling)', dangerous: false, resume: true, envDefault: () => cfg.encompassFloodEnabled },
  // Test mode: build + log the order but send NOTHING. Dry-run wins over the write
  // gate (checked first), so it is always safe to leave on while verifying.
  { key: 'ENCOMPASS_FLOOD_DRYRUN', integration: 'encompass', label: 'Flood orders — TEST MODE (build the order but don’t send it)', dangerous: false, envDefault: () => !!(cfg.encompassFlood && cfg.encompassFlood.dryrun) },
  { key: 'ENCOMPASS_FLOOD_OUTBOUND_ENABLED', integration: 'encompass', label: 'Place flood orders in Encompass (write)', dangerous: true, envDefault: () => cfg.encompassFloodOutboundEnabled },
  // The appraisal-XML catcher. READ-ONLY, but it is a poller that talks to a
  // vendor API on a timer, so it needs an off switch a human can reach WITHOUT a
  // Render restart. The env var ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED=1 still
  // wins on its own (it is checked first, so it can stop the catcher even if the
  // switches table is unreachable).
  // `resume: false` — the catcher re-reads this switch on EVERY tick, so turning
  // it back on resumes by itself with no restart.
  { key: 'ENCOMPASS_APPRAISAL_XML_CATCH_ENABLED', integration: 'encompass', label: 'Catch appraisal XML out of Encompass (read-only poller)', dangerous: false, resume: false, envDefault: () => process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED !== '1' },
  // Xactus "Flood ReportX" — the ACTIVE flood-cert provider (owner-directed
  // 2026-07-30). This master switch turns the button's Xactus ordering on/off — the
  // ONE control here. There is deliberately NO "TEST MODE" toggle: test mode was
  // REMOVED entirely (owner-directed 2026-08-02, "remove the test mode … go live right
  // away") because a stored test-mode override kept surviving deploys and pinning the
  // button in dry-run. Ordering is always LIVE; turn this master switch off to pause it.
  { key: 'XACTUS_FLOOD_ENABLED', integration: 'xactus', label: 'Order flood certificates from Xactus (the active flood provider)', dangerous: false, resume: true, envDefault: () => cfg.xactusFloodEnabled },
  // Dangerous: this one WRITES a loan value. Off = PILOT still reads the As-Is off the appraisal and
  // still shows it on the "Confirm the As-Is value" condition; it just never changes the file itself.
  { key: 'APPRAISAL_ASIS_AUTO_ENABLED', integration: 'azure_docint', label: 'Lower the As-Is value automatically when the appraisal reads lower than the purchase price', dangerous: true, envDefault: () => cfg.appraisalAsIsAutoEnabled },
  // AMC appraisal ordering (AppraisalScope / CoreLogic Digital Gateway). Master turns
  // on the lookups cache + the status/comment poll worker (reads); OUTBOUND actually
  // places orders, messages the AMC, requests revisions and uploads documents.
  { key: 'AMC_ENABLED', integration: 'amc', label: 'Order appraisals from the AMC (reading + polling)', dangerous: false, resume: true, envDefault: () => !!(cfg.amc && cfg.amc.enabled) },
  // Test mode: build + log the exact request, send nothing. Dry-run wins over the
  // write gate (checked first), so it is always safe to leave on while verifying.
  { key: 'AMC_DRYRUN', integration: 'amc', label: 'AMC orders — TEST MODE (build the request but don’t send it)', dangerous: false, envDefault: () => !!(cfg.amc && cfg.amc.dryrun) },
  { key: 'AMC_OUTBOUND_ENABLED', integration: 'amc', label: 'Place appraisal orders / message the AMC / upload documents (write)', dangerous: true, envDefault: () => !!(cfg.amc && cfg.amc.outboundEnabled) },

  // Class Valuation — the SECOND appraisal vendor. Its own switches on purpose:
  // the two vendors are turned on and off independently, and one being live must
  // never imply anything about the other. Same three-stage shape as the AMC.
  // No `resume` flag: both consumers (the poller and the client) read the switch at
  // CALL time, so turning it back on takes effect immediately. Claiming otherwise
  // would tell an admin a redeploy is needed when it is not.
  { key: 'CLASS_ENABLED', integration: 'class', label: 'Order appraisals from Class Valuation (reading)', dangerous: false, envDefault: () => !!(cfg.class && cfg.class.enabled) },
  { key: 'CLASS_DRYRUN', integration: 'class', label: 'Class Valuation orders — TEST MODE (build the request but don’t send it)', dangerous: false, envDefault: () => !!(cfg.class && cfg.class.dryrun) },
  { key: 'CLASS_OUTBOUND_ENABLED', integration: 'class', label: 'Place appraisal orders with Class Valuation (write)', dangerous: true, envDefault: () => !!(cfg.class && cfg.class.outboundEnabled) },

  // Richer Values — the THIRD appraisal vendor, and a different KIND of product
  // (a cheaper evaluation giving an As-Is value AND an ARV, with no MISMO XML).
  // Its own switches for the same reason the other two have their own: the three
  // vendors are turned on and off independently, and one being live must never
  // imply anything about another. No `resume` flag — both consumers (the poller
  // and the client) read the switch at CALL time, so turning it back on takes
  // effect immediately and claiming otherwise would send an admin for a redeploy
  // they do not need.
  { key: 'RV_ENABLED', integration: 'richer_value', label: 'Order Hybrid Appraisals from Richer Values (reading + polling)', dangerous: false, envDefault: () => !!(cfg.richerValue && cfg.richerValue.enabled) },
  { key: 'RV_DRYRUN', integration: 'richer_value', label: 'Richer Values orders — TEST MODE (build the order but don’t send it)', dangerous: false, envDefault: () => !!(cfg.richerValue && cfg.richerValue.dryrun) },
  { key: 'RV_OUTBOUND_ENABLED', integration: 'richer_value', label: 'Place Hybrid Appraisal orders with Richer Values (write)', dangerous: true, envDefault: () => !!(cfg.richerValue && cfg.richerValue.outboundEnabled) },

  // Elementix (recorded deeds / mortgages). Reading only — there is no write path to
  // Elementix at all, so neither switch is dangerous. NOT a switch: the paid contact
  // enrichment, which is a per-person human click and can never be turned on globally.
  { key: 'ELEMENTIX_ENABLED', integration: 'elementix', label: 'Elementix public-records lookups (reading)', dangerous: false, envDefault: () => cfg.elementix.enabled },
  { key: 'ELEMENTIX_DRYRUN', integration: 'elementix', label: 'Elementix dry-run (log the intended lookup, send nothing)', dangerous: false, envDefault: () => cfg.elementix.dryrun },

  // DocLab (Private Lender Law) — loan-document drafting. Same three-stage shape as
  // the AMC and Class: master turns on reading (the token, the template catalogue, a
  // state's prepayment options, a request's status); OUTBOUND actually puts a loan
  // request in front of the law firm. TEST MODE is checked FIRST, so leaving it on is
  // always safe while somebody is verifying a payload.
  // No `resume` flag: every consumer reads the switch at CALL time, so turning one
  // back on takes effect immediately with no redeploy.
  { key: 'DOCLAB_ENABLED', integration: 'doclab', label: 'DocLab loan documents (reading)', dangerous: false, envDefault: () => !!(cfg.doclab && cfg.doclab.enabled) },
  { key: 'DOCLAB_DRYRUN', integration: 'doclab', label: 'DocLab — TEST MODE (build the request but don’t send it)', dangerous: false, envDefault: () => !!(cfg.doclab && cfg.doclab.dryrun) },
  { key: 'DOCLAB_OUTBOUND_ENABLED', integration: 'doclab', label: 'Send loan document requests to DocLab (write)', dangerous: true, envDefault: () => !!(cfg.doclab && cfg.doclab.outboundEnabled) },

  /* THE DOWN-ALERT MONITOR — the only PLATFORM-level switch here, and the only one with
     `integration: null`. It belongs to no single card because it watches all of them, so
     the health registry's `s.integration === entry.key` filter never attaches it to one
     and the API Health page renders it in its own banner instead. `list()` still carries
     it, so the existing toggle/reset endpoints, the audit row and the override row all
     work unchanged.

     ON BY DEFAULT (owner-directed 2026-08-09, "turn on the down alerts"). It was opt-in
     so we would not call every outside service on a timer unless the owner wanted the
     alerts — the owner now does. `INTEGRATIONS_MONITOR_ENABLED=0` in the hosting settings
     still turns it off, and so does this switch, with no redeploy.

     `resume: false` is the truth here and not a copy-paste: monitor.start() arms its timer
     unconditionally and every tick re-reads this switch, so turning it back on resumes by
     itself. Claiming otherwise would tell an admin to redeploy when they need not. */
  { key: 'INTEGRATIONS_MONITOR_ENABLED', integration: null, label: 'Automatic down-alerts (check every service on a timer and email the admins when one stops)', dangerous: false, resume: false, envDefault: () => process.env.INTEGRATIONS_MONITOR_ENABLED !== '0' },
];
const BY_KEY = Object.create(null);
for (const s of SWITCHES) BY_KEY[s.key] = s;

// The switch's effective runtime state for the UI: whether it's on now (override ?? env default),
// whether an admin override is in force, its env default, dangerous/resume flags, and label.
function effective(key) {
  const s = BY_KEY[key];
  if (!s) return null;
  const envDefault = !!s.envDefault();
  return {
    key, label: s.label, integration: s.integration, dangerous: !!s.dangerous, resume: !!s.resume,
    on: flags.enabled(key, envDefault), overridden: flags.hasOverride(key), envDefault,
  };
}
function list() { return SWITCHES.map((s) => effective(s.key)); }
// A gate helper: `on('SITEWIRE_OUTBOUND_ENABLED')` = the effective runtime value (override ?? env).
function on(key) { const s = BY_KEY[key]; return s ? flags.enabled(key, !!s.envDefault()) : false; }

module.exports = { SWITCHES, BY_KEY, effective, list, on };
