/**
 * THE LIVE BASELINE — the one number that decides whether the mirror draws at all.
 *
 * rrweb's live scheduler compares each event's `timestamp` against the baseline
 * given to `startLive`, plus the elapsed time: an event OLDER than the baseline
 * is drawn at once, a NEWER one is queued for `baseline + elapsed`. Those
 * timestamps are stamped on the GUEST's machine. Seed the baseline from the
 * VIEWER's clock and two office computers a few seconds out of step make every
 * event "in the future" — nothing is ever drawn, and the watcher sees a blank
 * stage with a moving cursor. That is the owner's original report.
 *
 * WHY THIS IS ITS OWN FILE, with no imports. Three separate audits have now
 * shown that a guard which merely READS the screen's source cannot hold this:
 *   · the arithmetic was pinned by matching the literal call, and restamping the
 *     event one line earlier (`ev.timestamp = Date.now()`) restored the exact
 *     blank-mirror defect with the whole suite green (post-merge audit,
 *     2026-09-02);
 *   · the earlier `Number(ev && ev.timestamp) - 200 || Date.now() - 600` shape
 *     is wrong for a null or zero timestamp — `Number(null)` is 0, `0 - 200` is
 *     -200, and -200 is TRUTHY, so the fallback never runs and rrweb schedules
 *     every event about fifty-five years out: a permanently blank mirror from
 *     one bad event.
 * Both are answers to "what number comes out", so they belong in a function
 * somebody can call with real values and check. `test-cobrowse-pure` does, and
 * it also proves the answer does not move when the local clock does — which is
 * the property, stated directly.
 */

/**
 * The baseline to hand `startLive`, or `null` when this event cannot be trusted
 * to provide one and the caller should wait for the next.
 *
 * JUDGE THE TIMESTAMP FIRST, THEN SUBTRACT — never the other way round, for the
 * truthiness reason above.
 */
function liveBaseline(ev, bufferMs) {
  const ts = Number(ev && ev.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const b = Number(bufferMs);
  return ts - (Number.isFinite(b) && b >= 0 ? b : 0);
}

export { liveBaseline };
