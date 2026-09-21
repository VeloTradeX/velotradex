import * as crypto from 'crypto';
import config from '../config';

/**
 * Field-level AES-256-GCM encryption for sensitive credentials
 * (exchange API keys/secrets, AI API keys, etc.).
 *
 * Design goals:
 *  - Operate at the storage boundary (Sequelize model hooks).
 *  - Backward compatible: when SERVER_ENCRYPTION_KEY is NOT configured we fall
 *    back to storing plaintext (with a one-time warning). When it IS configured,
 *    sensitive fields are encrypted on write and decrypted on read.
 *  - Idempotent: payloads already prefixed with `enc:v1:` are never re-encrypted.
 */

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

/** Fields stored inside ExchangeInstance.config that should be encrypted. */
export const SENSITIVE_FIELDS = [
  'apiKey',
  'apiSecret',
  'privateKey',
  'apiPrivateKey',
  'secret',
  'password',
];

const warnedMessages = new Set<string>();

// Lazy-loaded 32-byte key derived from config.server.encryptionKey.
// `null` caches an explicit "not configured" state so we don't re-import config.
let secretKey: Buffer | null | undefined;

function deriveKey(encryptionKey: string): Buffer {
  return crypto.createHash('sha256').update(encryptionKey).digest();
}

/**
 * (Re)configure the encryption key from a config-shaped object.
 * Falls back to the application config when called without an argument.
 * Passing a config without encryptionKey (or an empty value) clears the key,
 * restoring plaintext passthrough mode.
 */
export function setSecretKeyIfConfiguredFrom(cfg: { server?: { encryptionKey?: string } } = config): void {
  const raw = cfg?.server?.encryptionKey;
  if (typeof raw === 'string' && raw.length > 0) {
    secretKey = deriveKey(raw);
  } else {
    secretKey = null;
  }
}

function getKey(): Buffer | null {
  if (secretKey === undefined) {
    setSecretKeyIfConfiguredFrom(config);
  }
  return secretKey ?? null;
}

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) {
    return;
  }
  warnedMessages.add(message);
  // Use console.warn to keep this util dependency-light (matches config.ts style).
  console.warn(`[secretCipher] ${message}`);
}

/**
 * Returns true when the value is already an encrypted payload
 * produced by this module (starts with the `enc:v1:` prefix).
 */
export function looksEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext secret. Falls back to returning plaintext unchanged when
 * no encryption key is configured (backward compatible), emitting a one-time
 * security warning. Never double-encrypts already-encrypted payloads.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return plaintext;
  }
  if (looksEncrypted(plaintext)) {
    return plaintext;
  }
  const key = getKey();
  if (!key) {
    warnOnce('Field-level encryption is DISABLED: SERVER_ENCRYPTION_KEY is not set. Sensitive secrets will be stored in plaintext.');
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt an encrypted payload. Payloads without the `enc:v1:` prefix are
 * treated as plaintext / legacy data and returned as-is. Throws with a clear
 * message when decryption fails (e.g. the key has changed).
 */
export function decryptSecret(payload: string): string {
  if (!looksEncrypted(payload)) {
    return payload;
  }
  const key = getKey();
  if (!key) {
    throw new Error(
      'Cannot decrypt secret: SERVER_ENCRYPTION_KEY is not configured, but encrypted data (enc:v1:...) was found. Set SERVER_ENCRYPTION_KEY to the key used when the data was encrypted.'
    );
  }
  const body = payload.slice(PREFIX.length);
  const [ivB64, authTagB64, dataB64] = body.split(':');
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret payload: expected "enc:v1:<iv>:<authTag>:<ciphertext>".');
  }
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(
      `Failed to decrypt secret. This usually means SERVER_ENCRYPTION_KEY changed after the data was encrypted. Original error: ${(err as Error).message}`
    );
  }
}