/* THE URL SHAPE — the pure half of "open this person's full profile" (owner-directed
   2026-08-21). React-free ON PURPOSE, exactly like urlState.js under useUrlState.js and
   overlay-layers-store.js under overlay-layers.js: the RULE (where the link goes, and
   what it carries so the trip back exists) is a rule, and a rule that imports React can
   only be read as text — CI installs the root package alone, so `app-v2/node_modules`
   is not there and a test that pulled React in through this file could not run at all.
   Keep this file free of every import. */

/** The query key that carries the file you came from. A HINT, never an authorization. */
export const FROM_PARAM = 'from';

/**
 * The one URL shape for a person's full profile.
 * @param borrowerId the person
 * @param fromAppId  optional loan file to offer a way back to
 * @returns the path, or null when there is no person (the caller renders plain text —
 *          a name that looks like a link and goes nowhere is worse than a name)
 */
export function borrowerProfileHref(borrowerId, fromAppId) {
  if (!borrowerId) return null;
  const from = fromAppId ? `?${FROM_PARAM}=${encodeURIComponent(fromAppId)}` : '';
  return `/internal/borrowers/${encodeURIComponent(borrowerId)}${from}`;
}

/** What is on the other side, in one sentence — so a name that became a link says where it goes. */
export const PROFILE_LINK_TITLE =
  'Open this person’s full profile — their entities, their track record, every loan file they are on, '
  + 'their documents and their history. It opens as a full page, with a link back to this file.';
