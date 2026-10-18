# Operations

## Processes

| Process    | Start                                             | Health                                                                                         |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| API        | `node apps/api/dist/main.js`                      | `GET /health/live`, `GET /health/ready` (PostgreSQL + object storage required; Redis reported) |
| Worker     | `node apps/worker/dist/main.js`                   | `GET :3002/health/live`, `/health/ready` (PostgreSQL + Redis) — port `WORKER_HEALTH_PORT`      |
| Dashboard  | `node apps/web/server.js` (image) or `next start` | `GET /login`                                                                                   |
| Migrations | `node packages/db/dist/migrate.js`                | exit code                                                                                      |

The API can accept email while Redis is down: acceptance only needs PostgreSQL and object
storage, and the outbox keeps the work. Protected writes fail closed when the Redis-backed rate
limiter is unavailable, and readiness returns unavailable until it recovers.

## Graceful shutdown

- API: Nest shutdown hooks close the HTTP server, DB pool and Redis.
- Worker (`SIGTERM`/`SIGINT`): stops the periodic loops, waits for active jobs (BullMQ
  `close()`), then closes connections. Hard stop after 60 s; a send interrupted in the middle
  stays `submitting` until its lease (`OPENSEND_SEND_LEASE_SECONDS`, 120 s) expires and then
  becomes `submission_unknown` — it is not resent automatically.

## Timeouts

Provider hand-off `OPENSEND_PROVIDER_TIMEOUT_MS` (30 s; SMTP connection/greeting/socket, SES
request), webhooks `OPENSEND_WEBHOOK_TIMEOUT_MS` (10 s), DB statements 30 s, idle transactions
60 s, readiness checks 2 s.

## Periodic worker tasks

| Task                      | Interval | Purpose                                                                   |
| ------------------------- | -------- | ------------------------------------------------------------------------- |
| dispatch                  | 1 s      | Move due outbox rows to BullMQ; re-dispatch rows stuck > 5 min            |
| reap-leases               | 30 s     | `submitting` with expired lease → `submission_unknown`                    |
| clarify-unknown           | 60 s     | Ask providers with `statusLookup` about unclear submissions               |
| reconcile-provider-events | 60 s     | Retry matching of events that arrived early                               |
| retention                 | 10 min   | Purge content/attachments, delete expired emails/events, idempotency keys |

## Metrics

`GET /metrics` (Prometheus text; `Authorization: Bearer $OPENSEND_METRICS_TOKEN`; the token is
required in production):

- `opensend_emails{status}` — emails by status
- `opensend_outbox_oldest_age_seconds` — age of the oldest due, unprocessed outbox row (queue age)
- `opensend_send_attempts_last_hour{outcome}` — attempts by outcome
- `opensend_webhook_deliveries_open{status}` — pending / retrying / dead webhook deliveries
- `opensend_provider_events_unmatched`

Suggested alerts: outbox age > 2 min; any `submission_unknown` increase; `transient_failure`
ratio > 20 %; dead webhook deliveries > 0; unmatched provider events growing.

## Logs

JSON to stdout with `service`, `x-request-id` correlation (`req.id`), job kind and ids. No
request bodies, no message content, no credentials.

## Backup and restore

What to back up:

1. **PostgreSQL** — the source of truth (jobs, outbox, events, encrypted content, credentials).
   Use continuous archiving (WAL / PITR) or at least daily `pg_dump`. Backups contain encrypted
   content and recipient addresses for as long as the retention policies keep them; your backup
   retention extends that period — document it in your privacy notice.
2. **Object storage bucket** — encrypted attachments (versioning or replication recommended).
3. **Secrets** — `OPENSEND_ENCRYPTION_KEYS`, `BETTER_AUTH_SECRET`, S3 and provider credentials.
   Store separately from the database backups. Without the encryption keys a database backup's
   content and credentials are unreadable (by design).

Redis does not need a backup: it only holds queue state that is reconstructed from the outbox.

Restore:

```bash
docker compose stop api worker               # or your orchestrator
pg_restore --clean --if-exists -d "$DATABASE_URL" opensend.dump
node packages/db/dist/migrate.js             # applies any newer migrations
# restore the bucket to the same keys if needed
redis-cli -u "$REDIS_URL" FLUSHDB            # optional: drop stale jobs
docker compose start api worker
```

After restore the dispatcher re-enqueues every incomplete outbox row (after 5 min for rows that
were dispatched before the backup was taken). Emails that were `submitting` at backup time will
be reaped to `submission_unknown` — review them before resending; the restored database cannot
know whether the provider accepted them after the backup.

## Recovery runbook

| Situation                 | What happens / what to do                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis lost or flushed     | Nothing is lost. Within ~5 min the dispatcher re-enqueues all incomplete outbox rows.                                                                                                                 |
| Worker crashed            | Restart it. Jobs it held are re-dispatched; any in-flight send becomes `submission_unknown` after the lease.                                                                                          |
| Provider outage           | Transient failures retry with backoff (≤ `OPENSEND_MAX_SEND_ATTEMPTS`), then `failed`. Unclear outcomes become `submission_unknown`. No automatic provider switch.                                    |
| Many `submission_unknown` | Check the provider's logs/inbox for the `Message-ID` (`<emailId>@<from domain>`) or `X-OpenSend-Email-Id` header; resend only those that did not arrive (dashboard → Resend, duplicate confirmation). |
| Webhook receiver down     | Deliveries retry up to 8 times over ~hours, then dead. Fix the receiver, replay from the dashboard.                                                                                                   |
| Abuse by a tenant         | Operator → pause project (rejects new email with 423, holds queued work). Add addresses to the platform block list.                                                                                   |
| Encryption key rotation   | See [SECURITY.md](SECURITY.md#encryption).                                                                                                                                                            |

## Upgrades

Stop workers, run migrations, start the new API and workers, then the dashboard. Migrations are
forward-only SQL files in `packages/db/drizzle`; take a backup first.
