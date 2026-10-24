import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts", "workspace-local": "src/workspace-local.ts", "workspace-migration": "src/workspace-migration.ts", "workspace-client": "src/workspace-client.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  splitting: false,
  // Keep the production executable's direct-run guard in its own module when
  // the local development launcher imports the server API.
  external: ["./server.js"],
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  // CLI adapters import CJS packages such as commander. Bundling them into this
  // ESM server produces "Dynamic require of ... is not supported" at boot.
  skipNodeModulesBundle: true,
  noExternal: ["@skillwiki/shared"],
});
