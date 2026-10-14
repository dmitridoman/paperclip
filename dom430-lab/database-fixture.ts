import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { issueService } from "../server/src/services/issues.js";

// Never retain an upstream database error as a cause: its query/parameters can
// contain credentials. Assertions receive only a bounded status and code.
export function sanitiseFailure(error: unknown) {
  const record = error && typeof error === "object" ? error as { status?: unknown; details?: unknown } : {};
  const status = typeof record.status === "number" && [400, 401, 403, 404, 409, 422].includes(record.status) ? record.status : 500;
  const details = record.details && typeof record.details === "object" ? record.details as { code?: unknown } : {};
  const code = typeof details.code === "string" && /^[a-z_]{1,80}$/.test(details.code) ? details.code : "upstream_failure";
  return { status, code };
}

export async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const failure = sanitiseFailure(error);
    throw new Error(`dom430_lab_failure:${failure.status}:${failure.code}`);
  }
}

export async function attempt<T>(action: () => Promise<T>) {
  try { return { ok: true as const, value: await action() }; }
  catch (error) { return { ok: false as const, ...sanitiseFailure(error) }; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export type AuthoritySeed = { companyId: string; issueId: string; agentIds: string[]; runIds: string[] };

/** Real upstream migrations and services; no replacement ownership logic. */
export async function createAuthorityFixture() {
  const temporary = await safe(() => startEmbeddedPostgresTestDatabase("dom430-authority-"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const applicationName = `dom430-authority-writer-${suffix}`;
  const db = createDb(temporary.connectionString, { maxConnections: 12, applicationName });
  const observer = createDb(temporary.connectionString, { maxConnections: 2, applicationName: `dom430-authority-observer-${suffix}` });
  const locker = createDb(temporary.connectionString, { maxConnections: 1, applicationName: `dom430-authority-locker-${suffix}` });
  const service = issueService(db);
  const activeLocks = new Set<{ release(): void; settled: Promise<unknown> }>();

  return {
    db,
    service,
    applicationName,
    async seed(count = 1): Promise<AuthoritySeed> {
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("dom430_invalid_seed_count");
      return safe(async () => {
        const companyId = randomUUID();
        const issueId = randomUUID();
        const agentIds = Array.from({ length: count }, () => randomUUID());
        const runIds = Array.from({ length: count }, () => randomUUID());
        await db.insert(companies).values({ id: companyId, name: "DOM430 synthetic authority lab", issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 12).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "dom430-synthetic-founder", status: "active", membershipRole: "owner" });
        await db.insert(agents).values(agentIds.map((id, i) => ({ id, companyId, name: `Synthetic claimant ${i}`, role: "engineer", status: "active", adapterType: "dom430_synthetic", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
        await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic authority task", status: "todo", priority: "medium" });
        await db.insert(heartbeatRuns).values(runIds.map((id, i) => ({ id, companyId, agentId: agentIds[i], status: "running", controllerBootId: randomUUID(), contextSnapshot: { issueId } })));
        return { companyId, issueId, agentIds, runIds };
      });
    },
    async readIssue(id: string) {
      return safe(async () => (await db.select().from(issues).where(eq(issues.id, id)))[0]);
    },
    async lockIssue(id: string) {
      const ready = deferred<Db>();
      const gate = deferred<void>();
      const settled = safe(() => locker.transaction(async (tx) => {
        await tx.execute(sql`select id from issues where id = ${id} for update`);
        ready.resolve(tx as unknown as Db);
        await gate.promise;
      }));
      // The catch also settles the readiness waiter; it never leaks raw errors.
      void settled.catch(() => ready.reject(new Error("dom430_lock_acquisition_failed")));
      const handle = { tx: await ready.promise, release: () => gate.resolve(), settled };
      activeLocks.add(handle);
      void settled.finally(() => activeLocks.delete(handle)).catch(() => {});
      return handle;
    },
    async waitForLockWait() {
      return safe(async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const rows = await observer.execute(sql`select count(*)::int as count from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock'`);
          if (Number(rows[0]?.count) > 0) return;
          await delay(10);
        }
        throw new Error("dom430_no_actual_database_lock_wait");
      });
    },
    async waitDatabaseMilliseconds(milliseconds: number) {
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 3_000) throw new Error("dom430_invalid_database_delay");
      await safe(() => observer.execute(sql`select pg_sleep(${milliseconds / 1000})`));
    },
    async setControllerLeaseMilliseconds(runId: string, milliseconds: number) {
      if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 3_000) throw new Error("dom430_invalid_controller_lease");
      await safe(() => observer.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() + ${milliseconds} * interval '1 millisecond'` }).where(eq(heartbeatRuns.id, runId)));
      const rows = await safe(() => observer.execute(sql`select controller_lease_expires_at > clock_timestamp() as live from heartbeat_runs where id = ${runId}`));
      return rows[0]?.live === true;
    },
    async expireControllerLease(runId: string) {
      await safe(() => observer.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(heartbeatRuns.id, runId)));
    },
    async cleanup() {
      for (const lock of activeLocks) lock.release();
      await Promise.allSettled([...activeLocks].map((lock) => lock.settled));
      await safe(() => temporary.cleanup());
    },
  };
}

export type AuthorityFixture = Awaited<ReturnType<typeof createAuthorityFixture>>;
