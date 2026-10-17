import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { KeyRing } from './crypto';

/**
 * Private object storage for attachments. Objects are encrypted with the application key ring
 * before upload, so the bucket never holds plaintext. Keys are always generated server-side.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  ping(): Promise<void>;
}

export interface S3StoreOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly opts: S3StoreOptions) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.opts.bucket }));
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }
}

/** In-memory store for unit tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
  }
  async get(key: string): Promise<Buffer> {
    const v = this.objects.get(key);
    if (!v) throw new Error('NoSuchKey');
    return v;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async ping(): Promise<void> {}
}

export function attachmentObjectKey(
  projectId: string,
  emailId: string,
  attachmentId: string,
): string {
  return `projects/${projectId}/emails/${emailId}/${attachmentId}`;
}

export async function putEncrypted(
  store: ObjectStore,
  keys: KeyRing,
  key: string,
  body: Buffer,
): Promise<void> {
  await store.put(key, keys.encryptBuffer(body, `object:${key}`), 'application/octet-stream');
}

export async function getDecrypted(
  store: ObjectStore,
  keys: KeyRing,
  key: string,
): Promise<Buffer> {
  return keys.decryptBuffer(await store.get(key), `object:${key}`);
}
