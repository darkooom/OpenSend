import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM, Node/OpenSSL) with versioned keys.
 *
 * Ciphertext format: `osenc1.<keyId>.<iv b64url>.<tag b64url>.<data b64url>`.
 * `aad` binds a ciphertext to its context (e.g. `provider_connection:<id>`) so that
 * values cannot be swapped between rows. Keys come from the environment
 * (OPENSEND_ENCRYPTION_KEYS), never from the database.
 */
export class KeyRing {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    keys: Record<string, Buffer>,
    readonly activeKeyId: string,
  ) {
    for (const [id, key] of Object.entries(keys)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`invalid encryption key id "${id}"`);
      if (key.length !== 32) throw new Error(`encryption key "${id}" must be 32 bytes`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(activeKeyId))
      throw new Error(`active encryption key "${activeKeyId}" is not configured`);
  }

  static fromEnv(spec: string, activeKeyId: string): KeyRing {
    const keys: Record<string, Buffer> = {};
    for (const part of spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx <= 0) throw new Error('OPENSEND_ENCRYPTION_KEYS entries must look like keyId:base64');
      keys[part.slice(0, idx)] = Buffer.from(part.slice(idx + 1), 'base64');
    }
    return new KeyRing(keys, activeKeyId);
  }

  encrypt(plaintext: string | Buffer, aad: string): string {
    return this.encryptBuffer(
      Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'),
      aad,
    ).toString('utf8');
  }

  decrypt(ciphertext: string, aad: string): string {
    return this.decryptBuffer(Buffer.from(ciphertext, 'utf8'), aad).toString('utf8');
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(ciphertext: string, aad: string): T {
    return JSON.parse(this.decrypt(ciphertext, aad)) as T;
  }

  encryptBuffer(plaintext: Buffer, aad: string): Buffer {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.from(
      [
        'osenc1',
        this.activeKeyId,
        iv.toString('base64url'),
        tag.toString('base64url'),
        data.toString('base64url'),
      ].join('.'),
      'utf8',
    );
  }

  decryptBuffer(ciphertext: Buffer, aad: string): Buffer {
    const parts = ciphertext.toString('utf8').split('.');
    if (parts.length !== 5 || parts[0] !== 'osenc1')
      throw new Error('unrecognized ciphertext format');
    const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`ciphertext uses unknown key "${keyId}"`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
  }

  /** Key id a ciphertext was produced with (used by the rotation command). */
  static keyIdOf(ciphertext: string): string | null {
    const parts = ciphertext.split('.');
    return parts.length === 5 && parts[0] === 'osenc1' ? (parts[1] ?? null) : null;
  }

  needsRotation(ciphertext: string): boolean {
    return KeyRing.keyIdOf(ciphertext) !== this.activeKeyId;
  }
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}
