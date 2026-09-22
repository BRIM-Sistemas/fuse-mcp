#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type {
  JSONRPCMessage,
  Transport,
} from '@modelcontextprotocol/sdk/types.js';

export interface BridgeConfig {
  apiUrl: string;
  token: string;
  mcpPath: string;
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface McpBridgeOptions {
  transport?: Transport;
  fetchFn?: typeof fetch;
}

/**
 * Validates environment variables for the Fuse MCP bridge.
 */
export function validateBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const rawToken = env.FUSE_TOKEN?.trim();
  if (!rawToken) {
    throw new Error(
      'FUSE_TOKEN is required. Please set FUSE_TOKEN to a valid token starting with fuse_live_',
    );
  }

  if (!rawToken.startsWith('fuse_live_')) {
    throw new Error(
      'FUSE_TOKEN must start with "fuse_live_". Received invalid token prefix.',
    );
  }

  const rawApiUrl = env.FUSE_API_URL?.trim() || 'http://localhost:3334';
  let apiUrl: string;
  try {
    const parsed = new URL(rawApiUrl);
    apiUrl =
      parsed.origin +
      (parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '');
  } catch {
    throw new Error(
      `Invalid FUSE_API_URL: "${rawApiUrl}". Expected a valid HTTP or HTTPS URL.`,
    );
  }

  const rawMcpPath = env.FUSE_MCP_PATH?.trim() || '/api/v1/mcp';
  const cleanPath = rawMcpPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const mcpPath = cleanPath.length > 0 ? `/${cleanPath}` : '/api/v1/mcp';

  return {
    apiUrl,
    token: rawToken,
    mcpPath,
  };
}

/**
 * Parses a raw SSE event block into an SseEvent object.
 */
export function parseSseBlock(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];
  let id: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    }
  }

  if (dataLines.length === 0 && event === 'message') {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n'),
    ...(id ? { id } : {}),
  };
}

/**
 * Resolves the relative or absolute endpoint URL returned by SSE against the API base URL.
 */
export function resolveEndpointUrl(
  apiUrl: string,
  endpointData: string,
): string {
  return new URL(endpointData, apiUrl).toString();
}

const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const POST_ATTEMPTS = 3;

const READ_ONLY_TOOLS = new Set([
  'fuse_get_context',
  'fuse_list_empresas',
  'participantes_list',
  'participantes_get',
  'produtos_servicos_list',
  'financas_contas_receber_list',
  'financas_contas_pagar_list',
  'financas_caixas_bancos_list',
  'dashboard_kpis_get',
  'relatorios_inadimplencia',
]);

export function isMessageSafeToRetry(message: JSONRPCMessage): boolean {
  if (!('method' in message) || typeof message.method !== 'string') {
    return false;
  }
  if (
    message.method === 'initialize' ||
    message.method === 'ping' ||
    message.method === 'tools/list' ||
    message.method === 'resources/list' ||
    message.method === 'resources/read' ||
    message.method === 'prompts/list' ||
    message.method === 'prompts/get'
  ) {
    return true;
  }
  if (message.method === 'tools/call') {
    const toolName = (message as any).params?.name;
    return typeof toolName === 'string' && READ_ONLY_TOOLS.has(toolName);
  }
  return false;
}

/**
 * MCP Stdio to HTTP bridge for Fuse ERP.
 * Connects standard input/output (used by Claude Desktop, Cursor, Antigravity)
 * to the remote or local Fuse MCP Server.
 */
export class McpBridge {
  private readonly config: BridgeConfig;
  private readonly transport: Transport;
  private readonly fetchFn: typeof fetch;
  private readonly abortController = new AbortController();
  private endpointUrl: string | null = null;
  private isRunning = false;
  private sseLoop: Promise<void> | null = null;

  constructor(config: BridgeConfig, options: McpBridgeOptions = {}) {
    this.config = config;
    this.transport = options.transport ?? new StdioServerTransport();
    this.fetchFn = options.fetchFn ?? fetch;
  }

  getEndpointUrl(): string | null {
    return this.endpointUrl;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    this.transport.onmessage = ((message: JSONRPCMessage) => {
      return this.handleClientMessage(message);
    }) as Transport['onmessage'];

    this.transport.onerror = (err) => {
      console.error('[fuse-mcp-bridge] Transport error:', err);
    };

    this.transport.onclose = () => {
      console.error('[fuse-mcp-bridge] Transport closed');
      void this.stop();
    };

    await this.transport.start();

    // SSE connects in background. Discovery occurs via direct POST to /messages.
    this.sseLoop = this.maintainSseConnection();
  }

  private messagesUrl(): string {
    return `${this.config.apiUrl}${this.config.mcpPath}/messages`;
  }

  private async maintainSseConnection(): Promise<void> {
    let attempt = 0;
    while (this.isRunning && !this.abortController.signal.aborted) {
      try {
        await this.openSseStream();
        attempt = 0;
      } catch (err: any) {
        if (!this.isRunning || this.abortController.signal.aborted) {
          return;
        }
        attempt += 1;
        console.error(
          `[fuse-mcp-bridge] SSE unavailable (attempt ${attempt}): ${err?.message ?? err}`,
        );
      }

      if (!this.isRunning || this.abortController.signal.aborted) {
        return;
      }
      const delay = Math.min(500 * 2 ** Math.min(attempt, 5), 15_000);
      await this.sleep(delay);
    }
  }

  private async openSseStream(): Promise<void> {
    const sseUrl = `${this.config.apiUrl}${this.config.mcpPath}/sse`;
    console.error(`[fuse-mcp-bridge] Connecting to SSE at ${sseUrl}...`);

    const response = await this.fetchFn(sseUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Failed to connect to MCP SSE endpoint (HTTP ${response.status}): ${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error('SSE response body is empty or unavailable');
    }

    console.error('[fuse-mcp-bridge] Connected to SSE stream.');
    await this.readSseStream(response.body);
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.abortController.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async readSseStream(
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const abortHandler = () => {
      void reader.cancel().catch(() => {});
    };

    if (this.abortController.signal.aborted) {
      void reader.cancel().catch(() => {});
      return;
    }
    this.abortController.signal.addEventListener('abort', abortHandler, {
      once: true,
    });

    try {
      while (!this.abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/(?:\r?\n){2}/);
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const parsed = parseSseBlock(part);
          if (parsed) {
            await this.handleSseEvent(parsed);
          }
        }
      }

      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) {
          await this.handleSseEvent(parsed);
        }
      }
    } catch (err: any) {
      if (!this.abortController.signal.aborted) {
        console.error(
          '[fuse-mcp-bridge] Error reading SSE stream:',
          err?.message ?? err,
        );
      }
    } finally {
      this.abortController.signal.removeEventListener('abort', abortHandler);
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  private async handleSseEvent(event: SseEvent): Promise<void> {
    if (event.event === 'endpoint') {
      const trimmed = event.data.trim();
      this.endpointUrl = resolveEndpointUrl(this.config.apiUrl, trimmed);
      console.error(
        `[fuse-mcp-bridge] Messages endpoint ready: ${this.endpointUrl}`,
      );
      return;
    }

    if (event.event === 'message' || event.event === '') {
      return;
    }

    console.error(
      `[fuse-mcp-bridge] Ignoring unsupported SSE event '${event.event}'`,
    );
  }

  private async handleClientMessage(message: JSONRPCMessage): Promise<void> {
    await this.postMessage(message);
  }

  private requestIdOf(message: JSONRPCMessage): string | number | undefined {
    if (!('id' in message)) {
      return undefined;
    }
    const id = message.id;
    if (typeof id === 'string' || typeof id === 'number') {
      return id;
    }
    return undefined;
  }

  private async postMessage(message: JSONRPCMessage): Promise<void> {
    const requestId = this.requestIdOf(message);
    const safeToRetry = isMessageSafeToRetry(message);
    const maxAttempts = safeToRetry ? POST_ATTEMPTS : 1;
    let lastStatus = 0;
    let lastText = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.abortController.signal.aborted) {
        return;
      }

      try {
        const response = await this.fetchFn(this.messagesUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(message),
          signal: this.abortController.signal,
        });

        lastStatus = response.status;
        try {
          lastText = await response.text();
        } catch (readErr: any) {
          if (attempt === maxAttempts) {
            await this.deliverHttpResult(
              requestId,
              false,
              response.status,
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: `Failed to read response body: ${readErr?.message || 'Network error'}`,
                },
              }),
            );
            return;
          }
          throw readErr;
        }

        const retryable =
          !response.ok && RETRYABLE_HTTP_STATUS.has(response.status);
        if (!retryable || attempt === maxAttempts) {
          await this.deliverHttpResult(requestId, response.ok, lastStatus, lastText);
          return;
        }
      } catch (err: any) {
        if (this.abortController.signal.aborted) {
          return;
        }
        if (attempt === maxAttempts) {
          console.error(
            '[fuse-mcp-bridge] Network error sending message:',
            err?.message ?? err,
          );
          await this.deliverHttpResult(
            requestId,
            false,
            0,
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: err?.message || 'Network error sending message',
              },
            }),
          );
          return;
        }
      }

      console.error(
        `[fuse-mcp-bridge] POST /messages failed (HTTP ${lastStatus}), retry ${attempt}/${maxAttempts}`,
      );
      await this.sleep(200 * attempt);
    }
  }

  private async deliverHttpResult(
    requestId: string | number | undefined,
    ok: boolean,
    status: number,
    text: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      if (requestId === undefined) {
        return;
      }
      await this.transport.send({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32000,
          message: ok
            ? 'Empty response body from MCP server'
            : `MCP request failed (HTTP ${status || 'network'})`,
        },
      });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      console.error(
        `[fuse-mcp-bridge] MCP response was not JSON (HTTP ${status}): ${trimmed.slice(0, 200)}`,
      );
      if (requestId === undefined) {
        return;
      }
      await this.transport.send({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32000,
          message: `MCP response was not JSON (HTTP ${status})`,
        },
      });
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    const id =
      typeof payload.id === 'string' || typeof payload.id === 'number'
        ? payload.id
        : requestId;
    if (id === undefined) {
      return;
    }

    if (!ok) {
      console.error(
        `[fuse-mcp-bridge] Error POSTing message (HTTP ${status}): ${trimmed.slice(0, 300)}`,
      );
    }

    const error = payload.error;
    const result = payload.result;
    if (error === undefined && result === undefined) {
      return;
    }

    await this.transport.send(
      error !== undefined
        ? { jsonrpc: '2.0', id, error }
        : { jsonrpc: '2.0', id, result },
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    this.abortController.abort();

    try {
      await this.transport.close();
    } catch (err) {
      console.error('[fuse-mcp-bridge] Error closing transport:', err);
    }

    if (this.sseLoop) {
      await this.sseLoop.catch(() => {});
    }

    console.error('[fuse-mcp-bridge] Bridge stopped.');
  }
}

/**
 * Main entry point for CLI execution.
 */
export async function main(): Promise<void> {
  const config = validateBridgeConfig(process.env);
  const bridge = new McpBridge(config);

  const shutdown = async () => {
    console.error('[fuse-mcp-bridge] Signal received, shutting down gracefully...');
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await bridge.start();
  } catch (err: any) {
    console.error('[fuse-mcp-bridge] Fatal error:', err?.message ?? err);
    await bridge.stop().catch(() => {});
    process.exit(1);
  }
}

if (
  (typeof process !== 'undefined' &&
    process.argv &&
    process.argv[1] &&
    import.meta.url === `file://${process.argv[1]}`) ||
  (import.meta as any).main
) {
  void main();
}
