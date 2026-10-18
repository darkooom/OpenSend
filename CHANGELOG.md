# Changelog

All notable changes will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with pre-release identifiers while the
public API and deployment model are still stabilizing.

## [Unreleased]

### Added

- Account email infrastructure, password reset, account-email verification, project deletion,
  operator domain controls and expanded integration coverage in the current preparation worktree.
- Open-source community health files, issue forms, dependency updates and release-readiness docs.

### Changed

- Local/CI object storage uses a digest-pinned, publicly retrievable MinIO image.
- CI pins third-party actions to immutable commits and checks high/critical dependency advisories.
- Suppressed recipients now count toward the durable accepted-recipient budget because their
  requests still create tenant-owned records.

### Security

- Completed a repository-wide source audit and remediated seven findings: bounded template
  expansion, token-safe request logging, suppressed-send resource accounting, fail-closed write
  limits, authenticated production metrics, bounded SES certificate retrieval, and admission
  limits for webhook test/replay work.
- Production configuration now rejects a plaintext public API URL.

## [0.1.0-beta.1] - Unreleased

First planned public beta. See [docs/releases/v0.1.0-beta.1.md](docs/releases/v0.1.0-beta.1.md).
