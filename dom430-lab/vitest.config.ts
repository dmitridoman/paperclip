import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const sdk = resolve(root, "packages/plugins/sdk/src");
export default defineConfig({
  resolve: { alias: [
    { find: /^@paperclipai\/db$/, replacement: resolve(root, "packages/db/src/index.ts") },
    { find: /^@paperclipai\/shared$/, replacement: resolve(root, "packages/shared/src/index.ts") },
    { find: /^drizzle-orm$/, replacement: resolve(root, "server/node_modules/drizzle-orm/index.js") },
    { find: /^@paperclipai\/paperclip-runner$/, replacement: resolve(root, "packages/paperclip-runner/src/index.ts") },
    { find: /^@paperclipai\/plugin-sdk$/, replacement: resolve(sdk, "index.ts") },
    ...["protocol", "types", "testing", "bundlers", "dev-server"].map(name => ({ find: "@paperclipai/plugin-sdk/" + name, replacement: resolve(sdk, name + ".ts") })),
  ] },
  test: { environment: "node", include: ["dom430-lab/*.test.ts", "server/src/__tests__/heartbeat-process-recovery.test.ts", "server/src/__tests__/recovery-stale-issue-lock-sweep.test.ts", ...["native-replacement-evidence", "stopped-codex-turn", "native-runner-ownership", "native-restart-recovery"].map(name => "server/src/services/native-runtime/" + name + ".test.ts")], pool: "forks", maxWorkers: 1,
    fileParallelism: false, isolate: true, testTimeout: 30000, hookTimeout: 90000, teardownTimeout: 30000,
    server: { deps: { inline: [/^@paperclipai\//] } },
  },
});
