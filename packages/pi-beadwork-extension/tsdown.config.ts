import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  // Pi extensions are loaded by pi at runtime, so keep pi runtime deps external.
  unbundle: true,
  deps: {
    neverBundle: [/^@mariozechner\//],
  },
});
