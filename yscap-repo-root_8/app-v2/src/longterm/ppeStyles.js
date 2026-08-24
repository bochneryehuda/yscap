// LT PPE — the screen tokens, in ONE place.
//
// Extracted so the pricing-engine screen and the rate-sheet console cannot drift into two slightly
// different cards. It is a small file on purpose: it carries the tokens the PPE screens share and
// nothing else.
//
// DARK TEXT ON THE WHITE PILOT CANVAS, ALWAYS — and never a `--ink*` token, which is a LIGHT paper
// colour in this palette and renders white-on-white (the trap CLAUDE.md records by name). Every
// colour here is an explicit hex chosen to be readable on white.

export const INK = '#141B22';     // primary text
export const MUTED = '#4B585C';   // secondary text
export const SLATE = '#3A4550';   // body text inside lists
export const GOLD = '#AE8746';
/* THE BRAND GOLD IS A MARK COLOUR, NOT A TEXT COLOUR — and that is measured, not a
   preference: on this paper #AE8746 is 2.98:1, which fails AA for body text (4.5:1)
   and fails even the large-text bar (3:1). Use GOLD for a rule, a dot, a border or
   a fill; use GOLD_TEXT (4.55:1) the moment it has to carry a WORD. It still reads
   unmistakably as gold. */
export const GOLD_TEXT = '#8A6A22';
export const PAPER = '#F4F1EA';
export const DANGER = '#8A2F2F';  // a refusal
export const CAUTION = '#7A5C25'; // a "you should know" note that is not an error

export const card = {
  border: '1px solid rgba(20,27,34,.12)', borderRadius: 12, padding: 16,
  background: '#fff', marginBottom: 14,
};
export const h2 = { margin: '0 0 4px', fontSize: 16, color: INK };
export const sub = { margin: '0 0 12px', fontSize: 13, color: MUTED };
export const eyebrow = {
  fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700,
};

// A text input on the white canvas. 16px is deliberate: iOS Safari zooms the whole page on focus of
// any control under 16px, which throws a form off screen on a phone.
export const input = {
  fontSize: 16, padding: '8px 10px', borderRadius: 8, color: INK, background: '#fff',
  border: '1px solid rgba(20,27,34,.22)', width: '100%', boxSizing: 'border-box',
};
export const mono = {
  ...input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13,
  minHeight: 120, lineHeight: 1.5, whiteSpace: 'pre', overflowX: 'auto',
};
export const label = { display: 'block', fontSize: 12, color: MUTED, fontWeight: 600, marginBottom: 4 };

/* ═══════════════════════════════════════════════════════════════════════════════
   THE FORM SYSTEM — added 2026-08-23 after the owner said the scenario form "is not layered
   together with the system", named three fields that did not line up, and asked for the whole
   screen to be designed properly.

   ⛔ THE ALIGNMENT IS STRUCTURAL, NOT A NUDGE, and that is the whole point of this block. Every
   field on this screen is now the SAME THREE BANDS in the same order and at the same heights:

       LABEL   fixed 22px   (a name, or a segmented control — both fit)
       CONTROL fixed 40px
       HINT    reserved 18px, present whether or not there is anything to say

   The three defects the owner reported were all ONE defect: the fields were laid out in a flex row
   with `align-items: flex-end`, so a field carrying a line of text UNDER its box (the loan
   amount/LTV pair, and the ZIP with its resolved county) had its box pushed UP by exactly the
   height of that line, while a field with no such line sat lower. "It's higher than everything" is
   a precise description of `align-items: flex-end` meeting an extra row. RESERVING the hint band on
   every field makes them all the same height by construction — there is nothing left to align,
   which is why this cannot come back the next time a field gains a note.

   ⛔ AND NEVER AN `--ink*` TOKEN FOR TEXT. Those are LIGHT paper colours in this palette (the trap
   CLAUDE.md records by name); every colour below is an explicit hex chosen to read on white. */

export const LINE = 'rgba(20,27,34,.13)';     // the hairline
export const WASH = '#FAF8F3';                // the warm band header
export const FIELD_BG = '#FFFFFF';

/** A band of fields: a titled block with its own hairline, so a twenty-box scenario reads as four
 *  short sections rather than one wall. */
export const band = {
  border: `1px solid ${LINE}`, borderRadius: 10, background: FIELD_BG,
  marginTop: 12, overflow: 'hidden',
};
export const bandHead = {
  ...eyebrow, background: WASH, borderBottom: `1px solid ${LINE}`,
  padding: '7px 12px', color: SLATE,
};
export const bandBody = {
  display: 'flex', flexWrap: 'wrap', gap: '2px 14px',
  alignItems: 'flex-start', padding: '10px 12px 8px',
};

/** BAND 1 — the field's name. Fixed height and bottom-aligned so a one-line name and a segmented
 *  control both sit on the same line as every other field's name. */
export const fieldLabel = {
  height: 22, display: 'flex', alignItems: 'flex-end', gap: 8,
  fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700, whiteSpace: 'nowrap',
};

/** BAND 2 — the control. 16px is not a style choice: iOS Safari zooms the whole page on focus of
 *  any control under 16px, which throws a form off screen on a phone. */
// ⛔ 44, BECAUSE THE HOUSE STYLESHEET SAYS 44. `app-v2/src/styles.css` carries
// `input:not([type=checkbox]), select, textarea { min-height: 44px }`, and a `min-height` in a
// stylesheet beats an inline `height` — so a control declared 40 here is drawn 44 on screen, and a
// tick-box row built to match the declared 40 sits two pixels above the boxes beside it. Measured,
// not guessed: the rendered centres were 524 against 522 until this matched what the house says.
export const CONTROL_H = 44;
export const control = {
  fontSize: 16, fontWeight: 500, lineHeight: '22px', height: CONTROL_H, padding: '8px 11px',
  borderRadius: 8, color: INK, background: FIELD_BG,
  border: `1px solid ${LINE}`, width: '100%', boxSizing: 'border-box',
  fontVariantNumeric: 'tabular-nums',
};
/** A `<select>` needs room for its own arrow and must not inherit a bold weight from the page. */
export const select = { ...control, fontWeight: 500, paddingRight: 28 };

/** BAND 3 — reserved, always. This is what holds the row's baseline. */
export const fieldHint = {
  minHeight: 18, marginTop: 3, fontSize: 11.5, lineHeight: '18px',
  color: MUTED, fontVariantNumeric: 'tabular-nums',
  overflow: 'hidden', textOverflow: 'ellipsis',
};

/** The money box: a fixed `$` drawn beside the digits rather than a character somebody has to type
 *  and delete. The BORDER lives on the wrapper and the input inside it is borderless, so the mark
 *  and the figure read as one control. */
export const moneyWrap = {
  ...control, display: 'flex', alignItems: 'center', gap: 6, padding: '0 11px',
};
export const moneyMark = { fontSize: 14, color: MUTED, fontWeight: 600, flex: '0 0 auto' };
export const moneyInput = {
  border: 'none', outline: 'none', background: 'transparent', color: INK,
  fontSize: 16, fontWeight: 500, width: '100%', minWidth: 0, padding: 0,
  fontVariantNumeric: 'tabular-nums',
};

/** The loan-amount / LTV switch: a real segmented control in its own track, sized to sit INSIDE the
 *  22px label band. It used to be two underlined words on a line of their own above the label,
 *  which is exactly what pushed that field above its neighbours. */
export const segTrack = {
  display: 'inline-flex', border: `1px solid ${LINE}`, borderRadius: 999,
  background: WASH, padding: 1, gap: 1,
};
export const segBtn = (on) => ({
  border: 'none', cursor: 'pointer', font: 'inherit', letterSpacing: 'inherit',
  fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase',
  padding: '2px 9px', borderRadius: 999, lineHeight: '15px',
  background: on ? INK : 'transparent', color: on ? '#FFF' : MUTED,
});

/** A checkbox row. It is a field like any other, so it carries the same three bands — which is what
 *  stops a row of tick-boxes floating at a different height from the boxes beside it. */
/** MIN-height, never a fixed height. On a desktop row this is exactly the 40px control band, so a
 *  tick-box sits level with the boxes beside it. On a phone the three loan-option flags WRAP, and a
 *  fixed 40 squeezed the second line into a 20px flex line — the first-time-homebuyer box simply
 *  was not on the screen. A field that grows downward is harmless here: the hint band follows it,
 *  and every field starts at the same top, so nothing beside it moves. */
export const checkRow = {
  display: 'flex', gap: 9, alignItems: 'center', minHeight: CONTROL_H,
  fontSize: 13.5, color: INK, cursor: 'pointer',
};
/** A line of explanation standing where a control would be, on the same band. */
export const fieldNote = {
  display: 'flex', alignItems: 'center', minHeight: CONTROL_H,
  fontSize: 12.5, lineHeight: 1.45, color: MUTED,
};
export const checkBox = { width: 17, height: 17, margin: 0, accentColor: GOLD, flex: '0 0 auto' };
