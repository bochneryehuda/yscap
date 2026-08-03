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
