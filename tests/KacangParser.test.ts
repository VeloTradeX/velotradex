import { KacangParser } from '../src/services/parsers/KacangParser';
import registry from '../src/services/parsers';

function msg(content: string, extra: Record<string, any> = {}) {
  return { id: 'kacang-1', channel_id: '100000000000000001', content, username: 'example_user', ...extra };
}

function parseOne(content: string) {
  const parser = new KacangParser();
  (parser as any).writeDebugLog = jest.fn();
  return parser.parse(msg(content));
}

describe('KacangParser', () => {
  it('解析标准 BUY 信号（区间双层入场）', async () => {
    const strategies = await parseOne(
      'Gold buy now @ 4325 - 4321\n\ntp1 : 4335\ntp2 : 4340\nsl : 4318\n\nLayer slowly in zone !',
    );
    expect(strategies).toHaveLength(1);
    const s = strategies![0];
    expect(s.action).toBe('open');
    expect(s.symbol).toBe('XAU_USDT');
    expect(s.side).toBe('buy');
    expect(s.orderType).toBe('market');
    expect(s.entryPrice).toBe('4321'); // 买单取区间低点
    expect(s.targets).toEqual(['4335', '4340']);
    expect(s.stopLoss).toBe('4318');
    expect(s.entries).toMatchObject([
      { type: 'market' },
      { type: 'limit', price: 4325 }, // 买单 L2 限价 = 区间高点
    ]);
    expect(s.riskMultiplier).toBe(1);
    expect(s.sourceType).toBe('text');
  });

  it('解析标准 SELL 信号', async () => {
    const strategies = await parseOne(
      'Gold sell now guys @ 4330.50 - 4334.50\n\ntp1 : 4324.50\ntp2 : 4320.50\nsl : 4337.50\n\nLayer slowly in zone !',
    );
    const s = strategies![0];
    expect(s.side).toBe('sell');
    expect(s.entryPrice).toBe('4334.5'); // 卖单取区间高点
    expect(s.entries).toMatchObject([
      { type: 'market' },
      { type: 'limit', price: 4330.5 }, // 卖单 L2 限价 = 区间低点
    ]);
    expect(s.targets).toEqual(['4324.5', '4320.5']);
    expect(s.stopLoss).toBe('4337.5');
  });

  it('双倍手数（double lot）映射为 riskMultiplier=2', async () => {
    const strategies = await parseOne(
      'Gold sell now double lot @ 4286 - 4290\n\ntp1 : 4270\ntp2 : 4265\nsl : 4293\n\nLayer slowly in zone !',
    );
    const s = strategies![0];
    expect(s.riskMultiplier).toBe(2);
  });

  it('单价格入场点按方向推断区间第二点', async () => {
    const buy = await parseOne('Gold buy now @ 4177\n\ntp1 : 4185\ntp2 : 4190\nsl : 4170\n\nLayer slowly in zone !');
    expect(buy![0].entryPrice).toBe('4173'); // 买单第二点 = 4177-4
    expect(buy![0].entries![1].price).toBe(4177);

    const sell = await parseOne('Gold sell now @ 4147\n\ntp1 : 4138\ntp2 : 4130\nsl : 4155\n\nLayer slowly in zone !');
    expect(sell![0].entryPrice).toBe('4151'); // 卖单范围 = 4147-4151，取高点
    expect(sell![0].entries![1].price).toBe(4147); // 卖单 L2 限价 = 低点
  });

  it('兼容 tp2 分号写法', async () => {
    const strategies = await parseOne(
      'Gold buy now @ 4107 - 4103\n\ntp1 : 4117\ntp2 ; 4125\nsl : 4100\n\nLayer slowly in zone !',
    );
    expect(strategies![0].targets).toEqual(['4117', '4125']);
  });

  it('缺 TP1/SL 的截断 BUY 信号用均值反推补全（sourceType=text_inferred）', async () => {
    // 仅保留方向 + "@ 入场价"（= 区间远端 L2 端点 4325），缺 TP1 → 均值反推
    const strategies = await parseOne('Gold buy now @ 4325 - 4321\n\nsl : 4318');
    expect(strategies).toHaveLength(1);
    const s = strategies![0];
    expect(s.side).toBe('buy');
    expect(s.entryPrice).toBe('4321');
    expect(s.targets).toEqual(['4335.8', '4341.9']); // 4325 + 10.8 / + 16.9
    expect(s.stopLoss).toBe('4317.8'); // 4325 - 7.2（均值反推，覆盖消息自带值）
    expect(s.entries).toMatchObject([{ type: 'market' }, { type: 'limit', price: 4325 }]);
    expect(s.sourceType).toBe('text_inferred');
  });

  it('缺 SL 的截断信号也按均值反推补全', async () => {
    const strategies = await parseOne('Gold buy now @ 4325 - 4321\n\ntp1 : 4335\n\ntp2 : 4340');
    expect(strategies).toHaveLength(1);
    const s = strategies![0];
    expect(s.targets).toEqual(['4335.8', '4341.9']);
    expect(s.stopLoss).toBe('4317.8');
    expect(s.sourceType).toBe('text_inferred');
  });

  it('截断 SELL 信号反推方向正确（TP 下行、SL 上行）', async () => {
    const strategies = await parseOne('Gold sell now @ 4147');
    expect(strategies).toHaveLength(1);
    const s = strategies![0];
    expect(s.side).toBe('sell');
    expect(s.entryPrice).toBe('4151'); // 卖单范围 4147-4151，取高点
    expect(s.targets).toEqual(['4136.2', '4130.1']); // 4147 - 10.8 / - 16.9
    expect(s.stopLoss).toBe('4154.2'); // 4147 + 7.2
    expect(s.entries![1].price).toBe(4147); // 卖单 L2 限价 = 低点
    expect(s.sourceType).toBe('text_inferred');
  });

  it('没有 TP/SL 的播报（now 通知）忽略', async () => {
    const strategies = await parseOne('Gold buy now instant 1-2 layer');
    expect(strategies).toBeNull();
  });

  it('没有方向的回复消息忽略', async () => {
    const strategies = await parseOne('回复: [Gold buy now @ 4325 - 4321 tp1 : 4335 tp2 : 4340 sl : 4318](https://discord.com/x)\nPACAK');
    expect(strategies).toBeNull();
  });

  it('带 @ 但无方向的价格行情忽略', async () => {
    const strategies = await parseOne('Ready signal\nGold at 4320 support');
    expect(strategies).toBeNull();
  });

  it('空内容忽略', async () => {
    expect(await parseOne('')).toBeNull();
  });

  it('已在注册表中注册', () => {
    const parser = registry.getParserByName('KacangParser');
    expect(parser).not.toBeNull();
    expect(parser!.name).toBe('KacangParser');
  });
});