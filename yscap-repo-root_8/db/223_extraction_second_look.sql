-- Record when a document read was recovered by the BACKUP / second-look OCR (#537, engine.js).
-- Lets the findings-corpus self-audit (Item 13) report per document type: how often the first
-- read failed, and how often the vision second-look rescued it — so we can see the backup-OCR
-- earning its keep and which document types still can't be read. Idempotent; default false, so
-- every existing extraction reads as "no second look" (correct — they predate the feature).
ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS second_look boolean NOT NULL DEFAULT false;
