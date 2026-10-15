#!/usr/bin/env node
/**
 * Process entry point. stdout is reserved for MCP protocol (stdio mode), so every diagnostic
 * goes to stderr and passes through `redact()`.
 */
import { parseCliArgs, USAGE } from './args.js';
import { isLoopbackHost, serverUrl, startHttpServer } from './http.js';
import { redact } from './redact.js';
import { runStdio } from './stdio.js';

/** Redacts the dynamic `message` only; `suffix` is static text (usage) and is printed as is. */
function fail(message: string, suffix = ''): never {
  process.stderr.write(`sirb-mcp-salla: ${redact(message, [process.env.SALLA_ACCESS_TOKEN])}\n${suffix}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let command;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), `\n${USAGE}`);
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
      'sirb-mcp-salla: warning: listening on a non-loopback address (--allow-remote). Bearer tokens travel ' +
        'in this connection; it must sit behind TLS (mesh mTLS or an authenticating proxy).\n',
    );
  }
  const server = await startHttpServer({
    host: command.host,
    port: command.port,
    allowRemote: command.allowRemote,
    ...(command.allowedHosts.length ? { allowedHostnames: command.allowedHosts } : {}),
  });
  process.stderr.write(`sirb-mcp-salla: listening on ${serverUrl(server)}\n`);
  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
