-- 359 — A purchase advice is NEVER borrower-visible. Previous files too.
--
-- The purchase advice names the note buyer and the price the loan sold for. The
-- standing rule is that a capital-partner name never reaches a borrower-facing
-- surface — so the document must be staff-only, always.
--
-- Going forward the designation route forces it (see the purchasing/advice
-- handler). This is the PREVIOUS-files half. It is needed because the upload
-- endpoint derives visibility from the CONDITION a document was filed against —
-- `staff_only` only when that condition's audience is exactly 'staff' — and the
-- purchasing screen has no upload slot of its own, so an advice filed against any
-- ordinary borrower-facing condition was stored visibility='borrower'. Both
-- borrower doors (the documents list and the mentionables list) admit exactly
-- that, and the download hands back the bytes unscrubbed.
--
-- Scoped as tightly as the fact allows: ONLY a document a purchasing_advice row
-- actually points at. A document that merely carries doc_kind='purchase_advice'
-- but was never designated is deliberately left alone — this migration re-runs on
-- every boot and must not quietly reclassify documents nobody chose.
--
-- Idempotent: the WHERE clause matches nothing on a second pass.

UPDATE documents d
   SET visibility = 'staff_only'
  FROM purchasing_advice a
 WHERE a.document_id = d.id
   AND d.visibility IS DISTINCT FROM 'staff_only';
