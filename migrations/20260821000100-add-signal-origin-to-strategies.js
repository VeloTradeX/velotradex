'use strict';
/**
 * strategies 表新增 signalOrigin 可空列，标记信号来源（'text' 纯文本 / 'image' 图片视觉）。
 * 图片兜底视觉识别（MansoorParser）需要区分信号的产生途径，便于事后排查。
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('strategies', 'signalOrigin', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: '信号来源：text（纯文本）/ image（图片视觉识别）',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('strategies', 'signalOrigin');
  },
};