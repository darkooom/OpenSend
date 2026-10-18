# Implementation status

Snapshot: 2026-10-18. "Verified" means covered by automated tests that were executed and
passed locally (see [TESTING.md](TESTING.md)). The launch-readiness worktree passes format, build,
lint, typecheck, all workspace tests (including 85 integration cases), and the fresh-install
Playwright flow. The previous GitHub CI run failed only while pulling the retired anonymous Quay
MinIO image; the replacement image is digest-pinned and health-checked locally. A new GitHub run
is still required before merge.

## Licensing

Platform: `AGPL-3.0-only` ([LICENSE](../LICENSE)). `@opensend/sdk` and `@opensend/contracts`:
MIT. These files are a candidate working-tree decision until the owner explicitly confirms it;
see [LICENSING_DECISION.md](LICENSING_DECISION.md). Still open: contribution terms (DCO or a CLA,
which is needed if dual licensing is ever planned).

## Release blockers

1. **Amazon SES not verified against a real account.** Adapter, DKIM handling and SNS
   verification are tested with test doubles only.
2. **No independent third-party penetration test.** A repository-wide Codex Security review was
   completed and its seven scan-start findings were remediated and regression-tested.
3. **License choice not explicitly confirmed for merge.** The working tree contains the
   recommended AGPL server / MIT SDK split, but the owner decision is still required.

## Implemented

| Area                                                                                                                                                                                                                                                                                                                                                           | Status                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Monorepo (pnpm, Turborepo, TS 6.0, lockfile, release-age policy respected)                                                                                                                                                                                                                                                                                     | done                                                |
| Config validation, production refusal of placeholder secrets / local provider / http webhooks                                                                                                                                                                                                                                                                  | verified (unit)                                     |
| PostgreSQL schema + migrations (Drizzle), UUIDv7 ids                                                                                                                                                                                                                                                                                                           | done, applied in every test run                     |
| Better Auth sessions, public sign-up disabled, one-time owner bootstrap, CLI token, password reset and verification through optional platform SMTP                                                                                                                                                                                                             | verified locally; real platform SMTP not tested     |
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
| GitHub Actions CI (frozen install, format, build, lint, typecheck, audit, tests with real services, e2e, image build)                                                                                                                                                                                                                                          | local equivalent passed; remote branch run pending  |

## Known limitations

- Account email, password reset, email verification and mailed invitations require an
  operator-configured platform SMTP sender; local Mailpit is covered, but a real authenticated
  TLS relay is not yet verified.
- Additional organizations can only be created by the platform operator (no self-service
  sign-up by design for now).
- Verified domain ownership is rechecked daily; missing records receive a 72-hour grace period
  before sending is revoked. Production resolver behavior is not covered end-to-end.
- The operator UI covers project pause; connection pause and the platform block list are API-only
  (`/api/admin/*`).
- Key rotation re-encrypts attachment objects in place; keep old keys until the command reports
  zero attachment failures and a restore drill succeeds.
- The rate limiter uses a weighted sliding window and fails closed for protected writes when
  Redis is unavailable; readiness also reports the API unavailable.
- The backlog check runs `count(*)` per acceptance (serialized per project); fine for moderate
  volume, not load-tested.
- With the default policy (`content = 0 days`) content is deleted right after the final state, so
  the dashboard cannot preview or resend those emails. Projects can raise the retention.
- Cancellation does not refund quota. `email.accepted`/`email.queued` are not webhook events.
- Plain SMTP relays never provide a provider message id or delivery events.
- Webhook payloads include recipient addresses for recipient-level events (personal data at the
  receiver).
- Projects, environments and organizations can be deleted through guarded danger-zone flows;
  deletion remains an operationally sensitive beta feature.
- The local stack uses a digest-pinned legacy MinIO community build because anonymous pulls of the
  former Quay image now fail. Any S3-compatible store works; production should use an actively
  maintained, operator-owned service.
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
