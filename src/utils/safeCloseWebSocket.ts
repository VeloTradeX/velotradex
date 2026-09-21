import WebSocket from 'ws';
import logger, { formatError } from './logger';

/**
 * 安全关闭 WebSocket，且保证清理逻辑绝不向外抛错/触发进程崩溃。
 *
 * 背景：ws 库在 readyState === CONNECTING（连接尚未建立）时调用
 * terminate()/close() 会进入 abortHandshake()，它通过 process.nextTick
 * 异步 emit 'error' 事件。若此时实例上已无任何 'error' 监听器（典型场景：
 * 先 removeAllListeners() 再 terminate() 的清理路径，如行情流 stop()/
 * disconnectWS()、交易所 WS 的 disconnect()），Node 会以
 * "Unhandled 'error' event" 直接崩溃整个进程。
 *
 * 处理：
 * 1. 先移除全部监听器，再补挂一个空 'error' 监听兜底，吞掉 abortHandshake
 *    延迟派发的 'error'；
 * 2. 仅对非 CLOSED 状态调用 terminate()（CLOSED 时调用直接 return，无意义）；
 * 3. 整体 try/catch 包裹，异常只记录日志，绝不向上抛出。
 */
export function safeCloseWebSocket(ws: WebSocket | null | undefined): void {
  if (!ws) return;
  try {
    ws.removeAllListeners();
    // abortHandshake 在 CONNECTING/CLOSING 阶段会 nextTick emit('error')，
    // 无监听器会触发 unhandled 'error' event 崩溃，空监听兜底。
    ws.on('error', () => {});
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  } catch (err) {
    logger.warn('Failed to close WebSocket', formatError(err));
  }
}
