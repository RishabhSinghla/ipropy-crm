-- Match part of a house/mobile number, retaining the metadata-controlled corpus.
CREATE INDEX IF NOT EXISTS idx_record_search_text_trgm
  ON ipy_record USING GIN (search_text gin_trgm_ops)
  WHERE is_deleted = false;
