# Implementation status

Snapshot: 2026-10-17. "Verified" means covered by automated tests that were executed and
passed locally (see [TESTING.md](TESTING.md)); CI is configured but has not run on GitHub yet
(nothing has been pushed).

## Release blockers

1. **No license.** The repository contains no license, so nobody may use or redistribute it.
   The owner has to choose one (e.g. AGPL-3.0 vs. Apache-2.0/MIT has direct consequences for
   the planned managed service). Not decided on purpose.
2. **Amazon SES not verified against a real account.** Adapter, DKIM handling and SNS
   verification are tested with test doubles only.
3. **No security review / penetration test** by a third party.
4. **No dashboard password reset or email verification** (needs a platform sender).

## Implemented

| Area                                                                                                                                                                                                                                                                                                                                                           | Status                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Monorepo (pnpm, Turborepo, TS 6.0, lockfile, release-age policy respected)                                                                                                                                                                                                                                                                                     | done                                                |
| Config validation, production refusal of placeholder secrets / local provider / http webhooks                                                                                                                                                                                                                                                                  | verified (unit)                                     |
| PostgreSQL schema + migrations (Drizzle), UUIDv7 ids                                                                                                                                                                                                                                                                                                           | done, applied in every test run                     |
| Better Auth sessions, public sign-up disabled, one-time owner bootstrap, CLI token                                                                                                                                                                                                                                                                             | verified                                            |
| Organizations, roles, project-restricted memberships, invitations, last-owner protection                                                                                                                                                                                                                                                                       | verified                                            |
| Central server-side authorization (404 for foreign resources), CSRF origin check, no CORS                                                                                                                                                                                                                                                                      | verified                                            |
| API keys (prefix + SHA-256, scopes, expiry, revocation, once-only display)                                                                                                                                                                                                                                                                                     | verified                                            |
| `POST /v1/emails` validation, header-injection guards, limits, attachments (encrypted, private keys)                                                                                                                                                                                                                                                           | verified                                            |
| Atomic acceptance: idempotency (DB constraint), quota reservation, backlog limit, outbox                                                                                                                                                                                                                                                                       | verified incl. concurrency                          |
| Batch with per-item semantics and per-item idempotency                                                                                                                                                                                                                                                                                                         | verified                                            |
| Scheduling (never early), cancellation (atomic vs. claim)                                                                                                                                                                                                                                                                                                      | verified incl. races                                |
| Transactional outbox, dispatcher, BullMQ, Redis-loss recovery                                                                                                                                                                                                                                                                                                  | verified with real Redis                            |
| Send processor: leases, backoff + jitter, max attempts, error categories, `submission_unknown`                                                                                                                                                                                                                                                                 | verified                                            |
| Lease reaper; unknown-outcome clarification (Mailpit status lookup)                                                                                                                                                                                                                                                                                            | verified                                            |
| Manual resend (linked, duplicate confirmation, audit)                                                                                                                                                                                                                                                                                                          | verified                                            |
| Per-recipient submission + delivery facts, aggregation, append-only timeline                                                                                                                                                                                                                                                                                   | verified                                            |
| Local provider (Mailpit, real SMTP)                                                                                                                                                                                                                                                                                                                            | verified (real)                                     |
| Generic SMTP provider (TLS, guarded resolution, classification)                                                                                                                                                                                                                                                                                                | unit-verified; no real TLS relay tested             |
| SES provider (raw MIME, Bcc only in envelope, `maxAttempts: 1`, DKIM records from SES)                                                                                                                                                                                                                                                                         | test doubles only                                   |
| SNS verification + SES event ingestion, dedupe, late/unmatched events, tenant isolation                                                                                                                                                                                                                                                                        | verified with signed test messages                  |
| Domains: ownership TXT, provider identity after ownership, SPF/DMARC diagnostics, local-only domains                                                                                                                                                                                                                                                           | verified (fake DNS)                                 |
| Templates: draft, immutable published versions, variable validation, preview, escaping                                                                                                                                                                                                                                                                         | verified                                            |
| Webhooks: HMAC signing, rotation, retries, dead letters, replay, test events, SSRF guard, no redirects                                                                                                                                                                                                                                                         | verified                                            |
| Suppressions (tenant per environment, platform block list), automatic on hard bounce/complaint                                                                                                                                                                                                                                                                 | verified                                            |
| Retention (content, attachments, metadata) incl. "no content archive" mode; export (NDJSON)                                                                                                                                                                                                                                                                    | verified                                            |
| Audit log; operator pause of projects/connections                                                                                                                                                                                                                                                                                                              | verified (projects); connection pause via API only  |
| Health/readiness, graceful shutdown, Prometheus metrics, structured redacted logs                                                                                                                                                                                                                                                                              | implemented; health checked manually and in compose |
| OpenAPI 3.1 at `/v1/openapi.json` generated from contracts                                                                                                                                                                                                                                                                                                     | implemented                                         |
| TypeScript SDK with typed errors, idempotency, webhook verification                                                                                                                                                                                                                                                                                            | verified (unit + integration)                       |
| Dashboard: setup, sign-in, invitations, projects, overview + onboarding, emails (search, filters, detail, timeline, sandboxed preview, attachments, cancel/resend), domains, providers, API keys, templates, webhooks (+ deliveries, dead letters, replay), suppressions, settings (environments, retention, usage, export), members, audit log, operator page | implemented; e2e covers the main path               |
| Docker images (api, worker, web) and compose `app` profile                                                                                                                                                                                                                                                                                                     | built and smoke-tested locally                      |
| GitHub Actions CI (lockfile install, format, build, lint, typecheck, tests with real services, e2e, image build)                                                                                                                                                                                                                                               | configured, **not run yet**                         |

## Known limitations

- Invitations are not emailed; the inviter copies the link. Dashboard users cannot reset
  passwords themselves (an owner can remove and re-invite).
- Additional organizations can only be created by the platform operator (no self-service
  sign-up by design for now).
- Domain ownership is checked on demand, not re-verified periodically.
- The operator UI covers project pause; connection pause and the platform block list are API-only
  (`/api/admin/*`).
- Key rotation does not re-encrypt attachment objects; keep old keys until attachment retention
  passed.
- The rate limiter is a fixed window and fails open when Redis is unavailable.
- The backlog check runs `count(*)` per acceptance (serialized per project); fine for moderate
  volume, not load-tested.
- With the default policy (`content = 0 days`) content is deleted right after the final state, so
  the dashboard cannot preview or resend those emails. Projects can raise the retention.
- Cancellation does not refund quota. `email.accepted`/`email.queued` are not webhook events.
- Plain SMTP relays never provide a provider message id or delivery events.
- Webhook payloads include recipient addresses for recipient-level events (personal data at the
  receiver).
- Projects, environments and organizations cannot be deleted from the dashboard yet.
- The pinned MinIO image is from September 2025: MinIO stopped publishing newer community images.
  Any S3-compatible store works; the local stack may need a replacement eventually.
- User creation goes through Better Auth's internal adapter (`auth.$context`), which is not a
  documented public API; the version is pinned and covered by tests.
- Dashboard navigation on narrow screens uses a compact menu; dense tables scroll horizontally.

## Continuation pointers

| Next step                                                      | Files                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Real SES verification                                          | `packages/providers/src/ses.ts`, `apps/api/src/ingest/ses-events.controller.ts`, docs/SELF_HOSTING.md |
| Password reset / verification emails via a platform connection | `apps/api/src/auth/auth.ts` (Better Auth `sendResetPassword`), new platform sender config             |
| Connection pause + platform block list UI                      | `apps/web/src/app/(app)/admin/page.tsx`, `apps/api/src/admin/admin.controller.ts`                     |
| Periodic domain re-verification                                | `apps/worker/src/maintenance.ts`, `apps/api/src/domains/domains.service.ts`                           |
