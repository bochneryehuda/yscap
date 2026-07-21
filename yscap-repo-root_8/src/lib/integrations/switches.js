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
  { key: 'CLICKUP_SYNC_ENABLED', integration: 'clickup', label: 'ClickUp sync', dangerous: false, resume: true, envDefault: () => cfg.clickupSyncEnabled },
  { key: 'CLICKUP_OUTBOUND_ENABLED', integration: 'clickup', label: 'ClickUp writing (push to ClickUp)', dangerous: true, envDefault: () => cfg.clickupOutboundEnabled },
  { key: 'CLICKUP_INBOUND_CREATE_FILES', integration: 'clickup', label: 'Create loan files from ClickUp tasks', dangerous: true, envDefault: () => cfg.clickupInboundCreateFiles },
  { key: 'SHAREPOINT_BACKUP_ENABLED', integration: 'sharepoint', label: 'Document mirroring to SharePoint', dangerous: false, envDefault: () => cfg.sharepointBackupEnabled },
  { key: 'DOCUSIGN_SEND_ENABLED', integration: 'docusign', label: 'E-signature sending', dangerous: true, envDefault: () => !!(cfg.docusign && cfg.docusign.sendEnabled) },
  { key: 'APPRAISAL_FLOOD_CHECK_ENABLED', integration: 'fema_flood', label: 'Flood-zone check', dangerous: false, envDefault: () => cfg.appraisalFloodCheckEnabled },
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
