'use strict';
/**
 * 交易所连接断开历史记录表迁移。
 *
 * - exchange_connection_logs：每次「连接断开 → 重连成功」记为一个断连事件（一行）。
 *   断开时写 disconnectedAt / reason；重连成功后回填 reconnectedAt 并计算 durationMs。
 * - durationMs 精确记录单次断连持续时间（设计字段，暂未在界面强依赖，保留以保证记录准确）。
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('exchange_connection_logs', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      exchangeInstanceId: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: '交易所实例 ID（→ exchange_instances.id）',
      },
      exchangeName: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '交易所实例名称（冗余快照，便于改名后仍可识别）',
      },
      exchangeType: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '交易所类型（gate / gate_tradfi / lighter / virtual_gate）',
      },
      eventType: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'disconnect',
        comment: '事件类型，当前仅 disconnect（预留扩展）',
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '断开原因（来自 WS lastError 或错误信息）',
      },
      disconnectedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: '断开时间',
      },
      reconnectedAt: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '重连成功时间（NULL 表示当前仍处于断线中）',
      },
      durationMs: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '断连持续时间（毫秒），重连成功后回填',
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

    await queryInterface.addIndex('exchange_connection_logs', ['exchangeInstanceId']);
    await queryInterface.addIndex('exchange_connection_logs', ['disconnectedAt']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('exchange_connection_logs');
  },
};
