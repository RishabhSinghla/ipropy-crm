# WhatsApp status workflows

Customer messaging remains OFF until an administrator creates/enables a rule.

1. Admin → WhatsApp Templates: Sync approval status.
2. Map each template's numbered blanks. For the 27 `ipropy_` service templates, slot 1 is Full Name and slot 2 is Enquiry / transaction reference (record ID). Map additional slots to the actual requirement or appointment fields. Preview a sample record; never substitute invented dates or budgets.
3. Admin → Workflows: choose Leads, When a field changes, watch Status, and add a condition for the desired status.
4. Add Send WhatsApp template, choose ONE approved alternative and the mobile field. Save disabled until ready.
5. Preview the mapping and perform one controlled send to an explicitly approved internal test number before enabling customer delivery.

Submitted/rejected/paused/missing templates, opt-outs and empty mapped fields must not send. Template approval is checked against the provider before delivery. Delayed actions recheck current workflow conditions and stop when a workflow is disabled. Historical WhatsApp actions need explicit reconfiguration; they do not start sending after upgrade.

Workflow execution and WhatsApp conversation logs show failures. Deferred WhatsApp failures are not automatically retried because a timeout can occur after the provider has accepted a message: inspect the delivery log first. No system can promise exactly-once delivery if a provider accepts a request then loses its response.

Prefer one status rule per stage and one alternative per rule. Do not enable all three alternatives for a client. Honour opt-outs; do not use a scheduled, unfiltered rule to message the entire database.

Readiness is not deployment or Meta approval. A green local simulation does not prove an actual recipient received a message. Production release and the controlled live send remain separate verification steps.
