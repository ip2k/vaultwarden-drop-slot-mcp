import express, { type Express, type ErrorRequestHandler } from 'express';
import { createServer, type Server } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authSchema, readJson, type InboxConfig, type Writer } from './config.js';
import { digest, encryptedBytes, envelopeSchema, MAX_BODY, parse, SafeError, uuid } from './protocol.js';
import { Queue } from './store.js';

export function baseApp(): Express {
  const app = express(); app.disable('x-powered-by'); app.set('query parser', false);
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Strict-Transport-Security': 'max-age=31536000', 'Referrer-Policy': 'no-referrer' }); next();
  });
  return app;
}
export function bearer(header?: string): string {
  if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw new SafeError('unauthorized', 401);
  return header.slice(7);
}
function matches(value: string, expected: string): boolean { return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex')); }
export function authenticate(config: InboxConfig, header?: string): Writer {
  const auth = readJson(config.auth_file, authSchema); const value = bearer(header);
  const writer = auth.writers.find(w => matches(value, w.token_hash));
  if (!writer || writer.revoked || Date.parse(writer.expires_at) <= Date.now()) throw new SafeError('unauthorized', 401);
  return writer;
}
export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const status = err instanceof SafeError ? err.status : (err as { type?: string })?.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 500;
    if (status === 401) res.set('WWW-Authenticate', 'Bearer');
    if (status === 429) res.set('Retry-After', '60');
    res.status(status).json({ error: { code: err instanceof SafeError ? err.code : status === 413 ? 'item_too_large' : status === 400 ? 'invalid_input' : 'internal_error' } });
  };
}
export function finishApp(app: Express): void {
  app.use((_req, res) => { res.status(404).json({ error: { code: 'not_found' } }); }); app.use(errorHandler());
}
export function inboxApps(config: InboxConfig, queue: Queue): { publicApp: Express; workerApp: Express } {
  const publicApp = baseApp(); const workerApp = baseApp();
  publicApp.get('/healthz', (_req, res) => { res.json({ status: 'ok', service: 'vaultwarden-drop-slot-mcp', version: '0.1.0' }); });
  publicApp.use((req, res, next) => { try { res.locals.writer = authenticate(config, req.headers.authorization); next(); } catch (err) { next(err); } });
  publicApp.get('/v1/recipient', (_req, res) => { res.json({ version: 1, ...config.recipients[0] }); });
  publicApp.post('/v1/deposits', express.json({ limit: MAX_BODY, strict: true, inflate: false }), (req, res) => {
    const envelope = parse(envelopeSchema, req.body);
    encryptedBytes(envelope);
    if (!config.recipients.some(k => k.key_id === envelope.key_id)) throw new SafeError('unknown_key');
    queue.prune(config.retention_hours);
    res.status(202).json(queue.deposit(res.locals.writer as Writer, envelope));
  });
  publicApp.get('/v1/receipts/:receipt', (req, res) => { res.json(queue.status((res.locals.writer as Writer).id, parse(uuid, req.params.receipt))); });
  workerApp.use((req, _res, next) => {
    try {
      if (!matches(bearer(req.headers.authorization), readJson(config.auth_file, authSchema).importer_token_hash)) throw new SafeError('unauthorized', 401);
      next();
    } catch (err) { next(err); }
  });
  workerApp.post('/internal/v1/claims', (_req, res) => { queue.prune(config.retention_hours); res.json({ job: queue.claim() }); });
  workerApp.post('/internal/v1/claims/:receipt', express.json({ limit: 1024, strict: true, inflate: false }), (req, res) => {
    const body = parse(z.strictObject({ lease: uuid, result: z.enum(['imported', 'failed', 'retry', 'locked']) }), req.body);
    queue.finish(parse(uuid, req.params.receipt), body.lease, body.result); res.json({ status: 'ok' });
  });
  finishApp(publicApp); finishApp(workerApp); return { publicApp, workerApp };
}
export async function listen(app: Express, config: { cert_file: string; key_file: string; client_ca_file?: string; host: string }, port: number): Promise<Server> {
  const server = createServer({
    cert: readFileSync(config.cert_file), key: readFileSync(config.key_file), minVersion: 'TLSv1.2',
    ...(config.client_ca_file ? { ca: readFileSync(config.client_ca_file), requestCert: true, rejectUnauthorized: true } : {}),
  }, app);
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, config.host, resolve); });
  return server;
}
