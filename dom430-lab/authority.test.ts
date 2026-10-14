import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../server/src/agent-auth-jwt.js";
import { attempt, createAuthorityFixture, safe, type AuthorityFixture, type AuthoritySeed } from "./database-fixture.js";

type Classification = "native-pass" | "equivalence-gap";
function observed(id: string, classification: Classification, observation: Record<string, unknown>) {
  // Synthetic aggregate evidence only. A green Vitest result validates the
  // observation, not DD equivalence: gaps remain explicit machine-readable gaps.
  const row = JSON.stringify({ schema: "dom430.paperclip.authority.v1", id, layer: "upstream-service", classification, desiredDdEquivalent: classification === "native-pass", ...observation });
  const outputFile = process.env.DOM430_AUTHORITY_OBSERVATIONS_FILE;
  if (outputFile !== undefined) {
    if (outputFile !== "/tmp/dom430-authority-observations.jsonl") throw new Error("dom430_invalid_observation_output_path");
    appendFileSync(outputFile, `${row}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(row);
}

async function claim(fixture: AuthorityFixture, seed: AuthoritySeed, index = 0) {
  return safe(() => fixture.service.checkout(seed.issueId, seed.agentIds[index], ["todo"], seed.runIds[index]));
}

async function stalePublication(fixture: AuthorityFixture, seed: AuthoritySeed) {
  // This is the existing route's admission helper and real mutation service,
  // deliberately separated by a real row-lock wait rather than a fake service.
  await safe(() => fixture.service.assertCheckoutOwner(seed.issueId, seed.agentIds[0], seed.runIds[0]));
  const lock = await fixture.lockIssue(seed.issueId);
  const publication = attempt(() => fixture.service.update(seed.issueId, { status: "done", actorAgentId: seed.agentIds[0], actorRunId: seed.runIds[0], companyGuard: seed.companyId }));
  try {
    await fixture.waitForLockWait();
    return { lock, publication };
  } catch (error) {
    lock.release();
    await publication;
    await lock.settled;
    throw error;
  }
}

describe("DOM430 upstream authority observations (passes and equivalence gaps are separate)", () => {
  let fixture: AuthorityFixture;
  const savedEnvironment: Record<string, string | undefined> = {};
  const jwtEnvironment = ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_AGENT_JWT_TTL_SECONDS", "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK"];

  beforeAll(async () => {
    fixture = await createAuthorityFixture();
    for (const key of jwtEnvironment) savedEnvironment[key] = process.env[key];
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "1";
    process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
  }, 90_000);

  afterAll(async () => {
    for (const key of jwtEnvironment) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
    await fixture?.cleanup();
  }, 15_000);

  it("100 distinct competing claims commit exactly one owner", async () => {
    const seed = await fixture.seed(100);
    const results = await Promise.all(seed.agentIds.map((agentId, i) => attempt(() => fixture.service.checkout(seed.issueId, agentId, ["todo"], seed.runIds[i]))));
    const successes = results.flatMap((result, i) => result.ok ? [i] : []);
    const failures = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(99);
    expect(failures.every((result) => !result.ok && result.status === 409)).toBe(true);
    const row = await fixture.readIssue(seed.issueId);
    expect(row.assigneeAgentId).toBe(seed.agentIds[successes[0]]);
    expect(row.checkoutRunId).toBe(seed.runIds[successes[0]]);
    expect(row.executionRunId).toBe(seed.runIds[successes[0]]);
    observed("100-contenders", "native-pass", { contenders: 100, winners: successes.length, conflicts: failures.length });
  }, 30_000);

  it("same-run ownership replay succeeds and another run conflicts", async () => {
    const seed = await fixture.seed(2);
    const first = await claim(fixture, seed);
    const replay = await safe(() => fixture.service.checkout(seed.issueId, seed.agentIds[0], ["todo"], seed.runIds[0]));
    const conflict = await attempt(() => fixture.service.checkout(seed.issueId, seed.agentIds[1], ["todo"], seed.runIds[1]));
    expect(replay.id).toBe(first.id);
    expect(replay.checkoutRunId).toBe(first.checkoutRunId);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.status).toBe(409);
    observed("same-run-ownership-replay", "native-pass", { sameOwnerAccepted: true, differentOwnerRejected: true, immutableRequestReceiptClaimed: false });
  });

  it("changed expected statuses under the same run are accepted without immutable request binding", async () => {
    const seed = await fixture.seed();
    await claim(fixture, seed);
    const changed = await attempt(() => fixture.service.checkout(seed.issueId, seed.agentIds[0], ["cancelled"], seed.runIds[0]));
    expect(changed.ok).toBe(true);
    expect((await fixture.readIssue(seed.issueId)).status).toBe("in_progress");
    observed("same-run-changed-input", "equivalence-gap", { desired: "reject changed input under replay identity", actual: "same owner accepted changed expectedStatuses", hasRequestIdParameter: false });
  });

  it("Stop requested during the issue row-lock wait rejects a late Done", async () => {
    const seed = await fixture.seed();
    await claim(fixture, seed);
    const { lock, publication } = await stalePublication(fixture, seed);
    try {
      await safe(() => fixture.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, seed.runIds[0])));
    } finally { lock.release(); }
    const result = await publication;
    await lock.settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect({ status: result.status, code: result.code }).toEqual({ status: 403, code: "agent_run_cancelled" });
    expect((await fixture.readIssue(seed.issueId)).status).toBe("in_progress");
    observed("cancellation-after-lock-wait", "native-pass", { actualDatabaseLockWait: true, revokedBeforeSettlement: true, lateDoneRejected: true, physicalStopClaimed: false });
  });

  it("committed human reassignment does not fence an already-admitted generic service write", async () => {
    const seed = await fixture.seed();
    await claim(fixture, seed);
    const { lock, publication } = await stalePublication(fixture, seed);
    try {
      await safe(() => fixture.service.update(seed.issueId, { assigneeAgentId: null, assigneeUserId: "dom430-synthetic-founder", actorUserId: "dom430-synthetic-founder", companyGuard: seed.companyId }, lock.tx));
    } finally { lock.release(); }
    const result = await publication;
    await lock.settled;
    expect(result.ok).toBe(true);
    const row = await fixture.readIssue(seed.issueId);
    expect(row.assigneeUserId).toBe("dom430-synthetic-founder");
    expect(row.status).toBe("done");
    observed("human-reassignment-after-lock-wait", "equivalence-gap", { actualDatabaseLockWait: true, desired: "holder change rejects stale publication", actual: "old admitted actor published Done after service reassignment", scope: "generic service path, not full HTTP route or verified physical takeover" });
  });

  it("a controller lease expiring during a real lock wait does not fence generic publication", async () => {
    const seed = await fixture.seed();
    await claim(fixture, seed);
    const { lock, publication } = await stalePublication(fixture, seed);
    try {
      // Set and observe live authority only after PostgreSQL confirms the wait.
      expect(await fixture.setControllerLeaseMilliseconds(seed.runIds[0], 300)).toBe(true);
      await fixture.waitDatabaseMilliseconds(450);
      const rows = await safe(() => fixture.db.execute(sql`select controller_lease_expires_at < clock_timestamp() as expired from heartbeat_runs where id = ${seed.runIds[0]}`));
      expect(rows[0]?.expired).toBe(true);
    } finally { lock.release(); }
    const result = await publication;
    await lock.settled;
    expect(result.ok).toBe(true);
    expect((await fixture.readIssue(seed.issueId)).status).toBe("done");
    observed("controller-lease-expiry-after-lock-wait", "equivalence-gap", { actualDatabaseLockWait: true, expiryMeasuredBy: "PostgreSQL clock_timestamp", desired: "expired final authority rejects publication", actual: "Done committed under expired controller lease" });
  });

  it("changed controller boot owner does not fence the old generic actor", async () => {
    const seed = await fixture.seed();
    await claim(fixture, seed);
    const { lock, publication } = await stalePublication(fixture, seed);
    try {
      await safe(() => fixture.db.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'` }).where(eq(heartbeatRuns.id, seed.runIds[0])));
    } finally { lock.release(); }
    const result = await publication;
    await lock.settled;
    expect(result.ok).toBe(true);
    expect((await fixture.readIssue(seed.issueId)).status).toBe("done");
    observed("controller-boot-change-after-lock-wait", "equivalence-gap", { actualDatabaseLockWait: true, desired: "old holder identity rejects writes", actual: "mutation actor carries run identity without controller boot identity", scope: "generic issue mutation, not native finalization ledger" });
  });

  it("a missing run row does not fail closed at the generic service boundary", async () => {
    const seed = await fixture.seed();
    // Use a never-registered run identity without altering a foreign key. This
    // is a service-boundary observation; HTTP authentication is not bypassed.
    const result = await attempt(() => fixture.service.update(seed.issueId, { description: "Synthetic missing-run publication", actorAgentId: seed.agentIds[0], actorRunId: randomUUID(), companyGuard: seed.companyId }));
    expect(result.ok).toBe(true);
    expect((await fixture.readIssue(seed.issueId)).description).toBe("Synthetic missing-run publication");
    observed("missing-run-service-publication", "equivalence-gap", { desired: "missing current run fails closed", actual: "generic mutation accepts unregistered run actor", scope: "direct service boundary only; HTTP admission not exercised" });
  });

  it("a terminal failed run still passes the generic cancellation-only write guard", async () => {
    const seed = await fixture.seed();
    await safe(() => fixture.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seed.runIds[0])));
    const result = await attempt(() => fixture.service.update(seed.issueId, { description: "Synthetic terminal-run publication", actorAgentId: seed.agentIds[0], actorRunId: seed.runIds[0], companyGuard: seed.companyId }));
    expect(result.ok).toBe(true);
    expect((await fixture.readIssue(seed.issueId)).description).toBe("Synthetic terminal-run publication");
    observed("terminal-run-service-publication", "equivalence-gap", { desired: "terminal run has no write authority", actual: "failed run accepted by cancellation-only service guard", scope: "direct service boundary only; HTTP admission not exercised" });
  });

  it("a JWT admitted before a lock wait expires before the generic mutation commits", async () => {
    const seed = await fixture.seed();
    await claim(fixture, seed);
    const token = createLocalAgentJwt(seed.agentIds[0], seed.companyId, "dom430_synthetic", seed.runIds[0]);
    expect(typeof token).toBe("string");
    const admitted = verifyLocalAgentJwt(token!);
    expect(admitted?.run_id).toBe(seed.runIds[0]);
    const { lock, publication } = await stalePublication(fixture, seed);
    try {
      // Prove the token is still live when the actual database wait begins.
      expect(verifyLocalAgentJwt(token!)).not.toBeNull();
      // Current verifier rejects when exp < now, hence allow two full seconds.
      await fixture.waitDatabaseMilliseconds(2_200);
      expect(verifyLocalAgentJwt(token!)).toBeNull();
    } finally { lock.release(); }
    const result = await publication;
    await lock.settled;
    expect(result.ok).toBe(true);
    expect((await fixture.readIssue(seed.issueId)).status).toBe("done");
    observed("token-expiry-after-lock-wait", "equivalence-gap", { actualDatabaseLockWait: true, desired: "admitted token expiry fences final commit", actual: "already-admitted run actor has no token-expiry parameter", scope: "real JWT admission helper plus generic service path; full HTTP not exercised" });
  }, 10_000);
});
