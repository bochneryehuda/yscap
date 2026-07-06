# YS Capital Group — Website

A complete, modern, single-page site for YS Capital Group. Static HTML/CSS/JS — no build step, no dependencies. Works on any host.

## Files
- `index.html` — all page content (nav, hero, programs, leverage, DSCR tool, process, team, reviews, CTA, footer + disclosures)
- `style.css` — design system (deep-ink + brand teal + warm ivory; Fraunces / Hanken Grotesk type)
- `script.js` — nav, scroll reveals, count-up stats, marquees, DSCR calculator, mobile menu
- `assets/images/` — logos and compliance marks
  - `ys-logo-t.png` — transparent-background logo (used in nav + footer)
  - `eho-lender.png` / `nmls.svg` — official Equal Housing Lender emblem + NMLS mark
  - `favicon-16/32/180/512.png` — browser tab icon (skyline mark on charcoal) + social image
  - `profile-placeholder.png` — team avatar (replace with real headshots when ready)

## View it locally
Just open `index.html` in a browser. (Fonts load from Google Fonts, so an internet connection shows the intended typography.)

## Publish it (free options)
- **Netlify Drop:** drag this whole folder onto https://app.netlify.com/drop — instant live link.
- **GitHub Pages:** push the folder to a repo, enable Pages on the `main` branch.
- **Cloudflare Pages / Vercel:** point at the folder, no build command needed.
- **Your own host:** upload the folder contents to the web root.

## Easy edits
- **Apply link / phone / email:** search `index.html` for `mymortgage-online`, `yscapgroup.com`, and the phone numbers.
- **Team:** each person is a `<article class="member">` block — duplicate or edit.
- **Headshots:** drop real photos into `assets/images/` and update each member's `<img src>`.
- **Leverage numbers / rates:** in the “Leverage” section (`.hl-card`) and program chips (`.prog-chip`).

## Notes
- The DSCR tool is an estimate only (rent ÷ PITIA) and is clearly labeled as not a quote or commitment to lend.
- One operations email in the original file (Ezra Green) was listed as `Goldy@…`; it was corrected to `Ezra@yscapgroup.com` for consistency — confirm before going live.
- Disclosures (Business Purpose Only / NJ DOBI / NY exclusion) are preserved verbatim from your original site.

---

## YS Capital Investor Suite (new)

A linked nav item **"Investor Suite"** (top of every page) opens `suite.html`, a hub
with cards for seven browser-based calculators. Every formula runs live in JavaScript —
no Excel, no server, nothing to download. Files:

- `suite.html` — the hub page
- `suite.css` — shared design system for the hub + all tools
- `suite.js` — shared finance helpers (amortized payment, formatting, live binding)
- `tools/qualifier-pro.html` — Mortgage & DSCR payment calculator
- `tools/deal-analyzer.html` — Cap rate, ROI & full rental performance
- `tools/flip-analyzer.html` — Fix & flip profit / ROI / LTC
- `tools/equity-compare.html` — HELOC / second lien vs. cash-out refi
- `tools/ratesaver.html` — Rate buydown vs. lender credit break-even
- `tools/refi-breakpoint.html` — Refinance break-even
- `tools/portfolio-tracker.html` — Multi-property REO/rental dashboard

The original single inline DSCR widget was removed from `index.html` and replaced by
this suite. All seven tools were rebuilt from the source Excel workbooks; each page's
`<script>` block documents its formulas in plain language.

### Formula corrections applied during the rebuild
The originals reproduce exactly, with three deliberate fixes where the spreadsheets
had defects:
1. **Flip Analyzer** — *Annualized ROI* and *Annualized return on cash* now multiply by
   `12 / months` (true annualization). The Excel divided by 12 and multiplied by months,
   which shrank the figure instead of annualizing it.
2. **Refi BreakPoint** — interest is computed as `loan × (rate / 100) ÷ 12`. The Excel
   omitted the `/100`, treating "9" as 900% and producing impossible numbers.
3. **Portfolio Tracker** — *Cash-on-cash return* uses **annual** cash flow ÷ cash in deal
   (the Excel used monthly cash flow). "Cash in deal" is also a real per-row input rather
   than a `Purchase − Mortgage` proxy.
