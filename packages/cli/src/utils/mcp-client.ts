import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { redactMcpSecret } from "./mcp-auth-env.js";

export const MCP_PROBE_TIMEOUT_MS = 10_000;

export async function withMcpClient<T>(
  input: { url: string; token: string; clientName: string; version: string; fetchFn?: typeof fetch },
  probe: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const client = new Client({ name: input.clientName, version: input.version });
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    requestInit: { headers: { Authorization: `Bearer ${input.token}` } },
    fetch: (url, init) => fetchFn(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    }),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`MCP probe timed out after ${MCP_PROBE_TIMEOUT_MS}ms`);
      reject(error);
      controller.abort(error);
    }, MCP_PROBE_TIMEOUT_MS);
  });
  try {
    const work = async () => {
      await client.connect(transport, { signal: controller.signal, timeout: MCP_PROBE_TIMEOUT_MS });
      return probe(client, controller.signal);
    };
    return await Promise.race([work(), deadline]);
  } catch (error: unknown) {
    throw new Error(redactMcpSecret(error instanceof Error ? error.message : String(error), input.token));
  } finally {
    clearTimeout(timer);
    controller.abort();
    await client.close();
  }
}
