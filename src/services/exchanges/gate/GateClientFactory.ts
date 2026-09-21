/**
 * Gate 交易所 REST 客户端共享工厂
 *
 * 从 GateIORestClient.ts 提取的横切能力（axios 实例 + HTTPS 代理 + API 签名注入 +
 * 错误规范化），供加密合约（gate/）与 CFD（gate_cfd/）两个 RestClient 共用，
 * 避免重复实现。架构见 内部设计文档 §2.1。
 */
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as GateApi from 'gate-api';

/** 与 GateIORestClient.ts 顶部 GateRestError 定义保持一致 */
export interface GateRestError extends Error {
  status?: number;
  label?: string;
  method?: string;
  path?: string;
  requestBody?: any;
  responseBody?: any;
  raw?: any;
}

export const GATE_MAINNET_BASE = 'https://api.gateio.ws/api/v4';
export const GATE_TESTNET_BASE = 'https://api-testnet.gateio.ws/api/v4';

export interface CreateGateApiClientConfig {
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  proxy?: string;
  isTestnet?: boolean;
}

/**
 * 错误规范化：把 SDK/axios 异常转为带 status/label/method/path/requestBody
 * 上下文的 GateRestError，便于上层审计与告警定位具体 REST 调用。
 */
export function normalizeError(err: any, method: string, path: string, requestBody?: any): GateRestError {
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

/** 拆掉 gate-api SDK 的 { response, body } 外壳，返回业务数据本体 */
export function extractBody(sdkResponse: any): any {
  if (sdkResponse && typeof sdkResponse === 'object' && 'body' in sdkResponse) {
    return sdkResponse.body;
  }
  return sdkResponse;
}

/**
 * 统一异常包装 + 拆包：
 * - fn 内抛错 → normalizeError 补全请求上下文后重新抛出
 * - 成功 → extractBody 去掉 SDK 外壳，返回业务数据
 */
export async function withRetry<T>(fn: () => Promise<T>, method: string, path: string, requestBody?: any): Promise<T> {
  try {
    const result = await fn();
    return extractBody(result) as T;
  } catch (err) {
    throw normalizeError(err, method, path, requestBody);
  }
}

/**
 * 创建共享的 gate-api ApiClient：
 * - axios 实例：10s 超时；配置了代理时用 HttpsProxyAgent 并禁用 axios 内置 proxy
 * - basePath：显式 baseURL 优先，否则按 isTestnet 走测试网/主网默认地址
 * - 签名：apiKey/apiSecret 存在时注入（setApiKeySecret）
 */
export function createGateApiClient(cfg: CreateGateApiClientConfig): {
  apiClient: InstanceType<typeof GateApi.ApiClient>;
  basePath: string;
} {
  const axiosConfig: any = { timeout: 10000 };
  if (cfg.proxy) {
    axiosConfig.httpsAgent = new HttpsProxyAgent(cfg.proxy);
    axiosConfig.proxy = false;
  }
  const axiosInstance = axios.create(axiosConfig);

  const basePath = cfg.baseURL || (cfg.isTestnet ? GATE_TESTNET_BASE : GATE_MAINNET_BASE);

  const apiClient = new GateApi.ApiClient(undefined, axiosInstance);
  apiClient.basePath = basePath;

  const apiKey = cfg.apiKey?.trim();
  const apiSecret = cfg.apiSecret?.trim();
  if (apiKey || apiSecret) {
    // ?? '' 兜底：仅 key/secret 单边配置时也保持类型安全（strict 模式）
    apiClient.setApiKeySecret(apiKey ?? '', apiSecret ?? '');
  }

  return { apiClient, basePath };
}
