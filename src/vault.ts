import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digest, SafeError, type Payload } from './protocol.js';
import { readSecret, type Destination, type ImporterConfig } from './config.js';

export const MARKER = 'vaultwarden-drop-slot:submission:v1';
export interface Vault {
  ready(): Promise<boolean>;
  contains(marker: string, destination: Destination): Promise<boolean>;
  create(payload: Payload, marker: string, destination: Destination): Promise<void>;
}
export function vaultItem(payload: Payload, marker: string, destination: Destination): Record<string, unknown> {
  if (payload.fields?.some(f => f.name.startsWith('vaultwarden-drop-slot:'))) throw new SafeError('reserved_field');
  return {
    type: payload.type === 'login' ? 1 : 2, name: payload.name, notes: payload.notes ?? '',
    favorite: false, reprompt: 0,
    organizationId: destination.mode === 'organization' ? destination.organization_id : null,
    collectionIds: destination.mode === 'organization' ? destination.collection_ids : [],
    fields: [...(payload.fields ?? []).map(f => ({ name: f.name, value: f.value, type: f.hidden !== false ? 1 : 0 })), { name: MARKER, value: marker, type: 1 }],
    ...(payload.type === 'login' ? { login: { username: payload.username ?? '', password: payload.password, totp: null, uris: (payload.urls ?? []).map(uri => ({ uri, match: null })) } } : { secureNote: { type: 0 } }),
  };
}
export class BitwardenVault implements Vault {
  private verified = false;
  constructor(private config: ImporterConfig) {
    if (resolve(config.bw_path) !== config.bw_path || digest(readFileSync(config.bw_path)) !== config.bw_sha256) throw new SafeError('cli_integrity_failed');
  }
  private async run(args: string[], input?: string): Promise<string> {
    const c = this.config;
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: c.bw_state_dir,
      BITWARDENCLI_APPDATA_DIR: c.bw_state_dir, BW_SESSION: readSecret(c.session_file),
      ...(c.ca_file ? { NODE_EXTRA_CA_CERTS: c.ca_file } : {}),
    };
    return new Promise((resolvePromise, reject) => {
      const child = spawn(c.bw_path, [...args, '--nointeraction'], { env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = []; let length = 0; let over = false;
      const timeout = setTimeout(() => { over = true; child.kill('SIGKILL'); }, 30000);
      child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8 * 1024 * 1024) { over = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timeout); reject(new SafeError('vault_unavailable', 503)); });
      child.on('close', code => { clearTimeout(timeout); if (code !== 0 || over) reject(new SafeError('vault_unavailable', 503)); else resolvePromise(Buffer.concat(chunks).toString('utf8').trim()); });
      child.stdin.end(input ?? '');
    });
  }
  async ready(): Promise<boolean> {
    try {
      if (!this.verified) {
        if (await this.run(['--version']) !== this.config.bw_version) throw new SafeError('cli_version_mismatch');
        this.verified = true;
      }
      const status = JSON.parse(await this.run(['status'])) as { status?: string; serverUrl?: string };
      if (status.serverUrl?.replace(/\/$/, '') !== this.config.vault_url.replace(/\/$/, '')) throw new SafeError('vault_target_mismatch');
      return status.status === 'unlocked';
    } catch (error) {
      if (error instanceof SafeError && error.code === 'secret_unavailable') return false;
      throw error;
    }
  }
  async contains(marker: string, destination: Destination): Promise<boolean> {
    await this.run(['sync']);
    const items: unknown = JSON.parse(await this.run(['list', 'items', ...(destination.mode === 'organization' ? ['--organizationid', destination.organization_id] : [])]));
    if (!Array.isArray(items)) throw new SafeError('vault_unavailable', 503);
    const found = items.filter(item => {
      if (!item || item.deletedDate) return false;
      const target = destination.mode === 'personal' ? !item.organizationId : item.organizationId === destination.organization_id && destination.collection_ids.every(id => item.collectionIds?.includes(id));
      return target && Array.isArray(item.fields) && item.fields.some((f: { name?: unknown; value?: unknown }) => f.name === MARKER && f.value === marker);
    });
    if (found.length > 1) throw new SafeError('duplicate_marker');
    return found.length === 1;
  }
  async create(payload: Payload, marker: string, destination: Destination): Promise<void> {
    const item = vaultItem(payload, marker, destination);
    // Bitwarden accepts the base64 document on stdin. Never pass it in argv.
    await this.run(['create', 'item'], Buffer.from(JSON.stringify(item)).toString('base64'));
  }
}
