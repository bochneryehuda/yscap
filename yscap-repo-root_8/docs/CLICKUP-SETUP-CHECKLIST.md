# ClickUp setup checklist — everything the owner does in the UI

The only things the ClickUp API can't do for us. Do these in the **Loan Pipeline** space
(id `90113223301`) unless noted. When done, tell me and I re-pull the new IDs and finalize
the mapping. **Nothing here is a blocker for the code build.**

---

## A. Custom fields to CREATE  *(Space-level, so every officer's list inherits them)*

**How to create a Space-wide field:** open any List in Loan Pipeline → switch to the **List/Table view** → click the **`+`** at the far right of the column headers → **`+ New field`** → pick the type + name → when it asks the scope, choose **the whole Space (“Loan Pipeline”)**, not “this List only”. (Or: sidebar → hover **Loan Pipeline** → `•••` → **Custom Fields** → **Create field**.)

| # | Field name | Type | Options to enter | Priority |
|---|---|---|---|---|
| 1 | **Send to Portal** | Checkbox | — | ⭐ required |
| 2 | **RTL As-Is Value** | Money / Currency (USD) | — | ⭐ required |
| 3 | **Rehab Type** | Dropdown | `Cosmetic`, `Moderate`, `Heavy`, `Adding SF`, `Ground-up` | recommended |
| 4 | Portal File ID | Text | — | optional* |
| 5 | Portal File Link | URL | — | optional* |
| 6 | Borrower Portal Status | Dropdown | `new`, `in_review`, `processing`, `underwriting`, `approved`, `clear_to_close`, `funded`, `on_hold`, `declined`, `withdrawn` | optional* |
| 7 | Sync Status / Last Error | Text | — | optional* |

\* Optional = if you skip it, that info just lives in the portal instead of showing on the ClickUp task. Create these later if you want staff to see them inside ClickUp.

**Minimum to unblock the core sync: #1 and #2.**

---

## B. Dropdown OPTIONS to add to EXISTING fields

**How:** open the field (click it on any task, or Space → Custom Fields → the field) → **`+ Add option`** → type the name → save.

| Field | Option(s) to add |
|---|---|
| **`*Program`** (`50eb857a`) | **Ground-Up** |
| **`*Property Type`** (`541524d9`) | **Condo** and **Townhouse** |

*(These fill the last 3 rows of the field map: Ground-Up program files, and Condo/Townhouse property types.)*

---

## C. ClickApp to ENABLE — “Tasks in Multiple Lists”

Needed so that when a **processor** is assigned, we can *add* the file to the processor's
folder **without moving it** out of the loan officer's folder.

**Steps:** Workspace avatar (top-left) → **Settings** → **ClickApps** → find **“Tasks in Multiple Lists”** → toggle **ON**.

---

## D. Finish the 2 new CRM folders (Chaim Lebowitz & Mendel Bochner)

I already created the folders + a `List` in each (fields inherit automatically):
- **Chaim Lebowitz CRM** — folder `90118114571`, list `901114073281`
- **Mendel Bochner CRM** — folder `90118114572`, list `901114073282`

They just need the same **saved view + automations** the other officers' CRM lists have — which the API can't copy. Two options:

- **Option A (recommended — copies everything):** in the CRM & SALES space sidebar, right-click an existing officer's folder (e.g. **“Yehuda Bochner CRM”**) → **Duplicate** → in the dialog include **views + automations** → rename the copy to **“Chaim Lebowitz CRM”**. Then **delete my empty “Chaim Lebowitz CRM”** folder. Repeat for **Mendel Bochner**.
- **Option B:** keep the folders I made and manually recreate the CRM view + any automations on their `List`.

---

## E. Statuses / tags — ✅ NOTHING to add

Your internal statuses **mirror ClickUp's existing 38-status workflow as-is**, and the new
`on_hold` borrower-facing status lives on the **portal** side. So there are **no new ClickUp
statuses, tags, or relationships to create.**

---

## F. When you're done

Just tell me — I'll re-pull the workspace and capture the new field IDs and the new option
UUIDs (Ground-Up / Condo / Townhouse), then finalize the mapping. You don't need to copy any
IDs by hand.

---

## G. Things I handle automatically (no action from you)

- Registering the ClickUp **webhook** (our server does it via the token once the portal is deployed with the webhook route).
- Backfilling every officer/processor/underwriter's **ClickUp user id** (matched by email).
- All field **values**, task create/update, status sync, officer-move / processor-add-to-list, conditions, the activity log.

---

## H. Deployment config (env vars — you or me, at go-live)

Set on the portal service (Render): `CLICKUP_API_TOKEN` (your key), `CLICKUP_TEAM_ID` = `9011888435`,
`CLICKUP_WEBHOOK_SECRET` (from webhook creation), `CLICKUP_SYNC_ENABLED` (master on/off), `CLICKUP_POLL_SEC`.

---

## I. One decision still open (not a ClickUp task)

- **CVV retention (PCI):** do we persist the appraisal-card security code long-term (encrypted), or
  parse it through and drop it after use? Your call.
