import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["dom430-bridge/adapter.test.ts"], environment: "node", pool: "forks", maxWorkers: 1, fileParallelism: false, testTimeout: 5000 } });
