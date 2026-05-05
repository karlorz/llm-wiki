import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "auto-update-bg": "src/auto-update-bg.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@skillwiki/shared"]
});
