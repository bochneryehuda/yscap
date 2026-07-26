

===== Encompass Loan/AUS Tracking Logs/01 - Create an AUS Tracking log =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ausTrackingLogs?view=id
--- REQUEST BODY ---
{
    
    "application": {
        "entityId": "borrower_2",
        "entityType": "application"
    },
    "uwRiskAssessType": "Other",
    "submissionDate": "2018-09-30T22:14:00Z",
    "firstSubmissionDate": "2018-10-04T07:00:00Z",
    "submissionNumber": "151",
    "recommendation": "",
    "duCaseIdOrLpAusKey": "487",
    "submittedBy": "TestUser",
    "version": "1",
    "docClass": "Testclass"
}
QUERY: view=id  # 


===== Encompass Loan/AUS Tracking Logs/02 - Get specific AUS tracking log =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ausTrackingLogs/{{ausTrackingLogId}}


===== Encompass Loan/AUS Tracking Logs/03 - Get list of AUS tracking Logs =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ausTrackingLogs


===== Encompass Loan/AUS Tracking Logs/04 - Get AUS Tracking log snapshot =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ausTrackingLogs/{{ausTrackingLogId}}/snapshot


===== Encompass Loan/AUS Tracking Logs/05 - Update an AUS Tracking log =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ausTrackingLogs/{{ausTrackingLogId}}?view=entity
--- REQUEST BODY ---
{
    
    "uwRiskAssessType": "LQA",
    "submissionDate": "2018-09-30T22:14:00Z",
    "firstSubmissionDate": "2018-10-04T07:00:00Z",
    "submissionNumber": "151",
    "recommendation": "100",
    "duCaseIdOrLpAusKey": "487",
    "submittedBy": "Tom",
    "version": "1",
    "docClass": "Test"
}
QUERY: view=entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Disclosure Tracking Log Email Messages/03 - Get List of Manual DT 2015 Logs Copy =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/emailMessage


===== Encompass Loan/Disclosure Tracking/V3 Add Manual Disclosure Tracking 2015 Logs/01a - Add Manual DT 2015 Log with LE =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?applicationId={{applicationId}}&view=Entity&includeSnapshot=true
--- REQUEST BODY ---
{
    "disclosedMethod": "InPerson",
    "contents": [
        "LE",
        "ServiceProviderListNoFee",
        "SafeHarbor"
    ]
}
QUERY: applicationId={{applicationId}}  # 
QUERY: view=Entity  # 
QUERY: includeSnapshot=true  # 


===== Encompass Loan/Disclosure Tracking/V3 Add Manual Disclosure Tracking 2015 Logs/01b - Add Manual DT 2015 Log with CD =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?applicationId={{applicationId}}&view=entity
--- REQUEST BODY ---
{
    "disclosedMethod": "InPerson",
    "contents": [
        "CD"
    ]
}
QUERY: applicationId={{applicationId}}  # 
QUERY: view=entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Add Manual Disclosure Tracking 2015 Logs/01b - Add Manual DT 2015 Log with CD =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=entity
--- REQUEST BODY ---
{
    "intentToProceed": {
        "intent": true,
        "date": "2021-07-17"       
    }
}
QUERY: view=entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Add Manual Disclosure Tracking 2015 Logs/03 - Get List of Manual DT 2015 Logs =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs


===== Encompass Loan/Disclosure Tracking/V3 Add Manual Disclosure Tracking 2015 Logs/04 - Get Specific Manual DT 2015 Log =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?includeSnapshot=true
QUERY: includeSnapshot=true  # 


===== Encompass Loan/Disclosure Tracking/V3 Add Manual Disclosure Tracking 2015 Logs/05 - Get Specific Manual DT 2015 Log Snapshot =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/snapshot


===== Encompass Loan/Disclosure Tracking/V3 DT Log - Manual Fulfillment/01 - Create Loan =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans?loanFolder=My+Pipeline&view=entity
--- REQUEST BODY ---
{
    "applications": [
    	{
        "borrower": {
            "FirstName": "andy",
            "LastName": "america",
            "TaxIdentificationIdentifier": "999-60-3333",
            "MaritalStatusType": "Married",
            "TotalMonthlyIncomeMinusNetRentalAmount": "10000.00"
        },
        "coborrower": {
            "FirstName": "amy",
            "LastName": "america",
            "EmailAddressText": "{{emailAddress}}",
            "TaxIdentificationIdentifier": "500-60-2222",
            "TotalMonthlyIncomeMinusNetRentalAmount": "3500.00"
        }
    }
    ],
    "property": {
        "LoanPurposeType": "NoCash-Out Refinance",
        "RefinancePropertyExistingLienAmount": "400000.00",
        "RefinancePropertyAcquiredYear": 1999,
        "RefinancePropertyOriginalCostAmount": "450000.00",
        "StreetAddress": "4321 CulDeSac Street",
        "City": "Someplace",
        "State": "MA",
        "PostalCode": "02723",
        "FinancedNumberOfUnits": 1
    },
    "ratelock":{
    "currentNumberOfDays" : 10
    },
    "customFields": [
    	{
    		"fieldName": "CX.123",
    		"value": "test1"
    	},
    	{
    		"fieldName": "LR.2146",
    		"value": "20"
    	}
    	]
}
QUERY: loanFolder=My+Pipeline  # 
QUERY: view=entity  # 


===== Encompass Loan/Disclosure Tracking/V3 DT Log - Manual Fulfillment/02 - Create Disclosure Tracking Log =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity
--- REQUEST BODY ---
{
    "disclosedMethod": "ByMail",
    "contents": [
        "LE"
    ]
}
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 DT Log - Manual Fulfillment/03 - Create Fulfillment =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/fulfillments
--- REQUEST BODY ---
{
    "disclosedMethod": "ByMail",
    "orderedBy": "Test User",
    "processedDate": "2023-03-21T16:15:04Z",
    "recipients": [
        {
            "comments": "Manually fulfilled by Test User",
            "actualDate": "2023-03-21T16:15:04Z"
        }
    ]
}
QUERY: =  # 


===== Encompass Loan/Disclosure Tracking/V3 DT Log - Manual Fulfillment/04 - Get a list of DT Logs =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs
--- REQUEST BODY ---
{
 "channel": "Correspondent",   
  "correspondent": {
  	"AutoPublishConditions":true
  },
"applications": [
        {
            "borrower": {
                "firstName": "milestonefreerole",
                "middleName": "Testing UPDATE loan",
                "lastName": "Closing cost template with data param",
                "emailAddressText": "{{emailAddress}}"
            }
        }
    ],
    "borrowerRequestedLoanAmount": "100000.00",
    "purchasePriceAmount": "110000.00",
    "propertyEstimatedValueAmount": "100000",
    "propertyAppraisedValueAmount": "90000",
    "fees": [
        {
            "feeType": "UserDefinedFee_701",
            "paidToName": "WhatsApp Inc."
        },
        {
            "feeType": "UserDefinedFee_702",
            "paidToName": "Instagram"
        },
        {
            "feeType": "UserDefinedFee_704",
            "paidToName": "Facebook",
            "borPaidAmount": "3999.99",
            "sellerPaidAmount": "799.99"
        }
    ],
    "closingCost": {
        "gfe2010": {
            "gfe2010Fees": [
                {
                    "gfe2010FeeParentType": "Section700",
                    "gfe2010FeeType": "Line704",
                    "gfe2010FeeIndex": "0",
                    "paidToName": "Mark Zuckerberg"
                },
                {
                    "gfe2010FeeParentType": "Section700",
                    "gfe2010FeeType": "Line701",
                    "gfe2010FeeIndex": "0",
                    "borPaidAmount": "1999.99",
                    "selPaidAmount": "999.99"
                },
                {
                    "gfe2010FeeParentType": "Section700",
                    "gfe2010FeeType": "Line702",
                    "gfe2010FeeIndex": "0",
                    "borPaidAmount": "2999.99",
                    "selPaidAmount": "899.99"
                },
                {
                    "gfe2010FeeParentType": "POCPTC700",
                    "gfe2010FeeType": "Undefined",
                    "gfe2010FeeIndex": "3",
                    "pocPtcIndicator": "True"
                }
            ]
        }
    }
}


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/01 -  CreateLoan_multipleApps_NBO =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans?loanFolder=Usha&view=Entity
--- REQUEST BODY ---
{
    "channel": "Retail",
    "loanProgramName": "EBSP102_AllFields",
  //
    "nonBorrowingOwners": [
        {
            "id": "cd4967dd-1f9f-4b7f-a602-33923e353b6f",
            "nonBorrowingOwnerIndex": 1,
            "firstName": "Non Borrower 1",
            "middleName": "Middle",
            "lastName": "Borrower1",
            "suffixName": "Mr",
            "addressStreet": "1245 Preston Road",
            "addressCity": "Dallas",
            "addressState": "TX",
            "addressPostalCode": "75252",
            "borrowerType": "Title only",
            "homePhoneNumber": "323-232-3232",
            "email": "{{emailAddress}}",
            "no3rdPartyEmailIndicator": true,
            "businessPhoneNumber": "323-123-2132 13",
            "cellPhoneNumber": "312-321-3321",
            "faxNumber": "232-132-1332",
            "dateOfBirth": "1989-08-21"
        }
    ],
    "applications": [
        {
            "borrower": {
                "borrowerType": "Individual",
                "emailAddressText": "{{emailAddress}}",
                "firstName": "Mickey",
                "lastName": "Mouse",
                "maritalStatusType": "Married",
                "taxIdentificationIdentifier": "991919991",
                "birthDate": "1980-10-30",
                "borrowerTypeInSummary": "Individual",
                "mailingAddress": {
                    "addressStreetLine1": "123 SK Rd",
                    "addressCity": "Fremont",
                    "addressState": "CA",
                    "addressPostalCode": 94538
                }
            },
            "coborrower": {
                "borrowerType": "Individual",
                "emailAddressText": "{{emailAddress}}",
                "firstName": "Minnie",
                "lastName": "Mouse",
                "maritalStatusType": "Married",
                "taxIdentificationIdentifier": "991919991",
                "birthDate": "1980-12-30",
                "borrowerTypeInSummary": "Individual",
                "mailingAddress": {
                    "addressStreetLine1": "123 SK Rd",
                    "addressCity": "Cupertino",
                    "addressState": "CA",
                    "addressPostalCode": 94538
                }
            },
            "propertyUsageType": "PrimaryResidence",
            "income": [
                {
                    "owner": "Borrower",
                    "incomeType": "Base",
                    "amount": 5000
                }
            ]
        },
         {
            "borrower": {
                "borrowerType": "Individual",
                "emailAddressText": "{{emailAddress}}",
                "firstName": "Tom",
                "lastName": "Smith",
                "maritalStatusType": "Married",
                "taxIdentificationIdentifier": "991919991",
                "birthDate": "1980-10-30",
                "borrowerTypeInSummary": "Individual",
                "mailingAddress": {
                    "addressStreetLine1": "123 SK Rd",
                    "addressCity": "Fremont",
                    "addressState": "CA",
                    "addressPostalCode": 94538
                }
            },
            "coborrower": {
                "borrowerType": "Individual",
                "emailAddressText": "{{emailAddress}}",
                "firstName": "Bob",
                "lastName": "Smith",
                "maritalStatusType": "Married",
                "taxIdentificationIdentifier": "991919991",
                "birthDate": "1980-12-30",
                "borrowerTypeInSummary": "Individual",
                "mailingAddress": {
                    "addressStreetLine1": "123 SK Rd",
                    "addressCity": "Cupertino",
                    "addressState": "CA",
                    "addressPostalCode": 94538
                }
            },
            "propertyU
QUERY: loanFolder=Usha  # 
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/02 -  Update 4499 to FullexternaleConsent =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}?view=entity
--- REQUEST BODY ---
{
    "regulationZ": {
        "externaleConsent": "FullExternalEConsent"
    }
}
QUERY: loanFolder=My%20Pipeline  # 
QUERY: view=entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/03 -  Add Manual LE DT to Borrower1 =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity
--- REQUEST BODY ---
{
    "disclosedMethod": "ByMail",
    "contents": [
        "LE"
    ]
}
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/04 -  Update DT Add eConsent to Borrower1 =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=Entity
--- REQUEST BODY ---
{
    "disclosurerecipients": [
        {
            "id": "{{dtBorrower1recptId}}",
            "tracking": {
                "acceptconsentdate": "2022-06-28T06:23:00z",
                "esigneddate": "2022-06-28T06:24:00z",
                "viewmessagedate": "2022-06-28T06:23:00z",
                "authenticateddate": "2022-06-28T06:23:00z",
                "authenticatedip": "209.220.148.33",
                "acceptconsentip": "209.220.148.33",
                "esignedip": "104.129.192.111",
                "viewesigneddate": "2022-07-09T16:23:00z",
                "informationalViewedDate": "2024-11-20T23:33:07Z",
                "informationalViewedIP": "209.220.148.33",
                "informationalCompletedDate": "2024-11-20T23:33:07Z",
                "informationalCompletedIP": "209.220.148.33"
                }
            }
        ]
    }
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/05 -  Add Manual LE DT to Borrower2 =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity&applicationId={{applicationId1}}
--- REQUEST BODY ---
{
    "disclosedMethod": "ByMail",
    "contents": [
        "LE"
    ]
}
QUERY: view=Entity  # 
QUERY: applicationId={{applicationId1}}  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/06 - Update DT Add eConsent to Borrower2 =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=Entity
--- REQUEST BODY ---
{
    "disclosurerecipients": [
        {
            "id": "{{dtBorrower1recptId}}",
            "tracking": {
                "acceptconsentdate": "2022-06-28T06:23:00z",
                "esigneddate": "2022-06-28T06:24:00z",
                "viewmessagedate": "2022-06-28T06:23:00z",
                "authenticateddate": "2022-06-28T06:23:00z",
                "authenticatedip": "209.220.148.33",
                "acceptconsentip": "209.220.148.33",
                "esignedip": "104.129.192.111",
                "viewesigneddate": "2022-07-09T16:23:00z",
                "informationalViewedDate": "2024-11-20T23:33:07Z",
                "informationalViewedIP": "209.220.148.33",
                "informationalCompletedDate": "2024-11-20T23:33:07Z",
                "informationalCompletedIP": "209.220.148.33"
                }
            }
        ]
    }
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/07 - Add Manual CD DT to Borrower1 =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity
--- REQUEST BODY ---
{
    "disclosedMethod": "ByMail",
    "contents": [
        "CD"
    ]
}
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/08 - Update DT mark use for UCD =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=Entity
--- REQUEST BODY ---
{
    "useForUcdExport": true
}
QUERY: view=Entity  # 


===== Encompass Loan/Disclosure Tracking/V3 Update Disclosure Tracking (including eConsent and UCD)/09 - V3 getlist of DTs =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs
--- REQUEST BODY ---
{
 "channel": "Correspondent",   
  "correspondent": {
  	"AutoPublishConditions":true
  },
"applications": [
        {
            "borrower": {
                "firstName": "milestonefreerole",
                "middleName": "Testing UPDATE loan",
                "lastName": "Closing cost template with data param",
                "emailAddressText": "{{emailAddress}}"
            }
        }
    ],
    "borrowerRequestedLoanAmount": "100000.00",
    "purchasePriceAmount": "110000.00",
    "propertyEstimatedValueAmount": "100000",
    "propertyAppraisedValueAmount": "90000",
    "fees": [
        {
            "feeType": "UserDefinedFee_701",
            "paidToName": "WhatsApp Inc."
        },
        {
            "feeType": "UserDefinedFee_702",
            "paidToName": "Instagram"
        },
        {
            "feeType": "UserDefinedFee_704",
            "paidToName": "Facebook",
            "borPaidAmount": "3999.99",
            "sellerPaidAmount": "799.99"
        }
    ],
    "closingCost": {
        "gfe2010": {
            "gfe2010Fees": [
                {
                    "gfe2010FeeParentType": "Section700",
                    "gfe2010FeeType": "Line704",
                    "gfe2010FeeIndex": "0",
                    "paidToName": "Mark Zuckerberg"
                },
                {
                    "gfe2010FeeParentType": "Section700",
                    "gfe2010FeeType": "Line701",
                    "gfe2010FeeIndex": "0",
                    "borPaidAmount": "1999.99",
                    "selPaidAmount": "999.99"
                },
                {
                    "gfe2010FeeParentType": "Section700",
                    "gfe2010FeeType": "Line702",
                    "gfe2010FeeIndex": "0",
                    "borPaidAmount": "2999.99",
                    "selPaidAmount": "899.99"
                },
                {
                    "gfe2010FeeParentType": "POCPTC700",
                    "gfe2010FeeType": "Undefined",
                    "gfe2010FeeIndex": "3",
                    "pocPtcIndicator": "True"
                }
            ]
        }
    }
}


===== Encompass Loan/Disclosure Tracking/V1 Disclosure Tracking 2015 Logs/01 - Get List of DT 2015 logs =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/disclosureTracking2015


===== Encompass Loan/Disclosure Tracking/V1 Disclosure Tracking 2015 Logs/02 - Get a Specific DT 2015 log =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/disclosureTracking2015/{{dtLogId}}


===== Encompass Loan/Disclosure Tracking/V1 Disclosure Tracking 2015 Logs/03 - Get snapshot of a Specific DT 2015 log =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/disclosureTracking2015/5edb2949-666e-4ebf-8873-1ecc418a32cd/snapshot


===== Encompass Loan/Disclosure Tracking/V3 Disclosure Tracking Snapshots/01 - Get Disclosure Tracking Snapshots =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/snapshots


===== Encompass Loan/Disclosure Tracking/V3 Disclosure Tracking Snapshots/02 - Get Disclosure Tracking Snapshot for Specific DT Log =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/snapshot


===== Encompass Loan/eFolder Documents/V3 Manage Documents/01 - Create a Document =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents?action=add&view=entity
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation
--- REQUEST BODY ---
[
  {
    "title": "Testing Doc",
    "description": "Testing Doc creation through v3 API"
  }
]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/eFolder Documents/V3 Manage Documents/02 - Retrieve a Document =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents/{{doc_id}}
--- DESCRIPTION ---
This step retrieves the loan you created.


===== Encompass Loan/eFolder Documents/V3 Manage Documents/03 - Retrieve Documents =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents?view=Full
--- DESCRIPTION ---
This step retrieves the loan you created.
QUERY: includeRemoved=true  # 
QUERY: requireActiveAttachments=false  # 
QUERY: view=Full  # Possible values are Detail, Full or Summary. Detail is the default.


===== Encompass Loan/eFolder Documents/V3 Manage Documents/04 - Update a Document =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents?action=update&view=entity
--- DESCRIPTION ---
Update the loan you created by updating the last name of tbe borrower
--- REQUEST BODY ---
[
    {
        "id": "{{doc_id}}",
        "title": "Testing Doc 1 Update 2"
    }
]
QUERY: action=update  # 
QUERY: view=entity  # 


===== Encompass Loan/eFolder Documents/V3 Manage Documents/05 - Add Comments to a Document =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents/{{doc_id}}/comments?action=add&view=entity
--- DESCRIPTION ---
Update the loan you created by updating the last name of tbe borrower
--- REQUEST BODY ---
[
  {
    "comments": "Testing Add Comments to Doc"
  }
]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/eFolder Documents/V3 Manage Documents/06 - Assign Attachments =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents/{{doc_id}}/attachments?action=add
--- DESCRIPTION ---
Update the loan you created by updating the last name of tbe borrower
--- REQUEST BODY ---
[
  {
    "entityId" : "Attachment-21518389-0f20-4f62-b6c9-e9516155f2d7.TXT",
    "entityType" : "attachment"
  }
]
QUERY: action=add  # 


===== Encompass Loan/eFolder Documents/V3 Manage Documents/07 - Remove a Document =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/documents?action=remove
--- DESCRIPTION ---
Update the loan you created by updating the last name of tbe borrower
--- REQUEST BODY ---
[
    {
        "id": "{{doc_id}}"
    }
]
QUERY: action=remove  # 


===== Encompass Loan/eFolder Documents/V1 Manage Documents/01 - Create a Document =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/documents?view=id
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation
--- REQUEST BODY ---
{  
	"title": "Testing Folder",
	"description": "This is to test attachments",
	"requestedFrom": "User",
    "applicationId": "All",
    "emnSignature": "string",
    "dateRequested": "2017-01-07T01:57:23.085Z",
    "dateExpected": "2017-01-07T01:57:23.085Z",
    "dateReceived": "2017-01-07T01:57:23.085Z",
    "dateReviewed": "2017-01-07T01:57:23.085Z",
    "dateReadyForUw": "2017-01-07T01:57:23.085Z",
    "dateReadyToShip": "2017-01-07T01:57:23.085Z" ,                
    "comments": [
        {
            "comments": "Test Comments",
            "forRoleId": 1         
        }
    ]
}
QUERY: view=id  # 


===== Encompass Loan/eFolder Documents/V1 Manage Documents/02 - Retrieve a Document =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/documents/{{doc_id}}
--- DESCRIPTION ---
This step retrieves the loan you created.


===== Encompass Loan/eFolder Documents/V1 Manage Documents/04 - Retrieve Document's Attachments =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/documents/{{doc_id}}/attachments
--- DESCRIPTION ---
This step retrieves the loan you created.


===== Encompass Loan/eFolder Documents/V1 Manage Documents/03 - Retrieve Documents =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/documents
--- DESCRIPTION ---
This step retrieves the loan you created.


===== Encompass Loan/eFolder Documents/V1 Manage Documents/05 - Update a Document =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/documents/{{doc_id}}?view=entity
--- DESCRIPTION ---
Update the loan you created by updating the last name of tbe borrower
--- REQUEST BODY ---
{
  "milestoneId": "Qualification",
  "webCenterAllowed": false,
  "tpoAllowed": false,
  "thirdPartyAllowed": false,
  "requestedBy": "devadmin",
  "rerequestedBy": "",
  "daysDue": 0,
  "isRequested": true,
  "isRerequested": true,
  "isReceived": true,
  "isReviewed": true,
  "isReadyForUw": true,
  "isReadyToShip": true,
  "receivedBy": "devadmin",
  "daysTillExpire": 0,
  "reviewedBy": "devadmin",
  "readyForUwBy": "devadmin",
  "readyToShipBy": "devadmin",
  "dateExpires": "2017-04-07T01:57:23.053Z",
  "title": "New Document",
  "description": "Test Description",
  "requestedFrom": "From Me",
  "applicationId": "All",
  "emnSignature": "test",
  "dateRequested": "2017-04-07T01:57:23Z",
  "dateReceived": "2017-04-07T01:57:23Z",
  "dateReviewed": "2017-04-07T01:57:23Z",
  "dateReadyForUw": "2017-04-07T01:57:23Z",
  "dateReadyToShip": "2017-04-07T01:57:23Z"
}
QUERY: view=entity  # 


===== Encompass Loan/eFolder Documents/V1 Manage Documents/06 - Assign Attachments =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/documents/{{doc_id}}/attachments?action=add
--- DESCRIPTION ---
Update the loan you created by updating the last name of tbe borrower
--- REQUEST BODY ---
[
  {
    "entityId" : "Attachment-21518389-0f20-4f62-b6c9-e9516155f2d7.TXT",
    "entityType" : "attachment"
  }
]
QUERY: action=add  # 


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/01 - Upload Attachment to eFolder =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments/url?view=id
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation
--- REQUEST BODY ---
{
	"title": "hello.doc",
	"fileWithExtension":"hello.doc",
	"createReason": 1
}
QUERY: view=id  # 


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/01 - Upload Attachment to eFolder =====
METHOD: PUT
URL: {{mediaURL}}
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/02 - Get Attachment =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}
--- DESCRIPTION ---
Retrieves an attachment by its ID within a loan


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/03 - Get Attachments =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments
--- DESCRIPTION ---
Retrieves an attachment by its ID within a loan


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/04 - Get Attachment from eFolder =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}/url
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/05 - Get Page of Attachment =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}/pages/{{pageId}}/url
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/06 - Get Thumbnail of Page =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}/pages/{{pageId}}/thumbnail/url
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.


===== Encompass Loan/eFolder Attachments/V1 Manage Attachments/07 - Update Attachment =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}
--- REQUEST BODY ---
{}


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/01a - Get URL to Upload Attachment to eFolder =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachmentUploadUrl
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation
--- REQUEST BODY ---
{
  "file": {
      "contentType": "application/pdf",
      "name": "ratelocks.pdf",
      "size": 10000
    },
    "title": "Rate locks doc"
}


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/Get URL to Upload Attachment and Assign to eFolder =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachmentUploadUrl
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation
--- REQUEST BODY ---
{
  "file": {
      "contentType": "application/pdf",
      "name": "ratelocks.pdf",
      "size": 10000
    },
    "title": "Rate locks doc",
    "assignTo": {
        "entityId": "{{documentEntityId}}",
        "entityType": "Document"
    }
}


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/01b - Upload Attachment =====
METHOD: PUT
URL: {{UploadURL}}
--- DESCRIPTION ---
Create a loan based on the sample provided in the developer connect documentation


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/02 - Get Attachment =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachments/{{AttachmentId}}
--- DESCRIPTION ---
Retrieves an attachment by its ID within a loan


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/03 - Get Attachments =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachments?includeRemoved=true
--- DESCRIPTION ---
Retrieves an attachment by its ID within a loan
QUERY: includeRemoved=true  # 


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/04 - Download Original Attachment =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachmentDownloadUrl
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.
--- REQUEST BODY ---
{
  "attachments": [
    "{{AttachmentId}}"
  ]
}


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/05 - Update an Attachment =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachments?action=update&view=entity
--- REQUEST BODY ---
[
	{
		"id": "Attachment-d7725480-ee95-410a-8e64-aed6fae2c6b2.pdf",
		"type": "Native",
		"title": "Update Rate locks attachment"
	}
	]

QUERY: action=update  # 
QUERY: view=entity  # 


===== Encompass Loan/eFolder Attachments/V3 Manage Attachments/06 - Remove an Attachment =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/attachments?action=remove
--- REQUEST BODY ---
[
	{
		"id": "{{AttachmentId}}"
	}
	]

QUERY: action=remove  # 


===== Encompass Loan/eFolder Attachments/eFolder Attachment Metadata/01 - Get Attachment Metadata =====
METHOD: GET
URL: {{API_SERVER}}/efolder/v1/loans/{{loanId}}/files/{{AttachmentId}}?includeMetaData=true
--- DESCRIPTION ---
Retrieves an attachment by its ID within a loan
QUERY: includeMetaData=true  # 


===== Encompass Loan/eFolder Export Attachments/01- Create an Export Job =====
METHOD: POST
URL: {{API_SERVER}}/efolder/v1/loans/{{loanId}}/exportJobsCreator
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.
--- REQUEST BODY ---
{
    "annotationSettings": {
        "visibility": [
            "Private"
        ]
    },
    "exportEntity": {
        "exportMeta": [
            {
                "fileName": "Job1.pdf",
                "entities": [
                    {
                        "entityType": "urn:elli:encompass:document",
                        "entityId": "525bae6a-9621-4474-9836-d935a86acca1"
                    }
                ],
                "requestId": "{{requestId}}"
            },
            {
                "fileName": "Job2.pdf",
                "entities": [
                    {
                        "entityType": "urn:elli:encompass:document",
                        "entityId": "4f29e3e4-a3b5-42e8-a75c-30144d61f952"
                    }
                ],
                "requestId": "{{requestId2}}"
            }
        ]
    },
    "requestId": "Export for Loan {{loanId}}"
}


===== Encompass Loan/eFolder Export Attachments/02 - Get Status of Export Job =====
METHOD: GET
URL: {{API_SERVER}}/efolder/v1/exportjobs/531d1bfb-8366-47e0-8668-b600191cd503
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.


===== Encompass Loan/eFolder Export Attachments/03- Create an Export Job for Multiple Attachment Requests =====
METHOD: POST
URL: {{API_SERVER}}/efolder/v1/loans/{{loanId}}/exportJobsCreator?skipPersonaChecks=false&includeNotActive=true
--- DESCRIPTION ---
Retrieves the URL for downloading an attachment of a loan. The URL is time sensitive. The URL needs to be invoked as a GET.
--- REQUEST BODY ---
{
  "annotationSettings": {
    "visibility": [
      "Private"
    ]
  },
  "exportEntity": {
    "exportMeta": [
      {
        "entities": [
          {
            "entityType": "urn:elli:encompass:document",
            "entityId": "{{documentId1}}"
          }
        ]
      },
      {
        "entities": [
          {
            "entityType": "urn:elli:encompass:document",
            "entityId": "{{documentId2}}"
          }
        ]
      }
    ]
  },
  "requestId": "test"
}
QUERY: skipPersonaChecks=false  # 
QUERY: includeNotActive=true  # 


===== Encompass Loan/eFolder History/01 - Get eFolder History =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/histories/efolder
--- DESCRIPTION ---
Retrieves an attachment by its ID within a loan


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/01 - Get list of conditions =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/02 - Get a specific condition =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}?view=full
QUERY: view=full  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/03a - Add conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions?action=add&view=entity
--- REQUEST BODY ---
[
	{
		 "title": "whatever",
        "conditionType": "X-3",
		"documentReceiptDate": "2020-08-15"
	}
	]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/03b - Duplicate conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions?action=duplicate&view=entity
--- REQUEST BODY ---
[
	{
		"id" : "b4f333ca-a114-4445-acca-233394f21f56"
	}
	]
QUERY: action=duplicate  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/04 - Update conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions?action=update&view=entity
--- REQUEST BODY ---
[
	{
		"id" : "1684da15-3fe9-4484-a1ce-8b6731da2e11",
		"internalDescription": "Collect signed and dated returns with all pages and schedules..."
	}
	]
QUERY: action=update  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/05 - Add comments to a condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments?action=add&view=entity
--- REQUEST BODY ---
[
	{
	 "comments": "comment1"
	},
	{
	 "comments": "comment2"
	}
	]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/06 - Get a condition's comments =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/07 - Update a condition's comments =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments?action=update&view=entity
--- REQUEST BODY ---
[
	{
		"id" : "418b8044-977b-467e-a012-1f9e72ed49fa",
		"isExternal" : false
	}
	]
QUERY: action=update  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/08 - Delete a condition's comments =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments?action=delete&view=entity
--- REQUEST BODY ---
[
	{
		"id" : "418b8044-977b-467e-a012-1f9e72ed49fa"	
	}
	]
QUERY: action=delete  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/09 - Update Status Tracking =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/tracking?action=add&view=entity
--- REQUEST BODY ---
[
	{
	 "status": "Received",
	 "isChecked" : true
	}
	]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/10 - Get Status Tracking =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/tracking


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/11 - Assign Documents to Condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/documents?action=add&view=entity
--- REQUEST BODY ---
[
	{
	 "entityId" : "",
	 "entityType" :"Document"
	}
	]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/12 - Unassign Documents to Condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/documents?action=remove
--- REQUEST BODY ---
[
{
	 "entityId" : "63f1f7a9-772f-4c8f-a137-617df038f43f",
	 "entityType" :"Document"
	}
	]
QUERY: action=remove  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/13 - Get a condition's Documents =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/documents


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/14 - Remove conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions?action=remove
--- REQUEST BODY ---
[
	{
		"id" : "{{ConditionId}}"
	}
	]
QUERY: action=remove  # 


===== Encompass Loan/Enhanced Conditions/Manage Enhanced Conditions/26.2R 15 - Update Delegation =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conditions?action=update&view=entity
--- REQUEST BODY ---
[
  {
    "id": "{{conditionId}}",
    "delegatedTrackingStatuses": [
      {
        "name": "Review",
        "action": "Add",
        "role": {
          "entityId": 1,
          "entityType": "Role"
        }
      }
    ]
  }
]
QUERY: action=update  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/01 - Create an Underwriting Condition =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting?view=entity
--- REQUEST BODY ---
    {
    	"priorTo": "Approval",
    	"category": "Credit",
    	"owner": "Loan Officer",
    	"printExternally": true,
    	"printInternally": true,
    	"isFulfilled": true,
    	"fulfilledDate": "2018-03-30T06:18:25Z",
    	"fulfilledBy": {
    		"entityId": "bryanborrower",
    		"entityType": "User"
    	},
    	"conditionType": "Underwriting",
    	"isRemoved": false,
    	"title": "Create UWC Test",
    	"description": "Under writing Condition Description",
	"forAllApplications" : true,
    	"source": "Manual",
    	"expectedDate": "2018-04-02T07:00:00Z",
    	"status": "Received",
    	"statusDate": "2018-03-30T06:18:53Z",
    	"daysToReceive": 4,
    	"requestedFrom": "devadmin",
    	"createdDate": "2018-03-30T06:17:36Z",
    	"createdBy": {
    		"entityId": "devadmin",
    		"entityType": "User"

    	},
    	"isRequested": true,
    	"requestedDate": "2018-03-30T06:18:32Z",
    	"requestedBy": {
    		"entityId": "bryanborrower",
    		"entityType": "User"

    	},
    	"isReceived": true,
    	"receivedDate": "2018-03-30T06:18:53Z",
    	"receivedBy": {
    		"entityId": "bryanborrower",
    		"entityType": "User"
    	},
    	"comments": [{

    			"comments": "New Test UWC Comments",
    			"forRoleId": 1,
    			"forRole": {
    				"entityId": "1",
    				"entityType": "Role"

    			}
    		},
    		{

    			"comments": "New Test UWC Comments 2",
    			"forRoleId": 1,
    			"forRole": {
    				"entityId": "1",
    				"entityType": "Role"

    			}
    		},
    		{

    			"comments": "New Test UWC Comments 3",
    			"forRoleId": 1,
    			"forRole": {
    				"entityId": "1",
    				"entityType": "Role"

    			}
    		}

    	],
    	"documents": [{
    		"entityId": "{{doc_id}}"
    	}]
    }
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/02 - Get a specific Underwriting condition =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}?view=entity
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/03 - Get list of Underwriting conditions =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/04 - Add Underwriting conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encomapss/v1/loans/{{loanId}}/conditions/underwriting?action=add
--- REQUEST BODY ---
 [
 	{
 	"priorTo": "Approval",
 	"category": "Credit",
 	"owner": "Loan Officer",
 	"printExternally": true,
 	"printInternally": true,
 	"isFulfilled": true,
 	"fulfilledDate": "2018-03-30T06:18:25Z",
 	"fulfilledBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "SumanLO true Madduluri"
 	},

 	"conditionType": "Underwriting",
 	"isRemoved": false,
 	"title": "Create UWC 1",
 	"description": "Add UWC for Update Operation",
 	"application": {
 		"entityId": "All",
 		"entityType": "Application",
 		"entityName": "All "
 	},
 	"source": "Manual",
 	"expectedDate": "2018-04-02T07:00:00Z",
 	"status": "Received",
 	"statusDate": "2018-03-30T06:18:53Z",
 	"daysToReceive": 4,
 	"requestedFrom": "devadmin",
 	"createdDate": "2018-03-30T06:17:36Z",
 	"createdBy": {
 		"entityId": "devadmin",
 		"entityType": "User",
 		"entityName": "dev mobile admin"
 	},
 	"isRequested": true,
 	"requestedDate": "2018-03-30T06:18:32Z",
 	"requestedBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "Bryan Nguyen"
 	},
 	"isReceived": true,
 	"receivedDate": "2018-03-30T06:18:53Z",
 	"receivedBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "Kris Admin"
 	},
 	"comments": [{

 		"comments": "Test UWC Comments",
 		"forRoleId": 1,
 		"forRole": {
 			"entityId": "1",
 			"entityType": "Role",
 			"entityName": "Loan Officer"
 		},
 		"dateCreated": "2018-03-30T06:19:14Z",
 		"createdBy": "devadmin",
 		"createdByName": "dev mobile admin"
 	}],
 	"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
 },
 {
 	"priorTo": "Approval",
 	"category": "Credit",
 	"owner": "Loan Officer",
 	"printExternally": true,
 	"printInternally": true,
 	"isFulfilled": true,
 	"fulfilledDate": "2018-03-30T06:18:25Z",
 	"fulfilledBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "SumanLO true Madduluri"
 	},

 	"conditionType": "Underwriting",
 	"isRemoved": false,
 	"title": "abc Create UWC 2",
 	"description": "Add UWC for Update Operation",
 	"application": {
 		"entityId": "All",
 		"entityType": "Application",
 		"entityName": "All "
 	},
 	"source": "Manual",
 	"expectedDate": "2018-04-02T07:00:00Z",
 	"status": "Received",
 	"statusDate": "2018-03-30T06:18:53Z",
 	"daysToReceive": 4,
 	"requestedFrom": "devadmin",
 	"createdDate": "2018-03-30T06:17:36Z",
 	"createdBy": {
 		"entityId": "devadmin",
 		"entityType": "User",
 		"entityName": "dev mobile admin"
 	},
 	"isRequested": true,
 	"requestedDate": "2018-03-30T06:18:32Z",
 	"requestedBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "Bryan Nguyen"
 	},
 	"isReceived": true,
 	"receivedDate": "2018-03-30T06:18:53Z",
 	"receivedBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "Kris Admin"
 	},
 	"comments": [{

 		"comments": "Test UWC Comments",
 		"forRoleId": 1,
 		"forRole": {
 			"entityId": "1",
 			"entityType": "Role",
 			"entityName": "Loan Officer"
 		},
 		"dateCreated": "2018-03-30T06:19:14Z",
 		"createdBy": "devadmin",
 		"createdByName": "dev mobile admin"
 	}],
 	"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
 },
 {
 	"priorTo": "Approval",
 	"category": "Credit",
 	"owner": "Loan Officer",
 	"printExternally": true,
 	"printInternally": true,
 	"isFulfilled": true,
 	"fulfilledDate": "2018-03-30T06:18:25Z",
 	"fulfilledBy": {
 		"entityId": "bryanborrower",
 		"entityType": "User",
 		"entityName": "SumanLO true Madduluri"
 	},

 	"conditionType": "Underwriting",
 	"isRemoved": false,
 	"title": "0 Create UWC 3",
 	"description": "Add UWC for Update Operation",
 	"application": {
 		"entityId": "All",
 		"entityType": "Application",
 		"entityName": "All "
 	},
 	"source": "Manual",
 	"expectedDate": "2018-04-02T07:00:00Z",
 	"status": "Receive
QUERY: action=add  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/05 -Update Underwriting conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting?action=update&view=id
--- REQUEST BODY ---
[
	{
		"priorTo": "Approval",
		"category": "Credit",
		"owner": "Loan Officer",
		"printExternally": true,
		"printInternally": true,
		"isFulfilled": true,
		"fulfilledDate": "2018-03-30T06:18:25Z",
		"fulfilledBy": {
			"entityId": "Devadmin",
			"entityType": "User",
			"entityName": "SumanLO true Madduluri"
		},
		"id": "{{ConditionId}}",
		"conditionType": "Underwriting",
		"isRemoved": false,
		"title": "UWC Update",
		"description": "Under writing Condition For Update",
		"forAllApplications" : true,
		"source": "Manual",
		"expectedDate": "2018-04-02T07:00:00Z",
		"status": "Received",
		"statusDate": "2018-03-30T06:18:53Z",
		"daysToReceive": 4,
		"requestedFrom": "devadmin",
		"createdDate": "2018-03-30T06:17:36Z",
		"createdBy": {
			"entityId": "devadmin",
			"entityType": "User",
			"entityName": "dev mobile admin"
		},
		"isRequested": false,
		"requestedDate": "2018-03-30T06:18:32Z",
		"requestedBy": {
			"entityId": "bryanborrower",
			"entityType": "User",
			"entityName": "Bryan Nguyen"
		},
		"isReceived": true,
		"receivedDate": "2018-03-30T06:18:53Z",
		"receivedBy": {
			"entityId": "bryanborrower",
			"entityType": "User",
			"entityName": "Kris Admin"
		},
		"comments": [{

			"comments": "Test UWC Comments 11",
			"forRoleId": 1,
			"forRole": {
				"entityId": "1",
				"entityType": "Role",
				"entityName": "Loan Officer"
			},
			"dateCreated": "2018-03-30T06:19:14Z",
			"createdBy": "devadmin",
			"createdByName": "dev mobile admin"
		}],
		"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
	}

]
QUERY: action=update  # 
QUERY: view=id  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/06 - Remove Underwriting conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting?action=remove
--- REQUEST BODY ---
[
    {
       "id": "1820c8ea-2050-41a6-a5b4-808525029f8d"
    }
]
QUERY: action=remove  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/07 - Add Comments to an Underwriting condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}/comments?action=add&view=entity
--- REQUEST BODY ---
  [{

  	"comments": "Comments Test 1",
  	"forRoleId": 7,
  	"forRole": {
  		"entityId": "7",
  		"entityType": "role"
  	}
  },
  {
  	"comments": "Comments Test 2",
  	"forRoleId": 6,
  	"forRole": {
  		"entityId": "6",
  		"entityType": "role"
  	}
  }]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/08 - Remove Comments from an Underwriting condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}/comments?action=remove
--- REQUEST BODY ---
  [{
  	"commentId": "c3f88f6a-8181-4674-8311-afd25319214a"
  }]
QUERY: action=remove  # 


===== Encompass Loan/Loan Conditions/UnderWriting Conditions/09 - Manage Documents for an Underwriting Condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}/documents?action=add&view=entity
--- REQUEST BODY ---
 [
    {
         "entityId": "e7bc576e-db82-4a42-b9d0-08c6307ae929",
         "entityType": "Document"
                
     }
]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/01 - Create a Preliminary condition =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary?view=entity
--- REQUEST BODY ---
{
	"priorTo": "Approval",
	"category": "Assets",
	"isFulfilled": true,
	"fulfilledDate": "2018-03-27T06:20:45Z",
	"fulfilledBy": {
		"entityId": "admin",
		"entityType": "User"
	},

	"conditionType": "Preliminary",
	"isRemoved": false,
	"title": "Prelim condition for Create",
	"description": "NEW PRELIMINARY CONDITIONS",
	"forAllApplications": true,
	"source": "Manual",
	"expectedDate": "2018-04-10T00:00:00Z",
	"status": "Fulfilled",
	"statusDate": "2018-03-27T06:20:45Z",
	"daysToReceive": 10,
	"requestedFrom": "SHAILENDRA GHEVDE",
	"createdDate": "2018-03-27T06:19:55Z",
	"createdBy": {
		"entityId": "admin",
		"entityType": "User"
	},
	"isRequested": true,
	"requestedDate": "2018-03-29T11:50:46Z",
	"requestedBy": {
		"entityId": "admin",
		"entityType": "User"
	},
	"isRerequested": true,
	"rerequestedDate": "2018-03-31T11:50:47Z",
	"rerequestedBy": {
		"entityId": "admin",
		"entityType": "User"
	},
	"isReceived": true,
	"receivedDate": "2018-04-05T11:50:47Z",
	"receivedBy": {
		"entityId": "admin",
		"entityType": "User"
	},
	"comments": [{

		"comments": "NEW PRELIMINARY CONDITIONS",
		"forRoleId": 1,
		"forRole": {
			"entityId": "1",
			"entityType": "Role",
			"entityName": "Loan Officer"
		},
		"dateCreated": "2018-03-27T06:20:27Z",
		"createdBy": "admin",
		"createdByName": "dev mobile admin"
	}]
}
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/02 - Get a specific Preliminary condition =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary/{{ConditionId}}?view=entity
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/03 - Get list of Preliminary conditions =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary


===== Encompass Loan/Loan Conditions/Preliminary Conditions/04 - Add Preliminary conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary?action=add&view=entity
--- REQUEST BODY ---
[{
	"priorTo": "Approval",
	"category": "Assets",
	"isFulfilled": true,
	"fulfilledDate": "2018-03-27T06:20:45Z",
	"fulfilledBy": {
		"entityId": "usha_lo_user",
		"entityType": "User",
		"entityName": "EPPS EmptyFacadeUserId",
		"entityUri": "/v1/users/1643792627"
	},
	"conditionType": "Preliminary",
	"isRemoved": false,
	"title": "PRELIMINARY CONDITIONS For Add",
	"description": "NEW PRELIMINARY CONDITIONS for Add",
	"application": {
		"entityId": "All",
		"entityType": "Application",
		"entityName": "All "
	},
	"source": "Manual",
	"expectedDate": "2018-04-10T07:00:00Z",
	"status": "Fulfilled",
	"statusDate": "2018-03-27T06:20:45Z",
	"daysToReceive": 10,
	"requestedFrom": "SHAILENDRA GHEVDE",
	"createdDate": "2018-03-29T10:46:21Z",
	"createdBy": {
		"entityId": "devadmin",
		"entityType": "User",
		"entityName": "dev mobile admin",
		"entityUri": "/v1/users/devadmin"
	},
	"isRequested": true,
	"requestedDate": "2018-03-29T11:50:46Z",
	"requestedBy": {
		"entityId": "auto_webpplsa",
		"entityType": "User",
		"entityName": "superadmin superadmin",
		"entityUri": "/v1/users/auto_webpplsa"
	},
	"isRerequested": true,
	"rerequestedDate": "2018-03-31T11:50:47Z",
	"rerequestedBy": {
		"entityId": "auto_nowebpplsa",
		"entityType": "User",
		"entityName": "superadmin no web ppl superadmin",
		"entityUri": "/v1/users/auto_nowebpplsa"
	},
	"isReceived": true,
	"receivedDate": "2018-04-05T11:50:47Z",
	"receivedBy": {
		"entityId": "bhagvat",
		"entityType": "User",
		"entityName": "Bhagavat Mehra",
		"entityUri": "/v1/users/bhagvat"
	},
	"comments": [{

		"comments": "NEW PRELIMINARY CONDITIONS",
		"forRoleId": 1,
		"forRole": {
			"entityId": "1",
			"entityType": "Role",
			"entityName": "Loan Officer"
		},
		"dateCreated": "2018-03-29T10:46:21Z",
		"createdBy": "devadmin",
		"createdByName": "dev mobile admin"
	}],
	"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
}]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/05 - Update Preliminary conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary?action=update&view=entity
--- REQUEST BODY ---
[{
	"priorTo": "Approval",
	"category": "Assets",
	"isFulfilled": true,
	"fulfilledDate": "2018-03-27T06:20:45Z",
	"fulfilledBy": {
		"entityId": "USHA_LO_USER",
		"entityType": "User",
		"entityName": "EPPS EmptyFacadeUserId",
		"entityUri": "/v1/users/1643792627"
	},
	"id": "{{ConditionId}}",
	"conditionType": "Preliminary",
	"isRemoved": false,
	"title": "UPDATE PRELIMINARY CONDITIONS FROM API",
	"description": "NEW PRELIMINARY CONDITIONS",
	"application": {
		"entityId": "All",
		"entityType": "Application",
		"entityName": "All "
	},
	"source": "Manual",
	"expectedDate": "2018-04-10T07:00:00Z",
	"status": "Fulfilled",
	"statusDate": "2018-03-27T06:20:45Z",
	"daysToReceive": 10,
	"requestedFrom": "SHAILENDRA GHEVDE",
	"createdDate": "2018-03-29T10:57:55Z",
	"createdBy": {
		"entityId": "devadmin",
		"entityType": "User",
		"entityName": "dev mobile admin",
		"entityUri": "/v1/users/devadmin"
	},
	"isRequested": true,
	"requestedDate": "2018-03-29T11:50:46Z",
	"requestedBy": {
		"entityId": "auto_webpplsa",
		"entityType": "User",
		"entityName": "superadmin superadmin",
		"entityUri": "/v1/users/auto_webpplsa"
	},
	"isRerequested": true,
	"rerequestedDate": "2018-03-31T11:50:47Z",
	"rerequestedBy": {
		"entityId": "auto_nowebpplsa",
		"entityType": "User",
		"entityName": "superadmin no web ppl superadmin",
		"entityUri": "/v1/users/auto_nowebpplsa"
	},
	"isReceived": true,
	"receivedDate": "2018-04-05T11:50:47Z",
	"receivedBy": {
		"entityId": "bhagvat",
		"entityType": "User",
		"entityName": "Bhagavat Mehra",
		"entityUri": "/v1/users/bhagvat"
	},
	"comments": [{

		"comments": "NEW PRELIMINARY CONDITIONS",
		"forRoleId": 1,
		"forRole": {
			"entityId": "1",
			"entityType": "Role",
			"entityName": "Loan Officer"
		},
		"dateCreated": "2018-03-29T10:57:55Z",
		"createdBy": "devadmin",
		"createdByName": "dev mobile admin"
	}],
	"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
}]
QUERY: action=update  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/06 - Remove Preliminary conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary?action=remove&view=entity
--- REQUEST BODY ---
[{
	"id": "{{ConditionId}}"
}]
QUERY: action=remove  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/07 -Manage Comments for a Preliminary Condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary/{{ConditionId}}/comments?action=remove&view=entity
--- REQUEST BODY ---
   [
            {
               "commentId": "1820c8ea-2050-41a6-a5b4-808525029f8d",
                "comments": "RR Preliminary ",
                "forRoleId": 7,
                "forRole": {
                    "entityId": "7",
                    "entityType": "Role",
                    "entityName": "Closer"
                },
                "dateCreated": "2018-03-27T06:38:09Z",
                "createdBy": "devadmin",
                "createdByName": "dev mobile admin"
            }
        ]
QUERY: action=remove  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/Preliminary Conditions/08 - Manage Documents for a Preliminary Condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/preliminary/{{ConditionId}}/documents?action=add&view=entity
--- REQUEST BODY ---
 [
    {
         "entityId": "e7bc576e-db82-4a42-b9d0-08c6307ae929",
         "entityType": "Document"
                
     }
]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/01 - Create a Postclosing condition =====
METHOD: POST
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing?view=entity
--- REQUEST BODY ---
{
	"priorTo": "Approval",
	"category": "Assets",
	"isFulfilled": true,
	"fulfilledDate": "2018-03-27T06:20:45Z",
	"fulfilledBy": {
		"entityId": "1643792627",
		"entityType": "User"
	},
	"conditionType": "Postclosing",
	"isRemoved": false,
	"title": "New Post closing Condition FROM API",
	"description": "closing Condition Description",
	"application": {
		"entityId": "All",
		"entityType": "Application"
	},
	"source": "Manual",
	"expectedDate": "2018-04-10T00:00:00Z",
	"status": "Fulfilled",
	"statusDate": "2018-03-27T06:20:45Z",
	"daysToReceive": 10,
	"requestedFrom": "SHAILENDRA GHEVDE",
	"createdDate": "2018-03-27T06:19:55Z",
	"createdBy": {
		"entityId": "devadmin",
		"entityType": "User"
	},
	"isRequested": true,
	"requestedDate": "2018-03-29T11:50:46Z",
	"requestedBy": {
		"entityId": "auto_webpplsa",
		"entityType": "User"
	},
	"isRerequested": true,
	"rerequestedDate": "2018-03-31T11:50:47Z",
	"rerequestedBy": {
		"entityId": "auto_nowebpplsa",
		"entityType": "User"
	},
	"isReceived": true,
	"receivedDate": "2018-04-05T11:50:47Z",
	"receivedBy": {
		"entityId": "bhagvat",
		"entityType": "User"
	},
	"comments": [{

		"comments": "NEW PRELIMINARY CONDITIONS",
		"forRoleId": 1,
		"forRole": {
			"entityId": "1",
			"entityType": "Role",
			"entityName": "Loan Officer"
		},
		"dateCreated": "2018-03-27T06:20:27Z",
		"createdBy": "devadmin",
		"createdByName": "dev mobile admin"
	}],
	"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
}
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/02 - Get a specific Postclosing condition =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing/{{ConditionId}}?view=entity?view=entity
QUERY: view=entity?view=entity  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/03 - Get list of Postclosing conditions =====
METHOD: GET
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing?view=entity&isRemoved=true
QUERY: view=entity  # 
QUERY: isRemoved=true  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/04 - Add Postclosing conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing?action=add&view=entity
--- REQUEST BODY ---
[{
	"priorTo": "Approval",
	"category": "Assets",
	"isFulfilled": true,
	"fulfilledDate": "2018-03-27T06:20:45Z",
	"fulfilledBy": {
		"entityId": "1643792627",
		"entityType": "User"
	},
	"conditionType": "Preliminary",
	"isRemoved": false,
	"title": "Post Closing For Add",
	"description": "Post Closing description",
	"application": {
		"entityId": "All",
		"entityType": "Application"
	},
	"source": "Manual",
	"expectedDate": "2018-04-10T00:00:00Z",
	"status": "Fulfilled",
	"statusDate": "2018-03-27T06:20:45Z",
	"daysToReceive": 10,
	"requestedFrom": "SHAILENDRA GHEVDE",
	"createdDate": "2018-03-27T06:19:55Z",
	"createdBy": {
		"entityId": "devadmin",
		"entityType": "User"
	},
	"isRequested": true,
	"requestedDate": "2018-03-29T11:50:46Z",
	"requestedBy": {
		"entityId": "auto_webpplsa",
		"entityType": "User"
	},
	"isRerequested": true,
	"rerequestedDate": "2018-03-31T11:50:47Z",
	"rerequestedBy": {
		"entityId": "auto_nowebpplsa",
		"entityType": "User"
	},
	"isReceived": true,
	"receivedDate": "2018-04-05T11:50:47Z",
	"receivedBy": {
		"entityId": "bhagvat",
		"entityType": "User"
	},
	"comments": [{

		"comments": "New Post Condition",
		"forRoleId": 1,
		"forRole": {
			"entityId": "1",
			"entityType": "Role",
			"entityName": "Loan Officer"
		},
		"dateCreated": "2018-03-27T06:20:27Z",
		"createdBy": "devadmin",
		"createdByName": "dev mobile admin"
	}],
	"documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
}]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/05 - Update Postclosing conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing?action=update
--- REQUEST BODY ---
[{
    "priorTo": "Approval",
    "category": "Assets",
    "isFulfilled": true,
    "fulfilledDate": "2018-03-27T06:20:45Z",
    "fulfilledBy": {
        "entityId": "1643792627",
        "entityType": "User",
        "entityName": "EPPS EmptyFacadeUserId",
        "entityUri": "/v1/users/1643792627"
    },
    "id": "{{ConditionId}}",
    "conditionType": "PostClosing",
    "isRemoved": false,
    "title": "Post Condition For update",
    "description": "Post Condition description",
    "application": {
        "entityId": "All",
        "entityType": "Application",
        "entityName": "All "
    },
    "source": "Manual",
    "expectedDate": "2018-04-10T07:00:00Z",
    "status": "Fulfilled",
    "statusDate": "2018-03-27T06:20:45Z",
    "daysToReceive": 10,
    "requestedFrom": "SHAILENDRA GHEVDE",
    "createdDate": "2018-03-29T10:57:55Z",
    "createdBy": {
        "entityId": "devadmin",
        "entityType": "User",
        "entityName": "dev mobile admin",
        "entityUri": "/v1/users/devadmin"
    },
    "isRequested": true,
    "requestedDate": "2018-03-29T11:50:46Z",
    "requestedBy": {
        "entityId": "auto_webpplsa",
        "entityType": "User",
        "entityName": "superadmin superadmin",
        "entityUri": "/v1/users/auto_webpplsa"
    },
    "isRerequested": true,
    "rerequestedDate": "2018-03-31T11:50:47Z",
    "rerequestedBy": {
        "entityId": "auto_nowebpplsa",
        "entityType": "User",
        "entityName": "superadmin no web ppl superadmin",
        "entityUri": "/v1/users/auto_nowebpplsa"
    },
    "isReceived": true,
    "receivedDate": "2018-04-05T11:50:47Z",
    "receivedBy": {
        "entityId": "bhagvat",
        "entityType": "User",
        "entityName": "Bhagavat Mehra",
        "entityUri": "/v1/users/bhagvat"
    },
    "comments": [
        {
            
            "comments": "NEW PRELIMINARY CONDITIONS",
            "forRoleId": 1,
            "forRole": {
                "entityId": "1",
                "entityType": "Role",
                "entityName": "Loan Officer"
            },
            "dateCreated": "2018-03-29T10:57:55Z",
            "createdBy": "devadmin",
            "createdByName": "dev mobile admin"
        }
    ],
    "documents": [{
    		"entityId": "{{doc_id}}" 
    	}]
}]
QUERY: action=update  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/06 - Update Postclosing conditions =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing?action=remove&view=entity
--- REQUEST BODY ---
[{
	"id": "{{ConditionId}}"
}]
QUERY: action=remove  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/07 - Manage Comments for a Postclosing condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing/{{ConditionId}}/comments?action=add&view=entity
--- REQUEST BODY ---
   [{
   	"comments": "Post Closing Comment",
   	"forRoleId": 7,
   	"forRole": {
   		"entityId": "7",
   		"entityType": "Role"
   	},
   	"createdBy": "devadmin",
   	"createdByName": "dev mobile admin"
   }]
QUERY: action=add  # 
QUERY: view=entity  # 


===== Encompass Loan/Loan Conditions/PostClosing Conditions/08 - Manage Documents for a Postclosing Condition =====
METHOD: PATCH
URL: {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conditions/postclosing/{{ConditionId}}/documents?action=add&view=entity
--- REQUEST BODY ---
 [
    {
         "entityId": "e7bc576e-db82-4a42-b9d0-08c6307ae929",
         "entityType": "Document"
                
     }
]
QUERY: action=add  # 
QUERY: view=entity  # 
