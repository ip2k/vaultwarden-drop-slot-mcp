import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import express from 'express';
import { z } from 'zod';
import { DepositClient } from './client.js';
import { bindingsSchema, readJson, type RemoteConfig } from './config.js';
import { baseApp, finishApp } from './http.js';
import { MAX_BODY, parse, payloadSchema, SafeError, uuid } from './protocol.js';

const depositInput = z.strictObject({ request_id: uuid.describe('Fresh UUID for a new item; reuse the same UUID only to retry the original deposit.'), payload: payloadSchema.describe('New login or secure note. Do not include routing or vault identifiers.') });
const statusInput = z.strictObject({ receipt: uuid.describe('Opaque receipt previously issued to this writer.') });
const depositJson = z.toJSONSchema(depositInput, { io: 'input' });
Object.assign(depositJson.properties?.payload ?? {}, { type: 'object' });
export const toolManifest = [
  { name: 'deposit_secret', description: 'Encrypt and queue a new login or secure note in the administrator-selected Vaultwarden destination. Returns an opaque receipt only. Reusing request_id retries the original item; changed arguments do not overwrite it.', inputSchema: depositJson, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'deposit_status', description: 'Read only the delivery state of your own opaque deposit receipt. Never returns names, contents, vault IDs, or search results.', inputSchema: z.toJSONSchema(statusInput, { io: 'input' }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];
export function mcpServer(client: DepositClient): Server {
  const server = new Server({ name: 'vaultwarden-drop-slot-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolManifest }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      let result;
      if (request.params.name === 'deposit_secret') {
        const args = parse(depositInput, request.params.arguments);
        result = await client.deposit(args.request_id, args.payload);
      } else if (request.params.name === 'deposit_status') {
        result = await client.status(parse(statusInput, request.params.arguments).receipt);
      } else throw new SafeError('unknown_tool');
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      // Never return raw validator, HTTP or CLI errors: they can contain inputs.
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: error instanceof SafeError ? error.code : 'deposit_unavailable' } }) }] };
    }
  });
  return server;
}
export async function stdio(client: DepositClient): Promise<void> { await mcpServer(client).connect(new StdioServerTransport()); }
export function remoteApp(config: RemoteConfig, getKey?: JWTVerifyGetKey): express.Express {
  const app = baseApp(); const resource = new URL(config.resource);
  if (resource.pathname !== '/mcp') throw new SafeError('invalid_configuration');
  const jwks = getKey ?? createRemoteJWKSet(new URL(config.jwks_url), { timeoutDuration: 5000, cooldownDuration: 30000 });
  const metadataPath = '/.well-known/oauth-protected-resource/mcp';
  const metadata = { resource: config.resource, authorization_servers: [config.issuer], bearer_methods_supported: ['header'], scopes_supported: ['deposits:write', 'deposits:status'], resource_name: 'Vaultwarden Drop Slot' };
  const counts = new Map<string, { minute: number; count: number }>();
  app.use((req, _res, next) => {
    if (req.headers.host !== resource.host || (req.headers.origin && !config.allowed_origins.includes(req.headers.origin))) { next(new SafeError('forbidden', 403)); return; }
    next();
  });
  app.get([metadataPath, '/.well-known/oauth-protected-resource'], (_req, res) => { res.json(metadata); });
  app.use('/mcp', async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header || header.length > 8192 || !header.startsWith('Bearer ')) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), jwks, { issuer: config.issuer, audience: config.resource, algorithms: [config.algorithm], requiredClaims: ['exp', 'sub', 'iat', 'client_id'], clockTolerance: 0 });
      if (typeof payload.scope !== 'string' || !['deposits:write', 'deposits:status'].every(s => payload.scope!.toString().split(' ').includes(s))) throw new Error();
      // Reload on every request so removing a binding revokes access immediately.
      const binding = readJson(config.bindings_file, bindingsSchema).find(b => b.subject === payload.sub && b.client_id === payload.client_id);
      if (!binding) throw new Error();
      const minute = Math.floor(Date.now() / 60000); const principal = JSON.stringify([payload.sub, payload.client_id]);
      for (const [key, value] of counts) if (value.minute !== minute) counts.delete(key);
      const counter = counts.get(principal) ?? { minute, count: 0 }; counter.count++; counts.set(principal, counter);
      if (counter.count > 60) { next(new SafeError('quota_exceeded', 429)); return; }
      res.locals.client = new DepositClient(binding.client); next();
    } catch {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${resource.origin}${metadataPath}", scope="deposits:write deposits:status"`);
      res.status(401).json({ error: { code: 'unauthorized' } });
    }
  });
  app.post('/mcp', express.json({ limit: MAX_BODY, strict: true, inflate: false }), async (req, res) => {
    const server = mcpServer(res.locals.client as DepositClient);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    await server.connect(transport); await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).json({ error: { code: 'method_not_allowed' } }); });
  finishApp(app); return app;
}
