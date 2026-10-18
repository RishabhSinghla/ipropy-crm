ALTER TABLE ipy_call ADD COLUMN sarvam_batch_id UUID REFERENCES ipy_sarvam_batch(id) ON DELETE SET NULL;
UPDATE ipy_call c SET sarvam_batch_id=q.batch_id FROM ipy_sarvam_queue q WHERE c.source='sarvam' AND c.provider_call_id=q.attempt_id;
CREATE INDEX idx_sarvam_record_history ON ipy_call(record_module,record_id,started_at DESC) WHERE source='sarvam' AND direction='outbound';
CREATE INDEX idx_sarvam_batch_history ON ipy_call(sarvam_batch_id) WHERE sarvam_batch_id IS NOT NULL;
