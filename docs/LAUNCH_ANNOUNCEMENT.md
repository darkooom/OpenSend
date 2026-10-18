# Draft GitHub launch announcement

OpenSend is an open-source, self-hostable transactional email platform built for developers,
agencies and SaaS teams that operate many customer projects.

It keeps each project’s environments, domains, API keys, providers, templates, webhooks,
suppressions, usage and retention separate. PostgreSQL is the durable source of truth, workers
recover from queue loss, and provider submission is never presented as recipient delivery.

The first beta supports local Mailpit, generic TLS SMTP and Amazon SES, with a TypeScript SDK and a
dashboard for day-to-day operations. It is a beta: SES still needs real-account verification and
operators should review the documented limitations before production use.

Repository: <https://github.com/darkooom/OpenSend>

Do not publish this announcement until the repository is public and the release checklist is clear.
