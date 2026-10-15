/**
 * Streamable HTTP transport, stateless. Every POST /mcp gets its own McpServer + transport bound to
 * the bearer token on that request, so tokens never cross callers or tenants.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { redact } from './redact.js';
import { createSallaClient, type SallaClient } from './salla-client.js';
import { createSallaServer } from './server.js';
import { isValidBearerToken, MAX_TOKEN_LENGTH } from './token.js';

export const MCP_PATH = '/mcp';
export const MAX_BODY_BYTES = 1024 * 1024;
const BEARER_PREFIX = /^Bearer (\S+)$/;

export interface HttpHandlerOptions {
  /** Builds the per-request Salla client. Tests inject a fake; production uses the real client. */
  readonly createClient?: (accessToken: string) => SallaClient;
  /**
   * Allowed `Host` header hostnames (DNS-rebinding protection). `undefined` disables the check.
   * `startHttpServer` sets loopback names automatically when bound to a loopback address.
   */
  readonly allowedHostnames?: readonly string[];
  /** Where diagnostics go (always redacted). Defaults to stderr. */
  readonly log?: (message: string) => void;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const defaultLog = (message: string): void => {
  process.stderr.write(`[sirb-mcp-salla] ${message}\n`);
};

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Extracts the bearer token, or `undefined` if the header is missing or malformed. */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) return undefined;
  const token = BEARER_PREFIX.exec(header.trim())?.[1];
  return token !== undefined && isValidBearerToken(token) ? token : undefined;
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Pathname of the request target, or `undefined` if it cannot be parsed (e.g. `http://[`). */
export function safePathname(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? '/', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHttpHandler(options: HttpHandlerOptions = {}): HttpHandler {
  const createClient = options.createClient ?? ((accessToken: string) => createSallaClient({ accessToken }));
  const log = options.log ?? defaultLog;
  const allowed = options.allowedHostnames?.map((h) => h.toLowerCase());

  return async (req, res) => {
    const pathname = safePathname(req.url);
    if (pathname === undefined) {
      sendJsonRpcError(res, 400, -32600, 'Invalid request target.');
      return;
    }

    if (allowed) {
      const hostname = hostnameOf(req.headers.host);
      if (!hostname || !allowed.includes(hostname)) {
        sendJsonRpcError(res, 403, -32000, 'Forbidden host.');
        return;
      }
    }

    if (pathname !== MCP_PATH) {
      sendJsonRpcError(res, 404, -32000, 'Not found.');
      return;
    }

    const token = parseBearer(req.headers.authorization);
    if (!token) {
      sendJsonRpcError(res, 401, -32001, 'Missing or malformed bearer token (a Salla access token is required).', {
        'WWW-Authenticate': 'Bearer realm="sirb-mcp-salla"',
      });
      return;
    }

    // Stateless server: no SSE GET stream and no session DELETE.
    if (req.method !== 'POST') {
      sendJsonRpcError(res, 405, -32000, 'Method not allowed.', { Allow: 'POST' });
      return;
    }

    const rejectTooLarge = (): void => {
      // Unread body bytes would poison a kept-alive socket, so close it after replying.
      // `req.socket` is already null if the early exit from the body stream destroyed the request.
      const socket = req.socket as Socket | null;
      res.once('finish', () => socket?.destroy());
      sendJsonRpcError(res, 413, -32000, 'Request body too large.', { Connection: 'close' });
    };
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      rejectTooLarge();
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        rejectTooLarge();
      } else {
        sendJsonRpcError(res, 400, -32700, 'Parse error.');
      }
      return;
    }

    // MCP 2025-06-18 removed JSON-RPC batching. Rejecting arrays also stops one POST from fanning
    // out into many concurrent Salla calls (and draining per-IP rate limits).
    if (Array.isArray(body)) {
      sendJsonRpcError(res, 400, -32600, 'JSON-RPC batch requests are not supported.');
      return;
    }

    try {
      const server = createSallaServer(createClient(token));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`request failed: ${redact(err, [token])}`);
      sendJsonRpcError(res, 500, -32603, 'Internal server error.');
    }
  };
}

export interface StartHttpServerOptions extends HttpHandlerOptions {
  readonly host?: string;
  readonly port?: number;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/**
 * Wraps a handler so that no rejection can escape into the process (an unhandled rejection would
 * terminate the server for every tenant). Logs through `redact()`, replies 500 if nothing has been
 * sent yet, and always ends the response.
 */
export function withErrorBoundary(
  handler: HttpHandler,
  log: (message: string) => void = defaultLog,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    let pending: Promise<void>;
    try {
      pending = handler(req, res);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.catch((err: unknown) => {
      try {
        log(`unhandled request error: ${redact(err, [parseBearer(req.headers.authorization)])}`);
      } finally {
        sendJsonRpcError(res, 500, -32603, 'Internal server error.');
        if (!res.writableEnded) res.end();
      }
    });
  };
}

/** Starts the HTTP server and resolves once it is listening. */
export async function startHttpServer(options: StartHttpServerOptions = {}): Promise<Server> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const allowedHostnames =
    options.allowedHostnames ?? (isLoopbackHost(host) ? ['127.0.0.1', 'localhost', '[::1]'] : undefined);
  const handler = createHttpHandler({ ...options, allowedHostnames });

  const server = createServer(withErrorBoundary(handler, options.log));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export function serverUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}${MCP_PATH}`;
}
