'use strict';

// =============================================================================
// PLAIN ENGLISH FOR THE TABLES AT THE CENTRE OF THE SYSTEM
// =============================================================================
//
// One definition, read by BOTH documents in docs/schema/: the browsable picture
// (`schema-picture.js`) and the Prisma map (`schema-prisma.js`). Two copies of a
// sentence about the same table would drift, and the drifted one would be the
// one somebody read.
//
// A NOTE HERE IS KNOWLEDGE, NOT A GUESS. There are 321 tables and this covers
// about thirty-five: the ones a person needs in order to orient themselves. A
// table with no entry simply shows its real name, which is FAR better than a
// generated sentence that sounds confident and is wrong.
//
// It cannot go stale silently: `test-schema-picture-pure.js` asserts every key
// here is still a real table, so a rename fails the build rather than quietly
// dropping the note.

const GLOSSARY = {
  applications: 'One loan file — one property, one deal. Almost everything in the system hangs off this.',
  borrowers: 'The person. Kept apart from their login on purpose, so a problem with one cannot reach the other.',
  borrower_auth: 'The borrower’s login — password and two-factor only. Deliberately holds no personal details.',
  staff_users: 'The team roster. Also where an outside broker’s login lives, flagged as external.',
  llcs: 'The company a loan is taken in the name of. Despite the name it now holds corporations, partnerships and trusts too.',
  documents: 'Every document in the system, whoever uploaded it and wherever it is filed.',
  checklist_items: 'The conditions on a file — what is still needed before it can close.',
  checklist_templates: 'The master list the conditions are created from.',
  product_registrations: 'The priced structure of a deal at the moment it was registered — the numbers the term sheet was printed from.',
  notifications: 'Everything the system has told someone, in the app and by email.',
  audit_log: 'Who did what, and when. The record that answers questions years later.',
  appraisals: 'An appraisal report, and everything read out of it.',
  appraisal_comparables: 'The other properties an appraiser compared this one to.',
  credit_reports: 'A credit pull for one borrower, including the scores the deal was priced on.',
  track_records: 'Deals a borrower has done before — what their experience level is built from.',
  application_assignees: 'Who on the team is on which file, and in what role.',
  conditions: 'Conditions raised on a file outside the standard checklist.',
  sync_queue: 'Work waiting to be pushed out to ClickUp or another outside system.',
  sync_review_queue: 'Disagreements between us and an outside system that a person has to settle.',
  clickup_task_index: 'The link between a card in ClickUp and a loan file here.',
  encompass_loan_snapshot: 'A read-only copy of what Encompass holds for a loan. We never write back to it.',
  sitewire_property_links: 'The link between a loan file and its construction-draw project.',
  draw_findings: 'What an inspector found on site, and what it means for the money.',
  draw_disbursements: 'Money actually released on a draw, and the fee taken out of it.',
  closing_workflow: 'The run-up to the closing table for one file.',
  loan_exceptions: 'The register of policy exceptions — what was asked for, who approved it, and why.',
  properties: 'Every property the system has ever been shown, across all files.',
  property_observations: 'What one appraiser said about one property on one date. Never overwritten.',
  invite_tokens: 'Outstanding invitations — to join the team, or for a borrower to set up their login.',
  tpo_firms: 'The outside brokerages that bring us loans.',
  borrower_assistants: 'Someone a borrower has asked to help them with their file.',
  underwriting_runs: 'One complete automated read of a whole loan file.',
  document_findings: 'Something the system noticed in a document that a person should look at.',
  amc_orders: 'An appraisal ordered through an appraisal management company, and where that order has got to.',
  messages: 'Messages inside the system — between the team, and with a borrower or a broker.',
  arena_spins: 'One spin of the wheel on a company game day — what is being played for, who was in it, and who won.',
  finding_decisions: 'A human’s verdict on a finding, kept so it is never asked again.',
  arena_sessions: 'One sales day of the staff game — who is playing, and whether it has started.',
  arena_spins: 'One draw in that day: the wheel, what is being won, and how the winner is picked.',
  arena_challenges: 'A timed task the room is set during the day, and what winning it is worth.',
  arena_tickets: 'The chances a person has earned in the game. A ledger — a mistake is reversed by adding the opposite, never by editing history.',
};

module.exports = { GLOSSARY };
