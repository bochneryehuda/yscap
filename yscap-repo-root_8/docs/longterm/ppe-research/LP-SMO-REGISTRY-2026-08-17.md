<!--
  LIVE capture of the Lender Price SPECIAL-MORTGAGE-OPTION (SMO) registry for this tenant.
  Captured 2026-08-17 via client.fetchSmoRegistry(companyId) against the live foundation. LT-only.
  These are TOKEN NAMES + their vendor ids — no credentials, no borrower data. Reference for the
  PPP layer, the 5% Fixed promo model (D33), and the rule builder. Ids can change; re-capture if the
  foundation reports drift.
-->

# Lender Price SMO registry — live capture (2026-08-17)

**193 special-mortgage-option tokens** in the tenant registry (company `68e4306f55eb24000170fea2`).

## Prepay / PPP-relevant tokens (the ones the DSCR PPP layer + promo model care about)

| token name | vendor id |
| --- | --- |
| 1 Yr PPP | `592868b74cedfd00015bdd61` |
| 2 Yr PPP | `592868b74cedfd00015bdd62` |
| 3 Yr PPP | `592868b74cedfd00015bdd63` |
| 4 Yr PPP | `583608ece4b075381a196a57` |
| 5 Yr PPP | `58263ae7e4b0e7f399741293` |
| 5% Flat Prepay | `6373fe9dce8ad00001a1b87e` |
| No PPP | `592868b74cedfd00015bdd64` |

**Finding (closes the §2.1 "Prepay Buyout" open item, honestly):** there is **no SMO token literally named "Prepay Buyout"** in this registry. The prepay-related tokens are the declining `N Yr PPP` series and the flat **`5% Flat Prepay`** promo (id `6373fe9dce8ad00001a1b87e`) — the exact live token for the D33 5% Fixed promo model. Mapping the frontend’s captured "Prepay Buyout" special-mortgage-option to a specific token/field still needs the actual frontend request capture beside this list; it is NOT guessed here.

## Full registry (A–Z)

| token name | vendor id |
| --- | --- |
| >=1x30x13-24 | `5835ce27e4b0753819c98c6e` |
| 0x30x12 | `58263ae7e4b0e7f399741292` |
| 0x30x12, 0x60x24 | `582b7398e4b0e7f39aaade00` |
| 0x30x24 | `5877c2d1e4b0111f2df0eb54` |
| 0x60x12 | `58263ae7e4b0e7f399741291` |
| 0x90x12 | `582a4df1e4b0e7f39a5b1469` |
| 1 Yr PPP | `592868b74cedfd00015bdd61` |
| 1 Yr Tax Return | `57f2f4cae4b071ea7b978632` |
| 1-0 Buydown | `57f2f4cae4b071ea7b977fb2` |
| 1099 | `5f36ae88ce8ad0000124dd25` |
| 12 Month Business Bank Statements | `583d9d96e4b06f18ab238ca6` |
| 12 Month CPA Prepared P&L | `5f370123ce8ad00001aa2289` |
| 12 Month Personal Bank Statements | `583d9d96e4b06f18ab238ca7` |
| 12 Month Tax Prepared P&L | `5f4e7676ce8ad00001d299cf` |
| 1x120x12 | `588faa88e4b0a09ed13bcd43` |
| 1x30x12 | `57f2f4cae4b071ea7b977fa3` |
| 1x60x12, 0x90x12 | `582b7398e4b0e7f39aaade01` |
| 2 Month Bank Statements | `59443aee4cedfd0001f8539e` |
| 2 Yr PPP | `592868b74cedfd00015bdd62` |
| 2-1 Buydown | `57f2f4cae4b071ea7b977fac` |
| 203k Standard | `57f2f4cae4b071ea7b97805f` |
| 203k Streamline | `57f2f4cae4b071ea7b97805e` |
| 24 Month Business Bank Statements | `583d9d96e4b06f18ab238ca9` |
| 24 Month CPA Prepared P&L | `5f3ac007ce8ad00001b0aab6` |
| 24 Month Personal Bank Statements | `583d9d96e4b06f18ab238ca8` |
| 24 Month Tax Prepared P&L | `5f4e7676ce8ad00001d299ce` |
| 3 Yr PPP | `592868b74cedfd00015bdd63` |
| 4 Yr PPP | `583608ece4b075381a196a57` |
| 5 Yr PPP | `58263ae7e4b0e7f399741293` |
| 5% Flat Prepay | `6373fe9dce8ad00001a1b87e` |
| ACH (Automatic Payment) | `57f2f4cae4b071ea7b9783d5` |
| Affordable/Community Second | `58408b4de4b0503cc1daeba6` |
| Agency Plus | `57f2f4cae4b071ea7b9780bd` |
| Alt Doc - 12 Months | `57f2f4cae4b071ea7b978317` |
| Alt Doc - 24 Months | `57f2f4cae4b071ea7b9782ea` |
| Alternative Credit Program | `585aaf3ee4b0cc5a2b6fd108` |
| Alternative Doc | `57f2f4cae4b071ea7b9780d7` |
| ASR Option 2 | `582f5191e4b09776b11f21ee` |
| ASR Option 3 | `582f5191e4b09776b11f21ef` |
| Asset Depletion | `57f2f4cae4b071ea7b977fdf` |
| Asset Group 1 | `593586c84cedfd0001bcd9c7` |
| Asset Group 2 | `57f2f4cae4b071ea7b978036` |
| Asset Group 3 | `588a7583e4b0a09ecef8ab71` |
| Asset Qualifier | `57f2f4cae4b071ea7b9780f2` |
| ATR In Full | `5f690f94ce8ad00001924a75` |
| Bankruptcy >=7 Years | `57f2f4cae4b071ea7b978e80` |
| BK < 2 Yrs | `5df2a130e03dd80001737b9d` |
| BK > 4 Years | `57f2f4cae4b071ea7b979002` |
| BK >= 2 Yrs | `5df2a109e03dd800016f5987` |
| BK CH 13 Discharge > or =1 Yrs | `6021adc8ce8ad00001c03cd4` |
| BK CH 13 Discharge > or =2 Yrs | `582608cce4b086e7ebaa4828` |
| BK CH 13 Dismissal > or =2Yrs | `5826097ce4b086e7ebaabdbc` |
| BK CH 13 Dismissal > or =4Yrs | `58260901e4b086e7ebaa5547` |
| BK CH 7 Discharge > or =2Yrs | `582609bfe4b086e7ebaae206` |
| BK CH 7 Discharge > or =4Yrs | `58260924e4b086e7ebaa640e` |
| Blue Shirt | `5dcb28754cedfd0001a3b6c0` |
| Borrower Paid Comp | `5f174c4b24aa9a00019506d7` |
| Borrower Prepared P&L | `57f2f4cae4b071ea7b978d0f` |
| Borrowers > 2 | `5cfee8174cedfd00018bc687` |
| Broker | `5ee0e50fce8ad00001697248` |
| Cash Out - Debt Consolidation | `5983acec4cedfd0001283172` |
| CH 11 Bankruptcy >=1 Yrs | `6021aee5ce8ad00001cca082` |
| CH 11 Bankruptcy >=3 Yrs | `5a147b874cedfd00012ea7d9` |
| CH 11 Bankruptcy >=5 Yrs | `5a147df04cedfd00012fa71e` |
| CH 13 Bankruptcy >=1 Yrs | `6021af61ce8ad00001d3b94f` |
| CH 13 Bankruptcy >=2 Yrs | `5835a747e4b0753819a1884e` |
| CH 13 Bankruptcy >=3 Yrs | `5a147b874cedfd00012ea7da` |
| CH 7 Bankruptcy >=1 Yrs | `6021af91ce8ad00001d7637e` |
| CH 7 Bankruptcy >=2 Yrs | `5835a747e4b0753819a1884c` |
| CH 7 Bankruptcy >=3 Yrs | `5936c5264cedfd00010b3c92` |
| CH 7 Bankruptcy >=5 Yrs | `5a147df04cedfd00012fa71f` |
| CH 7 Bankruptcy >=Settled | `5835b01ee4b0753819a39939` |
| Ch. 11 Bankruptcy >=2 Yrs | `594d25204cedfd0001e17236` |
| Ch. 11 Personal Bankruptcy >=2 Yrs | `59d6afff4cedfd00017a67a7` |
| Ch. 11 Personal Bankruptcy >=4 Yrs | `59d6af8b4cedfd000179a568` |
| Ch. 13 Bankruptcy >=4 Yrs | `59370aa64cedfd00012cd46c` |
| CH. 13 Bankruptcy >=Settled | `57f2f4cae4b071ea7b97940d` |
| Ch. 7 Bankruptcy >=1 Yr | `594d5ddd4cedfd0001f6c51b` |
| Ch. 7 Bankruptcy >=4 Yrs | `59370aa64cedfd00012cd46d` |
| Chattel Loan | `57f2f4cae4b071ea7b9780a4` |
| CHOICEHome | `5eea939224aa9a0001d023c7` |
| Co-Op | `57f2f4cae4b071ea7b97846e` |
| Condotel | `57f2f4cae4b071ea7b978548` |
| CPA Prepared P&L | `5f3700cdce8ad00001a67510` |
| Debt Service Coverage Ratio | `57f2f4cae4b071ea7b978407` |
| Delayed Financing | `5df2cb60e03dd80001699ce2` |
| DIL >=1 Yrs | `6021afb8ce8ad00001daa2ae` |
| DIL >=2 Yrs | `57f2f4cae4b071ea7b978fa0` |
| DIL >=3 Yrs | `57f2f4cae4b071ea7b97971d` |
| DIL >=4 Yrs | `594ada6d4cedfd000160b3e9` |
| DIL >=5 Yrs | `5a147e3b4cedfd000130197f` |
| DIL >=7 Years | `57f2f4cae4b071ea7b97812b` |
| DIL >=Settled | `57f2f4cae4b071ea7b9791fb` |
| Down Payment Assistance | `5d8d164c4cedfd00018f7330` |
| DSCR | `5f37104ace8ad000014c7abe` |
| DSCR <.75% | `614bb105ce8ad00001b87d07` |
| DSCR <1.00 | `588a6e2ee4b0a09eceee1bdd` |
| DSCR >=1.00 | `5f443dcbce8ad00001a03782` |
| DSCR >=1.25 | `62f12f09ce8ad0000134337b` |
| DSCR >=1.25 - J | `59235dd24cedfd0001c137fe` |
| DSCR 0.85-0.99 | `636bf051ce8ad0000182308a` |
| DSCR 1.00-1.49 | `636bf051ce8ad00001823088` |
| DSCR 1.000 - 1.149 | `637d270bce8ad00001b7319d` |
| DSCR 1.150 - 1.499 | `637d273bce8ad00001b742c1` |
| DSCR 1.50+ | `636bf051ce8ad00001823089` |
| DU Refi Plus | `57f2f4cae4b071ea7b977f9e` |
| Escrow Holdback | `57f2f4cae4b071ea7b978293` |
| FC/SS/DIL  < 4 Years | `57f2f4cae4b071ea7b978218` |
| FC/SS/DIL < 3 Yrs | `5df2a190e03dd8000179cc5c` |
| FC/SS/DIL >= 3 Yrs | `5df2a15fe03dd80001773889` |
| FHA 203(h) | `5873d316e4b077d25192baa6` |
| Fireman | `62f2c293ce8ad00001938a39` |
| First Time Home Buyer | `57f2f4cae4b071ea7b977fc1` |
| Fix and Flip | `57f2f4cae4b071ea7b978581` |
| Float Down Lock Option | `57f2f4cae4b071ea7b9781f0` |
| Forbearance <=180 days | `5f69119ece8ad00001a59cba` |
| Forbearance <=90 days | `5f69119ece8ad00001a59cb8` |
| Forbearance >=18 Months | `57f2f4e4e4b071ea7b97d3f6` |
| Foreclosure >=1 Yrs | `6021b010ce8ad00001e0fab3` |
| Foreclosure >=2 Years | `57f2f4cae4b071ea7b979065` |
| Foreclosure >=2 Yrs | `58260c69e4b086e7ebabb082` |
| Foreclosure >=3 Years | `57f2f4cae4b071ea7b978edf` |
| Foreclosure >=4 Yrs | `58260c69e4b086e7ebabb083` |
| Foreclosure >=5 Yrs | `58360a5be4b075381a1b7c00` |
| Foreclosure >=7 Yrs | `59370aa64cedfd00012cd46e` |
| Foreclosure >=Settled | `57f2f4cae4b071ea7b97947a` |
| Foreign National | `57f2f4cae4b071ea7b97804a` |
| Full Doc | `57f2f4cbe4b071ea7b97a286` |
| Full Doc, Non-QM | `59415cee4cedfd00011308bd` |
| Hobby Farm | `58485a45e4b05fb999f19afa` |
| Home One | `582b7398e4b0e7f39aaade02` |
| Home Possible | `57f2f4cae4b071ea7b978075` |
| Home Possible Advantage | `57f2f4cae4b071ea7b9784d9` |
| HomeReady | `57f2f4cae4b071ea7b977fa0` |
| Homestyle | `57f2f4cae4b071ea7b97808c` |
| Interest Only | `57f2f4cae4b071ea7b978006` |
| Investor DTI | `582a457de4b0e7f39a54a90f` |
| ITIN | `581a41efe4b03ef9dcc9a21d` |
| Limited Trade Lines | `57f2f4cbe4b071ea7b97987c` |
| Log Home | `611d1600ce8ad00001d1b70e` |
| LP Open Access | `57f2f4cae4b071ea7b978015` |
| Manual Underwrite | `57f2f4cae4b071ea7b9781a9` |
| Manufactured Housing | `57f2f4cae4b071ea7b978025` |
| MH Advantage | `5f174da424aa9a00019535d1` |
| Mixed Use | `587d19ece4b0cbf1cd32e833` |
| Mortgage Loan Charge-Off >=2 Yrs | `5835a747e4b0753819a1884d` |
| Mortgage Loan Charge-Off >=4 Yrs | `595523304cedfd000134de73` |
| Mortgage Loan Charge-Off >=Settled | `5835b01ee4b0753819a39938` |
| Multiple 30x12 | `5fd40658ce8ad00001fe2f69` |
| Multiple Housing Events >24 Months | `57f2f4cae4b071ea7b9781cb` |
| NDC | `5edfebfcce8ad00001f76e32` |
| No Appraisal | `585aaf3ee4b0cc5a2b6fd107` |
| No Mortgage History | `5835b01ee4b0753819a39937` |
| No PPP | `592868b74cedfd00015bdd64` |
| No Ratio | `58261542e4b0e7f39944da6e` |
| Non Permanent Resident | `57f2f4cae4b071ea7b978149` |
| Non-Occupant Co-Borrower | `57f2f4cae4b071ea7b9783a4` |
| Non-Warrantable Condo | `57f2f4cae4b071ea7b977fd4` |
| OTC | `619d56f5ce8ad00001b5a184` |
| Partnership / LLC | `5840a80fe4b0503cc20d2526` |
| Permanent Resident Alien | `57f2f4cae4b071ea7b977fca` |
| Product Exception | `5835aaf6e4b0753819a25751` |
| Property Inspection Waiver | `5866d668e4b01a69c1711dba` |
| PUDtel | `5f69119ece8ad00001a59cb9` |
| RC Commit Pd | `57f2f4cae4b071ea7b978cb6` |
| Refer | `57f2f4cae4b071ea7b978269` |
| Relocation Loan | `5a5694394cedfd0001295a23` |
| Reserves <6 Months | `585c131ce4b08ced94320242` |
| Rural Property | `57f2f4cae4b071ea7b978e22` |
| Seasoned Foreclosure > 7 years | `58ac82efc9e77c00012fab04` |
| Self-Employed | `57f2f4cae4b071ea7b978c07` |
| Self-Employed - 12 Mo. Verification | `593586df4cedfd0001bceb43` |
| Short Sale - 24 mos | `57f2f4cae4b071ea7b977fb9` |
| Short Sale - Settled | `57f2f4cae4b071ea7b97866f` |
| Short Sale >=1 Yrs | `6021b042ce8ad00001e326e2` |
| Short Sale >=2 Yrs | `5835a7e6e4b0753819a1d762` |
| Short Sale >=3 Yrs | `57f2f4cbe4b071ea7b979791` |
| Short Sale >=4 Yrs | `57f2f4cae4b071ea7b978f3f` |
| Short Sale >=5 Yrs | `5a147e3b4cedfd0001301980` |
| Short Sale >=7 Years | `588a9651e4b0a09ecf19bab1` |
| Short Sale >=Settled | `57f2f4cae4b071ea7b979194` |
| Short Sale 36 mos. | `582c9de1e4b09776af55654e` |
| Short Sale 48 mos. | `582c9de1e4b09776af55654d` |
| Short Sale or DIL >= 24 Months | `588a76f5e4b0a09ecef8ef6f` |
| Stated Income (1) | `583f5cd6e4b0503cc16163a5` |
| Temporary Buydown | `57f2f4cae4b071ea7b977fa7` |
| Texas 50(a)(6) | `5834793ee4b09776b2721b58` |
| Unseasoned Bankruptcy | `5849cc4ce4b05fb99af8934b` |
| Unseasoned Foreclosure | `5849cc4ce4b05fb99af89349` |
| Unseasoned Short Sale | `5849cc4ce4b05fb99af8934a` |
| VA Renovation | `5b22af114cedfd0001d35846` |
| VOE Only | `5aa703ed4cedfd000121e263` |
| W2 Earnings | `57f2f4cae4b071ea7b9784a3` |
