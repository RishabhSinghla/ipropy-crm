#!/usr/bin/env node
/**
 * iPropy as an MCP server — the CRM, available inside Claude, ChatGPT, or any
 * other assistant that speaks the protocol.
 *
 * The point is not novelty. A rep standing at a gate, or sitting in a car
 * between two site visits, does not want to open a CRM, find a list, apply a
 * filter and read a table. They want to say "who was looking for a 3 BHK in
 * Powai under two crore" and hear the answer. This makes that the same question
 * to the assistant they already have open.
 *
 * Two things make it safe to point at real customer data:
 *
 *   It authenticates as a person, using their own API key, and every call goes
 *   through the CRM's ordinary API — so it can see exactly what they can see
 *   and no more. There is no service account, and no second set of permission
 *   rules to keep in step with the first.
 *
 *   It cannot delete anything, and by default it cannot write at all. Writing
 *   is opt-in, per connection, by setting IPROPY_READ_ONLY=false.
 *
 * Runs over stdio, which is what a desktop assistant launches directly. An HTTP
 * transport for connecting remotely is a separate, later job — it needs OAuth
 * to be worth doing properly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CrmClient, CrmError, configFromEnv } from './client.js';
import { toolsFor } from './tools.js';

async function main(): Promise<void> {
  const crm = new CrmClient(configFromEnv());

  const server = new McpServer(
    { name: 'ipropy', version: '1.0.0' },
    {
      instructions:
        'iPropy is a CRM for an Indian real-estate business. Leads and contacts are one module '
        + '("leads"); inventory is "properties"; marketing is "campaigns". Prices are in rupees — '
        + 'write them as ₹1.45 Cr or ₹85 L when talking to the user, but pass plain numbers to '
        + 'tools. You are acting as one named person: you can only see and change what they can, '
        + 'and you cannot delete anything. Before changing a record, make sure you have the right '
        + 'one — find it, show the user who you found, and only then update it.',
    },
  );

  for (const tool of toolsFor(crm)) {
    server.registerTool(
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

  // Prove the connection before announcing readiness. A server that starts
  // cleanly and then fails on every call is the worst of both worlds — the
  // person sees a connected badge and a broken assistant.
  try {
    const me = await crm.whoami();
    process.stderr.write(
      `iPropy MCP: connected to ${crm.baseUrl} as ${me.fullName} <${me.email}>`
      + `${crm.readOnly ? ' (read-only)' : ' (can make changes)'}\n`,
    );
  } catch (err) {
    process.stderr.write(`iPropy MCP: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stderr, never stdout: stdout is the protocol channel, and one stray line
  // there corrupts the stream and disconnects the client.
  process.stderr.write(`iPropy MCP failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
