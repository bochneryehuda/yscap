import React from 'react';
import { Link } from 'react-router-dom';
import { borrowerProfileHref, PROFILE_LINK_TITLE } from '../lib/borrowerProfileUrl.js';

/* THE WAY INTO A PERSON'S FULL PROFILE, FROM INSIDE A LOAN FILE — and the way back.

   Owner-reported 2026-08-21: "Right now, when you're in a file, you don't have anywhere
   to access the borrower profile. In general, there's an entire massive profile of
   entities and stuff like that. You only see the details of the file. There should be a
   link somewhere to open up the full. In the file, you should be able to access it
   directly somehow and open up the borrower's profile on a full page. Think of an idea
   for the best way to do it."

   WHAT WAS ACTUALLY WRONG, stated plainly because a button DID exist. The profile panel
   on the file has carried an "Open full profile" button — but it sits inside Application
   details, which is COLLAPSED by default, and then inside that section's People tab. So
   reaching a person's profile meant opening two things first and knowing which. The
   owner's report is exact: from where you actually stand in a file, there is nowhere to
   go.

   THE ANSWER IS THE NAME. The place you are when you think "show me everything about
   this person" is the party list at the top of the file, looking at their name — so the
   name is the handle, on the overview, with no section to open first. The buried button
   stays where it is and now goes through this same definition, so the two doors cannot
   drift in where they land or what they carry.

   AND THE WAY BACK IS HALF THE FEATURE. A full page reached from inside a file is a
   one-way trip unless it knows where you came from: browser Back works until you touch
   a tab, and then the file is gone. So every link carries `?from=<application id>`, and
   the profile screen turns that into a plain "Back to the loan file" bar naming the
   property. It is a HINT, never an authorization: the profile screen resolves it
   against the person's OWN file list, so a file that is not theirs — or that the person
   reading cannot see — simply produces no bar. */

/* The URL shape itself lives in ../lib/borrowerProfileUrl.js — React-free, so the rule
   can be executed by a test in an environment where React is not installed (the same
   split urlState.js / useUrlState.js uses, for the same reason). Re-exported here so a
   caller needs one import. */
export { FROM_PARAM, borrowerProfileHref, PROFILE_LINK_TITLE } from '../lib/borrowerProfileUrl.js';

/**
 * `variant="name"`  — the person's own name, as the link (the overview handle).
 * `variant="button"` — a labelled button (the profile panel's header).
 *
 * With no borrower id it renders the children as PLAIN TEXT. A name that looks like a
 * link and goes nowhere is worse than a name.
 */
export default function BorrowerProfileLink({ borrowerId, fromAppId, children, variant = 'name', className, style }) {
  const href = borrowerProfileHref(borrowerId, fromAppId);
  const label = children == null || children === '' ? '—' : children;
  if (!href) return <>{label}</>;
  if (variant === 'button') {
    return (
      <Link to={href} className={className || 'btn ghost small'} style={style} title={PROFILE_LINK_TITLE}>
        {label}
      </Link>
    );
  }
  return (
    <Link to={href} className={className || 'bprof-namelink'} style={style} title={PROFILE_LINK_TITLE}>
      {label}<span aria-hidden="true" className="bprof-namelink-mark"> ↗</span>
    </Link>
  );
}
