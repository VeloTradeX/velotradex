import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as GateApi from 'gate-api';
import { ExchangeConfig } from '../IExchange';
import config from '../../../config';
import { ensureTimeSynced, getTimeOffsetMs } from './GateTimeSync';

export interface GateRestError extends Error {
  status?: number;
  label?: string;
  method?: string;
  path?: string;
  requestBody?: any;
  responseBody?: any;
  raw?: any;
}

const SETTLE = 'usdt';

const GATE_MAINNET_BASE = 'https://api.gateio.ws/api/v4';
// 旧域名 api-testnet.gateio.ws 在当前网络下不可达（DNS/TLS 失败），gateapi.io 实测可用
const GATE_TESTNET_BASE = 'https://api-testnet.gateapi.io/api/v4';

function normalizeError(err: any, method: string, path: string, requestBody?: any): GateRestError {
  const resp = err.response;
  const body = resp?.data ?? resp?.body;
  const error: any = new Error(body?.message || err.message || 'Unknown error');
  error.status = resp?.status;
  error.label = body?.label;
  error.method = method;
  error.path = path;
  error.requestBody = requestBody;
  error.responseBody = body;
  error.raw = err;
  return error as GateRestError;
}

function extractBody(sdkResponse: any): any {
  if (sdkResponse && typeof sdkResponse === 'object' && 'body' in sdkResponse) {
    return sdkResponse.body;
  }
  return sdkResponse;
}

export class GateIORestClient {
  private futuresApi: InstanceType<typeof GateApi.FuturesApi>;
  private settle: 'usdt' = 'usdt';
  private basePath: string = GATE_MAINNET_BASE;

  constructor(exchangeConfig: ExchangeConfig) {
    // 兼容 proxy / proxyUrl 两个字段（UI 保存过两种命名），再回退到全局 apiProxy
    const proxyUrl = exchangeConfig.proxy || (exchangeConfig as any).proxyUrl || config.trading.apiProxy;
    const axiosConfig: any = { timeout: 10000 };
    if (proxyUrl) {
      axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.proxy = false;
    }
    const axiosInstance = axios.create(axiosConfig);

    const basePath = exchangeConfig.baseURL
      || (exchangeConfig.isTestnet ? GATE_TESTNET_BASE : GATE_MAINNET_BASE);
    this.basePath = basePath;

    const client = new GateApi.ApiClient(undefined, axiosInstance);
    client.basePath = basePath;

    const apiKey = exchangeConfig.apiKey?.trim();
    const apiSecret = exchangeConfig.apiSecret?.trim();
    if (apiKey || apiSecret) {
      client.setApiKeySecret(apiKey, apiSecret);
    }

    // 服务器时间校准：Gate 签名使用本机时间戳，时钟偏差会导致 REQUEST_EXPIRED。
    // 启动时预热同步；每次请求前在 withRetry 中按 TTL 刷新。同时用偏移重定义
    // SDK 的签名时间戳（同步替换 Date.prototype.getTime，仅覆盖签名计算窗口）。
    void ensureTimeSynced(basePath).catch(() => {});
    const auth: any = (client as any).authentications?.['apiv4'];
    if (auth && typeof auth.applyToRequest === 'function') {
      const originalApply = auth.applyToRequest.bind(auth);
      auth.applyToRequest = (config: any) => {
        const offset = getTimeOffsetMs();
        if (Math.abs(offset) < 2_000) {
          return originalApply(config);
        }
        const originalGetTime = Date.prototype.getTime;
        try {
          Date.prototype.getTime = function () {
            return originalGetTime.apply(this, []) + offset;
          };
          return originalApply(config);
        } finally {
          Date.prototype.getTime = originalGetTime;
        }
      };
    }

    this.futuresApi = new GateApi.FuturesApi(client);
  }

  getBasePath(): string {
    return this.basePath;
  }

  private async withRetry<T>(fn: () => Promise<T>, method: string, path: string, requestBody?: any): Promise<T> {
    try {
      await ensureTimeSynced(this.basePath);
      const result = await fn();
      return extractBody(result) as T;
    } catch (err) {
      throw normalizeError(err, method, path, requestBody);
    }
  }

  async createOrder(body: any): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.createFuturesOrder(this.settle, body, {}),
      'POST', `/api/v4/futures/${this.settle}/orders`, body,
    );
  }

  async amendOrder(orderId: string, body: any): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.amendFuturesOrder(this.settle, orderId, body, {}),
      'PUT', `/api/v4/futures/${this.settle}/orders/${orderId}`, body,
    );
  }

  async cancelOrder(orderId: string, _contract: string): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.cancelFuturesOrder(this.settle, orderId, {}),
      'DELETE', `/api/v4/futures/${this.settle}/orders/${orderId}`,
    );
  }

  async getOrder(_contract: string, orderId: string): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.getFuturesOrder(this.settle, orderId),
      'GET', `/api/v4/futures/${this.settle}/orders/${orderId}`,
    );
  }

  async listOrders(options: { contract?: string; status: 'open' | 'finished'; limit?: number }): Promise<any[]> {
    const opts: any = {};
    if (options.contract) opts.contract = options.contract;
    if (options.limit) opts.limit = options.limit;
    return this.withRetry<any>(
      () => this.futuresApi.listFuturesOrders(this.settle, options.status, opts),
      'GET', `/api/v4/futures/${this.settle}/orders`,
    );
  }

  async createPriceOrder(body: any): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.createPriceTriggeredOrder(this.settle, body),
      'POST', `/api/v4/futures/${this.settle}/price_orders`, body,
    );
  }

  async cancelPriceOrder(orderId: string): Promise<any> {
    return this.withRetry(
      // SDK 7.2.100 将签名改为 number，但内部用 String(orderId) 拼 URL；
      // 保持 string 传递（价格触发单 ID 可能超过 Number 安全整数），as any 兼容类型。
      () => this.futuresApi.cancelPriceTriggeredOrder(this.settle, orderId as any),
      'DELETE', `/api/v4/futures/${this.settle}/price_orders/${orderId}`,
    );
  }

  async cancelAllPriceOrders(contract: string): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.cancelPriceTriggeredOrderList(this.settle, { contract }),
      'DELETE', `/api/v4/futures/${this.settle}/price_orders`,
    );
  }

  async listPriceOrders(options: { status: 'open' | 'finished'; contract?: string }): Promise<any[]> {
    const opts: any = {};
    if (options.contract) opts.contract = options.contract;
    return this.withRetry<any>(
      () => this.futuresApi.listPriceTriggeredOrders(this.settle, options.status, opts),
      'GET', `/api/v4/futures/${this.settle}/price_orders`,
    );
  }

  async getAccount(): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.listFuturesAccounts(this.settle),
      'GET', `/api/v4/futures/${this.settle}/accounts`,
    );
  }

  async getPosition(contract: string): Promise<any> {
    return this.withRetry(
      () => this.futuresApi.getPosition(this.settle, contract),
      'GET', `/api/v4/futures/${this.settle}/positions/${contract}`,
    );
  }

  async listPositions(): Promise<any[]> {
    return this.withRetry<any>(
      () => this.futuresApi.listPositions(this.settle, {}),
      'GET', `/api/v4/futures/${this.settle}/positions`,
    );
  }

  async listTrades(contract: string, limit: number): Promise<any[]> {
    return this.withRetry<any>(
      () => this.futuresApi.getMyTrades(this.settle, { contract, limit }),
      'GET', `/api/v4/futures/${this.settle}/my_trades`,
    );
  }

  async listContracts(): Promise<any[]> {
    return this.withRetry<any>(
      () => this.futuresApi.listFuturesContracts(this.settle, {}),
      'GET', `/api/v4/futures/${this.settle}/contracts`,
    );
  }

  async listTickers(contract: string): Promise<any[]> {
    return this.withRetry<any>(
      () => this.futuresApi.listFuturesTickers(this.settle, { contract }),
      'GET', `/api/v4/futures/${this.settle}/tickers`,
    );
  }

  async listCandlesticks(contract: string, interval: string, limit: number): Promise<any[]> {
    return this.withRetry<any>(
      () => this.futuresApi.listFuturesCandlesticks(this.settle, contract, { interval: interval as any, limit }),
      'GET', `/api/v4/futures/${this.settle}/candlesticks`,
    );
  }

  async updateLeverage(contract: string, leverage: string, mode?: 'cross' | 'single'): Promise<any> {
    const opts: any = {};
    if (mode) {
      opts.mode = mode;
    }
    return this.withRetry(
      () => this.futuresApi.updatePositionLeverage(this.settle, contract, leverage, opts),
      'POST', `/api/v4/futures/${this.settle}/positions/${contract}/leverage`,
    );
  }
}
