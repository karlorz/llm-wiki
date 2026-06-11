import { err, ok, type Result } from "./types.js";

export interface HeartbeatResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type HeartbeatFetch = (url: string) => Promise<HeartbeatResponse>;

export type HeartbeatResult =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "sent";
      url: string;
    };

export interface MaybeSendHeartbeatInput {
  enabled: boolean;
  url?: string;
  pushSucceeded: boolean;
  fetchFn?: HeartbeatFetch;
}

export async function maybeSendHeartbeat(input: MaybeSendHeartbeatInput): Promise<Result<HeartbeatResult>> {
  if (!input.enabled) return ok({ status: "skipped", reason: "heartbeat disabled" });
  if (!input.url) return ok({ status: "skipped", reason: "heartbeat URL missing" });
  if (!input.pushSucceeded) return ok({ status: "skipped", reason: "push did not succeed" });

  const fetchFn = input.fetchFn ?? defaultFetch;
  try {
    const response = await fetchFn(input.url);
    if (!response.ok) {
      return err("HEARTBEAT_FAILED", {
        status: response.status,
        body: await response.text(),
      });
    }
    return ok({ status: "sent", url: input.url });
  } catch (error) {
    return err("HEARTBEAT_FAILED", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const defaultFetch: HeartbeatFetch = async (url) => {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};
