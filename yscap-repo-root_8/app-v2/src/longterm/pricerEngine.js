/**
 * WHICH PRICING ENGINE IS THIS — the ONE description of everything that differs between the
 * General Pricing Engine and the Combined Pricing Engine.
 *
 * WHY THIS EXISTS. The Combined engine used to be a 2,900-line COPY of the general screen, watched
 * by a source fingerprint. The owner ended that: *"It will not even be a copy. It should just share
 * the code of the general pricing engine. If we enhance the general pricing engine, this should
 * also enhance it, but it shouldn't touch the general pricing engine."* One screen now serves both,
 * and everything the two boards do differently is named HERE, in one list somebody can read, rather
 * than spread through a copy as eight marked divergences nobody can diff.
 *
 * ⛔ THE DEFAULT IS THE GENERAL ENGINE, AND THAT IS THE SAFETY PROPERTY. A component rendered with
 * no provider above it — which includes every existing test that renders `PriceBuild` or `RateRow`
 * on its own — behaves exactly as the general engine has always behaved. So "the general engine did
 * not move" is the fallback everywhere rather than something each call site has to remember.
 *
 * ⛔ A DIVERGENCE THAT IS INERT ON THE OTHER SIDE DOES NOT BELONG HERE. `stalenessUnknown` and the
 * adjustment's grid cell are read straight off the option the server built: Lender Price never sets
 * them, so the general board renders identically with no flag at all. A flag for those would be a
 * setting nobody can ever change, and one more thing to keep in step. Only a difference that would
 * otherwise CHANGE what the general engine draws is listed.
 */
import React from 'react';
import { ltApi } from './api.js';

/**
 * The settings group the combined engine's own settings are declared in, named ONCE here and in
 * `src/longterm/settings/encompass-settings.js`. A group rather than a prefix because the settings
 * screen groups by it already, and because "which screen shows this" is then a property of the
 * declaration a person can see rather than a rule hidden in a filter.
 */
export const COMBINED_SETTINGS_GROUP = 'Combined Pricing Engine';

/**
 * The general engine — the one the company prices on. Every field here is the behaviour that
 * screen has today; changing one changes the live board, which is exactly why they are written
 * down rather than left implicit.
 */
export const GENERAL_ENGINE = {
  key: 'general',
  /** What the page is called. */
  title: 'Pricing Engine',
  /** Nothing above the form — this IS the company's pricing engine. */
  banner: null,
  /* THE DOOR. The general engine asks Lender Price and nothing else, and it asks EXACTLY what it
     has always asked: `revealSource` is a combined-engine idea and is deliberately not forwarded,
     so the request on the wire is unchanged to the byte. */
  price: (scenario) => ltApi.dscrPrice(scenario, { full: true }),
  /* THE INVESTOR ROSTER, already in the shape the picker reads. Normalising here rather than in
     the screen is what lets one picker serve two doors that answer in two shapes. */
  investors: () => ltApi.dscrInvestors().then((r) => (r && r.investors) || []),
  /* WHAT THE BREAKDOWN CALLS THE THING A PRICED LINE CAME FROM — in the three grammatical
     positions the copy actually uses. Three fields rather than one because English needs them:
     "came from X", "X returned no margin lines", "X's own fee fields". Building those from one
     string would mean a screen doing grammar, and the results ("the rate sheet that quoted this
     loan returned no margin lines") read like a machine wrote them. */
  sheetLabel: 'Lender Price',
  sheetSubject: 'Lender Price',
  sheetPossessive: "Lender Price's",
  /** FORK 6 — the vendor's own eligibility checks. Lender Price does not publish them. */
  showChecks: false,
  /** FORK 7 — the term-sheet cart: the tick-box, the collected chip and the comparison panel. */
  cart: true,
  /** The counts line ends with a lender count; only a board whose door returns one may say it. */
  lenderCount: true,
  /** What the SETTINGS screen for this engine is called. */
  settingsTitle: 'Long-term settings',
  /* WHICH GROUPS OF THE COMPANY ROSTER THIS ENGINE'S SETTINGS SCREEN LEAVES OUT.
     The settings screen is drawn from the SERVER's declaration and there is one roster, so a
     setting declared for the combined engine arrives on both screens unless somebody says
     otherwise. The general screen has never shown the combined engine's settings — main declares
     none of them — and it must not start now: this list is what keeps the second engine out of
     the first one's screen. It names a GROUP rather than the keys, so a fourth combined setting
     is hidden the day it is declared instead of the day somebody remembers this list. */
  settingsHideGroups: [COMBINED_SETTINGS_GROUP],
};

/**
 * The combined engine — the second engine, under audit, that prices the same loan on BOTH programs.
 * It is a set of DIFFERENCES from the general engine and nothing else, so a general-engine
 * enhancement reaches it by default rather than by being ported.
 */
export const COMBINED_ENGINE = {
  ...GENERAL_ENGINE,
  key: 'combined',
  title: 'Combined Pricing Engine',
  /* SAY WHAT THIS SCREEN IS, BEFORE ANYTHING ELSE. The owner is auditing a second engine beside
     the one the company prices on, and a board that looks identical to the live one and is not it
     is the single most expensive thing this screen could be. */
  banner: {
    eyebrow: 'Under audit — not the company\u2019s pricing engine yet',
    body: 'This is a SECOND engine, beside the General Pricing Engine. It prices the same loan on '
      + 'both programs and shows one board. The General Pricing Engine is unchanged and is still '
      + 'the one the company prices on.',
  },
  price: (scenario, opts) => ltApi.combinedPrice(scenario, {
    full: true, revealSource: !!(opts && opts.reveal),
  }),
  investors: () => ltApi.combinedInvestors().then((r) => ((r && r.investors) || [])
    .map((x) => ({ key: x.key, investor: x.label, whiteLabel: x.whiteLabel }))),
  /* ONE SYSTEM, SO NO VENDOR IS NAMED. Two programs quote this board and a line may have come from
     either, so naming one of them on every line would be wrong half the time. */
  sheetLabel: 'the rate sheet that quoted this loan',
  sheetSubject: 'This rate sheet',
  sheetPossessive: "The rate sheet's",
  /* FORK 6 — LoanNEX publishes what it checked, so the board shows it; a rate sheet that publishes
     nothing says so in words rather than leaving a silent gap. */
  showChecks: true,
  /* FORK 7 — an engine under audit must not issue a document a borrower reads. */
  cart: false,
  /* The combined door returns `programCount` and the investor roster; it does not return a lender
     count, and inventing a two-vendor meaning of "a lender" is the owner's call, not a screen's. */
  lenderCount: false,
  settingsTitle: 'Combined Pricing Engine settings',
  /* THE COMBINED SCREEN HIDES NOTHING. The owner's rule for it is *"separate settings with all the
     settings we currently have, adding the additional settings to link the investors and choose
     every investor from where it should price"* — so this screen is the whole roster, its own
     group included, with the investor panels above it. */
  settingsHideGroups: [],
};

const EngineContext = React.createContext(GENERAL_ENGINE);

/** Wrap a screen in this to tell every component under it which engine it is drawing. */
export const EngineProvider = EngineContext.Provider;

/** Read the engine. Outside a provider this is the general engine — see the note above. */
export function useEngine() {
  return React.useContext(EngineContext) || GENERAL_ENGINE;
}
