# 数据库迁移指南

本项目使用 Sequelize CLI 进行数据库迁移管理。

## 常用命令

### 生成新的迁移文件

```bash
npm run db:migration:generate add-new-column
```

这会在 `migrations/` 目录下创建一个带时间戳的迁移文件。

### 执行迁移

```bash
npm run db:migrate
```

执行所有未执行的迁移。

### 查看迁移状态

```bash
npm run db:migrate:status
```

查看哪些迁移已执行，哪些未执行。

### 回滚最后一次迁移

```bash
npm run db:migrate:undo
```

### 回滚所有迁移

```bash
npm run db:migrate:undo:all
```

## 迁移文件编写指南

每个迁移文件包含两个方法：

- `up`: 执行迁移时运行
- `down`: 回滚迁移时运行

### 示例：添加新列

```javascript
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders', 'new_field', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('orders', 'new_field');
  }
};
```

### 示例：修改列类型

```javascript
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('orders', 'amount', {
      type: Sequelize.DECIMAL(20, 8),
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('orders', 'amount', {
      type: Sequelize.STRING,
      allowNull: false,
    });
  }
};
```

### 示例：创建新表

```javascript
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('new_table', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('new_table');
  }
};
```

### 示例：添加索引

```javascript
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex('orders', ['symbol', 'status'], {
      name: 'orders_symbol_status_idx',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('orders', 'orders_symbol_status_idx');
  }
};
```

## 注意事项

1. **迁移文件命名**：由 Sequelize CLI 自动生成时间戳前缀，确保按顺序执行
2. **幂等性**：确保迁移可以安全地多次执行
3. **可回滚性**：每个 `up` 操作都应该有对应的 `down` 操作
4. **测试**：在生产环境执行前，先在开发/测试环境验证
5. **数据迁移**：如果需要迁移数据，在迁移文件中使用 `queryInterface.sequelize.query()` 执行 SQL

## 基线迁移（init-schema）

`20260101000000-init-schema.js` 是整个迁移链的**基线**：它建出全部基础表
（`users` / `strategies` / `orders` / `virtual_*` 等 24 张表）。

- 它刻意**不包含**后续迁移负责的对象：表 `cfd_leg_groups` / `cfd_legs` /
  `exchange_connection_logs` / `backtest_runs`，列 `strategies.signalOrigin` /
  `orders.fees` / `orders.mathMultiplier` / `*.backtestRunId`，这些仍由各自的时间戳迁移负责。
- 所有语句都是 `CREATE TABLE/INDEX IF NOT EXISTS`，因此在“已有表但缺迁移记录”的旧库上
  执行是 no-op，不会破坏现有数据。
- 该文件由 `scripts/generate-init-migration.py` 从现有库结构反推生成；新增基线表请改脚本
  重跑，不要手工增删语句。
- 新增迁移请放到 `migrations/` 根目录；模板已移到 `migrations/templates/`，避免被 CLI 当成
  正式迁移执行。

## 与模型定义（sequelize.sync）的关系

应用启动时**不会**自动同步表结构（仅回测子进程 `src/backtest/child-main.ts` 在内存库上
使用 `sequelize.sync()`）。生产 / 开发环境都以迁移为唯一 schema 变更入口：
空库必须先执行 `npx sequelize-cli db:migrate`，否则启动后所有查询都会报 `no such table`。

## 迁移表

Sequelize CLI 会自动创建 `SequelizeMeta` 表来跟踪已执行的迁移。
