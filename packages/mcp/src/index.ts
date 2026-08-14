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
 * This file is the stdio transport, which is what a desktop assistant launches
 * directly on a laptop. The CRM also serves the same tools over HTTP at
 * `/api/mcp` for clients connecting remotely — both build their server from
 * `createMcpServer`, so the two can never offer different things.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CrmClient, configFromEnv } from './client.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const crm = new CrmClient(configFromEnv());
  const server = createMcpServer(crm);

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
