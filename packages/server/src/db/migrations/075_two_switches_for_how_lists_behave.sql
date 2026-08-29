-- Two things about lists that were decided in code and should not have been.
--
-- **Editing straight from the list is now off by default.** Clicking a phone
-- number on the leads list turned it into an edit box, which is a lovely feature
-- when you meant it and a data-loss risk when you did not. The owner hit it by
-- accident on a real record and asked for it gone everywhere: "chances of
-- accidentally updating something is very much". He is right that the risk is
-- asymmetric — a mistyped mobile on a live lead costs a customer, and the saving
-- is one click.
--
-- Off rather than deleted, because the feature is good and somebody else running
-- this CRM may want it. One switch, and it applies to the list, the kanban card
-- and the record page alike.
--
-- **Opening a record in a new tab is now on by default.** Losing your place in a
-- filtered list to look at one record, then having to navigate back and re-apply
-- everything, is the other thing that makes a list tiring to work through.

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('ui.inline_edit', 'false'::jsonb, 'general',
   'Let people edit straight from a list',
   'On, and clicking a value in a list or on a record page turns it into a box you can type in, '
   || 'saving as soon as you leave it. Quick, and easy to trigger by accident on a record you only '
   || 'meant to read. Off, and values are read-only until you open the record and use Edit.'),

  ('ui.open_in_new_tab', 'true'::jsonb, 'general',
   'Open a record in a new tab',
   'On, and clicking a record from a list opens it in a new browser tab, so your list, its filters '
   || 'and your place in it are all still there when you come back. Off, and it opens in the same tab.')
ON CONFLICT (key) DO NOTHING;
