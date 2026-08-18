import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Windows CI runners flake on the 5s default under load (git-heavy
    // work-complete / ingest tests). Linux/macOS keep the vitest default.
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    coverage: { provider: "v8", reporter: ["text", "lcov"] }
  }
});
