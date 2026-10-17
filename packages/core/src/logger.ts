import pino, { type Logger } from 'pino';

/** Structured JSON logs with redaction of credentials and message content. */
export function createLogger(opts: { name: string; level?: string }): Logger {
  return pino({
    name: opts.name,
    level: opts.level ?? 'info',
    base: { service: opts.name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.secret',
        '*.apiKey',
        '*.token',
        '*.html',
        '*.text',
        '*.content',
        '*.attachments',
        '*.credentials',
        '*.accessKeyId',
        '*.secretAccessKey',
      ],
      censor: '[redacted]',
    },
  });
}
export type { Logger };
