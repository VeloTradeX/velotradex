import axios from 'axios';
import { WebhookConfig } from '../../src/models';
import logger from '../../src/utils/logger';
import webhookService from '../../src/services/WebhookService';

jest.mock('axios', () => {
  const axiosMock = jest.fn();
  (axiosMock as any).post = jest.fn();
  return { __esModule: true, default: axiosMock };
});

jest.mock('../../src/models', () => ({
  WebhookConfig: {
    findAll: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  formatError: jest.fn((e: any) => ({ errorMessage: e?.message, errorName: e?.name })),
}));

const axiosMock = axios as unknown as jest.Mock;
const axiosPost = (axios as any).post as jest.Mock;

function makeConfig(overrides: any = {}) {
  return {
    id: 1,
    name: 'hook',
    type: 'webhook',
    url: 'https://example.com/webhook',
    events: JSON.stringify(['ORDER_CREATED']),
    ...overrides,
  };
}

async function setConfigs(configs: any[]) {
  (WebhookConfig.findAll as jest.Mock).mockResolvedValue(configs);
  await webhookService.reloadConfigs();
}

describe('WebhookService', () => {
  beforeEach(async () => {
    (WebhookConfig.findAll as jest.Mock).mockResolvedValue([]);
    await webhookService.reloadConfigs();
  });

  it('reloadConfigs loads active configs from the database', async () => {
    await setConfigs([makeConfig()]);

    expect(WebhookConfig.findAll).toHaveBeenCalledWith({ where: { isActive: true } });
    expect(logger.info).toHaveBeenCalledWith('WebhookService loaded 1 configs.');
  });

  it('dispatch skips delivery when no config subscribes to the event', async () => {
    await webhookService.dispatch('ORDER_CREATED', { symbol: 'BTC_USDT' });

    expect(axiosMock).not.toHaveBeenCalled();
  });

  it('dispatch matches configs with events given as array or JSON string', async () => {
    await setConfigs([
      makeConfig({ id: 1, name: 'a', events: ['ORDER_CREATED'] }),
      makeConfig({ id: 2, name: 'b', events: JSON.stringify(['ORDER_CREATED']) }),
      makeConfig({ id: 3, name: 'c', events: ['OTHER_EVENT'] }),
    ]);

    await webhookService.dispatch('ORDER_CREATED', { symbol: 'BTC_USDT' });

    expect(axiosMock).toHaveBeenCalledTimes(2);
  });

  it('dispatch supports the * wildcard subscription', async () => {
    await setConfigs([makeConfig({ events: ['*'] })]);

    await webhookService.dispatch('SOMETHING_ELSE', {});

    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  it('dispatch skips configs whose events field is invalid JSON', async () => {
    await setConfigs([makeConfig({ events: '{invalid json' })]);

    await webhookService.dispatch('ORDER_CREATED', {});

    expect(axiosMock).not.toHaveBeenCalled();
  });

  it('a failed config reload keeps the previously loaded configs', async () => {
    await setConfigs([makeConfig()]);
    (WebhookConfig.findAll as jest.Mock).mockRejectedValue(new Error('db down'));

    await webhookService.reloadConfigs();
    expect(logger.error).toHaveBeenCalledWith('Failed to load webhook configs', expect.anything());

    await webhookService.dispatch('ORDER_CREATED', {});
    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  it('generic webhook posts the payload with default POST method and standard headers', async () => {
    await setConfigs([makeConfig()]);

    await webhookService.dispatch('ORDER_CREATED', { symbol: 'BTC_USDT' });

    expect(axiosMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: 'https://example.com/webhook',
      data: {
        event: 'ORDER_CREATED',
        timestamp: expect.any(Number),
        data: { symbol: 'BTC_USDT' },
      },
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'ORDER_CREATED',
        'X-Webhook-Timestamp': expect.any(String),
      }),
      timeout: 5000,
    }));
  });

  it('generic webhook merges sanitized custom headers from config', async () => {
    await setConfigs([
      makeConfig({ type: undefined, headers: JSON.stringify({ 'X-Token': 'secret' }) }),
    ]);

    await webhookService.dispatch('ORDER_CREATED', {});

    const callArgs = axiosMock.mock.calls[0][0];
    expect(callArgs.headers['X-Token']).toBe('secret');
  });

  it('generic webhook renders a JSON template into an object body', async () => {
    await setConfigs([
      makeConfig({ template: '{"event":"${event}","orderId":"${orderId}"}' }),
    ]);

    await webhookService.dispatch('ORDER_CREATED', { orderId: 'o-1' });

    expect(axiosMock.mock.calls[0][0].data).toEqual({
      event: 'ORDER_CREATED',
      orderId: 'o-1',
    });
  });

  it('generic webhook sends a non-JSON template result as a raw string body', async () => {
    await setConfigs([makeConfig({ template: 'Order ${orderId} created' })]);

    await webhookService.dispatch('ORDER_CREATED', { orderId: 'o-1' });

    expect(axiosMock.mock.calls[0][0].data).toBe('Order o-1 created');
  });

  it('feishu delivery sends a text message with a human readable body', async () => {
    await setConfigs([
      makeConfig({ type: 'feishu', url: 'https://open.feishu.cn/hook' }),
    ]);

    await webhookService.dispatch('ORDER_CREATED', {
      symbol: 'BTC_USDT',
      side: 'buy',
      exchangeOrderId: 'e-9',
      price: '100',
      amount: '0.5',
      parser: 'gauls',
    });

    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axiosPost.mock.calls[0];
    expect(url).toBe('https://open.feishu.cn/hook');
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('✅ 挂单成功');
    expect(body.content.text).toContain('BTC_USDT');
    expect(body.content.text).toContain('ID: e-9');
    expect(opts).toEqual({ timeout: 5000 });
  });

  it('dingtalk delivery sends a text message', async () => {
    await setConfigs([
      makeConfig({ type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send' }),
    ]);

    await webhookService.dispatch('ORDER_CREATED', { symbol: 'BTC_USDT' });

    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = axiosPost.mock.calls[0];
    expect(url).toBe('https://oapi.dingtalk.com/robot/send');
    expect(body.msgtype).toBe('text');
    expect(body.text.content).toContain('BTC_USDT');
  });

  it('pushover delivery splits title and message and defaults the API url', async () => {
    await setConfigs([
      makeConfig({
        type: 'pushover',
        url: '',
        config: JSON.stringify({ userKey: 'u-key', token: 'tok' }),
      }),
    ]);

    await webhookService.dispatch('ORDER_CREATED', { symbol: 'BTC_USDT' });

    expect(axiosPost).toHaveBeenCalledTimes(1);
    const [url, body] = axiosPost.mock.calls[0];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(body.token).toBe('tok');
    expect(body.user).toBe('u-key');
    expect(body.title).toBe('✅ 挂单成功');
    expect(body.message).not.toContain('✅ 挂单成功');
    expect(body.timestamp).toEqual(expect.any(Number));
  });

  it('pushover delivery without userKey/token fails softly without sending', async () => {
    await setConfigs([makeConfig({ type: 'pushover', config: '{}' })]);

    await expect(webhookService.dispatch('ORDER_CREATED', {})).resolves.toBeUndefined();

    expect(axiosPost).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('one failing target does not prevent delivery to other targets', async () => {
    await setConfigs([
      makeConfig({ id: 1, name: 'bad' }),
      makeConfig({ id: 2, name: 'good' }),
    ]);
    axiosMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 200 });

    await webhookService.dispatch('ORDER_CREATED', {});

    expect(axiosMock).toHaveBeenCalledTimes(2);
    // dispatch 通过 Promise.all 并行发送，失败目标的顺序由微任务调度决定，
    // 因此只断言「恰好一个目标失败被记录，且失败信息为 timeout」。
    const failureLogs = (logger.warn as jest.Mock).mock.calls.filter(([msg]) =>
      String(msg).startsWith('Failed to send webhook to'),
    );
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0][1]).toEqual({
      errorMessage: 'timeout',
      errorName: 'Error',
    });
  });
});
