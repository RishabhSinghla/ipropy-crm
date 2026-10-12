-- A template sent from the CRM was stored as "[template: name]", so the chat showed a label and not what the
-- customer received. New sends store the filled wording; this does the same for every one already sent.
DO $$
DECLARE
  m RECORD;
  wording TEXT;
  n INT;
BEGIN
  FOR m IN SELECT id, template_name, template_params::jsonb AS params FROM ipy_message
            WHERE body LIKE '[template: %' AND template_name IS NOT NULL LOOP
    SELECT body_text INTO wording FROM ipy_whatsapp_template WHERE name = m.template_name ORDER BY created_at DESC LIMIT 1;
    CONTINUE WHEN wording IS NULL OR btrim(wording) = '';
    IF m.params IS NOT NULL AND jsonb_typeof(m.params) = 'array' THEN
      FOR n IN 1..jsonb_array_length(m.params) LOOP
        wording := regexp_replace(wording, '\{\{\s*' || n || '\s*\}\}', replace(coalesce(m.params ->> (n - 1), ''), '\', '\\'), 'g');
      END LOOP;
    END IF;
    UPDATE ipy_message SET body = wording WHERE id = m.id;
  END LOOP;
END $$;
