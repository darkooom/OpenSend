import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setSnsCertFetcher } from '@opensend/api';
import { snsStringToSign, type SnsMessage } from '@opensend/providers';
import type { Harness, Tenant } from './harness';

const key = readFileSync(path.join(__dirname, 'fixtures', 'sns-test-key.pem'), 'utf8');
const cert = readFileSync(path.join(__dirname, 'fixtures', 'sns-test-cert.pem'), 'utf8');
export const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:opensend-events';

/** Test-only SNS signer (self-signed certificate injected as the "downloaded" SNS cert). */
export function useFakeSnsCertificates() {
  setSnsCertFetcher(async () => cert);
}

let n = 0;
export function snsNotification(
  sesEvent: unknown,
  opts: { messageId?: string; topic?: string } = {},
): SnsMessage {
  const m: SnsMessage = {
    Type: 'Notification',
    MessageId: opts.messageId ?? `sns-${Date.now()}-${++n}`,
    TopicArn: opts.topic ?? TOPIC,
    Message: JSON.stringify(sesEvent),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem',
  };
  const s = createSign('RSA-SHA256');
  s.update(snsStringToSign(m));
  m.Signature = s.sign(key, 'base64');
  return m;
}

export function postSns(h: Harness, connectionId: string, msg: SnsMessage) {
  // SNS sends JSON with Content-Type text/plain.
  return h.http
    .post(`/webhooks/ses/${connectionId}`)
    .set('content-type', 'text/plain; charset=UTF-8')
    .send(JSON.stringify(msg));
}

/** Production environment with an SES connection (fake adapter) and a verified domain. */
export async function sesTenant(
  h: Harness,
  makeTenant: (h: Harness, o: object) => Promise<Tenant>,
  domain = 'acme-mail.io',
) {
  const t = await makeTenant(h, { envKind: 'production', domain });
  const base = `/api/projects/${t.projectId}/environments/${t.envId}`;
  const conns = await t.owner.get(`${base}/providers`);
  const conn = conns.body.data[0];
  await t.owner.patch(`${base}/providers/${conn.id}`, {
    config: { region: 'eu-central-1', snsTopicArns: [TOPIC] },
  });
  const domains = await t.owner.get(`${base}/domains`);
  const d = domains.body[0];
  h.dns.txt.set(d.ownership.record.name, [d.ownership.record.value]);
  h.provider.domainSetup = { status: 'verified', records: [] };
  const verified = await t.owner.post(`${base}/domains/${d.id}/verify`);
  if (!verified.body.canSend)
    throw new Error(`domain not sendable: ${JSON.stringify(verified.body)}`);
  return { ...t, connectionId: conn.id as string, domain };
}
