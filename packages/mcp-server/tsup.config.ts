import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  // CLI adapters import CJS packages such as commander. Bundling them into this
  // ESM server produces "Dynamic require of ... is not supported" at boot.
  skipNodeModulesBundle: true,
  noExternal: ["@skillwiki/shared"],
});
