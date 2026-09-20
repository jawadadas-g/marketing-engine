import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export type Sealed = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

let cached: Buffer | undefined;

function key(): Buffer {
  if (!cached) {
    const hex = process.env.CREDENTIALS_KEY;
    if (!hex) throw new Error('CREDENTIALS_KEY is not set');
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      throw new Error('CREDENTIALS_KEY must be 32 bytes of hex (openssl rand -hex 32)');
    }
    cached = buf;
  }
  return cached;
}

/**
 * Seal provider credentials for storage. The plaintext exists only here and in
 * the adapter that uses it: never in a log line, an event payload or a
 * response body.
 */
export function encrypt(value: unknown): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decrypt<T = unknown>(sealed: Sealed): T {
  const decipher = createDecipheriv(ALGORITHM, key(), sealed.iv);
  decipher.setAuthTag(sealed.tag);
  const plaintext = Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as T;
}

/** Test seam only: the key is read once and cached. */
export function resetKeyCache(): void {
  cached = undefined;
}
