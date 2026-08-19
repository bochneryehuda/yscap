'use strict';
/**
 * READY-TO-GO PLANS — the two the owner described, pre-filled, one click away.
 *
 * WHY THESE ARE TEMPLATES AND NOT CODE. The owner asked for "a pre-filled
 * template ready to go … everything should also be ready in templates for next
 * time". So each one below is a SET OF ANSWERS to the ordinary new-spin form —
 * the same form an admin fills in by hand. Loading a template fills the form
 * in; it does not take a different path through the system, and every value it
 * sets can be changed before anything goes out. Nothing here is a special case
 * inside the engine, which is why a template can be edited, copied or thrown
 * away without touching a line of code.
 *
 * THE TIMES ARE THE OWNER'S OWN, and they are LOCAL wall-clock times resolved
 * against a date the caller passes in — never hard-coded to a timezone, and
 * never to a date. "10:30" means half past ten where the room is.
 *
 * ── 1. THE EARLY BIRD ──────────────────────────────────────────────────────
 * The owner: "the first spin should be already pre-filled. It should
 * automatically launch 10:30 AM and should send notifications every 15 minutes
 * by email — remember to clock in once you arrive at the location and you're
 * already in the indoors of the property, and you still have this and this
 * amount of time. The ending of the time is 11:38. 11:30 AM you can send
 * already a hurry-up email, and 11:38 AM is final and it locks in."
 *
 * Then the double spin, and this is the part worth reading twice: "we're going
 * to choose two people from the people that are in the spin who are going to
 * stop the first spin … the first name is going to be the one that clicks the
 * Stop button on which loan officer, the second one … on which item is going to
 * be the winner."
 *
 * So it is FOUR wheels, not two, and the first two exist to hand out the
 * buttons:
 *     Wheel 1  — who gets the button for the officer wheel
 *     Wheel 2  — who gets the button for the prize wheel
 *     Wheel 3  — WHICH LOAN OFFICER WINS   (wheel 1's winner presses stop)
 *     Wheel 4  — WHAT THEY WIN             (wheel 2's winner presses stop)
 *
 * AND THE BUTTON REALLY IS A BUTTON. The wheel spins and keeps spinning until
 * they press it, and where it lands is genuinely decided by when they pressed —
 * nothing is chosen in advance. It still cannot be aimed: at this speed the
 * wheel crosses a slice in a few tens of milliseconds, so they can lean on
 * roughly which quarter and no finer. And it is still checkable afterwards,
 * because the landing comes from the sealed seed plus the moment the press
 * reached the server, both of which are on the record.
 *
 * ── 2. THE MEGA SPIN ───────────────────────────────────────────────────────
 * "That spin should go live from 11:38 AM till 6 pm … we're going to fill a
 * whole list of things that anybody that does any of these things puts in gets
 * another chance in the spin. Anybody can have unlimited chances. For every
 * five chances that they have in the spin, they can choose another thing to be
 * within the spin … every 20 minutes randomly it should populate another
 * challenge … it should start populating from 12:30."
 *
 * PURE: no database, no clock of its own. `build` is given the day.
 */

const lib = require('./challenge-library');

/** A local wall-clock time on a given day. `day` is 'YYYY-MM-DD'. */
function at(day, hhmm, offsetMinutes) {
  const [h, m] = String(hhmm).split(':').map((x) => parseInt(x, 10));
  const [Y, M, D] = String(day).split('-').map((x) => parseInt(x, 10));
  // Built in UTC and then shifted by the room's offset, so the result is the
  // same instant everywhere and "10:30" always means 10:30 where the room is.
  // The offset is passed in rather than read from the server, because the
  // server is in whatever region it happens to be in and the room is not.
  const utc = Date.UTC(Y, M - 1, D, h, m, 0, 0);
  return new Date(utc - (Number(offsetMinutes) || 0) * 60000);
}

const TEMPLATES = [
  {
    key: 'early_bird',
    label: 'The Early Bird',
    blurb: 'Clock in when you get here. Doors shut at 11:38. Then two people get the buttons, and we spin for who and for what.',
    howItReads: [
      'Opens by itself at 10:30 and nudges the team every fifteen minutes.',
      'A hurry-up at 11:30, and it locks itself at 11:38 — nobody has to remember to press anything.',
      'Everybody who clocks in and is approved can put one thing forward that they would like to win.',
      'Two wheels hand out the stop buttons, then two wheels decide the officer and the prize.',
    ],
    build({ day, offsetMinutes = 0 }) {
      const opens = at(day, '10:30', offsetMinutes);
      const deadline = at(day, '11:38', offsetMinutes);
      return {
        templateKey: 'early_bird',
        title: 'The Early Bird',
        subtitle: 'Clock in when you arrive. Doors shut at 11:38.',
        kind: 'elementix_double',
        launchAt: opens,
        entryOpensAt: opens,
        entryDeadlineAt: deadline,
        config: {
          wheels: [
            { source: 'checked_in', title: 'Who gets the button for the officer wheel' },
            { source: 'checked_in', title: 'Who gets the button for the prize wheel' },
            { source: 'checked_in', title: 'Which loan officer wins' },
            { source: 'approved_entries', title: 'What they win' },
          ],
          // Wheel 3's button goes to whoever wheel 1 landed on; wheel 4's to
          // wheel 2's. This is the owner's "two people who are going to stop
          // the spin", written down.
          stopHolders: [
            { wheel: 3, fromWheel: 1 },
            { wheel: 4, fromWheel: 2 },
          ],
          checkinRequired: true,
          autoApproveCheckins: false,
          entriesAllowed: true,
          autoApproveEntries: false,
          entriesPerPerson: 1,
          personalCapCents: 50000,
          businessCapCents: 100000,
          weightMode: 'equal',
          removeWinner: 'zero',
          durationMs: 9000,
          fullTurns: 7,
          suspenseMs: 1200,
          // Every fifteen minutes from the moment it OPENS, counted back from
          // the 11:38 door: 10:45, 11:00, 11:15 and the 11:30 hurry-up — which
          // is offsets 53, 38, 23 and 8. The owner named the 11:00 one out
          // loud ("an alarm by eleven o'clock that you still have 38 minutes"),
          // and the first cut ([60,45,30,15,8]) missed it by counting from the
          // wrong end — its alarms landed at 10:38/10:53/11:08/11:23, none of
          // them on the clock times the owner said. The 10:30 opening already
          // announces itself, so no offset-68 is needed.
          reminderOffsetsMinutes: [53, 38, 23, 8],
          // The wording the person agrees to when they clock in. It is stored
          // with their check-in, so what they attested to is on the record
          // rather than being remembered differently later.
          attestation: 'I am here, inside the building, and clocking in now.',
        },
        announcement: [
          'The Early Bird is open. Clock in from your own screen the moment you are inside the building.',
          'Doors shut at 11:38 sharp — after that the wheel is set and nobody else can get on it.',
          'Once you are in, tell us one thing you would like to win: anything personal up to $500, or',
          'anything for your business up to $1,000. Every one of them gets read before it goes on the wheel.',
        ].join(' '),
        emailSubject: 'Elementix Day: clock in before 11:38',
      };
    },
  },

  {
    key: 'mega_spin',
    label: 'The Mega Spin',
    blurb: 'All day, 11:38 to six. Challenges land on your screen. Every one you do is another chance.',
    howItReads: [
      'Opens at 11:38, the moment the Early Bird shuts, and runs until six.',
      'Challenges start landing at 12:30, roughly every twenty minutes — but never on the dot, so nobody can time them.',
      'Do one, earn chances. There is no limit on how many you can have.',
      'Every five chances lets you put another thing on the prize wheel. The bigger the challenge you won, the more you may ask for — up to $2,000.',
      'Never more than two challenges live at once, so nobody is chasing three things and finishing none.',
    ],
    build({ day, offsetMinutes = 0, seed = 19 }) {
      const opens = at(day, '11:38', offsetMinutes);
      const ends = at(day, '18:00', offsetMinutes);
      const firstChallenge = at(day, '12:30', offsetMinutes);
      return {
        templateKey: 'mega_spin',
        title: 'The Mega Spin',
        subtitle: 'All day. Every challenge you finish is another chance.',
        kind: 'ticket_lottery',
        launchAt: opens,
        entryOpensAt: opens,
        entryDeadlineAt: ends,
        config: {
          wheels: [
            { source: 'checked_in_any', title: 'Who wins' },
            { source: 'approved_entries', title: 'What they win' },
          ],
          checkinRequired: true,
          autoApproveCheckins: true,          // the challenges are the gate, not the door
          entriesAllowed: true,
          autoApproveEntries: false,
          // Unlimited chances, and unlimited nominations — as many as the
          // tickets pay for. The five-per-nomination rule does the limiting.
          entriesPerPerson: 20,
          personalCapCents: 50000,
          businessCapCents: 100000,
          // The ceiling for the very biggest challenge of the day.
          maxPrizeCapCents: 200000,
          // Chances are the odds here. That is the whole design of this one.
          weightMode: 'tickets',
          ticketsAreWeights: true,
          removeWinner: 'keep',
          durationMs: 14000,
          fullTurns: 10,
          suspenseMs: 2000,
          maxCandidates: 200,
          // Six and a half hours is a long time to be pinged. Four reminders,
          // not forty — the research on notification fatigue is blunt that past
          // about ten an hour people stop reading any of them, and a sales floor
          // is already interrupted every few minutes without our help.
          reminderOffsetsMinutes: [120, 60, 20],
          challengePlan: {
            from: firstChallenge,
            to: ends,
            targetGapMinutes: 20,
            jitterMinutes: 5,
            windowMinutes: 45,
            seed,
          },
        },
        announcement: [
          'The Mega Spin is open and runs until six.',
          'Challenges will land on your screen through the afternoon — the first at half twelve, then roughly',
          'every twenty minutes, though never quite on the dot. Finish one and you earn chances in the draw.',
          'There is no limit: every five chances lets you add another prize to the wheel, and the bigger the',
          'challenge you take, the more you are allowed to ask for.',
        ].join(' '),
        emailSubject: 'The Mega Spin is open until 6pm',
      };
    },
  },
];

const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);
const TEMPLATE_BY_KEY = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

/** The list an admin picks from, with no dates resolved. */
function describeTemplates() {
  return TEMPLATES.map((t) => ({ key: t.key, label: t.label, blurb: t.blurb, howItReads: t.howItReads }));
}

/** One template, resolved against a real day. */
function buildTemplate(key, opts) {
  const t = TEMPLATE_BY_KEY[key];
  if (!t) return null;
  return t.build(opts || {});
}

/**
 * Which wheel, if any, hands its winner the button for a later wheel.
 * Returns the wheel number (1-based) whose winner holds wheel `seq`'s button,
 * or null. THE one reader of the `stopHolders` config shape.
 */
function stopHolderSource(config, seq) {
  const list = (config && Array.isArray(config.stopHolders)) ? config.stopHolders : [];
  const hit = list.find((x) => Number(x && x.wheel) === Number(seq));
  return hit && Number(hit.fromWheel) > 0 ? Number(hit.fromWheel) : null;
}

/** The sentence the button-holder reads, every time, before they press it. */
const STOP_BUTTON_TRUTH =
  'This really does stop it, and where it lands is down to when you press. It is going too fast to '
  + 'aim properly — you can lean on roughly a quarter of the wheel, no finer. Nobody can check it '
  + 'in advance either: the number that shifts it is sealed until afterwards.';

module.exports = {
  TEMPLATES, TEMPLATE_KEYS, TEMPLATE_BY_KEY,
  describeTemplates, buildTemplate, stopHolderSource, STOP_BUTTON_TRUTH, at,
  TICKETS_PER_NOMINATION: lib.TICKETS_PER_NOMINATION,
};
