-- Existing duplicates stay intact. The write engine only blocks new identities.
UPDATE ipy_module SET settings = settings || '{"mobileIdentityGroup":"crm-contact-mobile"}'::jsonb
WHERE name IN ('leads', 'properties');
