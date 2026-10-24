import { describe, expect, it } from 'vitest';
import { runTask, type TaskContext } from '../../src/core/workflow/tasks.js';

const context: TaskContext = {
  workflowId: 'workflow-test',
  taskId: 'task-test',
  module: 'leads',
  recordId: 'record-test',
  record: { status: 'New' },
  user: null,
  source: 'test',
};

describe('workflow task compatibility', () => {
  it('fails visibly when a saved workflow still has the retired WhatsApp step', async () => {
    await expect(runTask('send_whatsapp', {}, context))
      .rejects.toThrow(/retired WhatsApp message step.*approved, mapped template/i);
  });

  it('does not report an unrecognized task as a successful no-op', async () => {
    await expect(runTask('send_whatsap_template', {}, context))
      .rejects.toThrow(/Unknown workflow task type/);
  });
});
