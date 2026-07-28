-- 360 — A purchase advice is NEVER borrower-visible. Previous files too.
--
-- The purchase advice names the note buyer and the price the loan sold for. The
-- standing rule is that a capital-partner name never reaches a borrower-facing
-- surface — so the document must be staff-only, always.
--
-- Going forward the designation route forces it (see the purchasing/advice
-- handler). This is the PREVIOUS-files half. It is needed because the upload
-- endpoint derives visibility from the CONDITION a document was filed against —
-- `staff_only` only when that condition's audience is exactly 'staff' — and the
-- purchasing screen had no upload slot of its own, so an advice filed against any
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

-- Only rows this has NEVER handled: `document_prior_visibility` (db/359) is
-- stamped the moment the designation code forces a document, so its presence
-- means the new code owns this row. Without that guard this migration re-runs on
-- EVERY boot and would silently re-force a document an admin had deliberately
-- restored — making the documented undo impossible to keep.
--
-- Also scoped to documents that are BORROWER-visible: a document marked
-- 'internal' is MORE restricted than staff_only (tpr-export treats it as never
-- shippable to a buyer), so forcing it down to staff_only would be a widening.
UPDATE documents d
   SET visibility = 'staff_only'
  FROM purchasing_advice a
 WHERE a.document_id = d.id
   AND a.document_prior_visibility IS NULL
   AND COALESCE(d.visibility, 'borrower') = 'borrower';
