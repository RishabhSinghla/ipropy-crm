-- Sarvam AI voice agent removed (owner's instruction, 25 November 2026). Its settings
-- card goes. Calls already recorded stay in ipy_call, and the ipy_sarvam_* tables are left alone.
DELETE FROM ipy_integration WHERE provider = 'sarvam_voice';

-- The AI-call filter fields (ai_call_status, ai_call_outcome, ai_last_call_at, ai_attempts) no longer
-- exist, so anything still naming them would be refused when opened. Remove the seeded "AI: ..." lists and
-- any saved list, dashboard tile or report that names one of them (the same clean-up migration 184 did for "unread").
DELETE FROM ipy_view
WHERE seed_key LIKE 'AI: %'
   OR filter::text ~ '"field"\s*:\s*"(ai_call_status|ai_call_outcome|ai_last_call_at|ai_attempts)"';
DELETE FROM ipy_dashboard_widget
 WHERE (to_jsonb(ipy_dashboard_widget)->'config')::text ~ '"field"\s*:\s*"(ai_call_status|ai_call_outcome|ai_last_call_at|ai_attempts)"';
DELETE FROM ipy_report
 WHERE (to_jsonb(ipy_report)->'config')::text ~ '"field"\s*:\s*"(ai_call_status|ai_call_outcome|ai_last_call_at|ai_attempts)"';
