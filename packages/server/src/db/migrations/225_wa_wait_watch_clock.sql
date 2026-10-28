-- A reply's arrival time must be the moment the row is written, not the moment its transaction began (now()),
-- or a transaction that began before an alert was stamped could look older than it. Existing rows are unchanged.
ALTER TABLE ipy_message ALTER COLUMN received_at SET DEFAULT clock_timestamp();
