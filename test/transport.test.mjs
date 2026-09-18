import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, temp, certificate, save, payload, planted } from './helpers.mjs';
import { baseApp, listen } from '../dist/http.js';
import { jsonRequest } from '../dist/transport.js';
import { BitwardenVault } from '../dist/vault.js';
import { digest, token } from '../dist/protocol.js';

test('optional mTLS fails closed without the trusted client certificate', async () => {
  const f = await fixture(); const other = temp(); const wrong = certificate(other.dir);
  const app = baseApp(); app.get('/probe', (_req,res) => res.json({ status: 'ok' }));
  const server = await listen(app, { ...f.config, client_ca_file: f.config.cert_file }, 0);
  const url = `https://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(jsonRequest(url, '/probe', f.a, 'GET', undefined, f.config.cert_file));
    await assert.rejects(jsonRequest(url, '/probe', f.a, 'GET', undefined, f.config.cert_file, { client_cert_file: wrong.cert_file, client_key_file: wrong.key_file }));
    assert.deepEqual(await jsonRequest(url, '/probe', f.a, 'GET', undefined, f.config.cert_file, { client_cert_file: f.config.cert_file, client_key_file: f.config.key_file }), { status: 'ok' });
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); other.cleanup(); await f.close(); }
});

test('Bitwarden subprocess gets item via stdin, session via env, fixed verbs, and integrity pin', async () => {
  const t = temp(); const executable = join(t.dir, 'bw-fixture'); const spy = join(t.dir, 'spy.json'); const session = token();
  save(join(t.dir, 'session.txt'), session);
  const script = `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nlet input='';for await(const c of process.stdin) input+=c;\nif(args[0]==='--version') process.stdout.write('2026.8.0');\nelse if(args[0]==='status') process.stdout.write(JSON.stringify({status:'unlocked',serverUrl:'https://vault.example.invalid'}));\nelse if(args[0]==='create'){const item=JSON.parse(Buffer.from(input,'base64').toString());fs.writeFileSync(${JSON.stringify(spy)},JSON.stringify({args,hasSession:!!process.env.BW_SESSION,stdinPasswordMatches:item.login.password===${JSON.stringify(planted)},hasNodeOptions:!!process.env.NODE_OPTIONS}));process.stdout.write(JSON.stringify(item));}\n`;
  save(executable, script); chmodSync(executable, 0o700);
  const config = { bw_path: executable, bw_sha256: digest(script), bw_version: '2026.8.0', bw_state_dir: t.dir, session_file: join(t.dir, 'session.txt'), vault_url: 'https://vault.example.invalid' };
  try {
    assert.throws(() => new BitwardenVault({ ...config, bw_sha256: '0'.repeat(64) }), /cli_integrity_failed/);
    const vault = new BitwardenVault(config); assert.equal(await vault.ready(), true);
    await vault.create(payload, 'marker', { mode: 'personal', allow_personal_vault: true });
    const observed = JSON.parse(readFileSync(spy)); assert.deepEqual(observed.args, ['create','item','--nointeraction']);
    assert.equal(observed.stdinPasswordMatches, true); assert.equal(observed.hasSession, true); assert.equal(observed.hasNodeOptions, false);
    assert.ok(!readFileSync(spy, 'utf8').includes(planted)); assert.ok(!readFileSync(spy, 'utf8').includes(session));
  } finally { t.cleanup(); }
});
