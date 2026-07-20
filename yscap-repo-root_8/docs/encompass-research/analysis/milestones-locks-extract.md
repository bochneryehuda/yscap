

## FOLDER /Encompass Loan/Associates & Milestones


## FOLDER /Encompass Loan/Associates & Milestones/V3 Milestones

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 01 - Retrieve Milestone Logs List [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones
DESC: Returns all milestones for a loan.

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 02 - Retrieve a Specific Milestone Log [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones/{{milestoneId}}
DESC: Returns specifc milestone of a loan.

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 03 - Retrieve Milestone Free Role List [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestoneFreeRoles
DESC: Retrieves a list of milestonefreelogs for a loan

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 04 - Assign Loan Associate [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones/{{milestoneId}}
DESC: Update the specific milestones for a loan.
BODY:
{
    "startDate": "2024-03-28T10:51:00Z",
    "loanAssociate": {
        "loanAssociateType": "User",
        "user": {
            "entityId": "admin",
            "entityType": "User"
        },
        "cellPhone": "124-567-1258",
        "email": {{emailAddress}},
        "fax": "123-567-1234",
        "phone": "123-567-1234"
    }
}

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 04 - Finish a Milestone [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones/{{milestoneId}}
DESC: Update the specific milestones for a loan.
BODY:
{
    "doneIndicator": true
}

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 05 - Update MilestoneFreeRoles [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestoneFreeRoles
DESC: Update the specific milestones for a loan.
BODY:
[
    {
        "id": "milestoneFreeRoleLogId",
        "loanAssociate": {
            "loanAssociateType": "User",
            "user": {
                "entityId": "usha_lo_user",
                "entityType": "User"
            },
            "email": {{emailAddress}}
        }
    }
]

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 06 - Update MS Date - Default mode (Loan) [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones?action=updateDates&persistent=false
BODY:
[
    {
        "id": "{{ms_id1}}", // Id from Get milestones API response
        "startDate": "2025-03-14T10:00:00.000Z"
    }
]

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 07 - Update MS Date - Automatic mode [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones?action=updateDates&persistent=false&mode=automatic
BODY:
[
    {
        "id": "{{ms_id1}}",
        "startDate": "2025-03-14T10:00:00.000Z"
    }
]

### /Encompass Loan/Associates & Milestones/V3 Milestones :: 08 -  Update MS Date - Manual mode [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/milestones?action=updateDates&persistent=false&mode=manual
BODY:
[
    {
        "id": "{{ms_id1}}",
        "startDate": "2025-03-14T10:00:00.000Z"
        // "doneIndicator": true,
    }
]


## FOLDER /Encompass Loan/Associates & Milestones/V1 Milestones

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 01 - Retrieve all loan associates [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/associates
DESC: Retrieves a list of loan associates

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 02 - Retrieve a loan associate for a milestone/ milestoneFreeRole [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/associates/{{milestoneLogId}}
DESC: Retrieve a loan associate based on milestone/milestone free role guid.

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 03 - Assign a loan associate to a milestone/ milestoneFreeRole [PUT] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/associates/{{milestoneLogId}}
DESC: Assign a loan associate to milestone based on provided milestone/milestone free role guid and user id.
BODY:
{
        "loanAssociateType": "User",
        "id": "amurthyreg"
}

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 04 - Retrieve all milestones of a loan [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestones
DESC: Returns all milestones for a loan.

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 05 - Retrieve a specific milestone of a loan [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestones/{{milestoneLogId}}
DESC: Returns specifc milestone of a loan.

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 06a - Update a specific milestone [PATCH] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestones/{{milestoneLogId}}
DESC: Update the specific milestones for a loan.
BODY:
{
	"startDate": "2018-07-16T05:54:19.000Z",
    "loanAssociate": {
        "loanAssociateType": "User",
        "id": "admin"
    },
    "comments":"TESTING MILESTONE COMMENTS"
}

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 06b - Finish a specific milestone [PATCH] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestones/fd84cfdb-eaa0-4613-b8a4-bdc986c0a911
DESC: Update the specific milestones for a loan.
BODY:
{
	"startDate": "2018-07-16T05:54:19.000Z",
    "loanAssociate": {
        "loanAssociateType": "User",
        "id": "admin"
    },
    "comments":"TESTING MILESTONE COMMENTS"
}

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 06c - Unfinish a specific milestone [PATCH] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestones/{{milestoneLogId}}?action=unfinish
DESC: Update the specific milestones for a loan.
BODY:
{
	"startDate": "2018-07-16T05:54:19.000Z",
    "loanAssociate": {
        "loanAssociateType": "User",
        "id": "admin"
    },
    "comments":"TESTING MILESTONE COMMENTS"
}

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 07 - Retrieve all milestoneFreeRole logs of a loan [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestoneFreeRoles
DESC: Retrieves a list of milestonefreelogs for a loan

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 08 - Retrieve specific milestoneFreeRole log [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestoneFreeRoles/{{milestoneFreeRoleLogId}}
DESC: Retrieves a specific milestonefreerolelog of given logId for a loan

### /Encompass Loan/Associates & Milestones/V1 Milestones :: 09 - Update a specific milestoneFreeRole log [PATCH] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/milestoneFreeRoles/{{milestoneFreeRoleLogId}}
DESC: Update the specific milestones for a loan.
BODY:
{
    "loanAssociate": {
        "loanAssociateType": "User",
        "id": "servicer"
    }
}

### /Encompass Loan/Associates & Milestones :: Update MS Date - Save changes in loan [PATCH] {{v3API}}/loans/{{LoanID}}/milestones?action=updateDates&persistent=true&mode=automatic
BODY:
[
    {
        "id": "{{ms_id1}}",
    "startDate": "2025-03-14T10:00:00.000Z"
    }
]


## FOLDER /Encompass Loan/Conversation Log


## FOLDER /Encompass Loan/Conversation Log/V3 Conversation Logs
FOLDER DESC: Folder for v1

### /Encompass Loan/Conversation Log/V3 Conversation Logs :: 01 - Create Conversation Log [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/conversationlogs?action=add
BODY:
[
    {
        "alerts": [
            {
                "dueDate": "2020-01-29T21:14:09Z",
                "role": {
                    "entityId": "1",
                    "entityType": "Role"
                }
            }
        ],
        "comments": "comments alert role 111",
        "company": "conversation company",
        "inLogIndicator": true,
        "isEmailIndicator": true,
        "name": "Esc Aggregate",
        "phone": "333-333-3333"
    }
]


## FOLDER /Encompass Loan/Conversation Log/V1 Conversation Logs
FOLDER DESC: Folder for v1

### /Encompass Loan/Conversation Log/V1 Conversation Logs :: 01 - Get List of conversation Logs [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conversationLogs
DESC:  Update eConsent Status for one contact of a specified loan

### /Encompass Loan/Conversation Log/V1 Conversation Logs :: 02 - Get Specific Conversation log [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/conversationLogs/519a85e0-dc9e-4e0b-8bf8-8912e18f37b2
DESC:  Returns eConsent information for the specified loan


## FOLDER /Encompass Loan/Rate Locks

### /Encompass Loan/Rate Locks :: 01 - Create Loan - v1 [POST] {{API_SERVER}}/encompass/v1/loans?view=entity
BODY:
{
    "applications": [
        {
            "borrower": {
                "firstName": "Mickey",
                "lastName": "Mouse",
                "middleName": "Minnie",
                "suffixtoname": "JR",
                "taxIdentificationIdentifier": "555-444-3333"
            }
        }
    ],
    "property": {
        "StreetAddress": "123 ABC St",
        "PostalCode": "91402",
        "City": "Panorama City",
        "State": "CA",
        "County": "Los Angeles"
    },
   
    "lenderCaseIdentifier": "PCG12345",
    "Channel": "Correspondent",
    "correspondent": {
        "commitmentType": "Best Efforts",
        "deliveryType": "Individual Best Efforts"
    },
    "creditScoreToUse": 800,
    "rateLock": {
        "commitmentType": "Best Efforts",
        "deliveryType": "Individual Best Efforts",
        // "isDeliveryType":"False",
        "requestLockDate": "2023-01-25",
        "requestNumberOfDays": 365,
        "requestLockExpires": "2024-01-25",
        "buySideLockDate": "2023-01-25",
        "buySideNumberOfDays": 365,
        "buySideLockExpires": "2024-01-25"
    }
} 

### /Encompass Loan/Rate Locks :: 02 - Create AND Confirm a New Lock [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/RatelockRequests?action=confirm&copyLoanData=true&excludeInterestRateOnCopy=true&view=entity
BODY:
{
    "buySide": {
        "startingAdjustPrice": 1.3,
        "unDiscountedRate": 1.1,
        "startingAdjustRate": 1.2,
        "startingAdjPrice": 1.3,
        "branchApprovalDate": "",
        "corporateApprovalDate": "",
        "profitMarginAdjustedBuyPrice": 0.26,
        "totalBuyPrice": 59.622,
        "commitment": "WELCOME",
        "rateSheetId": "RS9110",
        "lockDate": "2023-01-25",
        "lockNumberOfDays": 365,
        "lockExpirationDate": "2024-01-25",
        "adjustments": [
            {
                "adjustmentType": "LockExtensionAdjustment",
                "description": "E1",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 8
            },
            {
                "adjustmentType": "LockExtensionAdjustment",
                "description": "E2",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 9
            },
            {
                "adjustmentType": "LockExtensionAdjustment",
                "description": "E3",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 10
            },
            {
                "adjustmentType": "Adjustment",
                "description": "Mobile Profit",
                "priceAdjustmentType": "ProfitMargin",
                "adjustment": 0.26
            },
            {
                "adjustmentType": "Adjustment",
                "description": "1 Year Payment Option",
                "priceAdjustmentType": "BaseMargin",
                "adjustment": 99
            },
            {
                "adjustmentType": "Adjustment",
                "description": "Second Home",
                "priceAdjustmentType": "BaseRate",
                "adjustment": 0.25
            },
            {
                "adjustmentType": "Adjustment",
                "description": "FICO 700 - 719",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 0.26
            },
            {
                "adjustmentType": "ReLockFeeAdjustment",
                "description": "R1",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 2.698
            },
            {
                "adjustmentType": "ReLockFeeAdjustment",
                "description": "R2",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 4.125
            },
            {
                "adjustmentType": "ReLockFeeAdjustment",
         

### /Encompass Loan/Rate Locks :: 03 - Create a Rate Lock request [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/RatelockRequests?view=entity
BODY:
{
    "lockRequest": {
        "lockDate": "2023-01-25",
        "lockNumberOfDays": 365,
        "lockExpirationDate": "2024-01-25",
        "lastRateSetDate": "2023-01-25",
        "rateSheetId": "ABCDEF",
        "comments": "comments",
        "loanProgram": "30 Year Fixed",
        "baseRate": 5.2,
        "unDiscountedRate": 30,
        "startingAdjustRate": 20,
        "startingAdjustPrice": 2,
        "programNotes": "Notes",
        "basePrice": 10000,
        "baseMarginRate": 4,
        "netMarginRate": 5,
        "onrpDate": "2023-01-29",
        "onrpEligible": true,
        "correspondentCommitmentType": "Best Efforts",
        "correspondentDeliveryType": "Individual Best Efforts",
        "adjustments": [
            {
                "adjustmentType": "Adjustment",
                "description": "No FICO",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 0.02
            },
            {
                "adjustmentType": "Adjustment",
                "description": "1 Year Payment Option",
                "priceAdjustmentType": "BaseMargin",
                "adjustment": 0.25
            },
            {
                "adjustmentType": "Adjustment",
                "description": "15 Day Lock Period",
                "priceAdjustmentType": "BaseRate",
                "adjustment": 0.002
            },
            {
                "adjustmentType": "Adjustment",
                "description": "Extended Payment Option",
                "priceAdjustmentType": "BaseRate",
                "adjustment": 0.001
            },
            {
                "adjustmentType": "LockExtensionAdjustment",
                "description": "LockExtensionAdjustment22",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 22
            },
            {
                "adjustmentType": "ReLockFeeAdjustment",
                "description": "ReLockFeeAdjustment133",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 33
            },
            {
                "adjustmentType": "CustomPriceAdjustment",
                "description": "CustomPriceAdjustment55",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 55
            }
        ],
        "srpPaidOut": 7,
        "onrpLock": true,
        "hedging": true,
        "penaltyTerm": "6",
        "prepayPenalty": "7",
        "marginSrpPaidOut": 8,
        "isDeliveryType": true
   

### /Encompass Loan/Rate Locks :: 04 - Confirm a rate Lock request [PUT] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/Confirmation?view=entity
BODY:
{}


### /Encompass Loan/Rate Locks :: 05 - Deny a Rate Lock request [PUT] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockRequests/{{LockId}}/denial?view=entity
BODY:
{
	"comments" : "Denial comment"
}

### /Encompass Loan/Rate Locks :: 06 - Re-lock a Rate Lock [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/RatelockRequests?action=relock&requestId={{LockId}}&view=entity
BODY:
{
    "lockRequest": {
        "lockDate": "2023-01-25",
        "lockNumberOfDays": 365,
        "lockExpirationDate": "2024-01-25",
        "lastRateSetDate": "2023-01-25",
        "rateSheetId": "ABCDEF",
        "comments": "comments",
        "loanProgram": "30 Year Fixed",
        "baseRate": 5.2,
        "unDiscountedRate": 30,
        "startingAdjustRate": 20,
        "startingAdjustPrice": 2,
        "programNotes": "Notes",
        "basePrice": 10000,
        "baseMarginRate": 4,
        "netMarginRate": 5,
        "onrpDate": "2023-01-29",
        "onrpEligible": true,
        "correspondentCommitmentType": "Best Efforts",
        "correspondentDeliveryType": "Individual Best Efforts",
        "adjustments": [
            {
                "adjustmentType": "Adjustment",
                "description": "No FICO",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 0.02
            },
            {
                "adjustmentType": "Adjustment",
                "description": "1 Year Payment Option",
                "priceAdjustmentType": "BaseMargin",
                "adjustment": 0.25
            },
            {
                "adjustmentType": "Adjustment",
                "description": "15 Day Lock Period",
                "priceAdjustmentType": "BaseRate",
                "adjustment": 0.002
            },
            {
                "adjustmentType": "Adjustment",
                "description": "Extended Payment Option",
                "priceAdjustmentType": "BaseRate",
                "adjustment": 0.001
            },
            {
                "adjustmentType": "LockExtensionAdjustment",
                "description": "LockExtensionAdjustment22",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 22
            },
            {
                "adjustmentType": "ReLockFeeAdjustment",
                "description": "ReLockFeeAdjustment133",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 33
            },
            {
                "adjustmentType": "CustomPriceAdjustment",
                "description": "CustomPriceAdjustment55",
                "priceAdjustmentType": "BasePrice",
                "adjustment": 55
            }
        ],
        "srpPaidOut": 7,
        "onrpLock": true,
        "hedging": true,
        "penaltyTerm": "6",
        "prepayPenalty": "7",
        "marginSrpPaidOut": 8,
        "isDeliveryType": true
   

### /Encompass Loan/Rate Locks :: 07a - Cancel a  Rate Lock request from SR [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests?action=cancel&requestId={{LockId}}&view=entity
BODY:
{
	"lockRequest": {
        "lockCancellationComment": "cancel lock test comments"
	}
}

### /Encompass Loan/Rate Locks :: 07b - Cancel a Rate Lock request [PUT] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/cancellation?view=entity
BODY:
{
		"comments": "cancel lock test comments"

}

### /Encompass Loan/Rate Locks :: 08 -  Extend a Rate Lock [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/RatelockRequests?action=extend&requestId={{LockId}}&view=entity
BODY:
{
    "lockRequest": {
        "daysToExtend": 7,
        "lockExtendPriceAdjustment": 10.5,
        "comments": "Extended from API for 7 days"
    } //,
    //Create custom field in company settings and use the field below.
    // "customFields": [
    //     {
    //         "fieldName": "LR.CX.RATELOCKCUSTOMFIELD",
    //         "stringValue": "Test"
    //     }
    // ]
}

### /Encompass Loan/Rate Locks :: 09 - Update RateLock [PATCH] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}?view=entity&copyLoanData=true&excludeInterestRateOnCopy=true
BODY:
{
    "buySide": {
        "lockDate": "2023-01-25",
        "lockNumberOfDays": 365,
        "lockExpirationDate": "2024-01-25",
        "daysToExtend": 201,
        "lastRateSetDate": "2023-01-25",
        "rateSheetId": "123401",
        "comments": "BuySide comments 01",
        // "adjustments": [
        //     {
        //         "adjustmentType": "string",
        //         "description": "string",
        //         "priceAdjustmentType": "string",
        //         "adjustment": 0
        //     }
        // ],
        "baseMarginRate": 1.01,
        "totalMarginAdjustments": 2.01,
        "netMarginRate": 3.01,
        "baseRate": 4.01,
        "totalRateAdjustments": 5.01,
        "netRate": 6.01,
        "basePrice": 1000001,
        "totalPriceAdjustments": 100001,
        "netPrice": 2000001,
        "srpPaidOut": 701,
        "onrpDate": "2023-01-27",
        "onrpEligible": true,
        "commitmentNumber": "101",
        "masterCommitmentNumber": "201",
        "tpoName": "Tester 01",
        "tpoId": "301",
        "orgId": "401",
        "commitmentDate": "2023-02-05",
        "commitmentType": "Best Efforts",
        "deliveryType": "Individual Best Efforts",
        "deliveryExpirationDate": "2023-05-01",
        "startingAdjustPrice": 5.01,
        "unDiscountedRate": 6.01,
        "startingAdjustRate": 7.01,
        "startingAdjPrice": 8.01,
        "profitMarginAdjustedBuyPrice": 11.01,
        "totalBuyPrice": 3000001,
        "totalPrice": 4000001,
        "loanProgram": "30 Year Fixed",
        "commitment": "Tests 01",
        "corporatePrice": 10.01,
        "corporateApprovalDate": "2023-02-01",
        "corporateApprovedby": "CorporateApprovalBy 201",
        "reasonforCorporateApproval": "CorporateApprovalReason 01",
        "corporatePrice2": 101,
        "corporateApprovalDate2": "2023-02-01",
        "corporateApprovedBy2": "CorporateApprovalBy 02",
        "reasonForCorporateApproval2": "CorporateApprovalReason 02",
        "corporatePrice3": 201,
        "corporateApprovalDate3": "2023-02-01",
        "corporateApprovedBy3": "CorporateApprovalBy 03",
        "reasonForCorporateApproval3": "CorporateApprovalReason 03",
        "corporatePrice4": 301,
        "corporateApprovalDate4": "2023-02-01",
        "corporateApprovedBy4": "CorporateApprovalBy 04",
        "reasonForCorporateApproval4": "CorporateApprovalReason 04",
        "corporatePrice5": 401,
        "corporateApprovalDate5": "2023-02-01",
        "corpora

### /Encompass Loan/Rate Locks :: 10 - Revise a Rate Lock [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/RatelockRequests?action=revise&requestId={{LockId}}&view=entity
BODY:
{
    "buySide": {
        "lockDate": "2023-01-25",
        "lockNumberOfDays": 365,
        "lockExpirationDate": "2024-01-25",
        "daysToExtend": 201,
        "lastRateSetDate": "2023-01-25",
        "rateSheetId": "123401",
        "comments": "BuySide comments 01",
        // "adjustments": [
        //     {
        //         "adjustmentType": "string",
        //         "description": "string",
        //         "priceAdjustmentType": "string",
        //         "adjustment": 0
        //     }
        // ],
        "baseMarginRate": 1.01,
        "totalMarginAdjustments": 2.01,
        "netMarginRate": 3.01,
        "baseRate": 4.01,
        "totalRateAdjustments": 5.01,
        "netRate": 6.01,
        "basePrice": 1000001,
        "totalPriceAdjustments": 100001,
        "netPrice": 2000001,
        "srpPaidOut": 701,
        "onrpDate": "2023-01-27",
        "onrpEligible": true,
        "commitmentNumber": "101",
        "masterCommitmentNumber": "201",
        "tpoName": "Tester 01",
        "tpoId": "301",
        "orgId": "401",
        "commitmentDate": "2023-02-05",
        "commitmentType": "Best Efforts",
        "deliveryType": "Individual Best Efforts",
        "deliveryExpirationDate": "2023-05-01",
        "startingAdjustPrice": 5.01,
        "unDiscountedRate": 6.01,
        "startingAdjustRate": 7.01,
        "startingAdjPrice": 8.01,
        "profitMarginAdjustedBuyPrice": 11.01,
        "totalBuyPrice": 3000001,
        "totalPrice": 4000001,
        "loanProgram": "30 Year Fixed",
        "commitment": "Tests 01",
        "corporatePrice": 10.01,
        "corporateApprovalDate": "2023-02-01",
        "corporateApprovedby": "CorporateApprovalBy 201",
        "reasonforCorporateApproval": "CorporateApprovalReason 01",
        "corporatePrice2": 101,
        "corporateApprovalDate2": "2023-02-01",
        "corporateApprovedBy2": "CorporateApprovalBy 02",
        "reasonForCorporateApproval2": "CorporateApprovalReason 02",
        "corporatePrice3": 201,
        "corporateApprovalDate3": "2023-02-01",
        "corporateApprovedBy3": "CorporateApprovalBy 03",
        "reasonForCorporateApproval3": "CorporateApprovalReason 03",
        "corporatePrice4": 301,
        "corporateApprovalDate4": "2023-02-01",
        "corporateApprovedBy4": "CorporateApprovalBy 04",
        "reasonForCorporateApproval4": "CorporateApprovalReason 04",
        "corporatePrice5": 401,
        "corporateApprovalDate5": "2023-02-01",
        "corpora

### /Encompass Loan/Rate Locks :: 11 - Update Sell Comparison for active/expired/ denied locks [POST] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests?action=SellComparisonUpdate&requestId={{LockId}}&view=entity
BODY:
{
    "sellSide": {
        "lockDate": "2023-01-25",
        "lockNumberOfDays": 365,
        "lockExpirationDate": "2024-01-25",
        "adjustments": [
            {
                "adjustmentType": "Adjustment",
                "description": "Branch Profit Margin",
                "priceAdjustmentType": "ProfitMargin",
                "adjustment": -1.000
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LO Comp",
                "priceAdjustmentType": "ProfitMargin",
                "adjustment": -1.000
            },
            {
                "adjustmentType": "Adjustment",
                "description": "Pricing Special",
                "priceAdjustmentType": "ProfitMargin",
                "adjustment": -1.000
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LTV/FICO >15 Yr Term Adjustments - FIXED - 700-719 / LTV 70.01 % - 75.0 %",
                "priceAdjustmentType": "BaseRate",
                "adjustment": -1.000
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LTV/FICO >15 Yr Term Adjustments - FIXED - 700-719 / LTV 70.01 % - 75.0 %",
                "priceAdjustmentType": "BasePrice",
                "adjustment": -1.0000000000
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LP-2728 Lowell Test - State CA / LTV 70.01 % - 75.0 %",
                "priceAdjustmentType": "BasePrice",
                "adjustment": -0.2500000000
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LP-2728 Lowell Test - State CA / LTV 70.01 % - 75.0 %",
                "priceAdjustmentType": "BaseRate",
                "adjustment": -0.250
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LP-2728 Lowell Test #2 - State CA / LTV 70.01 % - 75.0 %",
                "priceAdjustmentType": "BaseRate",
                "adjustment": -0.250
            },
            {
                "adjustmentType": "Adjustment",
                "description": "LP-2728 Lowell Test #3 - SFR / LTV 70.01 % - 75.0 %",
                "priceAdjustmentType": "BaseRate",
                "adjustment": -0.250
            },
            {
                "adjustmentType": "Adjustment",
                "description": "(0.250) Premium",
   

### /Encompass Loan/Rate Locks :: 12 - Void Rate Lock [PUT] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/void?view=entity
BODY:
{
		"comments": "void lock test comments"

}

### /Encompass Loan/Rate Locks :: 13 - Get a specific Rate Lock request [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockRequests/{{LockId}}?view=detailed

### /Encompass Loan/Rate Locks :: 14 - Get the Loan Snapshot for a ratelock request [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/snapshot?view=entity

### /Encompass Loan/Rate Locks :: 15 - Get list of Rate Lock requests [GET] {{API_SERVER}}/encompass/v1/loans/{{loanId}}/ratelockrequests


## FOLDER /Encompass Loan/Registration Logs

### /Encompass Loan/Registration Logs :: 01 - Add Registration Log [POST] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/registrationlogs?view=entity
BODY:
{


  "registrationDate": "2021-08-28T17:14:25.511Z",
  "expirationDate": "2021-08-28T17:14:25.511Z",
  "investorName": "investor",
  "referenceNumber": "1234"
}

### /Encompass Loan/Registration Logs :: 02 - Update Registration Log [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/registrationlogs/{{registrationLogId}}?view=entity
BODY:
{
    "expirationDate": "2021-08-28T17:14:25.511Z",
    "investorName": "investor",
    "referenceNumber": "1234"
}

### /Encompass Loan/Registration Logs :: 03- Get Registration Logs [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/registrationlogs


## FOLDER /Encompass Loan/Loan Funding

### /Encompass Loan/Loan Funding :: Get Funding Fees [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/fundingFees
DESC: This step retrieves the loan you created.

### /Encompass Loan/Loan Funding :: Update Funding Fees [PATCH] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/fundingFees
DESC: This step retrieves the loan you created.
BODY:
[
  {
    "id": "NEWHUD2.X141",
    "balanceChecked": true
  }
]


### /Encompass Loan/Loan Funding :: Get Funding Balances [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/fundingBalances
DESC: This step retrieves the loan you created.


## FOLDER /Encompass Loan/Loan Alerts

### /Encompass Loan/Loan Alerts :: Get Good Faith Fee Variance Violations [GET] {{API_SERVER}}/encompass/v3/loans/{{loanId}}/fundingFees
DESC: This step retrieves the loan you created.


## FOLDER /Settings and Utilities/Settings: Milestones

### /Settings and Utilities/Settings: Milestones :: 01- Get List of Milestones [GET] {{API_SERVER}}/encompass/v3/settings/milestones?includeArchived=True&view=Detail&start=0&limit=100

### /Settings and Utilities/Settings: Milestones :: 02- Get Details on Specific Milestone [GET] {{API_SERVER}}/encompass/v3/settings/milestones/{{milestoneId}}
