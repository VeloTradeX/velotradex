import { URL } from 'url';
import { promises as dnsPromises } from 'dns';

const PRIVATE_RANGES: Array<{ start: number; end: number }> = [
  { start: 0x0A000000, end: 0x0AFFFFFF },  // 10.0.0.0/8
  { start: 0xAC100000, end: 0xAC1FFFFF },  // 172.16.0.0/12
  { start: 0xC0A80000, end: 0xC0A8FFFF },  // 192.168.0.0/16
  { start: 0x7F000000, end: 0x7FFFFFFF },  // 127.0.0.0/8
  { start: 0xA9FE0000, end: 0xA9FEFFFF },  // 169.254.0.0/16
  { start: 0x00000000, end: 0x00FFFFFF },  // 0.0.0.0/8
];

const DANGEROUS_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding',
  'connection', 'upgrade', 'proxy-authorization',
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  return parts.reduce((acc, part) => (acc << 8) + parseInt(part, 10), 0) >>> 0;
}

function isPrivateIP(ip: string): boolean {
  const num = ipv4ToInt(ip);
  return PRIVATE_RANGES.some(r => num >= r.start && num <= r.end);
}

export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Webhook URL must use HTTPS protocol, got: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Webhook URL must not point to localhost');
  }
  const ipv4Match = hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (ipv4Match) {
    if (isPrivateIP(hostname)) {
      throw new Error(`Webhook URL must not point to a private IP address: ${hostname}`);
    }
  }
  if (hostname.startsWith('[') && (hostname.includes(':1]') || hostname.includes('fe80:'))) {
    throw new Error(`Webhook URL must not point to a loopback or link-local address: ${hostname}`);
  }
}

/**
 * Validate that a URL is safe to fetch over HTTP(S).
 *
 * Performs the same synchronous checks as `validateWebhookUrl`, plus a DNS
 * resolution re-check that guards against DNS rebinding: after the hostname is
 * resolved, every returned IPv4 address is tested against the private/loopback
 * ranges and rejected if any of them is private.
 */
export async function assertSafeFetchUrl(url: string): Promise<void> {
    validateWebhookUrl(url);

    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // Literal IPs were already validated above (private/loopback are blocked).
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) {
        return;
    }

    let addressRecords: import('dns').LookupAddress[];
    try {
        addressRecords = await dnsPromises.lookup(hostname, { all: true, family: 4 });
    } catch (error: any) {
        throw new Error(
            `SSRF check failed: unable to resolve host '${hostname}' (${error?.code || error?.message || 'unknown DNS error'})`
        );
    }

    const addresses = addressRecords.map(addr => addr.address);
    if (addresses.length === 0) {
        throw new Error(`SSRF check failed: host '${hostname}' resolved to no addresses`);
    }

    const blocked = addresses.find(addr => isPrivateIP(addr));
    if (blocked) {
        throw new Error(
            `SSRF check failed: host '${hostname}' resolves to a private IP address (${blocked})`
        );
    }
}

export function sanitizeCustomHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (DANGEROUS_HEADERS.has(key.toLowerCase())) continue;
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(`Header "${key}" contains invalid characters`);
    }
    safe[key] = value;
  }
  return safe;
}
