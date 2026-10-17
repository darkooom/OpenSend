# OpenSend API (v1)

Base URL: your instance, e.g. `https://mail.example.com` (local: `http://localhost:3001`).
Machine-readable spec: `GET /v1/openapi.json` (OpenAPI 3.1, generated from the same Zod
schemas the API validates with).

JSON field names are camelCase. Timestamps are ISO 8601 in UTC.

## Authentication

```
Authorization: Bearer os_<prefix>_<secret>
```

API keys belong to **one project and one environment**. They are independent of user sessions,
can expire and be revoked, and carry scopes:

| Scope            | Allows                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| `emails:send`    | `POST /v1/emails`, `POST /v1/emails/batch`, `POST /v1/emails/:id/cancel` |
| `emails:read`    | `GET /v1/emails`, `GET /v1/emails/:id`                                   |
| `domains:read`   | `GET /v1/domains`, `GET /v1/domains/:id`                                 |
| `domains:manage` | `POST /v1/domains`, `POST /v1/domains/:id/verify`                        |
| `usage:read`     | `GET /v1/usage`                                                          |

Keys are for server-side use only. Never ship them in browser or mobile code. The `/v1` API
does not send CORS headers.

## Errors

Every error uses one envelope:

```json
{
  "error": {
    "code": "validation_error",
    "message": "request validation failed",
    "details": [{ "path": "to.0", "message": "invalid email address" }],
    "requestId": "…"
  }
}
```

| HTTP | code                      | Meaning                                                                          |
| ---- | ------------------------- | -------------------------------------------------------------------------------- |
| 400  | `invalid_request`         | Malformed JSON or header                                                         |
| 401  | `invalid_api_key`         | Missing, malformed, wrong, expired or revoked key                                |
| 403  | `insufficient_scope`      | Key lacks the scope                                                              |
| 404  | `not_found`               | Not found **in this project/environment**                                        |
| 409  | `idempotency_conflict`    | Same `Idempotency-Key` used with a different body                                |
| 409  | `idempotency_in_progress` | Concurrent request with the same key could not be resolved; retry                |
| 409  | `not_cancellable`         | Email already handed off (or final)                                              |
| 413  | `payload_too_large`       | Body, content or attachments exceed limits                                       |
| 422  | `validation_error`        | Field-level problems in `details`                                                |
| 422  | `domain_not_verified`     | Sender domain not registered/verified for this environment's provider            |
| 422  | `provider_unavailable`    | No enabled default connection / connection paused / local provider in production |
| 423  | `project_paused`          | The instance operator paused sending for this project                            |
| 429  | `rate_limited`            | Requests per minute per key exceeded (`Retry-After`)                             |
| 429  | `quota_exceeded`          | Monthly recipient quota of the project exhausted                                 |
| 429  | `backlog_limit_exceeded`  | Too many pending emails in this environment; retry later                         |
| 500  | `internal_error`          | Bug; includes `requestId`                                                        |

Every response carries `X-Request-Id` (send your own, 8–100 chars `[A-Za-z0-9._-]`, to
correlate logs).

## Rate limits

Per API key, fixed one-minute window (`OPENSEND_RATE_LIMIT_PER_MINUTE`, default 600).
Responses include `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. Quotas and the
backlog limit are enforced transactionally in PostgreSQL and are independent of the rate limit.

## Send an email

`POST /v1/emails` → **202 Accepted**

```json
{
  "from": "Acme <hello@mail.acme.com>",
  "to": ["ada@example.com"],
  "cc": [],
  "bcc": ["audit@acme.com"],
  "replyTo": "support@acme.com",
  "subject": "Your receipt",
  "html": "<p>Thanks!</p>",
  "text": "Thanks!",
  "tags": { "type": "receipt", "order": "1042" },
  "headers": { "X-Entity-Ref-ID": "1042", "List-Unsubscribe": "<mailto:unsub@acme.com>" },
  "attachments": [
    { "filename": "receipt.pdf", "content": "<base64>", "contentType": "application/pdf" }
  ],
  "scheduledAt": "2026-11-01T09:00:00Z"
}
```

Response:

```json
{
  "id": "01a14b12-3cc1-746a-b6e0-77858ef62f2e",
  "object": "email",
  "status": "queued",
  "scheduledAt": null
}
```

**202 means durably accepted**: the email, its recipients, encrypted content, quota reservation
and outbox entry were committed to PostgreSQL. It does not mean the provider accepted it, and
not that anybody received it.

Rules (defaults, all configurable):

- Mailbox formats: `"a@b.com"`, `"Name <a@b.com>"`, `{ "email": "a@b.com", "name": "Name" }`.
  Line breaks and control characters are rejected everywhere they could reach a header.
- At least one of `to`/`cc`/`bcc`; at most 50 recipients; duplicates across lists receive one copy.
- `subject` + (`html` or `text`), or `template` (not both). Body ≤ 2 MB.
- `headers`: `X-*` plus `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `In-Reply-To`,
  `References`, `Precedence`, `Auto-Submitted`. Identity, routing, MIME, authentication and
  `X-OpenSend-*` headers are refused.
- `tags`: ≤ 10, names `[A-Za-z0-9_-]{1,64}`, values ≤ 256 chars. Returned in webhooks.
- `attachments`: base64 `content` only (no URLs), ≤ 10 files, ≤ 10 MB total; `contentId` for
  inline images (`cid:`). Stored encrypted in private object storage.
- `scheduledAt`: up to 30 days ahead; never handed off before that time; cancellable until then.
- The `from` domain must be registered in the key's environment and allowed to send
  (see [Domains](#domains)).

### Templates

```json
{
  "from": "hello@mail.acme.com",
  "to": "ada@example.com",
  "template": { "id": "welcome", "version": 3, "variables": { "name": "Ada" } }
}
```

`id` is the template slug or id in the same environment. Without `version` the latest published
version is used. Missing required or unknown variables → 422 with `details.variables`. The
rendered content is stored with the email, so later template edits never change accepted
emails. `{{var}}` is HTML-escaped in HTML bodies.

## Idempotency

Send `Idempotency-Key: <1–255 printable ASCII>` on `POST /v1/emails` and `POST /v1/emails/batch`.

- Scope: project + environment + operation.
- Same key + same normalized body (key order irrelevant) → the original response, with header
  `Idempotent-Replayed: true`. No new email, no extra usage.
- Same key + different body → `409 idempotency_conflict`.
- Concurrent requests with the same key are serialized by a database unique constraint (not by
  Redis): exactly one email is created.
- Retention: at least `OPENSEND_IDEMPOTENCY_TTL_HOURS` (24 h) after acceptance or after the
  scheduled time, and never while the email is still pending.
- Rejected requests (validation, quota, …) leave no idempotency record; the key can be reused.

## Batch

`POST /v1/emails/batch` with `{ "emails": [ … up to 100 … ] }`.

Each item is validated and accepted **independently** (own transaction). Response:

```json
{
  "object": "batch",
  "id": "…",
  "data": [{ "index": 0, "id": "…", "status": "queued" }],
  "errors": [{ "index": 1, "error": { "code": "validation_error", "message": "…" } }]
}
```

HTTP `202` if at least one item was accepted, `422` if none. With an `Idempotency-Key`, item
_i_ uses the derived key `<key>#<i>`: retrying the same batch returns the same ids for accepted
items and re-validates failed ones.

## Get and list emails

`GET /v1/emails/:id` returns status, per-recipient state and an aggregate:

```json
{
  "id": "…",
  "status": "submitted",
  "displayStatus": "partially_delivered",
  "recipients": [
    {
      "address": "a@x.com",
      "kind": "to",
      "status": "submitted",
      "deliveredAt": "…",
      "bouncedAt": null,
      "complainedAt": null
    },
    {
      "address": "b@x.com",
      "kind": "to",
      "status": "submitted",
      "deliveredAt": null,
      "bouncedAt": null,
      "complainedAt": null
    }
  ],
  "summary": {
    "total": 2,
    "submitted": 2,
    "delivered": 1,
    "bounced": 0,
    "complained": 0,
    "rejected": 0,
    "suppressed": 0,
    "failed": 0,
    "pending": 0,
    "cancelled": 0,
    "unknown": 0
  },
  "attempts": 1,
  "lastError": null,
  "contentPurged": true
}
```

`status` (job): `accepted`, `scheduled`, `queued`, `submitting`, `retry_wait`, `submitted`,
`failed`, `submission_unknown`, `cancelled`, `suppressed`.

Recipient `status` (submission): `pending`, `submitted`, `rejected`, `failed`, `suppressed`,
`cancelled`, `unknown`. Delivery facts are separate timestamps from provider events.

`displayStatus` aggregation for lists: equals `status` unless `status = submitted`; then
`complained` if any recipient complained, `bounced` if all submitted recipients bounced,
`partially_bounced` if some did, `delivered` if all submitted recipients have a delivery event
and none was rejected, `partially_delivered` if some do, otherwise `submitted`. Counts in
`summary` are independent (a delivered recipient that later complained counts in both).

`GET /v1/emails?limit=25&cursor=…&status=…&recipient=a@x.com&tag=order:1042&from=…&to=…`
lists newest first. `nextCursor` is `null` on the last page. Filters only ever cover the key's
own environment.

## Cancel

`POST /v1/emails/:id/cancel` → `200` with the email, or `409 not_cancellable` once a worker has
started the hand-off. A handed-off email cannot be recalled.

## Domains

- `POST /v1/domains { "name": "mail.acme.com" }` → 201
- `POST /v1/domains/:id/verify` → re-checks and returns the domain

A domain has three separate parts:

1. **Ownership**: TXT record `_opensend.<domain>` = `opensend-verification=<token>` (token per
   project/environment). Required for real domains.
2. **Provider identity**: records the provider adapter reports (SES: three DKIM CNAMEs
   `<token>._domainkey.<domain>` → `<token>.dkim.amazonses.com`). Created only after ownership
   is proven. SMTP relays: `unsupported` (configure DKIM with your relay). Local provider:
   `not_required`.
3. **Diagnostics**: SPF and DMARC findings. OpenSend never suggests a second SPF record.

`canSend` is true when the environment's default connection may send from it. Production
requires verified ownership (and verified provider identity for SES). Reserved test domains
(`*.test`, `*.localhost`, `*.example`, `*.invalid`, `example.com/net/org`) are `localOnly`: no
DNS, only with the local provider, never in production.

The same domain may exist in several projects; each must prove ownership with its own token, and
no project can see whether another one uses it.

## Usage

`GET /v1/usage` → accepted emails/recipients of the current month for the **project**, quota,
remaining, pending emails in this environment and the configured limits. Usage counts accepted,
non-suppressed recipients once (replays and provider events never add usage). Cancellation does
not refund quota.

## Webhooks

Configure endpoints in the dashboard (per environment). Event types:
`email.scheduled`, `email.submitted`, `email.failed`, `email.submission_unknown`,
`email.cancelled`, `email.suppressed`, `email.delivered`, `email.bounced`, `email.complained`,
`email.delivery_delayed`, `email.recipient_rejected` (+ `webhook.test`).

Request:

```
POST <your url>
content-type: application/json
opensend-webhook-id: <event id>
opensend-webhook-timestamp: <unix seconds>
opensend-webhook-signature: v1,<base64 hmac> [v1,<base64 hmac of the previous secret during rotation>]

{"id":"…","type":"email.delivered","version":1,"createdAt":"…","projectId":"…","environmentId":"…","data":{"emailId":"…","recipient":"a@x.com","tags":{…}}}
```

Signature: `HMAC-SHA256(base64decode(secret without "whsec_"), "<id>.<timestamp>.<raw body>")`.
Payloads never contain message content.

Delivery semantics: **at least once, possibly out of order**. Deduplicate on `id`. Any 2xx is
success; redirects are not followed; timeouts after 10 s. Retries with exponential backoff
(10 s … 6 h) up to 8 attempts, then the delivery is **dead** (visible in the dashboard, can be
replayed). A replay re-sends the same event id and never sends an email.

Verify (Node.js, SDK):

```ts
import { verifyWebhook } from '@opensend/sdk';

app.post('/opensend/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.headers, process.env.OPENSEND_WEBHOOK_SECRET!);
    // dedupe on event.id, then handle event.type
    res.sendStatus(204);
  } catch {
    res.sendStatus(400);
  }
});
```

Verify the raw bytes: re-serialized JSON does not match. Reject timestamps older than 5 minutes
(the SDK does) to limit replays. During rotation both secrets sign for 24 h.

## SDK

```ts
import { OpenSend, OpenSendError } from '@opensend/sdk';

const opensend = new OpenSend({
  apiKey: process.env.OPENSEND_API_KEY!,
  baseUrl: 'https://mail.example.com',
});

try {
  const r = await opensend.emails.send(
    { from: 'Acme <hello@mail.acme.com>', to: 'ada@example.com', subject: 'Hi', text: 'Hello' },
    { idempotencyKey: `signup-${userId}` },
  );
  console.log(r.id, r.status, r.replayed);
} catch (err) {
  if (err instanceof OpenSendError && err.code === 'quota_exceeded') {
    /* back off */
  }
  throw err;
}
```

Other methods: `emails.sendBatch`, `emails.get`, `emails.list`, `emails.cancel`,
`domains.list/create/verify`, `usage.get`. The SDK refuses to run in a browser.

### NestJS

```ts
import { Injectable } from '@nestjs/common';
import { OpenSend } from '@opensend/sdk';

@Injectable()
export class MailService {
  private readonly client = new OpenSend({
    apiKey: process.env.OPENSEND_API_KEY!,
    baseUrl: process.env.OPENSEND_URL!,
  });

  sendPasswordReset(email: string, url: string, requestId: string) {
    return this.client.emails.send(
      {
        from: 'Acme <security@mail.acme.com>',
        to: email,
        template: { id: 'password-reset', variables: { url } },
      },
      { idempotencyKey: `password-reset-${requestId}` },
    );
  }
}
```

## Sandbox / local behaviour

There is no special "test mode" key. Use a `development` environment with the **local
provider**: emails go to the operator-configured Mailpit, are reported as `submitted`, and never
produce delivery events. Reserved test domains (`*.test`) work there without DNS. The local
provider is disabled when `NODE_ENV=production` and cannot be used in production environments.

## Common errors

| Symptom                           | Cause / fix                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `422 domain_not_verified`         | Add the `from` domain in the key's environment and run _Check DNS & provider_. A key from `development` cannot use a domain registered in `production`.           |
| `422 provider_unavailable`        | No default connection in this environment, connection disabled/paused, or local provider in production.                                                           |
| `409 idempotency_conflict`        | You reused a key for a different email. Derive keys from the business event (e.g. `order-1042-receipt`).                                                          |
| `401 invalid_api_key`             | Key revoked/expired, or sent without `Bearer `.                                                                                                                   |
| Status stays `submission_unknown` | The provider timed out after the message may have been accepted. Check the provider/inbox, then resend deliberately (dashboard → Resend, duplicate confirmation). |
| No `delivered` ever               | SMTP relays and the local provider do not report delivery. Use SES with an SNS event destination.                                                                 |
