import {
  getRequiredReadScope,
  isReadMethod,
  apiCredentialHasScope,
} from '../src/middleware/apiCredentialScope';

describe('apiCredentialScope helpers', () => {
  test('maps existing read routes to read scopes', () => {
    expect(getRequiredReadScope('/api/orders')).toBe('orders:read');
    expect(getRequiredReadScope('/api/orders/history')).toBe('orders:read');
    expect(getRequiredReadScope('/api/strategies')).toBe('strategies:read');
    expect(getRequiredReadScope('/api/logs')).toBe('logs:read');
    expect(getRequiredReadScope('/api/audit-logs')).toBe('audit:read');
    expect(getRequiredReadScope('/api/exchanges')).toBe('exchanges:read');
    expect(getRequiredReadScope('/api/positions')).toBe('positions:read');
  });

  test('allows only safe read method for api credential access', () => {
    expect(isReadMethod('GET')).toBe(true);
    expect(isReadMethod('HEAD')).toBe(true);
    expect(isReadMethod('POST')).toBe(false);
    expect(isReadMethod('PUT')).toBe(false);
    expect(isReadMethod('DELETE')).toBe(false);
  });

  test('checks parsed credential scopes', () => {
    expect(apiCredentialHasScope({ scopes: JSON.stringify(['orders:read']) } as any, 'orders:read')).toBe(true);
    expect(apiCredentialHasScope({ scopes: JSON.stringify(['orders:read']) } as any, 'logs:read')).toBe(false);
    expect(apiCredentialHasScope({ scopes: 'not-json' } as any, 'orders:read')).toBe(false);
  });
});
