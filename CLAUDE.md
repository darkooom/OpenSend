# OpenSend — notes for AI coding agents

Transactional email platform (working name). Read `docs/ARCHITECTURE.md` first.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm services:up            # docker compose: postgres :54329, redis :56379, minio :59000, mailpit :51025/:58025
pnpm build                  # turbo; tests and apps consume built dist/ of the packages
pnpm db:migrate
pnpm dev                    # api :3001, worker, web :3000
pnpm test                   # unit + integration (needs services + build)
pnpm test:e2e               # Playwright fresh-install test
pnpm lint && pnpm typecheck && pnpm format:check
pnpm db:generate            # after editing packages/db/src/schema.ts (creates SQL in packages/db/drizzle)
```

## Rules of this codebase

- **Contracts first**: request/response shapes, states and permissions live in
  `packages/contracts`. Do not redefine them in apps.
- **Authorization**: management handlers must resolve access via `AccessService`
  (`requireOrg` / `requireProject` / `requireEnvironment`) and filter every query by
  `project_id` and `environment_id`. Never trust ids from the request alone. Foreign
  resources → 404.
- **State changes** of emails are conditional `UPDATE … WHERE status IN (…)` following
  `EMAIL_TRANSITIONS`. Never resend automatically from `submission_unknown` or an expired lease.
- **Acceptance** stays one transaction (idempotency claim, quota, rows, events, outbox).
  Jobs carry ids only.
- **Secrets/content**: encrypt with `KeyRing` (AAD = `<table>:<id>`), never log them, pass error
  text through `redact()`.
- **Outbound HTTP/SMTP to tenant targets** only via `safeFetch` / `resolveSafeAddress`.
- **Audit** security-relevant management actions with `writeAudit`.
- UI: tokens in `apps/web/src/app/globals.css` (petrol accent only for primary actions and the
  current nav item, 1px borders, IBM Plex). Every data view handles loading, empty, error and
  success. Message HTML only via `HtmlPreview` (sandboxed iframe).
- Dependencies: exact versions, respect pnpm's `minimumReleaseAge` (pick an older release
  instead of adding exclusions). Do not add a license; that is the owner's decision.
- Do not push, publish, deploy, change DNS or send real external email without explicit approval.
  Local email goes to Mailpit only.
- zsh: quote paths with `[...]` / `(...)` (Next.js route folders).
