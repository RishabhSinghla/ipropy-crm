-- "Busy": the person rang and the line was busy, so the pairing stays on the call sheet for a retry later.
-- Additive: it only widens the list of answers a pairing may carry. To undo, move any 'busy' rows back to 'new'
-- and re-add the earlier CHECK from migration 208 (UPDATE ipy_market_deal SET status = 'new' WHERE status = 'busy').
ALTER TABLE ipy_market_deal DROP CONSTRAINT IF EXISTS ipy_market_deal_status_check;
ALTER TABLE ipy_market_deal ADD CONSTRAINT ipy_market_deal_status_check
  CHECK (status IN ('new', 'called', 'busy', 'meeting', 'won', 'lost', 'dismissed', 'bad_match'));
