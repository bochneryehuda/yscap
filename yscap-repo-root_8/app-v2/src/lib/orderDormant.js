/**
 * WHY AN ORDER'S CLOCK IS STOPPED, in words — ONE wording, two screens.
 *
 * The DECISION is the server's: `src/lib/order-sla.js` `orderState` reads the
 * file's status against `DORMANT_FILE_STATUSES` and ships `dormant` +
 * `dormantReason` on every order it describes. Neither screen re-derives it —
 * that was the bug this file exists to prevent. The cross-file Orders desk had
 * its own copy of the status list, so adding a status server-side would have
 * stopped the clock while the desk went on offering "Chase now", firing a
 * follow-up at a vendor on a deal that was over.
 *
 * This is ONLY the wording. A reason the map does not know still reads as
 * dormant (with a neutral label) rather than being mislabelled as one of the
 * three it does know — the previous ternary fell through to "file withdrawn" for
 * anything unrecognised, so a fourth entry added server-side would have told the
 * team a live file had been withdrawn.
 */
export const FILE_STATE_LABEL = {
  on_hold: 'file on hold',
  declined: 'file declined',
  withdrawn: 'file withdrawn',
};

/** The full marker, e.g. "file on hold — not being chased". Null when the order's
    clock IS running, so a caller can render it unconditionally. */
export function dormantMarker(state) {
  if (!state || !state.dormant) return null;
  return `${FILE_STATE_LABEL[state.dormantReason] || 'file not being worked'} — not being chased`;
}
