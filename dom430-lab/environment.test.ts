import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
describe("DOM430 isolated execution boundary", () => {
  it("has a private home and hides personal state and host control sockets", () => {
    expect(process.env.HOME).toBe("/home/worker");
    expect(process.env.PAPERCLIP_TELEMETRY_DISABLED).toBe("1");
    for (const path of ["/home/dimz/.codex", "/home/dimz/.claude", "/home/dimz/.config", "/run/user/1001/bus", "/var/run/docker.sock"])
      expect(existsSync(path), "host state must be absent").toBe(false);
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.PAPERCLIP_TEST_DATABASE_URL).toBeUndefined();
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
  it("uses a different network namespace with only loopback and no default route", () => {
    expect(process.env.DOM430_HOST_NET_NS).toMatch(/^net:\[\d+\]$/);
    expect(readlinkSync("/proc/self/ns/net")).not.toBe(process.env.DOM430_HOST_NET_NS);
    expect(Object.keys(networkInterfaces()).filter(name => name !== "lo")).toEqual([]);
    const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
    expect(routes).toEqual([]);
  });
});
