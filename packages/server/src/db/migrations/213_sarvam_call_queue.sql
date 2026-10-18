-- A queue is saved before any phone call is requested. Refreshing never redials it.
CREATE TABLE ipy_sarvam_batch (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES ipy_user(id),
 module TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('running','paused','done')),
 message TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ipy_sarvam_queue (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id UUID NOT NULL REFERENCES ipy_sarvam_batch(id) ON DELETE CASCADE,
 record_id UUID NOT NULL REFERENCES ipy_record(id),
 label TEXT NOT NULL,
 phone TEXT NOT NULL,
 position INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitting','waiting','completed','busy','no_answer','failed','unknown','skipped')),
 attempt_id TEXT,
 error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(batch_id, record_id)
);
CREATE INDEX ON ipy_sarvam_queue(batch_id, position);
CREATE INDEX ON ipy_sarvam_queue(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX sarvam_one_running_batch_per_user ON ipy_sarvam_batch(user_id) WHERE status = 'running';
