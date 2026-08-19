'use strict';
/**
 * THE CHALLENGE LIBRARY — the things that pop up on everybody's screen during
 * the Mega Spin, and the rules for scheduling them.
 *
 * WHAT THE OWNER ASKED FOR: a spin that runs all day, with challenges appearing
 * "randomly maybe do such a pop-up on every screen with a countdown ... every 20
 * minutes randomly it should populate another challenge. Anybody that fulfills
 * this and clicks fulfill it needs to put a note on why they fulfilled it."
 * Some are first-past-the-post — "when somebody tries filling it, they should
 * see, hey, somebody won this one already". And: "I'm giving you a list. That
 * list is not a list for you to use. That list is for openness in your eyes,
 * and you should do more research on what else we can throw into ideas."
 *
 * SO THE OWNER'S SEVEN EXAMPLES ARE ALL HERE, MARKED `fromOwner: true`, and
 * they sit inside a much larger set drawn from research into how real products
 * run timed challenges (Duolingo daily quests, Strava segments and challenges,
 * Twitch predictions, Kahoot, Peloton, Nike Run Club) and into the metrics loan
 * officers are actually measured on. The full sourcing is in
 * docs/ARENA-GAME-ENGINE-RESEARCH.md.
 *
 * THREE FINDINGS FROM THAT RESEARCH ARE BUILT INTO THE DEFAULTS, not left as
 * advice somebody has to remember:
 *
 *   1. NOT A METRONOME. A challenge every twenty minutes exactly is predictable,
 *      and predictable rewards lose most of their pull — the whole effect
 *      depends on not knowing when the next one lands. It also guarantees you
 *      interrupt the same people mid-call every single time. So the scheduler
 *      jitters each gap inside a window around the target, and the jitter is
 *      part of the plan the admin can see and change.
 *   2. TWO AT A TIME, AT MOST. Somebody chasing three things at once chases
 *      none of them. `MAX_CONCURRENT` is a hard cap in the scheduler.
 *   3. THE MIDDLE OF THE TEAM MUST BE ABLE TO WIN. A day made only of
 *      first-past-the-post races is a day the same three people win and
 *      everybody else stops trying. Most of this library is `everyone` — do it,
 *      earn your chances — and the races are the spice, not the meal.
 *
 * AND ONE HONEST LIMIT, SAID PLAINLY: PILOT records no call log, no dial count
 * and no talk time. Every challenge here about a call is proved by a person
 * showing it — a screenshot, or what they typed — and a super admin agreeing.
 * `proof` says which. There is deliberately no 'automatic' proof type, because
 * there is nothing to read automatically.
 *
 * PURE: no database, no clock, no IO. `planDay` is given the times it should
 * work from, so the tests can stand at any hour and see exactly what would be
 * scheduled.
 */

// The proof a person offers. No 'automatic' — see the header.
const PROOF_TYPES = [
  { key: 'upload', label: 'A screenshot or photo', hint: 'They upload a picture — a call log, a calendar invite, a lock confirmation.' },
  { key: 'text', label: 'They write it', hint: 'They type what they did. Quickest, and the easiest to fib, so best for the small ones.' },
  { key: 'checkin', label: 'Just a click', hint: 'They say they did it. For the tiny ones where checking would cost more than it is worth.' },
  { key: 'count', label: 'A number', hint: 'They type how many — dials, connects, minutes — and can be spot-checked.' },
  { key: 'peer', label: 'Somebody vouches', hint: 'A manager or a teammate confirms it. The most solid proof we have without a dialer.' },
];
const PROOF_KEYS = PROOF_TYPES.map((p) => p.key);

const AWARD_MODES = [
  { key: 'everyone', label: 'Everybody who does it', hint: 'Do it, earn your chances. This is the default, and it should stay the default.' },
  { key: 'first', label: 'First one only', hint: 'One slot. Everybody else is told plainly that it has gone.' },
  { key: 'first_n', label: 'The first few', hint: 'You choose how many slots.' },
];

/**
 * Chances earned by difficulty, and the prize a winner may then nominate.
 *
 * FIXED BEFORE THE DAY STARTS, AND NOT CHANGED DURING IT. The research on
 * points economies is blunt about this: change what a tier is worth halfway
 * through and everybody who earned the old rate feels cheated. The admin can
 * change these in settings BETWEEN sessions; the scheduler reads them once.
 *
 * The caps are the owner's numbers: $500 personal / $1,000 business as the
 * everyday ceiling, and "max prize should be a $2,000 prize in general for the
 * biggest challenge" at the top. A tier-1 win does NOT earn a nomination on its
 * own — "for the lower challenges you need at least two of them" — which is
 * what `nominationCost` expresses.
 */
const TIERS = [
  { tier: 1, label: 'Quick', blurb: 'A couple of minutes. Something anybody can do between calls.', tickets: 1, prizeCapCents: 25000, nominationCost: 2 },
  { tier: 2, label: 'Real work', blurb: 'Fifteen or twenty minutes, or a real outcome.', tickets: 2, prizeCapCents: 50000, nominationCost: 1 },
  { tier: 3, label: 'Hard', blurb: 'A genuine result — an application, a lock, a booked appointment.', tickets: 3, prizeCapCents: 100000, nominationCost: 1 },
  { tier: 4, label: 'Big', blurb: 'The kind of thing that makes the day.', tickets: 5, prizeCapCents: 150000, nominationCost: 1 },
  { tier: 5, label: 'The biggest', blurb: 'One or two of these all day. Everybody stops to watch.', tickets: 8, prizeCapCents: 200000, nominationCost: 1 },
];
const TIER_BY_N = Object.fromEntries(TIERS.map((t) => [t.tier, t]));

/** The owner's rule: five chances buys the right to name something. */
const TICKETS_PER_NOMINATION = 5;

/** No more than this many challenges live at once. See the header. */
const MAX_CONCURRENT = 2;

const c = (o) => ({ tickets: null, slots: 1, ...o });

// ---------------------------------------------------------------------------
// THE LIBRARY
// ---------------------------------------------------------------------------
const CHALLENGES = [
  // ==== THE OWNER'S OWN SEVEN =============================================
  c({
    key: 'call_log_minutes', group: 'calls', tier: 3, proof: 'upload', award: 'first', fromOwner: true,
    title: 'Show a long call',
    prompt: 'First person to upload a screenshot of a call log longer than {minutes} minutes with a real contact takes this one.',
    detail: 'A picture of your dialer or phone showing the length and who it was with. First one in wins the slot.',
    vars: { minutes: 8 },
  }),
  c({
    key: 'who_called_this_number', group: 'crm', tier: 2, proof: 'text', award: 'first', fromOwner: true,
    title: 'Whose number is this?',
    prompt: 'We picked a number out of the system. Which loan officer called it, and what is the borrower’s name?',
    detail: 'A super admin pulls a real number from the pipeline and posts it. First correct answer wins.',
    adminNote: 'You type the number in when you set this one up. PILOT does not dial, so it cannot pick one by itself.',
  }),
  c({
    key: 'tough_question', group: 'skill', tier: 2, proof: 'text', award: 'first_n', slots: 2, fromOwner: true,
    title: 'The hardest question you were asked today',
    prompt: 'Tell us the toughest question a prospect hit you with today, and the answer you gave on the spot that landed.',
    detail: 'The first two good ones take the slots.',
  }),
  c({
    key: 'callback_within_hour', group: 'followup', tier: 2, proof: 'text', award: 'first', fromOwner: true,
    title: 'Get a callback',
    prompt: 'First person to get a call BACK from somebody they rang earlier — within the next hour — wins it.',
    detail: 'Say who called you back and roughly when you first rang them.',
  }),
  c({
    key: 'call_bingo', group: 'fun', tier: 2, proof: 'text', award: 'first', fromOwner: true,
    title: 'Call bingo',
    prompt: 'Bingo card: {phrases}. First person to genuinely hear three of them wins.',
    detail: 'Write which three you heard and roughly when. Honour system — and everybody knows it.',
    vars: { phrases: '"call me next week", "I’m driving", "send me an email", "what’s your rate?"' },
  }),
  c({
    key: 'best_save', group: 'skill', tier: 2, proof: 'text', award: 'everyone', fromOwner: true,
    title: 'Best save',
    prompt: 'Tell us about a call that started badly and you turned around.',
    detail: 'Everybody who posts a real one earns their chances.',
  }),
  c({
    key: 'best_question_asked', group: 'skill', tier: 2, proof: 'text', award: 'everyone', fromOwner: true,
    title: 'Best question you asked',
    prompt: 'Share one question you asked a prospect that actually got them talking.',
  }),
  c({
    key: 'lucky_minute', group: 'fun', tier: 1, proof: 'text', award: 'everyone', fromOwner: true,
    title: 'The lucky minute',
    prompt: 'The lucky minute was {time}. Were you on a call at exactly {time}? Say who with.',
    detail: 'Anybody who was on a call at that exact minute qualifies.',
    vars: { time: '2:46 PM' },
    adminNote: 'Pick the minute when you schedule it — ideally one that has already gone by, so nobody can arrange to be on a call for it.',
  }),

  // ==== DIALS AND VOLUME ==================================================
  c({ key: 'dial_sprint_15', group: 'calls', tier: 1, proof: 'count', award: 'everyone',
    title: 'Dial sprint', prompt: 'Fifteen outbound dials in the next twelve minutes. Type how many you got.' }),
  c({ key: 'power_hour_25', group: 'calls', tier: 2, proof: 'count', award: 'everyone',
    title: 'Power hour', prompt: 'Twenty-five dials before the next challenge drops.' }),
  c({ key: 'first_to_30_dials', group: 'calls', tier: 2, proof: 'upload', award: 'first',
    title: 'First to thirty', prompt: 'First person to show thirty dials since clocking in takes it.' }),
  c({ key: 'first_to_50_dials', group: 'calls', tier: 3, proof: 'upload', award: 'first',
    title: 'Fifty on the day', prompt: 'First to fifty dials today. Screenshot the count.' }),
  c({ key: 'ten_in_ten', group: 'calls', tier: 2, proof: 'upload', award: 'everyone',
    title: 'Ten in ten', prompt: 'Ten dials in ten minutes with no gaps. Show the timer.' }),
  c({ key: 'beat_your_hour', group: 'calls', tier: 1, proof: 'upload', award: 'everyone',
    title: 'Beat your own last hour', prompt: 'Screenshot your dial count now and beat what you did last hour.' }),
  c({ key: 'coldest_bucket', group: 'calls', tier: 1, proof: 'text', award: 'everyone',
    title: 'The coldest five', prompt: 'Dial five leads out of your oldest, coldest bucket. Name one of them.' }),

  // ==== CONNECTS ==========================================================
  c({ key: 'three_connects', group: 'connects', tier: 2, proof: 'count', award: 'everyone',
    title: 'Three real conversations', prompt: 'Three live connects in fifteen minutes. Voicemail does not count.' }),
  c({ key: 'one_good_connect', group: 'connects', tier: 1, proof: 'text', award: 'everyone',
    title: 'One good connect', prompt: 'Land a live connect. Tell us their first name and why they are a good fit.' }),
  c({ key: 'first_to_five_connects', group: 'connects', tier: 3, proof: 'count', award: 'first',
    title: 'Five conversations', prompt: 'First to five live connects since the Mega Spin opened.' }),
  c({ key: 'connect_next_step', group: 'connects', tier: 2, proof: 'peer', award: 'everyone',
    title: 'A real next step', prompt: 'Get a connect who agrees to a follow-up call. Have a manager confirm the note.' }),
  c({ key: 'past_client_checkin', group: 'connects', tier: 2, proof: 'text', award: 'everyone',
    title: 'No ask', prompt: 'Ring a past client just to see how they are. No pitch. Name them.' }),

  // ==== TALK TIME =========================================================
  c({ key: 'talk_20', group: 'talktime', tier: 2, proof: 'upload', award: 'everyone',
    title: 'Twenty minutes on the phone', prompt: 'Twenty minutes of talk time this window. Screenshot the total.' }),
  c({ key: 'five_minute_call', group: 'talktime', tier: 1, proof: 'text', award: 'everyone',
    title: 'Five straight minutes', prompt: 'One call over five minutes — a real conversation, not a pitch and a hang-up.' }),
  c({ key: 'talk_45_first', group: 'talktime', tier: 3, proof: 'upload', award: 'first',
    title: 'Forty-five minutes banked', prompt: 'First to forty-five minutes of talk time today.' }),
  c({ key: 'ten_minute_call', group: 'talktime', tier: 2, proof: 'text', award: 'everyone',
    title: 'Past ten minutes', prompt: 'Have a call run past ten minutes. What turned it into a real conversation?' }),

  // ==== APPOINTMENTS ======================================================
  c({ key: 'book_one', group: 'appointments', tier: 2, proof: 'text', award: 'everyone',
    title: 'Book one', prompt: 'Book an appointment in the next fifteen minutes. Name and time.' }),
  c({ key: 'first_to_three_appts', group: 'appointments', tier: 3, proof: 'text', award: 'first',
    title: 'Three on the board', prompt: 'First to book three appointments today.' }),
  c({ key: 'ghost_appointment', group: 'appointments', tier: 2, proof: 'text', award: 'everyone',
    title: 'Raise the dead', prompt: 'Set an appointment with somebody who has ghosted you before.' }),
  c({ key: 'same_day_appt', group: 'appointments', tier: 3, proof: 'peer', award: 'everyone',
    title: 'Today, not next week', prompt: 'Book a same-day appointment. A manager confirms it is on the calendar.' }),
  c({ key: 'confirm_appt', group: 'appointments', tier: 1, proof: 'checkin', award: 'everyone',
    title: 'Confirm one', prompt: 'Confirm — not book — an appointment already on your calendar this week.' }),
  c({ key: 'calendar_invite', group: 'appointments', tier: 2, proof: 'upload', award: 'everyone',
    title: 'Show the invite', prompt: 'Screenshot a calendar invite you just sent out.' }),

  // ==== APPLICATIONS ======================================================
  c({ key: 'first_app_after_open', group: 'apps', tier: 4, proof: 'peer', award: 'first',
    title: 'First application', prompt: 'First full application taken after the Mega Spin opened.' }),
  c({ key: 'fence_sitter_app', group: 'apps', tier: 3, proof: 'text', award: 'everyone',
    title: 'Off the fence', prompt: 'Start an application with somebody who has been sitting on it.' }),
  c({ key: 'two_apps', group: 'apps', tier: 4, proof: 'peer', award: 'everyone',
    title: 'Two in a day', prompt: 'Take two applications today.' }),
  c({ key: 'app_submitted_shot', group: 'apps', tier: 3, proof: 'upload', award: 'everyone',
    title: 'Show it submitted', prompt: 'Screenshot the submitted confirmation.' }),
  c({ key: 'app_end_to_end', group: 'apps', tier: 4, proof: 'peer', award: 'everyone',
    title: 'All the way through', prompt: 'Application taken and documents requested. A manager confirms.' }),

  // ==== PRE-APPROVALS AND LOCKS ===========================================
  c({ key: 'first_preapproval', group: 'preapproval', tier: 4, proof: 'peer', award: 'first',
    title: 'First pre-approval', prompt: 'First pre-approval letter issued today.' }),
  c({ key: 'preapproval_shot', group: 'preapproval', tier: 3, proof: 'upload', award: 'everyone',
    title: 'Show the letter', prompt: 'Screenshot a pre-approval letter you just generated.' }),
  c({ key: 'first_time_buyer', group: 'preapproval', tier: 3, proof: 'text', award: 'everyone',
    title: 'Somebody’s first home', prompt: 'Issue a pre-approval to a first-time buyer. Name them.' }),
  c({ key: 'prequal_to_preapproval', group: 'preapproval', tier: 3, proof: 'peer', award: 'everyone',
    title: 'Upgrade it', prompt: 'Turn a prequal into a full pre-approval.' }),
  c({ key: 'first_lock', group: 'locks', tier: 5, proof: 'peer', award: 'first',
    title: 'First lock of the day', prompt: 'First rate lock today. Bring it to the front of the room.' }),
  c({ key: 'lock_shot', group: 'locks', tier: 4, proof: 'upload', award: 'everyone',
    title: 'Show the lock', prompt: 'Screenshot a lock confirmation.' }),
  c({ key: 'stalled_lock', group: 'locks', tier: 4, proof: 'text', award: 'everyone',
    title: 'Unstick one', prompt: 'Lock a loan that had stalled. What got it moving?' }),

  // ==== REFERRAL PARTNERS =================================================
  c({ key: 'realtor_checkin', group: 'partners', tier: 1, proof: 'text', award: 'everyone',
    title: 'Check in with a partner', prompt: 'Text or ring one realtor partner just to see how they are. Name them.' }),
  c({ key: 'warm_intro', group: 'partners', tier: 3, proof: 'text', award: 'everyone',
    title: 'A warm introduction', prompt: 'Get an introduction from a past client to a new referral source.' }),
  c({ key: 'partner_thread', group: 'partners', tier: 2, proof: 'upload', award: 'everyone',
    title: 'Show the thread', prompt: 'Screenshot a text thread with a referral partner you started today.' }),
  c({ key: 'coffee_booked', group: 'partners', tier: 3, proof: 'peer', award: 'first',
    title: 'Get in the diary', prompt: 'First to book a coffee or a lunch with a realtor this week.' }),
  c({ key: 'three_partners', group: 'partners', tier: 2, proof: 'count', award: 'everyone',
    title: 'Three partners', prompt: 'Reach three different referral partners in the next twenty minutes.' }),
  c({ key: 'rate_alert_sent', group: 'partners', tier: 2, proof: 'text', award: 'everyone',
    title: 'Give them something useful', prompt: 'Send a market update or a rate alert to a partner. Who did you send it to?' }),
  c({ key: 'partner_commits', group: 'partners', tier: 3, proof: 'peer', award: 'everyone',
    title: 'Get a commitment', prompt: 'Get a referral partner to commit to sending you one deal this week.' }),

  // ==== DATABASE REACTIVATION =============================================
  c({ key: 'six_months_cold', group: 'database', tier: 1, proof: 'text', award: 'everyone',
    title: 'Six months cold', prompt: 'Ring somebody you have not spoken to in six months or more.' }),
  c({ key: 'three_dead_files', group: 'database', tier: 2, proof: 'count', award: 'everyone',
    title: 'Three dead files', prompt: 'Bring three dead-file contacts back into a real conversation.' }),
  c({ key: 'dead_file_yes', group: 'database', tier: 3, proof: 'text', award: 'first',
    title: 'Back from the dead', prompt: 'First to get a "yes, let’s talk" out of a dead file.' }),
  c({ key: 'no_response_retry', group: 'database', tier: 1, proof: 'text', award: 'everyone',
    title: 'Try again', prompt: 'Find somebody tagged "no response" and try once more. Name them.' }),

  // ==== OBJECTIONS AND SKILL ==============================================
  c({ key: 'no_to_maybe', group: 'skill', tier: 2, proof: 'text', award: 'everyone',
    title: 'No to maybe', prompt: 'Turn a "not interested" into a "maybe". What was the objection, and what did you say?' }),
  c({ key: 'rate_objection', group: 'skill', tier: 2, proof: 'peer', award: 'everyone',
    title: 'The rate objection', prompt: 'Handle a rate objection properly. A teammate confirms you talked it through.' }),
  c({ key: 'hardest_objection', group: 'skill', tier: 1, proof: 'text', award: 'everyone',
    title: 'The hardest one this hour', prompt: 'Write down the toughest objection you heard this hour and how you answered it.' }),
  c({ key: 'no_to_appointment', group: 'skill', tier: 4, proof: 'text', award: 'first',
    title: 'A hard no, turned', prompt: 'First to turn a flat no into a booked appointment.' }),
  c({ key: 'just_looking', group: 'skill', tier: 2, proof: 'text', award: 'everyone',
    title: '"Just looking around"', prompt: 'Handle a "just looking" and get a real next step. Describe it.' }),

  // ==== FOLLOW-UP =========================================================
  c({ key: 'clear_five_callbacks', group: 'followup', tier: 1, proof: 'count', award: 'everyone',
    title: 'Clear five callbacks', prompt: 'Five callbacks off your list in the next fifteen minutes.' }),
  c({ key: 'three_day_old', group: 'followup', tier: 2, proof: 'text', award: 'everyone',
    title: 'Three days untouched', prompt: 'Call back a lead that has been sitting for three days or more.' }),
  c({ key: 'queue_before_after', group: 'followup', tier: 1, proof: 'upload', award: 'everyone',
    title: 'Before and after', prompt: 'Screenshot your callback queue before and after clearing three of them.' }),
  c({ key: 'zero_the_queue', group: 'followup', tier: 3, proof: 'upload', award: 'first',
    title: 'Zero the queue', prompt: 'First to empty their callback queue today.' }),
  c({ key: 'early_callback', group: 'followup', tier: 2, proof: 'text', award: 'everyone',
    title: 'Early, not next week', prompt: 'Follow up with somebody who said "call me next week" — early. Name them.' }),

  // ==== THE ROOM ==========================================================
  c({ key: 'high_five', group: 'fun', tier: 1, proof: 'checkin', award: 'everyone',
    title: 'High five somebody', prompt: 'Somebody just booked something. Go and say so. Tag them in the chat.' }),
  c({ key: 'best_line', group: 'fun', tier: 1, proof: 'text', award: 'everyone',
    title: 'Your best line', prompt: 'Post the single best line you used on a call today.' }),
  c({ key: 'first_three_any_two', group: 'fun', tier: 2, proof: 'checkin', award: 'first_n', slots: 3,
    title: 'Any two, first three people', prompt: 'First three people to finish any two challenges from this hour split a bonus.' }),
  c({ key: 'flash_three_minutes', group: 'fun', tier: 4, proof: 'peer', award: 'first',
    title: 'Flash — three minutes only', prompt: 'Three-minute window. First person to get any verbal commitment on a call happening RIGHT NOW.' }),
  c({ key: 'coach_a_teammate', group: 'fun', tier: 2, proof: 'text', award: 'everyone',
    title: 'Coach somebody', prompt: 'Help a teammate through an objection they are stuck on. Name them.' }),
  c({ key: 'ten_minute_focus', group: 'fun', tier: 1, proof: 'checkin', award: 'everyone',
    title: 'Ten minutes, heads down', prompt: 'One uninterrupted ten-minute block of dialling. No breaks.' }),
  c({ key: 'vouch_for_help', group: 'fun', tier: 2, proof: 'peer', award: 'everyone',
    title: 'Get vouched for', prompt: 'Get a teammate to say you helped them land a connect or an appointment today.' }),
  c({ key: 'desk_photo', group: 'fun', tier: 1, proof: 'upload', award: 'everyone',
    title: 'Show us your desk', prompt: 'A photo of your desk mid-blitz. The room votes on the best one.' }),
];

const CHALLENGE_KEYS = CHALLENGES.map((x) => x.key);
const CHALLENGE_BY_KEY = Object.fromEntries(CHALLENGES.map((x) => [x.key, x]));
const GROUPS = [
  { key: 'calls', label: 'Dials' },
  { key: 'connects', label: 'Real conversations' },
  { key: 'talktime', label: 'Time on the phone' },
  { key: 'appointments', label: 'Appointments' },
  { key: 'apps', label: 'Applications' },
  { key: 'preapproval', label: 'Pre-approvals' },
  { key: 'locks', label: 'Locks' },
  { key: 'partners', label: 'Referral partners' },
  { key: 'database', label: 'The database' },
  { key: 'skill', label: 'Skill and objections' },
  { key: 'followup', label: 'Follow-up' },
  { key: 'crm', label: 'From the system' },
  { key: 'fun', label: 'For the room' },
];

/** Fill {placeholders} from a challenge's own vars plus anything supplied. */
function render(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => {
    const v = vars && vars[k];
    return v === undefined || v === null || v === '' ? m : String(v);
  });
}

/** One challenge, fully resolved — what the admin sees and what gets stored. */
function describe(key, overrides = {}) {
  const base = CHALLENGE_BY_KEY[key];
  if (!base) return null;
  const tier = TIER_BY_N[overrides.tier || base.tier] || TIER_BY_N[1];
  const vars = { ...(base.vars || {}), ...(overrides.vars || {}) };
  return {
    libraryKey: base.key,
    group: base.group,
    groupLabel: (GROUPS.find((g) => g.key === base.group) || {}).label || base.group,
    title: overrides.title || base.title,
    prompt: render(overrides.prompt || base.prompt, vars),
    detail: render(overrides.detail || base.detail || '', vars) || null,
    tier: tier.tier,
    tierLabel: tier.label,
    proofType: overrides.proof || base.proof,
    awardMode: overrides.award || base.award,
    slots: Math.max(1, Math.floor(Number(overrides.slots ?? base.slots) || 1)),
    ticketsAwarded: Math.max(0, Math.floor(Number(overrides.tickets ?? base.tickets ?? tier.tickets))),
    prizeCapCents: Math.max(0, Math.floor(Number(overrides.prizeCapCents ?? tier.prizeCapCents))),
    fromOwner: !!base.fromOwner,
    adminNote: base.adminNote || null,
    vars,
    // Said on the card, every time, so nobody sets one up believing PILOT will
    // check it: it will not, because it cannot.
    proofNote: 'PILOT has no call log or dialler to read, so whatever somebody claims here is checked by a person.',
  };
}

/** The whole library, resolved, for the admin's picker. */
const describeAll = () => CHALLENGE_KEYS.map((k) => describe(k));

/**
 * PLAN THE DAY.
 *
 * Given a window and a target gap, lay out when each challenge opens and
 * closes. Deterministic given its inputs — the `seed` drives the shuffle and
 * the jitter, so the same plan can be regenerated exactly, and the admin can
 * ask for a different one by changing the seed rather than by rolling dice
 * nobody can reproduce.
 *
 * WHAT IT ENFORCES, all three from the research:
 *   - the gap is jittered inside ±`jitterMinutes`, never a metronome;
 *   - at most MAX_CONCURRENT are open at once (a challenge's window is
 *     shortened rather than a third one being opened);
 *   - the mix walks the funnel — dials and partner calls early, applications
 *     and locks later — because a "first lock of the day" at 12:31 is a
 *     challenge nobody can win yet.
 *
 * PURE: `from` and `to` are passed in, and so is the seed. No clock.
 */
function planDay({ from, to, targetGapMinutes = 20, jitterMinutes = 5, seed = 1, keys = null, windowMinutes = 45 }) {
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  if (!(start < end)) return [];

  // A small deterministic generator. Not for anything that must be
  // unguessable — this only decides the ORDER of a published plan, which the
  // admin can see and change. The wheel's randomness is a different thing
  // entirely and lives in fair-draw.js.
  let s = (Math.floor(Number(seed)) || 1) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  const EARLY = ['calls', 'connects', 'partners', 'database', 'followup', 'fun', 'talktime', 'crm'];
  const LATE = ['appointments', 'apps', 'preapproval', 'locks', 'skill'];

  const pool = (keys && keys.length ? keys : CHALLENGE_KEYS).filter((k) => CHALLENGE_BY_KEY[k]);
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const totalMs = end - start;
  const out = [];
  let at = start.getTime();
  let n = 0;
  while (at < end.getTime() && n < 200) {
    const through = (at - start.getTime()) / totalMs;           // 0 at the start, 1 at the end
    const wantLate = through > 0.45;
    const prefer = wantLate ? LATE : EARLY;
    // Take the first shuffled key that fits this half of the day; fall back to
    // whatever is left rather than stopping early.
    let idx = shuffled.findIndex((k) => prefer.includes(CHALLENGE_BY_KEY[k].group));
    if (idx < 0) idx = 0;
    if (!shuffled.length) break;
    const key = shuffled.splice(idx, 1)[0];

    const opensAt = new Date(at);
    let closesAt = new Date(Math.min(at + windowMinutes * 60000, end.getTime()));
    // MAX_CONCURRENT: if opening this one would make three live at once, cut the
    // OLDEST one's window short rather than refusing to schedule this one.
    const openHere = out.filter((x) => x.closesAt > opensAt);
    if (openHere.length >= MAX_CONCURRENT) {
      const oldest = openHere[0];
      oldest.closesAt = new Date(Math.max(oldest.opensAt.getTime() + 60000, opensAt.getTime()));
    }
    out.push({ ...describe(key), seq: out.length + 1, opensAt, closesAt });

    const jitter = (rnd() * 2 - 1) * jitterMinutes;
    at += Math.max(3, targetGapMinutes + jitter) * 60000;
    n++;
  }
  return out;
}

/**
 * How many prize nominations somebody has earned, and how many are left.
 * The owner's rule, in one place: five chances buys one nomination.
 */
function nominationsEarned(ticketCount, used = 0, perNomination = TICKETS_PER_NOMINATION) {
  const per = Math.max(1, Math.floor(Number(perNomination) || TICKETS_PER_NOMINATION));
  const t = Math.max(0, Math.floor(Number(ticketCount) || 0));
  const earned = Math.floor(t / per);
  return {
    tickets: t,
    perNomination: per,
    earned,
    used: Math.max(0, Math.floor(Number(used) || 0)),
    left: Math.max(0, earned - Math.max(0, Math.floor(Number(used) || 0))),
    ticketsToNext: t % per === 0 && earned > 0 ? per : per - (t % per),
  };
}

/** The prize ceiling somebody has unlocked — the best tier they have won. */
function prizeCapFor(tiersWon = []) {
  const best = (tiersWon || []).reduce((a, t) => Math.max(a, Number(t) || 0), 0);
  return (TIER_BY_N[best] || { prizeCapCents: 0 }).prizeCapCents;
}

module.exports = {
  PROOF_TYPES, PROOF_KEYS, AWARD_MODES, TIERS, TIER_BY_N, GROUPS,
  TICKETS_PER_NOMINATION, MAX_CONCURRENT,
  CHALLENGES, CHALLENGE_KEYS, CHALLENGE_BY_KEY,
  render, describe, describeAll, planDay, nominationsEarned, prizeCapFor,
};
