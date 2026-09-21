import axios from 'axios';
import { LighterRestTxClient } from '../../../../src/services/exchanges/lighter/LighterRestTxClient';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('LighterRestTxClient read endpoints', () => {
  let get: jest.Mock;

  beforeEach(() => {
    mockedAxios.create.mockReset();
    get = jest.fn();
    mockedAxios.create.mockReturnValue({ get } as never);
  });

  it('fetches account balance from account endpoint', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { account: { available_balance: '10' } } });

    await expect(client.getAccount(7)).resolves.toEqual({
      account: { available_balance: '10' },
    });

    expect(get).toHaveBeenCalledWith('/api/v1/account', {
      params: { by: 'index', value: 7 },
    });
  });

  it('sends auth header when fetching account if auth provider is configured', async () => {
    const client = new LighterRestTxClient('https://lighter.example', undefined, async () => 'auth-token-account');
    get.mockResolvedValue({ data: { account: { positions: [] } } });

    await client.getAccount(7);

    expect(get).toHaveBeenCalledWith('/api/v1/account', {
      params: { by: 'index', value: 7 },
      headers: { Authorization: 'auth-token-account' },
    });
  });

  it('fetches active orders from accountActiveOrders endpoint', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { orders: [] } });

    await client.getAccountOrders(7);

    expect(get).toHaveBeenCalledWith('/api/v1/accountActiveOrders', {
      params: { account_index: 7 },
    });
  });

  it('sends auth header when fetching active orders if auth provider is configured', async () => {
    const client = new LighterRestTxClient('https://lighter.example', undefined, async () => 'auth-token-1');
    get.mockResolvedValue({ data: { orders: [] } });

    await client.getAccountOrders(7);

    expect(get).toHaveBeenCalledWith('/api/v1/accountActiveOrders', {
      params: { account_index: 7 },
      headers: { Authorization: 'auth-token-1' },
    });
  });

  it('fetches order history from accountInactiveOrders endpoint', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { orders: [] } });

    await client.getAccountOrderHistory(7, 1, 50);

    expect(get).toHaveBeenCalledWith('/api/v1/accountInactiveOrders', {
      params: { account_index: 7, market_id: 1, limit: 50 },
    });
  });

  it('sends auth header when fetching order history if auth provider is configured', async () => {
    const client = new LighterRestTxClient('https://lighter.example', undefined, async () => 'auth-token-2');
    get.mockResolvedValue({ data: { orders: [] } });

    await client.getAccountOrderHistory(7, 1, 50);

    expect(get).toHaveBeenCalledWith('/api/v1/accountInactiveOrders', {
      params: { account_index: 7, market_id: 1, limit: 50 },
      headers: { Authorization: 'auth-token-2' },
    });
  });

  it('uses default limit of 100 for order history', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { orders: [] } });

    await client.getAccountOrderHistory(7, 1);

    expect(get).toHaveBeenCalledWith('/api/v1/accountInactiveOrders', {
      params: { account_index: 7, market_id: 1, limit: 100 },
    });
  });

  it('fetches trades from accountTrades endpoint', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { trades: [] } });

    await client.getAccountTrades(7, 1, 50);

    expect(get).toHaveBeenCalledWith('/api/v1/trades', {
      params: { account_index: 7, market_id: 1, limit: 50 },
    });
  });

  it('uses default limit of 100 for trades', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { trades: [] } });

    await client.getAccountTrades(7, 2);

    expect(get).toHaveBeenCalledWith('/api/v1/trades', {
      params: { account_index: 7, market_id: 2, limit: 100 },
    });
  });

  it('fetches ticker from orderBookDetails endpoint by market id', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { order_book_details: [{ last_trade_price: 65000 }] } });

    await expect(client.getTicker(1)).resolves.toEqual({
      order_book_details: [{ last_trade_price: 65000 }],
    });

    expect(get).toHaveBeenCalledWith('/api/v1/orderBookDetails', {
      params: { market_id: 1 },
    });
  });

  it('fetches candles from candles endpoint', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { c: [] } });

    await client.getCandles(1, '1h', 200, 1000, 2000);

    expect(get).toHaveBeenCalledWith('/api/v1/candles', {
      params: { market_id: 1, resolution: '1h', count_back: 200, start_timestamp: 1000, end_timestamp: 2000 },
    });
  });

  it('delegates getAccountPositions to getAccount', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValue({ data: { account: { positions: [] } } });

    await expect(client.getAccountPositions(7)).resolves.toEqual({
      account: { positions: [] },
    });

    expect(get).toHaveBeenCalledWith('/api/v1/account', {
      params: { by: 'index', value: 7 },
    });
  });

  it('fetches active and finished orders separately', async () => {
    const client = new LighterRestTxClient('https://lighter.example');
    get.mockResolvedValueOnce({ data: { orders: [] } });
    get.mockResolvedValueOnce({ data: { orders: [] } });

    await client.getAccountOrders(7);
    await client.getAccountOrderHistory(7, 1, 50);

    expect(get).toHaveBeenNthCalledWith(1, '/api/v1/accountActiveOrders', {
      params: { account_index: 7 },
    });
    expect(get).toHaveBeenNthCalledWith(2, '/api/v1/accountInactiveOrders', {
      params: { account_index: 7, market_id: 1, limit: 50 },
    });
  });
});
