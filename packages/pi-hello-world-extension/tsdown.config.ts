import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "node",
	deps: {
		// pi loads extensions via jiti — these are runtime externals
		neverBundle: [
			"@mariozechner/pi-coding-agent",
			"@mariozechner/pi-ai",
			"@mariozechner/pi-tui",
			"@sinclair/typebox",
		],
	},
});
