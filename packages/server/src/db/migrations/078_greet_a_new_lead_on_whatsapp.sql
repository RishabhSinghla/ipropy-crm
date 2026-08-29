-- Say hello on WhatsApp the moment an enquiry arrives.
--
-- Somebody fills in a Facebook lead form at eleven at night. The CRM already
-- creates the lead, assigns it and starts an SLA clock — and the buyer hears
-- nothing until a rep opens the CRM the next morning, by which time they have
-- filled in three other builders' forms too. Speed to first contact is most of
-- what decides who gets the site visit.
--
-- **It has to be an approved template.** The person has never messaged the
-- business, so there is no open conversation, and Meta refuses free-form text
-- outside one. Naming a template that Meta has not approved fails at their end
-- and looks like success from in here, which is why this ships off: switching it
-- on is a decision that goes with having a template approved.
--
-- Without the Business API configured at all, the message is queued for a rep to
-- send from their own WhatsApp rather than silently dropped — the same fallback
-- the instant-response workflow already uses.
--
-- Applies to every captured source, not only Facebook: the website form, Google
-- Ads and the portal webhooks all arrive through the same door.

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('whatsapp.greet_new_leads', 'false'::jsonb, 'whatsapp',
   'Say hello on WhatsApp when a new enquiry arrives',
   'On, and every new enquiry — from your Facebook ads, your website or a portal — gets a WhatsApp '
   || 'message straight away, before anybody has picked up the phone. It is only sent once, only to a '
   || 'lead the CRM has just created, and never to somebody who has asked you to stop. Needs an '
   || 'approved template named below.'),

  ('whatsapp.greeting_template', '""'::jsonb, 'whatsapp',
   'Which approved template to greet them with',
   'The exact name of a template Meta has approved on your WhatsApp Business account — for example '
   || 'new_enquiry_greeting. WhatsApp does not allow a free-typed first message to somebody who has '
   || 'never written to you, so this has to be a template. Leave it empty and no greeting is sent, '
   || 'even with the switch above turned on.')
ON CONFLICT (key) DO NOTHING;
