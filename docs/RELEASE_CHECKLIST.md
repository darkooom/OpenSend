# Release checklist

Target candidate: `v0.1.0-beta.1`. Classifications mean:

- **READY** — verified and complete.
- **NEEDS ATTENTION** — useful or expected follow-up that may be accepted as an explicit beta
  limitation.
- **BLOCKED** — must be resolved or explicitly decided by the owner before publication.

## READY

- [x] Frozen-lockfile install succeeds in an isolated checkout.
- [x] Format, build, lint, typecheck, unit, integration, and Playwright E2E checks pass locally.
- [x] PostgreSQL, Redis, MinIO, and Mailpit start healthy using the documented local stack.
- [x] Security scan completed; all seven scan-start findings were remediated and retested.
- [x] No high or critical dependency advisory is reported by `pnpm audit --audit-level=high`.
- [x] README, screenshots, community files, templates, security policy, and support policy exist.
- [x] Draft changelog and release notes describe only implemented behavior.
- [x] Social preview asset is 1280×640 and under GitHub's size limit.
- [x] Screenshot regeneration passes from a fresh local instance with fictional data.
- [x] Gitleaks scanned the current tree and complete two-commit history; only the two documented
      self-signed SNS fixture keys were flagged in history.
- [x] Local Markdown links resolve.
- [x] Production dependency licenses were inventoried; no unknown license was reported.
- [x] Repository remains private during preparation.
- [x] Issues and Discussions are enabled; unused Wiki and Projects features are disabled.

## NEEDS ATTENTION

- [ ] Exercise Amazon SES send, DKIM setup, SNS subscription confirmation, delivery, bounce, and
      complaint against a real non-production AWS account.
- [ ] Exercise account email and generic SMTP against a real authenticated TLS relay.
- [ ] Run a backup/restore drill against a staging database and object store.
- [ ] Run a representative acceptance/dispatch load test and record queue/backlog behavior.
- [ ] Confirm production TLS, reverse-proxy routing, trusted proxy configuration, metrics token,
      secret storage, database backups, object lifecycle, and alerting.
- [ ] Confirm the old encryption key remains available until rotation reports zero failures and a
      restore drill passes.

## BLOCKED

- [ ] Owner confirms the platform and SDK/contracts license split.
- [ ] Launch branch is pushed and its GitHub Actions run is green.
- [ ] Pull-request review confirms no secrets, local `.env`, test output, or generated build output
      is included.
- [ ] Branch protection/ruleset is active for `main` with pull requests plus required `check` and
      `docker` status checks.
- [ ] Description and topics are saved and reviewed for accuracy.
- [ ] Private vulnerability reporting and supported no-cost security features are enabled where
      the plan permits.
- [ ] Social preview is uploaded from [`social-preview.png`](social-preview.png).
- [ ] Default branch and merge policy are reviewed after the launch pull request exists.

- [ ] Choose the public launch date and repository visibility.
- [ ] Confirm `v0.1.0-beta.1` as the exact version and tag.
- [ ] Review [draft release notes](releases/v0.1.0-beta.1.md) and
      [launch announcement](LAUNCH_ANNOUNCEMENT.md).
- [ ] Create the signed/annotated tag from the reviewed merge commit.
- [ ] Publish the GitHub release only after the tag, release notes, and artifacts are verified.
- [ ] Change repository visibility only when the owner explicitly authorizes it.
- [ ] Post announcements only after the public repository and release URLs work from a logged-out
      browser.

## Post-release follow-up

- [ ] Watch CI, installation reports, dependency alerts, Discussions, and security reports.
- [ ] Triage beta feedback into the roadmap without promising unimplemented features.
- [ ] Schedule the real-provider and load-test gaps if they were accepted as beta limitations.
- [ ] Rotate any temporary launch credentials and remove temporary access grants.
