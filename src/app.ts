import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import fs from 'fs';
import path from 'path';
import logger from './utils/logger';
import redisService from './services/RedisService';
import config from './config';
import router from './routes';
import { initializeServices } from './serviceStartup';
import { handleChannelMessage } from './channelMessageHandler';
import systemStatusService from './services/SystemStatusService';

const app = new Koa();
app.proxy = true;

// Global error middleware
app.use(async (ctx, next) => {
    try {
        await next();
    } catch (err) {
        logger.error('Unhandled error in middleware', { error: err, path: ctx.path, method: ctx.method });

        const httpError = err as { status?: number; statusCode?: number; message?: string };
        let status = httpError.status || httpError.statusCode || 500;

        // 关键修复：只有内部 token 验证中间件（authMiddleware）明确返回的 401 才保留
        // 其他任何来源的 401（如上游交易所 API 返回的 401）都转换为 503，
        // 避免前端误判为内部 token 失效而触发重新登录
        if (status === 401) {
            status = 503;
        }

        ctx.status = status;

        if (status >= 400 && status < 500) {
            ctx.body = { error: httpError.message };
        } else {
            ctx.body = { error: httpError.message || 'Internal Server Error' };
        }
    }
});

// Emit errors for uncaught Koa app errors
app.on('error', (err) => {
    logger.error('Uncaught Koa app error', { error: err });
});

// Middleware
app.use(bodyParser());

// ---------------------------------------------------------------------------
// 一体化部署（Docker 镜像的默认形态）：后端与管理面板跑在同一进程/端口上。
// 前端 admin-web 固定以 /ct-api 作为 API 前缀（见 admin-web/src/utils/request.ts），
// 常规部署靠 Nginx 把 /ct-api 重写为 /api；镜像内没有 Nginx，这里做等价别名，
// 让 http://<host>:3000/velotradex/ 开箱即用。已有反向代理的部署不受影响。
// ---------------------------------------------------------------------------
const WEB_APP_BASE = '/velotradex';
const webAppIndex = path.join(__dirname, 'public', 'velotradex', 'index.html');
const hasWebApp = fs.existsSync(webAppIndex);

app.use(async (ctx, next) => {
    if (ctx.path === '/ct-api' || ctx.path.startsWith('/ct-api/')) {
        ctx.path = `/api${ctx.path.slice('/ct-api'.length)}`;
    } else if (hasWebApp && ctx.path === '/') {
        // 浏览器访问根路径时直接跳转到管理面板
        ctx.redirect(`${WEB_APP_BASE}/`);
        return;
    }
    await next();
});

app.use(serve(path.join(__dirname, 'public')));
app.use(router.routes()).use(router.allowedMethods());

const start = async () => {
  // 先启动 HTTP 服务，再后台初始化业务服务。
  // 这样即使 Redis / 交易所暂时不可用，其他 API（订单、策略、配置等）也能正常响应，
  // 不会因为初始化阻塞导致整个前端都无法请求到数据。
  const PORT = config.server.port;
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });

  logger.info(`Trading mode: ${config.trading.mode} (enableTrading: ${config.enableTrading})`);

  // Subscribe to Redis（立即订阅：Redis 不可用时 ioredis 会排队，恢复连接后自动重连订阅）
  redisService.subscribe(config.redis.msgChannel, handleChannelMessage);

  // 启动系统状态聚合服务（独立于业务初始化，任何时候都可被 /api/status 读取）
  systemStatusService.start();

  // 后台初始化：失败不退出进程，仅记录日志；SystemStatusService 会暴露各组件状态供前端展示。
  void initializeServices()
    .then(() => {
      logger.info('Background service initialization completed');
      // 初始化完成后立即刷新一次状态，避免首页在启动初期显示不准确的组件状态
      void systemStatusService.refreshNow();
    })
    .catch((error) => {
      logger.error('Background service initialization failed (server keeps running)', { error });
      logger.warn('部分功能（消息接收/下单执行）暂不可用，请检查 Redis 与数据库配置；其他 API 不受影响');
    });
};

start();
