import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT } from './http.js';

export type CliCommand =
  | { readonly mode: 'stdio' }
  | { readonly mode: 'http'; readonly host: string; readonly port: number }
  | { readonly mode: 'help' };

export const USAGE = `Usage: sirb-mcp-salla [--stdio] | --http [--host 127.0.0.1] [--port 3000]

  --stdio        Run over stdio (default). Token from SALLA_ACCESS_TOKEN set by the MCP client.
  --http         Run Streamable HTTP on /mcp. Token from each request's Authorization: Bearer header.
  --host <host>  HTTP bind address (default ${DEFAULT_HOST}).
  --port <port>  HTTP port (default ${DEFAULT_PORT}).
  -h, --help     Show this help.
`;

/** Pure argv parser. Throws an Error with a user-facing message on bad input. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      stdio: { type: 'boolean' },
      http: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) return { mode: 'help' };
  if (values.stdio && values.http) throw new Error('Choose either --stdio or --http, not both.');

  if (!values.http) {
    if (values.host !== undefined || values.port !== undefined) {
      throw new Error('--host and --port are only valid with --http.');
    }
    return { mode: 'stdio' };
  }

  const host = values.host ?? DEFAULT_HOST;
  if (!/^[A-Za-z0-9.:\-[\]]{1,253}$/.test(host)) throw new Error('Invalid --host.');

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65_535) {
      throw new Error('Invalid --port (expected 0-65535).');
    }
    port = Number(values.port);
  }
  return { mode: 'http', host, port };
}
