import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { envelopeSchema, receiptSchema, documentSchema, payloadSchema } from '../dist/protocol.js';
import { toolManifest } from '../dist/mcp.js';
const schema = s => { const out = z.toJSONSchema(s, { io: 'input' }); delete out.$schema; return out; };
const json = name => ({ 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } });
const errors = Object.fromEntries([400,401,404,409,413,429,500].map(n => [n, { description: ({ 400: 'Invalid input or unknown encryption key', 401: 'Missing, expired, or revoked writer credential', 404: 'Not found, including another writer’s receipt', 409: 'Request ID already bound to another encrypted envelope', 413: 'Bounded input size exceeded', 429: 'Writer or installation quota exceeded', 500: 'Internal failure; no sensitive details returned' })[n], content: json('Error') }]));
errors[401].headers = { 'WWW-Authenticate': { description: 'Bearer authentication challenge', schema: { type: 'string', example: 'Bearer' } } };
errors[429].headers = { 'Retry-After': { description: 'Minimum seconds before another attempt; daily/pending limits may require a longer wait', schema: { type: 'string', example: '60' } } };
const readErrors = Object.fromEntries([400,401,404,500].map(code => [code, errors[code]]));
const envelope = schema(envelopeSchema); const receipt = schema(receiptSchema);
receipt.example = { receipt: '01234567-89ab-4def-8123-456789abcdef', state: 'queued' };
const description = 'Authenticated, create-only encrypted deposits. No vault read, search, edit, or delete operations. Recipients are pinned during enrollment; fetching a key never authorizes its replacement. JSON bodies are at most 256 KiB. Errors never include submitted values.';
const spec = {
  openapi: '3.1.0', info: { title: 'Vaultwarden Drop Slot Inbox', version: '1.0.0', description, contact: { name: 'Project maintainers', url: 'https://github.com/ip2k/vaultwarden-drop-slot-mcp/issues' }, license: { name: 'Apache-2.0', identifier: 'Apache-2.0' } },
  servers: [{ url: 'https://drop-slot.example.com', description: 'Your administrator-owned HTTPS inbox' }],
  security: [{ WriterToken: [] }], tags: [{ name: 'Deposits', description: 'Write-only envelope and receipt API' }],
  paths: {
    '/v1/recipient': { get: { operationId: 'getRecipient', summary: 'Get the current public recipient', description: 'Authenticated enrollment helper. Verify its fingerprint independently; never automatically trust a fetched replacement.', tags: ['Deposits'], responses: { 200: { description: 'Current public encryption recipient', content: json('Recipient') }, ...readErrors } } },
    '/v1/deposits': { post: { operationId: 'submitDeposit', summary: 'Queue an encrypted envelope', description: 'Requires a writer credential. Idempotency is scoped to writer and request_id; exact envelope replay returns the original receipt. Changed ciphertext returns 409. Public request_id and key_id use the protocol’s snake_case naming deliberately.', tags: ['Deposits'], requestBody: { required: true, description: 'An age X25519 envelope; payload is never plaintext here', content: json('Envelope') }, responses: { 202: { description: 'Accepted or an exact replay of a prior request', content: json('Receipt') }, ...errors } } },
    '/v1/receipts/{receipt}': { get: { operationId: 'getDepositStatus', summary: 'Get your own deposit state', description: 'Only queued, importing, imported, or failed. A foreign receipt is indistinguishable from an unknown receipt.', tags: ['Deposits'], parameters: [{ name: 'receipt', in: 'path', required: true, description: 'Opaque receipt issued to this writer', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Own delivery state only', content: json('Receipt') }, ...readErrors } } },
  },
  components: { securitySchemes: { WriterToken: { type: 'http', scheme: 'bearer', description: 'Per-writer random 256-bit token, stored hashed in the inbox' } }, schemas: {
    Envelope: envelope, Receipt: receipt,
    Recipient: { type: 'object', additionalProperties: false, required: ['version','recipient','key_id'], properties: { version: { type: 'integer', const: 1 }, recipient: { type: 'string', description: 'age X25519 public recipient' }, key_id: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 of the exact ASCII recipient' } } },
    Error: { type: 'object', additionalProperties: false, required: ['error'], properties: { error: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', description: 'Stable, non-sensitive error code' } } } } },
    EncryptedDocument: schema(documentSchema), Payload: schema(payloadSchema),
  } },
  'x-mcp-tools': toolManifest,
};
writeFileSync('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
writeFileSync('docs/tool-manifest.json', JSON.stringify({ tools: toolManifest }, null, 2) + '\n');
