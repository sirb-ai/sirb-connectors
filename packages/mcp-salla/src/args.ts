import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT, isLoopbackHost } from './http.js';

export type CliCommand =
  | { readonly mode: 'stdio'; readonly revealContactDetails: boolean }
  | {
      readonly mode: 'http';
      readonly host: string;
      readonly port: number;
      readonly allowRemote: boolean;
      readonly allowedHosts: readonly string[];
      readonly revealContactDetails: boolean;
    }
  | { readonly mode: 'help' };

export const USAGE = `Usage: sirb-mcp-salla [--stdio] | --http [--host 127.0.0.1] [--port 3000]
                      [--allow-remote --allowed-host <name>...] [--reveal-contact-details]

  --stdio                Run over stdio (default). Token from SALLA_ACCESS_TOKEN set by the MCP client.
  --http                 Run Streamable HTTP on /mcp. Token from each request's Authorization: Bearer header.
  --host <host>          HTTP bind address (default ${DEFAULT_HOST}).
  --port <port>          HTTP port (default ${DEFAULT_PORT}).
  --allow-remote         Required to bind a non-loopback address. Only behind TLS (mesh mTLS or a proxy).
  --allowed-host <name>  Accepted Host/Origin hostname. Repeatable; required with --allow-remote.
  --reveal-contact-details
                         Return customer email/mobile unmasked (default: masked). IBAN, bank details,
                         buyer IP and user agent are never returned.
  -h, --help             Show this help.
`;

const HOSTNAME = /^[A-Za-z0-9.:\-[\]]{1,253}$/;

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
      'allow-remote': { type: 'boolean' },
      'allowed-host': { type: 'string', multiple: true },
      'reveal-contact-details': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) return { mode: 'help' };
  if (values.stdio && values.http) throw new Error('Choose either --stdio or --http, not both.');

  const revealContactDetails = values['reveal-contact-details'] === true;

  if (!values.http) {
    if (
      values.host !== undefined ||
      values.port !== undefined ||
      values['allow-remote'] !== undefined ||
      values['allowed-host'] !== undefined
    ) {
      throw new Error('--host, --port, --allow-remote and --allowed-host are only valid with --http.');
    }
    return { mode: 'stdio', revealContactDetails };
  }

  const host = values.host ?? DEFAULT_HOST;
  if (!HOSTNAME.test(host)) throw new Error('Invalid --host.');

  const allowRemote = values['allow-remote'] === true;
  const allowedHosts = (values['allowed-host'] ?? []).map((h) => h.toLowerCase());
  for (const h of allowedHosts) {
    if (!HOSTNAME.test(h)) throw new Error('Invalid --allowed-host.');
  }
  if (!isLoopbackHost(host)) {
    if (!allowRemote) {
      throw new Error(`--host ${host} is not a loopback address; pass --allow-remote (only behind TLS).`);
    }
    if (allowedHosts.length === 0) throw new Error('--allow-remote requires at least one --allowed-host.');
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65_535) {
      throw new Error('Invalid --port (expected 0-65535).');
    }
    port = Number(values.port);
  }
  return { mode: 'http', host, port, allowRemote, allowedHosts, revealContactDetails };
}
