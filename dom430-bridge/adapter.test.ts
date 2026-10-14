import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BridgeRpc, MAX_FRAME_BYTES, createBridgeAdapter, schema, type } from './adapter.js';
import type { Binding, Operation, Snapshot } from './adapter.js';
import type { AdapterExecutionContext } from '../packages/adapter-utils/src/types.js';

const binding: Binding = { requestId: 'request-a', taskId: 'lab-issue-a', runId: 'pc-request-a', toolId: 'paperclip-synthetic-a' };
const value = (state: Snapshot['state'] = 'running', contained = false): Snapshot => ({ state, contained,
  runId: binding.runId, ddRunId: 'dd-run-a', leaseId: 'lease-a', fence: 1, generation: 1,
  budget: { originalTokens: 4, reservedTokens: 2, remainingTokens: 2, deadlineMs: 5000, dbTimeMs: 1000 },
  identity: { unit: 'dd-lab-a.service', pid: 123, startTicks: 456 } });
const context = (extra: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext => ({ runId: binding.runId,
  agent: { id: binding.toolId, companyId: 'dom430-flow-lab', name: 'Synthetic', adapterType: type, adapterConfig: {} },
  runtime: { taskKey: 'lab-issue-a', sessionId: null, sessionParams: null, sessionDisplayId: null },
  config: {}, context: { dom430: { requestId: binding.requestId } }, onLog: async () => {}, ...extra });
function fixture(reply: (request: Record<string, unknown>, input: PassThrough) => void) {
  const input = new PassThrough(), requests: Record<string, unknown>[] = [];
  const output = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString()); requests.push(request); done();
    queueMicrotask(() => reply(request, input));
  } });
  return { input, output, requests, adapter: createBridgeAdapter(input, output) };
}
function send(input: PassThrough, request: Record<string, unknown>, result: unknown = value(), patch = {}) {
  input.write(JSON.stringify({ schema, kind: 'response', id: request.id, ok: true, result, ...patch }) + '\n');
}

describe('private supported supervisor bridge', () => {
  it('waits for physical completion, exposes only parent budgets and never emits provider billing', async () => {
    const f = fixture((r, i) => send(i, r, value(r.operation === 'start' ? 'running' : 'complete', r.operation !== 'start')));
    const result = await f.adapter.execute(context());
    expect(f.requests.map(r => r.operation)).toEqual(['start', 'status']);
    expect(f.requests.map(r => r.id)).toEqual([1, 2]);
    expect(Object.keys(f.requests[0]).sort()).toEqual(['id', 'kind', 'operation', 'requestId', 'runId', 'schema', 'taskId', 'toolId']);
    expect(result.exitCode).toBe(0); expect(result.resultJson?.budget).toEqual(value().budget);
    expect(result.usage).toBeUndefined(); expect(result.costUsd).toBeUndefined(); expect(result.provider).toBeUndefined();
  });
  it('does not call the provider-stop collection callback on a frozen founder run', async () => {
    const f = fixture((r, i) => send(i, r, value('founder', true)));
    let calls = 0;
    const result = await f.adapter.execute(context({ onProviderStopped: async () => { calls++; } }));
    expect(result.exitCode).toBe(1); expect(result.errorCode).toBe('contained_handover'); expect(calls).toBe(0);
  });
  it.each(['running', 'founder', 'held', 'complete'] as const)('cannot return a successful %s worker without containment', async state => {
    const f = fixture((r, i) => { if (r.operation === 'start') send(i, r, value(state, false)); else i.end(); });
    const result = await f.adapter.execute(context());
    expect(f.requests.length).toBe(2); expect(result.exitCode).toBe(1); expect(result.resultJson?.contained).toBe(false);
  });
  it('accepts only bounded synthetic receipts and exposes canonical DD run identity', async () => {
    const s = { ...value('held', true),
      freezeReceipt: { verified: true, unit: 'dd-lab-a.service', pid: 123, startTicks: 456, counterBefore: 5, counterAfter: 5 },
      restoreReceipt: { verified: true, sourceSlot: 'old-a', successorSlot: 'new-a', snapshotDigest: 'a'.repeat(64), leaseId: 'lease-a', fence: 1, generation: 1 } };
    const f = fixture((r, i) => send(i, r, s));
    const result = await f.adapter.execute(context());
    expect(result.resultJson?.ddRunId).toBe('dd-run-a'); expect(result.resultJson?.freezeReceipt).toEqual(s.freezeReceipt);
    expect(result.exitCode).toBe(1);
  });
  it.each([
    { config: { command: 'arbitrary' } },
    { config: { model: 'real-model' } },
    { config: { budget: 999 } },
    { config: { env: {} } },
    { config: { path: '/tmp/elsewhere' } },
    { context: { dom430: { requestId: 'request-a', operation: 'founder' } } },
    { context: { dom430: { requestId: 'a'.repeat(65) } } },
    { executionTarget: { kind: 'local' } },
    { runtimeCommandSpec: { command: 'arbitrary' } },
    { authToken: 'synthetic-unexpected' },
  ])('refuses caller capabilities before emitting an RPC: %j', async extra => {
    const f = fixture(() => {}); const result = await f.adapter.execute(context(extra as Partial<AdapterExecutionContext>));
    expect(result.errorCode).toBe('input_refused'); expect(f.requests).toHaveLength(0);
  });
  it.each(['company', 'task', 'tool', 'run', 'request'])('refuses wrong or malformed %s identity', async field => {
    const ctx = context();
    if (field === 'company') ctx.agent.companyId = 'other-company';
    if (field === 'task') ctx.runtime.taskKey = 'other-task';
    if (field === 'tool') ctx.agent.id = 'real-provider';
    if (field === 'run') ctx.runId = '../run';
    if (field === 'request') ctx.context.dom430 = { requestId: '__proto__' };
    const f = fixture(() => {}); expect((await f.adapter.execute(ctx)).exitCode).toBe(1); expect(f.requests).toHaveLength(0);
  });
  it.each([
    { id: 999 }, { kind: 'request' }, { schema: 'other' }, { ok: false }, { command: 'arbitrary' },
  ])('holds a mismatched or malformed envelope: %j', async patch => {
    const f = fixture((r, i) => send(i, r, value(), patch));
    const result = await f.adapter.execute(context()); expect(result.errorCode).toBe('bridge_held'); expect(result.resultJson?.contained).toBe(false);
  });
  it.each([
    { runId: 'other-run' }, { fence: 0 }, { generation: -1 }, { identity: { unit: '/host/path' } },
    { budget: { ...value().budget, remainingTokens: 5 } }, { budget: { ...value().budget, remainingTokens: 3 } },
    { budget: { ...value().budget, originalTokens: 0, reservedTokens: 0, remainingTokens: 0 } }, { budget: { ...value().budget, dbTimeMs: Infinity } },
    { command: 'arbitrary' }, { freezeReceipt: { verified: true, rawNote: 'unbounded' } },
    { restoreReceipt: { verified: true, path: '/arbitrary' } },
  ])('holds an invalid snapshot: %j', async patch => {
    const f = fixture((r, i) => send(i, r, { ...value(), ...patch }));
    expect((await f.adapter.execute(context())).errorCode).toBe('bridge_held');
  });
  it.each(['originalTokens', 'deadlineMs'])('rejects an allocation reset of %s', async field => {
    const f = fixture((r, i) => {
      const s = value(r.operation === 'start' ? 'running' : 'complete', r.operation !== 'start');
      if (r.operation === 'status') s.budget[field as 'originalTokens' | 'deadlineMs'] += 1;
      send(i, r, s);
    });
    expect((await f.adapter.execute(context())).errorCode).toBe('bridge_held');
  });
  it.each(['end', 'close', 'error'] as const)('holds on channel %s without claiming a stop', async event => {
    const f = fixture((_r, i) => { if (event === 'end') i.end(); else if (event === 'close') i.destroy(); else i.destroy(new Error('private')); });
    const result = await f.adapter.execute(context()); expect(result.exitCode).toBe(1); expect(result.resultJson?.contained).toBe(false);
    expect(result.errorMessage).not.toContain('private');
  });
  it('contains via cancel exactly once and cannot report cancellation as completion', async () => {
    const abort = new AbortController();
    const f = fixture((r, i) => {
      if (r.operation === 'start') { send(i, r); abort.abort(); }
      else send(i, r, value(r.operation === 'cancel' ? 'running' : 'held', r.operation !== 'cancel'));
    });
    const result = await f.adapter.execute(context({ signal: abort.signal }));
    expect(f.requests.map(r => r.operation)).toEqual(['start', 'cancel', 'status']);
    expect(result.exitCode).toBe(1); expect(result.resultJson?.cancelled).toBe(true); expect(result.resultJson?.contained).toBe(true);
  });
  it('pre-start cancellation does not request admission', async () => {
    const abort = new AbortController(); abort.abort();
    const f = fixture(() => {}); expect((await f.adapter.execute(context({ signal: abort.signal }))).errorCode).toBe('cancelled_before_start');
    expect(f.requests).toHaveLength(0);
  });
  it('does not dispatch after cancellation inside the dispatch callback', async () => {
    const abort = new AbortController();
    const f = fixture(() => {});
    const result = await f.adapter.execute(context({ signal: abort.signal, onDispatch: () => abort.abort() }));
    expect(result.errorCode).toBe('cancelled_before_start'); expect(f.requests).toHaveLength(0);
  });
  it('holds callback failures without leaking them or dispatching work', async () => {
    const f = fixture(() => {});
    const result = await f.adapter.execute(context({ onCancellationReady: async () => { throw new Error('private'); } }));
    expect(result.errorCode).toBe('bridge_held'); expect(f.requests).toHaveLength(0);
  });
  it('has no model, runtime commands, sessions or provider discovery capability', () => {
    const f = fixture(() => {});
    expect(f.adapter.models).toEqual([]); expect(f.adapter.supportsLocalAgentJwt).toBe(false);
    for (const key of ['detectModel', 'listModels', 'getQuotaWindows', 'acp', 'sessionCodec', 'runtimeToolDelivery', 'getRuntimeCommand']) expect(key in f.adapter).toBe(false);
  });
});

describe('bounded pipe protocol', () => {
  it.each(['founder', 'takeover', 'handback', 'restore', 'launch'] as const)('cannot emit arbitrary %s opcode', async opcode => {
    const f = fixture(() => {}), rpc = new BridgeRpc(f.input, f.output);
    await expect(rpc.request(opcode as Operation, binding)).rejects.toThrow('bridge_held'); expect(f.requests).toHaveLength(0); rpc.dispose();
  });
  it('rejects an oversized frame before JSON parsing', async () => {
    const f = fixture((_r, i) => i.write('x'.repeat(MAX_FRAME_BYTES + 1)));
    expect((await f.adapter.execute(context())).errorCode).toBe('bridge_held');
  });
  it('rejects invalid JSON, extra frames and unsolicited data', async () => {
    for (const line of ['{bad}\n', '{}\n{}\n', '{}\n']) {
      const f = fixture((_r, i) => i.write(line)); expect((await f.adapter.execute(context())).errorCode).toBe('bridge_held');
    }
  });
  it('accepts fragmented valid responses without accepting a second launch', async () => {
    const f = fixture((r, i) => {
      const line = JSON.stringify({ schema, kind: 'response', id: r.id, ok: true, result: value('complete', true) }) + '\n';
      i.write(line.slice(0, 12)); i.write(line.slice(12));
    });
    expect((await f.adapter.execute(context())).exitCode).toBe(0); expect(f.requests).toHaveLength(1);
  });
  it('never resets RPC IDs by executing the same channel twice', async () => {
    const f = fixture((r, i) => send(i, r, value('complete', true)));
    expect((await f.adapter.execute(context())).exitCode).toBe(0);
    expect((await f.adapter.execute(context())).errorCode).toBe('bridge_busy'); expect(f.requests).toHaveLength(1);
  });
  it('does not allow concurrent execute to create a duplicate dispatcher request', async () => {
    let release: (() => void) | undefined;
    const f = fixture((r, i) => { release = () => send(i, r, value('complete', true)); });
    const pending = f.adapter.execute(context()); await new Promise<void>(resolve => queueMicrotask(resolve));
    expect((await f.adapter.execute(context())).errorCode).toBe('bridge_busy'); release?.();
    expect((await pending).exitCode).toBe(0); expect(f.requests).toHaveLength(1);
  });
});
