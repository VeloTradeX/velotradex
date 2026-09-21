# Admin Web

VeloTradeX 系统后台管理界面。基于 **Vue 3 + TypeScript + Vite + Element Plus + Pinia** 构建。

## 页面功能

1. **用户认证**：登录、退出、Token 刷新、修改密码
2. **仪表盘**：多交易所账户余额概览、活跃路由数、运行状态
3. **策略信号**：按解析器/交易对/时间过滤，查看原始信号与解析结果、关联订单与审计链路
4. **订单管理**：历史订单、开放挂单、触发单、一键撤单
5. **虚拟交易所**：订单、挂单、成交记录（本地撮合闭环）
6. **统计分析**：胜率、盈亏、RR、按路由/按天统计
7. **持仓管理**：当前持仓、浮盈、一键市价平仓
8. **交易所管理**：添加/编辑/启停交易所实例（GateIO / Lighter / Virtual Gate），配置代理、杠杆、API Key
9. **信号路由**：灵活配置「Discord 频道 + 解析器」→「目标交易所 + 风控参数 + 交易对白名单」
10. **AI 解析配置**：配置大模型接口（兼容 OpenAI/DeepSeek 等），设置温度/最大 Token/超时
11. **系统管理（管理员可见）**：用户管理、API 凭证管理、备份恢复、操作审计日志、Webhook 通知、系统日志

## 开发

### 环境要求

Node.js v18+

### 安装依赖 + 启动开发服务器

```bash
cd admin-web
npm install
npm run dev        # 默认 http://localhost:5173
```

Vite Dev Server 会将 `/ct-api/*` 请求代理到后端 `http://localhost:3000`。

### 构建生产版本

```bash
npm run build      # 产出 dist/
```

## 部署

路由模式: Hash（无需 Web 服务器特殊 rewrite 配置）。部署子路径：`/velotradex/`。

1. `npm run build`
2. 将 `dist/` 拷贝到服务器 Web 根目录下的 `velotradex/` 子目录
3. 反向代理 `/ct-api/*` → 后端 `3000` 端口
4. 访问 `http://your-domain/velotradex/`
