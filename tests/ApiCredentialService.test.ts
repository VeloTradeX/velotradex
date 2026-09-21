import {
  createApiCredentialToken,
  hashApiCredentialToken,
  normalizeScopes,
  READ_SCOPES,
  safeSerializeApiCredential,
} from '../src/services/ApiCredentialService';

describe('ApiCredentialService', () => {
  test('creates ctcli token and hashes without exposing the secret in safe serialization', () => {
    const token = createApiCredentialToken(12);
    expect(token).toMatch(/^ctcli_12_[A-Za-z0-9_-]{32,}$/);

    const hash = hashApiCredentialToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);

    const safe = safeSerializeApiCredential({
      id: 12,
      name: 'AI diagnostics',
      tokenPrefix: 'ctcli_12_abcd',
      tokenHash: hash,
      scopes: JSON.stringify(['orders:read']),
      expiresAt: null,
      lastUsedAt: null,
      disabledAt: null,
      createdByUserId: 1,
      createdAt: new Date('2026-05-15T00:00:00.000Z'),
      updatedAt: new Date('2026-05-15T00:00:00.000Z'),
      toJSON() {
        return this;
      },
    } as any);

    expect(safe).toEqual({
      id: 12,
      name: 'AI diagnostics',
      tokenPrefix: 'ctcli_12_abcd',
      scopes: ['orders:read'],
      expiresAt: null,
      lastUsedAt: null,
      disabledAt: null,
      createdByUserId: 1,
      createdAt: new Date('2026-05-15T00:00:00.000Z'),
      updatedAt: new Date('2026-05-15T00:00:00.000Z'),
      status: 'active',
    });
    expect((safe as any).tokenHash).toBeUndefined();
    expect((safe as any).token).toBeUndefined();
  });

  test('normalizes scopes to the supported read-only set', () => {
    expect(normalizeScopes(['orders:read', 'bad:scope', 'logs:read'])).toEqual(['orders:read', 'logs:read']);
    expect(normalizeScopes(READ_SCOPES)).toEqual([...READ_SCOPES]);
    expect(normalizeScopes('orders:read')).toEqual([]);
  });
});
