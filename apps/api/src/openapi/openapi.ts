import {
  acceptedEmailResponseSchema,
  batchResponseSchema,
  createDomainRequestSchema,
  domainResourceSchema,
  emailListResponseSchema,
  emailResourceSchema,
  errorBodySchema,
  sendEmailRequestSchema,
  usageResponseSchema,
  webhookEventEnvelopeSchema,
} from '@opensend/contracts';
import { z } from 'zod';

/**
 * OpenAPI 3.1 document for the public /v1 API, generated from the same Zod contracts the
 * API uses for validation. Served at GET /v1/openapi.json.
 */
export function buildOpenApi(serverUrl: string) {
  const schema = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const json = (name: string) => ({ 'application/json': { schema: ref(name) } });
  const errors = {
    '401': { description: 'Missing, invalid, expired or revoked API key', content: json('Error') },
    '403': { description: 'API key lacks the required scope', content: json('Error') },
    '422': {
      description: 'Validation error (field level details in error.details)',
      content: json('Error'),
    },
    '429': {
      description: 'Rate limit, monthly quota or backlog limit exceeded',
      content: json('Error'),
    },
  };
  const idParam = {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  };
  const idempotency = {
    name: 'Idempotency-Key',
    in: 'header',
    required: false,
    description:
      'Up to 255 printable ASCII characters, scoped to project + environment + operation. Same key and same body returns the original result (header Idempotent-Replayed: true); same key with a different body returns 409 idempotency_conflict. Kept for at least 24 h and while the email is still pending.',
    schema: { type: 'string', maxLength: 255 },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenSend API',
      version: '1.0.0',
      description:
        'Transactional email API. 202 Accepted means the email was durably accepted for processing, not that it was delivered. See docs/API.md for semantics.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Project/environment API key: `os_<prefix>_<secret>`',
        },
      },
      schemas: {
        Error: schema(errorBodySchema),
        SendEmailRequest: schema(sendEmailRequestSchema),
        AcceptedEmail: schema(acceptedEmailResponseSchema),
        Email: schema(emailResourceSchema),
        EmailList: schema(emailListResponseSchema),
        Batch: schema(batchResponseSchema),
        CreateDomainRequest: schema(createDomainRequestSchema),
        Domain: schema(domainResourceSchema),
        Usage: schema(usageResponseSchema),
        WebhookEvent: schema(webhookEventEnvelopeSchema),
      },
    },
    paths: {
      '/v1/emails': {
        post: {
          operationId: 'sendEmail',
          summary: 'Accept an email for sending',
          description: 'Requires scope emails:send.',
          parameters: [idempotency],
          requestBody: { required: true, content: json('SendEmailRequest') },
          responses: {
            '202': {
              description: 'Durably accepted (or replayed)',
              content: json('AcceptedEmail'),
            },
            '409': { description: 'Idempotency conflict', content: json('Error') },
            '413': { description: 'Payload too large', content: json('Error') },
            '423': {
              description: 'Project paused by the platform operator',
              content: json('Error'),
            },
            ...errors,
          },
        },
        get: {
          operationId: 'listEmails',
          summary: 'List emails of the API key environment',
          description: 'Requires scope emails:read. Cursor pagination, newest first.',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'recipient', in: 'query', schema: { type: 'string' } },
            {
              name: 'tag',
              in: 'query',
              description: '`name` or `name:value`',
              schema: { type: 'string' },
            },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            '200': { description: 'Page of emails', content: json('EmailList') },
            ...errors,
          },
        },
      },
      '/v1/emails/batch': {
        post: {
          operationId: 'sendBatch',
          summary: 'Accept up to N emails, each processed independently',
          parameters: [idempotency],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { emails: { type: 'array', items: ref('SendEmailRequest') } },
                  required: ['emails'],
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'At least one email accepted; per-item errors in `errors`',
              content: json('Batch'),
            },
            '422': { description: 'No item could be accepted', content: json('Batch') },
          },
        },
      },
      '/v1/emails/{id}': {
        get: {
          operationId: 'getEmail',
          summary: 'Get an email with per-recipient status',
          parameters: [idParam],
          responses: {
            '200': { description: 'Email', content: json('Email') },
            '404': { description: 'Not found', content: json('Error') },
            ...errors,
          },
        },
      },
      '/v1/emails/{id}/cancel': {
        post: {
          operationId: 'cancelEmail',
          summary: 'Cancel an email before hand-off to the provider',
          parameters: [idParam],
          responses: {
            '200': { description: 'Cancelled', content: json('Email') },
            '409': { description: 'not_cancellable', content: json('Error') },
            ...errors,
          },
        },
      },
      '/v1/domains': {
        get: {
          operationId: 'listDomains',
          summary: 'List sender domains (scope domains:read)',
          responses: { '200': { description: 'Domains' }, ...errors },
        },
        post: {
          operationId: 'createDomain',
          summary: 'Register a sender domain (scope domains:manage)',
          requestBody: { required: true, content: json('CreateDomainRequest') },
          responses: {
            '201': { description: 'Domain', content: json('Domain') },
            '409': { description: 'Already registered', content: json('Error') },
            ...errors,
          },
        },
      },
      '/v1/domains/{id}/verify': {
        post: {
          operationId: 'verifyDomain',
          summary: 'Check ownership, provider identity and DNS diagnostics',
          parameters: [idParam],
          responses: { '200': { description: 'Domain', content: json('Domain') }, ...errors },
        },
      },
      '/v1/usage': {
        get: {
          operationId: 'getUsage',
          summary: 'Current period usage, quota and limits (scope usage:read)',
          responses: { '200': { description: 'Usage', content: json('Usage') }, ...errors },
        },
      },
    },
    webhooks: {
      emailEvent: {
        post: {
          summary: 'Lifecycle event delivered to your endpoint',
          description:
            'Signed with HMAC-SHA256 over `<id>.<timestamp>.<raw body>`; see docs/API.md#webhooks.',
          requestBody: { content: json('WebhookEvent') },
          responses: { '2XX': { description: 'Acknowledged' } },
        },
      },
    },
  };
}
