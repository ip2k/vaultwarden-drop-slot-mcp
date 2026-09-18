import { identityToRecipient } from 'age-encryption';
import { z } from 'zod';
import { database, type Job } from './store.js';
import { digest, envelopeSchema, fingerprint, id, parse, SafeError, unseal, uuid } from './protocol.js';
import { readSecret, type Destination, type ImporterConfig } from './config.js';
import { jsonRequest } from './transport.js';
import { BitwardenVault, vaultItem, type Vault } from './vault.js';

export type Outcome = 'imported' | 'failed' | 'retry' | 'locked';
export class Importer {
  db: ReturnType<typeof database>;
  constructor(ledger: string, private identities: Map<string, string>, private destinations: Record<string, Destination>, private vault: Vault) {
    this.db = database(ledger);
    this.db.exec('CREATE TABLE IF NOT EXISTS deliveries (marker TEXT PRIMARY KEY, digest TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL)');
  }
  async process(job: Job): Promise<Outcome> {
    try {
      const destination = Object.hasOwn(this.destinations, job.writer_id) ? this.destinations[job.writer_id] : undefined;
      const identity = this.identities.get(job.envelope.key_id);
      if (!destination || !identity) return 'failed';
      const document = await unseal(identity, job.envelope, job.writer_id);
      const marker = digest(JSON.stringify(['drop-slot-v1', job.writer_id, document.request_id]));
      const contentDigest = digest(JSON.stringify(job.envelope));
      const destinationDigest = digest(JSON.stringify(destination));
      // Validate reserved fields before persisting a create intent.
      vaultItem(document.payload, marker, destination);
      const old = this.db.prepare('SELECT * FROM deliveries WHERE marker=?').get(marker);
      if (old && (old.digest !== contentDigest || old.destination !== destinationDigest)) return 'failed';
      if (old?.state === 'verified') return 'imported';
      if (!await this.vault.ready()) return 'locked';
      if (await this.vault.contains(marker, destination)) {
        this.db.prepare("INSERT INTO deliveries VALUES (?,?,?,'verified') ON CONFLICT(marker) DO UPDATE SET state='verified'").run(marker, contentDigest, destinationDigest);
        return 'imported';
      }
      if (old) return 'retry'; // Ambiguous previous create: reconciliation ONLY.
      const inserted = this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?,?,'intent')").run(marker, contentDigest, destinationDigest);
      if (inserted.changes !== 1) return 'retry';
      // Once durable intent exists, no automatic path can issue another create.
      await this.vault.create(document.payload, marker, destination);
      if (!await this.vault.contains(marker, destination)) return 'retry';
      this.db.prepare("UPDATE deliveries SET state='verified' WHERE marker=?").run(marker);
      return 'imported';
    } catch (error) {
      return error instanceof SafeError && ['invalid_envelope', 'reserved_field', 'duplicate_marker', 'vault_target_mismatch', 'cli_version_mismatch'].includes(error.code) ? 'failed' : 'retry';
    }
  }
  close(): void { this.db.close(); }
}
const jobSchema = z.strictObject({ receipt: uuid, writer_id: id, envelope: envelopeSchema, lease: uuid, attempts: z.number().int().min(1).max(5) });
export async function createImporter(config: ImporterConfig): Promise<Importer> {
  const identities = new Map<string, string>();
  for (const file of config.identity_files) {
    const identity = readSecret(file);
    if (!/^AGE-SECRET-KEY-1[A-Z0-9]+$/.test(identity)) throw new SafeError('invalid_identity');
    identities.set(fingerprint(await identityToRecipient(identity)), identity);
  }
  return new Importer(config.ledger, identities, config.destinations, new BitwardenVault(config));
}
export async function importOnce(config: ImporterConfig, importer: Importer): Promise<boolean> {
  const response = parse(z.strictObject({ job: jobSchema.nullable() }), await jsonRequest(config.worker_url, '/internal/v1/claims', readSecret(config.token_file), 'POST', undefined, config.ca_file, config));
  if (!response.job) return false;
  const result = await importer.process(response.job);
  await jsonRequest(config.worker_url, `/internal/v1/claims/${response.job.receipt}`, readSecret(config.token_file), 'POST', { lease: response.job.lease, result }, config.ca_file, config);
  return true;
}
