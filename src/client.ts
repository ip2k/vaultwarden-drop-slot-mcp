import { mkdirSync, readFileSync, writeFileSync, readdirSync, linkSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { clientSchema, readSecret, type ClientConfig } from './config.js';
import { digest, envelopeSchema, parse, payloadSchema, receiptSchema, SafeError, seal, uuid, type Envelope, type Payload, type Receipt } from './protocol.js';
import { jsonRequest } from './transport.js';

export class DepositClient {
  config: ClientConfig;
  constructor(config: ClientConfig) { this.config = parse(clientSchema, config); }
  async prepare(requestId: string, payload: Payload): Promise<Envelope> {
    parse(uuid, requestId); parse(payloadSchema, payload);
    const c = this.config;
    mkdirSync(c.spool_dir, { recursive: true, mode: 0o700 });
    const file = join(c.spool_dir, `${digest(`${c.inbox_url}\n${c.writer_id}\n${requestId}`)}.json`);
    // Reusing an ID means retrying the original item, even if new arguments differ.
    // No plaintext hash is persisted (it would enable offline password guessing).
    try { return parse(envelopeSchema, JSON.parse(readFileSync(file, 'utf8'))); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new SafeError('spool_unavailable'); }
    if (readdirSync(c.spool_dir).length >= 10000) throw new SafeError('spool_full', 429);
    const envelope = await seal(c.recipient, c.writer_id, requestId, payload);
    const temporary = join(c.spool_dir, `.${randomUUID()}.pending`);
    try {
      writeFileSync(temporary, JSON.stringify(envelope), { flag: 'wx', mode: 0o600, flush: true });
      linkSync(temporary, file); // Publish a complete file atomically, without replacement.
      const directory = openSync(c.spool_dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return parse(envelopeSchema, JSON.parse(readFileSync(file, 'utf8')));
      throw new SafeError('spool_unavailable');
    } finally { try { unlinkSync(temporary); } catch {} }
    return envelope;
  }
  async submit(envelope: Envelope): Promise<Receipt> {
    const c = this.config;
    parse(envelopeSchema, envelope);
    // Old pinned envelopes remain retryable after a recipient rotation.
    return parse(receiptSchema, await jsonRequest(c.inbox_url, '/v1/deposits', readSecret(c.token_file), 'POST', envelope, c.ca_file, c));
  }
  async deposit(requestId: string, payload: Payload): Promise<Receipt> { return this.submit(await this.prepare(requestId, payload)); }
  async status(receipt: string): Promise<Receipt> {
    const c = this.config; parse(uuid, receipt);
    return parse(receiptSchema, await jsonRequest(c.inbox_url, `/v1/receipts/${receipt}`, readSecret(c.token_file), 'GET', undefined, c.ca_file, c));
  }
}
