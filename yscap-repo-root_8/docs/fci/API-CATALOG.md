# FCI API — the complete published surface

**GENERATED FILE — do not edit by hand.** `node scripts/fci-api-catalog.js` rebuilds it
from `docs/fci/collection-snapshot.json`, a pinned copy of FCI's own public Postman
collection (<https://integrate.myfci.com/>). `npm test` re-runs the generator and fails if
this file has drifted from it, so a hand edit cannot survive. To take up a new FCI release:
`node scripts/fci-api-catalog.js --fetch` and commit both files.

What this file is FOR: knowing, without guessing, which call answers a question, what it
returns, what it can be filtered by, and how fresh the answer is. The design that uses it —
the workflow, the ownership rules, the reminders — is `docs/FCI-SERVICING-INTEGRATION-RESEARCH.md`.

## In numbers

| | |
|---|---|
| Operations documented | 70 |
| Distinct GraphQL root fields | 59 |
| Saved examples (query + response) | 72 |
| Folder-level data dictionaries | 18 |
| Requests against `fapi.myfci.com` | 68 |
| Requests against `tapi.myfci.com` | 1 |

## FCI's own overview page

```
API’s Status: ONLINE

- Pull API - Daily Distribution Reports : System is operating normally.

- Pull API - FCI Web Loan Information : System is operating normally.

- Push API - Update Charges : System is operating normally.

- Push API - Boarding Loans : System is operating normally.

The latest version is: v6.0

To check the latest updates on the API please go to the New Releases

Overview

This is a connection directly to FCI’s proprietary loan servicing system using the same engine that powers FCI’s industry leading Live Customer Login. PULL Capability grabs any field in FCI’s system and connects it to any 3rd party software. PUSH Capability in the API is currently available for Loan Boarding and other departments will be added shortly. You can receive your API Key by logging into the Lender Portal under the website Customer Login.

Authentication

To get access to this API you must have a token provided by FCI IT Department to be able to Receive or Send any data between your application and our API. This Token is the authorization method to be used for every request.

After your key is provided, you will need to add the token to the header on your API Request, see example below.

Authorization: Bearer

Also the security protocol needs to be set to TLS 1.2

Available Fields

The request can use 1 or multiple data fields. The available fields are incLuded on each request example.

Error Codes

What errors and status codes can a user expect?
There might be cases when your API doesn't work, or exhibits unexpected behavior. If you're not getting any response you will received any of the following errors:

- "You are not authorized to run this query": The token is incorrect or invalid.

- "Empty Return values": There is no information about that loan or the loan number is incorrect.

Rate limit

The rate limit will be set depending on the user of the API.
```

## Operation index

| Folder | Request | Root field | Host |
|---|---|---|---|
| Pull API - Daily Distribution Reports / Portfolio Reports | Loan Portfolio Information | `getLoanInformation` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Loan Payoff Value to date | `getLoanInformation` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Broker Disbursment Report | `getBrokerDisbursment` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Funding History Report | `getFundingHistory` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Interest Accrual Report | `getInterestAccrual` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Loan Activities Report | `getLoanActivities` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Loan Charges Report | `getLoanChargesList` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Lender Payment Statement History | `getLenderPaymentStatementHistory` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Other Payments Report | `getOtherPayments` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Portfolio Reports | Loan PayString Report | `getLoanPayString` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Reports by Loan Account | Loan Information by Loan Account | `getLoanInformation` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Reports by Loan Account | Interest Accrual Report by Loan Account | `getInterestAccrual` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Reports by Loan Account | Loan Activities Report by Loan Account | `getLoanActivities` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Reports by Loan Account | Loan Charges Report by Loan Account | `getLoanChargesList` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Reports by Loan Account | Lender Payment Statement History by Loan Account | `getLenderPaymentStatementHistory` | `fapi.myfci.com` |
| Pull API - Daily Distribution Reports / Reports by Loan Account | Other Payments Report by Loan Account | `getOtherPayments` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Portfolio | `getLoanPortfolio` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Portfolio - Broker | `getBrokerLoanPortfolio` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Assigned Lender Accounts - Broker | `getAssignedAccounts` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Updated Loan Portfolio List | `getUpdatedLoanList` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Details | `getLoanDetails` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Properties | `getLoanProperties` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Attachments | `getLoanAttachments` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Funding Information | `getFundingInformation` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Borrower Payments | `getBorrowerPayment` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Payment to Lenders | `getPaymentListToLender` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Notes | `getNotes` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Lender Statements | `getLenderStatement` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Charges | `getLoanCharges` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Charges Details | `getLoanChargesDetails` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Charges History | `getLoanChargesHistory` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Paid Charges & Other Charges | `getPaidChargesAndOtherPayments` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Delinquency | `getLoanDeliquency` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Mod Report | `getLoanModReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Portfolio Statistics | `getLoanPortfolioStatistics` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Status Breakdown | `getLoanStatusBreakdown` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | ACH Status | `getACHStatus` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Foreclosure Timelines | `getForeclosure` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan PreForeclosure Report | `getPreForeclosure` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Default Interest Report | `getLenderDefaultInterestReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Lender Disbursement | `getPaymentListToLender` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Investor Earnings | `getInvestorEarnings` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Lender Trust Ledger | `getLenderTrustLedger` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loan Cash Flow | `getLoanCashFlow` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Pay String Report | `getPayString` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Current Paystring Report | `getCurrentPaystring` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Scheduled Vs Actual Payment Report | `getSVAPaymentReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Scheduled Vs Actual Payment by Loan Report | `getSVALoanPaymentReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Payoff Value to Date | `getPayoffValuetoDate` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Payoff Demand Status | `getPayOffDemandStatus` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Pending Payoff Demands | `getPendingPayoffDemands` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Trust Balance | `getTrustBalance` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Lien Release Report | `getLienReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Loss Mit Report | `getLossMitReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Bankruptcy Report | `getBankruptcyReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | FCI Invoice List | `getInvoiceList` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | FCI Invoice Details | `getInvoiceDetail` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Tax Voucher Detail | `getVoucherTaxesDetailPublic` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Insurance Voucher Detail | `getVoucherInsurancesDetailPublic` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | ARM Report | `getArmReport` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | One Time Payment Link | `getOTPLink` | `fapi.myfci.com` |
| Pull API - FCI Web Loan Information | Payoff Request Tracker *Beta Testing | `getPayoffRequests` | `tapi.myfci.com` |
| Pull API - FCI Web Loan Information | getVersion | `getApiVersion` | `fapi.myfci.com` |
| Push API -  Update Charges | Update Charges | `insertLoanCharge` | `fapi.myfci.com` |
| Push API -  Draw Request / Insert Draw Structure | New Request | _(REST)_ | `` |
| Push API -  Draw Request | Draw Request | `insertDrawLoan` | `fapi.myfci.com` |
| Push API -  Draw Request | Draw Request RestAPI | _(REST)_ | `fapi.myfci.com/api/v1/boarding/drawLoan` |
| Push API -  Payoff Request | Payoff Request | `insertPayoff` | `fapi.myfci.com` |
| Push API - Boarding Loans | Boarding a Loan | `insertBoarding` | `fapi.myfci.com` |
| Push API - Boarding Loans | Boarding Multiple Loans | _(REST)_ | `fapi.myfci.com` |

## Folder documentation (FCI's data dictionaries and enum legends)

### Pull API - Daily Distribution Reports

```
This API allows our lenders to obtain data from every loan in their Portfolio, including each field of the payoff demand report of each loan at the time of the request.

This Daily Distribution Reports API's are only updated once a day at midnight.

Available Fields

The request can use 1 or multiple data fields. The available fields are inlcuded on each request example.

Data Dictionary

To download the data dictionary for all the request inside the DDR click here.

Filter available on each method

loanaccount: String = null
limit: Int = 0
offset: Int = 0
orderby: String = "LoanAccount"
order: String = "asc"

Filter available per method

If you received the following code as a response "code": “HC0007” This happens because the query is trying to pull a huge amount of data,  and this means you need to use any of the filters available:

Method:  getBrokerDisbursment
Filters:
  - loanaccount (string)
  - dateFrom  (string MM/dd/YYYY)
  - dateTo (string MM/dd/YYYY)
 
Method:  getLenderPaymentStatementHistory
Filters:
  - loanaccount (string)
  - lenderaccount (string)
  - dateFrom (string MM/dd/YYYY)
  - dateTo (string MM/dd/YYYY)
 
Method: getLoanChargesList
Filters    
  - loanaccount (string)
  - dateFrom (string MM/dd/YYYY)
  - dateTo  (string MM/dd/YYYY)

Method: getOtherPayments
Filters    
  - loanaccount (string)
  - dateFrom (string MM/dd/YYYY)
  - dateTo (string MM/dd/YYYY)
 
Method: getFundingHistory
Filters    
  - loanaccount (string)
  - dateFrom (string MM/dd/YYYY)
  - dateTo   (string MM/dd/YYYY)

Method: getLoanActivities
Filters    
  - loanaccount (string)
  - dayvariance (int)
  - dateFrom  (string MM/dd/YYYY)
  - dateTo    (string MM/dd/YYYY)

Method: getInterestAccrual
Filters    
  - loanaccount (string)
  - dateTo    (string MM/dd/YYYY)

Method: getLoanInformation
Filters  
 - loanaccount
 - includeNoProperty (true/false)
 - dateFrom
 - dateTo

Data Legent:

AmortizationType

0 = Other

1 = Fully Amortized

2 = Partially Amortized

3 = Inteest Only

4 = Constant Amortization

5 = Interest Only PYMI

6 = Year Amortized 15

7 = Year Amortized 10
```

### Pull API - FCI Web Loan Information

```
This API allows our lenders to obtain live data from every screen in our Lender Portal.

To use this collection of API's requests you need to generate a new key for FCI Web - Loan Information (PULL)

Data Dictionary

To download the data dictionary for all the FCI API requests click here.
```

### Push API -  Update Charges

```
Push FCI API- Update Charges is a GraphQL API with methods created to send new charges to FCI with updated information for any loan and to make the process easier for all our lenders.

Bulk Upload of Charges

Login to FCI Web portal using your credentials

URL: https://fciweb.myfci.com/login

After you login to the website, navigate to ‘API registration Key’ section and create a API token for uploading the Charges. See screenshot below for additional information.

You can upload the charges to FCI using our API. You can use your own application and connect to our API and upload the charges.

You can use the below variables to upload the charges using our API

- loanNumber : Your FCI loan account number

- investorAccountNumber : FCI Investor/Broker account number

- chargeDate: Date on which charge was added
  chargeAmount: Charge Amount

- paidBy: Who is paying the charges (Select the option from the drop down)

- invoiceNumber : Invoice Number

- comments : Any comments/descriptions related to charges

- doc1, doc2, doc3 : URL of the documents related to charges (You can use your document repository and provide the url to access the documents related to charges)

“Success “message will be displayed after a successful upload of charges

The data will be processed by FCI servicing department and will notify you through email once the upload process is completed. Once the charges are processed by FCI, they will be displayed under ‘Borrower Charges’ section on the FCI Website
```

### Push API -  Update Charges / Update Charges Structure

```
insertLoanCharge(
  charges:[
    {
      loanNumber:"String",
      investorAccountNumber:"String",
      chargeDate:"DateTime",
      chargeAmount:Decimal,
      paidBy:"String",
      invoiceNumber:"String",
      comments:"String",
      doc1:"URL",
      doc2:"URL",
      doc3:"URL"
    }
  ])
```

### Push API -  Update Charges / Charges Fields

```
Below are the variables used to upload charges.

- loanNumber : Your FCI loan account number

- investorAccountNumber : FCI Investor/Broker account number

- chargeDate: Date on which charge was added
  chargeAmount: Charge Amount

- paidBy: Who is paying the charges (Select the option from the drop down)

- invoiceNumber : Invoice Number

- comments : Any comments/descriptions related to charges

- doc1, doc2, doc3 : URL of the documents related to charges (You can use your document repository and provide the url to access the documents related to charges)
```

### Push API -  Draw Request

```
Push FCI API- Update Charges is a GraphQL API with methods created to send DRAW requests (Dutch and Non Dutch) to FCI with updated information for any loan and to make the process easier for all our lenders.

DRAW requests (Dutch and Non Dutch)

Login to FCI Web portal using your credentials

URL: https://fciweb.myfci.com/login

After you login to the website, navigate to ‘API registration Key’ section and create a API token for uploading the Draws of a loan. See screenshot below for additional information.

You can use your own application and connect to our API and be able to notify us of DRAW requests (Dutch and Non Dutch) via the API.

Below are the variables used to send Draw Requests.

- loanNumber : Your FCI loan account number

- investorAccountNumber : FCI Investor/Broker account number

- dateReceived: Date on which the draw was recorded in the loan.

- amount: Draw Amount

- comments : Any comments/descriptions related to charges

The data will be processed by FCI servicing department and will notify you through email once the upload process is completed. Once the draws are processed by FCI, you will received an email with the confirmation.
```

### Push API -  Draw Request / Insert Draw Structure

```
mutation {
 insertDrawLoan(
  drawloan:
    {
      loanNumber:"String",
      investorAccountNumber:"String",
      dateReceived:"DateTime",
      amount:Decimal,
      comments:"String"
    }
  )
}
```

### Push API -  Draw Request / Draw Fields

```
Below are the variables used to request a Draw for a Loan.

- loanNumber : Your FCI loan account number

- investorAccountNumber : FCI Investor/Broker account number

- dateReceived : Date on which the draw was recorded in the loan.

- amount: Draw Amount

- comments : Any comments/descriptions related to the draw request
```

### Push API -  Payoff Request

```
Push FCI API- Payoff Request is a GraphQL API with methods created to send PAYOFF requests to FCI with updated information for any loan and to make the process easier for all our lenders.

PAYOFF requests

Login to FCI Web portal using your credentials

URL: https://fciweb.myfci.com/login

After you login to the website, navigate to ‘API registration Key’ section and create a API token for uploading the PAYOFF of a loan. See screenshot below for additional information.

You can use your own application and connect to our API and be able to notify us of PAYOFF requests via the API.

Below are the variables used to send Draw Requests.

- loanNumber: Your FCI loan account number

- payoffDate: Date of Payoff

- reason: 0 = Payoff, 1 = Litigation, 2 = Inquiry, 3 = Other

- reqCompany: Requestor Company Information

- reqContact: Requestor Contact Information

- reqEmail: Requestor Email Information

- reqMailing: Requestor Mailing information

- reqPhone: Requestor Phone Number

- description: Any comments/descriptions related to charges

- dateReceived: Date on which the draw was recorded in the loan.

- requestedBy: Requestor Name

The data will be processed by FCI servicing department and will notify you through email once the upload process is completed. Once the PAYOFF is processed by FCI, you will received an email with the confirmation.
```

### Push API -  Payoff Request / Insert Payoff Structure

```
insertPayoff(
  payoff:
    {
        loanNumber: String!
        payoffDate: CustomDateFormat!
        reason: Int
        reqCompany: String
        reqContact: String
        reqEmail: String
        reqMailing: String
        reqPhone: String
        description: String
        dateReceived: CustomDateFormat!
        requestedBy: String!
    }
  )
```

### Push API -  Payoff Request / Payoff Fields

```
Below are the variables used to upload charges.

- loanNumber: Your FCI loan account number

- payoffDate: Date of Payoff

- reason: 0 = Payoff, 1 = Litigation, 2 = Inquiry, 3 = Other

- reqCompany: Requestor Company Information

- reqContact: Requestor Contact Information

- reqEmail: Requestor Email Information

- reqMailing: Requestor Mailing information

- reqPhone: Requestor Phone Number

- description: Any comments/descriptions related to charges

- dateReceived: Date on which the draw was recorded in the loan.

- requestedBy: Requestor Name
```

### Push API - Boarding Loans

```
The Boarding API is a GraphQL API with methods created to send data to FCI Boarding Department to make the boarding process easier for all our lenders.

How It Works:
https://youtu.be/yP8RAJOdV5Q

Upload required boarding documents on the Lender Portal

Sandbox API URL: https://tapi.myfci.com/graphql

Production API URL: https://fapi.myfci.com/graphql
```

### Push API - Boarding Loans / Loan Boarding Structure

```
mutation{
   insertBoarding
   (
       insertLoan:
       {
            prevAccount:"TESTLOAN01",
            lienPosition:1
            lenderAccount:"test1234",
            originationDate: "08/25/2020",
            fundingDate:"08/25/2020",
            firstPaymentDate:"08/25/2020",
            paidToDate:"08/25/2020"
            nextDueDate:"08/25/2020"
            originalBalance:12
            principalBalance:12.3
            lateChargesDays:1
            payment:5.0
            paymentImpound:12
            paymentFrequency:1
            maturityDate:"08/25/2020"
            noteRate:12.3
            primaryPurpose:1
            defaultRate: 12.32
            loanType: 1
            rateType: 1
            noteType: 1
            paymentPropertyTax: 12.30
            paymentSchoolTax: 12.32
            paymentCityTax: 15.00
            paymentWaterSewerTax: 15.00
            paymentTownshipTax: 10.00
            paymentOtherTax: 5.00
            withheldHazardInsurance: 0
            withheldPropertyTax: 0
            withheldWindInsurance: 0
            withheldFloodInsurance: 0
            reservePropertyTax: 5
            reserveSchoolTax: 5
            reserveCityTax: 0
            reserveWaterSewerTax: 0
            reserveTownshipTax: 0
            startingBalance: 0
            amortizationType: 1
            is365DayYears: true
            is30DayMonths: true
            negativeToPrincipal: true
            accruedMethod: 0
            lateChargesMin: 130
            lateChargeMax: 150
            lateChargesPct: 5
            noPyramiding: true
            lateChargesPostMaturity: false
            lateChargesDaily: 3
            lateChargesLenderPct: 40
            lateChargesVendorPct: 35
            lateChargesCompanyMaxDist: 50
            defaultIntIsEnabled: false
            defaultIntEnableMaturity: false
            defaultIntTypeCalculation: 0
            defaultIntUseCustomDate: false
            defaultIntDays:0
            defaultIntOptionDays:0
            defaultIntDateFrom: 1
            defaultCustomDateFrom: 2
            defaultIntEffectiveDays: 1
            defaultIntEffectiveOptionDays: 1
            defaultIntEffectiveDateFrom: 1
            defaultIntModifier: 1
            defaultIntRate: 1
            defaultIntLastEffectiveStatus: true
            defaultIntLastImplementationDate: "6/1/21"
            defaultIntLastEffectiveDate: "6/1/21"
            defaultIntLastTopDate: "6/1/21"
            defaultIntAllowLateCharges: false
            defaultIntActiveDaily: false
            defaultIntLenderPct: 10
            defaultIntVendorPct: 10
            defaultIntCompanyMaxDist: 100
            originalVendor: "VENDORaccount"
            spreadRate:1.0
            trustAccount: "FCI - Pool 1 Trust Account"
            approvalPayoff:BROKER
            approvalChangeFeesTerms: LENDER
            approvaleReinstatement:EITHER
            approvalStartForeclosure:BOTH
            setBorrower:[
                {
                firstName:"TEST"
                middleName:"TESTTEST"
                lastName:"TEST"
                street:"street"
                city:"sd"
                state:"sd"
                zipCode:"012"
                homePhone:"011-123"
                workPhone:"011-123"
                mobilePhone:"011-123"
                fax:"011-123"
                tin:"123456789"
                tinType: 1
                email:"testemail@gmail.com"
                contactName:"ContactName"
                isCompany:true
                company:"Company"
                isPrimary:true
                }
            ]
            setLenders:[
              {
                account:"test1234"
                firstName:"Lender Name"
                middleName:"Lender Middle Name"
                lastName:"Lender LastName"
                street:"Lender street"
                city:"COSTA"
                state:"CA"
                zipCode:"012"
                homePhone:"011-123"
                workPhone:"011-123"
                mobilePhone:"011-123"
                fax:"011-123"
                tin:"123456789"
                email:"email@gmail.com"
              }
            ]
            setProperties:
            [
                {
                description:"Description"
                street:"Street"
                city:"City"
                state:"sa"
                zipCode:"011"
                county:"SLASD"
                occupancyStatus:1
                type:0
                isPrimary:true
                }
            ]
            setFundings:[
              {
                agreementeTemplateEnumValue: BASIC_LIMITED
                lenderAccount: "test1234"
                funds: 126.00
                brokerFeePct: 0.00
                brokerFeeFlat: 11.00
                brokerFeeMin: 10.00
                vendorFeePct: 0.00
                vendorFeeFlat: 0.00
                vendorFeeMin: 0.00
                roundError: true
                rateType: 1
                rateValue: 12.00
                gSTaxUse: true
                brokerFeeFlatNPerf: 95.00
                brokerFeeMinNPerf: 95.00
                brokerResFee: 0.00
                brokerResAddFee: 0.00
                brokerResAddDays: 0
                brokerResAddFee_2: 0.00
                brokerResAddDays_2: 0
                brokerResAddFee_3: 0.00
                brokerResAddDays_3: 60
                trustAccount: "FCI - Pool 1 Trust Account"
              }
            ]
        }
    )
}
```

### Push API - Boarding Loans / Loan Variables

```
LienPosition

1st = 1,
2nd = 2,
3rd = 3,
4th = 4,
5th = 5,
6th = 6,
7th = 7,
8th = 8,
9th = 9,
10th = 10,
UNS = 11,
LEASE = 12

AmortizationType

    OTHER = 0,
    FULLY_AMORTIZED = 1,
    PARTIALLY_AMORTIZED = 2,
    INTEREST_ONLY = 3,
    CONSTANT_AMORTIZATION = 4,
    INTEREST_ONLY_PYMT = 5,
    YEAR_AMORTIZED_15 = 6,
    YEAR_AMORTIZED_30 = 7

RateType

    OTHER = 0,
    FIXED_RATE = 1,
    ARM = 2,
    GRADUATED_TERMS = 3

PaymentFrequency

    BIWEEKLY = 0,
    MONTHLY = 1,
    QUATERLY = 2,
    SEMI_YEARLY = 3,
    YEARLY = 4,
    TWICE_MONTHLY = 5,
    STRAIGHT = 6

PrimaryPurpose

    CONSUMER = 0,
    BUSINESS = 1

noteType

    OTHER = 0,
    CONVENTIONAL = 1,
    CONSTRUCTION = 2,
    LINE_OF_CREDIT = 3,
    AUTO = 4,
    BUSINESS_PURPOSE_LOAN = 5,
    CASH_ADVANCE = 6,
    FANNIE_MAE = 7,
    FHA = 8,
    FREDDIE_MAC = 9,
    HECM = 10,
    HUD = 11,
    LEASE = 12,
    PERSONAL = 13,
    PURCHASE_CONTRACT = 14,
    UNSECURED = 16,
    VA = 17,
    SECURITIZED_LOAN = 18,
    DRAW_LOAN_NON_DUTCH = 19,
    DRAW_LOAN_DUTCH = 20,
    LOC_OPEN = 21,
    LOC_CLOSED = 22,
    DSCR = 23

accruedMethod

DUE_TO_DUE_FIXED = 0 → Regular Period (Due Date to Due Date)
DUE_TO_DUE_ACTUAL = 1 → Actual Days (Due Date to Due Date)
RECEIVED_TO_RECEIVED = 2 → Actual Days (Received Date to Received Date)

approvalPayoff

    Broker = BROKER,
    Lender = LENDER,
    Either = EITHER,
    Both = BOTH

approvalChangeFeesTerms

    Broker = BROKER,
    Lender = LENDER,
    Either = EITHER,
    Both = BOTH

approvaleReinstatement

    Broker = BROKER,
    Lender = LENDER,
    Either = EITHER,
    Both = BOTH

approvalStartForeclosure

    Broker = BROKER,
    Lender = LENDER,
    Either = EITHER,
    Both = BOTH

tinType

   0 = EIN
   1 = SNN
   2 = ITIN
   3 = ATIN
   4 = PTIN
   5 = OTHER
```

### Push API - Boarding Loans / Property Variables

```
Type

   SINGLE_FAMILY_RES = 0,
   TWO_FAMILY_RES = 1,
   FOUR_FAMILY_RES = 2,
   TWO_TO_FOUR_FAMILY = 3,
   OFFICE_CONDO = 4,
   RESIDENTIAL_CONDO = 5,
   RESIDENTIAL_INCOME_1_4 = 6,
   RESIDENTIAL_INCOME_5 = 7,
   APARTMENT_COMPLEX_5_PLUS = 8,
   PUD = 9,
   FARM = 10,
   RANCH = 11,
   RESORT = 12,
   MIX_USE = 13,
   INDUSTRIAL = 14,
   COMERCIAL = 15,
   RAW_LAND = 16,
   MOBILE_HOME = 17,
   UNSECURED = 18,
   AUTOMOBILE = 19,
   AIRCRAFT = 20,
   OTHER = 21,
   COOP = 22,
   TOWNHOUSE = 23,
   FIVE_FAMILY_RES = 24,
   HOUSE_BOAT = 25
OccupancyStatus

   PRIMARY_BORROWER = 0,
   SECONDARY_BORROWER = 1,
   VACANT = 2,
   TENANT = 3,
   INVESTOR = 4,
   OTHER = 5,
   UNKNOWN = 6
```

### Push API - Boarding Loans / Borrower Variables

```
deliveryOptions

0 = PRINT,
1 = EMAIL,
2 = PRINT_AND_EMAIL,
3 = NEVER
```

### Push API - Boarding Loans / Funding Variables

```
AgreementeTemplate

Basic Limited = BASIC_LIMITED,
High Touch Limited = HIGH_TOUCH_LIMITED,
High Touch Full = HIGH_TOUCH_FULL,
Basic Full Collection = BASIC_FULL_COLLECTION
```

### New Releases

```
Version 8.0

Released August 11, 2026 | Available until TBD

- New endPoint for Pending Payoff Demands

- New endPoint for Loan Mod Report

Version 6.0

Released August 17, 2022 | Available until TBD

FCI Lender Services has just launched their Financial APIs on Microsoft Azure cloud.

- Current Users: To change your current connection to the new service offered in Azure update your API Url from https://api.myfci.com:PORT/graphql to https://fapi.myfci.com/graphql

PORTS: are not required anymore if you are using the FCI APIs hosted in Azure

- New Users: use API Url https://fapi.myfci.com/graphql

Version 5.1

Released September 17, 2021 | Available until TBD

Added new filter (includeInactive) to the POST / getLoanPortfolio
```

## Every operation in full

### Pull API - Daily Distribution Reports / Portfolio Reports / Loan Portfolio Information

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanInformation`

**FCI's notes (filters, parameters, enum legends):**

```
Loan Portfolio Report contains your portfolio’s basic fields like Original Balance, Paid to Date, Principle Balance, Property Address and Note Rate.
```

**Example — Loan Portfolio Information**

```graphql

{ 
  getLoanInformation
        {
            loanAccount
            achStatus
            amortizationType
            appraiserDate
            appraiserMarketValue
            appTimeStamp
            aRMOptionActive
            article7
            assignment
            boardingDate
            borrowerAddress
            borrowerCity
            borrowerEmail
            borrowerFax
            borrowerFirstName
            borrowerFullName
            borrowerHomePhone
            borrowerLastName
            borrowerMI
            borrowerMobilePhone
            borrowerState
            borrowerWorkPhone
            borrowerZip
            chargesAdjustment
            deferredLateCharges
            deferredPrinBal
            deferredUnpaidCharges
            deferredUnpaidInt
            draws
            ficoScore
            firstPaymentDate
            floatCapForNegAmort
            floatCapForPayment
            floatCeiling
            floatDaysAfterPymtChange
            floatDaysAfterRateChange
            floatEnabledPymtAdj
            floatEnableFirstRateCap
            floatEnableLastRecast
            floatEnableRecast
            floatFirstRateMaxCap
            floatFirstRateMinCap
            floatFloor
            floatFreqPymtChange
            floatFreqRateChange
            floatFreqRecast
            floatIndex
            floatLastRecast
            floatMargin
            floatNextAdjPayment
            floatNextAdjRate
            floatNextAdjRecast
            floatPeriodicMaxCap
            floatPeriodicMinCap
            floatRoundMethod
            floatRoundRateFactor
            floatSendNotice
            floatStopRecast
            funds
            impoundBalance
            iNFIndexARMUid
            investAssetNumber
            lateChargesDays
            lateChargesPct
            lenderAccount
            lienPosition
            loanAccount
            loanChargesAccruedInterest
            loanChargesPrincipal
            maturityDate
            nextDueDate
            noteRate
            noteType
            occupancyStatus
            originalBalance
            originationDate
            paidOffDate
            paidToDate
            payment
            paymentImpound
            paymentReserve
            poffAcrruedInterest
            poffAcurredLateCharges
            poffFromBorrower
            poffFromEscrow
            poffFromSuspense
            poffPaidLateCharges
            poffPrepayPenalty
            poffPrincipalBalance
            poffTotal
            poffUnpaidCharges
            poffUnpaidInterest
            poffUnpaidLateCharges
            prevAccount
            principalBalance
            principalWaived
            propertyAPN
            propertyCity
            propertyState
            propertyStreet
            propertytype
            propertyZip
            purpose
            rateType
            restrictedFunds
            suspenseBalance
            section32
            seniorLoanAmount
            status
            statusLender
            thomasMap
            unearnedDiscount
            unpaidCharges
            unpaidInterest
            unpaidInterestWaived
            unpaidLateCharges
            unpaidLateChargesWaived
         }
}
```

```json
{
    "data": {
        "getLoanInformation": [
            {
                "loanAccount": "test8122",
                "achStatus": "Inactive",
                "amortizationType": 3,
                "appraiserDate": "n/a",
                "appraiserMarketValue": 0,
                "appTimeStamp": "01/28/2020",
                "aRMOptionActive": false,
                "article7": false,
                "assignment": "n/a",
                "boardingDate": "04/08/2014",
                "borrowerAddress": "1800 Address K",
                "borrowerCity": "Concord",
                "borrowerEmail": "",
                "borrowerFax": "",
                "borrowerFirstName": "John",
                "borrowerFullName": "John Smith",
                "borrowerHomePhone": "(000)000-1111",
                "borrowerLastName": "Smith",
                "borrowerMI": "",
                "borrowerMobilePhone": "",
                "borrowerState": "CA",
                "borrowerWorkPhone": "",
                "borrowerZip": "99920",
                "chargesAdjustment": 0,
                "deferredLateCharges": 0,
                "deferredPrinBal": 0,
                "deferredUnpaidCharges": 0,
                "deferredUnpaidInt": 0,
                "draws": 107250,
                "ficaScore": 0,
                "firstPaymentDate": "05/01/2014",
                "floatCapForNegAmort": 0,
                "floatCapForPayment": 0,
                "floatCeiling": 0,
                "floatDaysAfterPymtChange": 30,
                "floatDaysAfterRateChange": 45,
                "floatEnabledPymtAdj": false,
                "floatEnableFirstRateCap": false,
                "floatEnableLastRecast": false,
                "floatEnableRecast": false,
                "floatFirstRateMaxCap": 0,
                "floatFirstRateMinCap": 0,
                "floatFloor": 0,
                "floatFreqPymtChange": 0,
                "floatFreqRateChange": 0,
                "floatFreqRecast": 0,
                "floatIndex": 0,
                "floatLastRecast": "n/a",
                "floatMargin": 0,
                "floatNextAdjPayment": "n/a",
                "floatNextAdjRate": "n/a",
                "floatNextAdjRecast": "n/a",
                "floatPeriodicMaxCap": 0,
                "floatPeriodicMinCap": 0,
                "floatRoundMethod": 0,
                "floatRoundRateFactor": 0,
                "floatSendNotice": true,
                "floatStopRecast": "n/a",
                "funds": 0,
                "impoundBalance": 0,
                "iNFIndexARMUid": "",
                "investAssetNumber": null,
                "lateChargesDays": 10,
                "lateChargesPct": 10,
                "lenderAccount": "13467",
                "lienPosition": 0,
                "loanChargesAccruedInterest": 0,
                "loanChargesPrincipal": 0,
                "maturityDate": "04/01/2015",
                "nextDueDate": "05/01/2015",
                "noteRate": 8.

... truncated: 9544 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Loan Payoff Value to date

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanInformation`

**FCI's notes (filters, parameters, enum legends):**

```
This example request return the payoff value to date of all the loans in your Portfolio, order by Principal Balance, and only returning the fields: Loan Account, Borrower Full Name, Principal Balance, Note Rate and Payoff Total.
```

**Example — Loan Payoff Value to date**

```graphql
{ 
  getLoanInformation(offset:0,orderby: "principalBalance",order: "dsc") 
        {
            loanAccount
            borrowerFullName
            principalBalance
            noteRate
            poffTotal
         }
}
```

```json
{
    "data": {
        "getLoanInformation": [
            {
                "loanAccount": "test00004",
                "borrowerFullName": "Company LLC / Jhon Smith",
                "principalBalance": 6750000,
                "noteRate": 9,
                "poffTotal": 7763576.64
            },
            {
                "loanAccount": "test0011",
                "borrowerFullName": "Martha Simons",
                "principalBalance": 2450000,
                "noteRate": 9.5,
                "poffTotal": 2490235.85
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Broker Disbursment Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getBrokerDisbursment`

**FCI's notes (filters, parameters, enum legends):**

```
The Broker Disbursement Report assists Brokers in viewing payments and fees on the loans that they are taking a Broker Spread. Pull Fields like Lender Account, Check amount and date, Principle Balance and Late Charges
```

**Example — Broker Disbursment Report**

```graphql
{
  getBrokerDisbursment{
    loanAccount
    checkAmount
    checkDate
    code
    interest
    interestCharges
    lateCharges
    lenderAccount
    name
    opmAmount
    otherNonTaxable
    otherPayments
    otherTaxable
    pmtDueDate
    prepayFee
    principal
    principalCharges
    serviceFee
  }
}
```

```json
{
    "data": {
        "getBrokerDisbursment": [
            {
                "loanAccount": "Test1111",
                "checkAmount": 800.59,
                "checkDate": "07/30/2020",
                "code": null,
                "interest": 800.59,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "TESTFUNDING",
                "name": null,
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "07/01/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 0,
                "serviceFee": 0
            },
            {
                "loanAccount": "Test1112",
                "checkAmount": -15,
                "checkDate": "07/30/2020",
                "code": null,
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "TESTFUNDING",
                "name": null,
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "07/01/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 0,
                "serviceFee": -15
            },
            {
                "loanAccount": "Test1113",
                "checkAmount": -15,
                "checkDate": "08/18/2020",
                "code": null,
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "TESTFUNDING",
                "name": null,
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "08/01/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 0,
                "serviceFee": -15
            },
            {
                "loanAccount": "Test1114",
                "checkAmount": 800.59,
                "checkDate": "08/18/2020",
                "code": null,
                "interest": 800.59,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "TESTFUNDING",
                "name": null,
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "08/01/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 0,
                "serviceFee": 0
            },
            {
                "loanAccount": "Test1115",
                "checkAmount": -15,
                "checkDate": "08/31/2020",
                "code": null,
                "interest": 0,
     

... truncated: 5556 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Funding History Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getFundingHistory`

**FCI's notes (filters, parameters, enum legends):**

```
The Funding History report pulls the fields that the loan was funded with like the borrower information, property information appraised market value and loan information
```

**Example — Funding History Report**

```graphql
{
  getFundingHistory{
    loanAccount
    amortizationType
    appraiserDate
    appraiserMarketValue
    armOptionActive
    article7
    assignment
    boardingDate
    borrowerAddress
    borrowerCity
    borrowerEmail
    borrowerFax
    borrowerFirstName
    borrowerFullName
    borrowerHomePhone
    borrowerLastName
    borrowerMI
    borrowerMobilePhone
    borrowerState
    borrowerWorkPhone
    borrowerZip
    brokerRepresentative
    chargesAdjustment
    cumulativeDraw
    deferredLateCharges
    deferredPrinBal
    deferredUnpaidCharges
    deferredUnpaidInt
    depositAmount
    depositDate
    depositFee
    depositNotes
    depositReference
    description
    draws
    ficoScore
    firstPaymentDate
    floatCapForNegAmort
    floatCapForPayment
    floatCeiling
    floatDaysAfterPymtChange
    floatDaysAfterRateChange
    floatEnabledPymtAdj
    floatEnableFirstRateCap
    floatEnableLastRecast
    floatEnableRecast
    floatFirstRateMaxCap
    floatFirstRateMinCap
    floatFloor
    floatFreqPymtChange
    floatFreqRateChange
    floatFreqRecast
    floatIndex
    floatLastRecast
    floatMargin
    floatNextAdjPayment
    floatNextAdjRate
    floatNextAdjRecast
    floatPeriodicMaxCap
    floatPeriodicMinCap
    floatRoundMethod
    floatRoundRateFactor
    floatSendNotice
    floatStopRecast
    funds
    impoundBalance
    lateChargesDays
    lateChargesMin
    lateChargesPct
    lenderAccount
    lenderFullName
    lienPosition
    loanChargesAccruedInterest
    loanChargesPrincipal
    maturityDate
    nextDueDate
    noteRate
    noteType
    occupancyStatus
    originalBalance
    originationDate
    paidOffDate
    paidToDate
    payment
    paymentImpound
    paymentReserve
    prevAccount
    principalBalance
    principalWaived
    propertyAPN
    propertyCity
    propertyState
    propertyStreet
    propertytype
    propertyZip
    purpose
    rateType
    reserveBalance
    section32
    seniorLoanAmount
    status
    thomasMap
    unearnedDiscount
    unpaidCharges
    unpaidInterest
    unpaidInterestWaived
    unpaidLateCharges
    unpaidLateChargesWaived
    unpaidLateChargesWaived
  }
}
```

```json
{
    "data": {
        "getFundingHistory": [
            {
                "loanAccount": "Test00011",
                "amortizationType": 5,
                "appraiserDate": "n/a",
                "appraiserMarketValue": 0,
                "armOptionActive": false,
                "article7": false,
                "assignment": "n/a",
                "boardingDate": "01/11/2012",
                "borrowerAddress": "110 STREET WAY ",
                "borrowerCity": "City",
                "borrowerEmail": "email@gmail.com",
                "borrowerFax": null,
                "borrowerFirstName": "",
                "borrowerFullName": "COMPANY LLC\r\nMartha Johnson",
                "borrowerHomePhone": null,
                "borrowerLastName": "",
                "borrowerMI": "",
                "borrowerMobilePhone": "(000)000-0000",
                "borrowerState": "TN",
                "borrowerWorkPhone": "",
                "borrowerZip": "37127",
                "brokerRepresentative": "7fff3847438dddd9748444",
                "chargesAdjustment": -120.25,
                "cumulativeDraw": 0,
                "deferredLateCharges": 0,
                "deferredPrinBal": 0,
                "deferredUnpaidCharges": 0,
                "deferredUnpaidInt": 0,
                "depositAmount": -123000,
                "depositDate": "01/04/2020",
                "depositFee": 0,
                "depositNotes": null,
                "depositReference": "",
                "description": "Funding",
                "draws": 0,
                "ficaScore": 0,
                "firstPaymentDate": "03/01/2012",
                "floatCapForNegAmort": 0,
                "floatCapForPayment": 0,
                "floatCeiling": 0,
                "floatDaysAfterPymtChange": 0,
                "floatDaysAfterRateChange": 0,
                "floatEnabledPymtAdj": true,
                "floatEnableFirstRateCap": false,
                "floatEnableLastRecast": false,
                "floatEnableRecast": false,
                "floatFirstRateMaxCap": 0,
                "floatFirstRateMinCap": 0,
                "floatFloor": 0,
                "floatFreqPymtChange": 0,
                "floatFreqRateChange": 0,
                "floatFreqRecast": 0,
                "floatIndex": 0,
                "floatLastRecast": "n/a",
                "floatMargin": 0,
                "floatNextAdjPayment": "n/a",
                "floatNextAdjRate": "n/a",
                "floatNextAdjRecast": "n/a",
                "floatPeriodicMaxCap": 0,
                "floatPeriodicMinCap": 0,
                "floatRoundMethod": 0,
                "floatRoundRateFactor": 0,
                "floatSendNotice": true,
                "floatStopRecast": "n/a",
                "funds": 0,
                "impoundBalance": 0,
                "lateChargesDays": 10,
                "lateChargesMin": 0,
                "lateChargesPct": 10,
                "lenderAccount": "lender01",
        

... truncated: 4569 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Interest Accrual Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getInterestAccrual`

**Example — Interest Accrual Report**

```graphql
{
  getInterestAccrual
  {
    loanAccount
    accrualMethod
    accruedInterestMTD
    currentMonth
    dailyRateUsing
    daysBetweenDates
    includEcalcInt
    lenderAccount
    loanNextDueDate
    negativeAmortization
    noteRate
    paidToDate
    payAutomatically
    principalBalance
  }
}
```

```json
{
    "data": {
        "getInterestAccrual": [
            {
                "loanAccount": "Test00011",
                "accrualMethod": "Regular Period (Due Date to Due Date)",
                "accruedInterestMTD": 6000,
                "currentMonth": "10/01/2020",
                "dailyRateUsing": "360 Days Year Basis",
                "daysBetweenDates": "Actual Number of Days",
                "includEcalcInt": "FALSE",
                "lenderAccount": "lender01",
                "loanNextDueDate": "11/09/2020",
                "negativeAmortization": "Unpaid Interest",
                "noteRate": 12,
                "paidToDate": "10/01/2020",
                "payAutomatically": "TRUE",
                "principalBalance": 600000
            },
            {
                "loanAccount": "Test00012",
                "accrualMethod": "Regular Period (Due Date to Due Date)",
                "accruedInterestMTD": 3145.26,
                "currentMonth": "10/01/2020",
                "dailyRateUsing": "360 Days Year Basis",
                "daysBetweenDates": "30 Days Month Basis",
                "includEcalcInt": "FALSE",
                "lenderAccount": "lender01",
                "loanNextDueDate": "11/09/2020",
                "negativeAmortization": "Unpaid Interest",
                "noteRate": 10.25,
                "paidToDate": "02/01/2020",
                "payAutomatically": "TRUE",
                "principalBalance": 368225
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Loan Activities Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanActivities`

**FCI's notes (filters, parameters, enum legends):**

```
This report is for tracking the activities that go on with your portfolio. Pull fields for dates with your payments like when they were received and when the funds will be released to you and pull the individual payment fields as well like Lender Fees, Escrow, Insurance and so on.
```

**Example — Loan Activities Report**

```graphql
{
  getLoanActivities{
    loanAccount
    achDate
    achTransNumber
    balance
    clearingDate
    dateDeposited
    dateDue
    dateReceived
    dayVariance
    defaultIntEffectiveDateFrom
    defaultIntImplementationDate
    description
    interestPaidTo
    lateCharge
    lenderAccount
    notes
    reference
    releaseDate
    releaseDateExt
    reserveRestricted
    revDateDue
    revInterestPaidTo
    revPaidOff
    toAdvanceRentReserve
    toBrokerFee
    toCapitalExp
    toChargesInterest
    toChargesPrincipal
    toExpenseReserve
    toImpound
    toImpoundEstimated
    toInsuranceAdvanceReserve
    toInsuranceReserve
    toInterest
    toInterestEstimated
    toLateCharge
    toLenderFee
    toMiscellaneous
    toOtherPayments
    toOtherTaxable
    toOtherTaxFree
    toPrepay
    toPrincipal
    toPrincipalEstimated
    toPropertyManagement
    toRepair
    toReserve
    toSecurityDeposit
    totalEstimated
    toTaxAdvanceReserve
    toTaxReserve
    toUnpaidDefaultInt
    toUnpaidEscrowInt
    toUnpaidFees
    toUnpaidInterest
    totalPayment
    pppPayment
  }
}
```

```json
{
    "data": {
        "getLoanActivities": [
            {
                "loanAccount": "Test00011",
                "achDate": "n/a",
                "achTransNumber": 0,
                "balance": 600000,
                "clearingDate": "09/21/2020",
                "dateDeposited": "09/21/2020",
                "dateDue": "09/21/2020",
                "dateReceived": "09/21/2020",
                "defaultIntEffectiveDateFrom": "n/a",
                "defaultIntImplementationDate": "n/a",
                "description": "OtherCash",
                "interestPaidTo": "09/01/2020",
                "lateCharge": 0,
                "lenderAccount": "lender01",
                "notes": null,
                "reference": "wire*",
                "releaseDate": "09/21/2020",
                "releaseDateExt": "n/a",
                "reserveRestricted": 0,
                "revDateDue": "09/21/2020",
                "revInterestPaidTo": "09/01/2020",
                "revPaidOff": "n/a",
                "toAdvanceRentReserve": 0,
                "toBrokerFee": 0,
                "toCapitalExp": 0,
                "toChargesInterest": 648.35,
                "toChargesPrincipal": 31371.65,
                "toExpenseReserve": 0,
                "toImpound": 0,
                "toImpoundEstimated": 0,
                "toInsuranceAdvanceReserve": 0,
                "toInsuranceReserve": 0,
                "toInterest": 0,
                "toInterestEstimated": 0,
                "toLateCharge": 0,
                "toLenderFee": 0,
                "toMiscellaneous": 0,
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toPrepay": 0,
                "toPrincipal": 0,
                "toPrincipalEstimated": 0,
                "toPropertyManagement": 0,
                "toRepair": 0,
                "toReserve": 0,
                "toSecurityDeposit": 0,
                "totalEstimated": 0,
                "toTaxAdvanceReserve": 0,
                "toTaxReserve": 0,
                "toUnpaidDefaultInt": 0,
                "toUnpaidEscrowInt": 0,
                "toUnpaidFees": 0,
                "toUnpaidInterest": 0
            },
            {
                "loanAccount": "Test00012",
                "achDate": "08/03/2020",
                "achTransNumber": 1111,
                "balance": 600000,
                "clearingDate": "08/07/2020",
                "dateDeposited": "08/03/2020",
                "dateDue": "08/01/2020",
                "dateReceived": "08/03/2020",
                "defaultIntEffectiveDateFrom": "n/a",
                "defaultIntImplementationDate": "n/a",
                "description": "RegPmt",
                "interestPaidTo": "07/01/2020",
                "lateCharge": 0,
                "lenderAccount": "lender01",
                "notes": null,
                "reference": "PYM",
                "releaseDate": "08/07/2020",
                "release

... truncated: 8817 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Loan Charges Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanChargesList`

**FCI's notes (filters, parameters, enum legends):**

```
This Report takes an in depth look at charges that your borrower has received on their loan. You can pull the Assessed Finance Charges, Accrued Interest, Charge Balance and the Charge Dates.
```

**Example — Loan Charges Report**

```graphql
{
  getLoanChargesList{
    loanAccount
    accruedInterest
    assessFinanceCharges
    behalfAccount
    behalfBalance
    borrowerFullName
    chargeBalance
    chargeDate
    code
    comments
    deferred
    description
    interestFrom
    interestRate
    lenderAccount
    name
    originalAmount
    principalBalance
    propertyStreet
    reference
    totalDue
    vendorBalance
  }
}
```

```json
{
    "data": {
        "getLoanChargesList": [
            {
                "loanAccount": "test8180",
                "accruedInterest": 0,
                "assessFinanceCharges": true,
                "behalfAccount": null,
                "behalfBalance": 0,
                "borrowerFullName": "test tester",
                "chargeBalance": 100,
                "chargeDate": "12/08/2020",
                "code": "INFE128",
                "comments": "Test Charge fir testing Purpose",
                "deferred": false,
                "description": "Admin Fee",
                "interestFrom": "12/08/2020",
                "interestRate": 5,
                "lenderAccount": "Test1234",
                "name": "Admin Fee",
                "originalAmount": 100,
                "principalBalance": 20019.14,
                "propertyStreet": "123 Main Street",
                "reference": "",
                "totalDue": 100,
                "vendorBalance": 100
            },
            {
                "loanAccount": "test8180",
                "accruedInterest": 0,
                "assessFinanceCharges": false,
                "behalfAccount": null,
                "behalfBalance": 0,
                "borrowerFullName": "Test Tester",
                "chargeBalance": 1000,
                "chargeDate": "07/15/2022",
                "code": "SEFE101",
                "comments": "This is Test Charges- VS",
                "deferred": false,
                "description": "Reconveyance Fee-By Investor",
                "interestFrom": "n/a",
                "interestRate": 0,
                "lenderAccount": "Test1234",
                "name": "Reconveyance Fee-By Investor",
                "originalAmount": 1000,
                "principalBalance": 22019.14,
                "propertyStreet": "123 Main Street",
                "reference": "Test Reference_VS",
                "totalDue": 1000,
                "vendorBalance": 1000
            },
            {
                "loanAccount": "test8180",
                "accruedInterest": 0,
                "assessFinanceCharges": false,
                "behalfAccount": null,
                "behalfBalance": 0,
                "borrowerFullName": "Test Tester",
                "chargeBalance": 1000,
                "chargeDate": "11/15/2021",
                "code": "SEFE118",
                "comments": "This is Test Charges- VS",
                "deferred": false,
                "description": "Skip Tracing Fee- To Servicer",
                "interestFrom": "n/a",
                "interestRate": 0,
                "lenderAccount": "Test1234",
                "name": "Skip Tracing Fee- To Servicer",
                "originalAmount": 1000,
                "principalBalance": 22019.14,
                "propertyStreet": "123 Main Street",
                "reference": "Test Reference_VS",
                "totalDue": 1000,
                "vendorBalance": 1000
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Lender Payment Statement History

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLenderPaymentStatementHistory`

**FCI's notes (filters, parameters, enum legends):**

```
The Lender Payment Statement History pulls the fields from Payment History in your Lender Login to this excel report across your portfolio

filters:

- lenderAccount:"Test1234"

- loanAccount:"test8180"

- dateFrom:"01-01-2021"
```

**Example — Lender Payment Statement History**

```graphql
{
  getLenderPaymentStatementHistory(lenderaccount:"Test1234" loanaccount:"test8180"){
    loanAccount
    checkAmount
    checkDate
    checkNo
    code
    interest
    interestCharges
    lateCharges
    lenderAccount
    name
    opmAmount
    otherNonTaxable
    otherPayments
    otherTaxable
    pmtDueDate
    prepayFee
    principal
    principalCharges
    serviceFee
  }
}
```

```json
{
    "data": {
        "getLenderPaymentStatementHistory": [
            {
                "loanAccount": "test0017",
                "checkAmount": 200000,
                "checkDate": "02/10/2020",
                "checkNo": "100001",
                "code": null,
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "lender04",
                "name": null,
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "08/05/2020",
                "prepayFee": 0,
                "principal": 200000,
                "principalCharges": 0,
                "serviceFee": 0
            },
            {
                "loanAccount": "test0018",
                "checkAmount": 768.5,
                "checkDate": "07/24/2020",
                "checkNo": "100009",
                "code": "INFE101",
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "lender04",
                "name": "Foreclosure Attorney Fees",
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "07/22/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 768.5,
                "serviceFee": 0
            },
            {
                "loanAccount": "test0018",
                "checkAmount": 388.14,
                "checkDate": "07/24/2020",
                "checkNo": "100008",
                "code": "INCO103",
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "lender04",
                "name": "Foreclosure Costs",
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "07/24/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 388.14,
                "serviceFee": 0
            },
            {
                "loanAccount": "test0018",
                "checkAmount": 1594.42,
                "checkDate": "07/24/2020",
                "checkNo": "100006",
                "code": "INFE101",
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "lender04",
                "name": "Foreclosure Attorney Fees",
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "07/24/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 1594.42,
             

... truncated: 3050 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Other Payments Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getOtherPayments`

**FCI's notes (filters, parameters, enum legends):**

```
List all other payments made for Foreclosure Attorney Fees, Foreclosure Costs, etc.
```

**Example — Other Payments Report**

```graphql
{
  getOtherPayments{
    loanAccount
    amount
    checkDate
    checkNo
    code
    description
    lenderAccount
    name
    subType
    toOtherPayments
    toOtherTaxable
    toOtherTaxFree
  }
}
```

```json
{
    "data": {
        "getOtherPayments": [
            {
                "loanAccount": "Test00012",
                "amount": 574.0,
                "checkDate": "07/24/2020",
                "checkNo": "111118",
                "code": "INFE101",
                "description": "Foreclosure Attorney Fees",
                "lenderAccount": "lend012",
                "name": "Foreclosure Attorney Fees",
                "subType": "Unknown",
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0
            },
            {
                "loanAccount": "Test00012",
                "amount": 2494.42,
                "checkDate": "07/24/2020",
                "checkNo": "111118",
                "code": "INFE101",
                "description": "Foreclosure Attorney Fees",
                "lenderAccount": "lend012",
                "name": "Foreclosure Attorney Fees",
                "subType": "Unknown",
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0
            },
            {
                "loanAccount": "Test00012",
                "amount": 588.5,
                "checkDate": "07/24/2020",
                "checkNo": "111118",
                "code": "INCO103",
                "description": "Foreclosure Costs",
                "lenderAccount": "lend012",
                "name": "Foreclosure Costs",
                "subType": "Unknown",
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0
            },
            {
                "loanAccount": "Test00012",
                "amount": 768.0,
                "checkDate": "07/24/2020",
                "checkNo": "111118",
                "code": "INFE101",
                "description": "Foreclosure Attorney Fees",
                "lenderAccount": "lend012",
                "name": "Foreclosure Attorney Fees",
                "subType": "Unknown",
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Portfolio Reports / Loan PayString Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanPayString`

**FCI's notes (filters, parameters, enum legends):**

```
Pay String report for last 24 months.

0 = days Past Due < 30
1 = days Past Due < 60
2 = days Past Due < 90
3 = days Past Due < 120
4 = days Past Due >=120

5 => when LOAN is in Foreclosure
R=> When Loan is REO
X=> PAYOFF
```

**Example — Loan PayString Report**

```graphql
{
  getLoanPayString{
    borrowerFullName
    currentDQStatus
    firstPaymentDate
    lateChargesDays
    lenderAccount
    loanAccount
    nextDueDate
    payString
    principalBalance
  }
}
```

```json
{
    "data": {
        "getLoanPayString": [
            {
                "borrowerFullName": "Borrower Name 1",
                "currentDQStatus": "Current",
                "firstPaymentDate": "11/01/2013",
                "lateChargesDays": 15,
                "lenderAccount": "300000",
                "loanAccount": "31111000",
                "nextDueDate": "01/01/2021",
                "payString": "000000000000000000000000",
                "principalBalance": 15600.11
            },
            {
                "borrowerFullName": "Borrower Name 2",
                "currentDQStatus": "150-179 DPD",
                "firstPaymentDate": "11/01/2006",
                "lateChargesDays": 15,
                "lenderAccount": "300000",
                "loanAccount": "31111333",
                "nextDueDate": "07/01/2020",
                "payString": "443210012340121234444444",
                "principalBalance": 41234.00
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Reports by Loan Account / Loan Information by Loan Account

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanInformation`

**FCI's notes (filters, parameters, enum legends):**

```
Request information of a specific loan account.
```

**Example — Loan Information by Loan Account**

```graphql

{ 
  getLoanInformation
    (
        loanaccount:"test8122",
        offset:0,
        orderby: "LoanAccount",
        order: "asc"
    ) 
        {
            loanAccount
            amortizationType
            appraiserDate
            appraiserMarketValue
            appTimeStamp
            aRMOptionActive
            article7
            assignment
            boardingDate
            borrowerAddress
            borrowerCity
            borrowerEmail
            borrowerFax
            borrowerFirstName
            borrowerFullName
            borrowerHomePhone
            borrowerLastName
            borrowerMI
            borrowerMobilePhone
            borrowerState
            borrowerWorkPhone
            borrowerZip
            chargesAdjustment
            deferredLateCharges
            deferredPrinBal
            deferredUnpaidCharges
            deferredUnpaidInt
            draws
            ficaScore
            firstPaymentDate
            floatCapForNegAmort
            floatCapForPayment
            floatCeiling
            floatDaysAfterPymtChange
            floatDaysAfterRateChange
            floatEnabledPymtAdj
            floatEnableFirstRateCap
            floatEnableLastRecast
            floatEnableRecast
            floatFirstRateMaxCap
            floatFirstRateMinCap
            floatFloor
            floatFreqPymtChange
            floatFreqRateChange
            floatFreqRecast
            floatIndex
            floatLastRecast
            floatMargin
            floatNextAdjPayment
            floatNextAdjRate
            floatNextAdjRecast
            floatPeriodicMaxCap
            floatPeriodicMinCap
            floatRoundMethod
            floatRoundRateFactor
            floatSendNotice
            floatStopRecast
            funds
            impoundBalance
            iNFIndexARMUid
            investAssetNumber
            lateChargesDays
            lateChargesPct
            lenderAccount
            lienPosition
            loanAccount
            loanChargesAccruedInterest
            loanChargesPrincipal
            maturityDate
            nextDueDate
            noteRate
            noteType
            occupancyStatus
            originalBalance
            originationDate
            paidOffDate
            paidToDate
            payment
            paymentImpound
            paymentReserve
            poffAcrruedInterest
            poffAcurredLateCharges
            poffFromBorrower
            poffFromEscrow
            poffFromSuspense
            poffPaidLateCharges
            poffPrepayPenalty
            poffPrincipalBalance
            poffTotal
            poffUnpaidCharges
            poffUnpaidInterest
            poffUnpaidLateCharges
            prevAccount
            principalBalance
            principalWaived
            propertyAPN
            propertyCity
            propertyState
            propertyStreet
            propertytype
            propertyZip
            purpose
            rateType
            reserveBalance
            section32
            seniorLoanAmount
            status
            statusLender
            thomasMap
            unearnedDiscount
            unpaidCharges
            unpaidInterest
            unpaidInterestWaived
            unpaidLateCharges
            unpaidLateChargesWaived
         }
}
```

```json
{
    "data": {
        "getLoanInformation": [
            {
                "loanAccount": "test8122",
                "amortizationType": 3,
                "appraiserDate": "n/a",
                "appraiserMarketValue": 0,
                "appTimeStamp": "01/28/2020",
                "aRMOptionActive": false,
                "article7": false,
                "assignment": "n/a",
                "boardingDate": "04/08/2014",
                "borrowerAddress": "1800 Address K",
                "borrowerCity": "Concord",
                "borrowerEmail": "",
                "borrowerFax": "",
                "borrowerFirstName": "John",
                "borrowerFullName": "John Smith",
                "borrowerHomePhone": "(000)000-1111",
                "borrowerLastName": "Smith",
                "borrowerMI": "",
                "borrowerMobilePhone": "",
                "borrowerState": "CA",
                "borrowerWorkPhone": "",
                "borrowerZip": "99920",
                "chargesAdjustment": 0,
                "deferredLateCharges": 0,
                "deferredPrinBal": 0,
                "deferredUnpaidCharges": 0,
                "deferredUnpaidInt": 0,
                "draws": 107250,
                "ficaScore": 0,
                "firstPaymentDate": "05/01/2014",
                "floatCapForNegAmort": 0,
                "floatCapForPayment": 0,
                "floatCeiling": 0,
                "floatDaysAfterPymtChange": 30,
                "floatDaysAfterRateChange": 45,
                "floatEnabledPymtAdj": false,
                "floatEnableFirstRateCap": false,
                "floatEnableLastRecast": false,
                "floatEnableRecast": false,
                "floatFirstRateMaxCap": 0,
                "floatFirstRateMinCap": 0,
                "floatFloor": 0,
                "floatFreqPymtChange": 0,
                "floatFreqRateChange": 0,
                "floatFreqRecast": 0,
                "floatIndex": 0,
                "floatLastRecast": "n/a",
                "floatMargin": 0,
                "floatNextAdjPayment": "n/a",
                "floatNextAdjRate": "n/a",
                "floatNextAdjRecast": "n/a",
                "floatPeriodicMaxCap": 0,
                "floatPeriodicMinCap": 0,
                "floatRoundMethod": 0,
                "floatRoundRateFactor": 0,
                "floatSendNotice": true,
                "floatStopRecast": "n/a",
                "funds": 0,
                "impoundBalance": 0,
                "iNFIndexARMUid": "",
                "investAssetNumber": null,
                "lateChargesDays": 10,
                "lateChargesPct": 10,
                "lenderAccount": "13467",
                "lienPosition": 0,
                "loanChargesAccruedInterest": 0,
                "loanChargesPrincipal": 0,
                "maturityDate": "04/01/2015",
                "nextDueDate": "05/01/2015",
                "noteRate": 8.99,
                "noteType": 1,
      

... truncated: 4760 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - Daily Distribution Reports / Reports by Loan Account / Interest Accrual Report by Loan Account

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getInterestAccrual`

**Example — Interest Accrual Report by Loan Account**

```graphql
{
  getInterestAccrual 
  (
        loanaccount:"Test00011",
        limit:1,
        offset:0,
        orderby: "LoanAccount",
        order: "asc"
    ) 
  {
    loanAccount
    accrualMethod
    accruedInterestMTD
    currentMonth
    dailyRateUsing
    daysBetweenDates
    includEcalcInt
    lenderAccount
    loanNextDueDate
    negativeAmortization
    noteRate
    paidToDate
    payAutomatically
    principalBalance
  }
}
```

```json
{
    "data": {
        "getInterestAccrual": [
            {
                "loanAccount": "Test00011",
                "accrualMethod": "Regular Period (Due Date to Due Date)",
                "accruedInterestMTD": 6000,
                "currentMonth": "10/01/2020",
                "dailyRateUsing": "360 Days Year Basis",
                "daysBetweenDates": "Actual Number of Days",
                "includEcalcInt": "FALSE",
                "lenderAccount": "lender01",
                "loanNextDueDate": "11/09/2020",
                "negativeAmortization": "Unpaid Interest",
                "noteRate": 12,
                "paidToDate": "10/01/2020",
                "payAutomatically": "TRUE",
                "principalBalance": 600000
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Reports by Loan Account / Loan Activities Report by Loan Account

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanActivities`

**Example — Loan Activities Report by Loan Account**

```graphql
{
  getLoanActivities
  (
        loanaccount:"TEST00001",
        limit:1,
        offset:0,
        orderby: "LoanAccount",
        order: "asc"
    ) 
    {
    loanAccount
    achDate
    achTransNumber
    balance
    clearingDate
    dateDeposited
    dateDue
    dateReceived
    defaultIntEffectiveDateFrom
    defaultIntImplementationDate
    description
    interestPaidTo
    lateCharge
    lenderAccount
    notes
    reference
    releaseDate
    releaseDateExt
    reserveRestricted
    revDateDue
    revInterestPaidTo
    revPaidOff
    toAdvanceRentReserve
    toBrokerFee
    toCapitalExp
    toChargesInterest
    toChargesPrincipal
    toExpenseReserve
    toImpound
    toImpoundEstimated
    toInsuranceAdvanceReserve
    toInsuranceReserve
    toInterest
    toInterestEstimated
    toLateCharge
    toLenderFee
    toMiscellaneous
    toOtherPayments
    toOtherTaxable
    toOtherTaxFree
    toPrepay
    toPrincipal
    toPrincipalEstimated
    toPropertyManagement
    toRepair
    toReserve
    toSecurityDeposit
    totalEstimated
    toTaxAdvanceReserve
    toTaxReserve
    toUnpaidDefaultInt
    toUnpaidEscrowInt
    toUnpaidFees
    toUnpaidInterest
  }
}
```

```json
{
    "data": {
        "getLoanActivities": [
            {
                "loanAccount": "TEST00001",
                "achDate": "02/21/2020",
                "achTransNumber": 7301,
                "balance": 687500,
                "clearingDate": "02/25/2020",
                "dateDeposited": "02/21/2020",
                "dateDue": "02/21/2020",
                "dateReceived": "02/21/2020",
                "defaultIntEffectiveDateFrom": "n/a",
                "defaultIntImplementationDate": "n/a",
                "description": "RegPmt",
                "interestPaidTo": "08/21/2020",
                "lateCharge": 0,
                "lenderAccount": "14462",
                "notes": null,
                "reference": "000012",
                "releaseDate": "02/25/2020",
                "releaseDateExt": "n/a",
                "reserveRestricted": 0,
                "revDateDue": "02/21/2020",
                "revInterestPaidTo": "01/21/2020",
                "revPaidOff": "n/a",
                "toAdvanceRentReserve": 0,
                "toBrokerFee": 0,
                "toCapitalExp": 0,
                "toChargesInterest": 0,
                "toChargesPrincipal": 0,
                "toExpenseReserve": 0,
                "toImpound": 0,
                "toImpoundEstimated": 0,
                "toInsuranceAdvanceReserve": 0,
                "toInsuranceReserve": 0,
                "toInterest": 5142.11,
                "toInterestEstimated": 5142.11,
                "toLateCharge": 0,
                "toLenderFee": 0,
                "toMiscellaneous": 0,
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toPrepay": 0,
                "toPrincipal": 0,
                "toPrincipalEstimated": 0,
                "toPropertyManagement": 0,
                "toRepair": 0,
                "toReserve": 0,
                "toSecurityDeposit": 0,
                "totalEstimated": 5142.11,
                "toTaxAdvanceReserve": 0,
                "toTaxReserve": 0,
                "toUnpaidDefaultInt": 0,
                "toUnpaidEscrowInt": 0,
                "toUnpaidFees": 0,
                "toUnpaidInterest": 0
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Reports by Loan Account / Loan Charges Report by Loan Account

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanChargesList`

**Example — Loan Charges Report by Loan Account**

```graphql
{
  getLoanChargesList
  (
        loanaccount:"Test00012",
        offset:0,
        orderby: "LoanAccount",
        order: "asc"
    ) 
    {
loanAccount
    accruedInterest
    assessFinanceCharges
    behalfAccount
    behalfBalance
    borrowerFullName
    chargeBalance
    chargeDate
    code
    comments
    deferred
    description
    interestFrom
    interestRate
    lenderAccount
    name
    originalAmount
    principalBalance
    propertyStreet
    reference
    totalDue
    vendorBalance
  }
}
```

```json
{
    "data": {
        "getLoanChargesList": [
            {
                "loanAccount": "Test00012",
                "accruedInterest": 0,
                "assessFinanceCharges": true,
                "behalfAccount": null,
                "behalfBalance": 0,
                "borrowerFullName": "Borrower Testname",
                "chargeBalance": 448.47,
                "chargeDate": "08/06/2020",
                "code": "INCO116",
                "comments": "FC \r\nACH payment attached \r\n",
                "deferred": false,
                "description": "Bankruptcy Costs",
                "interestFrom": "08/06/2020",
                "interestRate": 0,
                "lenderAccount": "len001",
                "name": "Bankruptcy Costs",
                "originalAmount": 448.47,
                "principalBalance": 113000,
                "propertyStreet": "101 STREET Dr. ",
                "reference": "000010001",
                "totalDue": 448.47,
                "vendorBalance": 448.47
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Reports by Loan Account / Lender Payment Statement History by Loan Account

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLenderPaymentStatementHistory`

**Example — Lender Payment Statement History by Loan Account**

```graphql
{
  getLenderPaymentStatementHistory
   (
        loanaccount:"test0018",
        offset:0,
        orderby: "LoanAccount",
        order: "asc"
    )
    {
    loanAccount
    checkAmount
    checkDate
    checkNo
    code
    interest
    interestCharges
    lateCharges
    lenderAccount
    name
    opmAmount
    otherNonTaxable
    otherPayments
    otherTaxable
    pmtDueDate
    prepayFee
    principal
    principalCharges
    serviceFee
  }
}
```

```json
{
    "data": {
        "getLenderPaymentStatementHistory": [
            {
                "loanAccount": "test0018",
                "checkAmount": 768.5,
                "checkDate": "07/24/2020",
                "checkNo": "100009",
                "code": "INFE101",
                "interest": 0,
                "interestCharges": 0,
                "lateCharges": 0,
                "lenderAccount": "lender04",
                "name": "Foreclosure Attorney Fees",
                "opmAmount": 0,
                "otherNonTaxable": 0,
                "otherPayments": 0,
                "otherTaxable": 0,
                "pmtDueDate": "07/22/2020",
                "prepayFee": 0,
                "principal": 0,
                "principalCharges": 768.5,
                "serviceFee": 0
            }
        ]
    }
}
```

### Pull API - Daily Distribution Reports / Reports by Loan Account / Other Payments Report by Loan Account

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getOtherPayments`

**Example — Other Payments Report by Loan Account**

```graphql
{
  getOtherPayments
  (
        loanaccount:"Test00012",
        limit:1,
        offset:0,
        orderby: "LoanAccount",
        order: "asc"
    )
  {
    loanAccount
    amount
    checkDate
    checkNo
    code
    description
    lenderAccount
    name
    subType
    toOtherPayments
    toOtherTaxable
    toOtherTaxFree
  }
}
```

```json
{
    "data": {
        "getOtherPayments": [
            {
                "loanAccount": "Test00012",
                "amount": 574.0,
                "checkDate": "07/24/2020",
                "checkNo": "111118",
                "code": "INFE101",
                "description": "Foreclosure Attorney Fees",
                "lenderAccount": "lend012",
                "name": "Foreclosure Attorney Fees",
                "subType": "Unknown",
                "toOtherPayments": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Portfolio

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanPortfolio`

**FCI's notes (filters, parameters, enum legends):**

```
To map you fields from the following lender portal screens, by default this API will list only all the active loans in your portfolio, use the parameters below to change the data that the API will show.

getLoanPortfolio {.......}

getLoanPortfolio(investor:"investor")

Parameters

investor: Optional

account: Optional

Limit: Optional

boardingDate: Optional

includeInactive Optional
-true: shows all the inactive loans
-false: shows all the active loans

includeUPB:true will show active loans with 0 UPB

dayslate: Optional (shows loans with daysLate equal or greater than the number specify on this parameter)

propertyStreet: “7 characters minimum“

propertyCity: “4 characters minimum“

propertyState: “Exact match, 2 characters“ example (CA, AZ)

propertyZip: “Exact match, 5 characters“ example (90045, 20155)

Query Options:

getLoanPortfolio {.......}

getLoanPortfolio (includeInactive:true) {.......}

getLoanPortfolio (dayslate:2){.......}

getLoanPortfolio (includeUPB:true){.......}

getLoanPortfolio(account:"testaccount"){ .......... }

getLoanPortfolio(investor:"investor"){ .......... }

getLoanPortfolio(boardingDate:"01/01/2000"){ .......... }

getLoanPortfolio(account:"testaccount" investor:"investor"){ .......... }
```

**Example — Loan Portfolio**

```graphql
{
  getLoanPortfolio(includeInactive:true, account:"test8180")
  {
    loanAccount
    lenderAccount
    lenderName
    prevServiceAccount
    origLender
    investorAssetNumber
    originatorLoanNumber
    name
    city
    state
    maturityDate
    primaryPurpose
    originalBalance
    currentBalance
    paidToDate
    daysLate
    nextDueDate
    noteRate
    noteType
    investorRate
    totalPayment
    loanStatus
    boardingDate
    closedDate
    closedReason
    originationDate
    defaultInterestActiveStatus
    defaultInterestRate
    defaultInterestActiveDate
    lenderOwnerPct
    brokerName
    vendor
    restrictedFunds
    reserveBalance
    drawStatus
    maximumDraw
    fundedAmount
    drawAvailableBalance
    escrowBalance
    prepymtExpDate
    appCreationDate
    achStatus
    armOptionActive
    borrowerFullName
    borrowerAddress
    borrowerCity
    borrowerState
    borrowerZip
    borrowerEmail
    borrowerHomePhone
    borrowerMobilePhone
    borrowerWorkPhone
    borrowerFax
    loanCharges
    paidOffDate
    seniorLoanAmounts
    floatCapForPayment
    escrowPayment
    floatIndex
    floatMargin
    floatFloor
    floatCeiling
    floatCapForNegAmort
    floatFirstRateMaxCap
    floatFirstRateMinCap
    floatPeriodicMaxCap
    floatFreqRateChange
    floatFreqPymtChange
    floatFreqRecast
    floatDaysAfterRateChange
    floatDaysAfterPymtChange
    floatEnableFirstRateCap
    floatEnabledPymtAdj
    floatRoundMethod
    floatRoundRateFactor
    floatSendNotice
    floatNextAdjPayment
    floatStopRecast
    fundedAmount
    graceDays
    lateChargesPct
    minimumLateCharges
    unpaidLateCharges
    unpaidInterest
    lienPosition
    suspensePayment
    unearnedDiscount
    propertyType
    property{
        city
        state
        street
        zipCode
    }
    # ARM / float
    floatPeriodicMaxCap
    floatPeriodicMinCap
    floatNextAdjRecast
    floatNextAdjRate
    floatEnableRecast
    floatEnableLastRecast
    floatLastRecast
    # property / appraisal
    propertyAppraisalValue
    propertyAppraisalDate
    propertyAppraisalSource
    propertyOccupancy
    propertyApn
    # others
    firstPaymentDate
    article7
    section32
    lastModifiedAt
    fico
  }
}
```

```json
{
    "data": {
        "getLoanPortfolio": [
            {
                "loanAccount": "test8180",
                "lenderAccount": "test12345",
                "lenderName": "Test Lender",
                "prevServiceAccount": null,
                "origLender": "",
                "investorAssetNumber": null,
                "originatorLoanNumber": null,
                "name": "Organization llc",
                "city": "",
                "state": null,
                "maturityDate": "06/08/2023",
                "primaryPurpose": "Business",
                "originalBalance": 10000000.00,
                "currentBalance": 0.00,
                "paidToDate": "06/09/2020",
                "daysLate": 2064,
                "nextDueDate": "06/09/2020",
                "noteRate": 0,
                "noteType": "BUSINESS PURPOSE LOAN",
                "investorRate": 0,
                "totalPayment": 0.00,
                "loanStatus": "Performing",
                "boardingDate": "06/09/2020",
                "closedDate": "n/a",
                "closedReason": null,
                "originationDate": "06/08/2020",
                "defaultInterestActiveStatus": "NO",
                "defaultInterestRate": 0,
                "defaultInterestActiveDate": "n/a",
                "lenderOwnerPct": 0,
                "brokerName": "Brokert Test",
                "vendor": null,
                "restrictedFunds": 0.00,
                "reserveBalance": 0.00,
                "drawStatus": "",
                "maximumDraw": null,
                "fundedAmount": 0.00,
                "drawAvailableBalance": null,
                "escrowBalance": 0.00,
                "prepymtExpDate": "n/a",
                "appCreationDate": "06/09/2020",
                "achStatus": "NONE",
                "armOptionActive": false,
                "borrowerFullName": "Borrower LLC",
                "borrowerAddress": "Z Street",
                "borrowerCity": "MIAMI",
                "borrowerState": "FL",
                "borrowerZip": "33158",
                "borrowerEmail": null,
                "borrowerHomePhone": "(700)000-1111",
                "borrowerMobilePhone": "(800)000-2222",
                "borrowerWorkPhone": null,
                "borrowerFax": null,
                "loanCharges": 0,
                "paidOffDate": "n/a",
                "seniorLoanAmounts": 0,
                "floatCapForPayment": null,
                "escrowPayment": 0.00,
                "floatIndex": 0,
                "floatMargin": 0,
                "floatFloor": 0,
                "floatCeiling": null,
                "floatCapForNegAmort": 0,
                "floatFirstRateMaxCap": 0,
                "floatFirstRateMinCap": 0,
                "floatPeriodicMaxCap": 0,
                "floatFreqRateChange": 0,
                "floatFreqPymtChange": 0,
                "floatFreqRecast": 0,
                "floatDaysAfterRateChange": 0,
                "floatDaysAfterPym

... truncated: 8434 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

**Example — Loan Portfolio w/ Inactive Loans**

```graphql
{
  getLoanPortfolio (includeInactive:true)
  {
    loanAccount
    lenderAccount
    prevServiceAccount
    origLender
    investorAssetNumber
    name
    city
    state
    maturityDate
    primaryPurpose
    originalBalance
    currentBalance
    daysLate
    nextDueDate
    noteRate
    investorRate
    totalPayment
    loanStatus
    boardingDate
    closedDate
    closedReason
    defaultInterestActiveStatus
    defaultInterestRate
    defaultInterestActiveDate
    lenderOwnerPct
    brokerName
    vendor
    restrictedFunds
    reserveBalance
    escrowBalance
    appCreationDate
    property{
        city
        state
        street
        zipCode
    }
  }
}
```

```json
{
    "data": {
        "getLoanPortfolio": [
            {
                "loanAccount": "test8180",
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "prevServiceAccount": null,
                "origLender": "Vtest1234",
                "investorAssetNumber": null,
                "name": "tester, test",
                "city": "ANAHEIM",
                "state": "CA",
                "maturityDate": "12/01/2041",
                "primaryPurpose": "Consumer",
                "originalBalance": 20019.14,
                "currentBalance": 20019.14,
                "daysLate": 139,
                "nextDueDate": "05/01/2021",
                "noteRate": 0.05,
                "investorRate": 0.05,
                "totalPayment": 55.29,
                "loanStatus": "Delinquency",
                "boardingDate": "10/31/2018",
                "closedDate": "n/a",
                "closedReason": null,
                "defaultInterestActiveStatus": "YES",
                "defaultInterestRate": 0,
                "defaultInterestActiveDate": "03/01/2021",
                "lenderOwnerPct": 90.917,
                "brokerName": "Centurion Test",
                "vendor": "Centurion Test",
                "restrictedFunds": 0.00,
                "reserveBalance": 40.46,
                "escrowBalance": 0,
                "appCreationDate": "10/05/2023",
                "property": [
                    {
                        "city": "ANAHEIM",
                        "state": "CA",
                        "street": "123 Main Street",
                        "zipCode": "92808"
                    }
                ]
            },
            {
                "loanAccount": "test8181",
                "lenderAccount": "Test1234",
                "prevServiceAccount": null,
                "origLender": "Vtest1234",
                "investorAssetNumber": null,
                "name": "tester, test",
                "city": "ANAHEIM",
                "state": "CA",
                "maturityDate": "12/01/2041",
                "primaryPurpose": "Consumer",
                "originalBalance": 20019.14,
                "currentBalance": 20019.14,
                "daysLate": 139,
                "nextDueDate": "05/01/2021",
                "noteRate": 0.05,
                "investorRate": 0.05,
                "totalPayment": 55.29,
                "loanStatus": "Assigned",
                "boardingDate": "10/31/2018",
                "closedDate": "n/a",
                "closedReason": null,
                "defaultInterestActiveStatus": "YES",
                "defaultInterestRate": 0,
                "defaultInterestActiveDate": "03/01/2021",
                "lenderOwnerPct": 90.917,
                "brokerName": "Centurion Test",
                "vendor": "Centurion Test",
                "restrictedFunds": 0.00,
                "reserveBalance": 40.46,
                "escrowBalance": 0,
         

... truncated: 4955 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

**Example — Loan Portfolio search by address**

```graphql
{
  getLoanPortfolio(propertyStreet:"123 Main Street")
  {
    loanAccount
    lenderAccount
    prevServiceAccount
    origLender
    investorAssetNumber
    name
    city
    state
    maturityDate
    primaryPurpose
    originalBalance
    currentBalance
    daysLate
    nextDueDate
    noteRate
    investorRate
    totalPayment
    loanStatus
    boardingDate
    closedDate
    closedReason
    defaultInterestActiveStatus
    defaultInterestRate
    defaultInterestActiveDate
    lenderOwnerPct
    brokerName
    vendor
    restrictedFunds
    reserveBalance
    drawStatus
    maximumDraw
    fundedAmount
    drawAvailableBalance
    escrowBalance
    appCreationDate
    property{
        city
        state
        street
        zipCode
    }
  }
}
```

```json
{
    "data": {
        "getLoanPortfolio": [
            {
                "loanAccount": "test8180",
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "prevServiceAccount": null,
                "origLender": "Vtest1234",
                "investorAssetNumber": null,
                "name": "Tester, Test",
                "city": "Anaheim",
                "state": "CA",
                "maturityDate": "12/01/2041",
                "primaryPurpose": "Consumer",
                "originalBalance": 20019.14,
                "currentBalance": 20019.14,
                "daysLate": 159,
                "nextDueDate": "05/01/2021",
                "noteRate": 0.05,
                "investorRate": 0.05,
                "totalPayment": 55.29,
                "loanStatus": "Delinquency",
                "boardingDate": "10/31/2018",
                "closedDate": "n/a",
                "closedReason": null,
                "defaultInterestActiveStatus": "YES",
                "defaultInterestRate": 0,
                "defaultInterestActiveDate": "03/01/2021",
                "lenderOwnerPct": 90.917,
                "brokerName": "Centurion Test",
                "vendor": "Centurion Test",
                "restrictedFunds": 0,
                "reserveBalance": 2,
                "drawStatus": "",
                "maximumDraw": null,
                "fundedAmount": 0,
                "drawAvailableBalance": null,
                "appCreationDate": "10/05/2023",
                "property": [
                    {
                        "city": "Anaheim",
                        "state": "CA",
                        "street": "123 Main Street",
                        "zipCode": "92808"
                    }
                ]
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Portfolio - Broker

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getBrokerLoanPortfolio`

**FCI's notes (filters, parameters, enum legends):**

```
To map you fields from the following lender portal screens, by default this API will list only all the active loans in your portfolio, use the parameters below to change the data that the API will show.

getBrokerLoanPortfolio {.......}

getBrokerLoanPortfolio(investor:"investor")

Parameters

investor: Optional

account: Optional

Limit: Optional

boardingDate: Optional

includeInactive Optional
-true: shows all the inactive loans
-false: shows all the active loans

includeUPB:true will show active loans with 0 UPB

dayslate: Optional (shows loans with daysLate equal or greater than the number specify on this parameter)

propertyStreet: “7 characters minimum“

propertyCity: “4 characters minimum“

propertyState: “Exact match, 2 characters“ example (CA, AZ)

propertyZip: “Exact match, 5 characters“ example (90045, 20155)

Query Options:

getBrokerLoanPortfolio {.......}

getBrokerLoanPortfolio (includeInactive:true) {.......}

getBrokerLoanPortfolio (dayslate:2){.......}

getBrokerLoanPortfolio (includeUPB:true){.......}

getBrokerLoanPortfolio(account:"testaccount"){ .......... }

getBrokerLoanPortfolio(investor:"investor"){ .......... }

getBrokerLoanPortfolio(boardingDate:"01/01/2000"){ .......... }

getBrokerLoanPortfolio(account:"testaccount" investor:"investor"){ .......... }
```

**Example — Loan Portfolio - Broker**

```graphql
{
  getBrokerLoanPortfolio(includeUPB:true)
  {
    loanAccount
    lenderAccount
    lenderName
    prevServiceAccount
    origLender
    investorAssetNumber
    name
    city
    state
    maturityDate
    primaryPurpose
    originalBalance
    currentBalance
    daysLate
    nextDueDate
    noteRate
    investorRate
    totalPayment
    loanStatus
    boardingDate
    closedDate
    closedReason
    originationDate
    defaultInterestActiveStatus
    defaultInterestRate
    defaultInterestActiveDate
    lenderOwnerPct
    brokerName
    vendor
    restrictedFunds
    fundedAmount
    appCreationDate
    propertyType
    property{
        city
        state
        street
        zipCode
    }
  }
}
```

```json
{
    "data": {
        "getBrokerLoanPortfolio": [
            {
                "loanAccount": "AA006100",
                "lenderAccount": "test8081",
                "lenderName": "ABC Bank",
                "prevServiceAccount": null,
                "origLender": "",
                "investorAssetNumber": null,
                "name": "HOMES LLC",
                "city": "",
                "state": null,
                "maturityDate": "06/18/2023",
                "primaryPurpose": "Business",
                "originalBalance": 0,
                "currentBalance": 0,
                "daysLate": 1231,
                "nextDueDate": "06/19/2020",
                "noteRate": 0,
                "investorRate": 0,
                "totalPayment": 0,
                "loanStatus": "Delinquency",
                "boardingDate": "06/19/2020",
                "closedDate": "n/a",
                "closedReason": null,
                "originationDate": "06/18/2020",
                "defaultInterestActiveStatus": "NO",
                "defaultInterestRate": 0,
                "defaultInterestActiveDate": "n/a",
                "lenderOwnerPct": 0,
                "brokerName": "ABC Bank",
                "vendor": null,
                "restrictedFunds": 0,
                "fundedAmount": 0,
                "appCreationDate": "10/05/2023",
                "property": []
            },
            {
                "loanAccount": "G17109003",
                "lenderAccount": "test8082",
                "lenderName": "ABC Bank",
                "prevServiceAccount": "G17109003",
                "origLender": "HOMES",
                "investorAssetNumber": null,
                "name": "NAME LLC",
                "city": "Los Angeles",
                "state": "CA",
                "maturityDate": "10/01/2021",
                "primaryPurpose": "Business",
                "originalBalance": 1440000,
                "currentBalance": 1440000,
                "daysLate": 580,
                "nextDueDate": "04/01/2022",
                "noteRate": 7.5,
                "investorRate": 7.5,
                "totalPayment": 21000,
                "loanStatus": "FORECLOSURE",
                "boardingDate": "01/25/2018",
                "closedDate": "n/a",
                "closedReason": null,
                "originationDate": "01/23/2018",
                "defaultInterestActiveStatus": "NO",
                "defaultInterestRate": 17.5,
                "defaultInterestActiveDate": "n/a",
                "lenderOwnerPct": 100,
                "brokerName": "ABC Bank",
                "vendor": "HOMES, Inc.",
                "restrictedFunds": 0,
                "fundedAmount": 0,
                "appCreationDate": "10/05/2023",
                "property": [
                    {
                        "city": "Los Angeles",
                        "state": "CA",
                        "street": "001 Avenue",
                        "zipCode": "90291"
       

... truncated: 4477 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Assigned Lender Accounts - Broker

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getAssignedAccounts`

**FCI's notes (filters, parameters, enum legends):**

```
This method helps map the lender accounts assigned to a broker account.

getAssignedAccounts {.......}

Parameters

account: Optional

fullName: Optional

isActive: Optional

Query Options:

getAssignedAccounts {.......}
```

**Example — Loan Portfolio - Broker Copy**

```graphql
{
  getAssignedAccounts {
        account
        fullName
        isActive
    }
}
```

```json
{
    "data": {
        "getAssignedAccounts": [
            {
                "account": "Vtest1234",
                "fullName": "Centurion Test",
                "isActive": false
            },
            {
                "account": "Test1234",
                "fullName": "Centurion Test",
                "isActive": true
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Updated Loan Portfolio List

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getUpdatedLoanList`

**FCI's notes (filters, parameters, enum legends):**

```
To get the list of updated loans on your portfolio.

Parameters

hoursago: indicate the amount of hours to consider on the search of updated loans

Query Options:

getUpdatedLoanList(hoursago:24) {.......}
```

**Example — Updated Loan Portfolio List**

```graphql
{
  getUpdatedLoanList(hoursago:100)
  {
    loanAccount
  }
}
```

```json
{
    "data": {
        "getUpdatedLoanList": [
            {
                "loanAccount": "Test12345"
            },
            {
                "loanAccount": "Test123"
            },
            {
                "loanAccount": "Test8180"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Details

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanDetails`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Details**

```graphql
{
  getLoanDetails(account:"test8180"){
    account
    aCHStatus
    aCHStatusEnum
    aRMName
    aRMOptionActive
    borrowerEmail
    borrowerFax
    borrowerFullName
    borrowerFirstName
    borrowerLastName
    borrowerHomePhone
    borrowerMailingAddress
    borrowerMobilePhone
    borrowerTIN
    borrowerTINMask
    borrowerTINParse
    borrowerTINType
    borrowerWorkPhone
    borrowerZip
    coBorrower
    deferredUnpaidLateCharges
    deferredPrinBal
    deferredUnpaidInt
    fciServiceProgram
    escrowBalance
    floatCapForNegAmort
    floatCapForPayment
    floatCeiling
    floatDaysAfterPymtChange
    floatDaysAfterRateChange
    floatEnabledPymtAdj
    floatEnableFirstRateCap
    floatEnableRecast
    floatEnableSurplus
    floatFirstRateMaxCap
    floatFirstRateMinCap
    floatFloor
    floatFreqPymtChange
    floatFreqRateChange
    floatFreqRecast
    floatIndex
    floatLastRecast
    floatMargin
    floatNextAdjPayment
    floatPeriodicMaxCap
    floatPeriodicMaxCap
    floatRoundMethod
    floatRoundRateFactor
    floatSendNotice
    floatStopRecast
    floatSurplus
    isOnHold
    graceDays
    minimunLateCharges
    lateChargesPct
    lienPosition
    loanMaturity
    nextPaymentDue
    noteRate
    noteType
    noteTypeEnum
    originalLoanAmount
    loanOrigination
    loanPayoff
    paidToDate
    payment
    escrowPayment
    paymentOthers
    suspensePayment
    currentLoanAmount
    propertyCity
    propertyState
    propertyStreet
    propertyZip
    rateType
    rateTypeEnum
    suspenseBalance
    restrictedSuspense
    investorRate
    status
    statusEnum
    unearnedDiscount
    unpaidInterest
    unpaidLateCharges
    defaultRate
    accruedLateCharges
    loanCharges
    deferredUnpaidLoanCharges
    seniorloanAmounts
    totalPayment
    drawStatus
    closeDate
    maximumDraw
    fundedAmount
    avaliableBalance
    propertyType
    uRLEppraisal
    uRLForeclosures
    uRLGoogle
    uRLListings
    prepymtExpDate
    prepymtPenalty
    prepymtCompanyPct
    prepymtVendorPerc
    prepymtInvestorPerc
    defaultIntCompanyPct
    defaultIntLenderPct
    defaultIntCompanyMaxDist
    defaultIntVendorPct
  }
}
```

```json
{
    "data": {
        "getLoanDetails": {
            "account": "test8180",
            "aCHStatus": 2,
            "aCHStatusEnum": "CANCELLED",
            "aRMName": "",
            "aRMOptionActive": false,
            "borrowerEmail": "timgri9@gmail.com",
            "borrowerFax": null,
            "borrowerFullName": "TestFName TesterLastName",
            "borrowerFirstName": "TestFName",
            "borrowerLastName": "TesterLastName",
            "borrowerHomePhone": "(714)408-5825",
            "borrowerMailingAddress": "8195 E Kaiser Blvd.., Anaheim, CA, 92808",
            "borrowerMobilePhone": "(657)244-9732;(714)271-7641;(714)932-8013",
            "borrowerTIN": "***-**-6789",
            "borrowerTINMask": "6789",
            "borrowerTINParse": "123456789",
            "borrowerTINType": 1,
            "borrowerWorkPhone": "(805)853-1337;(206)219-0789",
            "borrowerZip": "92808",
            "coBorrower": "",
            "deferredUnpaidLateCharges": 0.0000,
            "deferredPrinBal": 0.0000,
            "deferredUnpaidInt": 0.0000,
            "fciServiceProgram": "Standard Servicing",
            "escrowBalance": 0.0000,
            "floatCapForNegAmort": null,
            "floatCapForPayment": null,
            "floatCeiling": null,
            "floatDaysAfterPymtChange": 0,
            "floatDaysAfterRateChange": 0,
            "floatEnabledPymtAdj": false,
            "floatEnableFirstRateCap": false,
            "floatEnableRecast": false,
            "floatEnableSurplus": false,
            "floatFirstRateMaxCap": null,
            "floatFirstRateMinCap": null,
            "floatFloor": 0,
            "floatFreqPymtChange": 0,
            "floatFreqRateChange": 0,
            "floatFreqRecast": 0,
            "floatIndex": 0,
            "floatLastRecast": null,
            "floatMargin": 0,
            "floatNextAdjPayment": null,
            "floatPeriodicMaxCap": null,
            "floatRoundMethod": 0,
            "floatRoundRateFactor": 0.0000,
            "floatSendNotice": true,
            "floatStopRecast": null,
            "floatSurplus": 0.0000,
            "isOnHold": false,
            "graceDays": 15,
            "minimunLateCharges": 0.0000,
            "lateChargesPct": 4,
            "lienPosition": 1,
            "loanMaturity": "12/31/2060",
            "nextPaymentDue": "11/01/2025",
            "noteRate": 15,
            "noteType": 1,
            "noteTypeEnum": "CONVENTIONAL",
            "originalLoanAmount": 10000.0000,
            "loanOrigination": "10/01/2018",
            "loanPayoff": "n/a",
            "paidToDate": "10/01/2025",
            "payment": 141.7500,
            "escrowPayment": 0.0000,
            "paymentOthers": 0.0000,
            "suspensePayment": 0.0000,
            "currentLoanAmount": 21020.1400,
            "propertyCity": "Fairfield",
            "propertyState": "CT",
            "propertyStreet": "123 Main Street",
            "propertyZip": "06824

... truncated: 4551 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Loan Properties

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanProperties`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Properties**

```graphql
{
  getLoanProperties (account: "test8180") {
    street 
    city 
    state 
    zipCode
    propertyDrawAmountFunded 
    propertyDrawCurrentBalance 
    propertyMinimumReleaseAmount 
    propertyMaximumReleaseAmount 
    isPrimary 
    occupancyStatus 
    priority 
    status 
    description 
    propertyType 
    valuationOriginalAmount 
    valuationType 
    valuationDate 
    loanPropertyValue
  }
}
```

```json
{
    "data": {
        "getLoanProperties": [
            {
                "street": "123 Main Street",
                "city": "Columbus",
                "state": "OH",
                "zipCode": "43224",
                "propertyDrawAmountFunded": 0.0000,
                "propertyDrawCurrentBalance": 0.0000,
                "propertyMinimumReleaseAmount": 0.0000,
                "propertyMaximumReleaseAmount": 0.0000,
                "isPrimary": true,
                "occupancyStatus": "PRIMARY BORROWER",
                "priority": "ONE",
                "status": "UNKNOWN",
                "description": "",
                "propertyType": "SINGLE FAMILY RES",
                "valuationOriginalAmount": 1996000.0000,
                "valuationType": "AVM",
                "valuationDate": "09/01/2025",
                "loanPropertyValue": 1.278539078156313
            },
            {
                "street": "456 tes",
                "city": "Columbus",
                "state": "OH",
                "zipCode": "43224",
                "propertyDrawAmountFunded": 0.0000,
                "propertyDrawCurrentBalance": 0.0000,
                "propertyMinimumReleaseAmount": 0.0000,
                "propertyMaximumReleaseAmount": 0.0000,
                "isPrimary": false,
                "occupancyStatus": "PRIMARY BORROWER",
                "priority": "ONE",
                "status": "UNKNOWN",
                "description": null,
                "propertyType": "SINGLE FAMILY RES",
                "valuationOriginalAmount": 0.0000,
                "valuationType": "ORIGINAL APPRAISA",
                "valuationDate": "n/a",
                "loanPropertyValue": 1.278539078156313
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Attachments

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanAttachments`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Attachments**

```graphql
{
  getLoanAttachments(account:"test8180")
  {
    loanUid
    account
    name
    type
    date
  }
}
```

```json
{
    "data": {
        "getLoanAttachments": [
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "Payment Statement Report-20221221.pdf",
                "type": "PAYMENT STATEMENT",
                "date": "12/21/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "NSF Payment Report-20221205.pdf",
                "type": "OTHER",
                "date": "12/05/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "Payment Statement Report-20221121.pdf",
                "type": "PAYMENT STATEMENT",
                "date": "11/21/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "Unsigned Demand Payoff-20221118.pdf",
                "type": "PAY OFF NOTICE",
                "date": "11/18/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "Unsigned Demand Payoff-20221116.pdf",
                "type": "PAY OFF NOTICE",
                "date": "11/16/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "ACH Online Payment Terms -20221115.pdf",
                "type": "OTHER",
                "date": "11/15/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "ACH Online Payment Terms -20221115.pdf",
                "type": "OTHER",
                "date": "11/15/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "Payment Statement Report-20221021.pdf",
                "type": "PAYMENT STATEMENT",
                "date": "10/21/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "Payment Statement Report-20220921.pdf",
                "type": "PAYMENT STATEMENT",
                "date": "09/21/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "ACH Online Payment Terms -2022918.pdf",
                "type": "OTHER",
                "date": "09/18/2022"
            },
            {
                "loanUid": "3c385767eefa405d8a9037d802ae4c7e",
                "account": "test8180",
                "name": "399381234_Servicing Agreement - Program Select - Lender_1707810-107.pdf",
                "ty

... truncated: 62886 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Loan Funding Information

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getFundingInformation`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Funding Information**

```graphql
{
  getFundingInformation(account:"test8180"){
    
    lenderAccount
    lenderName
    amountFunded
    percentageOwned
    investorRate
    currentBalance
    paymentInformation
    isEnabled
    account_lender_to_vendor
    principal_balance_lender_to_vendor_pct
  }
}
```

```json
{
    "data": {
        "getFundingInformation": [
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "amountFunded": 20519.64,
                "percentageOwned": 80.41,
                "investorRate": 15,
                "currentBalance": 20519.64,
                "paymentInformation": 113.98,
                "isEnabled": "No",
                "account_lender_to_vendor": null,
                "principal_balance_lender_to_vendor_pct": "0%"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Borrower Payments

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getBorrowerPayment`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

This method only brings the data from the last 12 months, if you need prevous data please use the parameter dateFrom.

Parameters

account: Optional

excludeFunding: True or False Optional

dateFrom: Optional

dateTo: Optional

appCreationDate:"YYYY-DD-MM"

Query Options:

getBorrowerPayment{......}
getBorrowerPayment (appCreationDate:"YYYY-DD-MM"){......}

getBorrowerPayment(dateFrom:"05-05-2021" dateTo:"05-06-2021") {…. }

getBorrowerPayment(account:"test8180" excludeFunding:true dateFrom:"01-05-2020" dateTo:"05-06-2021"){
```

**Example — Borrower Payments**

```graphql
{
  getBorrowerPayment(account:"test8180" excludeFunding:true){
    account
    appCreationDate
    investAssetNumber
    dateReceived
    dateDue
    dayVariance
    reference
    isACH
    paymentType
    reserveRestricted
    totalAmount
    toInterest
    toPrincipal
    accruedLateCharges
    lateChargesPaid
    toReserve
    toEscrow
    toPrepay
    toChargesPrincipal
    toChargesInterest
    toBrokerFee
    toLenderFee
    toOtherTaxable
    toOtherTaxFree
    toOtherPayments
    toUnpaidInterest
    notes
    uid
  }
}
```

```json
{
    "data": {
        "getBorrowerPayment": [
            {
                "account": "test8180",
                "appCreationDate": "2020-11-09",
                "investAssetNumber": "12345",
                "dateReceived": "2022-09-18",
                "dateDue": "2022-09-18",
                "dayVariance": 0,
                "reference": "V000146779",
                "isACH": false,
                "paymentType": "OtherCash",
                "reserveRestricted": 0,
                "totalAmount": -0.5,
                "toInterest": 0,
                "toPrincipal": 0,
                "accruedLateCharges": 0,
                "lateChargesPaid": 0,
                "toReserve": -0.5,
                "toEscrow": 0,
                "toPrepay": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toBrokerFee": 0,
                "toLenderFee": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toUnpaidInterest": 0,
                "notes": "Reversed by vsumathi on 9/18/2022 3:52:32 PM",
                "uid": "062d6c57c17d463ea5209e182a633a40"
            },
            {
                "account": "test8180",
                "dateReceived": "2022-09-18",
                "dateDue": "2022-09-18",
                "dayVariance": 0,
                "reference": "V000146779",
                "isACH": false,
                "paymentType": "OtherCash",
                "reserveRestricted": 0,
                "totalAmount": 0.5,
                "toInterest": 0,
                "toPrincipal": 0,
                "accruedLateCharges": 0,
                "lateChargesPaid": 0,
                "toReserve": 0.5,
                "toEscrow": 0,
                "toPrepay": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toBrokerFee": 0,
                "toLenderFee": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toUnpaidInterest": 0,
                "notes": null,
                "uid": "67ee18df248e452aa249f8fe03d21824"
            },
            {
                "account": "test8180",
                "dateReceived": "2022-09-18",
                "dateDue": "2022-09-18",
                "dayVariance": 0,
                "reference": "V000146779",
                "isACH": false,
                "paymentType": "OtherCash",
                "reserveRestricted": 0,
                "totalAmount": 0.5,
                "toInterest": 0,
                "toPrincipal": 0,
                "accruedLateCharges": 0,
                "lateChargesPaid": 0,
                "toReserve": 0.5,
                "toEscrow": 0,
                "toPrepay": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toBrokerFee": 0,
                "toLenderFee": 0,
                "toOthe

... truncated: 42763 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Payment to Lenders

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPaymentListToLender`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

onlyPending: Optional

Limit: Optional

dateFrom: Optional

dateTo: Optional

Query Options:

getPaymentListToLender{......}

getPaymentListToLender(dateFrom:"05-05-2021" dateTo:"05-06-2021"){......}

getPaymentListToLender(account:"test8180"){ ......}

getPaymentListToLender(investor:"investor"){ ......}

getPaymentListToLender(investor:"investor" limit:100){......}
```

**Example — Payment to Lenders**

```graphql
{
  getPaymentListToLender(account:"test8180"){
   checkDate
   checkNo
   checkMemo
   account
   lenderAccount
   investorAssetNumber
   paymentDue
   paymentDate
   paymentType
   checkAmount
   toServiceFee
   toInterest
   toPrincipal
   toLateCharge
   toChargesInterest
   toPrepay
   toOtherTaxable
   toOtherTaxFree
   toOtherPayments
   toTrust
   defaultInterest
   noteInterest
   toEscrowAdvRepymt
  }
}
```

```json
{
    "data": {
        "getPaymentListToLender": [
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "investorAssetNumber": "testinvestor",
                "paymentDue": "05/01/2026",
                "paymentDate": "05/04/2026",
                "paymentType": "RegPmt",
                "checkAmount": 0.77,
                "toServiceFee": -15,
                "toInterest": 15.77,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toTrust": 0,
                "defaultInterest": 0,
                "noteInterest": 15.77,
                "toEscrowAdvRepymt": 0.00
            },
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "investorAssetNumber": "testinvestor",
                "paymentDue": "05/01/2026",
                "paymentDate": "05/04/2026",
                "paymentType": "RegPmt",
                "checkAmount": -0.77,
                "toServiceFee": 15,
                "toInterest": -15.77,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toTrust": 0,
                "defaultInterest": 0,
                "noteInterest": -15.77,
                "toEscrowAdvRepymt": 0.00
            },
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "investorAssetNumber": "testinvestor",
                "paymentDue": "05/01/2026",
                "paymentDate": "05/04/2026",
                "paymentType": "RegPmt",
                "checkAmount": 1.68,
                "toServiceFee": -15,
                "toInterest": 16.68,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toTrust": 0,
                "defaultInterest": 0,
                "noteInterest": 16.68,
                "toEscrowAdvRepymt": 0.00
            },
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Ch

... truncated: 12243 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Loan Notes

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getNotes`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

getNotes (account:"test8180"){.....}

getNotes(investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

Parameters

investor: Optional

account: Optional

dateFrom: Optional

dateTo: Optional

type: Optional

Limit: Optional

Query Options:

getNotes{.....}

getNotes(investor:"all" ){.....}

getNotes(investor:"test1234" ){.....}

getNotes(investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getNotes(account:"tes8180" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getNotes(account:"tes8180" dateFrom:"01/01/2020" dateTo:" 12/31/2020 type:"collector""){...}
```

**Example — Loan Notes**

```graphql
{
  getNotes(investor:"all"){
    account
    noteDate
    fciRep
    contactNumber
    subject
    noteType
    contactPerson
    note
    borrowerFullName
  }
}
```

```json
{
    "data": {
        "getNotes": [
            {
                "account": "test8180",
                "noteDate": "06/03/2021",
                "fciRep": "llopez",
                "contactNumber": "",
                "subject": "SUNWEST BANK NSF NOTICE FOR ACH DEBIT",
                "noteType": "NSF",
                "contactPerson": "",
                "note": "REC'D emailed NOTICE FROM SUNWEST BANK THAT ACH DEBIT REF# ( V000003713/0042 ) FOR ($60.81 ) HAS COME BACK AS NO ACCOUNT/UNABLE TO LOCATE ACCOUNT & HAS BEEN CHARGED BACK TO OUR ACCOUNT.  PYMT NSF'ED.  PAYMENT REJECTION LETTER PRINTED & MAILED TO BORROWER.  COPY OF BORROWER LETTER & BANK NOTICE. ATTACHED TO FILE.\r\n",
                "borrowerFullName": "test tester"
            },
            {
                "account": "test8180",
                "noteDate": "05/28/2021",
                "fciRep": "admin",
                "contactNumber": "",
                "subject": "[ExpPmt] ACH Online Confirmation V000003713",
                "noteType": "CALL CENTER",
                "contactPerson": "",
                "note": "Payment Information\r\nACH Online Confirmation: V000003713\r\nType: Regular Payment\r\n\r\nRegular Payment - Account: test8180: $60.81\r\n\r\n Total Amount: $60.81\r\n\r\n Notes:\r\ntest8180\nStandard Servicing\nAutomatic Process by FCI",
                "borrowerFullName": "test tester"
            },
            {
                "account": "test8180",
                "noteDate": "05/14/2021",
                "fciRep": "llopez",
                "contactNumber": "",
                "subject": "SUNWEST BANK NSF NOTICE FOR ACH DEBIT",
                "noteType": "NSF",
                "contactPerson": "",
                "note": "REC'D emailed NOTICE FROM SUNWEST BANK THAT ACH DEBIT REF# ( V000001270/0536 ) FOR ($60.81 ) HAS COME BACK AS NO ACCOUNT/UNABLE TO LOCATE ACCOUNT & HAS BEEN CHARGED BACK TO OUR ACCOUNT.  PYMT NSF'ED.  PAYMENT REJECTION LETTER PRINTED & MAILED TO BORROWER.  COPY OF BORROWER LETTER & BANK NOTICE. ATTACHED TO FILE.\r\n",
                "borrowerFullName": "test tester"
            },
            {
                "account": "test8180",
                "noteDate": "05/13/2021",
                "fciRep": "Centurion",
                "contactNumber": "",
                "subject": "Call Information from VA",
                "noteType": "COLLECTOR NOTES",
                "contactPerson": "",
                "note": "Subject: Call Information from VA\r\nCaller ID: (657) 244-9732\r\nCallerUID: c6ae10c9-b43e-11eb-ac45-506b8d66086d\r\nIs Voice Biometric: False\r\nIndividualUID: 1dfeb441c1bc418f86575880b777e345\r\nFirst Name: test\r\nLast Name: tester\r\nLast 4 TIN: 6789\r\nZip Code: 92808\r\nLoan Account: test8180\r\nLoan Status: Active\r\nIntent Name: Borrower-Check By Phone - Confirm Mini Miranda\r\nReason Call: Confirm Check Number Failure\r\n",
                "borrowerFullName": "test tester"
            },
            {
                "account"

... truncated: 137089 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Lender Statements

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLenderStatement`

**FCI's notes (filters, parameters, enum legends):**

```
To map you fields from the following lender portal screens, use this API method:

getLenderStatement {.......}

Parameters

investorAccount: Optional

dateFrom: Optional

dateTo: Optional

*If no filter is used the method will provide all the lender statements for the previous month only

Query Options:

getLenderStatement {.......}

getLenderStatement(dateFrom:"02/01/2024") {.......}

getLenderStatement(dateTo:"03/01/2024") {.......}

getLenderStatement(investorAccount: "2301524") {.......}

getLenderStatement(dateFrom:"02/01/2024", investorAccount: "2301524", dateTo:"03/01/2024") {.......}
```

**Example — Lender Statements**

```graphql
{
    getLenderStatement{
        lenderAccount
        lenderName
        portfolioBalance
        portfolioYield
        date
        description
    }
}
```

```json
{
    "data": {
        "getLenderStatement": [
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "date": "06/06/2022",
                "description": "Investor Statement Of Account Report-20220606-125439-SVRCENTPS01",
                "portfolioBalance": 0,
                "portfolioYield": 0,
                "interestPaid": 0,
                "principalPaid": 0,
                "interestPaidYtd": 0,
                "servicingFeePaidYtd": 0
            },
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "date": "05/01/2022",
                "description": "Investor Statement Of Account Report-20220501-23337-SVRCENTPS01",
                "portfolioBalance": 0,
                "portfolioYield": 0,
                "interestPaid": 0,
                "principalPaid": 0,
                "interestPaidYtd": 0,
                "servicingFeePaidYtd": 0
            },
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "date": "04/01/2022",
                "description": "Investor Statement Of Account Report-20220401-215822-SVRCENTPS01",
                "portfolioBalance": 0,
                "portfolioYield": 0,
                "interestPaid": 0,
                "principalPaid": 0,
                "interestPaidYtd": 0,
                "servicingFeePaidYtd": 0
            },
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "date": "03/10/2022",
                "description": "Investor Statement Of Account Report-20220310-194455-SVRCENTPS01",
                "portfolioBalance": 0,
                "portfolioYield": 0,
                "interestPaid": 0,
                "principalPaid": 0,
                "interestPaidYtd": 0,
                "servicingFeePaidYtd": 0
            },
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "date": "02/01/2022",
                "description": "Investor Statement Of Account Report-20220201-213834-SVRCENTPS01",
                "portfolioBalance": 0,
                "portfolioYield": 0,
                "interestPaid": 0,
                "principalPaid": 0,
                "interestPaidYtd": 0,
                "servicingFeePaidYtd": 0
            },
            {
                "lenderAccount": "Test1234",
                "lenderName": "Centurion Test",
                "date": "01/14/2022",
                "description": "Investor Statement Of Account Report-20220114-13038-SVRCENTPS01",
                "portfolioBalance": 0,
                "portfolioYield": 0,
                "interestPaid": 0,
                "principalPaid": 0,
                "interestPaidYtd": 0,
                "servicingFeePaidYtd": 0
            },
            {
                "lenderAccount

... truncated: 4427 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Loan Charges

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanCharges`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

getLoanCharges(account:"test8180"){ ......}

getLoanCharges(investor:"investor" limit:100){......}

Parameters

investor: Optional

account: Optional

Limit: Optional

Query Options:

getLoanCharges{......}

getLoanCharges(account:"test8180"){ ......}

getLoanCharges(investor:"investor"){ ......}

getLoanCharges(investor:"investor" limit:100){......}
```

**Example — Loan Charges**

```graphql
{
  getLoanCharges(account:"test8180"){
    loanAccount
    date
    reference
    description
    type
    interestRate
    interestFrom
    deferred
    origianlBalance
    unpaidBalance
    accruedInterest
    totalDue
    details{
      date
      payerName
      reference
      amount
      prinVendor
      intVendor
      prinBehalf
      intBehalf
    }
  }
}
```

```json
{
    "data": {
        "getLoanCharges": [
            {
                "loanAccount": "test8180",
                "date": "06/17/2021",
                "reference": "Ach CBP",
                "description": "Ach Payment Confirmation 8233 - CBP Fee",
                "type": "Recoverable",
                "interestRate": 0,
                "interestFrom": null,
                "deferred": false,
                "origianlBalance": 1,
                "unpaidBalance": 0,
                "accruedInterest": 0,
                "totalDue": 0,
                "details": [
                    {
                        "date": "06/17/2021",
                        "payerName": "F.C.I.",
                        "reference": "",
                        "amount": 1,
                        "prinVendor": 1,
                        "intVendor": 0,
                        "prinBehalf": 0,
                        "intBehalf": 0
                    },
                    {
                        "date": "06/17/2021",
                        "payerName": "F.C.I.",
                        "reference": "V000008233",
                        "amount": -1,
                        "prinVendor": -1,
                        "intVendor": 0,
                        "prinBehalf": 0,
                        "intBehalf": 0
                    }
                ]
            },
            {
                "loanAccount": "test8180",
                "date": "06/02/2021",
                "reference": "",
                "description": "NSF Payment Charge - NSF Payment Charge",
                "type": "Recoverable",
                "interestRate": 0,
                "interestFrom": null,
                "deferred": false,
                "origianlBalance": 25,
                "unpaidBalance": 25,
                "accruedInterest": 0,
                "totalDue": 25,
                "details": [
                    {
                        "date": "06/02/2021",
                        "payerName": "F.C.I.",
                        "reference": "",
                        "amount": 25,
                        "prinVendor": 25,
                        "intVendor": 0,
                        "prinBehalf": 0,
                        "intBehalf": 0
                    }
                ]
            },
            {
                "loanAccount": "test8180",
                "date": "05/12/2021",
                "reference": "",
                "description": "NSF Payment Charge - NSF Payment Charge",
                "type": "Recoverable",
                "interestRate": 0,
                "interestFrom": null,
                "deferred": false,
                "origianlBalance": 25,
                "unpaidBalance": 25,
                "accruedInterest": 0,
                "totalDue": 25,
                "details": [
                    {
                        "date": "05/12/2021",
                        "payerName": "F.C.I.",
                        "reference": "",
               

... truncated: 9314 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Loan Charges Details

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanChargesDetails`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

getLoanChargesDetails(dateFrom:"MM-DD-YYYY" dateTo:"MM-DD-YYYY"){ }

Parameters

dateFrom:"MM-DD-YYYY"

dateTo:"MM-DD-YYYY"

Query Options:

getLoanChargesDetails(dateFrom:"MM-DD-YYYY" dateTo:"MM-DD-YYYY"){ }
```

**Example — Loan Charges Details**

```graphql
{
  getLoanChargesDetails(dateFrom:"01-13-2017" dateTo:"01-01-2020"){
    chargeUid
    chargeCode
    chargeName
    paymentUid
    invetorUid
    investorAccount
    loanUid
    loanAccount
    behalfToUid
    behalfAccount
    chargeDate
    reference
    description
    interestRate
    interestFrom
    deferred
    originalBalance
    unpaidBalance
    accruedInterest
    appCreationDate
    totalDue
    chargeDateDetail
    referenceDetail
    descriptionDetail
    amountDetail
    principalVendorDetail
    interestVendorDetail
    principalBehalfDetail
    interestBehalfDetail
    }
}
```

```json
{
    "data": {
        "getLoanChargesDetails": [
            {
                "chargeUid": "90000c92243f449e91bf9a4a427d73c5",
                "chargeCode": "INAD104",
                "chargeName": "Prior Servicer Escrow Advances",
                "paymentUid": "22154ceabeb4d9daf5b0407775c54af",
                "invetorUid": "00ddeb4a00123d82a3c2704ff2453c99",
                "investorAccount": "test1234",
                "loanUid": "baf00123d82aa3588ff6375e000",
                "loanAccount": "test8180",
                "behalfToUid": null,
                "behalfAccount": null,
                "chargeDate": "12/17/2019",
                "reference": "BOARD",
                "description": "Prior Servicer Escrow Advances",
                "interestRate": 0,
                "interestFrom": "12/17/2020",
                "deferred": false,
                "originalBalance": 791.4100,
                "unpaidBalance": 791.4100,
                "accruedInterest": 0,
                "appCreationDate": "12/17/2020",
                "totalDue": 791.41,
                "chargeDateDetail": "09/27/2023",
                "referenceDetail": "",
                "descriptionDetail": "Origination",
                "amountDetail": 791.41,
                "principalVendorDetail": 791.41,
                "interestVendorDetail": 0.0000,
                "principalBehalfDetail": 0.0000,
                "interestBehalfDetail": 0.0000
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Charges History

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanChargesHistory`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

getLoanChargesHistory(dateFrom:"MM-DD-YYYY" dateTo:"MM-DD-YYYY"){ }

Data Legend

Type

0 = Origination

1 = Adjustment

2 = Payment

3 = Closed

4 = Waived

5 = Expired

Parameters

dateFrom:"MM-DD-YYYY"

dateTo:"MM-DD-YYYY"

Query Options:

getLoanChargesHistory(dateFrom:"MM-DD-YYYY" dateTo:"MM-DD-YYYY"){ }
```

**Example — Loan Charges History**

```graphql
{
  getLoanChargesHistory(dateFrom:"05-01-2021" dateTo:"01-01-2022"){
    loanAccount
    chargeActivityUid
    chargeUid
    borrowerPaymentUid
    chargeCode
    chargeName
    chargeDescription
    loanUid
    owedToAccountUid
    owedToAccount
    behalfToUid
    behalfAccount
    date
    interestRate
    paidBalance
    paidBalBehalf
    paidBalVendor
    paidIntBehalf
    paidInterest
    reference
    type
  }
}
```

```json
{
    "data": {
        "getLoanChargesHistory": [
            {
                "loanAccount": "test1234",
                "chargeActivityUid": "85116c8e85116c8e85116c8e85116c8e",
                "chargeUid": "74f4e4b774f4e4b774f4e4b774f4e4b7",
                "borrowerPaymentUid": null,
                "chargeCode": "VEFE108",
                "chargeName": "Extension Fee-To Vendor",
                "chargeDescription": "Extension Fee-To Vendor",
                "loanUid": "2084e32084e32084e32084e32084e3",
                "owedToAccountUid": "4B566F8B566F8B566F8B566F8B566F8",
                "owedToAccount": "TEST1234",
                "behalfToUid": null,
                "behalfAccount": null,
                "date": "12/29/2021",
                "interestRate": 0,
                "paidBalance": -460.1100,
                "paidBalBehalf": 0.0000,
                "paidBalVendor": -460.1100,
                "paidIntBehalf": 0.0000,
                "paidInterest": 0.0000,
                "reference": "",
                "type": 0
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Paid Charges & Other Charges

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPaidChargesAndOtherPayments`

**FCI's notes (filters, parameters, enum legends):**

```
This method allows you to link a borrower payment to a charge

getPaidChargesAndOtherPayments(chargeUid:"xxxxxxxxxxxxx"){}

Parameters

chargeUid: get it from getLoanChargesHistory method

paymentUid: get it from getLoanChargesDetails method.

Query Options:

getPaidChargesAndOtherPayments(chargeUid:"xxxxxxxxxxxxx"){}

getPaidChargesAndOtherPayments(paymentUid:"xxxxxxxxxxxxx"){}
```

**Example — Loan Paid Charges & Other Charges**

```graphql
{
  getPaidChargesAndOtherPayments(chargeUid:"e2df10ef4eea4791933c9424f370000"){
    paymentUid
    originalAmount
    amountPaid
    description
    codeCategory
    paymentDate
  }
}
```

```json
{
    "data": {
        "getPaidChargesAndOtherPayments": [
            {
                "paymentUid": "2266a44986ba456a864a8a4769d70000",
                "originalAmount": 1083.7,
                "amountPaid": -1083.7,
                "description": "Bankruptcy Attorney Fees",
                "codeCategory": "NO TAXABLE",
                "paymentDate": "01/21/2025"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Delinquency

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanDeliquency`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

Limit: Optional
```

**Example — Loan Delinquency**

```graphql
{
  getLoanDeliquency(account:"test8180" dateTo:"03-15-2021"){
    summary{
      status
      numberOfLoans
      principalBalance
      totalPercent
      upbPercent
    }
    detail{
      account
      borrowerName
      current
      nextDueDate
      principalBalance
      upb1to30
      upb31to60
      upb61to90
      upb121plus
    }
  }
}
```

```json
{
    "data": {
        "getLoanDeliquency": {
            "summary": [
                {
                    "status": "121+",
                    "numberOfLoans": 1,
                    "principalBalance": 60292281.37,
                    "totalPercent": 100,
                    "upbPercent": 100
                }
            ],
            "detail": [
                {
                    "account": "test8180",
                    "borrowerName": "test tester",
                    "current": 0,
                    "nextDueDate": "2002-05-01T00:00:00",
                    "principalBalance": 60292281.37,
                    "upb1to30": 0,
                    "upb31to60": 0,
                    "upb61to90": 0,
                    "upb121plus": 60292281.37
                }
            ]
        }
    }
}
```

### Pull API - FCI Web Loan Information / Loan Mod Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanModReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

Limit: Optional
```

**Example — Loan Mod Report**

```graphql
{
  getLoanModReport(dateFrom:"2019-01-01", dateTo: "2026-07-13"){
    loanID
    borrower
    originalBalance
    currentBalance
    originalRate
    newRate
    originalMaturity
    newMaturity
    modificationType
    modificationDate
    status
    }
}
```

```json
{
    "data": {
        "getLoanModReport": [
            {
                "loanID": "test8180",
                "borrower": "ABC Street LLC",
                "originalBalance": 0,
                "currentBalance": 0,
                "originalRate": 11.4500,
                "newRate": 12.44249,
                "originalMaturity": "2023-07-01T00:00:00.000-07:00",
                "newMaturity": "2023-07-01T00:00:00.000-07:00",
                "modificationType": 0,
                "modificationDate": "2023-04-01T00:00:00.000-07:00",
                "status": 2
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Portfolio Statistics

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanPortfolioStatistics`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Portfolio Statistics**

```graphql
{
  getLoanPortfolioStatistics
  {
  title
  data
    {
    title
    count
    countPercent
    upb
    upbPercent
    }
  }
}
```

```json
{
    "data": {
        "getLoanPortfolioStatistics": [
            {
                "title": "State",
                "data": [
                    {
                        "title": "CA",
                        "count": 1,
                        "countPercent": 100,
                        "upb": 20019.14,
                        "upbPercent": 100
                    },
                    {
                        "title": "Inactive",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    }
                ]
            },
            {
                "title": "Aging (Days)",
                "data": [
                    {
                        "title": "Current",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    },
                    {
                        "title": "16 - 30",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    },
                    {
                        "title": "31 - 60",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    },
                    {
                        "title": "61 - 90",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    },
                    {
                        "title": "91 - 120",
                        "count": 1,
                        "countPercent": 100,
                        "upb": 20019.14,
                        "upbPercent": 100
                    },
                    {
                        "title": "121 - 150",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    },
                    {
                        "title": "151 and over",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    },
                    {
                        "title": "Inactive",
                        "count": 0,
                        "countPercent": 0,
                        "upb": 0,
                        "upbPercent": 0
                    }
                ]
            },
            {
                "title": "Loan Age (Months)",
                "data": [
                    {
                        "title": "Less than 37",
                        "count": 1,
                        "countPercent": 100,
                        "upb": 20019.14,

... truncated: 13634 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Loan Status Breakdown

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanStatusBreakdown`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Status Breakdown**

```graphql
{
  getLoanStatusBreakdown
  {
    status
    totalLoans
    originalBalance
    principalBalance
  }
}
```

```json
{
    "data": {
        "getLoanStatusBreakdown": [
            {
                "status": "ASSIGNED",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Active",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Closed",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Paid Off",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Transfered",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Bankruptcy",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Foreclosure",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "REO",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Charge Off",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Complete Charge Off",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Transfer out",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Payoff Demand",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Pre Boarding",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Final Boarding",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "RESPA",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "Loss-Mit Request",
                "totalLoans": 0,
                "originalBalance": 0,
                "principalBalance": 0
            },
            {
                "status": "DELIQUENCY",
                "totalLoans": 1,
          

... truncated: 3111 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / ACH Status

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getACHStatus`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

account: Optional

Query Options:

getACHStatus) {.......}

getACHStatus(account:"test8180" ){ .......... }
```

**Example — ACH Status**

```graphql
{
  getACHStatus(account:"test8180" )
  {
    loanAccount
    achStatus
    borrowerName
    nextDebitDate
    customPayment
    paymentAmount
  }
}
```

```json
{
    "data": {
        "getACHStatus": [
            {
                "loanAccount": "test8180",
                "achStatus": "NONE",
                "borrowerName": "test tester",
                "nextDebitDate": "03/10/2021",
                "customPayment": "Fixed Amount",
                "paymentAmount": 60.81
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Foreclosure Timelines

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getForeclosure`

**Example — Loan Foreclosure**

```graphql
{
  getForeclosure(account:"test8180"){
    account
    property
    followUpDate
    foreclosureProccess
    referedForeclosure
    dateClosed
    reasonClosed
    referenceNo
    company
    phone
    overwriteTempo
    fcOnHold    
    referredToFC
    referredToAtty
    attyReceived
    noSent
    noExpires
    lastPmtReceived
    pullTitleActual
    pullTitleProjected
    complaintFiledActual
    complaintFiledProjected
    servedComplaintActual
    servedComplaintProjected
    judgmentFiledActual
    judgmentFiledProjected
    judgmentGrantedActual
    judgmentGrantedProjected
    saleDateActual
    saleDateProjected
    biddindInstructionsRequest
    biddindInstructionsSent
    saleResults
    saleAmount
    publicationSaleActual
    publicationSaleProjected
  }
}
```

```json
{
    "data": {
        "getForeclosure": [
            {
                "account": "test8180",
                "property": "123 Main Street",
                "followUpDate": "03/15/2021",
                "foreclosureProccess": 1,
                "referedForeclosure": "2018-12-19T00:00:00",
                "dateClosed": "n/a",
                "reasonClosed": "BK",
                "referenceNo": null,
                "company": "test tester company",
                "phone": "000-809-4002",
                "overwriteTempo": false,
                "fcOnHold": false,
                "referredToFC": "12/19/2018",
                "referredToAtty": "12/19/2018",
                "attyReceived": "12/20/2018",
                "noSent": "12/21/2018",
                "noExpires": "01/25/2019",
                "lastPmtReceived": "08/01/2018",
                "pullTitleActual": "n/a",
                "pullTitleProjected": "04/04/2021",
                "complaintFiledActual": "n/a",
                "complaintFiledProjected": "n/a",
                "servedComplaintActual": "n/a",
                "servedComplaintProjected": "n/a",
                "judgmentFiledActual": "n/a",
                "judgmentFiledProjected": "n/a",
                "judgmentGrantedActual": "n/a",
                "judgmentGrantedProjected": "n/a",
                "saleDateActual": "n/a",
                "saleDateProjected": "09/01/2021",
                "biddindInstructionsRequest": "n/a",
                "biddindInstructionsSent": "n/a",
                "saleResults": "",
                "saleAmount": 0.0000,
                "publicationSaleActual": "07/10/2024",
                "publicationSaleProjected": "07/08/2024"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan PreForeclosure Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPreForeclosure`

**FCI's notes (filters, parameters, enum legends):**

```
Parameters

account: Optional, without this filter will show report including all accounts

isClosed: Optional, by default set to False. Will include closed accounts
```

**Example — Loan PreForeclosure Report**

```graphql
{
    getPreForeclosure{
        account
        loanUid
        followUpDate
        lastReview
        property
        city
        state
        createdAt
        pfcRequired
        pfcStart
        pfcExpires
        noiSent
        noiExpires
        company
        phone
        referredToAtty
        attyNOISent
        attyReceived
        attyNOIExpires
        attyNOIRcvd
        closed
        referredToFC
        resolution
        pfcOpened
        pfcStatus
  }
}
```

```json
{
    "data": {
        "getPreForeclosure": [
            {
                "account": "test8180",
                "loanUid": "01d6a322c0c44cc6bXXXXab426d1b8b",
                "followUpDate": "n/a",
                "lastReview": "n/a",
                "property": "123 Main Street",
                "city": "Lake Harmony",
                "state": "PA",
                "createdAt": "06/20/2022",
                "pfcRequired": false,
                "pfcStart": "n/a",
                "pfcExpires": "n/a",
                "noiSent": "n/a",
                "noiExpires": "n/a",
                "company": "Test Tester GROUP LLC",
                "phone": "000-000-1234",
                "referredToAtty": "n/a",
                "attyNOISent": "06/13/2022",
                "attyReceived": "n/a",
                "attyNOIExpires": "06/23/2022",
                "attyNOIRcvd": "06/20/2022",
                "closed": "08/15/2022",
                "referredToFC": "n/a",
                "resolution": "OTHER",
                "pfcOpened": "n/a",
                "pfcStatus": "Inactive"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Default Interest Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLenderDefaultInterestReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional, without this filter will show report including all investors

dateFrom: Optional, default is last 6 months if filter is not used.

dateTo: Optional, default is today if filter is not used.

Query Options:

getLenderDefaultInterestReport{..........}

getLenderDefaultInterestReport(investor:"Investor" ){.........}

getLenderDefaultInterestReport(investor:"Investor" dateFrom:"01-01-2021" ){.........}

getLenderDefaultInterestReport(investor:"Investor" dateTo:"12-31-2021" ){.........}
```

**Example — Default Interest Report**

```graphql
{
  getLenderDefaultInterestReport{
        checkDate
        paymentDate
        checkNo
        lenderAccount
        loanAccount
        borrowerName
        prevAccount
        noteRate
        defaultInterestRate
        checkAmount
        toServiceFee
        toNoteInterest
        toDefaultInterest
        toPrincipal
        toLateCharge
        toChargesPrincipal
        toChargesInterest
        toPrepay
        toOtherTaxable
        toOtherTaxFree
        toOtherPayments
        distToLender
        distToVendor
        distToCompany
        maxDistToCompany
    }
  }
```

```json
{
    "data": {
        "getLenderDefaultInterestReport": [
            {
                "checkDate": "05/21/2021",
                "paymentDate": "05/07/2021",
                "checkNo": "654788",
                "lenderAccount": "Test1234",
                "loanAccount": "test8180",
                "borrowerName": "test tester",
                "prevAccount": null,
                "noteRate": 5,
                "defaultInterestRate": 0,
                "checkAmount": 41.81,
                "toServiceFee": -15,
                "toNoteInterest": 56.81,
                "toDefaultInterest": 0,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "distToLender": 100,
                "distToVendor": 0,
                "distToCompany": 0,
                "maxDistToCompany": 0.0000
            },
            {
                "checkDate": "05/21/2021",
                "paymentDate": "05/12/2021",
                "checkNo": "654788",
                "lenderAccount": "Test1234",
                "loanAccount": "test8180",
                "borrowerName": "test tester",
                "prevAccount": null,
                "noteRate": 5,
                "defaultInterestRate": 0,
                "checkAmount": -41.81,
                "toServiceFee": 15,
                "toNoteInterest": -56.81,
                "toDefaultInterest": 0,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "distToLender": 100,
                "distToVendor": 0,
                "distToCompany": 0,
                "maxDistToCompany": 0.0000
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Lender Disbursement

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPaymentListToLender`

**FCI's notes (filters, parameters, enum legends):**

```
Refer to the Lender Disbursment Report section for details.

Parameters

investor: Optional

account: Optional

onlyPending: Optional

Limit: Optional

dateFrom: Optional

dateTo: Optional

Query Options:

getPaymentListToLender{......}

getPaymentListToLender(dateFrom:"05-05-2021" dateTo:"05-06-2021"){......}

getPaymentListToLender(account:"test8180"){ ......}

getPaymentListToLender(investor:"investor"){ ......}

getPaymentListToLender(investor:"investor" limit:100){......}
```

**Example — Lender Disbursement**

```graphql
{
  getPaymentListToLender(account:"test8180"){
   checkDate
   checkNo
   checkMemo
   account
   lenderAccount
   paymentType
   paymentDue
   paymentDate
   checkAmount
   toServiceFee
   toInterest
   toPrincipal
   toLateCharge
   toChargesPrincipal
   toChargesInterest
   toPrepay
   toOtherTaxable
   toOtherTaxFree
   toOtherPayments
   toTrust
   defaultInterest
   noteInterest
  }
}
```

```json
{
    "data": {
        "getPaymentListToLender": [
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "paymentType": "RegPmt",
                "paymentDue": "02/05/2022",
                "paymentDate": "01/05/2022",
                "checkAmount": 0.77,
                "toServiceFee": -15,
                "toInterest": 15.77,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toTrust": 0,
                "defaultInterest": 0,
                "noteInterest": 15.77
            },
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "paymentType": "RegPmt",
                "paymentDue": "02/05/2022",
                "paymentDate": "01/05/2022",
                "checkAmount": -0.77,
                "toServiceFee": 15,
                "toInterest": -15.77,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toTrust": 0,
                "defaultInterest": 0,
                "noteInterest": -15.77
            },
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "paymentType": "RegPmt",
                "paymentDue": "03/05/2022",
                "paymentDate": "01/05/2022",
                "checkAmount": -1.68,
                "toServiceFee": 15,
                "toInterest": -16.68,
                "toPrincipal": 0,
                "toLateCharge": 0,
                "toChargesPrincipal": 0,
                "toChargesInterest": 0,
                "toPrepay": 0,
                "toOtherTaxable": 0,
                "toOtherTaxFree": 0,
                "toOtherPayments": 0,
                "toTrust": 0,
                "defaultInterest": 0,
                "noteInterest": -16.68
            },
            {
                "checkDate": "08/26/2022",
                "checkNo": "697282",
                "checkMemo": "Investor Check",
                "account": "test8180",
                "lenderAccount": "Test1234",
                "paymentType": "RegPmt",
                "paymentDue": "03/05/2

... truncated: 23840 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Investor Earnings

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getInvestorEarnings`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

Query Options:

getInvestorEarnings{..........}

getInvestorEarnings(investor:"Investor" ){.........}

getInvestorEarnings(investor:"Investor" ){....details(account:"account" ){....}}
```

**Example — Investor Earnings**

```graphql
{
  getInvestorEarnings{
    investorAccount
    investorName
    totalLoansInvested
    totalLoansServiced
    originalUPBServiced
    currentUPBBalance
    priorYearDistributions
    currentYearDistributions
    details{
      loanAccount
      borrowerName
      originalUPBalance
      currentUPBalance
      priorYeardistributions
      currentYearDistributions
    }
  }
}
```

```json
{
    "data": {
        "getInvestorEarnings": [
            {
                "investorAccount": "INV-1",
                "investorName": "Investments LLC",
                "totalLoansInvested": 1,
                "totalLoansServiced": 1,
                "originalUPBServiced": 4254.69,
                "currentUPBBalance": 2538.69,
                "priorYearDistributions": 572,
                "currentYearDistributions": 1144,
                "details": [
                    {
                        "loanAccount": "Test8180",
                        "borrowerName": "Bororower Test",
                        "originalUPBalance": 4254.6900,
                        "currentUPBalance": 2538.6900,
                        "priorYeardistributions": 572.0000,
                        "currentYearDistributions": 1144.0000
                    }
                ]
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Lender Trust Ledger

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLenderTrustLedger`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Required.

dateFrom: Optional.

dateTo: Optional.

limit: Optional.

Query Options:

getLenderTrustLedger(investor:"investor" ){.....}

getLenderTrustLedger(investor:"investor" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getLenderTrustLedger(investor:"investor" dateFrom:"01/01/2020" dateTo:" 12/31/2020" limit:10){...}
```

**Example — Lender Trust Ledger**

```graphql
{
  getLenderTrustLedger(investor:"INV-1" dateFrom:"01/01/2021"){
    type
    beneficiary
    dateDeposited
    reference
    memo
    deposit
    payment
    balance
  }
}
```

```json
{
    "data": {
        "getLenderTrustLedger": [
            {
                "type": "REGULAR",
                "beneficiary": "INV-1 Investments LLC",
                "dateDeposited": "03/04/2021",
                "reference": "1000011",
                "memo": "Investor Check-ACH",
                "deposit": 0,
                "payment": -572,
                "balance": 0
            },
            {
                "type": "REGULAR",
                "beneficiary": "TEST8180 BENEFICIARY",
                "dateDeposited": "02/22/2021",
                "reference": "004111",
                "memo": "Investor Disbursement",
                "deposit": 572,
                "payment": 0,
                "balance": 572
            },
            {
                "type": "REGULAR",
                "beneficiary": "INV-1 Investments LLC",
                "dateDeposited": "02/03/2021",
                "reference": "11111111",
                "memo": "Investor Check-ACH",
                "deposit": 0,
                "payment": -572,
                "balance": 0
            },
            {
                "type": "REGULAR",
                "beneficiary": "TEST8180 BENEFICIARY",
                "dateDeposited": "01/22/2021",
                "reference": "FCI001111",
                "memo": "Investor Disbursement",
                "deposit": 572,
                "payment": 0,
                "balance": 572
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loan Cash Flow

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLoanCashFlow`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Loan Cash Flow Report**

```graphql
  {
  getLoanCashFlow(limit:2){
    account
    assetNumber
    borrowerName
    status
    nextDueDate
    paymentDate
    monthToDate
    lastMonth
    month2
    month3
    month4
  }
}
```

```json
{
    "data": {
        "getLoanCashFlow": [
            {
                "account": "test8180",
                "assetNumber": null,
                "borrowerName": "TEST PROPERTIES, LLC",
                "status": "ACTIVE",
                "nextDueDate": "05/01/2021",
                "paymentDate": "02/23/2021",
                "monthToDate": 0,
                "lastMonth": 832.36,
                "month2": 832.36,
                "month3": 832.36,
                "month4": 832.36
            },
            {
                "account": "TEST12345",
                "assetNumber": null,
                "borrowerName": "BORROWER TEST",
                "status": "ACTIVE",
                "nextDueDate": "04/01/2021",
                "paymentDate": "03/04/2021",
                "monthToDate": 547.22,
                "lastMonth": 547.22,
                "month2": 547.22,
                "month3": 609.15,
                "month4": 609.15
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Pay String Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPayString`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

Query Options:

getPayString(account:"testaccount1"){........}

getPayString(investor:"investorname"){........}

getPayString(investor:"investorname" account:"testaccount1"){........}
```

**Example — Pay String Report**

```graphql
{
  getPayString(account:"test8180"){
    account
    principalBalance
    currentDQStatus
    payString
  }
}
```

```json
{
    "data": {
        "getPayString": [
            {
                "account": "test8180",
                "principalBalance": 20019.14,
                "currentDQStatus": "Current",
                "payString": null
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Current Paystring Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getCurrentPaystring`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

Query Options:

getPayString(account:"testaccount1"){........}

getPayString(investor:"investorname"){........}

getPayString(investor:"investorname" account:"testaccount1"){........}
```

**Example — Current paystring report**

```graphql
{
    getCurrentPaystring(loanAccount: "test8180") {
        resume
        details {
            valPaystring
            dateDue
            dateReceived
        }
        principalBalance
        originalBalance
        paymentFrequency
        paidToDate
        firstPaymentDate
        maturityDate
        nextDueDate
        paymentDay
        reportDate
    }
  
}
```

```json
{
    "data": {
        "getCurrentPaystring": {
            "resume": "P",
            "details": [
                {
                    "valPaystring": "P",
                    "dateDue": "02/01/2022",
                    "dateReceived": "n/a"
                }
            ],
            "principalBalance": "¤0.00",
            "originalBalance": "¤177,400.00",
            "paymentFrequency": "Monthly",
            "paidToDate": "01/01/2022",
            "firstPaymentDate": "05/01/2021",
            "maturityDate": "04/01/2022",
            "nextDueDate": "02/01/2022",
            "paymentDay": 1,
            "reportDate": "08/08/2025"
        }
    }
}
```

### Pull API - FCI Web Loan Information / Scheduled Vs Actual Payment Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getSVAPaymentReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Query Options:

getSVAPaymentReport { }
```

**Example — Scheduled Vs Actual Payment Report**

```graphql
{
  getSVAPaymentReport {
    fromYear
    toYear
    totalPrincipalScheduled
    totalPrincipalReceived
    totalInterestScheduled
    totalInterestReceived
    months {
      year
      month
      totalPrincipalScheduled
      totalPrincipalReceived
      totalInterestScheduled
      totalInterestReceived
      unpaidCount
      paidCount
    }
  }
}
```

```json
{
    "data": {
        "getSVAPaymentReport": {
            "fromYear": 2023,
            "toYear": 2025,
            "totalPrincipalScheduled": 0,
            "totalPrincipalReceived": 0,
            "totalInterestScheduled": 0,
            "totalInterestReceived": 0,
            "months": [
                {
                    "year": 2023,
                    "month": 11,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2023,
                    "month": 12,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2024,
                    "month": 1,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2024,
                    "month": 2,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2024,
                    "month": 3,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2024,
                    "month": 4,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2024,
                    "month": 5,
                    "totalPrincipalScheduled": 0,
                    "totalPrincipalReceived": 0,
                    "totalInterestScheduled": 0,
                    "totalInterestReceived": 0,
                    "unpaidCount": 1,
                    "paidCount": 0
                },
                {
                    "year": 2024,
                    "month": 6,
               

... truncated: 9632 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Scheduled Vs Actual Payment by Loan Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getSVALoanPaymentReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Query Options:

getSVAPaymentReport { }
```

**Example — Scheduled Vs Actual Payment by Loan Report**

```graphql
{
    getSVALoanPaymentReport(account:"test8180") {
    fromYear
    toYear
    totalPrincipalScheduled
    totalPrincipalReceived
    totalInterestScheduled
    totalInterestReceived
    months {
      dateDue
      dateReceived
      principalScheduled
      principalReceived
      interestScheduled
      interestReceived
      isPerforming
      isPaid
    }
  }
}
```

```json
{
    "data": {
        "getSVALoanPaymentReport": {
            "fromYear": 2023,
            "toYear": 2025,
            "totalPrincipalScheduled": 0,
            "totalPrincipalReceived": 0,
            "totalInterestScheduled": 58713.46,
            "totalInterestReceived": 58712.55,
            "months": [
                {
                    "dateDue": "11/01/2023",
                    "dateReceived": "10/19/2023",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8365,
                    "interestReceived": 8364.09,
                    "isPerforming": true,
                    "isPaid": true
                },
                {
                    "dateDue": "12/01/2023",
                    "dateReceived": "12/11/2023",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8391.41,
                    "interestReceived": 8391.41,
                    "isPerforming": true,
                    "isPaid": true
                },
                {
                    "dateDue": "01/01/2024",
                    "dateReceived": "12/14/2023",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8391.41,
                    "interestReceived": 8391.41,
                    "isPerforming": true,
                    "isPaid": true
                },
                {
                    "dateDue": "02/01/2024",
                    "dateReceived": "01/19/2024",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8391.41,
                    "interestReceived": 8391.41,
                    "isPerforming": true,
                    "isPaid": true
                },
                {
                    "dateDue": "03/01/2024",
                    "dateReceived": "02/26/2024",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8391.41,
                    "interestReceived": 8391.41,
                    "isPerforming": true,
                    "isPaid": true
                },
                {
                    "dateDue": "04/01/2024",
                    "dateReceived": "03/08/2024",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8391.41,
                    "interestReceived": 8391.41,
                    "isPerforming": true,
                    "isPaid": true
                },
                {
                    "dateDue": "05/01/2024",
                    "dateReceived": "05/01/2024",
                    "principalScheduled": 0,
                    "principalReceived": 0,
                    "interestScheduled": 8391.41,
                    "interestReceived": 8391.41,
       

... truncated: 6539 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Payoff Value to Date

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPayoffValuetoDate`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

account: Optional

Query Options:

getPayoffValuetoDate(account:"tes8180" ){...}
```

**Example — Payoff Value to Date**

```graphql
{
  getPayoffValuetoDate(account:"test8180")
  {
    payoffDate
    maturityDate
    interestPaidToDate   
    nextPaymentDue
    unpaidPrincipal
    deferredUnpaidPrincipal
    interestRate
    currentRate
    noteInterestRateDue
    additionalDefaultInterestRate
    unpaidInterest
    deferredUnpaidInterest
    unpaidFees
    otherPayments
    accLateCharges
    unpaidLateCharges
    deferredUnpaidLateCharges
    unpaidCharges
    otherEstimatedFees
    suspenseBalance
    escrowBalance
    restrictedFunds
    judgmentInterestFromDate
    judgmentAmount
    postJudgmentInterestRate
    judgmentRateDue
    prepaymentPenalty
    accrualRate
    noteInterestRateCredit
    drawLoan
    lenderExitFee
    interestGuarantee
    dailyInterest
  }
}
```

```json
{
    "data": {
        "getPayoffValuetoDate": {
            "payoffDate": "1/31/2025",
            "maturityDate": "12/31/2060",
            "interestPaidToDate": "10/01/2024",
            "nextPaymentDue": "11/01/2024",
            "unpaidPrincipal": 25019.14,
            "deferredUnpaidPrincipal": 0,
            "interestRate": 1,
            "currentRate": 1,
            "noteInterestRateDue": 84.31,
            "additionalDefaultInterestRate": 0.00,
            "unpaidInterest": 0,
            "deferredUnpaidInterest": 0,
            "unpaidFees": 0,
            "otherPayments": 0,
            "accLateCharges": 17.01,
            "unpaidLateCharges": 2.43,
            "deferredUnpaidLateCharges": 0,
            "unpaidCharges": 526.00,
            "otherEstimatedFees": 264.00,
            "suspenseBalance": -162.31,
            "escrowBalance": 0,
            "restrictedFunds": 0,
            "judgmentInterestFromDate": "n/a",
            "judgmentAmount": 0,
            "postJudgmentInterestRate": 0,
            "judgmentRateDue": 0,
            "prepaymentPenalty": 0,
            "accrualRate": 0,
            "noteInterestRateCredit": 0,
            "drawLoan": 0,
            "lenderExitFee": 0,
            "interestGuarantee": 0,
            "dailyInterest": 0.70,
            "fullyPayoff": 25750.58
        }
    }
}
```

### Pull API - FCI Web Loan Information / Payoff Demand Status

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPayOffDemandStatus`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

dateFrom: Optional

dateTo: Optional

wasPaid: Optional

Limit: Optional

Query Options:

getPayOffDemandStatus{.....}

getPayOffDemandStatus(investor:"test1234" ){.....}

getPayOffDemandStatus(investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getPayOffDemandStatus(account:"tes8180" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getPayOffDemandStatus(wasPaid:true
investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020" ) {.....}
```

**Example — Payoff Demand Status**

```graphql
{
  getPayOffDemandStatus(wasPaid:false dateFrom:"01-01-2021") {
    account
    borrowerName
    borrowerAddress
    borrowerCity
    borrowerState
    borrowerZip
    complianceDate
    upb
    interestRate
    paidToDate
    nextDueDate
    maturityDate
    paidOffDate
    closedDate
    propertyState
    propertyCity
    propertyZip
    loanStatus
    datePayoffDemandQuoteIssued
    wasPaid
    forwardToLender
    demandStatus
  }
}
```

```json
{
    "data": {
        "getPayOffDemandStatus": [
            {
                "account": "test8180",
                "dateReceived": "06/06/2022",
                "borrowerName": "test8180",
                "borrowerAddress": "8180 E Kaiser Blvd.",
                "borrowerCity": "ANAHEIM",
                "borrowerState": "CA",
                "borrowerZip": "92808",
                "complianceDate": "09/14/2022",
                "upb": 125719.81,
                "interestRate": 6,
                "paidToDate": "03/01/2021",
                "nextDueDate": "04/01/2021",
                "maturityDate": "08/01/2048",
                "paidOffDate": "n/a",
                "closedDate": "n/a",
                "propertyState": "TN",
                "propertyCity": "ANAHEIM",
                "propertyZip": "92808",
                "loanStatus": "Performing",
                "datePayoffDemandQuoteIssued": "02/19/2021",
                "wasPaid": 0,
                "expiresOnDate":"12/19/2022",
                "forwardToLender": "09/02/2022"
                "demandStatus": "COMPLETED"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Pending Payoff Demands

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getPendingPayoffDemands`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

dateFrom: Optional

dateTo: Optional

wasPaid: Optional

Limit: Optional

Query Options:

getPayOffDemandStatus{.....}

getPayOffDemandStatus(investor:"test1234" ){.....}

getPayOffDemandStatus(investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getPayOffDemandStatus(account:"tes8180" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getPayOffDemandStatus(wasPaid:true
investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020" ) {.....}
```

**Example — Pending Payoff Demands**

```graphql
{
  getPendingPayoffDemands {
    account
    borrowerName
    payoffTotal
    dateReceived
    daysPending
    urgency
    approvals {
      lenderAccount
      approveUrl
    }
  }
}
```

```json
{
    "data": {
        "getPendingPayoffDemands": [
            {
                "account": "test8180",
                "borrowerName": "TestBorrower",
                "payoffTotal": 250000.500,
                "dateReceived": "08/05/2026",
                "daysPending": 5,
                "urgency": "Attention",
                "approvals": [
                    {
                        "lenderAccount": "test1234",
                        "approveUrl": "https://ffciweb.myfci.com/DemandRequest/LenderApprove?uid=NDlmNmRiYXXXXNDhiZDljMTM1NGQ3OTk3MWJiYTE%3D"
                    }
                ]
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Trust Balance

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getTrustBalance`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

dateFrom: Optional

dateTo: Optional

Limit: Optional

Query Options:

getTrustBalance{.....}

getTrustBalance (investor:"test1234" ){.....}

getTrustBalance (investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getTrustBalance (account:"test8180" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}
```

**Example — Trust Balance**

```graphql
{
  getTrustBalance(dateFrom:"10-01-2020" account:"9160035254BK1"){
    account
    borowerName
    status
    escrowBalance
    suspenseBalance
    trustTotal
  }
}
```

```json
{
    "data": {
        "getTrustBalance": [
            {
                "account": "test8180",
                "borowerName": "TEST BORROWER",
                "status": 4,
                "escrowBalance": 0,
                "suspenseBalance": 0,
                "trustTotal": 0
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Lien Release Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLienReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

- investor: lender account (OPCIONAL)

- account: loan Account (OPCIONAL)

- dateFrom: (OPCIONAL)

- dateTo: (OPCIONAL)

Query Options:

getLienReport{.....}

getLienReport (investor:"test1234" ){.....}

getLienReport (investor:"test1234" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}

getLienReport (account:"test8180" dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}
```

**Example — Lien Release Report**

```graphql
{
  getLienReport{
    lenderAccount
    loanAccount
    street
    city
    state
    zipCode
    date
  }
}
```

```json
{
    "data": {
        "getLienReport": [
            {
                "lenderAccount": "test1234",
                "loanAccount": "testaccount",
                "street": "357 Address ave",
                "city": " Las Vegas",
                "state": "NV",
                "zipCode": "00000",
                "date": "03/10/2022"
            },
            {
                "lenderAccount": "test12345",
                "loanAccount": "testaccount00",
                "street": "10602 Address ave",
                "city": "Charlotte",
                "state": "NC",
                "zipCode": "00000",
                "date": "11/03/2021"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Loss Mit Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getLossMitReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Query Options:

getBankruptcyReport.....}

getBankruptcyReport (dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}
```

**Example — Loss Mit Report**

```graphql
{
  getLossMitReport { 
    lossMitStatus 
    decision 
    planStartDate 
    reasonClosed 
    initialAppReceived 
    requestReceivedFrom 
    workoutTypeRequested 
    acknowledegementSent 
    appSentToLender 
    additionalDocsNoticeSent 
    appComplete 
    foreclosureHoldAdded 
    decisionMade 
    workoutType 
    decisionNoticeSent 
    appealReceived 
    appealSentToLender 
    appealDecision 
    agreementReceived 
    loanTermsUpdated 
    followUpDate 
    lastReview 
    creationDate 
    initialAppComplete 
    appealEligible 
    fCIDraftedAgreement 
    comments 
    closedDate 
    propertyType 
    propertyStreet 
    lienPosition 
    propertyOccupancy 
    loanStatus 
    isCoveredCFPB 
    account 
    fCLSaleDate 
    consumerResponseDeadline 
    responseDeadlineForAddDocs 
    lenderDecisionDeadline 
    acknowledgmentDeadline 
    planStatus 
    }
}
```

```json
{
    "data": {
        "getLossMitReport": [
            {
                "lossMitStatus": "Active",
                "decision": "Approved",
                "planStartDate": "12/19/2025",
                "reasonClosed": "",
                "initialAppReceived": "n/a",
                "requestReceivedFrom": "Lender",
                "workoutTypeRequested": "Keep Property",
                "acknowledegementSent": "n/a",
                "appSentToLender": "n/a",
                "additionalDocsNoticeSent": "n/a",
                "appComplete": "n/a",
                "foreclosureHoldAdded": "n/a",
                "decisionMade": "n/a",
                "workoutType": "Forbearance Plan",
                "decisionNoticeSent": "n/a",
                "appealReceived": "n/a",
                "appealSentToLender": "n/a",
                "appealDecision": "",
                "agreementReceived": "n/a",
                "loanTermsUpdated": "n/a",
                "followUpDate": "n/a",
                "lastReview": "n/a",
                "creationDate": "12/19/2025",
                "initialAppComplete": "",
                "appealEligible": "",
                "fCIDraftedAgreement": "",
                "comments": null,
                "closedDate": "n/a",
                "propertyType": "Commercial",
                "propertyStreet": "propertyStreet , 33000",
                "lienPosition": "2nd",
                "propertyOccupancy": "Tenant",
                "loanStatus": "Foreclosure",
                "isCoveredCFPB": "False",
                "account": "test8180",
                "fCLSaleDate": "n/a",
                "consumerResponseDeadline": "n/a",
                "responseDeadlineForAddDocs": "n/a",
                "lenderDecisionDeadline": "n/a",
                "acknowledgmentDeadline": "n/a",
                "planStatus": "Active"
            },
            {
                "lossMitStatus": "Active",
                "decision": "Approved",
                "planStartDate": "12/19/2025",
                "reasonClosed": "",
                "initialAppReceived": "n/a",
                "requestReceivedFrom": "Lender",
                "workoutTypeRequested": "Keep Property",
                "acknowledegementSent": "n/a",
                "appSentToLender": "n/a",
                "additionalDocsNoticeSent": "n/a",
                "appComplete": "n/a",
                "foreclosureHoldAdded": "n/a",
                "decisionMade": "n/a",
                "workoutType": "Forbearance Plan",
                "decisionNoticeSent": "n/a",
                "appealReceived": "n/a",
                "appealSentToLender": "n/a",
                "appealDecision": "",
                "agreementReceived": "n/a",
                "loanTermsUpdated": "n/a",
                "followUpDate": "n/a",
                "lastReview": "n/a",
                "creationDate": "12/19/2025",
                "initialAppComplete": "",
                "appealEligible": "",
                "fCI

... truncated: 3734 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / Bankruptcy Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getBankruptcyReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

- dateFrom: (OPCIONAL)

- dateTo: (OPCIONAL)

Data Dictionary:

bKChapter

0=EMPTY | 1=NONE| 2=CHAPTER7 | 3=CHAPTER9 | 4=CHAPTER11 | 5=CHAPTER12 | 6=CHAPTER13 |7=CHAPTER15

trusteePayall

0=EMPTY | 1=YES | 2=NO

propertyTreatment
0=EMPTY | 1=CRAMDOWN | 2=LIEN_STRIP | 3=BIFURCATION | 4=MODIFICATION | 5=SURRENDERED | 6=RETAINED | 7=REAFFIRMED | 8=REAFFIRMED_ORDER | 9=TOTAL_DEBT | 10=SALE_PROPERTY | 11=NOT_PROVIDED_PLAN | 12=MISCELLANEOUS

mFRResults

0=EMPTY | 1=GRANTED | 2=DENIED | 3=AGREED_ORDER | 4=DAY_WAIVER | 5=MISC

caseDisposition

0=EMPTY | 1=DISMISSED | 2=DISCHARGED

cFPBReview
0=EMPTY | 1=YES | 2=NO

Query Options:

getBankruptcyReport.....}

getBankruptcyReport (dateFrom:"01/01/2020" dateTo:" 12/31/2020 "){...}
```

**Example — Bankruptcy Report**

```graphql
{
  getBankruptcyReport{
        loanAccount
        bKFiler
        caseNumber
        bKChapter
        stateBKFiled
        trusteePayall
        pOCBarDate
        pOCReferred
        pOCFiledDate
        tOCReferred
        tOCFiledDate
        pPFNDate
        planConfirmed
        pCNDate
        nOFCDate
        confHearingDate
        propertyTreatment
        mFRFiled
        mFRReferred
        mFRHearing
        mFRResults
        orderEntered
        caseDisposition
        dispositionDate
        closedDate
        cFPBReview
        trackContractually
        contractualDueDate
        postPeditionDueDate
        originalArrears
        currentArrears
        fPASent
        propertyAddress
    }
}
```

```json
{
    "data": {
        "getBankruptcyReport": [
            {
                "loanAccount": "test8180",
                "bKFiler": "10/02/2017",
                "caseNumber": "00-44111",
                "bKChapter": "6",
                "stateBKFiled": "TX",
                "trusteePayall": 1,
                "pOCBarDate": "n/a",
                "pOCReferred": null,
                "pOCFiledDate": "03/08/2018",
                "tOCReferred": "n/a",
                "tOCFiledDate": "n/a",
                "pPFNDate": "n/a",
                "planConfirmed": "12/14/2017",
                "pCNDate": "n/a",
                "nOFCDate": "n/a",
                "confHearingDate": "12/14/2017",
                "propertyTreatment": 6,
                "mFRFiled": "n/a",
                "mFRReferred": "n/a",
                "mFRHearing": "n/a",
                "mFRResults": 0,
                "orderEntered": "n/a",
                "caseDisposition": 1,
                "dispositionDate": "05/16/2018",
                "closedDate": "n/a",
                "cFPBReview": 2,
                "trackContractually": 2,
                "contractualDueDate": "03/01/2013",
                "postPeditionDueDate": "04/01/2019",
                "originalArrears": 6999.37,
                "currentArrears": 6999.37,
                "fPASent": "n/a",
                "propertyAddress": "0001 Street Dr"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / FCI Invoice List

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getInvoiceList`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

type: Optional
type=1, shows pending invoices
type=2, shows paid invoices

dateFrom: Optional

dateTo: Optional

Query Options:

getInvoiceList {.......}

getInvoiceList(type:1){ .......... }

getInvoiceList(type:2){ .......... }

getInvoiceList (dateFrom:"01-05-2020" dateTo:"05-06-2021"){.......}
```

**Example — FCI Invoice List**

```graphql
{
    getInvoiceList{
        numInvoice
        fullName
        account
        isFrozen
        department
        amount
        date
        dateDue
        lastDateSent
    }
}
```

```json
{
    "data": {
        "getInvoiceList": [
            {
                "numInvoice": "SP000001",
                "fullName": "test LLC",
                "account": "test8081",
                "isFrozen": false,
                "department": "Specialty Servicing",
                "amount": 0.5,
                "date": "01/31/2021",
                "dateDue": "02/09/2021",
                "lastDateSent": "n/a"
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / FCI Invoice Details

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getInvoiceDetail`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method
```

**Example — Invoice Details**

```graphql
{
  getInvoiceDetail(invoice:"ST000001"){
    fullName
    dateDue
    date
    numInvoice
    dateReceived
    isACH
    account
    loanAcct
    borrower
    propStreet
    propCity
    propState
    propZip
    loanStatus
    detailDescription
    quantity
    amount
  }
}
```

```json
{
    "data": {
        "getInvoiceDetail": [
            {
                "fullName": "Test Company Name Bank",
                "dateDue": "06/26/2019",
                "date": "06/30/2019",
                "numInvoice": "ST000001",
                "dateReceived": "06/19/2019",
                "isACH": false,
                "account": "1711696",
                "loanAcct": "TS1111111",
                "borrower": "Borrower-test",
                "propStreet": "Atlantic Ave",
                "propState": "NY",
                "propCity": "BROOKLYN",
                "propZip": "11238",
                "detailDescription": "New York Delinquent Property Inspection",
                "quantity": 1,
                "amount": 16
            },
            {
                "fullName": "Test Company Name Bank",
                "dateDue": "06/26/2019",
                "date": "06/30/2019",
                "numInvoice": "ST000001",
                "dateReceived": "06/19/2019",
                "isACH": false,
                "account": "TS1111112",
                "loanAcct": "G18012775",
                "borrower": "37 Borrower-test",
                "propStreet": "37 St",
                "propState": "NY",
                "propCity": "BROOKLYN",
                "propZip": "11231",
                "detailDescription": "Assignment Fee-By Investor",
                "quantity": 1,
                "amount": 25
            },
            {
                "fullName": "Test Company Name Bank",
                "dateDue": "06/26/2019",
                "date": "06/30/2019",
                "numInvoice": "TS1111113",
                "dateReceived": "06/19/2019",
                "isACH": false,
                "account": "1711696",
                "loanAcct": "G17129522",
                "borrower": "Borrower-test LLC",
                "propStreet": "00 Highland Terrace",
                "propState": "NY",
                "propCity": "Bridgehampton",
                "propZip": "11932",
                "detailDescription": "New York Delinquent Property Inspection",
                "quantity": 1,
                "amount": 16
            },
            {
                "fullName": "Test Company Name Bank",
                "dateDue": "06/26/2019",
                "date": "06/30/2019",
                "numInvoice": "ST000001",
                "dateReceived": "06/19/2019",
                "isACH": false,
                "account": "TS1111111",
                "loanAcct": "G17119262",
                "borrower": "Borrower-test CORP",
                "propStreet": "700 Avenue",
                "propState": "NY",
                "propCity": "BROOKLYN",
                "propZip": "11203",
                "detailDescription": "Base - Servicing Fee",
                "quantity": 1,
                "amount": 95
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Tax Voucher Detail

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getVoucherTaxesDetailPublic`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

account: Optional

Query Options:

getACHStatus) {.......}

getACHStatus(account:"test8180" ){ .......... }
```

**Example — Tax Voucher Detail**

```graphql
{
  getVoucherTaxesDetailPublic(account:"test8180")
  {
    toPayType
    loanAccount
    payeeAccount
    payeeName
    payeeAddress
    phone
    fax
    email
    memo
    propertyUid
    dueDate
    amount
    frequency
    responsibility
    streamIndicator
    followUpdate
    url
    aPN
    taxSaleDate
    propertyLoss
    goodThrough
    agentNotes
  }
}
```

```json
{
    "data": {
        "getVoucherTaxesDetailPublic": [
            {
                "toPayType": 0,
                "loanAccount": "test8180",
                "payeeAccount": "TAX-001819",
                "payeeName": "City of Richmond Treasurer",
                "payeeAddress": "PO Box 26505, Richmond, VA 23261",
                "phone": "(800) 000-0000",
                "fax": null,
                "email": null,
                "memo": "Taxes:  test Ave  Richmond, VA",
                "propertyUid": "66ba7aaaa4a403596fceb4d9d6e2b64",
                "dueDate": "2022-05-01T00:00:00.000-07:00",
                "amount": 1674,
                "frequency": 7,
                "responsibility": 1,
                "streamIndicator": 1,
                "followUpdate": null,
                "url": "https://www.test.com/invoice",
                "aPN": "N00000001",
                "taxSaleDate": null,
                "propertyLoss": null,
                "goodThrough": "2022-06-14T00:00:00.000-07:00",
                "agentNotes": "Voucher Dates - 12/1 & 5/1 "
            },
            {
                "toPayType": 0,
                "loanAccount": "399362577",
                "payeeAccount": "TAX-001819",
                "payeeName": "City of Richmond Treasurer",
                "payeeAddress": "PO Box 26505, Richmond, VA 23261",
                "phone": "(804) 646-7000",
                "fax": null,
                "email": null,
                "memo": "Taxes:  3014 3rd Ave  Richmond, VA",
                "propertyUid": "66ba7aaaa4a403596fceb4d9d6e2b64",
                "dueDate": "2021-12-01T00:00:00.000-08:00",
                "amount": 1674,
                "frequency": 7,
                "responsibility": 1,
                "streamIndicator": 1,
                "followUpdate": null,
                "url": "https://www.test.com/invoice",
                "aPN": "N00000001",
                "taxSaleDate": null,
                "propertyLoss": null,
                "goodThrough": "2022-01-14T00:00:00.000-08:00",
                "agentNotes": "Voucher Dates - 12/1 & 5/1 "
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / Insurance Voucher Detail

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getVoucherInsurancesDetailPublic`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

account: Optional

Query Options:

getACHStatus) {.......}

getACHStatus(account:"test8180" ){ .......... }
```

**Example — Insurance Voucher Detail**

```graphql
{
  getVoucherInsurancesDetailPublic(account:"test8180")
  {
    toPayType
    loanAccount
    payeeAccount
    payeeName
    payeeAddress
    phone
    email
    memo
    propertyUid
    dueDate
    amount
    frequency
    responsibility
    streamIndicator
    followUpdate
    agentName
    agentAddress
    comments
    policyNumber
    coverage
    effectiveDate
    expirationDate
    cancelDate
    lastReviewed
  }
}
```

```json
{
    "data": {
        "getVoucherInsurancesDetailPublic": [
            {
                "toPayType": 1,
                "loanAccount": "test8180",
                "payeeAccount": "INS-001791",
                "payeeName": "Certain Underwriters of Lloyds",
                "payeeAddress": "City Place\r\n11111 SW 00th St, Miami, FL 33186",
                "phone": "(804) 000-0000",
                "email": null,
                "memo": "Insurance:  Miami, FL",
                "propertyUid": "66ba00000284a403596fceb4d9d6e2b64",
                "dueDate": "2022-10-20T00:00:00.000-07:00",
                "amount": 1579.13,
                "frequency": 7,
                "responsibility": 1,
                "streamIndicator": 3,
                "followUpdate": null,
                "agentName": "Agent Test",
                "agentAddress": null,
                "comments": null,
                "policyNumber": "FLF-30000000",
                "coverage": 270000,
                "effectiveDate": "2021-10-20T00:00:00.000-07:00",
                "expirationDate": "2022-10-20T00:00:00.000-07:00",
                "cancelDate": null,
                "lastReviewed": null
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / ARM Report

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getArmReport`

**FCI's notes (filters, parameters, enum legends):**

```
To map the fields from the following lender portal screen, use this API method

Parameters

investor: Optional

account: Optional

onlyPending: Optional

Limit: Optional

dateFrom: Optional

dateTo: Optional

Query Options:

getPaymentListToLender{......}

getPaymentListToLender(dateFrom:"05-05-2021" dateTo:"05-06-2021"){......}

getPaymentListToLender(account:"test8180"){ ......}

getPaymentListToLender(investor:"investor"){ ......}

getPaymentListToLender(investor:"investor" limit:100){......}
```

**Example — ARM Report**

```graphql
{
  getArmReport
  {
    account
    adjForPayment
    appCreationDate
    ceiling
    dayisMonth
    daysinYear
    floatFirstRateMinCap
    floatFreqPymtChange
    floatPeriodicMaxCap
    floor
    indexARMString
    loanStatus
    lookBackDays
    margin
    newInterestRate
    newTotalPayment
    noticeType
    originationDate
    propertyState
    propertyType
    rateType
    roundFactor
    roundMethod
  }
}
```

```json
{
    "data": {
        "getArmReport": [
            {
                "account": "test8180",
                "adjForPayment": "2026-01-01T00:00:00.000-08:00",
                "appCreationDate": "2025-10-24T12:35:40.120-07:00",
                "ceiling": 13,
                "dayisMonth": true,
                "daysinYear": false,
                "floatFirstRateMinCap": null,
                "floatFreqPymtChange": 12,
                "floatPeriodicMaxCap": 2,
                "floor": 3.25,
                "indexARMString": "CMT 1-Year Weekly",
                "loanStatus": 0,
                "lookBackDays": 45,
                "margin": 3.25,
                "newInterestRate": 6.875,
                "newTotalPayment": 678.09,
                "noticeType": 2,
                "originationDate": "2006-11-03T00:00:00.000-08:00",
                "propertyState": "NV",
                "propertyType": 0,
                "rateType": 2,
                "roundFactor": 0.125,
                "roundMethod": 3
            },
            {
                "account": "test81800",
                "adjForPayment": null,
                "appCreationDate": "2025-06-02T09:20:02.890-07:00",
                "ceiling": 11.375,
                "dayisMonth": true,
                "daysinYear": false,
                "floatFirstRateMinCap": null,
                "floatFreqPymtChange": 6,
                "floatPeriodicMaxCap": 2,
                "floor": 2.25,
                "indexARMString": "SOFR 6-Month Term",
                "loanStatus": 0,
                "lookBackDays": 30,
                "margin": 2.25,
                "newInterestRate": 7,
                "newTotalPayment": null,
                "noticeType": 2,
                "originationDate": "2005-06-21T00:00:00.000-07:00",
                "propertyState": "NC",
                "propertyType": 3,
                "rateType": 2,
                "roundFactor": 0.125,
                "roundMethod": 3
            }
        ]
    }
}
```

### Pull API - FCI Web Loan Information / One Time Payment Link

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getOTPLink`

**FCI's notes (filters, parameters, enum legends):**

```
To get the direct link to our new tool One Time Payment for a specific loan

Parameters

account: Required

Query Options:

{ getOTPLink(account:"testAccount")
```

**Example — One Time Payment Link**

```graphql
{
getOTPLink(account:"test8180")
}
```

```json
{
    "data": {
        "getOTPLink": "https://blis.myfci.com/otp/3c385767eefa405d8a9037d802ae4c7e"
    }
}
```

### Pull API - FCI Web Loan Information / Payoff Request Tracker *Beta Testing

- **Method / URL:** `POST https://tapi.myfci.com/graphql`
- **Root field:** `getPayoffRequests`

**FCI's notes (filters, parameters, enum legends):**

```
To get the direct link to our new tool One Time Payment for a specific loan

Parameters

account: Required

Query Options:

{ getOTPLink(account:"testAccount")
```

**Example — Payoff Request Tracker**

```graphql
{
  getPayoffRequests(account: "test8180") {
    account
    payoffStatus
    fundsReleaseDate
    latestRequest {
      dateReceived
      expirationDate
      payoffDate
      trackingStatus
      trackingFailedStatus
      requestedBy
      signatureFor
      activities {
        date
        description
      }
    }
    requests {
      dateReceived
      expirationDate
      payoffDate
      trackingStatus
      trackingFailedStatus
      requestedBy
      signatureFor
      activities {
        date
        description
      }
    }
  }
}
```

```json
{
    "data": {
        "getPayoffRequests": {
            "account": "test8180",
            "payoffStatus": "Completed",
            "fundsReleaseDate": null,
            "latestRequest": {
                "dateReceived": "2025-04-01T12:45:53.323-07:00",
                "expirationDate": "2025-04-02T00:00:00.000-07:00",
                "payoffDate": "2025-04-01T00:00:00.000-07:00",
                "trackingStatus": "Completed",
                "trackingFailedStatus": null,
                "requestedBy": "Borrower",
                "signatureFor": null,
                "activities": [
                    {
                        "date": "2025-04-10T16:51:05.823-07:00",
                        "description": "Payoff Payment Pending, Expires On Date: 04/02/25"
                    },
                    {
                        "date": "2025-04-10T16:51:05.623-07:00",
                        "description": "Request Completed"
                    },
                    {
                        "date": "2025-04-01T12:46:30.650-07:00",
                        "description": "Demand made and Sent to Lender"
                    },
                    {
                        "date": "2025-04-01T12:45:53.323-07:00",
                        "description": "Request Received by Borrower"
                    },
                    {
                        "date": "2025-04-01T12:45:53.673-07:00",
                        "description": "Request Sent by Borrower"
                    }
                ]
            },
            "requests": [
                {
                    "dateReceived": "2025-04-01T12:45:53.323-07:00",
                    "expirationDate": "2025-04-02T00:00:00.000-07:00",
                    "payoffDate": "2025-04-01T00:00:00.000-07:00",
                    "trackingStatus": "Completed",
                    "trackingFailedStatus": null,
                    "requestedBy": "Borrower",
                    "signatureFor": null,
                    "activities": [
                        {
                            "date": "2025-04-10T16:51:05.823-07:00",
                            "description": "Payoff Payment Pending, Expires On Date: 04/02/25"
                        },
                        {
                            "date": "2025-04-10T16:51:05.623-07:00",
                            "description": "Request Completed"
                        },
                        {
                            "date": "2025-04-01T12:46:30.650-07:00",
                            "description": "Demand made and Sent to Lender"
                        },
                        {
                            "date": "2025-04-01T12:45:53.323-07:00",
                            "description": "Request Received by Borrower"
                        },
                        {
                            "date": "2025-04-01T12:45:53.673-07:00",
                            "description": "Request Sent by Borrower"
                        }
   

... truncated: 3068 characters in total. The complete example is in docs/fci/collection-snapshot.json.
```

### Pull API - FCI Web Loan Information / getVersion

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `getApiVersion`

**FCI's notes (filters, parameters, enum legends):**

```
Method to get the Version number of the API
```

**Example — getVersion**

```graphql
{
  getApiVersion
}
```

```json
{
    "data": {
        "getApiVersion": {
            "enviroment": "Integration",
            "version": "v 1.21.6.24:2"
        }
    }
}
```

### Push API -  Update Charges / Update Charges

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `insertLoanCharge`

**Example — Update Charges**

```graphql
mutation
{
 insertLoanCharge(
  charges:[
    { 
      loanNumber:"test8180",
      investorAccountNumber:"Test1234",
      chargeDate:"11/15/2021",
      chargeAmount:900123.45,
      interestRate:15.75,
      paidBy:"Borrower",
      invoiceNumber:"TestReference",
      comments:"ThisisTestCharges",
      doc1:"https://file-examples-com.github.io/uploads/2017/02/file-sample_500kB.doc",
      doc2:"https://file-examples-com.github.io/uploads/2017/02/file-sample_500kB.doc",
      doc3:"https://file-examples-com.github.io/uploads/2017/02/file-sample_500kB.doc"
    }
  ])
}
```

```json
{
    "data": {
        "insertLoanCharge": "Success"
    }
}
```

### Push API -  Draw Request / Insert Draw Structure / New Request

- **Method / URL:** `GET `

### Push API -  Draw Request / Draw Request

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `insertDrawLoan`

**FCI's notes (filters, parameters, enum legends):**

```
To be able to send this request with an attachment using our GraphQL mutation you need to convert your file to base64 encoded Blobs, see the example below:

*if you prefer to not convert your file please use our REST API which is also available
```

**Example — Draw Request**

```graphql
mutation
{
 insertDrawLoan(
  drawloan:
    { 
      loanNumber:"test8180",
      investorAccountNumber:"Test1234"
      dateReceived: "11-15-2021"
      amount:900123.45
      comments:"ThisisTestForADrawRequest"
    }
  )
}
```

```json
{
    "data": {
        "insertDrawLoan": "Success"
    }
}
```

**Example — Draw Request with attachment (base64)**

```graphql
mutation
{
 insertDrawLoan(
  drawloan:
    { 
      loanNumber:"test8180",
      investorAccountNumber:"Test1234"
      dateReceived: "11-15-2021"
      amount:900123.45
      comments:"ThisisTestForADrawRequest"
      attachment: "<base64 sample attachment, 12812 chars, removed from the pinned snapshot>"
    }
  )
}
```

```json
{
    "data": {
        "insertDrawLoan": "Success"
    }
}
```

### Push API -  Draw Request / Draw Request RestAPI

- **Method / URL:** `POST https://fapi.myfci.com/api/v1/boarding/drawLoan`

**Example — Draw Request RESTAPI**

```
loanNumber: test8180
investorAccountNumber: Test1234
dateReceived: 03/15/2024
amount: 500.50
comments: this is a draw request with attachment
attchment: <file>
```

```json
{
    "success": true,
    "data": "Success"
}
```

### Push API -  Payoff Request / Payoff Request

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `insertPayoff`

**Example — Payoff Request**

```graphql
mutation{
  insertPayoff(payoff:
                    {
                      loanNumber:"test8180"
                      payoffDate:"01/01/2023"
                      lsaRequired:true
                      reason:1
                      reqCompany:"company"
                      reqContact:"contact"
                      reqEmail:"email"
                      reqMailing:"mailling"
                      reqPhone:"phone"
                      description:"mydescription"
                      dateReceived:"03-03-2024"
                      requestedBy:"Lender"
                    })
}
```

```json
{
    "data": {
        "insertPayoff": "Success"
    }
}
```

### Push API - Boarding Loans / Boarding a Loan

- **Method / URL:** `POST https://fapi.myfci.com/graphql`
- **Root field:** `insertBoarding`

**Example — Boarding a Loan**

```graphql
mutation{
   insertBoarding
   (
       insertLoan:
       {
            prevAccount:"TESTLOAN01",
            lienPosition:1
            lenderAccount:"test1234",
            originationDate: "08/25/2020",
            fundingDate:"08/25/2020",
            firstPaymentDate:"08/25/2020",
            paidToDate:"08/25/2020"
            nextDueDate:"08/25/2020"
            originalBalance:12
            principalBalance:12.3
            lateChargesDays:1
            payment:5.0
            paymentImpound:12
            paymentFrequency:1
            maturityDate:"08/25/2020"
            noteRate:12.3
            primaryPurpose:1
            defaultRate: 12.32
            noteType: 1
            rateType: 1
            paymentPropertyTax: 12.30
            paymentSchoolTax: 12.32
            paymentCityTax: 15.00
            paymentWaterSewerTax: 15.00
            paymentTownshipTax: 10.00
            paymentOtherTax: 5.00
            withheldHazardInsurance: 0
            withheldPropertyTax: 0
            withheldWindInsurance: 0
            withheldFloodInsurance: 0
            reservePropertyTax: 5
            reserveSchoolTax: 5
            reserveCityTax: 0
            reserveWaterSewerTax: 0
            reserveTownshipTax: 0
            startingBalance: 0
            amortizationType: 1
            is365DayYears: true
            is30DayMonths: true
            negativeToPrincipal: true
            accruedMethod: 0
            lateChargesMin: 130
            lateChargeMax: 150
            lateChargesPct: 5
            noPyramiding: true
            lateChargesPostMaturity: false
            lateChargesDaily: 3
            lateChargesLenderPct: 40
            lateChargesVendorPct: 35
            lateChargesCompanyMaxDist: 50
            defaultIntIsEnabled: false
            defaultIntEnableMaturity: false
            defaultIntTypeCalculation: 0
            defaultIntUseCustomDate: false
            defaultIntDays:0
            defaultIntOptionDays:0
            defaultIntDateFrom: 1
            defaultCustomDateFrom: 2
            defaultIntEffectiveDays: 1
            defaultIntEffectiveOptionDays: 1
            defaultIntEffectiveDateFrom: 1
            defaultIntModifier: 1
            defaultIntRate: 1
            defaultIntLastEffectiveStatus: true
            defaultIntLastImplementationDate: "6/1/21"
            defaultIntLastEffectiveDate: "6/1/21"
            defaultIntLastTopDate: "6/1/21"
            defaultIntAllowLateCharges: false
            defaultIntActiveDaily: false
            defaultIntLenderPct: 10
            defaultIntVendorPct: 10
            defaultIntCompanyMaxDist: 100	
            originalVendor: "005-PRIV"
            spreadRate:1.0
            trustAccount: "FCI - Pool 1 Trust Account"
            approvalPayoff:BROKER
            approvalChangeFeesTerms: LENDER
            approvaleReinstatement:EITHER
            approvalStartForeclosure:BOTH
            setBorrower:[
                {
                firstName:"TEST"
                middleName:"TESTTEST"
                lastName:"TEST"
                street:"street"
                city:"sd"
                state:"sd"
                zipCode:"012"
                homePhone:"011-123"
                workPhone:"011-123"
                mobilePhone:"011-123"
                fax:"011-123"
                tin:"123456789"
                tinType: 1
                email:"testemail@gmail.com"
                contactName:"ContactName"
                isCompany:true
                company:"Company"
                isPrimary:true
                deliveryOptions:0
                }
            ]
            setLenders:[
              {
                account:"test1234"
                firstName:"Lender Name"
                middleName:"Lender Middle Name"
                lastName:"Lender LastName"
                street:"Lender street"
                city:"COSTA"
                state:"CA"
                zipCode:"012"
                homePhone:"011-123"
                workPhone:"011-123"
                mobilePhone:"011-123"
                fax:"011-123"
                tin:"123456789"
                email:"email@gmail.com"
              }
            ]
            setProperties:
            [
                {
                description:"Description"
                street:"Street"
                city:"City"
                state:"sa"
                zipCode:"011"
                county:"SLASD"
                occupancyStatus:1
                type:0
                isPrimary:true
                }
            ]
            setFundings:[
              {
                funds: 126.00
                brokerFeePct: 0.00
                brokerFeeFlat: 11.00
                brokerFeeMin: 10.00
                lenderAccount: "test1234"
                vendorFeePct: 0.00
                vendorFeeFlat: 0.00
                vendorFeeMin: 0.00
                roundError: true
                rateType: 1
                rateValue: 12.00
                gSTaxUse: true
                brokerFeeFlatNPerf: 95.00
                brokerFeeMinNPerf: 95.00
                brokerResFee: 0.00
                brokerResAddFee: 0.00
                brokerResAddDays: 0
                brokerResAddFee_2: 0.00
                brokerResAddDays_2: 0
                brokerResAddFee_3: 0.00
                brokerResAddDays_3: 60
                trustAccount: "FCI - Pool 1 Trust Account"
              }
            ]
        }
    )
}
```

```json
{
    "data": {
        "insertBoarding": "test-23b0c368f8"
    }
}
```

### Push API - Boarding Loans / Boarding Multiple Loans

- **Method / URL:** `POST https://fapi.myfci.com/graphql`

**Example — Boarding Multiple Loans**

```json
{
    "data": {
        "insertBoarding": "8c0a14507892415"
    }
}
```
