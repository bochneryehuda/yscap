# SharePoint Data Policy — One-Way Sync, No Automated Deletion

_Owner-directed 2026-07-12; design finalized by the owner 2026-07-13. This is a binding
operating policy for YS Capital Group's document platform. It governs the portal codebase,
any background job or sync worker, and any AI assistant that is ever given SharePoint access._

## What the sync does

Every document saved on the portal server is automatically mirrored — one-way — into the
team site at:

```
Pipeline Drive / <Loan Officer> / <Borrower> / <Property Address> / YS portal syncing / <Condition> /
```

- Existing officer/borrower/address folders are **reused** via conservative fuzzy matching
  (middle-name-tolerant borrower names; "St"≡"Street"-style address normalization anchored on
  an identical house number). When no confident match exists, a **new** folder is **created**,
  named **`<name>, YS portal sync`** so anyone browsing can tell automation-created folders
  from human-created ones — the sync never guesses into someone else's folder and never
  renames anything to "fix" it (matched folders keep their human names).
- All portal-written files live **only inside `YS portal syncing` folders**. The sync never
  writes a file anywhere else in the tree (creating missing folders up the chain is allowed).
- When a document is replaced in the portal (a new version supersedes the old), the condition's
  folder is versioned: on the first replacement the old portal-written copies move into a
  **`Version 1`** folder and the new document lands in **`Version 2`**; later replacements add
  `Version 3`, `Version 4`, … — the full version history stays visible forever.

## The hard rules

1. **Nothing in this system may ever DELETE or recycle anything in SharePoint** — with ONE
   owner-sanctioned exception (amendment, owner-directed 2026-07-16). Not a file, not a folder,
   not a version — anywhere, for any reason, including "cleanup," "dedupe," or "correcting a
   mistake." The storage provider's `remove()` permanently throws. Only a **human**, acting
   manually in the SharePoint UI, may delete. Confidence is not an exception.

   **The single sanctioned exception — replacing a corrupted mirror copy.** When the integrity
   audit has DIAGNOSED a mirror copy as corrupt (size/hash mismatch against the portal's bytes)
   and the sync has uploaded a **verified good "(fixed copy)" replacement**, the corrupt
   original — and ONLY it — may be deleted, so staff never open the bad file by mistake. This
   lives in exactly one function (`sharepoint.deleteReplacedCorruptMirror`) behind seven
   mandatory guards, none of which may ever be relaxed or reused for any other purpose:
   G1 kill switch (`SHAREPOINT_DELETE_REPLACED_CORRUPT=0` disables); G2 DB ownership (only the
   item recorded as the document's own mirror ref); G3 replacement-first (the fixed copy is
   re-read live and must size-match the portal bytes — no verified replacement, no delete);
   G4 same-bytes-as-diagnosed (the item's current size must equal the size recorded at
   diagnosis — a human fixing the file in the meantime makes it undeletable); G5 expected
   parent (the item must still sit in the exact portal-created folder our records say);
   G6 Pilot-tree ancestry (an ancestor folder must be a `Synced by Pilot` / `YS portal
   syncing` leaf — the delete can never reach outside a Pilot-created sync tree); G7 If-Match
   eTag pinning (any concurrent human change → Graph answers 412 → nothing happens). Every
   delete (and every refusal) is audited. `remove()` still throws for everything else, and no
   other Graph `DELETE` may exist in the codebase.
2. **Nothing may overwrite or replace an existing file.** Uploads fail on name conflict and
   retry under a uniquified name.
3. **Moves and renames are forbidden, with one owner-approved exception:** the sync may move
   **its own previously-uploaded mirror copies** — verified against the portal database AND an
   expected-parent check — between folders **it created inside a `YS portal syncing` folder**
   (the Version-N shuffle described above). Files created or moved by a person are never
   touched: if a human has moved a portal-written file, the expected-parent check makes it
   unmovable by the sync from then on.
4. **One-way flow.** Documents go portal → SharePoint only. The sync reads folder *names* to
   match existing folders; it never reads document *content* out of SharePoint into the portal.
5. **Anything uncertain gets a new folder, not a guess** — and the resolution decision is
   recorded (`sharepoint_folder_cache.details`) for manual review.

## How this is enforced (defense in depth)

- **Code:** create-only uploads (`conflictBehavior: 'fail'`), a throwing `remove()`, and a
  guarded `moveOwnItem()` that refuses any item whose current parent isn't the exact
  portal-created folder our records say it's in.
- **Policy over permission:** the Azure app currently holds `Sites.ReadWrite.All`
  (owner-approved), which technically permits deletion — therefore the no-delete guarantee is
  enforced by code and this policy, and every change touching a Graph call path is audited for
  delete/move/rename before it ships (see the audit gate in `CLAUDE.md`).
- **Never break an upload:** the mirror runs out-of-band; a SharePoint failure records an error
  on the document row and retries later — borrower/staff uploads never wait on SharePoint.

## Scope

The team site `yscapgroup.sharepoint.com/sites/SharedData` (`Documents` library, `Pipeline
Drive` tree) — the firm's document system of record — and any other SharePoint/OneDrive
location this platform is ever pointed at.
