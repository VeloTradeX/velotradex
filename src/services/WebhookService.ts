import axios from 'axios';
import { WebhookConfig } from '../models';
import appConfig from '../config';
import logger, { formatError } from '../utils/logger';
import { assertSafeFetchUrl, sanitizeCustomHeaders } from '../utils/ssrfProtection';

interface WebhookPayload {
  event: string;
  timestamp: number;
  data: any;
}

class WebhookService {
  private configs: WebhookConfig[] = [];

  constructor() {
    this.reloadConfigs();
  }

  public async reloadConfigs() {
    try {
      this.configs = await WebhookConfig.findAll({ where: { isActive: true } });
      logger.info(`WebhookService loaded ${this.configs.length} configs.`);
    } catch (error) {
      logger.error('Failed to load webhook configs', { error });
    }
  }

  public async dispatch(event: string, data: any) {
    const timestamp = Date.now();
    const payload: WebhookPayload = {
      event,
      timestamp,
      data
    };

    // Filter configs that subscribe to this event
    const targets = this.configs.filter(config => {
      try {
        const events = typeof config.events === 'string' ? JSON.parse(config.events) : config.events;
        return Array.isArray(events) && (events.includes(event) || events.includes('*'));
      } catch (e) {
        return false;
      }
    });

    if (targets.length === 0) return;

    logger.info(`Dispatching event ${event} to ${targets.length} targets`);

    // Send in parallel
    await Promise.all(targets.map(async (config) => {
      try {
        const type = config.type || 'webhook';

        if (type === 'webhook') {
            await this.sendGenericWebhook(config, payload);
        } else if (type === 'feishu') {
            await this.sendFeishu(config, payload);
        } else if (type === 'dingtalk') {
            await this.sendDingTalk(config, payload);
        } else if (type === 'pushover') {
            await this.sendPushover(config, payload);
        }
        
        logger.debug(`${type} sent to ${config.name}`);
      } catch (error: any) {
        logger.warn(`Failed to send ${config.type} to ${config.name}`, formatError(error));
      }
    }));
  }

  private renderTemplate(template: string, data: any): string {
      // Simple regex replace for ${key}
      // Support dot notation like ${details.price}
      // We first flatten the object or just use a recursive lookup
      return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (match, path) => {
          const keys = path.split('.');
          let value = data;
          for (const key of keys) {
              if (Object.prototype.hasOwnProperty.call(value, key)) {
                  value = value[key];
              } else {
                  return match; // Keep original if not found
              }
          }
          // Convert objects to string if necessary, but usually it's primitive
          if (typeof value === 'object') return JSON.stringify(value);
          return String(value);
      });
  }

  private pick(...values: any[]) {
    return values.find(v => v !== undefined && v !== null && v !== '');
  }

  private show(value: any, fallback = '-') {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  private extractNotifyMeta(data: any, details: any): { parser?: string; symbol?: string } {
    const parser = this.pick(
      data?.parser,
      details?.parser,
      details?.parserName
    );

    const symbol = this.pick(
      data?.symbol,
      details?.symbol,
      details?.parsed?.symbol,
      data?.parsed?.symbol,
      details?.strategy?.symbol
    );

    return {
      parser: parser || undefined,
      symbol: symbol || undefined
    };
  }

  private getHumanReadableMessage(payload: WebhookPayload): string {
      const { event, data, timestamp } = payload;
      const timeStr = new Date(timestamp).toLocaleString();
      const details = data?.details && typeof data.details === 'object' ? data.details : data;
      const meta = this.extractNotifyMeta(data, details);
      let title = `[CopyTrader] ${event}`;
      let body = '';

      switch (event) {
          case 'ORDER_INIT':
              title = '🆕 订单初始化';
              {
                  const leverage = this.pick(details.leverage, data.leverage);
                  body = `${this.show(this.pick(details.symbol, data.symbol))} ${this.show(this.pick(details.side, data.side))} ${this.show(this.pick(details.type, data.type))}\n价格: ${this.show(this.pick(details.price, data.price), 'Market')}\n数量: ${this.show(this.pick(details.size, data.size, details.amount, data.amount))}\n杠杆: ${leverage !== undefined && leverage !== null && leverage !== '' ? `${leverage}x` : '-'}`;
              }
              break;
          case 'ORDER_CREATED':
              title = '✅ 挂单成功';
              body = `${this.show(this.pick(details.symbol, data.symbol))} ${this.show(this.pick(details.side, data.side))}\nID: ${this.show(this.pick(details.exchangeOrderId, data.exchangeOrderId, details.orderId, data.orderId))}\n价格: ${this.show(this.pick(details.price, data.price))}\n数量: ${this.show(this.pick(details.amount, data.amount, details.size, data.size))}`;
              break;
          case 'ORDER_FILLED_WS':
          case 'ORDER_FILLED_RECOVERY':
              title = '🚀 订单成交';
              body = `${this.show(this.pick(details.symbol, data.symbol))} ${this.show(this.pick(details.side, data.side))}\n成交均价: ${this.show(this.pick(details.filledPrice, data.filledPrice, details.price, data.price))}\n成交数量: ${this.show(this.pick(details.filledAmount, data.filledAmount, details.amount, data.amount, details.size, data.size))}`;
              break;
          case 'ORDER_FAILED':
              title = '❌ 下单失败';
              body = `错误: ${this.show(this.pick(details.error, data.error), '未知错误')}`;
              break;
          case 'TP_ORDER_PLACED':
              title = '🎯 放置止盈';
              body = `TP-${this.show(this.pick(details.index, data.index), '?')} @ ${this.show(this.pick(details.price, data.price), '?')} (Qty: ${this.show(this.pick(details.amount, data.amount, details.qty, data.qty, details.size, data.size), '?')})`;
              break;
          case 'ORDER_CLOSED_BY_TRIGGER':
              title = '⚡️ 触发平仓';
              body = `触发价: ${this.show(this.pick(details.closePrice, data.closePrice), '?')}\n类型: ${this.show(this.pick(details.text, data.text), 'SL/TP')}`;
              break;
          case 'ORDER_CLOSED_POSITION':
              title = '🏁 主动平仓';
              body = `${this.show(this.pick(details.symbol, data.symbol))} ${this.show(this.pick(details.side, data.side))}`;
              break;
          case 'STRATEGY_DETECTED':
              title = '📡 发现信号';
              body = `${this.show(this.pick(details.parsed?.symbol, data.parsed?.symbol), '?')} ${this.show(this.pick(details.parsed?.action, data.parsed?.action), '?')}\nParser: ${this.show(this.pick(details.parser, data.parser), '?')}`;
              break;
          case 'PARSER_ERROR':
              title = '⚠️ 解析错误';
              body = `Parser: ${this.show(this.pick(details.parser, data.parser), '?')}\nError: ${this.show(this.pick(details.error, data.error), '未知错误')}`;
              break;
          default:
              body = JSON.stringify(details, null, 2);
      }

      const metaLines = [
        `解析器: ${this.show(meta.parser, '?')}`,
        `币种: ${this.show(meta.symbol, '?')}`
      ];

      return `${title}\n${timeStr}\n${metaLines.join('\n')}\n\n${body}`;
  }

  private async sendGenericWebhook(config: WebhookConfig, payload: WebhookPayload) {
    const customHeaders = typeof config.headers === 'string' ? JSON.parse(config.headers) : config.headers;
    const headers: any = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': payload.event,
      'X-Webhook-Timestamp': payload.timestamp.toString(),
      ...customHeaders
    };

    let bodyData: any = payload;

    // Apply Template if exists
    if (config.template && config.template.trim()) {
        try {
            // Flatten payload for easier access
            // payload structure: { event, timestamp, data: { ... } }
            // Users might want ${data.symbol} or just ${symbol} if we flatten data?
            // Let's keep structure but provide a flattened view or just support ${data.symbol}
            // User requirement: "${orderid}". In audit log, we have `orderId` in `data`.
            // So they likely want `${data.orderId}` or `${orderId}`.
            // Let's create a context object that merges payload and payload.data
            const context = {
                ...payload,
                ...payload.data, // Flatten data to top level
                parser: payload.data?.parser || payload.data?.details?.parser || payload.data?.details?.parserName,
                symbol: payload.data?.symbol || payload.data?.details?.symbol || payload.data?.details?.parsed?.symbol,
                // Also keep data as data
            };
            
            const renderedBody = this.renderTemplate(config.template, context);
            
            // Try to parse as JSON if it looks like JSON, otherwise send as string/text
            try {
                bodyData = JSON.parse(renderedBody);
            } catch (e) {
                // Not JSON, send as is (maybe text/plain or inside a wrapper?)
                // If content-type is application/json, we should wrap it?
                // Or user is responsible for valid JSON in template?
                // Let's assume user provides a JSON template string.
                // If parsing fails, maybe it's just a text body.
                // But axios 'data' expects object for JSON.
                // If we send string, axios sets content-type to urlencoded?
                // Let's just send the object if parsed, or raw string if not.
                bodyData = renderedBody;
            }
        } catch (e: any) {
            logger.warn(`Template render failed for ${config.name}`, formatError(e));
        }
    }

    await assertSafeFetchUrl(config.url);
    const safeHeaders = sanitizeCustomHeaders(headers);

    await axios({
        method: config.method || 'POST',
        url: config.url,
        data: bodyData,
        headers: safeHeaders,
        timeout: 5000
    });
  }

  private async sendFeishu(config: WebhookConfig, payload: WebhookPayload) {
      // Feishu/Lark Webhook format
      // { "msg_type": "text", "content": { "text": "text content" } }
      // Or card
      const text = this.getHumanReadableMessage(payload);

      await assertSafeFetchUrl(config.url);
      await axios.post(config.url, {
          msg_type: 'text',
          content: {
              text: text
          }
      }, { timeout: 5000 });
  }

  private async sendDingTalk(config: WebhookConfig, payload: WebhookPayload) {
      // DingTalk Webhook format
      // { "msgtype": "text", "text": { "content": "content" } }
      const text = this.getHumanReadableMessage(payload);

      await assertSafeFetchUrl(config.url);
      await axios.post(config.url, {
          msgtype: 'text',
          text: {
              content: text
          }
      }, { timeout: 5000 });
  }

  private async sendPushover(config: WebhookConfig, payload: WebhookPayload) {
      // Pushover API
      
      const extraConfig = typeof config.config === 'string' ? JSON.parse(config.config) : config.config;
      const userKey = extraConfig.userKey; // From config
      const token = extraConfig.token; // From config? Or maybe config.url is just 'https://api.pushover.net/1/messages.json'?
      
      // Usually for pushover, user might provide token/userKey in config
      // URL might be fixed or provided. Let's assume URL is the API endpoint if provided, or default.
      const url = config.url || appConfig.external.urls.pushoverApi;
      
      if (!userKey || !token) {
          throw new Error('Pushover requires userKey and token in config');
      }

      const text = this.getHumanReadableMessage(payload);
      // Pushover supports title and message
      // Extract title from first line of text
      const lines = text.split('\n');
      const title = lines[0];
      const message = lines.slice(1).join('\n').trim();

      await assertSafeFetchUrl(url);
      await axios.post(url, {
          token: token,
          user: userKey,
          message: message,
          title: title,
          timestamp: Math.floor(payload.timestamp / 1000)
      }, { timeout: 5000 });
  }
}

export default new WebhookService();
