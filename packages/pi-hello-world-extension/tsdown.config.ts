import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  platform: "node",
  // Pi extensions — keep all deps external (resolved by pi at runtime via jiti)
  unbundle: true,
});
