# Security model

This document describes what OpenSend enforces today. It is not a certification and makes no
compliance claims (GDPR, SOC 2, …): those depend on how and where you operate it.

## Identities

| Identity          | Authenticates with                                                                                        | Used for                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Dashboard user    | Better Auth session cookie (`opensend.session_token`, `HttpOnly`, `SameSite=Lax`, `Secure` in production) | `/api/*` management routes                                      |
| API key           | `Authorization: Bearer os_<prefix>_<secret>`                                                              | `/v1/*` only; bound to one project + environment                |
| Platform operator | User with `platformRole = admin` (the bootstrap owner)                                                    | `/api/admin/*`: pause projects/connections, platform block list |
| Amazon SNS        | RSA signature + per-connection topic allow-list                                                           | `/webhooks/ses/:connectionId`                                   |

- **No public sign-up.** Better Auth runs with `disableSignUp`. Users are created only by the
  one-time bootstrap (token from `pnpm bootstrap:token`, valid 60 min, stored as SHA-256, single
  use, closed forever once a user exists) or by accepting an invitation.
- Passwords: Better Auth's hashing (scrypt), minimum 12 characters; sign-in is rate limited.
- Better Auth telemetry is explicitly disabled.

## Authorization

All checks are server-side. `AccessService` resolves organization → project → environment from
the authenticated user and the URL ids; ids from a request are never trusted alone. A project or
environment the user cannot access is answered with **404** (no existence oracle). Every data
query is additionally filtered by `project_id` and `environment_id`.

### Permission matrix (organization roles)

| Permission                                                            | viewer | developer | admin | owner |
| --------------------------------------------------------------------- | :----: | :-------: | :---: | :---: |
| See projects, emails (metadata), domains, providers, templates, usage |   ✓    |     ✓     |   ✓   |   ✓   |
| Read message content and download attachments                         |        |     ✓     |   ✓   |   ✓   |
| Send test email, cancel, resend                                       |        |     ✓     |   ✓   |   ✓   |
| Manage domains, API keys, templates, webhooks, suppressions           |        |     ✓     |   ✓   |   ✓   |
| Create projects/environments, rename project                          |        |           |   ✓   |   ✓   |
| Manage provider connections (credentials)                             |        |           |   ✓   |   ✓   |
| Retention policy, export, audit log                                   |        |           |   ✓   |   ✓   |
| Invite/change/remove members (up to own rank)                         |        |           |   ✓   |   ✓   |
| Grant or change the owner role                                        |        |           |       |   ✓   |

Project restriction: a membership with `projectAccess = selected` only sees the listed projects —
lists, details, overview statistics, usage, audit entries and exports of other projects are
invisible. Restricted members cannot grant access to all projects or to projects they cannot
see. An organization always keeps at least one owner (row-locked check).

Invitations: random 256-bit token (only the hash is stored), default 72 h validity, single use,
revocable, role and project scope fixed at creation by someone allowed to grant them. Existing
accounts must be signed in as the invited address to accept.

### API key scopes

See [API.md](API.md#authentication). Keys are generated with 32 random bytes; only a public
12-character prefix and the SHA-256 of the secret are stored (high-entropy secrets do not need
a slow hash). The full key is shown once. Revocation and expiry take effect immediately.

## CSRF and CORS

- The dashboard talks to the API through a same-origin rewrite (`/api/*`). Cookies stay
  first-party.
- Every non-GET request to `/api/*` must carry `Origin` equal to `PUBLIC_WEB_URL` (or
  `Sec-Fetch-Site: same-origin`); otherwise 403. Better Auth additionally checks trusted origins.
- No CORS headers are sent at all. `/v1` is for server-to-server use.

## Encryption

- AES-256-GCM via Node.js/OpenSSL (`KeyRing` in `packages/core`). Ciphertext format
  `osenc1.<keyId>.<iv>.<tag>.<data>`; every value is bound to its row with additional
  authenticated data (e.g. `provider_connection:<id>`), so ciphertexts cannot be swapped.
- Encrypted: rendered message content (html, text, custom headers, reply-to), attachments
  (before upload), provider credentials, webhook secrets (current and previous).
- Keys come from `OPENSEND_ENCRYPTION_KEYS` (`id:base64,id:base64`) and
  `OPENSEND_ENCRYPTION_ACTIVE_KEY_ID`. They never live in the database.
- **Rotation**: add a new key, make it active, restart, run
  `pnpm --filter @opensend/api cli rotate-encryption` (re-encrypts credentials, webhook secrets
  and stored content). Keep the old key configured until the attachment retention of all
  projects has passed (attachments are not re-encrypted), then remove it.
- Production refuses to start with known placeholder secrets, with the local provider enabled,
  with http webhooks allowed, or without an https `PUBLIC_WEB_URL`.

## Network egress (SSRF)

Tenant-controlled targets are webhook URLs and SMTP relay hosts.

- Only `https://` webhooks (`http://` only when the operator sets `OPENSEND_WEBHOOK_ALLOW_HTTP`
  for local development). No credentials in URLs. Redirects are **not** followed.
- Hostname checks reject `localhost`, `*.local`, `*.internal`, metadata names and non-public
  IP literals.
- The real protection is in the DNS lookup used **for the connection itself**: every resolved
  address must be global unicast (blocks private, loopback, link-local incl. `169.254.169.254`,
  CGNAT, unique-local IPv6, IPv4-mapped IPv6, multicast, reserved). A name cannot resolve to a
  public address during validation and a private one when connecting.
- SMTP relays are resolved once with the same guard and connected by IP, while TLS still
  verifies the certificate against the configured hostname (TLS ≥ 1.2, STARTTLS required or
  implicit TLS; plaintext relays are not supported).
- `OPENSEND_PRIVATE_NETWORK_ALLOWLIST` (operator environment only) can allow named internal
  hosts. It is never settable through a tenant API. The local Mailpit provider uses the
  operator-configured host and is disabled in production.

## Email content handling

- Header injection: CR/LF and control characters are rejected in every header-bound field
  (names, subject, custom header values, rendered template subjects).
- Identity/routing/MIME/authentication headers and `X-OpenSend-*` cannot be set by clients.
- Attachments: base64 only, no remote URLs (nodemailer file/URL access is disabled too);
  object keys are generated by the server (`projects/<project>/emails/<email>/<attachment>`);
  downloads require a session with content permission, are always `Content-Disposition:
attachment`, `application/octet-stream`, `nosniff` and sandboxed by CSP.
- HTML preview in the dashboard: rendered only in an `<iframe sandbox="">` (no scripts, no
  forms, opaque origin) via `srcdoc`, with a CSP inside the document that blocks scripts and,
  unless the viewer opts in, remote images. The dashboard itself sends a strict CSP and
  `X-Frame-Options: DENY`.

## Webhook signing

HMAC-SHA256 over `<event id>.<timestamp>.<raw body>` with a 256-bit secret (`whsec_…`),
header `opensend-webhook-signature: v1,<base64>`. Receivers must verify the raw bytes, reject
stale timestamps (5 min) and deduplicate on the event id. Rotation keeps the previous secret
signing for 24 h (two signatures in the header).

## Provider events

SNS messages are accepted only with a valid RSA signature (SHA1 or SHA256 per
`SignatureVersion`), a certificate URL on `https://sns.<region>.amazonaws.com/…pem`, a
timestamp within one hour and a `TopicArn` from the receiving connection's allow-list (plus the
optional instance-wide `OPENSEND_SES_ALLOWED_TOPIC_ARNS`). Subscription confirmation URLs must
be SNS hosts. Events only match emails sent through the same connection.

## Suppressions and abuse controls

- Tenant suppression lists per environment (hard bounces and complaints automatically, manual
  entries). Enforced at acceptance and again right before hand-off.
- Platform block list (operator-managed). Tenants only see the reason `policy`; nothing about
  other tenants' bounces is exposed.
- Monthly recipient quota per project, reserved atomically in the acceptance transaction.
  Backlog limit per environment, recipient/size/attachment/schedule/batch limits, per-key rate
  limit.
- Operator pause for projects and connections (audit-logged, visible to the tenant).
- No open relay: sending requires an API key or dashboard session, a registered and verified
  sender domain and an enabled connection.

## Logging and audit

- Structured JSON logs (pino). Authorization headers, cookies and fields named like secrets or
  content are redacted. Error texts stored in the database are passed through `redact()`
  (credentials removed, email addresses masked).
- Request bodies are never logged.
- Audit log entries (actor, action, target, time, IP, non-sensitive metadata) for bootstrap,
  members, invitations, projects, environments, retention, API keys, provider connections,
  domains, templates, webhooks, suppressions, cancel/resend, export and operator actions.

## Known limitations

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md#known-limitations).
