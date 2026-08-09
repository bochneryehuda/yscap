import React from 'react';
import AddressAutocomplete from './AddressAutocomplete.jsx';

/* THE ONE ADDRESS BOX THE RESEARCH DESK TYPES INTO (owner-directed 2026-08-03:
 * "take the address automatic filler that we have … make it that should populate
 * everywhere where you can put in an address — when we start typing our subject
 * property address into the property research, or to define comparables, or to
 * the market conditions, what we charge, or the quick answer").
 *
 * It is a thin wrapper over the autocomplete the loan application and the borrower
 * profile already use — deliberately the SAME component, so an address typed on a
 * research screen is standardised exactly like an address typed on a loan file, and
 * a fix to one is a fix to all of them. What this adds is the two things a research
 * screen needs and a loan form does not:
 *
 *  1. IT FILLS THE WHOLE SET, not just the street. Every research screen searches
 *     on town + state (and sometimes ZIP), so picking one suggestion fills all of
 *     them at once instead of leaving three boxes to re-type. That is the owner's
 *     "the address is automatically populate".
 *
 *  2. IT CARRIES THE POSITION. This is what makes a distance search answerable at
 *     all. The owner reported a half-mile search returning properties in nine
 *     states; the search measures from a point, a typed address had none, and the
 *     radius was silently ignored. The search now REFUSES rather than answer
 *     wrongly — which is honest but useless on its own, because a typed address
 *     could never be answered. Picking from the suggestions gives it the point.
 *
 * The caller keeps its own town / state / ZIP inputs; this reports a merged value
 * and the screen decides what to do with it. Nothing here is required — a person
 * who types an address by hand and never picks a suggestion gets exactly what they
 * always got, minus the ability to run a distance search, and the field says so.
 */
export default function AddressBox({
  value, onChange, label = 'Address', placeholder = 'Start typing the address…',
  hint, className, autoFocus, style,
  /* CHANGE THIS WHEN A PERSON EDITS THE TOWN, STATE OR ZIP BY HAND.
   *
   * The coordinate belongs to the WHOLE picked set, so correcting one of those
   * boxes invalidates it — and the autocomplete has to forget the pick too, or the
   * position that lands a beat later puts it straight back and the search measures
   * from the address that was corrected away from.
   *
   * It is a PROP rather than something derived from `value` here, and that is the
   * whole point: the town changes on every pick as well, so a derived key would
   * fire on the pick itself and throw away the position it had just resolved
   * (measured — the field went straight back to "we could not place that
   * address"). Only the screen knows which of the two happened. */
  staleKey,
}) {
  const v = value || {};

  /* IT REPORTS ONLY THE KEYS IT OWNS, AND THE CALLER MUST MERGE FUNCTIONALLY.
   *
   * Both halves of that are load-bearing, and getting either wrong loses the
   * officer's typing. A pick is reported up to THREE times — on the click, again
   * when USPS standardises the text, and again when the position lands a second or
   * two later — each from a closure created on the render where the suggestion was
   * clicked. Meanwhile the natural next move is to tab straight on and fill in
   * Living area, Bedrooms and Year built, which are the next boxes.
   *
   * So: spreading the whole captured `value` would write the PRE-PICK form back
   * over everything typed since (reproduced in a browser — four fields silently
   * blanked ~1s after the pick, with nothing said), and a caller merging
   * `{...form, ...next}` from a stale `form` does the same thing one level up.
   * Reporting a PARTIAL and merging with the functional form makes the late
   * reports carry only what they actually learned.
   */
  const emit = (patch) => onChange && onChange(patch);

  // A PICK REPLACES THE WHOLE ADDRESS SET, INCLUDING WITH BLANKS. If the chosen
  // address carries no ZIP, keeping the ZIP from whatever was in the box before
  // would silently search a different place than the one on screen — the same
  // class of "the control lies about its own search" the radius box was guilty of.
  function pick(a) {
    // A POSITION REPORT LEARNED A COORDINATE AND NOTHING ELSE. Re-applying the
    // address here would revert whatever the officer typed in the second since
    // the pick — silently, a beat later, with nothing said. USPS standardising
    // the text IS about the address, so that one still replaces the set.
    if (a.reportKind === 'position') {
      emit({
        lat: a.lat != null ? a.lat : null,
        lng: a.lng != null ? a.lng : null,
        position_source: a.positionSource || null,
      });
      return;
    }
    emit({
      address: a.line1 || v.address || '',
      city: a.city || '',
      state: (a.state || '').toUpperCase(),
      zip: a.zip || '',
      lat: a.lat != null ? a.lat : null,
      lng: a.lng != null ? a.lng : null,
      position_source: a.positionSource || null,
    });
  }

  // TYPING BY HAND DROPS THE POSITION. The coordinate belongs to the address that
  // was picked; carrying it onto a different address typed over the top would
  // measure a half mile from the wrong house, which is worse than measuring from
  // nothing.
  function type(text) {
    emit({ address: text, lat: null, lng: null, position_source: null });
  }

  return (
    <label style={{ display: 'block', ...(style || {}) }}>
      <div style={{ fontSize: 12, color: '#4B585C', marginBottom: 4 }}>{label}</div>
      <AddressAutocomplete
        value={v.address || ''}
        onChange={type}
        onPick={pick}
        withPosition
        staleKey={staleKey}
        placeholder={placeholder}
        className={className}
        autoFocus={autoFocus}
      />
      {hint && <div style={{ fontSize: 12, color: '#4B585C', marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

/* THE SAME BOX, FOR THE SCREENS THAT ASK FOR A TOWN RATHER THAN A HOUSE.
 *
 * Market conditions, what we charge, the quick answer and the market areas all
 * search a TOWN, not a property — but a person working a deal has the property's
 * address in front of them, not its town spelled the way our reports spell it.
 * So the same autocomplete sits above those forms and fills the town and state in
 * for them, which is the owner's "anywhere the address is automatically populate".
 *
 * It deliberately does NOT ask for a position: nothing on those screens measures a
 * distance, so a geocoder lookup there would be a network call bought for nothing.
 */
export function TownLookup({ onFill, label = 'Start from an address', hint, style }) {
  const [text, setText] = React.useState('');
  return (
    <label style={{ display: 'block', ...(style || {}) }}>
      <div style={{ fontSize: 12, color: '#4B585C', marginBottom: 4 }}>{label}</div>
      <AddressAutocomplete
        value={text}
        onChange={setText}
        onPick={(a) => {
          // A POSITION REPORT LEARNED A COORDINATE AND NOTHING ELSE — and this box
          // never asked for one, so it has nothing to say here. Adopting it would
          // re-apply the picked town over a town typed since. (`setText` reads the
          // live value rather than a captured one for the same reason.)
          if (a.reportKind === 'position') return;
          setText((cur) => a.line1 || cur);
          onFill && onFill({ city: a.city || '', state: (a.state || '').toUpperCase(), zip: a.zip || '' });
        }}
        placeholder="Start typing a property address…"
      />
      <div style={{ fontSize: 12, color: '#4B585C', marginTop: 4 }}>
        {hint || 'Pick it from the list and the town and state below fill themselves in.'}
      </div>
    </label>
  );
}
