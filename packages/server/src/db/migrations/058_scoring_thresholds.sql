-- The numbers that decide what "Hot" means, moved out of the code.
--
-- Hot at 70, Warm at 45, grades at 80/60/40 and a buyer-match floor of 55 were
-- five business judgements sitting as literals in three files, with 70 and 45
-- written a fourth time in the web kanban badge. Changing what counts as a hot
-- lead — the sort of thing a sales head changes after one quarter of watching
-- the pipeline — meant finding a developer and shipping a release.
--
-- Seeded rather than left to the app's defaults so they appear in the settings
-- list on day one. An admin cannot edit a setting that does not exist yet.
INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('scoring.hot_at', '70', 'scoring', 'A lead is Hot at',
   'Score out of 100. At or above this, a lead shows as Hot everywhere in the CRM.'),
  ('scoring.warm_at', '45', 'scoring', 'A lead is Warm at',
   'Score out of 100. Between this and the Hot number a lead is Warm; below it, Cold.'),
  ('scoring.grade_a_at', '80', 'scoring', 'Grade A at',
   'Score out of 100 for the top grade.'),
  ('scoring.grade_b_at', '60', 'scoring', 'Grade B at', 'Score out of 100.'),
  ('scoring.grade_c_at', '40', 'scoring', 'Grade C at',
   'Score out of 100. Anything below this is graded D.'),
  ('scoring.match_floor', '55', 'scoring', 'Buyer match minimum',
   'How well a property must fit a buyer before the CRM suggests it. Lower shows more matches and more poor ones.')
ON CONFLICT (key) DO NOTHING;
