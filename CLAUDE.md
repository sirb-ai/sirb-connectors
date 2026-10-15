# Sirb — shared instructions for Claude

Sirb is an open-core agentic framework: one declarative **Agent Spec** that runs natively on
**Node.js and .NET**, with a Model Gateway that bills tokens, RAG, MCP connectors (MENA commerce,
ERP, CRM, IoT), generated UIs (React, Blazor) and a SaaS control plane.
Owner: Ahmed Dahy. GitHub org: `sirb-ai`. npm scope `@sirb`, NuGet prefix `Sirb.*`.

The requirements live in `sirb-spec/docs/requirements.md` (BRD + SRS). Every requirement has an ID:
`BR-xx`, `SR-<COMP>-xx`, `NFR-xx`, `SEC-xx`. Quote the IDs you implement in commits and PRs.

## Repositories

| Repo | What lives there | Visibility |
| --- | --- | --- |
| sirb-spec | Agent Spec JSON Schema, conformance fixtures, AI security evals, requirements | public |
| sirb-js | Node.js runtime, CLI, gateway client, React UI kit, Studio (pnpm + Turborepo) | public |
| sirb-dotnet | .NET runtime, CLI, Blazor UI kit (.NET 10) | public |
| sirb-connectors | MCP servers: Salla, Zid, Odoo, Shopify, WooCommerce, Paymob | public |
| sirb-templates | Starter agents | public |
| sirb-docs | Docs site (Astro Starlight, English + Arabic) | public |
| sirb-helm | Helm charts, Docker Compose | public |
| sirb-platform | Control plane: Model Gateway, billing ledger, identity, registry (NestJS) | private |
| sirb-portal | Website, customer portal, admin back-office (Next.js) | private |
| sirb-infra | OpenTofu, Argo CD, policies | private |

## Rules that apply everywhere

1. **Spec first.** Any change to agent behaviour starts in `sirb-spec` (schema + conformance fixture),
   then lands in **both** runtimes. A feature is not done until Node and .NET pass the same fixtures.
2. **Thin core.** Build on Vercel AI SDK Core (Node) and Microsoft.Extensions.AI (.NET). No deep
   class hierarchies; prefer plain functions and data.
3. **Security is a gate, not a phase.** Follow OWASP ASVS 5.0 L2 and the OWASP LLM + Agentic Top 10
   (SRS 11). Never commit secrets, never read `.env` files, never log prompts or keys unredacted.
4. **Tenant scope everything.** Every table and query in the platform carries `org_id` (SR-IAM-07).
5. **Billing must be exact.** Usage events are idempotent (`request_id`), the ledger is append-only
   double-entry, prices are versioned (SR-BILL-01..04). Never edit balances directly.
6. **Small PRs.** One concern per PR, branch from `main`, conventional commit messages
   (`feat:`, `fix:`, `chore:`, `docs:`, `test:`), and a PR body listing requirement IDs and how you
   verified the change. Never force-push to `main`; never merge your own PR unless told to.
7. **Prove it.** Run the repo's build, lint and tests before saying you're done. Add tests with
   every change; core and billing code keep ≥ 80% coverage.
8. **Ask before** changing: billing or ledger logic, authentication/authorization, the public Spec
   schema (breaking), infrastructure, licenses, or anything that costs money.

## Specialist agents (in `.claude/agents/`)

Delegate to these by name: `architect` (plans, ADRs, spec), `node-engineer`, `dotnet-engineer`,
`parity-checker` (Node vs .NET conformance), `security-reviewer`, `test-engineer`,
`docs-writer` (English + Arabic), `devops-engineer` (CI/CD, Helm, infra).
For a non-trivial feature: architect plans → engineers implement → test-engineer and
parity-checker verify → security-reviewer reviews → docs-writer documents.

## This repo: sirb-connectors

One MCP server per package in `packages/mcp-<system>` (Salla, Zid, Odoo, Shopify, WooCommerce, Paymob).
Each tool is tagged `read`, `write` or `destructive`; destructive tools require approval (SR-CONN-03).
Credentials come from the caller's vault, never from code or env files. Contract tests use sandbox
accounts and recorded fixtures; no live calls in unit tests.
Commands: `pnpm install` · `pnpm -r build` · `pnpm -r test`.
