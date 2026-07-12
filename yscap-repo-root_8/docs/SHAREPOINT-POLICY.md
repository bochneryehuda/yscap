# SharePoint Data Policy — Append-Only, No Automated Deletion

_Owner-directed, 2026-07-12. This is a binding operating policy for YS Capital Group's
document platform. It governs the portal codebase, any background job or sync worker,
and any AI assistant (including Claude Code) that is ever given SharePoint access._

## The rule

**SharePoint is append-only. Nothing in this system — and no AI assistant operating on
it — may ever delete, recycle, move, rename, or overwrite anything in SharePoint.**

That includes:

- Deleting a file, folder, or a prior file **version**.
- Sending anything to the **recycle bin**.
- **Moving** or **renaming** a file or folder.
- **Overwriting / replacing** the bytes of an existing file (a new version of a document
  is written to a **new** path, never by clobbering the existing one).
- "Cleanup," "dedupe," "reorganize," or "correct" operations that would remove or relocate
  existing content — regardless of how safe they look.

This holds **even when the automation (or an AI) believes it knows exactly what it is doing.**
Confidence is not an exception. There are no exceptions in code.

## Who may delete

Only a **human**, acting **manually** in the SharePoint / OneDrive web UI, may delete, move,
or rename content. The portal, its sync workers, its APIs, and any AI assistant are **read +
create/upload only**. If something genuinely needs to be removed or reorganized, a person does
it by hand — the software never does.

## How this is enforced (defense in depth)

1. **Code.** The SharePoint storage provider's `remove()` is a hard no-op that throws; the
   integration issues **no** Graph `DELETE`, no move/rename `PATCH`, and never PUTs over an
   existing item. New document versions are written to **new** paths.
2. **Least privilege.** The integration requests the narrowest Microsoft Graph permission that
   still functions (prefer `Sites.Selected` scoped to the specific site), and never
   `Sites.Manage.All` / `Sites.FullControl.All`.
3. **Policy over permission.** Microsoft Graph's site *write* role technically still allows
   delete; therefore the no-delete guarantee is enforced by **code and this policy**, not by the
   permission scope alone. Every Graph call path is audited for delete/move/rename before it ships.
4. **Review gate.** Any change that touches the SharePoint integration goes through the repo's
   standard audit-agent gate (see `CLAUDE.md`), which specifically checks that no destructive
   Graph operation was introduced.

## Scope

Applies to both document homes:

- The team site — `yscapgroup.sharepoint.com/sites/SharedData` (the `Pipeline Drive` system of
  record), and
- The personal OneDrive — `yscapgroup-my.sharepoint.com/personal/yehuda_yscapgroup_com`.
