'use strict';
/**
 * LONG-TERM — whether the subject property sits in a flood zone, read from the
 * ONE Encompass field that carries it.
 *
 * Owner-directed 2026-08-31: *"Right now, we have a flood insurance agent on
 * every file. This is only if you tick that this is a flood zone or if it
 * realizes from encompass that this is in a flood zone. Do research on how to
 * realize from encompass."*
 *
 * THE RESEARCH WAS ALREADY DONE AND RECORDED — this file is what it unblocks.
 * `application/unsourced.js` has carried an entry for `lt_properties.in_flood_zone`
 * since 2026-08-18 saying the measurement was finished and only a BUSINESS RULE
 * was missing. Field **541** (`closingDocument.specialFloodHazardAreaIndictor`,
 * labelled "Property Info Flood Zone") is a declared enum, filled on 40.2% of
 * long-term loans, carrying exactly six values across the 772-loan census:
 *
 *     X (210)   AE (12)   X500 (5)   A (2)   C (1)   Yes (1)
 *
 * Asked directly, the owner chose: **the A and V zones mean a flood zone.** That
 * is not our invention — it is what the field was built to say (its own
 * Encompass name is *specialFloodHazardArea*Indictor) and what FEMA's zone
 * lettering has always meant. The lone bare `Yes` is DELIBERATELY not read: the
 * owner picked the option that leaves it unread rather than the one that treats
 * it as a flood zone, and a word is not a zone.
 *
 * THREE ANSWERS, NEVER TWO. A zone letter we recognise answers yes or no; a
 * blank field, the letter `D` (which FEMA defines as *undetermined*) and any
 * word the census has never shown all answer NOTHING. That distinction is the
 * whole reason this file exists rather than a `startsWith('A')` at a call site:
 * *"No"* beside a flood question is a claim somebody prices a loan on, and 3 in
 * 5 long-term loans carry nothing in this field at all.
 *
 * PURE — no database, no client. The sync hands it the fieldReader values.
 */

/** The one id, and it is the one the census measured. */
const FIELD_IDS = ['541'];

const text = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
};

/**
 * A SPECIAL FLOOD HAZARD AREA — the A and V families, written out rather than
 * matched by first letter.
 *
 * `/^A/` would be shorter and would also swallow any future value beginning
 * with an A that is not a zone at all — an indicator word, a status, a
 * misfiled note — and turn it into "this property is in a flood zone", which
 * puts a real insurance requirement on a real loan. The families are closed and
 * short, so writing them out costs nothing and can only ever refuse.
 */
const SFHA_RE = /^(A|A[0-9]{1,2}|AE|AH|AO|AR|V|V[0-9]{1,2}|VE)$/;

/** OUTSIDE it. B and C are the pre-2000 lettering; X and X500 replaced them. */
const OUTSIDE_RE = /^(B|C|X|X500)$/;

/**
 * FEMA's own word for "nobody has determined this yet". It is NOT a no, and
 * reading it as one is the single most expensive mistake this file can make.
 */
const UNDETERMINED_RE = /^D$/;

/**
 * The decision. Returns:
 *   { answered, zone, inFloodZone }
 *
 * `answered` false = 541 was blank → claim nothing, write nothing.
 * `inFloodZone` null on an unrecognised or undetermined value — the zone is
 * still recorded verbatim so a screen can show what Encompass actually holds.
 */
function readFloodZone(values) {
  const raw = text(values && values['541']);
  if (!raw) return { answered: false, zone: null, inFloodZone: null };

  const zone = raw.toUpperCase();
  if (SFHA_RE.test(zone)) return { answered: true, zone: raw, inFloodZone: true };
  if (OUTSIDE_RE.test(zone)) return { answered: true, zone: raw, inFloodZone: false };
  // Undetermined, or a word the measured book has never shown (the bare "Yes").
  // Recorded so it can be SEEN; never turned into a determination.
  return { answered: true, zone: raw, inFloodZone: null };
}

/**
 * Plain words for a screen, so the file header, the contact row and the order
 * card can never describe one property's flood status three ways.
 */
function describeFloodZone(row) {
  const zone = text(row && (row.flood_zone != null ? row.flood_zone : row.floodZone));
  const inZone = row && (row.in_flood_zone != null ? row.in_flood_zone : row.inFloodZone);
  if (inZone === true) return { known: true, label: zone ? `Flood zone ${zone}` : 'In a flood zone' };
  if (inZone === false) return { known: true, label: zone ? `Zone ${zone} — not a flood zone` : 'Not in a flood zone' };
  if (zone) return { known: false, label: `Encompass holds "${zone}", which is not a zone PILOT reads` };
  return { known: false, label: 'Encompass has not said whether this is a flood zone' };
}

/**
 * A HUMAN'S ANSWER IS NEVER OVERWRITTEN BY A READ.
 *
 * The owner asked for both routes — *"if you tick that this is a flood zone or
 * if it realizes from encompass"* — and when the two disagree the person wins:
 * they have the determination certificate in front of them, and the field is
 * blank on three out of five loans precisely because nobody filled it in.
 *
 * So the sync only writes what it read when nothing has been ticked by hand.
 */
function mayWriteFromEncompass(storedSource) {
  return text(storedSource) !== SOURCE_MANUAL;
}

const SOURCE_ENCOMPASS = 'encompass';
const SOURCE_MANUAL = 'manual';

module.exports = {
  FIELD_IDS,
  readFloodZone,
  describeFloodZone,
  mayWriteFromEncompass,
  SOURCE_ENCOMPASS,
  SOURCE_MANUAL,
  _internals: { SFHA_RE, OUTSIDE_RE, UNDETERMINED_RE, text },
};
