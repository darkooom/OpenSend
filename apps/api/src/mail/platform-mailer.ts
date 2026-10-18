import type { AppConfig } from '@opensend/config';
import { redact, type Logger } from '@opensend/core';
import nodemailer, { type Transporter } from 'nodemailer';

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sender for OpenSend's own account emails (invitations, password reset, verification).
 * Configured by the operator only; it never uses tenant provider connections and never
 * appears in tenant data. Disabled when OPENSEND_PLATFORM_SMTP_HOST is empty.
 */
export class PlatformMailer {
  private transport: Transporter | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.OPENSEND_PLATFORM_SMTP_HOST);
  }

  private get transporter(): Transporter {
    if (!this.transport) {
      const c = this.config;
      this.transport = nodemailer.createTransport({
        host: c.OPENSEND_PLATFORM_SMTP_HOST,
        port: c.OPENSEND_PLATFORM_SMTP_PORT,
        secure: c.OPENSEND_PLATFORM_SMTP_SECURITY === 'tls',
        requireTLS: c.OPENSEND_PLATFORM_SMTP_SECURITY === 'starttls',
        ignoreTLS: c.OPENSEND_PLATFORM_SMTP_SECURITY === 'none',
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        auth: c.OPENSEND_PLATFORM_SMTP_USERNAME
          ? {
              user: c.OPENSEND_PLATFORM_SMTP_USERNAME,
              pass: c.OPENSEND_PLATFORM_SMTP_PASSWORD ?? '',
            }
          : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    }
    return this.transport;
  }

  /** Returns false (and logs) instead of throwing, so account flows never leak delivery details. */
  async send(mail: AccountEmail): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.transporter.sendMail({
        from: this.config.OPENSEND_PLATFORM_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      return true;
    } catch (err) {
      this.logger.error(
        { err: redact((err as Error).message) },
        'platform email could not be sent',
      );
      return false;
    }
  }
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function layout(
  title: string,
  lines: string[],
  action: { label: string; url: string },
  footer: string,
): { text: string; html: string } {
  const text = [title, '', ...lines, '', `${action.label}: ${action.url}`, '', footer].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#fafaf7;font-family:system-ui,-apple-system,sans-serif;color:#151513">
<div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e3e1d9;border-radius:6px;padding:28px">
<p style="margin:0 0 20px;font-family:ui-monospace,monospace;color:#0e6b5c">opensend</p>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join('')}
<p style="margin:20px 0"><a href="${esc(action.url)}" style="display:inline-block;background:#0e6b5c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">${esc(action.label)}</a></p>
<p style="margin:0;color:#6b6a63;font-size:13px;line-height:1.5">${esc(footer)}</p>
</div></body></html>`;
  return { text, html };
}

export const accountEmails = {
  invitation(input: {
    to: string;
    organization: string;
    role: string;
    inviter: string;
    url: string;
    expiresAt: Date;
  }): AccountEmail {
    const body = layout(
      `Join ${input.organization} on OpenSend`,
      [
        `${input.inviter} invited you to ${input.organization} as ${input.role}.`,
        `The invitation is valid until ${input.expiresAt.toUTCString()} and can be used once.`,
      ],
      { label: 'Accept invitation', url: input.url },
      'If you did not expect this invitation, you can ignore this email.',
    );
    return { to: input.to, subject: `You were invited to ${input.organization}`, ...body };
  },
  passwordReset(input: { to: string; url: string }): AccountEmail {
    const body = layout(
      'Reset your password',
      [
        'Someone asked to reset the password of your OpenSend account. The link is valid for one hour and can be used once.',
      ],
      { label: 'Choose a new password', url: input.url },
      'If you did not ask for this, ignore this email. Your password stays unchanged.',
    );
    return { to: input.to, subject: 'Reset your OpenSend password', ...body };
  },
  verification(input: { to: string; url: string }): AccountEmail {
    const body = layout(
      'Confirm your email address',
      ['Confirm that this address belongs to your OpenSend account.'],
      { label: 'Confirm email address', url: input.url },
      'If you do not have an OpenSend account, ignore this email.',
    );
    return { to: input.to, subject: 'Confirm your email address', ...body };
  },
};
