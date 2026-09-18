import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { token, digest, fingerprint } from '../dist/protocol.js';
import { Queue } from '../dist/store.js';
import { inboxApps, listen } from '../dist/http.js';

export function temp() { const dir = mkdtempSync(join(tmpdir(), 'drop-slot-test-')); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }
export function save(path, value) { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); }
export function certificate(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.crt'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  return { cert_file: join(dir, 'server.crt'), key_file: join(dir, 'server.key') };
}
export async function fixture() {
  const t = temp(); const identity = await generateIdentity(); const recipient = await identityToRecipient(identity); const key_id = fingerprint(recipient);
  const a = token(), b = token(), worker = token();
  const auth = { writers: ['a', 'b'].map((id, i) => ({ id, token_hash: digest(i ? b : a), expires_at: new Date(Date.now() + 3600000).toISOString(), daily_limit: 10, pending_limit: 10, revoked: false })), importer_token_hash: digest(worker) };
  const config = { ...certificate(t.dir), host: '127.0.0.1', auth_file: join(t.dir, 'auth.json'), database: join(t.dir, 'queue.sqlite'), recipients: [{ recipient, key_id }], retention_hours: 168 };
  save(config.auth_file, auth); save(join(t.dir, 'a.token'), a); save(join(t.dir, 'b.token'), b);
  const queue = new Queue(config.database, 100); const apps = inboxApps(config, queue);
  const pub = await listen(apps.publicApp, config, 0); const priv = await listen(apps.workerApp, config, 0);
  const publicUrl = `https://127.0.0.1:${pub.address().port}`, workerUrl = `https://127.0.0.1:${priv.address().port}`;
  return { ...t, config, auth, queue, identity, recipient, key_id, a, b, worker, publicUrl, workerUrl,
    client: { inbox_url: publicUrl, writer_id: 'a', token_file: join(t.dir, 'a.token'), recipient, key_id, spool_dir: join(t.dir, 'spool'), ca_file: config.cert_file },
    close: async () => { pub.closeAllConnections(); priv.closeAllConnections(); await Promise.all([new Promise(r => pub.close(r)), new Promise(r => priv.close(r))]); queue.close(); t.cleanup(); },
  };
}
export function raw(base, path, tokenValue, method = 'GET', body, ca, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(new URL(path, base), { method, ca: ca ? readFileSync(ca) : undefined, headers: { ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(data);
  });
}
export const planted = 'PLANTED-SECRET-4a13fc37-never-echo-this';
export const payload = { type: 'login', name: 'Test login', username: 'test@example.invalid', password: planted, urls: ['https://example.invalid/login'], notes: 'fixture', fields: [] };
