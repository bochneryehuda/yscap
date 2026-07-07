/**
 * Officer / processor routing registry — REAL folder ids.
 * Pulled live from CRM & SALES (90113224042) and Loan Pipeline (90113223301).
 * Reflects the folder fixes made this session (Isaac Zadmehr, Yonah Rapaport,
 * Mendel Schwimmer CRM, + new CRM folders for Pinchus/Yisroel/Simcha).
 *
 * ROUTING RULES:
 *   - New loan file  -> loan officer's pipeline folder (dual-write PII to their CRM folder).
 *   - No loan officer -> LEAD_CAPTURE pipeline folder for manual assignment.
 *   - Processors: pipeline access only, never a lead-routing target, no CRM folder.
 *   - The SITE officer dropdown determines who is actually selectable; this map
 *     is name-keyed so it stays correct regardless of dropdown ordering.
 */

const LEAD_CAPTURE_FOLDER = '90118110142'; // "Lead Capture" — canonical no-officer target

const LOAN_OFFICERS = {
  'Joshua Freidlander':  { crm: '90116357856', pipeline: '90116357907' },
  'Esther Bochner':      { crm: '90115283061', pipeline: '90115283054' }, // pipeline = "Esther Bochner Workflow"
  'Solomon Katz':        { crm: '90115018413', pipeline: '90115017331' },
  'Yehuda Bochner':      { crm: '90115018437', pipeline: '90115017377' },
  'Yosef Cohen':         { crm: '90115279344', pipeline: '90115279409' },
  'Moshe Mermelstein':   { crm: '90115913766', pipeline: '90115913843' },
  'Shia Kaff':           { crm: '90116152663', pipeline: '90116152676' },
  'Mendel Schwimmer':    { crm: '90117576712', pipeline: '90117307844' },
  'Abraham Eisen':       { crm: '90117589009', pipeline: '90117588937' },
  'Solomon Weiss':       { crm: '90117693135', pipeline: '90117693051' },
  'Josef Schnitzler':    { crm: '90117693155', pipeline: '90117693037' }, // CRM name has leading space in ClickUp
  'Isaac Zadmehr':       { crm: '90117693166', pipeline: '90117692994' },
  'Pinchus Wieder':      { crm: '90118110162', pipeline: '90118028635' },
  'Yisroel Weinstock':   { crm: '90118110163', pipeline: '90118081048' },
  'Simcha Shedrowitzky': { crm: '90118110164', pipeline: '90118094956' },
  // Files folder exists but NO CRM folder yet — flagged (see OPEN_ITEMS).
  'Chaim Lebowitz':      { crm: null, pipeline: '90118110153' },
  'Mendel Bochner':      { crm: null, pipeline: '90118110154' },
};

// Pipeline-only. Scoped logins see only files assigned to them. Never lead targets.
const PROCESSORS = {
  'Malky Katz':      { pipeline: '90117376201' },
  'Goldy Rosenberg': { pipeline: '90117430703' },
  'Ezra':            { pipeline: '90117447287' },
  'Lisa Katz':       { pipeline: '90117952996' },
  'Shana':           { pipeline: '90117990325' }, // Underwriting
  'Yonah Rapaport':  { pipeline: '90118065743' },
};

// Retained in ClickUp but excluded from site routing per instruction.
const EXCLUDED = {
  'Samual Stein':      { crm: '90115018345', pipeline: '90115017292', reason: 'ignore (not site-selectable)' },
  'Berish Mendlovic':  { crm: '90115661207', pipeline: '90115661228', reason: 'ignore (not site-selectable)' },
  'Boruch Stauber':    { pipeline: '90117284757', reason: 'no longer working with YS Capital' },
};

// System buckets — automations/workflows, never routing targets.
const SYSTEM_FOLDERS = {
  fullPipeline:       '90115750802',
  shortTermWorkload:  '90117191604',
  longTermWorkload:   '90117140244',
  publicSubmission:   '90117430715',
  leadCapture:        LEAD_CAPTURE_FOLDER,
};

const OPEN_ITEMS = [
  'Chaim Lebowitz & Mendel Bochner have Pipeline folders but no CRM folder. If they are loan officers, create CRM folders so borrower PII can dual-write.',
  'Josef Schnitzler CRM folder name has a stray leading space in ClickUp (cosmetic).',
];

// ---- ClickUp member ↔ email ↔ folder (INBOUND officer resolution) ----------
// Files come from the PIPELINE folder (not CRM). The two reliable signals for
// "whose file is this" are (1) the task's Loan Officer Email custom field and
// (2) the pipeline FOLDER the task lives in. Both resolve to an email — the
// STABLE key to match our staff_users (names drift in spelling/case; emails
// don't). Emails + ClickUp user ids pulled from the live workspace members list.
const CLICKUP_STAFF = [
  // loan officers  (email, clickupUserId, pipeline folder, crm folder)
  { email: 'joshua@yscapgroup.com',  clickupUserId: 81586262,  pipeline: '90116357907', crm: '90116357856', role: 'loan_officer' },
  { email: 'esther@yscapgroup.com',  clickupUserId: 81441384,  pipeline: '90115283054', crm: '90115283061', role: 'loan_officer' },
  { email: 'solomon@yscapgroup.com', clickupUserId: 81441383,  pipeline: '90115017331', crm: '90115018413', role: 'loan_officer' },
  { email: 'yehuda@yscapgroup.com',  clickupUserId: 120151948, pipeline: '90115017377', crm: '90115018437', role: 'loan_officer' },
  { email: 'yosef@yscapgroup.com',   clickupUserId: 81466296,  pipeline: '90115279409', crm: '90115279344', role: 'loan_officer' },
  { email: 'moshe@yscapgroup.com',   clickupUserId: 81537660,  pipeline: '90115913843', crm: '90115913766', role: 'loan_officer' },
  { email: 'shia@yscapgroup.com',    clickupUserId: 81561587,  pipeline: '90116152676', crm: '90116152663', role: 'loan_officer' },
  { email: 'mendel@yscapgroup.com',  clickupUserId: 87369209,  pipeline: '90117307844', crm: '90117576712', role: 'loan_officer' },
  { email: 'abraham@yscapgroup.com', clickupUserId: 87396408,  pipeline: '90117588937', crm: '90117589009', role: 'loan_officer' },
  { email: 'sol@yscapgroup.com',     clickupUserId: 87406875,  pipeline: '90117693051', crm: '90117693135', role: 'loan_officer' },
  { email: 'josef@yscapgroup.com',   clickupUserId: 87406877,  pipeline: '90117693037', crm: '90117693155', role: 'loan_officer' },
  { email: 'yitzchak@yscapgroup.com',clickupUserId: 87406874,  pipeline: '90117692994', crm: '90117693166', role: 'loan_officer' },
  { email: 'pinchus@yscapgroup.com', clickupUserId: 87441231,  pipeline: '90118028635', crm: '90118110162', role: 'loan_officer' },
  { email: 'yisroel@yscapgroup.com', clickupUserId: 87450032,  pipeline: '90118081048', crm: '90118110163', role: 'loan_officer' },
  { email: 'simcha@yscapgroup.com',  clickupUserId: 87451319,  pipeline: '90118094956', crm: '90118110164', role: 'loan_officer' },
  // processors (pipeline-only)
  { email: 'malky@yscapgroup.com',   clickupUserId: 87335667,  pipeline: '90117376201', crm: null, role: 'processor' },
  { email: 'goldy@yscapgroup.com',   clickupUserId: 87380437,  pipeline: '90117430703', crm: null, role: 'processor' },
  { email: 'lisa@yscapgroup.com',    clickupUserId: 87431116,  pipeline: '90117952996', crm: null, role: 'processor' },
  { email: 'shana@yscapgroup.com',   clickupUserId: 87435940,  pipeline: '90117990325', crm: null, role: 'processor' },
];
const _pipelineToEmail = {};
for (const s of CLICKUP_STAFF) if (s.pipeline) _pipelineToEmail[String(s.pipeline)] = s.email;

/** Officer/processor email that owns a pipeline folder (null if unmapped). */
function emailForPipelineFolder(folderId) {
  return folderId != null ? (_pipelineToEmail[String(folderId)] || null) : null;
}
/** The loan-officer email for a task: the Loan Officer Email field, else the
 *  pipeline folder's owner. Returns null → caller falls back to Lead Capture. */
function loanOfficerEmailFor(read, folderId) {
  const fromField = read && read.loanOfficerEmail ? String(read.loanOfficerEmail).toLowerCase().trim() : null;
  if (fromField) return fromField;
  const s = CLICKUP_STAFF.find((x) => x.role === 'loan_officer' && x.pipeline === String(folderId));
  return s ? s.email : null;
}
/** The processor email for a task: the Processor Email field only (a file's home
 *  folder is the officer's; processors are multi-homed). */
function processorEmailFor(read) {
  return read && read.processorEmail ? String(read.processorEmail).toLowerCase().trim() : null;
}

/**
 * Resolve a site officer name to routing targets.
 * Returns { role, crmFolderId, pipelineFolderId } or the Lead Capture fallback.
 */
function resolveRouting(officerName) {
  const name = (officerName || '').trim();
  if (name && LOAN_OFFICERS[name]) {
    return { role: 'loan_officer', officer: name,
             crmFolderId: LOAN_OFFICERS[name].crm,
             pipelineFolderId: LOAN_OFFICERS[name].pipeline };
  }
  // Unknown, blank, processor, or excluded -> Lead Capture for manual assignment.
  return { role: 'unassigned', officer: null,
           crmFolderId: null, pipelineFolderId: LEAD_CAPTURE_FOLDER };
}

module.exports = {
  LEAD_CAPTURE_FOLDER, LOAN_OFFICERS, PROCESSORS, EXCLUDED,
  SYSTEM_FOLDERS, OPEN_ITEMS, resolveRouting,
  CLICKUP_STAFF, emailForPipelineFolder, loanOfficerEmailFor, processorEmailFor,
};
