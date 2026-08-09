/* Remember WHERE a staffer was inside a loan file so a browser REFRESH puts them
   back — the room (section) they were in and the exact section they were reading —
   instead of dumping them on the Overview (owner-reported: "when you refresh deep
   in a condition you get sent back to the top / the overview; you should refresh
   right to that section, with the condition section open where you were").

   WHY sessionStorage, not local: it survives a reload of the SAME tab — which is
   the whole point — and clears itself when the tab closes, so it never goes stale
   across days and never leaks one person's place to the next on a shared machine.

   WHY per-file (the file id is in the key): opening a DIFFERENT file must never
   inherit this file's room — the exact cross-file leak the [id] reset in
   StaffApplication.jsx has always guarded against. Keying on the id keeps that
   guarantee while letting each file remember its own place.

   Every call is a defensive no-op outside a browser and NEVER throws — remembering
   a place is a courtesy and must never be able to break the file view. */

const KEY = (id) => `pilot.filePlace.${id}`;

function load(id) {
  if (!id || typeof sessionStorage === 'undefined') return null;
  try { return JSON.parse(sessionStorage.getItem(KEY(id)) || 'null'); }
  catch (_) { return null; }
}

/* Merge a patch into the file's saved place. Merges (never clobbers the whole
   record) so a scroll write and a room write don't overwrite each other. */
export function savePlace(id, patch) {
  if (!id || typeof sessionStorage === 'undefined' || !patch) return;
  try {
    const cur = load(id) || {};
    sessionStorage.setItem(KEY(id), JSON.stringify({ ...cur, ...patch }));
  } catch (_) { /* courtesy only */ }
}

/* The room (station id, e.g. 'st-review') the reader was last in, or null. */
export function readStation(id) {
  const p = load(id);
  return p && typeof p.station === 'string' && p.station ? p.station : null;
}

/* The exact section (e.g. 'sec-conditions') they were reading, or null. */
export function readSection(id) {
  const p = load(id);
  return p && typeof p.section === 'string' && p.section ? p.section : null;
}

/* Record a room switch. Clears the section — a rail click starts at the top of
   the new room, so the old section is no longer where they are. */
export function writeStation(id, station) {
  if (station) savePlace(id, { station, section: '' });
}
