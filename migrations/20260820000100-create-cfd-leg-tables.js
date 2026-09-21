'use strict';
/**
 * Gate-CFD 多腿数据模型迁移（设计文档 内部设计文档 §5.1）。
 * 需求方要求：Order 表零改动，腿分组/持仓关联/决策快照独立建表，再与 Order 关联。
 *
 * - cfd_leg_groups：多腿分组 + CfdLegPlanner 决策快照
 * - cfd_legs：单腿明细（orderId 关联 orders.id，positionId 为 CFD 交易所持仓锚点）
 *
 * 加密合约路径完全不涉及这两张表，零影响。
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('cfd_leg_groups', {
      id: {
        type: Sequelize.STRING,
        primaryKey: true,
        allowNull: false,
        comment: '腿组 ID（如 lg-{orderRecordId}，单腿信号也建组统一语义）',
      },
      orderRecordId: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '关联原始信号订单记录（order_records.id）',
      },
      symbol: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      side: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      entryPrice: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      slPrice: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '分组级止损（全腿共用 SL）',
      },
      legCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '实际腿数（减腿后可能与信号档位数不同）',
      },
      legPlan: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'CfdLegPlanner 决策快照 JSON（原始档位/放大减腿过程/风险名义核算）',
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending / filled / partially_filled / failed（全回滚时 failed）',
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

    await queryInterface.createTable('cfd_legs', {
      id: {
        type: Sequelize.STRING,
        primaryKey: true,
        allowNull: false,
      },
      legGroupId: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: '所属腿组（→ cfd_leg_groups.id）',
      },
      orderId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '该腿对应的 Order 行（→ orders.id，每腿一行 Order）',
      },
      legIndex: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: '腿序号（0-based）',
      },
      tpPrice: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '该腿止盈价',
      },
      volume: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: '该腿手数（含放大/封顶后的最终值）',
      },
      positionId: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'CFD 交易所持仓 ID（成交后回写，closePosition/updatePosition 锚点）',
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending / open / closed / failed',
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

    await queryInterface.addIndex('cfd_leg_groups', ['orderRecordId']);
    await queryInterface.addIndex('cfd_legs', ['legGroupId']);
    await queryInterface.addIndex('cfd_legs', ['orderId']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('cfd_legs');
    await queryInterface.dropTable('cfd_leg_groups');
  },
};
