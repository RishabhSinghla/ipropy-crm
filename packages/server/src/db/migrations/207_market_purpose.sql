-- Sale or rent. A deal is four things, not two: a dealer has a property to
-- sell or to let, and a dealer's client wants to buy or to rent. "have/want"
-- (kind) was only half of that, and an Associate's page needs all four lists.
--
-- NULL until the post has been read again; `READ_VERSION` in enrich.ts moves to
-- 2 with this, so the background reader fills it in for everything already held.
ALTER TABLE ipy_market_post
  ADD COLUMN IF NOT EXISTS purpose TEXT CHECK (purpose IN ('sale', 'rent'));
CREATE INDEX IF NOT EXISTS idx_market_post_poster ON ipy_market_post (poster_phone) WHERE poster_phone IS NOT NULL;
