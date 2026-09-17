-- A tag can belong to Contacts, to Inventories, or to both.
--
-- `ipy_tag` has always been one shared vocabulary: every tag offered on every
-- record of every module. The owner asked for the two lists to be separate —
-- "Site Visit Done" means nothing on a builder floor, and "Corner Unit" means
-- nothing on a person — while still allowing a tag that genuinely applies to
-- both.
--
-- `modules` is that choice, and an EMPTY array means "offer me everywhere".
-- Empty is the value, not a null: it is what every tag that exists right now
-- becomes, so nothing a rep has already tagged changes, no picker loses an
-- option, and narrowing a tag is a decision an admin makes rather than a
-- migration making it for them.
--
-- `name` stays UNIQUE across the CRM on purpose. A tag is one row that may be
-- offered in two places, not two rows that happen to share a word — which
-- keeps `ipy_tag_link` unambiguous about which tag a record actually carries,
-- and keeps a filter on "Hot" meaning one thing.

ALTER TABLE ipy_tag ADD COLUMN IF NOT EXISTS modules TEXT[] NOT NULL DEFAULT '{}';

-- Offered everywhere unless somebody narrows it. Stated rather than relied on
-- from the default, so a row written before this migration lands is covered.
UPDATE ipy_tag SET modules = '{}' WHERE modules IS NULL;

-- The list picker and the record's tag box both ask "which tags may this
-- module offer", which is a containment test on every read.
CREATE INDEX IF NOT EXISTS idx_tag_modules ON ipy_tag USING GIN (modules);
