import { sequelize, AILog } from '../../src/models';
import { listAILogs } from '../../src/routes/aiConfig';

describe('AI config route helpers', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  const createLog = (overrides: Partial<AILog> = {}) => {
    return AILog.create({
      model: 'gpt-4o',
      originalMessage: 'raw',
      prompt: 'prompt',
      response: '{}',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      durationMs: 10,
      status: 'success',
      ...overrides,
    } as any);
  };

  it('filters logs by route id stored in routeIds JSON', async () => {
    await createLog({ routeIds: JSON.stringify([3]), routeNames: JSON.stringify(['主路由']) });
    await createLog({ routeIds: JSON.stringify([13]), routeNames: JSON.stringify(['其他路由']) });
    await createLog({ routeIds: JSON.stringify([3, 13]), routeNames: JSON.stringify(['主路由', '其他路由']) });
    await createLog({ routeIds: null, routeNames: null });

    const result = await listAILogs({ page: '1', limit: '20', routeId: '3' });

    expect(result.total).toBe(2);
    expect(result.logs.map((log: any) => log.routeIds)).toEqual([
      JSON.stringify([3, 13]),
      JSON.stringify([3]),
    ]);
  });
});
