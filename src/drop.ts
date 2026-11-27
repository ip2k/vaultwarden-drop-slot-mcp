// `vault-drop <name>`: one-command interactive deposit with verified delivery.
// The secret arrives on stdin only (hidden TTY prompt or a pipe), never argv/env,
// and is never written anywhere except as the client's ciphertext spool entry.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DepositClient } from './client.js';
import { clientSchema, readJson } from './config.js';
import { SafeError, type Payload, type Receipt } from './protocol.js';

export const EXIT = { ok: 0, failure: 1, usage: 2, input: 3, config: 4, deposit: 5, import_failed: 6, timeout: 7, interrupted: 130 } as const;
export const LIMITS = { name: 256, password: 8192, note: 32768, username: 1024, url: 2048, urls: 16, input: 64 * 1024 } as const;
const TRANSIENT = new Set(['transport_failed', 'delivery_unavailable', 'invalid_response']);
const decoder = new TextDecoder('utf-8', { fatal: true });

export type InputStream = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type Output = { write(text: string): unknown };

/** Fixed-capacity byte buffer: no reallocation copies of the secret, zeroed on wipe. */
class SecretBuffer {
  bytes = Buffer.alloc(LIMITS.input); length = 0;
  push(byte: number): void { if (this.length >= this.bytes.length) throw new SafeError('input_too_large'); this.bytes[this.length++] = byte; }
  append(chunk: Uint8Array): void { for (const byte of chunk) this.push(byte); }
  backspace(): void {
    // Remove one whole UTF-8 code point: continuation bytes are 10xxxxxx.
    while (this.length > 0 && ((this.bytes[this.length - 1] ?? 0) & 0xc0) === 0x80) this.bytes[--this.length] = 0;
    if (this.length > 0) this.bytes[--this.length] = 0;
  }
  clear(): void { this.bytes.fill(0, 0, this.length); this.length = 0; }
  stripOneNewline(): void {
    if (this.bytes[this.length - 1] === 0x0a) { this.bytes[--this.length] = 0; if (this.bytes[this.length - 1] === 0x0d) this.bytes[--this.length] = 0; }
  }
  /** Decode strictly (a lossy decode would silently alter the secret), then wipe the bytes. */
  take(): string {
    try {
      if (this.length === 0) throw new SafeError('empty_input');
      try { return decoder.decode(this.bytes.subarray(0, this.length)); } catch { throw new SafeError('input_not_utf8'); }
    } finally { this.wipe(); }
  }
  wipe(): void { this.bytes.fill(0); this.length = 0; }
}

/** Piped input: everything up to EOF, minus exactly one trailing newline (LF or CRLF). */
export async function readPiped(input: AsyncIterable<Buffer | string>): Promise<string> {
  const secret = new SecretBuffer();
  try {
    for await (const chunk of input) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      try { secret.append(bytes); } finally { if (typeof chunk !== 'string') bytes.fill(0); }
    }
    secret.stripOneNewline();
    return secret.take();
  } finally { secret.wipe(); }
}

/**
 * Hidden TTY input in raw mode, so nothing is echoed. Single-line mode ends at
 * Enter and refuses a multi-line paste: anything left after the newline would
 * otherwise stay in the terminal queue and run as shell input after exit.
 * Multi-line mode (secure notes) ends at Ctrl-D. Ctrl-C cancels.
 */
export function readHidden(input: InputStream, prompt: Output, options: { multiline: boolean; text: string; settleMs?: number }): Promise<string> {
  const secret = new SecretBuffer(); const settleMs = options.settleMs ?? 150;
  let escape: 'none' | 'esc' | 'csi' | 'ss3' = 'none'; let lastCR = false; let done = false; let overflow = false;
  let restored = false;
  const restore = () => { if (restored) return; restored = true; input.removeListener('data', onData); try { input.setRawMode?.(false); } catch {} input.pause(); };
  process.once('exit', restore);
  let finish: (error?: SafeError) => void = () => {};
  const result = new Promise<string>((resolve, reject) => {
    finish = (error?: SafeError) => {
      if (done) return; done = true;
      const settle = (extra: boolean) => {
        restore(); process.removeListener('exit', restore); prompt.write('\n');
        if (error) { secret.wipe(); reject(error); return; }
        if (extra) { secret.wipe(); reject(new SafeError('multiline_input')); return; }
        try { if (options.multiline) secret.stripOneNewline(); resolve(secret.take()); } catch (err) { reject(err); }
      };
      if (error || options.multiline) { settle(false); return; }
      // Drain anything a paste delivered after the newline before handing the tty back.
      setTimeout(() => settle(overflow), settleMs);
    };
  });
  function onData(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    try {
      for (const byte of bytes) {
        if (done) { if (byte !== 0x0a || !lastCR) overflow = true; lastCR = false; continue; }
        if (escape === 'esc') { escape = byte === 0x5b ? 'csi' : byte === 0x4f ? 'ss3' : 'none'; continue; }
        if (escape === 'csi') { if (byte >= 0x40 && byte <= 0x7e) escape = 'none'; continue; }
        if (escape === 'ss3') { escape = 'none'; continue; }
        if (byte === 0x0a && lastCR) { lastCR = false; continue; }
        lastCR = byte === 0x0d;
        if (byte === 0x03) { finish(new SafeError('cancelled')); continue; }
        if (byte === 0x04) { finish(options.multiline ? undefined : new SafeError('cancelled')); continue; }
        if (byte === 0x0d || byte === 0x0a) { if (options.multiline) secret.push(0x0a); else finish(); continue; }
        if (byte === 0x7f || byte === 0x08) { secret.backspace(); continue; }
        if (byte === 0x15) { secret.clear(); continue; }
        if (byte === 0x1b) { escape = 'esc'; continue; }
        if (byte < 0x20 && byte !== 0x09) continue;
        secret.push(byte);
      }
    } catch (err) { finish(err instanceof SafeError ? err : new SafeError('invalid_input')); }
    finally { if (typeof chunk !== 'string') bytes.fill(0); }
  }
  // Raw mode (echo off) before the prompt appears, so a paste can never arrive while the tty still echoes.
  try { input.setRawMode?.(true); } catch { finish(new SafeError('terminal_unavailable')); return result; }
  prompt.write(options.text);
  input.on('data', onData); input.resume();
  return result;
}

export interface StatusClient { status(receipt: string): Promise<Receipt> }
export type WaitOutcome = { outcome: 'imported' | 'failed' | 'timeout' | 'interrupted'; state?: Receipt['state'] };

/**
 * Poll the writer's own receipt until it is final. States × events (and tests):
 *   queued/importing -> keep waiting; imported -> success; failed -> failure;
 *   transient transport error -> keep waiting; any other error -> throw;
 *   deadline -> timeout (deposited, not verified); abort signal -> interrupted.
 */
export async function waitForImport(client: StatusClient, receipt: string, options: { timeoutMs: number; intervalMs: number; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown> }): Promise<WaitOutcome> {
  const now = options.now ?? Date.now; const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const deadline = now() + options.timeoutMs; let state: Receipt['state'] | undefined;
  for (;;) {
    if (options.signal?.aborted) return { outcome: 'interrupted', state };
    try {
      state = (await client.status(receipt)).state;
      if (state === 'imported' || state === 'failed') return { outcome: state, state };
    } catch (err) { if (!(err instanceof SafeError) || !TRANSIENT.has(err.code)) throw err; }
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: 'timeout', state };
    try { await sleep(Math.min(options.intervalMs, remaining), options.signal); } catch { return { outcome: 'interrupted', state }; }
  }
}

export interface DropClient extends StatusClient { deposit(requestId: string, payload: Payload): Promise<Receipt>; forget(requestId: string): void }
export interface DropDeps {
  stdin: InputStream; stdout: Output; stderr: Output; env: NodeJS.ProcessEnv;
  client?: (configPath: string) => DropClient; signal?: AbortSignal; onDeposit?: () => void;
  intervalMs?: number; retryMs?: number; settleMs?: number; uuid?: () => string;
  now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  return env.VAULT_DROP_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vaultwarden-drop-slot', 'client.json');
}

const HELP = `vault-drop <name> [options]

Store a new secret in the vault through the drop slot, then wait until the
private importer confirms it was created. Paste the secret at the hidden
prompt and press Enter, or pipe it in (one trailing newline is removed).

  --note             Store a secure note instead of a login password
                     (at the prompt: paste, then press Ctrl-D)
  --username <name>  Login username
  --url <url>        Login URL (repeatable)
  --config <path>    Client config (default $VAULT_DROP_CONFIG, then
                     $XDG_CONFIG_HOME/vaultwarden-drop-slot/client.json)
  --timeout <sec>    How long to wait for verified import (default 120)
  --no-wait          Print the receipt after deposit without waiting
  --status <receipt> Report the state of an earlier deposit

Exit codes: 0 stored, 2 usage, 3 input, 4 config, 5 deposit, 6 import failed,
7 deposited but not yet verified, 130 interrupted.
`;

const EXPLAIN: Record<string, string> = {
  empty_input: 'no secret was entered', input_too_large: 'the input is larger than 64 KiB',
  input_not_utf8: 'the input is not valid UTF-8', multiline_input: 'the paste had more than one line; pipe multi-line secrets in, or use --note',
  cancelled: 'cancelled; nothing was stored', terminal_unavailable: 'could not switch the terminal to hidden input; pipe the secret in instead',
  secret_too_long: `a login password is limited to ${LIMITS.password} characters; use --note for longer secrets`, note_too_long: `a secure note is limited to ${LIMITS.note} characters`,
  invalid_configuration: 'the client config is missing or invalid', secret_unavailable: 'the writer token file is unreadable or not mode 0600',
  unauthorized: 'the inbox rejected the writer token (expired or revoked)', quota_exceeded: "this writer's deposit quota is used up; try again later",
  request_conflict: 'the inbox already holds a different item with this request ID', unknown_key: 'the inbox does not accept the pinned recipient key; re-enroll this client',
  item_too_large: 'the item is too large', transport_failed: 'could not reach the inbox', delivery_unavailable: 'the inbox returned an error',
  invalid_response: 'the inbox returned an unexpected response', invalid_envelope: 'the inbox rejected the encrypted item', spool_unavailable: 'the local ciphertext spool is not writable', spool_full: 'the local ciphertext spool is full',
  not_found: 'no such receipt for this writer', invalid_input: 'the item was rejected as invalid',
};
const explain = (code: string) => EXPLAIN[code] ?? 'unexpected error';
const codeOf = (err: unknown) => err instanceof SafeError ? err.code : 'operation_failed';
const statusCommand = (receipt: string) => `vault-drop --status ${receipt}`;

/** Returns the process exit code; never prints the secret, raw errors or validation detail. */
export async function main(argv: string[], deps: DropDeps): Promise<number> {
  const { stdout, stderr } = deps;
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      note: { type: 'boolean' }, username: { type: 'string' }, url: { type: 'string', multiple: true }, config: { type: 'string' },
      timeout: { type: 'string' }, 'no-wait': { type: 'boolean' }, status: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
  } catch { stderr.write('vault-drop: invalid arguments; see vault-drop --help\n'); return EXIT.usage; }
  const { values, positionals } = args;
  if (values.help) { stdout.write(HELP); return EXIT.ok; }
  const usage = (message: string) => { stderr.write(`vault-drop: ${message}; see vault-drop --help\n`); return EXIT.usage; };
  const timeoutSeconds = values.timeout === undefined ? 120 : Number(values.timeout);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) return usage('--timeout must be a whole number of seconds from 1 to 3600');
  const configPath = values.config ?? defaultConfigPath(deps.env);
  const open = deps.client ?? ((path: string) => new DepositClient(readJson(path, clientSchema)));

  if (values.status !== undefined) {
    if (positionals.length) return usage('--status takes only a receipt');
    let client: DropClient;
    try { client = open(configPath); } catch (err) { stderr.write(`✗ config: ${explain(codeOf(err))} (${configPath})\n`); return EXIT.config; }
    try {
      const { state } = await client.status(values.status);
      stdout.write(`${values.status} ${state}\n`);
      return state === 'imported' ? EXIT.ok : state === 'failed' ? EXIT.import_failed : EXIT.timeout;
    } catch (err) { stderr.write(`✗ status: ${explain(codeOf(err))}\n`); return EXIT.deposit; }
  }

  if (positionals.length !== 1) return usage('give exactly one secret name');
  const name = positionals[0] ?? '';
  if (name.trim().length === 0 || name.length > LIMITS.name) return usage(`the name must be 1 to ${LIMITS.name} characters`);
  const note = values.note === true; const urls = values.url ?? [];
  if (note && (values.username !== undefined || urls.length)) return usage('--username and --url apply to logins, not --note');
  if ((values.username?.length ?? 0) > LIMITS.username) return usage(`--username is limited to ${LIMITS.username} characters`);
  if (urls.length > LIMITS.urls || urls.some(u => u.length > LIMITS.url)) return usage(`at most ${LIMITS.urls} URLs of ${LIMITS.url} characters`);
  const fail = (stage: string, code: string, exit: number, tail = '') => { stderr.write(`✗ ${name}: ${stage} failed: ${explain(code)}${tail}\n`); return exit; };

  // Open the config before asking for the secret, so a broken setup fails first.
  let client: DropClient;
  try { client = open(configPath); } catch (err) { return fail('config', codeOf(err), EXIT.config, ` (${configPath})`); }

  let secret: string | undefined;
  try {
    secret = deps.stdin.isTTY
      ? await readHidden(deps.stdin, stderr, { multiline: note, settleMs: deps.settleMs, text: note ? `Secure note for "${name}" (hidden; paste, then Ctrl-D): ` : `Secret for "${name}" (hidden; paste, then Enter): ` })
      : await readPiped(deps.stdin);
    if (!note && secret.length > LIMITS.password) throw new SafeError('secret_too_long');
    if (note && secret.length > LIMITS.note) throw new SafeError('note_too_long');
  } catch (err) {
    secret = undefined; const code = codeOf(err);
    if (code === 'cancelled') { stderr.write(`vault-drop: ${explain(code)}\n`); return EXIT.interrupted; }
    return fail('input', code, EXIT.input);
  }

  const payload: Payload = note ? { type: 'secure_note', name, notes: secret } : { type: 'login', name, password: secret, username: values.username ?? '', urls };
  secret = undefined;
  const requestId = (deps.uuid ?? randomUUID)(); const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  deps.onDeposit?.();
  let receipt: Receipt | undefined;
  // The client spools the ciphertext under this request ID, so every retry resends the identical envelope.
  let maybeDelivered = false;
  for (let attempt = 1; ; attempt++) {
    try { receipt = await client.deposit(requestId, payload); break; }
    catch (err) {
      const code = codeOf(err); maybeDelivered ||= TRANSIENT.has(code);
      if (!TRANSIENT.has(code) || attempt >= 3) {
        const ambiguous = maybeDelivered ? '; an earlier attempt may still have reached the inbox and be queued (a locked importer delays it, so the vault may not show it yet); wait and check the vault before storing it again' : '';
        return fail('deposit', code, EXIT.deposit, ambiguous);
      }
      await sleep((deps.retryMs ?? 1000) * attempt).catch(() => {});
    }
  }
  if (values['no-wait']) { stdout.write(`✓ ${name} deposited; receipt ${receipt.receipt} (not yet verified: ${statusCommand(receipt.receipt)})\n`); return EXIT.ok; }

  let waited: WaitOutcome;
  try {
    waited = receipt.state === 'imported' || receipt.state === 'failed' ? { outcome: receipt.state }
      : await waitForImport(client, receipt.receipt, { timeoutMs: timeoutSeconds * 1000, intervalMs: deps.intervalMs ?? 2000, signal: deps.signal, now: deps.now, sleep: deps.sleep });
  } catch (err) { return fail('verify', codeOf(err), EXIT.deposit, `; deposited with receipt ${receipt.receipt} (${statusCommand(receipt.receipt)})`); }
  switch (waited.outcome) {
    case 'imported':
      try { client.forget(requestId); } catch {} // Best effort: the leftover entry is ciphertext only.
      stdout.write(`✓ ${name} stored and verified in the vault\n`); return EXIT.ok;
    case 'failed':
      stderr.write(`✗ ${name}: import failed: the importer could not create the item (receipt ${receipt.receipt}); the operator log on the importer host has the reason\n`); return EXIT.import_failed;
    case 'timeout':
      stderr.write(`✗ ${name}: verify timed out after ${timeoutSeconds}s: deposited (receipt ${receipt.receipt}, ${waited.state ?? 'queued'}) but the importer has not confirmed it; it may be locked. Check later: ${statusCommand(receipt.receipt)}\n`); return EXIT.timeout;
    case 'interrupted':
      stderr.write(`vault-drop: interrupted; deposited with receipt ${receipt.receipt}, import not yet verified: ${statusCommand(receipt.receipt)}\n`); return EXIT.interrupted;
  }
}
