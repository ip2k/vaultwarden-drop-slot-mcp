import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { seal, unseal, fingerprint, payloadSchema } from '../dist/protocol.js';
import { DepositClient } from '../dist/client.js';
import { Queue } from '../dist/store.js';
import { fixture, temp, save, raw, payload, planted } from './helpers.mjs';

test('age round trip binds writer/request and rejects wrong keys, tampering, and unknown fields', async () => {
  const identity = await generateIdentity(), recipient = await identityToRecipient(identity), requestId = randomUUID();
  const envelope = await seal(recipient, 'writer', requestId, payload);
  assert.equal((await unseal(identity, envelope, 'writer')).payload.password, planted);
  assert.equal(envelope.key_id, fingerprint(recipient));
  assert.ok(!JSON.stringify(envelope).includes(planted));
  for (const [key, item, writer] of [[await generateIdentity(), envelope, 'writer'], [identity, envelope, 'other'], [identity, { ...envelope, request_id: randomUUID() }, 'writer'], [identity, { ...envelope, ciphertext: envelope.ciphertext.slice(0, -12) + 'AAAAAAAAAAAA' }, 'writer']]) await assert.rejects(unseal(key, item, writer));
  assert.equal(payloadSchema.safeParse({ ...payload, organization_id: randomUUID() }).success, false);
  assert.equal(payloadSchema.safeParse({ ...payload, fields: Array(33).fill({ name: 'x', value: 'y' }) }).success, false);
  await assert.rejects(seal(recipient, 'writer', randomUUID(), { ...payload, notes: 'x'.repeat(32768), fields: Array(32).fill({ name: 'x', value: 'y'.repeat(4096) }) }));
});

test('HTTPS API enforces identity, own receipts, strict schemas, quotas and immediate revocation', async () => {
  const f = await fixture();
  try {
    const client = new DepositClient(f.client); const requestId = randomUUID();
    const result = await client.deposit(requestId, payload);
    assert.deepEqual(Object.keys(result).sort(), ['receipt', 'state']); assert.equal(result.state, 'queued');
    assert.deepEqual(await client.deposit(requestId, { ...payload, password: 'changed' }), result);
    const send = (path, tok = f.a, method = 'GET', body) => raw(f.publicUrl, path, tok, method, body, f.config.cert_file);
    assert.equal((await send(`/v1/receipts/${result.receipt}`, f.b)).status, 404);
    assert.equal((await send('/v1/recipient', undefined)).status, 200);
    assert.equal((await raw(f.publicUrl, '/v1/recipient', undefined, 'GET', undefined, f.config.cert_file)).status, 401);
    assert.equal((await send('/v1/recipient', f.worker)).status, 401);
    for (const path of ['/v1/items', '/v1/vault', '/internal/v1/claims']) assert.equal((await send(path)).status, 404);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await send(`/v1/receipts/${result.receipt}`, f.a, method)).status, 404);
    assert.equal((await raw(f.workerUrl, '/internal/v1/claims', f.a, 'POST', undefined, f.config.cert_file)).status, 401);
    const changed = await seal(f.recipient, 'a', requestId, payload);
    assert.equal((await send('/v1/deposits', f.a, 'POST', changed)).status, 409);
    const bad = await send('/v1/deposits', f.a, 'POST', { ...changed, [planted]: planted });
    assert.equal(bad.status, 400); assert.ok(!bad.text.includes(planted));
    assert.equal((await send('/v1/deposits', f.a, 'POST', { ...changed, ciphertext: Buffer.from('age-encryption.org/v1\n-> scrypt malicious-work-factor\n' + 'x'.repeat(128)).toString('base64') })).status, 400);
    assert.equal((await send('/v1/deposits', f.a, 'POST', { ...changed, ciphertext: 'a'.repeat(300000) })).status, 413);
    f.auth.writers[0].pending_limit = 1; save(f.config.auth_file, f.auth);
    await assert.rejects(client.deposit(randomUUID(), payload), /quota_exceeded/);
    f.auth.writers[0].revoked = true; save(f.config.auth_file, f.auth);
    await assert.rejects(client.status(result.receipt), /unauthorized/);
    f.auth.writers[0].revoked = false; f.auth.writers[0].expires_at = '2000-01-01T00:00:00.000Z'; save(f.config.auth_file, f.auth);
    await assert.rejects(client.status(result.receipt), /unauthorized/);
    await assert.rejects(raw(f.publicUrl, '/healthz'), /self-signed|certificate/);
    for (const name of readdirSync(f.dir).filter(n => n.startsWith('queue.sqlite'))) assert.ok(!readFileSync(join(f.dir, name)).includes(Buffer.from(planted)));
    for (const name of readdirSync(f.client.spool_dir)) assert.ok(!readFileSync(join(f.client.spool_dir, name)).includes(Buffer.from(planted)));
    assert.throws(() => new DepositClient({ ...f.client, key_id: '0'.repeat(64) }));
  } finally { await f.close(); }
});

test('durable queue fences stale workers, preserves idempotency after restart and purges ciphertext', async () => {
  const t = temp(); const path = join(t.dir, 'queue.sqlite'); let queue = new Queue(path);
  try {
    const identity = await generateIdentity(); const key = await identityToRecipient(identity);
    const envelope = await seal(key, 'a', randomUUID(), payload);
    const writer = { id: 'a', daily_limit: 2, pending_limit: 2 };
    const result = queue.deposit(writer, envelope, 1);
    queue.close(); queue = new Queue(path);
    assert.equal(queue.deposit(writer, envelope, 2).receipt, result.receipt);
    const first = queue.claim(3); assert.equal(queue.claim(4), null);
    const second = queue.claim(300004);
    assert.throws(() => queue.finish(first.receipt, first.lease, 'imported', 300005), /lease_conflict/);
    queue.finish(second.receipt, second.lease, 'locked', 300006);
    const third = queue.claim(360007); queue.finish(third.receipt, third.lease, 'imported', 360008);
    assert.equal(queue.status('a', result.receipt).state, 'imported');
    assert.equal(queue.db.prepare('SELECT ciphertext FROM deposits').get().ciphertext, null);
    assert.equal(queue.deposit(writer, envelope, 999999).state, 'imported');
    const another = await seal(key, 'a', randomUUID(), payload); queue.deposit(writer, another, 400000);
    queue.prune(1, 5000000);
    assert.equal(queue.db.prepare('SELECT COUNT(*) AS n FROM deposits WHERE ciphertext IS NOT NULL').get().n, 0);
  } finally { queue.close(); t.cleanup(); }
});
