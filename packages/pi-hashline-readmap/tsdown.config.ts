import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "index.ts", "src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  unbundle: true,
  copy: [
    "prompts",
    {
      from: ["scripts/gdscript_outline.py", "scripts/go_outline.go", "scripts/python_outline.py"],
      to: "dist/scripts",
    },
  ],
  deps: {
    neverBundle: [/^@mariozechner\//],
  },
});
