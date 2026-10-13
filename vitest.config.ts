import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000, fileParallelism: false,
    coverage: { provider: "v8", include: ["server/domain/**", "server/auth/**", "shared/**"] } },
});
