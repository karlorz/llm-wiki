import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

type Service = {
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
  entrypoint?: string[];
  command?: string[];
};

const root = resolve(import.meta.dirname, "../../..");
function smokeFixture(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "bundled-smoke-"));
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SMOKE_CALLS"
case "$*" in
  *"up -d"*) [ "$SMOKE_MODE" != up-failure ]; exit $? ;;
  *"exec -T"*)
    if [ "$SMOKE_MODE" = health-failure ]; then exit 1; fi
    if [ "$SMOKE_MODE" = retry ] && [ ! -f "$SMOKE_SEEN" ]; then touch "$SMOKE_SEEN"; exit 1; fi
    exit 0 ;;
esac
exit 0
`);
  for (const [name, body] of Object.entries({ timeout: '#!/usr/bin/env bash\nshift\nexec "$@"\n', sleep: '#!/usr/bin/env bash\nexit 0\n' })) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  chmodSync(docker, 0o755);
  try {
    const result = spawnSync("bash", [resolve(root, "scripts/smoke-bundled-compose.sh")], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SMOKE_MODE: mode, SMOKE_CALLS: join(dir, "calls"), SMOKE_SEEN: join(dir, "seen") },
      encoding: "utf8", timeout: 10_000,
    });
    return { status: result.status, calls: readFileSync(join(dir, "calls"), "utf8"), error: result.error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const compose = yaml.load(readFileSync(resolve(root, "docker-compose.coolify-bundled.yml"), "utf8")) as {
  services: Record<string, Service>;
};

describe("bundled Compose smoke cleanup", () => {
  for (const mode of ["success", "retry", "up-failure", "health-failure"]) {
    it.skipIf(process.platform === "win32")(`preserves ${mode} status and tears down fixtures`, () => {
      const run = smokeFixture(mode);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(mode.endsWith("failure") ? 1 : 0);
      expect(run.calls).toContain("ps -a");
      expect(run.calls).toContain("down -v");
      expect(run.calls.includes("logs --no-color --tail 100")).toBe(mode.endsWith("failure"));
      if (mode === "retry") expect(run.calls.match(/exec -T/g)).toHaveLength(2);
      if (mode === "health-failure") expect(run.calls.match(/exec -T/g)).toHaveLength(60);
    });
  }
});

describe("bundled Compose storage readiness", () => {
  it("uses server flags supported by the pinned SeaweedFS version", () => {
    expect(compose.services.seaweed.command).toContain("-master.volumeSizeLimitMB=1024");
    expect(compose.services.seaweed.command).not.toContain("-volumeSizeLimitMB=1024");
    expect(compose.services.seaweed.command?.some(flag => flag.startsWith("-s3.externalUrl="))).toBe(false);
  });

  it("configures the daemon's rclone remote from the same S3 binding", () => {
    const env = compose.services.mcp.environment!;
    expect(env.RCLONE_CONFIG_SEAWEED_TYPE).toBe("s3");
    expect(env.RCLONE_CONFIG_SEAWEED_PROVIDER).toBe("Other");
    expect(env.SKILLWIKI_MCP_RCLONE_REMOTE).toBe("seaweed");
    expect(env.RCLONE_CONFIG_SEAWEED_ENDPOINT).toBe(env.SKILLWIKI_MCP_S3_ENDPOINT);
    expect(env.RCLONE_CONFIG_SEAWEED_ACCESS_KEY_ID).toBe(env.SKILLWIKI_MCP_S3_ACCESS_KEY);
    expect(env.RCLONE_CONFIG_SEAWEED_SECRET_ACCESS_KEY).toBe(env.SKILLWIKI_MCP_S3_SECRET_KEY);
    expect(env.SKILLWIKI_MCP_RCLONE_BUCKET).toBe(env.SKILLWIKI_MCP_S3_BUCKET);
  });

  it("creates the bucket before starting the daemon", () => {
    const init = compose.services["storage-init"];
    expect(init.entrypoint).toEqual(["rclone"]);
    expect(init.command).toContain("mkdir");
    expect(init.command).toContain("seaweed:${SKILLWIKI_MCP_S3_BUCKET:-wiki}");
    expect(init.environment).toEqual(compose.services.mcp.environment);
    expect(init.depends_on?.seaweed.condition).toBe("service_started");
    expect(compose.services.mcp.depends_on?.["storage-init"].condition).toBe("service_completed_successfully");
  });

  it("runs the bundled smoke gate on main and retains failure diagnostics", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("  mcp-server-compose-smoke:"));
    expect(job).not.toContain("if: github.ref_type == 'tag'");
    expect(job).toContain("bash scripts/smoke-bundled-compose.sh");
    const script = readFileSync(resolve(root, "scripts/smoke-bundled-compose.sh"), "utf8");
    expect(script).toContain("logs --no-color --tail 100");
    expect(script).toContain("ps -a");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("response.status");
    expect(script).toContain("AbortSignal.timeout");
  });
});
