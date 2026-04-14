import { defineConfig } from "vitest/config";

export default defineConfig({
  css: {
    postcss: { plugins: [] },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 10_000,
    teardownTimeout: 3_000,
  },
});
