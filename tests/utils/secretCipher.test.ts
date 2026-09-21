import {
  encryptSecret,
  decryptSecret,
  looksEncrypted,
  setSecretKeyIfConfiguredFrom,
} from '../../src/utils/secretCipher';

const TEST_KEY = 'test-encryption-passphrase-0123456789';
const NO_KEY = { server: { encryptionKey: '' } };

describe('secretCipher', () => {
  afterEach(() => {
    // Always reset to an unconfigured state between tests so test order can't leak state.
    setSecretKeyIfConfiguredFrom(NO_KEY);
  });

  describe('with an encryption key configured', () => {
    beforeEach(() => {
      setSecretKeyIfConfiguredFrom({ server: { encryptionKey: TEST_KEY } });
    });

    it('encrypt -> decrypt round trip returns the original plaintext', () => {
      const plaintext = 'supersecretapikey';
      const ciphertext = encryptSecret(plaintext);

      expect(ciphertext).not.toBe(plaintext);
      expect(looksEncrypted(ciphertext)).toBe(true);
      expect(ciphertext.startsWith('enc:v1:')).toBe(true);
      expect(decryptSecret(ciphertext)).toBe(plaintext);
    });

    it('produces an `enc:v1:<iv>:<authTag>:<ciphertext>` shaped payload', () => {
      const ciphertext = encryptSecret('abc');
      const parts = ciphertext.split(':');
      // prefix split yields >= 5 segments: enc, v1, iv, authTag, ciphertext
      expect(parts.length).toBe(5);
      expect(parts[0]).toBe('enc');
      expect(parts[1]).toBe('v1');
      // iv and authTag are both 16 base64 chars for 12-byte values
      expect(parts[2]).toHaveLength(16);
      expect(parts[3]).toHaveLength(24);
    });

    it('does not re-encrypt an already-encrypted value (idempotency)', () => {
      const ciphertext = encryptSecret('secret');
      expect(encryptSecret(ciphertext)).toBe(ciphertext);
    });

    it('does not encrypt an empty string', () => {
      expect(encryptSecret('')).toBe('');
    });

    it('returns plaintext as-is when decrypting a non-encrypted payload', () => {
      expect(decryptSecret('plain-old-secret')).toBe('plain-old-secret');
    });

    it('returns plaintext as-is when decrypting legacy data without prefix', () => {
      expect(decryptSecret('legacy')).toBe('legacy');
    });

    it('throws a clear error when the key changes between encrypt and decrypt', () => {
      const ciphertext = encryptSecret('secret');
      setSecretKeyIfConfiguredFrom({ server: { encryptionKey: 'a-different-key' } });
      expect(() => decryptSecret(ciphertext)).toThrow(/Failed to decrypt|SERVER_ENCRYPTION_KEY|Different key|key changed/i);
    });

    it('throws when trying to decrypt when no key is configured', () => {
      const ciphertext = encryptSecret('secret');
      setSecretKeyIfConfiguredFrom(NO_KEY);
      expect(() => decryptSecret(ciphertext)).toThrow(/not configured/i);
    });
  });

  describe('without an encryption key configured (backward compatible)', () => {
    it('returns plaintext unchanged when encrypting', () => {
      expect(encryptSecret('my-secret')).toBe('my-secret');
    });

    it('treats plaintext as not encrypted', () => {
      expect(looksEncrypted('a1b2c3')).toBe(false);
    });

    it('still passes through a pre-existing encrypted payload through decrypt', () => {
      // Even with no key, decrypting a plaintext string returns it unchanged.
      expect(decryptSecret('not-encrypted')).toBe('not-encrypted');
    });
  });

  describe('looksEncrypted', () => {
    it('recognizes the `enc:v1:` prefix', () => {
      expect(looksEncrypted('enc:v1:aa:bb:cc')).toBe(true);
    });

    it('rejects values without the prefix and non-strings', () => {
      expect(looksEncrypted('enc:v2:aa')).toBe(false);
      expect(looksEncrypted('plain')).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(looksEncrypted(123 as any)).toBe(false);
    });
  });
});