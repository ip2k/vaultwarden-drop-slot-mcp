import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { Encrypter, Decrypter } from 'age-encryption';

export const MAX_BODY = 256 * 1024;
export const MAX_PLAINTEXT = 64 * 1024;
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const uuid = z.string().uuid();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const recipient = z.string().regex(/^age1[a-z0-9]{58}$/);
const fields = z.array(z.strictObject({ name: z.string().min(1).max(128), value: z.string().max(4096), hidden: z.boolean().default(true) })).max(32).default([]);
const common = { name: z.string().min(1).max(256), notes: z.string().max(32768).default(''), fields };
export const payloadSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('login'), username: z.string().max(1024).default(''), password: z.string().max(8192), urls: z.array(z.string().max(2048)).max(16).default([]) }),
  z.strictObject({ ...common, type: z.literal('secure_note') }),
]);
export type Payload = z.input<typeof payloadSchema>;
export const documentSchema = z.strictObject({ version: z.literal(1), writer_id: id, request_id: uuid, payload: payloadSchema });
export const envelopeSchema = z.strictObject({ version: z.literal(1), key_id: hash, request_id: uuid, ciphertext: z.string().min(100).max(180000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) });
export type Envelope = z.infer<typeof envelopeSchema>;
export const statusSchema = z.enum(['queued', 'importing', 'imported', 'failed']);
export const receiptSchema = z.strictObject({ receipt: uuid, state: statusSchema });
export type Receipt = z.infer<typeof receiptSchema>;
export class SafeError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function token(): string { return randomBytes(32).toString('base64url'); }
export function fingerprint(key: string): string { return digest(recipient.parse(key)); }
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SafeError('invalid_input');
  return result.data;
}
export function encryptedBytes(envelope: Envelope): Buffer {
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  // Restrict untrusted age headers before any expensive decryption work.
  const header = bytes.subarray(0, 200).toString('ascii');
  if (!/^age-encryption.org\/v1\n-> X25519 [A-Za-z0-9+/]{43}\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n/.test(header)) throw new SafeError('invalid_envelope');
  return bytes;
}
export async function seal(key: string, writerId: string, requestId: string, payload: Payload): Promise<Envelope> {
  const document = parse(documentSchema, { version: 1, writer_id: writerId, request_id: requestId, payload });
  const plaintext = JSON.stringify(document);
  if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT) throw new SafeError('item_too_large', 413);
  const encrypter = new Encrypter();
  encrypter.addRecipient(parse(recipient, key));
  const ciphertext = Buffer.from(await encrypter.encrypt(plaintext)).toString('base64');
  return { version: 1, key_id: fingerprint(key), request_id: requestId, ciphertext };
}
export async function unseal(identity: string, envelope: Envelope, writerId: string): Promise<z.infer<typeof documentSchema>> {
  try {
    // Only our bounded, single-recipient X25519 format is accepted. In particular,
    // an unauthenticated scrypt work factor must never reach the age decoder.
    const bytes = encryptedBytes(envelope);
    const decrypter = new Decrypter(); decrypter.addIdentity(identity);
    const plaintext = await decrypter.decrypt(bytes, 'text');
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT) throw new Error();
    const doc = documentSchema.parse(JSON.parse(plaintext));
    if (doc.request_id !== envelope.request_id || doc.writer_id !== writerId) throw new Error();
    return doc;
  } catch { throw new SafeError('invalid_envelope'); }
}
