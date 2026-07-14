// Shared Lead-CRM vocabulary so the board, list, and detail screens stay in
// lockstep (owner-directed full CRM, 2026-07-14).

// The pipeline, in funnel order. `board` stages show as kanban columns; lost /
// nurturing / archived are off-board states reached via the stage picker.
export const STAGES = [
  { key: 'new',        label: 'New',        pill: 'info', board: true },
  { key: 'contacted',  label: 'Contacted',  pill: 'warn', board: true },
  { key: 'qualified',  label: 'Qualified',  pill: 'warn', board: true },
  { key: 'quoted',     label: 'Quoted',     pill: 'warn', board: true },
  { key: 'working',    label: 'In progress', pill: 'warn', board: true },
  { key: 'converted',  label: 'Won',        pill: 'ok',   board: true },
  { key: 'nurturing',  label: 'Nurturing',  pill: 'mut',  board: false },
  { key: 'lost',       label: 'Lost',       pill: 'mut',  board: false },
  { key: 'archived',   label: 'Archived',   pill: 'mut',  board: false },
];
export const STAGE_LABEL = Object.fromEntries(STAGES.map(s => [s.key, s.label]));
export const STAGE_PILL = Object.fromEntries(STAGES.map(s => [s.key, s.pill]));
export const BOARD_STAGES = STAGES.filter(s => s.board);
export const OPEN_STAGES = ['new', 'contacted', 'qualified', 'quoted', 'working', 'nurturing'];

export const SOURCES = ['website', 'referral', 'call-in', 'email', 'social', 'event', 'repeat client', 'other'];
export const PROGRAMS = ['Fix & Flip', 'Fix & Hold', 'Bridge', 'Ground-Up', 'DSCR', 'Gold Standard', 'Other'];

export const TOOL_LABEL = {
  loan_application: 'Loan application', rehab_budget: 'Rehab budget', term_sheet: 'Term sheet',
  deal_analyzer: 'Deal analyzer', qualifier: 'Qualifier', contact: 'Contact',
  subscribe: 'Newsletter', dscr_waitlist: 'DSCR waitlist', manual: 'Added manually',
};

export const ACTIVITY_TYPES = [
  { key: 'note',    label: 'Note',    icon: 'note' },
  { key: 'call',    label: 'Call',    icon: 'call' },
  { key: 'email',   label: 'Email',   icon: 'email' },
  { key: 'sms',     label: 'Text',    icon: 'sms' },
  { key: 'meeting', label: 'Meeting', icon: 'meeting' },
];

export const leadName = (l) =>
  ([l.first_name, l.last_name].filter(Boolean).join(' ') || l.name || l.email || l.phone || 'Unnamed lead');

export const initials = (s) =>
  (String(s || '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase()) || '—';

export const todayStr = () => new Date().toISOString().slice(0, 10);

export const dueSoon = (l) =>
  l.next_follow_up && String(l.next_follow_up).slice(0, 10) <= todayStr() &&
  l.status !== 'converted' && l.status !== 'archived' && l.status !== 'lost';

export const money = (n) =>
  (n == null || n === '' || Number.isNaN(Number(n))) ? '' :
    Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const addrLine = (a) => !a ? '' :
  (a.oneLine || [a.street || a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ') || '');
