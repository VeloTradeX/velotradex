import { GateIORestClient, GateRestError } from '../../../../src/services/exchanges/gate/GateIORestClient';
import axios from 'axios';

const futuresApiMock = {
  createFuturesOrder: jest.fn(),
  amendFuturesOrder: jest.fn(),
  cancelFuturesOrder: jest.fn(),
  getFuturesOrder: jest.fn(),
  listFuturesOrders: jest.fn(),
  createPriceTriggeredOrder: jest.fn(),
  cancelPriceTriggeredOrder: jest.fn(),
  cancelPriceTriggeredOrderList: jest.fn(),
  listPriceTriggeredOrders: jest.fn(),
  listFuturesAccounts: jest.fn(),
  getPosition: jest.fn(),
  listPositions: jest.fn(),
  getMyTrades: jest.fn(),
  listFuturesContracts: jest.fn(),
  listFuturesTickers: jest.fn(),
  listFuturesCandlesticks: jest.fn(),
  updatePositionLeverage: jest.fn(),
};

const apiClientInstance = {
  basePath: '',
  setApiKeySecret: jest.fn(),
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({ defaults: {} })),
  },
}));

jest.mock('gate-api', () => ({
  ApiClient: jest.fn(() => apiClientInstance),
  FuturesApi: jest.fn(() => futuresApiMock),
}));

describe('GateIORestClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiClientInstance.basePath = '';
    (axios.create as jest.Mock).mockReturnValue({ defaults: {} });
  });

  function createClient() {
    return new GateIORestClient({
      id: 'gate-main',
      type: 'gate',
      name: 'Gate Main',
      baseURL: 'https://api.gateio.ws/api/v4',
      apiKey: ' key ',
      apiSecret: ' secret ',
      isTestnet: false,
    });
  }

  it('configures ApiClient with trimmed credentials and base path', () => {
    createClient();

    expect(apiClientInstance.basePath).toBe('https://api.gateio.ws/api/v4');
    expect(apiClientInstance.setApiKeySecret).toHaveBeenCalledWith('key', 'secret');
  });

  it('creates futures orders through SDK REST', async () => {
    const client = createClient();
    futuresApiMock.createFuturesOrder.mockResolvedValue({
      body: { id: 123, status: 'open', size: 5, price: '100', text: 't-entry' },
    });

    const result = await client.createOrder({
      contract: 'BTC_USDT',
      size: 5,
      price: '100',
      tif: 'gtc',
      text: 't-entry',
      reduce_only: false,
    });

    expect(futuresApiMock.createFuturesOrder).toHaveBeenCalledWith('usdt', {
      contract: 'BTC_USDT',
      size: 5,
      price: '100',
      tif: 'gtc',
      text: 't-entry',
      reduce_only: false,
    }, {});
    expect(result).toEqual({ id: 123, status: 'open', size: 5, price: '100', text: 't-entry' });
  });

  it('creates price-triggered orders through SDK REST', async () => {
    const client = createClient();
    const body = {
      initial: {
        contract: 'ETH_USDT',
        size: -2,
        price: '0',
        close: false,
        reduce_only: true,
        tif: 'ioc',
        text: 't-sl-ord-1',
      },
      trigger: {
        strategy_type: 0,
        price_type: 0,
        price: '3000',
        rule: 2,
        expiration: 2592000,
      },
    };
    futuresApiMock.createPriceTriggeredOrder.mockResolvedValue({ body: { id: 456, ...body } });

    const result = await client.createPriceOrder(body);

    expect(futuresApiMock.createPriceTriggeredOrder).toHaveBeenCalledWith('usdt', body);
    expect(result.id).toBe(456);
  });

  it('lists open futures orders with contract and status options', async () => {
    const client = createClient();
    futuresApiMock.listFuturesOrders.mockResolvedValue({ body: [{ id: 1, contract: 'BTC_USDT' }] });

    const result = await client.listOrders({ contract: 'BTC_USDT', status: 'open', limit: 50 });

    expect(futuresApiMock.listFuturesOrders).toHaveBeenCalledWith('usdt', 'open', {
      contract: 'BTC_USDT',
      limit: 50,
    });
    expect(result).toEqual([{ id: 1, contract: 'BTC_USDT' }]);
  });

  it('normalizes SDK errors with Gate label and response body', async () => {
    const client = createClient();
    futuresApiMock.createFuturesOrder.mockRejectedValue({
      response: {
        status: 400,
        data: { label: 'ORDER_POC_IMMEDIATE', message: 'would immediately match' },
      },
      message: 'Bad Request',
    });

    await expect(client.createOrder({
      contract: 'BTC_USDT',
      size: 1,
      price: '1',
      tif: 'poc',
      text: 't-maker',
    })).rejects.toMatchObject<Partial<GateRestError>>({
      status: 400,
      label: 'ORDER_POC_IMMEDIATE',
      responseBody: { label: 'ORDER_POC_IMMEDIATE', message: 'would immediately match' },
    });
  });

  it('normalizes retryable failures without retrying internally', async () => {
    const client = createClient();
    futuresApiMock.getFuturesOrder
      .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'socket hang up' });

    await expect(client.getOrder('BTC_USDT', 'ok')).rejects.toMatchObject({
      method: 'GET',
      path: '/api/v4/futures/usdt/orders/ok',
      message: 'socket hang up',
    });

    expect(futuresApiMock.getFuturesOrder).toHaveBeenCalledTimes(1);
  });

  it('does not retry normal business 4xx errors', async () => {
    const client = createClient();
    futuresApiMock.cancelPriceTriggeredOrder.mockRejectedValue({
      response: {
        status: 404,
        data: { label: 'AUTO_ORDER_NOT_FOUND', message: 'not found' },
      },
      message: 'Not Found',
    });

    await expect(client.cancelPriceOrder('missing')).rejects.toMatchObject({
      status: 404,
      label: 'AUTO_ORDER_NOT_FOUND',
    });
    expect(futuresApiMock.cancelPriceTriggeredOrder).toHaveBeenCalledTimes(1);
    expect(futuresApiMock.cancelPriceTriggeredOrder).toHaveBeenCalledWith('usdt', 'missing');
  });

  it('fetches account, positions, trades, contracts, tickers, candles, and leverage through SDK', async () => {
    const client = createClient();
    futuresApiMock.listFuturesAccounts.mockResolvedValue({ body: { total: '100', available: '80' } });
    futuresApiMock.getPosition.mockResolvedValue({ body: { contract: 'BTC_USDT', size: '1' } });
    futuresApiMock.listPositions.mockResolvedValue({ body: [{ contract: 'BTC_USDT', size: '1' }] });
    futuresApiMock.getMyTrades.mockResolvedValue({ body: [{ id: 1, order_id: 2 }] });
    futuresApiMock.listFuturesContracts.mockResolvedValue({ body: [{ name: 'BTC_USDT' }] });
    futuresApiMock.listFuturesTickers.mockResolvedValue({ body: [{ contract: 'BTC_USDT', last: '100' }] });
    futuresApiMock.listFuturesCandlesticks.mockResolvedValue({ body: [{ t: 1, c: '100' }] });
    futuresApiMock.updatePositionLeverage.mockResolvedValue({ body: { leverage: '0' } });

    await expect(client.getAccount()).resolves.toEqual({ total: '100', available: '80' });
    await expect(client.getPosition('BTC_USDT')).resolves.toEqual({ contract: 'BTC_USDT', size: '1' });
    await expect(client.listPositions()).resolves.toEqual([{ contract: 'BTC_USDT', size: '1' }]);
    await expect(client.listTrades('BTC_USDT', 10)).resolves.toEqual([{ id: 1, order_id: 2 }]);
    await expect(client.listContracts()).resolves.toEqual([{ name: 'BTC_USDT' }]);
    await expect(client.listTickers('BTC_USDT')).resolves.toEqual([{ contract: 'BTC_USDT', last: '100' }]);
    await expect(client.listCandlesticks('BTC_USDT', '4h', 2)).resolves.toEqual([{ t: 1, c: '100' }]);
    await expect(client.updateLeverage('BTC_USDT', '0')).resolves.toEqual({ leverage: '0' });

    expect(futuresApiMock.listFuturesAccounts).toHaveBeenCalledWith('usdt');
    expect(futuresApiMock.getPosition).toHaveBeenCalledWith('usdt', 'BTC_USDT');
    expect(futuresApiMock.listPositions).toHaveBeenCalledWith('usdt', {});
    expect(futuresApiMock.getMyTrades).toHaveBeenCalledWith('usdt', { contract: 'BTC_USDT', limit: 10 });
    expect(futuresApiMock.listFuturesContracts).toHaveBeenCalledWith('usdt', {});
    expect(futuresApiMock.listFuturesTickers).toHaveBeenCalledWith('usdt', { contract: 'BTC_USDT' });
    expect(futuresApiMock.listFuturesCandlesticks).toHaveBeenCalledWith('usdt', 'BTC_USDT', {
      interval: '4h',
      limit: 2,
    });
    expect(futuresApiMock.updatePositionLeverage).toHaveBeenCalledWith('usdt', 'BTC_USDT', '0', {});
  });

  it('does not retry internally when normalizing retryable errors', async () => {
    const client = createClient();
    const networkErr = { code: 'ECONNRESET', message: 'socket hang up' };
    futuresApiMock.getFuturesOrder.mockRejectedValue(networkErr);

    await expect(client.getOrder('BTC_USDT', 'fail')).rejects.toMatchObject({
      method: 'GET',
      path: '/api/v4/futures/usdt/orders/fail',
      message: 'socket hang up',
    });
    expect(futuresApiMock.getFuturesOrder).toHaveBeenCalledTimes(1);
  });

  it('normalizes network errors without response using error.message', async () => {
    const client = createClient();
    futuresApiMock.getFuturesOrder.mockRejectedValue(new Error('connection refused'));

    await expect(client.getOrder('BTC_USDT', 'fail')).rejects.toMatchObject({
      message: 'connection refused',
      responseBody: undefined,
    });
  });
});
