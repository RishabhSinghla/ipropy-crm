-- A search by meaning compared the question against all ~117,000 stored vectors
-- every time: 4.6 seconds on production, 13 October 2026. An HNSW index finds the
-- nearest few hundred without reading the rest.
--
-- It indexes the 1,024-number embeddings only (the model in use). The column has
-- no fixed width, so the index is on the column cast to one, and the search has to
-- ask in exactly that shape (core/search/semantic.ts). pgvector cannot index more
-- than 2,000 numbers, so the 2,048-number ones stay unindexed and keep working.
--
-- Building it reads every vector, which takes minutes on a full table. A deploy
-- must not wait that long to start, so a table that is already big skips it here
-- and the index is built beside the running site (CREATE INDEX CONCURRENTLY).
-- On an empty database, or a test one, it is instant.
DO $$
BEGIN
  IF (SELECT count(*) FROM ipy_embedding) < 5000 THEN
    CREATE INDEX IF NOT EXISTS idx_embedding_nearest_1024
      ON ipy_embedding USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
      WHERE dims = 1024;
  ELSE
    RAISE NOTICE 'ipy_embedding is large; build idx_embedding_nearest_1024 with CREATE INDEX CONCURRENTLY';
  END IF;
END $$;
