#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { z } from 'zod';
import { DepositClient } from './client.js';
import { clientSchema, importerSchema, inboxSchema, readJson, remoteSchema } from './config.js';
import { digest, fingerprint, MAX_BODY, parse, payloadSchema, SafeError, token, uuid } from './protocol.js';
import { Queue } from './store.js';
import { inboxApps, listen } from './http.js';
import { createImporter, importOnce } from './importer.js';
import { remoteApp, stdio } from './mcp.js';

async function input(): Promise<unknown> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { length += chunk.length; if (length > MAX_BODY) throw new SafeError('item_too_large'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SafeError('invalid_input'); }
}
async function main(): Promise<void> {
  process.umask(0o077);
  const [command, file, extra] = process.argv.slice(2);
  if (command === '--help' || command === undefined) {
    process.stdout.write('vaultwarden-drop-slot-mcp <command> <config-or-directory>\n\n  init <new-directory>    Generate keys, tokens and example config (no secrets printed)\n  stdio <client.json>    Local MCP adapter\n  deposit <client.json>  Read {request_id,payload} JSON from stdin\n  status <client.json> <receipt>\n  inbox <inbox.json>     HTTPS ciphertext inbox and private worker listener\n  importer <importer.json>  Private vault delivery loop\n  mcp-http <remote.json>    Optional OAuth-protected remote adapter\n'); return;
  }
  if (!file) throw new SafeError('configuration_path_required');
  if (command === 'init') {
    const dir = resolve(file); mkdirSync(dir, { mode: 0o700 });
    const identity = await generateIdentity(); const publicKey = await identityToRecipient(identity); const keyId = fingerprint(publicKey);
    const writerToken = token(); const workerToken = token();
    const save = (name: string, value: string | unknown) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    save('identity.txt', identity); save('writer-token.txt', writerToken); save('importer-token.txt', workerToken);
    save('recipient.json', { version: 1, recipient: publicKey, key_id: keyId });
    save('auth.json', { writers: [{ id: 'default', token_hash: digest(writerToken), expires_at: new Date(Date.now() + 90 * 86400000).toISOString(), daily_limit: 100, pending_limit: 100, revoked: false }], importer_token_hash: digest(workerToken) });
    save('client.json', { inbox_url: 'https://localhost:8443', writer_id: 'default', token_file: join(dir, 'writer-token.txt'), recipient: publicKey, key_id: keyId, spool_dir: join(dir, 'spool'), ca_file: join(dir, 'ca.crt') });
    save('inbox.json', { host: '0.0.0.0', port: 8443, worker_port: 8444, cert_file: join(dir, 'server.crt'), key_file: join(dir, 'server.key'), auth_file: join(dir, 'auth.json'), database: join(dir, 'queue.sqlite'), recipients: [{ recipient: publicKey, key_id: keyId }] });
    process.stdout.write(JSON.stringify({ status: 'initialized', key_id: keyId, next: 'Install verified TLS certificates; separate producer, inbox and importer files before deployment.' }) + '\n'); return;
  }
  if (command === 'stdio' || command === 'deposit' || command === 'status') {
    const client = new DepositClient(readJson(file, clientSchema));
    if (command === 'stdio') { await stdio(client); return; }
    const result = command === 'status' ? await client.status(parse(uuid, extra)) : await (async () => { const args = parse(z.strictObject({ request_id: uuid, payload: payloadSchema }), await input()); return client.deposit(args.request_id, args.payload); })();
    process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  if (command === 'inbox') {
    const config = readJson(file, inboxSchema); const queue = new Queue(config.database, config.max_records);
    const apps = inboxApps(config, queue);
    const publicServer = await listen(apps.publicApp, config, config.port);
    const workerServer = await listen(apps.workerApp, config, config.worker_port);
    const cleanup = setInterval(() => queue.prune(config.retention_hours), 60000);
    const stop = () => { clearInterval(cleanup); publicServer.closeAllConnections(); workerServer.closeAllConnections(); publicServer.close(); workerServer.close(); queue.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop); return;
  }
  if (command === 'importer') {
    const config = readJson(file, importerSchema); const importer = await createImporter(config);
    let stopping = false; const controller = new AbortController();
    const stop = () => { stopping = true; controller.abort(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop);
    const { setTimeout: delay } = await import('node:timers/promises');
    while (!stopping) {
      try { await importOnce(config, importer); } catch { process.stderr.write('importer: delivery unavailable; retrying\n'); }
      await delay(config.poll_ms, undefined, { signal: controller.signal }).catch(() => {});
    }
    importer.close(); return;
  }
  if (command === 'mcp-http') {
    const config = readJson(file, remoteSchema); const server = await listen(remoteApp(config), config, config.port);
    const stop = () => { server.closeAllConnections(); server.close(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop); return;
  }
  throw new SafeError('unknown_command');
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: { code: error instanceof SafeError ? error.code : 'operation_failed' } }) + '\n'); process.exitCode = 1; });
