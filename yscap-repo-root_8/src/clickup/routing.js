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
// staffEmail = the PORTAL staff_users email (the canonical lookup key). Where the
// ClickUp workspace uses a different email for the same person, clickupEmail
// records it so a task's "Loan Officer Email" field (which carries the ClickUp
// address) still resolves to the right staff row. clickupEmail omitted == same.
const CLICKUP_STAFF = [
  // loan officers
  { staffEmail: 'joshua@yscapgroup.com',  clickupUserId: 81586262,  pipeline: '90116357907', crm: '90116357856', role: 'loan_officer' },
  { staffEmail: 'esther@yscapgroup.com',  clickupUserId: 81441384,  pipeline: '90115283054', crm: '90115283061', role: 'loan_officer' },
  { staffEmail: 'solomon@yscapgroup.com', clickupUserId: 81441383,  pipeline: '90115017331', crm: '90115018413', role: 'loan_officer' },
  { staffEmail: 'yehuda@yscapgroup.com',  clickupUserId: 120151948, pipeline: '90115017377', crm: '90115018437', role: 'loan_officer' },
  { staffEmail: 'yosef@yscapgroup.com',   clickupUserId: 81466296,  pipeline: '90115279409', crm: '90115279344', role: 'loan_officer' },
  { staffEmail: 'moshe@yscapgroup.com',   clickupUserId: 81537660,  pipeline: '90115913843', crm: '90115913766', role: 'loan_officer' },
  { staffEmail: 'shia@yscapgroup.com',    clickupUserId: 81561587,  pipeline: '90116152676', crm: '90116152663', role: 'loan_officer' },
  { staffEmail: 'mendel@yscapgroup.com',  clickupUserId: 87369209,  pipeline: '90117307844', crm: '90117576712', role: 'loan_officer' },
  { staffEmail: 'abraham@yscapgroup.com', clickupUserId: 87396408,  pipeline: '90117588937', crm: '90117589009', role: 'loan_officer' },
  { staffEmail: 'sol@yscapgroup.com',     clickupUserId: 87406875,  pipeline: '90117693051', crm: '90117693135', role: 'loan_officer' },
  { staffEmail: 'josef@yscapgroup.com',   clickupUserId: 87406877,  pipeline: '90117693037', crm: '90117693155', role: 'loan_officer' },
  // Isaac Zadmehr: portal email differs from ClickUp (yitzchak@).
  { staffEmail: 'isaac@yscapgroup.com',   clickupEmail: 'yitzchak@yscapgroup.com', clickupUserId: 87406874, pipeline: '90117692994', crm: '90117693166', role: 'loan_officer' },
  { staffEmail: 'pinchus@yscapgroup.com', clickupUserId: 87441231,  pipeline: '90118028635', crm: '90118110162', role: 'loan_officer' },
  { staffEmail: 'yisroel@yscapgroup.com', clickupUserId: 87450032,  pipeline: '90118081048', crm: '90118110163', role: 'loan_officer' },
  { staffEmail: 'simcha@yscapgroup.com',  clickupUserId: 87451319,  pipeline: '90118094956', crm: '90118110164', role: 'loan_officer' },
  // Have pipeline folders but no ClickUp workspace member (assign by folder only).
  { staffEmail: 'chaim@yscapgroup.com',   clickupUserId: null, pipeline: '90118110153', crm: null, role: 'loan_officer' },
  { staffEmail: 'mendelb@yscapgroup.com', clickupUserId: null, pipeline: '90118110154', crm: null, role: 'loan_officer' },
  // processors (pipeline-only)
  { staffEmail: 'malky@yscapgroup.com',   clickupUserId: 87335667,  pipeline: '90117376201', crm: null, role: 'processor' },
  { staffEmail: 'goldy@yscapgroup.com',   clickupUserId: 87380437,  pipeline: '90117430703', crm: null, role: 'processor' },
  { staffEmail: 'lisa@yscapgroup.com',    clickupUserId: 87431116,  pipeline: '90117952996', crm: null, role: 'processor' },
  { staffEmail: 'yonah@yscapgroup.com',   clickupUserId: null,      pipeline: '90118065743', crm: null, role: 'processor' },
  { staffEmail: 'ezra@yscapgroup.com',    clickupUserId: null,      pipeline: '90117447287', crm: null, role: 'processor' },
];
const _norm = (e) => (e ? String(e).toLowerCase().trim() : null);
const _pipelineToStaff = {};
for (const s of CLICKUP_STAFF) if (s.pipeline) _pipelineToStaff[String(s.pipeline)] = s.staffEmail;
const _byClickupEmail = (e) => CLICKUP_STAFF.find((s) => _norm(s.clickupEmail) === e);
const _byStaffEmail   = (e) => CLICKUP_STAFF.find((s) => _norm(s.staffEmail) === e);

/** Portal staff email that owns a pipeline folder (null if unmapped). */
function emailForPipelineFolder(folderId) {
  return folderId != null ? (_pipelineToStaff[String(folderId)] || null) : null;
}
/** The loan-officer STAFF email for a task. The pipeline FOLDER is the primary
 *  signal (it's where the file physically lives — the source of ownership); the
 *  Loan Officer Email field is the fallback when the folder isn't a mapped
 *  officer folder (e.g. a shared/system folder). Prevents a stale email field
 *  from silently reassigning a file out of the folder it lives in. */
function loanOfficerEmailFor(read, folderId) {
  const byFolder = CLICKUP_STAFF.find((x) => x.role === 'loan_officer' && x.pipeline === String(folderId));
  if (byFolder) return byFolder.staffEmail;
  const field = _norm(read && read.loanOfficerEmail);
  if (field) {
    const s = _byClickupEmail(field) || _byStaffEmail(field);
    if (s && s.role === 'loan_officer') return s.staffEmail;
    return field;   // unknown but present — may still be a valid staff email
  }
  return null;
}
/** The processor STAFF email for a task (Processor Email field, translated). */
function processorEmailFor(read) {
  const field = _norm(read && read.processorEmail);
  if (!field) return null;
  const s = _byClickupEmail(field) || _byStaffEmail(field);
  return s ? s.staffEmail : field;
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
