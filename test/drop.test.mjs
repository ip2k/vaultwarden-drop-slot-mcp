import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPiped, readHidden, waitForImport, main, EXIT } from '../dist/drop.js';
import { SafeError } from '../dist/protocol.js';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { fingerprint } from '../dist/protocol.js';
import { fixture, save, planted } from './helpers.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'vault-drop.js');
const sink = () => { const out = { text: '', write(t) { out.text += t; return true; } }; return out; };
const codeOf = async promise => { try { await promise; return 'resolved'; } catch (err) { return err instanceof SafeError ? err.code : String(err); } };

function fakeTty() {
  const input = new PassThrough(); input.isTTY = true; input.modes = [];
  input.setRawMode = mode => { input.modes.push(mode); return input; };
  return input;
}
async function typed(chunks, options = {}) {
  const input = fakeTty(); const prompt = sink();
  const settled = readHidden(input, prompt, { multiline: false, text: 'prompt: ', settleMs: 20, ...options })
    .then(value => ({ value }), err => ({ error: err instanceof SafeError ? err.code : String(err) }));
  for (const chunk of chunks) { input.write(Buffer.from(chunk, 'utf8')); await new Promise(r => setImmediate(r)); }
  return { ...(await settled), input, prompt };
}

// ---- Piped input -------------------------------------------------------------

test('piped input removes exactly one trailing newline and zeroes the chunks it read', async () => {
  assert.equal(await readPiped(Readable.from([Buffer.from('s3cret\n')])), 's3cret');
  assert.equal(await readPiped(Readable.from([Buffer.from('s3cret\r\n')])), 's3cret');
  assert.equal(await readPiped(Readable.from([Buffer.from('s3cret')])), 's3cret');
  assert.equal(await readPiped(Readable.from([Buffer.from('a\n\n')])), 'a\n');
  assert.equal(await readPiped(Readable.from([Buffer.from('line1\nline2\n')])), 'line1\nline2');
  assert.equal(await readPiped(Readable.from([Buffer.from('pä'), Buffer.from('ss\n')])), 'päss');
  const chunk = Buffer.from('zero-me\n'); await readPiped(Readable.from([chunk]));
  assert.ok(chunk.every(b => b === 0));
});

test('piped input refuses empty, oversized and non-UTF-8 input', async () => {
  assert.equal(await codeOf(readPiped(Readable.from([]))), 'empty_input');
  assert.equal(await codeOf(readPiped(Readable.from([Buffer.from('\n')]))), 'empty_input');
  assert.equal(await codeOf(readPiped(Readable.from([Buffer.alloc(64 * 1024 + 1, 0x61)]))), 'input_too_large');
  assert.equal(await codeOf(readPiped(Readable.from([Buffer.from([0xff, 0xfe, 0x0a])]))), 'input_not_utf8');
});

// ---- Hidden TTY input ----------------------------------------------------------

test('TTY input is read in raw mode without echo, then the terminal is restored', async () => {
  const r = await typed([`${planted}\r`]);
  assert.equal(r.value, planted);
  assert.deepEqual(r.input.modes, [true, false]);
  assert.equal(r.prompt.text, 'prompt: \n');
  assert.ok(r.input.isPaused());
});

test('TTY editing keys: backspace removes a whole character, Ctrl-U clears, arrows are ignored', async () => {
  assert.equal((await typed(['abcé\x7f\x7fd\r'])).value, 'abd');
  assert.equal((await typed(['wrong\x15right\r'])).value, 'right');
  assert.equal((await typed(['ab\x1b[Dc\x1bOAd\r'])).value, 'abcd');
  assert.equal((await typed(['tab\there\r\n'])).value, 'tab\there');
});

test('TTY refuses empty input, cancels on Ctrl-C/Ctrl-D, and refuses a multi-line paste', async () => {
  assert.equal((await typed(['\r'])).error, 'empty_input');
  const cancelled = await typed(['half\x03']); assert.equal(cancelled.error, 'cancelled'); assert.deepEqual(cancelled.input.modes, [true, false]);
  assert.equal((await typed(['\x04'])).error, 'cancelled');
  assert.equal((await typed(['par\x04'])).error, 'cancelled', 'Ctrl-D never submits partial input');
  assert.equal((await typed(['line1\rline2\r'])).error, 'multiline_input');
  assert.equal((await typed(['line1\n', 'line2\n'])).error, 'multiline_input');
});

test('TTY note mode keeps newlines and ends at Ctrl-D', async () => {
  assert.equal((await typed(['line1\rline2\r\x04'], { multiline: true })).value, 'line1\nline2');
  assert.equal((await typed(['one\r\ntwo\x04'], { multiline: true })).value, 'one\ntwo');
  assert.equal((await typed(['\x04'], { multiline: true })).error, 'empty_input');
});

// ---- Waiting for verified import: states x events --------------------------------
// | event while waiting        | next                         | exit |
// | status queued / importing  | keep waiting                 |  -   |
// | status imported            | success, spool entry removed |  0   |
// | status failed              | import failed                |  6   |
// | transient transport error  | keep waiting                 |  -   |
// | other error (unauthorized) | stop: verify failed          |  5   |
// | deadline reached           | timeout, print receipt       |  7   |
// | interrupt (SIGINT)         | stop, print receipt          | 130  |

function scripted(...steps) {
  let i = 0; return { calls: () => i, status: async () => { const step = steps[Math.min(i++, steps.length - 1)]; if (step instanceof Error) throw step; return { receipt: 'r', state: step }; } };
}
const fast = { timeoutMs: 1000, intervalMs: 1, sleep: async () => {} };

test('wait loop follows the states-by-events table', async () => {
  assert.deepEqual(await waitForImport(scripted('queued', 'importing', 'imported'), 'r', fast), { outcome: 'imported', state: 'imported' });
  assert.deepEqual(await waitForImport(scripted('queued', 'failed'), 'r', fast), { outcome: 'failed', state: 'failed' });
  assert.equal((await waitForImport(scripted(new SafeError('transport_failed', 503), 'imported'), 'r', fast)).outcome, 'imported');
  assert.equal(await codeOf(waitForImport(scripted(new SafeError('unauthorized', 401)), 'r', fast)), 'unauthorized');
  let clock = 0; const timed = await waitForImport(scripted('queued'), 'r', { timeoutMs: 10, intervalMs: 4, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.deepEqual(timed, { outcome: 'timeout', state: 'queued' });
  const controller = new AbortController(); controller.abort();
  assert.equal((await waitForImport(scripted('queued'), 'r', { ...fast, signal: controller.signal })).outcome, 'interrupted');
});

// ---- The command against a real inbox -----------------------------------------

async function command(f, argv, input, options = {}) {
  const configPath = join(f.dir, 'client.json'); save(configPath, f.client);
  const stdout = sink(), stderr = sink();
  const stdin = typeof input === 'string' ? Readable.from([Buffer.from(input)]) : input;
  const code = await main(['--config', configPath, ...argv], { stdin, stdout, stderr, env: {}, intervalMs: 10, retryMs: 1, ...options });
  return { code, stdout: stdout.text, stderr: stderr.text };
}
// Stands in for the private importer: claim each job and report a fixed result.
function importer(f, result) {
  let stop = false;
  const loop = (async () => { while (!stop) { const job = f.queue.claim(); if (job) f.queue.finish(job.receipt, job.lease, result); await new Promise(r => setTimeout(r, 5)); } })();
  return async () => { stop = true; await loop; };
}
const spoolEntries = f => existsSync(f.client.spool_dir) ? readdirSync(f.client.spool_dir) : [];

test('vault-drop stores a piped secret, waits for verified import and prints one line', async () => {
  const f = await fixture(); const done = importer(f, 'imported');
  try {
    const r = await command(f, ['Example API key', '--username', 'svc@example.invalid', '--url', 'https://example.invalid'], `${planted}\n`);
    assert.equal(r.code, EXIT.ok); assert.equal(r.stdout, '✓ Example API key stored and verified in the vault\n'); assert.equal(r.stderr, '');
    assert.deepEqual(spoolEntries(f), [], 'verified deposits leave no spool entry');
  } finally { await done(); await f.close(); }
});

test('vault-drop reports import failure, timeout and --no-wait with the receipt, never the secret', async () => {
  const f = await fixture();
  try {
    const stopFailing = importer(f, 'failed');
    const failed = await command(f, ['Rejected item'], planted);
    await stopFailing();
    assert.equal(failed.code, EXIT.import_failed); assert.match(failed.stderr, /^✗ Rejected item: import failed: .*receipt [0-9a-f-]{36}/);

    const timedOut = await command(f, ['Locked importer', '--timeout', '1'], planted);
    assert.equal(timedOut.code, EXIT.timeout); assert.match(timedOut.stderr, /verify timed out after 1s: deposited \(receipt ([0-9a-f-]{36}), queued\).*vault-drop --status \1/);
    assert.equal(timedOut.stdout, '');

    const noWait = await command(f, ['Later', '--no-wait'], planted);
    assert.equal(noWait.code, EXIT.ok); assert.match(noWait.stdout, /^✓ Later deposited; receipt [0-9a-f-]{36} \(not yet verified/);
    const receipt = noWait.stdout.match(/receipt ([0-9a-f-]{36})/)[1];
    const queued = await command(f, ['--status', receipt], '');
    assert.equal(queued.code, EXIT.timeout); assert.equal(queued.stdout, `${receipt} queued\n`);

    for (const r of [failed, timedOut, noWait, queued]) { assert.ok(!r.stdout.includes(planted)); assert.ok(!r.stderr.includes(planted)); }
    for (const file of spoolEntries(f)) assert.ok(!readFileSync(join(f.client.spool_dir, file), 'utf8').includes(planted), 'spool holds ciphertext only');
  } finally { await f.close(); }
});

test('vault-drop checks arguments and config before reading the secret, and names the failing stage', async () => {
  const f = await fixture();
  try {
    const untouched = () => { const s = new PassThrough(); s.end(planted); return s; };
    assert.equal((await command(f, [], untouched())).code, EXIT.usage);
    assert.equal((await command(f, ['a', 'b'], untouched())).code, EXIT.usage);
    assert.equal((await command(f, ['x', '--note', '--username', 'u'], untouched())).code, EXIT.usage);
    assert.equal((await command(f, ['x', '--timeout', '0'], untouched())).code, EXIT.usage);
    assert.equal((await command(f, ['x', '--bogus'], untouched())).code, EXIT.usage);
    const stdin = untouched();
    const missing = await main(['x', '--config', join(f.dir, 'absent.json')], { stdin, stdout: sink(), stderr: sink(), env: {} });
    assert.equal(missing, EXIT.config); assert.equal(stdin.readableLength, Buffer.byteLength(planted), 'stdin was not consumed');
    chmodSync(f.client.token_file, 0o644);
    const loose = untouched(); const looseErr = sink();
    const looseCode = await main(['x', '--config', join(f.dir, 'client.json')], { stdin: loose, stdout: sink(), stderr: looseErr, env: {} });
    assert.equal(looseCode, EXIT.config); assert.match(looseErr.text, /writer token file is unreadable or not mode 0600/); assert.equal(loose.readableLength, Buffer.byteLength(planted));
    chmodSync(f.client.token_file, 0o600);
    const noCa = await command({ ...f, client: { ...f.client, ca_file: join(f.dir, 'absent-ca.crt') } }, ['x'], untouched());
    assert.equal(noCa.code, EXIT.config); assert.match(noCa.stderr, /CA or client certificate file/);

    const empty = await command(f, ['Empty'], '\n');
    assert.equal(empty.code, EXIT.input); assert.match(empty.stderr, /^✗ Empty: input failed: no secret was entered/);
    const long = await command(f, ['Long'], 'x'.repeat(8193));
    assert.equal(long.code, EXIT.input); assert.match(long.stderr, /--note/);

    save(f.client.token_file, 'not-the-writer-token');
    const rejected = await command(f, ['Revoked'], planted);
    assert.equal(rejected.code, EXIT.deposit); assert.match(rejected.stderr, /^✗ Revoked: deposit failed: the inbox rejected the writer token/);
    assert.ok(!rejected.stderr.includes(planted));
  } finally { await f.close(); }
});

test('vault-drop secure notes keep their lines', async () => {
  const f = await fixture(); let seen;
  const client = { deposit: async (_id, payload) => { seen = payload; return { receipt: '00000000-0000-4000-8000-000000000000', state: 'imported' }; }, status: async () => { throw new Error('unused'); }, forget: () => {} };
  try {
    const r = await command(f, ['Recovery codes', '--note'], 'code-1\ncode-2\n', { client: () => client });
    assert.equal(r.code, EXIT.ok); assert.deepEqual(seen, { type: 'secure_note', name: 'Recovery codes', notes: 'code-1\ncode-2' });
  } finally { await f.close(); }
});

test('definitive inbox rejections are not retried as transient, and ambiguity survives a later error', async () => {
  const f = await fixture();
  try {
    const recipient = await identityToRecipient(await generateIdentity());
    const r = await command({ ...f, client: { ...f.client, recipient, key_id: fingerprint(recipient) } }, ['Wrong key'], planted);
    assert.equal(r.code, EXIT.deposit); assert.match(r.stderr, /^✗ Wrong key: deposit failed: the inbox does not accept the pinned recipient key; re-enroll this client\n$/);

    const unknown = await command(f, ['--status', '00000000-0000-4000-8000-000000000000'], '');
    assert.equal(unknown.code, EXIT.deposit); assert.match(unknown.stderr, /no such receipt/);

    let attempt = 0;
    const flaky = { deposit: async () => { if (attempt++ === 0) throw new SafeError('transport_failed', 503); throw new SafeError('unauthorized', 401); }, status: async () => { throw new Error('unused'); }, forget: () => {} };
    const ambiguous = await command(f, ['Flaky'], planted, { client: () => flaky });
    assert.equal(ambiguous.code, EXIT.deposit); assert.equal(attempt, 2);
    assert.match(ambiguous.stderr, /rejected the writer token \(expired or revoked\); an earlier attempt may still have reached the inbox and be queued/);
  } finally { await f.close(); }
});

// ---- Real pseudo-terminal: the kernel's echo is really off -------------------------

const hasPython = (() => { try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const PTY_DRIVER = `
import os, pty, sys, select, time
secret = sys.stdin.buffer.read()
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out = b''
def pump(until, limit):
    global out
    end = time.time() + limit
    while time.time() < end and (until is None or until not in out):
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: data = os.read(fd, 4096)
            except OSError: return
            if not data: return
            out += data
pump(b'hidden', 15)
os.write(fd, secret + b'\\r')
pump(None, 15)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;

test('in a real pty the secret is never echoed and Enter submits it', { skip: !hasPython && 'python3 pty unavailable' }, async () => {
  const f = await fixture(); const configPath = join(f.dir, 'client.json'); save(configPath, f.client);
  try {
    const child = spawn('python3', ['-c', PTY_DRIVER, process.execPath, bin, '--no-wait', '--config', configPath, 'Pty item'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; child.stdout.on('data', c => { out += c; });
    child.stdin.end(planted);
    const code = await new Promise(r => child.on('close', r));
    assert.equal(code, 0, out);
    assert.match(out, /Secret for "Pty item" \(hidden; paste, then Enter\)/);
    assert.match(out, /✓ Pty item deposited; receipt [0-9a-f-]{36}/);
    assert.ok(!out.includes(planted), 'secret appeared on the terminal');
    for (const file of readdirSync(f.client.spool_dir)) assert.ok(!readFileSync(join(f.client.spool_dir, file), 'utf8').includes(planted));
  } finally { await f.close(); }
});
