/** Private synthetic bridge; the parent DD controller owns every execution right. */
import type { Readable, Writable } from 'node:stream';
import type { AdapterExecutionContext, AdapterExecutionResult, ServerAdapterModule } from '../packages/adapter-utils/src/types.js';

export const type = 'dom430_supervised_bridge';
export const schema = 'dom430.pc.bridge.v1';
export const MAX_FRAME_BYTES = 8192;
const POLL_MS = 100;
const RPC_TIMEOUT_MS = 30_000; // Channel liveness only, never the task deadline.
const tools = new Set(['paperclip-synthetic-a', 'paperclip-synthetic-b']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const id = (v: unknown, max = 96): v is string => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => uint(v) && v > 0;
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));

export interface Binding { requestId: string; taskId: 'lab-issue-a'; runId: string; toolId: string }
export interface Snapshot {
  state: 'running' | 'founder' | 'held' | 'complete';
  runId: string; leaseId: string; fence: number; generation: number;
  budget: { originalTokens: number; reservedTokens: number; remainingTokens: number; deadlineMs: number; dbTimeMs: number };
  identity: { unit: string; pid?: number; startTicks?: number };
  contained: boolean;
  ddRunId?: string; reason?: string;
  freezeReceipt?: Record<string, unknown>; restoreReceipt?: Record<string, unknown>;
}
export type Operation = 'start' | 'status' | 'cancel';
function validBinding(v: Binding): boolean {
  return record(v) && keys(v, ['requestId', 'taskId', 'runId', 'toolId']) && id(v.requestId, 64) &&
    v.taskId === 'lab-issue-a' && id(v.runId) && tools.has(v.toolId);
}
function snapshot(value: unknown, binding: Binding): Snapshot {
  if (!record(value) || !keys(value, ['state', 'runId', 'leaseId', 'fence', 'generation', 'budget', 'identity', 'contained'], ['ddRunId', 'reason', 'freezeReceipt', 'restoreReceipt']) ||
      !['running', 'founder', 'held', 'complete'].includes(value.state as string) || value.runId !== binding.runId ||
      !id(value.leaseId) || !positive(value.fence) || !positive(value.generation) || typeof value.contained !== 'boolean' ||
      value.ddRunId !== undefined && !id(value.ddRunId) || value.reason !== undefined && !id(value.reason)) throw new Error('invalid_response');
  const b = value.budget, i = value.identity;
  if (!record(b) || !keys(b, ['originalTokens', 'reservedTokens', 'remainingTokens', 'deadlineMs', 'dbTimeMs']) ||
      !positive(b.originalTokens) || !uint(b.reservedTokens) || !uint(b.remainingTokens) || !positive(b.deadlineMs) || !positive(b.dbTimeMs) ||
      b.reservedTokens > b.originalTokens || b.remainingTokens > b.originalTokens || b.reservedTokens + b.remainingTokens !== b.originalTokens ||
      !record(i) || !keys(i, ['unit'], ['pid', 'startTicks']) || !id(i.unit, 128) ||
      i.pid !== undefined && !positive(i.pid) || i.startTicks !== undefined && !positive(i.startTicks)) throw new Error('invalid_response');
  const f = value.freezeReceipt;
  if (f !== undefined && (!record(f) || !keys(f, ['verified', 'unit', 'pid', 'startTicks', 'counterBefore', 'counterAfter']) ||
      typeof f.verified !== 'boolean' || !id(f.unit, 128) || !positive(f.pid) || !positive(f.startTicks) || !uint(f.counterBefore) || !uint(f.counterAfter))) throw new Error('invalid_response');
  const r = value.restoreReceipt;
  if (r !== undefined && (!record(r) || !keys(r, ['verified', 'sourceSlot', 'successorSlot', 'snapshotDigest', 'leaseId', 'fence', 'generation']) ||
      typeof r.verified !== 'boolean' || !id(r.sourceSlot) || !id(r.successorSlot) || !id(r.leaseId) || !positive(r.fence) || !positive(r.generation) ||
      typeof r.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.snapshotDigest))) throw new Error('invalid_response');
  return value as unknown as Snapshot;
}

/** One channel, one pending request, monotonic IDs; transport failures are irreversible. */
export class BridgeRpc {
  private nextId = 1;
  private failed = false;
  private pending: { id: number; binding: Binding; resolve: (v: Snapshot) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private buffer = Buffer.alloc(0);
  private readonly onData = (chunk: Buffer | string) => {
    if (this.failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Bound the complete input chunk before buffering or parsing any response.
    if (bytes.length > MAX_FRAME_BYTES || this.buffer.length + bytes.length > MAX_FRAME_BYTES) { this.fail(); return; }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const at = this.buffer.indexOf(10);
    if (at < 0) return;
    const line = this.buffer.subarray(0, at);
    this.buffer = this.buffer.subarray(at + 1);
    try {
      const message: unknown = JSON.parse(line.toString('utf8'));
      const p = this.pending;
      if (!p || !record(message) || !keys(message, ['schema', 'kind', 'id', 'ok', 'result']) || message.schema !== schema ||
          message.kind !== 'response' || message.id !== p.id || message.ok !== true || this.buffer.length !== 0) throw new Error();
      const result = snapshot(message.result, p.binding);
      clearTimeout(p.timer); this.pending = null; p.resolve(result);
    } catch { this.fail(); }
  };
  private readonly onLoss = () => this.fail();
  constructor(private readonly input: Readable, private readonly output: Writable) {
    input.on('data', this.onData); input.on('end', this.onLoss); input.on('close', this.onLoss); input.on('error', this.onLoss);
    output.on('error', this.onLoss); output.on('close', this.onLoss);
  }
  private fail() {
    this.failed = true;
    const p = this.pending; this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(new Error('bridge_held')); }
  }
  request(operation: Operation, binding: Binding): Promise<Snapshot> {
    if (this.failed || this.pending || !['start', 'status', 'cancel'].includes(operation) || !validBinding(binding) ||
        !positive(this.nextId) || this.input.readableEnded || this.input.destroyed || this.output.destroyed || this.output.writableEnded) {
      this.fail(); return Promise.reject(new Error('bridge_held'));
    }
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id: requestId, binding: { ...binding }, resolve, reject, timer: setTimeout(() => this.fail(), RPC_TIMEOUT_MS) };
      try {
        this.output.write(JSON.stringify({ schema, kind: 'request', id: requestId, operation, ...binding }) + '\n', error => { if (error) this.fail(); });
      } catch { this.fail(); }
    });
  }
  assertOpen() { if (this.failed) throw new Error('bridge_held'); }
  dispose() {
    this.fail();
    this.input.off('data', this.onData); this.input.off('end', this.onLoss); this.input.off('close', this.onLoss); this.input.off('error', this.onLoss);
    this.output.off('error', this.onLoss); this.output.off('close', this.onLoss);
  }
}
const held = (code: string, requestId?: string): AdapterExecutionResult => ({ exitCode: 1, signal: null, timedOut: false,
  errorCode: code, errorMessage: 'Synthetic bridge held.', resultJson: { state: 'held', contained: false, ...(requestId ? { requestId } : {}) } });
function bind(ctx: AdapterExecutionContext): Binding {
  const d = ctx.context.dom430;
  if (!record(d) || !keys(d, ['requestId']) || !id(d.requestId, 64) || !id(ctx.runId) ||
      ctx.agent.companyId !== 'dom430-flow-lab' || !tools.has(ctx.agent.id) || ctx.agent.adapterType !== type ||
      !record(ctx.config) || Object.keys(ctx.config).length || !record(ctx.agent.adapterConfig) || Object.keys(ctx.agent.adapterConfig).length ||
      ctx.runtime.taskKey !== 'lab-issue-a' || ctx.runtime.sessionId !== null || ctx.runtime.sessionParams !== null || ctx.runtime.sessionDisplayId !== null ||
      ctx.executionTarget != null || ctx.executionTransport != null || ctx.runtimeCommandSpec != null || ctx.runtimeMcp != null ||
      ctx.runtimeTools != null || ctx.authToken != null) throw new Error('input_refused');
  return { requestId: d.requestId, taskId: 'lab-issue-a', runId: ctx.runId, toolId: ctx.agent.id };
}

/** Injection is restricted to channel IO for tests; no execution/budget capability exists. */
export function createBridgeAdapter(input: Readable, output: Writable): ServerAdapterModule {
  let used = false;
  return {
    type, models: [], supportsLocalAgentJwt: false,
    async testEnvironment() { return { adapterType: type, status: 'fail', testedAt: new Date().toISOString(), checks: [{
      code: 'parent_controller_required', level: 'error', message: 'Private synthetic parent controller required.' }] }; },
    async execute(ctx) {
      let binding: Binding;
      try { binding = bind(ctx); } catch { return held('input_refused'); }
      if (used) return held('bridge_busy', binding.requestId);
      used = true;
      let rpc: BridgeRpc | undefined, last: Snapshot | undefined, cancelled = false;
      try {
        await ctx.onCancellationReady?.();
        if (ctx.signal?.aborted) return held('cancelled_before_start', binding.requestId);
        rpc = new BridgeRpc(input, output);
        ctx.onDispatch?.();
        if (ctx.signal?.aborted) return held('cancelled_before_start', binding.requestId);
        last = await rpc.request('start', binding);
        const original = { tokens: last.budget.originalTokens, deadline: last.budget.deadlineMs };
        for (;;) {
          rpc.assertOpen();
          // Cancellation can only contain the already bound run. It cannot transfer ownership.
          if (ctx.signal?.aborted && !cancelled) { cancelled = true; last = await rpc.request('cancel', binding); }
          if (last.budget.originalTokens !== original.tokens || last.budget.deadlineMs !== original.deadline) throw new Error('budget_changed');
          if (last.contained && last.state !== 'running') {
            const success = last.state === 'complete' && !cancelled;
            return { exitCode: success ? 0 : 1, signal: cancelled ? 'SIGTERM' : null, timedOut: false,
              ...(success ? {} : { errorCode: last.state === 'founder' ? 'contained_handover' : 'contained_held', errorMessage: 'Synthetic run contained.' }),
              resultJson: { requestId: binding.requestId, ...last, cancelled },
              summary: success ? 'Synthetic run completed and contained.' : 'Synthetic run contained.' };
          }
          await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
          last = await rpc.request('status', binding);
        }
      } catch { return held('bridge_held', binding.requestId); }
      finally { rpc?.dispose(); }
    },
  };
}
export function createServerAdapter(): ServerAdapterModule { return createBridgeAdapter(process.stdin, process.stdout); }
