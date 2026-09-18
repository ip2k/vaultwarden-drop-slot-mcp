import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { hash, id, recipient, parse, fingerprint, SafeError } from './protocol.js';

export const httpsUrl = z.string().url().refine((value) => {
  const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
});
export const clientSchema = z.strictObject({
  inbox_url: httpsUrl, writer_id: id, token_file: z.string().min(1),
  recipient, key_id: hash, spool_dir: z.string().min(1), ca_file: z.string().optional(),
  client_cert_file: z.string().optional(), client_key_file: z.string().optional(),
}).refine(c => fingerprint(c.recipient) === c.key_id && Boolean(c.client_cert_file) === Boolean(c.client_key_file));
export type ClientConfig = z.infer<typeof clientSchema>;
export const writerSchema = z.strictObject({
  id, token_hash: hash, expires_at: z.string().datetime(), revoked: z.boolean().default(false),
  daily_limit: z.number().int().min(1).max(10000).default(100),
  pending_limit: z.number().int().min(1).max(10000).default(100),
});
export type Writer = z.infer<typeof writerSchema>;
export const authSchema = z.strictObject({
  writers: z.array(writerSchema).min(1).max(1000), importer_token_hash: hash,
}).refine(c => new Set(c.writers.map(w => w.id)).size === c.writers.length && new Set([...c.writers.map(w => w.token_hash), c.importer_token_hash]).size === c.writers.length + 1);
const tls = { cert_file: z.string().min(1), key_file: z.string().min(1), client_ca_file: z.string().optional() };
export const inboxSchema = z.strictObject({
  ...tls, host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65535).default(8443),
  worker_port: z.number().int().min(1).max(65535).default(8444),
  auth_file: z.string().min(1), database: z.string().min(1),
  recipients: z.array(z.strictObject({ recipient, key_id: hash })).min(1).max(16),
  max_records: z.number().int().min(1).max(1000000).default(100000),
  retention_hours: z.number().int().min(1).max(8760).default(168),
}).refine(c => c.port !== c.worker_port && c.recipients.every(r => fingerprint(r.recipient) === r.key_id));
export type InboxConfig = z.infer<typeof inboxSchema>;
export const destinationSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('organization'), organization_id: z.string().uuid(), collection_ids: z.array(z.string().uuid()).min(1).max(32) }),
  z.strictObject({ mode: z.literal('personal'), allow_personal_vault: z.literal(true) }),
]);
export type Destination = z.infer<typeof destinationSchema>;
export const importerSchema = z.strictObject({
  worker_url: httpsUrl, token_file: z.string().min(1), ca_file: z.string().optional(),
  client_cert_file: z.string().optional(), client_key_file: z.string().optional(),
  identity_files: z.array(z.string().min(1)).min(1).max(16), ledger: z.string().min(1),
  bw_path: z.string().min(1), bw_sha256: hash, bw_version: z.literal('2026.8.0'),
  bw_state_dir: z.string().min(1), session_file: z.string().min(1), vault_url: httpsUrl,
  destinations: z.record(id, destinationSchema), poll_ms: z.number().int().min(1000).max(60000).default(5000),
}).refine(c => Boolean(c.client_cert_file) === Boolean(c.client_key_file));
export type ImporterConfig = z.infer<typeof importerSchema>;
export const remoteSchema = z.strictObject({
  ...tls, host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65535).default(8445),
  resource: httpsUrl, issuer: httpsUrl, jwks_url: httpsUrl,
  algorithm: z.enum(['RS256', 'ES256', 'EdDSA']).default('RS256'),
  bindings_file: z.string().min(1), allowed_origins: z.array(httpsUrl).default([]),
});
export const bindingsSchema = z.array(z.strictObject({ subject: z.string().min(1), client_id: z.string().min(1), client: clientSchema })).max(1000);
export type RemoteConfig = z.infer<typeof remoteSchema>;
export function readJson<T>(file: string, schema: z.ZodType<T>): T {
  try { return parse(schema, JSON.parse(readFileSync(file, 'utf8'))); }
  catch { throw new SafeError('invalid_configuration'); }
}
export function readSecret(file: string): string {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error();
    return readFileSync(file, 'utf8').trim();
  } catch { throw new SafeError('secret_unavailable'); }
}
