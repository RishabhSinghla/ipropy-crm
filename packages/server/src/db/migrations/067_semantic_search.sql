-- Ask iPropy stops being limited to what a filter can express.
--
-- Until now the assistant could answer two kinds of question: one that reduces
-- to a filter ("leads in Sector 21 over a crore"), and one the daily digest
-- already computes ("what should I do today"). Anything else — "which buyer
-- mentioned they needed possession before Diwali", "what did we say to the
-- Sharma family about the parking", "any property with a north-facing terrace"
-- — lives in notes, WhatsApp threads, call transcripts and free-text fields,
-- and none of that is reachable by a WHERE clause.
--
-- So the text gets embedded and searched by meaning. pgvector rather than a
-- hand-rolled cosine over an array: production is Neon, which ships pgvector
-- 0.8.6, and the local and CI images moved to pgvector/pgvector:pg18 in the
-- same commit so all three agree.
--
-- The dimension is a column rather than a constraint on the type. Which model
-- does the embedding is an admin setting, models disagree about how many
-- numbers a vector has, and pinning it here would mean a migration every time
-- somebody switched. Rows carry their model and dimension; a query only ever
-- compares against rows that match both, so changing model degrades to "search
-- is thin until the worker catches up" rather than to nonsense.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ipy_embedding (
  id            BIGSERIAL PRIMARY KEY,
  -- What this row is: a record's own fields, a note, a message, a call. Kept
  -- so the assistant can say "from a WhatsApp on 12 August" rather than
  -- quoting a sentence from nowhere.
  kind          TEXT NOT NULL,
  -- The id of the thing itself, as text because these come from tables with
  -- different key types.
  source_id     TEXT NOT NULL,
  -- The CRM record it belongs to. This is what permissions are applied to:
  -- a note is exactly as visible as the lead it is attached to.
  record_id     UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  module_name   TEXT,
  -- The text that was embedded. Used for reranking and for nothing the user
  -- sees: the answer is built from the record read back under the caller's own
  -- scope, so a field they may not read cannot reach them through here.
  content       TEXT NOT NULL,
  embedding     vector NOT NULL,
  dims          INT NOT NULL,
  model         TEXT NOT NULL,
  -- Unchanged text is not re-embedded. Free models are still rate limited, and
  -- a scheduler that re-embeds the whole CRM every minute is a way to lose a
  -- free tier by lunchtime.
  content_hash  TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_embedding_record ON ipy_embedding(record_id);
CREATE INDEX IF NOT EXISTS idx_embedding_model ON ipy_embedding(model, dims);

COMMENT ON TABLE ipy_embedding IS
  'Meaning-searchable text from across the CRM. Written by the embedding worker; read by Ask iPropy and global search.';

-- Deliberately no ANN index yet.
--
-- pgvector's ivfflat and hnsw both need a fixed dimension on the column, which
-- is the one thing this table refuses to pin. An exact scan over a few thousand
-- rows is single-digit milliseconds; the day this holds a hundred thousand, the
-- model will have settled and the index becomes a three-line migration.
