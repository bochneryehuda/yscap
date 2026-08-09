/**
 * UAD 3.6 / MISMO 3.6 → PILOT canonical vocabulary: the FIELD MAP, the ENUM CROSSWALK,
 * and the value normalizers for the redesigned URAR.
 *
 * ───────────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE CHANGING A PATH.
 *
 * The GSEs' normative artefacts for UAD 3.6 — Fannie/Freddie **Appendix A-1** (the UAD
 * dataset and its MISMO v3.6 XML mapping, i.e. the xPaths), **Appendix D-1** (the
 * published sample scenarios and their XML files), **Appendix B-1** (the same dataset as
 * a spreadsheet) and the MISMO 3.6 XML schema itself — are all published on hosts this
 * environment's egress policy BLOCKS (fanniemae.com, freddiemac.com, mismo.org all
 * answer 403 to CONNECT; see `docs/appraisal-xml/uad-3.6-research.md` §Access, which
 * lists every document by name and URL for a human to download).
 *
 * So the locators below are CANDIDATES, ordered strongest-first, derived from:
 *   1. the MISMO v3 element/data-point naming conventions this repo already reads and
 *      writes in `src/lib/mismo/` (v3.4 — same reference model family, same containers:
 *      ADDRESS/AddressLineText, PROPERTY, PARTY/ROLES, xlink arrangement);
 *   2. the UAD 2.6 attribute names we read today, whose v3 spellings are mechanical
 *      (`GrossLivingAreaSquareFeetCount` → `GrossLivingAreaSquareFeetNumber`, the v3
 *      `…Count`/`…Number`/`…Amount`/`…Indicator`/`…Type`/`…Description` suffix rules);
 *   3. the published UAD 3.6 content changes (interior/exterior condition & quality,
 *      per-level/per-room detail, ANSI areas, "additional sales analyzed", structured
 *      assumptions/hypothetical conditions) — sourced in the research doc.
 *
 * THREE THINGS MAKE THAT SAFE RATHER THAN RECKLESS:
 *   • Every field carries SEVERAL candidate locators plus a last-resort regex SWEEP of
 *     the subtree, so a path that is one container off still resolves.
 *   • Every resolved field records WHICH locator fired (`coverage`), so the first real
 *     sample tells us precisely which guesses were right.
 *   • Nothing is ever guessed into a value. A field that does not resolve is `null`,
 *     and `extract36` reports it as missing rather than inventing a number.
 *
 * When Appendix A-1 is in hand, correct the FIRST locator of each field to the
 * normative xPath and leave the rest as fallbacks. That is the whole maintenance story.
 * ───────────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE NORMALIZERS ARE NOT SHARED WITH `extract.js`. The 2.6 reader's helpers are
 * shaped for attribute strings, where one attribute carries a compound value — most
 * visibly `TotalBathroomCount="2.1"`, UAD's "two full, one half" packed into one token.
 * MISMO 3.6 states those as separate typed data points (`TotalBathroomCount` /
 * `HalfBathroomCount`), and its booleans are real `true`/`false` Indicator elements
 * rather than 2.6's `Y`/`N`. Sharing one set of helpers would mean each one growing a
 * "which version am I reading" branch — the kind of coupling that makes a 2.6 bug fix
 * silently change a 3.6 answer. They are deliberately separate, and the 2.6 path is not
 * touched by anything in this file.
 */

'use strict';

const X = require('./xml36');

// ──────────────────────────────────────────────────────────────── normalizers ───

// NOTE: injected constant, matching `extract.js` — the codebase forbids `new Date()` in
// date-only paths (a date-only comparison must not depend on the process's clock/zone).
const CUR_YEAR = 2026;

/** Trimmed non-empty string, or null. Also rejects the placeholders vendors emit. */
function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^(n\/?a|none|unknown|not applicable|tbd|--+|\.+)$/i.test(s)) return null;
  return s;
}

/** A number, or null. Strips currency/commas/percent; a token with no digit is null (never 0). */
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.eE+\-]/g, '');
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** A positive money amount inside a sane ceiling, else null. */
function money(v) { const n = toNum(v); return n != null && n > 0 && round2(n) < 1e12 ? n : null; }

/** A positive measure below `max`, else null. Used for areas and rents (column-bounded). */
function bounded(v, max) { const n = toNum(v); return n != null && n > 0 && round2(n) < max ? n : null; }

/** A non-negative integer count — ZERO IS AN ANSWER here, not the absence of one. */
function count(v, max) {
  const n = toNum(v);
  return n != null && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** A signed adjustment inside a magnitude ceiling (0 is meaningful: "no adjustment"). */
function signed(v, max) { const n = toNum(v); return n != null && Math.abs(round2(n)) < max ? n : null; }

/** A percentage as a plain number, or null. */
function percent(v) { const n = toNum(v); return n != null && n > -1000 && n < 1000 ? n : null; }

/**
 * A MISMO 3.6 boolean. The v3 model uses real `true`/`false` on `…Indicator` data
 * points; some producers still emit `Y`/`N` or `1`/`0`. Anything else is null — an
 * unreadable indicator must not read as "false", which is a claim.
 */
function bool(v) {
  const s = clean(v);
  if (s == null) return null;
  if (/^(true|y|yes|1)$/i.test(s)) return true;
  if (/^(false|n|no|0)$/i.test(s)) return false;
  return null;
}

/** `YYYY-MM-DD` from an ISO date or datetime, validated. MISMO 3.x dates are ISO 8601. */
function ymd(v) {
  const s = clean(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    // Tolerate a US-formatted date from a non-conforming producer rather than lose it.
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
    if (!us) return null;
    return ymd(`${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`);
  }
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1800 || y > CUR_YEAR + 5) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A four-digit year in range, as a string (matching the 2.6 reader's shape). */
function year(v) {
  const n = toNum(v);
  return n != null && n >= 1700 && n <= CUR_YEAR + 2 ? String(Math.round(n)) : null;
}

/** Two-letter state code, upper-cased. */
function upState(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return /^[A-Za-z]{2}\b/.test(s) ? s.slice(0, 2).toUpperCase() : null;
}

/** 5-digit (or ZIP+4) postal code. */
function zip(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{5}(-\d{4})?$/.test(s)) return s;
  return /^\d{5}/.test(s) ? s.slice(0, 5) : null;
}

/** Cap a narrative so one essay cannot blow a column or a screen. */
function capText(v, max) {
  const s = clean(v);
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

/**
 * UAD bath text from the SEPARATE 3.6 counts.
 *
 * UAD writes baths as `full.half` — "2.1" is two full and one half, NOT two-and-a-tenth.
 * 2.6 packs that into one attribute and the 2.6 reader splits it; 3.6 states the two
 * counts as their own data points, so here we ASSEMBLE the same text instead. Producing
 * the identical `{full, half, text}` shape is what lets every downstream consumer (the
 * comp grid, the findings, the screen) stay version-blind.
 */
function bathsFrom(fullRaw, halfRaw) {
  const full = count(fullRaw, 99);
  const half = count(halfRaw, 99);
  if (full == null && half == null) return { full: null, half: null, text: null };
  const f = full == null ? 0 : full;
  const h = half == null ? 0 : half;
  return { full, half, text: `${f}.${h}` };
}

// ──────────────────────────────────────────────────────────── enum crosswalk ───

const UAD_C = /^C[1-6]$/;
const UAD_Q = /^Q[1-6]$/;

/**
 * A UAD condition or quality rating, normalized to the code this system already speaks.
 *
 * The SCALES DID NOT CHANGE in 3.6 — C1–C6 and Q1–Q6 survive, with rewritten definitions
 * (C1 now carries a 12-month age limit; C2 means remodelled to the studs within 36
 * months with no deferred maintenance). What changed is that 3.6 can state them at
 * component level and separately for INTERIOR and EXTERIOR, and applies them to property
 * types 2.6 exempted (manufactured housing). Producers may spell the value as the bare
 * code (`C3`) or as a typed enumeration (`ConditionRatingC3`, `C3ConditionRating`), so
 * all three spellings are accepted and only a real code is returned.
 */
function ratingCode(v, kind) {
  const s = clean(v);
  if (!s) return null;
  const re = kind === 'Q' ? UAD_Q : UAD_C;
  const direct = s.toUpperCase().replace(/\s+/g, '');
  if (re.test(direct)) return direct;
  const m = new RegExp(`${kind}\\s*([1-6])`, 'i').exec(s);
  return m ? `${kind}${m[1]}` : null;
}

/** Match a value against an allowed set, case-insensitively; null when it is not one of them. */
function enumOf(v, set) {
  const s = clean(v);
  if (!s) return null;
  const hit = set.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || null;
}

/** The three-way view/location verdict, unchanged in 3.6. */
const RATING_3 = ['Beneficial', 'Neutral', 'Adverse'];

/**
 * The condition-of-appraisal verdict — the single most load-bearing enum in this system,
 * because it decides whether the reported value is the AS-IS or the AFTER-REPAIR value.
 *
 * 2.6 states it as `_CONDITION_OF_APPRAISAL/@_Type` ∈ AsIs | SubjectToRepairs |
 * SubjectToCompletion | SubjectToInspection. 3.6 keeps the same four business meanings
 * but expresses them through the appraisal's stated condition/completion data points,
 * and adds STRUCTURED assumptions and hypothetical conditions (2.6 left those in
 * narrative, which is why the 2.6 reader has to scan prose for "as repaired" language).
 * Both spellings are folded onto the 2.6 vocabulary so every downstream rule — the
 * as-is/ARV split, the CTC tie-out, the findings — keeps working unchanged.
 */
const COND_OF_APPRAISAL = ['AsIs', 'SubjectToRepairs', 'SubjectToCompletion', 'SubjectToInspection'];
function conditionOfAppraisal(v) {
  const s = clean(v);
  if (!s) return null;
  const direct = enumOf(s.replace(/\s+/g, ''), COND_OF_APPRAISAL);
  if (direct) return direct;
  const t = s.toLowerCase();
  if (/subject\s*to\s*completion|as\s*completed|upon\s*completion/.test(t)) return 'SubjectToCompletion';
  if (/subject\s*to\s*repair|as\s*repaired|subject\s*to\s*alteration/.test(t)) return 'SubjectToRepairs';
  if (/subject\s*to\s*inspection/.test(t)) return 'SubjectToInspection';
  if (/^as[\s-]*is$/.test(t)) return 'AsIs';
  return null;
}

/**
 * The report's SCOPE OF WORK, which in 3.6 replaces the form number entirely.
 *
 * UAD 2.6 routed extraction on `REPORT/@AppraisalFormType` (FNM1004 / FNM1025 / FNM1073).
 * The redesigned URAR has NO FORM NUMBER — one dynamic report covers SFR, condo, co-op,
 * 2–4 unit, manufactured and leasehold, activating sections from the property's own
 * characteristics and the assignment's scope (interior inspection, exterior-only,
 * desktop, hybrid). So the "form type" this system stores is DERIVED — see
 * `deriveFormType` — and the scope is kept as its own fact rather than smuggled into it.
 */
const INSPECTION_SCOPE = ['InteriorAndExterior', 'ExteriorOnly', 'Desktop', 'Hybrid', 'None'];
function inspectionScope(v) {
  const s = clean(v);
  if (!s) return null;
  const t = s.toLowerCase().replace(/[^a-z]/g, '');
  if (/interiorandexterior|fullinterior|interiorexterior/.test(t)) return 'InteriorAndExterior';
  if (/exterioronly|driveby|exterior/.test(t)) return 'ExteriorOnly';
  if (/desktop/.test(t)) return 'Desktop';
  if (/hybrid|bifurcated/.test(t)) return 'Hybrid';
  if (/none|noinspection/.test(t)) return 'None';
  return enumOf(s, INSPECTION_SCOPE);
}

/**
 * DERIVE the legacy form type from 3.6 property facts.
 *
 * Everything downstream of `extract()` — `property-category.js`, the findings engine,
 * the 1025 rent-schedule path, the 1073 condo card, the stored `appraisals.form_type`
 * column — is keyed on `FNM1004` / `FNM1025` / `FNM1073`. A 3.6 report states no such
 * thing, and the honest answer is that the form is GONE, not that it is unknown. Rather
 * than fork every consumer, the equivalent form is derived from the two facts that
 * always drove the choice anyway (the ownership kind and the dwelling count) and the
 * BASIS is recorded, so a screen can say "derived from a UAD 3.6 report" instead of
 * implying the appraiser filled out a 1004.
 *
 * Returns `{ formType, basis }` — `formType` is null when the report does not say
 * enough, which the caller reports as a warning rather than defaulting to 1004.
 */
function deriveFormType({ units, propertyCategoryType, projectDesignType, attachmentType }) {
  const cat = (clean(propertyCategoryType) || '').toLowerCase();
  const design = (clean(projectDesignType) || '').toLowerCase();
  if (/condominium|condo/.test(cat) || /condominium|condo/.test(design)) {
    return { formType: 'FNM1073', basis: 'condominium ownership stated on the UAD 3.6 report' };
  }
  if (units != null && units >= 2 && units <= 4) {
    return { formType: 'FNM1025', basis: `${units} dwelling units stated on the UAD 3.6 report` };
  }
  if (units === 1) {
    return { formType: 'FNM1004', basis: 'one dwelling unit stated on the UAD 3.6 report' };
  }
  if (/single\s*family|detached|attached/.test(cat) || /^(detached|attached)$/i.test(clean(attachmentType) || '')) {
    return { formType: 'FNM1004', basis: 'single-family property type stated on the UAD 3.6 report' };
  }
  return { formType: null, basis: null };
}

// ────────────────────────────────────────────────────────────────── resolver ───

/**
 * Resolve one field from an ordered spec.
 *
 * A spec entry is:
 *   'A/B/C'          exact child path from the node
 *   '**''/NAME'      first descendant named NAME (written `**` + `/NAME`)
 *   { re: /…/ }      LAST RESORT: the first descendant whose LOCAL NAME matches, with a
 *                    non-empty value. This is the safety net that makes a one-container
 *                    path error survivable — a `GrossLivingAreaSquareFeetNumber` sitting
 *                    under a container we did not predict is still found by name.
 *
 * Returns `{ value, via }`; `via` is the locator that fired, recorded as coverage.
 */
function resolve(node, spec) {
  if (!node || !Array.isArray(spec)) return { value: null, via: null };
  for (const loc of spec) {
    if (loc && typeof loc === 'object' && loc.re) {
      const hit = findByNamePattern(node, loc.re);
      if (hit) return { value: hit.value, via: `~${loc.re.source}→${hit.local}` };
      continue;
    }
    const got = X.pick(node, [loc]);
    if (got.value != null) return got;
  }
  return { value: null, via: null };
}

/** First descendant whose LOCAL NAME matches `re` and whose text is non-empty. */
function findByNamePattern(node, re) {
  if (!node) return null;
  const stack = [node];
  while (stack.length) {
    const el = stack.pop();
    if (el.local !== '#root' && re.test(el.local)) {
      const v = X.text(el);
      if (v && v.trim() !== '') return { local: el.local, value: v.trim() };
    }
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return null;
}

/**
 * A field reader bound to a node and a coverage ledger.
 *
 * `read(key, spec, normalizer)` resolves, normalizes, records provenance, and returns
 * the value. The ledger is what turns "the screen is empty" into "these 14 fields did
 * not resolve, and here is the path each one tried" — the difference between a reader
 * you can finish against a real sample and one you have to re-guess.
 */
function fieldReader(node, coverage, prefix) {
  return function read(key, spec, normalizer) {
    const { value, via } = resolve(node, spec);
    const out = normalizer ? normalizer(value) : clean(value);
    if (coverage) {
      const k = prefix ? `${prefix}.${key}` : key;
      coverage[k] = out == null || out === ''
        ? { resolved: false, via: via || null, raw: value == null ? null : String(value).slice(0, 120) }
        : { resolved: true, via };
    }
    return out;
  };
}

// ─────────────────────────────────────────────────────────────── the FIELD MAP ──
//
// Ordered strongest-first. `**/NAME` means "anywhere below this node"; `{re}` is the
// name-pattern safety net. Paths are relative to the node named in the group comment.

/** Relative to the SUBJECT `PROPERTY` node (or, failing that, the document root). */
const SUBJECT = {
  street: ['ADDRESS/AddressLineText', '**/AddressLineText', { re: /^AddressLineText$/ }],
  street2: ['ADDRESS/AddressUnitIdentifier', '**/AddressUnitIdentifier'],
  city: ['ADDRESS/CityName', '**/CityName', { re: /^CityName$/ }],
  state: ['ADDRESS/StateCode', '**/StateCode', { re: /^StateCode$/ }],
  zip: ['ADDRESS/PostalCode', '**/PostalCode', { re: /^PostalCode$/ }],
  county: ['ADDRESS/CountyName', '**/CountyName', { re: /^CountyName$/ }],
  apn: ['PARCEL_IDENTIFICATION/PARCEL_IDENTIFIERS/PARCEL_IDENTIFIER/ParcelIdentifierValue',
    '**/ParcelIdentifierValue', '**/AssessorsParcelIdentifier', { re: /Parcel.*Identifier/ }],
  legal: ['**/PropertyLegalDescriptionText', { re: /LegalDescription/ }],
  censusTract: ['**/CensusTractIdentifier', { re: /CensusTract/ }],
  neighborhood: ['**/NeighborhoodName', '**/NeighborhoodDescription', { re: /^Neighborhood(Name|Identifier)$/ }],
  yearBuilt: ['**/PropertyStructureBuiltYear', '**/StructureBuiltYear', { re: /BuiltYear$/ }],
  effectiveYearBuilt: ['**/PropertyStructureEffectiveBuiltYear', { re: /EffectiveBuiltYear/ }],
  // ANSI is the measuring standard 3.6 assumes for above-grade area; the data point is
  // still a gross-living-area square-foot number.
  gla: ['**/GrossLivingAreaSquareFeetNumber', '**/LivingAreaSquareFeetNumber',
    '**/TotalFinishedAreaSquareFeetNumber', { re: /^(Gross)?LivingArea.*SquareFeet/ }],
  grossBuildingArea: ['**/GrossBuildingAreaSquareFeetNumber', { re: /GrossBuildingArea/ }],
  beds: ['**/TotalBedroomCount', '**/BedroomCount', { re: /^Total(Above)?.*BedroomCount$/ }],
  bathsFull: ['**/TotalBathroomCount', '**/FullBathroomCount', { re: /^(Total|Full)BathroomCount$/ }],
  bathsHalf: ['**/HalfBathroomCount', '**/TotalHalfBathroomCount', { re: /HalfBathroomCount$/ }],
  rooms: ['**/TotalRoomCount', '**/RoomCount', { re: /^TotalRoomCount$/ }],
  stories: ['**/StoriesCount', '**/StoryCount', { re: /^Stor(ies|y)Count$/ }],
  units: ['**/PropertyDwellingUnitCount', '**/LivingUnitCount', '**/FinancedUnitCount',
    { re: /(Dwelling|Living)UnitCount$/ }],
  design: ['**/ArchitecturalDesignType', '**/PropertyStructureDesignType', '**/DesignDescription',
    { re: /(ArchitecturalDesign|DesignType)/ }],
  attachmentType: ['**/AttachmentType', { re: /^AttachmentType$/ }],
  propertyCategoryType: ['**/PropertyCategoryType', '**/PropertyType', { re: /^Property(Category)?Type$/ }],
  pudIndicator: ['**/PUDIndicator', '**/ProjectPUDIndicator', { re: /PUDIndicator$/ }],
  projectDesignType: ['**/ProjectDesignType', '**/ProjectDwellingUnitsType', { re: /^ProjectDesignType$/ }],
  projectName: ['**/ProjectName', { re: /^ProjectName$/ }],
  // Site
  lotAreaSqft: ['**/LotSquareFeetNumber', '**/SiteAreaSquareFeetNumber', { re: /(Lot|Site).*SquareFeet/ }],
  lotAreaAcres: ['**/LotAcreageNumber', '**/SiteAcreageNumber', { re: /Acre(age)?Number$/ }],
  lotDimensions: ['**/LotDimensionsText', '**/SiteDimensionsDescription', { re: /Dimension/ }],
  lotShape: ['**/LotShapeType', { re: /LotShape/ }],
  zoningId: ['**/ZoningClassificationIdentifier', '**/ZoningIdentifier', { re: /Zoning.*Identifier/ }],
  zoningDesc: ['**/ZoningClassificationDescription', '**/ZoningDescription', { re: /Zoning.*Description/ }],
  zoningCompliance: ['**/ZoningComplianceType', { re: /ZoningCompliance/ }],
  floodZone: ['**/NFIPFloodZoneIdentifier', '**/FloodZoneIdentifier', { re: /FloodZone.*Identifier/ }],
  femaPanel: ['**/FEMAMapIdentifier', '**/NFIPMapIdentifier', { re: /(FEMA|NFIP)Map.*Identifier/ }],
  femaPanelDate: ['**/FEMAMapDate', '**/NFIPMapDate', { re: /(FEMA|NFIP)MapDate/ }],
  specialFloodHazard: ['**/SpecialFloodHazardAreaIndicator', { re: /SpecialFloodHazard/ }],
  // Condition & quality — the 3.6 additions are the INTERIOR/EXTERIOR split.
  conditionUad: ['**/PropertyConditionRatingType', '**/ConditionRatingType', '**/OverallConditionRatingType',
    { re: /ConditionRating(Type)?$/ }],
  qualityUad: ['**/PropertyQualityRatingType', '**/QualityRatingType', '**/ConstructionQualityRatingType',
    { re: /QualityRating(Type)?$/ }],
  conditionInterior: ['**/InteriorConditionRatingType', { re: /Interior.*ConditionRating/ }],
  conditionExterior: ['**/ExteriorConditionRatingType', { re: /Exterior.*ConditionRating/ }],
  qualityInterior: ['**/InteriorQualityRatingType', { re: /Interior.*QualityRating/ }],
  qualityExterior: ['**/ExteriorQualityRatingType', { re: /Exterior.*QualityRating/ }],
  conditionComment: ['**/PropertyConditionDescription', '**/ConditionCommentText', { re: /ConditionDescription/ }],
  // Improvements / systems
  basementSqft: ['**/BasementAreaSquareFeetNumber', '**/BelowGradeAreaSquareFeetNumber', { re: /Basement.*SquareFeet/ }],
  basementFinishedSqft: ['**/BasementFinishedSquareFeetNumber', '**/BelowGradeFinishedAreaSquareFeetNumber',
    { re: /Basement.*Finish.*SquareFeet/ }],
  basementExit: ['**/BasementExitType', { re: /BasementExit/ }],
  foundationType: ['**/FoundationFeatureType', '**/FoundationType', { re: /Foundation.*Type$/ }],
  roofDescription: ['**/RoofMaterialType', '**/RoofDescription', { re: /Roof(Material)?(Type|Description)$/ }],
  heatingType: ['**/HeatingSystemType', '**/HeatingType', { re: /Heating.*Type$/ }],
  heatingFuel: ['**/HeatingFuelType', { re: /HeatingFuel/ }],
  cooling: ['**/CoolingSystemType', '**/CoolingType', { re: /Cooling.*Type$/ }],
  garageSpaces: ['**/ParkingSpacesCount', '**/GarageSpaceCount', { re: /(Parking|Garage).*(Space).*Count$/ }],
  garageType: ['**/ParkingType', '**/GarageType', { re: /^(Parking|Garage)Type$/ }],
  attic: ['**/AtticType', '**/AtticDescription', { re: /^Attic/ }],
  hasAdu: ['**/AccessoryDwellingUnitIndicator', { re: /AccessoryDwellingUnit/ }],
  effectiveAge: ['**/PropertyStructureEffectiveAgeYearsCount', '**/EffectiveAgeYearsCount', { re: /EffectiveAge/ }],
  remainingEconomicLife: ['**/RemainingEconomicLifeYearsCount', { re: /RemainingEconomicLife/ }],
  physicalDeficiency: ['**/PhysicalDeficiencyIndicator', { re: /PhysicalDeficienc(y|ies)Indicator/ }],
  physicalDeficiencyNote: ['**/PhysicalDeficiencyDescription', { re: /PhysicalDeficienc.*Description/ }],
  buildingStatus: ['**/PropertyStructureBuildingStatusType', '**/BuildingStatusType', { re: /BuildingStatus/ }],
  propertyRights: ['**/PropertyRightsType', '**/PropertyInterestType', { re: /PropertyRights/ }],
  occupancyStatus: ['**/PropertyOccupancyStatusType', '**/OccupancyStatusType', { re: /OccupancyStatus/ }],
  ownerOfRecord: ['**/PropertyOwnerName', '**/OwnerOfRecordName', { re: /Owner.*Name$/ }],
  propertyTaxAmount: ['**/PropertyTaxAmount', '**/RealEstateTaxAmount', { re: /(PropertyTax|RealEstateTax).*Amount/ }],
  propertyTaxYear: ['**/PropertyTaxYear', '**/RealEstateTaxYear', { re: /Tax.*Year$/ }],
};

/** Relative to the VALUATION / report node. */
const VALUATION = {
  appraisedValue: ['**/PropertyAppraisedValueAmount', '**/PropertyValuationAmount', '**/AppraisedValueAmount',
    { re: /(Appraised|Valuation).*ValueAmount$|^PropertyValuationAmount$/ }],
  effectiveDate: ['**/PropertyValuationEffectiveDate', '**/AppraisalEffectiveDate', '**/EffectiveDate',
    { re: /ValuationEffectiveDate|AppraisalEffectiveDate/ }],
  reportSignedDate: ['**/AppraisalReportSignedDate', '**/PropertyValuationSignatureDate', '**/SignatureDate',
    { re: /(Signed|Signature)Date$/ }],
  inspectionDate: ['**/PropertyInspectionDate', '**/InspectionDate', { re: /InspectionDate$/ }],
  conditionOfAppraisal: ['**/AppraisalConditionType', '**/PropertyValuationConditionType',
    '**/ConditionOfAppraisalType', { re: /(Appraisal|Valuation)Condition.*Type$/ }],
  valueSalesApproach: ['**/SalesComparisonApproachValueAmount', '**/ValueIndicatedBySalesComparisonApproachAmount',
    { re: /SalesComparison.*(Value)?Amount$/ }],
  valueCostApproach: ['**/CostApproachValueAmount', '**/ValueIndicatedByCostApproachAmount',
    { re: /CostApproach.*(Value)?Amount$/ }],
  valueIncomeApproach: ['**/IncomeApproachValueAmount', '**/ValueIndicatedByIncomeApproachAmount',
    { re: /IncomeApproach.*(Value)?Amount$/ }],
  grm: ['**/GrossRentMultiplierFactor', { re: /GrossRentMultiplier/ }],
  siteValue: ['**/SiteValueAmount', '**/EstimatedSiteValueAmount', { re: /SiteValue.*Amount$/ }],
  contractPrice: ['**/SalesContractAmount', '**/PurchasePriceAmount', { re: /(SalesContract|PurchasePrice)Amount$/ }],
  contractDate: ['**/SalesContractDate', '**/PurchaseAgreementDate', { re: /SalesContractDate$/ }],
  inspectionScope: ['**/PropertyInspectionType', '**/AppraisalScopeOfWorkType', '**/InspectionType',
    { re: /(InspectionType|ScopeOfWork)/ }],
  uspapReportType: ['**/AppraisalReportType', '**/USPAPReportType', { re: /(USPAP)?AppraisalReportType/ }],
  appraisalPurpose: ['**/AppraisalPurposeType', { re: /AppraisalPurpose/ }],
  reconciliationComment: ['**/ReconciliationCommentText', '**/ValueReconciliationDescription',
    { re: /Reconciliation.*(Comment|Description)/ }],
  // 3.6 states these as their OWN data points — in 2.6 they only existed in prose.
  hypotheticalCondition: ['**/HypotheticalConditionDescription', '**/HypotheticalConditionIndicator',
    { re: /HypotheticalCondition/ }],
  extraordinaryAssumption: ['**/ExtraordinaryAssumptionDescription', '**/ExtraordinaryAssumptionIndicator',
    { re: /ExtraordinaryAssumption/ }],
};

/** Relative to a COMPARABLE node. */
const COMPARABLE = {
  street: ['ADDRESS/AddressLineText', '**/AddressLineText', { re: /^AddressLineText$/ }],
  city: ['ADDRESS/CityName', '**/CityName'],
  state: ['ADDRESS/StateCode', '**/StateCode'],
  zip: ['ADDRESS/PostalCode', '**/PostalCode'],
  salePrice: ['**/SalesContractAmount', '**/ComparableSalePriceAmount', '**/SalePriceAmount',
    { re: /Sale.*PriceAmount$/ }],
  saleDate: ['**/ClosedDate', '**/SaleDate', '**/PropertySaleDate', { re: /(Closed|Sale)Date$/ }],
  contractDate: ['**/SalesContractDate', '**/ContractDate', { re: /ContractDate$/ }],
  adjustedPrice: ['**/AdjustedSalesPriceAmount', '**/ComparableAdjustedValueAmount',
    { re: /Adjusted.*(Sales)?(Price|Value)Amount$/ }],
  netAdjustment: ['**/TotalNetAdjustmentAmount', '**/NetAdjustmentAmount', { re: /NetAdjustment.*Amount$/ }],
  grossAdjustment: ['**/TotalGrossAdjustmentAmount', '**/GrossAdjustmentAmount', { re: /GrossAdjustment.*Amount$/ }],
  gla: ['**/GrossLivingAreaSquareFeetNumber', '**/LivingAreaSquareFeetNumber', { re: /LivingArea.*SquareFeet/ }],
  beds: ['**/TotalBedroomCount', '**/BedroomCount', { re: /BedroomCount$/ }],
  bathsFull: ['**/TotalBathroomCount', '**/FullBathroomCount', { re: /^(Total|Full)BathroomCount$/ }],
  bathsHalf: ['**/HalfBathroomCount', { re: /HalfBathroomCount$/ }],
  rooms: ['**/TotalRoomCount', { re: /^TotalRoomCount$/ }],
  yearBuilt: ['**/PropertyStructureBuiltYear', '**/StructureBuiltYear', { re: /BuiltYear$/ }],
  units: ['**/PropertyDwellingUnitCount', '**/LivingUnitCount', { re: /UnitCount$/ }],
  conditionUad: ['**/PropertyConditionRatingType', '**/ConditionRatingType', { re: /ConditionRating(Type)?$/ }],
  qualityUad: ['**/PropertyQualityRatingType', '**/QualityRatingType', { re: /QualityRating(Type)?$/ }],
  viewRating: ['**/ViewOverallRatingType', '**/ViewRatingType', { re: /View.*RatingType$/ }],
  viewType: ['**/ViewType', '**/ViewTypeOtherDescription', { re: /^ViewType/ }],
  locationRating: ['**/LocationOverallRatingType', '**/LocationRatingType', { re: /Location.*RatingType$/ }],
  locationType: ['**/LocationType', '**/LocationTypeOtherDescription', { re: /^LocationType/ }],
  dom: ['**/DaysOnMarketCount', '**/MarketingTimeDaysCount', { re: /DaysOnMarket/ }],
  saleType: ['**/SalesContractType', '**/PropertyTransactionType', '**/SaleType', { re: /Sale.*Type$/ }],
  dataSource: ['**/DataSourceDescription', '**/ComparableDataSourceDescription', { re: /DataSource.*Description/ }],
  proximity: ['**/ProximityToSubjectDistanceText', '**/ProximityToSubjectDescription', { re: /Proximity/ }],
  belowGradeSqft: ['**/BelowGradeAreaSquareFeetNumber', '**/BasementAreaSquareFeetNumber', { re: /BelowGrade.*SquareFeet/ }],
  belowGradeFinishedSqft: ['**/BelowGradeFinishedAreaSquareFeetNumber', { re: /BelowGrade.*Finish.*SquareFeet/ }],
  concessionAmount: ['**/SalesConcessionAmount', { re: /Concession.*Amount$/ }],
  // 3.6 asks the appraiser to state, in the grid, how each comparable was WEIGHTED.
  weighting: ['**/ComparableWeightingDescription', '**/ComparableWeightType', { re: /Weight/ }],
  // A comparable can be a closed sale, a pending contract or an active listing.
  listingStatus: ['**/PropertyListingStatusType', '**/ListingStatusType', { re: /ListingStatus/ }],
  listPrice: ['**/ListPriceAmount', '**/OriginalListPriceAmount', { re: /ListPriceAmount$/ }],
  monthlyRent: ['**/ActualGrossMonthlyRentAmount', '**/EstimatedGrossMonthlyRentAmount', { re: /MonthlyRentAmount$/ }],
};

/** Relative to the appraiser PARTY / signature node. */
const APPRAISER = {
  name: ['**/FullName', '**/UnparsedName', '**/AppraiserName', { re: /(Full|Unparsed|Appraiser)Name$/ }],
  company: ['**/FullName', '**/UnparsedName', '**/AppraiserCompanyName', { re: /CompanyName$/ }],
  licenseId: ['**/LicenseIdentifier', '**/AppraiserLicenseIdentifier', { re: /License.*Identifier$/ }],
  licenseState: ['**/LicenseIssuingAuthorityStateCode', '**/LicenseStateCode', { re: /License.*State/ }],
  licenseType: ['**/LicenseCategoryType', '**/AppraiserLicenseType', { re: /License.*(Category|Type)$/ }],
  licenseExp: ['**/LicenseExpirationDate', { re: /License.*ExpirationDate/ }],
  phone: ['**/ContactPointTelephoneValue', { re: /TelephoneValue$/ }],
  email: ['**/ContactPointEmailValue', { re: /EmailValue$/ }],
};

/** Relative to the neighborhood / market node. */
const MARKET = {
  valueTrend: ['**/NeighborhoodPropertyValueTrendType', '**/PropertyValuesTrendType', { re: /ValueTrend/ }],
  demandSupply: ['**/NeighborhoodDemandSupplyType', '**/DemandSupplyType', { re: /DemandSupply/ }],
  marketingTime: ['**/NeighborhoodMarketingTimeType', '**/MarketingTimeType', { re: /MarketingTime/ }],
  growth: ['**/NeighborhoodGrowthType', '**/GrowthPaceType', { re: /Growth/ }],
  builtUp: ['**/NeighborhoodBuiltUpPercent', '**/BuiltUpType', { re: /BuiltUp/ }],
  priceLow: ['**/NeighborhoodHousingPriceLowAmount', { re: /PriceLowAmount$/ }],
  priceHigh: ['**/NeighborhoodHousingPriceHighAmount', { re: /PriceHighAmount$/ }],
  pricePredominant: ['**/NeighborhoodHousingPricePredominantAmount', { re: /PricePredominantAmount$/ }],
  agePredominant: ['**/NeighborhoodHousingAgePredominantYearsCount', { re: /AgePredominant/ }],
  boundaries: ['**/NeighborhoodBoundariesDescription', { re: /Boundaries/ }],
  monthsSupply: ['**/HousingSupplyMonthsCount', '**/MonthsOfHousingSupplyCount', { re: /(Supply).*Months|Months.*Supply/ }],
  medianDom: ['**/MedianDaysOnMarketCount', { re: /Median.*DaysOnMarket/ }],
  saleToListPct: ['**/MedianSaleToListPricePercent', { re: /SaleToList/ }],
  marketComment: ['**/MarketConditionsDescription', '**/NeighborhoodMarketConditionsComment',
    { re: /MarketConditions.*(Description|Comment)/ }],
};

module.exports = {
  // normalizers
  clean, toNum, round2, money, bounded, count, signed, percent, bool, ymd, year,
  upState, zip, capText, bathsFrom,
  // enums
  ratingCode, enumOf, conditionOfAppraisal, inspectionScope, deriveFormType,
  RATING_3, COND_OF_APPRAISAL, INSPECTION_SCOPE, UAD_C, UAD_Q,
  // resolution
  resolve, findByNamePattern, fieldReader,
  // the map
  SUBJECT, VALUATION, COMPARABLE, APPRAISER, MARKET,
};
