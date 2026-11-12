import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/*",
      // repo-level checks across packages (manifests)
      { test: { name: "repo", include: ["tests/**/*.test.ts"] } },
    ],
  },
});
