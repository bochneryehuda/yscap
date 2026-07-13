# YS Capital — Design System baseline

A **living snapshot** of the production design language — tokens (color, type,
spacing, radius) and the core components — extracted verbatim from
[`web/style.css`](../style.css) so it reads identically to the live site.

Open [`index.html`](./index.html) in a browser (it has a dark/light toggle).

## Why this exists

It's the hand-off point between **Claude Design** (the visual "design
specialists" at [claude.ai/design](https://claude.ai/design)) and **Claude
Code** (this repo):

```
  web/style.css  ──extract──▶  this baseline  ──push──▶  Claude Design project
                                                              │
                                                        specialists refine
                                                        the look visually
                                                              │
  every page + portal  ◀──apply──  Claude Code  ◀──design-sync──┘
```

## The redesign loop

1. **Baseline** (this folder) — the current system, captured so refinement
   starts from brand equity instead of a blank page.
2. **Refine in Claude Design** — push the baseline to a design-system project;
   the specialists iterate on palette, type, and components visually.
3. **`design-sync`** — pull approved components back down, one at a time.
4. **Apply in code** — Claude Code rolls the refreshed tokens/components across
   all `web/*.html` marketing pages, the `web/tools/*` toolkit, and the
   `app/` → `web/portal/` React portal, then opens a PR with a Render preview.

Nothing here changes the production site until step 4 is reviewed and merged.
The frozen pricing/guideline engines (`window.YSP`/`GSP`/`TitleCost`) are never
touched — a redesign is presentation only.
