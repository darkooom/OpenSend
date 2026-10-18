# Launch readiness

Snapshot: 2026-10-18. This document records what was actually verified while preparing the
first public beta. It is evidence, not a promise that every external provider or production
topology has been exercised.

## Executive summary

OpenSend is ready for a **public beta**. The local installation,
dashboard setup, provider connection, domain, API key, API send, worker processing, Mailpit
delivery, and dashboard status flow all pass end to end. The repository is public, the licensing
split is recorded, and publication safeguards are active.

The remaining external checks below are accepted beta limitations, not claims of production
verification.

## Changes made

- Repaired the failed local/CI MinIO dependency, hardened the CI workflow, and pinned third-party
  Actions.
- Added community health, contribution, support, security, issue, pull-request, ownership,
  dependency-update, changelog, release-note, and launch materials.
- Reconciled README and `docs/` claims with the implementation and current test evidence.
- Remediated the seven security findings listed below and added focused regression coverage.
- Prepared an authentic social preview from the reproducible product hero.

## GitHub settings configured

- Repository visibility is **public** and the default branch remains `main`.
- Issues and Discussions are enabled.
- Unused Wiki and Projects features are disabled.
- GitHub Actions is active (the existing workflow runs are visible).
- An active `main` ruleset requires pull requests and the `check`/`docker` statuses while blocking
  force pushes and deletions.
- Description and topics are published. Dependency Graph, Dependabot alerts, malware alerts, and
  Dependabot security updates are enabled.

## README improvements

- Preserved the real product hero, tour, screenshots, architecture, API and provider evidence.
- Added clearer navigation, contribution guidance, project status, roadmap, security, and release
  caveats without inventing features or production verification.
- Corrected the quick start to use the frozen lockfile.
- Regenerated every screenshot from a fresh local instance with fictional data; all 20 referenced
  WebP assets resolve and the mobile/desktop capture pipeline passes.

## Verified in this pass

| Check                                           | Result                 | Evidence                                                                                                           |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Frozen-lockfile install in an isolated checkout | pass                   | `pnpm install --frozen-lockfile` with 503 packages and no lockfile mutation                                        |
| Local setup generation                          | pass                   | `pnpm setup:local` created a mode-600 `.env` with random secrets                                                   |
| Uncached production build                       | pass                   | `pnpm turbo run build --force`, 9/9 tasks                                                                          |
| Formatting                                      | pass                   | `pnpm format:check`                                                                                                |
| Lint                                            | pass                   | 18/18 tasks                                                                                                        |
| Typecheck                                       | pass                   | 18/18 tasks                                                                                                        |
| Unit and integration tests                      | pass                   | 14 integration files, 85 integration tests; all workspace tests pass                                               |
| Fresh-install browser flow                      | pass                   | Playwright: setup → project/environment → Mailpit provider → domain → API key → send → worker → Mailpit/dashboard  |
| Redis-loss and worker-restart recovery          | pass                   | integration reliability suite                                                                                      |
| Docker dependencies                             | pass                   | PostgreSQL, Redis, MinIO, and Mailpit healthy with loopback-only host ports                                        |
| Dependency audit                                | pass with note         | no high/critical advisory; one moderate, development-only transitive `esbuild` advisory through `drizzle-kit`      |
| Security review                                 | pass after remediation | repository-wide Codex Security review; 3 high and 4 medium scan-start findings fixed and regression-tested         |
| Secret scan                                     | pass with fixtures     | Gitleaks found only two documented self-signed SNS fixture keys in history and no additional prepared-tree finding |
| README media                                    | pass                   | local, repository-owned WebP assets; reproducible screenshot script present                                        |
| Social preview asset                            | published              | [`social-preview.png`](social-preview.png), 1280×640, derived from the real product hero                           |

The canonical security report is stored outside the repository at:

`/Users/darko/.codex/state/plugins/codex-security/scans/OpenSend/fff689bcd92f87d23c3ded8bc0567d7882d9265b_20261018T083616Z_ykd__elo/report.md`

## Security changes made during review

- Template variables and rendered output now have pre-allocation and final byte budgets.
- Request logging removes query strings and collapses token-bearing authentication paths.
- Every accepted recipient consumes the durable tenant quota, including suppressed recipients.
- SES/SNS ingress is rate-limited before certificate retrieval; certificate URLs and caches are
  bounded, failed requests are negatively cached, and concurrent retrievals are coalesced.
- Public write rate limits fail closed when Redis is unavailable; readiness reflects that
  dependency.
- Production requires an authenticated metrics endpoint.
- Webhook test and replay actions have per-user and per-project admission limits.
- Production also refuses a plaintext `PUBLIC_API_URL`.

## Technical audit findings

- The PostgreSQL outbox, idempotency constraints, leases, retry categories, unknown-submission
  state, Redis-loss recovery, per-recipient state, suppressions, provider-event deduplication,
  webhook retry/dead-letter flow, retention, and cleanup paths were traced and exercised by the
  integration suite.
- API keys use generated high-entropy secrets, digest-only storage, constant-time verification,
  scopes, expiry, and revocation. Management paths centralize tenant authorization and attachment
  retrieval binds the parent email and project.
- Provider credentials, webhook secrets, content, and attachments use AES-256-GCM with
  context-specific authenticated data; the rotation flow includes stored objects.
- Dependency licenses are MIT, Apache-2.0, BSD, ISC, MPL-2.0, LGPL-3.0-or-later (the libvips
  runtime used by Sharp), CC-BY-4.0 data, MIT-0, and 0BSD. No unknown production dependency license
  was reported. This is an engineering inventory, not legal advice.
- One moderate development-only transitive `esbuild` advisory remains through `drizzle-kit`; it
  does not meet the CI high/critical failure threshold and should be removed by a tested upstream
  dependency update rather than a risky pre-release override.

## Repository and CI preparation

- Community health files, issue forms, pull-request template, CODEOWNERS, Dependabot, changelog,
  support policy, security policy, release notes, and launch announcement are present.
- CI installs from the frozen lockfile, checks formatting/build/lint/types, runs tests and E2E,
  builds Docker images, runs a high-severity dependency audit, and uploads Playwright artifacts on
  failure.
- Third-party GitHub Actions are pinned to immutable commit SHAs.
- The previous CI failure was an anonymous pull failure for the retired Quay MinIO image. Compose
  now uses a digest-pinned compatible image that was started and health-checked locally.

## Remaining beta verification work

1. **Real Amazon SES verification.** The adapter and signed SNS processing are test-verified, not
   exercised against a real AWS account.
2. **Real production SMTP verification.** Local Mailpit and TLS behavior are tested; an external
   authenticated relay has not been exercised.
3. **Operational evidence.** Sustained load and a production-like backup/restore drill remain to
   be recorded before making broader production-readiness claims.

## Known limitations accepted for beta

- PostgreSQL row-level security and composite project/environment foreign keys are not present;
  application authorization is the primary tenant boundary. Current tenant and attachment paths
  were reviewed and integration-tested without a demonstrated bypass.
- The per-acceptance backlog query uses `count(*)` and has not been load-tested at production
  scale.
- The local stack uses a digest-pinned legacy MinIO build for development compatibility.
  Production operators should use an actively maintained S3-compatible service they control.
- Account emails require operator-configured SMTP. The product continues to expose manual invite
  links when that sender is unavailable.
- The operator UI does not yet expose every administrative API action.

## Remaining manual actions

- Monitor Dependabot, private vulnerability reports, and beta feedback after publication.
- Complete the real SES, authenticated SMTP, load, and restore drills before claiming broader
  production readiness.

## Recommendation

Publish `v0.1.0-beta.1` only from a green, reviewed commit. Keep the real SES/SMTP, load, and
restore gaps visible as beta limitations until direct evidence replaces them.
