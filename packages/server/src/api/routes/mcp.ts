/**
 * The CRM, served over MCP to a client that is not on this machine.
 *
 * `packages/mcp` runs on a laptop and is launched by a desktop assistant. This
 * is the other half: the same tools, reachable at a URL, so an assistant on a
 * phone or in a browser can use them. It is mounted on the CRM's own server
 * rather than deployed separately because a second service means a second
 * thing to host, pay for and keep running, and there is nothing here that
 * needs its own process.
 *
 * **Stateless, one transport per request.** The alternative — a session map
 * keyed by `Mcp-Session-Id` — would put conversation state in the memory of a
 * container that Render restarts whenever it likes, so a redeploy in the
 * middle of somebody's afternoon would break every open assistant with a 404
 * on a session it no longer has. Every request carries its own key and stands
 * alone; nothing is kept.
 *
 * **Loopback, not a shortcut into the service layer.** The tools call the
 * CRM's own HTTP API on 127.0.0.1, which looks wasteful from inside the same
 * process. It buys the property the whole design rests on: there is exactly
 * one path that enforces permissions, validation, workflows and the audit
 * trail, and this is not a second one. A tool reaching straight into
 * `recordService` would be a parallel entry point to keep in step forever, and
 * the first thing to fall out of step would be a permission check.
 *
 * **Still to build: OAuth.** A one-click connector in the Claude or ChatGPT
 * apps needs OAuth 2.1 with dynamic client registration. This endpoint takes a
 * personal API key instead, which is what Claude Code and any client that lets
 * you set a header can use today.
 */
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CrmClient, createMcpServer } from '@ipropy/mcp';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { getUser, requireAuth } from '../../middleware/auth.js';
import { UnauthorizedError } from '../../utils/errors.js';

export const mcpRouter = Router();

/**
 * The key the caller presented, to be handed back to the loopback client.
 *
 * `requireAuth` accepts a session token too, and one arriving here is a person
 * pointing a browser at an endpoint that is not for browsers. Refused rather
 * than accommodated: a session token in an assistant's config is a credential
 * that expires in hours and cannot be revoked on its own, which is exactly
 * what the API key exists to avoid.
 */
function callerKey(header: unknown): string {
  if (typeof header !== 'string' || !header) {
    throw new UnauthorizedError(
      'Connect with a personal API key in an x-api-key header. Create one in the CRM under Settings → Security → Connected apps.',
    );
  }
  return header;
}

mcpRouter.post('/', requireAuth, async (req, res) => {
  let transport: StreamableHTTPServerTransport | undefined;
  try {
    const apiKey = callerKey(req.headers['x-api-key']);
    const user = getUser(req);

    const crm = new CrmClient({
      // The server's own address. `config.port` rather than a hardcoded 4000
      // because the port is configurable and a mismatch here would look like
      // the CRM being down, from inside the CRM.
      baseUrl: `http://127.0.0.1:${config.port}`,
      apiKey,
      // Remote connections read by default, exactly like the stdio one. A URL
      // is easier to hand around than a laptop config file, so the default
      // matters more here, not less.
      readOnly: (req.headers['x-ipropy-write'] ?? '') !== 'allow',
    });

    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Both are per-request, so both are closed when the response ends —
    // otherwise every call leaks a transport and its listeners.
    res.on('close', () => { void transport?.close(); });

    const server = createMcpServer(crm);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    logger.debug({ userId: user.id }, 'mcp request served');
  } catch (err) {
    if (!res.headersSent) {
      const status = err instanceof UnauthorizedError ? 401 : 500;
      res.status(status).json({
        jsonrpc: '2.0',
        error: { code: status === 401 ? -32001 : -32603, message: (err as Error).message },
        id: null,
      });
    }
    void transport?.close();
  }
});

/**
 * GET and DELETE are the session half of the protocol — a client opening a
 * server-sent-event stream, or ending a session. Neither applies to a
 * stateless server, and answering 405 with a reason is how a client learns
 * that rather than hanging on a stream that will never speak.
 */
for (const method of ['get', 'delete'] as const) {
  mcpRouter[method]('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This MCP endpoint is stateless: use POST for every request.' },
      id: null,
    });
  });
}
