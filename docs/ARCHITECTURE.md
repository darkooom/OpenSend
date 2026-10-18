# Architecture

OpenSend is a **modular monolith with a separate worker**: one HTTP API process, one or more
worker processes, a Next.js dashboard, PostgreSQL as the durable source of truth, Redis as the
work queue and an S3-compatible object store for attachments.

```
             ┌──────────────┐  /api (session cookie, same-origin proxy)
 browser ───▶│  apps/web    │──────────────┐
             └──────────────┘              ▼
 your app ── /v1 (Bearer API key) ──▶ ┌──────────┐   one transaction   ┌────────────┐
                                      │ apps/api │────────────────────▶│ PostgreSQL │
 Amazon SNS ── /webhooks/ses/:id ───▶ └──────────┘                     │  emails,   │
                                                                       │  outbox,   │
             ┌───────────────┐   dispatch due outbox rows (ids only)   │  events …  │
             │  apps/worker  │◀────────────────────────────────────────┤            │
             │  dispatcher   │──▶ Redis/BullMQ ──▶ processors ────────▶│            │
             └───────┬───────┘                                         └────────────┘
                     │ hand-off               signed webhooks
                     ▼                              ▼
          Mailpit / SMTP relay / SES        customer endpoints
```

## Packages and boundaries

| Package              | Responsibility                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Zod schemas and types for the public API, state machine, permission matrix, webhook envelope. One definition used by API validation, OpenAPI, SDK and dashboard.                                                                                      |
| `packages/db`        | Drizzle schema (snake_case), generated SQL migrations, pool factory.                                                                                                                                                                                  |
| `packages/core`      | Domain logic used by API **and** worker: key ring (AES-256-GCM), tokens/hashing, template rendering, domain normalization, SSRF-guarded networking, webhook signing, object storage, outbox/event/usage/suppression/audit operations. No HTTP, no UI. |
| `packages/providers` | `ProviderAdapter` interface with explicit capabilities; local Mailpit, generic SMTP and SES adapters; error classification; SNS signature verification and SES event normalization.                                                                   |
| `packages/config`    | Environment schema (Zod) with production safety checks.                                                                                                                                                                                               |
| `apps/api`           | NestJS. Controllers are thin; services hold the use cases; `AccessService` is the only place that turns ids from a request into authorized rows.                                                                                                      |
| `apps/worker`        | Outbox dispatcher, send/webhook/provider-event processors, lease reaper, unknown-outcome clarification, retention. Exposes processors as a library for tests.                                                                                         |
| `apps/web`           | Dashboard. Client components talking to `/api` through a Next.js rewrite (same origin).                                                                                                                                                               |
| `packages/sdk`       | Thin typed client for `/v1` plus webhook verification.                                                                                                                                                                                                |

## Tenancy model

```
Organization ─┬─ Membership (role, projectAccess all|selected) ─ MembershipProjects
              └─ Project (retention, quota, operator pause)
                   └─ Environment (development | staging | production)
                        ├─ Domain, ProviderConnection, ApiKey, Template(+Versions)
                        ├─ Email ─ Recipients, Contents (encrypted), Attachments, Attempts, Events
                        ├─ WebhookEndpoint ─ WebhookEvents ─ Deliveries ─ Attempts
                        └─ Suppression
```

Every tenant-owned row carries `project_id` (and `environment_id` where relevant). Queries are
always filtered by the project/environment taken from the authenticated context (API key, or
the AccessService result for sessions). There is no separate "customer" model: a project is the
customer boundary.

## Email lifecycle (state machine)

Defined once in `packages/contracts/src/status.ts`:

```
accepted ─▶ queued ─▶ submitting ─▶ submitted
   │          ▲  │          ├─▶ retry_wait ─▶ submitting
   ▼          │  ▼          ├─▶ failed
scheduled ────┘ suppressed  └─▶ submission_unknown ─▶ submitted | failed (only via provider clarification)
   │
   ▼
cancelled   (from accepted / scheduled / queued / retry_wait)
```

- Every transition is an atomic conditional `UPDATE … WHERE status IN (…)`. Cancel and claim
  race safely: one wins, the other affects zero rows.
- `submitted` = the transport accepted the message. Delivery facts are per recipient and only
  come from trusted provider events (`deliveredAt`, `bouncedAt`, `complainedAt`, `deferredAt`
  are independent columns; the append-only `email_events` table keeps the history).
- `submission_unknown` is final for automation. It is reached when a provider timeout/reset
  happened after the message may have been accepted, or when a worker lease expired during
  `submitting`. It is never retried automatically and never switched to another provider.
  Adapters with `statusLookup` (local Mailpit) are asked to clarify; others need a person
  (manual resend = new linked email, duplicate confirmation, audit entry).

## Acceptance (one transaction)

`AcceptanceService.accept` validates the request (Zod + limits), uploads encrypted attachments
under server-generated keys, then in **one PostgreSQL transaction**:

1. loads project/environment, rejects paused projects (423);
2. claims the `Idempotency-Key` with `INSERT … ON CONFLICT DO NOTHING` on a unique index
   (concurrent duplicates wait on the index lock, then replay or get 409);
3. renders a template version if requested (bound to an immutable version);
4. authorizes the sender domain and the environment's default connection;
5. checks suppressions (tenant + platform);
6. reserves quota with a conditional `UPDATE usage_periods … WHERE used + n <= limit`, which
   also serializes the per-environment backlog check;
7. inserts email, encrypted content, recipients, attachments, lifecycle events, webhook fan-out
   and the outbox row.

Only after commit does the API answer `202`. Any failure rolls back everything (no leftover
reservation, no idempotency record) and deletes already uploaded objects.

## Outbox, queue and worker

- `outbox` rows reference an id (`send_email`, `deliver_webhook`, `process_provider_event`) and
  have `available_at` (scheduled time or retry time).
- The dispatcher selects **due** rows with `FOR UPDATE SKIP LOCKED`, moves due scheduled emails
  to `queued`, and adds BullMQ jobs whose id is derived from the outbox row. Job payloads
  contain ids only.
- Rows dispatched but not completed after 5 minutes are dispatched again (Redis loss, crashes).
  The job id dedupes jobs that still exist; processors re-check state in PostgreSQL, so
  duplicate jobs are no-ops.
- The send processor claims with a lease (`lease_owner`, `lease_expires_at`), re-checks pause
  state, sender authorization and suppressions, hands off **once**, and records the outcome
  only while it still owns the lease. Transient failures schedule a new outbox row with
  exponential backoff + jitter, up to `OPENSEND_MAX_SEND_ATTEMPTS`.
- Webhooks run in their own queue, so slow receivers never block sending.

## Provider events

`POST /webhooks/ses/:connectionId` verifies the SNS signature (certificate only from
`https://sns.<region>.amazonaws.com/*.pem`, topic allow-list per connection), stores the
notification in `provider_events` (unique per SNS MessageId) **before** processing, and enqueues
it. Matching uses `provider_message_id` **and** the receiving connection, so one tenant's topic
cannot affect another tenant's emails. Unmatched events stay stored and are reconciled later
(events can overtake our own bookkeeping). Hard bounces and complaints add tenant suppressions.

## Data protection

- Content, provider credentials and webhook secrets are encrypted with AES-256-GCM using a key
  ring from the environment (`OPENSEND_ENCRYPTION_KEYS`), with additional authenticated data
  binding each ciphertext to its row. Attachments are encrypted before they reach the bucket.
- Retention per project (`content`, `attachments`, `events`). With `content = 0` the content is
  deleted in the same transaction that records the final state. See docs/SECURITY.md.

## Key decisions and trade-offs

| Decision                                                                   | Why                                                                          | Trade-off                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| Better Auth only for users/sessions; organizations/roles in our own tables | We need project-scoped access and controlled invitations; one session system | We maintain the org model ourselves                  |
| Users created via Better Auth's internal adapter (public sign-up disabled) | Bootstrap and invitations are the only ways in                               | Relies on `auth.$context` internals (pinned version) |
| Next.js rewrite proxy for `/api`                                           | First-party cookies, simple CSRF origin check, no CORS                       | Rewrite target is fixed at build time                |
| Text columns with TS enums instead of PG enums                             | Cheap evolution of states                                                    | DB does not reject unknown values (app does)         |
| Weighted sliding-window rate limit in Redis, failing open                  | Abuse protection must not block durable acceptance                           | Redis outages temporarily remove this outer limit    |
| Count-based backlog check under the quota row lock                         | Correct under concurrency without extra counters                             | One extra `count(*)` per acceptance                  |
| Mustache templates, HTML-escaping, no raw variables in HTML                | Logic-less, predictable                                                      | No helpers/conditionals beyond sections              |
| One submission per email (all recipients) with per-recipient results       | Matches SMTP/SES semantics, BCC privacy                                      | A provider-wide rejection fails all recipients       |
| SES `maxAttempts: 1`                                                       | SDK retries after timeouts could duplicate mail                              | Transient network errors become our retries          |
