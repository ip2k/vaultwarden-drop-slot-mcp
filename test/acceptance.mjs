// Opt-in, disposable stock Vaultwarden + OSS Bitwarden CLI compatibility check.
// Runs in the acceptance Docker target; never points at an existing vault.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright';
import { fixture, save, payload } from './helpers.mjs';
import { DepositClient } from '../dist/client.js';
import { BitwardenVault } from '../dist/vault.js';
import { Importer } from '../dist/importer.js';

const f = await fixture();
const vaultUrl = 'https://localhost:18443';
const proxy = createServer({ key: readFileSync(f.config.key_file), cert: readFileSync(f.config.cert_file) }, (req, res) => {
    const upstream = request({ hostname: 'vaultwarden', port: 80, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, reply => {
      const route = ['/api/config', '/api/sync', '/api/accounts/keys', '/api/accounts/prelogin', '/identity/accounts/prelogin', '/identity/connect/token'].find(path => req.url?.split('?')[0] === path);
      if (route) console.log('acceptance: fixed endpoint HTTP status', route, reply.statusCode);
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
  upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
await new Promise(r => proxy.listen(18443, r));
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
// Fixture-only self-signed certificate. The production transport's rejection of
// untrusted certificates is tested independently; no production bypass exists.
const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
const email = `acceptance-${randomUUID()}@example.invalid`; const password = randomBytes(32).toString('base64url');
const state = join(f.dir, 'bw'); mkdirSync(state, { mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: state, BITWARDENCLI_APPDATA_DIR: state, NODE_EXTRA_CA_CERTS: f.config.cert_file, DROP_SLOT_TEST_PASSWORD: password };
function bw(args) {
  return new Promise((resolve, reject) => execFile('/usr/local/bin/bw', [...args, '--nointeraction'], { env, timeout: 60000, maxBuffer: 8*1024*1024 }, (err, stdout, stderr) => {
    if (err) {
      const categories = ['password', 'certificate', 'ECONNREFUSED', 'fetch failed', 'unknown option', 'login failed', 'not logged in', 'two-step', 'verification', 'API key', 'unsupported', 'ENOTFOUND', 'EACCES', 'required', 'email', 'invalid', 'decrypt', 'connect', 'ENOENT', 'unknown', 'not found', 'Error', 'failed', 'refused', 'tls', 'network', 'timeout', 'response', 'undefined', 'null', 'wrong', 'again', 'permission', 'login', 'device', 'session'].filter(s => (stderr + stdout).toLowerCase().includes(s.toLowerCase()));
      const details = ['key', 'Key not found: User', 'SDK', 'WebAssembly', 'WASM', 'binding', 'module', 'config', 'fetch', '401', '404', '500', 'self-signed', 'resolve', 'EAI_AGAIN', 'Unexpected', 'entity', 'prelogin', 'device', 'User', 'rust', 'panic', 'ca cert', 'request to', 'localhost', 'api.bitwarden.com'].filter(s => (stderr + stdout).toLowerCase().includes(s.toLowerCase()));
      console.error('acceptance: CLI failure categories', JSON.stringify([...categories, ...details]), 'exit', typeof err.code === 'number' ? err.code : 'spawn', 'output sizes', stdout.length, stderr.length);
      reject(Error('stock CLI operation failed'));
    } else resolve(stdout.trim());
  }));
}
let importer; let checkpoint = 'registration';
try {
  await page.goto(vaultUrl, { waitUntil: 'networkidle' });
  console.log('acceptance: registration page loaded');
  await page.getByRole('link', { name: /create account/i }).click();
  await page.locator('input[type=email]').fill(email);
  const name = page.getByLabel(/^name$/i); if (await name.count()) await name.fill('Drop Slot Acceptance');
  let passwords = page.locator('input[type=password]');
  if (await passwords.count() === 0) {
    await page.getByRole('button', { name: /continue/i }).click();
    await page.locator('input[type=password]').first().waitFor();
  }
  passwords = page.locator('input[type=password]');
  for (let i = 0; i < await passwords.count(); i++) await passwords.nth(i).fill(password);
  // This isolated fixture cannot call the external breach-check service.
  const breachCheck = page.locator('#input-password-form_check-for-breaches');
  if (await breachCheck.count()) await breachCheck.uncheck();
  const registration = page.waitForResponse(r => r.url().includes('/accounts/register') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /create account/i }).click();
  const confirm = page.getByRole('button', { name: /submit|confirm|i understand/i });
  if (await confirm.count()) await confirm.first().click();
  assert.equal((await registration).status(), 200);
  checkpoint = 'organization setup';
  await page.getByRole('button', { name: /add it later/i }).click();
  await page.getByRole('link', { name: /skip to web app/i }).click();
  await page.waitForURL('**/#/vault**');
  await page.getByRole('button', { name: /^skip$/i }).click();
  await page.goto(`${vaultUrl}/#/create-organization`, { waitUntil: 'networkidle' });
  await page.locator('input').first().waitFor();
  await page.locator('input[type=text]').first().fill('Drop Slot Acceptance');
  await page.locator('input[type=email]').fill(email);
  const [orgResponse] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/organizations' && r.request().method() === 'POST'),
    page.locator('button[type=submit]').click(),
  ]);
  assert.equal(orgResponse.status(), 200);
  const organizationId = (await orgResponse.json()).id;
  assert.equal(typeof organizationId, 'string');
  checkpoint = 'CLI configuration';
  await bw(['config', 'server', vaultUrl]);
  assert.equal(JSON.parse(await bw(['status'])).serverUrl, vaultUrl);
  checkpoint = 'CLI login';
  const session = JSON.parse(await bw(['login', email, '--passwordenv', 'DROP_SLOT_TEST_PASSWORD', '--response'])).data.raw;
  assert.equal(typeof session, 'string');
  save(join(f.dir, 'session.txt'), session); env.BW_SESSION = session;
  console.log('acceptance: stock CLI authenticated to isolated Vaultwarden');
  const config = { bw_path: '/usr/local/bin/bw', bw_sha256: createHash('sha256').update(readFileSync('/usr/local/bin/bw')).digest('hex'), bw_version: '2026.8.0', bw_state_dir: state, session_file: join(f.dir, 'session.txt'), vault_url: vaultUrl, ca_file: f.config.cert_file };
  const vault = new BitwardenVault(config); assert.equal(await vault.ready(), true);
  const collections = JSON.parse(await bw(['list', 'org-collections', '--organizationid', organizationId]));
  assert.ok(collections.length > 0);
  const destination = { mode: 'organization', organization_id: organizationId, collection_ids: [collections[0].id] };
  importer = new Importer(join(f.dir, 'ledger.sqlite'), new Map([[f.key_id, f.identity]]), { a: destination }, vault);
  const client = new DepositClient(f.client);
  for (const item of [payload, { type: 'secure_note', name: 'Drop Slot Note Acceptance', notes: 'A new encrypted note', fields: [] }]) {
    const requestId = randomUUID(); const receipt = await client.deposit(requestId, item); const job = f.queue.claim(); assert.ok(job);
    const outcome = await importer.process(job); assert.equal(outcome, 'imported'); f.queue.finish(job.receipt, job.lease, outcome);
    assert.equal((await client.status(receipt.receipt)).state, 'imported'); assert.equal((await client.deposit(requestId, item)).receipt, receipt.receipt);
    assert.equal(await importer.process(job), 'imported');
  }
  await bw(['sync']); const items = JSON.parse(await bw(['list', 'items'])); assert.equal(items.length, 2);
  const login = items.find(item => item.type === 1); const note = items.find(item => item.type === 2);
  assert.equal(login.name, payload.name); assert.equal(login.login.password, payload.password); assert.equal(login.login.username, payload.username);
  assert.equal(note.notes, 'A new encrypted note');
  assert.ok(items.every(item => item.organizationId === organizationId && item.collectionIds.includes(collections[0].id)));
  console.log('acceptance: login and note verified in stock CLI; retries produced exactly two items');
  checkpoint = 'stock web client readback';
  await page.goto(`${vaultUrl}/#/vault`, { waitUntil: 'networkidle' });
  await page.getByText(payload.name, { exact: true }).first().click();
  await page.getByText(payload.username, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: /^close$/i }).first().click();
  await page.getByText('Drop Slot Note Acceptance', { exact: true }).first().click();
  await page.getByText('A new encrypted note', { exact: true }).first().waitFor();
  console.log('acceptance: stock web client opened both imported organization items');
} catch (error) {
  // Print UI labels only, never input values, page contents, CLI output or errors.
  console.error('acceptance: failed', checkpoint, error instanceof assert.AssertionError ? 'assertion' : error.name);
  console.error(JSON.stringify({ buttons: await page.getByRole('button').allTextContents(), links: await page.getByRole('link').allTextContents(), inputs: await page.locator('input').evaluateAll(nodes => nodes.map(n => ({ type: n.type, placeholder: n.placeholder, name: n.name, id: n.id }))) }));
  process.exitCode = 1;
} finally {
  importer?.close(); await browser.close(); proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); await f.close();
}
