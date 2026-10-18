# Roadmap

Not part of the first release. Listed so the architecture keeps room for them; none of these
exist in the product as buttons or stubs.

## Before a first public release

- Decide contribution terms (DCO vs. CLA); the contribution workflow itself is documented.
- Real-account verification of the SES adapter and SNS ingestion; a TLS-enabled SMTP relay test.
- Load test of acceptance and dispatch throughput; tune the per-acceptance backlog count.
- Session management UI (password reset and email verification already work with a platform
  sender).
- Production-scale validation of the periodic domain-ownership recheck.

## Managed service

- Managed BYO operation (multi-instance deployment guide, tenant onboarding without operator
  bootstrap, abuse review workflow).
- Hosted billing (Stripe), plan-based quotas and usage invoices.
- Managed sending access with our own provider accounts, dedicated sending pools/IPs.

## Product

- Contacts, segments, marketing unsubscribe handling, broadcasts.
- Visual automations.
- Inbound email and threads.
- SSO (SAML/OIDC) and SCIM.
- Additional providers (e.g. Postmark-, Mailgun- or SparkPost-style HTTP APIs) via the existing
  `ProviderAdapter` capability model.
- Block-based template editor (templates today are code-first with draft/publish versions).
- Per-environment custom quotas, configurable retry policies per connection.
- Webhook endpoint per-event filtering by tag, mTLS for webhooks.
- Outbound IP allow-listing info, DKIM signing by OpenSend for SMTP relays that do not sign.
