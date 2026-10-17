# Self-hosting

OpenSend needs: PostgreSQL ≥ 16 (developed on 18), Redis ≥ 7 (developed on 8; AOF recommended,
`maxmemory-policy noeviction`), an S3-compatible bucket, and a sending provider (SMTP relay or
Amazon SES; Mailpit for local use). Nothing calls home.

## From a fresh checkout to a local test email

```bash
git clone <repo> opensend && cd opensend
corepack enable                 # pnpm version is pinned in package.json
pnpm install --frozen-lockfile
pnpm setup:local                # creates .env with random secrets (mode 600); never overwrites
pnpm services:up                # docker compose: postgres, redis, minio, mailpit (waits for health)
pnpm build
pnpm db:migrate
pnpm bootstrap:token            # one-time setup token, valid 60 minutes
pnpm dev                        # API :3001, worker, dashboard :3000
```

Then follow the steps in the [README](../README.md#quick-start-local). Mailpit's inbox:
<http://localhost:58025>.

### Host ports

| Service             | Default host port | Variable                                                  |
| ------------------- | ----------------- | --------------------------------------------------------- |
| PostgreSQL          | 54329             | `OPENSEND_PG_PORT`                                        |
| Redis               | 56379             | `OPENSEND_REDIS_PORT`                                     |
| MinIO API / console | 59000 / 59001     | `OPENSEND_MINIO_PORT` / `OPENSEND_MINIO_CONSOLE_PORT`     |
| Mailpit SMTP / UI   | 51025 / 58025     | `OPENSEND_MAILPIT_SMTP_PORT` / `OPENSEND_MAILPIT_UI_PORT` |
| API / dashboard     | 3001 / 3000       | `API_PORT` / Next.js `--port`                             |

All services bind to `127.0.0.1` only. If you change a port, change the matching URL in `.env`.

> Use `MAILPIT_SMTP_HOST=127.0.0.1` rather than `localhost`: on some systems `localhost`
> resolves to `::1` first while Docker publishes the port on IPv4 only.

## Running with Docker images

```bash
pnpm setup:local                       # or write .env yourself (see below)
docker compose --profile app up -d --build
docker compose exec api node apps/api/dist/cli.js bootstrap-token
```

The `app` profile builds one image with three targets (`api`, `worker`, `web`), runs migrations
once (`migrate` service) and starts API, worker and dashboard. The dashboard image proxies
`/api` to `OPENSEND_API_INTERNAL_URL`, which is fixed at **build time** (default
`http://api:3001`); rebuild with `--build-arg OPENSEND_API_INTERNAL_URL=…` for other layouts.

## Production checklist

- `NODE_ENV=production`, `PUBLIC_WEB_URL=https://…` (the dashboard origin users open),
  `PUBLIC_API_URL=https://…` (used in docs/OpenAPI and the SES SNS endpoint shown to tenants).
- Put the API and dashboard behind a TLS-terminating reverse proxy. Route `/api/*` of the
  dashboard host to the dashboard (it proxies to the API) or directly to the API on the same
  origin. Expose `/v1/*` and `/webhooks/*` of the API publicly. Set `TRUST_PROXY=true` only behind
  a proxy that overwrites `X-Forwarded-For`.
- Generate secrets: `BETTER_AUTH_SECRET` (≥ 32 random chars),
  `OPENSEND_ENCRYPTION_KEYS=v1:<base64 32 bytes>` (`pnpm --filter @opensend/api cli generate-key`),
  real S3 credentials. Store them outside the database backup (secret manager / env files with
  restricted permissions). **Losing the encryption key makes stored content, credentials and
  webhook secrets unreadable.**
- `OPENSEND_LOCAL_PROVIDER_ENABLED=false` (enforced), `OPENSEND_WEBHOOK_ALLOW_HTTP=false`
  (enforced).
- Create the S3 bucket beforehand (outside production the API creates it). Block public access.
- Set `OPENSEND_METRICS_TOKEN` or keep `/metrics` unreachable from the internet.
- Run `pnpm db:migrate` (or `node packages/db/dist/migrate.js`) before starting new versions.
- Run at least one worker. Several workers are safe (leases, `SKIP LOCKED`, job-id dedupe).
- Configure backups (see [OPERATIONS.md](OPERATIONS.md)).

## Configuring providers

### Generic SMTP relay

Dashboard → Providers → _SMTP relay_: host, port, `starttls` (587) or `tls` (465), optional
username/password (stored encrypted). Hosts resolving to private addresses are refused unless the
operator lists them in `OPENSEND_PRIVATE_NETWORK_ALLOWLIST`. Plain SMTP gives no delivery,
bounce or complaint events; DKIM/SPF for the relay are configured with the relay provider.

### Amazon SES

1. In AWS (outside OpenSend, by you): an IAM user/role with `ses:SendEmail`,
   `ses:GetEmailIdentity`, `ses:CreateEmailIdentity`, `ses:GetAccount`; a configuration set with
   an SNS event destination for _Delivery, Bounce, Complaint, DeliveryDelay, Reject_; an SNS
   topic.
2. Dashboard → Providers → _Amazon SES_: region, configuration set, the topic ARN(s), access key.
   _Test connection_ reports whether sending is enabled and whether the account is still in the
   SES sandbox.
3. Subscribe the SNS topic (protocol HTTPS) to the endpoint shown on the connection card:
   `https://<PUBLIC_API_URL>/webhooks/ses/<connectionId>`. OpenSend confirms the subscription
   automatically after verifying the signature and topic.
4. Domains → add your domain → publish the ownership TXT record → _Check_: OpenSend then
   creates/reads the SES identity and shows the DKIM CNAMEs SES issued → publish them → _Check_
   again until the provider status is _verified_.

OpenSend never creates AWS resources other than the SES email identity for a domain whose
ownership was proven, and only when a user runs the check.

## Data residency

Where data lives is your configuration: the PostgreSQL server, the S3 bucket/region, Redis and
the provider you connect (e.g. the SES region). OpenSend does not copy data elsewhere. The
sending provider processes recipient addresses and message content under its own terms.
