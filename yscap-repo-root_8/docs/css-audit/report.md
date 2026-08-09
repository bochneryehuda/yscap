# CSS / layout audit

240 screen-loads across 3 widths (1440, 1280, 390px), 80 screens. **1738 findings**, 28 high.

| what | count | screens |
|---|---:|---:|
| spill | 1 | 1 |
| clipped | 6 | 1 |
| covered-text | 13 | 3 |
| overlap | 8 | 3 |
| contrast | 70 | 14 |
| contrast-near | 124 | 15 |
| tiny-text | 344 | 58 |
| covered-by-overlay | 289 | 44 |
| ellipsized | 15 | 4 |
| tap-target | 868 | 40 |

## spill (1)


**staff borrower detail** — phone

- `div > div > div > h1` 6px of text escapes the box (overflow visible)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom

## clipped (6)


**site home** — desktop, laptop, phone

- `main#top > section.offer-bar` 3875px of content cut off with no ellipsis
  > Ask about no closing cost options Zero points on eligible Fix & Hold renovation loans Defe
- `section#reviews > div.review-viewport` 11021px of content cut off with no ellipsis
  > ★★★★★Just closed with YS Capital and had a great experience! They offer good rates and min
- `main#top > section.offer-bar` 4034px of content cut off with no ellipsis
  > Ask about no closing cost options Zero points on eligible Fix & Hold renovation loans Defe
- `section#reviews > div.review-viewport` 11181px of content cut off with no ellipsis
  > ★★★★★Just closed with YS Capital and had a great experience! They offer good rates and min
- `main#top > section.offer-bar` 4924px of content cut off with no ellipsis
  > Ask about no closing cost options Zero points on eligible Fix & Hold renovation loans Defe
- `section#reviews > div.review-viewport` 12061px of content cut off with no ellipsis
  > ★★★★★Just closed with YS Capital and had a great experience! They offer good rates and min

## covered-text (13)


**staff approvals** — desktop, laptop

- `div.esc-primary-field > div.field > div.inp-suffix > span.sfx` painted over by div.esc-primary-field > div.field > div.inp-suffix > input.input — nothing can scroll them apart
  > months
- `div.esc-primary-field > div.field > div.inp-suffix > span.sfx` painted over by div.esc-primary-field > div.field > div.inp-suffix > input.input — nothing can scroll them apart
  > months

**staff research** — phone

- `div > aside > div > label` painted over by div#root > div.app > main.app-main > footer.wrap.app-foot.small — nothing can scroll them apart
  > Units

**site home** — phone

- `div#navMobile > a` painted over by main#top > section.m-hero.hero — nothing can scroll them apart
  > Programs
- `div#navMobile > a` painted over by section.m-hero.hero > div.m-wrap.hero-grid > div > div.kicker.reveal — nothing can scroll them apart
  > Leverage
- `div#navMobile > a` painted over by main#top > section.m-hero.hero > div.m-wrap.hero-grid > div — nothing can scroll them apart
  > Investor Suite
- `div#navMobile > a` painted over by div.m-wrap.hero-grid > div > h1.hero-title > span.reveal — nothing can scroll them apart
  > Request a Draw
- `div#navMobile > a` painted over by div.m-wrap.hero-grid > div > h1.hero-title > span.reveal — nothing can scroll them apart
  > Process
- `div#navMobile > a` painted over by main#top > section.m-hero.hero > div.m-wrap.hero-grid > div — nothing can scroll them apart
  > Team
- `div#navMobile > a` painted over by section.m-hero.hero > div.m-wrap.hero-grid > div > p.lede.reveal — nothing can scroll them apart
  > FAQ
- `div#navMobile > a` painted over by section.m-hero.hero > div.m-wrap.hero-grid > div > p.lede.reveal — nothing can scroll them apart
  > Contact
- …and 2 more

## overlap (8)


**staff api health** — desktop, laptop, phone

- `div.dd-wrap > div.dd-card > p.ah-purpose > b` overlaps "Retry stuck ones" (div.dd-wrap > div.dd-card > p.ah-purpose > b) by 100%
  > Copy everything now
- `div.dd-wrap > div.dd-card > p.ah-purpose > b` overlaps "Retry stuck ones" (div.dd-wrap > div.dd-card > p.ah-purpose > b) by 100%
  > Copy everything now
- `div.dd-wrap > div.dd-card > p.ah-purpose > b` overlaps "Retry stuck ones" (div.dd-wrap > div.dd-card > p.ah-purpose > b) by 48%
  > Copy everything now

**site home** — desktop, laptop, phone

- `div.disclosures > div.disc-grid > p > a` overlaps "SMS Terms & Conditions" (div.disclosures > div.disc-grid > p > a) by 100%
  > Privacy Policy
- `div.disclosures > div.disc-grid > p > a` overlaps "SMS Terms & Conditions" (div.disclosures > div.disc-grid > p > a) by 100%
  > Privacy Policy
- `div.disclosures > div.disc-grid > p > a` overlaps "SMS Terms & Conditions" (div.disclosures > div.disc-grid > p > a) by 100%
  > Privacy Policy

**staff pipeline shadow** — phone

- `div.wrap > div.card > div.muted > b` overlaps "(the new pipeline runs in shadow only)" (div.wrap > div.card > div.muted > span.muted) by 100%
  > V1
- `div.wrap > div.card > div.muted > span.muted` overlaps "(none)" (div.wrap > div.card > div.muted > b) by 100%
  > (the new pipeline runs in shadow only)

## contrast (70)


**staff file** — desktop, laptop, phone

- `div#ctc-outstanding > div.nx-advisories > div.row > span.pill` 3.23:1 (needs 4.5:1) — rgb(183, 121, 31) on rgb(244,241,234) at 12px
  > advisory
- `div#ctc-outstanding > div.nx-advisories > div.row > span.pill` 3.23:1 (needs 4.5:1) — rgb(183, 121, 31) on rgb(244,241,234) at 12px
  > advisory
- `div#ctc-outstanding > div.nx-advisories > div.row > span.pill` 3.23:1 (needs 4.5:1) — rgb(183, 121, 31) on rgb(244,241,234) at 12px
  > advisory

**site home** — desktop, laptop, phone

- `div > div.kicker.reveal > a.chip > span.stars` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.5px
  > ★★★★★
- `div > div.kicker.reveal > a.chip > span.stars` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.5px
  > ★★★★★
- `div#navMobile > a.btn.btn-solid` 3.22:1 (needs 4.5:1) — rgb(29, 40, 48) on rgb(47,127,134) at 15.68px
  > Apply Now
- `div > div.kicker.reveal > a.chip > span.stars` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.5px
  > ★★★★★

**site privacy** — desktop, laptop, phone

- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance

**site terms** — desktop, laptop, phone

- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance

**site disclosures** — desktop, laptop, phone

- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance

**site sms terms** — desktop, laptop, phone

- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance
- `main#top > section.ysl-hero > div.ysl-wrap > p.eyebrow.ysl-eyebrow.ysl-anim` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Compliance

**tool deal analyzer** — desktop, laptop, phone

- `footer#daFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™
- `footer#daFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™
- `footer#daFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™

**tool equity compare** — desktop, laptop, phone

- `div.vs > div.opt > div.oname > span.lead` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Keep
- `div.vs > div.opt > div.oname > span.lead` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Keep
- `div.vs > div.opt > div.oname > span.lead` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Keep

**tool flip analyzer** — desktop, laptop, phone

- `div#fa > main > div.wrap.an-head.tool-hero > p.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor Suite / Flip Analyzer
- `div#fa > main > div.wrap.an-head.tool-hero > p.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor Suite / Flip Analyzer
- `div#fa > main > div.wrap.an-head.tool-hero > p.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor Suite / Flip Analyzer

**tool loan application** — desktop, laptop, phone

- `div.la-scope > main > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Fix & Flip · Bridge · Rental
- `div.la-scope > main > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Fix & Flip · Bridge · Rental
- `div.la-scope > main > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Fix & Flip · Bridge · Rental

**tool portfolio tracker** — desktop, laptop, phone

- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $140,000
- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $190,000
- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $105,000
- `td#tEquity` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 18px
  > $435,000
- `div.pt-lower > div.inputs-col > div.result-hero > div.rh-label` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12px
  > Net worth from REO
- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $140,000
- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $190,000
- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $105,000
- …and 7 more

**tool qualifier pro** — desktop, laptop, phone

- `footer#qpFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™
- `footer#qpFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™
- `footer#qpFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™

**tool ratesaver** — desktop, laptop, phone

- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 1
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 2
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 3
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 4
- `tbody#cmpBody > tr.cmp-best > td` 2.88:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,239,227) at 14.4px
  > Option 2
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 1
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 2
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 3
- …and 7 more

**tool track record** — desktop, laptop, phone

- `body > main > section.tr-hero > span.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor Suite · Borrower Experience
- `section.tr-summary > div.tr-rank.t0 > div.tr-rank-main > span.tr-rank-eyebrow` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11.2px
  > Experience ranking
- `body > main > section.tr-hero > span.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor Suite · Borrower Experience
- `section.tr-summary > div.tr-rank.t0 > div.tr-rank-main > span.tr-rank-eyebrow` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11.2px
  > Experience ranking
- `body > main > section.tr-hero > span.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor Suite · Borrower Experience
- `section.tr-summary > div.tr-rank.t0 > div.tr-rank-main > span.tr-rank-eyebrow` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11.2px
  > Experience ranking

## contrast-near (124)


**site home** — desktop, laptop, phone

- `div.m-wrap.hero-grid > div > div.hero-cta.reveal > a.btn.btn-gold.btn-lg` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 16px
  > ⚡ Generate your term sheet in seconds
- `div.reveal > div.ts > div.ts-top > span.live` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `main#top > section.m-proof > div.m-wrap > p.proof-note` 3.49:1 (needs 4.5:1) — rgba(244, 240, 231, 0.4) on rgb(20,27,34) at 11px
  > *Business-purpose, investment (non-owner-occupied) loans only. The figure shown is a repre
- `footer.footer > div.footer-top > div.footer-brand > p.footer-tag` 4.34:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(237,230,215) at 17px
  > The answer is yes.™
- `footer.footer > div.footer-top > nav.footer-nav > h5` 4.34:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(237,230,215) at 11.52px
  > Programs
- `footer.footer > div.footer-top > nav.footer-nav > h5` 4.34:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(237,230,215) at 11.52px
  > Company
- `footer.footer > div.footer-top > div.footer-compliance > h5` 4.34:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(237,230,215) at 11.52px
  > Compliance
- `form#subscribeForm > button.btn.btn-gold` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 15.2px
  > Subscribe
- …and 37 more

**site privacy** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**site terms** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**site disclosures** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**site sms terms** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 4.38:1 (needs 4.5:1) — rgb(99, 107, 110) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**tool deal analyzer** — desktop, laptop, phone

- `span#cfVerdict` 4.32:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(231,236,228) at 13.12px
  > Positive cash flow
- `footer#daFoot > div.sf-inner > p.sf-copy` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer#daFoot > div.sf-inner > p.sf-copy > a` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > Disclosures
- `span#cfVerdict` 4.32:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(231,236,228) at 13.12px
  > Positive cash flow
- `footer#daFoot > div.sf-inner > p.sf-copy` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer#daFoot > div.sf-inner > p.sf-copy > a` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > Disclosures
- `span#cfVerdict` 4.32:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(231,236,228) at 13.12px
  > Positive cash flow
- `footer#daFoot > div.sf-inner > p.sf-copy` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- …and 1 more

**tool equity compare** — desktop, laptop, phone

- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live

**tool flip analyzer** — desktop, laptop, phone

- `header.tool-bar > div.wrap.inner > div.tool-actions.topbar-actions > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13.5px
  > Apply now
- `div.form-col.inputs-col > section.panel > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Acquisition
- `div.form-col.inputs-col > section.panel.reveal > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Construction
- `div.out-col.results-col > aside.result.result-hero-wrap > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `span#profitVerdict` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Strong margin — 15%+ ROI
- `div.out-col.results-col > aside.result.result-hero-wrap > div.an-actions > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13.5px
  > Apply now
- `header.tool-bar > div.wrap.inner > div.tool-actions.topbar-actions > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13.5px
  > Apply now
- `div.form-col.inputs-col > section.panel > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Acquisition
- …and 8 more

**tool loan application** — desktop, laptop, phone

- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Primary residence — where this borrower lives, not the subject property
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Time at this address
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Housing status *
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Primary residence — where this borrower lives, not the subject property
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Time at this address
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Housing status *
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Primary residence — where this borrower lives, not the subject property
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Time at this address
- …and 1 more

**tool term sheet studio** — desktop, laptop, phone

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.tool-grid > div.results-col > div.ts-live-head > span.est` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 11px
  > Live
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.tool-grid > div.results-col > div.ts-live-head > span.est` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 11px
  > Live
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.tool-grid > div.results-col > div.ts-live-head > span.est` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 11px
  > Live

**tool qualifier pro** — desktop, laptop, phone

- `span#dscrVerdict` 4.32:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(231,236,228) at 13.12px
  > Strong — 1.25× or better
- `footer#qpFoot > div.sf-inner > p.sf-copy` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer#qpFoot > div.sf-inner > p.sf-copy > a` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > Disclosures
- `span#dscrVerdict` 4.32:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(231,236,228) at 13.12px
  > Strong — 1.25× or better
- `footer#qpFoot > div.sf-inner > p.sf-copy` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer#qpFoot > div.sf-inner > p.sf-copy > a` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > Disclosures
- `span#dscrVerdict` 4.32:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(231,236,228) at 13.12px
  > Strong — 1.25× or better
- `footer#qpFoot > div.sf-inner > p.sf-copy` 3.71:1 (needs 4.5:1) — rgba(244, 240, 231, 0.42) on rgb(20,27,34) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- …and 1 more

**tool ratesaver** — desktop, laptop, phone

- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live

**tool refi breakpoint** — desktop, laptop, phone

- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live

**tool term sheet** — desktop, laptop, phone

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.tool-grid > div.results-col > div.ts-live-head > span.est` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 11px
  > Live
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.tool-grid > div.results-col > div.ts-live-head > span.est` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 11px
  > Live
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.tool-grid > div.results-col > div.ts-live-head > span.est` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 11px
  > Live

**tool track record** — desktop, laptop, phone

- `div#tr-app > section.tr-toolbar > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14.72px
  > + Add a property
- `div#tr-app > section.tr-toolbar > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14.72px
  > + Add a property
- `div#tr-app > section.tr-toolbar > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 16px
  > + Add a property

## tiny-text (344)


**borrower dashboard** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower tasks** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower file** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `div.cv-head > div.cv-head-actions > button.cv-avastack > span.cv-ava.small.online` 9.5px text
  > MB
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `div.cv-head > div.cv-head-actions > button.cv-avastack > span.cv-ava.small.online` 9.5px text
  > MB
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `div.cv-head > div.cv-head-actions > button.cv-avastack > span.cv-ava.small.online` 9.5px text
  > MB

**borrower apply** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower profile** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower helpers** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower entities** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower track record** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower pricing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**borrower notifications** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff queue** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff new file** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff tasks** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff workflow** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff file** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff file draws** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff team** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff conditions studio** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff pricing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff approvals** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff settings** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff AI center** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff archived** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff leads** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff emails** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff orders** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff investor suite** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff term sheet** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff borrowers** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff borrower detail** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff borrower view** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff vendors** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research comps** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research market** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research adjustments** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research appraisers** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research quick answer** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff research areas** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff chat** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div.cv-item-main > div.cv-item-top > span.cv-item-avas > span.cv-ava.tiny` 8.5px text
  > AN
- `div.cv-item-main > div.cv-item-top > span.cv-item-avas > span.cv-ava.tiny` 8.5px text
  > MB
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div.cv-item-main > div.cv-item-top > span.cv-item-avas > span.cv-ava.tiny` 8.5px text
  > AN
- `div.cv-item-main > div.cv-item-top > span.cv-item-avas > span.cv-ava.tiny` 8.5px text
  > MB
- …and 3 more

**staff api health** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff pipeline shadow** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff clickup** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff draws** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff closing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff purchasing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff draw rules** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff tapes** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff audit log** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff e-sign** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff dashboards** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**staff notifications** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital

**tool deal analyzer** — desktop, laptop, phone

- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Inputs
- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Inputs
- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Inputs

**tool equity compare** — desktop, laptop, phone

- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field.span2 > label > em` 9.35px text
  > (years)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field.span2 > label > em` 9.35px text
  > (years)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field.span2 > label > em` 9.35px text
  > (years)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- …and 13 more

**tool qualifier pro** — desktop, laptop, phone

- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Sizing
- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Sizing
- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Sizing

**tool ratesaver** — desktop, laptop, phone

- `div.form-grid > div.field > label > em` 9.35px text
  > (years)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- …and 22 more

**tool refi breakpoint** — desktop, laptop, phone

- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)
- `div.form-grid > div.field > label > em` 9.35px text
  > (%)

**design system** — desktop, laptop, phone

- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > Max Leverage
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > DSCR From
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > Close In
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > Loan Size
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > Max Leverage
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > DSCR From
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > Close In
- `div.ds-panel > div.hero-stats > div.stat > div.stat-tag` 9.92px text
  > Loan Size
- …and 4 more

## covered-by-overlay (289)


**borrower track record** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-word` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > strong until you scroll — check it is not the only place this value shows
  > PILOT
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Borrower console
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Dashboard
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Tasks3
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > New application
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Price a loan
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Profile
- …and 27 more

**borrower pricing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-word` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > strong until you scroll — check it is not the only place this value shows
  > PILOT
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Borrower console
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Dashboard
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Tasks3
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > New application
- `header.header > div.wrap > nav.nav > a.active` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Price a loan
- `header.header > div.wrap > nav.nav > a` sits under div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small until you scroll — check it is not the only place this value shows
  > Profile
- …and 27 more

**staff queue** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff new file** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff tasks** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff workflow** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff file** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff file draws** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff team** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff conditions studio** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div.panel-b > div.checkitem.cc-defrow > div.row > button.btn.link.small` sits under div#root > div.app > button.chat-fab until you scroll — check it is not the only place this value shows
  > Delete
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center
- `div > div.panel > div.panel-h > span.pill.mut` sits under div#root > div.app > button.chat-fab > span.chat-fab-label until you scroll — check it is not the only place this value shows
  > 11

**staff pricing** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff approvals** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff settings** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff AI center** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff archived** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff leads** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff emails** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff orders** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff investor suite** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff term sheet** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-word` sits under div.wrap > div.isuite-full > div.isuite-full-head > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > PILOT
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` sits under main.app-main > div.wrap > div.isuite-full > div.isuite-full-head until you scroll — check it is not the only place this value shows
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` sits under div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe until you scroll — check it is not the only place this value shows
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` sits under div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe until you scroll — check it is not the only place this value shows
  > Main
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe until you scroll — check it is not the only place this value shows
  > Pipeline
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe until you scroll — check it is not the only place this value shows
  > My tasks
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe until you scroll — check it is not the only place this value shows
  > Workflow
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe until you scroll — check it is not the only place this value shows
  > Approvals
- …and 43 more

**staff borrowers** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff borrower detail** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center
- `div.panel > div > div.metrow > span.v` sits under div#root > div.app > button.chat-fab until you scroll — check it is not the only place this value shows
  > 742

**staff borrower view** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff vendors** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff research** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff research comps** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff research market** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff research adjustments** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff research appraisers** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff research quick answer** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff research areas** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div#root > div.app > aside.app-sidebar > div.sb-foot until you scroll — check it is not the only place this value shows
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > What we charge

**staff chat** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff api health** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff pipeline shadow** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff clickup** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff draws** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff closing** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff purchasing** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff draw rules** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff tapes** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff audit log** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff e-sign** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff dashboards** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

**staff notifications** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link.active` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > My settings
- `div.row > div > div > button` sits under div#root > div.app > button.chat-fab until you scroll — check it is not the only place this value shows
  > Manual
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > span.pill until you scroll — check it is not the only place this value shows
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` sits under div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small until you scroll — check it is not the only place this value shows
  > Email Center

## ellipsized (15)


**borrower file** — desktop, laptop, phone

- `div.panel > div.rail-team > div.rail-who > div.rail-n` 79px past its box (…)
  > Alexandra Konstantinopoulos-Vandermeulen
- `div.cv-head > div.cv-head-main > div > div.cv-title` 13px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom
- `div.panel > div.rail-team > div.rail-who > div.rail-n` 79px past its box (…)
  > Alexandra Konstantinopoulos-Vandermeulen
- `div.cv-head > div.cv-head-main > div > div.cv-title` 242px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom
- `div.panel > div.rail-team > div.rail-who > div.rail-n` 5px past its box (…)
  > Alexandra Konstantinopoulos-Vandermeulen

**staff chat** — desktop, laptop, phone

- `div.cv-list-scroll > div.cv-group > div.cv-group-head > span.muted.small.cv-group-addr` 188px past its box (…)
  > Saint Petersburg Beach, FL · YSCAP-CSSAUDIT-LONG
- `button.cv-item > div.cv-item-main > div.cv-item-top > span.cv-item-name` 81px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom
- `div.cv-list-scroll > div.cv-group > div.cv-group-head > span.muted.small.cv-group-addr` 188px past its box (…)
  > Saint Petersburg Beach, FL · YSCAP-CSSAUDIT-LONG
- `button.cv-item > div.cv-item-main > div.cv-item-top > span.cv-item-name` 81px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom
- `div.cv-list-scroll > div.cv-group > div.cv-group-head > span.muted.small.cv-group-addr` 192px past its box (…)
  > Saint Petersburg Beach, FL · YSCAP-CSSAUDIT-LONG
- `button.cv-item > div.cv-item-main > div.cv-item-top > span.cv-item-name` 99px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom

**borrower tasks** — phone

- `li > button.an-item.fix > span.an-main > span.an-file` 309px past its box (…)
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 309px past its box (…)
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 309px past its box (…)
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be

**borrower pricing** — phone

- `div.toolsheet > header.toolsheet-head > div.toolsheet-titles > strong` 55px past its box (…)
  > Price a loan

## tap-target (868)


**borrower sign-in** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**staff sign-in** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**assistant sign-in** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**borrower forgot password** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**staff forgot password** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**reset password** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**verify email** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**accept invitation** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**e-sign done** — desktop, laptop, phone

- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 98×21px (min 24×24)
  > ← Back to home
- `section.auth-form-panel > div.auth-form-top > span > a.auth-help` 68×21px (min 24×24)
  > Need help?

**borrower dashboard** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower tasks** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower file** — desktop, laptop, phone

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `aside.file-rail > div.panel > div.rail-help > a` 88×22px (min 24×24)
  > 718-831-2168
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `aside.file-rail > div.panel > div.rail-help > a` 88×22px (min 24×24)
  > 718-831-2168
- `aside.file-rail > div.panel > div.rail-help > a` 88×22px (min 24×24)
  > 718-831-2168

**borrower apply** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower profile** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower helpers** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower entities** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower track record** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower pricing** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**borrower notifications** — desktop, laptop

- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔
- `header.header > div.wrap > nav.nav > a.bell` 17×30px (min 24×24)
  > 🔔

**staff file** — desktop, laptop, phone

- `section#sec-overview > div.panel > div.row > button.ts-badge.warn` 296×18px (min 24×24)
  > 5 to clear before CTC — see what’s left →
- `section#sec-overview > div.panel > div.row > button.ts-badge.warn` 296×18px (min 24×24)
  > 5 to clear before CTC — see what’s left →
- `section#sec-overview > div.panel > div.row > button.ts-badge.warn` 296×18px (min 24×24)
  > 5 to clear before CTC — see what’s left →

**staff AI center** — desktop, laptop, phone

- `div.page > div > div > a` 243×17px (min 24×24)
  > Open training proposals →
- `div.page > div > div > a` 283×17px (min 24×24)
  > Open training proposals →
- `div.page > div > div > a` 316×17px (min 24×24)
  > Open training proposals →

**staff borrowers** — desktop, laptop

- `tr > td > span.off > a.lead` 45×22px (min 24×24)
  > Ana Ng
- `tr > td > span.off > a.lead` 45×22px (min 24×24)
  > Ana Ng

**staff notifications** — desktop, laptop, phone

- `div.row > div > div > button` 41×22px (min 24×24)
  > Off
- `div.row > div > div > button` 50×22px (min 24×24)
  > Auto
- `div.row > div > div > button` 64×22px (min 24×24)
  > Manual
- `div.row > div > div > button` 41×22px (min 24×24)
  > Off
- `div.row > div > div > button` 50×22px (min 24×24)
  > Auto
- `div.row > div > div > button` 64×22px (min 24×24)
  > Manual
- `div.row > div > div > button` 41×22px (min 24×24)
  > Off
- `div.row > div > div > button` 50×22px (min 24×24)
  > Auto
- …and 559 more

**site home** — desktop, laptop, phone

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 60×24px (min 24×24)
  > Leverage
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `header#nav > div.nav-inner > nav.nav-links > a` 104×24px (min 24×24)
  > Request a Draw
- `header#nav > div.nav-inner > nav.nav-links > a` 52×24px (min 24×24)
  > Process
- `header#nav > div.nav-inner > nav.nav-links > a` 35×24px (min 24×24)
  > Team
- `header#nav > div.nav-inner > nav.nav-links > a` 28×24px (min 24×24)
  > FAQ
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- …and 104 more

**site investor suite** — desktop, laptop

- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 32×22px (min 24×24)
  > Price
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 50×22px (min 24×24)
  > Analyze
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 58×22px (min 24×24)
  > Compare
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > div.nav-actions > a.ssx-back` 85×22px (min 24×24)
  > ← Back to site
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 32×22px (min 24×24)
  > Price
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 50×22px (min 24×24)
  > Analyze
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 58×22px (min 24×24)
  > Compare
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > div.nav-actions > a.ssx-back` 85×22px (min 24×24)
  > ← Back to site

**site privacy** — desktop, laptop

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite

**site terms** — desktop, laptop

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite

**site disclosures** — desktop, laptop

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite

**site sms terms** — desktop, laptop

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a` 92×24px (min 24×24)
  > Privacy Policy
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a` 92×24px (min 24×24)
  > Privacy Policy

**tool deal analyzer** — desktop, laptop, phone

- `header#daBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#daBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `header#daBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#daBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `header#daBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools

**tool equity compare** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools

**tool loan application** — desktop, laptop, phone

- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools

**tool term sheet studio** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools

**tool portfolio tracker** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header#ptBar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header#ptBar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite

**tool qualifier pro** — desktop, laptop, phone

- `header#qpBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#qpBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `header#qpBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#qpBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `header#qpBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools

**tool ratesaver** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools

**tool refi breakpoint** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools

**tool rehab budget** — desktop, laptop, phone

- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite.tb-under` 88×23px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back.tb-under` 67×23px (min 24×24)
  > ← All tools
- `div.rb-card > div.rb-sec-title > span.rb-itip > button.rb-i` 17×17px (min 24×24)
  > i
- `div.rb-card > div.rb-sec-title > span.rb-itip > button.rb-i` 17×17px (min 24×24)
  > i
- `div.rb-card > div.rb-sec-title > span.rb-itip > button.rb-i` 17×17px (min 24×24)
  > i
- `div.rb-card > div.rb-sec-title > span.rb-itip > button.rb-i` 17×17px (min 24×24)
  > i
- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite.tb-under` 88×23px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back.tb-under` 67×23px (min 24×24)
  > ← All tools
- …and 9 more

**tool term sheet** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools

**tool track record** — desktop, laptop, phone

- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
