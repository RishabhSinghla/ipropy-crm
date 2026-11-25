-- Dealer Groups (the WhatsApp-group feed, its Jev reading and the call sheet) were removed
-- (owner's instruction, 25 November 2026). Only the Jev settings card goes; the ipy_market_* tables and
-- every dealer's Associates record stay in the database.
DELETE FROM ipy_integration WHERE provider = 'typesafe_jev';
