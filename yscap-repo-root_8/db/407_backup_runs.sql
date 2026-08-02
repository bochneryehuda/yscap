-- Off-site backup bookkeeping (owner-directed 2026-08-02: "if the database restarts we lose all
-- our data — we need a real backup we can restore from").
--
-- The backup itself lives OUTSIDE this database, in an object-storage vault, which is the whole
-- point: a backup stored in the thing it is backing up is not a backup. What lives HERE is the
-- LEDGER — what ran, when, how big it was, whether it was verified by a real test restore — so the
-- health page and the morning alert can answer "are we actually protected right now?" without
-- anyone opening a bucket.
--
-- Losing this table loses no backups. It is rebuilt from the vault's own manifests by
-- `node scripts/backup-restore.js --list`.

CREATE TABLE IF NOT EXISTS backup_runs (
  id             BIGSERIAL PRIMARY KEY,
  backup_id      TEXT,                       -- the id in the object key; NULL for a run that died before naming one
  kind           TEXT NOT NULL,              -- 'database' | 'documents' | 'verify'
  status         TEXT NOT NULL,              -- 'success' | 'warning' | 'failed'
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  duration_ms    INTEGER,
  tables_count   INTEGER,
  rows_count     BIGINT,
  plain_bytes    BIGINT,
  cipher_bytes   BIGINT,
  vaults         JSONB,                      -- [{label,bucket,key,objectLock}]
  detail         JSONB,                      -- the manifest, the verify report, or the prune plan
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "When did the last database backup succeed?" is the only question this table is asked in an
-- emergency, so it is the query that gets the index.
CREATE INDEX IF NOT EXISTS backup_runs_kind_started_idx ON backup_runs (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS backup_runs_status_idx       ON backup_runs (status, started_at DESC);

-- Incremental state for the DOCUMENT vault copy. The loan documents (PDFs, appraisals, bank
-- statements) live in object storage and are referenced by rows in `documents`; a database restored
-- without them is a filing cabinet of empty folders. Copying every object every night would be
-- pointless and expensive, so we remember what has already been copied — an object whose size and
-- ETag are unchanged is skipped.
--
-- PRIMARY KEY is (vault_label, object_key): the same document copied to two vaults is two facts.
CREATE TABLE IF NOT EXISTS backup_document_state (
  vault_label    TEXT NOT NULL,
  object_key     TEXT NOT NULL,
  source_etag    TEXT,
  source_bytes   BIGINT,
  copied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_label, object_key)
);

CREATE INDEX IF NOT EXISTS backup_document_state_copied_idx ON backup_document_state (copied_at DESC);
