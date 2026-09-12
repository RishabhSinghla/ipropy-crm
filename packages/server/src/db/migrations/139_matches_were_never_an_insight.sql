-- "10 matching properties found" is not an insight, and it is gone.
--
-- The matching engine wrote its own results into `ipy_ai_insight`, so the AI
-- Insights panel on a record showed a numbered list of matches — beside a
-- Matching tab listing the same records with filters, a saved state, an eye on
-- each row and a way to send a set of them to a customer.
--
-- Two places showing the same answer is how somebody comes to trust the wrong
-- one, and this was the lesser: four rows, no filtering, no acting on them, and
-- stale the moment anything was repriced, because it was only rewritten when
-- somebody re-ran matching.
--
-- `ai/matching.ts` no longer persists them. This removes the ones already
-- written; there is nothing to migrate them to, because the Matching tab
-- recomputes from live data every time it is opened.

DELETE FROM ipy_ai_insight WHERE kind = 'property_match';
