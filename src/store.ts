import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, SafeError, type Envelope, type Receipt } from './protocol.js';
import type { Writer } from './config.js';

export function database(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  return db;
}
export interface Job { receipt: string; writer_id: string; envelope: Envelope; lease: string; attempts: number }
interface Row { receipt: string; writer: string; request_id: string; key_id: string; ciphertext: string | null; digest: string; state: Receipt['state']; lease: string; attempts: number }
export class Queue {
  db: DatabaseSync;
  constructor(file: string, private maxRecords = 100000) {
    this.db = database(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS deposits (
      receipt TEXT PRIMARY KEY, writer TEXT NOT NULL, request_id TEXT NOT NULL,
      key_id TEXT NOT NULL, ciphertext TEXT, digest TEXT NOT NULL, state TEXT NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, available INTEGER NOT NULL,
      lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      UNIQUE(writer, request_id));
      CREATE INDEX IF NOT EXISTS ready ON deposits(state, available, created);
      CREATE INDEX IF NOT EXISTS writer_state ON deposits(writer, state);
      CREATE TABLE IF NOT EXISTS quotas (writer TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(writer, day));`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deposit(writer: Writer, envelope: Envelope, now = Date.now()): Receipt {
    return this.transaction(() => {
      const contentDigest = digest(JSON.stringify(envelope));
      const old = this.db.prepare('SELECT * FROM deposits WHERE writer=? AND request_id=?').get(writer.id, envelope.request_id) as unknown as Row | undefined;
      if (old) {
        if (old.digest !== contentDigest) throw new SafeError('request_conflict', 409);
        return { receipt: old.receipt, state: old.state };
      }
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM deposits').get()!.n as number;
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE writer=? AND state IN ('queued','importing')").get(writer.id)!.n as number;
      const day = Math.floor(now / 86400000);
      const count = (this.db.prepare('SELECT count FROM quotas WHERE writer=? AND day=?').get(writer.id, day)?.count ?? 0) as number;
      if (total >= this.maxRecords || pending >= writer.pending_limit || count >= writer.daily_limit) throw new SafeError('quota_exceeded', 429);
      const receipt = randomUUID();
      this.db.prepare("INSERT INTO deposits (receipt,writer,request_id,key_id,ciphertext,digest,state,created,updated,available) VALUES (?,?,?,?,?,?,'queued',?,?,?)").run(receipt, writer.id, envelope.request_id, envelope.key_id, envelope.ciphertext, contentDigest, now, now, now);
      this.db.prepare('INSERT INTO quotas VALUES (?,?,1) ON CONFLICT(writer,day) DO UPDATE SET count=count+1').run(writer.id, day);
      return { receipt, state: 'queued' };
    });
  }
  status(writer: string, receipt: string): Receipt {
    const row = this.db.prepare('SELECT state FROM deposits WHERE receipt=? AND writer=?').get(receipt, writer);
    if (!row) throw new SafeError('not_found', 404);
    return { receipt, state: row.state as Receipt['state'] };
  }
  claim(now = Date.now()): Job | null {
    return this.transaction(() => {
      this.db.prepare("UPDATE deposits SET state='failed', updated=?, lease=NULL WHERE state='importing' AND lease_until<? AND attempts>=5").run(now, now);
      const row = this.db.prepare("SELECT * FROM deposits WHERE ciphertext IS NOT NULL AND attempts<5 AND ((state='queued' AND available<=?) OR (state='importing' AND lease_until<?)) ORDER BY created LIMIT 1").get(now, now) as unknown as Row | undefined;
      if (!row) return null;
      const lease = randomUUID();
      this.db.prepare("UPDATE deposits SET state='importing',lease=?,lease_until=?,updated=?,attempts=attempts+1 WHERE receipt=?").run(lease, now + 300000, now, row.receipt);
      return { receipt: row.receipt, writer_id: row.writer, envelope: { version: 1, key_id: row.key_id, request_id: row.request_id, ciphertext: row.ciphertext! }, lease, attempts: row.attempts + 1 };
    });
  }
  finish(receipt: string, lease: string, result: 'imported' | 'failed' | 'retry' | 'locked', now = Date.now()): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM deposits WHERE receipt=? AND lease=? AND state='importing' AND lease_until>=?").get(receipt, lease, now) as unknown as Row | undefined;
      if (!row) throw new SafeError('lease_conflict', 409);
      const retry = result === 'retry' || result === 'locked';
      const state = retry && (result === 'locked' || row.attempts < 5) ? 'queued' : retry ? 'failed' : result;
      this.db.prepare('UPDATE deposits SET state=?,updated=?,available=?,lease=NULL,lease_until=0,ciphertext=?,attempts=? WHERE receipt=?').run(
        state, now, now + (result === 'locked' ? 60000 : Math.min(300000, 1000 * 2 ** row.attempts)),
        result === 'imported' ? null : row.ciphertext, result === 'locked' ? Math.max(0, row.attempts - 1) : row.attempts, receipt,
      );
    });
  }
  prune(retentionHours: number, now = Date.now()): void {
    const cutoff = now - retentionHours * 3600000;
    this.db.prepare("UPDATE deposits SET state='failed',ciphertext=NULL,updated=? WHERE created<? AND ciphertext IS NOT NULL AND (state!='importing' OR lease_until<?)").run(now, cutoff, now);
    this.db.prepare('DELETE FROM quotas WHERE day<?').run(Math.floor(now / 86400000) - 1);
    // Keep compact tombstones: expiration must not silently re-enable a request ID.
  }
  close(): void { this.db.close(); }
}
