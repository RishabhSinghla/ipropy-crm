-- "Report a Problem" becomes a ticket the AI engineering pipeline can pick up.
--
-- The owner is not technical and is not going to become technical. His half of
-- the bargain is a sentence in Hinglish plus a screenshot, submitted from
-- wherever he is in the CRM. Our half is everything after the Submit button:
-- the report becomes a GitHub issue, an agent investigates the repository,
-- opens a pull request, CI proves it, and the change deploys — and the person
-- who asked for it can see, in the same simple words he used, where his thing
-- is and whether it is done.
--
-- One row per report. The screenshots he attaches live in ipy_attachment
-- against this row, exactly like photos on a property — same storage driver,
-- same permission model, same derivative pipeline. No new file plumbing.

CREATE TABLE IF NOT EXISTS ipy_feedback (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who asked, so verification and notifications go back to the right person.
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  -- What he typed, kept verbatim. Hinglish is first-class: "edit karne par
  -- locality gayab ho jati hai" is a complete bug report.
  text          TEXT NOT NULL,
  -- Where he was: module, record, route. Sent automatically so he never has
  -- to name the screen he is on.
  module_name   TEXT,
  record_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  route         TEXT,
  -- 'bug' | 'idea' | 'question' — decided by the reporter, not inferred.
  kind          TEXT NOT NULL DEFAULT 'bug'
                CHECK (kind IN ('bug','idea','question')),
  -- 'blocking' | 'important' | 'minor'
  severity      TEXT NOT NULL DEFAULT 'important'
                CHECK (severity IN ('blocking','important','minor')),
  -- The pipeline's own state, driven entirely by what GitHub reports back.
  --    submitted   row created, nothing external attempted yet
  --    triaging    AI is reading the report and the repository
  --    working     agent is editing code / a PR is open
  --    reviewing   PR open, CI green, waiting on the owner's 👍
  --    fixed       merged and deployed
  --    reopened    the owner looked and it is still wrong — same row, agent
  --                re-runs with the follow-up text appended
  --    failed      the agent or CI could not do it; the reason is in the log
  --    declined    a person decided it should not be built
  status        TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted','triaging','working','reviewing','fixed','reopened','failed','declined')),
  -- What the AI understood the request to be, written back in simple Hinglish
  -- so the reporter can confirm he was understood before anything is built.
  ai_summary    TEXT,
  -- GitHub linkage. Null until the issue exists; the issue is the single
  -- source of truth for the engineering half from that moment on.
  issue_number  INTEGER,
  issue_url     TEXT,
  pr_number     INTEGER,
  pr_url        TEXT,
  -- A signed token that carries no session and no permission, so a
  -- screenshot can be shown to the reporter (and only him) without a login,
  -- and handed to the agent without handing it the session.
  share_token   TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24),'hex'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_created
  ON ipy_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status
  ON ipy_feedback (status)
  WHERE status NOT IN ('fixed','declined');

-- The story of one report, in order: submitted, triaged, PR opened, deployed,
-- verified — each step with a plain-language note for the reporter.
CREATE TABLE IF NOT EXISTS ipy_feedback_event (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID NOT NULL REFERENCES ipy_feedback(id) ON DELETE CASCADE,
  -- Machine stage, mirrors the vocabulary above.
  stage       TEXT NOT NULL,
  -- What the reporter reads. Hinglish by design.
  note        TEXT,
  actor       TEXT NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_event_feedback
  ON ipy_feedback_event (feedback_id, created_at);
