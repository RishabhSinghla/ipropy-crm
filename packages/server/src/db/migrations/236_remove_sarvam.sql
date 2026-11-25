-- Sarvam AI voice agent removed (owner's instruction, 25 November 2026). Its settings
-- card goes. Calls already recorded stay in ipy_call, and the ipy_sarvam_* tables are left alone.
DELETE FROM ipy_integration WHERE provider = 'sarvam_voice';
