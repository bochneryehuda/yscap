# Every Long-Term condition, in plain language

Generated from `src/longterm/conditions-center/library.js` — the one place the
conditions are defined — so this page and the system cannot drift apart.
Regenerate after any change to that file.

**Who sees it.** *Internal only* means staff and nobody else. *Internal + external*
means the borrower also sees it on their portal, written in their own words, and can
answer it themselves.

**What kind it is.** *Upload* wants a file. *Form* is answered inside PILOT with no
file at all. *Order* sends an email out to a company and waits for what comes back.
*Signature* goes out to be signed.

**26 conditions in total** — 15 internal only, 11 that the borrower sees too.

---

## Prior to submittal

Everything the file needs before it goes to underwriting.

14 conditions.

### Mortgages on the credit report — a statement for each

*Internal + external · Upload*

**What it is.** Read the liabilities off the credit report, mark which are mortgages and which are not, and collect a current statement for every mortgage. A mortgage that is the borrower’s own primary residence can be linked to it instead of uploaded again; anything else needs its own statement against the property it is secured by.

**What the borrower is asked.** “For every mortgage on your credit report, we need a current statement. If one of them is the home you live in, say so and we will use what we already have.”

**How it behaves.** appears on every file; the answer is saved to the shared borrower profile, so the next loan starts from it.

<sub>`lt_reo_liabilities`</sub>

### Vesting entity — formation documents and ownership

*Internal + external · Upload*

**What it is.** The entity taking title: its articles, its operating agreement or bylaws, its EIN letter and who its members are. Verified once and then verified forever — the entity lives on the borrower’s profile, so a second loan for the same entity starts already done.

**What the borrower is asked.** “The formation documents for the company taking title, its EIN letter, and who its owners are. If you have given us these before for the same company, they are already on file.”

**How it behaves.** appears only when the file calls for it; 4 named slots (Articles of formation, Operating agreement or bylaws, EIN letter, Certificate of good standing (optional)); the answer is saved to the shared borrower profile, so the next loan starts from it.

<sub>`lt_vesting_entity`</sub>

### Mortgage statement on the subject property

*Internal + external · Upload*

**What it is.** A current statement on the loan being paid off. Three ways to satisfy it: upload the statement — PILOT reads the servicer, the loan number and the outstanding principal balance off it and fills them in for somebody to check; type those three in yourself — all three, none of them optional; or say it refinances one of our own short-term loans serviced by FCI, which answers the servicer itself and still needs the FCI loan number and the outstanding balance looked up in FCI.

**What the borrower is asked.** “A recent statement for the mortgage on this property.”

**How it behaves.** appears only when the file calls for it; 1 named slot (Mortgage statement).

<sub>`lt_subject_mortgage_statement`</sub>

### File contacts

*Internal + external · Form*

**What it is.** The title company and the hazard insurance agent on every file — and, when the deal calls for them, the landlord (the borrower rents where they live), the HOA management company (a condominium) and the settlement agent (a New York file); each of those three is greyed with the reason on a file that does not need it. The attorneys and the realtor live in the File contacts section rather than being asked for here. Picked from the shared vendor directory rather than typed, so the same company is the same record on every file.

**What the borrower is asked.** “Your title company and your insurance agent — and your landlord, your condo’s management company or your settlement agent where they apply.”

**How it behaves.** appears on every file.

<sub>`lt_file_contacts`</sub>

### Title ordered

*Internal only · Order*

**What it is.** The title order goes out to the title company on the file, from the officer’s own address, so their reply lands on the file.

**How it behaves.** appears on every file; sends the title order.

<sub>`lt_order_title`</sub>

### Insurance ordered

*Internal only · Order*

**What it is.** A quote on a purchase, or verification of the policy in force on a refinance — two different letters for two different questions.

**How it behaves.** appears on every file; sends the insurance order.

<sub>`lt_order_insurance`</sub>

### Flood insurance ordered

*Internal only · Order*

**What it is.** Only where the property is in a flood zone. Until the determination has been read, this condition does not attach — an unread file has not been determined to be outside a flood zone, it has not been determined at all.

**How it behaves.** appears only when the file calls for it; sends the flood_insurance order.

<sub>`lt_order_flood_insurance`</sub>

### New York settlement agent ordered

*Internal only · Order*

**What it is.** New York closes through a settlement agent rather than the title company, so the order goes to them.

**How it behaves.** appears only when the file calls for it; sends the ny_settlement_agent order.

<sub>`lt_order_ny_settlement_agent`</sub>

### Card on file for the appraisal

*Internal + external · Form*

**What it is.** The card the appraisal is charged to. It is held on the borrower’s shared profile, so a card given on one loan is already here on the next — and a card added here goes back to the profile the same way.

**What the borrower is asked.** “The appraisal is paid for up front. If you have given us a card before, it is already on file.”

**How it behaves.** appears on every file; the answer is saved to the shared borrower profile, so the next loan starts from it.

<sub>`lt_appraisal_card`</sub>

### Verification of rent sent

*Internal only · Signature*

**What it is.** The form is filled in from what we already know — the property, the borrower, the rent, our own details — and every part the landlord has to answer is left blank and required. It can go by DocuSign, as an email attachment, or both; a form that comes back filled in by hand voids the envelope so there is never a second, half-signed copy in flight.

**How it behaves.** appears only when the file calls for it; sends the vor order.

<sub>`lt_vor_sent`</sub>

### Government photo ID

*Internal + external · Upload*

**What it is.** Held on the borrower’s shared profile, so an ID given on any previous loan is already here.

**What the borrower is asked.** “A driver’s licence or passport. If you have given us one before, it is already on file.”

**How it behaves.** appears on every file; 1 named slot (Photo ID); the answer is saved to the shared borrower profile, so the next loan starts from it.

<sub>`lt_photo_id`</sub>

### Payoff ordered

*Internal only · Order*

**What it is.** Requested from the servicer of the loan being paid off.

**How it behaves.** appears only when the file calls for it; sends the payoff order.

<sub>`lt_payoff_ordered`</sub>

### Condo questionnaire ordered

*Internal only · Order*

**What it is.** Sent to the management company on the file.

**How it behaves.** appears only when the file calls for it; sends the condo_questionnaire order.

<sub>`lt_condo_questionnaire_ordered`</sub>

### Purchase contract

*Internal + external · Upload*

**What it is.** The fully executed contract, with every rider and amendment.

**What the borrower is asked.** “The fully signed contract, including anything attached to it.”

**How it behaves.** appears only when the file calls for it; 1 named slot (Executed contract).

<sub>`lt_purchase_contract`</sub>

---

## Prior to clear to close

What has to be true before the file can be cleared to close.

12 conditions.

### Cash-out letter

*Internal + external · Upload*

**What it is.** What the money is for, in the borrower’s own words and signed by them.

**What the borrower is asked.** “A short signed note saying what you plan to do with the money you are taking out.”

**How it behaves.** appears only when the file calls for it; 1 named slot (Cash-out letter).

<sub>`lt_cash_out_letter`</sub>

### Title documents

*Internal only · Upload*

**What it is.** The title package. New York asks for less of it — there is no closing protection letter, no preliminary settlement statement and no wiring instructions there, because the settlement agent handles all three — so a New York file is not left holding slots nobody can ever fill.

**How it behaves.** appears on every file; 5 named slots (Title commitment, Closing protection letter, Preliminary settlement statement, Wire instructions, Title invoice).

<sub>`lt_title_docs`</sub>

### Settlement agent documents

*Internal only · Upload*

**What it is.** New York only — what the settlement agent provides in place of the title company’s own closing package.

**How it behaves.** appears only when the file calls for it; 5 named slots (Engagement letter, Wire instructions, Closing protection letter, Settlement agent E&O insurance, Settlement statement).

<sub>`lt_ny_settlement_docs`</sub>

### Insurance documents

*Internal only · Upload*

**What it is.** The binder or the declarations page, and the invoice or evidence that it is paid. Two slots because they are two different things: one says the cover exists, the other says it is paid for.

**How it behaves.** appears on every file; 2 named slots (Binder or declarations page, Invoice or evidence of payment).

<sub>`lt_insurance_docs`</sub>

### Flood insurance documents

*Internal only · Upload*

**What it is.** Only where the property is in a flood zone.

**How it behaves.** appears only when the file calls for it; 2 named slots (Flood binder or declarations page, Invoice or evidence of payment).

<sub>`lt_flood_insurance_docs`</sub>

### Housing history verified

*Internal only · Upload*

**What it is.** One of three, decided by what the borrower said about where they live (FR0115): the rent verification back from the landlord if they rent, a verification of mortgage on the home they live in if they own it, or a letter if they live somewhere rent free. They are alternatives, not a list — asking for all three would be asking for two things that cannot exist. The rent one fills itself in from the verification of rent order; any of the three can also be uploaded here.

**How it behaves.** appears on every file; 3 named slots (Verification of rent (completed), Verification of mortgage — primary residence, Living rent free letter).

<sub>`lt_housing_history`</sub>

### Verification of mortgage — the subject property

*Internal only · Upload*

**What it is.** On a refinance: the payment history on the loan being paid off.

**How it behaves.** appears only when the file calls for it; 1 named slot (Verification of mortgage).

<sub>`lt_vom_subject`</sub>

### Lease agreement

*Internal + external · Upload*

**What it is.** On a refinance of a property that is already rented: the lease the rent is coming from.

**What the borrower is asked.** “The signed lease for the property you are refinancing.”

**How it behaves.** appears only when the file calls for it; 1 named slot (Lease agreement).

<sub>`lt_lease_agreement`</sub>

### Cash to close

*Internal + external · Upload*

**What it is.** On a purchase: proof the borrower holds what they have to bring to the table.

**What the borrower is asked.** “Statements showing the funds you are bringing to closing.”

**How it behaves.** appears only when the file calls for it; 1 named slot (Bank statements).

<sub>`lt_cash_to_close`</sub>

### Earnest money deposit

*Internal + external · Upload*

**What it is.** On a purchase: evidence the deposit was actually paid — the cleared cheque or the wire, not the contract that says it was due.

**What the borrower is asked.** “The cleared cheque or the wire confirmation for your deposit.”

**How it behaves.** appears only when the file calls for it; 1 named slot (Evidence of the deposit).

<sub>`lt_emd`</sub>

### Payoff received

*Internal only · Upload*

**What it is.** The statement back from the servicer, still good on the closing date. It files itself in from the payoff order, and can also be uploaded here.

**How it behaves.** appears only when the file calls for it; 1 named slot (Payoff statement).

<sub>`lt_payoff_received`</sub>

### Condo documents

*Internal only · Upload*

**What it is.** The completed questionnaire, the association’s current budget, the bylaws, and its master insurance.

**How it behaves.** appears only when the file calls for it; 4 named slots (Condo questionnaire (completed), Association budget, Bylaws, Master insurance policy).

<sub>`lt_condo_docs`</sub>
