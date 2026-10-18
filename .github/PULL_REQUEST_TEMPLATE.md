## Summary

<!-- What changes, and why? Keep security-sensitive details out of a public PR until coordinated. -->

## Validation

- [ ] `pnpm format:check`
- [ ] `pnpm build`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:e2e` (or explain why not)
- [ ] Documentation and `CHANGELOG.md` updated when user-visible

## Safety and operations

- [ ] Tenant/project/environment authorization remains enforced and is covered by tests
- [ ] No secrets, customer data, message contents or real recipient data are included
- [ ] Migrations are forward-only and safe to run before the new application starts, or N/A
- [ ] Configuration, deployment, provider and rollback implications are documented, or N/A

## Not verified

<!-- Real-provider, browser, load, migration, or platform behavior not exercised. -->
