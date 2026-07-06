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
};
