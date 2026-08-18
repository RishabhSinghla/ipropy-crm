-- Which properties the public website shows.
--
-- `PUBLIC_PROPERTY_STATUS = 'Available'` was one string in public.ts used by
-- four queries, and it is the most customer-visible literal in the codebase:
-- it decides what every visitor to the website sees. Eight statuses exist —
-- Sold, Held, Blocked, Booked, Agreement Done, Registered, Not For Sale,
-- Available — and which of them belong on a public site is a decision about
-- how you want to sell, not a fact about the software. Plenty of builders show
-- Booked units deliberately, because a half-sold tower sells the other half.
--
-- A list rather than one value, because the honest answer is often two.
INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('website.public_statuses', '["Available"]', 'website',
   'Property statuses shown on the website',
   'Only properties in these statuses appear on your public site and in share links. Separate several with commas. Must match your Property Status dropdown exactly.')
ON CONFLICT (key) DO NOTHING;
