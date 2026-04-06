import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	platform: "node",
	outDir: "dist",
	clean: true,
	sourcemap: true,
	dts: true,
	// Library package — keep all deps external (peer deps resolved by host)
	unbundle: true,
});
