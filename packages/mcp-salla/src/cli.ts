#!/usr/bin/env node
/**
 * Process entry point. stdout is reserved for MCP protocol (stdio mode), so every diagnostic
 * goes to stderr and passes through `redact()`.
 */
import { parseCliArgs, USAGE } from './args.js';
import { isLoopbackHost, serverUrl, startHttpServer } from './http.js';
import { redact } from './redact.js';
import { runStdio } from './stdio.js';

function fail(message: string): never {
  process.stderr.write(`sirb-mcp-salla: ${redact(message, [process.env.SALLA_ACCESS_TOKEN])}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let command;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  if (command.mode === 'help') {
    process.stderr.write(USAGE);
    return;
  }

  if (command.mode === 'stdio') {
    await runStdio();
    return;
  }

  if (!isLoopbackHost(command.host)) {
    process.stderr.write(
      'sirb-mcp-salla: warning: listening on a non-loopback address. Bearer tokens travel in this ' +
        'connection; put the server behind TLS and an authenticating proxy.\n',
    );
  }
  const server = await startHttpServer({ host: command.host, port: command.port });
  process.stderr.write(`sirb-mcp-salla: listening on ${serverUrl(server)}\n`);
  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
