-- A WhatsApp thread is filed under the module its record actually lives in.
--
-- Sending from a record links the thread to it, and `send.ts` wrote
-- `record_module = 'leads'` whatever the record was. A rep messaging a buyer
-- from an Inventory record therefore left a thread holding a property's id
-- filed as a lead. Everything downstream then asked the wrong question:
-- the Chats screen's right-hand pane requested `/records/leads/<property id>`,
-- got nothing, and showed its grey loading boxes for ever; the LD/INV tag said
-- LD; the "Inventories chats" filter left the thread out.
--
-- The record knows its own module, so the stored copy is simply re-read from
-- it. A thread whose record has since been deleted keeps its link, so the
-- history is still reachable if the record is restored.
UPDATE ipy_conversation c
   SET record_module = m.name
  FROM ipy_record r
  JOIN ipy_module m ON m.id = r.module_id
 WHERE c.record_id = r.id
   AND c.record_module IS DISTINCT FROM m.name;
