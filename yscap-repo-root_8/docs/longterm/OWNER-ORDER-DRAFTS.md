# THE OWNER'S ORDER DRAFTS — VERBATIM (owner-directed 2026-08-30)

These are the owner's own drafts, pasted by them, with the Encompass merge tokens
(`«Field_ID»`) exactly as they wrote them. The owner's standing instruction, twice:

> *"The way you drafted your draft is terrible. You didn't follow the drafts I asked
> you to do. I asked you not to rewrite it."*
> *"The email drafts need to look exactly like I pasted, not reinvented email drafts."*
> *"Don't rewrite the entire draft. It's written very nicely. I don't want it to sound
> like AI, but just clean it up."*

So: the templates the Long-Term order desk seeds are THESE, byte-for-byte in wording.
The only permitted change is "clean it up" — bullet characters, stray spacing — never
the sentences. They live in settings as editable defaults; this file is the record of
what the defaults must say.

Token convention: `«Name_FieldID»` — the trailing number/id is the Encompass field id
(e.g. `«Subject_Property_Address_11»` = field 11, `«M_1859»` = field 1859,
`«M_venddotx162»` = VEND.X162, `«Borrower_Present_Address_FR0104»` = FR0104).

---

## 1. TITLE ORDER (prior-to-submittal order)

Subject: Title Order Request – «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15»

Hi «M_416»,

Please proceed with ordering title for the following transaction:

Transaction Details:
- Transaction Type: «M_19»
- Property Address: «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15»
- Borrower Name: «Borrower_First_And_Middle_Name_36» «Borrower_Last_Name_4002» «Co_Borrower_First_Name_4004» «Co_Borrower_Last_Name_4006»
- Borrowing Entity Name: «M_1859»
- Loan Amount: Approximately $«Loan_Amount_1109»

Mortgagee Clause:
YS Capital Group, ISAOA/ATIMA
5 New Montrose Avenue, #Bsmt
Brooklyn, NY 11211
Loan Number: «Loan_Number_364»

Please let us know if you need any additional information to complete the order.
Thank you,

---

## 2. TITLE FOLLOW-UP (prior-to-clear-to-close condition)

Hi,

Following up to confirm when we can expect the title search to be completed.

Please provide the following as soon as they become available:
- Title Commitment
- CPL
- Settlement agent E&O Insurance
- Tax Certificate
- Wiring Instructions
- Preliminary Settlement Statement
- Survey or Plat Map, or confirmation that no survey is required along with the applicable Survey Affidavit or Endorsement

Thank you.

### New York rule (same as the short-term side)

> **CORRECTED BY THE OWNER 2026-09-02 — read this before the list below.**
> *"In NY, there is no CPL. We only ask them for their Errors and Omissions
> Assurance."*
>
> The earlier wording of this section said the CPL **moved** from the title ask
> onto the settlement-agent ask. It does not move: **there is no closing
> protection letter in New York at all**, so nobody is asked for one — not title,
> not the settlement agent. db/677 had added a `cpl` slot to
> `lt_ny_settlement_docs` on the strength of the old wording; db/680 removes it.
> A slot for a document a state does not issue can never be filled, and the
> condition sits outstanding forever.

On a NEW YORK file the title ask REMOVES exactly two items:
- no CPL — and it is not asked of anybody else either; there is none
- no Preliminary Settlement Statement — this one **does** move, see below

The NEW YORK SETTLEMENT AGENT order asks the settlement agent for:
- the preliminary settlement statement
- the settlement agent's errors and omissions (E&O) insurance
- (plus their engagement letter and wire instructions, which were always theirs)

---

## 3. INSURANCE — PURCHASE (Insurance quote request)

Subject: «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15» - Insurance Quote Request

Hi «M_venddotx162»,

We are the lender on the above-referenced transaction and are requesting an insurance quote on behalf of our client. Please provide a quote for the following, and let us know if you need any additional details to proceed.

Transaction Details:
- Transaction Type: «M_19»
- Property Address: «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15»
- Property Type: «M_1553»
- Borrower Name: «Borrower_First_And_Middle_Name_36» «Borrower_Last_Name_4002» «Co_Borrower_First_Name_4004» «Co_Borrower_Last_Name_4006»
- Borrower DOB: «M_1402»
- Borrower Mailing address: «Borrower_Present_Address_FR0104». «Borrower_Present_Address_City_FR0106» «Borrower_Present_Address_State_FR0107» «Borrower_Present_Address_Zip_FR0108»
- Borrowing Entity Name: «M_1859»
- Loan Amount: Approximately $«Loan_Amount_1109»

Please note that this will be a rental (landlord) policy. The policy must include loss of rents coverage for a minimum of six (6) months in the event of a covered loss.

Mortgagee Clause:
YS Capital Group, ISAOA/ATIMA
5 New Montrose Avenue, #Bsmt
Brooklyn, NY 11211
Loan Number: «Loan_Number_364»

Please let me know if you need any additional information to complete the order.
Thank you

---

## 4. INSURANCE — REFINANCE (Verification of insurance)

Subject: «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15» - Request for Hazard Insurance Documentation

Hi «M_venddotx162»,

We are the lender on the above-referenced transaction and are requesting evidence of insurance on behalf of our client. Please provide the required documentation for the following, and let us know if you need any additional details to proceed.

Required Documents
- Evidence of hazard insurance to include lender’s Mortgage clause and Loan Number
- Insurance (Open / Paid) Invoice / Billing Statement
- Current Replacement Cost Estimator (RCE)

Transaction Details:
- Transaction Type: «M_19»
- Property Address: «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15»
- Property Type: «M_1553»
- Borrower Name: «Borrower_First_And_Middle_Name_36» «M_Borrower_Last_Name_4002» «Co_Borrower_First_Name_4004» «Co_Borrower_Last_Name_4006»
- Borrowing Entity Name: «M_1859»
- Loan Amount: Approximately $«Loan_Amount_1109»

Please note that this will be a rental (landlord) policy. The policy must include loss of rents coverage for a minimum of six (6) months in the event of a covered loss.

Mortgagee Clause:
YS Capital Group, ISAOA/ATIMA
5 New Montrose Avenue, #Bsmt
Brooklyn, NY 11211
Loan Number: «Loan_Number_364»

Please let us know if any further documentation or clarification is needed.
Thank you

---

## 5. CONDO DOCUMENTS REQUEST (condo files, to the HOA management contact)

Attaches the Fannie Mae condo questionnaire template
(`src/longterm/assets/fannie-1076-condo-questionnaire.pdf` — the owner's own copy),
with a short draft stating the borrower, the property address, the unit number, and
whether it is a purchase or refinance, and this ask:

Condo Documents Request - Please provide the following:
- Completed condo questionnaire
- Current HOA budget
- Bylaws
- Master insurance policy or insurance agent contact

---

## 6. VOR ORDER EMAIL (the owner's guidance, their words)

> *"Basically say, 'Hey, we're the mortgage lender for your tenants, and we need to
> complete a verification of rent. Here, see attached form. If it was sent by
> DocuSign, say it was also sent by DocuSign, or if not, hey, it was attached to this
> email. Please fill out and return back to us at your earliest convenience.'"*

Human language in the register of the drafts above — never AI-sounding. The FORM is
the owner's exact blank (`src/longterm/assets/blank-vor.pdf`); Part 1 + applicant
lines prefilled, Part 2 (completed by landlord) LEFT EMPTY with DocuSign slots.

---

## THE FOLLOW-UP / SEND RULES THAT RIDE WITH EVERY DRAFT

- Always a DRAFT first — a person reads it before it sends.
- Sent as the ordering USER — their name, their address where DKIM alignment allows
  (the send-as / deliverability work already researched and built).
- The mortgagee clause block is OURS (YS Capital Group ISAOA/ATIMA) exactly as above.
