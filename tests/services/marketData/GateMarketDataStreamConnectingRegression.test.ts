/**
 * 回归测试：ws 处于 CONNECTING（连接尚未建立）时调用 stop()/disconnectWS()
 * 不得导致进程崩溃。
 *
 * 背景：ws 库在 CONNECTING 状态下 terminate() 会触发 abortHandshake()，
 * 它通过 process.nextTick 异步 emit 'error'；若清理路径先 removeAllListeners()
 * 再 terminate()，实例上已无 'error' 监听器，Node 会抛 unhandled 'error' event
 * 直接崩溃进程（曾发生于实例注册后立刻注销的时序）。
 *
 * 本测试用真实 ws 库（不 mock），本地 HTTP server 故意不完成握手，
 * 让客户端停留在 CONNECTING，随后立即 stop()，验证进程不崩、stop 正常完成。
 */
import http from 'http';
import { AddressInfo } from 'net';
import { Duplex } from 'stream';
import { GateMarketDataStream } from '../../../src/services/marketData/GateMarketDataStream';

describe('GateMarketDataStream — stop() while WS is CONNECTING (regression)', () => {
  it('does not crash the process when stop() is called before connection is established', async () => {
    // 原始 HTTP server：收到 upgrade 请求后故意不发送 101 握手响应，
    // 使客户端 ws 停留在 CONNECTING 状态。
    const server = http.createServer();
    const sockets = new Set<Duplex>();
    server.on('upgrade', (_req, socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const stream = new GateMarketDataStream('TON_USDT', {
      fetchTicker: jest.fn(),
      useWebSocket: true,
      wsUrl: `ws://127.0.0.1:${port}`,
    });

    try {
      await stream.start(jest.fn());

      // 此时 ws 必然处于 CONNECTING（server 未响应握手）
      // 修复前：removeAllListeners + terminate → nextTick emit('error') 无监听 → 进程崩溃
      // 修复后：安全关闭，正常 resolve
      await expect(stream.stop()).resolves.toBeUndefined();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
