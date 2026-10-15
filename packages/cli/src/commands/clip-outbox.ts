import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { loadClipOutboxConfig, CLIP_NOT_CONFIGURED } from "../utils/clip-outbox-config.js";

export async function runClipOutboxStatus(home: string): Promise<{
  exitCode: number;
  result: Result<{ enabled: boolean; humanHint: string }>;
}> {
  const resolved = await loadClipOutboxConfig(home);
  if (!resolved.ok) {
    return {
      exitCode: ExitCode.INVALID_CONFIG_VALUE,
      result: err("INVALID_CONFIG_VALUE", { message: resolved.message }),
    };
  }
  if (!resolved.enabled) {
    return {
      exitCode: ExitCode.OK,
      result: ok({ enabled: false, humanHint: CLIP_NOT_CONFIGURED }),
    };
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({
      enabled: true,
      humanHint: `clip-outbox enabled root=${resolved.config.root} mode=${resolved.config.mode}`,
    }),
  };
}
