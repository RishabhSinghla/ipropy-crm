-- The switch for "Rewrite with AI" on the notes box (3 October 2026), so it
-- appears in Admin → Settings → AI features beside the others. On by default:
-- it only suggests, and nothing is posted until somebody presses Comment.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES ('ai_features.note_rewrite', 'true'::jsonb, 'ai_features',
        'Rewrite a note with AI',
        'A button on the notes box that rewrites what somebody typed so it reads nicely, in the same '
        || 'language. Nothing is posted until they press Comment.')
ON CONFLICT (key) DO NOTHING;
