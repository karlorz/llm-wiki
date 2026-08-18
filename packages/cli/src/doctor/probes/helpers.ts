import { CheckResult, CheckStatus } from "../types.js";

export function check(status: CheckStatus, id: string, label: string, detail: string): CheckResult {
  return { id, label, status, detail };
}
