# CSS / layout audit

240 screen-loads across 3 widths (1440, 1280, 390px), 80 screens. **4693 findings**, 702 high.

| what | count | screens |
|---|---:|---:|
| spill | 72 | 5 |
| clipped | 11 | 3 |
| covered-text | 572 | 62 |
| overlap | 47 | 7 |
| contrast | 590 | 26 |
| contrast-near | 1222 | 64 |
| tiny-text | 1173 | 63 |
| ios-zoom-field | 50 | 11 |
| ellipsized | 27 | 5 |
| tap-target | 929 | 41 |

## spill (72)


**staff file** — desktop, laptop, phone

- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 28px of text escapes the box (overflow visible)
  > Borrower
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 24px of text escapes the box (overflow visible)
  > Entity
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 35px of text escapes the box (overflow visible)
  > Note buyer
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 35px of text escapes the box (overflow visible)
  > Address
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 21px of text escapes the box (overflow visible)
  > Program
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 4px of text escapes the box (overflow visible)
  > Rehab type
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 21px of text escapes the box (overflow visible)
  > Borrower
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rk` 22px of text escapes the box (overflow visible)
  > Entity
- …and 8 more

**tool term sheet studio** — desktop, laptop, phone

- `div.panel.reveal > div.field-rows.two-col > div.field.cond > label` 47px of text escapes the box (overflow visible)
  > Construction / rehab budgetiYour full scope-of-work cost for the renovation. These program
- `div.panel.reveal > div.field-rows.two-col > div.field.cond > label` 20px of text escapes the box (overflow visible)
  > Interest reserve (months)iMonths of interest payments built into the loan so the project c
- `div.panel.reveal > div.field-rows.two-col > div.field.cond > label` 30px of text escapes the box (overflow visible)
  > …or as a dollar amount ($)iThe interest reserve is one thing shown two ways — type a numbe
- `div.panel.reveal > div.field-rows.two-col > div.field > label` 11px of text escapes the box (overflow visible)
  > Estimated closing dateiSets the estimated first payment date (the 1st of the second month 
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 80px of text escapes the box (overflow visible)
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 67px of text escapes the box (overflow visible)
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- `article#pcardSilver > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 80px of text escapes the box (overflow visible)
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardSilver > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 67px of text escapes the box (overflow visible)
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- …and 16 more

**tool term sheet** — desktop, laptop, phone

- `div.panel.reveal > div.field-rows.two-col > div.field.cond > label` 47px of text escapes the box (overflow visible)
  > Construction / rehab budgetiYour full scope-of-work cost for the renovation. These program
- `div.panel.reveal > div.field-rows.two-col > div.field.cond > label` 20px of text escapes the box (overflow visible)
  > Interest reserve (months)iMonths of interest payments built into the loan so the project c
- `div.panel.reveal > div.field-rows.two-col > div.field.cond > label` 30px of text escapes the box (overflow visible)
  > …or as a dollar amount ($)iThe interest reserve is one thing shown two ways — type a numbe
- `div.panel.reveal > div.field-rows.two-col > div.field > label` 11px of text escapes the box (overflow visible)
  > Estimated closing dateiSets the estimated first payment date (the 1st of the second month 
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 80px of text escapes the box (overflow visible)
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 67px of text escapes the box (overflow visible)
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- `article#pcardSilver > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 80px of text escapes the box (overflow visible)
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardSilver > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 67px of text escapes the box (overflow visible)
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- …and 16 more

**staff conditions studio** — phone

- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 6px of text escapes the box (overflow visible)
  > Borrower sees: “Condo association documents”
- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 17px of text escapes the box (overflow visible)
  > Borrower sees: “Construction / rehab budget”
- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 5px of text escapes the box (overflow visible)
  > Borrower sees: “Plans & permits (if applicable)”
- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 6px of text escapes the box (overflow visible)
  > Borrower sees: “Track record / experience”
- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 8px of text escapes the box (overflow visible)
  > Borrower sees: “Assignment contract”
- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 6px of text escapes the box (overflow visible)
  > Borrower sees: “State formation documents”
- `div.panel-b > div.checkitem.cc-defrow > div > div.muted.small` 4px of text escapes the box (overflow visible)
  > Borrower sees: “Operating agreement”

**staff borrower detail** — phone

- `div > div > div > h1` 6px of text escapes the box (overflow visible)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom

## clipped (11)


**staff borrowers** — desktop, laptop, phone

- `main.app-main > div.wrap > div.panel > div.tbl-scroll` 41px of content cut off with no ellipsis
  > BorrowerContactLoan officerFilesAccountLast loginActionsMFMaximiliano Bartholomew Feathers
- `main.app-main > div.wrap > div.panel > div.tbl-scroll` 201px of content cut off with no ellipsis
  > BorrowerContactLoan officerFilesAccountLast loginActionsMFMaximiliano Bartholomew Feathers
- `main.app-main > div.wrap > div.panel > div.tbl-scroll` 818px of content cut off with no ellipsis
  > BorrowerContactLoan officerFilesAccountLast loginActionsMFMaximiliano Bartholomew Feathers

**site home** — desktop, laptop, phone

- `main#top > section.offer-bar` 3875px of content cut off with no ellipsis
  > Ask about no closing cost options Zero points on eligible Fix & Hold renovation loans Defe
- `section#reviews > div.review-viewport` 11021px of content cut off with no ellipsis
  > ★★★★★Just closed with YS Capital and had a great experience! They offer good rates and min
- `main#top > section.offer-bar` 4035px of content cut off with no ellipsis
  > Ask about no closing cost options Zero points on eligible Fix & Hold renovation loans Defe
- `section#reviews > div.review-viewport` 11181px of content cut off with no ellipsis
  > ★★★★★Just closed with YS Capital and had a great experience! They offer good rates and min
- `main#top > section.offer-bar` 4924px of content cut off with no ellipsis
  > Ask about no closing cost options Zero points on eligible Fix & Hold renovation loans Defe
- `section#reviews > div.review-viewport` 12061px of content cut off with no ellipsis
  > ★★★★★Just closed with YS Capital and had a great experience! They offer good rates and min

**staff pricing** — phone

- `div.wrap > div.stack > div.panel > div.tbl-scroll` 300px of content cut off with no ellipsis
  > ProgramTier 1 (top)Tier 2Tier 3StandardGold StandardSilver
- `div.wrap > div.stack > div.panel > div.tbl-scroll` 379px of content cut off with no ellipsis
  > WhenByMarkup (Std / Gold / Silver)Orig (Std / Gold / Silver)UWCreditAppraisalTitleNote8/9/

## covered-text (572)


**borrower track record** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-word` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > strong — the text is not readable where it sits
  > PILOT
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Borrower console
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Dashboard
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Tasks3
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > New application
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Price a loan
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Profile
- …and 27 more

**borrower pricing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-word` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > strong — the text is not readable where it sits
  > PILOT
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Borrower console
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Dashboard
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Tasks3
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > New application
- `header.header > div.wrap > nav.nav > a.active` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Price a loan
- `header.header > div.wrap > nav.nav > a` painted over by div.toolsheet > header.toolsheet-head > div.toolsheet-titles > span.muted.small — the text is not readable where it sits
  > Profile
- …and 27 more

**staff queue** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center
- `div.q-table > a.q-row > div.q-off > span.off` painted over by div.q-table > a.q-row > div.prog-cell > span.pct — the text is not readable where it sits
  > AKAlexandra Konstantinopoulos-Vandermeulen

**staff new file** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff tasks** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff workflow** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff file** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center
- `div.file-top > div.file-top-main > span.muted.small > b` painted over by div.wrap > div.file-top > span.row > button.btn.ghost.small — the text is not readable where it sits
  > $14,212,500
- `div.snap-clusters > div.snap-cluster > div.snap-row > span.snap-rv` painted over by div#root > div.app > button.chat-fab — the text is not readable where it sits
  > RTL

**staff file draws** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff team** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff conditions studio** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div.panel-b > div.checkitem.cc-defrow > div.row > button.btn.link.small` painted over by div#root > div.app > button.chat-fab — the text is not readable where it sits
  > Delete
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center
- `div > div.panel > div.panel-h > span.pill.mut` painted over by div#root > div.app > button.chat-fab > span.chat-fab-label — the text is not readable where it sits
  > 11

**staff pricing** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff approvals** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div.esc-primary-field > div.field > div.inp-suffix > span.sfx` painted over by div.esc-primary-field > div.field > div.inp-suffix > input.input — the text is not readable where it sits
  > months
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center
- `div.esc-primary-field > div.field > div.inp-suffix > span.sfx` painted over by div.esc-primary-field > div.field > div.inp-suffix > input.input — the text is not readable where it sits
  > months

**staff settings** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff AI center** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff archived** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff leads** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff emails** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff orders** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff investor suite** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff term sheet** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-word` painted over by div.wrap > div.isuite-full > div.isuite-full-head > button.btn.ghost.small — the text is not readable where it sits
  > PILOT
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` painted over by main.app-main > div.wrap > div.isuite-full > div.isuite-full-head — the text is not readable where it sits
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` painted over by div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe — the text is not readable where it sits
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` painted over by div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe — the text is not readable where it sits
  > Main
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe — the text is not readable where it sits
  > Pipeline
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe — the text is not readable where it sits
  > My tasks
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe — the text is not readable where it sits
  > Workflow
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.isuite-full > div.isuite-full-body > div.toolframe.fill > iframe — the text is not readable where it sits
  > Approvals
- …and 43 more

**staff borrowers** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff borrower detail** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center
- `div.panel > div > div.metrow > span.v` painted over by div#root > div.app > button.chat-fab — the text is not readable where it sits
  > 742

**staff borrower view** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff vendors** — desktop, laptop, phone

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div.wrap > details.panel > div > p.muted.small` painted over by div.app > main.app-main > div.wrap > div.row — the text is not readable where it sits
  > From our own orders: how fast each company sends the documents back, how often that is by 
- `details.panel > div > p.muted.small > em` painted over by main.app-main > div.wrap > div.row > input.input — the text is not readable where it sits
  > correct
- `details.panel > div > div.row > label.muted.small` painted over by main.app-main > div.wrap > div.panel > div.panel-h — the text is not readable where it sits
  > Show
- `div.wrap > details.panel > div > p.muted.small` painted over by main.app-main > div.wrap > div.panel > div.panel-h — the text is not readable where it sits
  > Working it out…
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center
- …and 7 more

**staff research** — desktop, laptop, phone

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge
- `div > aside > div > label` painted over by div#root > div.app > main.app-main > footer.wrap.app-foot.small — the text is not readable where it sits
  > Units

**staff research comps** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge

**staff research market** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge

**staff research adjustments** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge

**staff research appraisers** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge

**staff research quick answer** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge

**staff research areas** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Quick answer
- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Market areas
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Market conditions
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > What we charge

**staff chat** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff api health** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div.ah-tools > div.ah-chips > button.ah-chip > span.ah-chip-n` painted over by div#root > div.app > button.chat-fab — the text is not readable where it sits
  > 23
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff pipeline shadow** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff clickup** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff draws** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff closing** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff purchasing** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff draw rules** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff tapes** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff audit log** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff e-sign** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff dashboards** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**staff notifications** — desktop, laptop

- `div#root > div.app > aside.app-sidebar > a.sb-link.active` painted over by div#root > div.app > aside.app-sidebar > div.sb-foot — the text is not readable where it sits
  > Notifications
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > My settings
- `div.row > div > div > button` painted over by div#root > div.app > button.chat-fab — the text is not readable where it sits
  > Manual
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > span.pill — the text is not readable where it sits
  > Borrower view
- `div#root > div.app > aside.app-sidebar > a.sb-link` painted over by div.app > aside.app-sidebar > div.sb-foot > button.btn.ghost.small — the text is not readable where it sits
  > Email Center

**site investor suite** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main > section.ssx-callout > div.ssx-wrap.in > a.ssx-btn.ssx-btn-gold.ssx-btn-lg — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by body > main > section.ssx-callout > div.ssx-wrap.in — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by body > main > section.ssx-callout > div.ssx-wrap.in — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by body > main > section.ssx-callout > div.ssx-wrap.in — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > section.ssx-callout — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by body > main > section.ssx-callout > div.ssx-wrap.in — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by body > main > section.ssx-callout > div.ssx-wrap.in — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by body > main > section.ssx-callout > div.ssx-wrap.in — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**site privacy** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**site terms** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**site disclosures** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**site sms terms** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#top > div.ysl-wrap.ysl-grid > div.ysl-doc — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool deal analyzer** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#da > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#da > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#da > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#da > div.tool-grid > div.results-col — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by div.tool-grid > div.results-col > div.result-grid > div.result — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by div#cfMo — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#cfMo — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div#cfYr — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool equity compare** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by div#coTotal — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by span#betterVerdict — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.result-hero — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div.results-col.out-col > aside.result-card > div.vs > div.opt — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool flip analyzer** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by div.wrap.analyzer > div.out-col.results-col > aside.result.result-hero-wrap > div.an-actions — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#fa > main > div.wrap.analyzer — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div#fa > main > div.wrap.analyzer — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by div.wrap.analyzer > div.out-col.results-col > div.kpi-grid > div.kpi — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by div.wrap.analyzer > div.out-col.results-col > div.kpi-grid > div.kpi — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by div#cashIn — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div.out-col.results-col > aside.result.result-hero-wrap > div.an-actions > button.btn.btn-ghost.btn-sm — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div.out-col.results-col > aside.result.result-hero-wrap > div.an-actions > button.btn.btn-ghost.btn-sm — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool loan application** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by form#appForm — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by form#appForm — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by form#appForm — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by form#appForm — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by form#appForm — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by form#appForm > section.wizard-step.is-active.app-wrap > div.panel — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by form#appForm — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by form#appForm — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool term sheet studio** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by article#pcardGold — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by article#pcardGold — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#goldOrigBig — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by article#pcardGold > div.pcard-headline > div.pcard-stat > div.pcard-statlbl — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool portfolio tracker** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#pt > div.pt-wrap > section.panel > div.panel-b — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#pt > div.pt-wrap — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#pt > div.pt-wrap — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#pt > div.pt-wrap — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by main#pt > div.pt-wrap — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by tbody#pfBody > tr > td — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by tbody#pfBody > tr > td > input — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by tbody#pfBody > tr > td — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool qualifier pro** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by main#qp > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by main#qp > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#qp > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by main#qp > div.tool-grid > div.results-col — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by main#qp > div.tool-grid > div.results-col — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by div#dscrRes — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#dscrRes — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by main#qp > div.tool-grid > div.results-col > div.result-hero — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool ratesaver** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.an-actions — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.result-hero — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.result-hero — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.result-hero — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool refi breakpoint** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.an-actions — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > div.analyzer — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by span#beVerdict — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div.analyzer > div.results-col.out-col > aside.result-card > div.result-hero — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div.results-col.out-col > aside.result-card > div.an-actions > button.btn.btn-sm.btn-line — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool rehab budget** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by input#f-months — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main > div.rb-wrap — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main > div.rb-wrap — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main > div.rb-wrap — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > div.rb-wrap — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by div.rb-card > div.rb-choice > button > span.c-sub — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#rb-body > div.rb-card — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div#rb-body > div.rb-card > div.rb-sec-title — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool term sheet** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by article#pcardGold — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main > div.tool-grid — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by article#pcardGold — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#goldOrigBig — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by article#pcardGold > div.pcard-headline > div.pcard-stat > div.pcard-statlbl — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**tool track record** — desktop, laptop, phone

- `div#contactPop > div.cpop-head > span` painted over by div#tr-app > section.tr-section — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by html > body > main — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by html > body > main — the text is not readable where it sits
  > Chat with us now
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-t` painted over by html > body > main — the text is not readable where it sits
  > Call us
- `div#contactPop > a.cpop-item > span.cpop-body > span.cpop-s` painted over by html > body > main — the text is not readable where it sits
  > 718-831-2168
- `div#contactPop > div.cpop-head > span` painted over by div#tr-app > section.tr-toolbar > div.tr-toolbar-right > button.tr-chip — the text is not readable where it sits
  > Contact us
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-t` painted over by div#tr-app > section.tr-section — the text is not readable where it sits
  > WhatsApp
- `div#contactPop > a.cpop-item.is-wa > span.cpop-body > span.cpop-s` painted over by div#tr-app > section.tr-section — the text is not readable where it sits
  > Chat with us now
- …and 7 more

**site home** — phone

- `div#navMobile > a` painted over by main#top > section.m-hero.hero — the text is not readable where it sits
  > Programs
- `div#navMobile > a` painted over by section.m-hero.hero > div.m-wrap.hero-grid > div > div.kicker.reveal — the text is not readable where it sits
  > Leverage
- `div#navMobile > a` painted over by main#top > section.m-hero.hero > div.m-wrap.hero-grid > div — the text is not readable where it sits
  > Investor Suite
- `div#navMobile > a` painted over by div.m-wrap.hero-grid > div > h1.hero-title > span.reveal — the text is not readable where it sits
  > Request a Draw
- `div#navMobile > a` painted over by div.m-wrap.hero-grid > div > h1.hero-title > span.reveal — the text is not readable where it sits
  > Process
- `div#navMobile > a` painted over by main#top > section.m-hero.hero > div.m-wrap.hero-grid > div — the text is not readable where it sits
  > Team
- `div#navMobile > a` painted over by section.m-hero.hero > div.m-wrap.hero-grid > div > p.lede.reveal — the text is not readable where it sits
  > FAQ
- `div#navMobile > a` painted over by section.m-hero.hero > div.m-wrap.hero-grid > div > p.lede.reveal — the text is not readable where it sits
  > Contact
- …and 2 more

## overlap (47)


**staff queue** — desktop, laptop

- `div.q-table > a.q-row > div.q-off > span.off` overlaps "Underwriting" (div.q-table > a.q-row > div.q-stat > span.pill.warn) by 98%
  > AKAlexandra Konstantinopoulos-Vandermeulen
- `div.q-table > a.q-row > div.q-off > span.off` overlaps "Underwriting" (div.q-table > a.q-row > div.q-stat > span.pill.warn) by 98%
  > AKAlexandra Konstantinopoulos-Vandermeulen
- `div.q-table > a.q-row > div.q-off > span.off` overlaps "20%" (div.q-table > a.q-row > div.prog-cell > span.pct) by 47%
  > AKAlexandra Konstantinopoulos-Vandermeulen

**staff file** — desktop, laptop

- `details.file-nav-help > ul > li > span` overlaps "The Deal" (details.file-nav-help > ul > li > b) by 100%
  > Application details
- `div.file-top > div.file-top-main > span.muted.small > b` overlaps "Borrower view" (div.wrap > div.file-top > span.row > button.btn.ghost.small) by 59%
  > $14,212,500
- `details.file-nav-help > ul > li > span` overlaps "The Deal" (details.file-nav-help > ul > li > b) by 100%
  > Application details

**staff vendors** — desktop, laptop, phone

- `div.wrap > details.panel > div > p.muted.small` overlaps "0 vendors" (main.app-main > div.wrap > div.row > span.muted.small) by 58%
  > From our own orders: how fast each company sends the documents back, how often that is by 
- `div.wrap > details.panel > div > p.muted.small` overlaps "0 vendors" (main.app-main > div.wrap > div.row > span.muted.small) by 100%
  > From our own orders: how fast each company sends the documents back, how often that is by 
- `details.panel > div > div.row > label.muted.small` overlaps "Directory" (div.wrap > div.panel > div.panel-h > h3) by 43%
  > Show
- `div.wrap > details.panel > div > p.muted.small` overlaps "0 vendors" (main.app-main > div.wrap > div.row > span.muted.small) by 71%
  > From our own orders: how fast each company sends the documents back, how often that is by 
- `div.wrap > details.panel > div > p.muted.small` overlaps "Directory" (div.wrap > div.panel > div.panel-h > h3) by 100%
  > From our own orders: how fast each company sends the documents back, how often that is by 
- `div.wrap > details.panel > div > p.muted.small` overlaps "0 of 0" (div.wrap > div.panel > div.panel-h > span.pill.mut) by 100%
  > From our own orders: how fast each company sends the documents back, how often that is by 
- `div.wrap > details.panel > div > p.muted.small` overlaps "Try a different type or search term, or " (div.wrap > div.panel > div.empty-state > p) by 59%
  > Working it out…

**staff api health** — desktop, laptop, phone

- `div.dd-wrap > div.ah-note.ah-t-info.ah-monitor > div.ah-monitor-t > b` overlaps "more than 30 minutes" (div.dd-wrap > div.ah-note.ah-t-info.ah-monitor > div.ah-monitor-t > b) by 100%
  > Automatic down-alerts are on.
- `div.dd-wrap > div.dd-card > p.ah-purpose > b` overlaps "Retry stuck ones" (div.dd-wrap > div.dd-card > p.ah-purpose > b) by 100%
  > Copy everything now
- `div.dd-wrap > div.dd-card > p.ah-purpose > b` overlaps "Retry stuck ones" (div.dd-wrap > div.dd-card > p.ah-purpose > b) by 100%
  > Copy everything now
- `div.dd-wrap > div.dd-card > p.ah-purpose > b` overlaps "Retry stuck ones" (div.dd-wrap > div.dd-card > p.ah-purpose > b) by 48%
  > Copy everything now

**site home** — desktop, laptop, phone

- `div.faq-grid.reveal-up > details.faq-item > div.faq-a > p` overlaps "How fast can you close?" (section#faq > div.faq-grid.reveal-up > details.faq-item > summary) by 75%
  > Business-purpose financing for real estate investors: fix & flip, fix & hold, ground-up co
- `div.faq-grid.reveal-up > details.faq-item > div.faq-a > p` overlaps "seconds" (details.faq-item > div.faq-a > p > strong) by 100%
  > Business-purpose financing for real estate investors: fix & flip, fix & hold, ground-up co
- `details.faq-item > div.faq-a > p > strong` overlaps "How fast can you close?" (section#faq > div.faq-grid.reveal-up > details.faq-item > summary) by 100%
  > fix & flip, fix & hold, ground-up construction, and bridge
- `div.faq-grid.reveal-up > details.faq-item > div.faq-a > p` overlaps "We work with a representative FICO from " (div.faq-grid.reveal-up > details.faq-item > div.faq-a > p) by 44%
  > On fix & flip, up to 90% of the purchase price and 100% of the rehab budget (released in d
- `details.faq-item > div.faq-a > p > strong` overlaps "92.5% loan-to-cost" (details.faq-item > div.faq-a > p > strong) by 100%
  > 75% of the after-repair value
- `details.faq-item > div.faq-a > p > strong` overlaps "Term Sheet tool" (details.faq-item > div.faq-a > p > a) by 45%
  > 92.5% loan-to-cost
- `details.faq-item > div.faq-a > p > a` overlaps "We work with a representative FICO from " (div.faq-grid.reveal-up > details.faq-item > div.faq-a > p) by 67%
  > Term Sheet tool
- `details.faq-item > div.faq-a > p > a` overlaps "600" (details.faq-item > div.faq-a > p > strong) by 100%
  > Term Sheet tool
- …and 19 more

**staff conditions studio** — phone

- `div.checkitem.cc-defrow > div > div.cc-defline > strong.cc-def-title` overlaps "Edit" (div.panel-b > div.checkitem.cc-defrow > div.row > button.btn.ghost.small) by 68%
  > Condo project documents (questionnaire, budget, master insurance)

**staff pipeline shadow** — phone

- `div.wrap > div.card > div.muted > b` overlaps "(the new pipeline runs in shadow only)" (div.wrap > div.card > div.muted > span.muted) by 100%
  > V1
- `div.wrap > div.card > div.muted > span.muted` overlaps "(none)" (div.wrap > div.card > div.muted > b) by 100%
  > (the new pipeline runs in shadow only)

## contrast (590)


**borrower tasks** — desktop, laptop, phone

- `div.wrap > section.action-needed > div.an-head > span.an-summary` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.8px
  > 1 to fix · 2 to provide
- `div.wrap > section.action-needed > div.an-head > span.an-summary` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.8px
  > 1 to fix · 2 to provide
- `div.wrap > section.action-needed > div.an-head > span.an-summary` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.8px
  > 1 to fix · 2 to provide

**borrower file** — desktop, laptop, phone

- `div.wrap > div.file-top > span.file-top-amt > span.ln-amount` 2.98:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,243,236) at 22px
  > $14,212,500
- `div.file-rail-grid > aside.file-rail > div.panel.rail-callout > div.rail-callout-lbl` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12px
  > Next step
- `div.wrap > div.file-top > span.file-top-amt > span.ln-amount` 2.98:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,243,236) at 22px
  > $14,212,500
- `div.file-rail-grid > aside.file-rail > div.panel.rail-callout > div.rail-callout-lbl` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12px
  > Next step
- `div.wrap > div.file-top > span.file-top-amt > span.ln-amount` 2.98:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,243,236) at 22px
  > $14,212,500
- `div.file-rail-grid > aside.file-rail > div.panel.rail-callout > div.rail-callout-lbl` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12px
  > Next step

**borrower entities** — desktop, laptop, phone

- `div > div.panel > div.row > span.reqchip.short` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.5px
  > 0/3 documents accepted
- `div > div.panel > div.row > span.reqchip.short` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.5px
  > 0/3 documents accepted
- `div > div.panel > div.row > span.reqchip.short` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.5px
  > 0/3 documents accepted
- `div > div.panel > div.row > span.reqchip.short` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.5px
  > 0/3 documents accepted
- `div > div.panel > div.row > span.reqchip.short` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.5px
  > 0/3 documents accepted
- `div > div.panel > div.row > span.reqchip.short` 2.86:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,238,221) at 12.5px
  > 0/3 documents accepted

**staff queue** — desktop, laptop, phone

- `div.q-table > a.q-row > div.q-stat > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Underwriting
- `div.q-table > a.q-row > div.q-stat > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Underwriting
- `div.q-table > a.q-row > div.q-stat > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Underwriting

**staff file** — desktop, laptop, phone

- `div#ctc-outstanding > div.nx-advisories > div.row > span.pill` 3.23:1 (needs 4.5:1) — rgb(183, 121, 31) on rgb(244,241,234) at 12px
  > advisory
- `section#sec-overview > div.panel > div.row > button.ts-badge.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 11px
  > 5 to clear before CTC — see what’s left →
- `div#ctc-outstanding > div.nx-advisories > div.row > span.pill` 3.23:1 (needs 4.5:1) — rgb(183, 121, 31) on rgb(244,241,234) at 12px
  > advisory
- `section#sec-overview > div.panel > div.row > button.ts-badge.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 11px
  > 5 to clear before CTC — see what’s left →
- `div#ctc-outstanding > div.nx-advisories > div.row > span.pill` 3.23:1 (needs 4.5:1) — rgb(183, 121, 31) on rgb(244,241,234) at 12px
  > advisory
- `section#sec-overview > div.panel > div.row > button.ts-badge.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 11px
  > 5 to clear before CTC — see what’s left →

**staff conditions studio** — desktop, laptop, phone

- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- `div.checkitem.cc-defrow > div > div.cc-defline > span.pill` 2.93:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,241,234) at 12px
  > Built-in
- …and 220 more

**staff approvals** — desktop, laptop, phone

- `div > div.page-head > div > div.esc-eyebrow` 2.98:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,243,236) at 12px
  > Underwriting · Manual products
- `div > div.page-head > div > div.esc-eyebrow` 2.98:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,243,236) at 12px
  > Underwriting · Manual products
- `div > div.page-head > div > div.esc-eyebrow` 2.98:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(246,243,236) at 12px
  > Underwriting · Manual products

**staff leads** — desktop, laptop, phone

- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Contacted
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Qualified
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Quoted
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > In progress
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Contacted
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Qualified
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > Quoted
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.warn` 3.22:1 (needs 4.5:1) — rgb(176, 122, 30) on rgb(246,238,221) at 12px
  > In progress
- …and 4 more

**site home** — desktop, laptop, phone

- `div > div.kicker.reveal > a.chip > span.stars` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.5px
  > ★★★★★
- `section.brand > div.brand-inner > div.brand-left.reveal-up > div.eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Investor-first execution
- `div.brand-inner > div.brand-right > div.value-card.reveal-up > div.value-idx` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 15.2px
  > 01
- `div.brand-inner > div.brand-right > div.value-card.reveal-up > div.value-idx` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 15.2px
  > 02
- `div.brand-inner > div.brand-right > div.value-card.reveal-up > div.value-idx` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 15.2px
  > 03
- `div.m-wrap > div.m-sechead.reveal-up > div > div.m-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > 01Financing
- `div.m-wrap > div.prog-grid.reveal-up > div.prog > div.pnum` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > 02
- `div.m-wrap > div.prog-grid.reveal-up > div.prog > div.pnum` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > 03
- …and 191 more

**site investor suite** — desktop, laptop, phone

- `section#suite > div.ssx-wrap > span.ssx-eyebrow.ssx-rise` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > —Powered by YS Capital Group
- `div.ssx-wrap > div.ssx-group-head.reveal-up > div > span.ssx-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > 01Price
- `div.ssx-wrap > div.ssx-grid.cols-3 > a.ssx-prog.reveal-up > div.pnum` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > TERM SHEET
- `div.ssx-wrap > div.ssx-grid.cols-3 > a.ssx-prog.reveal-up > div.pnum` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > SCOPE OF WORK
- `div.ssx-wrap > div.ssx-grid.cols-3 > a.ssx-prog.reveal-up > div.pnum` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > EXPERIENCE
- `div.ssx-wrap > div.ssx-group-head.reveal-up > div > span.ssx-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > 02Analyze
- `div.ssx-wrap > div.ssx-grid > a.ssx-prog.reveal-up > div.pnum` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > RENTAL
- `div.ssx-wrap > div.ssx-grid > a.ssx-prog.reveal-up > div.pnum` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > FIX & FLIP
- …and 37 more

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

- `main#da > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 11.52px
  > Rental underwriting
- `main#da > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 11.52px
  > Rental underwriting
- `footer#daFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™

**tool equity compare** — desktop, laptop, phone

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Equity strategy
- `div.vs > div.opt > div.oname > span.lead` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Keep
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Equity strategy
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

**tool term sheet studio** — desktop, laptop

- `div.field-rows.two-col > div.field > label > em` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.48px
  > • required
- `div.field-rows.two-col > div.field > label > em` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.48px
  > • required

**tool portfolio tracker** — desktop, laptop, phone

- `section.tool-hero.pt-head > div.toprow > div > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Portfolio command center
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
- `section.tool-hero.pt-head > div.toprow > div > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Portfolio command center
- `tbody#pfBody > tr > td.calc` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 16px
  > $140,000
- …and 9 more

**tool qualifier pro** — desktop, laptop, phone

- `main#qp > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 11.52px
  > Mortgage & DSCR
- `main#qp > section.tool-hero > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 11.52px
  > Mortgage & DSCR
- `footer#qpFoot > div.sf-inner > div.sf-top > span.sf-tag` 3.22:1 (needs 4.5:1) — rgb(133, 101, 41) on rgb(20,27,34) at 16.8px
  > The answer is yes.™

**tool ratesaver** — desktop, laptop, phone

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Points & credits
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
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Points & credits
- `div.panel-b > div.opt > div.opt-h > span.otag` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 11px
  > Option 1
- …and 9 more

**tool refi breakpoint** — desktop, laptop

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Refinance timing
- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 2.91:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(244,240,231) at 12px
  > Refinance timing

**tool rehab budget** — desktop, laptop

- `header.topbar > div.topbar-inner > div.topbar-actions > button.btn.btn-sm.btn-gold` 2.84:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(185,148,74) at 13.44px
  > Export Excel ⤓
- `body > main > section.rb-hero > div.suite-eyebrow` 2.70:1 (needs 4.5:1) — rgb(185, 148, 74) on rgb(247,250,249) at 12px
  > RTL Loan Application
- `body > main > section.rb-hero > p.tool-tagline` 2.70:1 (needs 4.5:1) — rgb(185, 148, 74) on rgb(247,250,249) at 17.28px
  > The scope of work serious investors say YES to.
- `body > main > section.rb-hero > p.tool-tagline` 2.70:1 (needs 4.5:1) — rgb(185, 148, 74) on rgb(247,250,249) at 17.28px
  > The scope of work serious investors say YES to.

**tool term sheet** — desktop, laptop

- `div.field-rows.two-col > div.field > label > em` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.48px
  > • required
- `div.field-rows.two-col > div.field > label > em` 3.14:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(251,249,243) at 12.48px
  > • required

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

## contrast-near (1222)


**borrower dashboard** — desktop, laptop, phone

- `div.grid.cols-2 > a.panel > div.metrow > span.v.ln-amount` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 19px
  > $14,212,500
- `div.grid.cols-2 > a.panel > div.metrow > span.v.ln-amount` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 19px
  > $14,212,500
- `div.grid.cols-2 > a.panel > div.metrow > span.v.ln-amount` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 19px
  > $14,212,500

**borrower tasks** — desktop, laptop, phone

- `li > button.an-item.fix > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.fix > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.fix > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `li > button.an-item.doc > span.an-main > span.an-file` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 12.16px
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- …and 1 more

**borrower file** — desktop, laptop, phone

- `main.content > div.wrap > div.file-top > a.btn.link` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 14px
  > ← All loans
- `ol.timeline > li.tl-step.current > div.tl-body > div.tl-label` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 14px
  > Underwriting
- `div.grid.cols-2 > div.panel > div.metrow > span.v.ln-amount` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 19px
  > $14,212,500
- `section#sec-application > div.panel > div.row > button.pill` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > + Date of birth
- `section#sec-application > div.panel > div.row > button.pill` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > + Citizenship
- `div.panel > div.metrow > span.v > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `main.content > div.wrap > div.file-top > a.btn.link` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 14px
  > ← All loans
- `ol.timeline > li.tl-step.current > div.tl-body > div.tl-label` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 14px
  > Underwriting
- …and 10 more

**borrower profile** — desktop, laptop, phone

- `div.ent-list > div.ent-row > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div.ent-list > div.ent-row > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div.ent-list > div.ent-row > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div.ent-list > div.ent-row > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div.ent-list > div.ent-row > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div.ent-list > div.ent-row > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓

**borrower entities** — desktop, laptop, phone

- `div.row > div > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div > div.panel > div.row > span.reqchip.met` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12.5px
  > Vesting 1 loan file
- `div > div.panel > div.row > span.reqchip.met` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12.5px
  > ✓ Auto-fulfills the LLC condition on every loan
- `div.row > div > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div > div.panel > div.row > span.reqchip.met` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12.5px
  > ✓ Auto-fulfills the LLC condition on every loan
- `div.row > div > div.row > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div > div.panel > div.row > span.reqchip.met` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12.5px
  > Vesting 1 loan file
- `div > div.panel > div.row > span.reqchip.met` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12.5px
  > ✓ Auto-fulfills the LLC condition on every loan
- …and 7 more

**staff queue** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.page-head > div.page-head-actions > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `a.q-row > div.cell-deal > div.mut > span` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12.5px
  > Note buyer: Fidelis
- `a.q-row > div.cell-deal > div.mut > span` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12.5px
  > Note buyer: Northwestern Mutual Structured Credit Opportunities Fund IV, L.P.
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.page-head > div.page-head-actions > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `a.q-row > div.cell-deal > div.mut > span` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12.5px
  > Note buyer: Fidelis
- `a.q-row > div.cell-deal > div.mut > span` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12.5px
  > Note buyer: Northwestern Mutual Structured Credit Opportunities Fund IV, L.P.
- …and 4 more

**staff new file** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.panel > div.panel-b > button.btn.btn-gold` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14px
  > Invite for a new application
- `div.panel > div.panel-h > div.grp-h > span.n` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > 01
- `div.panel > div.panel-h > div.grp-h > span.n` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > 02
- `div.panel > div.panel-h > div.grp-h > span.n` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > 03
- `div.panel > div.panel-h > div.grp-h > span.n` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > 04
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.panel > div.panel-b > button.btn.btn-gold` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14px
  > Invite for a new application
- …and 10 more

**staff tasks** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff workflow** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff file** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `main.app-main > div.wrap > div.file-top > a.btn.link` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 14px
  > ← Pipeline
- `div.loan-prog > ol.lp-track > li.lp-step.current > span.lp-label` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Underwriting
- `div.deal-snap > div.snap-clusters > div.snap-cluster > div.snap-cluster-h` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Parties
- `div.snap-row > span.snap-rv > span > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Verified ✓
- `div.deal-snap > div.snap-clusters > div.snap-cluster > div.snap-cluster-h` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Property
- `div.deal-snap > div.snap-clusters > div.snap-cluster > div.snap-cluster-h` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Economics
- `div.deal-snap > div.snap-clusters > div.snap-cluster > div.snap-cluster-h` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Leverage
- …and 16 more

**staff file draws** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff team** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff conditions studio** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff pricing** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff approvals** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > p.muted.small > a` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 13px
  > Exceptions
- `div > div.dd-card > div.dd-card-h > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Available
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > p.muted.small > a` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 13px
  > Exceptions
- `div > div.dd-card > div.dd-card-h > span.ts-badge.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 11px
  > Available
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > p.muted.small > a` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 13px
  > Exceptions
- …and 1 more

**staff settings** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff AI center** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff archived** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff leads** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.page-head > div.page-head-actions > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + Add lead
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Won
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.page-head > div.page-head-actions > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + Add lead
- `div.lead-board > div.lead-col > div.lead-col-h > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Won
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.page-head > div.page-head-actions > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + Add lead
- …and 1 more

**staff emails** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.ec-wrap > div.ec-stats > div.ec-stat > span.ec-stat-l` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 11px
  > total
- `div.ec-wrap > div.ec-stats > div.ec-stat > span.ec-stat-l` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 11px
  > emailed
- `div.ec-wrap > div.ec-stats > div.ec-stat > span.ec-stat-l` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 11px
  > in-app only
- `div.ec-wrap > div.ec-stats > div.ec-stat > span.ec-stat-l` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 11px
  > failed
- `div.ec-wrap > div.ec-stats > div.ec-stat > span.ec-stat-l` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 11px
  > replies in
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.ec-wrap > div.ec-stats > div.ec-stat > span.ec-stat-l` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 11px
  > total
- …and 10 more

**staff orders** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff investor suite** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff term sheet** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.isuite-full > div.isuite-full-head > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Create loan file →
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.isuite-full > div.isuite-full-head > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Create loan file →
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div.isuite-full > div.isuite-full-head > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > Create loan file →

**staff borrowers** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `tbody > tr > td > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- `tbody > tr > td > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `tbody > tr > td > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- `tbody > tr > td > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `tbody > tr > td > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- …and 1 more

**staff borrower detail** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `main.app-main > div.wrap > p > a.small` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 13px
  > ← Borrowers
- `div.row > div > div.small > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `main.app-main > div.wrap > p > a.small` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 13px
  > ← Borrowers
- `div.row > div > div.small > span.pill.ok` 4.44:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,240,234) at 12px
  > Active
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `main.app-main > div.wrap > p > a.small` 4.21:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(246,243,236) at 13px
  > ← Borrowers
- …and 1 more

**staff borrower view** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.card > div.bview-list > div.bview-row > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > View as this borrower
- `div.card > div.bview-list > div.bview-row > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > View as this borrower
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.card > div.bview-list > div.bview-row > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > View as this borrower
- `div.card > div.bview-list > div.bview-row > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > View as this borrower
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.card > div.bview-list > div.bview-row > button.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > View as this borrower
- …and 1 more

**staff vendors** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff research** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff research comps** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div > section > div > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Search
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div > section > div > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Search
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div > section > div > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > Search

**staff research market** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > section > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Show
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > section > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Show
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > section > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > Show

**staff research adjustments** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Show
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Show
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > Show

**staff research appraisers** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff research quick answer** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Answer
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Answer
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > Answer

**staff research areas** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Show
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 12.5px
  > Show
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.wrap > div > form > button.btn.btn-gold.small` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > Show

**staff chat** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff api health** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.ah-grid > div.ah-card.ah-t-mute > div.ah-body > div.ah-eyebrow` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 10.5px
  > Switches
- `div.ah-grid > div.ah-card.ah-t-mute > div.ah-body > div.ah-eyebrow` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 10.5px
  > Credentials (names only — never a value)
- `div.ah-card.ah-t-mute > div.ah-body > div.ah-note.ah-t-warn > code` 4.26:1 (needs 4.5:1) — rgb(138, 97, 16) on rgb(232,225,210) at 11.5px
  > AZURE_DOCINT_ENDPOINT
- `div.ah-card.ah-t-mute > div.ah-body > div.ah-note.ah-t-warn > code` 4.26:1 (needs 4.5:1) — rgb(138, 97, 16) on rgb(232,225,210) at 11.5px
  > AZURE_DOCINT_KEY
- `div.ah-grid > div.ah-card.ah-t-mute > div.ah-body > div.ah-eyebrow` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 10.5px
  > Credentials (names only — never a value)
- `div.ah-card.ah-t-mute > div.ah-body > div.ah-note.ah-t-warn > code` 4.26:1 (needs 4.5:1) — rgb(138, 97, 16) on rgb(232,225,210) at 11.5px
  > AZURE_OPENAI_ENDPOINT
- `div.ah-card.ah-t-mute > div.ah-body > div.ah-note.ah-t-warn > code` 4.26:1 (needs 4.5:1) — rgb(138, 97, 16) on rgb(232,225,210) at 11.5px
  > AZURE_OPENAI_KEY
- …and 265 more

**staff pipeline shadow** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff clickup** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff draws** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.dd-wrap > div.dd-kpis > div.dd-kpi > div.dd-kpi-sub` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 12px
  > 0 awaiting approval
- `div.dd-wrap > div.dd-kpis > div.dd-kpi > div.dd-kpi-sub` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 12px
  > all clear
- `div.dd-wrap > div.dd-kpis > a.dd-kpi > div.dd-kpi-sub` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 12px
  > nothing waiting
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.dd-wrap > div.dd-kpis > div.dd-kpi > div.dd-kpi-sub` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 12px
  > 0 awaiting approval
- `div.dd-wrap > div.dd-kpis > div.dd-kpi > div.dd-kpi-sub` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 12px
  > all clear
- `div.dd-wrap > div.dd-kpis > a.dd-kpi > div.dd-kpi-sub` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 12px
  > nothing waiting
- …and 4 more

**staff closing** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff purchasing** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff draw rules** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `table.dd-table > thead > tr > th` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 11px
  > Note buyer (our name)
- `table.dd-table > thead > tr > th` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 11px
  > Sitewire capital partner
- `table.dd-table > thead > tr > th` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 11px
  > Status
- `div.dd-wrap > div.dd-card > div.inv-buyer > div.act-label` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 10.5px
  > Fidelis
- `div.dd-wrap > div.dd-card > div.inv-add > div.act-label` 3.92:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(255,255,255) at 10.5px
  > Add a contact
- `table.dd-table > thead > tr > th` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 11px
  > Capital partner
- `table.dd-table > thead > tr > th` 3.47:1 (needs 4.5:1) — rgb(122, 130, 133) on rgb(244,241,234) at 11px
  > Program
- …and 37 more

**staff tapes** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff audit log** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff e-sign** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff dashboards** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file

**staff notifications** — desktop, laptop, phone

- `div.app > header.app-topbar > div.user-pill > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13px
  > + New file
- `main.app-main > div.wrap > div.row > button.btn.btn-gold` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14px
  > ✎ Compose
- `div.panel > div.row > div > span.ec-pill.ec-pill-ok` 4.41:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,239,236) at 11.5px
  > Always on
- `div.panel > div.row > div > span.ec-pill.ec-pill-ok` 4.41:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,239,236) at 11.5px
  > Always on
- `div.panel > div.row > div > span.ec-pill.ec-pill-ok` 4.41:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,239,236) at 11.5px
  > Always on
- `div.panel > div.row > div > span.ec-pill.ec-pill-ok` 4.41:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,239,236) at 11.5px
  > Always on
- `div.panel > div.row > div > span.ec-pill.ec-pill-ok` 4.41:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,239,236) at 11.5px
  > Always on
- `div.panel > div.row > div > span.ec-pill.ec-pill-ok` 4.41:1 (needs 4.5:1) — rgb(46, 122, 94) on rgb(230,239,236) at 11.5px
  > Always on
- …and 70 more

**site home** — desktop, laptop, phone

- `div.m-wrap.hero-grid > div > div.hero-cta.reveal > a.btn.btn-gold.btn-lg` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 16px
  > ⚡ Generate your term sheet in seconds
- `div.reveal > div.ts > div.ts-top > span.live` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `main#top > section.m-proof > div.m-wrap > p.proof-note` 3.49:1 (needs 4.5:1) — rgba(244, 240, 231, 0.4) on rgb(20,27,34) at 11px
  > *Business-purpose, investment (non-owner-occupied) loans only. The figure shown is a repre
- `div.m-wrap > div.flagship.reveal-up > div.l > span.flag-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Flagship · DSCR Rental
- `section#suite > div.m-wrap > div.suite-foot.reveal-up > a.btn.btn-gold.btn-lg` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 16px
  > Open the full Investor Suite →
- `section#highlights > div.hl-grid > div.hl-card.reveal-up > span.hl-fine` 3.89:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(244,240,231) at 12px
  > Terms vary by experience, asset type and scenario.
- `section#highlights > div.hl-grid > div.hl-card.reveal-up > span.hl-fine` 3.89:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(244,240,231) at 12px
  > Guidelines vary by DSCR, credit and property profile.
- `section#highlights > div.hl-grid > div.hl-card.reveal-up > span.hl-fine` 3.89:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(244,240,231) at 12px
  > Restrictions may apply by seasoning and rent type.
- …and 283 more

**site investor suite** — desktop, laptop, phone

- `main > section.ssx-callout > div.ssx-wrap.in > a.ssx-btn.ssx-btn-gold.ssx-btn-lg` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 15px
  > Choose your application →
- `main > section.ssx-callout > div.ssx-wrap.in > a.ssx-btn.ssx-btn-gold.ssx-btn-lg` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 15px
  > Choose your application →
- `main > section.ssx-callout > div.ssx-wrap.in > a.ssx-btn.ssx-btn-gold.ssx-btn-lg` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 15px
  > Choose your application →

**site privacy** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**site terms** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**site disclosures** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**site sms terms** — desktop, laptop, phone

- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.
- `body > footer.footer > div.disclosures > p.copyright` 3.56:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(237,230,215) at 12.16px
  > © 2026 YS Capital Group. All rights reserved.

**tool deal analyzer** — desktop, laptop, phone

- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 10.56px
  > Inputs
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (if higher)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (%)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (override)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (%)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (years)
- `div.inputs-col > div.panel.da-reveal > div.panel-head > span.panel-tag` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 10.56px
  > Revenue
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (all units)
- …and 29 more

**tool equity compare** — desktop, laptop, phone

- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > First mortgage / mo
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > Second loan / mo
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > HELOC (interest-only) / mo
- `footer.suite-footer > div.sf-inner > div.sf-top > span.sf-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 16px
  > The answer is yes.™
- `body > footer.suite-footer > div.sf-inner > p.sf-disc` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > For estimation & education only. Outputs are estimates based on your inputs and are not a 
- `body > footer.suite-footer > div.sf-inner > p.sf-copy` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer.suite-footer > div.sf-inner > p.sf-copy > a` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > Disclosures
- …and 4 more

**tool flip analyzer** — desktop, laptop, phone

- `header.tool-bar > div.wrap.inner > div.tool-actions.topbar-actions > a.btn.btn-gold.btn-sm` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 13.5px
  > Apply now
- `div.form-col.inputs-col > section.panel > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Acquisition
- `div.form-col.inputs-col > section.panel.reveal > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Construction
- `div.form-grid > div.field > label > em` 4.42:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(255,255,255) at 12.48px
  > (optional)
- `div.form-col.inputs-col > section.panel.reveal > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Bridge loan
- `div.form-grid > div.field > label > em` 4.42:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(255,255,255) at 12.48px
  > (%)
- `div.form-grid > div.field.span2 > label > em` 4.42:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(255,255,255) at 12.48px
  > (months)
- `div.form-col.inputs-col > section.panel.reveal > div.panel-h > span.eyebrow` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 12px
  > Monthly carry
- …and 32 more

**tool loan application** — desktop, laptop, phone

- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Primary residence — where this borrower lives, not the subject property
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Time at this address
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Housing status *
- `div.la-scope > footer.suite-footer > div.sf-inner > p.sf-copy` 4.07:1 (needs 4.5:1) — rgba(244, 240, 231, 0.45) on rgb(20,27,34) at 11.5px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer.suite-footer > div.sf-inner > p.sf-copy > a` 4.07:1 (needs 4.5:1) — rgba(244, 240, 231, 0.45) on rgb(20,27,34) at 11.5px
  > Disclosures
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Primary residence — where this borrower lives, not the subject property
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Time at this address
- `section.wizard-step.is-active.app-wrap > div.panel.borrower-block > div.field-rows > div.subhead` 3.31:1 (needs 4.5:1) — rgb(174, 135, 70) on rgb(255,255,255) at 11px
  > Housing status *
- …and 7 more

**tool term sheet studio** — desktop, laptop, phone

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.panel > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (optional)
- `div.panel > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (optional — the individual / guarantor)
- `div.panel > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (optional — adds a second signature line)
- `div.field-rows.two-col > div.field.cond > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (months)
- `div.field-rows.two-col > div.field.cond > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > ($)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (months)
- `form#tsForm > div.panel.reveal > p.rate-hint` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.52px
  > Your rate is set automatically from experience, credit, leverage and the program — it appe
- …and 18 more

**tool portfolio tracker** — desktop, laptop, phone

- `footer.suite-footer > div.sf-inner > div.sf-top > span.sf-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 16px
  > The answer is yes.™
- `body > footer.suite-footer > div.sf-inner > p.sf-disc` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > For estimation & education only. Outputs are estimates based on your inputs and are not a 
- `body > footer.suite-footer > div.sf-inner > p.sf-copy` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer.suite-footer > div.sf-inner > p.sf-copy > a` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > Disclosures
- `footer.suite-footer > div.sf-inner > div.sf-top > span.sf-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 16px
  > The answer is yes.™
- `footer.suite-footer > div.sf-inner > div.sf-top > span.sf-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 16px
  > The answer is yes.™

**tool qualifier pro** — desktop, laptop, phone

- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 10.56px
  > Sizing
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (%)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (manual override)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (%)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (years)
- `div.inputs-col > div.panel.qp-reveal > div.panel-head > span.panel-tag` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 10.56px
  > Carry
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (annual)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (annual)
- …and 22 more

**tool ratesaver** — desktop, laptop, phone

- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `table.cmp-table > thead > tr > th` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.84px
  > Option
- `table.cmp-table > thead > tr > th` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.84px
  > Rate
- `table.cmp-table > thead > tr > th` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.84px
  > Cost
- `table.cmp-table > thead > tr > th` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.84px
  > Payment
- `table.cmp-table > thead > tr > th` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.84px
  > Saves/mo
- `table.cmp-table > thead > tr > th` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.84px
  > Break-even
- `div#summary > div.note-row > div.tip` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > Option 1: hold the loan at least 2.5 years for the buydown to pay off. Refinancing sooner 
- …and 10 more

**tool refi breakpoint** — desktop, laptop, phone

- `div.results-col.out-col > aside.result-card > div.result-top > span.est` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 11px
  > Live
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > Total closing costs
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > Monthly interest savings
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > Old monthly interest
- `div.results-col.out-col > div.result-grid > div.result > div.r-label` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > New monthly interest
- `footer.suite-footer > div.sf-inner > div.sf-top > span.sf-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 16px
  > The answer is yes.™
- `body > footer.suite-footer > div.sf-inner > p.sf-disc` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > For estimation & education only. Outputs are estimates based on your inputs and are not a 
- `body > footer.suite-footer > div.sf-inner > p.sf-copy` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- …and 5 more

**tool term sheet** — desktop, laptop, phone

- `body > main > section.tool-hero.an-head > div.suite-eyebrow` 4.10:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(244,240,231) at 12px
  > Standard Program · Fix & Flip · Ground-Up · Bridge
- `div.panel > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (optional)
- `div.panel > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (optional — the individual / guarantor)
- `div.panel > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (optional — adds a second signature line)
- `div.field-rows.two-col > div.field.cond > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (months)
- `div.field-rows.two-col > div.field.cond > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > ($)
- `div.field-rows.two-col > div.field > label > em` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.48px
  > (months)
- `form#tsForm > div.panel.reveal > p.rate-hint` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 11.52px
  > Your rate is set automatically from experience, credit, leverage and the program — it appe
- …and 18 more

**tool track record** — desktop, laptop, phone

- `div#tr-app > section.tr-toolbar > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14.72px
  > + Add a property
- `div#tr-app > section.tr-exportbar > div.tr-export-btns > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14.72px
  > Export branded PDF ⤓
- `footer.suite-footer > div.sf-inner > div.sf-top > span.sf-tag` 4.43:1 (needs 4.5:1) — rgb(47, 127, 134) on rgb(251,249,243) at 16px
  > The answer is yes.™
- `body > footer.suite-footer > div.sf-inner > p.sf-disc` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > For estimation & education only. Outputs are estimates based on your inputs and are not a 
- `body > footer.suite-footer > div.sf-inner > p.sf-copy` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > © 2026 YS Capital Group. All rights reserved. Equal Housing Lender. Disclosures.
- `footer.suite-footer > div.sf-inner > p.sf-copy > a` 4.20:1 (needs 4.5:1) — rgb(110, 122, 126) on rgb(251,249,243) at 12.16px
  > Disclosures
- `div#tr-app > section.tr-toolbar > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14.72px
  > + Add a property
- `div#tr-app > section.tr-exportbar > div.tr-export-btns > button.tr-btn.primary` 3.31:1 (needs 4.5:1) — rgb(255, 255, 255) on rgb(174,135,70) at 14.72px
  > Export branded PDF ⤓
- …and 4 more

## tiny-text (1173)


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
- `div.wrap > div.file-top > span.file-top-amt > span.k` 10.5px text
  > Loan amount
- `div.cv-head > div.cv-head-actions > button.cv-avastack > span.cv-ava.small.online` 9.5px text
  > MB
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `header.header > div.wrap > a.brand > span.sub` 10px text
  > Borrower console
- `div.wrap > div.file-top > span.file-top-amt > span.k` 10.5px text
  > Loan amount
- `div.cv-head > div.cv-head-actions > button.cv-avastack > span.cv-ava.small.online` 9.5px text
  > MB
- …and 2 more

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
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff new file** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff tasks** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff workflow** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff file** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 14 more

**staff file draws** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff team** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff conditions studio** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff pricing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff approvals** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff settings** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff AI center** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `div > div > div > span` 10.5px text
  > ocr:docint-2024-11-30
- `div > div > div > span` 10.5px text
  > model:gpt5
- `div > div > div > span` 10.5px text
  > extractionSchema:uw-schema-r1
- …and 39 more

**staff archived** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff leads** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff emails** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff orders** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff investor suite** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff term sheet** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff borrowers** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff borrower detail** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff borrower view** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff vendors** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research comps** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research market** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research adjustments** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research appraisers** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research quick answer** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff research areas** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff chat** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `div.cv-item-main > div.cv-item-top > span.cv-item-avas > span.cv-ava.tiny` 8.5px text
  > AN
- `div.cv-item-main > div.cv-item-top > span.cv-item-avas > span.cv-ava.tiny` 8.5px text
  > MB
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- …and 12 more

**staff api health** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `div.ah-grid > div.ah-card.ah-t-mute > div.ah-body > div.ah-eyebrow` 10.5px text
  > Switches
- `div.ah-sw > div.ah-sw-l > div.ah-sw-t > span.ah-tag.ah-t-bad` 9.5px text
  > changes live behavior
- `div.ah-grid > div.ah-card.ah-t-mute > div.ah-body > div.ah-eyebrow` 10.5px text
  > Credentials (names only — never a value)
- …and 132 more

**staff pipeline shadow** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff clickup** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff draws** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff closing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff purchasing** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff draw rules** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `div.dd-wrap > div.dd-card > div.inv-buyer > div.act-label` 10.5px text
  > Fidelis
- `div.dd-wrap > div.dd-card > div.inv-add > div.act-label` 10.5px text
  > Add a contact
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- …and 12 more

**staff tapes** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff audit log** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff e-sign** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff dashboards** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**staff notifications** — desktop, laptop, phone

- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Files
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Admin
- `a.brand > span.pilot-lockup > span.pilot-stack > span.pilot-by` 9px text
  > by YS Capital
- `aside.app-sidebar > div.app-brandrow > a.brand > span.sub` 10px text
  > Admin console
- `div#root > div.app > aside.app-sidebar > div.sb-sec` 10.5px text
  > Main
- …and 6 more

**tool deal analyzer** — desktop, laptop, phone

- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Inputs
- `div.inputs-col > div.panel.da-reveal > div.panel-head > span.panel-tag` 10.56px text
  > Revenue
- `div.inputs-col > div.panel.da-reveal > div.panel-head > span.panel-tag` 10.56px text
  > Expenses
- `div.inputs-col > div.panel.da-reveal > div.panel-head > span.panel-tag` 10.56px text
  > One-time
- `div.results-col > div.result-hero > div.rh-top > span.rh-ey` 10.88px text
  > Deal result · Estimate
- `div.results-col > div.result-hero > div.rh-top > span.rh-live` 10.88px text
  > Live
- `div.results-col > div.result-grid > div.result > div.r-label` 10.88px text
  > Cap rate
- `div.results-col > div.result-grid > div.result > div.r-label` 10.88px text
  > Cash-on-cash ROI
- …and 58 more

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
- `div.vs > div.opt > div.obl > span.bk` 10.5px text
  > Blended rate
- …and 19 more

**tool flip analyzer** — desktop, laptop, phone

- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > price + rehab
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- `div.out-col.results-col > div.kpi-grid > div.kpi > div.est-flag` 10px text
  > Estimate
- …and 16 more

**tool term sheet studio** — desktop, laptop, phone

- `article#pcardStd > div.pcard-loanlbl` 10.24px text
  > Loan amount
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- `span#stdOrigPts` 9.6px text
  > 1.25 pts
- `article#pcardGold > div.pcard-loanlbl` 10.24px text
  > Loan amount
- `article#pcardGold > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardGold > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- `span#goldOrigPts` 9.6px text
  > 1.25 pts
- …and 43 more

**tool portfolio tracker** — desktop, laptop, phone

- `table.pf-table > thead > tr > th` 10.5px text
  > Address
- `table.pf-table > thead > tr > th` 10.5px text
  > Type
- `table.pf-table > thead > tr > th` 10.5px text
  > Purchase $
- `table.pf-table > thead > tr > th` 10.5px text
  > Value $
- `table.pf-table > thead > tr > th` 10.5px text
  > Mortgage $
- `table.pf-table > thead > tr > th` 10.5px text
  > Equity $
- `table.pf-table > thead > tr > th` 10.5px text
  > Cash in deal $
- `table.pf-table > thead > tr > th` 10.5px text
  > Rent /mo
- …and 25 more

**tool qualifier pro** — desktop, laptop, phone

- `div.inputs-col > div.panel > div.panel-head > span.panel-tag` 10.56px text
  > Sizing
- `div.inputs-col > div.panel.qp-reveal > div.panel-head > span.panel-tag` 10.56px text
  > Carry
- `div.inputs-col > div.panel.qp-reveal > div.panel-head > span.panel-tag` 10.56px text
  > Coverage
- `div.results-col > div.result-hero > div.rh-top > span.rh-ey` 10.88px text
  > DSCR result · Estimate
- `div.results-col > div.result-hero > div.rh-top > span.rh-live` 10.88px text
  > Live
- `div.results-col > div.result-grid > div.result > div.r-label` 10.88px text
  > Final loan amount
- `div.results-col > div.result-grid > div.result > div.r-label` 10.88px text
  > Down payment
- `div.results-col > div.result-grid > div.result > div.r-label` 10.88px text
  > Monthly P&I
- …and 25 more

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

**tool term sheet** — desktop, laptop, phone

- `article#pcardStd > div.pcard-loanlbl` 10.24px text
  > Loan amount
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardStd > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- `span#stdOrigPts` 9.6px text
  > 1.25 pts
- `article#pcardGold > div.pcard-loanlbl` 10.24px text
  > Loan amount
- `article#pcardGold > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > note rateiYour interest rate on the loan. It’s charged interest-only during the term — you
- `article#pcardGold > div.pcard-headline > div.pcard-stat > div.pcard-statlbl` 9.6px text
  > origination · 1.25 ptsiThe lender’s fee at closing. “1 point” = 1% of the loan amount.
- `span#goldOrigPts` 9.6px text
  > 1.25 pts
- …and 43 more

**tool track record** — desktop, laptop, phone

- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Deals on record
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Fix & flips
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Fix & holds
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Acquisition volume
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Rehab invested
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Avg hold
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Deals on record
- `section.tr-summary > div.tr-stats > div.tr-stat > div.tr-stat-l` 10.88px text
  > Fix & flips
- …and 10 more

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

## ios-zoom-field (50)


**staff queue** — phone

- `div.stack > div.row > div.row > select.input.flt-sm` 12.5px control — iOS zooms the page on focus (needs 16px)
  > CreatedFunded

**staff leads** — phone

- `div.wrap > div.stack > div.row.lead-filters > select.input.flt-sm` 12.5px control — iOS zooms the page on focus (needs 16px)
  > All stagesNewContactedQualifiedQuotedIn progressWonNurturingLostArchived
- `div.wrap > div.stack > div.row.lead-filters > select.input.flt-sm` 12.5px control — iOS zooms the page on focus (needs 16px)
  > All ownersMy leadsUnassignedEsther BochnerYonah RapapaortGoldy RosenbergEzra GreenSarah Am

**staff orders** — phone

- `select#ord-owner` 13px control — iOS zooms the page on focus (needs 16px)
  > AnyoneNobody yet

**staff vendors** — phone

- `select#vs-type` 13px control — iOS zooms the page on focus (needs 16px)
  > EveryoneTitle companiesInsurance agents

**staff research** — phone

- `div > aside > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `aside > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `aside > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > aside > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `aside > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `aside > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `aside > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `aside > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- …and 15 more

**staff research comps** — phone

- `section > div > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `section > div > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `section > div > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `section > div > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `section > div > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `section > div > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `section > div > label > select` 14px control — iOS zooms the page on focus (needs 16px)
  > —C1 — brand newC2 — like newC3 — well maintainedC4 — average, some wearC5 — needs obvious 

**staff research market** — phone

- `div > section > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > section > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > section > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div.wrap > div > section > select` 14px control — iOS zooms the page on focus (needs 16px)
  > last 12 monthslast 2 yearslast 3 yearslast 5 years

**staff research adjustments** — phone

- `div.wrap > div > form > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div.wrap > div > form > input` 14px control — iOS zooms the page on focus (needs 16px)

**staff research appraisers** — phone

- `div.wrap > div > div > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div.wrap > div > div > select` 14px control — iOS zooms the page on focus (needs 16px)
  > Most files for usMost recent reportBy nameBy firm

**staff research quick answer** — phone

- `div > form > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > form > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > form > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > form > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > form > label > select` 14px control — iOS zooms the page on focus (needs 16px)
  > 6 months12 months18 months24 months36 months60 months

**staff research areas** — phone

- `div > form > label > input` 14px control — iOS zooms the page on focus (needs 16px)
- `div > form > label > input` 14px control — iOS zooms the page on focus (needs 16px)

## ellipsized (27)


**borrower file** — desktop, laptop, phone

- `div.wrap > div.file-top > div.file-top-main > h1.file-top-addr` 123px past its box (…)
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `div.panel > div.rail-team > div.rail-who > div.rail-n` 79px past its box (…)
  > Alexandra Konstantinopoulos-Vandermeulen
- `div.wrap > div.file-top > div.file-top-main > h1.file-top-addr` 277px past its box (…)
  > 12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C, Saint Petersburg Be
- `div.cv-head > div.cv-head-main > div > div.cv-title` 13px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom
- `div.panel > div.rail-team > div.rail-who > div.rail-n` 79px past its box (…)
  > Alexandra Konstantinopoulos-Vandermeulen
- `div.wrap > div.file-top > div.file-top-main > span.muted.small` 144px past its box (…)
  > YSCAP-CSSAUDIT-LONG · Ground Up Construction — Tier 3 Experienced Builder · RTL
- `div.cv-head > div.cv-head-main > div > div.cv-title` 242px past its box (…)
  > Borrower — Featherstonehaugh-Wintersbottom
- `div.panel > div.rail-team > div.rail-who > div.rail-n` 5px past its box (…)
  > Alexandra Konstantinopoulos-Vandermeulen

**staff file** — desktop, laptop, phone

- `div.wrap > div.file-top > div.file-top-main > h1.file-top-addr` 990px past its box (…)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom · 12345 Northwest Kensington-Montg
- `div.wrap > div.file-top > div.file-top-main > h1.file-top-addr` 1150px past its box (…)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom · 12345 Northwest Kensington-Montg
- `div.wrap > div.file-top > div.file-top-main > span.muted.small` 63px past its box (…)
  > YSCAP-CSSAUDIT-LONG · Ground-Up Construction — Tier 3 Experienced Builder · RTL · $14,212,
- `div.wrap > div.file-top > div.file-top-main > span.muted.small` 244px past its box (…)
  > YSCAP-CSSAUDIT-LONG · Ground-Up Construction — Tier 3 Experienced Builder · RTL · $14,212,
- `div.loan-prog > ol.lp-track > li.lp-step.done > span.lp-label` 4px past its box (…)
  > Submitted
- `div.loan-prog > ol.lp-track > li.lp-step.done > span.lp-label` 7px past its box (…)
  > Processing
- `div.loan-prog > ol.lp-track > li.lp-step.current > span.lp-label` 17px past its box (…)
  > Underwriting
- `div.loan-prog > ol.lp-track > li.lp-step.upcoming > span.lp-label` 3px past its box (…)
  > Approved
- …and 1 more

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

## tap-target (929)


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

**staff borrowers** — desktop, laptop, phone

- `tr > td > span.off > a.lead` 390×22px (min 24×24)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom
- `tr > td > span.off > a.lead` 45×22px (min 24×24)
  > Ana Ng
- `tr > td > span.off > a.lead` 390×22px (min 24×24)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom
- `tr > td > span.off > a.lead` 45×22px (min 24×24)
  > Ana Ng
- `tr > td > span.off > a.lead` 390×22px (min 24×24)
  > Maximiliano Bartholomew Featherstonehaugh-Wintersbottom
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
- …and 110 more

**site investor suite** — desktop, laptop, phone

- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 32×22px (min 24×24)
  > Price
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 50×22px (min 24×24)
  > Analyze
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 58×22px (min 24×24)
  > Compare
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > div.nav-actions > a.ssx-back` 85×22px (min 24×24)
  > ← Back to site
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 32×22px (min 24×24)
  > Price
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 50×22px (min 24×24)
  > Analyze
- `header.ssx-nav > div.ssx-wrap.ssx-nav-inner > nav.ssx-nav-links > a` 58×22px (min 24×24)
  > Compare
- …and 3 more

**site privacy** — desktop, laptop, phone

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- …and 1 more

**site terms** — desktop, laptop, phone

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- …and 1 more

**site disclosures** — desktop, laptop, phone

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a.nav-suite` 90×24px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- …and 1 more

**site sms terms** — desktop, laptop, phone

- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a` 92×24px (min 24×24)
  > Privacy Policy
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#nav > div.nav-inner > nav.nav-links > a` 63×24px (min 24×24)
  > Programs
- `header#nav > div.nav-inner > nav.nav-links > a` 53×24px (min 24×24)
  > Contact
- `header#nav > div.nav-inner > nav.nav-links > a` 92×24px (min 24×24)
  > Privacy Policy
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- …and 1 more

**tool deal analyzer** — desktop, laptop, phone

- `header#daBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#daBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#daBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#daBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#daBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×

**tool equity compare** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- …and 1 more

**tool flip analyzer** — desktop, laptop, phone

- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `button#contactPopClose` 17×21px (min 24×24)
  > ×

**tool loan application** — desktop, laptop, phone

- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×

**tool term sheet studio** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- …and 1 more

**tool portfolio tracker** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header#ptBar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header#ptBar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `button#contactPopClose` 17×21px (min 24×24)
  > ×

**tool qualifier pro** — desktop, laptop, phone

- `header#qpBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#qpBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#qpBar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 88×23px (min 24×24)
  > Investor Suite
- `header#qpBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header#qpBar > div.topbar-inner > div.topbar-actions > a.back` 67×23px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×

**tool ratesaver** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- …and 1 more

**tool refi breakpoint** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- …and 1 more

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
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite.tb-under` 88×23px (min 24×24)
  > Investor Suite
- …and 12 more

**tool term sheet** — desktop, laptop, phone

- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `div.inner > div.crumb > span.trail > a.tb-under` 84×21px (min 24×24)
  > Investor Suite
- `header.tool-bar > div.inner > div.tool-actions > a.back.tb-under` 62×21px (min 24×24)
  > ← All tools
- …and 1 more

**tool track record** — desktop, laptop, phone

- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header.topbar > div.topbar-inner > div.topbar-crumb > a.crumb-suite` 84×21px (min 24×24)
  > Investor Suite
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
- `header.topbar > div.topbar-inner > div.topbar-actions > a.back` 62×21px (min 24×24)
  > ← All tools
- `button#contactPopClose` 17×21px (min 24×24)
  > ×
