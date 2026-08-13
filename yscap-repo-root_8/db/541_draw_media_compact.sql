-- THE COPY THAT GOES OUT BY EMAIL (owner-directed 2026-08-13: "while you click Deliver to
-- Investor it should take all the photos and redraw a new report on a much more compressed version
-- that should definitely fit in all the email versions").
--
-- db/540 gave each photo a page-sized DISPLAY copy so every photo reaches the report. That report
-- is ~25 MB for a 100-photo draw — right for the copy we keep, still too big to email (Gmail
-- refuses over 25 MB received, and email encoding inflates a file by about a third on the way).
-- This adds a THIRD rendition, ~700px / ~50 KB a photo, so the same 100-photo report is ~5 MB and
-- clears every mailbox limit with room to spare.
--
-- THREE RENDITIONS, ONE SOURCE, AND THE SOURCE IS NEVER TOUCHED: `storage_ref` is still the
-- inspector's own bytes, `display_ref` is what the report we keep embeds, `compact_ref` is what the
-- delivery email carries. The compact copy is deliberately NOT a `documents` row — it is built into
-- the email at send time and never filed, because a stored second report would compute the same
-- version-hashed filename as the full one, be handed back in its place, and (once told apart)
-- supersede it — dropping the full-quality report off every screen that reads `is_current` and
-- shelving it in SharePoint. See src/sitewire/draw-report.js.
--
-- BOTH RENDITIONS ARE BUILT FROM ONE DECODE by the same paced worker, so the extra size costs
-- almost nothing: the decode is ~3 seconds and each extra resample+encode is ~0.2.

ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS compact_ref         text;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS compact_bytes       integer;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS compact_width       integer;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS compact_height      integer;
-- Why there is no compact copy, when there is none ('already_small' | 'no_saving' | 'not_jpeg' | …).
-- Set on EVERY outcome, which is what makes the reset below self-terminating.
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS compact_skip_reason text;

-- ONE STAMP GOVERNS BOTH RENDITIONS (`display_checked_at`), because they are built together. db/540
-- and db/541 ship in the same change, so in production no row can exist that was stamped by the
-- display-only worker — but a database that already ran db/540 alone (a developer's, or a test
-- database mid-upgrade) would hold rows stamped done with no compact copy, and those photos would
-- silently never gain one.
--
-- THIS RESET IS SELF-TERMINATING, WHICH IS THE ONLY REASON IT IS SAFE TO RE-RUN ON EVERY BOOT: the
-- worker always writes EITHER compact_ref OR compact_skip_reason, so a row it has processed can
-- never match this WHERE again. Without the compact_skip_reason test, a photo whose compact
-- rendition legitimately came back "no saving" would be un-stamped on every single boot and
-- re-decoded forever — a permanent CPU burn that would look like the worker never finishing.
UPDATE draw_media
   SET display_checked_at = NULL
 WHERE display_checked_at IS NOT NULL
   AND compact_ref IS NULL
   AND compact_skip_reason IS NULL
   AND kind = 'image'
   AND storage_ref IS NOT NULL;
