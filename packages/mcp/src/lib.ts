/**
 * What the CRM server imports to mount the same tools over HTTP.
 *
 * The binary entry point is `index.ts`; this is the library face of the same
 * package, deliberately narrow — a transport, a client and the server factory.
 */
export { CrmClient, CrmError, configFromEnv, type CrmConfig } from './client.js';
export { createMcpServer } from './server.js';
export { TOOLS, toolsFor, type ToolDef, type ToolResult } from './tools.js';
