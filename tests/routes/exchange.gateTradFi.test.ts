/**
 * Gate-CFD（gate_tradfi）交易所路由/默认配置回归测试。
 * 覆盖：applyDefaultConfig 默认 baseURL、test 路由分支可创建 GateCFDExchange 实例
 * （回归：连接测试接口不得再抛 Unsupported exchange type）。
 */
import {
  applyDefaultConfig,
  serializeExchangeInstance,
} from '../../src/routes/exchange';
import { GateCFDExchange } from '../../src/services/exchanges/GateCFDExchange';

describe('exchange route gate_tradfi defaults', () => {
  it('applies gate_tradfi config defaults (baseURL, no wsURL since CFD has no WebSocket)', () => {
    const config: any = {};
    applyDefaultConfig('gate_tradfi', config);
    expect(config.baseURL).toBe('https://api.gateio.ws/api/v4');
    expect(config.wsURL).toBeUndefined();
  });

  it('preserves explicit gate_tradfi config values', () => {
    const config: any = { baseURL: 'https://custom.example', proxy: 'http://proxy:8080' };
    applyDefaultConfig('gate_tradfi', config);
    expect(config.baseURL).toBe('https://custom.example');
    expect(config.proxy).toBe('http://proxy:8080');
  });

  it('supports gate_cfd alias with same defaults', () => {
    const config: any = {};
    applyDefaultConfig('gate_cfd', config);
    expect(config.baseURL).toBe('https://api.gateio.ws/api/v4');
  });
});

describe('GateCFDExchange testConnection (route /api/exchanges/test branch)', () => {
  it('constructs a GateCFDExchange instance with gate_tradfi type (no Unsupported exchange type)', async () => {
    // 与 routes/exchange.ts POST /test 分支同一构造路径
    const testConfig: any = {
      id: 'test_connection',
      name: 'Test Connection',
      type: 'gate_tradfi',
      apiKey: '',
      apiSecret: '',
      baseURL: 'https://api.gateio.ws/api/v4',
    };
    const exchange = new GateCFDExchange(testConfig);
    expect(exchange.productLine).toBe('gate_cfd');
    // 无 API key 时 HTTP 探测应失败但不抛「Unsupported」类错误。
    // ws 为公共行情通道（fx-ws.gateio.ws）探测结果：CFD 无私有订单/持仓 WS，
    // 但公共行情 WS 存在且网络可达时为 true —— 故只断言类型，不断言具体值（避免依赖外网）。
    const result = await exchange.testConnection();
    expect(result.success).toBe(false);
    expect(result.http).toBe(false);
    expect(typeof result.ws).toBe('boolean');
    expect(result.message).toContain('HTTP Error');
  });
});
