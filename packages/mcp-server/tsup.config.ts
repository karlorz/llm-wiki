import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@skillwiki/shared"],
});
