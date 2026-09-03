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
  /**
   * WHY EACH INVESTOR SAID NO — the door, and the handle it needs.
   *
   * The general engine asks Lender Price exactly as it always has: `disqualifyHandle` reads the
   * search key off the price answer and `disqualify` polls it. Byte-identical to the call this
   * screen has made since it shipped; the only change is that the screen now asks the ENGINE for
   * the handle instead of reaching into the price answer itself, which is what lets a second
   * engine answer differently without forking the screen.
   */
  disqualifyHandle: (res) => ((res && res.searchKey) ? { searchKey: res.searchKey } : null),
  disqualify: (h) => ltApi.dscrDisqualifications(h.searchKey),

  /* THE INVESTOR ROSTER, already in the shape the picker reads. Normalising here rather than in
     the screen is what lets one picker serve two doors that answer in two shapes. */
  investors: () => ltApi.dscrInvestors().then((r) => (r && r.investors) || []),
  /* FORK 8 — DOES A ROW HAVE TO BE ASKED TO EXPLAIN ITSELF? Lender Price ships the itemization WITH
     the search, so on this board a price build is already complete the moment it arrives and asking
     again would be a call that buys nothing. `null` is what the panel reads as "there is nothing to
     fetch", which is the general engine's behaviour today, unchanged. */
  explain: null,
  /* WHAT THE BREAKDOWN CALLS THE THING A PRICED LINE CAME FROM — in the three grammatical
     positions the copy actually uses. Three fields rather than one because English needs them:
     "came from X", "X returned no margin lines", "X's own fee fields". Building those from one
     string would mean a screen doing grammar, and the results ("the rate sheet that quoted this
     loan returned no margin lines") read like a machine wrote them. */
  sheetLabel: 'Lender Price',
  sheetSubject: 'Lender Price',
  sheetPossessive: "Lender Price's",
  /* A FOURTH POSITION, for the same reason there are three: "the 12 programmes X returned". The
     subject form reads "the 12 programmes This rate sheet returned" on a board quoted by two
     programs, which is why the combined engine answers with a clause of its own rather than a name
     English cannot place there. */
  sheetReturned: 'Lender Price returned',
  /* FORK 11 — THE EMPTY BOARD'S OWN SENTENCE, whole rather than assembled. `sheetSubject` is the
     right word in the three places that describe ONE QUOTE's own sheet ("this rate sheet returned
     no fee lines on this quote"), and the wrong one for the WHOLE BOARD, which on the combined
     engine two rate sheets quote. Splicing a subject into a shared sentence cannot fix that —
     "Neither rate sheet returned no priced rungs" — so each engine owns its own grammar, the same
     reason `sheetReturned` exists. */
  emptyBoardLine: 'Lender Price returned no priced rungs for this scenario.',
  /* FORK 9 — MAY THE OFFICER CHOOSE FIXED OR ARM? Both programs take the answer (Lender Price as
     `criteria.loanType`, LoanNEX by narrowing its own board on `amortizationType`), but this
     engine's search has forced `Fixed` since it was written — a DSCR investor search is a
     fixed-rate search — and the owner's rule for it is *"don't touch our current setup"*. With the
     control absent the form states nothing, the request is byte-identical, and this board answers
     exactly what it always has. */
  amortizationChoice: false,
  /** FORK 6 — the vendor's own eligibility checks. Lender Price does not publish them. */
  showChecks: false,
  /** FORK 7 — the term-sheet cart: the tick-box, the collected chip and the comparison panel. */
  cart: true,
  /** The counts line ends with a lender count; only a board whose door returns one may say it. */
  lenderCount: true,
  /* FORK 10 — DOES A ROW PRINT ITS RATE LOCK? Not here. Every quote on this board came from one
     vendor answering one `dayLocksCriteria`, so every row is at the same lock and printing it on
     each would be the same number repeated down the page. The owner's rule for this engine is
     *"don't touch our current setup"*, and a board of identical badges is a change that buys
     nothing. The lock is where it has always been, in the expanded Details panel. */
  showRowLock: false,
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
  /* FORK 8 — THE ONE REAL ASYMMETRY BETWEEN THE TWO PROGRAMS. One of the two rate sheets on this
     board publishes its itemization with the quote and the other explains a row only when asked —
     one call per quote, which is how its own screen works too. The server answers BOTH through the
     same door and the same builder, so the panel never learns which one it is talking to: a row
     that arrived explained comes back `alreadyExplained` with nothing to merge.

     ⛔ IT RETURNS AN OPTION, NOT A BREAKDOWN. The panel reads an OPTION; the breakdown is a flatter
     shape with different keys. Translating one into the other in the browser would be a second copy
     of a mapping the server already holds — and the copy that drifts is the one drawing the price
     somebody quotes. */
  explain: (quote, scenario, option) => ltApi.combinedExplain(quote, scenario, option),
  /**
   * WHY EACH INVESTOR SAID NO — BOTH RATE SHEETS, ONE LIST.
   *
   * ⛔ THIS SECTION WAS DEAD ON THIS BOARD, for both rate sheets, and that was MEASURED rather than
   * inferred: `askDisqualified` reads a search key off the price answer, and the combined answer
   * has never carried one at the top level (the identities sat inside `provenance`, which is
   * reveal-gated and which no browser code reads), so it returned early every time and nothing was
   * ever asked. The server now hands back an `ineligibility` handle naming the two searches — by
   * MECHANISM, not by vendor — and this asks both through one door.
   *
   * ⛔ NO PORTAL IS SENT, AND THAT IS DELIBERATE RATHER THAN AN OMISSION. This screen prices
   * without naming one (`engine.price` sends only the scenario and `reveal`), so the search this
   * handle points at was made on the vendor's default aggregator portal and the ineligible tree
   * must be asked for on the same one — a portal invented here would ask a session that never saw
   * this search. IF A PORTAL IS EVER ADDED TO THE PRICE CALL IT MUST BE ADDED HERE IN THE SAME
   * COMMIT, or the two will quietly describe different searches.
   */
  disqualifyHandle: (res) => {
    const h = res && res.ineligibility;
    if (!h || (!h.pollKey && !h.treeId)) return null;
    return { pollKey: h.pollKey || null, treeId: h.treeId || null };
  },
  disqualify: (h, ctx) => ltApi.combinedDisqualifications({ ...h, revealSource: !!(ctx && ctx.reveal) }),

  /* ONE SYSTEM, SO NO VENDOR IS NAMED. Two programs quote this board and a line may have come from
     either, so naming one of them on every line would be wrong half the time. */
  sheetLabel: 'the rate sheet that quoted this loan',
  sheetSubject: 'This rate sheet',
  sheetPossessive: "The rate sheet's",
  sheetReturned: 'came back',
  /* FORK 11 — two rate sheets quote this board, so the singular was simply wrong (audit F2).
     A person reading "this rate sheet returned nothing" on a board quoted by two has been told
     something untrue about which sheets were asked. */
  emptyBoardLine: 'Neither rate sheet returned a priced rung for this scenario.',
  /* FORK 9 — the officer picks the product, because on THIS board it decides what comes back from
     both programs at once. Lender Price is asked for it; LoanNEX cannot be asked, so its board is
     narrowed on the fields it publishes about each programme. */
  amortizationChoice: true,
  /* FORK 6 — LoanNEX publishes what it checked, so the board shows it; a rate sheet that publishes
     nothing says so in words rather than leaving a silent gap. */
  showChecks: true,
  /* FORK 7 — an engine under audit must not issue a document a borrower reads. */
  cart: false,
  /* The combined door returns `programCount` and the investor roster; it does not return a lender
     count, and inventing a two-vendor meaning of "a lender" is the owner's call, not a screen's. */
  lenderCount: false,
  /* FORK 10 — this board DOES print the lock, because it is the board where the question can be
     asked. Two programs answer here, and until 2026-09-02 only one of them was narrowed by the
     lock: Lender Price answers at the lock it was asked for and at no other, while LoanNEX accepts
     no lock in its search and answered at 15, 30, 45 and 60 days at once. `product-filter` now
     mirrors the asked lock onto the LoanNEX board so every row IS at one lock — and this prints
     that lock, so the officer can see it is the one they asked for rather than trust that it is.
     A row whose option carries no lock draws nothing, never a guessed 30. */
  showRowLock: true,
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

/**
 * ASKING A ROW TO EXPLAIN ITSELF — a SECOND context, deliberately, rather than a field on the
 * engine.
 *
 * The engine descriptors above are module constants: they know their own door but not WHICH LOAN is
 * on the screen, and an explain call needs the scenario the board was priced with. So the screen
 * binds `engine.explain` to its own priced scenario and provides the result here.
 *
 * ⛔ THE DEFAULT IS `null` AND THAT IS THE SAFETY PROPERTY, exactly as it is for the engine itself.
 * A panel rendered with no provider above it — which includes every existing test that renders
 * `PriceBuild` on its own, and the whole general board — asks nobody anything and draws what it
 * has always drawn.
 */
const ExplainContext = React.createContext(null);
export const ExplainProvider = ExplainContext.Provider;
export function useExplain() {
  return React.useContext(ExplainContext) || null;
}
