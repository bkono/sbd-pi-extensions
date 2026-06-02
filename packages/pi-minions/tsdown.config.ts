import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  // Pi extensions — keep all deps external (resolved by pi at runtime via jiti)
  unbundle: true,
});
