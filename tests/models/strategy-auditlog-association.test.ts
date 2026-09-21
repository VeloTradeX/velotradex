import { Strategy, AuditLog } from '../../src/models';

describe('Strategy-AuditLog association', () => {
  it('should have hasMany(AuditLog) association on Strategy', () => {
    const associations = Strategy.associations;
    expect(associations.AuditLogs).toBeDefined();
    expect(associations.AuditLogs.associationType).toBe('HasMany');
  });

  it('should have belongsTo(Strategy) association on AuditLog', () => {
    const associations = AuditLog.associations;
    expect(associations.Strategy).toBeDefined();
    expect(associations.Strategy.associationType).toBe('BelongsTo');
  });
});
