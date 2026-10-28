-- A live group whose name has a slash was filed apart from the chat export of the same group (a file name cannot
-- hold a slash, so the export is "G_F ..."). Point live groups at the spelling the feed already has. Posts already
-- stored under the slash spelling keep their label; only where new messages go changes.
UPDATE ipy_wa_group g SET feed_name = m.name
  FROM ipy_market_group m
 WHERE m.name = replace(g.name, '/', '_') AND m.name <> g.name AND g.feed_name = g.name
   AND NOT EXISTS (SELECT 1 FROM ipy_wa_group o WHERE o.id <> g.id AND (o.name = m.name OR o.feed_name = m.name));
