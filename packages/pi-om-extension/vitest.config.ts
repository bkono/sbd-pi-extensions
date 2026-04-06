import { defineConfig } from "vitest/config";

export default defineConfig({
	// Provide an empty inline postcss config to prevent vite from walking up
	// the filesystem searching for one (which trips on parent directory perms).
	css: {
		postcss: { plugins: [] },
	},
	test: {
		globals: false,
		environment: "node",
		include: ["src/__tests__/**/*.test.ts"],
		testTimeout: 10_000,
		// Force-kill worker pools after 3s if they haven't cleaned up. Default
		// is 10s. A tight budget guards against runaway tests (infinite
		// microtask chains, unbounded recursive promises, etc.) orphaning
		// vitest workers — if a worker is stuck in a tight JS loop it won't
		// process the IPC shutdown message, and vitest will eventually
		// SIGKILL it at this timeout instead of hanging forever.
		teardownTimeout: 3_000,
	},
});
