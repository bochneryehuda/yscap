'use strict';
/**
 * THE GAME CATALOG -- every kind of spin the Arena can run.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. Every entry here is a
 * PRE-FILLED SETTING, not a hard-coded behaviour. A game type says which wheels
 * to put up and what the sensible answers are; the admin sees those answers
 * already filled in on the "new spin" form and changes anything they like
 * before starting. Nothing in this file forces an outcome, and deleting an
 * entry removes an option -- it never breaks a spin already recorded, because a
 * spin stores the CONFIG it ran with, not a pointer to this list.
 *
 * WHERE THE LIST CAME FROM. These are not invented. They are the formats that
 * real sales-gamification platforms actually ship (Spinify's Poker Stars, Flash
 * Friday, Musical Chairs, the Sales Playoffs bracket; SalesScreen's Lottery,
 * multi-round and relay competitions; Hoopla's finance point ladder and
 * Application Blitz; RepCard's You-vs-You, Best-vs-Rest and tiered brackets;
 * the instant-win family -- scratch card, mystery box, slot pull), plus the
 * mortgage-specific call-blitz metrics loan officers are actually measured on.
 * Each entry records its `origin` so nobody has to guess later why it is here.
 * The sources are listed in docs/ARENA-GAME-ENGINE-RESEARCH.md.
 *
 * THE ONE OPINION BAKED INTO THE DEFAULTS. The research is consistent and
 * blunt: winner-take-all formats stop the middle of a sales team from trying,
 * because once the top performers pull ahead everyone else knows they cannot
 * catch up. So the DEFAULT weighting on every game here is `equal`, and the
 * ticket-weighted formats are offered as an explicit choice rather than the
 * path of least resistance. An admin who wants a leaderboard-shaped contest can
 * have one in two clicks; they just have to mean it.
 *
 * WHAT IS NOT MEASURABLE HERE, SAID PLAINLY. Several of these games are about
 * things this system does not record -- talk time, dial counts, connects, a
 * tough rejection. There is NO call log and NO dialer integration anywhere in
 * this codebase. Those games are marked `needs: ['claims']`, which means the
 * game runs on people claiming what they did with proof a super admin approves,
 * and the UI says so on the card rather than implying a number came from
 * somewhere. Games marked `needs: ['pipeline']` DO read real data -- the RTL
 * loan files. Nothing is presented as automatic that is not.
 *
 * PURE: no database, no config, no clock. The only require is the (lazily
 * database-backed) source registry, and only for its list of KEYS, so that a
 * game can never name a wheel source that does not exist --
 * scripts/test-arena-game-types-pure.js fails the build the moment one does.
 */

const { SOURCE_KEYS, SOURCE_BY_KEY, WEIGHT_MODE_KEYS } = require('./candidate-sources');

/** How a spin decides who is allowed on the wheel at all. */
const FAMILIES = [
  { key: 'signature',   label: 'The Elementix format', blurb: 'Check in before the cutoff, say what you want to win, then we spin for who and we spin for what.' },
  { key: 'raffle',      label: 'Raffles and draws',    blurb: 'Everyone in the pool, one name out. The format that keeps the whole team in it.' },
  { key: 'achievement', label: 'What you did today',   blurb: 'Spin the thing that wins, then spin between the people who did it.' },
  { key: 'pipeline',    label: 'Straight from the CRM', blurb: 'Wheels built out of the real loan pipeline -- live files, recent closings, the officers behind them.' },
  { key: 'headtohead',  label: 'Head to head',         blurb: 'Two names, one winner. Brackets, playoffs and duels.' },
  { key: 'team',        label: 'Teams',                blurb: 'Squads rather than individuals.' },
  { key: 'personal',    label: 'You against you',      blurb: 'Formats that reward improvement instead of raw volume, so the middle of the team stays in the game.' },
  { key: 'novelty',     label: 'For the fun of it',    blurb: 'The ones that break up a long day of dialling.' },
];
const FAMILY_KEYS = FAMILIES.map((f) => f.key);

// The defaults every game inherits unless it says otherwise. Kept in ONE place
// so "what happens if the admin changes nothing" has a single answer.
const BASE_DEFAULTS = {
  checkinRequired: false,     // must a person check in before they are on the wheel?
  autoApproveCheckins: true,  // or does a super admin wave each one through?
  entriesAllowed: false,      // may people type what they want to win?
  autoApproveEntries: false,  // entries are screened by default -- money is involved
  weightMode: 'equal',
  removeWinner: 'keep',       // 'keep' | 'zero' | 'remove' once somebody has won today
  qualifiersMustHaveClaimants: true,
  fullTurns: 6,
  durationMs: 7000,
  suspenseMs: 700,
  maxCandidates: 60,
  sound: true,
  confetti: true,
};

/** Shorthand for a wheel stage. */
const wheel = (source, title) => ({ source, title });

const GAMES = [
  // ---------------------------------------------------------------- signature
  {
    key: 'elementix_double',
    family: 'signature',
    label: 'The Elementix double spin',
    blurb: 'Check in before the cutoff, type what you want to win, we approve it -- then one wheel picks the person and a second picks the prize.',
    howItWorks: 'People check in from their own login before the deadline. Everyone approved may type one thing they want: anything personal up to the personal cap, anything for their business up to the business cap. You accept or decline each one. Then the first wheel picks WHO wins and the second picks WHAT they win.',
    wheels: [wheel('checked_in', 'Who wins'), wheel('approved_entries', 'What they win')],
    defaults: { checkinRequired: true, autoApproveCheckins: false, entriesAllowed: true, removeWinner: 'zero' },
    origin: 'The owner\'s own description of Elementix Day spin number one.',
  },
  {
    key: 'elementix_prize_first',
    family: 'signature',
    label: 'The Elementix double spin, prize first',
    blurb: 'The same thing the other way round -- the prize is revealed first, then we find out who just won it.',
    howItWorks: 'Identical to the double spin, with the wheels swapped. Revealing the prize first and the person second is usually the bigger moment in a room.',
    wheels: [wheel('approved_entries', 'What is up for grabs'), wheel('checked_in', 'Who just won it')],
    defaults: { checkinRequired: true, autoApproveCheckins: false, entriesAllowed: true, removeWinner: 'zero' },
    origin: 'The owner: "or two opposite, or we can spin what we\'re gonna spin first".',
  },
  {
    key: 'elementix_triple',
    family: 'signature',
    label: 'The Elementix triple spin',
    blurb: 'Three wheels: what you had to have done, who did it, and what they win.',
    howItWorks: 'Wheel one lands on one of the things you listed for this spin. Wheel two spins between the people whose claim to that one you approved. Wheel three picks the prize.',
    wheels: [wheel('qualifiers', 'What wins'), wheel('qualifier_claimants', 'Who did it'), wheel('approved_entries', 'What they win')],
    defaults: { checkinRequired: true, autoApproveCheckins: false, entriesAllowed: true },
    needs: ['claims'],
    origin: 'The owner\'s three-way idea: a long call, a tough rejection, or a closed deal -- spin between the three, then between the people who have it.',
  },

  // ------------------------------------------------------------------ raffle
  {
    key: 'classic_raffle',
    family: 'raffle',
    label: 'Straight raffle',
    blurb: 'One wheel, everyone on it, one winner. The simplest thing that works.',
    howItWorks: 'Everyone in the session goes on the wheel with one slice each, and one name comes out.',
    wheels: [wheel('session_members', 'The draw')],
    defaults: {},
    origin: 'The baseline every wheel tool ships (Wheel of Names, PickerWheel).',
  },
  {
    key: 'checkin_raffle',
    family: 'raffle',
    label: 'Made-the-cutoff raffle',
    blurb: 'Only the people who checked in before the deadline are on the wheel.',
    howItWorks: 'Set a deadline. People check in from their login. Anyone who did not make it is not on the wheel, and everyone can see the list before it spins.',
    wheels: [wheel('checked_in', 'Everyone who made it')],
    defaults: { checkinRequired: true, autoApproveCheckins: false },
    origin: 'The owner: "everybody that arrived before 11:38 goes into the spin".',
  },
  {
    key: 'ticket_lottery',
    family: 'raffle',
    label: 'Tickets earned',
    blurb: 'More tickets, better odds -- but nobody is ever out of it.',
    howItWorks: 'You set how many tickets each person holds. Their slice grows with their tickets, so the hardest workers really are likelier to win, and the person on one ticket still might.',
    wheels: [wheel('checked_in', 'The ticket draw')],
    defaults: { checkinRequired: true, weightMode: 'tickets' },
    origin: 'SalesScreen\'s Lottery competition -- the format built specifically so the middle of the team stays engaged all day.',
  },
  {
    key: 'hourly_draw',
    family: 'raffle',
    label: 'Top-of-the-hour draw',
    blurb: 'A quick draw every hour so the energy never sags to the end of the day.',
    howItWorks: 'A small, fast spin among everyone still checked in. Run one an hour rather than saving everything for a single draw at five o\'clock.',
    wheels: [wheel('checked_in', 'This hour')],
    defaults: { checkinRequired: true, durationMs: 5000, fullTurns: 4 },
    origin: 'The live-blitz pattern: draw at the top of each power hour, not only at the end.',
  },
  {
    key: 'grand_finale',
    family: 'raffle',
    label: 'The grand finale',
    blurb: 'The last draw of the day, out of everyone who was here for it, with the long dramatic spin.',
    howItWorks: 'Everybody in the session, the big prize, and a slower wheel with a longer pause before it lands.',
    wheels: [wheel('session_members', 'The finale')],
    defaults: { durationMs: 12000, fullTurns: 9, suspenseMs: 1500 },
    origin: 'The end-of-day grand-prize draw every blitz playbook closes on.',
  },
  {
    key: 'no_repeat_raffle',
    family: 'raffle',
    label: 'Nobody wins twice',
    blurb: 'Anyone who has already won today comes off the wheel.',
    howItWorks: 'Same as a straight raffle, except every previous winner in this session is removed, so the prizes spread across the room.',
    wheels: [wheel('checked_in', 'Everyone still eligible')],
    defaults: { checkinRequired: true, removeWinner: 'remove' },
    origin: 'The elimination / remove-after-win mode every wheel tool ships.',
  },
  {
    key: 'catalog_wheel',
    family: 'raffle',
    label: 'Spin the prize list',
    blurb: 'The person is already decided -- spin to find out what they get.',
    howItWorks: 'Use this on its own when somebody has earned a spin. The wheel is your standing prize list from settings, so nothing needs typing on the day.',
    wheels: [wheel('prize_catalog', 'What you won')],
    defaults: {},
    origin: 'The classic earn-a-spin wheel of fortune.',
  },
  {
    key: 'quick_wheel',
    family: 'raffle',
    label: 'Type a list, spin it',
    blurb: 'Anything at all, one per line. Thirty seconds to set up.',
    howItWorks: 'Paste or type whatever you want on the wheel. Nothing is stored beyond this spin.',
    wheels: [wheel('custom_list', 'The wheel')],
    defaults: { durationMs: 5000 },
    origin: 'What people actually use a public wheel site for.',
  },
  {
    key: 'mystery_box',
    family: 'raffle',
    label: 'Mystery box',
    blurb: 'The slices are blank. Nobody sees what they won until it lands.',
    howItWorks: 'Same wheel, hidden labels. The prize is only revealed at the moment it stops.',
    wheels: [wheel('prize_catalog', 'Pick a box')],
    defaults: { hideLabels: true },
    origin: 'The instant-win family: mystery box / mystery result, as shipped by PickerWheel and the gamification vendors.',
  },
  {
    key: 'scratch_card',
    family: 'raffle',
    label: 'Scratch card',
    blurb: 'Earn one scratch per connect. Quick, cheap, and constant.',
    howItWorks: 'Give people a spin each time they do the thing, and run a short wheel with mostly small prizes and one big one.',
    wheels: [wheel('prize_catalog', 'Scratch')],
    defaults: { durationMs: 3500, fullTurns: 3, confetti: true },
    origin: 'The instant-win scratch-off format.',
  },
  {
    key: 'double_or_nothing',
    family: 'raffle',
    label: 'Double or nothing',
    blurb: 'A winner can risk it on a second wheel that either doubles the prize or takes it away.',
    howItWorks: 'Run the prize wheel, then offer a second wheel with the doubled prize on some slices and nothing on the rest. Their call whether to take it.',
    wheels: [wheel('custom_list', 'Double, or nothing')],
    defaults: { durationMs: 6000 },
    origin: 'The stretch-target bonus spin used in call-blitz contests.',
  },

  // ------------------------------------------------------------- achievement
  {
    key: 'achievement_spin',
    family: 'achievement',
    label: 'What wins, then who did it',
    blurb: 'List the things that could win, spin one, then spin between the people who did it.',
    howItWorks: 'You write the list -- a call over ten minutes, a tough rejection somebody stayed on, a deal closed. People claim the ones they did and attach their proof; you approve. The first wheel picks which one wins and the second picks who.',
    wheels: [wheel('qualifiers', 'What wins'), wheel('qualifier_claimants', 'Who did it')],
    defaults: { checkinRequired: false },
    needs: ['claims'],
    origin: 'The owner\'s own three-way example. Claims rather than metrics because there is no call log in this system to read.',
  },
  {
    key: 'long_call',
    family: 'achievement',
    label: 'The longest conversations',
    blurb: 'Everyone who held a real conversation over the length you set.',
    howItWorks: 'People claim the call and paste what proves it. Approve the ones that hold up and spin between them.',
    wheels: [wheel('qualifier_claimants', 'The long talkers')],
    defaults: {},
    needs: ['claims'],
    origin: 'The owner: "whoever had a call more than 10 minutes -- you can show me a call log". Nothing in PILOT records call length, so this runs on claims.',
  },
  {
    key: 'tough_rejection',
    family: 'achievement',
    label: 'Best tough rejection',
    blurb: 'Rewards the calls that went badly and were handled well.',
    howItWorks: 'People post the rejection they took and how they handled it. Approve the real ones and spin. Turning a no into something worth telling the room about is the point.',
    wheels: [wheel('qualifier_claimants', 'Who stayed on the call')],
    defaults: {},
    needs: ['claims'],
    origin: 'The owner\'s example, and the well-documented "most no\'s" contest that reframes rejection as progress.',
  },
  {
    key: 'closed_today',
    family: 'achievement',
    label: 'Closed something today',
    blurb: 'Only the people who got one over the line.',
    howItWorks: 'Claim it, show the file, get approved, go on the wheel.',
    wheels: [wheel('qualifier_claimants', 'Today\'s closers')],
    defaults: {},
    needs: ['claims'],
    origin: 'The owner\'s third example.',
  },
  {
    key: 'first_to_show',
    family: 'achievement',
    label: 'First to show it wins',
    blurb: 'Whoever produces the proof first takes it -- no wheel needed unless two arrive together.',
    howItWorks: 'Announce what you want to see. The first approved claim wins outright. If two land at once, the wheel breaks the tie between exactly those two.',
    wheels: [wheel('qualifier_claimants', 'The tie-break')],
    defaults: { durationMs: 4000, fullTurns: 3 },
    needs: ['claims'],
    origin: 'The owner: "that person that has this and comes the first showing it wins it -- if there\'s two people, it spins between two people".',
  },
  {
    key: 'appointment_set',
    family: 'achievement',
    label: 'Set an appointment',
    blurb: 'The metric that actually predicts loans -- meetings booked, not dials made.',
    howItWorks: 'Claim the appointment with who and when. Approve and spin.',
    wheels: [wheel('qualifier_claimants', 'Who booked one')],
    defaults: {},
    needs: ['claims'],
    origin: 'Appointments set is one of the headline numbers every published mortgage call-blitz reports.',
  },
  {
    key: 'referral_partner_touch',
    family: 'achievement',
    label: 'Referral-partner touches',
    blurb: 'Realtors, CPAs, advisers -- the calls that pay off next quarter, not today.',
    howItWorks: 'Claim each partner conversation. Best used with tickets on, so ten touches really does beat one.',
    wheels: [wheel('qualifier_claimants', 'Who worked their partners')],
    defaults: { weightMode: 'tickets' },
    needs: ['claims'],
    origin: 'Referral-partner outreach is a standard blitz-day list and is measured separately from lead calls.',
  },
  {
    key: 'database_reactivation',
    family: 'achievement',
    label: 'Woke up the database',
    blurb: 'Past clients brought back into a live conversation.',
    howItWorks: 'Claim each reactivated contact. This is the highest-return activity on most blitz days and the one people skip.',
    wheels: [wheel('qualifier_claimants', 'Who went back to the database')],
    defaults: { weightMode: 'tickets' },
    needs: ['claims'],
    origin: 'Database reactivation is repeatedly named the highest-ROI blitz activity in mortgage marketing sources.',
  },
  {
    key: 'best_opener',
    family: 'achievement',
    label: 'Best opener',
    blurb: 'A skill contest, not a volume one -- the room votes or you judge.',
    howItWorks: 'People post the opener that worked. Approve the entries, then spin between them, or just pick.',
    wheels: [wheel('qualifier_claimants', 'The openers')],
    defaults: {},
    needs: ['claims'],
    origin: 'The best-opener / best-objection-handling contest from published power-hour playbooks.',
  },
  {
    key: 'most_nos',
    family: 'achievement',
    label: 'Most no\'s',
    blurb: 'Celebrates the person who got told no the most times, on purpose.',
    howItWorks: 'Count the rejections. Turn tickets on so the count is the odds. It sounds like a joke and it is one of the most effective formats there is.',
    wheels: [wheel('qualifier_claimants', 'Who heard no the most')],
    defaults: { weightMode: 'tickets' },
    needs: ['claims'],
    origin: 'The documented "getting the most no\'s" contest -- reframes rejection as measurable progress.',
  },

  // ---------------------------------------------------------------- pipeline
  {
    key: 'active_file_wheel',
    family: 'pipeline',
    label: 'Spin the live pipeline',
    blurb: 'Every loan file that is live right now goes on the wheel. The file that lands wins its officer something.',
    howItWorks: 'Reads the real pipeline. The wheel shows loan number and borrower; when it lands, the officer on that file is the winner.',
    wheels: [wheel('active_files', 'The live files')],
    defaults: { maxCandidates: 60 },
    needs: ['pipeline'],
    origin: 'The owner: "we should spin all files that is currently active".',
  },
  {
    key: 'closed_last_week',
    family: 'pipeline',
    label: 'Closed in the last week',
    blurb: 'Only the files that actually closed inside the window you choose.',
    howItWorks: 'Set the number of days -- seven for "last week". Every file that closed in that window is a slice, and its officer wins.',
    wheels: [wheel('closed_files_window', 'Recently closed')],
    defaults: { windowDays: 7, maxCandidates: 60 },
    needs: ['pipeline'],
    origin: 'The owner: "all that closed with, and last week for example, and the file that wins, that officer wins something".',
  },
  {
    key: 'closed_last_month',
    family: 'pipeline',
    label: 'Closed in the last month',
    blurb: 'The same thing over thirty days.',
    howItWorks: 'A wider window for a bigger pool and a bigger prize.',
    wheels: [wheel('closed_files_window', 'Closed this month')],
    defaults: { windowDays: 30, maxCandidates: 120 },
    needs: ['pipeline'],
    origin: 'The same request over a longer window.',
  },
  {
    key: 'busiest_officers',
    family: 'pipeline',
    label: 'Officers with live files',
    blurb: 'Spins between the officers who actually have work in the pipeline, weighted by how much.',
    howItWorks: 'Every officer with something live is on the wheel. Turn tickets on and their file count becomes their slice size automatically.',
    wheels: [wheel('officers_of_active_files', 'Who is carrying the pipeline')],
    defaults: { weightMode: 'tickets' },
    needs: ['pipeline'],
    origin: 'Connecting the game to the CRM the owner asked for, without needing anybody to type a number.',
  },
  {
    key: 'file_then_prize',
    family: 'pipeline',
    label: 'A file, then a prize',
    blurb: 'Spin the pipeline for the file, then spin for what its officer wins.',
    howItWorks: 'Two wheels. The first lands on a real loan file; the second decides the prize for the officer behind it.',
    wheels: [wheel('active_files', 'The file'), wheel('approved_entries', 'What its officer wins')],
    defaults: { entriesAllowed: true },
    needs: ['pipeline'],
    origin: 'The owner\'s pipeline spin combined with the double-spin shape.',
  },

  // -------------------------------------------------------------- head to head
  {
    key: 'duel',
    family: 'headtohead',
    label: 'Head to head',
    blurb: 'Two names you pick. One wheel. Ten seconds.',
    howItWorks: 'Tick exactly two people and spin. Good for settling anything.',
    wheels: [wheel('selected_staff', 'The duel')],
    defaults: { durationMs: 4500, fullTurns: 3 },
    origin: 'The head-to-head format every gamification platform ships.',
  },
  {
    key: 'bracket_round',
    family: 'headtohead',
    label: 'Bracket round',
    blurb: 'One round of a knockout. Run it again for the next round.',
    howItWorks: 'Pick the pair for this round and spin. Record it, then set up the next round from the winners.',
    wheels: [wheel('selected_staff', 'This round')],
    defaults: { durationMs: 5000, removeWinner: 'keep' },
    origin: 'Spinify\'s Sales Playoffs bracket, run one round at a time.',
  },
  {
    key: 'best_vs_rest',
    family: 'headtohead',
    label: 'Best against the rest',
    blurb: 'The top closers on one side, everybody else on the other. The handicap is the point.',
    howItWorks: 'Put your strongest two or three on one slice and the rest of the floor on the other. It gives the room a real chance and it gives your best people something to prove.',
    wheels: [wheel('custom_list', 'Best or rest')],
    defaults: {},
    origin: 'RepCard\'s "Best vs Rest" -- a deliberate handicap so the contest is not decided in the first hour.',
  },
  {
    key: 'musical_chairs',
    family: 'headtohead',
    label: 'Musical chairs',
    blurb: 'Spin to knock somebody OUT. Keep going until one is left.',
    howItWorks: 'The name that lands is eliminated, not rewarded. Run it repeatedly through the day; the last one standing takes it.',
    wheels: [wheel('checked_in', 'Who is out')],
    defaults: { checkinRequired: true, removeWinner: 'remove', durationMs: 5500 },
    origin: 'Spinify\'s Musical Chairs call-blitz contest.',
  },

  // -------------------------------------------------------------------- team
  {
    key: 'team_draw',
    family: 'team',
    label: 'Team draw',
    blurb: 'Teams on the wheel instead of people. The whole winning team gets it.',
    howItWorks: 'Type your teams, one per line, and spin. Everyone on the team that lands wins.',
    wheels: [wheel('custom_list', 'The teams')],
    defaults: {},
    origin: 'Team-vs-team contests, deliberately mixing skill levels across squads.',
  },
  {
    key: 'team_then_member',
    family: 'team',
    label: 'Team, then one of them',
    blurb: 'Pick the team, then pick the person inside it.',
    howItWorks: 'The first wheel lands on a team, the second on somebody in it. Two moments instead of one.',
    wheels: [wheel('custom_list', 'The team'), wheel('selected_staff', 'Who on that team')],
    defaults: {},
    origin: 'The relay/squad formats, with the double-spin reveal.',
  },
  {
    key: 'three_legged_race',
    family: 'team',
    label: 'Three-legged race',
    blurb: 'Threes, mixing a strong performer with a middle and a newer one.',
    howItWorks: 'Build the trios yourself so no team is stacked, then draw between them.',
    wheels: [wheel('custom_list', 'The trios')],
    defaults: {},
    origin: 'Spinify\'s Sales Playoffs three-legged race.',
  },
  {
    key: 'everybody_or_nobody',
    family: 'team',
    label: 'Everybody or nobody',
    blurb: 'The draw only happens if the whole floor hits the number.',
    howItWorks: 'Set the target out loud. If the team gets there, you spin; if not, you do not. It puts the room on one side of the same line.',
    wheels: [wheel('session_members', 'The team draw')],
    defaults: {},
    origin: 'The relay format where the reward lands only if every member gets there.',
  },

  // ---------------------------------------------------------------- personal
  {
    key: 'personal_best',
    family: 'personal',
    label: 'You against you',
    blurb: 'Beat your own last-week number and you are on the wheel. Nothing to do with anyone else.',
    howItWorks: 'People claim that they beat their own previous best. It is the fairest format there is, and it is the one the quiet half of a sales floor can actually win.',
    wheels: [wheel('qualifier_claimants', 'Everyone who beat their own best')],
    defaults: {},
    needs: ['claims'],
    origin: 'RepCard\'s "You vs You" -- the antidote to a contest only the top closer can win.',
  },
  {
    key: 'most_improved',
    family: 'personal',
    label: 'Most improved',
    blurb: 'Percentage lift over your own baseline, not raw volume.',
    howItWorks: 'People claim their improvement. Turn tickets on if you want a bigger lift to mean better odds.',
    wheels: [wheel('qualifier_claimants', 'The climbers')],
    defaults: { weightMode: 'tickets' },
    needs: ['claims'],
    origin: 'The most-improved contest, standard in published sales-contest catalogs.',
  },
  {
    key: 'everyone_who_hit_it',
    family: 'personal',
    label: 'Everyone who hit the number',
    blurb: 'No ranking at all -- cross the line and you are in.',
    howItWorks: 'Set one threshold. Everyone who reaches it goes on the wheel with an equal slice. Multiple people can hit it, which is the whole idea.',
    wheels: [wheel('qualifier_claimants', 'Everyone who got there')],
    defaults: {},
    needs: ['claims'],
    origin: 'The milestone contest -- research on prize structure is clear that more than one winner beats one big winner.',
  },
  {
    key: 'streak_keepers',
    family: 'personal',
    label: 'Kept the streak',
    blurb: 'For the people who hit their number every single day, not just the big day.',
    howItWorks: 'Run it at the end of a week or a month between everyone who never missed.',
    wheels: [wheel('qualifier_claimants', 'The unbroken streaks')],
    defaults: {},
    needs: ['claims'],
    origin: 'The consistency/streak competition.',
  },

  // ---------------------------------------------------------------- novelty
  {
    key: 'flash_spin',
    family: 'novelty',
    label: 'Flash spin',
    blurb: 'Announced with no warning, closing in minutes. Nobody can plan for it.',
    howItWorks: 'Open it with a very short deadline and let the countdown do the work. Surprise is the mechanic.',
    wheels: [wheel('checked_in', 'Whoever got here in time')],
    defaults: { checkinRequired: true, autoApproveCheckins: true, durationMs: 5000 },
    origin: 'Spinify\'s Flash Friday -- a surprise mid-day contest with an immediate cutoff.',
  },
  {
    key: 'poker_card',
    family: 'novelty',
    label: 'Draw a card',
    blurb: 'Hit your number, draw a card. Best hand at the end of the week wins.',
    howItWorks: 'Use the wheel as the deck. Everyone who hits the daily target spins once for a card; you keep the hands.',
    wheels: [wheel('custom_list', 'The deck')],
    defaults: { durationMs: 4000 },
    origin: 'Spinify\'s Poker Stars call-blitz contest.',
  },
  {
    key: 'steal_the_gift',
    family: 'novelty',
    label: 'Steal the gift',
    blurb: 'Winners in order, and each one may take an earlier winner\'s prize instead.',
    howItWorks: 'Run the people wheel repeatedly. Each name that comes out either opens a new prize or takes one already on the table.',
    wheels: [wheel('checked_in', 'Who picks next')],
    defaults: { checkinRequired: true, removeWinner: 'remove' },
    origin: 'Spinify\'s Holiday Gift Exchange, the steal-a-gift format.',
  },
  {
    key: 'trivia_round',
    family: 'novelty',
    label: 'Trivia round',
    blurb: 'Spin for who has to answer. Breaks up four hours of dialling.',
    howItWorks: 'The wheel picks the person; you ask the question. Product knowledge, compliance, anything.',
    wheels: [wheel('checked_in', 'Who is answering')],
    defaults: { checkinRequired: true, durationMs: 4000, fullTurns: 3 },
    origin: 'Team trivia, used across blitz playbooks to break up call fatigue.',
  },
  {
    key: 'pick_the_music',
    family: 'novelty',
    label: 'Who picks the music',
    blurb: 'A thirty-second spin for the smallest prize that people care about most.',
    howItWorks: 'One wheel, everyone on it, the winner owns the floor playlist. Costs nothing and works every time.',
    wheels: [wheel('checked_in', 'Whose playlist')],
    defaults: { checkinRequired: true, durationMs: 4000, fullTurns: 3 },
    origin: 'The non-cash perk that shows up on every sales-floor prize list.',
  },
  {
    key: 'boss_does_it',
    family: 'novelty',
    label: 'The boss does your admin',
    blurb: 'The winner hands a manager their paperwork for the day.',
    howItWorks: 'One wheel. The prize is a person\'s afternoon, and it is consistently one of the most wanted things on the list.',
    wheels: [wheel('checked_in', 'Who gets a hand')],
    defaults: { checkinRequired: true },
    origin: 'A standard non-cash sales-floor perk. Research finds non-cash rewards are remembered and talked about far longer than cash of the same value.',
  },
];

// ---------------------------------------------------------------------------
// derived views -- GENERATED from the list above, never hand-maintained
// ---------------------------------------------------------------------------

const GAME_KEYS = GAMES.map((g) => g.key);
const GAME_BY_KEY = Object.fromEntries(GAMES.map((g) => [g.key, g]));

/** Every game with its defaults fully resolved, ready for the "new spin" form. */
function describeGames() {
  return GAMES.map((g) => ({
    key: g.key,
    family: g.family,
    label: g.label,
    blurb: g.blurb,
    howItWorks: g.howItWorks,
    wheels: g.wheels.map((w) => ({
      source: w.source,
      title: w.title,
      scope: (SOURCE_BY_KEY[w.source] || {}).scope || null,
      sourceLabel: (SOURCE_BY_KEY[w.source] || {}).label || w.source,
    })),
    defaults: { ...BASE_DEFAULTS, ...(g.defaults || {}) },
    needs: g.needs || [],
    // Said on the card, not buried: a game that needs claims is NOT reading a
    // number from anywhere, and the person setting it up deserves to know that
    // before the room does.
    dataNote: (g.needs || []).includes('claims')
      ? 'PILOT does not record call logs or talk time, so this one runs on people claiming what they did and a super admin approving it.'
      : (g.needs || []).includes('pipeline')
        ? 'This one reads the real loan pipeline -- no typing needed.'
        : null,
    origin: g.origin,
  }));
}

/** The starting config for a new spin of this kind. */
function defaultsFor(kind) {
  const g = GAME_BY_KEY[kind];
  if (!g) return null;
  return {
    kind: g.key,
    wheels: g.wheels.map((w) => ({ source: w.source, title: w.title })),
    ...BASE_DEFAULTS,
    ...(g.defaults || {}),
  };
}

/**
 * Is a spin's saved config coherent? Returns a list of plain-language problems,
 * empty when it is fine. Used by the API before a spin is saved AND by the test
 * that sweeps the whole catalog -- so a game type that names a wheel source
 * which does not exist fails the BUILD, not the sales day.
 */
function configProblems(config) {
  const out = [];
  const c = config || {};
  const wheels = Array.isArray(c.wheels) ? c.wheels : [];
  if (!wheels.length) out.push('This spin has no wheels on it.');
  if (wheels.length > 4) out.push('A spin can have at most four wheels.');
  wheels.forEach((w, i) => {
    if (!w || !w.source) out.push(`Wheel ${i + 1} does not say what goes on it.`);
    else if (!SOURCE_KEYS.includes(w.source)) out.push(`Wheel ${i + 1} uses "${w.source}", which is not a thing the Arena can put on a wheel.`);
  });
  if (c.weightMode && !WEIGHT_MODE_KEYS.includes(c.weightMode)) {
    out.push(`"${c.weightMode}" is not a way of weighting a wheel.`);
  }
  if (c.removeWinner && !['keep', 'zero', 'remove'].includes(c.removeWinner)) {
    out.push(`"${c.removeWinner}" is not a rule for people who already won.`);
  }
  const dur = Number(c.durationMs);
  if (c.durationMs !== undefined && (!Number.isFinite(dur) || dur < 1500 || dur > 60000)) {
    out.push('A spin has to run for between 1.5 and 60 seconds.');
  }
  const turns = Number(c.fullTurns);
  if (c.fullTurns !== undefined && (!Number.isInteger(turns) || turns < 1 || turns > 30)) {
    out.push('The wheel has to turn between 1 and 30 full times.');
  }
  return out;
}

module.exports = {
  FAMILIES, FAMILY_KEYS, BASE_DEFAULTS,
  GAMES, GAME_KEYS, GAME_BY_KEY,
  describeGames, defaultsFor, configProblems,
};
