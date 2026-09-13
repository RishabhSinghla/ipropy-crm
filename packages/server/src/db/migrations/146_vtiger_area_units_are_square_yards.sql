-- The original version of this migration rewrote every historical JSON record
-- during application startup. On the production database that operation can
-- exceed the cluster storage quota and prevent the CRM from starting at all.
--
-- Keep this migration deliberately small. Historical unit normalization must
-- be performed later as a controlled, batched maintenance job after database
-- capacity has been made available. No measurements are changed here.
DO $$
BEGIN
  RAISE NOTICE '146: deferred historical area-unit normalization; run it later as batched database maintenance';
END $$;
