import axios from 'axios';

/**
 * GateIO 服务器时间同步（进程级单例）。
 *
 * 签名（REST + WS）都依赖与 Gate 服务器一致的 Unix 时间戳。若本机时钟偏差过大
 * （例如快照恢复、休眠唤醒、手工改时），会得到 Gate 的 REQUEST_EXPIRED /
 * "Timestamp too first or expired"。本模块通过一个公开接口的响应 Date 头估算
 * 服务器时间（RTT 折半），把偏移量缓存起来供签名使用。
 */

const TTL_MS = 60_000; // 缓存 60s，重启同步也不廉
const SYNC_TIMEOUT_MS = 6_000;

let offsetMs = 0;
let lastSyncAt = 0;
let inflight: Promise<number> | null = null;

/** 当前估算的本地到服务器的时间偏移（ms，本地 + offset = 服务器时间） */
export function getTimeOffsetMs(): number {
  return offsetMs;
}

/** 换算后的服务器当前时间（ms） */
export function nowMs(): number {
  return Date.now() + offsetMs;
}

/** 换算后的服务器当前时间（秒，整数，WS 握手用） */
export function nowSec(): number {
  return Math.floor(nowMs() / 1000);
}

/**
 * 确保时间已同步（TTL 内直接返回缓存偏移）。
 * @param baseURL REST API 前缀，如 https://api-testnet.gateapi.io/api/v4
 */
export function ensureTimeSynced(baseURL: string): Promise<number> {
  if (inflight) {
    return inflight;
  }
  if (offsetMs !== 0 && Date.now() - lastSyncAt < TTL_MS) {
    return Promise.resolve(offsetMs);
  }
  inflight = syncFromHttp(baseURL)
    .catch(() => offsetMs) // 同步失败时沿用旧偏移（最坏情况只是签名再次失败）
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function syncFromHttp(baseURL: string): Promise<number> {
  const probeUrls = [
    `${baseURL}/futures/usdt/tickers?contract=BTC_USDT`,
    `${baseURL}/spot/currency_pairs`,
  ];
  let lastStatus = 0;
  for (const url of probeUrls) {
    try {
      const t0 = Date.now();
      const resp = await axios.get(url, {
        timeout: SYNC_TIMEOUT_MS,
        validateStatus: () => true, // 4xx/5xx 也带 Date 头，可作对时来源
        transformResponse: [(d) => d],
      });
      const t1 = Date.now();
      lastStatus = resp.status;
      const dateHeader = resp.headers?.['date'];
      const serverMs = Number.isFinite(dateHeader) ? Number(dateHeader) : Date.parse(String(dateHeader || ''));
      if (Number.isFinite(serverMs)) {
        const estServerNow = serverMs + (t1 - t0) / 2; // RTT 折半
        offsetMs = estServerNow - t1;
        lastSyncAt = Date.now();
        if (Math.abs(offsetMs) > 1_000) {
          // eslint-disable-next-line no-console
          console.warn(
            `[GateTimeSync] ${url.split('/api/v4')[0]} 时间偏差 ${Math.round(offsetMs / 1000)}s，` +
            `已应用偏移校准（服务端 HTTP ${lastStatus}）`
          );
        }
        return offsetMs;
      }
    } catch {
      // try next probe url
    }
  }
  return offsetMs;
}