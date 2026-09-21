import crypto from 'crypto';
import ApiCredential from '../models/ApiCredential';

export const READ_SCOPES = [
  'orders:read',
  'strategies:read',
  'logs:read',
  'audit:read',
  'exchanges:read',
  'positions:read',
] as const;

export type ApiCredentialScope = typeof READ_SCOPES[number];

export interface SafeApiCredential {
  id: number;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  disabledAt: Date | null;
  createdByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'disabled' | 'expired';
}

export function createApiCredentialToken(id: number): string {
  const secret = crypto.randomBytes(32).toString('base64url');
  return `ctcli_${id}_${secret}`;
}

export function getApiCredentialTokenPrefix(token: string): string {
  const parts = token.split('_');
  if (parts.length < 3 || parts[0] !== 'ctcli') return '';
  const secretPreview = parts[2].slice(0, 8);
  return `ctcli_${parts[1]}_${secretPreview}`;
}

export function parseApiCredentialId(token: string): number | null {
  const match = token.match(/^ctcli_(\d+)_/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function hashApiCredentialToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseScopes(scopes: string | string[] | null | undefined): string[] {
  if (Array.isArray(scopes)) return scopes.map(String);
  if (!scopes) return [];
  try {
    const parsed = JSON.parse(scopes);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizeScopes(scopes: unknown): ApiCredentialScope[] {
  const input = Array.isArray(scopes) ? scopes.map(String) : [];
  return input.filter((scope): scope is ApiCredentialScope =>
    (READ_SCOPES as readonly string[]).includes(scope)
  );
}

export function getCredentialStatus(credential: Pick<ApiCredential, 'disabledAt' | 'expiresAt'>): 'active' | 'disabled' | 'expired' {
  if (credential.disabledAt) return 'disabled';
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export function safeSerializeApiCredential(credential: ApiCredential): SafeApiCredential {
  const raw = typeof (credential as any).toJSON === 'function'
    ? (credential as any).toJSON()
    : credential;

  return {
    id: raw.id,
    name: raw.name,
    tokenPrefix: raw.tokenPrefix,
    scopes: parseScopes(raw.scopes),
    expiresAt: raw.expiresAt,
    lastUsedAt: raw.lastUsedAt,
    disabledAt: raw.disabledAt,
    createdByUserId: raw.createdByUserId ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    status: getCredentialStatus(raw),
  };
}

export async function verifyApiCredentialToken(token: string): Promise<ApiCredential | null> {
  const id = parseApiCredentialId(token);
  if (!id) return null;

  const credential = await ApiCredential.findByPk(id);
  if (!credential) return null;

  const tokenHash = hashApiCredentialToken(token);
  const storedHash = String(credential.tokenHash);
  const tokenHashBuffer = Buffer.from(tokenHash, 'hex');
  const storedHashBuffer = Buffer.from(storedHash, 'hex');
  if (
    tokenHashBuffer.length !== storedHashBuffer.length ||
    !crypto.timingSafeEqual(tokenHashBuffer, storedHashBuffer)
  ) {
    return null;
  }

  if (getCredentialStatus(credential) !== 'active') return null;

  credential.lastUsedAt = new Date();
  await credential.save();
  return credential;
}
