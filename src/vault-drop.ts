#!/usr/bin/env node
// Thin executable for `vault-drop`; the logic and its tests live in drop.ts.
import { main } from './drop.js';

process.umask(0o077);
const controller = new AbortController();
let deposited = false;
// Before the deposit, Ctrl-C simply exits (the hidden prompt restores the terminal on exit).
// After it, stop waiting and print the receipt so the item can still be checked.
process.on('SIGINT', () => { if (!deposited) process.exit(130); controller.abort(); });
main(process.argv.slice(2), {
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env,
  signal: controller.signal, onDeposit: () => { deposited = true; },
}).then(code => { process.exitCode = code; }, () => { process.stderr.write('vault-drop: unexpected error\n'); process.exitCode = 1; });
