/**
 * The MCP server itself, independent of how it is reached.
 *
 * Two transports use this: the stdio one in `index.ts`, which a desktop
 * assistant launches on a laptop, and the HTTP one the CRM mounts at
 * `/api/mcp` for remote clients. They differ only in plumbing — the tools,
 * their descriptions and the instructions the model reads are defined once,
 * here, so the two can never drift into offering different things.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CrmError, type CrmClient } from './client.js';
import { toolsFor } from './tools.js';

/**
 * What the model is told about this CRM before it sees a single tool.
 *
 * Worth its length. Without the note about rupees a model writes "₹21500000";
 * without the note about acting as one person it explains away an empty result
 * as a bug rather than as a permission boundary; and without the instruction to
 * confirm before changing, it updates the first Sharma it finds.
 */
const INSTRUCTIONS =
  'iPropy is a CRM for an Indian real-estate business. Leads and contacts are one module '
  + '("leads") and inventory is "properties". Prices are in rupees — '
  + 'write them as ₹1.45 Cr or ₹85 L when talking to the user, but pass plain numbers to '
  + 'tools. You are acting as one named person: you can only see and change what they can, '
  + 'and you cannot delete anything. An empty result usually means exactly that, not an '
  + 'error. Before changing a record, make sure you have the right one — find it, show the '
  + 'user who you found, and only then update it.';

export function createMcpServer(crm: CrmClient): McpServer {
  const server = new McpServer(
    { name: 'ipropy', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  // See inputSchema below. The SDK's generic overload attempts to infer every
  // individual schema in the catalogue as one enormous union. Bind once to a
  // deliberately erased boundary; each catalogue item remains runtime-checked
  // by the SDK when the tool is registered and called.
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => void;

  for (const tool of toolsFor(crm)) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: !tool.writes,
          // Nothing offered here deletes or overwrites irrecoverably; an update
          // is a change somebody can see in the audit trail and put back.
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          return await tool.run(crm, args);
        } catch (err) {
          // Errors come back as tool results rather than protocol failures, so
          // the model can tell the user what went wrong and try something else
          // instead of the whole conversation falling over.
          const message = err instanceof CrmError
            ? err.message
            : `Something went wrong talking to the CRM: ${(err as Error).message}`;
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }

  return server;
}
