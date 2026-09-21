'use strict';

/**
 * 端到端回测功能：
 * - 新建 backtest_runs 表（回测运行记录：状态/进度/配置/汇总）。
 * - strategies / orders 增加 backtestRunId 列（null = 实盘数据），
 *   回测导入的数据打上运行 id，默认查询排除，保证与实盘数据互不干扰。
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('backtest_runs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      runKey: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending',
      },
      messagesPath: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      messageCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rangeStart: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      rangeEnd: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      parserName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      routeId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      config: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      progress: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      summary: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      childPid: {
        type: Sequelize.INTEGER,
        allowNull: true,
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
    await queryInterface.addIndex('backtest_runs', ['status']);

    await queryInterface.addColumn('strategies', 'backtestRunId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: '回测运行 id；null = 实盘数据',
    });
    await queryInterface.addIndex('strategies', ['backtestRunId']);

    await queryInterface.addColumn('orders', 'backtestRunId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: '回测运行 id；null = 实盘数据',
    });
    await queryInterface.addIndex('orders', ['backtestRunId']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('orders', ['backtestRunId']);
    await queryInterface.removeColumn('orders', 'backtestRunId');
    await queryInterface.removeIndex('strategies', ['backtestRunId']);
    await queryInterface.removeColumn('strategies', 'backtestRunId');
    await queryInterface.dropTable('backtest_runs');
  }
};
