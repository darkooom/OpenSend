# Testing

```bash
pnpm services:up      # PostgreSQL, Redis, MinIO, Mailpit (docker compose)
pnpm build            # integration and e2e tests use the built packages
pnpm test             # unit tests of every package + integration tests (sequential)
pnpm test:e2e         # Playwright: fresh install -> Mailpit -> dashboard
pnpm lint && pnpm typecheck && pnpm format:check
```

## Layers

| Layer       | Where                                                      | Runs against                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `packages/*/src/**/*.test.ts`, `apps/web/src/**/*.test.ts` | pure code, test doubles                                                                                                                                                                                       |
| Integration | `tests/integration`                                        | the real NestJS app in-process, **real PostgreSQL** (fresh database `opensend_it` per run, all migrations), **real Redis** (db 15), real Mailpit for `mailpit.test.ts`; worker processors are called directly |
| End-to-end  | `e2e/`                                                     | fresh database `opensend_e2e`, real API + worker processes, Next.js dashboard, Mailpit, Chromium                                                                                                              |

Integration tests replace only what has no local equivalent: the object store (in-memory),
DNS (fake resolver) and, except in `mailpit.test.ts`, the provider adapter (programmable test
double recording every hand-off). The SES adapter is tested against a fake SDK client, SNS
signatures with a self-signed **test-only** certificate.

## Coverage of the acceptance criteria

| #   | Requirement                                                                                   | Tests                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No cross-org / cross-project access incl. search, stats, export, downloads                    | `tenancy.test.ts` (keys, sessions, restricted members, attachments), `retention-templates.test.ts` (export)                                           |
| 2   | Revoked/expired keys rejected, scopes enforced                                                | `tenancy.test.ts` › _API key lifecycle and scopes_                                                                                                    |
| 3   | Parallel same-key requests → one email; different body → 409                                  | `idempotency.test.ts` (12 parallel identical, 6 parallel conflicting, scoping, expiry while pending, batch)                                           |
| 4   | Survives worker restart and Redis loss                                                        | `reliability.test.ts` › _durability_ (real BullMQ queue, `FLUSHDB`, redispatch; expired lease)                                                        |
| 5   | Retries before safe hand-off, no blind resend after unclear hand-off                          | `reliability.test.ts` › _retries and unclear outcomes_ (backoff, max attempts, permanent, unknown, clarification, confirmed resend)                   |
| 6   | Multiple recipients with different outcomes                                                   | `recipients-events.test.ts` › _multiple recipients_                                                                                                   |
| 7   | Duplicate, late, unmatched provider events; usage unaffected                                  | `recipients-events.test.ts` › _provider events_                                                                                                       |
| 8   | Webhook signatures, retries, replay, SSRF                                                     | `webhooks.test.ts`, `packages/core/src/network.test.ts`, `packages/core/src/core.test.ts`                                                             |
| 9   | Suppressions, quotas, domain authorization enforced before sending                            | `enforcement.test.ts` (incl. parallel quota race, backlog, platform blocks, operator pause, header injection)                                         |
| 10  | Retention removes content/objects without crossing projects                                   | `retention-templates.test.ts` › _retention_                                                                                                           |
| 11  | Scheduled emails not early; concurrent cancel safe                                            | `reliability.test.ts` › _scheduling and cancellation_ (15 concurrent cancel/claim races)                                                              |
| 12  | Template changes do not alter accepted emails                                                 | `retention-templates.test.ts` › _templates_                                                                                                           |
| 13  | HTML preview cannot execute code in the dashboard                                             | `e2e/fresh-install.spec.ts` (sandbox attribute, script not executed, title untouched, images blocked), `apps/web/src/components/html-preview.test.ts` |
| E2E | Fresh install → bootstrap → project → local provider → key → public API → Mailpit → dashboard | `e2e/fresh-install.spec.ts`                                                                                                                           |

## Not covered by automated tests

- Real Amazon SES and SNS (no credentials in this repository or CI). The adapter is verified
  against an SDK test double and documented request shapes only.
- Real SMTP relays with TLS/authentication (only Mailpit without TLS is exercised for real; the
  TLS options are passed to nodemailer as documented).
- Real DNS lookups for domain verification (fake resolver).
- Load/performance tests.

## Tips

- Override service locations with `IT_ADMIN_DATABASE_URL`, `IT_REDIS_URL`, `MAILPIT_*`.
- `e2e/.auth/stack-env.json` (git-ignored) contains the generated secrets of the last e2e run.
- Playwright keeps traces of failed runs in `test-results/`.
