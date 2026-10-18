import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SesAdapter, classifySesError } from './ses';
import { classifySmtpError } from './smtp';
import {
  isTrustedSnsUrl,
  normalizeSesEvent,
  snsStringToSign,
  verifySnsMessage,
  type SnsMessage,
} from './sns';
import type { OutgoingMessage } from './types';

const fixtures = path.join(__dirname, '..', 'test', 'fixtures');
const key = readFileSync(path.join(fixtures, 'sns-test-key.pem'), 'utf8');
const cert = readFileSync(path.join(fixtures, 'sns-test-cert.pem'), 'utf8');

describe('SMTP error classification', () => {
  it('treats explicit 4xx replies as transient (definitely not accepted)', () => {
    expect(
      classifySmtpError(
        Object.assign(new Error('x'), { code: 'EMESSAGE', responseCode: 451, command: 'DATA' }),
      ).outcome,
    ).toBe('transient_failure');
  });
  it('treats 5xx replies as permanent', () => {
    const r = classifySmtpError(
      Object.assign(new Error('x'), {
        code: 'EENVELOPE',
        responseCode: 550,
        command: 'RCPT TO',
        rejected: ['a@b.test'],
      }),
    );
    expect(r).toMatchObject({ outcome: 'permanent_failure', category: 'recipients_rejected' });
  });
  it('treats connection failures before DATA as transient', () => {
    expect(
      classifySmtpError(
        Object.assign(new Error('refused'), { code: 'ECONNECTION', command: 'CONN' }),
      ).outcome,
    ).toBe('transient_failure');
  });
  it('treats a timeout after the message was streamed as unknown', () => {
    const r = classifySmtpError(
      Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'DATA' }),
    );
    expect(r).toMatchObject({ outcome: 'unknown', category: 'timeout' });
  });
  it('treats an unlabeled socket error as unknown', () => {
    expect(
      classifySmtpError(Object.assign(new Error('socket hang up'), { code: 'ESOCKET' })).outcome,
    ).toBe('unknown');
  });
});

describe('SES error classification', () => {
  it.each([
    [{ name: 'MessageRejected', $metadata: { httpStatusCode: 400 } }, 'permanent_failure'],
    [{ name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } }, 'transient_failure'],
    [{ name: 'InternalFailure', $metadata: { httpStatusCode: 500 } }, 'transient_failure'],
    [{ name: 'Error', code: 'ENOTFOUND' }, 'transient_failure'],
    [{ name: 'TimeoutError' }, 'unknown'],
    [{ name: 'Error', code: 'ECONNRESET' }, 'unknown'],
  ])('%o -> %s', (e, outcome) => {
    expect(classifySesError(Object.assign(new Error('x'), e) as never).outcome).toBe(outcome);
  });
});

const message: OutgoingMessage = {
  messageId: '<abc@opensend.test>',
  from: { email: 'noreply@acme.example', name: 'Acme' },
  to: ['to@x.example'],
  cc: [],
  bcc: ['hidden@x.example'],
  replyTo: [],
  subject: 'Hello',
  text: 'Hi',
  html: '<p>Hi</p>',
  headers: { 'X-Campaign': 'welcome' },
  attachments: [],
  tags: { flow: 'sign up' },
};

describe('SES adapter (test double client)', () => {
  it('sends raw MIME with Bcc only in the destination', async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return { MessageId: '0100-ses-id' };
      },
      destroy: () => {},
    };
    const adapter = new SesAdapter(
      { region: 'eu-central-1', snsTopicArns: [] },
      { accessKeyId: 'A'.repeat(20), secretAccessKey: 'b'.repeat(40) },
      {
        timeoutMs: 1000,
        client: client as never,
      },
    );
    const res = await adapter.submit(message);
    expect(res).toMatchObject({ outcome: 'accepted', providerMessageId: '0100-ses-id' });
    const input = sent[0] as {
      Destination: { BccAddresses: string[] };
      Content: { Raw: { Data: Buffer } };
      EmailTags: Array<{ Name: string; Value: string }>;
    };
    expect(input.Destination.BccAddresses).toEqual(['hidden@x.example']);
    const raw = Buffer.from(input.Content.Raw.Data).toString('utf8');
    expect(raw).toContain('Message-ID: <abc@opensend.test>');
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(input.EmailTags[0]).toEqual({ Name: 'flow', Value: 'sign_up' });
  });

  it('reports timeouts as unknown instead of failures', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
      },
      destroy: () => {},
    };
    const adapter = new SesAdapter(
      { region: 'eu-central-1', snsTopicArns: [] },
      { accessKeyId: 'A'.repeat(20), secretAccessKey: 'b'.repeat(40) },
      {
        timeoutMs: 1000,
        client: client as never,
      },
    );
    expect((await adapter.submit(message)).outcome).toBe('unknown');
  });

  it('derives DKIM records from the identity SES returns (no invented records)', async () => {
    const client = {
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'GetEmailIdentityCommand') {
          return {
            DkimAttributes: { Tokens: ['tok1', 'tok2', 'tok3'], Status: 'PENDING' },
            VerifiedForSendingStatus: false,
          };
        }
        throw new Error('unexpected');
      },
      destroy: () => {},
    };
    const adapter = new SesAdapter(
      { region: 'eu-central-1', snsTopicArns: [] },
      { accessKeyId: 'A'.repeat(20), secretAccessKey: 'b'.repeat(40) },
      {
        timeoutMs: 1000,
        client: client as never,
      },
    );
    const r = await adapter.setupDomain('acme.example', { create: false });
    expect(r.status).toBe('pending');
    expect(r.records.map((x) => [x.name, x.value])).toEqual([
      ['tok1._domainkey.acme.example', 'tok1.dkim.amazonses.com'],
      ['tok2._domainkey.acme.example', 'tok2.dkim.amazonses.com'],
      ['tok3._domainkey.acme.example', 'tok3.dkim.amazonses.com'],
    ]);
  });
});

function signedSns(overrides: Partial<SnsMessage> = {}): SnsMessage {
  const m: SnsMessage = {
    Type: 'Notification',
    MessageId: 'sns-msg-1',
    TopicArn: 'arn:aws:sns:eu-central-1:123456789012:opensend-events',
    Message: JSON.stringify({
      eventType: 'Delivery',
      mail: { messageId: 'ses-1' },
      delivery: { recipients: ['a@b.example'], timestamp: '2026-10-17T10:00:00.000Z' },
    }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem',
    ...overrides,
  };
  const s = createSign('RSA-SHA256');
  s.update(snsStringToSign(m));
  m.Signature = s.sign(key, 'base64');
  return m;
}

describe('SNS verification', () => {
  const opts = {
    allowedTopicArns: ['arn:aws:sns:eu-central-1:123456789012:opensend-events'],
    fetchCert: async () => cert,
  };

  it('accepts a correctly signed message from an allowed topic', async () => {
    await expect(verifySnsMessage(signedSns(), opts)).resolves.toMatchObject({
      MessageId: 'sns-msg-1',
    });
  });
  it('rejects modified payloads', async () => {
    const m = signedSns();
    m.Message = m.Message.replace('Delivery', 'Bounce');
    await expect(verifySnsMessage(m, opts)).rejects.toThrow(/signature/);
  });
  it('rejects topics outside the allowlist', async () => {
    await expect(
      verifySnsMessage(
        signedSns({ TopicArn: 'arn:aws:sns:eu-central-1:999999999999:other' }),
        opts,
      ),
    ).rejects.toThrow(/topic/);
  });
  it('rejects certificate URLs not hosted by SNS', async () => {
    await expect(
      verifySnsMessage(signedSns({ SigningCertURL: 'https://evil.example/sns.pem' }), opts),
    ).rejects.toThrow(/certificate URL/);
    expect(
      isTrustedSnsUrl('https://sns.eu-central-1.amazonaws.com.evil.example/x.pem', 'cert'),
    ).toBe(false);
    expect(isTrustedSnsUrl('http://sns.eu-central-1.amazonaws.com/x.pem', 'cert')).toBe(false);
    expect(
      isTrustedSnsUrl(
        'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem?cache=x',
        'cert',
      ),
    ).toBe(false);
    expect(isTrustedSnsUrl('https://sns.eu-central-1.amazonaws.com/other.pem', 'cert')).toBe(false);
  });
  it('rejects stale messages', async () => {
    await expect(
      verifySnsMessage(signedSns({ Timestamp: '2020-01-01T00:00:00.000Z' }), opts),
    ).rejects.toThrow(/timestamp/);
  });
});

describe('SES event normalization', () => {
  it('maps bounces per recipient and drops headers', () => {
    const e = normalizeSesEvent(
      'sns-1',
      JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'ses-1', headers: [{ name: 'Subject', value: 'secret subject' }] },
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [
            { emailAddress: 'x@y.example', diagnosticCode: 'smtp; 550 user unknown' },
          ],
        },
      }),
    );
    expect(e).toMatchObject({
      eventType: 'bounced',
      providerMessageId: 'ses-1',
      recipients: [{ address: 'x@y.example', bounceType: 'permanent' }],
    });
    expect(JSON.stringify(e.payload)).not.toContain('secret subject');
  });
  it('supports the legacy notificationType format', () => {
    expect(
      normalizeSesEvent(
        'n',
        JSON.stringify({
          notificationType: 'Complaint',
          mail: { messageId: 'm' },
          complaint: { complainedRecipients: [{ emailAddress: 'c@d.example' }] },
        }),
      ).eventType,
    ).toBe('complained');
  });
});
