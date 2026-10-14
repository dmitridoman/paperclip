/** Trusted fixture entry: real external loader, fixed context, private pipe only. */
import { mkdtempSync, writeFileSync, rmSync, lstatSync, readdirSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
const schema = 'dom430.pc.bridge.v1';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
process.stdout.on('error', () => { process.exitCode = 1; process.stdin.pause(); });
process.stdin.on('error', () => { process.exitCode = 1; });
function absent(file) {
  try { lstatSync(file); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}
function routeRows(file) {
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(8193);
    let used = 0, count;
    while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, null)) > 0) used += count;
    if (used > 8192) throw new Error();
    const text = bytes.subarray(0, used).toString('utf8').trim();
    return text ? text.split('\n') : [];
  } finally { closeSync(fd); }
}
function boundary() {
  const home = homedir(), homeEntries = readdirSync(home);
  if (home !== '/home/worker' || homeEntries.length !== 0) throw new Error();
  const namespace = readlinkSync('/proc/self/ns/net');
  // /proc lists interface names even when the namespace loopback has no address.
  const devices = routeRows('/proc/net/dev');
  if (devices.length < 2) throw new Error();
  const names = devices.slice(2).map(row => row.slice(0, row.indexOf(':')).trim()).sort();
  if (!/^net:\[[0-9]{1,20}\]$/.test(namespace) || names.length > 16 ||
      names.some(name => !/^[A-Za-z0-9_.:-]{1,64}$/.test(name))) throw new Error();
  // Report route counts and interface names only. Route bytes and addresses are never emitted.
  const ipv4 = routeRows('/proc/net/route');
  if (!ipv4.length || !ipv4[0].startsWith('Iface')) throw new Error();
  const externalRouteCount = ipv4.slice(1).filter(row => row.trim().split(/\s+/)[0] !== 'lo').length +
    routeRows('/proc/net/ipv6_route').filter(row => row.trim().split(/\s+/).at(-1) !== 'lo').length;
  return { home, homeEntries,
    personalStateAbsent: ['.codex', '.claude', '.config'].every(name => absent(join('/home/dimz', name))),
    hostSocketsAbsent: ['/run/user/1001/bus', '/var/run/docker.sock'].every(absent),
    networkNamespace: namespace, networkInterfaces: names, externalRouteCount,
    telemetryDisabled: process.env.PAPERCLIP_TELEMETRY_DISABLED === '1' && process.env.DO_NOT_TRACK === '1' };
}
let root;
let result = { exitCode: 1, signal: null, timedOut: false, errorCode: 'client_held', errorMessage: 'Synthetic bridge held.', resultJson: { state: 'held', contained: false } };
try {
  const [toolId, requestId] = process.argv.slice(2);
  if (process.argv.length !== 4 || !['paperclip-synthetic-a', 'paperclip-synthetic-b'].includes(toolId) || !safeId(requestId)) throw new Error();
  process.stdout.write(JSON.stringify({ schema, kind: 'boundary', result: boundary() }) + '\n');
  // Set only this disposable client's logger; no instance settings or plugin store changes.
  process.env.NODE_ENV = 'production';
  process.env.PAPERCLIP_LOG_LEVEL = 'silent';
  root = mkdtempSync(join(tmpdir(), 'dom430-pc-bridge-'));
  const name = 'dom430-private-supervised-bridge';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': './index.mjs' } }), { mode: 0o600 });
  writeFileSync(join(root, 'index.mjs'), 'export { createServerAdapter } from ' + JSON.stringify(new URL('./adapter.ts', import.meta.url).href) + ';\n', { mode: 0o600 });
  const { loadExternalAdapterPackage } = await import('../server/src/adapters/plugin-loader.ts');
  const adapter = await loadExternalAdapterPackage(name, root);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    result = await adapter.execute({ runId: 'pc-' + requestId,
      agent: { id: toolId, companyId: 'dom430-flow-lab', name: 'Synthetic bridge fixture', adapterType: 'dom430_supervised_bridge', adapterConfig: {} },
      runtime: { taskKey: 'lab-issue-a', sessionId: null, sessionParams: null, sessionDisplayId: null },
      config: {}, context: { dom430: { requestId } }, signal: cancellation.signal,
      onLog: async () => {}, onCancellationReady: async () => {} });
  } finally { process.off('SIGTERM', cancel); process.off('SIGINT', cancel); }
} catch { /* No raw errors, paths or environment values enter the protocol. */ }
finally {
  try { if (root) rmSync(root, { recursive: true, force: true }); }
  catch { result = { exitCode: 1, signal: null, timedOut: false, errorCode: 'client_cleanup_held', errorMessage: 'Synthetic bridge held.', resultJson: { state: 'held', contained: false } }; }
}
process.stdin.pause();
process.exitCode = result.exitCode === 0 ? 0 : 1;
process.stdout.write(JSON.stringify({ schema, kind: 'adapter-result', result }) + '\n');
