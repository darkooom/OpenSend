# Contributing to OpenSend

Thanks for helping make self-hosted email infrastructure safer and easier to operate. OpenSend is
pre-release software: discuss large features before investing in an implementation, and keep pull
requests focused enough to review and test.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- Corepack with the pnpm version pinned in `package.json`
- Docker with Compose v2
- Git

## Local setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm setup:local
pnpm services:up
pnpm build
pnpm db:migrate
pnpm bootstrap:token
pnpm dev
```

`pnpm setup:local` creates a mode-`600` `.env` with random local secrets and never overwrites an
existing file. Open <http://localhost:3000/setup>; Mailpit is at <http://localhost:58025>.
Production setup is documented in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Before opening a pull request

Run the same meaningful checks as CI:

```bash
pnpm format:check
pnpm build
pnpm lint
pnpm typecheck
pnpm services:up
pnpm test
pnpm test:e2e
pnpm audit --audit-level=high
```

Tests use isolated databases and local services. Never point them at production. See
[docs/TESTING.md](docs/TESTING.md) for the test layers and known external-service gaps.

## Code and database conventions

- Keep controllers thin; put authorization-aware use cases in services.
- Resolve tenant-owned resources through `AccessService` and retain project/environment filters in
  every query. A route parameter is never proof of ownership.
- Define public shapes in `packages/contracts`, then reuse them in validation, OpenAPI, SDK and UI.
- PostgreSQL is the durable source of truth. Queue work must remain recoverable from the outbox.
- Add generated Drizzle SQL and metadata for schema changes. Migrations must be forward-only and
  safe to run before the new application version starts.
- Preserve the distinction between submission and delivery states. Never present provider
  acceptance as recipient delivery.
- Add or update tests for behavior changes, especially tenant boundaries, retries, idempotency,
  quotas, retention and authorization.

Formatting is enforced by Prettier and linting by ESLint. Follow the existing TypeScript style;
avoid unrelated rewrites or broad dependency upgrades in feature pull requests.

## Issues and feature proposals

Use the issue forms for reproducible bugs and scoped feature requests. For substantial changes,
open a feature request first and describe the user problem, security/tenancy impact, migration
needs and alternatives considered.

Do not include API keys, cookies, SMTP or cloud credentials, message bodies, recipient addresses,
customer data, private logs or production database extracts. Redact request IDs only when they can
be correlated to private infrastructure. Security vulnerabilities must follow [SECURITY.md](SECURITY.md),
not a public issue.

## Commits and pull requests

- Use a short imperative subject; explain the reason and operational impact in the body when useful.
- Keep generated files and lockfile changes with the code that requires them.
- Describe validation performed and anything not verified (for example, a real SES account).
- Call out migrations, configuration changes, compatibility risks and security-sensitive behavior.
- Link the relevant issue, update documentation, and add an entry under `Unreleased` in
  [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

Maintainers may ask for a smaller PR, additional tenant-isolation tests or a security review before
merging. Do not use real customer data or live sending credentials in review apps or test fixtures.
