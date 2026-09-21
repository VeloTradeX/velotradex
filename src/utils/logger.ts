import winston from 'winston';
import path from 'path';
import DailyRotateFile from 'winston-daily-rotate-file';
import { AsyncLocalStorage } from 'async_hooks';
import { Order } from '../models';
import { safeStringify } from './json';

export const logContext = new AsyncLocalStorage<Map<string, any>>();

export interface LogContext {
  traceId?: string;
  strategyId?: number;
  routeId?: number;
  parserName?: string;
  exchangeInstanceId?: number;
  symbol?: string;
  side?: string;
  orderId?: number;
  exchangeOrderId?: string;
}

export function buildLogContextFromOrder(order: Order): LogContext {
  return {
    strategyId: order.strategyId,
    routeId: order.routeId ?? undefined,
    exchangeInstanceId: order.exchangeInstanceId ? Number(order.exchangeInstanceId) : undefined,
    symbol: order.symbol,
    side: order.side,
    orderId: order.id,
    exchangeOrderId: order.exchangeOrderId,
  };
}

// Custom format to inject context from AsyncLocalStorage
const contextFormat = winston.format((info) => {
  const store = logContext.getStore();
  if (store) {
    // Backward compat: support old traceId-only maps
    const traceId = store.get('traceId');
    if (traceId) {
      info.traceId = traceId;
    }
    // New: inject full LogContext
    const ctx = store.get('context') as LogContext | undefined;
    if (ctx) {
      if (ctx.traceId) info.traceId = ctx.traceId;
      if (ctx.strategyId !== undefined) info.strategyId = ctx.strategyId;
      if (ctx.routeId !== undefined) info.routeId = ctx.routeId;
      if (ctx.parserName) info.parserName = ctx.parserName;
      if (ctx.exchangeInstanceId !== undefined) info.exchangeInstanceId = ctx.exchangeInstanceId;
      if (ctx.symbol) info.symbol = ctx.symbol;
      if (ctx.side) info.side = ctx.side;
      if (ctx.orderId !== undefined) info.orderId = ctx.orderId;
      if (ctx.exchangeOrderId) info.exchangeOrderId = ctx.exchangeOrderId;
    }
  }
  return info;
});

const logFormat = winston.format.combine(
  contextFormat(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  contextFormat(),
  winston.format.printf(({ timestamp, level, message, traceId, strategyId, routeId, parserName, ...meta }) => {
    const msg = typeof message === 'object' ? JSON.stringify(message) : message;
    const ctxParts = [traceId && `[${traceId}]`, strategyId && `[S${strategyId}]`, routeId && `[R${routeId}]`].filter(Boolean).join(' ');
    return `${timestamp} ${ctxParts}[${level}]: ${msg} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {},
  transports: [
    new DailyRotateFile({
      filename: path.join('logs', 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '50m',
      maxFiles: '7d',
    }),
    new DailyRotateFile({
      filename: path.join('logs', 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '7d',
    }),
  ],
});

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
  }));
}

// Sensitive field keywords to redact from logs (matched case-insensitively against object keys)
const sensitiveFieldKeywords = ['password', 'apiSecret', 'apiKey', 'secret', 'token', 'privateKey'];

/**
 * Recursively redact sensitive field values (matched by key name) with '******'.
 * Returns a new structure and does not mutate the input.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value && typeof value === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, val] of Object.entries(value as Record<string, any>)) {
      if (sensitiveFieldKeywords.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
        redacted[key] = '******';
      } else {
        redacted[key] = redactSensitive(val);
      }
    }
    return redacted;
  }
  return value;
}

export function formatError(err: unknown, businessCtx?: Record<string, any>): Record<string, any> {
  if (err instanceof Error) {
    const result: Record<string, any> = {
      errorMessage: err.message,
      errorName: err.name,
      errorStack: err.stack,
    };

    // Gate SDK / axios HTTP 错误：提取请求/响应详情
    const axiosErr = err as any;
    if (axiosErr.config?.url) {
      result.httpRequest = {
        method: axiosErr.config.method,
        url: axiosErr.config.url,
        requestBody: safeStringify(redactSensitive(axiosErr.config.data), 1000),
      };
    }
    if (axiosErr.response) {
      result.httpResponse = {
        status: axiosErr.response.status,
        statusText: axiosErr.response.statusText,
        responseBody: safeStringify(axiosErr.response.data, 1000),
      };
    }

    if (businessCtx) {
      Object.assign(result, businessCtx);
    }
    return result;
  }

  return { error: String(err), ...businessCtx };
}

export default logger;
