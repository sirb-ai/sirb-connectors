import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSallaClient } from './salla-client.js';
import { createSallaServer } from './server.js';
import type { SallaToolOptions } from './tools.js';
import { isValidBearerToken, MAX_TOKEN_LENGTH } from './token.js';

export const TOKEN_ENV_VAR = 'SALLA_ACCESS_TOKEN';

/**
 * Reads the token the MCP client put in this process's environment (its server launch `env` block).
 * No `.env` file is ever loaded.
 */
export function readStdioToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env[TOKEN_ENV_VAR]?.trim();
  if (!token) {
    throw new Error(
      `${TOKEN_ENV_VAR} is not set. Set it in your MCP client's server "env" block; ` +
        'this server never reads .env files.',
    );
  }
  if (!isValidBearerToken(token)) {
    // Never echo the value: it may be a real (if mangled) secret.
    throw new Error(
      `${TOKEN_ENV_VAR} is not a valid OAuth access token (expected RFC 6750 token characters, ` +
        `at most ${MAX_TOKEN_LENGTH} characters). Check the value in your MCP client's server "env" block.`,
    );
  }
  return token;
}

/** Runs the server over stdio. Only MCP protocol messages are written to stdout. */
export async function runStdio(
  env: NodeJS.ProcessEnv = process.env,
  options: SallaToolOptions = {},
): Promise<McpServer> {
  const server = createSallaServer(createSallaClient({ accessToken: readStdioToken(env) }), options);
  await server.connect(new StdioServerTransport());
  return server;
}
