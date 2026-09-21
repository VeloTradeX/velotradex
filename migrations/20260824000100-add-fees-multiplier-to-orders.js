'use strict';

/**
 * orders 表新增字段：
 * - fees：该订单计入统计的手续费（当前为平仓侧成交手续费，USDT 计价）。
 *   统计模块 realizedPnl 已在平仓时扣除该费用，fees 仅用于展示「总手续费」。
 * - mathMultiplier：平仓统计时真实使用的合约乘数（来源：交易所市场信息或符号兜底）。
 *   供统计模块无递归推算的口径复用，避免用净盈亏反推乘数造成偏差。
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders', 'fees', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: '计入统计的手续费（USDT）',
    });
    await queryInterface.addColumn('orders', 'mathMultiplier', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: '统计使用的合约乘数',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orders', 'mathMultiplier');
    await queryInterface.removeColumn('orders', 'fees');
  }
};