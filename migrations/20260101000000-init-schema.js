'use strict';

/**
 * 初始 schema（基线迁移）。
 *
 * 背景：本仓库长期依赖“已有数据库”迭代，基础表从未有迁移文件覆盖，
 * 导致全新环境执行 `sequelize-cli db:migrate` 会在
 * `20260821000100-add-signal-origin-to-strategies` 处报
 * `no such table: strategies`，空库完全无法启动。
 *
 * 本迁移补齐全部基础表，且刻意**不包含**后续迁移负责的部分：
 *   - 表：cfd_leg_groups / cfd_legs / exchange_connection_logs / backtest_runs
 *   - 列：strategies.signalOrigin / orders.fees / orders.mathMultiplier
 * 它们由 20260820000100 / 20260821000100 / 20260823000100 /
 * 20260824000100 / 20260901000100 负责，保证历史迁移链在空库上依然成立。
 *
 * 全部语句使用 IF NOT EXISTS，因此在“表已存在但缺少迁移记录”的旧库上
 * 重复执行是安全的（no-op）。
 *
 * 该文件由 scripts/generate-init-migration.py 生成，请勿手工调整语句顺序。
 */

const TABLES = [
  "users",
  "exchange_instances",
  "strategies",
  "strategy_positions",
  "orders",
  "parser_configs",
  "signal_routes",
  "pending_protections",
  "soft_stop_losses",
  "audit_logs",
  "api_audit_logs",
  "api_credentials",
  "ai_configs",
  "ai_logs",
  "webhook_configs",
  "image_download_caches",
  "idempotency_keys",
  "market_data_sources",
  "lighter_tx_journals",
  "lighter_client_order_indexes",
  "virtual_accounts",
  "virtual_positions",
  "virtual_orders",
  "virtual_trades"
];

const STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS `users` (`id` INTEGER PRIMARY KEY, `username` VARCHAR(255) NOT NULL UNIQUE, `password` VARCHAR(255) NOT NULL, `role` VARCHAR(255) DEFAULT 'admin', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `exchange_instances` (`id` VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY, `type` VARCHAR(255) NOT NULL, `name` VARCHAR(255) NOT NULL, `config` TEXT NOT NULL DEFAULT '{}', `status` VARCHAR(255) DEFAULT 'active', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `strategies` (`id` INTEGER PRIMARY KEY, `rawMessage` TEXT, `action` VARCHAR(255) DEFAULT 'open', `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255), `source` VARCHAR(255), `parserName` VARCHAR(255), `entryPrice` VARCHAR(255), `targets` TEXT, `stopLoss` VARCHAR(255), `status` VARCHAR(255) DEFAULT 'pending', `routes` TEXT, `aiAnalysis` TEXT, `riskMultiplier` FLOAT NOT NULL DEFAULT '1', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, `leverage` VARCHAR(255) DEFAULT '20')",
  "CREATE TABLE IF NOT EXISTS `strategy_positions` (`id` INTEGER PRIMARY KEY, `strategyId` INTEGER REFERENCES `strategies` (`id`), `orderId` INTEGER REFERENCES `orders` (`id`), `routeId` INTEGER, `exchangeInstanceId` VARCHAR(255), `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255) NOT NULL, `totalSize` VARCHAR(255) NOT NULL, `remainingSize` VARCHAR(255) NOT NULL, `source` VARCHAR(255), `parserName` VARCHAR(255), `status` VARCHAR(255) NOT NULL DEFAULT 'OPEN', `closedAt` DATETIME, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `orders` (`id` INTEGER PRIMARY KEY, `strategyId` INTEGER REFERENCES `strategies` (`id`), `routeId` INTEGER, `exchangeOrderId` VARCHAR(255), `exchangeInstanceId` VARCHAR(255), `source` VARCHAR(255), `exchange` VARCHAR(255), `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255) NOT NULL, `amount` VARCHAR(255) NOT NULL, `price` VARCHAR(255), `filledAmount` VARCHAR(255), `filledPrice` VARCHAR(255), `status` VARCHAR(255) DEFAULT 'new', `lifecycleStatus` VARCHAR(255) DEFAULT 'INIT', `relatedMessages` TEXT DEFAULT '[]', `initialSl` VARCHAR(255), `initialTp` VARCHAR(255), `currentSl` VARCHAR(255), `currentTp` VARCHAR(255), `type` VARCHAR(255), `leverage` VARCHAR(255), `isSimulated` TINYINT(1) DEFAULT 0, `realizedPnl` VARCHAR(255), `exitPrice` VARCHAR(255), `closedAt` DATETIME, `response` TEXT, `activeStopLossId` VARCHAR(255), `activeTpIds` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, `closePrice` VARCHAR(255), `lastPrice` VARCHAR(255))",
  "CREATE TABLE IF NOT EXISTS `parser_configs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `parserName` VARCHAR(255) NOT NULL UNIQUE, `config` TEXT DEFAULT '{}', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `signal_routes` (`id` INTEGER PRIMARY KEY, `name` VARCHAR(255) NOT NULL, `channelId` VARCHAR(255) NOT NULL, `exchangeInstanceId` VARCHAR(255) NOT NULL, `parser` VARCHAR(255) DEFAULT 'TheLabKenParser', `riskSettings` TEXT DEFAULT '{}', `symbolSpecificSettings` TEXT DEFAULT '{}', `supportedSymbols` TEXT DEFAULT NULL, `isActive` TINYINT(1) DEFAULT 1, `aiMode` VARCHAR(255) NOT NULL DEFAULT 'disabled', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `pending_protections` (`orderId` VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY, `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255) NOT NULL, `stopLoss` VARCHAR(255), `takeProfit` VARCHAR(255), `status` VARCHAR(255) NOT NULL DEFAULT 'PENDING', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, `tpOrdersJson` TEXT)",
  "CREATE TABLE IF NOT EXISTS `soft_stop_losses` (`id` INTEGER PRIMARY KEY, `parserName` VARCHAR(255) NOT NULL, `source` VARCHAR(255), `strategyId` INTEGER REFERENCES `strategies` (`id`), `orderId` INTEGER REFERENCES `orders` (`id`), `positionId` INTEGER REFERENCES `strategy_positions` (`id`), `exchangeInstanceId` VARCHAR(255), `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255) NOT NULL, `timeframe` VARCHAR(255) NOT NULL, `direction` VARCHAR(255) NOT NULL, `price` VARCHAR(255) NOT NULL, `sourceText` TEXT, `status` VARCHAR(255) NOT NULL DEFAULT 'ACTIVE', `triggeredAt` DATETIME, `triggerClosePrice` VARCHAR(255), `raw` TEXT, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `audit_logs` (`id` INTEGER PRIMARY KEY, `strategyId` INTEGER NOT NULL, `orderId` INTEGER, `action` VARCHAR(255) NOT NULL, `exchangeInstanceId` VARCHAR(255), `routeId` INTEGER, `lifecycleStatus` VARCHAR(255), `details` TEXT, `createdAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `api_audit_logs` (`id` INTEGER PRIMARY KEY, `userId` INTEGER, `username` VARCHAR(255), `method` VARCHAR(255) NOT NULL, `path` VARCHAR(255) NOT NULL, `params` TEXT, `statusCode` INTEGER NOT NULL, `ip` VARCHAR(255), `duration` INTEGER, `createdAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `api_credentials` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255) NOT NULL, `tokenPrefix` VARCHAR(255) NOT NULL UNIQUE, `tokenHash` VARCHAR(255) NOT NULL UNIQUE, `scopes` TEXT NOT NULL DEFAULT '[]', `expiresAt` DATETIME, `lastUsedAt` DATETIME, `disabledAt` DATETIME, `createdByUserId` INTEGER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `ai_configs` (`id` INTEGER PRIMARY KEY, `provider` VARCHAR(255) NOT NULL DEFAULT 'openai', `apiKey` VARCHAR(255) NOT NULL, `baseUrl` VARCHAR(255), `textModel` VARCHAR(255) NOT NULL DEFAULT 'gpt-4o', `visionModel` VARCHAR(255) NOT NULL DEFAULT 'gpt-4o', `stripChinese` TINYINT(1) NOT NULL DEFAULT 1, `extraPayload` TEXT DEFAULT NULL, `requestTimeoutMs` INTEGER NOT NULL DEFAULT '60000', `promptTemplate` TEXT NOT NULL DEFAULT '<system>\nYou are an expert crypto trading signal parser. Analyze the message and output JSON only.\n</system>\n\n<market>\n  <current_price>{{currentPrice}}</current_price>\n</market>\n\n{{positions}}\n\n{{context}}\n\n<current_message>\n  <text>{{message}}</text>\n</current_message>\n\n<output_format>\n{\n  \"action\": \"open|close|update|cancel|ignore\",\n  \"symbol\": \"BTC_USDT\",\n  \"side\": \"buy|sell (required when action=open)\",\n  \"entryPrice\": \"number (required when action=open)\",\n  \"targets\": [number],\n  \"stopLoss\": \"number (required when action=open)\",\n  \"leverage\": number,\n  \"confidence\": \"number (0-1)\",\n  \"reasoning\": \"string\"\n}\n</output_format>', `mode` VARCHAR(255) NOT NULL DEFAULT 'disabled', `contextMessageCount` INTEGER DEFAULT '5', `isActive` TINYINT(1) DEFAULT 1, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `ai_logs` (`id` INTEGER PRIMARY KEY, `strategyId` INTEGER, `routeIds` TEXT, `routeNames` TEXT, `model` VARCHAR(255) NOT NULL, `originalMessage` TEXT, `systemPrompt` TEXT, `prompt` TEXT NOT NULL, `response` TEXT, `promptTokens` INTEGER DEFAULT '0', `completionTokens` INTEGER DEFAULT '0', `totalTokens` INTEGER DEFAULT '0', `durationMs` INTEGER DEFAULT '0', `status` VARCHAR(255) DEFAULT 'success', `error` TEXT, `imageBase64` TEXT, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `webhook_configs` (`id` INTEGER PRIMARY KEY, `name` VARCHAR(255) NOT NULL, `type` VARCHAR(255) NOT NULL DEFAULT 'webhook', `url` VARCHAR(255) NOT NULL, `method` VARCHAR(255) DEFAULT 'POST', `headers` TEXT DEFAULT '{}', `template` TEXT, `config` TEXT DEFAULT '{}', `events` TEXT NOT NULL DEFAULT '[]', `isActive` TINYINT(1) DEFAULT 1, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `image_download_caches` (`id` INTEGER PRIMARY KEY, `url` TEXT NOT NULL UNIQUE, `urlHash` VARCHAR(64) NOT NULL UNIQUE, `imageBase64` TEXT NOT NULL, `mimeType` VARCHAR(255), `sizeBytes` INTEGER, `hitCount` INTEGER NOT NULL DEFAULT '0', `lastAccessedAt` DATETIME NOT NULL, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `idempotency_keys` (`id` INTEGER PRIMARY KEY, `channelId` VARCHAR(255) NOT NULL UNIQUE, `contentHash` VARCHAR(64) NOT NULL UNIQUE, `firstSeenAt` DATETIME NOT NULL, `messageId` BIGINT, `strategyId` INTEGER)",
  "CREATE TABLE IF NOT EXISTS `market_data_sources` (`id` VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY, `type` VARCHAR(255) NOT NULL DEFAULT 'gate', `name` VARCHAR(255) NOT NULL, `config` TEXT NOT NULL DEFAULT '{}', `status` VARCHAR(255) NOT NULL DEFAULT 'active', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `lighter_tx_journals` (`txId` VARCHAR(255) NOT NULL PRIMARY KEY, `exchangeInstanceId` VARCHAR(255) NOT NULL, `accountIndex` INTEGER NOT NULL, `apiKeyIndex` INTEGER NOT NULL, `nonce` VARCHAR(255) NOT NULL, `txType` INTEGER NOT NULL, `txInfoHash` VARCHAR(255) NOT NULL, `intentJson` TEXT NOT NULL, `status` VARCHAR(255) NOT NULL DEFAULT 'CREATED', `strategyId` INTEGER, `orderId` INTEGER, `clientOrderIndex` VARCHAR(255), `error` TEXT, `confirmedAt` DATETIME, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `lighter_client_order_indexes` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `exchangeInstanceId` VARCHAR(255) NOT NULL, `businessKey` VARCHAR(255) NOT NULL, `clientOrderIndex` VARCHAR(255) NOT NULL, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `virtual_accounts` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `exchangeInstanceId` VARCHAR(255) NOT NULL, `currency` VARCHAR(255) NOT NULL DEFAULT 'USDT', `initialBalance` VARCHAR(255) NOT NULL DEFAULT '10000', `availableBalance` VARCHAR(255) NOT NULL DEFAULT '10000', `realizedPnl` VARCHAR(255) NOT NULL DEFAULT '0', `status` VARCHAR(255) NOT NULL DEFAULT 'active', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `virtual_positions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `exchangeInstanceId` VARCHAR(255) NOT NULL, `symbol` VARCHAR(255) NOT NULL, `size` VARCHAR(255) NOT NULL DEFAULT '0', `entryPrice` VARCHAR(255) NOT NULL DEFAULT '0', `markPrice` VARCHAR(255) NOT NULL DEFAULT '0', `realizedPnl` VARCHAR(255) NOT NULL DEFAULT '0', `leverage` VARCHAR(255) NOT NULL DEFAULT '1', `marginType` VARCHAR(255) NOT NULL DEFAULT 'cross', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `virtual_orders` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `virtualOrderId` VARCHAR(255) NOT NULL UNIQUE, `exchangeInstanceId` VARCHAR(255) NOT NULL, `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255) NOT NULL, `type` VARCHAR(255) NOT NULL, `orderRole` VARCHAR(255) NOT NULL DEFAULT 'entry', `price` VARCHAR(255), `amount` VARCHAR(255) NOT NULL, `filledAmount` VARCHAR(255), `filledPrice` VARCHAR(255), `status` VARCHAR(255) NOT NULL DEFAULT 'open', `reduceOnly` TINYINT(1) NOT NULL DEFAULT 0, `postOnly` TINYINT(1) NOT NULL DEFAULT 0, `triggerPrice` VARCHAR(255), `triggerCondition` VARCHAR(255), `text` VARCHAR(255), `parentSide` VARCHAR(255), `parentOrderId` VARCHAR(255), `raw` TEXT, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `virtual_trades` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `tradeId` VARCHAR(255) NOT NULL UNIQUE, `virtualOrderId` VARCHAR(255) NOT NULL, `exchangeInstanceId` VARCHAR(255) NOT NULL, `symbol` VARCHAR(255) NOT NULL, `side` VARCHAR(255) NOT NULL, `price` VARCHAR(255) NOT NULL, `amount` VARCHAR(255) NOT NULL, `role` VARCHAR(255) NOT NULL DEFAULT 'taker', `realizedPnl` VARCHAR(255) NOT NULL DEFAULT '0', `text` VARCHAR(255), `executedAt` DATETIME NOT NULL, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `virtual_account_instance_currency` ON `virtual_accounts` (`exchangeInstanceId`, `currency`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `virtual_position_instance_symbol` ON `virtual_positions` (`exchangeInstanceId`, `symbol`)",
  "CREATE INDEX IF NOT EXISTS `lighter_tx_journals_exchange_instance_id_status` ON `lighter_tx_journals` (`exchangeInstanceId`, `status`)",
  "CREATE INDEX IF NOT EXISTS `lighter_tx_journals_exchange_instance_id_account_index_api_key_index_nonce` ON `lighter_tx_journals` (`exchangeInstanceId`, `accountIndex`, `apiKeyIndex`, `nonce`)",
  "CREATE INDEX IF NOT EXISTS `lighter_tx_journals_client_order_index` ON `lighter_tx_journals` (`clientOrderIndex`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `lighter_client_order_indexes_exchange_instance_id_business_key` ON `lighter_client_order_indexes` (`exchangeInstanceId`, `businessKey`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `lighter_client_order_indexes_exchange_instance_id_client_order_index` ON `lighter_client_order_indexes` (`exchangeInstanceId`, `clientOrderIndex`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `idempotency_keys_channel_id_content_hash` ON `idempotency_keys` (`channelId`, `contentHash`)",
  "CREATE INDEX IF NOT EXISTS `idempotency_keys_first_seen_at` ON `idempotency_keys` (`firstSeenAt`)",
  "CREATE INDEX IF NOT EXISTS `soft_stop_losses_status_exchange_instance_id` ON `soft_stop_losses` (`status`, `exchangeInstanceId`)",
  "CREATE INDEX IF NOT EXISTS `soft_stop_losses_strategy_id` ON `soft_stop_losses` (`strategyId`)",
  "CREATE INDEX IF NOT EXISTS `soft_stop_losses_order_id` ON `soft_stop_losses` (`orderId`)",
  "CREATE INDEX IF NOT EXISTS `soft_stop_losses_symbol_side_status` ON `soft_stop_losses` (`symbol`, `side`, `status`)",
  "CREATE INDEX IF NOT EXISTS `api_credentials_token_prefix` ON `api_credentials` (`tokenPrefix`)",
  "CREATE INDEX IF NOT EXISTS `api_credentials_token_hash` ON `api_credentials` (`tokenHash`)",
  "CREATE INDEX IF NOT EXISTS `api_credentials_disabled_at` ON `api_credentials` (`disabledAt`)",
  "CREATE INDEX IF NOT EXISTS `api_credentials_expires_at` ON `api_credentials` (`expiresAt`)",
  "CREATE INDEX IF NOT EXISTS `orders_strategy_id` ON `orders` (`strategyId`)",
  "CREATE INDEX IF NOT EXISTS `orders_exchange_instance_id_lifecycle_status` ON `orders` (`exchangeInstanceId`, `lifecycleStatus`)",
  "CREATE INDEX IF NOT EXISTS `orders_lifecycle_status_closed_at` ON `orders` (`lifecycleStatus`, `closedAt`)",
  "CREATE INDEX IF NOT EXISTS `orders_symbol_status` ON `orders` (`symbol`, `status`)",
  "CREATE INDEX IF NOT EXISTS `orders_is_simulated` ON `orders` (`isSimulated`)",
  "CREATE INDEX IF NOT EXISTS `strategies_status` ON `strategies` (`status`)",
  "CREATE INDEX IF NOT EXISTS `strategies_symbol` ON `strategies` (`symbol`)",
  "CREATE INDEX IF NOT EXISTS `strategies_source` ON `strategies` (`source`)",
  "CREATE INDEX IF NOT EXISTS `strategies_parser_name` ON `strategies` (`parserName`)",
  "CREATE INDEX IF NOT EXISTS `strategies_created_at` ON `strategies` (`createdAt`)",
  "CREATE INDEX IF NOT EXISTS `pending_protections_status` ON `pending_protections` (`status`)",
  "CREATE INDEX IF NOT EXISTS `pending_protections_symbol_side` ON `pending_protections` (`symbol`, `side`)",
  "CREATE INDEX IF NOT EXISTS `signal_routes_channel_id` ON `signal_routes` (`channelId`)",
  "CREATE INDEX IF NOT EXISTS `signal_routes_exchange_instance_id` ON `signal_routes` (`exchangeInstanceId`)",
  "CREATE INDEX IF NOT EXISTS `signal_routes_is_active` ON `signal_routes` (`isActive`)",
  "CREATE INDEX IF NOT EXISTS `strategy_positions_strategy_id` ON `strategy_positions` (`strategyId`)",
  "CREATE INDEX IF NOT EXISTS `strategy_positions_order_id` ON `strategy_positions` (`orderId`)",
  "CREATE INDEX IF NOT EXISTS `strategy_positions_exchange_instance_id_symbol_status` ON `strategy_positions` (`exchangeInstanceId`, `symbol`, `status`)",
  "CREATE INDEX IF NOT EXISTS `audit_logs_created_at` ON `audit_logs` (`createdAt`)",
  "CREATE INDEX IF NOT EXISTS `audit_logs_strategy_id` ON `audit_logs` (`strategyId`)",
  "CREATE INDEX IF NOT EXISTS `audit_logs_order_id` ON `audit_logs` (`orderId`)"
];

module.exports = {
  async up(queryInterface) {
    for (const statement of STATEMENTS) {
      await queryInterface.sequelize.query(statement);
    }
  },

  async down(queryInterface) {
    for (const table of [...TABLES].reverse()) {
      await queryInterface.dropTable(table);
    }
  },
};
