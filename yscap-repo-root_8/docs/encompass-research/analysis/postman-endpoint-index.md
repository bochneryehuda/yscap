# Encompass Developer Connect 26.2 Postman Collection — Endpoint Index

Total requests: 800. Method counts: {'POST': 200, 'GET': 329, 'PUT': 27, 'PATCH': 214, 'DELETE': 30}

| Folder | Request name | Method | URL |
|---|---|---|---|
| Authentication / Get Access Token | Resource Owner Password Credentials | POST | /oauth2/v1/token |
| Authentication / Get Access Token | Client Credentials (API User) | POST | /oauth2/v1/token |
| Authentication / User Impersonation | 01a - Get Actor Token | POST | /oauth2/v1/token |
| Authentication / User Impersonation | 01b - Introspect Actor token | POST | /oauth2/v1/token/introspection |
| Authentication / User Impersonation | 02a - Get Subject Impersonation Token | POST | /oauth2/v1/token |
| Authentication / User Impersonation | 02b - Introspect Subject Impersonation token | POST | /oauth2/v1/token/introspection |
| Authentication / User Impersonation | 03 - Create Loan as Subject with Impersonation token | POST | /encompass/v3/loans?loanFolder={{loanFolder}}&view=entity |
| Calculators / Compliance Calendar Calculator | Date Calculator - Event | POST | /encompass/v3/calculators/timerCompletion |
| Calculators / Compliance Calendar Calculator | v3 Field Reader | POST | /encompass/v3/loans/{{loanId}}/fieldReader |
| Calculators / Compliance Calendar Calculator | Date Calculator - Loan Date field | POST | /encompass/v3/calculators/timerCompletion |
| Calculators / Print Form Calculators | 02 - V3 Loan Print Form | POST | /encompass/v3/calculators/standardPrintForms?loanId={{loanId}} |
| Calculators / Loan Calculators | 01 - Loan Calculator | POST | /encompass/v1/calculators/loan |
| Calculators / Amortization Calculators | 26.2R 01 - V3 Amortization Schedule Calculator - With LoanId | POST | /encompass/v3/calculators/payments/amortization?loanId={{loanId}} |
| Calculators / Amortization Calculators | 26.2R 02 - V3 Amortization Schedule Calculator - With Loan Object | POST | /encompass/v3/calculators/payments/amortization |
| Consumer Engagement / Prospect Engagement | 01 - Invite | POST | /consumers/v1/invitations |
| Consumer Engagement / Prospect Engagement | 02 - Remind | POST | /consumers/v1/reminders |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 01 - Get All Opportunities | GET | /loanopportunity/v1/loanOpportunities |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 02 - Create a Loan Opportunity | POST | /loanopportunity/v1/loanOpportunities |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 03 - Get a specific Opportunity | GET | /loanOpportunity/v1/loanOpportunities/{{opportunityId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 04a - Replace a specific Opportunity | PUT | /loanOpportunity/v1/loanOpportunities/{{opportunityId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 04b - Update a specific Opportunity | PATCH | /loanOpportunity/v1/loanOpportunities/{{opportunityId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 05 - Delete a specific Opportunity | DELETE | /loanOpportunity/v1/loanOpportunities/{{opportunityId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 06 - Get List of Scenarios in an Opportunity | GET | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/scenarios |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 07 - Create a Scenario in an Opportunity | POST | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/scenarios |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 08 - Get a specific Scenario | GET | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/scenarios/{{scenarioId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 09a - Replace a specific Scenario | PUT | /loanopportunity/v1/loanOpportunities/{{opportunityId}}/scenarios/{{scenarioId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 09b - Update a specific Scenario | PATCH | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/scenarios/{{scenarioId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 10 - Delete a specific Scenario | DELETE | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/scenarios/{{scenarioId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 11 - Create Eligibility Letter for an Opportunity | POST | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/documents |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 12a - Get an Eligibility Letter | GET | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/documents/{{documentId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 12b - Get PDF of Eligibility Letter | GET | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/documents/{{documentId}}?type=pdf |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 13 - Update an Eligibility Letter | PATCH | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/documents/{{documentId}} |
| Consumer Engagement / Loan Opportunities / Manage Loan Opportunities | 14 - Trigger a Notification Request to the Borrower | POST | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/notifications |
| Consumer Engagement / Loan Opportunities / Contract Generator for Conversion | 01 - Create Opportunity Contract from Loan | POST | /loanOpportunity/v1/loanOpportunities/opportunityContractGenerator?version=v1 |
| Consumer Engagement / Loan Opportunities / Contract Generator for Conversion | 02 - Create Loan Contract from Scenario | GET | /loanOpportunity/v1/loanOpportunities/{{opportunityId}}/scenarios/{{scenarioId}}/loanContractGenerator?version=v1 |
| Consumer Engagement / Loan Opportunities / Loan Opportunity Selector | 01 - Opportunity Selector with Sorting | GET | /loanOpportunity/v1/loanOpportunitySelector?sortBy=-BorrowerLastName,-City |
| Consumer Engagement / Loan Opportunities / Loan Opportunity Selector | 02 - Opportunity Selector with Filtering | GET | /loanOpportunity/v1/loanOpportunitySelector?BorrowerLastName=Walker&city=Alamo |
| Consumer Engagement / Loan Opportunities / Settings / Feature Management | 01 - Get all Feature Management Settings | GET | /loanOpportunity/v1/settings/featureManagement?Category=Eligibility |
| Consumer Engagement / Loan Opportunities / Settings / Feature Management | 02 - Create Feature Management Setting | POST | /loanOpportunity/v1/settings/featureManagement |
| Consumer Engagement / Loan Opportunities / Settings / Feature Management | 03a - Replace existing Feature Management Setting | PUT | /loanOpportunity/v1/settings/featureManagement/{{featureManagementId}} |
| Consumer Engagement / Loan Opportunities / Settings / Feature Management | 03b - Update Feature Management Setting | PATCH | /loanOpportunity/v1/settings/featureManagement |
| Consumer Engagement / Loan Opportunities / Settings / Feature Management | 04 - Delete a Feature Management Setting | DELETE | /loanOpportunity/v1/settings/featureManagement/{{featureManagementId}} |
| Consumer Engagement / Loan Opportunities / Settings / Affordability Qualification | 01 - Get All AffordabilityQualification Settings | GET | /loanOpportunity/v1/settings/affordabilityQualification |
| Consumer Engagement / Loan Opportunities / Settings / Affordability Qualification | 02 - Create Affordability Qualification Setting | POST | /loanOpportunity/v1/settings/affordabilityQualification |
| Consumer Engagement / Loan Opportunities / Settings / Affordability Qualification | 03a - Update AffordabilityQualification ByID | PUT | /loanOpportunity/v1/settings/affordabilityQualification/{{affordabilityQualificationId}} |
| Consumer Engagement / Loan Opportunities / Settings / Affordability Qualification | Delete AffordabilityQualification ById | DELETE | /loanOpportunity/v1/settings/affordabilityQualification/{{affordabilityQualificationId}} |
| Consumer Engagement / Loan Opportunities / Settings / Email Templates | 01 - Get list of Email Templates | GET | /loanopportunity/v1/settings/emailTemplates |
| Consumer Engagement / Loan Opportunities / Settings / Email Templates | 02 - Create Email Template | POST | /loanOpportunity/v1/settings/emailTemplates |
| Consumer Engagement / Loan Opportunities / Settings / Email Templates | 03 - Get an Email Template | GET | /loanOpportunity/v1/settings/emailTemplates/{{emailTemplateId}} |
| Consumer Engagement / Loan Opportunities / Settings / Email Templates | 04 - Delete an Email Template | DELETE | /loanOpportunity/v1/settings/emailTemplates/{{emailTemplateId}} |
| Consumer Engagement / Loan Opportunities / Settings / Letter Templates | 01 - Get List of Letter Templates | GET | /loanOpportunity/v1/settings/letterTemplates |
| Consumer Engagement / Loan Opportunities / Settings / Letter Templates | 02 - Create a Letter Template | POST | /loanOpportunity/v1/settings/letterTemplates |
| Consumer Engagement / Loan Opportunities / Settings / Letter Templates | 03 - Get a Letter Template | GET | /loanOpportunity/v1/settings/letterTemplates/{{letterTemplateId}} |
| Consumer Engagement / Loan Opportunities / Settings / Letter Templates | 04 - Update a Letter Template | PUT | /loanOpportunity/v1/settings/letterTemplates/{{letterTemplateId}} |
| Consumer Engagement / Loan Opportunities / Settings / Letter Templates | 05 - Delete a Letter Template | DELETE | /loanOpportunity/v1/settings/letterTemplates/{{letterTemplateId}} |
| Encompass Contacts / Business Contacts | 01a - Create Business Contact | POST | /encompass/v1/businessContacts |
| Encompass Contacts / Business Contacts | 01b - Create Business Contact without Name | POST | /encompass/v1/businessContacts?allowEmpty=True |
| Encompass Contacts / Business Contacts | 02 - GET Business Contact by id | GET | /encompass/v1/businessContacts/{{bus_contact_id}} |
| Encompass Contacts / Business Contacts | 03 - Update Business Contact | PATCH | /encompass/v1/businessContacts/{{bus_contact_id}} |
| Encompass Contacts / Business Contacts | 03b - Update Business Category Additional Fields | PATCH | /encompass/v1/businessContacts/{{bus_contact_id}} |
| Encompass Contacts / Business Contacts | 04 - Delete Business Contact by id | DELETE | /encompass/v1/businessContacts/{{bus_contact_id}} |
| Encompass Contacts / Business Contacts | 05 - Create a note for a Business Contact | POST | /encompass/v1/businessContacts/{{bus_contact_id}}/notes |
| Encompass Contacts / Business Contacts | 06 - Update a Note for a Business Contact | PATCH | /encompass/v1/businessContacts/{{bus_contact_id}}/notes/{{bus_contact_note_id}} |
| Encompass Contacts / Business Contacts | 07 - Delete a Note for a Business Contact | DELETE | /encompass/v1/borrowerContacts/{{bus_contact_id}}/notes/{{bus_contact_note_id}} |
| Encompass Contacts / Business Contacts | 08 - GET all Notes for a Business Contact | GET | /encompass/v1/businessContacts/{{bus_contact_id}}/notes |
| Encompass Contacts / Business Contacts | 09 - GET a Note for a Business Contact | GET | /encompass/v1/businessContacts/{{bus_contact_id}}/notes/{{bus_contact_note_id}} |
| Encompass Contacts / Business Contacts | 10 - Retrieve canonical names | GET | /encompass/v1/settings/businessContacts/fieldDefinitions |
| Encompass Contacts / Business Contacts | 11 - Retrieve list of Business Contacts | POST | /encompass/v1/businessContactSelector?start=0&limit=100 |
| Encompass Contacts / Business Contacts | 12 -  Query list of Business Contacts | POST | /encompass/v1/businessContactSelector?start=0&limit=100&cursorType=RandomAccess |
| Encompass Contacts / Borrower Contacts | 01a - Create Borrower Contact | POST | /encompass/v1/borrowerContacts |
| Encompass Contacts / Borrower Contacts | 01b - Create Borrower Contact without Name | POST | /encompass/v1/borrowerContacts?view=id&allowEmpty=True |
| Encompass Contacts / Borrower Contacts | 02 - GET Borrower Contact by id | GET | /encompass/v1/borrowerContacts/{{bor_contact_id}} |
| Encompass Contacts / Borrower Contacts | 03 - Update Borrower Contact | PATCH | /encompass/v1/borrowerContacts/{{bor_contact_id}} |
| Encompass Contacts / Borrower Contacts | 04 - Delete Borrower Contact by id | DELETE | /encompass/v1/borrowerContacts/{{bor_contact_id}} |
| Encompass Contacts / Borrower Contacts | 05 - Create a note for a Borrower Contact | POST | /encompass/v1/borrowerContacts/{{bor_contact_id}}/notes |
| Encompass Contacts / Borrower Contacts | 06 - Update a Note for a Borrower Contact | PATCH | /encompass/v1/borrowerContacts/{{bor_contact_id}}/notes/{{bor_contact_note_id}} |
| Encompass Contacts / Borrower Contacts | 07 - Delete a Note for a Borrower Contact | DELETE | /encompass/v1/borrowerContacts/{{bor_contact_id}}/notes/{{bor_contact_note_id}} |
| Encompass Contacts / Borrower Contacts | 08 - GET all Notes for a Borrower Contact | GET | /encompass/v1/borrowerContacts/{{bor_contact_id}}/notes |
| Encompass Contacts / Borrower Contacts | 09 - GET a Note for a Borrower Contact | GET | /encompass/v1/borrowerContacts/{{bor_contact_id}}/notes/{{bor_contact_note_id}} |
| Encompass Contacts / Borrower Contacts | 10 - Retrieve canonical names | GET | /encompass/v1/settings/borrowerContacts/fieldDefinitions |
| Encompass Contacts / Borrower Contacts | 11 - Retrieve list of Borrower Contacts | POST | /encompass/v1/borrowerContactSelector?start=0&limit=100 |
| Encompass Contacts / Borrower Contacts | 12 - Query list of Borrower Contacts | POST | /encompass/v1/borrowerContactSelector?start=0&limit=100&cursorType=RandomAccess |
| Encompass Contacts / Contact Groups | 01 - Create a Contact Group | POST | /encompass/v1/contactGroups?view=id |
| Encompass Contacts / Contact Groups | 02 - Update a Contact Group | PATCH | /encompass/v1/contactGroups/{{GroupId}}?view=entity |
| Encompass Contacts / Contact Groups | 03 - Get a Specific Contact Group | GET | /encompass/v1/contactGroups/{{GroupId}} |
| Encompass Contacts / Contact Groups | 04 - Get List of Public Business Contact Groups | GET | /encompass/v1/contactGroups?contactType=business&groupType=public |
| Encompass Contacts / Contact Groups | 05 - Get List of Private Business Contact Groups | GET | /encompass/v1/contactGroups?contactType=business&groupType=private |
| Encompass Contacts / Contact Groups | 06 - Get List of Borrower Contact Groups | GET | /encompass/v1/contactGroups?ContactType=borrower |
| Encompass Contacts / Contact Groups | 07 - Get contacts in Specific Contact Group | GET | /encompass/v1/contactGroups/{{GroupId}}/contacts |
| Encompass Contacts / Contact Groups | 08 - Update contacts of a Specific Contact Group | PATCH | /encompass/v1/contactGroups/{{GroupId}}/contacts?action=add |
| Encompass Contacts / Contact Groups | 09 - Delete a Contact group | DELETE | /encompass/v1/contactGroups/{{GroupId}} |
| Document Delivery / Point of Sale Integration Framework / DeliveryRoomSessions | 01 - Create | POST | /pos/v1/sessions |
| Document Delivery / Point of Sale Integration Framework / DeliveryRoomSessions | 02 - Create Theme Customized | POST | /pos/v1/sessions |
| Document Delivery / Point of Sale Integration Framework / DeliveryRoomSessions | 03 - Create Header Logo / Title / Style Customized | POST | /pos/v1/sessions |
| Document Delivery / Point of Sale Integration Framework / DeliveryRoomSessions | 04 - Create Header No Logo and Text Customized | POST | /pos/v1/sessions |
| Document Delivery / Point of Sale Integration Framework / DeliveryRoomSessions | 05 - Create Theme / Widgets Customized | POST | /pos/v1/sessions |
| Document Delivery / Point of Sale Integration Framework / DeliveryRoomSessions | 06 - Create Header Only Exit Icon | POST | /pos/v1/sessions |
| Document Delivery / Delivery Packages | 01 - Get Delivery Packages | GET | /delivery/v3/{{groupNamespace}}/{{packageGroupId}}/packages |
| Document Delivery / Delivery Packages | 02 - Get Delivery Package | GET | /delivery/v3/{{groupNamespace}}/{{packageGroupId}}/packages/{{packageId}} |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 02 - Get Loan | GET | /encompass/v3/loans/{{loanId}} |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 03a - Get Plan Codes (Optional) | GET | /encompassdocs/v1/planCodes?planCodeType=Opening |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 03b - Apply Plan Code (Optional) | POST | /encompassdocs/v1/planCodes/00000001/evaluator |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 04-01 - Generate Loan Audit (company selects package) | POST | /encompassdocs/v1/documentAudits/opening |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 04-02 - Generate Loan Audit (user selects package) | POST | /encompassdocs/v1/documentAudits/opening |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 05 - Get Loan Audit | GET | {{locationHeaderAudit}} |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 06 - Create Document Order | POST | /encompassdocs/v1/documentOrders/opening |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 07 - Get Document Order Status | GET | {{locationHeaderOpening}} |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 08a - Append Additional Documents (Optional) | POST | /encompassdocs/v1/documentOrders/opening/{{docSetId}}/documents |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 08b - Get Append Documents Status (Optional) | GET | {{locationHeaderSendDisclosures}} |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 09a - Send Opening Package(Without fulfillment) | POST | /encompassdocs/v1/documentOrders/opening/{{docSetId}}/delivery |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 09b - Send Opening Package (With fulfillment) | POST | /encompassdocs/v1/documentOrders/opening/{{docSetId}}/delivery |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 10 - Get Initial Disclosure Delivery Status | GET | {{locationHeaderOpening}} |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 11 - Get Authcode for Loan Recipients | GET | /encompass/v3/loans/{{loanId}}/recipients |
| Encompass Docs / Send Encompass Docs / Initial Disclosures | 12 - Get Loan Disclosure Tracking Logs | GET | /encompass/v3/loans/{{loanId}}?view=full&entities=disclosureTracking2015Logs,documents |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 02a - Get Plan Code (Optional) | GET | /encompassdocs/v1/planCodes?planCodeType=Closing |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 02b - Apply Plan Code (Optional) | POST | /encompassdocs/v1/planCodes/00000001/evaluator |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 02 - Generate Loan Audit | POST | /encompassdocs/v1/documentAudits/closing |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 03 - Get Loan Audit Status | GET | {{locationHeaderAudit}} |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 04 - Create Document Order | POST | /encompassdocs/v1/documentOrders/closing |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 05 - Get Document Order Status | GET | {{locationHeaderClosing}} |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 06a - Append Additional Documents (Optional) | POST | /encompassdocs/v1/documentOrders/closing/{{docSetId}}/documents |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 06b - Get Additional Documents Status | GET | {{locationHeaderSendDisclosures}} |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 07a - Send Closing Package (Without fulfillment) | POST | /encompassdocs/v1/documentOrders/closing/{{docSetId}}/delivery |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 07b - Send Closing Package (With fullfilment) | POST | /encompassdocs/v1/documentOrders/closing/{{docSetId}}/delivery |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 08 - Get Closing Package Delivery Status | GET | {{locationHeaderClosing}} |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 09 - Get Authcode for Loan Recipients | GET | /encompass/v3/loans/{{loanId}}/recipients |
| Encompass Docs / Send Encompass Docs / Closing Disclosures | 10 - Get Loan Disclosure Tracking Logs | GET | /encompass/v3/loans/{{loanId}}?view=full&entities=disclosureTracking2015Logs,documents |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder={{FolderName}}&view=entity |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 02- Get Disclosure Tracking Forms Settings (Optional) | GET | /encompass/v3/settings/loan/disclosureTracking |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 03a - Generate onDemand Documents | POST | /encompassdocs/v1/documentOrders/forms |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 03b - Generate onDemand Documents with eFolder docs | POST | /encompassdocs/v1/documentOrders/forms |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 04 - Get onDemand Documents | GET | {{env_locationHeaderForms}} |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 05a - Send onDemand Documents (Without Fulfillments) | POST | /encompassdocs/v1/documentOrders/forms/{{docSetId}}/delivery |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 05b - Send onDemand Documents (With Fulfillments) | POST | /encompassdocs/v1/documentOrders/forms/{{docSetId}}/delivery |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 06 - Get onDemand Doc Order Delivery Status | GET | {{env_locationHeaderForms}} |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 07 - Get Authcode for Loan Recipients | GET | /encompass/v3/loans/{{loanId}}/recipients |
| Encompass Docs / Send Encompass Docs / On Demand Disclosures with Forms | 08 - Get Loan Disclosure Tracking Logs | GET | /encompass/v3/loans/{{loanId}}?view=full&entities=disclosureTracking2015Logs,documents |
| Encompass Docs / Send Encompass Docs / Upload additional documents to eFolder | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder={{FolderName}}&view=entity |
| Encompass Docs / Send Encompass Docs / Upload additional documents to eFolder | 02 - Create document container | PATCH | /encompass/v3/loans/{{loanId}}/documents?action=add&view=entity |
| Encompass Docs / Send Encompass Docs / Upload additional documents to eFolder | 03 - Assign document to container | POST | /encompass/v3/loans/{{loanId}}/attachmentUrl?context=Browse |
| Encompass Docs / Send Encompass Docs / Upload additional documents to eFolder | 04 - Upload file to document container | PUT | {{env_UnssignedDoc_URL}} |
| Encompass Docs / Send Encompass Docs / Upload additional documents to eFolder | 05 - Get Attachments | GET | /encompass/v3/loans/{{loanId}}/attachments?view=Summary |
| Encompass Docs / Send Encompass Docs / Webhooks | 01 - GET Resource Events | GET | /webhook/v1/resources/documentOrder/events |
| Encompass Docs / Send Encompass Docs / Webhooks | 02 - Create a Webhook Subscription for Initial Disclosures | POST | /webhook/v1/subscriptions |
| Encompass Docs / Send Encompass Docs / Webhooks | 03 - Create a Webhook Subscription for Closing Disclosures | POST | /webhook/v1/subscriptions |
| Encompass Docs / Send Encompass Docs / Webhooks | 04 - Create a Webhook Subscription for On Demand Disclosures | POST | /webhook/v1/subscriptions |
| Encompass Docs / Print OnDemand | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity |
| Encompass Docs / Print OnDemand | 02 - EDIS Ondemand - POST | POST | /encompassdocs/v1/documentOrders/ondemand |
| Encompass Docs / Print OnDemand | 03 -  EDIS Ondemand - GET | GET | /encompassdocs/v1/documentOrders/ondemand/{{orderId}} |
| Encompass Loan / Associates & Milestones / V3 Milestones | 01 - Retrieve Milestone Logs List | GET | /encompass/v3/loans/{{loanId}}/milestones |
| Encompass Loan / Associates & Milestones / V3 Milestones | 02 - Retrieve a Specific Milestone Log | GET | /encompass/v3/loans/{{loanId}}/milestones/{{milestoneId}} |
| Encompass Loan / Associates & Milestones / V3 Milestones | 03 - Retrieve Milestone Free Role List | GET | /encompass/v3/loans/{{loanId}}/milestoneFreeRoles |
| Encompass Loan / Associates & Milestones / V3 Milestones | 04 - Assign Loan Associate | PATCH | /encompass/v3/loans/{{loanId}}/milestones/{{milestoneId}} |
| Encompass Loan / Associates & Milestones / V3 Milestones | 04 - Finish a Milestone | PATCH | /encompass/v3/loans/{{loanId}}/milestones/{{milestoneId}} |
| Encompass Loan / Associates & Milestones / V3 Milestones | 05 - Update MilestoneFreeRoles | PATCH | /encompass/v3/loans/{{loanId}}/milestoneFreeRoles |
| Encompass Loan / Associates & Milestones / V3 Milestones | 06 - Update MS Date - Default mode (Loan) | PATCH | /encompass/v3/loans/{{loanId}}/milestones?action=updateDates&persistent=false |
| Encompass Loan / Associates & Milestones / V3 Milestones | 07 - Update MS Date - Automatic mode | PATCH | /encompass/v3/loans/{{loanId}}/milestones?action=updateDates&persistent=false&mode=automatic |
| Encompass Loan / Associates & Milestones / V3 Milestones | 08 -  Update MS Date - Manual mode | PATCH | /encompass/v3/loans/{{loanId}}/milestones?action=updateDates&persistent=false&mode=manual |
| Encompass Loan / Associates & Milestones / V1 Milestones | 01 - Retrieve all loan associates | GET | /encompass/v1/loans/{{loanId}}/associates |
| Encompass Loan / Associates & Milestones / V1 Milestones | 02 - Retrieve a loan associate for a milestone/ milestoneFreeRole | GET | /encompass/v1/loans/{{loanId}}/associates/{{milestoneLogId}} |
| Encompass Loan / Associates & Milestones / V1 Milestones | 03 - Assign a loan associate to a milestone/ milestoneFreeRole | PUT | /encompass/v1/loans/{{loanId}}/associates/{{milestoneLogId}} |
| Encompass Loan / Associates & Milestones / V1 Milestones | 04 - Retrieve all milestones of a loan | GET | /encompass/v1/loans/{{loanId}}/milestones |
| Encompass Loan / Associates & Milestones / V1 Milestones | 05 - Retrieve a specific milestone of a loan | GET | /encompass/v1/loans/{{loanId}}/milestones/{{milestoneLogId}} |
| Encompass Loan / Associates & Milestones / V1 Milestones | 06a - Update a specific milestone | PATCH | /encompass/v1/loans/{{loanId}}/milestones/{{milestoneLogId}} |
| Encompass Loan / Associates & Milestones / V1 Milestones | 06b - Finish a specific milestone | PATCH | /encompass/v1/loans/{{loanId}}/milestones/fd84cfdb-eaa0-4613-b8a4-bdc986c0a911 |
| Encompass Loan / Associates & Milestones / V1 Milestones | 06c - Unfinish a specific milestone | PATCH | /encompass/v1/loans/{{loanId}}/milestones/{{milestoneLogId}}?action=unfinish |
| Encompass Loan / Associates & Milestones / V1 Milestones | 07 - Retrieve all milestoneFreeRole logs of a loan | GET | /encompass/v1/loans/{{loanId}}/milestoneFreeRoles |
| Encompass Loan / Associates & Milestones / V1 Milestones | 08 - Retrieve specific milestoneFreeRole log | GET | /encompass/v1/loans/{{loanId}}/milestoneFreeRoles/{{milestoneFreeRoleLogId}} |
| Encompass Loan / Associates & Milestones / V1 Milestones | 09 - Update a specific milestoneFreeRole log | PATCH | /encompass/v1/loans/{{loanId}}/milestoneFreeRoles/{{milestoneFreeRoleLogId}} |
| Encompass Loan / Associates & Milestones | Update MS Date - Save changes in loan | PATCH | {{v3API}}/loans/{{LoanID}}/milestones?action=updateDates&persistent=true&mode=automatic |
| Encompass Loan / Audit Trail | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity |
| Encompass Loan / Audit Trail | 02 - Retrieve Loan | GET | /encompass/v3/loans/{{loanId}} |
| Encompass Loan / Audit Trail | 03 - Update Loan | PATCH | /encompass/v3/loans/{{loanId}}?view=entity |
| Encompass Loan / Audit Trail | 04 - Create Audit Trail | POST | /encompass/v3/loans/{{loanId}}/auditTrail?includeHistoricalData=false&ignoreInvalidFields=true&start=0&limit=10 |
| Encompass Loan / AUS Tracking Logs | 01 - Create an AUS Tracking log | POST | /encompass/v1/loans/{{loanId}}/ausTrackingLogs?view=id |
| Encompass Loan / AUS Tracking Logs | 02 - Get specific AUS tracking log | GET | /encompass/v1/loans/{{loanId}}/ausTrackingLogs/{{ausTrackingLogId}} |
| Encompass Loan / AUS Tracking Logs | 03 - Get list of AUS tracking Logs | GET | /encompass/v1/loans/{{loanId}}/ausTrackingLogs |
| Encompass Loan / AUS Tracking Logs | 04 - Get AUS Tracking log snapshot | GET | /encompass/v1/loans/{{loanId}}/ausTrackingLogs/{{ausTrackingLogId}}/snapshot |
| Encompass Loan / AUS Tracking Logs | 05 - Update an AUS Tracking log | PATCH | /encompass/v1/loans/{{loanId}}/ausTrackingLogs/{{ausTrackingLogId}}?view=entity |
| Encompass Loan / Batch Update | 01 - Update Loans - with Loan Guids | POST | /encompass/v1/loanBatch/updateRequests |
| Encompass Loan / Batch Update | 02 - Update Loans - with filter | POST | /encompass/v1/loanBatch/updateRequests |
| Encompass Loan / Batch Update | 03 - Get Status of Batch Update | GET | /encompass/v1/loanBatch/updateRequests/{{batchRequestId}} |
| Encompass Loan / Borrower Pairs | 01 - Create Borrower Pair | POST | /encompass/v1/loans/{{loanId}}/applications |
| Encompass Loan / Borrower Pairs | 02 - Get Borrower Pair | GET | /encompass/v1/loans/{{loanId}}/applications/{{bor_pair_id}} |
| Encompass Loan / Borrower Pairs | 03 - Get all BorrowerPairs | GET | /encompass/v1/loans/{{loanId}}/applications |
| Encompass Loan / Borrower Pairs | 04 - Update Borrower Pair | PATCH | /encompass/v1/loans/{{loanId}}/applications/{{bor_pair_id}} |
| Encompass Loan / Borrower Pairs | 05 - Delete Borrower Pair | DELETE | /encompass/v1/loans/{{loanId}}/applications/{{bor_pair_id}} |
| Encompass Loan / Borrower Pairs | 06 - Link Contact during Create Borrower Pair | POST | /encompass/v1/loans/{{loanId}}/applications?view=id |
| Encompass Loan / Borrower Pairs | 07 - Swap / Move Borrower - CoBorrower | PATCH | /encompass/v1/loans/{{loanId}}/applications |
| Encompass Loan / Borrower Vesting | 01 Create Loan | POST | /encompass/v3/loans?loanFolder=My Pipeline&view=entity |
| Encompass Loan / Borrower Vesting | 02 Get VestingEntities | GET | /encompass/v3/loans/{{loanId}}/closingDocument/vestingEntities?view=entity |
| Encompass Loan / Borrower Vesting | 03 Add VestingEntities | PATCH | /encompass/v3/loans/{{loanId}}/closingDocument/vestingEntities?action=add&view=Entity |
| Encompass Loan / Borrower Vesting | 04 Update VestingEntities | PATCH | /encompass/v3/loans/{{loanId}}/closingDocument/vestingEntities?action=update&view=Entity |
| Encompass Loan / Conversation Log / V3 Conversation Logs | 01 - Create Conversation Log | PATCH | /encompass/v3/loans/{{loanId}}/conversationlogs?action=add |
| Encompass Loan / Conversation Log / V1 Conversation Logs | 01 - Get List of conversation Logs | GET | /encompass/v1/loans/{{loanId}}/conversationLogs |
| Encompass Loan / Conversation Log / V1 Conversation Logs | 02 - Get Specific Conversation log | GET | /encompass/v1/loans/{{loanId}}/conversationLogs/519a85e0-dc9e-4e0b-8bf8-8912e18f37b2 |
| Encompass Loan / Disclosure Tracking / V3 Disclosure Tracking Log Email Messages | 03 - Get List of Manual DT 2015 Logs Copy | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/emailMessage |
| Encompass Loan / Disclosure Tracking / V3 Add Manual Disclosure Tracking 2015 Logs | 01a - Add Manual DT 2015 Log with LE | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?applicationId={{applicationId}}&view=Entity&includeSnapshot=true |
| Encompass Loan / Disclosure Tracking / V3 Add Manual Disclosure Tracking 2015 Logs | 01b - Add Manual DT 2015 Log with CD | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?applicationId={{applicationId}}&view=entity |
| Encompass Loan / Disclosure Tracking / V3 Add Manual Disclosure Tracking 2015 Logs | 01b - Add Manual DT 2015 Log with CD | PATCH | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=entity |
| Encompass Loan / Disclosure Tracking / V3 Add Manual Disclosure Tracking 2015 Logs | 03 - Get List of Manual DT 2015 Logs | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs |
| Encompass Loan / Disclosure Tracking / V3 Add Manual Disclosure Tracking 2015 Logs | 04 - Get Specific Manual DT 2015 Log | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?includeSnapshot=true |
| Encompass Loan / Disclosure Tracking / V3 Add Manual Disclosure Tracking 2015 Logs | 05 - Get Specific Manual DT 2015 Log Snapshot | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/snapshot |
| Encompass Loan / Disclosure Tracking / V3 DT Log - Manual Fulfillment | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity |
| Encompass Loan / Disclosure Tracking / V3 DT Log - Manual Fulfillment | 02 - Create Disclosure Tracking Log | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity |
| Encompass Loan / Disclosure Tracking / V3 DT Log - Manual Fulfillment | 03 - Create Fulfillment | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/fulfillments |
| Encompass Loan / Disclosure Tracking / V3 DT Log - Manual Fulfillment | 04 - Get a list of DT Logs | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 01 -  CreateLoan_multipleApps_NBO | POST | /encompass/v3/loans?loanFolder=Usha&view=Entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 02 -  Update 4499 to FullexternaleConsent | PATCH | /encompass/v3/loans/{{loanId}}?view=entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 03 -  Add Manual LE DT to Borrower1 | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 04 -  Update DT Add eConsent to Borrower1 | PATCH | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=Entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 05 -  Add Manual LE DT to Borrower2 | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity&applicationId={{applicationId1}} |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 06 - Update DT Add eConsent to Borrower2 | PATCH | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=Entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 07 - Add Manual CD DT to Borrower1 | POST | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs?view=Entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 08 - Update DT mark use for UCD | PATCH | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}?view=Entity |
| Encompass Loan / Disclosure Tracking / V3 Update Disclosure Tracking (including eConsent and UCD) | 09 - V3 getlist of DTs | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs |
| Encompass Loan / Disclosure Tracking / V1 Disclosure Tracking 2015 Logs | 01 - Get List of DT 2015 logs | GET | /encompass/v1/loans/{{loanId}}/disclosureTracking2015 |
| Encompass Loan / Disclosure Tracking / V1 Disclosure Tracking 2015 Logs | 02 - Get a Specific DT 2015 log | GET | /encompass/v1/loans/{{loanId}}/disclosureTracking2015/{{dtLogId}} |
| Encompass Loan / Disclosure Tracking / V1 Disclosure Tracking 2015 Logs | 03 - Get snapshot of a Specific DT 2015 log | GET | /encompass/v1/loans/{{loanId}}/disclosureTracking2015/5edb2949-666e-4ebf-8873-1ecc418a32cd/snapshot |
| Encompass Loan / Disclosure Tracking / V3 Disclosure Tracking Snapshots | 01 - Get Disclosure Tracking Snapshots | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/snapshots |
| Encompass Loan / Disclosure Tracking / V3 Disclosure Tracking Snapshots | 02 - Get Disclosure Tracking Snapshot for Specific DT Log | GET | /encompass/v3/loans/{{loanId}}/disclosureTracking2015Logs/{{disclosureTrackingId}}/snapshot |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 01 - Create a Document | PATCH | /encompass/v3/loans/{{loanId}}/documents?action=add&view=entity |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 02 - Retrieve a Document | GET | /encompass/v3/loans/{{loanId}}/documents/{{doc_id}} |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 03 - Retrieve Documents | GET | /encompass/v3/loans/{{loanId}}/documents?view=Full |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 04 - Update a Document | PATCH | /encompass/v3/loans/{{loanId}}/documents?action=update&view=entity |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 05 - Add Comments to a Document | PATCH | /encompass/v3/loans/{{loanId}}/documents/{{doc_id}}/comments?action=add&view=entity |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 06 - Assign Attachments | PATCH | /encompass/v3/loans/{{loanId}}/documents/{{doc_id}}/attachments?action=add |
| Encompass Loan / eFolder Documents / V3 Manage Documents | 07 - Remove a Document | PATCH | /encompass/v3/loans/{{loanId}}/documents?action=remove |
| Encompass Loan / eFolder Documents / V1 Manage Documents | 01 - Create a Document | POST | /encompass/v1/loans/{{loanId}}/documents?view=id |
| Encompass Loan / eFolder Documents / V1 Manage Documents | 02 - Retrieve a Document | GET | /encompass/v1/loans/{{loanId}}/documents/{{doc_id}} |
| Encompass Loan / eFolder Documents / V1 Manage Documents | 04 - Retrieve Document's Attachments | GET | /encompass/v1/loans/{{loanId}}/documents/{{doc_id}}/attachments |
| Encompass Loan / eFolder Documents / V1 Manage Documents | 03 - Retrieve Documents | GET | /encompass/v1/loans/{{loanId}}/documents |
| Encompass Loan / eFolder Documents / V1 Manage Documents | 05 - Update a Document | PATCH | /encompass/v1/loans/{{loanId}}/documents/{{doc_id}}?view=entity |
| Encompass Loan / eFolder Documents / V1 Manage Documents | 06 - Assign Attachments | PATCH | /encompass/v1/loans/{{loanId}}/documents/{{doc_id}}/attachments?action=add |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 01 - Upload Attachment to eFolder | POST | /encompass/v1/loans/{{loanId}}/attachments/url?view=id |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 01 - Upload Attachment to eFolder | PUT | {{mediaURL}} |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 02 - Get Attachment | GET | /encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}} |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 03 - Get Attachments | GET | /encompass/v1/loans/{{loanId}}/attachments |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 04 - Get Attachment from eFolder | POST | /encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}/url |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 05 - Get Page of Attachment | POST | /encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}/pages/{{pageId}}/url |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 06 - Get Thumbnail of Page | POST | /encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}}/pages/{{pageId}}/thumbnail/url |
| Encompass Loan / eFolder Attachments / V1 Manage Attachments | 07 - Update Attachment | PATCH | /encompass/v1/loans/{{loanId}}/attachments/{{AttachmentId}} |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 01a - Get URL to Upload Attachment to eFolder | POST | /encompass/v3/loans/{{loanId}}/attachmentUploadUrl |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | Get URL to Upload Attachment and Assign to eFolder | POST | /encompass/v3/loans/{{loanId}}/attachmentUploadUrl |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 01b - Upload Attachment | PUT | {{UploadURL}} |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 02 - Get Attachment | GET | /encompass/v3/loans/{{loanId}}/attachments/{{AttachmentId}} |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 03 - Get Attachments | GET | /encompass/v3/loans/{{loanId}}/attachments?includeRemoved=true |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 04 - Download Original Attachment | POST | /encompass/v3/loans/{{loanId}}/attachmentDownloadUrl |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 05 - Update an Attachment | PATCH | /encompass/v3/loans/{{loanId}}/attachments?action=update&view=entity |
| Encompass Loan / eFolder Attachments / V3 Manage Attachments | 06 - Remove an Attachment | PATCH | /encompass/v3/loans/{{loanId}}/attachments?action=remove |
| Encompass Loan / eFolder Attachments / eFolder Attachment Metadata | 01 - Get Attachment Metadata | GET | /efolder/v1/loans/{{loanId}}/files/{{AttachmentId}}?includeMetaData=true |
| Encompass Loan / eFolder Export Attachments | 01- Create an Export Job | POST | /efolder/v1/loans/{{loanId}}/exportJobsCreator |
| Encompass Loan / eFolder Export Attachments | 02 - Get Status of Export Job | GET | /efolder/v1/exportjobs/531d1bfb-8366-47e0-8668-b600191cd503 |
| Encompass Loan / eFolder Export Attachments | 03- Create an Export Job for Multiple Attachment Requests | POST | /efolder/v1/loans/{{loanId}}/exportJobsCreator?skipPersonaChecks=false&includeNotActive=true |
| Encompass Loan / eFolder History | 01 - Get eFolder History | GET | /encompass/v3/loans/{{loanId}}/histories/efolder |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 01 - Get list of conditions | GET | /encompass/v3/loans/{{loanId}}/conditions |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 02 - Get a specific condition | GET | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}?view=full |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 03a - Add conditions | PATCH | /encompass/v3/loans/{{loanId}}/conditions?action=add&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 03b - Duplicate conditions | PATCH | /encompass/v3/loans/{{loanId}}/conditions?action=duplicate&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 04 - Update conditions | PATCH | /encompass/v3/loans/{{loanId}}/conditions?action=update&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 05 - Add comments to a condition | PATCH | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments?action=add&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 06 - Get a condition's comments | GET | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 07 - Update a condition's comments | PATCH | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments?action=update&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 08 - Delete a condition's comments | PATCH | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/comments?action=delete&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 09 - Update Status Tracking | PATCH | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/tracking?action=add&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 10 - Get Status Tracking | GET | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/tracking |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 11 - Assign Documents to Condition | PATCH | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/documents?action=add&view=entity |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 12 - Unassign Documents to Condition | PATCH | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/documents?action=remove |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 13 - Get a condition's Documents | GET | /encompass/v3/loans/{{loanId}}/conditions/{{ConditionId}}/documents |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 14 - Remove conditions | PATCH | /encompass/v3/loans/{{loanId}}/conditions?action=remove |
| Encompass Loan / Enhanced Conditions / Manage Enhanced Conditions | 26.2R 15 - Update Delegation | PATCH | /encompass/v3/loans/{{loanId}}/conditions?action=update&view=entity |
| Encompass Loan / Import from File / V3 Support for MISMO 3.4 | 01a - Convert MISMO 3.4 file to Loan Object | POST | /encompass/v3/converter/loans?mediaType=mismo |
| Encompass Loan / Import from File / V3 Support for MISMO 3.4 | 01b - Create Loan from MISMO 3.4 file | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity |
| Encompass Loan / Import from File / V3 Support for MISMO 3.4 | 02 - Import MISMO 3.4 file to Update an existing Loan | POST | /encompass/v3/loans/{{loanId}}/importer?complianceFieldsImportOption |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 01 - Create an Underwriting Condition | POST | /encompass/v1/loans/{{loanId}}/conditions/underwriting?view=entity |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 02 - Get a specific Underwriting condition | GET | /encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}?view=entity |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 03 - Get list of Underwriting conditions | GET | /encompass/v1/loans/{{loanId}}/conditions/underwriting |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 04 - Add Underwriting conditions | PATCH | /encomapss/v1/loans/{{loanId}}/conditions/underwriting?action=add |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 05 -Update Underwriting conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/underwriting?action=update&view=id |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 06 - Remove Underwriting conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/underwriting?action=remove |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 07 - Add Comments to an Underwriting condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}/comments?action=add&view=entity |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 08 - Remove Comments from an Underwriting condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}/comments?action=remove |
| Encompass Loan / Loan Conditions / UnderWriting Conditions | 09 - Manage Documents for an Underwriting Condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/underwriting/{{ConditionId}}/documents?action=add&view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 01 - Create a Preliminary condition | POST | /encompass/v1/loans/{{loanId}}/conditions/preliminary?view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 02 - Get a specific Preliminary condition | GET | /encompass/v1/loans/{{loanId}}/conditions/preliminary/{{ConditionId}}?view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 03 - Get list of Preliminary conditions | GET | /encompass/v1/loans/{{loanId}}/conditions/preliminary |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 04 - Add Preliminary conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/preliminary?action=add&view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 05 - Update Preliminary conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/preliminary?action=update&view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 06 - Remove Preliminary conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/preliminary?action=remove&view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 07 -Manage Comments for a Preliminary Condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/preliminary/{{ConditionId}}/comments?action=remove&view=entity |
| Encompass Loan / Loan Conditions / Preliminary Conditions | 08 - Manage Documents for a Preliminary Condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/preliminary/{{ConditionId}}/documents?action=add&view=entity |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 01 - Create a Postclosing condition | POST | /encompass/v1/loans/{{loanId}}/conditions/postclosing?view=entity |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 02 - Get a specific Postclosing condition | GET | /encompass/v1/loans/{{loanId}}/conditions/postclosing/{{ConditionId}}?view=entity?view=entity |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 03 - Get list of Postclosing conditions | GET | /encompass/v1/loans/{{loanId}}/conditions/postclosing?view=entity&isRemoved=true |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 04 - Add Postclosing conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/postclosing?action=add&view=entity |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 05 - Update Postclosing conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/postclosing?action=update |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 06 - Update Postclosing conditions | PATCH | /encompass/v1/loans/{{loanId}}/conditions/postclosing?action=remove&view=entity |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 07 - Manage Comments for a Postclosing condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/postclosing/{{ConditionId}}/comments?action=add&view=entity |
| Encompass Loan / Loan Conditions / PostClosing Conditions | 08 - Manage Documents for a Postclosing Condition | PATCH | /encompass/v1/loans/{{loanId}}/conditions/postclosing/{{ConditionId}}/documents?action=add&view=entity |
| Encompass Loan / Loan Folder / V3 Loan Folders | 01 - Get list of Loan folders | GET | /encompass/v3/loanFolders |
| Encompass Loan / Loan Folder / V3 Loan Folders | 02 - Get a specific loan folder | GET | /encompass/v3/loanFolders/{{loanFolders}} |
| Encompass Loan / Loan Management / V3 Manage Loan | 01 - Create Loan | POST | /encompass/v3/loans?loanFolder={{loanFolder}}&view=entity |
| Encompass Loan / Loan Management / V3 Manage Loan | 01b - Create Loan with Loan Template Set | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity&templateType=templateSet&templatePath=Public%3A%5C%5CCompanywide%5CAPI+Automation+Loan+Templates%5CAllTemplatesSet |
| Encompass Loan / Loan Management / V3 Manage Loan | 01c - Create and Register a TPO Loan | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity&templateType=templateSet&templatePath=Public%3A%5C%5CCompanywide%5CAPI+Automation+Loan+Templates%5CAllTemplatesSet |
| Encompass Loan / Loan Management / V3 Manage Loan | 02 - Retrieve Loan | GET | /encompass/v3/loans/{{loanId}} |
| Encompass Loan / Loan Management / V3 Manage Loan | 02a - Update URLA Version of the loan | PATCH | /encompass/v3/loans/{{loanId}}/urlaVersion |
| Encompass Loan / Loan Management / V3 Manage Loan | 02b - Update Loan & apply loan template Set | PATCH | /encompass/v3/loans/{{loanId}}?view=entity&templateType=templateSet&templatePath=Public%3A%5C%5CCompanywide%5CAPI+Automation+Loan+Templates%5CAllTemplatesSet&ignoreEmptyClosingCostValues=true&ignoreEmptyLoanProgramValues=true&ignoreEmptyLoanProgramClosingCostValues=true |
| Encompass Loan / Loan Management / V3 Manage Loan | 02c - Update Loan & apply loan Program template | PATCH | /encompass/v3/loans/{{loanId}}?view=entity&templateType=loanProgram&templatePath=Public%3A%5C%5CCompanywide%5CFHA&ignoreEmptyLoanProgramValues=true&ignoreEmptyClosingCostValues=false |
| Encompass Loan / Loan Management / V3 Manage Loan | 02d - Update Loan & apply closing cost template | PATCH | /encompass/v3/loans/{{loanId}}?view=entity&templateType=closingCost&templatePath=Public%3A%5C%5CCompanywide%5CNew+Closing+Cost&ignoreEmptyClosingCostValues=true |
| Encompass Loan / Loan Management / V3 Manage Loan | 03 - Update Loan | PATCH | /encompass/v3/loans/{{loanId}}?view=entity |
| Encompass Loan / Loan Management / V3 Manage Loan | 03 - Archive Loan | PATCH | /encompass/v3/loans/{{loanId}}?view=entity |
| Encompass Loan / Loan Management / V3 Manage Loan | 04 - Field Writer for Standard, Custom, lockable, indexed, variable collection fields | POST | /encompass/v3/loans/{{loanId}}/fieldWriter |
| Encompass Loan / Loan Management / V3 Manage Loan | 05 - Field Reader | POST | /encompass/v3/loans/{{loanId}}/fieldReader?invalidFieldBehavior=Include |
| Encompass Loan / Loan Management / V3 Manage Loan | 06 - Add Field Lock Data | PATCH | /encompass/v3/loans/{{loanId}}/fieldLockData?action=add |
| Encompass Loan / Loan Management / V3 Manage Loan | 07 - Remove Field Lock Data | PATCH | /encompass/v3/loans/{{loanId}}/fieldLockData?action=remove |
| Encompass Loan / Loan Management / V3 Manage Loan | 08 - Replace Field Lock Data | PATCH | /encompass/v3/loans/{{loanId}}/fieldLockData?action=replace |
| Encompass Loan / Loan Management / V3 Manage Loan | 09 - Delete Loan | DELETE | /encompass/v3/loans/{{loanId}} |
| Encompass Loan / Loan Management / V3 Manage Loan | 10 - Preview Loan Update | PATCH | /encompass/v3/loans/{{loanId}}?view=entity&preview=true |
| Encompass Loan / Loan Management / V1 Manage Loan | 01a - Create a loan | POST | /encompass/v1/loans?view=entity |
| Encompass Loan / Loan Management / V1 Manage Loan | 01a - Import a loan from FNMA | POST | /encompass/v1/importers/loan |
| Encompass Loan / Loan Management / V1 Manage Loan | 01b - Create a loan with template | POST | /encompass/v1/loans?view=id&loanTemplate=Public%3a%5cCompanywide%5cDoNotDelete_LoanActions%5cChangeOfCircumstance_LoanActions |
| Encompass Loan / Loan Management / V1 Manage Loan | 01c - Create a loan in a folder | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=id |
| Encompass Loan / Loan Management / V1 Manage Loan | 01d - Create a loan & Assign LO | POST | /encompass/v1/loans?view=entity&loId={loId} |
| Encompass Loan / Loan Management / V1 Manage Loan | 02 - Retrieve a loan | GET | /encompass/v1/loans/{{loanId}} |
| Encompass Loan / Loan Management / V1 Manage Loan | 03 - Loan Field Reader (Retrieve values for field IDs) | POST | /encompass/v1/loans/{{loanId}}/fieldReader |
| Encompass Loan / Loan Management / V1 Manage Loan | 04 - Retrieve loan metadata | GET | /encompass/v1/loans/{{loanId}}/metadata |
| Encompass Loan / Loan Management / V1 Manage Loan | 05a - Update loan | PATCH | /encompass/v1/loans/{{loanId}}?view=id |
| Encompass Loan / Loan Management / V1 Manage Loan | 05b - Update Loan with Template | PATCH | /encompass/v1/loans/{{loanId}}?loanTemplate=Public%3A%5CCompanywide%5CEST-1826 |
| Encompass Loan / Loan Management / V1 Manage Loan | 06 - Move a Loan from one folder to another | PATCH | /encompass/v1/loanfolders/My Pipeline/loans?action=add |
| Encompass Loan / Loan Management / V1 Manage Loan | 07 - Delete the loan | DELETE | /encompass/v1/loans/{{loanId}} |
| Encompass Loan / Loan Management / V1 Manage Loan | 08 - Link Borrower Contact during Create Loan | POST | /encompass/v1/loans?loanfolder=My Pipeline&view=entity |
| Encompass Loan / Loan Management / V1 Manage Loan | 09 - Link Borrower Contact during Update Loan | PATCH | /encompass/v1/loans/{{loanId}}?view=entity |
| Encompass Loan / Loan Management / V1 Manage Loan | 10 - Link Business Contact during Create Loan | POST | /encompass/v1/loans?loanfolder=My Pipeline&view=entity |
| Encompass Loan / Loan Management / V1 Manage Loan | 11 - Link Business Contact during Update Loan | PATCH | /encompass/v1/loans/{{loanId}}?view=entity |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 01 - Get Canonical Names | GET | /encompass/v3/loanPipeline/canonicalFields |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 02 - Simple Query Pipeline | POST | /encompass/v3/loanPipeline?start=0&limit=1000 |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 03 - Complex Query Pipeline | POST | /encompass/v3/loanPipeline?limit=2000&include=LockInfo |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 04 - Retrieve using loanIds (no pagination) | POST | /encompass/v3/loanPipeline |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 05 - Include Archived Loans | POST | /encompass/v3/loanPipeline |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 05 - Simple Pipeline Query with Loan Folder | POST | /encompass/v3/loanPipeline?start=0&limit=10 |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 06a - Loan Pipeline for Reports - Step 1 | POST | /encompass/v3/loanPipeline/report |
| Encompass Loan / Loan Pipeline / V3 Loan Pipeline | 06b - Loan Pipeline for Reports - Step 2 | POST | /encompass/v3/loanPipeline/report?cursorId={{pip_cursor_id}} |
| Encompass Loan / Loan Pipeline / V1 Loan Pipeline | 01 - Create Cursor | POST | /encompass/v1/loanPipeline?cursortype=randomAccess&limit=10 |
| Encompass Loan / Loan Pipeline / V1 Loan Pipeline | 02 - Create Cursor (Loan Rate) | POST | /encompass/v1/loanPipeline?cursortype=randomAccess&limit=10 |
| Encompass Loan / Loan Pipeline / V1 Loan Pipeline | 03 - Paginate | POST | /encompass/v1/loanPipeline?cursor={{pip_cursor_id}}&start=3&limit=200 |
| Encompass Loan / Loan Pipeline / V1 Loan Pipeline | 04 - Retrieve Only GUID (No Pagination) | POST | /encompass/v1/loanPipeline?limit=2000 |
| Encompass Loan / Loan Pipeline / V1 Loan Pipeline | 05 - Retrieve using ONLY GUID (No Pagination) | POST | /encompass/v1/loanPipeline |
| Encompass Loan / Loan Pipeline / V1 Loan Pipeline | 06 - Get Canonical Names | GET | /encompass/v1/loanPipeline/fieldDefinitions |
| Encompass Loan / Loan Schema / V3 Loan Schema | 01 - Get v3 Loan Schema | GET | /encompass/v3/schemas/loan |
| Encompass Loan / Loan Schema / V3 Loan Schema | 02a - Get list of Standard Fields in Loan | GET | /encompass/v3/schemas/loan/standardFields?start=0&limit=10000 |
| Encompass Loan / Loan Schema / V3 Loan Schema | 02b - Get specific set of Standard Fields | GET | /encompass/v3/schemas/loan/standardFields?ids=4000,4002,2025,TQL.x27 |
| Encompass Loan / Loan Schema / V3 Loan Schema | 03 - Get list of Virtual Fields | GET | /encompass/v3/schemas/loan/virtualFields |
| Encompass Loan / Loan Schema / V1 Loan Schema | 01 - Get Loan Schema | GET | /encompass/v1/schema/loan |
| Encompass Loan / Loan Schema / V1 Loan Schema | 02 - Get Field Schema | GET | /encompass/v1/schema/loan/{{fieldId}}?= |
| Encompass Loan / Loan Schema / V1 Loan Schema | 03 - Get JSON Path for fields | POST | /encompass/v1/schema/loan/pathGenerator?ignoreInvalidFields=true&fieldNamePattern=loanType |
| Encompass Loan / Loan Schema / V1 Loan Schema | 04 - Get JSON Contract for fields | POST | /encompass/v1/schema/loan/contractGenerator |
| Encompass Loan / Loan Schema / V1 Loan Schema | 05 - Retrieve Supported Entities for Loan | GET | /encompass/v1/loans/supportedEntities |
| Encompass Loan / Rate Locks | 01 - Create Loan - v1 | POST | /encompass/v1/loans?view=entity |
| Encompass Loan / Rate Locks | 02 - Create AND Confirm a New Lock | POST | /encompass/v1/loans/{{loanId}}/RatelockRequests?action=confirm&copyLoanData=true&excludeInterestRateOnCopy=true&view=entity |
| Encompass Loan / Rate Locks | 03 - Create a Rate Lock request | POST | /encompass/v1/loans/{{loanId}}/RatelockRequests?view=entity |
| Encompass Loan / Rate Locks | 04 - Confirm a rate Lock request | PUT | /encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/Confirmation?view=entity |
| Encompass Loan / Rate Locks | 05 - Deny a Rate Lock request | PUT | /encompass/v1/loans/{{loanId}}/ratelockRequests/{{LockId}}/denial?view=entity |
| Encompass Loan / Rate Locks | 06 - Re-lock a Rate Lock | POST | /encompass/v1/loans/{{loanId}}/RatelockRequests?action=relock&requestId={{LockId}}&view=entity |
| Encompass Loan / Rate Locks | 07a - Cancel a  Rate Lock request from SR | POST | /encompass/v1/loans/{{loanId}}/ratelockrequests?action=cancel&requestId={{LockId}}&view=entity |
| Encompass Loan / Rate Locks | 07b - Cancel a Rate Lock request | PUT | /encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/cancellation?view=entity |
| Encompass Loan / Rate Locks | 08 -  Extend a Rate Lock | POST | /encompass/v1/loans/{{loanId}}/RatelockRequests?action=extend&requestId={{LockId}}&view=entity |
| Encompass Loan / Rate Locks | 09 - Update RateLock | PATCH | /encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}?view=entity&copyLoanData=true&excludeInterestRateOnCopy=true |
| Encompass Loan / Rate Locks | 10 - Revise a Rate Lock | POST | /encompass/v1/loans/{{loanId}}/RatelockRequests?action=revise&requestId={{LockId}}&view=entity |
| Encompass Loan / Rate Locks | 11 - Update Sell Comparison for active/expired/ denied locks | POST | /encompass/v1/loans/{{loanId}}/ratelockrequests?action=SellComparisonUpdate&requestId={{LockId}}&view=entity |
| Encompass Loan / Rate Locks | 12 - Void Rate Lock | PUT | /encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/void?view=entity |
| Encompass Loan / Rate Locks | 13 - Get a specific Rate Lock request | GET | /encompass/v1/loans/{{loanId}}/ratelockRequests/{{LockId}}?view=detailed |
| Encompass Loan / Rate Locks | 14 - Get the Loan Snapshot for a ratelock request | GET | /encompass/v1/loans/{{loanId}}/ratelockrequests/{{LockId}}/snapshot?view=entity |
| Encompass Loan / Rate Locks | 15 - Get list of Rate Lock requests | GET | /encompass/v1/loans/{{loanId}}/ratelockrequests |
| Encompass Loan / Registration Logs | 01 - Add Registration Log | POST | /encompass/v3/loans/{{loanId}}/registrationlogs?view=entity |
| Encompass Loan / Registration Logs | 02 - Update Registration Log | PATCH | /encompass/v3/loans/{{loanId}}/registrationlogs/{{registrationLogId}}?view=entity |
| Encompass Loan / Registration Logs | 03- Get Registration Logs | GET | /encompass/v3/loans/{{loanId}}/registrationlogs |
| Encompass Loan / Resource Lock / V1 Resource Locks | 01 - Lock a resource (loan) | POST | /encompass/v1/resourceLocks?view=id |
| Encompass Loan / Resource Lock / V1 Resource Locks | 02 - Retrieve a lock | GET | /encompass/v1/resourceLocks/{{LockId}}?resourceType=loan&resourceId={{loanId}} |
| Encompass Loan / Resource Lock / V1 Resource Locks | 03 - Retrieve locks | GET | /encompass/v1/resourceLocks?resourceType=loan&resourceId={{loanId}} |
| Encompass Loan / Resource Lock / V1 Resource Locks | 04 - Unlock a resource (loan) | DELETE | /encompass/v1/resourceLocks/{{LockId}}?resourceType=loan&resourceId={{loanId}} |
| Encompass Loan / Resource Lock / V3 Resource Locks Copy | 01 - Lock a resource (loan) | POST | /encompass/v3/resourceLocks?view=id |
| Encompass Loan / Resource Lock / V3 Resource Locks Copy | 02 - Retrieve a lock | GET | /encompass/v3/resourceLocks/{{LockId}}?resourceType=loan&resourceId={{loanId}} |
| Encompass Loan / Resource Lock / V3 Resource Locks Copy | 03 - Retrieve locks | GET | /encompass/v3/resourceLocks?resourceType=loan&resourceId={{loanId}} |
| Encompass Loan / Resource Lock / V3 Resource Locks Copy | 04 - Unlock a resource (loan) | DELETE | /encompass/v3/resourceLocks/{{LockId}}?resourceType=loan&resourceId={{loanId}} |
| Encompass Loan / Manage Loan Sub-collections / Manage VoDs | 01 - Add VODs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/vods?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoDs | 02 - Get VODs | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/vods |
| Encompass Loan / Manage Loan Sub-collections / Manage VoDs | 03 -Update VODs | PATCH | {{APIServer}}/EBS.WebApi/v3/loans/{{loanId}}/applications/{{applicationId}}/vods?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoDs | 04 - Delete VODs | PATCH | {{APIServer}}/EBS.WebApi/v3/loans/{{loanId}}/applications/{{applicationId}}/vods?action=clear |
| Encompass Loan / Manage Loan Sub-collections / Manage VoLs | 01 - Add VOLs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/vols?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoLs | 02 - Get VOLs | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/vols |
| Encompass Loan / Manage Loan Sub-collections / Manage VoLs | 03 -Update VOLs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/vols?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoLs | 04 - Delete VOLs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/vols?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage REO Properties | 01 - Add REO Properties | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/reoProperties?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage REO Properties | 02 - Get REO Properties | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/reoProperties |
| Encompass Loan / Manage Loan Sub-collections / Manage REO Properties | 03 -Update REO Properties | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/reoProperties?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage REO Properties | 04 - Delete REO Properties | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/reoProperties?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Residences | 01 - Add Residences | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/residences?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Residences | 02 - Get Residences | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/residences |
| Encompass Loan / Manage Loan Sub-collections / Manage Residences | 03 - Update Residences | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/residences?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Residences | 04 - Delete Residences | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/residences?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Employment | 01 - Add Employment records | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/employment?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Employment | 02 - Get Employment records | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/employment |
| Encompass Loan / Manage Loan Sub-collections / Manage Employment | 03 -Update Employment records | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/employment?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Employment | 04 - Delete Employment records | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/employment?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Non-VOLs | 01- Add non-VoLs | PATCH | /encompass/v3/loans/{{loanId}}/nonVols?action=add&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Non-VOLs | 02- Get non-VoLs | GET | /encompass/v3/loans/{{loanId}}/nonVols |
| Encompass Loan / Manage Loan Sub-collections / Manage Non-VOLs | 03 - Update Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=update&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Non-VOLs | 04 - Delete Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=delete&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Non-VOLs | 05 - Reorder Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=reorder&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Settlement Service Provider Contacts in Loan | 01- Add serviceProviderContacts | PATCH | /encompass/v3/loans/{{loanId}}/serviceProviderContacts?action=add&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Settlement Service Provider Contacts in Loan | 02- Get List of SSPL Contacts | GET | /encompass/v3/loans/{{loanId}}/serviceProviderContacts |
| Encompass Loan / Manage Loan Sub-collections / Manage Settlement Service Provider Contacts in Loan | 03 - Update SSPL Contacts | PATCH | /encompass/v3/loans/{{loanId}}/serviceProviderContacts?action=update&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Settlement Service Provider Contacts in Loan | 04 - Delete SSPL Contacts | PATCH | /encompass/v3/loans/{{loanId}}/serviceProviderContacts?action=delete&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Settlement Service Provider Contacts in Loan | 05 - Reorder SSPL Contacts | PATCH | /encompass/v3/loans/{{loanId}}/serviceProviderContacts?action=reorder&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Home Counseling Providers in Loan | 01- Add Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=add&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Home Counseling Providers in Loan | 02- Get List of Home Counseling Providers | GET | /encompass/v3/loans/{{loanId}}/homeCounselingProviders |
| Encompass Loan / Manage Loan Sub-collections / Manage Home Counseling Providers in Loan | 03 - Update Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=update&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Home Counseling Providers in Loan | 04 - Delete Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=delete&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Home Counseling Providers in Loan | 05 - Reorder Home Counseling Providers | PATCH | /encompass/v3/loans/{{loanId}}/homeCounselingProviders?action=reorder&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Affiliated Business Arrangements in Loan | 01- Add Affiliated Business Arrangements | PATCH | /encompass/v3/loans/{{loanId}}/affiliatedBusinessArrangements?action=add&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Affiliated Business Arrangements in Loan | 02- Get List of Affiliated Business Arrangements | GET | /encompass/v3/loans/{{loanId}}/affiliatedBusinessArrangements |
| Encompass Loan / Manage Loan Sub-collections / Manage Affiliated Business Arrangements in Loan | 03 - Update Affiliated Business Arrangements | PATCH | /encompass/v3/loans/{{loanId}}/affiliatedBusinessArrangements?action=update&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Affiliated Business Arrangements in Loan | 04 - Delete Affiliated Business Arrangements | PATCH | /encompass/v3/loans/{{loanId}}/affiliatedBusinessArrangements?action=delete&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Affiliated Business Arrangements in Loan | 05 - Reorder Affiliated Business Arrangements | PATCH | /encompass/v3/loans/{{loanId}}/affiliatedBusinessArrangements?action=reorder&view=Entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VooAs | 01 - Add VOOAs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherAssets?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VooAs | 02 - Get VOOAs | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherLiabilities |
| Encompass Loan / Manage Loan Sub-collections / Manage VooAs | 03 -Update VOOAs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherAssets?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VooAs | 04 - Delete VOOAs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherAssets?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VooIs | 01 - Add VOOIs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherIncomeSources?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VooIs | 02 - Get VOOIs | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherLiabilities |
| Encompass Loan / Manage Loan Sub-collections / Manage VooIs | 03 -Update VOOIs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherIncomeSources?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VooIs | 04 - Delete VOOIs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherLiabilities?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoGGs | 01 - Add VOGGs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/otherAssets?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoGGs | 02 - Get VOGGs | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/giftsGrants |
| Encompass Loan / Manage Loan Sub-collections / Manage VoGGs | 03 -Update VOGGs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/giftsGrants?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage VoGGs | 04 - Delete VOGGs | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/giftsGrants?action=delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 01 - Create Loan with Loan Template Set | POST | /encompass/v3/loans?loanFolder=My+Pipeline&view=entity&templateType=templateSet&templatePath=Public%3A%5C%5CCompanywide%5CAPI+Automation+Loan+Templates%5CAllTemplatesSet |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 01a - Add Borrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=Add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 01b - Add CoBorrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/coborrower/urlaAlternateNames?action=Add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 02a - Get Borrower URLA AlternateNames | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=Add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 02b - Get Coborrower URLA AlternateNames | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/coborrower/urlaAlternateNames?action=Add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 03a - Update Borrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=Update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 03b - Update Coborrower URLA AlternameName | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/coborrower/urlaAlternateNames?action=Update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 04a - Reorder Borrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=Reorder&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 04b - Reorder Coborrower URLA AlternameName | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/coborrower/urlaAlternateNames?action=Reorder&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 05a - Replace Borrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=replace&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 05b - Replace CoBorrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/coborrower/urlaAlternateNames?action=replace&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 06a - Delete Borrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=Delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Alternate Names Collection in Loan Application | 06b - Delete CoBorrower URLA AlternameNames | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/borrower/urlaAlternateNames?action=Delete&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Additional Loans Collection in Loan Application | 01 - Add Additional loans | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/additionalloans?view=entity&action=add |
| Encompass Loan / Manage Loan Sub-collections / Manage Additional Loans Collection in Loan Application | 02 - Update Additional loans | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/additionalloans?view=entity&action=update |
| Encompass Loan / Manage Loan Sub-collections / Manage Additional Loans Collection in Loan Application | 03 - Replace Additional loans | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/additionalloans?view=entity&action=replace |
| Encompass Loan / Manage Loan Sub-collections / Manage Additional Loans Collection in Loan Application | 04 - Reorder Additional loans | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/additionalloans?view=entity&action=reorder |
| Encompass Loan / Manage Loan Sub-collections / Manage Additional Loans Collection in Loan Application | 05 - Delete Additional loans | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/additionalloans?view=entity&action=delete |
| Encompass Loan / Manage Loan Sub-collections / Manage Additional Loans Collection in Loan Application | 06 - GET Additionalloans | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/additionalloans |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 00 - Retrieve Supported Entities for Loan | GET | /encompass/v1/loans/supportedEntities |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 00 - Get V3 Loan Schema | GET | /encompass/v3/schemas/loan |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 00 - Get specific set of Standard Fields | GET | /encompass/v3/schemas/loan/standardFields?ids=4953,FEMA0101,FEMA0102,FEMA0103,FEMA0104,FEMA0105,FEMA0106,FEMA0107,FEMA0108,FEMA0109,FEMA0110,FEMA0111,FEMA0112,FEMA0113,FEMA0114,FEMA0115,FEMA0116,FEMA0117 |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 01 - Create Loan with Disaster Record | POST | /encompass/v3/loans?loanFolder={{loanFolder}}&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 02 - Update Existing Disaster Record | PATCH | /encompass/v3/loans/{{loanId}}/disasters?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 03- Add New Disaster Records | PATCH | /encompass/v3/loans/{{loanId}}/disasters?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 04 - Replace Existing Disaster Collection | PATCH | /encompass/v3/loans/{{loanId}}/disasters?action=replace&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 05 - Reorder Existing Disaster Collection | PATCH | /encompass/v3/loans/{{loanId}}/disasters?action=reorder&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 06 - Delete Disaster Record | PATCH | /encompass/v3/loans/{{loanId}}/disasters?action=delete |
| Encompass Loan / Manage Loan Sub-collections / Manage Disasters | 07 - Get All Disaster Records | GET | /encompass/v3/loans/{{loanId}}/disasters?includeEmpty=false&includeRemoved=true |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 00 - Retrieve Supported Entities for Loan | GET | /encompass/v1/loans/supportedEntities |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 00 - Get v3 Loan Schema | GET | /encompass/v3/schemas/loan |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 00 - Get specific set of Standard Fields | GET | /encompass/v3/schemas/loan/standardFields?ids=4008,NBOC0098,NBOC0099,NBOC0101,NBOC0102,NBOC0103,NBOC0104,NBOC0105,NBOC0106,NBOC0107,NBOC0108,NBOC0109,NBOC0110,NBOC0111,NBOC0112,NBOC0113,NBOC0114,NBOC0115,NBOC0116,NBOC0117,NBOC0118,NBOC0119,NBOC0120,NBOC0121,NBOC0122,NBOC0123,NBOC0124,NBOC0125,NBOC0126,NBOC0127,NBOC0128,NBOC0130,NBOC0131,NBOC0132,NBOC0133,NBOC0134,NBOC0135,NBOC0136,NBOC0137,NBOC0138,NBOC0139,NBOC0140,NBOC0141 |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 01 - Create Loan - 2 borrowers and 1 NBO | POST | /encompass/v3/loans?loanFolder={{loanFolder}}&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 02 - Update Existing Non-Borrowing Owner | PATCH | /encompass/v3/loans/{{loanId}}/nonBorrowingOwners?action=update&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 03- Add New Non-Borrowing Owner | PATCH | /encompass/v3/loans/{{loanId}}/nonBorrowingOwners?action=add&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 04 - Replace Existing Non-Borrowing Owners | PATCH | /encompass/v3/loans/{{loanId}}/nonBorrowingOwners?action=replace&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 05 - Reorder Existing Non-Borrowing Owners | PATCH | /encompass/v3/loans/{{loanId}}/nonBorrowingOwners?action=reorder&view=entity |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 06 - Delete Non-Borrowing Owner | PATCH | /encompass/v3/loans/{{loanId}}/nonBorrowingOwners?action=delete |
| Encompass Loan / Manage Loan Sub-collections / Manage NBOs | 07 - Get All Borrowing Owners | GET | /encompass/v3/loans/{{loanId}}/nonBorrowingOwners?includeEmpty=false&includeRemoved=true |
| Encompass Loan / Manage Loan Sub-collections / Manage Request for Transcript of Tax | Retrieve Request for Transcript of Tax - PREVIEW | GET | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/tax4506Ts |
| Encompass Loan / Manage Loan Sub-collections / Manage Request for Transcript of Tax | Update Request for Transcript of Tax | PATCH | /encompass/v3/loans/{{loanId}}/applications/{{applicationId}}/tax4506Ts?action=add |
| Encompass Loan / Loan Funding | Get Funding Fees | GET | /encompass/v3/loans/{{loanId}}/fundingFees |
| Encompass Loan / Loan Funding | Update Funding Fees | PATCH | /encompass/v3/loans/{{loanId}}/fundingFees |
| Encompass Loan / Loan Funding | Get Funding Balances | GET | /encompass/v3/loans/{{loanId}}/fundingBalances |
| Encompass Loan / Loan Alerts | Get Good Faith Fee Variance Violations | GET | /encompass/v3/loans/{{loanId}}/fundingFees |
| Secondary and Trades / Trade Management / Trade Pipeline | 01 - Get correspondentTrade Field Definitions | GET | /secondary/v1/tradePipeline/canonicalFields?type=CorrespondentTrade |
| Secondary and Trades / Trade Management / Trade Pipeline | 1b - Get loanTrade Field Definitions | GET | /secondary/v1/tradePipeline/canonicalFields?type=loanTrade |
| Secondary and Trades / Trade Management / Trade Pipeline | 02 - Get Correspondent Trade Pipeline | POST | /secondary/v1/tradePipeline?type=correspondentTrade&view=current |
| Secondary and Trades / Trade Management / Trade Pipeline | 2b - Get Loan Trade Pipeline | POST | /secondary/v1/tradePipeline?type=loanTrade&limit=10 |
| Secondary and Trades / Trade Management / Correspondent Trades | 01 - Create Correspondent Trade | POST | /secondary/v1/trades/correspondent |
| Secondary and Trades / Trade Management / Correspondent Trades | 02 -  Get a specific Trade | GET | /secondary/v1/trades/correspondent/{{TradeId}} |
| Secondary and Trades / Trade Management / Correspondent Trades | 03 - Create Loan | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=Entity |
| Secondary and Trades / Trade Management / Correspondent Trades | 04 - Assign loans to a Trade | PUT | /secondary/v1/trades/correspondent/{{TradeId}}/loans |
| Secondary and Trades / Trade Management / Correspondent Trades | 05 - Update a Trade | PATCH | /secondary/v1/trades/correspondent/{{TradeId}} |
| Secondary and Trades / Trade Management / Correspondent Trades | 06 - Publish a Trade | PATCH | /secondary/v1/trades/correspondent/{{TradeId}}?action=publish |
| Secondary and Trades / Trade Management / Correspondent Trades | 07 - Get Event History of a Trade | GET | /secondary/v1/trades/correspondent/{{TradeId}}/eventHistory |
| Secondary and Trades / Trade Management / Correspondent Trades | 08 - Get Notes of a Trade | GET | /secondary/v1/trades/correspondent/{{TradeId}}/notes |
| Secondary and Trades / Trade Management / Correspondent Trades | 09 - Get Statistics of a Trade | GET | /secondary/v1/trades/correspondent/{{TradeId}}/statistics |
| Secondary and Trades / Trade Management / Correspondent Trades | 12 - Update Assigned Loan in a Correspondent Trade | PUT | /secondary/v1/trades/correspondent/{{TradeId}}/loans/update |
| Secondary and Trades / Trade Management / Loan Trades | 01 Create Loan Trade with Filters | POST | /secondary/v1/trades/loanTrades |
| Secondary and Trades / Trade Management / Loan Trades | 01b Create Loan Trade | POST | /secondary/v1/trades/loanTrades |
| Secondary and Trades / Trade Management / Loan Trades | 02 Update Loan Trade | PATCH | /secondary/v1/trades/loanTrades/{{TradeId}} |
| Secondary and Trades / Trade Management / Loan Trades | 03 Create Loan1 | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=Entity |
| Secondary and Trades / Trade Management / Loan Trades | 04 Create Loan2 | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=Entity |
| Secondary and Trades / Trade Management / Loan Trades | 05 Create Loan3 | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=Entity |
| Secondary and Trades / Trade Management / Loan Trades | 06 Create Loan4 | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=Entity |
| Secondary and Trades / Trade Management / Loan Trades | 07 Create Loan5 | POST | /encompass/v1/loans?loanFolder=My Pipeline&view=Entity |
| Secondary and Trades / Trade Management / Loan Trades | 08 Assign Loans to a Loan Trade | PUT | /secondary/v1/trades/loanTrades/{{TradeId}}/loans |
| Secondary and Trades / Trade Management / Loan Trades | 09 Update Assigned Loans in a Loan Trade | PUT | /secondary/v1/trades/loanTrades/{{TradeId}}/loans/update?forceUpdateAllLoans=true&dataSyncOption=syncLockToLoan |
| Secondary and Trades / Trade Management / Loan Trades | 10 Get Loan Trade | GET | /secondary/v1/trades/loanTrades/{{TradeId}}?view=all |
| Secondary and Trades / Trade Management / Loan Trades | 11 Unassign Loans from a Loan Trade | DELETE | /secondary/v1/trades/loanTrades/{{TradeId}}/loans |
| Secondary and Trades / Trade Management / Trade Documents | Create Loan Trade with Documents | POST | /secondary/v1/trades/loanTrades |
| Secondary and Trades / Trade Management / Trade Documents | 02 Loan Trade Documents Pipeline | POST | /secondary/v1/Trades/loanTrades/{{TradeId}}/documents |
| Secondary and Trades / Trade Management / Trade Documents | 03 Create Trade Document Upload URL | POST | /secondary/v1/trades/urlGenerator |
| Secondary and Trades / Secondary Settings | 01 - Get list of Investor Templates | GET | /encompass/v3/settings/secondary/investorTemplates |
| Secondary and Trades / Secondary Settings | 02 - Get details of a specific Investor Template | GET | /encompass/v3/settings/secondary/investorTemplates/{{investorTemplateId}} |
| Secondary and Trades / Funding Templates | 01 - Get List of Funding Templates from Settings | GET | /encompass/v3/settings/secondary/fundingTemplates |
| Secondary and Trades / Funding Templates | 02 - Create Loan | POST | /encompass/v3/loans?loanfolder=My+Pipeline&view=Entity |
| Secondary and Trades / Funding Templates | 03 - Apply Funding Template to loan | PATCH | /encompass/v3/loans/{{loanId}}?view=entity&templateType=funding&templatePath=Public:\\2015 Funding Template Conventional&ignoreEmptyFundingTemplateValues=false |
| Secondary and Trades / Funding Templates | 04 - Get Loan | GET | /encompass/v3/loans/{{loanId}}?view=entity |
| Services / Partner Services | 01a - Order a Service (requestType:newOrder) | POST | /services/v1/partners/{{partnerId}}/transactions?view=id |
| Services / Partner Services | 01b - Submit Request to retrieve DU Report Files | POST | /services/v1/partners/{{du_partner_id}}/transactions |
| Services / Partner Services | 01c - Submit Request to retrieve CBC-Credit Report Files | POST | /services/v1/partners/304369/transactions |
| Services / Partner Services | 01d - Submit Request to Freddie Mac Affordable Check | POST | /services/v1/partners/{{partnerId}}/transactions |
| Services / Partner Services | 02a - Get a credit transaction's status | GET | /services/v1/partners/307827/transactions/{{transactionId}} |
| Services / Partner Services | 02b - Get Transaction Status Response with Report URLs | GET | /services/v1/partners/{{partner_id}}/transactions/{{transaction_id}}?generateFileUrls=true |
| Services / Partner Services | 03 - Download Report file using URL | GET | {{URL}} |
| Services / Encompass Compliance Service | 01 - GetLatestReport | GET | /ecs/v1/compliancereports?EntityType=urn:elli:encompass:loan&EntityId={{loanId}} |
| Services / Encompass Compliance Service | 02 - OrderReport | POST | /ecs/v1/ComplianceReports |
| Services / Encompass Product and Pricing Service / User Mapping | 01 - Get EPPS User mapping | GET | /epps/v2/userMappings |
| Services / Encompass Product and Pricing Service / User Mapping | 02 - Map EPPS User | PATCH | /epps/v2/userMappings?action=add |
| Services / Encompass Product and Pricing Service / User Mapping | 03 - Remove mapping to EPPS User | PATCH | /epps/v2/userMappings?action=delete |
| Services / Encompass Product and Pricing Service / Rates | Post Rates_CONV_FIXED | POST | /epps/v2/loanQualifier |
| Services / Encompass Product and Pricing Service / Rates | Get Programs and Rates_FNMA Mission Score | POST | /epps/v2/loanQualifier |
| Services / Encompass Product and Pricing Service / Rates | Post Rates_CONV_FIXED Eligibility | POST | /epps/v2/loans/programs/{{ProgramID}}/eligibility |
| Services / Encompass Product and Pricing Service / Rates | RateSelector_200 | POST | /epps/v2/loans/{{loanId}}/rateSelector |
| Services / Encompass Product and Pricing Service / Rates | Adjustments_200 | POST | /epps/v2/loans/programs/{{ProgramID}}/adjustments |
| Services / Encompass Product and Pricing Service / Rates | Guidelines | GET | /epps/v2/programs/{{ProgramID}}/guidelines |
| Services / Encompass Product and Pricing Service / Lookups | ProductOptionsLookup | GET | /epps/v2/lookups/productOptions |
| Services / Encompass Product and Pricing Service / Lookups | PropertyTypes | GET | /epps/v2/lookups/propertyTypes |
| Services / Encompass Product and Pricing Service / Lookups | SpecialProducts | GET | /epps/v2/lookups/specialProducts |
| Services / Encompass Product and Pricing Service / Lookups | Standard Products | GET | /epps/v2/lookups/standardProducts |
| Services / Encompass Product and Pricing Service / Lookups | PropertyUse | GET | /epps/v2/lookups/propertyUse |
| Services / Encompass Product and Pricing Service / Lookups | loanUsage | GET | /epps/v2/lookups/loanUsage |
| Services / Encompass Product and Pricing Service / Lookups | loanTerms | GET | /epps/v2/lookups/loanTerms |
| Services / Encompass Product and Pricing Service / Lookups | bankruptcy | GET | /epps/v2/lookups/bankruptcy |
| Services / Encompass Product and Pricing Service / Lookups | foreclosure | GET | /epps/v2/lookups/foreclosure |
| Services / Encompass Product and Pricing Service / Lookups | counties | GET | /epps/v2/lookups/state/5/counties |
| Services / Encompass Product and Pricing Service / Lookups | states | GET | /epps/v2/lookups/states |
| Services / Encompass Product and Pricing Service / Lookups | agencyapprovals | GET | /epps/v2/lookups/agencyapprovals |
| Services / Encompass Product and Pricing Service / Lookups | lockDays | GET | /epps/v2/lookups/lockDays |
| Services / Encompass Product and Pricing Service / Lookups | prepayPenaltyTerms | GET | /epps/v2/lookups/prepayPenaltyTerms |
| Services / Encompass Product and Pricing Service / Lookups | deliveryTypes | GET | /epps/v2/lookups/deliveryTypes |
| Services / Encompass Product and Pricing Service / Lookups | encompassElements | GET | /epps/v2/lookups/encompassElements |
| Services / Encompass Product and Pricing Service / Lookups | customFields | GET | /epps/v2/lookups/customFields |
| Services / Encompass Product and Pricing Service / Lookups | documentationTypes | GET | /epps/v2/lookups/documentationTypes |
| Services / Encompass Product and Pricing Service / Lookups | citizenship | GET | /epps/v2/lookups/citizenship |
| Services / Encompass Product and Pricing Service / Lookups | LienPos | GET | /epps/v2/lookups/lienPos |
| Services / Encompass Product and Pricing Service / Lookups | citizenship | GET | /epps/v2/lookups/citizenship |
| Services / Encompass Product and Pricing Service / Lookups | buydownType | GET | /epps/v2/lookups/buydownType |
| Services / Encompass Product and Pricing Service / Lookups | nonQMDocLevel | GET | /epps/v2/lookups/nonQMDocLevel |
| Services / Encompass Product and Pricing Service / Lookups | buydownContributorType | GET | /epps/v2/lookups/buydownContributorType |
| Services / Encompass Product and Pricing Service / Lookups | NODTypes | GET | /epps/v2/lookups/NODTypes |
| Services / Encompass Product and Pricing Service / Lookups | Locations | GET | /epps/v2/lookups/zipcodes/10018/locations |
| Services / Encompass Product and Pricing Service / Lookups | UnitTypes | GET | /epps/v2/lookups/UnitTypes |
| Services / Encompass Product and Pricing Service / Lookups | CommitmentTypes | GET | /epps/v2/lookups/CommitmentTypes |
| Services / Encompass Product and Pricing Service / Lookups | clientSettings | GET | /epps/v2/lookups/CommitmentTypes |
| Services / Encompass Product and Pricing Service / Lookups | investors | GET | /epps/v2/lookups/investors |
| Services / Encompass Product and Pricing Service / Lookups | Rates CONV | POST | /epps/v2/loanQualifier |
| Services / Encompass Product and Pricing Service / Lookups | loanlimits | GET | /epps/v2/lookups/loans/{{loanId}}/loanlimits |
| Services / Encompass Product and Pricing Service / Lookups | qualificationID | GET | /epps/v2/programs/{{ProgramID}}/guidelines/details/{{qualificationID}} |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 01 - Get Custom Fields | GET | /encompass/v3/settings/loan/customFields |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 02 - Get Specific Custom Fields | GET | /encompass/v3/settings/loan/customFields?ids=CUST01FV,CUST02FV,CUST03FV |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 03 - Get Custom Fields with Limits | GET | /encompass/v3/settings/loan/customFields?start=0&limit=5 |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 04 - Create Custom Field_1 | PATCH | /encompass/v3/settings/loan/customFields?action=add&view=entity |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 05 - Create Custom Field_2 | PATCH | /encompass/v3/settings/loan/customFields?action=add&view=entity |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 06 - Create Custom Field_3 | PATCH | /encompass/v3/settings/loan/customFields?action=add&view=entity |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 07 - Update Custom Field | PATCH | /encompass/v3/settings/loan/customFields?action=update&view=entity |
| Settings and Utilities / Custom Field Management / V3 Custom Fields | 08 - Delete Custom Field | PATCH | /encompass/v3/settings/loan/customFields?action=delete&view=entity |
| Settings and Utilities / Custom Field Management / V1 Custom Fields Settings | 01 - Get Settings for list of Custom Fields | GET | /encompass/v1/settings/loan/customFields |
| Settings and Utilities / Custom Field Management / V1 Custom Fields Settings | 02 - Get Settings for a Specific Custom Field | GET | /encompass/v1/settings/loan/customFields/{{customFieldId}} |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 01 - Create/ Replace Global CDO | PUT | /encompass/v1/company/customObjects/Demo2.txt?view=id |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 02 - Update Global  CDO | PUT | /encompass/v1/company/customObjects/{{GlobalCDOid}}?view=entity |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 03 - Get List of all Global CDOs | GET | /encompass/v1/company/customObjects |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 04 - Get a Specific Global CDO | GET | /encompass/v1/company/customObjects/{{GlobalCDOid}} |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 05 - Delete a Global  CDO | DELETE | /encompass/v1/company/customObjects/Demo2.txt |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 06 - Append Global CDO 1 | PATCH | /encompass/v1/company/customObjects/{{GlobalCDOid}}?view=entity |
| Settings and Utilities / Custom Data Objects / CDO GLOBAL  | 07 - Append Global  CDO 2 | PATCH | /encompass/v1/company/customObjects/Demo1.txt?view=entity |
| Settings and Utilities / Custom Data Objects / CDO USER  | 01 - Create/ Replace a User CDO | PUT | /encompass/v1/users/{{user}}/customObjects/Demo2.txt?view=id |
| Settings and Utilities / Custom Data Objects / CDO USER  | 02 - Update a User CDO | PUT | /encompass/v1/users/{{user}}/customObjects/{{UserCDOid}}?view=entity |
| Settings and Utilities / Custom Data Objects / CDO USER  | 03 - Get List of all User CDOs | GET | /encompass/v1/users/{{user}}/customObjects |
| Settings and Utilities / Custom Data Objects / CDO USER  | 04 - Get a Specific User CDO | GET | /encompass/v1/users/{{user}}/customObjects/{{UserCDOid}} |
| Settings and Utilities / Custom Data Objects / CDO USER  | 05 - Delete a User CDO | DELETE | /encompass/v1/users/{{user}}/customObjects/{{UserCDOid}} |
| Settings and Utilities / Custom Data Objects / CDO USER  | 06 - Append CDO 1 | PATCH | /encompass/v1/users/{{user}}/customObjects/MyObjectFile.txt?view=entity |
| Settings and Utilities / Custom Data Objects / CDO USER  | 07 - Append CDO 2 | PATCH | /encompass/v1/users/{{user}}/customObjects/MyObjectFile.txt |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 01 - Create/ Replace a Loan CDO | PUT | /encompass/v1/loans/{{loanId}}/customObjects/demo2.txt?view=id |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 02 - Update a Loan CDO | PUT | /encompass/v1/loans/{{loanId}}/customObjects/{{LoanCDOid}}?view=entity |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 03 - Get List of all Loan CDOs | GET | /encompass/v1/loans/{{loanId}}/customObjects |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 04 - Get a Specific Loan CDO | GET | /encompass/v1/loans/{{loanId}}/customObjects/{{LoanCDOid}} |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 05 - Delete a Loan CDO | DELETE | /encompass/v1/loans/{{loanId}}/customObjects/{{LoanCDOid}} |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 06 - AppendLoanCDO 1 | PATCH | /encompass/v1/loans/{{loanId}}/customObjects/{{LoanCDOid}}?view=entity |
| Settings and Utilities / Custom Data Objects / CDO LOAN  | 07 - AppendLoanCDO 2 | PATCH | /encompass/v1/loans/{{loanId}}/customObjects/MyObjectFile.txt?view=entity |
| Settings and Utilities / Settings: Business Contacts | 01 - Get Business Contacts Custom Fields | GET | /encompass/v3/settings/contacts/businessContacts/customFields |
| Settings and Utilities / Settings: Business Contacts | 02 - Get Business Contacts Categories | GET | /encompass/v3/settings/contacts/businessContacts/categories |
| Settings and Utilities / Settings: Business Contacts | 03 - Get Business Contacts Custom Category Fields | GET | /encompass/v3/settings/contacts/businessContacts/customCategoryFields?includeLegacyId=True |
| Settings and Utilities / Settings: Document Settings | 01 - Get eFolder Document Settings | GET | /encompass/v3/settings/efolder/documents |
| Settings and Utilities / Settings: Document Settings | 02 - Get eFolder Document Options | GET | /encompass/v3/settings/efolder/documents/options |
| Settings and Utilities / Settings: Document Settings | 03 - Get List of eFolder Document Stacking Templates | GET | /encompass/v3/settings/eFolder/documentStackingTemplates |
| Settings and Utilities / Settings: Document Settings | 04 - Get eFolder Document Groups | GET | /encompass/v3/settings/eFolder/documentGroups |
| Settings and Utilities / Settings: Document Settings | 04 - Get List of Print Form Groups | GET | /encompass/v3/settings/loan/printFormGroups?path=public&level=all&includeAdditionalInfo=true&start=0&limit=1000 |
| Settings and Utilities / Settings: Document Settings | 05 - Get Print Form Group Details | GET | /encompass/v3/settings/loan/printFormGroupDetail?path=Public:\\EDS_21.2&start=0&limit=1000 |
| Settings and Utilities / Settings: Document Settings | 06 - Get List of Custom Print Forms | GET | /encompass/v3/settings/loan/customPrintForms?path=public&level=All&start=0&limit=1000 |
| Settings and Utilities / Settings: Document Settings | 07 - Get List of Standard Print Forms | GET | /encompass/v3/settings/loan/standardPrintForms?view=full&start=0&limit=5 |
| Settings and Utilities / Settings: External Organizations / Manage External Orgs | 01 - Get list of external Organizations (TPO) (slated for deprecation) | GET | /encompass/v3/externalOrganizations/tpos |
| Settings and Utilities / Settings: External Organizations / Manage External Orgs | Get List of External Orgs | GET | /encompass/v3/settings/externalOrganizations/tpos?start=0&tpoId={{tpoOrgId}} |
| Settings and Utilities / Settings: External Organizations / Manage External Orgs | 02 - Get a specific external Organization (TPO) - (slated for deprecation) | GET | /encompass/v3/externalOrganizations/tpos/{{tpoOrgId}}?entities=all |
| Settings and Utilities / Settings: External Organizations / Manage External Orgs | 02 - Get Specific External Org | GET | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}} |
| Settings and Utilities / Settings: External Organizations / Manage External Orgs | 03 - Create External Org | POST | /encompass/v3/settings/externalOrganizations/tpos?view=entity&parentOrgId=111 |
| Settings and Utilities / Settings: External Organizations / Manage External Orgs | 04 - Update External Org | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}?view=entity |
| Settings and Utilities / Settings: External Organizations / Manage DBA | 02 - Add DBA | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/dbas?view=entity&action=add |
| Settings and Utilities / Settings: External Organizations / Manage DBA | 02 - Update DBA | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/dbas?view=entity&action=update |
| Settings and Utilities / Settings: External Organizations / Manage DBA | 03 - ReOrder DBA | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/dbas?view=entity&action=reorder |
| Settings and Utilities / Settings: External Organizations / Manage DBA | 04 - Delete DBA | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/dbas?view=entity&action=delete |
| Settings and Utilities / Settings: External Organizations / Manage Warehouse | 01 - Add Warehouse | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/warehouses?view=entity&action=add |
| Settings and Utilities / Settings: External Organizations / Manage Warehouse | 02 - Update warehouse | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/warehouses?view=entity&action=update |
| Settings and Utilities / Settings: External Organizations / Manage Warehouse | 03 - Delete Warehouse | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{tpoOrgId}}/warehouses?view=entity&action=Delete |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get Company Status | GET | /encompass/v3/settings/externalOrganizations/tpoSettings/companyStatus |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get Company Rating | GET | /encompass/v3/settings/externalOrganizations/tpoSettings/companyRating |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get Product and Pricing | GET | /encompass/v3/settings/externalOrganizations/tpoSettings/PriceGroup |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get External Banks | GET | /encompass/v3/settings/externalOrganizations/banks |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get TPO Custom Field Definition Settings | GET | /encompass/v3/settings/externalOrganizations/tpoCustomFieldDefinitions |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get TPO Fees | GET | /encompass/v3/settings/externalOrganizations/tpoFees?view=Full&start=0&limit=2 |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get TPO Fees Copy | GET | /encompass/v3/settings/externalOrganizations/tpoFees/{{feeId}}?view=Summary |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get TPO Late Fees | GET | /encompass/v3/settings/externalOrganizations/tpoLateFees |
| Settings and Utilities / Settings: External Organizations / TPO Settings | V3 Add External Org Site URLs | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{orgId}}/externalUrls?action=add&view=entity |
| Settings and Utilities / Settings: External Organizations / TPO Settings | V3 Update External Org Site URL | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{{orgId}}/externalUrls?action=update&view=entity |
| Settings and Utilities / Settings: External Organizations / TPO Settings | V3 Delete External Org Site URL | PATCH | /encompass/v3/settings/externalOrganizations/tpos/{orgId}/externalUrls |
| Settings and Utilities / Settings: External Organizations / TPO Settings | Get List of Available External Site URLs | GET | /encompass/v3/settings/externalOrganizations/tpoSettings/externalUrls |
| Settings and Utilities / Settings: External Users | 01 - Get list of external users | GET | /encompass/v3/externalUsers?orgId={{tpoOrgId}} |
| Settings and Utilities / Settings: External Users | 02 - Get a specific external user | GET | /encompass/v3/externalUsers/{{TPOUserId1}} |
| Settings and Utilities / Settings: External Users | 03 - Get a specific external user's effective rights | GET | /encompass/v3/externalUsers/{{TPOUserId1}}/effectiveRights |
| Settings and Utilities / Settings: External Users | 04 - Update External User | PATCH | /encompass/v3/externalUsers?action=update&view=entity&orgId={{tpoOrgId}} |
| Settings and Utilities / Settings: External Users | 05 - Delete External User | PATCH | /encompass/v3/externalUsers?Action=Delete&view=entity&orgId={{tpoOrgId}} |
| Settings and Utilities / Settings: External Users | 06 - Add External User | PATCH | /encompass/v3/externalUsers?Action=add&view=entity&orgId={{tpoOrgId}} |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 01 - Retrieve List of Templates (Loan Template Sets) | GET | /encompass/v3/settings/templates/loanTemplateSet/folders?path=public%5cCompanywide |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 02 - Get list of Loan Program Templates | GET | /encompass/v3/settings/templates/loanProgram/folders?path=Public:\\Companywide\\ |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 03 - Get list of Closing Cost Templates | GET | /encompass/v3/settings/templates/closingCost/folders?path=Public:\\Companywide\\ |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 04 - Get list of SSP Templates | GET | /encompass/v3/settings/templates/settlementServiceProvider/folders?path=Public |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 05 - Get Loan Program Template Items | GET | /encompass/v3/settings/templates/loanProgram/items?path=Public:\\Companywide\\10/1 LIBOR 5/2/5 Caps |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 06 - Get List of Transcript of Tax Templates | GET | /encompass/v3/settings/templates/transcriptRequests?formVersions&start&limit |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | 07 - Get Transcript of Tax Template | GET | /encompass/v3/settings/templates/transcriptRequests/{{templateId}} |
| Settings and Utilities / Settings: Loan Templates / V3 Loan Templates | Get Closing Cost Template Settings | GET | /encompass/v3/settings/templates/closingCost/items?path=Public:\\Companywide\\234 |
| Settings and Utilities / Settings: Loan Templates / V1 Loan Templates | 01 - Return all template folders | GET | /encompass/v1/settings/templates/loanTemplateSet/folders/public |
| Settings and Utilities / Settings: Loan Templates / V1 Loan Templates | 02 - Return list of loan templates | GET | /encompass/v1/settings/templates/loanTemplateSet/items?path={{entityUri}} |
| Settings and Utilities / Settings: Organizations | 01 - Get List of Organizations | GET | /encompass/v1/organizations?start=1&limit=5&view=summary |
| Settings and Utilities / Settings: Organizations | 02 - Get specific Organization By OrgId | GET | /encompass/v1/organizations/{{orgId}}?view=entity |
| Settings and Utilities / Settings: Organizations | 03 - Retrieve the root organization | GET | /encompass/v1/organizations/root?view=summary |
| Settings and Utilities / Settings: Organizations | 04 - Get Organization Children | GET | /encompass/v1/organizations/{{orgId}}/children?recursive=false&type=user&start=1&limit=10 |
| Settings and Utilities / Settings: Personas / V3 Personas | Get list of Personas | GET | /encompass/v3/settings/personas?filter=name:'{{personaName}}'&start=0&limit=100 |
| Settings and Utilities / Settings: Personas / V3 Personas | Get specific Persona | GET | /encompass/v3/settings/personas/{{personaId}} |
| Settings and Utilities / Settings: Personas / V3 Personas | Get specific categories for a Persona | GET | /encompass/v3/settings/personas/{{personaId}}?categories=borrowerContacts,settings,forms,tools |
| Settings and Utilities / Settings: Personas / V1 Persona Settings | 01 - Get List of Personas | GET | /encompass/v1/settings/personas |
| Settings and Utilities / Settings: Personas / V1 Persona Settings | 02 - Get specific Persona | GET | /encompass/v1/settings/personas/{{personaId}} |
| Settings and Utilities / Settings: Personas / V1 Persona Settings | 03 - Get specific categories for a Persona | GET | /encompass/v1/settings/personas/{{personaId}}?categories=borrowerContacts,settings,forms,tools |
| Settings and Utilities / Settings: Policies / V3 URLA Support | 01 - Get Instance level URLA Configuration | GET | /encompass/v3/settings/policies/urla |
| Settings and Utilities / Settings: Roles / Settings: V3 Roles | 01 - Get List of Roles | GET | /encompass/v3/settings/roles?Entities=All&Start=0&Limit=10 |
| Settings and Utilities / Settings: Roles / Settings: V3 Roles | 02 - Get Specific Role Details | GET | /encompass/v3/settings/roles/{{roleId}}?Entities=All |
| Settings and Utilities / Settings: Roles / Settings: V3 Roles | 03 - Get Role Mappings | GET | /encompass/v3/settings/roles/roleMappings |
| Settings and Utilities / Settings: Roles / Settings: V1 Roles | 01 - GET roles list | GET | /encompass/v1/settings/roles |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 01 - Get List Of Users | GET | /encompass/v1/company/users |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 02 - Get a Specific User | GET | /encompass/v1/company/users/{{userId}} |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 03 - Get a User's Licenses | GET | /encompass/v1/company/users/{{userId}}/licenses |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 04 - Get User's Compensation details | GET | /encompass/v1/company/users/{{userId}}/compensation |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 05 - Get List of User's user groups | GET | /encompass/v1/company/users/devadmin/groups |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 06 - Get user's assigned rights | GET | /encompass/v1/company/users/{{userId}}/assignedRights |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 07 - Get user's effective rights | GET | /encompass/v1/company/users/{{userId}}/effectiveRights |
| Settings and Utilities / Settings: Internal Users / Settings: V1 Users | 08 - Get self User profile | GET | /encompass/v1/company/users/me |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 00 - Get User's Eligible Roles | GET | /encompass/v3/users/me/eligibleRoles |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 00a - Get list of Personas | GET | /encompass/v3/settings/personas?personaType={{personaType}} |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 00b - Get List of Organizations | GET | /encompass/v1/organizations?view=summary |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 01 - Retrieve List of Users | GET | /encompass/v3/users?orgId={{orgId}}&isRecursive=true&entities=Summary&filter=userId\|('60103', 'a_10') |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 02 - Retrieve List of Users filtered by UserId | GET | /encompass/v3/users?orgId={{orgId}}&isRecursive=true&entities=Summary&filter=userId='{{userId}}' |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 03 - Create an Encompass user | POST | /encompass/v3/users?orgId={{orgId}}&ignoreMinTermDays=true&view=entity |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 04 - Bulk Move Users | PATCH | /encompass/v3/users?action=move&sourceOrgId={{orgId}}&targetOrgId={{orgId2}} |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 05 - Update a user profile | PATCH | /encompass/v3/users/{{userId}}?view=entity |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 06 - Deactivate-Soft Delete a User Profile | PATCH | /encompass/v3/users/{{userId}}?view=entity |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 07 -  Retrieve Details of a specific user | GET | /encompass/v3/users/{{userId}}?includeOrgHierarchy=true&entities=All |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 08 - Add/Update User Public Profile | PATCH | /encompass/v3/users/{{userId}}/publicProfile?view=entity |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 09 - Retrieve User Public Profile | GET | /encompass/v3/users/aa01/publicProfile?view=Full |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 10 - Retrieve List of Compensation Plans | GET | /encompass/v3/settings/fees/loCompensationPlans |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 11 - Add/Update/Delete User Compensation Plan | PUT | /encompass/v3/users/{{userId}}/compensationPlans?view=entity&ignoreMinTermDays=true |
| Settings and Utilities / Settings: Internal Users / Settings: V3 Users | 12 - DELETE user (CAUTION) | DELETE | /encompass/v3/users/{{userId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 00a Get list of Personas | GET | /encompass/v3/settings/personas?personaType={{personaType}} |
| Settings and Utilities / Settings: SCIM Provisioning | 00b Get List of Organizations | GET | /encompass/v1/organizations?view=summary |
| Settings and Utilities / Settings: SCIM Provisioning | 1 Retrieve List of Users | GET | /scim2/v1/users?schema=urn:ietf:params:scim:schemas:extension:ice:2.0:EncompassInternalUser&count=100&startIndex=0&filter=enc_isRecursive eq true&attributes=personas |
| Settings and Utilities / Settings: SCIM Provisioning | 2 Retrieving Encompass User Group List | GET | /scim2/v1/groups?schema=urn:ietf:params:scim:schemas:extension:ice:2.0:EncompassGroup |
| Settings and Utilities / Settings: SCIM Provisioning | 3 Retrieving Specific Encompass User Group | GET | /scim2/v1/groups/{{groupId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 4a Create an Encompass user with SCIM | POST | /scim2/v1/users |
| Settings and Utilities / Settings: SCIM Provisioning | 4b Create an Encompass SSO User with SCIM | POST | /scim2/v1/users |
| Settings and Utilities / Settings: SCIM Provisioning | 5a Retrieve Details for Specific User by username | GET | /scim2/v1/users?filter=userName eq {{userName}} |
| Settings and Utilities / Settings: SCIM Provisioning | 5b Retrieve Details for Specific User by globalUserId | GET | /scim2/v1/users/{{globalUserId}}?schema=urn:ietf:params:scim:schemas:extension:ice:2.0:EncompassInternalUser |
| Settings and Utilities / Settings: SCIM Provisioning | 6a Add attributes to the user profile | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 6c Replacing Licenses | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 6d Replacing Personas | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 6d Remove attribute from the user profile | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 7 Assigning Encompass Users and Orgs to User Groups | PATCH | /scim2/v1/groups/{{groupId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 8 Removing Encompass Users from User Groups | PATCH | /scim2/v1/groups/{{groupId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 9 Disable user | DELETE | /scim2/v1/users/{{globalUserId}}?schema=urn:ietf:params:scim:schemas:extension:ice:2.0:EncompassInternalUser |
| Settings and Utilities / Settings: SCIM Provisioning | 10 Create a DDA (AIQ) user and link to an existing Encompass User | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 10b Create an Encompass user and patch to DDA (AIQ) user | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Provisioning | 11 Adding Persona | PATCH | /scim2/v1/users/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Account Linking | 1 Retrieve SCIM Linked Accounts | GET | /scim2/v1/accountLinks/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Account Linking | 2 Generate globalUserId for an existing product user | POST | /scim2/v1/accountLinks |
| Settings and Utilities / Settings: SCIM Account Linking | 3 Link existing Encompass user to SCIM globalUserId | PATCH | /scim2/v1/accountLinks/{{globalUserId}} |
| Settings and Utilities / Settings: SCIM Account Linking | 4 Unlink a SCIM user | DELETE | /scim2/v1/accountLinks/{{globalUserId}}?schema=urn:ietf:params:scim:schemas:extension:link:ice:2.0:EncompassInternalUser |
| Settings and Utilities / Settings: Fees Management | 01 - Get Itemization Fee Management | GET | /encompass/v3/settings/fees/itemization |
| Settings and Utilities / Settings: Fees Management | 02 - Get Loan Originator Compensation Plans | GET | /encompass/v3/settings/fees/loCompensationPlans |
| Settings and Utilities / Settings: Fees Management | 03 - Get Area Median Income Limit Settings | GET | /encompass/v3/settings/fees/affordableLending/amiLimits |
| Settings and Utilities / Settings: Fees Management | 04 - Get Median Family Income Limit Settings | GET | /encompass/v3/settings/fees/affordableLending/mfiLimits |
| Settings and Utilities / Tools: Loan Transformer | 01a - Export a Loan to MISMO 3.4 file (DU) | GET | /services/v1/transformer?loanId={{loanId}}&format=ULADDU |
| Settings and Utilities / Tools: Loan Transformer | 01b - Export a Loan to MISMO 3.4 file (LPA) | GET | /services/v1/transformer?loanId={{loanId}}&format=ULADLPA |
| Settings and Utilities / Tools: Loan Transformer | 01c - Export a Loan to MISMO 3.4 file (iLAD) | GET | /services/v1/transformer?loanId={{loanId}}&format=ILAD |
| Settings and Utilities / Tools: Search | 01 - Search for custom form given custom field id | POST | /encwsearch/v1/search?key=form_fields |
| Settings and Utilities / Tools: Search | 02 - Search for field ids given a custom form name | POST | /encwsearch/v1/search?key=form_fields |
| Settings and Utilities / Tools: Search | 03 - Search for all forms given a field id | POST | /encwsearch/v1/search?key=form_fields |
| Settings and Utilities / Settings: HMDA Profile | Get List of HMDA Profiles | GET | /encompass/v3/settings/loan/hmdaProfiles?start=0&limit=100&view=Summary |
| Settings and Utilities / Settings: HMDA Profile | Get HMDA Profile Details | GET | /encompass/v3/settings/loan/hmdaProfiles/{{hmdaProfileId}} |
| Settings and Utilities / Settings: Milestones | 01- Get List of Milestones | GET | /encompass/v3/settings/milestones?includeArchived=True&view=Detail&start=0&limit=100 |
| Settings and Utilities / Settings: Milestones | 02- Get Details on Specific Milestone | GET | /encompass/v3/settings/milestones/{{milestoneId}} |
| Settings and Utilities / Settings: Encompass Compliance Service (ECS ) | 01 - Manage Compliance Settings Report Permissions | POST | /ecs/v1/settings/user |
| Settings and Utilities / Settings: Enhanced Condition | 01 - Get List of Condition Types | GET | /encompass/v3/settings/loan/conditions/types |
| Settings and Utilities / Settings: Enhanced Condition | 02 - Get a specific Condition Type | GET | /encompass/v3/settings/loan/conditions/types/{{typeId}} |
| Settings and Utilities / Settings: Enhanced Condition | 03 - Create Condition Types | PATCH | /encompass/v3/settings/loan/conditions/types?action=add&view=entity |
| Settings and Utilities / Settings: Enhanced Condition | 03 - Update Condition Types | PATCH | /encompass/v3/settings/loan/conditions/types?action=update&view=entity |
| Settings and Utilities / Settings: Enhanced Condition | 03 - Delete Condition Types | PATCH | /encompass/v3/settings/loan/conditions/types?action=delete&templateOption=delete&view=entity |
| Settings and Utilities / Settings: Enhanced Condition | 04 - Get List of Condition Templates | GET | /encompass/v3/settings/loan/conditions/templates |
| Settings and Utilities / Settings: Enhanced Condition | 05 - Get a specific Condition Template | GET | /encompass/v3/settings/loan/conditions/templates/{{templateId}} |
| Settings and Utilities / Settings: Enhanced Condition | 06 - Create Condition Templates | PATCH | /encompass/v3/settings/loan/conditions/templates?action=add&view=entity |
| Settings and Utilities / Settings: Enhanced Condition | 07 - Update Condition Templates | PATCH | /encompass/v3/settings/loan/conditions/templates?action=update&view=entity |
| Settings and Utilities / Settings: Enhanced Condition | 08 - Get List of Condition Sets | GET | /encompass/v3/settings/loan/conditions/sets |
| Settings and Utilities / Settings: Enhanced Condition | 09 - Get a specific Condition Set | GET | /encompass/v3/settings/loan/conditions/sets/{{setId}} |
| Settings and Utilities / Settings: Enhanced Condition | 10 - Automated Condition Evaluator | POST | /encompass/v3/calculators/automatedConditions?loanId={{loanId}} |
| Webhook Custom Auth - Premium | 01 Create Webhook Custom Auth Policy - OAUTH2_CLIENT_CREDENTIAL | POST | /webhook/v1/functions/auth |
| Webhook Custom Auth - Premium | 02 Get Webhook Custom Auth Function | GET | /webhook/v1/functions/auth |
| Webhook Custom Auth - Premium | 03a Update Webhook Custom Auth Function - OAUTH2_CLIENT_CREDENTIAL | PUT | /webhook/v1/functions/auth/{{functionId}} |
| Webhook Custom Auth - Premium | 03b Update Webhook Custom Auth Credentials - OAUTH2_CLIENT_CREDENTIAL | PATCH | /webhook/v1/functions/auth/{{functionId}} |
| Webhook Custom Auth - Premium | 04 Delete Webhook Custom Auth Function | DELETE | /webhook/v1/functions/auth/{{functionId}} |
| Webhook Custom Auth - Premium | 05 Link Custom Auth Function to Webhook Subscription | PATCH | /webhook/v1/subscriptions/{{subscription_id}}/functions/auth/{{functionId}} |
| Webhook Custom Auth - Premium | 06 Remove Custom Auth Function from Webhook Subscription | DELETE | /webhook/v1/subscriptions/{{subscription_id}}/functions/auth/{{functionId}} |
| Webhook Custom Auth - Premium | 07 Get Custom Auth Functions for Webhook Subscription | GET | /webhook/v1/subscriptions/{{subscription_id}}}/functions/auth |
| Webhook Custom Auth - Premium | 08 Test Webhook Custom Auth Parameters | POST | /webhook/v1/functions/auth/{{functionId}}/test |
| Webhook | 01 - GET all Resources | GET | /webhook/v1/resources |
| Webhook | 02 - GET Resource Events | GET | /webhook/v1/resources/{{resourceName}}/events |
| Webhook | 03 - GET Subscription | GET | /webhook/v1/subscriptions/{{subscription_id}} |
| Webhook | 04 - GET all Subscriptions | GET | /webhook/v1/subscriptions |
| Webhook | 05a - Create a Loan Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05b - Create a Transaction Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05c - Create a Correspondent Trade Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05d - Create a Webhook Subscription (Ext Users) | POST | /webhook/v1/subscriptions |
| Webhook | 05e - Create a Webhook Subscription (Ext Orgs) | POST | /webhook/v1/subscriptions |
| Webhook | 05f - Create an InternalUsers Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05g - Create an ExternalUsers Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05h - Create Scheduler (Timer) Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05i - Create userGroup Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05j - Create TaskComment Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05k - Create DocumentDelivery Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 05k - Create enhancedfieldchange Webhook Subscription | POST | /webhook/v1/subscriptions |
| Webhook | 06 - Update a Webhook Subscription | PUT | /webhook/v1/subscriptions/{{subscription_id}} |
| Webhook | 07 - Delete a Webhook subscription | DELETE | /webhook/v1/subscriptions/{{subscription_id}} |
| Webhook | 08 - Get Event history for loan transactions | GET | /webhook/v1/events?startTime=2020-06-29T22:19:35.979Z&endTime=2020-06-30T22:19:35.979Z&eventType=create&status=EventReceived&resourceType=Loan&start=0&limit=100 |
| Workflow Management / Task Configuration | Get All Task Templates | GET | /workflow/v1/templates/task/items |
| Workflow Management / Task Configuration | Get Task-template by ID | GET | /workflow/v1/templates/task/items/{{tasktemplateid}} |
| Workflow Management / Task Configuration | Update Task Template (Patch) by ID | PATCH | /workflow/v1/templates/task/items/{{tasktemplateid}} |
| Workflow Management / Task Configuration | Create standalone Task Template | POST | /workflow/v1/templates/task/items?view=entity |
| Workflow Management / Task Configuration | Delete Task Template by ID | DELETE | /workflow/v1/templates/task/items/{{tasktemplateid}} |
| Workflow Management / Task Configuration | Get Sub-Task Template by ID | GET | /workflow/v1/templates/task/items/{{tasktemplateid}}/subtasks/{{subtasktemplateid}} |
| Workflow Management / Task Configuration | Get All SubTask- Templates within Task Template | GET | /workflow/v1/templates/task/items/{{tasktemplateid}}/subtasks |
| Workflow Management / Task Configuration | Create Sub-Task Template within Task Template | POST | /workflow/v1/templates/task/items/{{tasktemplateid}}/subtasks?view=entity |
| Workflow Management / Task Configuration | Update Sub-Task Template (Patch) by ID | PATCH | /workflow/v1/templates/task/items/{{tasktemplateid}}/subtasks/{{subtasktemplateid}} |
| Workflow Management / Task Configuration | Delete SubTask- Template By ID | DELETE | /workflow/v1/templates/task/items/{{tasktemplateid}}/subtasks/{{subtasktemplateid}} |
| Workflow Management / Task Configuration | Get Global Task Settings | GET | /workflow/v1/settings/task |
| Workflow Management / Task Configuration | Update Global Task Settings  (Put) | PUT | /workflow/v1/settings/task |
| Workflow Management / Task Instance Management | Assign all Tasks within a Loan | PATCH | /workflow/v1/tasks?action=assignTo&loanId={{loanId}}&associatedEntityId=1&associatedEntityType=urn:elli:encompass:role&relationship=Assignee |
| Workflow Management / Task Instance Management | Get All Tasks in a Loan | GET | /workflow/v1/tasks?loanId={{loanId}}&completedDate=05-10-2025 |
| Workflow Management / Task Instance Management | Get All Task Templates in a Loan | GET | /workflow/v1/templates/task/items?loanId={{loanId}}&metaData=True |
| Workflow Management / Task Instance Management | Get Task by ID | GET | /workflow/v1/tasks/{{taskId}}?loanId={{loanId}}&metaData=true |
| Workflow Management / Task Instance Management | Create standalone Task | POST | /workflow/v1/tasks?view=entity&loanId={{loanId}} |
| Workflow Management / Task Instance Management | Update Task (Patch) by ID | PATCH | /workflow/v1/tasks/{{taskId}}?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Bulk Update | PATCH | /workflow/v1/tasks/bulk?action=update |
| Workflow Management / Task Instance Management | Add Task Comment by ID | POST | /workflow/v1/tasks/{{taskId}}/comments?view=entity&loanId={{loanId}} |
| Workflow Management / Task Instance Management | Get all comments for a Task by Task ID | GET | /workflow/v1/tasks/{{taskId}}/comments?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Create Sub-Task within a Task | POST | /workflow/v1/tasks/{{taskId}}/subtasks?loanId={{loanId}}&view=entity |
| Workflow Management / Task Instance Management | Create Sub-Task witin a Task from Template | POST | /workflow/v1/tasks/{{taskId}}/subtasks?templateid={{subtasktemplateid}}&loanId={{loanId}}&view=entity |
| Workflow Management / Task Instance Management | Get Sub-Task by ID | GET | /workflow/v1/tasks/{{taskId}}/subtasks/{{subtaskId}}?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Get All Sub-Tasks within a Task | GET | /workflow/v1/tasks/{{taskId}}/subtasks/{{subtaskId}}?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Get All SubTask- Templates within Task Template in a Loan | GET | /workflow/v1/templates/task/items/{{tasktemplateid}}/subtasks?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Update Sub-Task (Patch) by ID | PATCH | /workflow/v1/tasks/{{taskId}}/subtasks/{{subtaskId}}?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Add Sub-Task Comment by ID | POST | /workflow/v1/tasks/{{taskId}}/subtasks/{{subtaskId}}/comments?view=entity&loanId={{loanId}} |
| Workflow Management / Task Instance Management | Get all comments for a Sub-Task by Sub-Task ID | GET | /workflow/v1/tasks/{{taskId}}/subtasks/{{subtaskId}}/comments |
| Workflow Management / Task Instance Management | Delete Sub-Task by ID | DELETE | /workflow/v1/tasks/{{taskId}}/subtasks/{{subtaskId}}?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Delete Task by ID | DELETE | /workflow/v1/tasks/{{taskId}}?loanId={{loanId}} |
| Workflow Management / Task Instance Management | Query Task Pipeline & Filter By Priority | GET | /workflow/v1/taskPipeline?view=NormalView&size=1000&priority=1 |
