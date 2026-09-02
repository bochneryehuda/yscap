# The owner's blank VOR (`src/longterm/assets/blank-vor.pdf`) — the coordinate map

Standard **Request for Verification of Rent** (form mark `GVOR_S 11/15`), ONE page,
**612 × 792 pt, FLAT** (no AcroForm fields) — so prefill is a TEXT OVERLAY on the
owner's exact page (pdf-lib), never a redrawn document. PDF text coordinates below
are BOTTOM-UP (pdf-lib native); a DocuSign tab's y is `792 − y_pdf` (top-down).
Companion reference: `src/longterm/assets/vor-field-ids-reference.pdf` (the same form
with Encompass field ids printed in the blanks — per the owner, a REFERENCE for where
data comes from, NOT a template to follow for what gets prefilled).

## WE PREFILL (everything up to "To Be Completed By Landlord") — owner's words:
- **1. To (landlord name/address)** — label at y=615 x=60; write in the band
  y≈560–608, x≈60–300. From the landlord-contact condition (management company
  name + address).
- **2. From (lender)** — label y=615 x=320; band y≈560–608, x≈320–560:
  `YS Capital Group` / `5 New Montrose Avenue, #Bsmt` / `Brooklyn, NY 11211`.
- **3. Signature of Lender** (y=530 x=60 label; drawn at y=516.5 x=60 in the Great Vibes signature script, 12pt shrinking to 9pt to fit 115pt — the sender’s name as a signature, not typed).
- **4. Title** (x=190), **5. Date** (x=353), **6. Lender's No. (Optional)** (x=467)
  → the LT loan number.
- **7. Information to be verified**: **Property Address** (label y=490 x=49; value
  band y≈455–487, x=49–305) = the borrower's PRIMARY (rented) address —
  NOT the subject property. **Account in the name of** (label y=490 x=310; band
  x=310–560) = the borrower name(s).
- **8. Name and Address of Applicant(s)** (label y=404 x=60; band y≈360–400,
  x=49–335) = borrower names + their primary address.
- **9. Signature of Applicant(s)** (label y=404 x=353; X-lines at y=383 and y=356,
  x≈353) → the words **"See attached signature"** (owner-directed).

## LEFT EMPTY — DocuSign tabs for the LANDLORD (Part II, y≤334; Part III):
- **10. Tenant rented from ___** (blank after x≈120, line y=292) — DATE tab,
  required; **to ___** (blank after x≈222) — DATE tab, required.
- **Is account satisfactory?** Yes (x=444) / No (x=493), y=292 — RADIO group
  (either/or), required.
- **Amount of rent $** (after x=125, y=281) — TEXT tab, required.
- **Is rent in arrears?** Yes (x≈155) / No (x≈200), y=269 — RADIO group; **Amount $**
  (after x=125, y=258) + **Period** (after x≈240, y=258) — TEXT tabs, optional.
- **No. of late payments past due 30 in the last 12 months** (value ≈ x=160, y=235)
  — TEXT tab, optional.
- **11. Additional information** (band y≈185–218) — TEXT tab, optional, full width.
- **Part III**: **12. Signature of Landlord** (y=139 x=49; sign band y≈118–136) —
  SIGN-HERE tab; **13. Title** (x=277) — TEXT, required; **14. Date** (x=482) —
  DATE-SIGNED tab (auto-fills from the signature, owner-directed); **15. printed
  name** (y=112 x=49) — TEXT; **16. Phone No.** (y=112 x=277) — TEXT, required.

## THE RULES THAT RIDE WITH IT (owner-stated)
- Part II / Part III are NEVER prefilled by us — even where the field-id reference
  sheet shows an Encompass id in those blanks. *"You leave empty even if it's
  pre-filled on the field ID call."*
- The preview is EDITABLE before sending (add/remove overlay text), and what was
  edited is what goes out — manual attach and DocuSign alike.
- Send modes: DocuSign / manual email (prefilled PDF attached) / BOTH; when both,
  the email says it was also delivered by DocuSign.
- A manual return ACCEPTED by the processor VOIDS the outstanding envelope.
