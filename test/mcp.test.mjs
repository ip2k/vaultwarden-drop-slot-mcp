import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { remoteApp } from '../dist/mcp.js';
import { listen } from '../dist/http.js';
import { fixture, save, payload, raw, planted } from './helpers.mjs';

test('real stdio MCP exposes only two tools and keeps secrets out of replies and stderr', async () => {
  const f = await fixture(); const configPath = join(f.dir, 'client.json'); save(configPath, f.client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'stdio', configPath], stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', c => { errors += c; });
  const client = new Client({ name: 'acceptance', version: '1' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['deposit_secret', 'deposit_status']);
    const deposited = await client.callTool({ name: 'deposit_secret', arguments: { request_id: randomUUID(), payload } });
    assert.ok(!deposited.isError); assert.ok(!JSON.stringify(deposited).includes(planted));
    const receipt = deposited.structuredContent.receipt;
    const status = await client.callTool({ name: 'deposit_status', arguments: { receipt } }); assert.equal(status.structuredContent.state, 'queued');
    for (const name of ['list_items', 'get_secret', 'edit_item', 'delete_item']) {
      const result = await client.callTool({ name, arguments: { secret: planted } }); assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes(planted));
    }
    const invalid = await client.callTool({ name: 'deposit_secret', arguments: { request_id: randomUUID(), payload: { ...payload, [planted]: planted } } });
    assert.equal(invalid.isError, true); assert.ok(!JSON.stringify(invalid).includes(planted));
    f.auth.writers[0].revoked = true; save(f.config.auth_file, f.auth);
    assert.equal((await client.callTool({ name: 'deposit_status', arguments: { receipt } })).isError, true);
    assert.ok(!errors.includes(planted));
  } finally { await client.close(); await f.close(); }
});

test('remote MCP validates OAuth, resource discovery, origin, scope, audience, bindings and direct tools', async () => {
  const f = await fixture(); const wrapper = express(); const server = await listen(wrapper, f.config, 0);
  const base = `https://127.0.0.1:${server.address().port}`; const resource = `${base}/mcp`;
  const keys = await generateKeyPair('ES256'); const jwk = await exportJWK(keys.publicKey); jwk.kid = 'test-key';
  const bindings = [{ subject: 'user-a', client_id: 'test-client', client: f.client }]; const bindings_file = join(f.dir, 'bindings.json'); save(bindings_file, bindings);
  const config = { ...f.config, resource, issuer: 'https://issuer.example.invalid', jwks_url: 'https://issuer.example.invalid/keys', algorithm: 'ES256', bindings_file, allowed_origins: [] };
  wrapper.use(remoteApp(config, createLocalJWKSet({ keys: [jwk] })));
  const sign = (changes = {}) => new SignJWT({ sub: 'user-a', client_id: 'test-client', scope: 'deposits:write deposits:status', iss: config.issuer, aud: resource, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 60, ...changes }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(keys.privateKey);
  const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
  const send = (tok, body, headers = {}) => raw(base, '/mcp', tok, 'POST', body, f.config.cert_file, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers });
  try {
    const noAuth = await send(undefined, rpc('tools/list')); assert.equal(noAuth.status, 401); assert.match(noAuth.headers['www-authenticate'], /resource_metadata/);
    const metadata = await raw(base, '/.well-known/oauth-protected-resource/mcp', undefined, 'GET', undefined, f.config.cert_file); assert.equal(JSON.parse(metadata.text).resource, resource);
    for (const changes of [{ aud: 'https://elsewhere.invalid/mcp' }, { iss: 'https://other.invalid' }, { exp: 1 }, { scope: 'deposits:write' }, { sub: 'other' }, { client_id: 'other' }]) assert.equal((await send(await sign(changes), rpc('tools/list'))).status, 401);
    const tok = await sign();
    assert.equal((await send(tok, rpc('tools/list'), { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await send(tok, rpc('tools/list'), { host: `localhost:${server.address().port}` })).status, 403);
    const listed = await send(tok, rpc('tools/list')); assert.equal(listed.status, 200); assert.equal(JSON.parse(listed.text).result.tools.length, 2);
    const deposited = await send(tok, rpc('tools/call', { name: 'deposit_secret', arguments: { request_id: randomUUID(), payload } }));
    assert.equal(deposited.status, 200); assert.ok(!deposited.text.includes(planted)); assert.ok(JSON.parse(deposited.text).result.structuredContent.receipt);
    const direct = await send(tok, rpc('tools/call', { name: 'get_secret', arguments: { name: planted } })); assert.equal(JSON.parse(direct.text).result.isError, true); assert.ok(!direct.text.includes(planted));
    for (const body of [rpc(planted), rpc('tools/call', { name: { [planted]: planted } }), { jsonrpc: planted, id: 1, method: 'tools/list' }]) {
      const rejected = await send(tok, body); assert.ok(!rejected.text.includes(planted));
    }
    save(bindings_file, []); assert.equal((await send(tok, rpc('tools/list'))).status, 401);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); }
});
