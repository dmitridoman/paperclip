/** Synthetic DD policy bridge. This is not Paperclip authentication or fencing. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterExecutionContext, AdapterExecutionResult, ServerAdapterModule } from '../packages/adapter-utils/src/types.js';

export const type = 'dom430_synthetic';
export const label = 'DOM-430 synthetic qualification';
const worker = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const sourceFile = fileURLToPath(import.meta.url);
const sourceDigest = () => createHash('sha256').update(fs.readFileSync(sourceFile)).update(fs.readFileSync(worker)).digest('hex');
// Root's frozen-source manifest remains the external trust anchor. This detects
// drift after module import; it is not a signed Paperclip source attestation.
const loadedSourceDigest = sourceDigest();
type Mode = 'finish' | 'wait' | 'unknown';
export interface LabAuthority {
  taskId: string; companyId: string; agentId: string; runId: string;
  generation: number; paused: boolean; allocationId: string; originalBudget: number; maxRunMs: number;
}
interface Operation {
  taskId: string; runId: string; hash: string; state: 'prepared' | 'held' | 'settled';
  result?: AdapterExecutionResult;
}
interface Ledger {
  allocations: Record<string, { id: string; original: number; used: number }>;
  operations: Record<string, Operation>;
}
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const errorResult = (code: string): AdapterExecutionResult => ({ exitCode: 1, signal: null, timedOut: false,
  errorCode: code, errorMessage: 'Synthetic qualification held or refused.', costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 }, usageBasis: 'per_run' });
function rootPath(): string {
  const root = process.env.DOM430_LAB_ROOT;
  if (!root || !path.isAbsolute(root) || !root.startsWith('/tmp/')) throw new Error('lab_root_required');
  const actual = fs.realpathSync(root);
  if (actual !== root || fs.statSync(root).mode & 0o077) throw new Error('lab_root_unsafe');
  const workspace = path.join(root, 'workspace');
  if (fs.realpathSync(workspace) !== workspace || fs.statSync(workspace).mode & 0o077) throw new Error('workspace_unsafe');
  return root;
}
function read<T>(p: string): T {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('lab_state_unsafe');
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as T;
  } finally { fs.closeSync(fd); }
}
function durable(p: string, value: unknown): void {
  const temp = p + '.new';
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, p);
  const dir = fs.openSync(path.dirname(p), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function locked<T>(root: string, fn: () => T): T {
  const lock = path.join(root, 'ledger.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  try { return fn(); } finally { fs.rmdirSync(lock); }
}
function ledger(root: string): Ledger {
  const p = path.join(root, 'ledger.json');
  return fs.existsSync(p) ? read<Ledger>(p) : { allocations: {}, operations: {} };
}
function authority(root: string, ctx: AdapterExecutionContext, generation: number): LabAuthority {
  const a = read<LabAuthority>(path.join(root, 'authority.json'));
  if (!safeId(a.taskId) || !safeId(a.allocationId) || a.taskId !== ctx.runtime.taskKey ||
      a.companyId !== ctx.agent.companyId || a.agentId !== ctx.agent.id || a.runId !== ctx.runId ||
      a.generation !== generation || !Number.isSafeInteger(generation) || generation < 1 ||
      a.paused !== false || !Number.isInteger(a.originalBudget) || a.originalBudget < 1 || a.originalBudget > 8 ||
      !Number.isInteger(a.maxRunMs) || a.maxRunMs < 50 || a.maxRunMs > 2000) throw new Error('authority_refused');
  return a;
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type, models: [], supportsLocalAgentJwt: false,
    async testEnvironment() {
      let status: 'pass' | 'fail' = 'pass';
      try { rootPath(); } catch { status = 'fail'; }
      return { adapterType: type, status, testedAt: new Date().toISOString(), checks: [{
        code: 'synthetic_only', level: status === 'pass' ? 'info' : 'error',
        message: 'Fixed synthetic worker requires a private disposable lab root.' }] };
    },
    async execute(ctx) {
      let root: string, requestId: string, generation: number, mode: Mode, hash: string;
      try {
        root = rootPath();
        if (sourceDigest() !== loadedSourceDigest) return errorResult('source_changed');
        const input = ctx.context.dom430 as Record<string, unknown>;
        if (!input || Object.keys(input).sort().join(',') !== 'generation,mode,requestId' ||
            !safeId(input.requestId) || !Number.isSafeInteger(input.generation) ||
            !['finish', 'wait', 'unknown'].includes(input.mode as string) ||
            !safeId(ctx.runId) || !safeId(ctx.runtime.taskKey) || !safeId(ctx.agent.companyId) || !safeId(ctx.agent.id) ||
            Object.keys(ctx.config).length !== 0 || ctx.executionTarget && ctx.executionTarget.kind !== 'local') {
          return errorResult('input_refused');
        }
        requestId = input.requestId; generation = input.generation as number; mode = input.mode as Mode;
        hash = createHash('sha256').update(JSON.stringify([ctx.agent.companyId, ctx.agent.id,
          ctx.runtime.taskKey, ctx.runId, generation, requestId, mode, loadedSourceDigest])).digest('hex');
        const admitted = locked(root, () => {
          const a = authority(root, ctx, generation), l = ledger(root);
          const old = l.operations[requestId];
          if (old) return old.hash !== hash ? errorResult('altered_request') :
            old.state === 'settled' ? old.result! : errorResult('effect_uncertain');
          if (Object.values(l.operations).some(o => o.taskId === a.taskId && o.state !== 'settled')) return errorResult('effect_uncertain');
          const budget = l.allocations[a.taskId] ?? { id: a.allocationId, original: a.originalBudget, used: 0 };
          if (budget.id !== a.allocationId || budget.original !== a.originalBudget) return errorResult('allocation_changed');
          if (budget.used >= budget.original) return errorResult('budget_exhausted');
          budget.used += 1; l.allocations[a.taskId] = budget;
          l.operations[requestId] = { taskId: a.taskId, runId: ctx.runId, hash, state: 'prepared' };
          durable(path.join(root, 'ledger.json'), l);
          return a;
        });
        if ('exitCode' in admitted) return admitted;
      } catch { return errorResult('admission_held'); }

      let effect: string | null = null, ready = false, stopped = false, protocolBad = false;
      let cancelled = false, timedOut = false, callbackBad = false, pid: number | null = null;
      let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      try {
        await ctx.onCancellationReady?.();
        if (ctx.signal?.aborted) { cancelled = true; }
        else {
          const a = authority(root, ctx, generation);
          ctx.onDispatch?.();
          authority(root, ctx, generation);
          if (sourceDigest() !== loadedSourceDigest) throw new Error('source_changed');
          const child = spawn(process.execPath, [worker], { shell: false, cwd: path.join(root, 'workspace'),
            env: { HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), PATH: '', LANG: 'C' },
            stdio: ['pipe', 'pipe', 'pipe'] });
          pid = child.pid ?? null;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => {
            child.kill('SIGTERM');
            killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
          };
          const abort = () => { cancelled = true; stop(); };
          const timer = setTimeout(() => { timedOut = true; stop(); }, a.maxRunMs);
          let buffer = '', bytes = 0;
          child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4096) { protocolBad = true; stop(); return; }
            buffer += chunk.toString();
            while (buffer.includes('\n')) {
              const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
              try {
                const msg = JSON.parse(line);
                if (msg.nonce !== hash) throw new Error();
                if (msg.kind === 'ready' && !ready && Object.keys(msg).length === 2) ready = true;
                else if (msg.kind === 'effect' && ready && !effect && Object.keys(msg).length === 3 &&
                  msg.digest === createHash('sha256').update('synthetic:' + hash).digest('hex')) effect = msg.digest;
                else if (msg.kind === 'stopped' && ready && !stopped && Object.keys(msg).length === 2) stopped = true;
                else throw new Error();
              } catch { protocolBad = true; stop(); }
            }
          });
          child.stderr.on('data', () => { protocolBad = true; stop(); });
          child.stdin.on('error', () => { protocolBad = true; stop(); });
          const settled = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
            child.once('error', () => { protocolBad = true; });
            child.once('close', (code, signal) => resolve({ code, signal }));
          });
          ctx.signal?.addEventListener('abort', abort, { once: true });
          if (ctx.signal?.aborted) abort();
          child.stdin.end(JSON.stringify({ nonce: hash, mode }) + '\n');
          try {
            if (pid) await ctx.onSpawn?.({ pid, processGroupId: null, startedAt: new Date().toISOString() });
          } catch { callbackBad = true; stop(); }
          closed = await settled;
          clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
          ctx.signal?.removeEventListener('abort', abort);
          if (buffer.length) protocolBad = true;
          if (pid) await ctx.onProviderStopped?.();
          if (ready) await ctx.onLog('stdout', 'Synthetic worker ready.\n');
        }
      } catch { callbackBad = true; }

      try {
        return locked(root, () => {
          const l = ledger(root), op = l.operations[requestId];
          const bound = !!op && op.hash === hash && op.state === 'prepared';
          let current = true; try { authority(root, ctx, generation); } catch { current = false; }
          const knownCancel = cancelled && !effect && (!pid || !!closed) && !protocolBad && !callbackBad;
          const success = current && ready && effect !== null && closed?.code === 0 && !cancelled && !timedOut && !protocolBad && !callbackBad;
          if (!bound || !success && !knownCancel) {
            if (op && op.hash === hash) { op.state = 'held'; durable(path.join(root, 'ledger.json'), l); }
            return errorResult('effect_uncertain');
          }
          const result: AdapterExecutionResult = { exitCode: 0, signal: closed?.signal ?? null, timedOut,
            costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 }, usageBasis: 'per_run',
            summary: knownCancel ? 'Synthetic worker stopped.' : 'Synthetic worker completed.',
            resultJson: { bridge: 'DD synthetic policy', requestId, runId: ctx.runId, generation,
              inputHash: hash, sourceDigest: loadedSourceDigest, effectDigest: effect, cancelled: knownCancel,
              stopReceipt: { pid, settled: !pid || !!closed, code: closed?.code ?? null, signal: closed?.signal ?? null, workerAcknowledged: stopped },
              allocation: l.allocations[op.taskId] } };
          op.state = 'settled'; op.result = result; durable(path.join(root, 'ledger.json'), l);
          return result;
        });
      } catch { return errorResult('effect_uncertain'); }
    },
  };
}
