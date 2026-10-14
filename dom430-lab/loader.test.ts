import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExternalAdapterPackage } from "../server/src/adapters/plugin-loader.js";
describe("DOM430 actual upstream external adapter loader", () => {
  it("loads and validates our factory through the supported package loader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dom430-paperclip-package-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dom430-synthetic-adapter", type: "module", exports: { ".": "./index.mjs" } }));
      const target = new URL("./adapter.ts", import.meta.url).href;
      writeFileSync(join(dir, "index.mjs"), "export { createServerAdapter } from " + JSON.stringify(target) + ";\n");
      const adapter = await loadExternalAdapterPackage("dom430-synthetic-adapter", dir);
      expect(adapter).toBeTruthy();
      expect(typeof adapter!.execute).toBe("function");
      expect(typeof adapter!.testEnvironment).toBe("function");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
