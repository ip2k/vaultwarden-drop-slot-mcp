import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { Importer } from '../dist/importer.js';
import { seal, fingerprint } from '../dist/protocol.js';
import { vaultItem, MARKER } from '../dist/vault.js';
import { temp, payload } from './helpers.mjs';

async function setup(vault) {
  const t = temp(); const identity = await generateIdentity(); const recipient = await identityToRecipient(identity);
  const keys = new Map([[fingerprint(recipient), identity]]); const destinations = { a: { mode: 'personal', allow_personal_vault: true } };
  const ledger = join(t.dir, 'ledger.sqlite');
  return { ...t, ledger, keys, destinations, importer: new Importer(ledger, keys, destinations, vault), job: { receipt: randomUUID(), lease: randomUUID(), writer_id: 'a', attempts: 1, envelope: await seal(recipient, 'a', randomUUID(), payload) } };
}
test('locked vault stays queued without create; ordinary success is verified once', async () => {
  let ready = false, creates = 0; const items = new Set();
  const vault = { ready: async () => ready, contains: async marker => items.has(marker), create: async (_p, marker) => { creates++; items.add(marker); } };
  const f = await setup(vault);
  try {
    assert.equal(await f.importer.process(f.job), 'locked'); assert.equal(creates, 0);
    ready = true; assert.equal(await f.importer.process(f.job), 'imported'); assert.equal(creates, 1);
    assert.equal(await f.importer.process(f.job), 'imported'); assert.equal(creates, 1);
    assert.equal(await f.importer.process({ ...f.job, writer_id: 'b' }), 'failed');
  } finally { f.importer.close(); f.cleanup(); }
});
test('ambiguous successful create reconciles after restart without another create', async () => {
  let creates = 0; const items = new Set();
  const vault = { ready: async () => true, contains: async marker => items.has(marker), create: async (_p, marker) => { creates++; items.add(marker); throw Error('response lost'); } };
  const f = await setup(vault);
  try {
    assert.equal(await f.importer.process(f.job), 'retry'); f.importer.close();
    f.importer = new Importer(f.ledger, f.keys, f.destinations, vault);
    assert.equal(await f.importer.process(f.job), 'imported'); assert.equal(creates, 1);
  } finally { f.importer.close(); f.cleanup(); }
});
test('persisted intent never retries a create even when no item is visible; no false imported state', async () => {
  let creates = 0;
  const vault = { ready: async () => true, contains: async () => false, create: async () => { creates++; throw Error('network lost'); } };
  const f = await setup(vault);
  try { for (let i = 0; i < 5; i++) assert.equal(await f.importer.process(f.job), 'retry'); assert.equal(creates, 1); }
  finally { f.importer.close(); f.cleanup(); }
});
test('concurrent importers sharing a ledger issue at most one create', async () => {
  let creates = 0; const items = new Set();
  const vault = { ready: async () => true, contains: async marker => items.has(marker), create: async (_p, marker) => { creates++; items.add(marker); } };
  const f = await setup(vault); const other = new Importer(f.ledger, f.keys, f.destinations, vault);
  try { await Promise.all([f.importer.process(f.job), other.process(f.job)]); assert.equal(creates, 1); }
  finally { other.close(); f.importer.close(); f.cleanup(); }
});
test('vault item mapping stores inert URLs and reserves the reconciliation field', () => {
  const destination = { mode: 'organization', organization_id: randomUUID(), collection_ids: [randomUUID()] };
  const item = vaultItem({ ...payload, urls: ['http://169.254.169.254/never-fetched'] }, 'opaque-marker', destination);
  assert.equal(item.type, 1); assert.equal(item.organizationId, destination.organization_id);
  assert.deepEqual(item.collectionIds, destination.collection_ids); assert.equal(item.fields.at(-1).name, MARKER);
  assert.equal(vaultItem({ type: 'secure_note', name: 'note', notes: 'body' }, 'marker', destination).type, 2);
  assert.throws(() => vaultItem({ ...payload, fields: [{ name: MARKER, value: 'spoof' }] }, 'marker', destination), /reserved_field/);
});
