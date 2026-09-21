import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface LighterSendTxResult {
  accepted: boolean;
  raw: unknown;
  txHash?: string;
  error?: string;
}

export class LighterRestTxClient {
  private readonly client: AxiosInstance;

  constructor(
    baseURL: string,
    proxy?: string,
    private readonly authTokenProvider?: () => Promise<string>,
  ) {
    this.client = axios.create({
      baseURL,
      timeout: 10000,
      validateStatus: () => true,
      ...(proxy
        ? {
            httpsAgent: new HttpsProxyAgent(proxy),
            proxy: false as const,
          }
        : {}),
    });
  }

  async sendTx(txType: number, txInfo: string): Promise<LighterSendTxResult> {
    const form = new URLSearchParams();
    form.append('tx_type', String(txType));
    form.append('tx_info', txInfo);
    const response = await this.client.post('/api/v1/sendTx', form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const raw = response.data;
    const txHash = this.getTxHash(raw);
    const accepted = response.status >= 200 && response.status < 300 && this.getCode(raw) === 200 && Boolean(txHash);

    if (accepted) {
      return {
        accepted: true,
        raw,
        txHash,
      };
    }

    return {
      accepted: false,
      raw,
      error: this.getErrorMessage(raw) ?? `Lighter sendTx rejected with HTTP ${response.status}`,
    };
  }

  async getNextNonce(accountIndex: number, apiKeyIndex: number): Promise<string> {
    const response = await this.client.get('/api/v1/nextNonce', {
      params: {
        account_index: accountIndex,
        api_key_index: apiKeyIndex,
      },
    });

    const nonce = this.getNonce(response.data);
    if (!nonce) {
      throw new Error('Lighter nextNonce response did not include nonce');
    }

    return nonce;
  }

  async getAccountTx(_accountIndex: number, value: string, by: 'tx_hash' | 'sequence_index' | 'tx_info_hash' = 'tx_hash'): Promise<unknown> {
    try {
      const response = await this.client.get('/api/v1/tx', {
        params: { by, value },
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      if (status && data) return data;
      throw err;
    }
  }

  async getAccountOrders(accountIndex: number): Promise<unknown> {
    const response = await this.client.get('/api/v1/accountActiveOrders', {
      params: {
        account_index: accountIndex,
      },
      ...(await this.authRequestConfig()),
    });

    return response.data;
  }

  async getAccount(accountIndex: number): Promise<unknown> {
    const response = await this.client.get('/api/v1/account', {
      params: {
        by: 'index',
        value: accountIndex,
      },
      ...(await this.authRequestConfig()),
    });

    return response.data;
  }

  async getAccountPositions(accountIndex: number): Promise<unknown> {
    return this.getAccount(accountIndex);
  }

  async getAccountOrderHistory(accountIndex: number, marketIndex: number, limit: number = 100): Promise<unknown> {
    const response = await this.client.get('/api/v1/accountInactiveOrders', {
      params: {
        account_index: accountIndex,
        market_id: marketIndex,
        limit,
      },
      ...(await this.authRequestConfig()),
    });

    return response.data;
  }

  async getAccountTrades(accountIndex: number, marketIndex: number, limit: number = 100): Promise<unknown> {
    const response = await this.client.get('/api/v1/trades', {
      params: {
        account_index: accountIndex,
        market_id: marketIndex,
        limit,
      },
      ...(await this.authRequestConfig()),
    });

    return response.data;
  }

  async getTicker(marketIndex: number): Promise<unknown> {
    const response = await this.client.get('/api/v1/orderBookDetails', {
      params: {
        market_id: marketIndex,
      },
    });

    return response.data;
  }

  async getCandles(
    marketId: number,
    resolution: string,
    countBack: number,
    startTimestamp: number,
    endTimestamp: number,
  ): Promise<unknown> {
    const response = await this.client.get('/api/v1/candles', {
      params: {
        market_id: marketId,
        resolution,
        count_back: countBack,
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
      },
    });

    return response.data;
  }

  private getCode(raw: unknown): number | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const code = (raw as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }

  private getTxHash(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const candidate = raw as { tx_hash?: unknown; txHash?: unknown };
    if (typeof candidate.tx_hash === 'string') {
      return candidate.tx_hash;
    }
    if (typeof candidate.txHash === 'string') {
      return candidate.txHash;
    }
    return undefined;
  }

  private getNonce(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const candidate = raw as { nonce?: unknown; next_nonce?: unknown; nextNonce?: unknown };
    const nonce = candidate.nonce ?? candidate.next_nonce ?? candidate.nextNonce;
    if (typeof nonce === 'string') {
      return nonce;
    }
    if (typeof nonce === 'number' && Number.isSafeInteger(nonce)) {
      return nonce.toString();
    }
    return undefined;
  }

  private getErrorMessage(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const candidate = raw as { message?: unknown; error?: unknown };
    if (typeof candidate.message === 'string') {
      return candidate.message;
    }
    if (typeof candidate.error === 'string') {
      return candidate.error;
    }
    return undefined;
  }

  private async authRequestConfig(): Promise<{ headers: { Authorization: string } } | Record<string, never>> {
    if (!this.authTokenProvider) {
      return {};
    }

    return {
      headers: {
        Authorization: await this.authTokenProvider(),
      },
    };
  }
}
