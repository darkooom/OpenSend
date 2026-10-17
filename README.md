# OpenSend

> Working name. A developer-focused platform for transactional email with real project
> separation, controllable data retention and an exchangeable sending provider.
> Self-host it, or (later) use it as a managed service.

OpenSend is aimed at developers, agencies and SaaS teams that send email for several
customers or products. Each customer gets a **project** with its own environments, domains,
API keys, provider connection, templates, webhooks, suppression list, usage and retention
policy. The full product runs without any OpenSend-operated service: no license server, no
phone-home, no feature gates.

> **Status:** pre-release. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)
> for what is implemented and verified, and the release blockers (no license chosen yet).

## What it does

- **Public HTTP API** (`/v1`) to send single and batch emails with idempotency keys,
  scheduling, templates, attachments, tags and allow-listed custom headers. `202 Accepted`
  means _durably accepted_, never _delivered_.
- **Reliable processing**: transactional outbox in PostgreSQL, BullMQ/Redis as the work
  queue, leases, bounded retries with backoff and jitter, and an explicit
  `submission_unknown` state instead of blind re-sends.
- **Providers**: local development delivery to Mailpit, generic SMTP (TLS), Amazon SES
  (official SDK, SNS-signed events). Capabilities are explicit per provider.
- **Domains**: per-project ownership proof (TXT), provider identity records reported by the
  adapter (e.g. SES DKIM CNAMEs), SPF/DMARC diagnostics.
- **Per-recipient tracking**: submission and delivery facts (delivered, bounced, complained)
  are kept per recipient and never overwrite each other.
- **Webhooks**: HMAC-signed, retried, replayable, with dead-letter view and SSRF protection.
- **Tenancy & roles**: organizations, owner/admin/developer/viewer roles, members limited to
  selected projects, short-lived invitations, audit log, platform-operator pause.
- **Privacy controls**: per-project retention for content, attachments and metadata, a mode
  without long-term content archive, encrypted content/attachments/credentials, export.
- **Dashboard** (Next.js) with onboarding, email search and timeline, sandboxed HTML preview,
  domains, providers, keys, templates, webhooks, suppressions, members, audit log.
- **TypeScript SDK** (`@opensend/sdk`) with typed errors, idempotency and webhook verification.

## Quick start (local)

Requirements: Node.js 24, pnpm 11 (`corepack enable`), Docker.

```bash
corepack enable
pnpm install
pnpm setup:local          # writes .env with random local secrets (never overwrites)
pnpm services:up          # PostgreSQL, Redis, MinIO, Mailpit
pnpm build
pnpm db:migrate
pnpm bootstrap:token      # prints a one-time setup token (valid 60 min)
pnpm dev                  # API :3001, worker, dashboard :3000
```

Open <http://localhost:3000/setup>, paste the token and create the first owner. Then:

1. **New project** (creates `development`, optionally `production`).
2. **Providers** → _Local (Mailpit)_ → _Save as default connection_.
3. **Domains** → add e.g. `myapp.test` (reserved test domains need no DNS, local provider only).
4. **API keys** → create a key with `emails:send` (shown once).
5. Send:

```bash
curl -X POST http://localhost:3001/v1/emails \
  -H "Authorization: Bearer $OPENSEND_API_KEY" \
  -H "Idempotency-Key: welcome-42" \
  -H "Content-Type: application/json" \
  -d '{"from":"My App <hello@myapp.test>","to":["you@example.test"],"subject":"Hello","text":"It works."}'
```

6. Open Mailpit at <http://localhost:58025> — the message is there. The dashboard shows it as
   **Submitted** (accepted by the transport), not as delivered.

Host ports are chosen to avoid clashes (`54329` Postgres, `56379` Redis, `59000/59001` MinIO,
`51025/58025` Mailpit) and can be changed via `OPENSEND_*_PORT` variables, see
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Repository layout

```
apps/api            NestJS HTTP API: /v1 (API keys), /api (dashboard sessions), /webhooks/ses
apps/worker         Outbox dispatcher + BullMQ processors + maintenance jobs
apps/web            Next.js dashboard (App Router, Tailwind, shadcn/ui)
packages/contracts  Zod contracts shared by API, SDK, dashboard and OpenAPI
packages/db         Drizzle schema, migrations, client
packages/core       Domain logic shared by API and worker (crypto, outbox, events, SSRF guard, ...)
packages/providers  Provider adapters (local Mailpit, SMTP, SES) + SNS verification
packages/sdk        TypeScript client
packages/config     Validated runtime configuration, shared TS/ESLint config
tests/integration   System tests against real PostgreSQL/Redis/Mailpit
e2e                 Playwright end-to-end test of a fresh installation
docs                Architecture, API, security, operations, testing, roadmap
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API reference](docs/API.md) (also `GET /v1/openapi.json`)
- [Security model](docs/SECURITY.md) (permission matrix, crypto, SSRF, webhooks)
- [Self-hosting](docs/SELF_HOSTING.md)
- [Operations](docs/OPERATIONS.md) (health, metrics, backup/restore, recovery)
- [Testing](docs/TESTING.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Roadmap](docs/ROADMAP.md)

## License

**Not decided yet.** No license file is included, which means no rights are granted. Choosing
a license is a release blocker; see [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

OpenSend is an independent project. It does not claim API compatibility with any other email
service.
