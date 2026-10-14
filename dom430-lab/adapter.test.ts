import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterExecutionContext } from '../packages/adapter-utils/src/types.js';
import { createServerAdapter, type LabAuthority } from './adapter.js';

let root: string, previous: string | undefined;
const base: LabAuthority = { taskId: 'task_1', companyId: 'company_1', agentId: 'agent_1',
  runId: 'run_1', generation: 1, paused: false, allocationId: 'original_1', originalBudget: 3, maxRunMs: 1000 };
function policy(patch: Partial<LabAuthority> = {}) {
  fs.writeFileSync(path.join(root, 'authority.json'), JSON.stringify({ ...base, ...patch }), { mode: 0o600 });
}
function context(patch: Partial<AdapterExecutionContext> = {}, input: Record<string, unknown> = {}): AdapterExecutionContext {
  return { runId: 'run_1', agent: { id: 'agent_1', companyId: 'company_1', name: 'Synthetic', adapterType: 'dom430_synthetic', adapterConfig: {} },
    runtime: { taskKey: 'task_1', sessionId: null, sessionParams: null, sessionDisplayId: null },
    config: {}, context: { dom430: { requestId: 'request_1', generation: 1, mode: 'finish', ...input } },
    onLog: async () => {}, ...patch };
}
const run = (ctx = context()) => createServerAdapter().execute(ctx);
const state = () => JSON.parse(fs.readFileSync(path.join(root, 'ledger.json'), 'utf8'));
const effects = () => fs.readFileSync(path.join(root, 'workspace', 'synthetic-effects.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
beforeEach(() => {
  previous = process.env.DOM430_LAB_ROOT;
  root = fs.mkdtempSync('/tmp/dom430-adapter-'); fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'tmp'));
  fs.mkdirSync(path.join(root, 'workspace'), { mode: 0o700 });
  process.env.DOM430_LAB_ROOT = root; policy();
});
afterEach(() => {
  if (previous === undefined) delete process.env.DOM430_LAB_ROOT; else process.env.DOM430_LAB_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('supported factory and separate DD synthetic bridge', () => {
  it('implements supported adapter without model, login or agent credential capability', async () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe('dom430_synthetic'); expect(adapter.models).toEqual([]);
    expect(adapter.supportsLocalAgentJwt).toBe(false); expect(adapter.loginCapability).toBeUndefined();
    expect((await adapter.testEnvironment({ companyId: 'company_1', adapterType: adapter.type, config: {} })).status).toBe('pass');
  });
  it('starts a real fixed child and reports exact bound effect and settled PID', async () => {
    const phases: string[] = []; let pid: number | undefined;
    const result = await run(context({ onCancellationReady: async () => { phases.push('ready'); },
      onSpawn: async meta => { pid = meta.pid; phases.push('spawn'); },
      onProviderStopped: async () => { phases.push('stopped'); } }));
    expect(result.exitCode).toBe(0); expect(phases).toEqual(['ready', 'spawn', 'stopped']);
    expect(result.resultJson?.stopReceipt).toMatchObject({ pid, settled: true, code: 0 });
    expect(result.resultJson?.effectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(result.costUsd).toBe(0); expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it('replays the same immutable result across fresh factories without another effect or budget charge', async () => {
    const first = await run(); let spawned = 0;
    const second = await run(context({ onSpawn: async () => { spawned++; } }));
    expect(second).toEqual(first); expect(spawned).toBe(0);
    expect(state().allocations.task_1.used).toBe(1);
    expect(effects()).toHaveLength(1);
  });
  it('refuses changed input with the same request identity', async () => {
    await run(); expect((await run(context({}, { mode: 'wait' }))).errorCode).toBe('altered_request');
    expect(state().allocations.task_1.used).toBe(1);
  });
  it.each([
    ['company', { agent: { ...context().agent, companyId: 'other' } }],
    ['agent', { agent: { ...context().agent, id: 'other' } }],
    ['run', { runId: 'other' }],
    ['task', { runtime: { ...context().runtime, taskKey: 'other' } }],
  ])('refuses stale or wrong %s before launch', async (_name, patch) => {
    let spawned = 0;
    expect((await run(context({ ...patch, onSpawn: async () => { spawned++; } }))).errorCode).toBe('admission_held');
    expect(spawned).toBe(0); expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false);
  });
  it('rejects stale generation and paused policy', async () => {
    expect((await run(context({}, { generation: 2 }))).errorCode).toBe('admission_held');
    policy({ paused: true }); expect((await run()).errorCode).toBe('admission_held');
  });
  it.each([{ command: 'anything' }, { cwd: '/' }, { env: { SECRET: 'not-a-real-secret' } }, { model: 'real' }])(
    'rejects alternate task command/configuration %j', async config => {
      expect((await run(context({ config }))).errorCode).toBe('input_refused');
      expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false);
    });
  it('rejects arbitrary input fields and path identity', async () => {
    expect((await run(context({}, { command: 'false' }))).errorCode).toBe('input_refused');
    expect((await run(context({}, { requestId: '../outside' }))).errorCode).toBe('input_refused');
  });
  it('pre-aborted admission returns known no-launch cancellation with durable receipt', async () => {
    const abort = new AbortController(); abort.abort(); let spawned = 0;
    const result = await run(context({ signal: abort.signal, onSpawn: async () => { spawned++; } }));
    expect(result.resultJson?.cancelled).toBe(true); expect(spawned).toBe(0);
    expect(result.resultJson?.stopReceipt).toMatchObject({ pid: null, settled: true });
  });
  it('awaits actual child stop before cancellation settlement and exact replay', async () => {
    const abort = new AbortController(); let pid: number | undefined;
    const result = await run(context({ signal: abort.signal, onSpawn: async meta => {
      pid = meta.pid; setTimeout(() => abort.abort(), 150);
    } }, { mode: 'wait' }));
    expect(result.resultJson?.cancelled).toBe(true); expect(result.resultJson?.stopReceipt).toMatchObject({ pid, settled: true });
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(await run(context({}, { mode: 'wait' }))).toEqual(result);
  });
  it('holds timed-out work even after verified process closure', async () => {
    policy({ maxRunMs: 100 });
    expect((await run(context({}, { mode: 'wait' }))).errorCode).toBe('effect_uncertain');
    expect(state().operations.request_1.state).toBe('held');
    expect((await run(context({}, { requestId: 'request_2' }))).errorCode).toBe('effect_uncertain');
  });
  it('holds missing effect receipt across restart and never retries that effect', async () => {
    expect((await run(context({}, { mode: 'unknown' }))).errorCode).toBe('effect_uncertain');
    let spawned = 0;
    expect((await run(context({ onSpawn: async () => { spawned++; } }, { mode: 'unknown' }))).errorCode).toBe('effect_uncertain');
    expect((await run(context({}, { requestId: 'retry' }))).errorCode).toBe('effect_uncertain');
    expect(spawned).toBe(0); expect(state().allocations.task_1.used).toBe(1);
    expect(effects()).toHaveLength(1);
  });
  it('rejects concurrent admission while a prepared effect remains unsettled', async () => {
    const abort = new AbortController(); let concurrent: Promise<unknown> | undefined;
    await run(context({ signal: abort.signal, onSpawn: async () => {
      concurrent = run(context({}, { requestId: 'second' })); setTimeout(() => abort.abort(), 100);
    } }, { mode: 'wait' }));
    expect(await concurrent).toMatchObject({ errorCode: 'effect_uncertain' });
    expect(state().allocations.task_1.used).toBe(1);
  });
  it('does not publish an effect after current generation revocation', async () => {
    const result = await run(context({ onSpawn: async () => { policy({ generation: 2 }); } }));
    expect(result.errorCode).toBe('effect_uncertain'); expect(state().operations.request_1.state).toBe('held');
  });
  it('does not publish after pause during execution', async () => {
    expect((await run(context({ onSpawn: async () => { policy({ paused: true }); } }))).errorCode).toBe('effect_uncertain');
  });
  it('rechecks synchronous dispatch callback revocation before spawning', async () => {
    let spawned = 0;
    expect((await run(context({ onDispatch: () => { policy({ paused: true }); },
      onSpawn: async () => { spawned++; } }))).errorCode).toBe('effect_uncertain');
    expect(spawned).toBe(0); expect(state().operations.request_1.state).toBe('held');
  });
  it('preserves original allocation across generation and run handover', async () => {
    policy({ originalBudget: 1 }); expect((await run()).exitCode).toBe(0);
    policy({ originalBudget: 1, generation: 2, runId: 'run_2' });
    expect((await run(context({ runId: 'run_2' }, { requestId: 'next', generation: 2 }))).errorCode).toBe('budget_exhausted');
    expect(state().allocations.task_1).toEqual({ id: 'original_1', original: 1, used: 1 });
  });
  it('refuses budget reset or replacement allocation after handover', async () => {
    await run(); policy({ originalBudget: 4, generation: 2, runId: 'run_2' });
    expect((await run(context({ runId: 'run_2' }, { requestId: 'next', generation: 2 }))).errorCode).toBe('allocation_changed');
    policy({ allocationId: 'replacement', generation: 2, runId: 'run_2' });
    expect((await run(context({ runId: 'run_2' }, { requestId: 'next', generation: 2 }))).errorCode).toBe('allocation_changed');
  });
  it.each([{ originalBudget: 0 }, { originalBudget: 9 }, { maxRunMs: 5000 }, { generation: 0 }])(
    'refuses unbounded or invalid authority %j', async patch => {
      policy(patch); expect((await run()).errorCode).toBe('admission_held');
      expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false);
    });
  it('holds callback failure rather than exposing diagnostic contents', async () => {
    const result = await run(context({ onProviderStopped: async () => { throw new Error('private-diagnostic-must-not-leak'); } }));
    expect(result.errorCode).toBe('effect_uncertain'); expect(JSON.stringify(result)).not.toContain('private-diagnostic');
    expect(state().operations.request_1.state).toBe('held');
  });
  it('requires a private root selected by trusted server environment', async () => {
    fs.chmodSync(root, 0o755); expect((await run()).errorCode).toBe('admission_held');
    expect(fs.existsSync(path.join(root, 'ledger.json'))).toBe(false);
  });
});
