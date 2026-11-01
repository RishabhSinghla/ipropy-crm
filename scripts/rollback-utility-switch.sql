-- Rollback for the switch of the 9 "Lead status → WhatsApp template" workflows
-- from the marketing (_mkt) templates to the utility (_utl) ones (31 Oct 2026).
-- One command (workflows reload on their own within 30 seconds):
--   psql "$PROD_DATABASE_URL" -f scripts/rollback-utility-switch.sql
-- Puts every workflow step back on its old marketing template and switches the
-- Exchange workflow back on. Nothing is deleted; the _utl templates stay approved.
-- Format: workflow step id  |  marketing template id (restored)  |  utility template id (before rollback)
BEGIN;
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"399c992a-76cb-4c7a-a019-29b46cffc912"') WHERE id='1c002384-3d00-40dd-9e6d-475fdd6b23f8'; -- New          | _utl 21e1bf64-b375-4d42-9dd5-e9ece097add5
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"0a728085-6f41-4478-8741-fd388255e83c"') WHERE id='8a043232-f9da-48b6-bb52-edaa8968e4a3'; -- Qualified    | _utl 257b7987-64b3-4ef1-8774-780edd291951
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"efeead09-55ee-44d1-b116-d8169439614f"') WHERE id='c07bca59-ea91-4b8e-b288-0413aa99254f'; -- Meeting Fixed | _utl 6d59a256-f109-4e7a-b00a-1d7c2b198de4
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"1b4e46ef-8c94-4656-956d-6ae7107233f0"') WHERE id='79281444-4dfc-4965-ad02-6d68de8ff560'; -- Meeting Done  | _utl 36cfd9b4-ddd0-4868-9d49-60fc60857144
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"b3f1c201-f68e-4a96-97ed-cf8f888d03da"') WHERE id='ee38eb54-a06b-4d94-b0c8-e0fd6b6e9d8d'; -- Negotiation   | _utl bd67dd9f-63b1-4046-8b36-35980078110d
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"d27da9dc-3fec-4688-8288-907174f057bf"') WHERE id='2637d681-bcd2-4291-8fab-9c2804ce1f94'; -- Exchange      | _utl 8b38679c-93b9-4b5e-a7f2-df15a10b5f22
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"ee31f276-b530-4010-9f0e-642112145893"') WHERE id='983497bf-865d-413d-8e83-76fd048c1867'; -- On Hold       | _utl d369fbbc-6975-4abb-9fd6-05c0dea7efc8
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"3784b63f-200c-40ac-8e4f-5d7780214026"') WHERE id='60ea5b74-75a3-4567-b29d-a0b81a21457b'; -- Won           | _utl 4ba2abaf-4aa3-459e-807f-147e2e37ead0
UPDATE ipy_workflow_task SET config = jsonb_set(config,'{templateId}','"a1ec1fe4-aedb-4cd7-ac04-92a24dd91bf8"') WHERE id='21f6fa52-d314-4df0-8025-e0d3bc0389b6'; -- Lost          | _utl 52bd259f-bd49-4ded-8ac0-4bcf59075dd9
-- The Exchange workflow (31b2996a-…) was switched off after the switch because it fires on On Hold, the same as the On Hold workflow.
UPDATE ipy_workflow SET is_active = true, updated_at = now() WHERE id='31b2996a-e99d-4cfa-adba-d86c228b75f8';
COMMIT;
