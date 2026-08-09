# The CSS / layout audit

`scripts/audit-css.mjs` loads **every screen in the product** in a real
browser, at three widths, against deliberately awkward data, and measures what
a stylesheet cannot tell you: whether a value fits its box, whether text is
readable where it sits, and whether two things are drawn on top of each other.

```
node scripts/audit-css.mjs                 # every screen, 1440 / 1280 / 390
node scripts/audit-css.mjs --only=pricing  # one screen (substring match)
node scripts/audit-css.mjs --width=390     # one width
```

Output lands in this folder: `report.md` (grouped, readable), `findings.json`
(every finding, machine-readable) and `shots/` (a full-page PNG per screen per
width, so a finding can be looked at rather than taken on faith).

## What it covers

The three sign-ins (borrower, staff, assistant) and every screen reachable
without one; every borrower screen; every `/internal` staff screen; the
marketing pages; and all eleven standalone tools. 79 screens × 3 widths.

## What it measures

| finding | what it means |
|---|---|
| `crash` / `load-failure` | the screen rendered the ErrorBoundary, or never loaded — it was **not** audited, and saying so is the difference between "clean" and "not looked at" |
| `viewport-blowup` | the layout viewport is wider than the device: every phone breakpoint is switched OFF and the page renders zoomed out |
| `page-overflow` | the page scrolls sideways, and which element is doing it |
| `spill` | text escapes its box (`overflow: visible`) and paints over its neighbour |
| `clipped` | text is silently cut with no ellipsis and no way to scroll to it |
| `covered-text` | something **in flow** is painted over text — nothing can scroll them apart |
| `covered-by-overlay` | text sits under a sticky/fixed overlay until you scroll (worth seeing, not broken) |
| `overlap` | two text elements in the **same stacking context** collide |
| `contrast` / `contrast-near` | text below WCAG AA against its real composited background |
| `tiny-text` | text under 11px |
| `ios-zoom-field` | a form control under 16px, which makes iOS Safari zoom the page on focus |
| `uneven-slots` | side-by-side tiles built from the same class whose heights disagree |
| `tap-target` | an interactive control under 24×24px |

## Two things that make the numbers trustworthy

**The real typefaces.** The portal loads Fraunces, Hanken Grotesk and Inter
from Google. They are unreachable from the browser in this environment, so
every screen would otherwise render in a fallback face — and a fallback face
has different metrics, which means every width measured would be a width the
real site never has. `scripts/lib/font-cache.mjs` fetches them once through the
agent proxy (nothing about TLS is weakened) and replays them to the browser
from disk. If they cannot be fetched the run says so in its first line rather
than reporting measurements of the wrong typeface.

**Awkward data, not demo data.** `scripts/qa-seed-css-audit.js` seeds the
shapes the real pipeline holds and nobody demos with: a 31-character surname, a
118-character entity name, an address with a unit and a ZIP+4, an unbroken
44-character filename, and money in the eight figures — plus a normal-length
twin of each, because half the audit is whether two rows holding
different-length values still line up.

## Reading a finding

Every finding carries the screen, the width, a short selector path, the text
involved and the screenshot it appears in. Start with `report.md`; the sections
are ordered worst-first.

## What it deliberately does not call a defect

A **modal, tool sheet, dropdown or popover drawn over the page** is layering,
not a collision — pairs are only reported when both elements share a stacking
context. A **sticky bar the page scrolls under** is how a sticky bar works. The
staff sidebar's **pinned footer** covers the last nav rows until you scroll,
which is deliberate (logout must always be reachable) and was confirmed by
measurement: every row is reachable, so it is reported as
`covered-by-overlay`, not as a fault. A **closed tooltip** is absolutely
positioned and hidden but still laid out, so it inflates its ancestor's
`scrollWidth` without a pixel of text being near the edge — those are excluded
too.

## The guard that runs in CI

`scripts/test-contrast-tokens-pure.js` (in `npm test`, no DB or browser) reads
the actual token values out of `app-v2/src/styles.css` and `web/v2/suite.css`
and asserts every colour we set **text** in clears 4.5:1 against every surface
that text is painted on. The token→surface pairs are declared in that file: a
stylesheet cannot tell you which token is a text colour and which is a
hairline — `--gold` is legitimately both — so adding a palette colour means
adding its line there.
