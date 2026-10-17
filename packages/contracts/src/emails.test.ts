import { describe, expect, it } from 'vitest';
import { isAllowedCustomHeader, parseMailbox, sendEmailRequestSchema } from './emails';

describe('parseMailbox', () => {
  it('parses name-addr and normalizes the domain', () => {
    expect(parseMailbox('Acme Support <Help@Acme.TEST>')).toEqual({
      email: 'Help@acme.test',
      name: 'Acme Support',
    });
  });
  it('rejects header injection', () => {
    expect(parseMailbox('a@b.test\r\nBcc: victim@x.test')).toBeNull();
    expect(parseMailbox({ email: 'a@b.test', name: 'x\r\nBcc: y@z.test' })).toBeNull();
  });
  it('rejects multiple addresses in one string', () => {
    expect(parseMailbox('a@b.test, c@d.test')).toBeNull();
  });
});

describe('custom headers', () => {
  it('blocks security relevant headers', () => {
    for (const h of [
      'From',
      'bcc',
      'Message-ID',
      'Content-Type',
      'DKIM-Signature',
      'X-OpenSend-Email-Id',
      'Return-Path',
    ]) {
      expect(isAllowedCustomHeader(h)).toBe(false);
    }
  });
  it('allows X- headers and list headers', () => {
    expect(isAllowedCustomHeader('X-Campaign')).toBe(true);
    expect(isAllowedCustomHeader('List-Unsubscribe')).toBe(true);
  });
  it('rejects CRLF in header values', () => {
    const r = sendEmailRequestSchema.safeParse({
      from: 'a@b.test',
      to: 'c@d.test',
      subject: 'x',
      text: 'y',
      headers: { 'X-Test': 'ok\r\nBcc: evil@x.test' },
    });
    expect(r.success).toBe(false);
  });
});

describe('sendEmailRequestSchema', () => {
  it('requires subject and a body without template', () => {
    expect(sendEmailRequestSchema.safeParse({ from: 'a@b.test', to: 'c@d.test' }).success).toBe(
      false,
    );
  });
  it('rejects mixing template with inline content', () => {
    const r = sendEmailRequestSchema.safeParse({
      from: 'a@b.test',
      to: 'c@d.test',
      subject: 's',
      template: { id: 'welcome' },
    });
    expect(r.success).toBe(false);
  });
  it('rejects unknown fields', () => {
    const r = sendEmailRequestSchema.safeParse({
      from: 'a@b.test',
      to: 'c@d.test',
      subject: 's',
      text: 't',
      attachmentUrl: 'http://x',
    });
    expect(r.success).toBe(false);
  });
});
