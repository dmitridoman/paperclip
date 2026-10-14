// Fixed synthetic worker. One fixed local effect; no task command or provider.
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { openSync, writeSync, fsyncSync, closeSync, constants } from 'node:fs';

const lines = createInterface({ input: process.stdin });
lines.once('line', (line) => {
  const input = JSON.parse(line);
  if (Object.keys(input).sort().join(',') !== 'mode,nonce' ||
      !/^[0-9a-f]{64}$/.test(input.nonce) ||
      !['finish', 'wait', 'unknown'].includes(input.mode)) process.exit(2);
  const emit = (event) => process.stdout.write(JSON.stringify({ ...event, nonce: input.nonce }) + '\n');
  emit({ kind: 'ready' });
  const effect = createHash('sha256').update('synthetic:' + input.nonce).digest('hex');
  if (input.mode !== 'wait') {
    // Independent physical effect counter, distinct from the adapter journal.
    const fd = openSync('synthetic-effects.jsonl', constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify({ nonce: input.nonce, digest: effect }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  if (input.mode === 'unknown') {
    // Simulate an effect whose receipt is lost. The adapter cannot infer success.
    process.exit(3);
  }
  if (input.mode === 'finish') {
    emit({ kind: 'effect', digest: effect });
    process.exit(0);
  }
  process.once('SIGTERM', () => {
    emit({ kind: 'stopped' });
    process.exit(0);
  });
  setTimeout(() => process.exit(4), 5000);
});
