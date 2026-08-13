-- A DISPLAY COPY OF EACH INSPECTION PHOTO, BESIDE THE ORIGINAL (owner-directed 2026-08-13:
-- "the report itself should be able to handle more pictures", and the standing rule that the
-- full-quality copy stays in PILOT).
--
-- THE PROBLEM. draw_media stores what the inspector's camera produced, at full size (up to the
-- 30 MB per-file archive cap) — and jsPDF embeds JPEG bytes VERBATIM, so a ~3.5 MB phone photo
-- costs 3.5 MB of report. src/sitewire/draw-report.js stops embedding at EMBED_BYTE_BUDGET
-- (60 MB), which is about FIFTEEN such photos; a real inspection carries ~100 (99 on the
-- 105-107 N 10th St draw #2). So roughly eighty-five photos per draw never reached the report.
--
-- THE FIX IS A SECOND, SMALLER RENDERING — never a replacement. `storage_ref` keeps the original
-- bytes untouched and every existing reader is unaffected; `display_ref` is an ADDITIONAL blob
-- sized to what a report page can actually show (see src/lib/image-fit.js for why that loses
-- nothing visible). The reports prefer `display_ref` and fall back to `storage_ref`, so a photo
-- with no display copy yet still appears exactly as it does today.
--
-- WHY THE COLUMNS ARE ALL NULLABLE AND NOTHING IS BACK-FILLED HERE: building a display copy means
-- decoding the JPEG in pure JavaScript (~3 seconds per photo, blocking the event loop), so it is
-- done by the PACED background pass in media-archive.js, exactly like the HEIC conversion sweep.
-- A migration cannot do that work. NULL simply means "not built yet", never "does not apply".

ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS display_ref        text;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS display_bytes      integer;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS display_width      integer;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS display_height     integer;
-- Stamped whatever the outcome — including "this one cannot be shrunk" — so the backfill drains
-- instead of re-decoding the same unshrinkable photo on every boot forever. It is deliberately
-- NOT stamped when the READ itself failed, so one storage outage never drops a real photo out of
-- the sweep (the same rule as the research XML sweep).
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS display_checked_at timestamptz;
-- Why no display copy was made, when there is none: 'not_jpeg' | 'already_small' | 'no_saving' |
-- 'source_too_large' | 'undecodable' | 'encode_failed' | 'resize_failed' | 'error'. Kept so the
-- reason a photo is still embedded at full size is answerable without re-running anything.
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS display_skip_reason text;

-- The backfill walks id-ascending over rows never looked at. Partial so the index stays tiny and
-- disappears in effect once the sweep has drained.
CREATE INDEX IF NOT EXISTS draw_media_display_pending_idx
  ON draw_media (id)
  WHERE display_checked_at IS NULL;
